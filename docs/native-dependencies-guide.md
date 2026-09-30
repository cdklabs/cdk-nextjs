# Native Dependencies Guide

`next build` traces native addons (`.node` files) from the machine it runs on.
cdk-nextjs swaps `sharp` for the platform your app deploys to, but nothing else.
Any other native dependency built on a Mac, or on an x64 CI runner deploying
arm64, is staged for the wrong platform and fails with `MODULE_NOT_FOUND` or
`ERR_DLOPEN_FAILED` on the first request that loads it.

Synth warns about this, naming each staged package whose addons are all for a
platform other than the target:

```
[WARNING] /MyStack/Nextjs/NextjsBuild: [cdk-nextjs] Deployment root "default"
has native binaries built for a platform other than linux-arm64, which it runs
on: node_modules/@valkey/valkey-glide-darwin-arm64. ...
[ack: cdk-nextjs:foreignNativeBinaries]
```

The target is:

| Construct            | Target                                     |
| -------------------- | ------------------------------------------ |
| `*Functions`         | `linux-<arch>` glibc (Amazon Linux 2023)   |
| `*Containers`        | `linux-<arch>` musl (`node:24-alpine`)     |

`<arch>` is the Lambda's architecture for Functions (`arm64` or `x64`), and the
synth machine's for Containers.

There are three ways to fix it.

## 1. Build on the target platform

Run synth on a Linux runner of the architecture you deploy. Nothing else to do.

## 2. Stage the target's package after `next build` (any package manager)

Most native libraries ship each platform as its own package
(`@valkey/valkey-glide-linux-arm64-gnu`, `@node-rs/argon2-linux-arm64-gnu`, …),
pinned in the main package's `optionalDependencies`. After `next build`, remove
the build machine's variant from the staged output and extract the target's in
its place, the way cdk-nextjs does for `sharp`. Your local `node_modules` is
untouched, so local dev keeps working.

Run the script from `buildCommand`, which runs in your Next.js project directory
before cdk-nextjs zips the staged output:

```ts
new NextjsGlobalFunctions(this, "Nextjs", {
  buildDirectory: "./app",
  buildCommand: "npm run build && node scripts/stage-native.mjs arm64",
  overrides: {
    nextjsFunctions: { functionProps: { architecture: Architecture.ARM_64 } },
  },
});
```

With `skipBuild: true`, `buildCommand` doesn't run, so run the script yourself
after your own build.

`scripts/stage-native.mjs`, for `@valkey/valkey-glide` on Lambda. Edit the
constants for your package; for Containers, use the `-musl` variant.

```js
// Replaces a native package's platform variant in the cdk-nextjs staged build
// with the one for the deploy target.
// Usage: node scripts/stage-native.mjs <arm64|x64>
import { execFileSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  unlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const arch = process.argv[2];
if (arch !== "arm64" && arch !== "x64") {
  throw new Error(`stage-native: expected "arm64" or "x64", got "${arch}"`);
}

// Edit these for your package.
const scope = "@valkey";
const name = "valkey-glide";
// Lambda's managed runtime uses glibc; Containers use `-musl`.
const target = `${scope}/${name}-linux-${arch}-gnu`;

// Platform packages are `<scope>/<name>-<os>-<arch>[-<libc>]` links and
// directories, plus their pnpm store directories (`<scope>+<name>-…`). Match
// the platform, not only the prefix: Turbopack links the main package as
// `<name>-<hash>`.
const platform = new RegExp(`^(?:${scope}\\+)?${name}-(?:darwin|linux|win32)-`);
const isPlatformPackage = (parent, entry) =>
  platform.test(entry) &&
  (parent.endsWith(scope) || entry.startsWith(`${scope}+`));

// One deployment root without `functionGroups`, one per group with them.
const adapter = join(".next", "cdk-nextjs-adapter");
const groups = join(adapter, "groups");
const roots = [
  join(adapter, "app"),
  ...(existsSync(groups)
    ? readdirSync(groups).map((group) => join(groups, group))
    : []),
].filter((root) => existsSync(root));

for (const root of roots) {
  let version;
  const pending = [root];
  for (let dir = pending.pop(); dir !== undefined; dir = pending.pop()) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (isPlatformPackage(dir, entry.name)) {
        if (entry.isSymbolicLink()) {
          unlinkSync(path);
        } else {
          rmSync(path, { recursive: true, force: true });
        }
      } else if (entry.isDirectory()) {
        if (entry.name === name && dir.endsWith(scope)) {
          const manifest = JSON.parse(
            readFileSync(join(path, "package.json"), "utf8"),
          );
          version = manifest.optionalDependencies?.[target];
        }
        pending.push(path);
      }
    }
  }
  if (!version) {
    continue; // This root doesn't use the package.
  }

  // The root's node_modules is on the resolution path of the staged package
  // and of the app's server chunks.
  const tmp = mkdtempSync(join(tmpdir(), "stage-native-"));
  const tarball = execFileSync("npm", ["pack", `${target}@${version}`, "--silent"], {
    cwd: tmp,
    encoding: "utf8",
  }).trim();
  execFileSync("tar", ["-xzf", tarball], { cwd: tmp });
  // A copy, not a rename: the temporary directory can be on another file system.
  cpSync(join(tmp, "package"), join(root, "node_modules", target), {
    recursive: true,
  });
  rmSync(tmp, { recursive: true, force: true });
  console.log(`stage-native: staged ${target}@${version} in ${root}`);
}
```

The script depends on cdk-nextjs's staged layout (`.next/cdk-nextjs-adapter/app`
and `.next/cdk-nextjs-adapter/groups/<name>`), which can change between minor
versions. Libraries that don't ship per-platform packages (they build from
source at install, or bundle every platform's prebuild in one package) need
approach 1.

## 3. Install the target's variant with pnpm

pnpm can install other platforms' optional dependencies next to your own. Keep
`current` in the list so local dev still gets the host's variant:

```yaml
# pnpm-workspace.yaml
supportedArchitectures:
  os: [current, linux]
  cpu: [current, arm64]
  libc: [current, glibc]
```

This applies to every package in the workspace, and installs every combination
of the listed values. Tracing still only follows the variant that loads on the
build machine, so add the target's with Next.js's `outputFileTracingIncludes`
and drop the host's with `outputFileTracingExcludes`. Both are needed: the
host's package stays traced beside the one you add, and still has only a
foreign addon. Under pnpm both live in `node_modules/.pnpm`, so the globs
match the store directories, not `node_modules/<scope>/<name>`. Approach 2 is
usually simpler.

npm's `--os`/`--cpu` install flags replace the host's platform instead of adding
to it, which breaks local dev, so use approach 2 with npm.

## Optional native dependencies

Some packages load an addon inside `try`/`catch` and fall back to JavaScript
without it: `ws` with `bufferutil`/`utf-8-validate`, and `fsevents`. Their
foreign addon never loads, so the app works as deployed. Acknowledge the
warning:

```ts
import { Annotations } from "aws-cdk-lib";

Annotations.of(nextjs).acknowledgeWarning("cdk-nextjs:foreignNativeBinaries");
```

To fail synth on it instead, run `cdk synth --strict`.
