#checkov:skip=CKV_DOCKER_2: healthcheck not needed for local only container
#checkov:skip=CKV_DOCKER_3: user not required for local builder container
FROM public.ecr.aws/docker/library/node:22-alpine
# Check https://github.com/nodejs/docker-node/tree/b4117f9333da4138b03a546ec926ef50a31506c3#nodealpine to understand why libc6-compat might be needed.
RUN apk add --no-cache libc6-compat
WORKDIR /app
# It's preferrable to only copy package.json's and lockfiles, install, and then
# copy the rest of the code to efficiently utilize build cache. We don't do that
# here because it's highly customized based on a projects setup. See cdk-nextjs/examples/turbo.
COPY . .
# Install dependencies based on the preferred package manager
RUN \
  if [ -f yarn.lock ]; then yarn --frozen-lockfile; \
  elif [ -f package-lock.json ]; then npm ci; \
  elif [ -f pnpm-lock.yaml ]; then npm i -g corepack@latest && corepack enable pnpm && pnpm i --frozen-lockfile; \
  else echo "Lockfile not found." && exit 1; \
  fi
ARG BUILD_COMMAND
ARG RELATIVE_PATH_TO_PACKAGE
RUN cd $RELATIVE_PATH_TO_PACKAGE && {{INJECT_CDK_NEXTJS_BUILD_ENV_VARS}} $BUILD_COMMAND
RUN rm -rf node_modules && \
  # remove pnpm cache if exists
  command -v pnpm >/dev/null 2>&1 && rm -rf $(pnpm store path) || echo "pnpm not installed, skipping cache cleanup" && \
  # .next/cache/webpack used to speed up builds on subsequent `next build`
  rm -rf $RELATIVE_PATH_TO_PACKAGE/.next/cache/webpack && \
  # .next/trace used for debugging purposes
  rm $RELATIVE_PATH_TO_PACKAGE/.next/trace && \
  # not needed since we use .next/server in standalone
  rm -rf $RELATIVE_PATH_TO_PACKAGE/.next/server