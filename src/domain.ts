/**
 * Domain types. Nothing here knows about HTTP, MCP or the disk.
 *
 * Two invariants live in the types instead of in runtime checks:
 *   - a Resolution can only come from the catalog, so a hardcoded "1080p"
 *     cannot reach the API (the per-tier list lives on the server and the CRM
 *     changes it);
 *   - no domain type holds an output URL, only a local path, so a provider
 *     link that expires can never be handed back to the model.
 */

/** The three axes the API validates with `oneof` (standalone_video.go). */
export type Mode = "text-to-video" | "image-to-video";
export type Priority = "low" | "fast";
export type Quality = "standard" | "high";

/** `t2v-low-standard` … — the server builds this same string from the axes. */
export type TierId = `${"t2v" | "i2v"}-${Priority}-${Quality}`;

declare const resolutionBrand: unique symbol;
/** Valid only because some tier offered it. Build with `Catalog.resolution`. */
export type Resolution = string & { readonly [resolutionBrand]: true };

export type Aspect = "16:9" | "9:16" | "1:1";

export interface TierResolution {
  readonly name: Resolution;
  readonly tokensPerSecond: number;
}

/** One row of the catalog, parsed from `GET /pricing`. Never hand-written. */
export interface Tier {
  readonly id: TierId;
  readonly mode: Mode;
  readonly priority: Priority;
  readonly quality: Quality;
  readonly baseTokens: number;
  readonly resolutions: readonly TierResolution[];
  readonly aspects: readonly Aspect[];
  readonly supportsLastImage: boolean;
}

/** What the caller writes. `slug` names the scene for the whole job's life. */
export interface SceneSpec {
  readonly slug: string;
  readonly prompt: string;
  readonly seconds: number;
  readonly imageUrls?: readonly string[];
  readonly lastImageUrl?: string;
}

/** The shape every scene of one job shares. Fixed when the job is created. */
export interface JobSpec {
  readonly tier: TierId;
  readonly resolution: Resolution;
  readonly aspect: Aspect;
}

export type SceneState =
  | "planned" // priced, nothing spent
  | "working" // submitted, a run exists, tokens are spent
  | "ready" // downloaded to disk
  | "failed"; // the run ended without a file; the server refunds those

export interface SceneRecord {
  readonly slug: string;
  readonly specHash: string;
  readonly state: SceneState;
  readonly runId?: string;
  readonly file?: string; // relative to the project dir, never a URL
  readonly tokens?: number;
  readonly lastError?: string;
}

export interface Job {
  readonly id: string;
  readonly spec: JobSpec;
  readonly scenes: readonly SceneRecord[];
  readonly spent: number;
}

export interface EstimateLine {
  readonly slug: string;
  readonly tokens: number;
}

/**
 * What the scenes should cost. It is an estimate, not a promise: the ledger
 * charges on the clip the provider actually returns, and a tier can hand back
 * a little more than asked (MiniMax H3 returns 5.167 s for `duration: 5`,
 * which is 41 tokens where this estimate says 40).
 */
export interface Estimate {
  readonly lines: readonly EstimateLine[];
  readonly total: number;
  readonly note: string;
}

/**
 * A ceiling the caller must state. There is deliberately no "unlimited":
 * every path that can spend tokens takes one of these.
 */
export interface Budget {
  readonly maxTokens: number;
  readonly alreadySpent: number;
}

export type StopReason =
  | "insufficient_tokens"
  | "over_budget"
  | "rejected_by_api"
  | "provider_failed";

export interface JobView {
  readonly job: string;
  readonly spent: number;
  readonly done: number;
  readonly total: number;
  readonly scenes: readonly SceneRecord[];
  readonly stopped?: StopReason;
  /** The server's own words when it refused. Never re-worded. */
  readonly detail?: string;
}

export const TIER_PATTERN = /^(t2v|i2v)-(low|fast)-(standard|high)$/;

export function isTierId(value: string): value is TierId {
  return TIER_PATTERN.test(value);
}

export function modeOf(tier: TierId): Mode {
  return tier.startsWith("t2v") ? "text-to-video" : "image-to-video";
}
