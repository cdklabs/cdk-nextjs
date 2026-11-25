import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Script } from "node:vm";

// `scripts/e2e-sweep.sh` runs inline `node -e '...'` scripts. An apostrophe in
// one (a comment's "can't", say) ends the shell quote early, so node gets a
// truncated script and the sweep, and every harness shard's stack delete, fail
// at run time. Compiling each one here, without running it, catches that.
const sweep = readFileSync(
  join(__dirname, "..", "scripts", "e2e-sweep.sh"),
  "utf-8",
);
const scripts = [...sweep.matchAll(/node -e '([^']*)'/g)].map((m) => m[1]);

describe("e2e-sweep.sh", () => {
  it("has inline node scripts", () => {
    expect(scripts.length).toBeGreaterThan(0);
  });

  it.each(scripts.map((script, i) => [i, script]))(
    "inline node script %i is whole",
    (_i, script) => {
      expect(() => new Script(script as string)).not.toThrow();
    },
  );
});
