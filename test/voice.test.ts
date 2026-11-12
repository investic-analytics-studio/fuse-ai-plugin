/**
 * Voiceover is the customer's own ElevenLabs account, so these tests are about
 * two things: not sending a credential to the wrong company, and not spending
 * someone else's money twice.
 *
 * Tested against a stand-in ElevenLabs rather than a stubbed `fetch`, for the
 * same reason as `client.test.ts`: the failures that matter here are HTTP ones
 * — a header that never went out, a 401 that is really "out of credit", a 200
 * with no audio in it. The bodies below are the shapes the real API documents.
 */
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { existsSync } from "node:fs";
import { mkdtemp, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, beforeEach, test } from "node:test";
import {
  DEFAULT_VOICE_MODEL,
  ElevenLabs,
  VOICE_OUTPUT_FORMAT,
  VoiceError,
} from "../src/voice/elevenlabs.ts";
import { characterCount, narrate, type NarrationReport } from "../src/voice/narrate.ts";

/** An mp3's first bytes. Nothing reads them; they prove a file is not empty. */
const MP3 = new Uint8Array([0x49, 0x44, 0x33, 0x04, 0x00, 0x00]);

interface Call {
  method: string;
  url: string;
  xiApiKey?: string;
  authorization?: string;
  body: unknown;
}

const calls: Call[] = [];

/** What the stand-in does next, set per test. */
const script: {
  /** One entry per call: `undefined` means "answer with audio". */
  speak: Array<{ status: number; body?: unknown; empty?: boolean } | undefined>;
  subscription: { character_count: number; character_limit: number };
  voicesStatus?: number;
  modelsStatus?: number;
} = {
  speak: [],
  subscription: { character_count: 0, character_limit: 1_000_000 },
};

beforeEach(() => {
  calls.length = 0;
  script.speak = [];
  script.subscription = { character_count: 0, character_limit: 1_000_000 };
  script.voicesStatus = undefined;
  script.modelsStatus = undefined;
});

function read(request: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let text = "";
    request.on("data", (chunk) => (text += chunk));
    request.on("end", () => resolve(text));
  });
}

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "Content-Type": "application/json" });
  response.end(JSON.stringify(body));
}

const server: Server = createServer(async (request, response) => {
  const text = await read(request);
  const url = request.url ?? "";
  calls.push({
    method: request.method ?? "",
    url,
    xiApiKey: request.headers["xi-api-key"] as string | undefined,
    authorization: request.headers.authorization,
    body: text ? JSON.parse(text) : undefined,
  });

  if (url.startsWith("/v2/voices")) {
    if (script.voicesStatus) {
      json(response, script.voicesStatus, { detail: { status: "invalid_api_key", message: "bad key" } });
      return;
    }
    json(response, 200, {
      voices: [
        { voice_id: "v-thai-female", name: "Ploy", category: "premade", labels: { accent: "thai" } },
        { voice_id: "v-brand-clone", name: "Brand", category: "cloned" },
        { name: "nameless, no id at all" },
      ],
      has_more: true,
    });
    return;
  }
  if (url.startsWith("/v1/models")) {
    if (script.modelsStatus) {
      json(response, script.modelsStatus, { detail: "the model list is having a bad day" });
      return;
    }
    // Shaped like the live account, which matters here: multilingual v2 is the
    // default this package falls back to and it does **not** list Thai. The
    // fixture used to give it Thai, and a fixture that is kinder than reality
    // is how a Thai script came to be sent to a model that cannot read it.
    json(response, 200, [
      {
        model_id: "eleven_multilingual_v2",
        name: "Multilingual v2",
        can_do_text_to_speech: true,
        languages: [{ language_id: "en", name: "English" }, { language_id: "ja", name: "Japanese" }],
      },
      {
        model_id: "eleven_v3",
        name: "Eleven v3",
        can_do_text_to_speech: true,
        languages: [{ language_id: "en", name: "English" }, { language_id: "th", name: "Thai" }],
      },
      { model_id: "scribe_v1", name: "Scribe", can_do_text_to_speech: false },
    ]);
    return;
  }
  if (url.startsWith("/v1/user/subscription")) {
    json(response, 200, script.subscription);
    return;
  }
  if (url.startsWith("/v1/text-to-speech/")) {
    const next = script.speak.shift();
    if (next?.empty) {
      // A truly empty body, not `""` serialised as JSON — which is two bytes
      // and would sail past the check this is here to exercise.
      response.writeHead(next.status, { "Content-Type": "audio/mpeg" });
      response.end();
      return;
    }
    if (next) {
      json(response, next.status, next.body ?? { detail: { status: "boom", message: "no" } });
      return;
    }
    response.writeHead(200, { "Content-Type": "audio/mpeg" });
    response.end(Buffer.from(MP3));
    return;
  }
  json(response, 404, { detail: "no such path in the stand-in" });
});

