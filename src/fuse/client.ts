/**
 * The only module that speaks HTTP to Fuse.
 *
 * Everything the API decides stays on the server: the duration range per tier,
 * the reference-image limits, whether a tier takes a last frame, the price. So
 * this module's job is narrow — carry a request there, and carry the server's
 * own words back when it refuses. It never re-words a message and never keeps
 * a second copy of a rule, because a local copy drifts the moment the CRM
 * changes a tier.
 *
 * Two shapes from the backend that callers here depend on:
 *   - every response is `{ status: { code, message[] }, data }`
 *     (`shared.ResponseBody`), errors included;
 *   - a run's status is already reduced to COMPLETED / FAILED / CANCELLED /
 *     IN_PROGRESS before it leaves the handler, and `output_url` appears only
 *     on COMPLETED (`standalone_video_handler.go`).
 */
import { type JobSpec, type SceneSpec, modeOf } from "../domain.ts";

const PRICING_PATH = "/v1/api/pricing";
const VIDEO_PATH = "/v1/api/ai/standalone/video";
const UPLOAD_PATH = "/v1/api/upload";

/**
 * Why a call did not succeed, in the terms the caller can act on:
 *
 *   rejected            — the request is wrong; sending it again changes nothing
 *   insufficient_tokens — the account is out of tokens; nothing was charged
 *   unauthorized        — the API key is missing, wrong or disabled
 *   not_found           — no run with that id belongs to this key
 *   server              — Fuse failed on its side; worth another try
 *   transport           — the network or the timeout; worth another try
 */
export type FuseErrorKind =
  | "rejected"
  | "insufficient_tokens"
  | "unauthorized"
  | "not_found"
  | "server"
  | "transport";

/** Carries the server's text verbatim in `detail` so the model reads the real rule. */
export class FuseError extends Error {
  readonly kind: FuseErrorKind;
  readonly httpStatus: number;
  readonly code?: string;
  readonly detail: string;

  constructor(kind: FuseErrorKind, httpStatus: number, detail: string, code?: string) {
    super(detail);
    this.name = "FuseError";
    this.kind = kind;
    this.httpStatus = httpStatus;
    this.code = code;
    this.detail = detail;
  }

  /** A second attempt can succeed; a `rejected` one cannot. */
  get retryable(): boolean {
    return this.kind === "server" || this.kind === "transport";
  }
}

/** The envelope the backend wraps every response in. */
interface Envelope {
  status?: { code?: string; message?: string[] };
  data?: unknown;
}

function detailOf(envelope: Envelope, fallback: string): string {
  const message = envelope.status?.message;
  const text = Array.isArray(message) ? message.filter(Boolean).join(" — ") : "";
  return text || fallback;
}

function kindOf(httpStatus: number, code: string | undefined): FuseErrorKind {
  if (httpStatus === 402 || code === "ERR_7001") return "insufficient_tokens";
  if (httpStatus === 401 || httpStatus === 403) return "unauthorized";
  if (httpStatus === 404) return "not_found";
  if (httpStatus >= 500) return "server";
  return "rejected";
}

/** What `Catalog` and `Runs` need; a test substitutes its own. */
export interface Transport {
  get(path: string): Promise<unknown>;
  post(path: string, body: unknown): Promise<unknown>;
}

/** One file, already read, on its way to somewhere the API can fetch it. */
export interface FileToUpload {
  /** The name the customer will recognise it by, not a path. */
  readonly name: string;
  readonly bytes: Uint8Array;
  /**
   * The file's own media type, e.g. `image/png`.
   *
   * It has to be carried here rather than guessed on the way out: the bytes
   * travel as a `Blob`, and a `Blob` with no type is sent as
   * `application/octet-stream`, which the upload endpoint refuses for every
   * file whatever its size.
   */
  readonly contentType: string;
  /** The server's own word for the kind of asset, e.g. "image". */
  readonly mediaKind: string;
  /** Groups a job's files into one folder; any stable string will do. */
  readonly groupId: string;
}

