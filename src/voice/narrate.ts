/**
 * Turns a script into voiceover files in the project, and spends as little of
 * the customer's ElevenLabs allowance as it can.
 *
 * One idea carries the file, the same one as `job/lifecycle.ts`: **a line is
 * paid for once.** A line's identity is the hash of what would be sent — voice,
 * model, format and the text itself — and that hash is in the filename. So the
 * file on disk *is* the receipt: finding `*-<hash>.mp3` means those characters
 * were already spent, whatever the scene is called now. Renaming a scene costs
 * nothing; changing a word really is new audio, and two scenes that say exactly
 * the same thing in the same voice share one file instead of paying twice.
 *
 * Unlike a video run there is no id to write down first. ElevenLabs charges and
 * returns the audio in one response, so the narrow window between the charge
 * and the file landing on disk cannot be closed, only kept small: the bytes go
 * to a `.part` file and are renamed into place, and nothing else is attempted
 * in between. A process killed inside that window pays for one line twice.
 *
 * Nothing in here spends a Fuse token. The quota it checks and the characters
 * it reports belong to the customer's own ElevenLabs account.
 */
import { createHash } from "node:crypto";
import { mkdir, readdir, rename, writeFile } from "node:fs/promises";
import { join, posix } from "node:path";
import {
  DEFAULT_VOICE_MODEL,
  VOICE_OUTPUT_FORMAT,
  VoiceError,
  type VoicePort,
} from "./elevenlabs.ts";
import type { ProbeDuration } from "../project/scaffold.ts";

const AUDIO_DIR = posix.join("assets", "audio");

/** One line of the script: which scene it belongs to, and what is said. */
export interface NarrationLine {
  readonly slug: string;
  readonly text: string;
}

export type NarrationState =
  | "spoken" // synthesised in this call; characters were spent
  | "reused" // the same words in the same voice were already on disk
  | "planned"; // never reached, because the call stopped before it

export interface NarrationRecord {
  readonly slug: string;
  readonly hash: string;
  readonly state: NarrationState;
  /** Characters this line costs, counted the way ElevenLabs bills them. */
  readonly characters: number;
  /** Relative to the project dir, never a URL. */
  readonly file?: string;
  /** Measured from the mp3, so a composition can time the picture to the voice. */
  readonly seconds?: number;
  readonly lastError?: string;
}

export type NarrationStop =
  | "over_budget"
  | "quota_exhausted"
  | "rejected_by_api"
  | "provider_failed";

export interface NarrationReport {
  readonly voiceId: string;
  readonly modelId: string;
  readonly lines: readonly NarrationRecord[];
  /** What the lines not yet on disk cost: the figure to agree with the user. */
  readonly charactersToSpend: number;
  /** Characters this call actually spent on the customer's account. */
  readonly charactersSpent: number;
  /** Characters a file on disk saved — what re-running would have cost again. */
  readonly charactersReused: number;
  /** Set when nothing was spoken because the caller only asked for the price. */
  readonly dryRun?: boolean;
  readonly stopped?: NarrationStop;
  /** ElevenLabs' own words when it refused. Never re-worded. */
  readonly detail?: string;
}

export interface NarrateDeps {
  readonly voice: VoicePort;
  /**
   * Measures the written mp3. Optional: without ffprobe the audio is still
   * correct, and HyperFrames can measure it later — a missing duration is a
   * missing convenience, not a failure worth throwing away paid-for audio over.
   */
  readonly probeDuration?: ProbeDuration;
}

export interface NarrateOptions {
  readonly voiceId: string;
  readonly modelId?: string;
  /**
   * Ceiling on the characters this call may spend. Required, for the same
   * reason `fuse_scenes` requires maxTokens: every path that spends someone's
   * money states the limit out loud.
   */
  readonly maxCharacters: number;
  /** Price the script and speak none of it. Costs nothing and touches nothing. */
  readonly dryRun?: boolean;
}

/**
 * How ElevenLabs bills: per character of the text sent. Counted in code points
 * rather than UTF-16 units or bytes, because Thai is three bytes per character
 * and counting bytes would quote three times the real cost.
 */
export function characterCount(text: string): number {
  return [...text].length;
}

