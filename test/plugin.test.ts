/**
 * The plugin shell is text files, so what can go wrong with it is drift: a
 * skill that tells the model to call a tool we never shipped, a version that
 * moved in one manifest and not the other, a server name the installer and the
 * plugin spell differently, or an API key written into a file that goes into a
 * git repository.
 *
 * None of that shows up in a unit test of the code, and all of it only shows
 * up for the customer. So it is checked here against the code itself.
 */
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { SERVER_NAME, launchCommand } from "../src/install.ts";
import { createTools } from "../src/tools.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const read = (name: string): string => readFileSync(root + name, "utf8");
const json = (name: string): Record<string, unknown> => JSON.parse(read(name));

/** The pipeline: every job walks these four in order, whatever it is a job for. */
const STAGES = ["01-analysis", "02-planning", "03-generation", "04-editing"];
/**
 * What a job is *about*. A genre skill is not a fifth step: it is what the four
 * steps need to know extra, and the model is sent to it by its own command, so
 * the two have to stay in step with each other.
 */
const GENRES = ["genre-food", "genre-product", "genre-series", "genre-vox"];
const SKILLS = [...STAGES, ...GENRES];
/** `genre-food` is driven by `/fuse:food`, and so on. */
const commandOf = (genre: string): string => `commands/${genre.replace("genre-", "")}.md`;
const COMMANDS = readdirSync(root + "commands")
  .filter((name) => name.endsWith(".md"))
  .map((name) => `commands/${name}`)
  .sort();
/**
 * The one page Codex reads. It is not a skill of the plugin and not a command:
 * Codex has neither, so this is where the gates and the routing are repeated
 * for it. It is held to every rule the other pages are held to.
 */
const CODEX_PAGE = "codex/SKILL.md";
const PAGES = [
  ...SKILLS.map((skill) => `skills/${skill}/SKILL.md`),
  ...COMMANDS,
  CODEX_PAGE,
];

/** The real tool names, from the code that registers them. */
const toolNames = createTools({
  catalog: async () => assert.fail("listing tool names must not load a catalog"),
  runs: {
    submit: async () => assert.fail("listing tool names must not submit anything"),
    status: async () => assert.fail("listing tool names must not poll anything"),
  },
  openClip: async () => assert.fail("listing tool names must not fetch a clip"),
  scaffold: {
    run: async () => assert.fail("listing tool names must not run a command"),
    probe: async () => assert.fail("listing tool names must not probe a file"),
  },
  newJobId: () => "job",
}).map((definition) => definition.name);

/* ----------------------------------------------------------------- manifests */

test("one version number, not three", () => {
  assert.equal(json(".claude-plugin/plugin.json").version, json("package.json").version);
});

test("the marketplace points at this folder and names this plugin", () => {
  const marketplace = json(".claude-plugin/marketplace.json") as {
    plugins: Array<{ name: string; source: string }>;
  };
  assert.equal(marketplace.plugins.length, 1);
  const [plugin] = marketplace.plugins;
  assert.ok(plugin, "the marketplace lists no plugin");
  assert.equal(plugin.name, json(".claude-plugin/plugin.json").name);
  assert.equal(plugin.source, "./", "the repository root is the plugin");
});

test("the plugin starts the same server, the same way, as the installer", () => {
  const config = json(".mcp.json") as {
    mcpServers: Record<string, { command: string; args: string[]; env: Record<string, string> }>;
  };
  const names = Object.keys(config.mcpServers);
  assert.deepEqual(names, [SERVER_NAME], "a second name here is a second server in the client");
  const server = config.mcpServers[SERVER_NAME];
  assert.ok(server, `${SERVER_NAME} is not the server this file starts`);
  assert.deepEqual([server.command, ...server.args], [...launchCommand()]);
  // `:-` so an unset key expands to empty instead of the literal "${FUSE_API_KEY}":
  // with no key the server still lists tiers and quotes, which is the designed
  // behaviour, and the client shows no missing-variable warning for it.
  assert.equal(server.env.FUSE_API_KEY, "${FUSE_API_KEY:-}");
  // The voiceover key has to be passed through here as well, or a customer who
  // installed the plugin rather than running the installer could never have a
  // voice — the server would start without ever being handed the key they set.
  assert.equal(server.env.ELEVENLABS_API_KEY, "${ELEVENLABS_API_KEY:-}");
});

