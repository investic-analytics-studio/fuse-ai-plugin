/**
 * Nothing here spawns a process or reaches the network: the runner, the probe
 * and the fetch are injected. What is checked is the part that can be wrong on
 * a customer's machine — the exact command line, the canvas that comes out of
 * real measurements, and what happens when the fonts cannot be fetched.
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  HYPERFRAMES_VERSION,
  createProject,
  ensureDeps,
  ffprobeProbe,
  installFonts,
  spawnRunner,
  writeManifest,
  type ClipBox,
  type CommandResult,
  type Runner,
  type ScaffoldDeps,
} from "../src/project/scaffold.ts";
import type { Job } from "../src/domain.ts";

const OK: CommandResult = { code: 0, stdout: "", stderr: "" };

interface Spawned {
  command: string;
  args: readonly string[];
  cwd: string;
}

function recorder(result: (spawned: Spawned) => CommandResult = () => OK): {
  run: Runner;
  calls: Spawned[];
} {
  const calls: Spawned[] = [];
  const run: Runner = async (command, args, cwd) => {
    const spawned = { command, args, cwd };
    calls.push(spawned);
    return result(spawned);
  };
  return { run, calls };
}

/** The pixel boxes really measured on prod, per tier. */
const BOXES: Record<string, ClipBox> = {
  "scene-a": { width: 864, height: 480, seconds: 5.167 }, // MiniMax H3, 480p 16:9
  "scene-b": { width: 832, height: 480, seconds: 6.583 }, // WaveSpeed, same 480p 16:9
};

const deps = (run: Runner): ScaffoldDeps => ({
  run,
  probe: async (file: string) => {
    const measured = Object.entries(BOXES).find(([slug]) => file.includes(slug));
    if (!measured) throw new Error(`no measurement for ${file}`);
    return measured[1];
  },
});

test("the project is created by HyperFrames' own init, at a pinned version", async () => {
  const parent = await mkdtemp(join(tmpdir(), "fuse-scaffold-"));
  const { run, calls } = recorder();
  const report = await createProject(parent, "thai-tea-ad", deps(run));

  assert.deepEqual(calls[0], {
    command: "npx",
    args: ["--yes", `hyperframes@${HYPERFRAMES_VERSION}`, "init", "thai-tea-ad", "--non-interactive"],
    cwd: parent,
  });
  assert.equal(report.dir, join(parent, "thai-tea-ad"));
  // The clips need somewhere to land before the first scene finishes.
  await stat(join(report.dir, "assets", "scenes"));
});

test("a failed init says what HyperFrames said, not what we guess", async () => {
  const parent = await mkdtemp(join(tmpdir(), "fuse-scaffold-"));
  const { run } = recorder(() => ({ code: 1, stdout: "", stderr: "EACCES: permission denied" }));
  await assert.rejects(
    () => createProject(parent, "blocked", deps(run)),
    /EACCES: permission denied/,
  );
});

test("a scaffold left behind by a cut-off call is picked up, not treated as an obstacle", async () => {
  // What a customer actually hits: the first call fetched HyperFrames, wrote
  // the scaffold, and was then cut off by the client before the job was
  // recorded. `hyperframes init` refuses to run in a non-empty directory, so
  // without this the directory is a dead end.
  const parent = await mkdtemp(join(tmpdir(), "fuse-scaffold-"));
  const dir = join(parent, "half-built");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "hyperframes.json"), "{}\n", "utf8");

  const { run, calls } = recorder();
  const report = await createProject(parent, "half-built", deps(run));

  assert.equal(report.created, false);
  assert.equal(report.dir, dir);
  assert.deepEqual(calls, [], "init must not be run over a scaffold that is already written");
  await stat(join(dir, "assets", "scenes"));
});

