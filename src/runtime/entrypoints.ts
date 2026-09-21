/**
 * Loading and invoking build-output entrypoints.
 *
 * All four invocable output types — `app-page`, `app-route`, `page`, `page-api` —
 * export the same `handler(req, res, ctx)` from
 * `next/dist/build/templates/{app-page,app-route,pages,pages-api}.js`, so there
 * is nothing to switch on: `AdapterEntrypoint.type` is carried for diagnostics,
 * not dispatch.
 *
 * Loading is lazy and memoized per file. Lazy because a cold start that requires
 * every route's module pays for the whole app on the first request; memoized
 * because locale variants and `_next/data` siblings of one route all resolve to
 * the same `filePath`.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
import { loadBuiltModule, requireFunctionExport } from "./load-module";
import { AdapterEntrypoint, AdapterManifest } from "./manifest";

/**
 * Per-request context, the third argument of every entrypoint `handler`.
 *
 * `requestMeta` is `RequestMeta` from `next/dist/server/request-meta`, typed
 * loosely here so this module does not need a `next` type import.
 */
export interface EntrypointContext {
  readonly waitUntil?: (promise: Promise<unknown>) => void;
  readonly requestMeta?: Record<string, unknown>;
}

export type EntrypointHandler = (
  req: IncomingMessage,
  res: ServerResponse,
  ctx: EntrypointContext,
) => Promise<void | null | undefined>;

export class EntrypointRegistry {
  private readonly handlers = new Map<string, Promise<EntrypointHandler>>();

  /**
   * @param root absolute path the manifest's repo-root-relative `filePath`s
   * resolve against — the staging root, which is `process.cwd()` at runtime.
   * @param manifest used only to explain a failed load; see {@link ownedRouteError}.
   */
  public constructor(
    private readonly root: string,
    private readonly manifest?: AdapterManifest,
  ) {}

  public load(entrypoint: AdapterEntrypoint): Promise<EntrypointHandler> {
    let handler = this.handlers.get(entrypoint.filePath);
    if (!handler) {
      handler = loadEntrypointHandler(this.root, entrypoint, this.manifest);
      // Cached as the promise so two concurrent first requests for one route
      // share a single (expensive) module load.
      this.handlers.set(entrypoint.filePath, handler);
    }
    return handler;
  }

  /** Number of distinct files loaded. Reported in cold-start logs. */
  public get loadedCount(): number {
    return this.handlers.size;
  }
}

async function loadEntrypointHandler(
  root: string,
  entrypoint: AdapterEntrypoint,
  manifest?: AdapterManifest,
): Promise<EntrypointHandler> {
  const absolute = join(root, entrypoint.filePath);
  let exports: unknown;
  try {
    exports = await loadBuiltModule(absolute);
  } catch (error) {
    throw new Error(
      `Could not load the entrypoint for "${entrypoint.id}" from ` +
        `"${absolute}" (manifest filePath "${entrypoint.filePath}", type ` +
        `"${entrypoint.type}"). The deployment package is incomplete.` +
        ownedRouteError(entrypoint, manifest),
      { cause: error },
    );
  }
  return requireFunctionExport<EntrypointHandler>(
    exports,
    "handler",
    () => `The entrypoint for "${entrypoint.id}" at "${absolute}"`,
  );
}

/**
 * The one thing splitting can break that nothing else can: a request arriving at
 * a function whose package does not contain the route.
 *
 * Every group ships the same manifest, so the function knows the route exists and
 * which group owns it; what it does not have is the file. Without this the
 * symptom is a module-not-found on a path nobody wrote, and the cause — a
 * CloudFront behavior or API Gateway resource pointing at the wrong function — is
 * several layers away. With it, the error names both groups.
 */
function ownedRouteError(
  entrypoint: AdapterEntrypoint,
  manifest?: AdapterManifest,
): string {
  const groups = manifest?.groups;
  const self = process.env.CDK_NEXTJS_FUNCTION_GROUP;
  if (!groups || !self) {
    return "";
  }
  const templates = Object.entries(manifest?.entrypoints ?? {})
    .filter(([, candidate]) => candidate.id === entrypoint.id)
    .map(([template]) => template);
  const owner = Object.entries(groups).find(([, owned]) =>
    owned.some((template) => templates.includes(template)),
  )?.[0];
  if (!owner || owner === self) {
    return "";
  }
  return (
    ` This function is \`functionGroups\` group "${self}", but this route was ` +
    `packaged into group "${owner}" — so the request reached the wrong function. ` +
    `Check that the route pattern in group "${owner}" covers the URL that was ` +
    `requested: a pattern can be too narrow at the edge while still claiming the ` +
    `route at build time (for example "/reports/**" claims "/reports/[id]" but ` +
    `the CloudFront behavior it becomes, "reports/*", does not match "/reports").`
  );
}