await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
const baseUrl =
  typeof address === "object" && address ? `http://127.0.0.1:${address.port}` : "http://127.0.0.1";
after(() => server.close());

const client = (): ElevenLabs => new ElevenLabs({ apiKey: "xi-secret", baseUrl, timeoutMs: 5_000 });

const spoke = (): Call[] => calls.filter((call) => call.url.startsWith("/v1/text-to-speech/"));

async function workspace(): Promise<string> {
  return mkdtemp(join(tmpdir(), "fuse-voice-"));
}

function run(
  dir: string,
  lines: ReadonlyArray<{ slug: string; text: string }>,
  options: {
    maxCharacters?: number;
    dryRun?: boolean;
    probe?: boolean;
    modelId?: string;
  } = {},
): Promise<NarrationReport> {
  return narrate(
    dir,
    lines,
    {
      voiceId: "v-thai-female",
      // These scripts are Thai, so a model that reads Thai is named: the
      // fallback cannot, and every test below would stop on that instead of
      // on the thing it is about.
      modelId: options.modelId ?? "eleven_v3",
      maxCharacters: options.maxCharacters ?? 10_000,
      ...(options.dryRun === undefined ? {} : { dryRun: options.dryRun }),
    },
    {
      voice: client(),
      ...(options.probe ? { probeDuration: async () => 4.25 } : {}),
    },
  );
}

/* ------------------------------------------------------------------ the key */

test("the key travels in xi-api-key and nothing resembling a Fuse credential goes with it", async () => {
  await client().speak({ voiceId: "v-thai-female", modelId: DEFAULT_VOICE_MODEL, text: "hello" });
  const call = spoke()[0]!;
  assert.equal(call.xiApiKey, "xi-secret");
  // The guard that matters: Fuse reads `Authorization: Bearer`, so an
  // Authorization header leaving for ElevenLabs is a key sent to the wrong
  // company — the one mistake in this file that cannot be taken back.
  assert.equal(call.authorization, undefined);
});

test("the audio is asked for in the one format every tier may request", async () => {
  await client().speak({ voiceId: "v-thai-female", modelId: DEFAULT_VOICE_MODEL, text: "hello" });
  assert.ok(spoke()[0]!.url.includes(`output_format=${VOICE_OUTPUT_FORMAT}`));
  assert.deepEqual(spoke()[0]!.body, { text: "hello", model_id: DEFAULT_VOICE_MODEL });
});

/* --------------------------------------------------------------- refusals */

test("running out of characters is not reported as a bad key", async () => {
  // ElevenLabs answers 401 for both, and the difference is only in the body.
  // Calling this one "unauthorized" sends the customer to re-issue a key that
  // was never the problem, and the real cause — no credit — goes unsaid.
  script.speak = [
    {
      status: 401,
      body: { detail: { status: "quota_exceeded", message: "You have 12 characters left." } },
    },
  ];
  const error = await client()
    .speak({ voiceId: "v", modelId: DEFAULT_VOICE_MODEL, text: "hi" })
    .then(() => undefined, (cause: unknown) => cause as VoiceError);
  assert.ok(error instanceof VoiceError);
  assert.equal(error.kind, "quota_exhausted");
  assert.match(error.detail, /12 characters left/);
});

