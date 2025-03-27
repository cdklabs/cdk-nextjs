#checkov:skip=CKV_DOCKER_2: healthcheck run by ALB and ECS
#checkov:skip=CKV_DOCKER_7: latest tag is ok to use for local builder container
# Modified from: https://github.com/vercel/next.js/blob/canary/examples/with-docker/Dockerfile
ARG BUILDER_IMAGE_TAG
FROM $BUILDER_IMAGE_TAG as builder
# Production image, copy all the files and run next
FROM public.ecr.aws/docker/library/node:22-alpine as runner
WORKDIR /app

ENV NODE_ENV production
# Uncomment the following line in case you want to disable telemetry during runtime.
# ENV NEXT_TELEMETRY_DISABLED 1

RUN addgroup --system --gid 1001 nodejs
RUN adduser --system --uid 1001 nextjs

ARG RELATIVE_PATH_TO_WORKSPACE
COPY --from=builder --chown=nextjs:nodejs /app/$RELATIVE_PATH_TO_WORKSPACE/.next/standalone ./
ARG MOUNT_PATH
ARG DATA_CACHE_DIR
ARG FULL_ROUTE_CACHE_DIR
ARG IMAGE_CACHE_DIR
ARG PUBLIC_DIR
RUN mkdir -p $MOUNT_PATH/$DATA_CACHE_DIR && \
  mkdir -p $MOUNT_PATH/$FULL_ROUTE_CACHE_DIR && \
  mkdir -p $MOUNT_PATH/$IMAGE_CACHE_DIR && \
  mkdir -p $MOUNT_PATH/$PUBLIC_DIR && \
  chmod -R u+rw $MOUNT_PATH && \
  mkdir -p ./$RELATIVE_PATH_TO_WORKSPACE/.next/cache && \
  ln -s $MOUNT_PATH/$DATA_CACHE_DIR ./$RELATIVE_PATH_TO_WORKSPACE/.next/cache/fetch-cache && \
  ln -s $MOUNT_PATH/$IMAGE_CACHE_DIR ./$RELATIVE_PATH_TO_WORKSPACE/.next/cache/images && \
  ln -s $MOUNT_PATH/$PUBLIC_DIR ./$RELATIVE_PATH_TO_WORKSPACE/public && \
  ln -s $MOUNT_PATH/$FULL_ROUTE_CACHE_DIR ./$RELATIVE_PATH_TO_WORKSPACE/.next/server/app

USER nextjs

EXPOSE 3000

ENV PORT 3000

# server.js is created by next build from the standalone output
# https://nextjs.org/docs/pages/api-reference/next-config-js/output
# CMD will be overwritten by ECS Task Definition
CMD HOSTNAME="0.0.0.0" node server.js