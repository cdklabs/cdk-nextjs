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
  // cdk-nextjs sets `NEXT_ADAPTER_PATH` on the build it runs, so an app
  // installed from npm needs none of this. The examples can't rely on it: they
  // depend on cdk-nextjs with `link:../..`, and resolving that symlink at synth
  // time lands outside `turbopack.root`, which makes Turbopack reject the
  // `cacheHandler` the adapter derives from its own location. `sync-cdk-nextjs` copies
  // the adapter into this app's `node_modules` instead, and this entry resolves
  // that copy — after the copy exists, since Next.js resolves `adapterPath`
  // during the build.
  adapterPath: import.meta.resolve('cdk-nextjs/adapter'),
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
  // Config-level routing, which `@next/routing` resolves and nothing else in this
  // app declares. All three get the `basePath` prefix from Next.js, so on
  // NextjsRegionalFunctions they are also a test of `/prod` surviving the trip.
  // See examples/e2e-tests/src/config-routing.test.ts.
  async redirects() {
    return [
      {
        source: '/e2e/redirect-from/:slug',
        destination: '/params/encoded/:slug',
        permanent: false,
      },
    ];
  },
  async headers() {
    return [
      {
        source: '/api/echo',
        headers: [{ key: 'x-e2e-config-header', value: 'from-next-config' }],
      },
    ];
  },
  async rewrites() {
    return {
      // Matches its own output while `?json=true` is still on the URL, which is
      // what made Next.js apply it a second time inside the entrypoint and
      // overwrite `from` (defect 29 in docs/plans/adapter-runtime-progress.md).
      // Scoped to a prefix so it cannot touch any other route.
      beforeFiles: [
        {
          source: '/e2e/rewrite/:path(.*)',
          has: [{ type: 'query', key: 'json', value: 'true' }],
          destination: '/e2e/rewrite/echo?from=/:path',
        },
      ],
    };
  },
  // typedRoutes: true,
  turbopack: {
    root: rootWorkspace,
  },
};

export default nextConfig;
