# @fuseai/mcp

***English** · [ภาษาไทย](README.th.md)*

Fuse AI for coding agents. Your agent generates the video scenes through Fuse's API, then edits
and renders them on your own machine with [HyperFrames](https://www.npmjs.com/package/hyperframes).

Generating spends Fuse tokens. Everything after that — composing, captioning, mixing, rendering —
runs locally and costs nothing.

It ships as both an MCP server (any client) and a Claude Code plugin (the server plus the four-step
ad playbook and a `/make-ad` command).

## Requirements

- **Node 22.18.0 or newer.** `node --version` to check. The published package runs compiled
  JavaScript, but the sources are TypeScript that Node runs directly in development — see
  [Development](#development).
- A Fuse API key, from the Fuse dashboard. Without one you can still list tiers and price a job;
  generating needs it.
- ffmpeg and a headless Chrome for rendering. You do not install these by hand — the installer runs
  HyperFrames' own `doctor` and `browser ensure`, and tells you if the machine is not ready.

## Install

**Every client CLI on this machine, in one command:**

```bash
export FUSE_API_KEY=...        # omit to install without a key; quoting still works
export ELEVENLABS_API_KEY=...  # optional, and your own account: voice-over only
npx -y @fuseai/mcp install    # add --dry-run to see the commands without running them
```

It does not edit anyone's config file. It runs each client's own CLI — `claude mcp add`,
`codex mcp add` — because those own that file, know where it lives on each platform, and merge into
it safely. It reports a client it cannot find, and prints by-hand steps for a client that has no CLI.

**Claude Code, as a plugin** (adds the skills and `/make-ad` as well as the server):

```
/plugin marketplace add investic-analytics-studio/fuse-ai-plugin
/plugin install fuse@fuse-ai-plugin
```

**One client at a time, by hand:**

```bash
claude mcp add fuse -s user -e FUSE_API_KEY=... -e ELEVENLABS_API_KEY=... -- npx -y @fuseai/mcp
codex  mcp add fuse --env FUSE_API_KEY=... --env ELEVENLABS_API_KEY=... -- npx -y @fuseai/mcp
```

Both keys are read from the environment only, never from a command-line argument the installer
builds, and both are masked in everything the installer prints.

### Two keys, because they are two accounts

`FUSE_API_KEY` is Fuse, and it pays for the clips in Fuse tokens. `ELEVENLABS_API_KEY` is **your own
ElevenLabs account**, and it pays for the voice-over in ElevenLabs characters — a separate bill, from
a separate company, topped up in a separate place. Leave it out and everything works except the
voice: the two voice tools refuse with instructions, and the ads come out silent unless you supply
the audio yourself.

## A full run, end to end

One sequence, from a machine that has never seen this package to a rendered file. **You talk to the
agent; the agent calls the tools.** The shell commands below are only the ones you run yourself:
installing, checking the machine, and rendering.

### 1. Check the machine

```bash
node --version    # 22.18.0 or newer
```

### 2. Install, dry run first

On a machine you have not set up before, look before you touch anything:

```bash
npx -y @fuseai/mcp install --dry-run
```

```
@fuseai/mcp 0.1.0

  Claude Code: would install
    claude mcp add fuse -s user -- npx -y @fuseai/mcp
  Codex CLI: would install
    codex mcp add fuse -- npx -y @fuseai/mcp

  rendering: ready
```

It names every client it found and the exact command it would run for each, so nothing happens that
you did not read first. `rendering: ready` is HyperFrames' own `doctor`: ffmpeg and a headless
Chrome are present. A machine that reports otherwise still generates clips fine — it just cannot do
step 9.

Then the real thing, with the keys in the environment so they never appear in a command line:

```bash
export FUSE_API_KEY=...        # omit and quoting still works; generating does not
export ELEVENLABS_API_KEY=...  # optional, your own account, voice-over only
npx -y @fuseai/mcp install
```

Start a new client session afterwards, so it picks the server up.

### 3. Prove the server is reachable before spending anything

> list the Fuse tiers

The agent calls **`fuse_tiers`**. No key, no cost — which makes it the cheapest possible proof that
the server is actually wired into this client. You get the live tier list with prices, and an
`audio` field per tier saying what soundtrack its clips arrive carrying. If this does not work,
nothing below will.

### 4. Price the job and agree a ceiling

> three scenes, four seconds each, on i2v-fast-standard at 720p — what does that cost?

The agent calls **`fuse_quote`** with `tier`, `resolution` and `scenes`, each scene a `slug` and
`seconds`; prompts are not needed to price. **The total is a floor, not a cap** — you are charged on
the clip the provider returns, which can run slightly longer than the duration asked for. Decide the
number you are willing to spend here; it becomes `maxTokens` in step 6.

### 5. Create the project

> create the project in ./my-ad on that tier and resolution

The agent calls **`fuse_project_new`** with `dir`, `tier`, `resolution` and optionally `aspect`. It
runs `hyperframes init` — which brings its own project file, its own instructions and its own
skills — and then adds only the parts Fuse knows about:

```
my-ad/
  hyperframes.json        # HyperFrames' own, plus the files its init writes
  assets/
    scenes/               # the clips land here
    fonts/
      noto-sans-thai.css  # local Thai font, so Thai does not render as empty boxes
  .fuse/
    job.json              # the record of what has been paid for
```

Point it at a directory that already has a `hyperframes.json` and it **reuses** that project and
reports what has already been spent, instead of starting a second one beside it.

### 6. Generate the clips — the only step that spends Fuse tokens

> generate the scenes, ceiling 900 tokens

The agent calls **`fuse_scenes`** with `dir`, `maxTokens` and `scenes`, each scene a `prompt` plus
`imageUrls` for image-to-video and `lastImageUrl` where the tier supports one. A local image has to
go through **`fuse_upload`** first, which puts it on your Fuse account and hands back a public URL.

`maxTokens` is a ceiling on the **whole project**, already-spent included, and the tool refuses
rather than overshoot it. The call blocks for about 45 seconds and then reports progress; **call it
again with the same arguments** and it waits on runs already paid for instead of starting new ones,
so a crash, a closed client or a top-up all resume for free. That is what `.fuse/job.json` is for:
delete it and you have thrown away the record of what you bought.

### 7. Measure the clips before composing anything

> measure the clips

The agent calls **`fuse_manifest`**, which runs ffprobe over the downloaded clips and writes
`assets/scenes/manifest.json`: the real canvas, the real durations, the frame rate, and whether each
clip carries sound. **Compose from this file, never from the resolution name** — the delivered pixel
size does not always match what the name implies.

### 8. Voice-over, if you want it — billed by ElevenLabs, not by Fuse

> what voices do I have? price the script before speaking any of it

**`fuse_voices`** lists the voices and models on your own ElevenLabs account and the characters you
have left. **`fuse_narration`** speaks the script into `assets/audio/` — call it with `dryRun: true`
first, which prices the script in characters and spends nothing. Re-speaking a line you already have
is free; changing one word of it is new audio and is charged again.

### 9. Edit and render — on your machine, for nothing

Writing the composition is HyperFrames' subject, not this package's: read the instructions and
skills that `hyperframes init` left inside the project. Then, from the project directory:

```bash
npx hyperframes lint      # problems before a render, Thai rendering as boxes among them
npx hyperframes check     # checks the composition
npx hyperframes render    # the real render
```

If `check` warns `film_silent` **and** the manifest says the clips carry no sound, that warning is
the expected one: what you have is a picture cut with no audio mix, and saying otherwise would be a
lie. If the manifest says the clips **do** carry sound and you still get `film_silent`, you have
muted audio you paid for.

### Taking it to a second machine

- Keys live in each client's own config file, per machine — run step 2 again there.
- `rendering: ready` is per machine too. A machine without ffmpeg or Chrome generates clips
  perfectly well and renders nothing.
- A project carries its own `.fuse/job.json`. Copy the **whole directory** and `fuse_scenes` picks
  up where it left off; copy only the clips and that record is gone, so a re-run pays again.
- An API key cannot read your token balance, so quote first and keep the ceiling honest.

## The tools

| Tool | What it does | Costs |
|---|---|---|
| `fuse_tiers` | What Fuse can generate right now: your account's live pricing, plus what soundtrack each tier's clips arrive carrying, and how firmly that is known | nothing |
| `fuse_upload` | Puts local images on your Fuse account and returns a public URL for each, which is what makes image-to-video usable | nothing |
| `fuse_quote` | Token cost of a set of scenes on one tier | nothing |
| `fuse_project_new` | Scaffolds a HyperFrames project and binds it to one tier/resolution/aspect | nothing |
| `fuse_scenes` | Generates the scenes and downloads the clips. Resumable, never double-charges | **Fuse tokens** |
| `fuse_manifest` | Measures the clips with ffprobe: the canvas, the real durations, the frame rate and whether they carry sound | nothing |
| `fuse_voices` | The voices and models on *your* ElevenLabs account, and the characters left | nothing |
| `fuse_narration` | Speaks the script into `assets/audio/`. Resumable, never double-charges | **your ElevenLabs characters** |

Nothing here hardcodes a tier, a price, a resolution or a voice: they come from the account's own
pricing — or your own ElevenLabs account — on every call, so a change on our side reaches you without
a package update.

`fuse_scenes` is the only tool that spends Fuse tokens. Its `maxTokens` is a ceiling on the whole
project, already-spent included, and it refuses rather than overshoot. It blocks for 45 seconds and
then reports progress; calling it again with the same arguments waits on instead of starting over, so
a crash, a closed client or a top-up all resume where you left off, free.

## Known limits, stated up front

- **The API key lands in your client's config file in plain text.** Anything that can read your home
  directory can read it. That is how key-based MCP auth works today, not a choice this package makes.
- **An API key cannot read your token balance.** There is no balance tool because the endpoint is
  session-authenticated. You learn you are short when a generation is refused — so agree a budget
  from `fuse_quote` first.
- **An uploaded image gets a public URL.** Image-to-video reads its start frame over HTTP, so
  `fuse_upload` puts your file on your Fuse account and hands back a plain storage link — no key in
  it, readable by anyone who has it. It lands in your own asset library. Do not upload anything you
  would not put on a public URL.
- **Voice-over is billed by ElevenLabs, not by us.** `fuse_narration` runs on your own ElevenLabs
  account. Call it with `dryRun: true` first: that prices the script in characters and spends
  nothing. Re-running a line you have already spoken is free, and renaming a scene is free; changing
  one word of a line is new audio and is charged again.
- **The voice is always yours to buy, on every tier.** Some tiers return clips with a soundtrack
  of their own — `fuse_tiers` says which under `audio`, and how sure that is — but a video model
  invents speech that reads nobody's script and can change voice between scenes. It is atmosphere
  at best and a track to mute at worst, never the narration. Music, ambience and SFX are still
  yours to supply as files.
- **A quote is a floor, not a cap.** You are charged on the clip the provider returns, which can run
  slightly longer than the duration asked for.

## Development

```bash
npm install
npm test              # the whole suite, offline
npm run typecheck     # tsc --noEmit; the suite runs this too
npm run build         # tsc -p tsconfig.build.json, into dist/; prepack runs it
npm run test:live     # one real call to the public pricing endpoint
node src/index.ts install --dry-run
```

Development runs the sources: Node reads `.ts` directly, so `node src/index.ts` needs no build and the
imports keep their real `.ts` extensions.

Publishing cannot. Node refuses to strip types for anything under `node_modules`
(`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`), which is exactly where this package lives once it is
installed — so `bin` points at `dist/index.js`, built by `tsc` with `rewriteRelativeImportExtensions`,
which turns each `./x.ts` into `./x.js` on the way out. One source tree, both ways of running it.
`prepack` builds, so `npm publish` and `npm pack` cannot ship a stale or missing `dist/`.

## Licence

Apache-2.0. See [LICENSE](LICENSE). The licence covers this package; generating scenes still spends
tokens on your Fuse account.