test("a genuinely bad key is still unauthorized", async () => {
  script.voicesStatus = 401;
  const error = await client().voices().then(() => undefined, (cause: unknown) => cause as VoiceError);
  assert.equal(error?.kind, "unauthorized");
});

test("a rejected request names the field that was wrong", async () => {
  script.speak = [
    {
      status: 422,
      body: { detail: [{ loc: ["body", "text"], msg: "field required", type: "value_error" }] },
    },
  ];
  const error = await client()
    .speak({ voiceId: "v", modelId: DEFAULT_VOICE_MODEL, text: "x" })
    .then(() => undefined, (cause: unknown) => cause as VoiceError);
  assert.equal(error?.kind, "rejected");
  assert.match(error!.detail, /body\.text: field required/);
  assert.equal(error!.retryable, false);
});

test("a 200 with no audio in it is a fault, not an empty file", async () => {
  // Writing a zero-byte mp3 would leave a file on disk that reads as paid for
  // and plays as silence, which is the worst of both.
  script.speak = [{ status: 200, empty: true }];
  const error = await client()
    .speak({ voiceId: "v", modelId: DEFAULT_VOICE_MODEL, text: "x" })
    .then(() => undefined, (cause: unknown) => cause as VoiceError);
  assert.equal(error?.kind, "server");
});

/* ---------------------------------------------------------------- catalogue */

test("a model that cannot speak is not offered as a voice", async () => {
  const models = await client().models();
  assert.deepEqual(
    models.map((model) => model.id),
    ["eleven_multilingual_v2", "eleven_v3"],
  );
  const thai = models.filter((model) => model.languages.includes("th")).map((model) => model.id);
  assert.deepEqual(thai, ["eleven_v3"], "Thai has to be visible to pick a model by it");
});

test("a voice with no id is dropped rather than carried as a blank choice", async () => {
  const listing = await client().voices();
  assert.deepEqual(
    listing.voices.map((voice) => voice.id),
    ["v-thai-female", "v-brand-clone"],
  );
  assert.equal(listing.hasMore, true);
});

test("an account over its allowance has none left, not a negative number", async () => {
  // A negative remainder would read as room in the budget check below.
  script.subscription = { character_count: 10_500, character_limit: 10_000 };
  assert.equal((await client().quota()).remaining, 0);
});

/* ------------------------------------------------------------------- money */

test("Thai is billed by character, not by byte", async () => {
  // The same mistake exists on the backend's standalone route, which counts
  // len() over UTF-8 and so quotes a Thai script at three times its real cost.
  const thai = "สวัสดีครับ";
  assert.equal(characterCount(thai), 10);
  assert.equal(Buffer.byteLength(thai, "utf8"), 30);
  const report = await run(await workspace(), [{ slug: "hook", text: thai }]);
  assert.equal(report.charactersSpent, 10);
});

test("a line already on disk is never spoken again", async () => {
  const dir = await workspace();
  const lines = [{ slug: "hook", text: "ชาไทยเย็นแก้วโปรด" }];
  const first = await run(dir, lines);
  assert.equal(first.lines[0]!.state, "spoken");
  assert.ok(first.charactersSpent > 0);

  const second = await run(dir, lines);
  assert.equal(second.lines[0]!.state, "reused");
  assert.equal(second.charactersSpent, 0);
  assert.equal(second.charactersReused, first.charactersSpent);
  assert.equal(spoke().length, 1, "the second call must not reach ElevenLabs at all");
});

test("renaming a scene does not pay for the same words twice", async () => {
  const dir = await workspace();
  const text = "เทลงบนน้ำแข็ง";
  await run(dir, [{ slug: "scene-a", text }]);
  const renamed = await run(dir, [{ slug: "opening-pour", text }]);
  assert.equal(renamed.lines[0]!.state, "reused");
  assert.equal(renamed.charactersSpent, 0);
  assert.equal(spoke().length, 1);
});

