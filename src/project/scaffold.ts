/**
 * What HyperFrames needs on disk before an agent can write a composition.
 *
 * This module does not reimplement a HyperFrames project. Its CLI already
 * scaffolds one — with its own `hyperframes.json`, its own skills and its own
 * CLAUDE.md — so `createProject` runs `hyperframes init` and stops there. What
 * Fuse adds on top is only what Fuse knows: the clips, a font that can render
 * Thai, and the measured size of what came back.
 *
 * The canvas is measured, never calculated. The same nominal size comes back in
 * different pixel boxes depending on which provider served the tier — 480p at
 * 16:9 arrived as 864x480 from MiniMax H3 and 832x480 from WaveSpeed — so a
 * table of resolution x aspect would be wrong for one tier or the other, and
 * `init --resolution` cannot say either of them (its presets start at 1080).
 * A composition built on a guessed canvas is silently upscaled, which is how
 * the first trial run turned a 37 second render into 2 minutes 30.
 */
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join, posix } from "node:path";
import type { Job, SceneRecord } from "../domain.ts";

/** Pinned in one place: the project's scripts name this same version. */
export const HYPERFRAMES_VERSION = "0.8.202";

const FONT_DIR = posix.join("assets", "fonts");
const FONT_CSS = posix.join(FONT_DIR, "noto-sans-thai.css");
const SCENE_DIR = posix.join("assets", "scenes");
const MANIFEST = posix.join(SCENE_DIR, "manifest.json");

const GOOGLE_FONT_CSS =
  "https://fonts.googleapis.com/css2?family=Noto+Sans+Thai:wght@400;700&display=swap";

/** Google serves woff2 only to a browser-shaped request. */
const FONT_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

export interface CommandResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** Runs a command; injected so tests never spawn anything. */
export type Runner = (
  command: string,
  args: readonly string[],
  cwd: string,
) => Promise<CommandResult>;

export interface ClipBox {
  readonly width: number;
  readonly height: number;
  readonly seconds: number;
  /**
   * The clip's own frame rate. Absent when ffprobe did not report a usable
   * one, which is the honest answer: a guessed rate is the same mistake as a
   * guessed canvas, one axis over.
   */
  readonly fps?: number;
  /** Whether the provider returned sound on the clip. */
  readonly hasAudio: boolean;
}

/** Reads a clip's real box and length. Injected for the same reason. */
export type Probe = (file: string) => Promise<ClipBox>;

/**
 * Reads how long a media file runs, in seconds. Separate from `Probe` because
 * an mp3 has no video stream to read a box from, and `Probe` requires one.
 */
export type ProbeDuration = (file: string) => Promise<number>;

export type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;

export interface ScaffoldDeps {
  readonly run: Runner;
  readonly probe: Probe;
  /** Optional: a machine without ffprobe can still scaffold and generate. */
  readonly probeDuration?: ProbeDuration;
  readonly fetch?: Fetcher;
}

/* ------------------------------------------------------------------ project */

export interface ProjectReport {
  readonly dir: string;
  readonly created: boolean;
  readonly log: string;
}

/**
 * Creates a HyperFrames project named `name` under `parent`, or picks up the
 * one that is already there.
 *
 * `--non-interactive` is not optional here: the CLI otherwise prompts, and a
 * tool call has nobody to answer it.
 *
 * The scaffold has to be resumable, because it is the slow part of creating a
 * project — on a cold machine it fetches HyperFrames and a browser — and a
 * client cuts a tool call off long before that finishes. A first attempt
 * therefore leaves a scaffolded directory behind quite often, and `init`
 * refuses to run anywhere that is not empty, so without this the customer is
 * stuck with a directory they have to delete by hand. `hyperframes.json` is
 * what says the scaffold got written: finding one means that work is done,
 * not that something is in the way.
 */
