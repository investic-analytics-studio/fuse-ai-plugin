/**
 * `npx -y @fuseai/mcp install` — put this server into whichever clients this
 * machine has, and check the machine can render.
 *
 * It does not write any client's config file. Every client here has a CLI that
 * owns that file, knows where it lives per platform, merges into it and
 * validates it; a config file is that client's format, not ours, and the one
 * thing worse than not being installed is a rewritten config that loses the
 * user's other servers. So this runs `claude mcp add` and `codex mcp add` and
 * passes their own words back — the same reason `project/scaffold.ts` runs
 * `hyperframes init` instead of writing a HyperFrames project itself.
 *
 * A client with no CLI to ask (Cowork, today) is reported with the steps to do
 * it by hand rather than guessed at.
 *
 * Both API keys are read from this process's environment and never from argv:
 * argv lands in shell history and in every process listing on the machine.
 * There are two because they are two accounts — Fuse bills the clips, and the
 * customer's own ElevenLabs account bills the voiceover.
 */
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ensureDeps, type DepReport, type Runner, type ScaffoldDeps } from "./project/scaffold.ts";

/** The name the server is registered under, in every client. */
export const SERVER_NAME = "fuse";

export interface SelfPackage {
  readonly name: string;
  readonly version: string;
}

/** How this package identifies and launches itself. Read, never retyped. */
export function selfPackage(): SelfPackage {
  const path = new URL("../package.json", import.meta.url);
  const json = JSON.parse(readFileSync(path, "utf8")) as SelfPackage;
  return { name: json.name, version: json.version };
}

/**
 * Left unpinned on purpose for now: the docs tell customers to run
 * `npx -y @fuseai/mcp`, and pinning here while the docs float would give two
 * answers. Whether to pin the version, or install it globally instead of
 * fetching it per session, is still an open question on the card — so it is a
 * parameter, not a constant buried in a command line.
 */
export function launchCommand(spec = selfPackage().name): readonly string[] {
  return ["npx", "-y", spec];
}

/** Where our registration lives in Claude Code, in that CLI's own wording. */
const CLAUDE_SCOPE = "User";

interface ClientSpec {
  readonly id: string;
  readonly name: string;
  /** The CLI that owns this client's config. */
  readonly cli: string;
  /**
   * Clears our own registration, at the one scope we write to, before adding.
   *
   * Only for a client whose `add` will not overwrite. `claude mcp add` on a
   * name it already holds prints "already exists", changes nothing, and
   * **exits 0** — so without this, rotating a key would silently do nothing
   * and report success. `codex mcp add` replaces what is there, so it has none.
   */
  clear?(): readonly string[];
  /** The add command, given the environment the server should start with. */
  add(launch: readonly string[], env: Readonly<Record<string, string>>): readonly string[];
  /**
   * Asks the client what it holds now. Exits non-zero when it holds nothing,
   * which is the only trustworthy signal either CLI gives us: both exit 0 for
   * refusals as well as successes, so the install is confirmed by asking
   * rather than by reading an exit code.
   */
  readonly inspect: readonly string[];
  /** Reads the scope out of `inspect`'s text, for a client that has scopes. */
  scopeOf?(output: string): string | undefined;
  /** The scope `add` writes to, when the client has more than one. */
  readonly writesTo?: string;
}

const CLIENTS: readonly ClientSpec[] = [
  {
    id: "claude-code",
    name: "Claude Code",
    cli: "claude",
    clear: () => ["mcp", "remove", SERVER_NAME, "-s", "user"],
    add: (launch, env) => [
      "mcp",
      "add",
      SERVER_NAME,
      // User scope, not the default local scope: a video project is not the
      // only directory the customer will ever want this in.
      "-s",
      "user",
      ...Object.entries(env).flatMap(([key, value]) => ["-e", `${key}=${value}`]),
      "--",
      ...launch,
    ],
    inspect: ["mcp", "get", SERVER_NAME],
    // "  Scope: Project config (shared via .mcp.json)"
    scopeOf: (output) => /^\s*Scope:\s*(.+)$/m.exec(output)?.[1]?.trim(),
    writesTo: CLAUDE_SCOPE,
  },
  {
    id: "codex",
    name: "Codex CLI",
    cli: "codex",
    add: (launch, env) => [
      "mcp",
      "add",
      SERVER_NAME,
      ...Object.entries(env).flatMap(([key, value]) => ["--env", `${key}=${value}`]),
      "--",
      ...launch,
    ],
    inspect: ["mcp", "get", SERVER_NAME],
  },
];

/* ------------------------------------------------------------ Codex skills */

