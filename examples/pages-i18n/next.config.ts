import { NextConfig } from "next";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootWorkspace = path.join(fileURLToPath(import.meta.url), "..", "..");

const nextConfig: NextConfig = {
  adapterPath: import.meta.resolve("cdk-nextjs/adapter"),
  i18n: {
    locales: ["en-US", "fr", "nl-NL"],
    defaultLocale: "en-US",
    domains: [
      {
        domain: "example.fr",
        defaultLocale: "fr",
      },
    ],
  },
  turbopack: {
    root: rootWorkspace,
  },
};

export default nextConfig;
