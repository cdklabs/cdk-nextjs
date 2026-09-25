/**
 * `public/`, as the runtime finds it on disk.
 *
 * Listed at cold start, the way `next start` lists it
 * (`next/dist/server/lib/router-utils/filesystem.js`, `recursiveReadDir` of
 * `public/`), rather than at build time in the manifest. The build-time list
 * was the wrong source of truth in two ways: `onBuildComplete` runs inside
 * `next build`, so anything an app's `postbuild` writes into `public/` —
 * `next-sitemap`'s `sitemap.xml` and `robots.txt`, Pagefind's `_pagefind/` — was
 * in the image and missing from the list; and every Lambda deployment carried
 * the whole list for files CloudFront or API Gateway always answers from S3.
 *
 * Only the container images copy `public/` in, so on the Lambda types this is
 * normally empty and dispatch behaves as though the app had no `public/`.
 */
import { readdirSync, realpathSync, statSync } from "node:fs";
import { join } from "node:path";
import { AdapterManifest } from "./manifest";

/** Where `public/` sits in the deployment root, as a POSIX key. */
export function publicDirKey(manifest: AdapterManifest): string {
  const { relativeProjectDir } = manifest;
  return relativeProjectDir ? `${relativeProjectDir}/public` : "public";
}

/**
 * Every file under `public/`, as `/`-separated paths relative to it, unencoded:
 * `static/hello e2e.png`, `images/logo@2x.png`.
 *
 * Symlinks are followed, files and directories alike, because Next.js's
 * `recursiveReadDir` follows them and so does everything that puts `public/` in
 * front of a user: Docker `COPY` keeps a working link in the image, and CDK's
 * asset staging uploads the target's bytes to S3. `Dirent.isFile()` describes the
 * link, not its target, so filtering on it silently dropped them. A directory
 * is not entered from inside itself, so a link cycle terminates.
 */
export function readPublicFiles(dir: string): string[] {
  const files: string[] = [];
  /** The real paths of the directories being walked, root to current. */
  const ancestors = new Set<string>();

  const walk = (absolute: string, relative: string) => {
    let real: string;
    try {
      real = realpathSync(absolute);
    } catch {
      return;
    }
    if (ancestors.has(real)) return;
    ancestors.add(real);

    for (const entry of readdirSync(absolute, { withFileTypes: true })) {
      const childAbsolute = join(absolute, entry.name);
      const childRelative = relative ? `${relative}/${entry.name}` : entry.name;
      let isDirectory = entry.isDirectory();
      let isFile = entry.isFile();
      if (entry.isSymbolicLink()) {
        try {
          const target = statSync(childAbsolute);
          isDirectory = target.isDirectory();
          isFile = target.isFile();
        } catch {
          // A dangling link: nothing to serve.
          continue;
        }
      }
      if (isDirectory) {
        walk(childAbsolute, childRelative);
      } else if (isFile) {
        files.push(childRelative);
      }
    }
    ancestors.delete(real);
  };

  try {
    walk(dir, "");
  } catch (error) {
    if ((error as { code?: string }).code !== "ENOENT") throw error;
  }
  return files.sort();
}
