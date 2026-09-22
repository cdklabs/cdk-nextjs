import { NextConfig } from 'next';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rootWorkspace = path.join(fileURLToPath(import.meta.url), '..', '..');

const nextConfig: NextConfig = {
  // Partial Prerendering. `experimental.ppr` was merged into this in Next.js
  // 16.3, so this is also what the PPR e2e exercises.
  cacheComponents: true,
  experimental: {
    turbopackFileSystemCacheForBuild: true,
  },
  // `adapterPath` is deliberately unset here: cdk-nextjs sets
  // `NEXT_ADAPTER_PATH` on the build it runs, so every e2e run over this app
  // covers the zero-config path. `examples/pages-i18n` sets it explicitly,
  // because its build is run by `scripts/capture-adapter-fixture.mjs` rather
  // than by the constructs — the case where the config entry is still required.
  // needed for NextjsRegionalFunctions with API GW which adds /prod base path by default
  // see examples/regional-functions/app.ts
  basePath: process.env['NEXTJS_BASE_PATH'],
  images: {
    // allows the image-optimization example page to reference an absolute
    // image URL, to test the fetchExternalImage path of the image
    // optimization handler alongside the local/S3-backed images below.
    remotePatterns: [
      {
        protocol: 'https',
        hostname: 'raw.githubusercontent.com',
        pathname: '/cdklabs/cdk-nextjs/**',
      },
    ],
  },
  reactCompiler: true,
  // typedRoutes: true,
  turbopack: {
    root: rootWorkspace,
  },
};

export default nextConfig;
