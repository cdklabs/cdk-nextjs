import { readdirSync } from "node:fs";
import { join } from "node:path";

export function getBuilderImageExcludeDirectories(example: string): string[] {
  const include = [
    "app-playground",
    "pnpm-lock.yaml",
    "pnpm-workspace.yaml",
    "tsconfig.json",
    "package.json",
    example,
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
