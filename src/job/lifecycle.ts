/**
 * The only module that spends tokens, and the only writer of `.fuse/job.json`.
 *
 * One idea carries the whole file: **a scene is paid for once.** A scene's
 * identity is the hash of what would be sent to the API — tier, resolution,
 * aspect, prompt, duration, references. If a record with that hash already has
 * a run id, the tokens are already gone and the run is followed instead of
 * started again. That is why the id is written to disk in the same step it
 * comes back, before anything else can fail: a client that dies between the
 * charge and the file would otherwise pay twice for the same clip.
 *
 * `advance` is therefore safe to call again. It is one door for the whole
 * cycle — price, check the budget, submit what has no run yet, follow the runs,
 * fetch each clip the moment it is done — and it blocks for at most `waitMs`
 * before handing back a partial picture. Calling it again continues waiting; it
 * never starts over. There is deliberately no second "status" tool to get this
 * wrong with.
 *
 * Finished clips are fetched at once and never remembered as links: the host
 * differs by tier and a provider URL expires, so a link that reached the model
 * would be a link that breaks later.
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { dirname, join, posix } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  type Budget,
  type Job,
  type JobSpec,
  type JobView,
  type SceneRecord,
  type SceneSpec,
  type StopReason,
} from "../domain.ts";
import { FuseError, type OpenClip, type RunView } from "../fuse/client.ts";
import type { Catalog } from "../fuse/catalog.ts";

const STATE_FILE = posix.join(".fuse", "job.json");
const SCENE_DIR = posix.join("assets", "scenes");
const STATE_VERSION = 1;

/** What `Runs` offers; a test gives its own. */
export interface RunsPort {
  submit(spec: JobSpec, scene: SceneSpec): Promise<RunView>;
  status(runId: string): Promise<RunView>;
}

interface StateFile {
  version: number;
  job: Job;
}

/**
 * The hash that decides whether two asks are the same scene. The slug is left
 * out on purpose: renaming a scene must not make the account pay for the same
 * clip twice, and changing a prompt by one character really is a new render.
 */
export function specHash(spec: JobSpec, scene: SceneSpec): string {
  const canonical = JSON.stringify([
    spec.tier,
    spec.resolution,
    spec.aspect,
    scene.prompt,
    scene.seconds,
    scene.imageUrls ?? [],
    scene.lastImageUrl ?? "",
  ]);
  return createHash("sha256").update(canonical).digest("hex");
}

/** Tokens the account has been charged: every scene that reached a run. */
function spentOf(scenes: readonly SceneRecord[]): number {
  return scenes
    .filter((scene) => scene.runId !== undefined)
    .reduce((sum, scene) => sum + (scene.tokens ?? 0), 0);
}

/**
 * Owns `.fuse/job.json`. Every write goes to a temporary file and is renamed
 * over the real one, so a client killed mid-write leaves the previous state
 * readable rather than half a file.
 *
 * Writes are queued, and each gets its own temporary name. Scenes finish at the
 * same time — that is the point of submitting them together — and two writes
 * sharing one temporary path means one of them renames a file the other has
 * already moved. The first version of this did share it, and the second scene
 * of a pair lost its "ready" state about half the time.
 */
export class JobStore {
  readonly dir: string;
  private current: Job;
  private queue: Promise<unknown> = Promise.resolve();
  private writes = 0;

  private constructor(dir: string, job: Job) {
    this.dir = dir;
    this.current = job;
  }

  /** Reads an existing job, or undefined when the directory has none. */
  static async open(dir: string): Promise<JobStore | undefined> {
    let text: string;
    try {
      text = await readFile(join(dir, STATE_FILE), "utf8");
    } catch (cause) {
      if ((cause as { code?: string }).code === "ENOENT") return undefined;
      throw cause;
    }
    const state = JSON.parse(text) as StateFile;
    if (state.version !== STATE_VERSION) {
      throw new Error(
        `${STATE_FILE} was written by another version of this package (version ${state.version})`,
      );
    }
    return new JobStore(dir, state.job);
  }

  /** Starts a job, or returns the one already in the directory. */
  static async start(dir: string, id: string, spec: JobSpec): Promise<JobStore> {
    const existing = await JobStore.open(dir);
    if (existing) return existing;
    const store = new JobStore(dir, { id, spec, scenes: [], spent: 0 });
    await store.write();
    return store;
  }

  get job(): Job {
    return this.current;
  }

  /**
   * Writes one scene record through, immediately.
   *
   * Records are kept by `specHash`, not by slug: a re-prompted scene is a new
   * record beside the old one rather than on top of it, so the row that proves
   * an earlier clip was paid for — and names the file it landed in — cannot be
   * erased by editing a prompt.
   */
  async put(record: SceneRecord): Promise<void> {
    const scenes = this.current.scenes.some((scene) => scene.specHash === record.specHash)
      ? this.current.scenes.map((scene) => (scene.specHash === record.specHash ? record : scene))
      : [...this.current.scenes, record];
    this.current = { ...this.current, scenes, spent: spentOf(scenes) };
    await this.write();
  }

