/**
 * The tool surface is where a model's words become our calls, so these tests
 * are about the boundary: what is refused before anything is created or
 * charged, what the five tools are wired to, and the two places where calling
 * the same tool twice must not mean doing the work twice.
 *
 * The lifecycle's own counting is covered in lifecycle.test.ts; here a budget
 * test only checks the one thing this layer decides — that maxTokens is a
 * ceiling for the whole project, not for one call.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { Catalog } from "../src/fuse/catalog.ts";
import type { RunView } from "../src/fuse/client.ts";
import type { RunsPort } from "../src/job/lifecycle.ts";
import type { ClipBox, CommandResult, Runner, ScaffoldDeps } from "../src/project/scaffold.ts";
import { createTools, type ToolDefinition } from "../src/tools.ts";
import type { JobSpec, SceneSpec } from "../src/domain.ts";

const fixture = JSON.parse(
  readFileSync(fileURLToPath(new URL("./fixtures/pricing-2026-10-26.json", import.meta.url)), "utf8"),
);
const catalog = Catalog.parse(fixture.data);

const OK: CommandResult = { code: 0, stdout: "ok", stderr: "" };

/** Submits always succeed and complete at once; the counting lives elsewhere. */
class FakeRuns implements RunsPort {
  submits: SceneSpec[] = [];
  private next = 0;

  async submit(_spec: JobSpec, scene: SceneSpec): Promise<RunView> {
    this.submits.push(scene);
    return { id: `run-${++this.next}`, status: "IN_PROGRESS" };
  }

  async status(runId: string): Promise<RunView> {
    return {
      id: runId,
      status: "COMPLETED",
      outputUrl: `https://storage.googleapis.com/fuse/${runId}.mp4`,
    };
  }
}

interface Harness {
  tool(name: string): ToolDefinition;
  names: string[];
  runs: FakeRuns;
  argv: string[][];
  fetched: string[];
}

function harness(
  options: {
    fetch?: (url: string, init?: RequestInit) => Promise<Response>;
    probe?: (file: string) => Promise<ClipBox>;
    run?: Runner;
  } = {},
): Harness {
  const runs = new FakeRuns();
  const argv: string[][] = [];
  const fetched: string[] = [];
  const run: Runner =
    options.run ??
    (async (command, args) => {
      argv.push([command, ...args]);
      return OK;
    });
  const scaffold: ScaffoldDeps = {
    run,
    probe:
      options.probe ??
      (async (file: string) => {
        // The two boxes really measured on prod for the same nominal 480p 16:9.
        const wide = file.includes("scene-a");
        return { width: wide ? 864 : 832, height: 480, seconds: wide ? 5.167 : 6.583 };
      }),
    fetch:
      options.fetch ??
      (async (url: string) => {
        fetched.push(url);
        if (url.includes("css2")) {
          return new Response(
            "@font-face { font-family: 'Noto Sans Thai'; src: url(https://fonts.gstatic.com/s/t.woff2) format('woff2'); }",
            { status: 200 },
          );
        }
        return new Response(new Uint8Array([119, 79, 70, 50]), { status: 200 });
      }),
  };
  const list = createTools({
    catalog: async () => catalog,
    runs,
    openClip: async () =>
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112]));
          controller.close();
        },
      }),
    scaffold,
    newJobId: () => "job-under-test",
  });
  return {
    tool: (name) => {
      const found = list.find((definition) => definition.name === name);
      if (!found) throw new Error(`no tool named ${name}; there are ${list.map((d) => d.name)}`);
      return found;
    },
    names: list.map((definition) => definition.name),
    runs,
    argv,
    fetched,
  };
}

async function project(): Promise<{ dir: string; harness: Harness }> {
  const parent = await mkdtemp(join(tmpdir(), "fuse-tools-"));
  const dir = join(parent, "thai-tea-ad");
  const bench = harness();
  await bench.tool("fuse_project_new").run({
    dir,
    tier: "t2v-low-standard",
    resolution: "480p",
    aspect: "16:9",
  });
  return { dir, harness: bench };
}

const SCENES = [
  { slug: "scene-a", prompt: "A frosted bottle on a wooden table.", seconds: 5 },
  { slug: "scene-b", prompt: "Thai iced tea poured over ice.", seconds: 5 },
];

/* ------------------------------------------------------------------ surface */

