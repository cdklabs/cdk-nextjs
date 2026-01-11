import { NextConfig } from 'next';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rootWorkspace = path.join(fileURLToPath(import.meta.url), '..', '..');

const nextConfig: NextConfig = {
  output: 'standalone',
  experimental: {
    turbopackFileSystemCacheForBuild: true,
    // TODO: leverage in future to avoid having to use build a container and use lambda-web-adapter for Nextjs***Functions constructs
    adapterPath: import.meta.resolve('./cdk-nextjs-adapter.mjs'),
  },
  images: {
    customCacheHandler: true,
  },
  // needed for NextjsRegionalFunctions without custom domain. see examples/regiona-functions/app.ts
  basePath: process.env['NEXTJS_BASE_PATH'],
  reactCompiler: true,
  // typedRoutes: true,
  turbopack: {
    root: rootWorkspace,
  },
};

export default nextConfig;
