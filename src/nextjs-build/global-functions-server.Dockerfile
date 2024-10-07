#checkov:skip=CKV_DOCKER_2: healthcheck run by AWS Lambda Web Adapter
#checkov:skip=CKV_DOCKER_7: latest tag is ok to use for local builder container
# Modified from: https://github.com/vercel/next.js/blob/canary/examples/with-docker/Dockerfile
ARG BUILDER_IMAGE_TAG
FROM $BUILDER_IMAGE_TAG as builder
# Production image, copy all the files and run next
FROM public.ecr.aws/docker/library/node:20-alpine as runner
ARG MOUNT_PATH
COPY --from=public.ecr.aws/awsguru/aws-lambda-adapter:0.8.3 /lambda-adapter /opt/extensions/lambda-adapter
WORKDIR /app

ENV NODE_ENV production
# Uncomment the following line in case you want to disable telemetry during runtime.
# ENV NEXT_TELEMETRY_DISABLED 1

RUN addgroup --system --gid 1001 nodejs
RUN adduser --system --uid 1001 nextjs

ARG RELATIVE_PATH_TO_WORKSPACE
COPY --from=builder --chown=nextjs:nodejs /app/$RELATIVE_PATH_TO_WORKSPACE/.next/standalone ./
# removes 30MB+ reducing cold start by ~440ms
RUN rm -rf node_modules/.pnpm/@img+sharp-*
COPY --chown=nextjs:nodejs ./add-cache-handler.mjs ./cache-handler.cjs ./symlink-full-route-cache.mjs ./
ARG MOUNT_PATH
ARG DATA_CACHE_DIR
ARG FULL_ROUTE_CACHE_DIR
RUN node add-cache-handler.mjs ./$RELATIVE_PATH_TO_WORKSPACE/.next/required-server-files.json && \
  rm add-cache-handler.mjs && \
  mkdir -p $MOUNT_PATH/$DATA_CACHE_DIR && \
  mkdir -p $MOUNT_PATH/$FULL_ROUTE_CACHE_DIR && \
  chmod -R u+rw $MOUNT_PATH && \
  mkdir -p ./$RELATIVE_PATH_TO_WORKSPACE/.next/cache && \
  ln -s $MOUNT_PATH/$DATA_CACHE_DIR ./$RELATIVE_PATH_TO_WORKSPACE/.next/cache/fetch-cache && \
  node symlink-full-route-cache.mjs /app/$RELATIVE_PATH_TO_WORKSPACE/.next/server/app $MOUNT_PATH/$FULL_ROUTE_CACHE_DIR && \
  rm symlink-full-route-cache.mjs

USER nextjs

EXPOSE 3000

ENV PORT 3000

# CMD will be overwritten by Lambda IaC