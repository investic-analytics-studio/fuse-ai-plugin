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
  /** The add whose arguments actually took effect, per CLI. */
  effective: Map<string, readonly string[]>;
}

/**
 * A stand-in for the two client CLIs, modelled on what they really do —
 * measured, because what they really do is the whole reason this code exists:
 *
 *   - `claude mcp add` on a name it already holds prints "already exists",
 *     changes nothing and **exits 0**. An installer that trusts the exit code
 *     reports success and leaves the old key in place.
 *   - `codex mcp add` overwrites, and exits 0.
 *   - both `remove` commands exit 0 whether or not there was anything there.
 *   - `mcp get` is the only one that exits non-zero for "nothing registered",
 *     and it is scope-blind: it answers about any scope, naming the scope in
 *     its text.
 *
 * `configured` names the CLIs that already hold a registration; `scope` makes
 * Claude Code report it under something other than User config, the way a
 * `.mcp.json` in the directory does.
 */
function recorder(options: {
  present?: readonly string[];
  configured?: readonly string[];
  addFails?: readonly string[];
  missingThrows?: boolean;
  scope?: string;
} = {}): Recorder {
  const present = options.present ?? ["claude", "codex", "npx"];
  const calls: Array<{ command: string; args: readonly string[] }> = [];
  const effective = new Map<string, readonly string[]>();
  const held = new Set(options.configured ?? []);
  const run: Runner = async (command, args): Promise<CommandResult> => {
    calls.push({ command, args });
    if (!present.includes(command)) {
      // Windows runs these through a shell, which exits non-zero; elsewhere the
      // spawn itself throws. Both have to read as "this client is not here".
      if (options.missingThrows) throw new Error(`spawn ${command} ENOENT`);
      return { code: 1, stdout: "", stderr: `'${command}' is not recognized` };
    }
    if (args[0] === "mcp" && args[1] === "get") {
      if (!held.has(command)) {
        return { code: 1, stdout: "", stderr: `No MCP server named '${SERVER_NAME}'.` };
      }
      const scope = command === "claude" ? `\n  Scope: ${options.scope ?? "User config"}` : "";
      return { code: 0, stdout: `${SERVER_NAME}:${scope}\n  Command: npx`, stderr: "" };
    }
    if (args[0] === "mcp" && args[1] === "remove") {
      held.delete(command);
      effective.delete(command);
      return { code: 0, stdout: `Removed ${SERVER_NAME}`, stderr: "" };
    }
    if (args[0] === "mcp" && args[1] === "add") {
      if ((options.addFails ?? []).includes(command)) {
        return { code: 1, stdout: "", stderr: "EACCES: permission denied, open config" };
      }
      // Claude Code will not overwrite; Codex will.
      if (held.has(command) && command === "claude") {
        return { code: 0, stdout: `MCP server ${SERVER_NAME} already exists`, stderr: "" };
      }
      held.add(command);
      effective.set(command, args);
      return { code: 0, stdout: `Added ${SERVER_NAME}`, stderr: "" };
    }
    return { code: 0, stdout: "ok", stderr: "" };
  };
  return {
    calls,
    effective,
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

/* --------------------------------------------------------------- rewriting */

test("running it again writes the new key instead of leaving the old one", async () => {
  // How a customer rotates a key, and it used to be impossible: the installer
  // saw the name was taken and stopped, so the report said "already there" and
  // the server kept starting with the key from before. The CLI is no help —
  // `claude mcp add` on a name it holds exits 0 and changes nothing — so the
  // registration has to be cleared first.
  const bench = recorder({ configured: ["claude", "codex"] });
  const report = await install({ deps: bench.deps, apiKey: "fuse_sk_the_new_one" });

  assert.equal(state(report, "Claude Code"), "installed");
  assert.ok(
    bench.effective.get("claude")?.includes("FUSE_API_KEY=fuse_sk_the_new_one"),
    "the add that took effect did not carry the new key",
  );
  assert.ok(
    bench.calls.some(
      (call) => call.command === "claude" && call.args[1] === "remove" && call.args.includes("user"),
    ),
    "the old registration was never cleared, so the new key went nowhere",
  );
});

test("only the scope we write to is ever cleared", async () => {
  // `claude mcp remove` without a scope would take whichever one it finds
  // first, and a project `.mcp.json` is not ours to delete.
  const bench = recorder();
  await install({ deps: bench.deps, apiKey: KEY });
  const removes = bench.calls.filter(
    (call) => call.command === "claude" && call.args[1] === "remove",
  );
  assert.equal(removes.length, 1);
  assert.deepEqual([...removes[0]!.args], ["mcp", "remove", "fuse", "-s", "user"]);
});

test("the install is confirmed by asking the client, not by an exit code", async () => {
  // Both CLIs exit 0 for refusals as well as successes, so a 0 from `add` is
  // not evidence of anything. This is what catches an add that quietly did
  // nothing: the client is asked afterwards and says it holds nothing.
  const bench = recorder();
  const brokenRun: Runner = async (command, args) => {
    if (args[0] === "mcp" && args[1] === "add") {
      return { code: 0, stdout: "something went wrong but exited 0 anyway", stderr: "" };
    }
    return bench.deps.run(command, args, ".");
  };
  const report = await install({ deps: { ...bench.deps, run: brokenRun }, apiKey: KEY });
  assert.equal(state(report, "Claude Code"), "failed");
  assert.match(report.clients[0]!.detail!, /nothing registered/);
});

test("a registration in another scope is reported, not silently shadowed", async () => {
  // Measured on a real machine: with the server in both user scope and a
  // project `.mcp.json`, `claude mcp get` answers "Scope: Project config" —
  // that one wins, and it takes its keys from the environment. Reporting
  // "installed" and stopping there hands the customer a keyless server and a
  // clean bill of health.
  const bench = recorder({ scope: "Project config (shared via .mcp.json)" });
  const report = await install({ deps: bench.deps, apiKey: KEY, voiceKey: VOICE_KEY });

  assert.equal(state(report, "Claude Code"), "installed");
  const note = report.notes.find((text) => text.includes("Project config"));
  assert.ok(note, `no note about the shadowing scope; notes were ${JSON.stringify(report.notes)}`);
  assert.match(note, /reads the keys from the environment/);
  assert.doesNotMatch(format(report), new RegExp(KEY));
});

test("a registration in our own scope is not reported as a problem", async () => {
  const bench = recorder({ scope: "User config" });
  const report = await install({ deps: bench.deps, apiKey: KEY });
  assert.equal(
    report.notes.some((text) => text.includes("Scope") || text.includes("User config")),
    false,
    "the normal case must not warn about itself",
  );
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