test("a directory that is in the way but is not ours says what to do about it", async () => {
  const parent = await mkdtemp(join(tmpdir(), "fuse-scaffold-"));
  await mkdir(join(parent, "someone-elses"), { recursive: true });
  await writeFile(join(parent, "someone-elses", "notes.txt"), "mine\n", "utf8");
  const { run } = recorder(() => ({
    code: 1,
    stdout: "",
    stderr: "Directory already exists and is not empty: someone-elses",
  }));

  await assert.rejects(
    () => createProject(parent, "someone-elses", deps(run)),
    (error: Error) => {
      assert.match(error.message, /is not empty/, "HyperFrames' own words are kept");
      assert.match(error.message, /will not delete a directory it did not create/);
      return true;
    },
  );
});

test("the canvas is the biggest clip, and the durations are the provider's", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fuse-scaffold-"));
  const { run } = recorder();
  const job: Job = {
    id: "job-1",
    spec: { tier: "t2v-low-standard", resolution: "480p" as never, aspect: "16:9" },
    spent: 80,
    scenes: [
      { slug: "scene-a", specHash: "aaaa1111", state: "ready", runId: "r1", file: "assets/scenes/scene-a-aaaa1111.mp4", tokens: 40 },
      { slug: "scene-b", specHash: "bbbb2222", state: "ready", runId: "r2", file: "assets/scenes/scene-b-bbbb2222.mp4", tokens: 40 },
      { slug: "scene-c", specHash: "cccc3333", state: "working", runId: "r3", tokens: 40 },
    ],
  };
  const manifest = await writeManifest(dir, job, deps(run));

  // 864x480 and 832x480 are the same nominal 480p 16:9 from two providers; the
  // canvas takes the larger box so neither clip is scaled up.
  assert.deepEqual(manifest.canvas, { width: 864, height: 480 });
  // 5 seconds were asked for; 5.167 came back. The composition must use this.
  assert.deepEqual(
    manifest.scenes.map((scene) => [scene.slug, scene.seconds]),
    [
      ["scene-a", 5.167],
      ["scene-b", 6.583],
    ],
  );
  assert.equal(manifest.totalSeconds, 11.75);
  assert.equal(manifest.scenes.length, 2, "a scene still rendering is not in the manifest");
  assert.match(manifest.note, /upscales the footage/);

  const written = JSON.parse(await readFile(join(dir, "assets", "scenes", "manifest.json"), "utf8"));
  assert.deepEqual(written.canvas, manifest.canvas);
  assert.match(written.scenes[0].file, /^assets\/scenes\//, "paths stay relative to the project");
});

test("measuring before anything has rendered is refused, not guessed", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fuse-scaffold-"));
  const { run } = recorder();
  const job: Job = {
    id: "job-2",
    spec: { tier: "t2v-low-standard", resolution: "480p" as never, aspect: "16:9" },
    spent: 0,
    scenes: [{ slug: "scene-a", specHash: "aaaa1111", state: "planned" }],
  };
  await assert.rejects(() => writeManifest(dir, job, deps(run)), /nothing to measure/);
});

test("ffprobe's own output is read for the box and the length", async () => {
  // Copied from a real run against one of the downloaded clips.
  const real = `{
    "programs": [],
    "stream_groups": [],
    "streams": [ { "width": 864, "height": 480 } ],
    "format": { "duration": "5.167000" }
  }`;
  const { run, calls } = recorder(() => ({ code: 0, stdout: real, stderr: "" }));
  const box = await ffprobeProbe(run)("scene-a.mp4");

  assert.deepEqual(box, { width: 864, height: 480, seconds: 5.167 });
  assert.ok(calls[0]!.args.includes("stream=width,height"));
});

test("an audio-only or broken file is reported, not silently sized", async () => {
  const noStream = `{ "streams": [], "format": { "duration": "5.0" } }`;
  const { run } = recorder(() => ({ code: 0, stdout: noStream, stderr: "" }));
  await assert.rejects(() => ffprobeProbe(run)("voice.m4a"), /no video stream/);
});

