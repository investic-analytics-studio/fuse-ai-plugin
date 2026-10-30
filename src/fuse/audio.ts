/**
 * What arrives in the clip's own soundtrack, and how sure we are of it.
 *
 * Every other tier fact in this package is read from `GET /v1/api/pricing`,
 * because the CRM edits those and a local copy would drift. This one has no
 * row to read: pricing carries prices, and audio is free wherever it exists.
 *
 * Two things this table is NOT, both learned the hard way on 2026-10-30:
 *
 * 1. It is not a narration plan. The speech a video model invents is a
 *    different voice in every scene and reads nothing anyone wrote, so the
 *    voice-over always comes from `fuse_narration` (the customer's own
 *    ElevenLabs account) or from their own file. A tier that arrives with
 *    sound saves nobody the voice budget; it adds a track to deal with.
 *
 * 2. It is not a reading of the server's `GenerateAudio` field
 *    (`internal/core/domain/projects/wavespeed_models.go`). Nil there means
 *    "Fuse does not send the input", which is not the same as "the clip comes
 *    back silent" — the provider's default decides, and three measured
 *    MiniMax-H3 clips came back with real, scene-specific audio (mean -25.4,
 *    -14.0 and -14.1 dB) on a tier this table once called silent.
 *
 * So each tier says how firmly its sound is known, and `fuse_manifest` still
 * measures the clip that actually arrived. The manifest wins on disagreement.
 */
import type { TierId } from "../domain.ts";

/**
 * How sure the claim is, which matters more than the yes/no:
 * - `always`   Fuse sends the input and the model renders it. Ours to rely on.
 * - `observed` Fuse sends nothing; the provider's default decides, and the
 *              clips measured so far came back with sound. It can change
 *              under us without a deploy on our side.
 * - `unknown`  Nothing is sent and no clip has been measured.
 */
export type TierSound = "always" | "observed" | "unknown";

export interface TierAudio {
  /** How firmly this tier's own soundtrack is known. */
  readonly sound: TierSound;
  /** The model the tier runs on, named so that a stale claim can be spotted. */
  readonly model: string;
  /** Why, in terms a customer can plan around. */
  readonly because: string;
}

const seedance: TierAudio = {
  sound: "always",
  model: "Seedance 2.5",
  because:
    "Fuse sends generate_audio on for these tiers and the provider charges the same per second " +
    "either way, so the clips arrive with a soundtrack of their own. It is atmosphere, not a " +
    "read of anyone's script: plan the voice-over separately and expect to mute what you do " +
    "not want under it.",
};

const minimaxOnWaveSpeed: TierAudio = {
  sound: "observed",
  model: "MiniMax-H3 (WaveSpeed)",
  because:
    "Fuse sends no audio input here, so WaveSpeed's own default decides. Every clip measured " +
    "so far (three, 2026-10-01) came back with real audio, so plan for a track arriving — but " +
    "it is the provider's choice, not ours, and it can change without warning.",
};

const minimaxOnFuse: TierAudio = {
  sound: "unknown",
  model: "MiniMax-H3 (Fuse's own deployment)",
  because:
    "The request Fuse sends its own MiniMax-H3 deployment has no audio field, and no clip from " +
    "it has been measured. Treat the soundtrack as unknown until fuse_manifest reports on a " +
    "real clip.",
};

/**
 * Keyed by every tier id there is. Adding one to TierId stops the type checker
 * here, rather than shipping a tier whose sound nobody stated.
 *
 * The two MiniMax rows are kept apart on purpose: they are the same model on
 * two deployments and are known to two different degrees, which is also why
 * this cannot be derived from the quality axis and has to be a table.
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
