/**
 * Is the type checker actually run, and does the one invariant that lives in
 * the types still hold?
 *
 * `bin` points straight at `src/index.ts` and Node strips the types away at
 * startup, so nothing in the shipping path ever reads them. That makes the
 * checker easy to not run, and a Resolution that can only come from the
 * catalog is worth exactly as much as the last time someone checked it. Both
 * tests here shell out to the real tsc so that `npm test` is what notices.
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { test } from "node:test";

const root = fileURLToPath(new URL("..", import.meta.url));
const tsc = join(root, "node_modules", "typescript", "bin", "tsc");

/** tsc writes its complaints to stdout and exits non-zero when it has any. */
function check(args: readonly string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(process.execPath, [tsc, ...args], { cwd: root }, (_error, stdout, stderr) => {
      if (stderr.trim()) reject(new Error(stderr));
      else resolve(stdout.trim());
    });
  });
}

test("the package type-checks", async () => {
  assert.equal(await check(["--noEmit"]), "", "the types no longer check out");
});

test("a resolution the catalog never handed out cannot reach a JobSpec", async () => {
  const fixture = "test/fixtures/types/branded-resolution.ts";
  // Built from the word, so this file does not mark a line of its own.
  const token = "EXPECT" + "_ERROR";
  const marked = readFileSync(join(root, fixture), "utf8")
    .split("\n")
    .flatMap((line, index) => (line.includes(token) ? [index + 1] : []));
  assert.equal(marked.length, 1, "the fixture should mark exactly one line");

  const output = await check(["-p", join("test", "fixtures", "types"), "--noEmit"]);
  const refusals = output
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith(fixture));
  assert.equal(refusals.length, 1, `expected one refusal, got:\n${output}`);
  // The line, not the column: the point is which assignment was refused.
  assert.ok(
    refusals[0]?.startsWith(`${fixture}(${marked[0]},`),
    `the refusal is not on line ${marked[0]}:\n${output}`,
  );
  assert.ok(
    refusals[0]?.endsWith("error TS2322: Type 'string' is not assignable to type 'Resolution'."),
    `the brand no longer refuses a plain string:\n${output}`,
  );
});
