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
# Add SSM Parameter Store and Secrets Manager extensions
COPY --from=public.ecr.aws/aws-lambda-extensions/aws-lambda-parameters-and-secrets-extension:latest-arm64 /opt/extensions/ /opt/extensions/
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

USER nextjs

EXPOSE 3000

ENV PORT 3000