test("the package says it is Apache-2.0 and ships the text that says so", () => {
  const manifest = json("package.json");
  assert.equal(manifest.license, "Apache-2.0");
  const license = read("LICENSE");
  assert.match(license, /Apache License\s+Version 2\.0, January 2004/);
  assert.match(license, /Copyright \d{4} Fuse AI/, "the appendix still has its placeholder");
  // `private` would make `npm publish` refuse, and a scoped package without
  // this defaults to restricted: either way the customer's `npx -y @fuseai/mcp`
  // cannot resolve, which is the install path every document here describes.
  assert.equal(manifest.private, undefined, "a private package never reaches a customer");
  assert.deepEqual(manifest.publishConfig, { access: "public" });
});

test("the listing icon is one the directory accepts, and stays visible on a dark card", () => {
  const icon = readFileSync(root + ".claude-plugin/icon.png");
  assert.deepEqual(
    [...icon.subarray(0, 8)],
    [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
    "the directory takes PNG or JPEG, and refuses SVG and WebP",
  );
  // IHDR is always the first chunk: width, height, bit depth, colour type.
  const width = icon.readUInt32BE(16);
  const height = icon.readUInt32BE(20);
  const colourType = icon.readUInt8(25);
  assert.equal(width, height, "the icon has to be square");
  assert.ok(width >= 512 && width <= 2048, `512 to 2048 px a side, got ${width}`);
  assert.ok(icon.byteLength < 2 * 1024 * 1024, "under 2 MB");
  // The Fuse mark is near-black with a transparent background as the product
  // ships it, which disappears on a dark listing card. It is flattened onto
  // white here, so an alpha channel coming back means that was undone.
  assert.ok(
    colourType !== 4 && colourType !== 6,
    "the icon carries an alpha channel again; a near-black mark on it vanishes on dark",
  );
});

test("no file in the plugin shell carries a key", () => {
  for (const file of [".mcp.json", "README.md", "README.th.md", CODEX_PAGE, ...COMMANDS]) {
    const text = read(file);
    assert.doesNotMatch(text, /sk-[A-Za-z0-9]{8}/, `${file} looks like it holds a key`);
    assert.doesNotMatch(
      text,
      /FUSE_API_KEY\s*[=:]\s*["']?[A-Za-z0-9_-]{12}/,
      `${file} assigns FUSE_API_KEY a real-looking value`,
    );
  }
});

/* -------------------------------------------------------------------- skills */

test("the skills on disk are the ones named here, and each names itself after its folder", () => {
  assert.deepEqual(readdirSync(root + "skills").sort(), [...SKILLS].sort());
  for (const skill of SKILLS) {
    const text = read(`skills/${skill}/SKILL.md`);
    const front = /^---\n([\s\S]*?)\n---\n/.exec(text)?.[1];
    assert.ok(front, `${skill} has no frontmatter`);
    assert.match(front, new RegExp(`^name: ${skill}$`, "m"), `${skill}'s name must match its folder`);
    assert.match(front, /^description: \S/m, `${skill} has no description to be chosen by`);
  }
});

test("every command declares itself and says what to type after it", () => {
  for (const command of COMMANDS) {
    const front = /^---\n([\s\S]*?)\n---\n/.exec(read(command))?.[1];
    assert.ok(front, `${command} has no frontmatter`);
    assert.match(front, /^description: \S/m, `${command} has no description`);
    assert.match(front, /^argument-hint: \S/m, `${command} never says what its argument is`);
  }
});

test("a genre is reachable: one command per genre skill, and it sends the model there", () => {
  // A genre skill nothing points at is a file nobody opens; a command naming a
  // skill that is not there sends the model reading into nothing. And a genre
  // does not replace the pipeline, so its command still has to walk all four.
  for (const genre of GENRES) {
    const command = commandOf(genre);
    assert.ok(COMMANDS.includes(command), `${genre} has no command: ${command} is missing`);
    const text = read(command);
    assert.ok(text.includes(genre), `${command} never tells the model to read ${genre}`);
    for (const stage of STAGES) {
      assert.ok(text.includes(stage), `${command} skips ${stage}; every genre walks all four`);
    }
  }
  const owned = new Set(["commands/make-ad.md", ...GENRES.map(commandOf)]);
  for (const command of COMMANDS) {
    assert.ok(owned.has(command), `${command} belongs to no genre: add one, or add it to GENRES`);
  }
});

test("the command that names no genre routes to all of them", () => {
  // make-ad is the way in when nobody has named a genre yet. If a genre is
  // added and this page is not touched, the genre is reachable only by someone
  // who already knows its command exists, which is nobody being helped.
  const text = read("commands/make-ad.md");
  for (const genre of GENRES) {
    assert.ok(text.includes(genre), `make-ad does not mention ${genre}`);
  }
});

test("the skills a customer installs are the skills the package publishes", () => {
  // `files` is what reaches npm. A skill outside it exists for whoever cloned
  // the repository and for nobody who ran `npx -y @fuseai/mcp`.
  const files = json("package.json").files as string[];
  assert.ok(files.includes("skills"), "the skills folder is not in the published files");
  // The installer reads this one off disk at install time to write it into
  // Codex. Left out of `files`, `npx -y @fuseai/mcp install` fails on a
  // machine that has Codex and works on one that does not.
  assert.ok(files.includes("codex"), "the page Codex reads is not in the published files");
});

test("the page Codex reads routes to every stage and every genre", () => {
  // Codex gets no commands, so if a genre is not named here it is reachable
  // only by a customer who already knows it exists.
  const text = read(CODEX_PAGE);
  for (const skill of SKILLS) {
    assert.ok(text.includes(skill), `the Codex page never mentions ${skill}`);
  }
  // And the gates, which on Claude Code are repeated on every command.
  for (const gate of ["fuse_quote", "fuse_manifest", "fuse_upload"]) {
    assert.ok(text.includes(gate), `the Codex page drops the ${gate} gate`);
  }
});

test("every tool a skill, a command or a README names is a tool we ship", () => {
  const files = [...PAGES, "README.md", "README.th.md"];
  for (const file of files) {
    for (const [mentioned] of read(file).matchAll(/fuse_[a-z_]+/g)) {
      assert.ok(
        toolNames.includes(mentioned),
        `${file} tells the model to call ${mentioned}, which this package does not register`,
      );
    }
  }
});

test("nothing may talk about spending without naming the quote that gates it", () => {
  // The budget gate is a rule of the playbook, not of the code: fuse_scenes
  // happily spends up to whatever maxTokens it is handed. So every page that
  // tells the model to generate must also tell it where the number comes from.
  for (const page of PAGES) {
    const text = read(page);
    if (!text.includes("fuse_scenes")) continue;
    assert.ok(
      text.includes("fuse_quote"),
      `${page} sends the model to fuse_scenes without naming fuse_quote first`,
    );
  }
  // A command is the first page the model reads for a job, so the gate has to
  // be on it whether or not it happens to spell the spending tool by name.
  for (const command of COMMANDS) {
    assert.ok(read(command).includes("fuse_quote"), `${command} names no budget gate`);
  }
});

test("the step that plans sound asks the tool which tiers have it, and keeps no list of its own", () => {
  // A tier's sound is a claim about the model behind it, and the one copy of
  // that claim is src/fuse/audio.ts, where fuse_tiers reads it. A skill that
  // names the models instead would be a second copy, and the stale one, since
  // nothing re-reads a skill when a tier is rebound.
  const planning = read("skills/02-planning/SKILL.md");
  assert.ok(
    planning.includes("audio.sound") && planning.includes("fuse_tiers"),
    "planning designs sound without asking fuse_tiers what the clips will arrive carrying",
  );
  // And it must not sell that sound as the voice-over. A tier arriving with
  // audio adds a track to mute; the narration is bought from ElevenLabs on
  // every tier, and a plan that skips that budget is a plan with no voice.
  assert.ok(
    planning.includes("fuse_narration") && planning.includes("ElevenLabs"),
    "planning never says where the voice itself comes from",
  );
  for (const page of SKILLS.map((skill) => `skills/${skill}/SKILL.md`)) {
    for (const model of ["Seedance", "MiniMax"]) {
      assert.ok(
        !read(page).includes(model),
        `${page} names ${model}, which makes it a second copy of the model table`,
      );
    }
  }
});

test("the two steps that run on the customer's own machine call nothing of ours", () => {
  // Analysis is reading; editing is HyperFrames' job through the shell. If a
  // Fuse tool call leaks into either, the step has quietly changed owner.
  assert.deepEqual([...read("skills/01-analysis/SKILL.md").matchAll(/fuse_[a-z_]+/g)], []);
  const editing = [...read("skills/04-editing/SKILL.md").matchAll(/fuse_[a-z_]+/g)].map(
    ([name]) => name,
  );
  assert.deepEqual(
    [...new Set(editing)],
    ["fuse_manifest"],
    "editing may only point back at the measurement it starts from",
  );
});
