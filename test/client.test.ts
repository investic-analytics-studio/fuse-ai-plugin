/**
 * The client is tested against a stand-in Fuse server rather than a stubbed
 * `fetch`, because the things that go wrong here are HTTP things: a header that
 * never got sent, an envelope read at the wrong depth, a 402 that looks like a
 * 400. The bodies below are the ones prod really sends — copied from
 * `shared.ResponseBody`, `common_error.go` and the recorded pricing fixture.
 */
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { Catalog } from "../src/fuse/catalog.ts";
import { FuseError, FuseHttp, Runs } from "../src/fuse/client.ts";
import type { JobSpec, Resolution, SceneSpec } from "../src/domain.ts";

const pricingBody = readFileSync(
  fileURLToPath(new URL("./fixtures/pricing-2026-10-26.json", import.meta.url)),
  "utf8",
);

interface Call {
  method: string;
  url: string;
  auth?: string;
  body: unknown;
  /** Multipart is kept as it arrived: the part headers are the point of it. */
  raw?: string;
}

/** One reply per call, in order; the default is "run started". */
let replies: Array<{ status: number; body: unknown }> = [];
const calls: Call[] = [];

const RUN_ID = "4f2b4ec8-456c-45cc-adb2-7b36cba792b4";

const started = {
  status: { code: "SUCCESS", message: ["Video generation started"] },
  data: { id: RUN_ID, status: "IN_PROGRESS", created_at: "2026-10-26T10:13:12Z" },
};

function read(request: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let text = "";
    request.on("data", (chunk) => (text += chunk));
    request.on("end", () => resolve(text));
  });
}

const server: Server = createServer(async (request: IncomingMessage, response: ServerResponse) => {
  const text = await read(request);
  const multipart = (request.headers["content-type"] ?? "").startsWith("multipart/form-data");
  calls.push({
    method: request.method ?? "",
    url: request.url ?? "",
    auth: request.headers.authorization,
    body: multipart || !text ? undefined : JSON.parse(text),
    ...(multipart ? { raw: text } : {}),
  });
  if ((request.url ?? "").startsWith("/v1/api/pricing")) {
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(pricingBody);
    return;
  }
  const reply = replies.shift() ?? { status: 200, body: started };
  response.writeHead(reply.status, { "Content-Type": "application/json" });
  response.end(typeof reply.body === "string" ? reply.body : JSON.stringify(reply.body));
});

await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = (server.address() as { port: number }).port;
const baseUrl = `http://127.0.0.1:${port}`;

after(() => server.close());

function fresh(apiKey: string | undefined = "test-key"): Runs {
  calls.length = 0;
  replies = [];
  return new Runs(new FuseHttp({ baseUrl, apiKey, timeoutMs: 5_000 }));
}

function freshHttp(apiKey: string | undefined = "test-key"): FuseHttp {
  calls.length = 0;
  replies = [];
  return new FuseHttp({ baseUrl, apiKey, timeoutMs: 5_000 });
}

const spec: JobSpec = {
  tier: "t2v-low-standard",
  resolution: "480p" as Resolution,
  aspect: "16:9",
};

const scene: SceneSpec = { slug: "scene-a", prompt: "A paper boat drifts down a stream.", seconds: 5 };

test("submit names the tier by its three axes, the way the API validates it", async () => {
  const runs = fresh();
  const run = await runs.submit(spec, scene);

  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.method, "POST");
  assert.equal(calls[0]!.url, "/v1/api/ai/standalone/video");
  assert.equal(calls[0]!.auth, "Bearer test-key");
  assert.deepEqual(calls[0]!.body, {
    mode: "text-to-video",
    priority: "low",
    quality: "standard",
    prompt: scene.prompt,
    resolution: "480p",
    duration: 5,
    aspect_ratio: "16:9",
  });
  // A t2v body carries no reference fields at all; the API rejects them there.
  assert.deepEqual(run, { id: RUN_ID, status: "IN_PROGRESS", outputUrl: undefined, completedAt: undefined });
});

