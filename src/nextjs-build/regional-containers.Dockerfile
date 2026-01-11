#checkov:skip=CKV_DOCKER_2: healthcheck run by ALB and ECS
#checkov:skip=CKV_DOCKER_7: latest tag is ok to use for local builder container
# Modified from: https://github.com/vercel/next.js/blob/canary/examples/with-docker/Dockerfile

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
# Copy from local build output instead of builder image
COPY --chown=nextjs:nodejs .next/standalone ./
# html,rsc,body,meta files don't need to be in compute container b/c they're handled by cdk-nextjs-cache-handler.cjs
RUN find . -type f \( -name "*.html" -o -name "*.rsc" -name "*.body" -name "*.meta" \) -delete
# static properties needed b/c we don't have cloudfront to serve them from s3
COPY --chown=nextjs:nodejs .next/static ./$RELATIVE_PATH_TO_PACKAGE/.next/static
ARG BUILD_ID
RUN sed -i 's/"env":{},/"env":{},cacheHandler:"\.\.\/cdk-nextjs-cache-handler.cjs",/g' ./$RELATIVE_PATH_TO_PACKAGE/server.js

USER nextjs

EXPOSE 3000

ENV PORT=3000

# server.js is created by next build from the standalone output
# https://nextjs.org/docs/pages/api-reference/next-config-js/output
# CMD will be overwritten by ECS Task Definition
CMD HOSTNAME="0.0.0.0" node server.js