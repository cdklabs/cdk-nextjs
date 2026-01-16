# cdk-nextjs Development Guide for AI Assistants

## Project Overview

This is an AWS CDK construct library for deploying Next.js applications to AWS. It treats Next.js as a black box to minimize reliance on internal APIs, provides 4 distinct architecture patterns (Global Functions/Containers, Regional Functions/Containers), and uses projen for project management.

## Architecture Patterns

Four root constructs in [src/root-constructs/](../src/root-constructs/):

1. **NextjsGlobalFunctions**: Lambda + CloudFront (lowest cost, cold starts)
2. **NextjsGlobalContainers**: Fargate + CloudFront (predictable traffic, low latency)
3. **NextjsRegionalFunctions**: Lambda + API Gateway (GovCloud compatible, no CDN)
4. **NextjsRegionalContainers**: Fargate + ALB (GovCloud compatible, no CDN)

All extend `NextjsBaseConstruct` which orchestrates: `NextjsBuild` → compute layer (`NextjsFunctions`/`NextjsContainers`) → optional `NextjsDistribution` (CloudFront) → `NextjsPostDeploy` (cleanup).

## Key Components

### Adapter System ([src/adapter/](../src/adapter/))

- **adapter.mts**: Next.js adapter that sets `output: "standalone"` and configures cache handler
- **cache-handler.ts**: Multi-tier cache (memory → S3+DynamoDB) with circuit breaker pattern
- **s3-dynamo-cache-handler.ts**: S3 storage for all Next.js cache kinds (FETCH, APP_PAGE, IMAGE, etc.) with tag-based revalidation via DynamoDB
- Uses BUILD_ID prefixing: `/{buildId}/{kind}/{cacheKey}.json`

### Build System ([src/nextjs-build/](../src/nextjs-build/))

- **nextjs-build.ts**: Executes `next build`, extracts `.next` artifacts, generates Dockerfile
- Supports monorepos via `relativePathToPackage`
- Generates Dockerfile for container-based constructs (won't overwrite existing)

### Compute ([src/nextjs-compute/](../src/nextjs-compute/))

- **nextjs-functions.ts**: Lambda function handling with response streaming
- **nextjs-containers.ts**: Fargate container configuration with ALB integration

### Post-Deploy ([src/nextjs-post-deploy.ts](../src/nextjs-post-deploy.ts))

- Prunes old cache entries (S3 objects with old BUILD_ID, DynamoDB partition cleanup)
- Cleans static assets older than 30 days with different BUILD_ID
- See [docs/pruning-guide.md](../docs/pruning-guide.md) for details

## Development Workflows

### Build Commands (projen-managed)

```bash
pnpm build                    # Full build: compile TypeScript, bundle assets, NOTE: ignore build errors about api docs
pnpm test                     # Run Jest tests
pnpm eslint                   # Lint with ESLint + Prettier
pnpm bundle                   # Bundle all esbuild targets (adapter, lambdas, etc.)
pnpm bundle:adapter/adapter:watch  # Watch mode for adapter development
```

**Important**: All scripts run via `pnpm dlx projen <command>`. The project uses projen ([.projenrc.ts](../.projenrc.ts)) - do NOT manually edit package.json scripts.

### Local Development with Adapter

The adapter files must be in `node_modules/cdk-nextjs/lib/adapter/` for Next.js to resolve package exports. For local testing in [examples/app-playground](../examples/app-playground/), use the `prebuild` script that copies (not symlinks) files to avoid Turbopack filesystem root issues. See [docs/development-guide.md](../docs/development-guide.md).

### Testing Examples

Examples live in [examples/](../examples/) with shared utilities in [examples/shared/](../examples/shared/). Each example deploys independently:

```bash
cd examples/app-playground
pnpm build        # Builds adapter first (prebuild hook), then Next.js app
pnpm cdk deploy   # Deploy to AWS
```

## Critical Conventions

### Overrides Pattern

All constructs use a two-level override system:

- **Props**: High-level configuration (recommended for users)
- **Overrides**: Direct access to underlying CDK constructs (use with caution)

Example: `NextjsGlobalFunctionsProps` vs `NextjsGlobalFunctionsOverrides`

### Cache Handler Integration

- Cache handler uses environment variables: `CDK_NEXTJS_CACHE_BUCKET_NAME`, `CDK_NEXTJS_REVALIDATION_TABLE_NAME`, `CDK_NEXTJS_BUILD_ID`
- Circuit breaker pattern prevents cascade failures (5 failures → open circuit for 5 minutes)
- Tag-based revalidation stores `{tag}#{s3Key}` mappings in DynamoDB for efficient lookups

### BUILD_ID Isolation

Every deployment gets unique BUILD_ID for cache/asset isolation:

- S3: `/{buildId}/{kind}/{cacheKey}.json`
- DynamoDB: `pk: buildId, sk: {tag}#{s3Key}`
- Static assets: metadata `next-build-id: {buildId}`

### Generated Structs ([src/generated-structs/](../src/generated-structs/))

Use `@mrgrain/jsii-struct-builder` to generate "Optional" versions of props interfaces for partial overrides. See imports in [.projenrc.ts](../.projenrc.ts) line 3.

## Documentation References

- [docs/caching-guide.md](../docs/caching-guide.md): Deep dive on Next.js cache types and S3/DynamoDB implementation
- [docs/pruning-guide.md](../docs/pruning-guide.md): BUILD_ID isolation and automatic cleanup
- [docs/development-guide.md](../docs/development-guide.md): Lambda log tailing, container debugging, adapter development
- [docs/breaking-changes.md](../docs/breaking-changes.md): Version migration notes
- [API.md](../API.md): Auto-generated API documentation

## Common Pitfalls

1. **Don't bypass projen**: Run `pnpm projen` to regenerate files after modifying .projenrc.ts
2. **Adapter symlinks fail**: Use copy strategy in examples (prebuild hook) due to Turbopack constraints
3. **Circuit breaker testing**: S3/DynamoDB errors trigger circuit breaker after 5 failures - check health status via `getHealthStatus()`
4. **Container ECR auth**: Remove `credHelpers` from Docker config when running `cdk deploy` (CDK incompatibility)
5. **Next.js version**: Requires v16.1.1-canary.19+ (waiting for official adapter API in 16.2)

## File Organization

- `src/`: TypeScript source (builds to `lib/`)
- `lib/`: Compiled JavaScript + .d.ts (git-tracked for jsii)
- `assets/`: Bundled lambdas and build scripts (deployed to AWS)
- `test-reports/`, `coverage/`: Generated test artifacts
- `examples/`: Working CDK apps demonstrating usage patterns
