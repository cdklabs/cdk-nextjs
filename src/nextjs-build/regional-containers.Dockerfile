#checkov:skip=CKV_DOCKER_2: healthcheck run by ALB and ECS
#checkov:skip=CKV_DOCKER_7: latest tag is ok to use for local builder container
# Modified from: https://github.com/vercel/next.js/blob/canary/examples/with-docker/Dockerfile
ARG BUILDER_IMAGE_ALIAS=cdk-nextjs/builder:latest
FROM $BUILDER_IMAGE_ALIAS AS builder
# Production image, copy all the files and run next
FROM public.ecr.aws/docker/library/node:22-alpine AS runner
# Check https://github.com/nodejs/docker-node/tree/b4117f9333da4138b03a546ec926ef50a31506c3#nodealpine to understand why libc6-compat might be needed.
RUN apk add --no-cache libc6-compat
WORKDIR /app

ENV NODE_ENV=production
# Uncomment the following line in case you want to disable telemetry during runtime.
# ENV NEXT_TELEMETRY_DISABLED 1

RUN addgroup --system --gid 1001 nodejs
RUN adduser --system --uid 1001 nextjs

ARG RELATIVE_PATH_TO_PACKAGE
COPY --from=builder --chown=nextjs:nodejs /app/$RELATIVE_PATH_TO_PACKAGE/.next/standalone ./
# html,rsc,body,meta files don't need to be in compute container b/c they're handled by cdk-nextjs-cache-handler.cjs
RUN find . -type f \( -name "*.html" -o -name "*.rsc" -name "*.body" -name "*.meta" \) -delete
COPY --from=builder --chown=nextjs:nodejs /app/cdk-nextjs-cache-handler.cjs ./$RELATIVE_PATH_TO_PACKAGE/
# static properties needed b/c we don't have cloudfront to serve them from s3
COPY --from=builder --chown=nextjs:nodejs /app/$RELATIVE_PATH_TO_PACKAGE/.next/static ./$RELATIVE_PATH_TO_PACKAGE/.next/static
ARG BUILD_ID
ARG CACHE_PATH
ARG DATA_CACHE_PATH
ARG IMAGE_CACHE_PATH
ARG MOUNT_PATH
ARG PUBLIC_PATH
RUN sed -i 's/"env":{},/"env":{},cacheHandler:"\.\.\/cdk-nextjs-cache-handler.cjs",/g' ./$RELATIVE_PATH_TO_PACKAGE/server.js && \
  # locally in this docker image the paths where EFS will be mounted need to exist for symlinks to be made
  mkdir -p $MOUNT_PATH/$BUILD_ID/$DATA_CACHE_PATH && \
  mkdir -p $MOUNT_PATH/$BUILD_ID/$IMAGE_CACHE_PATH && \
  mkdir -p $MOUNT_PATH/$BUILD_ID/$PUBLIC_PATH && \
  # delete if exists so that symlinks can be made; image cache doesn't exist at build time
  rm -rf ./$RELATIVE_PATH_TO_PACKAGE/$DATA_CACHE_PATH && \
  rm -rf ./$RELATIVE_PATH_TO_PACKAGE/$PUBLIC_PATH && \
  # create .next/cache if doesn't exist. won't exist if no cached fetch data.
  mkdir -p ./$RELATIVE_PATH_TO_PACKAGE/$CACHE_PATH && \
  # `ln -s <src_file> <target_file>` such that accessing <target_file> accesses <src_file>
  ln -s $MOUNT_PATH/$BUILD_ID/$DATA_CACHE_PATH ./$RELATIVE_PATH_TO_PACKAGE/$DATA_CACHE_PATH && \
  ln -s $MOUNT_PATH/$BUILD_ID/$IMAGE_CACHE_PATH ./$RELATIVE_PATH_TO_PACKAGE/$IMAGE_CACHE_PATH && \
  ln -s $MOUNT_PATH/$BUILD_ID/$PUBLIC_PATH ./$RELATIVE_PATH_TO_PACKAGE/$PUBLIC_PATH && \
  # chown needs to be at end after all files are added so that nextjs:nodejs can access all files
  chown -R nextjs:nodejs $MOUNT_PATH/$BUILD_ID

USER nextjs

EXPOSE 3000

ENV PORT=3000

# server.js is created by next build from the standalone output
# https://nextjs.org/docs/pages/api-reference/next-config-js/output
# CMD will be overwritten by ECS Task Definition
CMD HOSTNAME="0.0.0.0" node server.js