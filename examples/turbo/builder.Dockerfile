#checkov:skip=CKV_DOCKER_2: healthcheck not needed for local only container
#checkov:skip=CKV_DOCKER_3: user not required for local builder container
# Keep up to date with: https://github.com/cdklabs/cdk-nextjs/blob/main/src/nextjs-build/builder.Dockerfile
FROM public.ecr.aws/docker/library/node:22-alpine
# Check https://github.com/nodejs/docker-node/tree/b4117f9333da4138b03a546ec926ef50a31506c3#nodealpine to understand why libc6-compat might be needed.
RUN apk add --no-cache libc6-compat
WORKDIR /app
COPY ./json/ ./cdk-nextjs-cache-handler.cjs ./
RUN npm install -g corepack@latest && corepack enable pnpm && pnpm install --frozen-lockfile
COPY ./full/ ./
ARG BUILD_COMMAND
ARG RELATIVE_PATH_TO_PACKAGE
RUN cd $RELATIVE_PATH_TO_PACKAGE && {{INJECT_CDK_NEXTJS_BUILD_ENV_VARS}} NODE_OPTIONS="--max-old-space-size=8192" $BUILD_COMMAND
RUN rm -rf node_modules && \
  # remove pnpm cache if exists
  command -v pnpm >/dev/null 2>&1 && rm -rf $(pnpm store path) || echo "pnpm not installed, skipping cache cleanup" && \
  # .next/cache/webpack used to speed up builds on subsequent `next build`
  rm -rf $RELATIVE_PATH_TO_PACKAGE/.next/cache/webpack && \
  # .next/trace used for debugging purposes
  rm $RELATIVE_PATH_TO_PACKAGE/.next/trace && \
  # not needed since we use .next/server in standalone
  rm -rf $RELATIVE_PATH_TO_PACKAGE/.next/server