export async function createProject(
  parent: string,
  name: string,
  deps: ScaffoldDeps,
): Promise<ProjectReport> {
  const dir = join(parent, name);
  if (existsSync(join(dir, "hyperframes.json"))) {
    await mkdir(join(dir, SCENE_DIR), { recursive: true });
    return { dir, created: false, log: "the HyperFrames scaffold was already there" };
  }
  // `init` runs with the parent as its working directory, and spawning into a
  // directory that does not exist fails as ENOENT naming the shell rather than
  // the missing path — which tells the caller nothing. Picking a fresh folder
  // for an ad is the normal first move, so make the parent instead.
  await mkdir(parent, { recursive: true });
  const result = await deps.run(
    "npx",
    ["--yes", `hyperframes@${HYPERFRAMES_VERSION}`, "init", name, "--non-interactive"],
    parent,
  );
  if (result.code !== 0) {
    // A directory that is in the way but holds no `hyperframes.json` is not a
    // half-built project of ours, and so is not ours to write into either.
    const inTheWay = existsSync(dir)
      ? `

${dir} exists and is not a HyperFrames project. Use another directory, or ` +
        "empty that one yourself — this tool will not delete a directory it did not create."
      : "";
    throw new Error(
      `hyperframes init failed (exit ${result.code}). Its own output says:
${
        result.stderr || result.stdout
      }${inTheWay}`,
    );
  }
  await mkdir(join(dir, SCENE_DIR), { recursive: true });
  return { dir, created: true, log: result.stdout };
}

/* -------------------------------------------------------------------- fonts */

export interface FontReport {
  readonly files: readonly string[];
  readonly css: string;
  /** Set when the fonts could not be fetched; the project is still usable. */
  readonly warning?: string;
}

/**
 * Puts Noto Sans Thai in the project as local woff2 files and a stylesheet.
 *
 * Thai has to be local. The renderer resolves a webfont only partly, so Thai
 * glyphs fall back to tofu in a headless Chrome that has no Thai font
 * installed — HyperFrames' own `lint` catches it before a render, which is how
 * this was found. The files are fetched at project time rather than shipped in
 * this package, so no font binary is redistributed with it.
 */
export async function installFonts(dir: string, deps: ScaffoldDeps): Promise<FontReport> {
  const get = deps.fetch ?? fetch;
  await mkdir(join(dir, FONT_DIR), { recursive: true });
  let css: string;
  try {
    const response = await get(GOOGLE_FONT_CSS, { headers: { "User-Agent": FONT_UA } });
    if (!response.ok) throw new Error(`Google Fonts answered ${response.status}`);
    css = await response.text();
  } catch (cause) {
    return {
      files: [],
      css: FONT_CSS,
      warning:
        `Noto Sans Thai could not be fetched (${(cause as Error).message}). Thai captions will ` +
        `fail HyperFrames' lint until a woff2 file is placed in ${FONT_DIR} and declared in ${FONT_CSS}.`,
    };
  }

  // Rewrite each remote src to the local copy, keeping Google's own weights and
  // unicode-range blocks: those are what make the subsets load correctly.
  const urls = [...css.matchAll(/url\((https:\/\/[^)]+\.woff2)\)/g)].flatMap(
    (match) => match[1] ?? [],
  );
  const unique = [...new Set(urls)];
  const names = new Map<string, string>();
  const files: string[] = [];
  for (const [index, url] of unique.entries()) {
    const name = `noto-sans-thai-${index + 1}.woff2`;
    const response = await get(url);
    if (!response.ok) throw new Error(`${url} answered ${response.status}`);
    await writeFile(join(dir, FONT_DIR, name), Buffer.from(await response.arrayBuffer()));
    names.set(url, name);
    files.push(posix.join(FONT_DIR, name));
  }
  const local = css.replace(/url\((https:\/\/[^)]+\.woff2)\)/g, (whole, url: string) => {
    const name = names.get(url);
    return name ? `url(${name})` : whole;
  });
  await writeFile(
    join(dir, FONT_CSS),
    `/* Noto Sans Thai, fetched from Google Fonts for local rendering. */\n${local}`,
    "utf8",
  );
  return { files, css: FONT_CSS };
}

/* ----------------------------------------------------------------- manifest */

export interface ManifestScene {
  readonly slug: string;
  readonly file: string;
  readonly width: number;
  readonly height: number;
  readonly seconds: number;
  readonly fps?: number;
  readonly hasAudio: boolean;
}

export interface Manifest {
  readonly canvas: { readonly width: number; readonly height: number };
  /** The rate to render at. Absent when no clip reported one. */
  readonly fps?: number;
  /** True when any clip came back with sound on it. */
  readonly hasAudio: boolean;
  readonly totalSeconds: number;
  readonly scenes: readonly ManifestScene[];
  readonly note: string;
}

