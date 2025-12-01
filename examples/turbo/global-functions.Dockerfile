#checkov:skip=CKV_DOCKER_2: healthcheck run by AWS Lambda Web Adapter
#checkov:skip=CKV_DOCKER_7: latest tag is ok to use for local builder container
# Keep up to date with: https://github.com/cdklabs/cdk-nextjs/blob/main/src/nextjs-build/global-functions.Dockerfile
ARG BUILDER_IMAGE_ALIAS=cdk-nextjs/builder:latest
FROM $BUILDER_IMAGE_ALIAS AS builder
# Production image, copy all the files and run next
FROM public.ecr.aws/docker/library/node:22-alpine as runner
# Check https://github.com/nodejs/docker-node/tree/b4117f9333da4138b03a546ec926ef50a31506c3#nodealpine to understand why libc6-compat might be needed.
RUN apk add --no-cache libc6-compat
COPY --from=public.ecr.aws/awsguru/aws-lambda-adapter:0.9.1 /lambda-adapter /opt/extensions/lambda-adapter
# Add SSM Parameter Store and Secrets Manager extensions. See README for where this was downloaded from
COPY ./extensions/ /opt/extensions/
WORKDIR /app

# Below is not needed for this demo but still helpful for reference
# Download RDS certificate bundle for PostgreSQL SSL connections
RUN mkdir -p /etc/ssl/certs/rds \
    && wget -q -O /etc/ssl/certs/rds/us-east-1-bundle.pem https://truststore.pki.rds.amazonaws.com/us-east-1/us-east-1-bundle.pem \
    && chmod 644 /etc/ssl/certs/rds/us-east-1-bundle.pem
# postgres.js will pick up on tls ssl/tls certs via this env var
ENV NODE_EXTRA_CA_CERTS=/etc/ssl/certs/rds/us-east-1-bundle.pem

ENV NODE_ENV production
# Uncomment the following line in case you want to disable telemetry during runtime.
# ENV NEXT_TELEMETRY_DISABLED 1

RUN addgroup --system --gid 1001 nodejs
RUN adduser --system --uid 1001 nextjs

ARG RELATIVE_PATH_TO_PACKAGE
COPY --from=builder --chown=nextjs:nodejs /app/$RELATIVE_PATH_TO_PACKAGE/.next/standalone ./
# html,rsc,body,meta files don't need to be in compute container b/c they're handled by cdk-nextjs-cache-handler.cjs
RUN find . -type f \( -name "*.html" -o -name "*.rsc" -name "*.body" -name "*.meta" \) -delete
COPY --from=builder --chown=nextjs:nodejs /app/cdk-nextjs-cache-handler.cjs ./$RELATIVE_PATH_TO_PACKAGE/
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

ENV PORT 3000

# CMD will be overwritten by Lambda IaC