  /** The record that already paid for this exact ask, under any slug. */
  paidFor(hash: string): SceneRecord | undefined {
    return this.current.scenes.find((scene) => scene.specHash === hash && scene.runId !== undefined);
  }

  private write(): Promise<void> {
    const mine = this.queue.then(() => this.flush());
    // The chain has to survive a failed write, or every later write is poisoned.
    this.queue = mine.catch(() => undefined);
    return mine;
  }

  private async flush(): Promise<void> {
    const path = join(this.dir, STATE_FILE);
    await mkdir(dirname(path), { recursive: true });
    const temporary = `${path}.${process.pid}.${++this.writes}.tmp`;
    const state: StateFile = { version: STATE_VERSION, job: this.current };
    await writeFile(temporary, `${JSON.stringify(state, undefined, 2)}\n`, "utf8");
    await rename(temporary, path);
  }
}

export interface LifecycleDeps {
  readonly runs: RunsPort;
  readonly catalog: Catalog;
  readonly openClip: OpenClip;
  /** Overridden in tests so a deadline does not take real seconds. */
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
}

export interface AdvanceOptions {
  /** Required: there is no unlimited spend on any path. */
  readonly budget: Budget;
  readonly waitMs?: number;
  readonly pollMs?: number;
}

/**
 * Measured, not guessed: the MCP SDK caps a request at 60 s by default, and a
 * client has to opt out of that. A block longer than the cap never reports
 * partial progress — the call just fails as a timeout, which reads to the
 * model as a broken tool rather than as work still running. 45 s leaves room
 * for the round trips inside one call and stays well under the cap.
 */