/**
 * Measures every clip that is on disk and writes what a composition needs:
 * the canvas to use and each clip's real length.
 *
 * The canvas is the largest box among the clips, so nothing is scaled up. The
 * durations are the provider's, not the ones that were asked for — a 5 second
 * ask came back as 5.167 s, and a composition laid out on 5.0 would cut each
 * scene short.
 */
export async function writeManifest(dir: string, job: Job, deps: ScaffoldDeps): Promise<Manifest> {
  const ready = job.scenes.filter(
    (scene): scene is SceneRecord & { file: string } =>
      scene.state === "ready" && typeof scene.file === "string",
  );
  if (ready.length === 0) {
    throw new Error("no scene has been rendered yet, so there is nothing to measure");
  }
  const scenes: ManifestScene[] = [];
  for (const scene of ready) {
    const box = await deps.probe(join(dir, scene.file));
    scenes.push({
      slug: scene.slug,
      file: scene.file,
      width: box.width,
      height: box.height,
      seconds: box.seconds,
      ...(box.fps === undefined ? {} : { fps: box.fps }),
      hasAudio: box.hasAudio,
    });
  }
  // The fastest clip sets the rate, for the same reason the largest box sets
  // the canvas: rendering below a clip's own rate throws its frames away.
  const rates = scenes
    .map((scene) => scene.fps)
    .filter((fps): fps is number => typeof fps === "number" && fps > 0);
  const fps = rates.length === 0 ? undefined : Math.max(...rates);
  const manifest: Manifest = {
    canvas: {
      width: Math.max(...scenes.map((scene) => scene.width)),
      height: Math.max(...scenes.map((scene) => scene.height)),
    },
    ...(fps === undefined ? {} : { fps }),
    hasAudio: scenes.some((scene) => scene.hasAudio),
    totalSeconds: Number(scenes.reduce((sum, scene) => sum + scene.seconds, 0).toFixed(3)),
    scenes,
    note:
      "Measured from the clips themselves. Use this canvas for the composition's " +
      "data-width/data-height, the CSS box and the viewport meta: a larger canvas " +
      "upscales the footage and multiplies render time. Render at this fps too, " +
      "as the root's data-fps: HyperFrames renders at 30 unless told otherwise, " +
      "and 24 fps footage rendered at 30 carries a duplicate of every fifth frame. " +
      "hasAudio is what the provider actually returned, not what the tier promises: " +
      "when it is true the clips carry sound that was paid for, so keep it on the " +
      "<video> (data-has-audio) instead of muting it, unless silence was asked for.",
  };
  await mkdir(join(dir, SCENE_DIR), { recursive: true });
  await writeFile(join(dir, MANIFEST), `${JSON.stringify(manifest, undefined, 2)}\n`, "utf8");
  return manifest;
}

/** The real probe: ffprobe, as the installer left it. */
export function ffprobeProbe(run: Runner): Probe {
  return async (file: string) => {
    const binary = process.env.FFPROBE_PATH || "ffprobe";
    const result = await run(
      binary,
      [
        "-v",
        "error",
        // Every stream, not just v:0 — the audio stream is half the answer.
        "-show_entries",
        "stream=codec_type,width,height,r_frame_rate",
        "-show_entries",
        "format=duration",
        "-of",
        "json",
        file,
      ],
      process.cwd(),
    );
    if (result.code !== 0) {
      throw new Error(`ffprobe could not read ${file}: ${result.stderr || result.stdout}`);
    }
    const parsed = JSON.parse(result.stdout) as {
      streams?: Array<{
        codec_type?: string;
        width?: number;
        height?: number;
        r_frame_rate?: string;
      }>;
      format?: { duration?: string };
    };
    const streams = parsed.streams ?? [];
    const stream = streams.find((candidate) => candidate.width && candidate.height);
    const seconds = Number(parsed.format?.duration);
    if (!stream?.width || !stream.height || !Number.isFinite(seconds)) {
      throw new Error(`ffprobe read ${file} but found no video stream in it`);
    }
    const fps = readRate(stream.r_frame_rate);
    return {
      width: stream.width,
      height: stream.height,
      seconds,
      ...(fps === undefined ? {} : { fps }),
      hasAudio: streams.some((candidate) => candidate.codec_type === "audio"),
    };
  };
}

/**
 * ffprobe states a frame rate as a rational: "24/1", "30000/1001". A container
 * that has none says "0/0", and that is not a rate to render at — it comes back
 * undefined so the caller can say it does not know instead of rendering at 30.
 */
