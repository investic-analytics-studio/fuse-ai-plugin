/**
 * The public surface: seven tools, and the only place that parses what a model
 * sent us.
 *
 * Shape is checked here with zod; *availability* is not. Whether a tier exists,
 * which resolutions and aspects it offers, how long a clip may be and how many
 * reference images it takes are all the server's to answer, and it answers them
 * in `/pricing` or in its own refusal text. So a tier id, a resolution and an
 * aspect arrive as plain strings and the catalog judges them — that way the
 * error names what is really on offer today instead of what this package was
 * published believing (`per encode-lessons-in-structure`, and the same reason
 * `domain.ts` lets no one build a `Resolution` by hand).
 *
 * What is checked here is what only we can check: that a slug is safe to put in
 * a filename, that two scenes in one call do not share a slug (the lifecycle
 * keys a call's scenes by slug, so a duplicate would silently drop one), and
 * that a budget was stated.
 *
 * Nothing here imports the MCP SDK. A tool is a name, a description, an input
 * shape and a function — `index.ts` is what turns that into a server, and a
 * test can call `run()` directly.
 */
import { basename, dirname, isAbsolute, resolve } from "node:path";
import { z } from "zod";
import { audioOf } from "./fuse/audio.ts";
import { Catalog } from "./fuse/catalog.ts";
import type { OpenClip } from "./fuse/client.ts";
import { JobStore, Lifecycle, type RunsPort } from "./job/lifecycle.ts";
import {
  createProject,
  ensureDeps,
  installFonts,
  writeManifest,
  type ScaffoldDeps,
} from "./project/scaffold.ts";
import { isTierId, type JobSpec, type TierId } from "./domain.ts";
import { DEFAULT_VOICE_MODEL, type VoicePort } from "./voice/elevenlabs.ts";
import { characterCount, narrate } from "./voice/narrate.ts";

export interface ToolDeps {
  /**
   * The catalog. Caching is the caller's business, not a tool's: `index.ts`
   * holds it for a few minutes so five tool calls are not five `/pricing`
   * round trips.
   */
  catalog(): Promise<Catalog>;
  readonly runs: RunsPort;
  readonly openClip: OpenClip;
  readonly scaffold: ScaffoldDeps;
  /**
   * The customer's own ElevenLabs account, when they have set a key for it.
   * Absent is a normal state — the video tools do not need it — so the two
   * voice tools are the only ones that say so, and they say what to set.
   */
  readonly voice?: VoicePort;
  /** Injected so a test knows the id it will get back. */
  newJobId(): string;
}

export interface ToolDefinition {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly inputShape: z.ZodRawShape;
  run(args: unknown): Promise<unknown>;
}

function tool<Shape extends z.ZodRawShape>(def: {
  name: string;
  title: string;
  description: string;
  shape: Shape;
  run: (args: z.output<z.ZodObject<Shape>>) => Promise<unknown>;
}): ToolDefinition {
  const schema = z.object(def.shape);
  return {
    name: def.name,
    title: def.title,
    description: def.description,
    inputShape: def.shape,
    // Async so a parse failure rejects like every other failure. A function
    // that returns a promise but throws synchronously needs two catch sites.
    run: async (args: unknown) => def.run(schema.parse(args)),
  };
}

/* ------------------------------------------------------------------ pieces */

/**
 * A scene's name for the life of the job. It ends up in a filename
 * (`assets/scenes/<slug>-<hash>.mp4`) and in HTML the agent writes, so it is
 * kept to what is safe in both rather than trusted as given.
 */
const slug = z
  .string()
  .regex(
    /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/,
    "a slug is lowercase letters, digits and hyphens, e.g. scene-a",
  )
  .max(48);

const projectDir = z
  .string()
  .min(1)
  .describe("The project directory, absolute or relative to where this server was started.");

const tierId = z
  .string()
  .describe("A tier id from fuse_tiers, e.g. t2v-low-standard.");

const resolutionName = z
  .string()
  .describe("A resolution name offered by that tier, as fuse_tiers lists it, e.g. 480p.");

/** Duration is the server's rule, per tier; it is sent as asked and refused verbatim. */
const seconds = z
  .number()
  .positive()
  .describe("Clip length in seconds. The valid range belongs to the tier; the API states it.");