test("the surface is the five tools the design settled on, and nothing else", () => {
  assert.deepEqual(harness().names, [
    "fuse_tiers",
    "fuse_quote",
    "fuse_project_new",
    "fuse_scenes",
    "fuse_manifest",
  ]);
});

test("the tools deliberately left out are still left out", () => {
  const names = harness().names;
  // A balance tool would be a lie: an API key cannot read /tokens/info.
  // Wrapping HyperFrames' own commands would be a pass-through that hides
  // nothing and gives an agent two ways to do one thing.
  for (const absent of ["fuse_balance", "fuse_render", "fuse_check", "fuse_compose"]) {
    assert.ok(!names.includes(absent), `${absent} should not exist`);
  }
});

/* -------------------------------------------------------------------- read */

test("tiers come from pricing, with the per-second rate the account is charged", async () => {
  const result = (await harness().tool("fuse_tiers").run({})) as {
    tiers: Array<{ id: string; baseTokens: number; resolutions: Array<{ name: string }> }>;
    asOf: string;
  };
  const low = result.tiers.find((tier) => tier.id === "t2v-low-standard")!;
  assert.equal(low.baseTokens, 20);
  assert.ok(low.resolutions.some((resolution) => resolution.name === "480p"));
  assert.ok(Date.parse(result.asOf) > 0);
});

test("a quote needs no aspect and no prompts, because the price depends on neither", async () => {
  const result = (await harness().tool("fuse_quote").run({
    tier: "t2v-low-standard",
    resolution: "480p",
    scenes: [{ slug: "scene-a", seconds: 5 }, { slug: "scene-b", seconds: 5 }],
  })) as { total: number; lines: Array<{ slug: string; tokens: number }>; note: string };

  assert.equal(result.total, 80); // (20 base + 5 x 4) x 2
  assert.deepEqual(result.lines.map((line) => line.slug), ["scene-a", "scene-b"]);
  assert.match(result.note, /charges on the clip the provider returns/);
});

test("a resolution the tier does not sell is refused with the ones it does", async () => {
  await assert.rejects(
    () =>
      harness().tool("fuse_quote").run({
        tier: "t2v-low-standard",
        resolution: "4k",
        scenes: [{ slug: "scene-a", seconds: 5 }],
      }),
    /does not offer 4k; it offers/,
  );
});

test("a tier id of the wrong shape is told what one looks like", async () => {
  await assert.rejects(
    () =>
      harness().tool("fuse_quote").run({
        tier: "veo-3",
        resolution: "480p",
        scenes: [{ slug: "scene-a", seconds: 5 }],
      }),
    /<t2v\|i2v>-<low\|fast>-<standard\|high>/,
  );
});

/* --------------------------------------------------------------- the edge */

test("a slug that is not safe in a filename never reaches the disk", async () => {
  await assert.rejects(
    () =>
      harness().tool("fuse_quote").run({
        tier: "t2v-low-standard",
        resolution: "480p",
        scenes: [{ slug: "../../etc/passwd", seconds: 5 }],
      }),
    /lowercase letters, digits and hyphens/,
  );
});

test("two scenes sharing a slug are refused instead of quietly becoming one", async () => {
  const { dir, harness: bench } = await project();
  await assert.rejects(
    () =>
      bench.tool("fuse_scenes").run({
        dir,
        maxTokens: 500,
        scenes: [
          { slug: "scene-a", prompt: "one", seconds: 5 },
          { slug: "scene-a", prompt: "another", seconds: 5 },
        ],
      }),
    /cannot share a slug/,
  );
  assert.deepEqual(bench.runs.submits, [], "nothing may be submitted when the args are refused");
});

test("spending without a stated budget is not possible", async () => {
  const { dir, harness: bench } = await project();
  await assert.rejects(
    () => bench.tool("fuse_scenes").run({ dir, scenes: SCENES }),
    /maxTokens/,
  );
});

test("a relative dir is resolved against this process, and said back in full", async () => {
  await assert.rejects(
    () => harness().tool("fuse_scenes").run({ dir: "no-such-project", maxTokens: 100, scenes: SCENES }),
    (error: Error) => {
      assert.ok(
        error.message.includes(resolve(process.cwd(), "no-such-project")),
        `the absolute path should be in: ${error.message}`,
      );
      return true;
    },
  );
});

test("scenes before a project says to make the project, not how we store state", async () => {
  const empty = await mkdtemp(join(tmpdir(), "fuse-empty-"));
  await assert.rejects(
    () => harness().tool("fuse_scenes").run({ dir: empty, maxTokens: 100, scenes: SCENES }),
    /fuse_project_new/,
  );
});