/**
 * The name the whole playbook goes in under on Codex.
 *
 * Claude Code reads a plugin folder, so there the four stages and the four
 * genres are eight skills and the plugin keeps them apart. Codex has no such
 * folder: it reads `$CODEX_HOME/skills/<name>/SKILL.md`, one flat namespace
 * shared with every other vendor on the machine and with its own system
 * skills. Putting eight directories called things like `01-analysis` into
 * somebody else`s namespace is how two products quietly shadow each other, so
 * all of it goes in under one name that says whose it is, with the eight as
 * reference pages — the shape Codex uses itself, where `imagegen` is a
 * SKILL.md plus a references folder.
 */
export const CODEX_SKILL = "fuse-video";

/** Where the package root is, from wherever this file was built to. */
function packageRoot(): string {
  return fileURLToPath(new URL("..", import.meta.url));
}

export interface SkillFile {
  /** Path inside the installed skill folder. */
  readonly to: string;
  /** What it says. Read from this package, never retyped. */
  readonly text: string;
}

/**
 * Every file the Codex skill is made of.
 *
 * The reference list is read off the `skills/` directory rather than written
 * out here, so a skill added for Claude Code reaches Codex too without
 * anybody remembering to edit this file.
 */
export function codexSkillFiles(): readonly SkillFile[] {
  const root = packageRoot();
  const files: SkillFile[] = [
    { to: "SKILL.md", text: readFileSync(root + "codex/SKILL.md", "utf8") },
  ];
  for (const skill of readdirSync(root + "skills").sort()) {
    files.push({
      to: `references/${skill}.md`,
      text: readFileSync(`${root}skills/${skill}/SKILL.md`, "utf8"),
    });
  }
  return files;
}

/**
 * Where Codex keeps its skills, and how to write one. Injected so a test can
 * watch what would be written without touching the machine running it.
 */
export interface SkillSink {
  /** The skills directory, or undefined when Codex has never run here. */
  readonly dir?: string;
  readonly write: (path: string, text: string) => Promise<void>;
}

export interface SkillResult {
  readonly state: InstallState;
  /** The folder the pages went into. */
  readonly dir?: string;
  readonly files?: number;
  readonly detail?: string;
}

async function writeCodexSkill(
  sink: SkillSink | undefined,
  dryRun: boolean,
): Promise<SkillResult> {
  if (!sink?.dir) return { state: "absent" };
  // The sink gives a path in the host platform’s own spelling, and a report
  // that reads `C:\Users\...\skills/fuse-video` looks like a bug to the person
  // reading it even though it opens fine. So the separator is taken from the
  // directory rather than assumed.
  const root = sink.dir.replace(/[\/]+$/, "");
  const sep = root.includes("\\") ? "\\" : "/";
  const dir = `${root}${sep}${CODEX_SKILL}`;
  const at = (to: string): string => `${dir}${sep}${to.split("/").join(sep)}`;
  let files: readonly SkillFile[];
  try {
    files = codexSkillFiles();
  } catch (error) {
    // The package is on disk, so this is a packaging mistake rather than a
    // machine problem: say so instead of reporting Codex as not installed.
    return { state: "failed", dir, detail: `this package is missing its own pages: ${error}` };
  }
  if (dryRun) return { state: "would-install", dir, files: files.length };
  try {
    for (const file of files) await sink.write(at(file.to), file.text);
  } catch (error) {
    return { state: "failed", dir, files: files.length, detail: String(error) };
  }
  return { state: "installed", dir, files: files.length };
}

/** A client that has no CLI to ask, so the steps are printed instead. */
const BY_HAND: readonly { readonly name: string; readonly steps: readonly string[] }[] = [
  {
    name: "Cowork",
    steps: [
      "Open Cowork's settings and add a connector that runs in each session,",
      `with the command: ${launchCommand().join(" ")}`,
      "and the environment variable FUSE_API_KEY set to your Fuse key.",
      "Add ELEVENLABS_API_KEY too if the ads need a voiceover: that one is your own",
      "ElevenLabs account, and ElevenLabs bills it, not Fuse.",
    ],
  },
];

/**
 * There is deliberately no "already registered" state any more. Refusing when
 * the name was taken is what made the installer unable to change a key — and
 * it refused on a name found in *any* scope, including the `.mcp.json` this
 * package ships, so running it from a directory holding one reported success
 * and set no key at all.
 */
export type InstallState = "installed" | "failed" | "absent" | "would-install";

export interface ClientResult {
  readonly client: string;
  readonly state: InstallState;
  /** The command that was run, or would be. Never carries the key's value. */
  readonly command?: string;
  /** The CLI's own output when it refused. */
  readonly detail?: string;
}

