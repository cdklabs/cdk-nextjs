/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'standalone',
  // needed for NextjsRegionalFunctions without custom domain. see examples/regiona-functions/app.ts
  basePath: process.env['NEXTJS_BASE_PATH'],
};

module.exports = nextConfig;
