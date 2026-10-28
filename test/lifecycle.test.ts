/**
 * These tests are about money, so they are about counting: how many times
 * `submit` was called for the same ask, what is on disk at the moment a client
 * dies, and what happens when the budget is too small. The clock is faked so a
 * 90 second deadline costs no seconds here.
 */
import assert from "node:assert/strict";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { Catalog } from "../src/fuse/catalog.ts";
import { FuseError, type RunView } from "../src/fuse/client.ts";
import { JobStore, Lifecycle, specHash, type RunsPort } from "../src/job/lifecycle.ts";
import type { Budget, JobSpec, SceneSpec } from "../src/domain.ts";

const fixture = JSON.parse(
  readFileSync(fileURLToPath(new URL("./fixtures/pricing-2026-10-26.json", import.meta.url)), "utf8"),
);
const catalog = Catalog.parse(fixture.data);

const spec: JobSpec = {
  tier: "t2v-low-standard",
  resolution: catalog.resolution("t2v-low-standard", "480p"),
  aspect: catalog.aspect("t2v-low-standard", "16:9"),
};

const SCENE_A: SceneSpec = { slug: "scene-a", prompt: "A frosted bottle on a wooden table.", seconds: 5 };
const SCENE_B: SceneSpec = { slug: "scene-b", prompt: "Thai iced tea poured over ice.", seconds: 5 };
const SCENES: SceneSpec[] = [SCENE_A, SCENE_B];

/** 20 base + ceil(5 x 4) per scene, as the catalog prices it. */
const PER_SCENE = 40;
const PLENTY: Budget = { maxTokens: 500, alreadySpent: 0 };

/** A stand-in API: counts submits and plays a scripted status per run. */
class FakeRuns implements RunsPort {
  submits: SceneSpec[] = [];
  statusCalls = 0;
  /** Status answers per run id, consumed in order; the last one repeats. */
  script = new Map<string, RunView[]>();
  failSubmit?: Error;
  private next = 0;

  async submit(_spec: JobSpec, scene: SceneSpec): Promise<RunView> {
    if (this.failSubmit) throw this.failSubmit;
    this.submits.push(scene);
    const id = `run-${++this.next}`;
    if (!this.script.has(id)) {
      this.script.set(id, [
        { id, status: "COMPLETED", outputUrl: `https://storage.googleapis.com/fuse/${id}.mp4` },
      ]);
    }
    return { id, status: "IN_PROGRESS" };
  }

  async status(runId: string): Promise<RunView> {
    this.statusCalls++;
    const queue = this.script.get(runId);
    if (!queue || queue.length === 0) throw new Error(`no scripted status for ${runId}`);
    return queue.length === 1 ? queue[0]! : queue.shift()!;
  }
}

interface Harness {
  dir: string;
  store: JobStore;
  runs: FakeRuns;
  life: Lifecycle;
  clips: string[];
}

async function harness(options: { openClip?: (url: string) => Promise<ReadableStream<Uint8Array>> } = {}): Promise<Harness> {
  const dir = await mkdtemp(join(tmpdir(), "fuse-job-"));
  const store = await JobStore.start(dir, "job-1", spec);
  const runs = new FakeRuns();
  const clips: string[] = [];
  let clock = 1_000;
  const life = new Lifecycle(store, {
    runs,
    catalog,
    openClip:
      options.openClip ??
      (async (url: string) => {
        clips.push(url);
        return new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112])); // an mp4 box header
            controller.close();
          },
        });
      }),
    now: () => clock,
    sleep: async (ms: number) => {
      clock += ms; // Time only moves when the code decides to wait.
    },
  });
  return { dir, store, runs, life, clips };
}

