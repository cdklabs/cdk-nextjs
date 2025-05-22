#checkov:skip=CKV_DOCKER_2: healthcheck not needed for local only container
#checkov:skip=CKV_DOCKER_3: user not required for local builder container
# Keep up to date with: https://github.com/cdklabs/cdk-nextjs/blob/main/src/nextjs-build/builder.Dockerfile
FROM public.ecr.aws/docker/library/node:22-alpine
# Check https://github.com/nodejs/docker-node/tree/b4117f9333da4138b03a546ec926ef50a31506c3#nodealpine to understand why libc6-compat might be needed.
RUN apk add --no-cache libc6-compat
WORKDIR /app
COPY ./json/ ./cdk-nextjs-load-env-vars.sh ./add-cache-handler.mjs ./cache-handler.cjs .
RUN npm install -g corepack@latest && corepack enable pnpm && pnpm install --frozen-lockfile
COPY ./full/ ./
ARG BUILD_COMMAND
ARG RELATIVE_PATH_TO_PACKAGE
RUN chmod u+x ./cdk-nextjs-load-env-vars.sh && . ./cdk-nextjs-load-env-vars.sh && \
    cd $RELATIVE_PATH_TO_PACKAGE && $BUILD_COMMAND
# after building, node_modules aren't needed anymore. this reduces image size
RUN rm -rf node_modules