/** Posts one file and answers with the URL the API itself can read it from. */
export type UploadPort = (file: FileToUpload) => Promise<string>;

export interface FuseHttpOptions {
  readonly baseUrl: string;
  /** Left out for `/pricing`, which is public. */
  readonly apiKey?: string;
  readonly timeoutMs?: number;
}

export class FuseHttp implements Transport {
  readonly baseUrl: string;
  private readonly apiKey?: string;
  private readonly timeoutMs: number;

  constructor({ baseUrl, apiKey, timeoutMs = 60_000 }: FuseHttpOptions) {
    this.baseUrl = baseUrl;
    this.apiKey = apiKey;
    this.timeoutMs = timeoutMs;
  }

  get(path: string): Promise<unknown> {
    return this.send("GET", path);
  }

  post(path: string, body: unknown): Promise<unknown> {
    return this.send("POST", path, body);
  }

  /**
   * Puts one file where `image_urls` can reach it, and answers with that URL.
   *
   * It goes through its own method rather than `post` because the body is
   * multipart: the server wants the bytes under `file` and everything else as
   * one JSON string under `metadata`, which is the shape the web app sends.
   * `fetch` writes the boundary of the request itself, so the request's own
   * Content-Type is left unset here — setting it by hand is the usual way this
   * breaks.
   *
   * The file's part is a different header, and that one is ours to set. The
   * endpoint admits `image/*`, `video/*` and `audio/mpeg` and refuses the rest
   * (`ValidContentTypeWildCard`), so a `Blob` left untyped arrives as
   * `application/octet-stream` and is turned away — under a message that reads
   * `file too large`, because that is the text the error code carries.
   */
  async upload(file: FileToUpload): Promise<string> {
    const form = new FormData();
    form.append("file", new Blob([file.bytes], { type: file.contentType }), file.name);
    form.append(
      "metadata",
      JSON.stringify({ dir_name: "assets", group_uuid: file.groupId, media_kind: file.mediaKind }),
    );
    const data = await this.send("POST", UPLOAD_PATH, form);
    const url = (data as { downloadUrl?: unknown } | null)?.downloadUrl;
    if (typeof url !== "string" || !url) {
      throw new FuseError("server", 200, UPLOAD_PATH + " answered without a downloadUrl");
    }
    return url;
  }

