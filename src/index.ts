#!/usr/bin/env node
/**
 * The MCP server: wiring, and nothing else.
 *
 * Everything that could be wrong about Fuse, about money or about HyperFrames
 * lives in the modules below this one. What is decided here is only what a
 * process has to decide — where the API key comes from, how long a price list
 * is good for, what a thrown error looks like to a model, and which stream the
 * server talks on.
 *
 * The key is read from the environment and never logged. stdout belongs to the
 * protocol, so anything this file has to say goes to stderr.
 */
import { fileURLToPath } from "node:url";
import { realpathSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { Catalog } from "./fuse/catalog.ts";
import { FuseError, FuseHttp, Runs, openClip } from "./fuse/client.ts";
import type { RunsPort } from "./job/lifecycle.ts";
import {
  ffprobeDuration,
  ffprobeProbe,
  spawnRunner,
  type ScaffoldDeps,
} from "./project/scaffold.ts";
import { createTools, type ToolDefinition } from "./tools.ts";
import { ElevenLabs, VoiceError, type VoicePort } from "./voice/elevenlabs.ts";
import { format, install, selfPackage } from "./install.ts";

const DEFAULT_BASE_URL = "https://api.fuseai.art";

/**
 * Prices move (the CRM changes them), but not between two tool calls in one
 * conversation. Holding them briefly keeps a quote from costing a round trip,
 * and the server re-prices every submit anyway, so a stale number here can
 * only ever be a slightly wrong estimate — never a wrong charge.
 */
const CATALOG_TTL_MS = 10 * 60 * 1000;

export function catalogCache(load: () => Promise<Catalog>): () => Promise<Catalog> {
  let held: { catalog: Catalog; at: number } | undefined;
  let inFlight: Promise<Catalog> | undefined;
  return async () => {
    if (held && Date.now() - held.at < CATALOG_TTL_MS) return held.catalog;
    // Single-flight: two tools asking at once is one fetch, not two.
    inFlight ??= load()
      .then((catalog) => {
        held = { catalog, at: Date.now() };
        return catalog;
      })
      .finally(() => {
        inFlight = undefined;
      });
    return inFlight;
  };
}

/**
 * Without a key, the public price list still works, so `fuse_tiers` and
 * `fuse_quote` answer as usual. Only the paths that spend tokens stop, and
 * they stop here saying what to set rather than relaying a bare 401.
 */
export function requireKey(runs: RunsPort, hasKey: boolean): RunsPort {
  if (hasKey) return runs;
  // Async: these stand in for calls that return promises, and a caller that
  // awaits them should not also have to guard against a synchronous throw.
  const refuse = async (): Promise<never> => {
    throw new Error(
      "No Fuse API key. Set FUSE_API_KEY in this MCP server's environment " +
        "(get one from the Fuse dashboard). Listing tiers and quoting work without it.",
    );
  };
  return { submit: refuse, status: refuse };
}

/**
 * The customer's ElevenLabs account, when they have given this process a key
 * for it. No key is a normal state: it is a second account with a second
 * invoice, and everything but the two voice tools works without one.
 */
export function voicePort(apiKey: string | undefined): VoicePort | undefined {
  return apiKey ? new ElevenLabs({ apiKey }) : undefined;
}

/** What the model sees when something throws. The server's own words, kept. */
export function failure(error: unknown): string {
  if (error instanceof z.ZodError) {
    const issues = error.issues
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("\n");
    return `These arguments were not accepted:\n${issues}`;
  }
  if (error instanceof FuseError) {
    // `detail` is the API's text, unedited: it holds the real rule, such as the
    // duration range for a tier or the reference-image limit.
    return (
      `Fuse refused this (${error.kind}): ${error.detail}` +
      (error.retryable ? "\nThis one is worth trying again." : "")
    );
  }
  if (error instanceof VoiceError) {
    // Named as ElevenLabs rather than as Fuse, because which account is being
    // refused decides who the customer has to go and talk to.
    return (
      `ElevenLabs refused this (${error.kind}): ${error.detail}` +
      (error.retryable ? "\nThis one is worth trying again." : "")
    );
  }
  return error instanceof Error ? error.message : String(error);
}

function register(server: McpServer, definition: ToolDefinition): void {
  server.registerTool(
    definition.name,
    {
      title: definition.title,
      description: definition.description,
      inputSchema: definition.inputShape,
    },
    async (args: unknown) => {
      try {
        const result = await definition.run(args);
        return { content: [{ type: "text" as const, text: JSON.stringify(result, undefined, 2) }] };
      } catch (error) {
        return { isError: true, content: [{ type: "text" as const, text: failure(error) }] };
      }
    },
  );
}

function scaffoldDeps(): ScaffoldDeps {
  const runner = spawnRunner();
  return {
    run: runner,
    probe: ffprobeProbe(runner),
    probeDuration: ffprobeDuration(runner),
    fetch,
  };
}

/**
 * `install` is a command for a person, not a tool call, so stdout is its own
 * here — the protocol only owns stdout when the server is running.
 */
/**
 * `--package <spec>`: what the client should be told to launch. The default is
 * this package's own name, which is right once it is on npm; before that, and
 * for anyone testing a change, it is a path to a local checkout.
 */
export function packageSpec(args: readonly string[]): string | undefined {
  const at = args.indexOf("--package");
  if (at === -1) return undefined;
  const spec = args[at + 1];
  if (!spec || spec.startsWith("--")) {
    throw new Error("--package needs a value: an npm spec, or a path to a local checkout.");
  }
  return spec;
}

export async function runInstaller(args: readonly string[]): Promise<void> {
  const report = await install({
    deps: scaffoldDeps(),
    apiKey: process.env.FUSE_API_KEY,
    voiceKey: process.env.ELEVENLABS_API_KEY,
    dryRun: args.includes("--dry-run"),
    packageSpec: packageSpec(args),
  });
  console.log(format(report));
  if (report.clients.some((result) => result.state === "failed")) process.exit(1);
}

export async function main(): Promise<void> {
  const apiKey = process.env.FUSE_API_KEY;
  const http = new FuseHttp({
    baseUrl: process.env.FUSE_BASE_URL || DEFAULT_BASE_URL,
    apiKey,
  });
  const tools = createTools({
    catalog: catalogCache(() => Catalog.load(http)),
    runs: requireKey(new Runs(http), Boolean(apiKey)),
    openClip,
    scaffold: scaffoldDeps(),
    voice: voicePort(process.env.ELEVENLABS_API_KEY),
    newJobId: () => randomUUID(),
  });

  const server = new McpServer({ name: "fuse", version: selfPackage().version });
  for (const definition of tools) register(server, definition);
  await server.connect(new StdioServerTransport());
}

/**
 * Is this file the program, or was it imported by something else?
 *
 * Compared as real paths, because npm installs a `bin` as a link: a global
 * install, `npm link`, and `npx` pointed at a local checkout all leave
 * `process.argv[1]` holding the link while `import.meta.url` holds the file it
 * points at. Comparing those two as strings looks right and is wrong, and the
 * way it is wrong is silent — nothing runs, nothing is printed, the process
 * exits 0, and the client sees only a server that never connects.
 */
function isProgram(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    const here = fileURLToPath(import.meta.url);
    // The first comparison covers --preserve-symlinks-main, where it is
    // `import.meta.url` that holds the link; the second covers the usual way.
    return entry === here || realpathSync(entry) === realpathSync(here);
  } catch {
    return false;
  }
}

if (isProgram()) {
  const [subcommand, ...rest] = process.argv.slice(2);
  // A client launches this with no arguments at all; anything else is a person
  // at a terminal, and should be told when they typed something we do not have.
  const work =
    subcommand === undefined
      ? main()
      : subcommand === "install"
        ? runInstaller(rest)
        : Promise.reject(
            new Error(
              `Unknown command "${subcommand}". Usage: ` +
                `${selfPackage().name} [install [--dry-run] [--package <spec>]]  ` +
                `(no arguments runs the MCP server)`,
            ),
          );
  work.catch((error: unknown) => {
    console.error(failure(error));
    process.exit(1);
  });
}
