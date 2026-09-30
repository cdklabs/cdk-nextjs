# pages-i18n

The smallest Pages Router app that exercises the build-output shapes the App
Router cannot produce:

- `outputs.pages` and `outputs.pagesApi` (App Router builds leave both empty)
- `config.i18n`, which Next.js rejects when an `app/` directory is present

It exists only so `scripts/capture-adapter-fixture.mjs` can capture a real
`onBuildComplete` context for `src/adapter/__fixtures__/pages-i18n.json`. It is
not deployed by any CDK example and is not part of the e2e suite.

```bash
node scripts/capture-adapter-fixture.mjs pages-i18n   # from the repo root
```
