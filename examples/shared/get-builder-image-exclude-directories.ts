import { readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * Excludes unnecessary context from builder image docker build which results
 * in less docker build cache busts (faster builds).
 *
 * This solution is bandaid fix. See cdk-nextjs/examples/turbo
 */
export function getBuilderImageExcludeDirectories(): string[] {
  const include = [
    "app-playground",
    "pnpm-lock.yaml",
    "pnpm-workspace.yaml",
    "tsconfig.json",
    "package.json",
  ];
  const dirname = import.meta.dirname;
  return [
    "**/node_modules",
    "**/.next",
    ...readdirSync(join(dirname, "..")).filter(
      (name) => !include.includes(name),
    ),
  ];
}
