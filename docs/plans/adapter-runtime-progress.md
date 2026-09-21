# Adapter runtime: implementation progress

Running log for the branch implementing `docs/plans/adapter-runtime-release.md`.

**Purpose.** The plan says what to build; this file says what actually happened.
It exists so a session with zero prior context — or one resuming after a
compaction — can pick up the *facts* without reading a transcript. Write for that
reader.

**How to maintain it.** Append a section at every commit boundary in the plan's
"Commit order". Never rewrite history here; if an earlier entry turns out wrong,
add a later entry correcting it and say so. Keep entries short and factual — this
is not a narrative.

Each entry records:

- **Landed** — what the commit does, and its SHA once committed.
- **Decisions** — choices made that the plan left open, and the reason. A
  decision that contradicts the plan's "Decisions (do not relitigate)" section
  needs an explicit note saying why, and should have been raised with the user
  first.
- **Measured** — any number the plan asks to be recorded (packaging sizes,
  cold-start timings, response byte diffs). Include the command used, so it can
  be re-run.
- **Verified vs. assumed** — which behavior a test actually proves, and which is
  currently taken on faith. Be honest here; this is the field that decays fastest
  under compaction.
- **Deferred / open** — anything left undone, with enough detail to resume it.

## Environment

AWS testing uses:

```bash
export AWS_PROFILE="stickb-cdk-nextjs"
export AWS_REGION="us-east-1"
```

Build/verify commands (see `CLAUDE.md`): `pnpm compile`, `pnpm jest <file>`,
`pnpm eslint`, `pnpm bundle`. **Do not run `pnpm build`** — docgen hangs on
`node_modules`; CI regenerates `API.md`. Run `pnpm projen` after editing
`.projenrc.ts`.

The four deployed stacks `main-glbl-fns`, `main-rgnl-fns`, `main-glbl-cntnrs`,
`main-rgnl-cntrs` run the pre-branch path and are the byte-diff oracle. They stay
up for the duration of this work — do not delete or modify them.

## Status

| Plan step | State |
| --- | --- |
| 1 — build outputs (`onBuildComplete`) | done |
| 2 — dispatch via `@next/routing` | not started |
| 3 — middleware runner | not started |
| 4 — runtime core + two shells | not started |
| 5 — wire constructs, Functions to zip, Containers Dockerfiles | not started |
| 6 — delete `output: "standalone"` + dedicated image function | not started |
| 7 — splitting (`functionGroups`) | not started |
| 8 — tests, docs, breaking-changes | not started |

Exit criteria are tracked in the plan, not duplicated here. Record against them
in the final entry.

## Log

<!-- Append entries below. Newest last. -->

## Step 1 — build outputs (`onBuildComplete`)

**Landed** — commit `feat: stage the adapter manifest and deployment root at build time` (referenced by subject, not SHA: this entry ships inside that commit, so it cannot name its own hash)

- `src/runtime/manifest.ts` — the build → runtime → synth contract, exactly the
  shape in the plan's "Artifact contract". Deliberately **not** exported from
  `src/index.ts`, so it is exempt from JSII restrictions. Also holds the four
  path constants (`cdk-nextjs-adapter`, `app`, `manifest.json`,
  `cdk-nextjs-runtime`).
- `src/adapter/build-outputs.ts` — `buildAdapterManifest(ctx)` (pure) and
  `writeBuildOutputs(ctx)` (does the I/O). The split exists so the fixtures can
  be tested without a real filesystem. Covers the plan's jobs 1–6; job 7
  (init-cache seeding) is untouched. Also emits the `maxDuration` /
  `preferredRegion` warnings.
- `src/adapter/adapter.mts` — calls `writeBuildOutputs` at the top of
  `onBuildComplete` and logs the staged file count / bytes / entrypoint count.
  `modifyConfig` **still sets `output: "standalone"`**; both trees are produced
  until step 6. Nothing reads the manifest yet.
- `scripts/capture-adapter-fixture.mjs` — regenerates the fixtures from a real
  `next build`. Kept (not throwaway) because `ctx.routing`/`ctx.outputs` are
  Next.js's shapes and change between minors.
- `src/adapter/__fixtures__/{app-playground,app-playground-base-path,pages-i18n}.json`
  — real captures, trimmed and with absolute paths rewritten to `/repo`.
- `examples/pages-i18n/` — new minimal Pages Router example. Its only job is to
  produce the `outputs.pages` / `outputs.pagesApi` / `config.i18n` shapes, which
  an App Router build cannot: Next.js rejects `i18n` when an `app/` directory
  exists. Not deployed by any CDK example, not in the e2e suite.
- `src/adapter/build-outputs.test.ts` — 29 tests.

**Decisions**

1. **Symlinks in `assets` are recreated as symlinks, never dereferenced.** Under
   pnpm, `assets` values are frequently *directory* symlinks into the store
   (21 of 738 keys for app-playground, including `app-playground/node_modules/next`
   → the whole package). `copyFile` fails on those with `ENOTSUP`, and Next's own
   `copyTracedFiles` (`node_modules/next/dist/build/utils.js`, ~1012–1038) does
   `readlink` → `symlink` with a Windows junction fallback, so preserving them is
   the behavior-matching choice as well as the small one. `stageFiles` stages
   regular files first, then links, skipping any link whose destination is
   already real content, and dereferences (`cp -R --dereference`) only a link
   that resolves **outside** the staging root — those would dangle in Lambda.
