import { NextConfig } from 'next';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// The repo root, not examples/: the adapter points `cacheHandler` at an
// absolute path inside cdk-nextjs's own lib/ (node_modules/cdk-nextjs is
// symlinked to the repo root here), and Turbopack refuses any module that
// resolves outside its root.
const rootWorkspace = path.join(fileURLToPath(import.meta.url), '..', '..', '..');

const nextConfig: NextConfig = {
  experimental: {
    turbopackFileSystemCacheForBuild: true,
  },
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
  // typedRoutes: true,
  turbopack: {
    root: rootWorkspace,
  },
};

export default nextConfig;