/**
 * The hash that decides whether two asks are the same audio. The slug is left
 * out deliberately: renaming a scene must not make the account pay again.
 */
export function lineHash(voiceId: string, modelId: string, text: string): string {
  const canonical = JSON.stringify([voiceId, modelId, VOICE_OUTPUT_FORMAT, text]);
  return createHash("sha256").update(canonical).digest("hex");
}

/**
 * How much of the hash goes in the filename.
 *
 * Longer than it looks necessary, and the length is the point: with no state
 * file, the name on disk is the whole identity of a paid-for line. Two
 * different scripts whose hashes agree on the first 8 hex digits would make one
 * scene silently play the other's voiceover — rare, invisible, and in the
 * finished ad. 16 digits is 64 bits, which puts that past worrying about, and
 * the slug in front of it is what keeps the name readable.
 */
const HASH_IN_NAME = 16;

/** The part of a line's hash that identifies it on disk. */
function short(hash: string): string {
  return hash.slice(0, HASH_IN_NAME);
}

function fileFor(slug: string, hash: string): string {
  return posix.join(AUDIO_DIR, `${slug}-${short(hash)}.mp3`);
}

/**
 * Every `*-<hash>.mp3` already in the project, keyed by the hash in its name —
 * which is the shortened one, so every lookup against this map has to shorten
 * too. Looking a full hash up in here is how the first version of this
 * silently paid for every line twice.
 */
async function alreadySpoken(dir: string): Promise<Map<string, string>> {
  let names: string[];
  try {
    names = await readdir(join(dir, AUDIO_DIR));
  } catch (cause) {
    if ((cause as { code?: string }).code === "ENOENT") return new Map();
    throw cause;
  }
  const found = new Map<string, string>();
  const pattern = new RegExp(`-([0-9a-f]{${HASH_IN_NAME}})\\.mp3$`);
  for (const name of names) {
    const hash = pattern.exec(name)?.[1];
    // First writer wins, so a reused line keeps pointing at one stable file
    // even when two scenes said the same words.
    if (hash && !found.has(hash)) found.set(hash, posix.join(AUDIO_DIR, name));
  }
  return found;
}

function stopFor(error: VoiceError): NarrationStop {
  switch (error.kind) {
    case "quota_exhausted":
      return "quota_exhausted";
    case "server":
    case "transport":
    case "rate_limited":
      return "provider_failed";
    default:
      return "rejected_by_api";
  }
}

/**
 * Speaks every line that is not already on disk, and reports what it did.
 *
 * Safe to call again: the lines that landed are reused for free, so a call cut
 * off by a client timeout or a crash continues where it stopped rather than
 * paying for the whole script a second time.
 */
