/**
 * Whether the model behind a tier renders its own audio.
 *
 * Every other tier fact in this package is read from `GET /v1/api/pricing`,
 * because the CRM edits those and a local copy would drift. This one has no
 * row to read: pricing carries prices, and audio is free wherever it exists.
 * The fact lives in the server's own source, in the model each tier is bound
 * to (`internal/core/domain/projects/wavespeed_models.go`, field
 * `GenerateAudio`), and nothing over HTTP exposes it.
 *
 * So it is written down here with its evidence, and what is written here is a
 * claim about a model, not a measurement of a clip. `fuse_manifest` measures
 * the clip. Where the two disagree the manifest is right, and the disagreement
 * means a tier has been bound to another model and this table has gone stale.
 *
 * It is worth stating anyway, because it is needed before any clip exists: a
 * customer choosing a tier is also choosing whether they have to go and find a
 * voice and a music track, which is a second budget on a second account.
 */
import type { TierId } from "../domain.ts";

export interface TierAudio {
  /** True when clips from this tier arrive with sound already in them. */
  readonly rendersAudio: boolean;
  /** The model the tier runs on, named so that a stale claim can be spotted. */
  readonly model: string;
  /** Why, in terms a customer can plan around. */
  readonly because: string;
}

const seedance: TierAudio = {
  rendersAudio: true,
  model: "Seedance 2.5",
  because:
    "Seedance renders native audio, and the provider charges the same per second with it on, " +
    "so these clips come back carrying sound that has already been paid for with the picture.",
};

const minimaxOnWaveSpeed: TierAudio = {
  rendersAudio: false,
  model: "MiniMax-H3 (WaveSpeed)",
  because:
    "MiniMax-H3 takes no audio input on WaveSpeed, so the clips come back silent: voice, " +
    "music and effects all have to come from somewhere else.",
};

const minimaxOnFuse: TierAudio = {
  rendersAudio: false,
  model: "MiniMax-H3 (Fuse's own deployment)",
  because:
    "The request Fuse sends its own MiniMax-H3 deployment has no audio field at all, so these " +
    "clips are silent by construction, not by setting.",
};

/**
 * Keyed by every tier id there is. Adding one to TierId stops the type checker
 * here, rather than shipping a tier whose sound nobody stated.
 *
 * The two silent pairs are kept apart on purpose: they are the same model on
 * two different deployments, which is also why this cannot be derived from the
 * quality axis and has to be a table.
 */
const TIER_AUDIO: Readonly<Record<TierId, TierAudio>> = {
  "t2v-low-standard": minimaxOnFuse,
  "t2v-low-high": seedance,
  "t2v-fast-standard": minimaxOnWaveSpeed,
  "t2v-fast-high": seedance,
  "i2v-low-standard": minimaxOnFuse,
  "i2v-low-high": seedance,
  "i2v-fast-standard": minimaxOnWaveSpeed,
  "i2v-fast-high": seedance,
};

export function audioOf(tier: TierId): TierAudio {
  return TIER_AUDIO[tier];
}
