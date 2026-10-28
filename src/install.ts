/**
 * `npx -y @fuse-ai/mcp install` — put this server into whichever clients this
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
 * The API key is read from this process's environment and never from argv:
 * argv lands in shell history and in every process listing on the machine.
 */
import { readFileSync } from "node:fs";
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
 * `npx -y @fuse-ai/mcp`, and pinning here while the docs float would give two
 * answers. Whether to pin the version, or install it globally instead of
 * fetching it per session, is still an open question on the card — so it is a
 * parameter, not a constant buried in a command line.
 */
export function launchCommand(spec = selfPackage().name): readonly string[] {
  return ["npx", "-y", spec];
}

interface ClientSpec {
  readonly id: string;
  readonly name: string;
  /** The CLI that owns this client's config. */
  readonly cli: string;
  /** Exits 0 only when our server is already registered. */
  readonly check: readonly string[];
  /** The add command, given the environment the server should start with. */
  add(launch: readonly string[], env: Readonly<Record<string, string>>): readonly string[];
}

const CLIENTS: readonly ClientSpec[] = [
  {
    id: "claude-code",
    name: "Claude Code",
    cli: "claude",
    check: ["mcp", "get", SERVER_NAME],
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
  },
  {
    id: "codex",
    name: "Codex CLI",
    cli: "codex",
    check: ["mcp", "get", SERVER_NAME],
    add: (launch, env) => [
      "mcp",
      "add",
      SERVER_NAME,
      ...Object.entries(env).flatMap(([key, value]) => ["--env", `${key}=${value}`]),
      "--",
      ...launch,
    ],
  },
];

/** A client that has no CLI to ask, so the steps are printed instead. */
const BY_HAND: readonly { readonly name: string; readonly steps: readonly string[] }[] = [
  {
    name: "Cowork",
    steps: [
      "Open Cowork's settings and add a connector that runs in each session,",
      `with the command: ${launchCommand().join(" ")}`,
      `and the environment variable FUSE_API_KEY set to your key.`,
    ],
  },
];

export type InstallState = "installed" | "already" | "failed" | "absent" | "would-install";

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
  readonly keyFound: boolean;
  readonly notes: readonly string[];
}

export interface InstallOptions {
  readonly deps: ScaffoldDeps;
  /** Taken from the environment by the caller; never parsed out of argv. */
  readonly apiKey?: string;
  readonly dryRun?: boolean;
  readonly cwd?: string;
  readonly packageSpec?: string;
}

/** The key must not end up in a report, a log or an error message. */
function redact(args: readonly string[], apiKey: string | undefined): string {
  const text = args.join(" ");
  return apiKey ? text.split(apiKey).join("***") : text;
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
  const { deps, apiKey, dryRun = false } = options;
  const cwd = options.cwd ?? process.cwd();
  const launch = launchCommand(options.packageSpec);
  const env: Record<string, string> = apiKey ? { FUSE_API_KEY: apiKey } : {};
  const results: ClientResult[] = [];

  for (const client of CLIENTS) {
    if (!(await hasCli(deps.run, client.cli, cwd))) {
      results.push({ client: client.name, state: "absent" });
      continue;
    }
    const args = client.add(launch, env);
    const command = `${client.cli} ${redact(args, apiKey)}`;
    const already = await deps.run(client.cli, client.check, cwd);
    if (already.code === 0) {
      results.push({
        client: client.name,
        state: "already",
        command,
        detail:
          `${SERVER_NAME} is already registered in ${client.name}. To change it, run ` +
          `\`${client.cli} mcp remove ${SERVER_NAME}\` first.`,
      });
      continue;
    }
    if (dryRun) {
      results.push({ client: client.name, state: "would-install", command });
      continue;
    }
    const added = await deps.run(client.cli, args, cwd);
    results.push(
      added.code === 0
        ? { client: client.name, state: "installed", command }
        : {
            client: client.name,
            state: "failed",
            command,
            detail: redact([added.stderr || added.stdout], apiKey),
          },
    );
  }

  const machine = await ensureDeps(cwd, deps);
  const notes: string[] = [];
  if (!apiKey) {
    notes.push(
      "No FUSE_API_KEY was set, so the server was registered without one. Listing tiers and " +
        "quoting work without a key; generating does not. Set FUSE_API_KEY and run this " +
        "installer again to write it in.",
    );
  } else {
    // Stated plainly rather than left for the customer to discover: this is a
    // real limitation of key-based auth, not an implementation detail.
    notes.push(
      "The API key is now stored in each client's own config file on this machine, in plain " +
        "text. Anything that can read your home directory can read it.",
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

  return { package: selfPackage(), clients: results, byHand: BY_HAND, machine, keyFound: Boolean(apiKey), notes };
}

const LABEL: Readonly<Record<InstallState, string>> = {
  installed: "installed",
  already: "already there",
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
