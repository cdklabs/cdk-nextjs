#checkov:skip=CKV_DOCKER_2: healthcheck run by ALB and ECS
#checkov:skip=CKV_DOCKER_7: latest tag is ok to use for local builder container
# Modified from: https://github.com/vercel/next.js/blob/canary/examples/with-docker/Dockerfile
ARG BUILDER_IMAGE_ALIAS=cdk-nextjs/builder:latest
FROM $BUILDER_IMAGE_ALIAS AS builder
# Production image, copy all the files and run next
FROM public.ecr.aws/docker/library/node:22-alpine AS runner
WORKDIR /app

ENV NODE_ENV production
# Uncomment the following line in case you want to disable telemetry during runtime.
# ENV NEXT_TELEMETRY_DISABLED 1

RUN addgroup --system --gid 1001 nodejs
RUN adduser --system --uid 1001 nextjs

ARG RELATIVE_PATH_TO_WORKSPACE
COPY --from=builder --chown=nextjs:nodejs /app/$RELATIVE_PATH_TO_WORKSPACE/.next/standalone ./
# .rsc, .html, .body, and .meta files not needed because they're cached in EFS
RUN find ./ -type f \( -name "*.rsc" -o -name "*.html" -o -name "*.body" -o -name "*.meta" \) -delete
COPY --from=builder --chown=nextjs:nodejs /app/add-cache-handler.mjs /app/cache-handler.cjs ./
ARG MOUNT_PATH
ARG BUILD_ID
ARG SERVER_DIST_PATH
ARG IMAGE_CACHE_PATH
ARG CACHE_PATH
ARG PUBLIC_PATH
RUN node add-cache-handler.mjs ./$RELATIVE_PATH_TO_WORKSPACE/.next/required-server-files.json && \
  rm add-cache-handler.mjs && \
  # locally in this docker image these directories need to exists for symlinks but they'll be mounted by EFS later
  mkdir -p $MOUNT_PATH/$BUILD_ID/$SERVER_DIST_PATH && \
  mkdir -p $MOUNT_PATH/$BUILD_ID/$IMAGE_CACHE_PATH && \
  mkdir -p $MOUNT_PATH/$BUILD_ID/$PUBLIC_PATH && \
  chmod -R u+rw $MOUNT_PATH/$BUILD_ID && \
  # parent directory to ./$RELATIVE_PATH_TO_WORKSPACE/$IMAGE_CACHE_PATH needs to exist for symlink to be made
  mkdir -p ./$RELATIVE_PATH_TO_WORKSPACE/$CACHE_PATH && \
  # in order to soft link, target directory needs to be removed. $IMAGE_CACHE_PATH doesn't exist initially
  rm -rf ./$RELATIVE_PATH_TO_WORKSPACE/$SERVER_DIST_PATH && \
  rm -rf ./$RELATIVE_PATH_TO_WORKSPACE/$PUBLIC_PATH && \
  ln -s $MOUNT_PATH/$BUILD_ID/$SERVER_DIST_PATH ./$RELATIVE_PATH_TO_WORKSPACE/$SERVER_DIST_PATH && \
  ln -s $MOUNT_PATH/$BUILD_ID/$IMAGE_CACHE_PATH ./$RELATIVE_PATH_TO_WORKSPACE/$IMAGE_CACHE_PATH && \
  ln -s $MOUNT_PATH/$BUILD_ID/$PUBLIC_PATH ./$RELATIVE_PATH_TO_WORKSPACE/$PUBLIC_PATH

USER nextjs

EXPOSE 3000

ENV PORT 3000

# server.js is created by next build from the standalone output
# https://nextjs.org/docs/pages/api-reference/next-config-js/output
# CMD will be overwritten by ECS Task Definition
CMD HOSTNAME="0.0.0.0" node server.js