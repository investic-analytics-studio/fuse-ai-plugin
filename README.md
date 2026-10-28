# @fuse-ai/mcp

Fuse AI for coding agents. Your agent generates the video scenes through Fuse's API, then edits
and renders them on your own machine with [HyperFrames](https://www.npmjs.com/package/hyperframes).

Generating spends Fuse tokens. Everything after that — composing, captioning, mixing, rendering —
runs locally and costs nothing.

It ships as both an MCP server (any client) and a Claude Code plugin (the server plus the four-step
ad playbook and a `/make-ad` command).

> Not on npm yet. The `npx -y @fuse-ai/mcp` commands below are the intended install and are what the
> installer writes; until the package is published, point them at a local checkout instead.

## Requirements

- **Node 22.18.0 or newer.** That is the release where Node runs TypeScript directly, which is why
  this package has no build step. `node --version` to check.
- A Fuse API key, from the Fuse dashboard. Without one you can still list tiers and price a job;
  generating needs it.
- ffmpeg and a headless Chrome for rendering. You do not install these by hand — the installer runs
  HyperFrames' own `doctor` and `browser ensure`, and tells you if the machine is not ready.

## Install

**Every client CLI on this machine, in one command:**

```bash
export FUSE_API_KEY=...        # omit to install without a key; quoting still works
export ELEVENLABS_API_KEY=...  # optional, and your own account: voice-over only
npx -y @fuse-ai/mcp install    # add --dry-run to see the commands without running them
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
claude mcp add fuse -s user -e FUSE_API_KEY=... -e ELEVENLABS_API_KEY=... -- npx -y @fuse-ai/mcp
codex  mcp add fuse --env FUSE_API_KEY=... --env ELEVENLABS_API_KEY=... -- npx -y @fuse-ai/mcp
```

Both keys are read from the environment only, never from a command-line argument the installer
builds, and both are masked in everything the installer prints.

### Two keys, because they are two accounts

`FUSE_API_KEY` is Fuse, and it pays for the clips in Fuse tokens. `ELEVENLABS_API_KEY` is **your own
ElevenLabs account**, and it pays for the voice-over in ElevenLabs characters — a separate bill, from
a separate company, topped up in a separate place. Leave it out and everything works except the
voice: the two voice tools refuse with instructions, and the ads come out silent unless you supply
the audio yourself.

## The tools

| Tool | What it does | Costs |
|---|---|---|
| `fuse_tiers` | What Fuse can generate right now, read live from your account's pricing | nothing |
| `fuse_quote` | Token cost of a set of scenes on one tier | nothing |
| `fuse_project_new` | Scaffolds a HyperFrames project and binds it to one tier/resolution/aspect | nothing |
| `fuse_scenes` | Generates the scenes and downloads the clips. Resumable, never double-charges | **Fuse tokens** |
| `fuse_manifest` | Measures the clips with ffprobe and writes the canvas and real durations | nothing |
| `fuse_voices` | The voices and models on *your* ElevenLabs account, and the characters left | nothing |
| `fuse_narration` | Speaks the script into `assets/audio/`. Resumable, never double-charges | **your ElevenLabs characters** |

Nothing here hardcodes a tier, a price, a resolution or a voice: they come from the account's own
pricing — or your own ElevenLabs account — on every call, so a change on our side reaches you without
a package update.

`fuse_scenes` is the only tool that spends Fuse tokens. Its `maxTokens` is a ceiling on the whole
project, already-spent included, and it refuses rather than overshoot. It blocks for 90 seconds and
then reports progress; calling it again with the same arguments waits on instead of starting over, so
a crash, a closed client or a top-up all resume where you left off, free.

## Known limits, stated up front

- **The API key lands in your client's config file in plain text.** Anything that can read your home
  directory can read it. That is how key-based MCP auth works today, not a choice this package makes.
- **An API key cannot read your token balance.** There is no balance tool because the endpoint is
  session-authenticated. You learn you are short when a generation is refused — so agree a budget
  from `fuse_quote` first.
- **Image-to-video needs image URLs the API can fetch itself.** A file on your disk cannot be sent:
  uploads are session-authenticated too. Text-to-video tiers are unaffected.
- **Voice-over is billed by ElevenLabs, not by us.** `fuse_narration` runs on your own ElevenLabs
  account. Call it with `dryRun: true` first: that prices the script in characters and spends
  nothing. Re-running a line you have already spoken is free, and renaming a scene is free; changing
  one word of a line is new audio and is charged again.
- **Music and SFX are still yours to supply.** The package speaks a script; it does not write music,
  ambience or sound effects. Some tiers do render their own audio, which can be a different voice in
  every scene — so that is not an answer to "who narrates this".
- **A quote is a floor, not a cap.** You are charged on the clip the provider returns, which can run
  slightly longer than the duration asked for.

## Development

```bash
npm install
npm test              # the whole suite, offline
npm run typecheck     # tsc --noEmit; the suite runs this too
npm run test:live     # one real call to the public pricing endpoint
node src/index.ts install --dry-run
```

No build step, by design: `bin` points at `src/index.ts` and Node strips the types. The type check is
therefore the only thing that reads them, which is why the suite runs it rather than leaving it to CI.

## Licence

Apache-2.0. See [LICENSE](LICENSE). The licence covers this package; generating scenes still spends
tokens on your Fuse account.