test("the Thai font is fetched and rewritten to local files", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fuse-scaffold-"));
  const { run } = recorder();
  // Shortened, but the shape Google really serves: one block per subset.
  const css = [
    "@font-face {",
    "  font-family: 'Noto Sans Thai';",
    "  font-weight: 400;",
    "  src: url(https://fonts.gstatic.com/s/notosansthai/v1/thai.woff2) format('woff2');",
    "  unicode-range: U+0E01-0E5B;",
    "}",
    "@font-face {",
    "  font-family: 'Noto Sans Thai';",
    "  font-weight: 700;",
    "  src: url(https://fonts.gstatic.com/s/notosansthai/v1/latin.woff2) format('woff2');",
    "  unicode-range: U+0000-00FF;",
    "}",
  ].join("\n");
  const asked: string[] = [];
  const report = await installFonts(dir, {
    ...deps(run),
    fetch: async (url: string, init?: RequestInit) => {
      asked.push(url);
      if (url.includes("css2")) {
        assert.match(
          String((init?.headers as Record<string, string>)["User-Agent"]),
          /Chrome/,
          "Google serves woff2 only to a browser-shaped request",
        );
        return new Response(css, { status: 200 });
      }
      return new Response(new Uint8Array([119, 79, 70, 50]), { status: 200 }); // "wOF2"
    },
  });

  assert.deepEqual(report.files, [
    "assets/fonts/noto-sans-thai-1.woff2",
    "assets/fonts/noto-sans-thai-2.woff2",
  ]);
  assert.equal(report.warning, undefined);
  const stylesheet = await readFile(join(dir, "assets", "fonts", "noto-sans-thai.css"), "utf8");
  assert.doesNotMatch(stylesheet, /https:\/\//, "no remote font URL may be left in the stylesheet");
  assert.match(stylesheet, /url\(noto-sans-thai-1\.woff2\)/);
  assert.match(stylesheet, /unicode-range: U\+0E01-0E5B/, "the subsets' ranges are kept as served");
  assert.equal(asked.length, 3);
  for (const file of report.files) {
    assert.ok((await stat(join(dir, file))).size > 0);
  }
});

test("no network still leaves a usable project, with the lint failure explained", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fuse-scaffold-"));
  const { run } = recorder();
  const report = await installFonts(dir, {
    ...deps(run),
    fetch: async () => {
      throw new Error("getaddrinfo ENOTFOUND fonts.googleapis.com");
    },
  });
  assert.deepEqual(report.files, []);
  assert.match(report.warning!, /ENOTFOUND/);
  assert.match(report.warning!, /fail HyperFrames' lint/);
  await stat(join(dir, "assets", "fonts"));
});

test("the dependency check is HyperFrames' doctor plus the browser it renders with", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fuse-scaffold-"));
  const { run, calls } = recorder((spawned) =>
    spawned.args.includes("doctor")
      ? { code: 0, stdout: "ffmpeg 8.1 ok", stderr: "" }
      : { code: 0, stdout: "Chrome ready", stderr: "" },
  );
  const report = await ensureDeps(dir, deps(run));

  assert.deepEqual(calls.map((call) => call.args.slice(2)), [["doctor"], ["browser", "ensure"]]);
  assert.equal(report.ok, true);
  assert.equal(report.doctor, "ffmpeg 8.1 ok");
  assert.equal(report.chrome, "Chrome ready");
});

test("a machine that cannot render says so in the tool's own words", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fuse-scaffold-"));
  const { run } = recorder((spawned) =>
    spawned.args.includes("doctor")
      ? { code: 1, stdout: "", stderr: "ffmpeg not found on PATH" }
      : OK,
  );
  const report = await ensureDeps(dir, deps(run));
  assert.equal(report.ok, false);
  assert.deepEqual(report.problems, ["ffmpeg not found on PATH"]);
});

test("the real runner hands every argument over whole, however it is punctuated", async () => {
  // The one test here that really spawns something. A project name comes from a
  // model and lands in a command line, so the escaping has to hold: with
  // `shell: true` this arrives split into pieces, or runs `calc`.
  const name = 'thai & tea "ad" | 100%';
  const result = await spawnRunner()(
    process.execPath,
    ["-e", "console.log(process.argv[1])", name],
    process.cwd(),
  );
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stdout.trim(), name);
});