function tierIdOf(value: string): TierId {
  if (!isTierId(value)) {
    throw new Error(
      `"${value}" is not a tier id. One looks like t2v-low-standard: ` +
        "<t2v|i2v>-<low|fast>-<standard|high>. Call fuse_tiers for the ones on offer.",
    );
  }
  return value;
}

/** Resolved against the server's own working directory, and reported back absolute. */
function dirOf(value: string): string {
  return isAbsolute(value) ? resolve(value) : resolve(process.cwd(), value);
}

function specOf(catalog: Catalog, tier: string, resolution: string, aspect: string): JobSpec {
  const id = tierIdOf(tier);
  return {
    tier: id,
    resolution: catalog.resolution(id, resolution),
    aspect: catalog.aspect(id, aspect),
  };
}

/**
 * The customer's ElevenLabs account, or a refusal that names the one thing
 * they have to do. Voiceover is their account and their invoice, so the key
 * cannot be defaulted, borrowed from Fuse or guessed at.
 */
function voiceOf(deps: ToolDeps): VoicePort {
  if (!deps.voice) {
    throw new Error(
      "No ElevenLabs API key, so there is no voice to speak with. Voiceover runs on the " +
        "customer's own ElevenLabs account: get a key from elevenlabs.io, then re-run this " +
        "package's `install` command with ELEVENLABS_API_KEY set in the environment, and " +
        "restart the client so the server picks it up. Everything else in this package — " +
        "tiers, quotes, clips, the manifest — works without it.",
    );
  }
  return deps.voice;
}

async function jobIn(dir: string): Promise<JobStore> {
  const store = await JobStore.open(dir);
  if (!store) {
    throw new Error(
      `${dir} holds no Fuse job. Call fuse_project_new to create the project first.`,
    );
  }
  return store;
}

/* ------------------------------------------------------------------- tools */