export function readRate(rate: string | undefined): number | undefined {
  if (!rate) return undefined;
  const [top, bottom] = rate.split("/");
  const numerator = Number(top);
  const denominator = bottom === undefined ? 1 : Number(bottom);
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator === 0) {
    return undefined;
  }
  const fps = numerator / denominator;
  return fps > 0 ? Number(fps.toFixed(3)) : undefined;
}

/**
 * The duration-only probe: the same ffprobe, asked for the container's length
 * and nothing else, so it answers for an mp3 as readily as for an mp4.
 */
export function ffprobeDuration(run: Runner): ProbeDuration {
  return async (file: string) => {
    const binary = process.env.FFPROBE_PATH || "ffprobe";
    const result = await run(
      binary,
      ["-v", "error", "-show_entries", "format=duration", "-of", "json", file],
      process.cwd(),
    );
    if (result.code !== 0) {
      throw new Error(`ffprobe could not read ${file}: ${result.stderr || result.stdout}`);
    }
    const parsed = JSON.parse(result.stdout) as { format?: { duration?: string } };
    const seconds = Number(parsed.format?.duration);
    if (!Number.isFinite(seconds) || seconds <= 0) {
      throw new Error(`ffprobe read ${file} but found no playable duration in it`);
    }
    return Number(seconds.toFixed(3));
  };
}

/* --------------------------------------------------------------------- deps */

export interface DepReport {
  readonly ok: boolean;
  /** HyperFrames' own words from `doctor`, passed through. */
  readonly doctor: string;
  readonly chrome: string;
  readonly problems: readonly string[];
}

/**
 * Asks HyperFrames whether this machine can render, and makes sure the Chrome
 * it renders with exists. Both are its own commands — this does not re-check
 * ffmpeg or Node versions, because `doctor` already does and would drift.
 */
export async function ensureDeps(cwd: string, deps: ScaffoldDeps): Promise<DepReport> {
  const problems: string[] = [];
  const doctor = await deps.run(
    "npx",
    ["--yes", `hyperframes@${HYPERFRAMES_VERSION}`, "doctor"],
    cwd,
  );
  if (doctor.code !== 0) problems.push(doctor.stderr || doctor.stdout);
  const chrome = await deps.run(
    "npx",
    ["--yes", `hyperframes@${HYPERFRAMES_VERSION}`, "browser", "ensure"],
    cwd,
  );
  if (chrome.code !== 0) problems.push(chrome.stderr || chrome.stdout);
  const major = Number(process.versions.node.split(".")[0]);
  if (major < 22) {
    problems.push(`HyperFrames needs Node 22 or newer; this is Node ${process.versions.node}`);
  }
  return {
    ok: problems.length === 0,
    doctor: doctor.stdout.trim(),
    chrome: chrome.stdout.trim(),
    problems,
  };
}

/**
 * The real runner. Kept out of the exported surface's way so tests can skip it.
 *
 * `cross-spawn`, not `node:child_process`, and deliberately no `shell: true`.
 * The commands here are `npx`, `claude` and `codex`, which on Windows are
 * `.cmd` shims that a bare spawn refuses to execute — the usual answer is
 * `shell: true`, but that concatenates the arguments into one command line
 * without escaping them (Node's own DEP0190 says so), and one of those
 * arguments is a project name that came from a model. `cross-spawn` runs the
 * shim through cmd.exe with the escaping done properly.
 */
export function spawnRunner(): Runner {
  return async (command, args, cwd) => {
    const { default: spawn } = await import("cross-spawn");
    return new Promise<CommandResult>((resolve, reject) => {
      const child = spawn(command, [...args], { cwd, stdio: ["ignore", "pipe", "pipe"] });
      // The streams are typed nullable because a caller could ask for other
      // stdio; this one asks for pipes, so missing them is a broken promise
      // worth hearing about rather than reading as empty output.
      const { stdout: out, stderr: err } = child;
      if (!out || !err) {
        reject(new Error(`${command} was spawned without the pipes needed to read it`));
        return;
      }
      let stdout = "";
      let stderr = "";
      out.on("data", (chunk) => (stdout += chunk));
      err.on("data", (chunk) => (stderr += chunk));
      child.on("error", reject);
      child.on("close", (code) => resolve({ code: code ?? 0, stdout, stderr }));
    });
  };
}
