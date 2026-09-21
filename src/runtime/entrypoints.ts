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
import { AdapterEntrypoint } from "./manifest";

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
   */
  public constructor(private readonly root: string) {}

  public load(entrypoint: AdapterEntrypoint): Promise<EntrypointHandler> {
    let handler = this.handlers.get(entrypoint.filePath);
    if (!handler) {
      handler = loadEntrypointHandler(this.root, entrypoint);
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
): Promise<EntrypointHandler> {
  const absolute = join(root, entrypoint.filePath);
  let exports: unknown;
  try {
    exports = await loadBuiltModule(absolute);
  } catch (error) {
    throw new Error(
      `Could not load the entrypoint for "${entrypoint.id}" from ` +
        `"${absolute}" (manifest filePath "${entrypoint.filePath}", type ` +
        `"${entrypoint.type}"). The deployment package is incomplete.`,
      { cause: error },
    );
  }
  return requireFunctionExport<EntrypointHandler>(
    exports,
    "handler",
    () => `The entrypoint for "${entrypoint.id}" at "${absolute}"`,
  );
}
