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
 * Only the `NextjsRegionalContainers` image copies `public/` in. The other
 * types' deployment roots carry the list instead — {@link PUBLIC_FILES_FILE_NAME}, written at synth after the build
 * command, so a `postbuild` file is in it — and the runtime streams a listed
 * file from the assets bucket when a request lands on it. A file's own URL
 * never gets that far (the edge routes it to S3); a rewrite onto one does.
 */
import { readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  AdapterManifest,
  PUBLIC_FILES_FILE_NAME,
  RUNTIME_DIR_NAME,
} from "./manifest";

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

/** `public/` as the runtime serves it, and where its bytes are. */
export interface PublicFiles {
  readonly files: readonly string[];
  /**
   * `true` when `files` came from {@link PUBLIC_FILES_FILE_NAME} because
   * `public/` is not on disk: every type but `NextjsRegionalContainers`. Their
   * bytes are in S3.
   */
  readonly inS3: boolean;
}

/**
 * `public/` off disk when it is there, which is `NextjsRegionalContainers`, and the
 * synth-time list otherwise. An empty `public/` on disk with no list is an app
 * without one.
 */
export function resolvePublicFiles(
  deploymentRoot: string,
  manifest: AdapterManifest,
): PublicFiles {
  const onDisk = readPublicFiles(join(deploymentRoot, publicDirKey(manifest)));
  if (onDisk.length > 0) {
    return { files: onDisk, inS3: false };
  }
  let listed: unknown;
  try {
    listed = JSON.parse(
      readFileSync(
        join(deploymentRoot, RUNTIME_DIR_NAME, PUBLIC_FILES_FILE_NAME),
        "utf-8",
      ),
    );
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT") {
      return { files: onDisk, inS3: false };
    }
    throw error;
  }
  if (
    !Array.isArray(listed) ||
    !listed.every((file) => typeof file === "string")
  ) {
    throw new Error(
      `${RUNTIME_DIR_NAME}/${PUBLIC_FILES_FILE_NAME} is not a JSON array of paths.`,
    );
  }
  return { files: listed as string[], inS3: true };
}
