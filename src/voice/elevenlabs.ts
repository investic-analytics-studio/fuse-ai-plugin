/**
 * The only module that speaks HTTP to ElevenLabs.
 *
 * ElevenLabs is the customer's own account, not ours. The key comes from their
 * environment, the characters come off their quota, and the invoice arrives
 * from ElevenLabs — no Fuse token is involved on any path in this file. That is
 * why it does not reuse `fuse/client.ts`: one module per account, so a Fuse key
 * can never be sent to ElevenLabs, and an ElevenLabs key can never be sent to
 * Fuse. The two keys do not even share a header name (`xi-api-key` here,
 * `Authorization: Bearer` there), and mixing them up would mean handing a live
 * credential to the wrong company.
 *
 * What is read live instead of hardcoded: the voices on the account, the models
 * it may use with the languages each one speaks, and how many characters are
 * left. A voice list baked into this package would be a list of voices a
 * particular customer does not have, and a baked-in model id would eventually
 * be one that cannot pronounce Thai.
 */

/** The public API. Regional hosts exist; this is the global one. */
export const ELEVENLABS_BASE_URL = "https://api.elevenlabs.io";

/**
 * The model used when the caller names none: ElevenLabs' own default for this
 * endpoint. It stays a default rather than a constant because `fuse_voices`
 * reports what the account can actually use — a package that insisted on one
 * model id would outlive it.
 *
 * **It does not speak Thai.** This comment claimed it did until a live account
 * was read: the model list gives multilingual v2 twenty-nine languages and Thai
 * is not among them. Nothing refuses a Thai script sent to it, so it answers,
 * charges, and reads the words as something else — which is why `narrate`
 * checks the language of the script against the model before it spends. A
 * Thai job has to name a model that lists `th`, and `fuse_voices` is where to
 * see which ones do.
 */
export const DEFAULT_VOICE_MODEL = "eleven_multilingual_v2";

/**
 * mp3 at 44.1 kHz, which every tier may request and HyperFrames can place
 * without a conversion step. Higher bitrates and raw PCM need a paid tier, so
 * asking for one would fail for exactly the customers least able to fix it.
 */
export const VOICE_OUTPUT_FORMAT = "mp3_44100_128";

const VOICES_PATH = "/v2/voices";
const MODELS_PATH = "/v1/models";
const SUBSCRIPTION_PATH = "/v1/user/subscription";
const SPEECH_PATH = "/v1/text-to-speech";

/**
 * Why a call did not succeed, in terms the caller can act on:
 *
 *   rejected         — the request is wrong; sending it again changes nothing
 *   unauthorized     — the key is missing, wrong or disabled
 *   quota_exhausted  — the account is out of characters; nothing was spoken
 *   rate_limited     — too many at once; the same request later is fine
 *   not_found        — no such voice or model on this account
 *   server           — ElevenLabs failed on its side; worth another try
 *   transport        — the network or the timeout; worth another try
 */
export type VoiceErrorKind =
  | "rejected"
  | "unauthorized"
  | "quota_exhausted"
  | "rate_limited"
  | "not_found"
  | "server"
  | "transport";

/** Carries ElevenLabs' own text in `detail`, unedited. */
export class VoiceError extends Error {
  readonly kind: VoiceErrorKind;
  readonly httpStatus: number;
  readonly detail: string;

  constructor(kind: VoiceErrorKind, httpStatus: number, detail: string) {
    super(detail);
    this.name = "VoiceError";
    this.kind = kind;
    this.httpStatus = httpStatus;
    this.detail = detail;
  }

  /** A second attempt can succeed; a `rejected` one cannot. */
  get retryable(): boolean {
    return this.kind === "server" || this.kind === "transport" || this.kind === "rate_limited";
  }
}

export interface Voice {
  readonly id: string;
  readonly name?: string;
  /** `premade`, `cloned`, `professional`… — how the customer got this voice. */
  readonly category?: string;
  /** Free-form tags the account set: accent, age, use case. */
  readonly labels?: Readonly<Record<string, string>>;
}

export interface VoiceListing {
  readonly voices: readonly Voice[];
  /** True when the account has more voices than one page holds. */
  readonly hasMore: boolean;
}

export interface VoiceModelInfo {
  readonly id: string;
  readonly name?: string;
  /** Language ids the model speaks, so a Thai script is not sent to an English model. */
  readonly languages: readonly string[];
}

