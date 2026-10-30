/**
 * The audio table is the one tier fact this package states on its own, which
 * makes it the one that can go stale without anything failing. These tests
 * hold it to what keeps it honest: every tier says whether its clips have
 * sound, every answer names the model it came from, and the mapping is the one
 * the server's model table had when this was written (2026-10-30).
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { audioOf } from "../src/fuse/audio.ts";
import { isTierId, type TierId } from "../src/domain.ts";

/** Every tier id there is, built from the axes rather than listed by hand. */
const ALL_TIERS: readonly TierId[] = (["t2v", "i2v"] as const).flatMap((mode) =>
  (["low", "fast"] as const).flatMap((priority) =>
    (["standard", "high"] as const).map((quality) => {
      const id = `${mode}-${priority}-${quality}`;
      // Narrowed through the same guard the tools use, so these ids are tier
      // ids for the same reason a caller's string would be.
      if (!isTierId(id)) throw new Error(`${id} is not a tier id`);
      return id;
    }),
  ),
);

test("every tier states whether its clips come back with sound", () => {
  assert.equal(ALL_TIERS.length, 8);
  for (const tier of ALL_TIERS) {
    const audio = audioOf(tier);
    assert.equal(typeof audio.rendersAudio, "boolean", `${tier} does not state its sound`);
    assert.ok(audio.model.length > 0, `${tier} does not name the model it runs on`);
    assert.ok(audio.because.length > 0, `${tier} states its sound without saying why`);
  }
});

test("the four Seedance tiers are the ones whose clips arrive with sound", () => {
  const withSound = ALL_TIERS.filter((tier) => audioOf(tier).rendersAudio);
  assert.deepEqual(withSound, ["t2v-low-high", "t2v-fast-high", "i2v-low-high", "i2v-fast-high"]);
  for (const tier of withSound) {
    assert.match(audioOf(tier).model, /Seedance/, `${tier} claims sound without naming Seedance`);
  }
});

test("a silent tier names MiniMax-H3, so a rebinding is visible rather than quiet", () => {
  const silent = ALL_TIERS.filter((tier) => !audioOf(tier).rendersAudio);
  assert.deepEqual(silent, [
    "t2v-low-standard",
    "t2v-fast-standard",
    "i2v-low-standard",
    "i2v-fast-standard",
  ]);
  for (const tier of silent) {
    assert.match(audioOf(tier).model, /MiniMax-H3/, `${tier} is silent for an unnamed reason`);
  }
});

/**
 * The same model on two deployments, and only one of them is a WaveSpeed
 * setting. This is why the table cannot be replaced by "standard means
 * silent": the two halves are silent for different reasons, and the day one of
 * them changes it will change on its own.
 */
test("the two silent pairs are told apart by their deployment", () => {
  assert.notEqual(audioOf("t2v-low-standard").model, audioOf("t2v-fast-standard").model);
  assert.equal(audioOf("t2v-low-standard").model, audioOf("i2v-low-standard").model);
  assert.equal(audioOf("t2v-fast-standard").model, audioOf("i2v-fast-standard").model);
});
