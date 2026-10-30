/**
 * The audio table is the one tier fact this package states on its own, which
 * makes it the one that can go stale without anything failing.
 *
 * It got that wrong once already: it read the server's unsent generate_audio
 * input as "the clip comes back silent" and shipped it, while three measured
 * MiniMax-H3 clips on disk had audible, scene-specific sound. So these tests
 * hold it to stating a confidence rather than a yes/no, and to never implying
 * that a tier's own soundtrack stands in for narration.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { audioOf, type TierSound } from "../src/fuse/audio.ts";
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

const SOUNDS: readonly TierSound[] = ["always", "observed", "unknown"];

test("every tier states how firmly its sound is known, and on which model", () => {
  assert.equal(ALL_TIERS.length, 8);
  for (const tier of ALL_TIERS) {
    const audio = audioOf(tier);
    assert.ok(SOUNDS.includes(audio.sound), `${tier} states ${audio.sound}, which is not a state`);
    assert.ok(audio.model.length > 0, `${tier} does not name the model it runs on`);
    assert.ok(audio.because.length > 0, `${tier} states its sound without saying why`);
  }
});

test("only the tiers Fuse actually asks for audio on may claim it always arrives", () => {
  // "always" is the only state the package controls: it is true because the
  // server sends generate_audio, and Seedance is the model that takes it.
  const always = ALL_TIERS.filter((tier) => audioOf(tier).sound === "always");
  assert.deepEqual(always, ["t2v-low-high", "t2v-fast-high", "i2v-low-high", "i2v-fast-high"]);
  for (const tier of always) {
    assert.match(audioOf(tier).model, /Seedance/, `${tier} claims sound without naming Seedance`);
  }
});

/**
 * The tiers Fuse sends no audio input for must not be stated as a fact in
 * either direction. Claiming them silent is what went wrong before; claiming
 * them loud would be the same mistake pointing the other way.
 */
test("a tier Fuse does not ask audio for is never stated as a certainty", () => {
  for (const tier of ALL_TIERS) {
    const audio = audioOf(tier);
    if (audio.sound === "always") continue;
    assert.match(audio.model, /MiniMax-H3/, `${tier} is uncertain for an unnamed reason`);
    assert.notEqual(audio.sound, "always");
  }
  assert.equal(audioOf("t2v-fast-standard").sound, "observed");
  assert.equal(audioOf("i2v-fast-standard").sound, "observed");
  assert.equal(audioOf("t2v-low-standard").sound, "unknown");
  assert.equal(audioOf("i2v-low-standard").sound, "unknown");
});

/**
 * The same model on two deployments, known to two different degrees. This is
 * why the table cannot be replaced by "standard means silent": the two halves
 * differ, and the day one of them changes it will change on its own.
 */
test("the two MiniMax pairs are told apart by their deployment", () => {
  assert.notEqual(audioOf("t2v-low-standard").model, audioOf("t2v-fast-standard").model);
  assert.equal(audioOf("t2v-low-standard").model, audioOf("i2v-low-standard").model);
  assert.equal(audioOf("t2v-fast-standard").model, audioOf("i2v-fast-standard").model);
  assert.notEqual(audioOf("t2v-low-standard").sound, audioOf("t2v-fast-standard").sound);
});

/**
 * The reason this field exists is to be read out while a tier is being
 * chosen, and the thing most easily misread from it is that a tier with sound
 * saves the voice budget. No tier does, so no answer may suggest it.
 */
test("no tier offers its own soundtrack as the narration", () => {
  for (const tier of ALL_TIERS) {
    const because = audioOf(tier).because.toLowerCase();
    for (const word of ["narration", "voice-over", "voiceover"]) {
      assert.ok(
        !because.includes(`${word} is included`) && !because.includes(`no ${word} needed`),
        `${tier} offers its own audio as ${word}`,
      );
    }
  }
  // The tiers that do arrive with sound have to say what it is good for, so
  // the plan treats it as atmosphere and not as somebody reading the script.
  assert.match(audioOf("t2v-fast-high").because, /atmosphere/);
});
