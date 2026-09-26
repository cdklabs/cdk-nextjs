import { NextConfig } from 'next';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rootWorkspace = path.join(fileURLToPath(import.meta.url), '..', '..');

/**
 * The app the load tests deploy (examples/load-tests). The README's
 * Performance numbers were measured with exactly this config, so changing it
 * (turning on `cacheComponents`, say) changes what they mean. No route may call
 * anything outside the stack under test.
 */
const nextConfig: NextConfig = {
  // See examples/app-playground/next.config.ts for why the examples resolve the
  // adapter from their own node_modules.
  adapterPath: import.meta.resolve('cdk-nextjs/adapter'),
  // NextjsRegionalFunctions serves under the API Gateway stage name
  basePath: process.env['NEXTJS_BASE_PATH'],
  turbopack: {
    root: rootWorkspace,
  },
};

export default nextConfig;
