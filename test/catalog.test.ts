/**
 * The catalog is the contract between this package and the Fuse API. These
 * tests exist so a change on the server shows up here, not at a customer.
 *
 * `npm test`         — fixture only, offline.
 * `npm run test:live` — also fetches prod and compares its shape to the fixture.
 *
 * The live check turns itself on from npm's own lifecycle name rather than an
 * env prefix in the script, which only works in a POSIX shell.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { Catalog, CatalogError } from "../src/fuse/catalog.ts";
import { FuseHttp } from "../src/fuse/client.ts";
import type { JobSpec, Resolution } from "../src/domain.ts";

const fixture = JSON.parse(
  readFileSync(fileURLToPath(new URL("./fixtures/pricing-2026-10-26.json", import.meta.url)), "utf8"),
);

// The fixture is the whole response as prod sent it; the transport hands the
// parser the `data` out of that envelope, so the test does the same.
const catalog = Catalog.parse(fixture.data, new Date("2026-10-26T00:00:00Z"));

test("parses every active video tier and nothing else", () => {
  assert.deepEqual(
    catalog.tiers.map((t) => t.id),
    [
      "i2v-fast-high",
      "i2v-fast-standard",
      "i2v-low-high",
      "i2v-low-standard",
      "t2v-fast-high",
      "t2v-fast-standard",
      "t2v-low-high",
      "t2v-low-standard",
    ],
  );
});

test("reads price, resolutions and last-image support off the tier", () => {
  const tier = catalog.tier("t2v-low-standard");
  assert.equal(tier.baseTokens, 20);
  assert.deepEqual(tier.resolutions, [
    { name: "480p", tokensPerSecond: 4 },
    { name: "768p", tokensPerSecond: 12 },
  ]);
  assert.equal(tier.supportsLastImage, false);
  assert.equal(catalog.tier("i2v-fast-standard").supportsLastImage, true);
});

test("derives aspects from the pixel box, and MiniMax H3 has no square", () => {
  // i2v/t2v-low-standard are the MiniMax H3 tiers; the API rejects 1:1 there.
  assert.deepEqual(catalog.tier("t2v-low-standard").aspects, ["16:9", "9:16"]);
  assert.deepEqual(catalog.tier("t2v-fast-standard").aspects, ["16:9", "9:16", "1:1"]);
});

test("a resolution can only be built through the catalog", () => {
  assert.equal(catalog.resolution("t2v-low-standard", "480p"), "480p");
  assert.throws(
    () => catalog.resolution("t2v-low-standard", "1080p"),
    (error: unknown) =>
      error instanceof CatalogError && /does not offer 1080p/.test((error as Error).message),
  );
});

test("estimate matches the charge seen on prod", () => {
  const spec: JobSpec = {
    tier: "t2v-low-standard",
    resolution: catalog.resolution("t2v-low-standard", "480p"),
    aspect: catalog.aspect("t2v-low-standard", "16:9"),
  };
  const estimate = catalog.estimate(spec, [
    { slug: "scene-a", seconds: 5 },
    { slug: "scene-b", seconds: 5 },
    { slug: "scene-c", seconds: 5 },
  ]);
  // base 20 + ceil(5 x 4) = 40 per scene; the real charge was 41 because the
  // provider returned 5.167 s, which is what the note warns about.
  assert.deepEqual(
    estimate.lines.map((l) => l.tokens),
    [40, 40, 40],
  );
  assert.equal(estimate.total, 120);
  assert.match(estimate.note, /slightly longer/);
});

test("rejects a payload that is not a pricing response", () => {
  assert.throws(() => Catalog.parse({}), CatalogError);
  assert.throws(() => Catalog.parse({ services: [] }), CatalogError);
});

test(
  "live pricing still has the shape the fixture recorded",
  {
    skip:
      process.env.FUSE_LIVE || process.env.npm_lifecycle_event === "test:live"
        ? false
        : "run `npm run test:live` to hit prod",
  },
  async () => {
    const live = await Catalog.load(new FuseHttp({ baseUrl: "https://api.fuseai.art" }));
    assert.deepEqual(
      live.tiers.map((t) => t.id),
      catalog.tiers.map((t) => t.id),
      "the set of tiers changed on the server",
    );
    for (const tier of live.tiers) {
      const recorded = catalog.tier(tier.id);
      assert.deepEqual(
        tier.resolutions.map((r) => r.name),
        recorded.resolutions.map((r) => r.name),
        `${tier.id} changed which resolutions it offers`,
      );
    }
  },
);