test("an i2v scene carries its references, and only the ones it has", async () => {
  const runs = fresh();
  await runs.submit(
    { tier: "i2v-fast-standard", resolution: "720p" as Resolution, aspect: "9:16" },
    {
      slug: "scene-b",
      prompt: "The bottle turns.",
      seconds: 6,
      imageUrls: ["https://example.test/bottle.png"],
      lastImageUrl: "https://example.test/last.png",
    },
  );
  assert.deepEqual(calls[0]!.body, {
    mode: "image-to-video",
    priority: "fast",
    quality: "standard",
    prompt: "The bottle turns.",
    resolution: "720p",
    duration: 6,
    aspect_ratio: "9:16",
    image_urls: ["https://example.test/bottle.png"],
    last_image_url: "https://example.test/last.png",
  });
});

test("the server's own refusal text reaches the caller unchanged", async () => {
  const runs = fresh();
  replies = [
    {
      status: 400,
      body: {
        status: {
          code: "INVALID_REQUEST",
          message: ["duration must be between 5 and 10 for low priority with standard quality"],
        },
      },
    },
  ];
  await assert.rejects(
    () => runs.submit(spec, { ...scene, seconds: 30 }),
    (error: unknown) => {
      assert.ok(error instanceof FuseError);
      assert.equal(error.kind, "rejected");
      assert.equal(error.retryable, false);
      // Verbatim: the duration range lives on the server, not in this package.
      assert.equal(
        error.detail,
        "duration must be between 5 and 10 for low priority with standard quality",
      );
      return true;
    },
  );
});

test("an empty balance is its own answer, not a bad request", async () => {
  const runs = fresh();
  replies = [
    {
      status: 402,
      body: {
        status: {
          code: "ERR_7001",
          message: ["Insufficient token balance", "You do not have enough tokens for this action"],
        },
      },
    },
  ];
  await assert.rejects(
    () => runs.submit(spec, scene),
    (error: unknown) => {
      assert.ok(error instanceof FuseError);
      assert.equal(error.kind, "insufficient_tokens");
      assert.equal(error.code, "ERR_7001");
      assert.equal(error.retryable, false);
      assert.match(error.detail, /Insufficient token balance/);
      return true;
    },
  );
});

test("a disabled or missing key, and someone else's video, are told apart", async () => {
  const runs = fresh();
  replies = [
    { status: 401, body: { status: { code: "UNAUTHORIZED", message: ["Unauthorized"] } } },
    { status: 404, body: { status: { code: "NOT_FOUND", message: ["Video not found"] } } },
  ];
  await assert.rejects(
    () => runs.submit(spec, scene),
    (error: unknown) => error instanceof FuseError && error.kind === "unauthorized",
  );
  await assert.rejects(
    () => runs.status(RUN_ID),
    (error: unknown) => error instanceof FuseError && error.kind === "not_found",
  );
});

test("Fuse failing on its side is worth another try", async () => {
  const runs = fresh();
  replies = [
    {
      status: 500,
      body: { status: { code: "PROCESSING_FAILED", message: ["Failed to start video generation"] } },
    },
  ];
  await assert.rejects(
    () => runs.submit(spec, scene),
    (error: unknown) => {
      assert.ok(error instanceof FuseError);
      assert.equal(error.kind, "server");
      assert.equal(error.retryable, true);
      return true;
    },
  );
});

test("status reads the finished clip's URL off the run", async () => {
  const runs = fresh();
  replies = [
    {
      status: 200,
      body: {
        status: { code: "SUCCESS", message: ["Video retrieved successfully"] },
        data: {
          id: RUN_ID,
          status: "COMPLETED",
          // The host differs by tier: our bucket here, a provider CDN on the
          // WaveSpeed tiers. Either way it is used at once, never stored.
          output_url: "https://storage.googleapis.com/fuse/scene-a.mp4",
          completed_at: "2026-10-26T10:15:01Z",
        },
      },
    },
  ];
  const run = await runs.status(RUN_ID);
  assert.equal(calls[0]!.url, `/v1/api/ai/standalone/video/${RUN_ID}`);
  assert.equal(run.status, "COMPLETED");
  assert.equal(run.outputUrl, "https://storage.googleapis.com/fuse/scene-a.mp4");
  assert.equal(run.completedAt, "2026-10-26T10:15:01Z");
});