  private async send(method: "GET" | "POST", path: string, body?: unknown): Promise<unknown> {
    const url = new URL(path, this.baseUrl);
    const multipart = body instanceof FormData;
    const headers: Record<string, string> = { Accept: "application/json" };
    if (this.apiKey) headers.Authorization = "Bearer " + this.apiKey;
    // FormData carries its own Content-Type, boundary included, and fetch sets
    // it. Writing one here would send a boundary the body does not use.
    if (body !== undefined && !multipart) headers["Content-Type"] = "application/json";

    let response: Response;
    try {
      response = await fetch(url, {
        method,
        headers,
        body: body === undefined ? undefined : multipart ? (body as FormData) : JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (cause) {
      // A timeout and a dead network look the same to the caller: try later.
      throw new FuseError(
        "transport",
        0,
        method + " " + path + " did not complete: " + reasonOf(cause),
      );
    }

    const text = await response.text();
    let envelope: Envelope = {};
    if (text) {
      try {
        envelope = JSON.parse(text) as Envelope;
      } catch {
        // A proxy or a gateway can answer in HTML; keep a short trace of it.
        if (response.ok) {
          throw new FuseError("server", response.status, path + " answered with a non-JSON body");
        }
        throw new FuseError(
          kindOf(response.status, undefined),
          response.status,
          path + " answered " + response.status + ": " + text.slice(0, 200),
        );
      }
    }

    if (!response.ok) {
      const code = envelope.status?.code;
      throw new FuseError(
        kindOf(response.status, code),
        response.status,
        detailOf(envelope, path + " answered " + response.status),
        code,
      );
    }
    return envelope.data;
  }
}

/** Fetches `/pricing` through a transport, so auth and timeouts live in one place. */
export function pricing(http: Transport): Promise<unknown> {
  return http.get(PRICING_PATH);
}

/** The four names the handler reduces every provider's status to. */
export type RunStatus = "IN_PROGRESS" | "COMPLETED" | "FAILED" | "CANCELLED";

/**
 * A run as the API describes it. This is a wire shape, not a domain one — it is
 * the one place an output URL exists, and it is meant to be used at once: the
 * host differs by tier (our own bucket on the Modal tiers, the provider's CDN
 * on the WaveSpeed ones) and a provider link expires.
 */
export interface RunView {
  readonly id: string;
  readonly status: RunStatus;
  readonly outputUrl?: string;
  readonly completedAt?: string;
}

interface WireRun {
  id?: string;
  status?: string;
  output_url?: string;
  completed_at?: string;
}

function runFrom(data: unknown, path: string): RunView {
  const wire = data as WireRun | null;
  if (!wire || typeof wire.id !== "string" || !wire.id) {
    throw new FuseError("server", 200, path + " answered without a video id");
  }
  const status = wire.status;
  if (
    status !== "IN_PROGRESS" &&
    status !== "COMPLETED" &&
    status !== "FAILED" &&
    status !== "CANCELLED"
  ) {
    // Not quietly read as IN_PROGRESS: a new status name is a contract change,
    // and the caller keeps the run id, so nothing paid for is lost by stopping.
    throw new FuseError("server", 200, path + " answered with unknown status " + String(status));
  }
  return {
    id: wire.id,
    status,
    outputUrl: typeof wire.output_url === "string" && wire.output_url ? wire.output_url : undefined,
    completedAt: typeof wire.completed_at === "string" ? wire.completed_at : undefined,
  };
}

/** Starts and follows standalone video runs. One `submit` is one charge. */
export class Runs {
  private readonly http: Transport;

  constructor(http: Transport) {
    this.http = http;
  }

  /**
   * Starts one scene and returns as soon as the run exists. The tokens are
   * charged here, before the provider is called, so a caller that loses this
   * answer has still paid — which is why `job/lifecycle` writes the id to disk
   * the moment it comes back.
   */
  async submit(spec: JobSpec, scene: SceneSpec): Promise<RunView> {
    const [, priority, quality] = spec.tier.split("-");
    const body: Record<string, unknown> = {
      mode: modeOf(spec.tier),
      priority,
      quality,
      prompt: scene.prompt,
      resolution: spec.resolution,
      duration: scene.seconds,
      aspect_ratio: spec.aspect,
    };
    if (scene.imageUrls?.length) body.image_urls = [...scene.imageUrls];
    if (scene.lastImageUrl) body.last_image_url = scene.lastImageUrl;
    return runFrom(await this.http.post(VIDEO_PATH, body), VIDEO_PATH);
  }

  async status(runId: string): Promise<RunView> {
    const path = VIDEO_PATH + "/" + encodeURIComponent(runId);
    return runFrom(await this.http.get(path), path);
  }
}

/**
 * Opens the finished clip for reading. Deliberately not part of `Transport`:
 * the URL is not ours, carries no API key and must never be sent one.
 */
export type OpenClip = (url: string) => Promise<ReadableStream<Uint8Array>>;

export const openClip: OpenClip = async (url) => {
  let response: Response;
  try {
    response = await fetch(url, { signal: AbortSignal.timeout(120_000) });
  } catch (cause) {
    throw new FuseError("transport", 0, "the finished clip could not be fetched: " + reasonOf(cause));
  }
  if (!response.ok || !response.body) {
    throw new FuseError(
      response.status >= 500 ? "server" : "transport",
      response.status,
      "the finished clip answered " + response.status + "; a provider link may have expired",
    );
  }
  return response.body;
};

function reasonOf(cause: unknown): string {
  if (cause instanceof Error) {
    return cause.name === "TimeoutError" ? "timed out" : cause.message;
  }
  return String(cause);
}
