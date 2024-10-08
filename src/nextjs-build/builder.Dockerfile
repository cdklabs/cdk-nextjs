#checkov:skip=CKV_DOCKER_2: healthcheck not needed for local only container
#checkov:skip=CKV_DOCKER_3: user not required for local builder container
FROM public.ecr.aws/docker/library/node:20-alpine
# Check https://github.com/nodejs/docker-node/tree/b4117f9333da4138b03a546ec926ef50a31506c3#nodealpine to understand why libc6-compat might be needed.
RUN apk add --no-cache libc6-compat
WORKDIR /app
# It's preferrable to only copy package.json's and lockfiles, install, and then
# copy the rest of the code to efficiently utilize build cache. We don't do that
#$ here because it's highly customized based on a projects setup. We recommend
# developers use `overrides.nextjsXX.nextjsBuildProps.builderImageProps.srcDockerfilePath`
# to optimize for their setup.
COPY . .
# Install dependencies based on the preferred package manager
RUN \
  if [ -f yarn.lock ]; then yarn --frozen-lockfile; \
  elif [ -f package-lock.json ]; then npm ci; \
  elif [ -f pnpm-lock.yaml ]; then corepack enable pnpm && pnpm i --frozen-lockfile; \
  else echo "Lockfile not found." && exit 1; \
  fi
ARG BUILD_COMMAND
ARG RELATIVE_PATH_TO_WORKSPACE
RUN if [ -f ./cdk-nextjs-load-env-vars.sh ]; then chmod u+x ./cdk-nextjs-load-env-vars.sh && . ./cdk-nextjs-load-env-vars.sh; fi
RUN cd $RELATIVE_PATH_TO_WORKSPACE && $BUILD_COMMAND
# after building, node_modules aren't needed anymore. this reduces image size by over 50mb
RUN rm -rf node_modules