test("one call submits, follows, fetches and records every scene", async () => {
  const { dir, store, runs, life, clips } = await harness();
  const view = await life.advance(SCENES, { budget: PLENTY });

  assert.equal(runs.submits.length, 2);
  assert.equal(view.total, 2);
  assert.equal(view.done, 2);
  assert.equal(view.stopped, undefined);
  assert.equal(view.spent, 2 * PER_SCENE);
  assert.deepEqual(
    view.scenes.map((scene) => [scene.slug, scene.state, scene.file]),
    [
      ["scene-a", "ready", `assets/scenes/scene-a-${specHash(spec, SCENE_A).slice(0, 8)}.mp4`],
      ["scene-b", "ready", `assets/scenes/scene-b-${specHash(spec, SCENE_B).slice(0, 8)}.mp4`],
    ],
  );
  for (const scene of view.scenes) {
    const file = await stat(join(dir, scene.file!));
    assert.ok(file.size > 0, `${scene.slug} has no bytes on disk`);
  }
  assert.equal(clips.length, 2);
  assert.equal(store.job.spent, 2 * PER_SCENE);
});

test("calling again waits on the same runs instead of paying again", async () => {
  const { life, runs } = await harness();
  await life.advance(SCENES, { budget: PLENTY });
  const second = await life.advance(SCENES, { budget: PLENTY });

  assert.equal(runs.submits.length, 2, "a second call must not submit anything");
  assert.equal(second.done, 2);
  assert.equal(second.spent, 2 * PER_SCENE);
});

test("a run id survives a client that dies right after the charge", async () => {
  // The fetch is what fails here, which is the same shape as a crash: the
  // tokens are gone and the only thing that must not be lost is the run id.
  let allowFetch = false;
  const { dir, life, runs } = await harness({
    openClip: async () => {
      if (!allowFetch) throw new FuseError("transport", 0, "the clip could not be fetched");
      return new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array([1, 2, 3, 4]));
          controller.close();
        },
      });
    },
  });
  const first = await life.advance([SCENE_A], { budget: PLENTY });
  assert.equal(first.done, 0);
  assert.equal(runs.submits.length, 1);

  const onDisk = JSON.parse(await readFile(join(dir, ".fuse", "job.json"), "utf8"));
  assert.equal(onDisk.job.scenes[0].runId, "run-1", "the run id was not written through");
  assert.equal(onDisk.job.scenes[0].state, "working");

  // A new process opens the same directory and carries on.
  allowFetch = true;
  const reopened = await JobStore.open(dir);
  assert.ok(reopened);
  const resumed = new Lifecycle(reopened, {
    runs,
    catalog,
    openClip: async () =>
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array([1, 2, 3, 4]));
          controller.close();
        },
      }),
  });
  const after = await resumed.advance([SCENE_A], { budget: PLENTY });
  assert.equal(runs.submits.length, 1, "the resumed job must not submit a second run");
  assert.equal(after.done, 1);
});

test("a budget that does not cover the scenes spends nothing at all", async () => {
  const { life, runs } = await harness();
  const view = await life.advance(SCENES, { budget: { maxTokens: 50, alreadySpent: 0 } });

  assert.equal(runs.submits.length, 0);
  assert.equal(view.stopped, "over_budget");
  assert.match(view.detail!, /80 more tokens.*50 token budget/);
  assert.equal(view.spent, 0);
});

test("tokens already spent count against the same ceiling", async () => {
  const { life, runs } = await harness();
  const view = await life.advance([SCENE_A], { budget: { maxTokens: 100, alreadySpent: 70 } });
  assert.equal(runs.submits.length, 0);
  assert.equal(view.stopped, "over_budget");
  assert.match(view.detail!, /70 already spent/);
});

test("an empty balance stops the call before the next scene is charged", async () => {
  const { life, runs } = await harness();
  runs.failSubmit = new FuseError(
    "insufficient_tokens",
    402,
    "Insufficient token balance — You do not have enough tokens for this action",
    "ERR_7001",
  );
  const view = await life.advance(SCENES, { budget: PLENTY });

  assert.equal(runs.submits.length, 0);
  assert.equal(view.stopped, "insufficient_tokens");
  assert.match(view.detail!, /Insufficient token balance/);
  assert.equal(view.spent, 0);
  assert.deepEqual(view.scenes.map((scene) => scene.state), ["planned"]);
});