export interface VoiceQuota {
  readonly used: number;
  readonly limit: number;
  readonly remaining: number;
  /** When the allowance resets, as the account reports it. */
  readonly resetsAt?: string;
}

export interface SpeakRequest {
  readonly voiceId: string;
  readonly modelId: string;
  readonly text: string;
}

/** What narration needs of ElevenLabs. A test substitutes its own. */
export interface VoicePort {
  voices(search?: string): Promise<VoiceListing>;
  models(): Promise<readonly VoiceModelInfo[]>;
  quota(): Promise<VoiceQuota>;
  /** One call is one charge against the customer's character allowance. */
  speak(request: SpeakRequest): Promise<Uint8Array>;
}

/* ------------------------------------------------------------------ errors */

/**
 * ElevenLabs reports a problem in two different shapes under the same key:
 * `detail` is a list of field errors on a 422, and an object with its own
 * `status` on a business refusal. Both are read, because the status is what
 * tells "out of characters" apart from "bad key" — they arrive with the same
 * HTTP code.
 */
function problemOf(text: string): { detail: string; status?: string } {
  if (!text) return { detail: "" };
  let parsed: { detail?: unknown };
  try {
    parsed = JSON.parse(text) as { detail?: unknown };
  } catch {
    // A gateway can answer in HTML; keep a short trace rather than the lot.
    return { detail: text.slice(0, 200) };
  }
  const detail = parsed.detail;
  if (typeof detail === "string") return { detail };
  if (Array.isArray(detail)) {
    const messages = detail
      .map((item) => {
        const row = item as { loc?: readonly unknown[]; msg?: unknown };
        const where = Array.isArray(row.loc) ? row.loc.join(".") : "";
        const message = typeof row.msg === "string" ? row.msg : "";
        return where && message ? `${where}: ${message}` : message || where;
      })
      .filter((message) => message !== "");
    return { detail: messages.join(" — ") };
  }
  if (detail !== null && typeof detail === "object") {
    const row = detail as { status?: unknown; message?: unknown };
    return {
      detail: typeof row.message === "string" ? row.message : "",
      status: typeof row.status === "string" ? row.status : undefined,
    };
  }
  return { detail: text.slice(0, 200) };
}

function kindOf(httpStatus: number, status: string | undefined): VoiceErrorKind {
  // The status string is read before the HTTP code on purpose: running out of
  // characters arrives as a 401, and calling that "unauthorized" would send the
  // customer off to check a key that is perfectly good.
  if (status === "quota_exceeded") return "quota_exhausted";
  if (httpStatus === 429) return "rate_limited";
  if (httpStatus === 401 || httpStatus === 403) return "unauthorized";
  if (httpStatus === 404) return "not_found";
  if (httpStatus >= 500) return "server";
  return "rejected";
}

function reasonOf(cause: unknown): string {
  if (cause instanceof Error) {
    return cause.name === "TimeoutError" ? "timed out" : cause.message;
  }
  return String(cause);
}

/* ------------------------------------------------------------------ client */

export interface ElevenLabsOptions {
  readonly apiKey: string;
  readonly baseUrl?: string;
  readonly timeoutMs?: number;
  /** Injected so tests never reach the network. */
  readonly fetch?: (url: string, init?: RequestInit) => Promise<Response>;
}

interface WireVoice {
  voice_id?: unknown;
  name?: unknown;
  category?: unknown;
  labels?: unknown;
}

interface WireModel {
  model_id?: unknown;
  name?: unknown;
  can_do_text_to_speech?: unknown;
  languages?: unknown;
}

/** One page is enough to choose from, and asking for more is a slower answer. */
const VOICE_PAGE_SIZE = 100;

export class ElevenLabs implements VoicePort {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly get: (url: string, init?: RequestInit) => Promise<Response>;

  constructor(options: ElevenLabsOptions) {
    this.apiKey = options.apiKey;
    this.baseUrl = options.baseUrl ?? ELEVENLABS_BASE_URL;
    this.timeoutMs = options.timeoutMs ?? 120_000;
    this.get = options.fetch ?? fetch;
  }

