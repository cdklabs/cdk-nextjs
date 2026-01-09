import { NextConfig } from 'next';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rootWorkspace = path.join(fileURLToPath(import.meta.url), '..', '..');

const nextConfig: NextConfig = {
  output: 'standalone',
  // needed for NextjsRegionalFunctions without custom domain. see examples/regiona-functions/app.ts
  basePath: process.env['NEXTJS_BASE_PATH'],
  reactCompiler: true,
  // typedRoutes: true,
  turbopack: {
    root: rootWorkspace,
  },
};

export default nextConfig;