test("editing a word is new audio, and leaves the old file alone", async () => {
  const dir = await workspace();
  await run(dir, [{ slug: "hook", text: "ชาไทยเย็น" }]);
  const edited = await run(dir, [{ slug: "hook", text: "ชาไทยเย็นจัด" }]);
  assert.equal(edited.lines[0]!.state, "spoken");
  assert.equal(spoke().length, 2);
  const files = await readdir(join(dir, "assets", "audio"));
  assert.equal(files.length, 2, "the version already paid for must survive a re-prompt");
});

test("two scenes that say the same thing share one file", async () => {
  const dir = await workspace();
  const text = "อร่อยจริง";
  const report = await run(dir, [
    { slug: "scene-a", text },
    { slug: "scene-b", text },
  ]);
  assert.equal(spoke().length, 1);
  assert.equal(report.lines[0]!.file, report.lines[1]!.file);
  assert.equal(report.charactersSpent, characterCount(text));
});

test("over budget speaks nothing at all", async () => {
  // Half a voiceover nobody asked for is worse than none, and it would have
  // been paid for.
  const dir = await workspace();
  const lines = [
    { slug: "scene-a", text: "หนึ่งสองสามสี่ห้า" },
    { slug: "scene-b", text: "หกเจ็ดแปดเก้าสิบ" },
  ];
  const report = await run(dir, lines, { maxCharacters: 5 });
  assert.equal(report.stopped, "over_budget");
  assert.equal(report.charactersSpent, 0);
  assert.equal(spoke().length, 0);
  assert.equal(existsSync(join(dir, "assets", "audio")), false);
  // Counted from the script rather than written in by hand: the figure the
  // refusal quotes is the one the user is asked to approve, so it has to be
  // the real character count and not a number that happened to match once.
  const whole = lines.reduce((sum, line) => sum + characterCount(line.text), 0);
  assert.equal(report.charactersToSpend, whole);
  assert.match(report.detail!, new RegExp(`${whole} characters`));
});

test("a dry run prices the script and speaks none of it", async () => {
  const dir = await workspace();
  const report = await run(dir, [{ slug: "hook", text: "ชาไทยเย็น" }], {
    dryRun: true,
    maxCharacters: 1,
  });
  assert.equal(report.dryRun, true);
  assert.equal(report.charactersToSpend, 9);
  assert.equal(report.charactersSpent, 0);
  assert.equal(report.lines[0]!.state, "planned");
  // Priced even though the figure is over the ceiling: that number is exactly
  // what there is to go and agree with the user.
  assert.equal(report.stopped, undefined);
  assert.equal(spoke().length, 0);
  assert.equal(existsSync(join(dir, "assets", "audio")), false);
});

test("an account with too little left is told before anything is spoken", async () => {
  script.subscription = { character_count: 9_995, character_limit: 10_000 };
  const dir = await workspace();
  const report = await run(dir, [{ slug: "hook", text: "ชาไทยเย็นหอมมัน" }]);
  assert.equal(report.stopped, "quota_exhausted");
  assert.equal(report.charactersSpent, 0);
  assert.equal(spoke().length, 0, "the point is to find out without spending a call");
  assert.match(report.detail!, /5 characters left/);
});

test("a failure part way keeps the lines already paid for", async () => {
  const dir = await workspace();
  script.speak = [undefined, { status: 500, body: { detail: "upstream fell over" } }];
  const report = await run(dir, [
    { slug: "scene-a", text: "หนึ่ง" },
    { slug: "scene-b", text: "สอง" },
  ]);
  assert.equal(report.stopped, "provider_failed");
  assert.equal(report.lines[0]!.state, "spoken");
  assert.equal(report.lines[1]!.state, "planned");
  assert.equal(report.charactersSpent, characterCount("หนึ่ง"));
  assert.ok(existsSync(join(dir, report.lines[0]!.file!)));

  // And the retry buys only what is missing.
  const again = await run(dir, [
    { slug: "scene-a", text: "หนึ่ง" },
    { slug: "scene-b", text: "สอง" },
  ]);
  assert.equal(again.lines[0]!.state, "reused");
  assert.equal(again.lines[1]!.state, "spoken");
  assert.equal(again.charactersSpent, characterCount("สอง"));
});

