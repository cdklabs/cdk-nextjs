FROM public.ecr.aws/docker/library/node:22-alpine
# Check https://github.com/nodejs/docker-node/tree/b4117f9333da4138b03a546ec926ef50a31506c3#nodealpine to understand why libc6-compat might be needed.
RUN apk add --no-cache libc6-compat
WORKDIR /app
COPY ./json/ .
ENV HUSKY=0
RUN npm install -g corepack@latest && corepack enable pnpm && pnpm install --frozen-lockfile
COPY ./full/ ./cdk-nextjs-load-env-vars.sh ./
ARG BUILD_COMMAND
ARG RELATIVE_PATH_TO_WORKSPACE
RUN \
  if [ -f ./cdk-nextjs-load-env-vars.sh ]; then \
    chmod u+x ./cdk-nextjs-load-env-vars.sh && \
    . ./cdk-nextjs-load-env-vars.sh; \
  fi && \
  cd $RELATIVE_PATH_TO_WORKSPACE && \
  $BUILD_COMMAND