2. **`assetsHashes` is used only as a conflict check, not as a staged-content
   integrity assertion.** The plan's job 3 asks for both. The integrity half is
   not implementable: the map mixes two hash schemes. `pushAsset` entries are
   `sha256(outputHashSalt + "file:" + content)` (verified reproducible for
   `.next/BUILD_ID`), but the large majority come from `loadNFT`, which copies
   NFT's own `fileHashes[i]` — a different, unsalted scheme that does not
   reproduce under either formula. Recorded as an explicit omission, not a
   silent skip. The conflict check (two outputs → one key → different hashes →
   throw) is implemented and tested.
3. **`entrypoints` is keyed by `output.pathname` verbatim, including `basePath`.**
   `pathname` is basePath-prefixed (`/prod/api/health`) while `id` is not
   (`/api/health`). The plan's step 2 passes `basePath` to `resolveRoutes`
   separately; whether `resolvedPathname` comes back prefixed is the open
   question that decides if this key needs stripping. Deliberately left prefixed
   for now because that is what the build reports; **step 2 must confirm it.**
4. **Fixtures are trimmed and human-readable, not faithful blobs.** A raw
   app-playground capture is ~9 MB, nearly all repeated `node_modules` paths in
   per-output `assets` maps. The script keeps a curated route allowlist, every
   non-`node_modules` asset key, and 8 `node_modules` keys per output, and
   records the trim in a `_meta` block. Chosen for reviewability of the diff.
5. **The staged tree is `rm -rf`'d before each build.** A previous build's tree
   is never additive: a deleted route leaves an orphan entrypoint and a renamed
   chunk leaves dead bytes inside the 250 MB budget.

**Measured**

| What | Value | Command |
| --- | --- | --- |
| app-playground staged | 738 files, 31.5 MB counted, 32 MB on disk, 122 entrypoints | `node scripts/capture-adapter-fixture.mjs app-playground`; `du -sh examples/app-playground/.next/cdk-nextjs-adapter/app` |
| same tree, dereferenced | 96 MB (3.0×) | `du -shL examples/app-playground/.next/cdk-nextjs-adapter/app` |
| symlinks in that tree | 21 | `find . -type l \| wc -l` in the staged tree |
| pages-i18n staged | 218 files, 6.7 MB, 18 entrypoints | `node scripts/capture-adapter-fixture.mjs pages-i18n` |
| fixture sizes | 227 KB / 228 KB / 168 KB | `ls -l src/adapter/__fixtures__` |
| tests | 29 passed, 98.7% statement coverage of `build-outputs.ts` | `pnpm jest src/adapter/build-outputs.test.ts` |

Both `.next/standalone` and the new tree are produced right now, so neither
number is the final packaged size. The zip-vs-image comparison the plan asks for
belongs to step 5.

Correction to an earlier in-session figure: the dereferenced cost was briefly
recorded as 430 MB. The reproducible number is 96 MB (`du -shL`), still under the
250 MB cap for this app. The argument for preserving symlinks rests on `ENOTSUP`
and on matching `copyTracedFiles`, not on breaching the cap.

**Verified vs. assumed**

Verified by test or direct measurement:

- The manifest produced from all three fixtures: version/buildId/
  `relativeProjectDir`, the four config fields, `routing` preserved verbatim
  (including `middlewareMatchers`), one entrypoint per invocable `pathname`, all
  entrypoint `filePath`s present in the staging plan, sorted-unique `pathnames`
  and `staticFiles`, and every staging key relative, POSIX, and inside the root.
- Staging for real on a tmpdir repo: a copied file, a preserved relative
  symlink, a dereferenced escaping symlink, `.env` + `.env.production` staged,
  `manifest.json` written and matching the returned manifest, and a stale file
  from a prior run removed.
- Every throw: edge runtime, hash conflict, `..` key, `cdk-nextjs-runtime/` key,
  two outputs claiming one pathname.
- The `maxDuration` warning fires exactly once from a real build (`pages-i18n`).
- The `assets` union is a complete standalone replacement, checked directly
  against the still-present standalone output: all 17 `requiredServerFiles.files`
  are in the union, and a sampled `page.js.nft.json`'s 167 entries are 100%
  covered.
- `next` 16.3.5 supplies `ctx.routing.middlewareMatchers`; 16.2.10 does not.
  `examples/node_modules` was stale at 16.2.10 and needed
  `pnpm install --frozen-lockfile` before the first capture was trustworthy.

Assumed, not yet proven:

- That a Lambda can actually boot from this tree. Nothing loads the manifest or
  requires an entrypoint yet; steps 2–4 are the first real test.
- That the three standalone-only contributions (its generated `server.js`, its
  root `package.json` shim, `.env`/`.env.production`) are the complete gap. Only
  the env files are handled here, because the other two are replaced by our own
  runtime in step 4.
- Byte-for-byte response parity with the deployed oracle stacks — step 5+.

**Deferred / open**

- **Step 2 must decide the basePath question** in decision 3 above: compare
  `resolveRoutes`' `resolvedPathname` against the basePath-prefixed
  `manifest.entrypoints` keys using the `app-playground-base-path` fixture. If it
  returns unprefixed templates, either the keys get stripped at build time or the
  lookup strips at runtime — pick one and record it.
- `routing.shouldNormalizeNextData` is `false` in the `pages-i18n` capture even
  though that build emits `/_next/data/<buildId>/…json` outputs, which are
  separate `entrypoints` keys pointing at the same file. Step 2 should confirm
  `resolveRoutes` handles those without our help.
- Pages Router `sourcePage` has no leading slash (`blog/[slug]`), unlike App
  Router (`/context/[categorySlug]/page`). Only affects error-message wording
  today.
- `preferredRegion` warning path and the "link destination already staged as real
  content" branch of `stageFiles` are the only uncovered lines; no fixture
  produces either.
- Fixtures are POSIX-keyed with a `/repo` placeholder, so the unit tests assume a
  POSIX `path.relative`. They would need adjusting to run on Windows; CI is
  Linux/macOS.