const DEFAULT_WAIT_MS = 45_000;
const DEFAULT_POLL_MS = 5_000;

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export class Lifecycle {
  private readonly store: JobStore;
  private readonly runs: RunsPort;
  private readonly catalog: Catalog;
  private readonly open: OpenClip;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(store: JobStore, deps: LifecycleDeps) {
    this.store = store;
    this.runs = deps.runs;
    this.catalog = deps.catalog;
    this.open = deps.openClip;
    this.now = deps.now ?? Date.now;
    this.sleep = deps.sleep ?? defaultSleep;
  }

  /**
   * Brings every named scene as far as it can inside `waitMs`, then reports.
   * Scenes already on disk are left alone; scenes already submitted are
   * followed; only a scene with no run of its own costs anything.
   */
  async advance(scenes: readonly SceneSpec[], options: AdvanceOptions): Promise<JobView> {
    const spec = this.store.job.spec;
    const deadline = this.now() + (options.waitMs ?? DEFAULT_WAIT_MS);
    const pollMs = options.pollMs ?? DEFAULT_POLL_MS;

    const estimate = this.catalog.estimate(spec, scenes);
    // Priced by slug rather than by position: slugs are already unique here,
    // and a price read off the wrong index would charge the wrong scene quietly.
    const priced = new Map(estimate.lines.map((line) => [line.slug, line.tokens]));
    const asked = new Map<string, { scene: SceneSpec; hash: string; tokens: number }>();
    for (const scene of scenes) {
      const tokens = priced.get(scene.slug);
      if (tokens === undefined) {
        throw new Error(`${scene.slug} came back from the estimate without a price`);
      }
      asked.set(scene.slug, { scene, hash: specHash(spec, scene), tokens });
    }

    // What this call would add to what the account has already been charged.
    const newSpend = [...asked.values()]
      .filter((entry) => this.store.paidFor(entry.hash) === undefined)
      .reduce((sum, entry) => sum + entry.tokens, 0);
    if (options.budget.alreadySpent + newSpend > options.budget.maxTokens) {
      // Nothing is submitted: a partial job the caller did not ask for is worse
      // than no job, and it would have been paid for.
      return this.view(
        asked,
        "over_budget",
        `these scenes need about ${newSpend} more tokens, which is over the ${options.budget.maxTokens} token budget` +
          (options.budget.alreadySpent > 0 ? ` (${options.budget.alreadySpent} already spent)` : ""),
      );
    }

    let stopped: StopReason | undefined;
    let detail: string | undefined;

    for (const [slug, entry] of asked) {
      const paid = this.store.paidFor(entry.hash);
      if (paid) {
        // Already charged for — under this slug or an earlier name for it. The
        // run is followed, never started again; renaming it only renames it.
        if (paid.slug !== slug) await this.store.put({ ...paid, slug });
        continue;
      }
      try {
        const run = await this.runs.submit(spec, entry.scene);
        // Written before anything else can throw: the charge has happened.
        await this.store.put({
          slug,
          specHash: entry.hash,
          state: "working",
          runId: run.id,
          tokens: entry.tokens,
        });
      } catch (error) {
        const fuse = error instanceof FuseError ? error : undefined;
        stopped =
          fuse?.kind === "insufficient_tokens"
            ? "insufficient_tokens"
            : fuse?.kind === "server" || fuse?.kind === "transport"
              ? "provider_failed"
              : "rejected_by_api";
        detail = fuse?.detail ?? (error as Error).message;
        await this.store.put({
          slug,
          specHash: entry.hash,
          state: "planned",
          lastError: detail,
        });
        break; // Every scene shares one spec, so the next would fail the same way.
      }
    }

    if (stopped === undefined) {
      await this.follow(asked, deadline, pollMs);
      if (this.pending(asked).some((record) => record.state === "failed")) {
        stopped = "provider_failed";
        detail = this.pending(asked).find((record) => record.state === "failed")?.lastError;
      }
    }
    return this.view(asked, stopped, detail);
  }

  /** Polls every unfinished run in parallel until they finish or time runs out. */
  private async follow(
    asked: Map<string, { scene: SceneSpec; hash: string; tokens: number }>,
    deadline: number,
    pollMs: number,
  ): Promise<void> {
    for (;;) {
      const working = this.pending(asked).filter((record) => record.state === "working");
      if (working.length === 0) return;
      await Promise.all(working.map((record) => this.step(record)));
      const left = this.pending(asked).filter((record) => record.state === "working");
      if (left.length === 0) return;
      if (this.now() + pollMs >= deadline) return; // Partial is fine; calling again waits on.
      await this.sleep(pollMs);
    }
  }

  /** One look at one run, and the fetch that must follow a COMPLETED at once. */
  private async step(record: SceneRecord): Promise<void> {
    let run: RunView;
    try {
      run = await this.runs.status(record.runId!);
    } catch (error) {
      const fuse = error instanceof FuseError ? error : undefined;
      // A paid run is never given up on because one poll failed; the deadline
      // ends the wait, and the next call picks the same run back up.
      await this.store.put({ ...record, lastError: fuse?.detail ?? (error as Error).message });
      return;
    }
    if (run.status === "IN_PROGRESS") return;
    if (run.status === "FAILED" || run.status === "CANCELLED") {
      await this.store.put({
        ...record,
        state: "failed",
        lastError: `the run ended ${run.status}; the server refunds a failed render`,
      });
      return;
    }
    if (!run.outputUrl) {
      await this.store.put({ ...record, lastError: "the run completed without an output URL" });
      return;
    }
    try {
      const file = await this.fetchClip(record, run.outputUrl);
      await this.store.put({ ...record, state: "ready", file, lastError: undefined });
    } catch (error) {
      const fuse = error instanceof FuseError ? error : undefined;
      await this.store.put({ ...record, lastError: fuse?.detail ?? (error as Error).message });
    }
  }

  /**
   * Streams the clip to `assets/scenes/<slug>-<hash>.mp4`. The hash is in the
   * name so a re-prompted scene writes a new file instead of overwriting a clip
   * that was already paid for, and so the record's path is enough to tell two
   * versions apart.
   */
  private async fetchClip(record: SceneRecord, url: string): Promise<string> {
    const name = `${record.slug}-${record.specHash.slice(0, 8)}.mp4`;
    const relative = posix.join(SCENE_DIR, name);
    const absolute = join(this.store.dir, SCENE_DIR, name);
    await mkdir(dirname(absolute), { recursive: true });
    const temporary = `${absolute}.part`;
    const body = await this.open(url);
    await pipeline(Readable.fromWeb(body as Parameters<typeof Readable.fromWeb>[0]), createWriteStream(temporary));
    await rename(temporary, absolute);
    return relative; // A path, never the URL it came from.
  }

  private recordFor(hash: string): SceneRecord | undefined {
    return this.store.job.scenes.find((scene) => scene.specHash === hash);
  }

  /** The record of each scene this call asked for, in the order it asked. */
  private pending(asked: Map<string, { hash: string }>): SceneRecord[] {
    return [...asked.values()]
      .map((entry) => this.recordFor(entry.hash))
      .filter((record): record is SceneRecord => record !== undefined);
  }

  private view(
    asked: Map<string, { hash: string }>,
    stopped?: StopReason,
    detail?: string,
  ): JobView {
    const scenes = this.pending(asked);
    return {
      job: this.store.job.id,
      spent: this.store.job.spent,
      done: scenes.filter((record) => record.state === "ready").length,
      total: asked.size,
      scenes,
      stopped,
      detail,
    };
  }
}
