#checkov:skip=CKV_DOCKER_2: healthcheck not needed for Custom Resource
#checkov:skip=CKV_DOCKER_3: lambda container creates user by default
#checkov:skip=CKV_DOCKER_7: latest tag is ok to use for local builder container
ARG BUILDER_IMAGE_TAG
FROM $BUILDER_IMAGE_TAG as builder
FROM public.ecr.aws/lambda/nodejs:22 as runner

ARG RELATIVE_PATH_TO_WORKSPACE
COPY --from=builder --chown=nextjs:nodejs /app/$RELATIVE_PATH_TO_WORKSPACE/public /app/public
# see src/nextjs-assets-deployment.ts's #createCustomResource method to see what
# we copy from within this resulting image in /app/.next to S3 and EFS
COPY --from=builder --chown=nextjs:nodejs /app/$RELATIVE_PATH_TO_WORKSPACE/.next /app/.next
# create fetch-cache if not created by next build
RUN mkdir -p /app/.next/cache/fetch-cache
# copy bundled custom resource handler
COPY --chown=nextjs:nodejs ./index.js ./patch-fetch.js ./

CMD ["index.handler"]