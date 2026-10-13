#!/usr/bin/env node
/**
 * Render the README architecture diagrams with real AWS icons.
 *
 *   pnpm diagrams          # docs/diagrams/*.mmd -> docs/diagrams/*.svg
 *   pnpm diagrams:check    # fail if an .svg is missing or older than its .mmd
 *
 * Why committed SVGs and not ```mermaid blocks. GitHub's Mermaid renderer can't
 * register icon packs, so `architecture-beta` there is limited to its generic
 * built-in icons; and npm and Construct Hub don't render Mermaid at all. An SVG
 * renders everywhere the README is shown.
 *
 * Why the check compares a hash and not the rendered bytes. Chromium lays out
 * labels with whatever fonts the machine has, so a render on macOS and one on an
 * Ubuntu runner differ even from the same source. Each SVG instead carries the
 * SHA-256 of the `.mmd` it was rendered from, which the check (no Chrome needed)
 * compares against the source on disk.
 *
 * `mmdc` runs through `npx`, not as a devDependency: it pulls in Puppeteer, whose
 * Chrome download pnpm blocks as a build script, and every install would pay for
 * it. The icon pack is a devDependency so its version is pinned by the lockfile.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const MERMAID_CLI = "@mermaid-js/mermaid-cli@12.0.0";
const DIAGRAMS_DIR = resolve("docs", "diagrams");
const ICON_PACK = resolve(
  "node_modules",
  "@iconify-json",
  "logos",
  "icons.json",
);
const STAMP = /^<!-- source-sha256: ([0-9a-f]{64}) -->\n/;

const sources = readdirSync(DIAGRAMS_DIR)
  .filter((f) => f.endsWith(".mmd"))
  .sort();

const sha256 = (text) => createHash("sha256").update(text).digest("hex");

if (process.argv.includes("--check")) {
  const stale = sources.filter((source) => {
    const svg = join(DIAGRAMS_DIR, source.replace(/\.mmd$/, ".svg"));
    if (!existsSync(svg)) return true;
    const stamp = STAMP.exec(readFileSync(svg, "utf8"));
    return stamp?.[1] !== sha256(readFileSync(join(DIAGRAMS_DIR, source)));
  });
  if (stale.length) {
    console.error(
      `Stale diagrams (run \`pnpm diagrams\` and commit the SVGs): ${stale.join(", ")}`,
    );
    process.exit(1);
  }
  process.exit(0);
}

// Chrome's sandbox can't start on GitHub's Ubuntu runners or in most containers.
const work = mkdtempSync(join(tmpdir(), "render-diagrams-"));
const puppeteerConfig = join(work, "puppeteer.json");
writeFileSync(puppeteerConfig, JSON.stringify({ args: ["--no-sandbox"] }));

try {
  for (const source of sources) {
    const name = basename(source, ".mmd");
    const input = join(DIAGRAMS_DIR, source);
    const output = join(DIAGRAMS_DIR, `${name}.svg`);
    execFileSync(
      "npx",
      [
        "--yes",
        MERMAID_CLI,
        "--quiet",
        "--puppeteerConfigFile",
        puppeteerConfig,
        "--iconPacksNamesAndUrls",
        `logos#${pathToFileURL(ICON_PACK)}`,
        "--input",
        input,
        "--output",
        output,
      ],
      { stdio: "inherit" },
    );
    // Iconify names gradient ids with a random prefix; renumber them so an
    // unchanged source re-renders to the same bytes on the same machine.
    const ids = new Map();
    const svg = readFileSync(output, "utf8").replace(
      /IconifyId[0-9a-f]+/g,
      (id) => {
        if (!ids.has(id)) ids.set(id, `${name}-icon-${ids.size}`);
        return ids.get(id);
      },
    );
    const stamp = `<!-- source-sha256: ${sha256(readFileSync(input))} -->\n`;
    writeFileSync(output, `${stamp}${svg}\n`);
    console.log(`rendered ${output}`);
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}
