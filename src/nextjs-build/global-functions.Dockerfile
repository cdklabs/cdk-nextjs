#checkov:skip=CKV_DOCKER_2: healthcheck run by AWS Lambda Web Adapter
#checkov:skip=CKV_DOCKER_7: latest tag is ok to use for local builder container
# Modified from: https://github.com/vercel/next.js/blob/canary/examples/with-docker/Dockerfile
ARG BUILDER_IMAGE_ALIAS=cdk-nextjs/builder:latest
FROM $BUILDER_IMAGE_ALIAS AS builder
# Production image, copy all the files and run next
FROM public.ecr.aws/docker/library/node:22-alpine AS runner
COPY --from=public.ecr.aws/awsguru/aws-lambda-adapter:0.9.1 /lambda-adapter /opt/extensions/lambda-adapter
WORKDIR /app

ENV NODE_ENV production
# Uncomment the following line in case you want to disable telemetry during runtime.
# ENV NEXT_TELEMETRY_DISABLED 1

RUN addgroup --system --gid 1001 nodejs
RUN adduser --system --uid 1001 nextjs

ARG RELATIVE_PATH_TO_WORKSPACE
COPY --from=builder --chown=nextjs:nodejs /app/$RELATIVE_PATH_TO_WORKSPACE/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/add-cache-handler.mjs /app/cache-handler.cjs ./
ARG MOUNT_PATH
ARG BUILD_ID
ARG SERVER_DIST_PATH
ARG IMAGE_CACHE_PATH
ARG PUBLIC_PATH
RUN node add-cache-handler.mjs ./$RELATIVE_PATH_TO_WORKSPACE/.next/required-server-files.json && \
  rm add-cache-handler.mjs && \
  mkdir -p $MOUNT_PATH/$BUILD_ID/$SERVER_DIST_PATH && \
  mkdir -p $MOUNT_PATH/$BUILD_ID/$IMAGE_CACHE_PATH && \
  mkdir -p $MOUNT_PATH/$BUILD_ID/$PUBLIC_PATH && \
  chmod -R u+rw $MOUNT_PATH/$BUILD_ID && \
  mkdir -p ./$RELATIVE_PATH_TO_WORKSPACE/$IMAGE_CACHE_PATH && \
  ln -s $MOUNT_PATH/$BUILD_ID/$SERVER_DIST_PATH ./$RELATIVE_PATH_TO_WORKSPACE/$SERVER_DIST_PATH && \
  ln -s $MOUNT_PATH/$BUILD_ID/$IMAGE_CACHE_PATH ./$RELATIVE_PATH_TO_WORKSPACE/$IMAGE_CACHE_PATH && \
  ln -s $MOUNT_PATH/$BUILD_ID/$PUBLIC_PATH ./$RELATIVE_PATH_TO_WORKSPACE/$PUBLIC_PATH

USER nextjs

EXPOSE 3000

ENV PORT 3000

# CMD will be overwritten by Lambda IaC