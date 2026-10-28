/**
 * Does the thing actually start and speak MCP?
 *
 * The first test runs the real binary as a child process and talks to it with
 * the real client over stdio, against a stand-in Fuse. That is the only way to
 * catch the failures this layer can have — a tool that does not register, a
 * schema the SDK rejects, something written to stdout that is not protocol —
 * none of which a unit test of a handler would notice.
 *
 * The rest check the three decisions this file makes on its own: how long a
 * price list is held, what happens with no API key, and what a thrown error
 * looks like by the time a model reads it.
 */
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { execFile } from "node:child_process";
import { mkdtemp, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
import { Catalog } from "../src/fuse/catalog.ts";
import { FuseError } from "../src/fuse/client.ts";
import { catalogCache, failure, packageSpec, requireKey } from "../src/index.ts";

const pricingBody = readFileSync(
  fileURLToPath(new URL("./fixtures/pricing-2026-10-26.json", import.meta.url)),
  "utf8",
);
const serverEntry = fileURLToPath(new URL("../src/index.ts", import.meta.url));

/** A Fuse that only knows how to quote, which is all this test asks of it. */
const fuse: Server = createServer((request, response) => {
  if ((request.url ?? "").startsWith("/v1/api/pricing")) {
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(pricingBody);
    return;
  }
  response.writeHead(404, { "Content-Type": "application/json" });
  response.end(JSON.stringify({ status: { code: "NOT_FOUND", message: ["not in this test"] } }));
});
await new Promise<void>((resolve) => fuse.listen(0, "127.0.0.1", resolve));
const baseUrl = `http://127.0.0.1:${(fuse.address() as { port: number }).port}`;
after(() => fuse.close());

function text(result: unknown): string {
  const content = (result as { content: Array<{ type: string; text?: string }> }).content;
  return content.map((part) => part.text ?? "").join("");
}

test("the real server starts, lists its tools and answers over stdio", async () => {
  const client = new Client({ name: "fuse-test", version: "0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverEntry],
    env: { ...getDefaultEnvironment(), FUSE_BASE_URL: baseUrl },
    stderr: "pipe",
  });
  await client.connect(transport);
  try {
    const listed = await client.listTools();
    assert.deepEqual(
      listed.tools.map((tool) => tool.name),
      ["fuse_tiers", "fuse_quote", "fuse_project_new", "fuse_scenes", "fuse_manifest"],
    );
    for (const tool of listed.tools) {
      assert.ok(tool.description, `${tool.name} reached the client without a description`);
      assert.equal(tool.inputSchema.type, "object", `${tool.name}'s schema did not survive`);
    }
    // fuse_scenes' arguments are the ones a model gets wrong, so check they arrived.
    const scenes = listed.tools.find((tool) => tool.name === "fuse_scenes")!;
    assert.deepEqual(
      Object.keys(scenes.inputSchema.properties as Record<string, unknown>).sort(),
      ["dir", "maxTokens", "scenes", "waitMs"],
    );
    assert.deepEqual(scenes.inputSchema.required, ["dir", "maxTokens", "scenes"]);

    const tiers = JSON.parse(text(await client.callTool({ name: "fuse_tiers", arguments: {} })));
    assert.ok(
      tiers.tiers.some((tier: { id: string }) => tier.id === "t2v-low-standard"),
      "the live price list did not come back through the protocol",
    );

    const quote = JSON.parse(
      text(
        await client.callTool({
          name: "fuse_quote",
          arguments: {
            tier: "t2v-low-standard",
            resolution: "480p",
            scenes: [{ slug: "scene-a", seconds: 5 }],
          },
        }),
      ),
    );
    assert.equal(quote.total, 40);

    // A refusal must come back as a tool error the model can read, not as a
    // dead connection or a stack trace.
    const refused = await client.callTool({
      name: "fuse_quote",
      arguments: { tier: "t2v-low-standard", resolution: "4k", scenes: [{ slug: "a", seconds: 5 }] },
    });
    assert.equal(refused.isError, true);
    assert.match(text(refused), /does not offer 4k; it offers 480p, 768p/);

    const malformed = await client.callTool({
      name: "fuse_quote",
      arguments: { tier: "t2v-low-standard", resolution: "480p", scenes: [{ slug: "Scene A", seconds: 5 }] },
    });
    assert.equal(malformed.isError, true);
    assert.match(text(malformed), /slug/);
  } finally {
    await client.close();
  }
});

test("the price list is held for a while, and two callers asking at once is one fetch", async () => {
  let loads = 0;
  const fixture = JSON.parse(pricingBody);
  const cached = catalogCache(async () => {
    loads++;
    return Catalog.parse(fixture.data);
  });

  const [first, second] = await Promise.all([cached(), cached()]);
  assert.equal(loads, 1, "a concurrent pair must share the one request");
  assert.equal(first, second);
  await cached();
  assert.equal(loads, 1, "a later call inside the TTL must not refetch");
});

test("a failed fetch is not cached, so the next call tries again", async () => {
  let loads = 0;
  const cached = catalogCache(async () => {
    loads++;
    throw new FuseError("transport", 0, "fetch failed");
  });
  await assert.rejects(() => cached());
  await assert.rejects(() => cached());
  assert.equal(loads, 2);
});

test("with no key, quoting still works and spending says what to set", async () => {
  const refused = requireKey(
    {
      submit: async () => assert.fail("submit must not reach the API without a key"),
      status: async () => assert.fail("status must not reach the API without a key"),
    },
    false,
  );
  await assert.rejects(
    () => refused.submit({ tier: "t2v-low-standard", resolution: "480p" as never, aspect: "16:9" }, { slug: "a", prompt: "p", seconds: 5 }),
    /FUSE_API_KEY/,
  );
  await assert.rejects(() => refused.status("run-1"), /FUSE_API_KEY/);
});

test("the server's own words reach the model, and bad arguments read as a list", () => {
  const fuseError = new FuseError(
    "rejected",
    400,
    "duration must be between 5 and 10 for low priority with standard quality",
  );
  const said = failure(fuseError);
  assert.match(said, /duration must be between 5 and 10/);
  assert.doesNotMatch(said, /worth trying again/, "a refusal is not retryable");
  assert.match(failure(new FuseError("server", 500, "Failed to start")), /worth trying again/);

  const parsed = z.object({ maxTokens: z.number() }).safeParse({});
  const listed = failure(parsed.error);
  assert.match(listed, /maxTokens:/);
  assert.doesNotMatch(listed, /^\[/, "a model should not be handed raw zod JSON");

  assert.equal(failure(new Error("ffmpeg not found on PATH")), "ffmpeg not found on PATH");
});

/**
 * npm installs a `bin` as a link, so the path the shim passes is not the path
 * the module resolves to. This is the one failure of that kind that cannot be
 * noticed by hand: the process starts, does nothing, prints nothing and exits
 * 0, and the client only reports a server that never connected.
 */
test("started through a link, as npm installs it, the program still runs", async () => {
  const linked = join(await mkdtemp(join(tmpdir(), "fuse-link-")), "pkg");
  // A junction, because that is what npm uses for a directory on Windows and
  // it needs no privileges there; the type is ignored everywhere else.
  await symlink(fileURLToPath(new URL("..", import.meta.url)), linked, "junction");

  const run = (entry: string): Promise<{ code: number | string; stdout: string; stderr: string }> =>
    new Promise((resolve) => {
      execFile(
        process.execPath,
        [join(entry, "src", "index.ts"), "no-such-command"],
        // `code` is left as node types it: a process that exits gives a number,
        // one that never started gives a string like "ENOENT", and flattening
        // the second into 0 would read as success.
        (error, stdout, stderr) => {
          resolve({ code: error?.code ?? 0, stdout, stderr });
        },
      );
    });

  // Asking for a command that does not exist is the cheapest proof the entry
  // point ran at all: it has to refuse, by name.
  const throughLink = await run(linked);
  assert.match(
    throughLink.stderr,
    /Unknown command "no-such-command"/,
    "through a link the program did nothing at all",
  );
  assert.equal(throughLink.code, 1);

  const direct = await run(fileURLToPath(new URL("..", import.meta.url)));
  assert.match(direct.stderr, /Unknown command "no-such-command"/);
  assert.equal(direct.code, 1);
});

test("the installer can be told what the client should launch", () => {
  assert.equal(packageSpec(["--dry-run"]), undefined, "the default is this package's own name");
  assert.equal(packageSpec(["--package", "@fuse-ai/mcp@1.2.3"]), "@fuse-ai/mcp@1.2.3");
  assert.equal(packageSpec(["--package", "/home/me/fuse-ai-plugin", "--dry-run"]), "/home/me/fuse-ai-plugin");
  // A swallowed flag would silently register the wrong command.
  assert.throws(() => packageSpec(["--package"]), /needs a value/);
  assert.throws(() => packageSpec(["--package", "--dry-run"]), /needs a value/);
});
