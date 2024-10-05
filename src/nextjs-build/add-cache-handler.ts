import { existsSync, readFileSync, writeFileSync } from "fs";

/**
 * For `NextjsGlobalFunctions`, adds custom [Cache Handler](https://nextjs.org/docs/app/api-reference/next-config-js/incrementalCacheHandlerPath)
 * so that time-based revalidation works. In serverless environment, functions
 * spin down after request is complete but Next.js depends upon compute to still
 * be running for time-based revalidation to work properly so we need to perform
 * work async and use SQS Queue to do so.
 */
function addCacheHandler(requiredServerFilesPath: string) {
  if (!existsSync(requiredServerFilesPath)) {
    throw new Error(
      `Could not find required server files path: ${requiredServerFilesPath}`,
    );
  }
  const requiredServerFiles = JSON.parse(
    readFileSync(requiredServerFilesPath, {
      encoding: "utf-8",
    }),
  );
  requiredServerFiles.config.cacheHandler = "../cache-handler.cjs";
  writeFileSync(requiredServerFilesPath, JSON.stringify(requiredServerFiles));
}

const [requiredServerFilesPath] = process.argv.slice(2);
addCacheHandler(requiredServerFilesPath);