/* ------------------------------------------------------------------ project */

test("a new project is HyperFrames' own scaffold, a bound tier and a Thai font", async () => {
  const parent = await mkdtemp(join(tmpdir(), "fuse-tools-"));
  const dir = join(parent, "thai-tea-ad");
  const bench = harness();
  const result = (await bench.tool("fuse_project_new").run({
    dir,
    tier: "t2v-low-standard",
    resolution: "480p",
    aspect: "16:9",
  })) as Record<string, unknown>;

  assert.equal(result.dir, dir);
  assert.equal(result.job, "job-under-test");
  assert.equal(result.reused, false);
  assert.deepEqual(result.spec, { tier: "t2v-low-standard", resolution: "480p", aspect: "16:9" });
  assert.deepEqual(result.fonts, ["assets/fonts/noto-sans-thai-1.woff2"]);
  assert.deepEqual(result.warnings, []);
  // The canvas is not here on purpose: it is measured from the clips later.
  assert.equal("canvas" in result, false);
  assert.match(String(result.next), /fuse_manifest/);

  assert.deepEqual(bench.argv[0]!.slice(0, 3), ["npx", "--yes", "hyperframes@0.8.202"]);
  assert.ok(bench.argv.some((line) => line.includes("doctor")));
  await stat(join(dir, ".fuse", "job.json"));
});

test("creating the same project twice reuses the job instead of re-initialising", async () => {
  const { dir, harness: bench } = await project();
  const before = bench.argv.length;
  const again = (await bench.tool("fuse_project_new").run({
    dir,
    tier: "t2v-low-standard",
    resolution: "480p",
    aspect: "16:9",
  })) as Record<string, unknown>;

  assert.equal(again.reused, true);
  assert.equal(again.job, "job-under-test");
  assert.equal(bench.argv.length, before, "hyperframes init must not run a second time");
});

test("a project whose first call was cut off short of recording the job carries on", async () => {
  // The client cuts a tool call off at 60 s by default and the first call on a
  // cold machine fetches HyperFrames and a browser, so this is the ordinary
  // path, not an unlucky one: the scaffold is on disk and the job is not.
  const parent = await mkdtemp(join(tmpdir(), "fuse-tools-"));
  const dir = join(parent, "cut-off");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "hyperframes.json"), '{"name":"cut-off"}\n', "utf8");

  const bench = harness();
  const report = (await bench.tool("fuse_project_new").run({
    dir,
    tier: "t2v-low-standard",
    resolution: "480p",
    aspect: "16:9",
  })) as { job: string; reused: boolean };

  assert.equal(report.job, "job-under-test", "the job has to exist now, or scenes cannot start");
  assert.equal(report.reused, false, "there was no job to reuse, only a scaffold");
  assert.equal(
    bench.argv.some((line) => line.includes("init")),
    false,
    "init must not be run again over a scaffold that is already written",
  );
  // And the scenes can now actually be asked for, which is the whole point.
  const view = (await bench.tool("fuse_scenes").run({
    dir,
    maxTokens: 200,
    scenes: [SCENES[0]],
  })) as { done: number };
  assert.equal(view.done, 1);
});

test("a project cannot be re-bound to another tier once tokens are on the line", async () => {
  const { dir, harness: bench } = await project();
  await bench.tool("fuse_scenes").run({ dir, maxTokens: 500, scenes: SCENES });
  await assert.rejects(
    () =>
      bench.tool("fuse_project_new").run({
        dir,
        tier: "t2v-low-high", // a tier the fixture really has, with its own resolutions
        resolution: "720p",
        aspect: "16:9",
      }),
    (error: Error) => {
      assert.match(error.message, /already holds a job bound to t2v-low-standard/);
      assert.match(error.message, /80 tokens have been spent/);
      return true;
    },
  );
});

