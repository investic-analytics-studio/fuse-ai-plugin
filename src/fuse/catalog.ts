/**
 * Tier capability and price, parsed from `GET /v1/api/pricing`.
 *
 * That endpoint is public (no auth) and is the single source of truth for what
 * a tier accepts: nothing in this package may hardcode a resolution, an aspect
 * or a price, because the CRM changes them and a local copy would drift.
 *
 * What pricing does NOT carry: the per-tier duration range and the reference
 * image/audio limits. Those stay with the server, which rejects a bad request
 * with a message written for callers ("duration must be between 5 and 10 …").
 * We pass that text through instead of keeping a second copy of the rule.
 */
import {
  type Aspect,
  type Estimate,
  type JobSpec,
  type Quality,
  type Priority,
  type Resolution,
  type SceneSpec,
  type Tier,
  type TierId,
  isTierId,
  modeOf,
} from "../domain.ts";
import { type Transport, pricing } from "./client.ts";

/** Wire shapes stay private to this module. */
interface WireOption {
  category: string;
  option_value: string;
  additional_cost: number;
  is_active: boolean;
}

interface WireService {
  service_name: string;
  base_token_cost: number;
  is_active: boolean;
  options?: WireOption[];
}

/** The `data` of the pricing response; the transport unwraps the envelope. */
interface WirePricing {
  services?: WireService[];
}

export class CatalogError extends Error {}

const RESOLUTION_CATEGORY = "resolution_per_sec";
const ASPECT_CATEGORY = "aspect_ratio";
const LAST_IMAGE_CATEGORY = "last_image";

/** `1280:720` -> `16:9`. Derived from the box, so new sizes keep working. */
function aspectOf(optionValue: string): Aspect | undefined {
  const [w, h] = optionValue.split(":").map((n) => Number.parseInt(n, 10));
  // A value with no colon leaves `h` undefined; say so rather than leaning on
  // `Number.isFinite(undefined)` being false, which the type checker cannot see.
  if (w === undefined || h === undefined) return undefined;
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return undefined;
  if (w === h) return "1:1";
  return w > h ? "16:9" : "9:16";
}

function tierFrom(service: WireService): Tier | undefined {
  const id = service.service_name;
  if (!isTierId(id)) return undefined;
  const [, , priority, quality] = /^(t2v|i2v)-(low|fast)-(standard|high)$/.exec(id)!;
  const options = (service.options ?? []).filter((o) => o.is_active);

  const resolutions = options
    .filter((o) => o.category === RESOLUTION_CATEGORY)
    .map((o) => ({ name: o.option_value as Resolution, tokensPerSecond: o.additional_cost }))
    .sort((a, b) => a.tokensPerSecond - b.tokensPerSecond);

  const aspects = [
    ...new Set(
      options
        .filter((o) => o.category === ASPECT_CATEGORY)
        .map((o) => aspectOf(o.option_value))
        .filter((a): a is Aspect => a !== undefined),
    ),
  ];

  const supportsLastImage = options.some(
    (o) => o.category === LAST_IMAGE_CATEGORY && o.option_value === "true",
  );

  if (resolutions.length === 0) return undefined;

  return {
    id,
    mode: modeOf(id),
    priority: priority as Priority,
    quality: quality as Quality,
    baseTokens: service.base_token_cost,
    resolutions,
    aspects,
    supportsLastImage,
  };
}

export class Catalog {
  readonly tiers: readonly Tier[];
  readonly asOf: Date;

  private constructor(tiers: readonly Tier[], asOf: Date) {
    this.tiers = tiers;
    this.asOf = asOf;
  }

  /** Parses the pricing data. Inactive services and non-tier rows are dropped. */
  static parse(payload: unknown, asOf = new Date()): Catalog {
    const services = (payload as WirePricing)?.services;
    if (!Array.isArray(services)) {
      throw new CatalogError("pricing data has no services array");
    }
    const tiers = services
      .filter((s) => s.is_active)
      .map(tierFrom)
      .filter((t): t is Tier => t !== undefined)
      .sort((a, b) => a.id.localeCompare(b.id));
    if (tiers.length === 0) {
      throw new CatalogError("pricing response carried no active video tiers");
    }
    return new Catalog(tiers, asOf);
  }

  /** Goes through the transport so auth, timeouts and errors stay in one place. */
  static async load(http: Transport): Promise<Catalog> {
    return Catalog.parse(await pricing(http));
  }

  tier(id: TierId): Tier {
    const found = this.tiers.find((t) => t.id === id);
    if (!found) {
      throw new CatalogError(
        `tier ${id} is not available; current tiers: ${this.tiers.map((t) => t.id).join(", ")}`,
      );
    }
    return found;
  }

  /** The only way to make a Resolution. Rejects what the tier does not offer. */
  resolution(id: TierId, name: string): Resolution {
    const tier = this.tier(id);
    const found = tier.resolutions.find((r) => r.name === name);
    if (!found) {
      throw new CatalogError(
        `${id} does not offer ${name}; it offers ${tier.resolutions.map((r) => r.name).join(", ")}`,
      );
    }
    return found.name;
  }

  aspect(id: TierId, name: string): Aspect {
    const tier = this.tier(id);
    const found = tier.aspects.find((a) => a === name);
    if (!found) {
      throw new CatalogError(
        `${id} does not offer aspect ${name}; it offers ${tier.aspects.join(", ")}`,
      );
    }
    return found;
  }

  /**
   * base + ceil(seconds × tokensPerSecond) per scene.
   *
   * Checked against a real charge: t2v-low-standard at 480p for 5 s cost 41
   * tokens, which is base 20 + ceil(5.167 × 4) — the provider returned 5.167 s
   * for the 5 s that was asked for. So this number is the floor, and the note
   * says so rather than pretending otherwise.
   *
   * It takes only the fields a price depends on, so a quote need not invent an
   * aspect or a prompt that has not been written yet.
   */
  estimate(
    spec: Pick<JobSpec, "tier" | "resolution">,
    scenes: readonly Pick<SceneSpec, "slug" | "seconds">[],
  ): Estimate {
    const tier = this.tier(spec.tier);
    const perSecond = tier.resolutions.find((r) => r.name === spec.resolution);
    if (!perSecond) {
      throw new CatalogError(`${spec.tier} does not offer ${spec.resolution}`);
    }
    const lines = scenes.map((scene) => ({
      slug: scene.slug,
      tokens: tier.baseTokens + Math.ceil(scene.seconds * perSecond.tokensPerSecond),
    }));
    return {
      lines,
      total: lines.reduce((sum, line) => sum + line.tokens, 0),
      note:
        "Estimate. The ledger charges on the clip the provider returns, which can run " +
        "slightly longer than the duration asked for, so the real total can be a few tokens higher.",
    };
  }
}
