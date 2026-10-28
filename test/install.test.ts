/**
 * The installer touches two things that are not ours — other programs' config
 * files, and the customer's API key — so these tests are about exactly that:
 * the command line handed to each client's own CLI, and the key never showing
 * up in anything we print or return.
 *
 * Every command is recorded, never run: a test that really installed anything
 * would reconfigure the machine it runs on.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  SERVER_NAME,
  format,
  install,
  launchCommand,
  selfPackage,
  type InstallReport,
} from "../src/install.ts";
import type { CommandResult, Runner, ScaffoldDeps } from "../src/project/scaffold.ts";

const KEY = "fuse_sk_live_do_not_log_me";
/** A second account's key, which must be kept just as quiet as the first. */
const VOICE_KEY = "xi_sk_live_also_do_not_log_me";

interface Recorder {
  deps: ScaffoldDeps;
  calls: Array<{ command: string; args: readonly string[] }>;
}

/**
 * `present` names the CLIs this machine is pretending to have; `configured`
 * names the ones that already know about us.
 */
function recorder(options: {
  present?: readonly string[];
  configured?: readonly string[];
  addFails?: readonly string[];
  missingThrows?: boolean;
} = {}): Recorder {
  const present = options.present ?? ["claude", "codex", "npx"];
  const calls: Array<{ command: string; args: readonly string[] }> = [];
  const run: Runner = async (command, args): Promise<CommandResult> => {
    calls.push({ command, args });
    if (!present.includes(command)) {
      // Windows runs these through a shell, which exits non-zero; elsewhere the
      // spawn itself throws. Both have to read as "this client is not here".
      if (options.missingThrows) throw new Error(`spawn ${command} ENOENT`);
      return { code: 1, stdout: "", stderr: `'${command}' is not recognized` };
    }
    if (args[0] === "mcp" && args[1] === "get") {
      const configured = options.configured ?? [];
      return configured.includes(command)
        ? { code: 0, stdout: `${SERVER_NAME}: npx -y @fuse-ai/mcp`, stderr: "" }
        : { code: 1, stdout: "", stderr: `No MCP server named '${SERVER_NAME}'.` };
    }
    if (args[0] === "mcp" && args[1] === "add" && (options.addFails ?? []).includes(command)) {
      return { code: 1, stdout: "", stderr: "EACCES: permission denied, open config" };
    }
    return { code: 0, stdout: "ok", stderr: "" };
  };
  return {
    calls,
    deps: {
      run,
      probe: async () => assert.fail("the installer has no clip to measure"),
      fetch: async () => assert.fail("the installer fetches nothing"),
    },
  };
}

function argsFor(bench: Recorder, cli: string): readonly string[] {
  const call = bench.calls.find((entry) => entry.command === cli && entry.args[1] === "add");
  assert.ok(call, `${cli} was never asked to add anything`);
  return call.args;
}

function state(report: InstallReport, client: string): string {
  const found = report.clients.find((result) => result.client === client);
  assert.ok(found, `${client} is not in the report`);
  return found.state;
}

/* ------------------------------------------------------------- the commands */

test("each client is configured through its own CLI, with our launch command", async () => {
  const bench = recorder();
  const report = await install({ deps: bench.deps, apiKey: KEY });

  assert.deepEqual(argsFor(bench, "claude"), [
    "mcp",
    "add",
    "fuse",
    "-s", // user scope: not only the directory the installer happened to run in
    "user",
    "-e",
    `FUSE_API_KEY=${KEY}`,
    "--",
    "npx",
    "-y",
    "@fuse-ai/mcp",
  ]);
  assert.deepEqual(argsFor(bench, "codex"), [
    "mcp",
    "add",
    "fuse",
    "--env",
    `FUSE_API_KEY=${KEY}`,
    "--",
    "npx",
    "-y",
    "@fuse-ai/mcp",
  ]);
  assert.equal(state(report, "Claude Code"), "installed");
  assert.equal(state(report, "Codex CLI"), "installed");
});

test("no config file of anyone else's is opened, only their CLIs", async () => {
  const bench = recorder();
  await install({ deps: bench.deps, apiKey: KEY });
  for (const call of bench.calls) {
    assert.ok(
      ["claude", "codex", "npx"].includes(call.command),
      `the installer ran ${call.command}, which owns nobody's config`,
    );
  }
});

test("the machine check is HyperFrames' doctor, not a second opinion of ours", async () => {
  const bench = recorder();
  const report = await install({ deps: bench.deps });
  assert.ok(
    bench.calls.some((call) => call.command === "npx" && call.args.includes("doctor")),
    "the installer must ask HyperFrames whether this machine can render",
  );
  assert.equal(report.machine.ok, true);
});

/* ----------------------------------------------------------------- the key */

test("the key never appears in anything the installer returns or prints", async () => {
  const bench = recorder();
  const report = await install({ deps: bench.deps, apiKey: KEY });

  const printed = format(report);
  assert.doesNotMatch(printed, new RegExp(KEY), "the key was printed to the console");
  assert.doesNotMatch(JSON.stringify(report), new RegExp(KEY), "the key is in the report object");
  assert.match(printed, /\*\*\*/, "the command is still shown, with the key masked");
  // It does reach the CLI, which is the whole point; just not our output.
  assert.ok(argsFor(bench, "claude").includes(`FUSE_API_KEY=${KEY}`));
});

