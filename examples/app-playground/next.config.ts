import { NextConfig } from 'next';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rootWorkspace = path.join(fileURLToPath(import.meta.url), '..', '..');

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
