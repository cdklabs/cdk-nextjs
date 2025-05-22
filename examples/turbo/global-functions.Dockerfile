#checkov:skip=CKV_DOCKER_2: healthcheck run by AWS Lambda Web Adapter
#checkov:skip=CKV_DOCKER_7: latest tag is ok to use for local builder container
# Keep up to date with: https://github.com/cdklabs/cdk-nextjs/blob/main/src/nextjs-build/global-functions.Dockerfile
ARG BUILDER_IMAGE_ALIAS=cdk-nextjs/builder:latest
FROM $BUILDER_IMAGE_ALIAS AS builder
# Production image, copy all the files and run next
FROM public.ecr.aws/docker/library/node:22-alpine as runner
COPY --from=public.ecr.aws/awsguru/aws-lambda-adapter:0.9.1 /lambda-adapter /opt/extensions/lambda-adapter
# Add SSM Parameter Store and Secrets Manager extensions
COPY --from=public.ecr.aws/aws-lambda-extensions/aws-lambda-parameters-and-secrets-extension:latest-arm64 /opt/extensions/ /opt/extensions/
WORKDIR /app

# Below is not needed for this demo but still helpful for reference
# Download RDS certificate bundle for PostgreSQL SSL connections
RUN mkdir -p /etc/ssl/certs/rds \
    && wget -q -O /etc/ssl/certs/rds/us-east-1-bundle.pem https://truststore.pki.rds.amazonaws.com/us-east-1/us-east-1-bundle.pem \
    && chmod 644 /etc/ssl/certs/rds/us-east-1-bundle.pem
# postgres.js will pick up on tls ssl/tls certs via this env var
ENV PGSSLROOTCERT=/etc/ssl/certs/rds/us-east-1-bundle.pem

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

# CMD will be overwritten by Lambda IaC