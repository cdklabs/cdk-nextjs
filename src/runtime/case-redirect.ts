/**
 * The canonical spelling of a URL that reached the wrong function group only
 * because of its case.
 *
 * CloudFront behaviors and API Gateway resources match paths case-sensitively,
 * and Next.js's route matching does not, so `/API/reports/1` misses the
 * `api/reports/*` behavior, reaches the default group, and matches
 * `/api/reports/[id]` there, whose code another group carries. Redirecting it
 * to `/api/reports/1` gets it to the group that has the route, where a 404
 * would have told the client a URL `next start` serves does not exist.
 */
import { AdapterManifest } from "./manifest";

/**
 * `pathname` (as requested, percent-encoded) respelled with the static segments
 * of `template` (the matched `manifest.entrypoints` key), keeping the request's
 * own dynamic segment values, basePath and locale prefix. `undefined` when the
 * two differ in anything but case — a rewrite, a mismatched shape — or not at
 * all, since then a redirect would not change where the request goes.
 */
export function caseCanonicalPath(
  pathname: string,
  template: string,
  manifest: Pick<AdapterManifest, "config">,
): string | undefined {
  const basePath = manifest.config.basePath ?? "";
  let rest = pathname;
  let prefix = "";
  if (basePath) {
    if (!startsWithSegment(rest.toLowerCase(), basePath.toLowerCase())) {
      return undefined;
    }
    prefix = basePath;
    rest = rest.slice(basePath.length) || "/";
  }
  const i18n = manifest.config.i18n as {
    readonly locales?: readonly string[];
  } | null;
  const first = rest.split("/")[1] ?? "";
  const locale = i18n?.locales?.find(
    (candidate) => candidate.toLowerCase() === first.toLowerCase(),
  );
  if (locale) {
    prefix += `/${locale}`;
    rest = rest.slice(first.length + 1) || "/";
  }

  const trailingSlash = rest.length > 1 && rest.endsWith("/");
  const requested = segments(rest);
  const expected = segments(template);
  const canonical: string[] = [];
  for (let i = 0; i < expected.length; i++) {
    const part = expected[i];
    if (/^\[\[?\.\.\./.test(part)) {
      // A catch-all takes everything left, as requested.
      canonical.push(...requested.slice(i));
      return finish(prefix, canonical, trailingSlash, pathname);
    }
    const value = requested[i];
    if (value === undefined) {
      return undefined;
    }
    if (part.startsWith("[")) {
      canonical.push(value);
      continue;
    }
    if (safeDecode(value)?.toLowerCase() !== part.toLowerCase()) {
      return undefined;
    }
    canonical.push(encodeURIComponent(part));
  }
  if (requested.length !== expected.length) {
    return undefined;
  }
  return finish(prefix, canonical, trailingSlash, pathname);
}

function finish(
  prefix: string,
  canonical: readonly string[],
  trailingSlash: boolean,
  pathname: string,
): string | undefined {
  const path = `${prefix}/${canonical.join("/")}`.replace(/\/+$/, "") || "/";
  const result = trailingSlash && path !== "/" ? `${path}/` : path;
  return result === pathname ? undefined : result;
}

function segments(path: string): string[] {
  return path.split("/").filter(Boolean);
}

function startsWithSegment(path: string, prefix: string): boolean {
  return path === prefix || path.startsWith(`${prefix}/`);
}

function safeDecode(segment: string): string | undefined {
  try {
    return decodeURIComponent(segment);
  } catch {
    return undefined;
  }
}