test("a status name the contract does not have stops the call instead of polling forever", async () => {
  const runs = fresh();
  replies = [{ status: 200, body: { status: { code: "SUCCESS" }, data: { id: RUN_ID, status: "QUEUED" } } }];
  await assert.rejects(
    () => runs.status(RUN_ID),
    (error: unknown) =>
      error instanceof FuseError && error.kind === "server" && /unknown status QUEUED/.test(error.detail),
  );
});

test("a gateway answering in HTML does not surface as a parse crash", async () => {
  const runs = fresh();
  replies = [{ status: 502, body: "<html><body>502 Bad Gateway</body></html>" }];
  await assert.rejects(
    () => runs.submit(spec, scene),
    (error: unknown) => {
      assert.ok(error instanceof FuseError);
      assert.equal(error.kind, "server");
      assert.match(error.detail, /502/);
      return true;
    },
  );
});

test("pricing is fetched without a key, and parses as the recorded fixture does", async () => {
  calls.length = 0;
  const catalog = await Catalog.load(new FuseHttp({ baseUrl, timeoutMs: 5_000 }));
  assert.equal(calls[0]!.url, "/v1/api/pricing");
  assert.equal(calls[0]!.auth, undefined, "pricing is public; no key should be sent");
  assert.equal(catalog.tier("t2v-low-standard").baseTokens, 20);
});

/* ----------------------------------------------------------------- uploading */

const uploaded = {
  status: { code: "SUC_201", message: ["Created"] },
  data: { downloadUrl: "https://storage.googleapis.com/bucket/assets/job-1/bottle.png" },
};

test("an uploaded file declares its own media type on its part of the body", async () => {
  // Prod reads this header and refuses anything outside image/*, video/* and
  // audio/mpeg. An untyped Blob goes out as application/octet-stream, which
  // was refused for every file, 54 KB included, under the message the error
  // code happens to carry: "file too large".
  const http = freshHttp();
  replies = [{ status: 201, body: uploaded }];
  const url = await http.upload({
    name: "bottle.png",
    bytes: new Uint8Array([137, 80, 78, 71]),
    contentType: "image/png",
    mediaKind: "image",
    groupId: "job-1",
  });

  assert.equal(url, "https://storage.googleapis.com/bucket/assets/job-1/bottle.png");
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.method, "POST");
  assert.equal(calls[0]!.url, "/v1/api/upload");
  assert.equal(calls[0]!.auth, "Bearer test-key");

  const raw = calls[0]!.raw ?? "";
  assert.match(raw, /name="file"; filename="bottle\.png"/);
  assert.match(raw, /Content-Type: image\/png/);
  assert.doesNotMatch(raw, /application\/octet-stream/);
  // The metadata the web app sends alongside, in the same shape.
  assert.match(raw, /name="metadata"/);
  assert.deepEqual(JSON.parse(raw.split("\r\n\r\n").pop()!.split("\r\n")[0]!), {
    dir_name: "assets",
    group_uuid: "job-1",
    media_kind: "image",
  });
});

test("a refusal of the upload reaches the caller in the server's own words", async () => {
  const http = freshHttp();
  replies = [
    { status: 400, body: { status: { code: "ERR_6002", message: ["file too large", "not support file"] } } },
  ];
  await assert.rejects(
    () =>
      http.upload({
        name: "script.txt",
        bytes: new Uint8Array([1]),
        contentType: "text/plain",
        mediaKind: "image",
        groupId: "job-1",
      }),
    (error: unknown) =>
      error instanceof FuseError && error.kind === "rejected" && /not support file/.test(error.detail),
  );
});
