/*
  This file is compiled as defined in .projenrc.ts to be used as Next.js
  Custom Cache Handler. See: https://nextjs.org/docs/app/api-reference/next-config-js/incrementalCacheHandlerPath
*/
// eslint-disable-next-line import/no-extraneous-dependencies
import { CacheHandlerValue } from "next/dist/server/lib/incremental-cache";
// eslint-disable-next-line import/no-extraneous-dependencies
import FileSystemCache from "next/dist/server/lib/incremental-cache/file-system-cache";
// eslint-disable-next-line import/no-extraneous-dependencies
import {
  IncrementalCacheKindHint,
  IncrementalCacheValue,
} from "next/dist/server/response-cache";
import { CDK_NEXTJS_SERVER_DIST_DIR_ENV_VAR_NAME } from "../constants";

export default class CdkNextjsCacheHandler extends FileSystemCache {
  constructor(options: ConstructorParameters<typeof FileSystemCache>[0]) {
    /**
     * @example `/mnt/cdk-nextjs/{relativePathToPackage}/.next/server`
     * This allows us to tell Next.js `FileSystemCache` to write .next/cache/fetch-cache
     * data and .next/server/app/*.{html,rsc,meta,body} data to our EFS shared
     * file system. Note, we cannot control where optimized images are cached
     * through public Next.js APIs so we must symlink.
     *
     * Note, the `serverDistDir` defaults to current directory of the Next.js
     * app but we cannot use this because 1/ we want to share cache between
     * mutiple functions or containers via EFS mount 2/ lambda cannot write
     * to disk (unless /tmp or EFS mount)
     */
    const cdkNextjsServerDistDir =
      process.env[CDK_NEXTJS_SERVER_DIST_DIR_ENV_VAR_NAME];
    if (!cdkNextjsServerDistDir) {
      throw new Error(
        `${CDK_NEXTJS_SERVER_DIST_DIR_ENV_VAR_NAME} environment variable not set`,
      );
    }
    super({ ...options, serverDistDir: cdkNextjsServerDistDir });
  }

  get(
    cacheKey: string,
    ctx?:
      | {
          kindHint?: IncrementalCacheKindHint;
          revalidate?: number | false;
          fetchUrl?: string;
          fetchIdx?: number;
          tags?: string[];
          softTags?: string[];
        }
      | undefined,
  ): Promise<CacheHandlerValue | null> {
    // console.log(JSON.stringify({ cacheKey, ctx }, null, 2));
    return super.get(cacheKey, ctx);
  }

  set(
    pathname: string,
    data: IncrementalCacheValue | null,
    ctx: {
      revalidate?: number | false;
      fetchCache?: boolean;
      fetchUrl?: string;
      fetchIdx?: number;
      tags?: string[];
    },
  ): Promise<void> {
    // console.log(
    //   JSON.stringify(
    //     {
    //       pathname,
    //       data:
    //         data?.kind === "PAGE"
    //           ? { ...data, pageData: "...", html: "..." }
    //           : data,
    //       ctx,
    //     },
    //     null,
    //     2,
    //   ),
    // );
    return super.set(pathname, data, ctx);
  }
}