  async voices(search?: string): Promise<VoiceListing> {
    const query = new URLSearchParams({ page_size: String(VOICE_PAGE_SIZE) });
    if (search) query.set("search", search);
    const data = (await this.json(VOICES_PATH, query)) as {
      voices?: unknown;
      has_more?: unknown;
    };
    const rows = Array.isArray(data.voices) ? data.voices : [];
    const voices: Voice[] = [];
    for (const row of rows) {
      const wire = row as WireVoice;
      if (typeof wire.voice_id !== "string" || !wire.voice_id) continue;
      voices.push({
        id: wire.voice_id,
        ...(typeof wire.name === "string" ? { name: wire.name } : {}),
        ...(typeof wire.category === "string" ? { category: wire.category } : {}),
        ...(wire.labels !== null && typeof wire.labels === "object"
          ? { labels: wire.labels as Record<string, string> }
          : {}),
      });
    }
    return { voices, hasMore: data.has_more === true };
  }

  async models(): Promise<readonly VoiceModelInfo[]> {
    const data = await this.json(MODELS_PATH);
    const rows = Array.isArray(data) ? data : [];
    const models: VoiceModelInfo[] = [];
    for (const row of rows) {
      const wire = row as WireModel;
      if (typeof wire.model_id !== "string" || !wire.model_id) continue;
      // Models that cannot speak are not choices for a voiceover. The field is
      // optional, so only an explicit `false` rules a model out.
      if (wire.can_do_text_to_speech === false) continue;
      const languages = Array.isArray(wire.languages)
        ? wire.languages.flatMap((entry) => {
            const id = (entry as { language_id?: unknown }).language_id;
            return typeof id === "string" ? [id] : [];
          })
        : [];
      models.push({
        id: wire.model_id,
        ...(typeof wire.name === "string" ? { name: wire.name } : {}),
        languages,
      });
    }
    return models;
  }

  async quota(): Promise<VoiceQuota> {
    const data = (await this.json(SUBSCRIPTION_PATH)) as {
      character_count?: unknown;
      character_limit?: unknown;
      next_character_count_reset_unix?: unknown;
    };
    const used = typeof data.character_count === "number" ? data.character_count : 0;
    const limit = typeof data.character_limit === "number" ? data.character_limit : 0;
    const reset = data.next_character_count_reset_unix;
    return {
      used,
      limit,
      // Never negative: an account over its allowance has none left, not a
      // debt, and a negative number here would read as room in a budget check.
      remaining: Math.max(0, limit - used),
      ...(typeof reset === "number" && reset > 0
        ? { resetsAt: new Date(reset * 1000).toISOString() }
        : {}),
    };
  }

  async speak(request: SpeakRequest): Promise<Uint8Array> {
    const path = `${SPEECH_PATH}/${encodeURIComponent(request.voiceId)}`;
    const query = new URLSearchParams({ output_format: VOICE_OUTPUT_FORMAT });
    const response = await this.send("POST", path, query, {
      text: request.text,
      model_id: request.modelId,
    });
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength === 0) {
      throw new VoiceError("server", response.status, `${path} answered 200 with no audio in it`);
    }
    return bytes;
  }

  private async json(path: string, query?: URLSearchParams): Promise<unknown> {
    const response = await this.send("GET", path, query);
    const text = await response.text();
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new VoiceError("server", response.status, `${path} answered with a non-JSON body`);
    }
  }

  /** The one place a request is made, so auth, timeout and refusals agree. */
  private async send(
    method: "GET" | "POST",
    path: string,
    query?: URLSearchParams,
    body?: unknown,
  ): Promise<Response> {
    const search = query && [...query.keys()].length > 0 ? `?${query.toString()}` : "";
    const url = new URL(`${path}${search}`, this.baseUrl).toString();
    const headers: Record<string, string> = {
      // ElevenLabs' own header. Deliberately not `Authorization`, which is
      // what Fuse uses: the difference is the guard against sending one
      // company's key to the other.
      "xi-api-key": this.apiKey,
    };
    if (body !== undefined) headers["Content-Type"] = "application/json";

    let response: Response;
    try {
      response = await this.get(url, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (cause) {
      throw new VoiceError(
        "transport",
        0,
        `${method} ${path} did not complete: ${reasonOf(cause)}`,
      );
    }
    if (!response.ok) {
      // Read as text first: an error body is small, and the shape under
      // `detail` varies by which kind of refusal this is.
      const { detail, status } = problemOf(await response.text().catch(() => ""));
      throw new VoiceError(
        kindOf(response.status, status),
        response.status,
        detail || `${path} answered ${response.status}`,
      );
    }
    return response;
  }
}