export function createTools(deps: ToolDeps): readonly ToolDefinition[] {
  return [
    tool({
      name: "fuse_tiers",
      title: "List video tiers and their prices",
      description:
        "What Fuse can generate right now, read live from the account's pricing: each tier's " +
        "three axes (mode, priority, quality), its token price, the resolutions it offers with " +
        "the per-second rate for each, its aspect ratios, and whether it accepts a last frame. " +
        "Nothing in this package hardcodes these — call this before quoting or creating a " +
        "project.\n\n" +
        "audio says what the clip's own soundtrack will be, which pricing cannot carry because " +
        "audio is free wherever a tier has it and pricing carries prices. audio.sound is how " +
        "firmly it is known: always (Fuse asks for it), observed (Fuse asks for nothing, the " +
        "provider's default has so far returned sound) or unknown (nothing asked, nothing " +
        "measured).\n\n" +
        "None of that is the voice-over. A video model invents speech that reads nobody's " +
        "script and can be a different person in every scene, so the narration always comes " +
        "from fuse_narration or the customer's own file, on every tier. Tell them while the " +
        "tier is being chosen: the voice is a second budget on a second account whatever they " +
        "pick, and a tier that arrives with sound adds a track to mute rather than one to " +
        "save. It is a claim about a model, not a measurement: fuse_manifest measures the " +
        "clips themselves, and where the two disagree the manifest is right.",
      shape: {},
      run: async () => {
        const catalog = await deps.catalog();
        return {
          tiers: catalog.tiers.map((tier) => ({ ...tier, audio: audioOf(tier.id) })),
          asOf: catalog.asOf.toISOString(),
        };
      },
    }),

    tool({
      name: "fuse_quote",
      title: "Price scenes before spending anything",
      description:
        "Token cost of a set of scenes on one tier, without creating or charging anything. " +
        "The total is a floor: the ledger charges on the clip the provider returns, which can " +
        "run slightly longer than the duration asked for. Use it to agree a budget with the " +
        "user, then pass that budget as fuse_scenes' maxTokens.",
      shape: {
        tier: tierId,
        resolution: resolutionName,
        scenes: z
          .array(z.object({ slug, seconds }))
          .min(1)
          .describe("The scenes to price. Prompts are not needed for a quote."),
      },
      run: async ({ tier, resolution, scenes }) => {
        const catalog = await deps.catalog();
        const id = tierIdOf(tier);
        const estimate = catalog.estimate(
          { tier: id, resolution: catalog.resolution(id, resolution) },
          scenes,
        );
        return { tier: id, resolution, ...estimate };
      },
    }),

    tool({
      name: "fuse_project_new",
      title: "Create a HyperFrames project bound to one tier",
      description:
        "Creates a video project on this machine: HyperFrames' own scaffold (its config, its " +
        "skills, its CLAUDE.md), a place for the clips, and Noto Sans Thai as local files so " +
        "Thai captions render instead of turning into tofu boxes. The tier, resolution and " +
        "aspect are fixed here for the whole job, which is why fuse_scenes does not take them " +
        "again. It does NOT report a canvas size: the real pixel box differs between providers " +
        "serving the same nominal resolution, so it is measured from the clips by fuse_manifest " +
        "once they exist.\n\n" +
        "The first call on a machine that has never rendered fetches HyperFrames and a browser, " +
        "which can take longer than the client allows one tool call. That is harmless and the " +
        "work is kept: call it again with the same arguments and it carries on from the scaffold " +
        "it left. It will refuse to re-bind an existing project to a different tier.",
      shape: {
        dir: projectDir,
        tier: tierId,
        resolution: resolutionName,
        aspect: z
          .string()
          .describe("An aspect ratio the tier offers, as fuse_tiers lists it, e.g. 16:9."),
        fonts: z
          .boolean()
          .default(true)
          .describe("Fetch Noto Sans Thai into the project. Turn off only for a Latin-only ad."),
      },
      run: async ({ dir, tier, resolution, aspect, fonts }) => {
        const catalog = await deps.catalog();
        const spec = specOf(catalog, tier, resolution, aspect);
        const path = dirOf(dir);

        const existing = await JobStore.open(path);
        if (existing) {
          const bound = existing.job.spec;
          if (
            bound.tier !== spec.tier ||
            bound.resolution !== spec.resolution ||
            bound.aspect !== spec.aspect
          ) {
            throw new Error(
              `${path} already holds a job bound to ${bound.tier} at ${bound.resolution} ` +
                `${bound.aspect}, and ${existing.job.spent} tokens have been spent on it. ` +
                "Use a new directory for a different tier, resolution or aspect.",
            );
          }
          return {
            dir: path,
            job: existing.job.id,
            reused: true,
            spec: bound,
            spent: existing.job.spent,
            next: "Call fuse_scenes with this dir to add or continue scenes.",
          };
        }

        const project = await createProject(dirname(path), basename(path), deps.scaffold);
        const warnings: string[] = [];
        let fontFiles: readonly string[] = [];
        if (fonts) {
          const report = await installFonts(project.dir, deps.scaffold);
          fontFiles = report.files;
          if (report.warning) warnings.push(report.warning);
        }
        const machine = await ensureDeps(project.dir, deps.scaffold);
        if (!machine.ok) warnings.push(...machine.problems);
        const store = await JobStore.start(project.dir, deps.newJobId(), spec);

        return {
          dir: project.dir,
          job: store.job.id,
          reused: false,
          spec,
          fonts: fontFiles,
          hyperframesReady: machine.ok,
          doctor: machine.doctor,
          warnings,
          next:
            "Call fuse_scenes with this dir, a maxTokens budget and the scene prompts. " +
            "Write the composition only after fuse_manifest reports the measured canvas.",
        };
      },
    }),

    tool({
      name: "fuse_scenes",
      title: "Generate the scenes' clips, resumably",
      description:
        "Generates every named scene and downloads the clips into the project. This is the only " +
        "tool that spends tokens, and maxTokens is the ceiling for the whole project, including " +
        "what it has already spent: if the scenes would go over it, nothing is submitted and " +
        "nothing is charged.\n\n" +
        "It blocks for up to waitMs (45 s by default, because a client commonly cuts a tool " +
        "call off at 60 s) and then reports what is done. Call it " +
        "again with the same arguments to keep waiting — a scene that was already paid for is " +
        "never submitted twice, so re-calling costs nothing and resumes after a crash, a new " +
        "session or a top-up. Renaming a scene's slug does not re-charge it either; editing its " +
        "prompt or duration does, because that is a different clip.\n\n" +
        "A stopped field says why it gave up early (insufficient_tokens, over_budget, " +
        "rejected_by_api, provider_failed) and detail carries the server's own words — read " +
        "them, they hold the real rule, such as the duration range for the tier.",
      shape: {
        dir: projectDir,
        maxTokens: z
          .number()
          .int()
          .positive()
          .describe(
            "Token ceiling for this project in total, already-spent included. Required: agree it " +
              "with the user from fuse_quote.",
          ),
        scenes: z
          .array(
            z.object({
              slug,
              prompt: z.string().min(1).describe("What the clip should show."),
              seconds,
              imageUrls: z
                .array(z.string().url())
                .optional()
                .describe(
                  "Reference images for an image-to-video tier, as public URLs the API can " +
                    "fetch. How many are allowed is the tier's rule.",
                ),
              lastImageUrl: z
                .string()
                .url()
                .optional()
                .describe("The frame to end on, where the tier supports one."),
            }),
          )
          .min(1)
          .refine(
            (list) => new Set(list.map((scene) => scene.slug)).size === list.length,
            "two scenes in one call cannot share a slug",
          ),
        waitMs: z
          .number()
          .int()
          .min(1_000)
          .max(600_000)
          .optional()
          .describe(
            "How long to wait before reporting partial progress. Keep it under the client's " +
              "own tool-call timeout, which is 60 s unless the client raises it: a longer " +
              "block does not report progress, it fails. Calling again waits on, for free.",
          ),
      },
      run: async ({ dir, maxTokens, scenes, waitMs }) => {
        const path = dirOf(dir);
        const store = await jobIn(path);
        const catalog = await deps.catalog();
        const lifecycle = new Lifecycle(store, {
          runs: deps.runs,
          catalog,
          openClip: deps.openClip,
        });
        const view = await lifecycle.advance(scenes, {
          budget: { maxTokens, alreadySpent: store.job.spent },
          waitMs,
        });
        return {
          dir: path,
          ...view,
          next:
            view.done === view.total
              ? "Call fuse_manifest to measure the clips before writing the composition."
              : "Call fuse_scenes again with the same arguments to keep waiting; it will not re-charge.",
        };
      },
    }),

    tool({
      name: "fuse_manifest",
      title: "Measure the clips and report the canvas, rate and sound to compose on",
      description:
        "Reads every downloaded clip with ffprobe and writes assets/scenes/manifest.json: the " +
        "canvas to compose on, each clip's real duration, the frame rate the clips carry and " +
        "whether they came back with sound. All of it has to be measured. The same " +
        "nominal 480p 16:9 came back as 864x480 from one provider and 832x480 from another, and " +
        "a 5 second ask came back as 5.167 s — so use this canvas for the composition's " +
        "data-width/data-height, its CSS box and its viewport, and these durations for the " +
        "timing. A guessed canvas upscales the footage and multiplies render time.\n\n" +
        "fps goes on the root as data-fps: HyperFrames renders at 30 unless told otherwise, so " +
        "24 fps footage left alone is delivered with a duplicate of every fifth frame. When fps " +
        "is absent nothing reported a rate — say so rather than picking one.\n\n" +
        "hasAudio is what the provider returned, not what the tier promises, and it is the " +
        "measurement that settles any disagreement with fuse_tiers. When it is true the clip " +
        "carries a soundtrack nobody wrote: keep it on the <video> (data-has-audio, no muted) " +
        "only where it works as atmosphere under the piece. Where the scene has narration, or " +
        "the model is audibly speaking, mute it — model speech reads nobody's script and " +
        "changes voice between scenes.",
      shape: { dir: projectDir },
      run: async ({ dir }) => {
        const path = dirOf(dir);
        const store = await jobIn(path);
        const manifest = await writeManifest(path, store.job, deps.scaffold);
        return {
          dir: path,
          file: "assets/scenes/manifest.json",
          ...manifest,
          next: "Write the composition with HyperFrames' own skills, then run its check and render.",
        };
      },
    }),

    tool({
      name: "fuse_voices",
      title: "List the voices on the customer's ElevenLabs account",
      description:
        "The voices this ElevenLabs account can speak with, the text-to-speech models it may " +
        "use and the languages each one covers, and how many characters are left this period. " +
        "Costs nothing.\n\n" +
        "Voiceover runs on the customer's own ElevenLabs account, never on Fuse: these " +
        "characters are billed by ElevenLabs and no Fuse token is involved. Show the list and " +
        "let the user pick — a voice is the ad's presenter, so it is their choice to make, not " +
        "one to default. Pass the id they choose to fuse_narration.\n\n" +
        "Check that the model you intend to use lists the script's language: a model that does " +
        "not speak Thai will mispronounce a Thai script and charge for it all the same.",
      shape: {
        search: z
          .string()
          .min(1)
          .optional()
          .describe(
            "Narrow the list by name, description, label or category. Useful on an account " +
              "with more voices than one page holds.",
          ),
      },
      run: async ({ search }) => {
        const voice = voiceOf(deps);
        const [listing, models, quota] = await Promise.all([
          voice.voices(search),
          voice.models(),
          voice.quota(),
        ]);
        return {
          voices: listing.voices,
          hasMore: listing.hasMore,
          models,
          quota,
          defaultModel: DEFAULT_VOICE_MODEL,
          next:
            "Ask the user which voice to use, then call fuse_narration with that voiceId and " +
            "dryRun true to price the script before spending anything.",
        };
      },
    }),

    tool({
      name: "fuse_narration",
      title: "Speak the script into the project as voiceover files",
      description:
        "Writes one mp3 per line into assets/audio/ in the voice the user chose, and reports " +
        "each file's measured duration so the picture can be timed to the voice.\n\n" +
        "This spends the customer's ElevenLabs character allowance, not Fuse tokens. Call it " +
        "first with dryRun true: that prices every line, spends nothing and touches nothing, " +
        "and the figure it reports is the one to agree with the user. maxCharacters is then the " +
        "ceiling for the real call — if the lines would go over it, nothing is spoken and " +
        "nothing is charged.\n\n" +
        "Safe to call again. A line whose exact words were already spoken in the same voice is " +
        "reused from disk for free, so a call cut off by a timeout carries on instead of paying " +
        "for the script twice. Renaming a scene is free; editing a word is new audio, because " +
        "it is. Two scenes that say the same thing share one file.\n\n" +
        "A stopped field says why it gave up early (over_budget, quota_exhausted, " +
        "rejected_by_api, provider_failed) and detail carries ElevenLabs' own words.",
      shape: {
        dir: projectDir,
        voiceId: z
          .string()
          .min(1)
          .describe("A voice id from fuse_voices — the one the user picked, not a default."),
        modelId: z
          .string()
          .min(1)
          .optional()
          .describe(
            `A model id from fuse_voices. Defaults to ${DEFAULT_VOICE_MODEL}, which speaks Thai.`,
          ),
        maxCharacters: z
          .number()
          .int()
          .positive()
          .describe(
            "Character ceiling for this call. Required: get the figure from a dryRun call and " +
              "agree it with the user, the same way maxTokens is agreed for the clips.",
          ),
        dryRun: z
          .boolean()
          .default(false)
          .describe("Price the script and speak none of it. Nothing is charged or written."),
        lines: z
          .array(
            z.object({
              slug,
              text: z
                .string()
                .min(1)
                .describe("Exactly what is said in this scene. Punctuation shapes the delivery."),
            }),
          )
          .min(1)
          .refine(
            (list) => new Set(list.map((line) => line.slug)).size === list.length,
            "two lines in one call cannot share a slug",
          ),
      },
      run: async ({ dir, voiceId, modelId, maxCharacters, dryRun, lines }) => {
        // The key is checked before the directory: it is the precondition of
        // this tool existing usefully at all, costs nothing to check, and is
        // the one a customer has to go and fix somewhere else.
        const voice = voiceOf(deps);
        const path = dirOf(dir);
        // The voiceover belongs beside the clips it is mixed with, so it goes
        // only into a directory that is already a project of ours.
        await jobIn(path);
        const report = await narrate(
          path,
          lines,
          { voiceId, modelId, maxCharacters, dryRun },
          { voice, probeDuration: deps.scaffold.probeDuration },
        );
        return {
          dir: path,
          ...report,
          longestLine: Math.max(...lines.map((line) => characterCount(line.text))),
          next: report.dryRun
            ? `Agree ${report.charactersToSpend} characters with the user, then call this again ` +
              "with dryRun false and maxCharacters set to that figure."
            : report.stopped
              ? "Read detail: it holds ElevenLabs' own reason. Nothing further was spoken."
              : "Place each file in the composition against its scene, then render. On a tier " +
                "that renders its own audio, mute the model's voice rather than layering this " +
                "over it.",
        };
      },
    }),
  ];
}