test("the measured duration reaches the caller, so picture can be cut to voice", async () => {
  const report = await run(await workspace(), [{ slug: "hook", text: "ชาไทย" }], { probe: true });
  assert.equal(report.lines[0]!.seconds, 4.25);
});

test("audio that cannot be measured is still kept, because it was paid for", async () => {
  const dir = await workspace();
  const report = await narrate(
    dir,
    [{ slug: "hook", text: "ชาไทย" }],
    { voiceId: "v-thai-female", modelId: "eleven_v3", maxCharacters: 100 },
    {
      voice: client(),
      probeDuration: async () => {
        throw new Error("ffprobe is not on this machine");
      },
    },
  );
  assert.equal(report.lines[0]!.state, "spoken");
  assert.equal(report.lines[0]!.seconds, undefined);
  assert.ok(existsSync(join(dir, report.lines[0]!.file!)));
});

/* --------------------------------------------------- the language of the script */

test("a Thai script is not sent to a model that cannot read it", async () => {
  // The refusal that matters most, because nothing else catches it: a model
  // without Thai answers, charges, and hands back audio of something other
  // than the words on the page. Only listening would reveal it, and by then
  // the characters are gone.
  const dir = await workspace();
  const report = await run(dir, [{ slug: "hook", text: "ชาไทยเย็นหอมมัน" }], {
    modelId: "eleven_multilingual_v2",
  });
  assert.equal(report.stopped, "model_cannot_speak_script");
  assert.equal(report.charactersSpent, 0);
  assert.equal(spoke().length, 0, "nothing may reach ElevenLabs, because it would be billed");
  assert.equal(existsSync(join(dir, "assets", "audio")), false);
  // The way out has to be in the message, or the caller is left guessing.
  assert.match(report.detail!, /th/);
  assert.match(report.detail!, /eleven_v3/, "the models that can read it have to be named");
});

test("the model the package falls back to is checked like any other", async () => {
  // This is the real case rather than a contrived one: the fallback is
  // multilingual v2, the documentation of this package is in Thai, and a job
  // that names no model is the normal way in.
  const dir = await workspace();
  const report = await narrate(
    dir,
    [{ slug: "hook", text: "เทลงบนน้ำแข็ง" }],
    { voiceId: "v-thai-female", maxCharacters: 1_000 },
    { voice: client() },
  );
  assert.equal(report.stopped, "model_cannot_speak_script");
  assert.equal(report.modelId, DEFAULT_VOICE_MODEL);
  assert.equal(spoke().length, 0);
});

test("a dry run says so while the price is still being agreed", async () => {
  // Finding out at the dry run costs nothing. Finding out after the real call
  // costs the whole script.
  const report = await run(await workspace(), [{ slug: "hook", text: "อร่อยจริง" }], {
    modelId: "eleven_multilingual_v2",
    dryRun: true,
  });
  assert.equal(report.stopped, "model_cannot_speak_script");
  assert.equal(report.dryRun, true);
  assert.equal(spoke().length, 0);
});

test("an English script is not held up by the Thai check", async () => {
  // The check must not become a tax on every other job: no Thai in the script,
  // no reason to ask the model list anything.
  const report = await run(await workspace(), [{ slug: "hook", text: "pour it over ice" }], {
    modelId: "eleven_multilingual_v2",
  });
  assert.equal(report.stopped, undefined);
  assert.equal(report.lines[0]!.state, "spoken");
  assert.equal(spoke().length, 1);
  assert.equal(
    calls.filter((call) => call.url.startsWith("/v1/models")).length,
    0,
    "an English script must not even ask which languages the model speaks",
  );
});

test("a model list that cannot be read does not block work that may be fine", async () => {
  // Being unable to check is not the same as knowing it is wrong. A refusal
  // here would turn a bad minute at the model endpoint into a refusal to do
  // work the account is paying for, and the synthesis call is the authority.
  script.modelsStatus = 500;
  const report = await run(await workspace(), [{ slug: "hook", text: "ชาไทย" }], {
    modelId: "eleven_multilingual_v2",
  });
  assert.equal(report.stopped, undefined);
  assert.equal(report.lines[0]!.state, "spoken");
  assert.equal(spoke().length, 1);
});
