/**
 * The published build, checked for the one thing that cannot be seen from a
 * checkout.
 *
 * Everything else in this suite runs `src/` directly, which is also how
 * development runs it, and that path works. The customer's path does not go
 * through `src/`: npx puts the package under node_modules, and Node refuses
 * to strip types for anything under node_modules
 * (ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING). A package whose `bin` points
 * at a .ts file therefore installs cleanly, links its binary, and dies on the
 * first line the customer ever runs.
 *
 * So these hold the shape that cannot regress silently: the entry is
 * JavaScript, it is built from the sources rather than kept beside them, and
 * nothing in the output still asks Node for a .ts file.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const manifest = JSON.parse(readFileSync(root + "package.json", "utf8")) as {
  bin: Record<string, string>;
  files: string[];
  scripts: Record<string, string>;
};

test("what a customer runs is JavaScript, and it is what gets shipped", () => {
  const targets = Object.values(manifest.bin);
  assert.equal(targets.length, 1);
  const [entry] = targets;
  assert.ok(entry, "the package declares no bin, so npx has nothing to run");
  assert.match(entry, /\.js$/, "a .ts bin cannot run from node_modules");
  assert.match(entry, /^dist\//, "the bin must come from the build, not from src");
  // Spelled `./dist/index.js` it still runs, but npm rewrites it to
  // `dist/index.js` when publishing and prints `script name ... was invalid
  // and removed` while it does, which reads like the command was thrown away.
  // It was not — the registry metadata keeps it, and 0.2.0 installs and runs
  // from npx — but nobody reading a release log can tell that. So the spelling
  // here is the one npm stores, and the warning has nothing left to say.
  assert.doesNotMatch(entry, /^\.\//, "npm will rewrite this on publish and warn while doing it");
  assert.ok(manifest.files.includes("dist"), "the build is not in the published files");
  assert.ok(!manifest.files.includes("src"), "shipping src again invites the .ts bin back");
  // prepack runs for `npm publish` and `npm pack` alike, so the build cannot
  // be forgotten by publishing from a tree that never ran it.
  assert.equal(manifest.scripts.prepack, "npm run build");
});

test("the build emits a runnable entry, with no .ts left anywhere in it", () => {
  const out = mkdtempSync(join(tmpdir(), "fuse-build-"));
  try {
    execFileSync(
      process.execPath,
      [
        join(root, "node_modules", "typescript", "lib", "tsc.js"),
        "-p",
        join(root, "tsconfig.build.json"),
        "--outDir",
        out,
      ],
      { stdio: "pipe" },
    );

    const entry = join(out, "index.js");
    assert.ok(statSync(entry).isFile(), "the build produced no index.js");
    const text = readFileSync(entry, "utf8");
    assert.match(text, /^#!\/usr\/bin\/env node\r?\n/, "the shebang did not survive the build");

    // The failure this file exists for: a relative import still naming a .ts
    // file would resolve to nothing once the sources are gone.
    const files: string[] = [];
    const walk = (dir: string): void => {
      for (const item of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, item.name);
        if (item.isDirectory()) walk(path);
        else if (item.name.endsWith(".js")) files.push(path);
      }
    };
    walk(out);
    assert.ok(files.length > 5, "the build is suspiciously small");
    for (const file of files) {
      const source = readFileSync(file, "utf8");
      for (const [match] of source.matchAll(/from\s+"(\.[^"]*)"/g)) {
        assert.ok(
          !match.includes('.ts"'),
          `${relative(out, file)} still imports ${match} after the build`,
        );
      }
    }
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});