test("fonts can be skipped, and a font that cannot be fetched is a warning, not a failure", async () => {
  const parent = await mkdtemp(join(tmpdir(), "fuse-tools-"));
  const offline = harness({
    fetch: async () => {
      throw new Error("getaddrinfo ENOTFOUND fonts.googleapis.com");
    },
  });
  const warned = (await offline.tool("fuse_project_new").run({
    dir: join(parent, "offline"),
    tier: "t2v-low-standard",
    resolution: "480p",
    aspect: "16:9",
  })) as { warnings: string[] };
  assert.match(warned.warnings.join(" "), /ENOTFOUND/);

  const latin = harness();
  const skipped = (await latin.tool("fuse_project_new").run({
    dir: join(parent, "latin-only"),
    tier: "t2v-low-standard",
    resolution: "480p",
    aspect: "16:9",
    fonts: false,
  })) as { fonts: string[] };
  assert.deepEqual(skipped.fonts, []);
  assert.deepEqual(latin.fetched, [], "no font is fetched when it was not asked for");
});

/* ------------------------------------------------------------------- scenes */

test("the scenes land on disk and the answer points at the next step", async () => {
  const { dir, harness: bench } = await project();
  const view = (await bench.tool("fuse_scenes").run({
    dir,
    maxTokens: 500,
    scenes: SCENES,
  })) as { done: number; total: number; spent: number; scenes: Array<{ file?: string }>; next: string };

  assert.equal(view.total, 2);
  assert.equal(view.done, 2);
  assert.equal(view.spent, 80);
  assert.match(view.next, /fuse_manifest/);
  for (const scene of view.scenes) await stat(join(dir, scene.file!));
});

test("calling it again waits on rather than paying again", async () => {
  const { dir, harness: bench } = await project();
  await bench.tool("fuse_scenes").run({ dir, maxTokens: 500, scenes: SCENES });
  const again = (await bench.tool("fuse_scenes").run({ dir, maxTokens: 500, scenes: SCENES })) as {
    spent: number;
    done: number;
  };
  assert.equal(bench.runs.submits.length, 2, "the same ask must be submitted once");
  assert.equal(again.spent, 80);
  assert.equal(again.done, 2);
});

test("maxTokens is the project's ceiling, so what was already spent counts against it", async () => {
  const { dir, harness: bench } = await project();
  await bench.tool("fuse_scenes").run({ dir, maxTokens: 500, scenes: SCENES });

  const third = [...SCENES, { slug: "scene-c", prompt: "A straw goes in.", seconds: 5 }];
  const refused = (await bench.tool("fuse_scenes").run({
    dir,
    maxTokens: 100, // 80 already spent; one more scene is 40
    scenes: third,
  })) as { stopped?: string; detail?: string; spent: number };

  assert.equal(refused.stopped, "over_budget");
  assert.match(refused.detail!, /80 already spent/);
  assert.equal(refused.spent, 80, "a refusal spends nothing");
  assert.equal(bench.runs.submits.length, 2);

  const raised = (await bench.tool("fuse_scenes").run({ dir, maxTokens: 200, scenes: third })) as {
    done: number;
    spent: number;
  };
  assert.equal(raised.done, 3);
  assert.equal(raised.spent, 120);
});

/* ----------------------------------------------------------------- manifest */

test("the manifest reports the measured canvas, not one derived from the tier", async () => {
  const { dir, harness: bench } = await project();
  await bench.tool("fuse_scenes").run({ dir, maxTokens: 500, scenes: SCENES });
  const manifest = (await bench.tool("fuse_manifest").run({ dir })) as {
    canvas: { width: number; height: number };
    totalSeconds: number;
    scenes: Array<{ slug: string; seconds: number }>;
    file: string;
  };

  // 864x480 from one provider and 832x480 from another, both "480p 16:9".
  assert.deepEqual(manifest.canvas, { width: 864, height: 480 });
  assert.deepEqual(manifest.scenes.map((scene) => scene.seconds), [5.167, 6.583]);
  assert.equal(manifest.totalSeconds, 11.75);

  const written = JSON.parse(await readFile(join(dir, manifest.file), "utf8"));
  assert.deepEqual(written.canvas, manifest.canvas);
});

test("asking for a manifest before any clip exists says so plainly", async () => {
  const { dir, harness: bench } = await project();
  await assert.rejects(() => bench.tool("fuse_manifest").run({ dir }), /nothing to measure/);
});

/* -------------------------------------------------------------- the writing */

test("every tool's description tells the model what it costs and what comes next", () => {
  for (const name of harness().names) {
    const definition = harness().tool(name);
    assert.ok(definition.title.length > 0, `${name} needs a title`);
    assert.ok(definition.description.length > 120, `${name}'s description is too thin to act on`);
  }
  // The one that spends money says so, in those words.
  assert.match(harness().tool("fuse_scenes").description, /only tool that spends tokens/);
});
