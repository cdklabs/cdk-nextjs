#checkov:skip=CKV_DOCKER_2: healthcheck not needed for Custom Resource
#checkov:skip=CKV_DOCKER_3: lambda container creates user by default
#checkov:skip=CKV_DOCKER_7: latest tag is ok to use for local builder container
ARG BUILDER_IMAGE_ALIAS=cdk-nextjs/builder:latest
FROM $BUILDER_IMAGE_ALIAS AS builder
FROM public.ecr.aws/lambda/nodejs:22 AS runner
# do not set WORKDIR b/c it's configured by public.ecr.aws/lambda/nodejs:22 to be /var/task for lambda to run

ARG RELATIVE_PATH_TO_PACKAGE
ARG PUBLIC_PATH
COPY --from=builder /app/$RELATIVE_PATH_TO_PACKAGE/$PUBLIC_PATH /app/$PUBLIC_PATH
# 1. see src/nextjs-assets-deployment.ts's #createCustomResource method to see what
# we copy from this resulting image to S3 and EFS
# 2. we don't copy from /app/$RELATIVE_PATH_TO_PACKAGE/.next/standalone like in
# compute images because we need .next/cache folder which doesn't exist within standalone
COPY --from=builder /app/$RELATIVE_PATH_TO_PACKAGE/.next /app/.next
# create fetch-cache if not created by next build
RUN mkdir -p /app/.next/cache/fetch-cache
# copy bundled custom resource handler
COPY ./index.js ./patch-fetch.js ./

CMD ["index.handler"]