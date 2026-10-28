/**
 * Not run; type-checked by `test/types.test.ts` with its own tsconfig.
 *
 * The design's central claim is that a Resolution can only come from the
 * catalog, so a hardcoded one cannot reach the API. That claim is a type, and
 * a type nobody checks is a comment. Exactly one line below must be refused,
 * the marked one, and every other line must compile.
 */
import type { JobSpec } from "../../../src/domain.ts";
import { Catalog } from "../../../src/fuse/catalog.ts";

export function fromCatalog(catalog: Catalog): JobSpec {
  return {
    tier: "t2v-low-standard",
    resolution: catalog.resolution("t2v-low-standard", "480p"),
    aspect: catalog.aspect("t2v-low-standard", "16:9"),
  };
}

export function hardcoded(catalog: Catalog): JobSpec {
  return {
    tier: "t2v-low-standard",
    resolution: "480p", // EXPECT_ERROR: a string the catalog never handed out
    aspect: catalog.aspect("t2v-low-standard", "16:9"),
  };
}