export async function narrate(
  dir: string,
  lines: readonly NarrationLine[],
  options: NarrateOptions,
  deps: NarrateDeps,
): Promise<NarrationReport> {
  const modelId = options.modelId ?? DEFAULT_VOICE_MODEL;
  const voiceId = options.voiceId;
  const onDisk = await alreadySpoken(dir);

  // `id` is the only thing that is ever looked up in `onDisk`: the map is keyed
  // by the shortened hash, and shortening at each call site instead is how the
  // first version of this paid for every line twice without saying so.
  const planned = lines.map((line) => {
    const hash = lineHash(voiceId, modelId, line.text);
    return { line, hash, id: short(hash), characters: characterCount(line.text) };
  });

  // What actually has to be spoken, each distinct line once. Two scenes with
  // the same words in the same voice are one piece of audio, so the second is
  // not merely free on a later call — it must not be bought twice inside this
  // one either, and the figure quoted to the user has to say so.
  const needed: typeof planned = [];
  const queued = new Set<string>();
  for (const entry of planned) {
    if (onDisk.has(entry.id) || queued.has(entry.id)) continue;
    queued.add(entry.id);
    needed.push(entry);
  }
  const toSpend = needed.reduce((sum, entry) => sum + entry.characters, 0);
  // Everything the script asks for, minus what has to be bought: whether a
  // line was saved by a file from last week or by its twin two scenes down,
  // it is a character the account does not pay for.
  const reused = planned.reduce((sum, entry) => sum + entry.characters, 0) - toSpend;

  const records = new Map<string, NarrationRecord>();

  /**
   * The report, given what has been recorded so far. A line with no record of
   * its own takes the file already on disk under its hash, which is how a
   * scene whose twin was spoken a moment ago reports the file it shares rather
   * than looking untouched.
   */
  const report = (
    spent: number,
    stopped?: NarrationStop,
    detail?: string,
  ): NarrationReport => ({
    voiceId,
    modelId,
    lines: planned.map((entry) => {
      const own = records.get(entry.line.slug);
      if (own) return own;
      const file = onDisk.get(entry.id);
      const base = {
        slug: entry.line.slug,
        hash: entry.hash,
        characters: entry.characters,
      };
      return file
        ? { ...base, state: "reused" as const, file }
        : { ...base, state: "planned" as const };
    }),
    charactersToSpend: toSpend,
    charactersSpent: spent,
    charactersReused: reused,
    ...(options.dryRun ? { dryRun: true } : {}),
    ...(stopped ? { stopped } : {}),
    ...(detail ? { detail } : {}),
  });

  if (needed.length === 0) return report(0);

  // Priced but not spoken. Checked before the budget so a dry run can report a
  // figure that is over the ceiling — that is exactly the number to go and
  // agree with the user.
  if (options.dryRun) return report(0);

  if (toSpend > options.maxCharacters) {
    // Nothing is spoken: half a voiceover the caller did not ask for is worse
    // than none, and it would have been paid for.
    return report(
      0,
      "over_budget",
      `these lines need ${toSpend} characters, which is over the ${options.maxCharacters} ` +
        "character budget for this call",
    );
  }

  // Asked before anything is spent, so an account with too little left says so
  // once instead of failing somewhere in the middle of the script.
  try {
    const quota = await deps.voice.quota();
    if (quota.limit > 0 && quota.remaining < toSpend) {
      return report(
        0,
        "quota_exhausted",
        `this ElevenLabs account has ${quota.remaining} characters left and these lines need ` +
          `${toSpend}` +
          (quota.resetsAt ? `; the allowance resets at ${quota.resetsAt}` : ""),
      );
    }
  } catch (error) {
    // A quota that cannot be read is not a reason to refuse to work: the
    // synthesis call itself reports being out of characters, and that answer is
    // the authoritative one. An unreadable quota from a bad key, though, is
    // worth stopping on rather than spending a call to rediscover.
    if (error instanceof VoiceError && error.kind === "unauthorized") {
      return report(0, "rejected_by_api", error.detail);
    }
  }

  await mkdir(join(dir, AUDIO_DIR), { recursive: true });
  let spent = 0;
  for (const entry of needed) {
    const { slug } = entry.line;
    let bytes: Uint8Array;
    try {
      bytes = await deps.voice.speak({ voiceId, modelId, text: entry.line.text });
    } catch (error) {
      const voiceError = error instanceof VoiceError ? error : undefined;
      const detail = voiceError?.detail ?? (error as Error).message;
      records.set(slug, {
        slug,
        hash: entry.hash,
        state: "planned",
        characters: entry.characters,
        lastError: detail,
      });
      // Every line shares one voice and model, so the next would fail the same
      // way — except a rate limit, and stopping is the right answer to that too.
      return report(
        spent,
        voiceError ? stopFor(voiceError) : "provider_failed",
        detail,
      );
    }

    const relative = fileFor(slug, entry.hash);
    const absolute = join(dir, relative);
    const temporary = `${absolute}.part`;
    await writeFile(temporary, bytes);
    await rename(temporary, absolute);
    spent += entry.characters;
    // Recorded at once: a later line failing must not make this paid-for file
    // look unpaid, and the next call must find it.
    onDisk.set(entry.id, relative);

    let seconds: number | undefined;
    if (deps.probeDuration) {
      try {
        seconds = await deps.probeDuration(absolute);
      } catch {
        // The audio is written and paid for; a measurement is not worth losing
        // it over, and HyperFrames can measure the file itself.
      }
    }
    records.set(slug, {
      slug,
      hash: entry.hash,
      state: "spoken",
      characters: entry.characters,
      file: relative,
      ...(seconds !== undefined ? { seconds } : {}),
    });
  }

  return report(spent);
}
