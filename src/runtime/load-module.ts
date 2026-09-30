/**
 * Loading built Next.js modules out of the staged deployment tree.
 *
 * Shared by the middleware runner and the entrypoint registry, because the one
 * non-obvious part is the same for both: Turbopack emits **async modules** whose
 * `module.exports` is a `Promise`. Its keys live behind
 * `Symbol(turbopack exports)`, so `Object.keys` reports nothing and a
 * synchronous `require(...).handler` is `undefined` — which looks exactly like
 * Next.js having changed its template API. `await` covers both that and the
 * plain-CJS/webpack shape.
 */
import { createRequire } from "node:module";

/**
 * `createRequire` anchored to the module being loaded, rather than a bare
 * `require`: this file is bundled to ESM by esbuild, where the ambient `require`
 * resolves relative to `lib/runtime/`, not the staged app tree.
 */
export async function loadBuiltModule(absolutePath: string): Promise<unknown> {
  return createRequire(absolutePath)(absolutePath);
}

/** Pulls a named function export off a loaded module, or throws saying why not. */
export function requireFunctionExport<T>(
  exports: unknown,
  name: string,
  describe: () => string,
): T {
  const value = (exports as Record<string, unknown> | undefined)?.[name];
  if (typeof value !== "function") {
    throw new Error(
      `${describe()} does not export a \`${name}\` function (got ` +
        `${typeof value}). This means Next.js changed the shape of its build ` +
        `templates (next/dist/build/templates/).`,
    );
  }
  return value as T;
}