export interface InstallReport {
  readonly package: SelfPackage;
  readonly clients: readonly ClientResult[];
  readonly byHand: readonly { readonly name: string; readonly steps: readonly string[] }[];
  readonly machine: DepReport;
  /** What happened to the playbook pages Codex reads. */
  readonly skills: SkillResult;
  readonly keyFound: boolean;
  /** Whether a key for the customer's own ElevenLabs account was in the environment. */
  readonly voiceKeyFound: boolean;
  readonly notes: readonly string[];
}

export interface InstallOptions {
  readonly deps: ScaffoldDeps;
  /** Taken from the environment by the caller; never parsed out of argv. */
  readonly apiKey?: string;
  /** The customer's own ElevenLabs key, read the same way. Optional: no voiceover without it. */
  readonly voiceKey?: string;
  readonly dryRun?: boolean;
  readonly cwd?: string;
  readonly packageSpec?: string;
  /**
   * Where to put the playbook for Codex. Left out, nothing is written and the
   * report says so — an installer that silently writes into a home directory
   * nobody asked about is worse than one that says it skipped it.
   */
  readonly skills?: SkillSink;
}

/**
 * No key may end up in a report, a log or an error message. Every key is
 * masked, not just the Fuse one: the command line that registers the server
 * carries both, and a CLI that refuses quotes the command back.
 */
function redact(args: readonly string[], keys: readonly (string | undefined)[]): string {
  let text = args.join(" ");
  for (const key of keys) {
    if (key) text = text.split(key).join("***");
  }
  return text;
}

/** The scopes Claude Code names, and the flag that addresses each one. */
const KNOWN_SCOPES = ["local", "project", "user", "dynamic"];

/**
 * How to remove a registration the client reports under `scope`.
 *
 * The scope's own first word is the flag ("Project config (shared via
 * .mcp.json)" → `-s project`), which is worth deriving rather than pointing
 * the customer at `claude mcp get`: that command prints every environment
 * variable it holds — the API key included — in clear text. Telling someone
 * to run it is telling them to put their key on screen and in their scrollback.
 */
function removalOf(client: ClientSpec, scope: string): string {
  const first = /^([a-z]+)/.exec(scope.toLowerCase())?.[1];
  return first && KNOWN_SCOPES.includes(first)
    ? `\`${client.cli} mcp remove ${SERVER_NAME} -s ${first}\``
    : `whatever ${client.name} offers for that scope`;
}

async function hasCli(run: Runner, cli: string, cwd: string): Promise<boolean> {
  try {
    const result = await run(cli, ["--version"], cwd);
    return result.code === 0;
  } catch {
    // A shell that cannot find the command, or a platform that throws instead
    // of exiting. Either way this client is not here.
    return false;
  }
}