test("the server's refusal is passed through and the rest is not sent", async () => {
  const { life, runs } = await harness();
  runs.failSubmit = new FuseError(
    "rejected",
    400,
    "duration must be between 5 and 10 for low priority with standard quality",
  );
  const view = await life.advance(SCENES, { budget: PLENTY });

  assert.equal(view.stopped, "rejected_by_api");
  assert.equal(view.detail, "duration must be between 5 and 10 for low priority with standard quality");
  assert.equal(view.scenes.length, 1, "scene-b is never sent once the spec is refused");
});

test("a failed render is reported as failed, not as a missing file", async () => {
  const { life, runs } = await harness();
  runs.script.set("run-1", [{ id: "run-1", status: "FAILED" }]);
  const view = await life.advance([SCENE_A], { budget: PLENTY });

  assert.equal(view.done, 0);
  assert.equal(view.stopped, "provider_failed");
  assert.equal(view.scenes[0]!.state, "failed");
  assert.match(view.scenes[0]!.lastError!, /FAILED/);
});

test("a render still running comes back as a partial answer, not a hang", async () => {
  const { life, runs } = await harness();
  runs.script.set("run-1", [{ id: "run-1", status: "IN_PROGRESS" }]);
  const view = await life.advance([SCENE_A], { budget: PLENTY, waitMs: 30_000, pollMs: 5_000 });

  assert.equal(view.done, 0);
  assert.equal(view.stopped, undefined, "still working is not a stop");
  assert.equal(view.scenes[0]!.state, "working");
  assert.equal(view.scenes[0]!.runId, "run-1");
  assert.ok(runs.statusCalls >= 5 && runs.statusCalls <= 7, `polled ${runs.statusCalls} times`);
});

test("no output URL is ever written to the job file", async () => {
  const { dir, life } = await harness();
  await life.advance(SCENES, { budget: PLENTY });
  const text = await readFile(join(dir, ".fuse", "job.json"), "utf8");
  assert.doesNotMatch(text, /https?:\/\//, "a provider link that expires must not be stored");
});

test("re-prompting a scene keeps the clip already paid for", async () => {
  const { dir, life, runs } = await harness();
  await life.advance([SCENE_A], { budget: PLENTY });
  const edited: SceneSpec = { ...SCENE_A, prompt: `${SCENE_A.prompt} Now at dusk.` };
  const view = await life.advance([edited], { budget: PLENTY });

  assert.equal(runs.submits.length, 2, "an edited prompt is a new render");
  const onDisk = JSON.parse(await readFile(join(dir, ".fuse", "job.json"), "utf8"));
  assert.equal(onDisk.job.scenes.length, 2, "the earlier paid record is kept beside the new one");
  assert.equal(view.scenes.length, 1, "the view shows only what this call asked for");
  assert.notEqual(view.scenes[0]!.file, onDisk.job.scenes[0].file, "the new clip gets its own file");
  await stat(join(dir, onDisk.job.scenes[0].file)); // the first clip is still there
});

test("renaming a scene does not pay for it twice", async () => {
  const { life, runs } = await harness();
  await life.advance([SCENE_A], { budget: PLENTY });
  const renamed: SceneSpec = { ...SCENE_A, slug: "opening-shot" };
  const view = await life.advance([renamed], { budget: PLENTY });

  assert.equal(runs.submits.length, 1, "the same ask under a new name is the same scene");
  assert.equal(view.scenes[0]!.slug, "opening-shot");
  assert.equal(view.scenes[0]!.state, "ready");
  assert.equal(view.spent, PER_SCENE);
});

test("two scenes finishing at the same moment both land in the file", async () => {
  // This failed before the store queued its writes: both records were written
  // through the same temporary path, so one rename lost a scene's "ready".
  const { dir, store } = await harness();
  await Promise.all(
    Array.from({ length: 12 }, (_unused, index) =>
      store.put({
        slug: `scene-${index}`,
        specHash: `hash-${index}`,
        state: "working",
        runId: `run-${index}`,
        tokens: 40,
      }),
    ),
  );
  const onDisk = JSON.parse(await readFile(join(dir, ".fuse", "job.json"), "utf8"));
  assert.equal(onDisk.job.scenes.length, 12);
  assert.equal(onDisk.job.spent, 12 * PER_SCENE);
  assert.equal(store.job.scenes.length, 12);
});