test("the voiceover key is registered alongside the Fuse one, and masked as well", async () => {
  // Two accounts, two keys, one command line. The masking is per key rather
  // than per "the key": the first version of redact() took only the Fuse one,
  // so an ElevenLabs key would have been printed in full by a CLI that refused.
  const bench = recorder();
  const report = await install({ deps: bench.deps, apiKey: KEY, voiceKey: VOICE_KEY });

  assert.ok(argsFor(bench, "claude").includes(`FUSE_API_KEY=${KEY}`));
  assert.ok(argsFor(bench, "claude").includes(`ELEVENLABS_API_KEY=${VOICE_KEY}`));
  assert.ok(argsFor(bench, "codex").includes(`ELEVENLABS_API_KEY=${VOICE_KEY}`));

  const printed = format(report);
  assert.doesNotMatch(printed, new RegExp(VOICE_KEY), "the voice key was printed");
  assert.doesNotMatch(JSON.stringify(report), new RegExp(VOICE_KEY), "it is in the report");
  assert.equal(report.voiceKeyFound, true);
});

test("a failing CLI quotes a command line that holds neither key", async () => {
  const bench = recorder({ addFails: ["claude"] });
  const report = await install({ deps: bench.deps, apiKey: KEY, voiceKey: VOICE_KEY });
  const text = JSON.stringify(report) + format(report);
  assert.doesNotMatch(text, new RegExp(KEY));
  assert.doesNotMatch(text, new RegExp(VOICE_KEY));
});

test("no voiceover key is said out loud, with whose invoice it is", async () => {
  // Silence here is how a customer gets a finished ad with no voice and no
  // idea why, so it is a note rather than a thing to notice later.
  const report = await install({ deps: recorder().deps, apiKey: KEY });
  assert.equal(report.voiceKeyFound, false);
  const printed = format(report);
  assert.match(printed, /ELEVENLABS_API_KEY/);
  assert.match(printed, /ElevenLabs bills those characters, not Fuse/);
});

test("a failure from a client CLI is masked too, and reported as its own words", async () => {
  const bench = recorder({ addFails: ["claude"] });
  const report = await install({ deps: bench.deps, apiKey: KEY });
  const failed = report.clients.find((result) => result.client === "Claude Code")!;
  assert.equal(failed.state, "failed");
  assert.match(failed.detail!, /EACCES: permission denied/);
  assert.doesNotMatch(JSON.stringify(report), new RegExp(KEY));
  // One client failing must not stop the next.
  assert.equal(state(report, "Codex CLI"), "installed");
});

test("without a key it still installs, and says what that costs", async () => {
  const bench = recorder();
  const report = await install({ deps: bench.deps });
  assert.equal(report.keyFound, false);
  assert.deepEqual(
    argsFor(bench, "claude").filter((arg) => arg === "-e"),
    [],
    "no empty key may be written in",
  );
  assert.match(report.notes.join("\n"), /quoting work without a key; generating does not/);
});

test("with a key it says where the key now lives", async () => {
  const report = await install({ deps: recorder().deps, apiKey: KEY });
  assert.match(report.notes.join("\n"), /stored in each client's own config file/);
});

/* ------------------------------------------------------------- idempotence */

test("a client that already knows about us is left alone", async () => {
  const bench = recorder({ configured: ["claude"] });
  const report = await install({ deps: bench.deps, apiKey: KEY });

  assert.equal(state(report, "Claude Code"), "already");
  assert.equal(
    bench.calls.some((call) => call.command === "claude" && call.args[1] === "add"),
    false,
    "re-adding would need a remove first; the installer must not try",
  );
  assert.match(report.clients[0]!.detail!, /claude mcp remove fuse/);
  assert.equal(state(report, "Codex CLI"), "installed");
});

test("a dry run runs the checks and changes nothing", async () => {
  const bench = recorder();
  const report = await install({ deps: bench.deps, apiKey: KEY, dryRun: true });
  assert.equal(state(report, "Claude Code"), "would-install");
  assert.equal(
    bench.calls.some((call) => call.args[1] === "add"),
    false,
    "a dry run must not add anything",
  );
  assert.match(format(report), /would install/);
  assert.doesNotMatch(format(report), new RegExp(KEY));
});

/* ----------------------------------------------------------- what is absent */

test("a client that is not on this machine is skipped, however the shell says so", async () => {
  for (const missingThrows of [false, true]) {
    const bench = recorder({ present: ["codex", "npx"], missingThrows });
    const report = await install({ deps: bench.deps, apiKey: KEY });
    assert.equal(state(report, "Claude Code"), "absent");
    assert.equal(state(report, "Codex CLI"), "installed");
    assert.match(format(report), /Cowork/, "the client with no CLI is explained by hand");
  }
});

test("a machine with no client CLI at all is told what to install", async () => {
  const bench = recorder({ present: ["npx"] });
  const report = await install({ deps: bench.deps });
  assert.deepEqual(
    report.clients.map((result) => result.state),
    ["absent", "absent"],
  );
  assert.match(report.notes.join("\n"), /No supported client CLI was found/);
});

/* -------------------------------------------------------------- the package */

test("the package names itself from package.json, in one place", () => {
  const self = selfPackage();
  assert.equal(self.name, "@fuse-ai/mcp");
  assert.match(self.version, /^\d+\.\d+\.\d+/);
  assert.deepEqual(launchCommand(), ["npx", "-y", "@fuse-ai/mcp"]);
  // The version to launch is a parameter, because pinning it is still open.
  assert.deepEqual(launchCommand("@fuse-ai/mcp@1.2.3"), ["npx", "-y", "@fuse-ai/mcp@1.2.3"]);
});