export async function install(options: InstallOptions): Promise<InstallReport> {
  const { deps, apiKey, voiceKey, dryRun = false } = options;
  const cwd = options.cwd ?? process.cwd();
  const launch = launchCommand(options.packageSpec);
  const env: Record<string, string> = {
    ...(apiKey ? { FUSE_API_KEY: apiKey } : {}),
    ...(voiceKey ? { ELEVENLABS_API_KEY: voiceKey } : {}),
  };
  const secrets = [apiKey, voiceKey];
  const results: ClientResult[] = [];
  const shadowed: string[] = [];

  for (const client of CLIENTS) {
    if (!(await hasCli(deps.run, client.cli, cwd))) {
      results.push({ client: client.name, state: "absent" });
      continue;
    }
    const args = client.add(launch, env);
    const command = `${client.cli} ${redact(args, secrets)}`;
    if (dryRun) {
      results.push({ client: client.name, state: "would-install", command });
      continue;
    }

    // Written, not merely added: running this again is how a customer rotates
    // a key, and it has to end with the keys they just set rather than with
    // whatever was registered first.
    if (client.clear) await deps.run(client.cli, client.clear(), cwd);
    const added = await deps.run(client.cli, args, cwd);
    const seen = await deps.run(client.cli, client.inspect, cwd);
    if (added.code !== 0 || seen.code !== 0) {
      // Two different failures, and saying which is which is the difference
      // between "that CLI refused, here is what it said" and "that CLI claimed
      // success and then had nothing to show for it".
      const why =
        added.code !== 0
          ? added.stderr || added.stdout || `${client.cli} refused without saying why`
          : `${client.cli} exited 0 but then reported nothing registered under ` +
            SERVER_NAME +
            (added.stdout.trim() ? `; it said: ${added.stdout.trim()}` : "");
      results.push({
        client: client.name,
        state: "failed",
        command,
        detail: redact([why], secrets),
      });
      continue;
    }
    results.push({ client: client.name, state: "installed", command });

    // A registration in another scope wins over the one just written, and
    // starts the server with whatever the environment holds instead of the
    // keys above. Saying "installed" and leaving that unsaid is how a customer
    // ends up with a server that has no key and a report that looked fine.
    const scope = client.scopeOf?.(seen.stdout);
    if (scope && client.writesTo && !scope.includes(client.writesTo)) {
      shadowed.push(
        `${client.name} reports ${SERVER_NAME} under "${scope}", not ${client.writesTo} config, ` +
          "so that is the registration it starts — and it reads the keys from the environment " +
          `it is launched from, not from the one just written. Either set FUSE_API_KEY (and ` +
          "ELEVENLABS_API_KEY) there, or drop that registration with " +
          `${removalOf(client, scope)}.`,
      );
    }
  }

  const skills = await writeCodexSkill(options.skills, dryRun);
  const machine = await ensureDeps(cwd, deps);
  const notes: string[] = [...shadowed];
  if (skills.state === "installed" || skills.state === "would-install") {
    notes.push(
      `Codex reads its skills from disk at startup, so the playbook under ${skills.dir} ` +
        "is there from its next session, not this one. Claude Code gets the same pages from " +
        "the plugin instead, and does not need these.",
    );
  }
  if (skills.state === "failed") {
    notes.push(
      `The server is registered, but the playbook pages could not be written to ${skills.dir}: ` +
        (skills.detail ?? "no reason given") +
        ". Codex will have the tools and no instructions for them, which is the expensive way " +
        "round: it can call fuse_scenes without ever being told to quote first.",
    );
  }
  if (!apiKey) {
    notes.push(
      "No FUSE_API_KEY was set, so the server was registered without one. Listing tiers and " +
        "quoting work without a key; generating does not. Set FUSE_API_KEY and run this " +
        "installer again to write it in.",
    );
  }
  if (!voiceKey) {
    notes.push(
      "No ELEVENLABS_API_KEY was set, so the ads will have no voiceover. That is a second " +
        "account with a second invoice: get a key from elevenlabs.io, set ELEVENLABS_API_KEY " +
        "and run this installer again. ElevenLabs bills those characters, not Fuse.",
    );
  }
  if (apiKey || voiceKey) {
    // Stated plainly rather than left for the customer to discover: this is a
    // real limitation of key-based auth, not an implementation detail.
    notes.push(
      `${apiKey && voiceKey ? "Both API keys are" : "The API key is"} now stored in each ` +
        "client's own config file on this machine, in plain text. Anything that can read your " +
        "home directory can read it.",
    );
  }
  if (!machine.ok) {
    notes.push(
      "This machine cannot render yet. HyperFrames' own doctor says: " + machine.problems.join("; "),
    );
  }
  if (results.every((result) => result.state === "absent")) {
    notes.push(
      "No supported client CLI was found on this machine. Install Claude Code or the Codex CLI, " +
        "or add the connector by hand with the steps above.",
    );
  }

  return {
    package: selfPackage(),
    clients: results,
    byHand: BY_HAND,
    machine,
    skills,
    keyFound: Boolean(apiKey),
    voiceKeyFound: Boolean(voiceKey),
    notes,
  };
}

const LABEL: Readonly<Record<InstallState, string>> = {
  installed: "installed",
  failed: "FAILED",
  absent: "not on this machine",
  "would-install": "would install",
};

/** The console output is this tool's whole interface, so it is written, not dumped. */
export function format(report: InstallReport): string {
  const lines = [`${report.package.name} ${report.package.version}`, ""];
  for (const result of report.clients) {
    lines.push(`  ${result.client}: ${LABEL[result.state]}`);
    if (result.state === "installed" || result.state === "would-install") {
      lines.push(`    ${result.command}`);
    }
    if (result.detail) lines.push(`    ${result.detail}`);
  }
  if (report.clients.some((result) => result.state === "absent")) {
    lines.push("", "By hand, for a client with no CLI:");
    for (const client of report.byHand) {
      lines.push(`  ${client.name}:`);
      for (const step of client.steps) lines.push(`    ${step}`);
    }
  }
  lines.push("", `  Codex playbook: ${LABEL[report.skills.state]}`);
  if (report.skills.dir) {
    const count = report.skills.files;
    lines.push(`    ${count === undefined ? "" : `${count} pages into `}${report.skills.dir}`);
  }
  if (report.skills.detail) lines.push(`    ${report.skills.detail}`);
  lines.push("", `  rendering: ${report.machine.ok ? "ready" : "not ready"}`);
  // Doctor's full text only when it matters. It reports optional extras this
  // package never uses (transcription, local TTS, local music, Docker) and
  // says "some checks failed" about them while still exiting 0 — printing all
  // of that under our own "ready" reads like a contradiction.
  if (!report.machine.ok) {
    for (const problem of report.machine.problems) lines.push(`    ${problem}`);
  }
  for (const note of report.notes) lines.push("", note);
  return lines.join("\n");
}
