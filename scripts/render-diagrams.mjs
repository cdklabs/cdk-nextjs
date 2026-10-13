#!/usr/bin/env node
/**
 * Render the README architecture diagrams with real AWS icons.
 *
 *   pnpm diagrams          # docs/diagrams/*.mmd -> docs/diagrams/*.svg
 *   pnpm diagrams:check    # fail if an .svg is missing, orphaned or stale
 *
 * Why committed SVGs and not ```mermaid blocks. GitHub's Mermaid renderer can't
 * register icon packs, so `architecture-beta` there is limited to its generic
 * built-in icons; and npm and Construct Hub don't render Mermaid at all. An SVG
 * renders everywhere the README is shown.
 *
 * Why the check compares a hash and not the rendered bytes. Chromium lays out
 * labels with whatever fonts the machine has, so a render on macOS and one on an
 * Ubuntu runner differ even from the same source. Each SVG instead carries a
 * SHA-256 of the `.mmd` it was rendered from and the `mmdc` and icon pack
 * versions, which the check (no Chrome needed) recomputes from what's on disk.
 *
 * `mmdc` runs through `npx`, not as a devDependency: it pulls in Puppeteer, whose
 * Chrome download pnpm blocks as a build script, and every install would pay for
 * it. The icon pack is an exact-pinned devDependency, which keeps it out of the
 * automated `upgrade-dev-deps` PRs: bumping either version is a hand edit that
 * `diagrams:check` then makes you re-render for.
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
const ICON_PACK_DIR = resolve("node_modules", "@iconify-json", "logos");
const ICON_PACK = join(ICON_PACK_DIR, "icons.json");
const ICON_PACK_VERSION = JSON.parse(
  readFileSync(join(ICON_PACK_DIR, "package.json"), "utf8"),
).version;
const STAMP = /^<!-- source-sha256: ([0-9a-f]{64}) -->\n/;

const files = readdirSync(DIAGRAMS_DIR);
const sources = files.filter((f) => f.endsWith(".mmd")).sort();

const stampOf = (source) =>
  createHash("sha256")
    .update(`${MERMAID_CLI}\n@iconify-json/logos@${ICON_PACK_VERSION}\n`)
    .update(readFileSync(join(DIAGRAMS_DIR, source)))
    .digest("hex");

if (process.argv.includes("--check")) {
  const stale = sources.filter((source) => {
    const svg = join(DIAGRAMS_DIR, source.replace(/\.mmd$/, ".svg"));
    if (!existsSync(svg)) return true;
    return STAMP.exec(readFileSync(svg, "utf8"))?.[1] !== stampOf(source);
  });
  const orphaned = files.filter(
    (f) => f.endsWith(".svg") && !sources.includes(f.replace(/\.svg$/, ".mmd")),
  );
  if (stale.length) {
    console.error(
      `Stale diagrams (run \`pnpm diagrams\` and commit the SVGs): ${stale.join(", ")}`,
    );
  }
  if (orphaned.length) {
    console.error(`SVGs with no .mmd source: ${orphaned.join(", ")}`);
  }
  process.exit(stale.length || orphaned.length ? 1 : 0);
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
      // `npx` is `npx.cmd` on Windows, which only a shell can run.
      { stdio: "inherit", shell: process.platform === "win32" },
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
    const stamp = `<!-- source-sha256: ${stampOf(source)} -->\n`;
    writeFileSync(output, `${stamp}${svg}\n`);
    console.log(`rendered ${output}`);
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}
