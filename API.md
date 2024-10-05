# API Reference <a name="API Reference" id="api-reference"></a>

## Constructs <a name="Constructs" id="Constructs"></a>

### NextjsAssetsDeployment <a name="NextjsAssetsDeployment" id="cdk-nextjs.NextjsAssetsDeployment"></a>

Deploys static assets to S3 and cache assets to EFS in Lambda Custom Resource.

#### Initializers <a name="Initializers" id="cdk-nextjs.NextjsAssetsDeployment.Initializer"></a>

```typescript
import { NextjsAssetsDeployment } from 'cdk-nextjs'

new NextjsAssetsDeployment(scope: Construct, id: string, props: NextjsAssetsDeploymentProps)
```

| **Name** | **Type** | **Description** |
| --- | --- | --- |
| <code><a href="#cdk-nextjs.NextjsAssetsDeployment.Initializer.parameter.scope">scope</a></code> | <code>constructs.Construct</code> | *No description.* |
| <code><a href="#cdk-nextjs.NextjsAssetsDeployment.Initializer.parameter.id">id</a></code> | <code>string</code> | *No description.* |
| <code><a href="#cdk-nextjs.NextjsAssetsDeployment.Initializer.parameter.props">props</a></code> | <code><a href="#cdk-nextjs.NextjsAssetsDeploymentProps">NextjsAssetsDeploymentProps</a></code> | *No description.* |

---

##### `scope`<sup>Required</sup> <a name="scope" id="cdk-nextjs.NextjsAssetsDeployment.Initializer.parameter.scope"></a>

- *Type:* constructs.Construct

---

##### `id`<sup>Required</sup> <a name="id" id="cdk-nextjs.NextjsAssetsDeployment.Initializer.parameter.id"></a>

- *Type:* string

---

##### `props`<sup>Required</sup> <a name="props" id="cdk-nextjs.NextjsAssetsDeployment.Initializer.parameter.props"></a>

- *Type:* <a href="#cdk-nextjs.NextjsAssetsDeploymentProps">NextjsAssetsDeploymentProps</a>

---

#### Methods <a name="Methods" id="Methods"></a>

| **Name** | **Description** |
| --- | --- |
| <code><a href="#cdk-nextjs.NextjsAssetsDeployment.toString">toString</a></code> | Returns a string representation of this construct. |

---

##### `toString` <a name="toString" id="cdk-nextjs.NextjsAssetsDeployment.toString"></a>

```typescript
public toString(): string
```

Returns a string representation of this construct.

#### Static Functions <a name="Static Functions" id="Static Functions"></a>

| **Name** | **Description** |
| --- | --- |
| <code><a href="#cdk-nextjs.NextjsAssetsDeployment.isConstruct">isConstruct</a></code> | Checks if `x` is a construct. |

---

##### ~~`isConstruct`~~ <a name="isConstruct" id="cdk-nextjs.NextjsAssetsDeployment.isConstruct"></a>

```typescript
import { NextjsAssetsDeployment } from 'cdk-nextjs'

NextjsAssetsDeployment.isConstruct(x: any)
```

Checks if `x` is a construct.

###### `x`<sup>Required</sup> <a name="x" id="cdk-nextjs.NextjsAssetsDeployment.isConstruct.parameter.x"></a>

- *Type:* any

Any object.

---

#### Properties <a name="Properties" id="Properties"></a>

| **Name** | **Type** | **Description** |
| --- | --- | --- |
| <code><a href="#cdk-nextjs.NextjsAssetsDeployment.property.node">node</a></code> | <code>constructs.Node</code> | The tree node. |
| <code><a href="#cdk-nextjs.NextjsAssetsDeployment.property.customResource">customResource</a></code> | <code>aws-cdk-lib.CustomResource</code> | *No description.* |
| <code><a href="#cdk-nextjs.NextjsAssetsDeployment.property.dockerImageFunction">dockerImageFunction</a></code> | <code>aws-cdk-lib.aws_lambda.DockerImageFunction</code> | *No description.* |
| <code><a href="#cdk-nextjs.NextjsAssetsDeployment.property.previewModeId">previewModeId</a></code> | <code>string</code> | Only used for `NextjsGlobalFunctions`. |

---

##### `node`<sup>Required</sup> <a name="node" id="cdk-nextjs.NextjsAssetsDeployment.property.node"></a>

```typescript
public readonly node: Node;
```

- *Type:* constructs.Node

The tree node.

---

##### `customResource`<sup>Required</sup> <a name="customResource" id="cdk-nextjs.NextjsAssetsDeployment.property.customResource"></a>

```typescript
public readonly customResource: CustomResource;
```

- *Type:* aws-cdk-lib.CustomResource

---

##### `dockerImageFunction`<sup>Required</sup> <a name="dockerImageFunction" id="cdk-nextjs.NextjsAssetsDeployment.property.dockerImageFunction"></a>

```typescript
public readonly dockerImageFunction: DockerImageFunction;
```

- *Type:* aws-cdk-lib.aws_lambda.DockerImageFunction

---

##### `previewModeId`<sup>Required</sup> <a name="previewModeId" id="cdk-nextjs.NextjsAssetsDeployment.property.previewModeId"></a>

```typescript
public readonly previewModeId: string;
```

- *Type:* string

Only used for `NextjsGlobalFunctions`.

---


### NextjsBuild <a name="NextjsBuild" id="cdk-nextjs.NextjsBuild"></a>

Builds Next.js assets.

> [https://nextjs.org/docs/pages/api-reference/next-config-js/output](https://nextjs.org/docs/pages/api-reference/next-config-js/output)

#### Initializers <a name="Initializers" id="cdk-nextjs.NextjsBuild.Initializer"></a>

```typescript
import { NextjsBuild } from 'cdk-nextjs'

new NextjsBuild(scope: Construct, id: string, props: NextjsBuildProps)
```

| **Name** | **Type** | **Description** |
| --- | --- | --- |
| <code><a href="#cdk-nextjs.NextjsBuild.Initializer.parameter.scope">scope</a></code> | <code>constructs.Construct</code> | *No description.* |
| <code><a href="#cdk-nextjs.NextjsBuild.Initializer.parameter.id">id</a></code> | <code>string</code> | *No description.* |
| <code><a href="#cdk-nextjs.NextjsBuild.Initializer.parameter.props">props</a></code> | <code><a href="#cdk-nextjs.NextjsBuildProps">NextjsBuildProps</a></code> | *No description.* |

---

##### `scope`<sup>Required</sup> <a name="scope" id="cdk-nextjs.NextjsBuild.Initializer.parameter.scope"></a>

- *Type:* constructs.Construct

---

##### `id`<sup>Required</sup> <a name="id" id="cdk-nextjs.NextjsBuild.Initializer.parameter.id"></a>

- *Type:* string

---

##### `props`<sup>Required</sup> <a name="props" id="cdk-nextjs.NextjsBuild.Initializer.parameter.props"></a>

- *Type:* <a href="#cdk-nextjs.NextjsBuildProps">NextjsBuildProps</a>

---

#### Methods <a name="Methods" id="Methods"></a>

| **Name** | **Description** |
| --- | --- |
| <code><a href="#cdk-nextjs.NextjsBuild.toString">toString</a></code> | Returns a string representation of this construct. |

---

##### `toString` <a name="toString" id="cdk-nextjs.NextjsBuild.toString"></a>

```typescript
public toString(): string
```

Returns a string representation of this construct.

#### Static Functions <a name="Static Functions" id="Static Functions"></a>

| **Name** | **Description** |
| --- | --- |
| <code><a href="#cdk-nextjs.NextjsBuild.isConstruct">isConstruct</a></code> | Checks if `x` is a construct. |

---

##### ~~`isConstruct`~~ <a name="isConstruct" id="cdk-nextjs.NextjsBuild.isConstruct"></a>

```typescript
import { NextjsBuild } from 'cdk-nextjs'

NextjsBuild.isConstruct(x: any)
```

Checks if `x` is a construct.

###### `x`<sup>Required</sup> <a name="x" id="cdk-nextjs.NextjsBuild.isConstruct.parameter.x"></a>

- *Type:* any

Any object.

---

#### Properties <a name="Properties" id="Properties"></a>

| **Name** | **Type** | **Description** |
| --- | --- | --- |
| <code><a href="#cdk-nextjs.NextjsBuild.property.node">node</a></code> | <code>constructs.Node</code> | The tree node. |
| <code><a href="#cdk-nextjs.NextjsBuild.property.buildImageDigest">buildImageDigest</a></code> | <code>string</code> | Hash of builder image which will change whenever the image changes. |
| <code><a href="#cdk-nextjs.NextjsBuild.property.containerMountPathForEfs">containerMountPathForEfs</a></code> | <code>string</code> | Mount path in container for EFS. Next.js image optimization, data, and full route cache will be symlinked to this location. |
| <code><a href="#cdk-nextjs.NextjsBuild.property.imageForNextjsAssetsDeployment">imageForNextjsAssetsDeployment</a></code> | <code>aws-cdk-lib.aws_lambda.DockerImageCode</code> | Docker image built for `NextjsAssetsDeployment`. |
| <code><a href="#cdk-nextjs.NextjsBuild.property.publicDirEntries">publicDirEntries</a></code> | <code><a href="#cdk-nextjs.PublicDirEntry">PublicDirEntry</a>[]</code> | Absolute path to public. |
| <code><a href="#cdk-nextjs.NextjsBuild.property.relativePathToEntrypoint">relativePathToEntrypoint</a></code> | <code>string</code> | The entrypoint JavaScript file used as an argument for Node.js to run the Next.js standalone server relative to the standalone directory. |
| <code><a href="#cdk-nextjs.NextjsBuild.property.imageForNextjsContainers">imageForNextjsContainers</a></code> | <code>aws-cdk-lib.aws_ecr_assets.DockerImageAsset</code> | Docker image built if using Fargate. |
| <code><a href="#cdk-nextjs.NextjsBuild.property.imageForNextjsFunctions">imageForNextjsFunctions</a></code> | <code>aws-cdk-lib.aws_lambda.DockerImageCode</code> | Docker image built if using Lambda. |

---

##### `node`<sup>Required</sup> <a name="node" id="cdk-nextjs.NextjsBuild.property.node"></a>

```typescript
public readonly node: Node;
```

- *Type:* constructs.Node

The tree node.

---

##### `buildImageDigest`<sup>Required</sup> <a name="buildImageDigest" id="cdk-nextjs.NextjsBuild.property.buildImageDigest"></a>

```typescript
public readonly buildImageDigest: string;
```

- *Type:* string

Hash of builder image which will change whenever the image changes.

Useful
for passing to properties of custom resources that depend upon the builder
image to re-run when build image changes.

---

##### `containerMountPathForEfs`<sup>Required</sup> <a name="containerMountPathForEfs" id="cdk-nextjs.NextjsBuild.property.containerMountPathForEfs"></a>

```typescript
public readonly containerMountPathForEfs: string;
```

- *Type:* string

Mount path in container for EFS. Next.js image optimization, data, and full route cache will be symlinked to this location.

Must comply with pattern: ^/mnt/[a-zA-Z0-9-_.]+$

> [https://docs.aws.amazon.com/lambda/latest/api/API_FileSystemConfig.html](https://docs.aws.amazon.com/lambda/latest/api/API_FileSystemConfig.html)

---

##### `imageForNextjsAssetsDeployment`<sup>Required</sup> <a name="imageForNextjsAssetsDeployment" id="cdk-nextjs.NextjsBuild.property.imageForNextjsAssetsDeployment"></a>

```typescript
public readonly imageForNextjsAssetsDeployment: DockerImageCode;
```

- *Type:* aws-cdk-lib.aws_lambda.DockerImageCode

Docker image built for `NextjsAssetsDeployment`.

---

##### `publicDirEntries`<sup>Required</sup> <a name="publicDirEntries" id="cdk-nextjs.NextjsBuild.property.publicDirEntries"></a>

```typescript
public readonly publicDirEntries: PublicDirEntry[];
```

- *Type:* <a href="#cdk-nextjs.PublicDirEntry">PublicDirEntry</a>[]

Absolute path to public.

Use by CloudFront/ALB to create behaviors/rules

---

*Example*

```typescript
"/Users/john/myapp/public"
```


##### `relativePathToEntrypoint`<sup>Required</sup> <a name="relativePathToEntrypoint" id="cdk-nextjs.NextjsBuild.property.relativePathToEntrypoint"></a>

```typescript
public readonly relativePathToEntrypoint: string;
```

- *Type:* string

The entrypoint JavaScript file used as an argument for Node.js to run the Next.js standalone server relative to the standalone directory.

---

*Example*

```typescript
"./packages/ui/server.js" (monorepo)
```


##### `imageForNextjsContainers`<sup>Optional</sup> <a name="imageForNextjsContainers" id="cdk-nextjs.NextjsBuild.property.imageForNextjsContainers"></a>

```typescript
public readonly imageForNextjsContainers: DockerImageAsset;
```

- *Type:* aws-cdk-lib.aws_ecr_assets.DockerImageAsset

Docker image built if using Fargate.

---

##### `imageForNextjsFunctions`<sup>Optional</sup> <a name="imageForNextjsFunctions" id="cdk-nextjs.NextjsBuild.property.imageForNextjsFunctions"></a>

```typescript
public readonly imageForNextjsFunctions: DockerImageCode;
```

- *Type:* aws-cdk-lib.aws_lambda.DockerImageCode

Docker image built if using Lambda.

---


### NextjsContainers <a name="NextjsContainers" id="cdk-nextjs.NextjsContainers"></a>

Next.js load balanced via Application Load Balancer with containers via AWS Fargate.

#### Initializers <a name="Initializers" id="cdk-nextjs.NextjsContainers.Initializer"></a>

```typescript
import { NextjsContainers } from 'cdk-nextjs'

new NextjsContainers(scope: Construct, id: string, props: NextjsContainersProps)
```

| **Name** | **Type** | **Description** |
| --- | --- | --- |
| <code><a href="#cdk-nextjs.NextjsContainers.Initializer.parameter.scope">scope</a></code> | <code>constructs.Construct</code> | *No description.* |
| <code><a href="#cdk-nextjs.NextjsContainers.Initializer.parameter.id">id</a></code> | <code>string</code> | *No description.* |
| <code><a href="#cdk-nextjs.NextjsContainers.Initializer.parameter.props">props</a></code> | <code><a href="#cdk-nextjs.NextjsContainersProps">NextjsContainersProps</a></code> | *No description.* |

---

##### `scope`<sup>Required</sup> <a name="scope" id="cdk-nextjs.NextjsContainers.Initializer.parameter.scope"></a>

- *Type:* constructs.Construct

---

##### `id`<sup>Required</sup> <a name="id" id="cdk-nextjs.NextjsContainers.Initializer.parameter.id"></a>

- *Type:* string

---

##### `props`<sup>Required</sup> <a name="props" id="cdk-nextjs.NextjsContainers.Initializer.parameter.props"></a>

- *Type:* <a href="#cdk-nextjs.NextjsContainersProps">NextjsContainersProps</a>

---

#### Methods <a name="Methods" id="Methods"></a>

| **Name** | **Description** |
| --- | --- |
| <code><a href="#cdk-nextjs.NextjsContainers.toString">toString</a></code> | Returns a string representation of this construct. |

---

##### `toString` <a name="toString" id="cdk-nextjs.NextjsContainers.toString"></a>

```typescript
public toString(): string
```

Returns a string representation of this construct.

#### Static Functions <a name="Static Functions" id="Static Functions"></a>

| **Name** | **Description** |
| --- | --- |
| <code><a href="#cdk-nextjs.NextjsContainers.isConstruct">isConstruct</a></code> | Checks if `x` is a construct. |

---

##### ~~`isConstruct`~~ <a name="isConstruct" id="cdk-nextjs.NextjsContainers.isConstruct"></a>

```typescript
import { NextjsContainers } from 'cdk-nextjs'

NextjsContainers.isConstruct(x: any)
```

Checks if `x` is a construct.

###### `x`<sup>Required</sup> <a name="x" id="cdk-nextjs.NextjsContainers.isConstruct.parameter.x"></a>

- *Type:* any

Any object.

---

#### Properties <a name="Properties" id="Properties"></a>

| **Name** | **Type** | **Description** |
| --- | --- | --- |
| <code><a href="#cdk-nextjs.NextjsContainers.property.node">node</a></code> | <code>constructs.Node</code> | The tree node. |
| <code><a href="#cdk-nextjs.NextjsContainers.property.albFargateService">albFargateService</a></code> | <code>aws-cdk-lib.aws_ecs_patterns.ApplicationLoadBalancedFargateService</code> | *No description.* |
| <code><a href="#cdk-nextjs.NextjsContainers.property.ecsCluster">ecsCluster</a></code> | <code>aws-cdk-lib.aws_ecs.Cluster</code> | *No description.* |
| <code><a href="#cdk-nextjs.NextjsContainers.property.url">url</a></code> | <code>string</code> | *No description.* |

---

##### `node`<sup>Required</sup> <a name="node" id="cdk-nextjs.NextjsContainers.property.node"></a>

```typescript
public readonly node: Node;
```

- *Type:* constructs.Node

The tree node.

---

##### `albFargateService`<sup>Required</sup> <a name="albFargateService" id="cdk-nextjs.NextjsContainers.property.albFargateService"></a>

```typescript
public readonly albFargateService: ApplicationLoadBalancedFargateService;
```

- *Type:* aws-cdk-lib.aws_ecs_patterns.ApplicationLoadBalancedFargateService

---

##### `ecsCluster`<sup>Required</sup> <a name="ecsCluster" id="cdk-nextjs.NextjsContainers.property.ecsCluster"></a>

```typescript
public readonly ecsCluster: Cluster;
```

- *Type:* aws-cdk-lib.aws_ecs.Cluster

---

##### `url`<sup>Required</sup> <a name="url" id="cdk-nextjs.NextjsContainers.property.url"></a>

```typescript
public readonly url: string;
```

- *Type:* string

---


### NextjsDistribution <a name="NextjsDistribution" id="cdk-nextjs.NextjsDistribution"></a>

#### Initializers <a name="Initializers" id="cdk-nextjs.NextjsDistribution.Initializer"></a>

```typescript
import { NextjsDistribution } from 'cdk-nextjs'

new NextjsDistribution(scope: Construct, id: string, props: NextjsDistributionProps)
```

| **Name** | **Type** | **Description** |
| --- | --- | --- |
| <code><a href="#cdk-nextjs.NextjsDistribution.Initializer.parameter.scope">scope</a></code> | <code>constructs.Construct</code> | *No description.* |
| <code><a href="#cdk-nextjs.NextjsDistribution.Initializer.parameter.id">id</a></code> | <code>string</code> | *No description.* |
| <code><a href="#cdk-nextjs.NextjsDistribution.Initializer.parameter.props">props</a></code> | <code><a href="#cdk-nextjs.NextjsDistributionProps">NextjsDistributionProps</a></code> | *No description.* |

---

##### `scope`<sup>Required</sup> <a name="scope" id="cdk-nextjs.NextjsDistribution.Initializer.parameter.scope"></a>

- *Type:* constructs.Construct

---

##### `id`<sup>Required</sup> <a name="id" id="cdk-nextjs.NextjsDistribution.Initializer.parameter.id"></a>

- *Type:* string

---

##### `props`<sup>Required</sup> <a name="props" id="cdk-nextjs.NextjsDistribution.Initializer.parameter.props"></a>

- *Type:* <a href="#cdk-nextjs.NextjsDistributionProps">NextjsDistributionProps</a>

---

#### Methods <a name="Methods" id="Methods"></a>

| **Name** | **Description** |
| --- | --- |
| <code><a href="#cdk-nextjs.NextjsDistribution.toString">toString</a></code> | Returns a string representation of this construct. |

---

##### `toString` <a name="toString" id="cdk-nextjs.NextjsDistribution.toString"></a>

```typescript
public toString(): string
```

Returns a string representation of this construct.

#### Static Functions <a name="Static Functions" id="Static Functions"></a>

| **Name** | **Description** |
| --- | --- |
| <code><a href="#cdk-nextjs.NextjsDistribution.isConstruct">isConstruct</a></code> | Checks if `x` is a construct. |

---

##### ~~`isConstruct`~~ <a name="isConstruct" id="cdk-nextjs.NextjsDistribution.isConstruct"></a>

```typescript
import { NextjsDistribution } from 'cdk-nextjs'

NextjsDistribution.isConstruct(x: any)
```

Checks if `x` is a construct.

###### `x`<sup>Required</sup> <a name="x" id="cdk-nextjs.NextjsDistribution.isConstruct.parameter.x"></a>

- *Type:* any

Any object.

---

#### Properties <a name="Properties" id="Properties"></a>

| **Name** | **Type** | **Description** |
| --- | --- | --- |
| <code><a href="#cdk-nextjs.NextjsDistribution.property.node">node</a></code> | <code>constructs.Node</code> | The tree node. |
| <code><a href="#cdk-nextjs.NextjsDistribution.property.distribution">distribution</a></code> | <code>aws-cdk-lib.aws_cloudfront.Distribution</code> | *No description.* |

---

##### `node`<sup>Required</sup> <a name="node" id="cdk-nextjs.NextjsDistribution.property.node"></a>

```typescript
public readonly node: Node;
```

- *Type:* constructs.Node

The tree node.

---

##### `distribution`<sup>Required</sup> <a name="distribution" id="cdk-nextjs.NextjsDistribution.property.distribution"></a>

```typescript
public readonly distribution: Distribution;
```

- *Type:* aws-cdk-lib.aws_cloudfront.Distribution

---


### NextjsFileSystem <a name="NextjsFileSystem" id="cdk-nextjs.NextjsFileSystem"></a>

Next.js Network File System enabling sharing of image optimization cache, data cach, and pages cache.

#### Initializers <a name="Initializers" id="cdk-nextjs.NextjsFileSystem.Initializer"></a>

```typescript
import { NextjsFileSystem } from 'cdk-nextjs'

new NextjsFileSystem(scope: Construct, id: string, props: NextjsFileSystemProps)
```

| **Name** | **Type** | **Description** |
| --- | --- | --- |
| <code><a href="#cdk-nextjs.NextjsFileSystem.Initializer.parameter.scope">scope</a></code> | <code>constructs.Construct</code> | *No description.* |
| <code><a href="#cdk-nextjs.NextjsFileSystem.Initializer.parameter.id">id</a></code> | <code>string</code> | *No description.* |
| <code><a href="#cdk-nextjs.NextjsFileSystem.Initializer.parameter.props">props</a></code> | <code><a href="#cdk-nextjs.NextjsFileSystemProps">NextjsFileSystemProps</a></code> | *No description.* |

---

##### `scope`<sup>Required</sup> <a name="scope" id="cdk-nextjs.NextjsFileSystem.Initializer.parameter.scope"></a>

- *Type:* constructs.Construct

---

##### `id`<sup>Required</sup> <a name="id" id="cdk-nextjs.NextjsFileSystem.Initializer.parameter.id"></a>

- *Type:* string

---

##### `props`<sup>Required</sup> <a name="props" id="cdk-nextjs.NextjsFileSystem.Initializer.parameter.props"></a>

- *Type:* <a href="#cdk-nextjs.NextjsFileSystemProps">NextjsFileSystemProps</a>

---

#### Methods <a name="Methods" id="Methods"></a>

| **Name** | **Description** |
| --- | --- |
| <code><a href="#cdk-nextjs.NextjsFileSystem.toString">toString</a></code> | Returns a string representation of this construct. |
| <code><a href="#cdk-nextjs.NextjsFileSystem.allowCompute">allowCompute</a></code> | *No description.* |

---

##### `toString` <a name="toString" id="cdk-nextjs.NextjsFileSystem.toString"></a>

```typescript
public toString(): string
```

Returns a string representation of this construct.

##### `allowCompute` <a name="allowCompute" id="cdk-nextjs.NextjsFileSystem.allowCompute"></a>

```typescript
public allowCompute(__0: AllowComputeProps): void
```

###### `__0`<sup>Required</sup> <a name="__0" id="cdk-nextjs.NextjsFileSystem.allowCompute.parameter.__0"></a>

- *Type:* <a href="#cdk-nextjs.AllowComputeProps">AllowComputeProps</a>

---

#### Static Functions <a name="Static Functions" id="Static Functions"></a>

| **Name** | **Description** |
| --- | --- |
| <code><a href="#cdk-nextjs.NextjsFileSystem.isConstruct">isConstruct</a></code> | Checks if `x` is a construct. |

---

##### ~~`isConstruct`~~ <a name="isConstruct" id="cdk-nextjs.NextjsFileSystem.isConstruct"></a>

```typescript
import { NextjsFileSystem } from 'cdk-nextjs'

NextjsFileSystem.isConstruct(x: any)
```

Checks if `x` is a construct.

###### `x`<sup>Required</sup> <a name="x" id="cdk-nextjs.NextjsFileSystem.isConstruct.parameter.x"></a>

- *Type:* any

Any object.

---

#### Properties <a name="Properties" id="Properties"></a>

| **Name** | **Type** | **Description** |
| --- | --- | --- |
| <code><a href="#cdk-nextjs.NextjsFileSystem.property.node">node</a></code> | <code>constructs.Node</code> | The tree node. |
| <code><a href="#cdk-nextjs.NextjsFileSystem.property.accessPoint">accessPoint</a></code> | <code>aws-cdk-lib.aws_efs.AccessPoint</code> | *No description.* |
| <code><a href="#cdk-nextjs.NextjsFileSystem.property.fileSystem">fileSystem</a></code> | <code>aws-cdk-lib.aws_efs.FileSystem</code> | *No description.* |

---

##### `node`<sup>Required</sup> <a name="node" id="cdk-nextjs.NextjsFileSystem.property.node"></a>

```typescript
public readonly node: Node;
```

- *Type:* constructs.Node

The tree node.

---

##### `accessPoint`<sup>Required</sup> <a name="accessPoint" id="cdk-nextjs.NextjsFileSystem.property.accessPoint"></a>

```typescript
public readonly accessPoint: AccessPoint;
```

- *Type:* aws-cdk-lib.aws_efs.AccessPoint

---

##### `fileSystem`<sup>Required</sup> <a name="fileSystem" id="cdk-nextjs.NextjsFileSystem.property.fileSystem"></a>

```typescript
public readonly fileSystem: FileSystem;
```

- *Type:* aws-cdk-lib.aws_efs.FileSystem

---


### NextjsFunctions <a name="NextjsFunctions" id="cdk-nextjs.NextjsFunctions"></a>

Run Next.js in functions on AWS with AWS Lambda.

#### Initializers <a name="Initializers" id="cdk-nextjs.NextjsFunctions.Initializer"></a>

```typescript
import { NextjsFunctions } from 'cdk-nextjs'

new NextjsFunctions(scope: Construct, id: string, props: NextjsFunctionsProps)
```

| **Name** | **Type** | **Description** |
| --- | --- | --- |
| <code><a href="#cdk-nextjs.NextjsFunctions.Initializer.parameter.scope">scope</a></code> | <code>constructs.Construct</code> | *No description.* |
| <code><a href="#cdk-nextjs.NextjsFunctions.Initializer.parameter.id">id</a></code> | <code>string</code> | *No description.* |
| <code><a href="#cdk-nextjs.NextjsFunctions.Initializer.parameter.props">props</a></code> | <code><a href="#cdk-nextjs.NextjsFunctionsProps">NextjsFunctionsProps</a></code> | *No description.* |

---

##### `scope`<sup>Required</sup> <a name="scope" id="cdk-nextjs.NextjsFunctions.Initializer.parameter.scope"></a>

- *Type:* constructs.Construct

---

##### `id`<sup>Required</sup> <a name="id" id="cdk-nextjs.NextjsFunctions.Initializer.parameter.id"></a>

- *Type:* string

---

##### `props`<sup>Required</sup> <a name="props" id="cdk-nextjs.NextjsFunctions.Initializer.parameter.props"></a>

- *Type:* <a href="#cdk-nextjs.NextjsFunctionsProps">NextjsFunctionsProps</a>

---

#### Methods <a name="Methods" id="Methods"></a>

| **Name** | **Description** |
| --- | --- |
| <code><a href="#cdk-nextjs.NextjsFunctions.toString">toString</a></code> | Returns a string representation of this construct. |

---

##### `toString` <a name="toString" id="cdk-nextjs.NextjsFunctions.toString"></a>

```typescript
public toString(): string
```

Returns a string representation of this construct.

#### Static Functions <a name="Static Functions" id="Static Functions"></a>

| **Name** | **Description** |
| --- | --- |
| <code><a href="#cdk-nextjs.NextjsFunctions.isConstruct">isConstruct</a></code> | Checks if `x` is a construct. |

---

##### ~~`isConstruct`~~ <a name="isConstruct" id="cdk-nextjs.NextjsFunctions.isConstruct"></a>

```typescript
import { NextjsFunctions } from 'cdk-nextjs'

NextjsFunctions.isConstruct(x: any)
```

Checks if `x` is a construct.

###### `x`<sup>Required</sup> <a name="x" id="cdk-nextjs.NextjsFunctions.isConstruct.parameter.x"></a>

- *Type:* any

Any object.

---

#### Properties <a name="Properties" id="Properties"></a>

| **Name** | **Type** | **Description** |
| --- | --- | --- |
| <code><a href="#cdk-nextjs.NextjsFunctions.property.node">node</a></code> | <code>constructs.Node</code> | The tree node. |
| <code><a href="#cdk-nextjs.NextjsFunctions.property.function">function</a></code> | <code>aws-cdk-lib.aws_lambda.DockerImageFunction</code> | *No description.* |
| <code><a href="#cdk-nextjs.NextjsFunctions.property.functionUrl">functionUrl</a></code> | <code>aws-cdk-lib.aws_lambda.FunctionUrl</code> | *No description.* |

---

##### `node`<sup>Required</sup> <a name="node" id="cdk-nextjs.NextjsFunctions.property.node"></a>

```typescript
public readonly node: Node;
```

- *Type:* constructs.Node

The tree node.

---

##### `function`<sup>Required</sup> <a name="function" id="cdk-nextjs.NextjsFunctions.property.function"></a>

```typescript
public readonly function: DockerImageFunction;
```

- *Type:* aws-cdk-lib.aws_lambda.DockerImageFunction

---

##### `functionUrl`<sup>Required</sup> <a name="functionUrl" id="cdk-nextjs.NextjsFunctions.property.functionUrl"></a>

```typescript
public readonly functionUrl: FunctionUrl;
```

- *Type:* aws-cdk-lib.aws_lambda.FunctionUrl

---


### NextjsGlobalContainers <a name="NextjsGlobalContainers" id="cdk-nextjs.NextjsGlobalContainers"></a>

Deploy Next.js globally distributed with containers. Uses [CloudFront Distribution](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/distribution-working-with.html) as Content Delivery Network (CDN) for global distribution and [AWS Fargate](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/AWS_Fargate.html) for containers.

#### Initializers <a name="Initializers" id="cdk-nextjs.NextjsGlobalContainers.Initializer"></a>

```typescript
import { NextjsGlobalContainers } from 'cdk-nextjs'

new NextjsGlobalContainers(scope: Construct, id: string, props: NextjsGlobalContainersProps)
```

| **Name** | **Type** | **Description** |
| --- | --- | --- |
| <code><a href="#cdk-nextjs.NextjsGlobalContainers.Initializer.parameter.scope">scope</a></code> | <code>constructs.Construct</code> | *No description.* |
| <code><a href="#cdk-nextjs.NextjsGlobalContainers.Initializer.parameter.id">id</a></code> | <code>string</code> | *No description.* |
| <code><a href="#cdk-nextjs.NextjsGlobalContainers.Initializer.parameter.props">props</a></code> | <code><a href="#cdk-nextjs.NextjsGlobalContainersProps">NextjsGlobalContainersProps</a></code> | *No description.* |

---

##### `scope`<sup>Required</sup> <a name="scope" id="cdk-nextjs.NextjsGlobalContainers.Initializer.parameter.scope"></a>

- *Type:* constructs.Construct

---

##### `id`<sup>Required</sup> <a name="id" id="cdk-nextjs.NextjsGlobalContainers.Initializer.parameter.id"></a>

- *Type:* string

---

##### `props`<sup>Required</sup> <a name="props" id="cdk-nextjs.NextjsGlobalContainers.Initializer.parameter.props"></a>

- *Type:* <a href="#cdk-nextjs.NextjsGlobalContainersProps">NextjsGlobalContainersProps</a>

---

#### Methods <a name="Methods" id="Methods"></a>

| **Name** | **Description** |
| --- | --- |
| <code><a href="#cdk-nextjs.NextjsGlobalContainers.toString">toString</a></code> | Returns a string representation of this construct. |

---

##### `toString` <a name="toString" id="cdk-nextjs.NextjsGlobalContainers.toString"></a>

```typescript
public toString(): string
```

Returns a string representation of this construct.

#### Static Functions <a name="Static Functions" id="Static Functions"></a>

| **Name** | **Description** |
| --- | --- |
| <code><a href="#cdk-nextjs.NextjsGlobalContainers.isConstruct">isConstruct</a></code> | Checks if `x` is a construct. |

---

##### ~~`isConstruct`~~ <a name="isConstruct" id="cdk-nextjs.NextjsGlobalContainers.isConstruct"></a>

```typescript
import { NextjsGlobalContainers } from 'cdk-nextjs'

NextjsGlobalContainers.isConstruct(x: any)
```

Checks if `x` is a construct.

###### `x`<sup>Required</sup> <a name="x" id="cdk-nextjs.NextjsGlobalContainers.isConstruct.parameter.x"></a>

- *Type:* any

Any object.

---

#### Properties <a name="Properties" id="Properties"></a>

| **Name** | **Type** | **Description** |
| --- | --- | --- |
| <code><a href="#cdk-nextjs.NextjsGlobalContainers.property.node">node</a></code> | <code>constructs.Node</code> | The tree node. |
| <code><a href="#cdk-nextjs.NextjsGlobalContainers.property.nextjsAssetsDeployment">nextjsAssetsDeployment</a></code> | <code><a href="#cdk-nextjs.NextjsAssetsDeployment">NextjsAssetsDeployment</a></code> | *No description.* |
| <code><a href="#cdk-nextjs.NextjsGlobalContainers.property.nextjsBuild">nextjsBuild</a></code> | <code><a href="#cdk-nextjs.NextjsBuild">NextjsBuild</a></code> | *No description.* |
| <code><a href="#cdk-nextjs.NextjsGlobalContainers.property.nextjsContainers">nextjsContainers</a></code> | <code><a href="#cdk-nextjs.NextjsContainers">NextjsContainers</a></code> | *No description.* |
| <code><a href="#cdk-nextjs.NextjsGlobalContainers.property.nextjsDistribution">nextjsDistribution</a></code> | <code><a href="#cdk-nextjs.NextjsDistribution">NextjsDistribution</a></code> | *No description.* |
| <code><a href="#cdk-nextjs.NextjsGlobalContainers.property.nextjsFileSystem">nextjsFileSystem</a></code> | <code><a href="#cdk-nextjs.NextjsFileSystem">NextjsFileSystem</a></code> | *No description.* |
| <code><a href="#cdk-nextjs.NextjsGlobalContainers.property.nextjsInvalidation">nextjsInvalidation</a></code> | <code><a href="#cdk-nextjs.NextjsInvalidation">NextjsInvalidation</a></code> | *No description.* |
| <code><a href="#cdk-nextjs.NextjsGlobalContainers.property.nextjsStaticAssets">nextjsStaticAssets</a></code> | <code><a href="#cdk-nextjs.NextjsStaticAssets">NextjsStaticAssets</a></code> | *No description.* |
| <code><a href="#cdk-nextjs.NextjsGlobalContainers.property.nextjsVpc">nextjsVpc</a></code> | <code><a href="#cdk-nextjs.NextjsVpc">NextjsVpc</a></code> | *No description.* |

---

##### `node`<sup>Required</sup> <a name="node" id="cdk-nextjs.NextjsGlobalContainers.property.node"></a>

```typescript
public readonly node: Node;
```

- *Type:* constructs.Node

The tree node.

---

##### `nextjsAssetsDeployment`<sup>Required</sup> <a name="nextjsAssetsDeployment" id="cdk-nextjs.NextjsGlobalContainers.property.nextjsAssetsDeployment"></a>

```typescript
public readonly nextjsAssetsDeployment: NextjsAssetsDeployment;
```

- *Type:* <a href="#cdk-nextjs.NextjsAssetsDeployment">NextjsAssetsDeployment</a>

---

##### `nextjsBuild`<sup>Required</sup> <a name="nextjsBuild" id="cdk-nextjs.NextjsGlobalContainers.property.nextjsBuild"></a>

```typescript
public readonly nextjsBuild: NextjsBuild;
```

- *Type:* <a href="#cdk-nextjs.NextjsBuild">NextjsBuild</a>

---

##### `nextjsContainers`<sup>Required</sup> <a name="nextjsContainers" id="cdk-nextjs.NextjsGlobalContainers.property.nextjsContainers"></a>

```typescript
public readonly nextjsContainers: NextjsContainers;
```

- *Type:* <a href="#cdk-nextjs.NextjsContainers">NextjsContainers</a>

---

##### `nextjsDistribution`<sup>Required</sup> <a name="nextjsDistribution" id="cdk-nextjs.NextjsGlobalContainers.property.nextjsDistribution"></a>

```typescript
public readonly nextjsDistribution: NextjsDistribution;
```

- *Type:* <a href="#cdk-nextjs.NextjsDistribution">NextjsDistribution</a>

---

##### `nextjsFileSystem`<sup>Required</sup> <a name="nextjsFileSystem" id="cdk-nextjs.NextjsGlobalContainers.property.nextjsFileSystem"></a>

```typescript
public readonly nextjsFileSystem: NextjsFileSystem;
```

- *Type:* <a href="#cdk-nextjs.NextjsFileSystem">NextjsFileSystem</a>

---

##### `nextjsInvalidation`<sup>Required</sup> <a name="nextjsInvalidation" id="cdk-nextjs.NextjsGlobalContainers.property.nextjsInvalidation"></a>

```typescript
public readonly nextjsInvalidation: NextjsInvalidation;
```

- *Type:* <a href="#cdk-nextjs.NextjsInvalidation">NextjsInvalidation</a>

---

##### `nextjsStaticAssets`<sup>Required</sup> <a name="nextjsStaticAssets" id="cdk-nextjs.NextjsGlobalContainers.property.nextjsStaticAssets"></a>

```typescript
public readonly nextjsStaticAssets: NextjsStaticAssets;
```

- *Type:* <a href="#cdk-nextjs.NextjsStaticAssets">NextjsStaticAssets</a>

---

##### `nextjsVpc`<sup>Required</sup> <a name="nextjsVpc" id="cdk-nextjs.NextjsGlobalContainers.property.nextjsVpc"></a>

```typescript
public readonly nextjsVpc: NextjsVpc;
```

- *Type:* <a href="#cdk-nextjs.NextjsVpc">NextjsVpc</a>

---


### NextjsGlobalFunctions <a name="NextjsGlobalFunctions" id="cdk-nextjs.NextjsGlobalFunctions"></a>

Deploy Next.js globally distributed with functions. Uses [CloudFront Distribution](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/distribution-working-with.html) as Content Delivery Network (CDN) for global distribution and [AWS Lambda Functions](https://docs.aws.amazon.com/lambda/latest/dg/welcome.html) for functions.

#### Initializers <a name="Initializers" id="cdk-nextjs.NextjsGlobalFunctions.Initializer"></a>

```typescript
import { NextjsGlobalFunctions } from 'cdk-nextjs'

new NextjsGlobalFunctions(scope: Construct, id: string, props: NextjsGlobalFunctionsProps)
```

| **Name** | **Type** | **Description** |
| --- | --- | --- |
| <code><a href="#cdk-nextjs.NextjsGlobalFunctions.Initializer.parameter.scope">scope</a></code> | <code>constructs.Construct</code> | *No description.* |
| <code><a href="#cdk-nextjs.NextjsGlobalFunctions.Initializer.parameter.id">id</a></code> | <code>string</code> | *No description.* |
| <code><a href="#cdk-nextjs.NextjsGlobalFunctions.Initializer.parameter.props">props</a></code> | <code><a href="#cdk-nextjs.NextjsGlobalFunctionsProps">NextjsGlobalFunctionsProps</a></code> | *No description.* |

---

##### `scope`<sup>Required</sup> <a name="scope" id="cdk-nextjs.NextjsGlobalFunctions.Initializer.parameter.scope"></a>

- *Type:* constructs.Construct

---

##### `id`<sup>Required</sup> <a name="id" id="cdk-nextjs.NextjsGlobalFunctions.Initializer.parameter.id"></a>

- *Type:* string

---

##### `props`<sup>Required</sup> <a name="props" id="cdk-nextjs.NextjsGlobalFunctions.Initializer.parameter.props"></a>

- *Type:* <a href="#cdk-nextjs.NextjsGlobalFunctionsProps">NextjsGlobalFunctionsProps</a>

---

#### Methods <a name="Methods" id="Methods"></a>

| **Name** | **Description** |
| --- | --- |
| <code><a href="#cdk-nextjs.NextjsGlobalFunctions.toString">toString</a></code> | Returns a string representation of this construct. |

---

##### `toString` <a name="toString" id="cdk-nextjs.NextjsGlobalFunctions.toString"></a>

```typescript
public toString(): string
```

Returns a string representation of this construct.

#### Static Functions <a name="Static Functions" id="Static Functions"></a>

| **Name** | **Description** |
| --- | --- |
| <code><a href="#cdk-nextjs.NextjsGlobalFunctions.isConstruct">isConstruct</a></code> | Checks if `x` is a construct. |

---

##### ~~`isConstruct`~~ <a name="isConstruct" id="cdk-nextjs.NextjsGlobalFunctions.isConstruct"></a>

```typescript
import { NextjsGlobalFunctions } from 'cdk-nextjs'

NextjsGlobalFunctions.isConstruct(x: any)
```

Checks if `x` is a construct.

###### `x`<sup>Required</sup> <a name="x" id="cdk-nextjs.NextjsGlobalFunctions.isConstruct.parameter.x"></a>

- *Type:* any

Any object.

---

#### Properties <a name="Properties" id="Properties"></a>

| **Name** | **Type** | **Description** |
| --- | --- | --- |
| <code><a href="#cdk-nextjs.NextjsGlobalFunctions.property.node">node</a></code> | <code>constructs.Node</code> | The tree node. |
| <code><a href="#cdk-nextjs.NextjsGlobalFunctions.property.nextjsAssetsDeployment">nextjsAssetsDeployment</a></code> | <code><a href="#cdk-nextjs.NextjsAssetsDeployment">NextjsAssetsDeployment</a></code> | *No description.* |
| <code><a href="#cdk-nextjs.NextjsGlobalFunctions.property.nextjsBuild">nextjsBuild</a></code> | <code><a href="#cdk-nextjs.NextjsBuild">NextjsBuild</a></code> | *No description.* |
| <code><a href="#cdk-nextjs.NextjsGlobalFunctions.property.nextjsDistribution">nextjsDistribution</a></code> | <code><a href="#cdk-nextjs.NextjsDistribution">NextjsDistribution</a></code> | *No description.* |
| <code><a href="#cdk-nextjs.NextjsGlobalFunctions.property.nextjsFileSystem">nextjsFileSystem</a></code> | <code><a href="#cdk-nextjs.NextjsFileSystem">NextjsFileSystem</a></code> | *No description.* |
| <code><a href="#cdk-nextjs.NextjsGlobalFunctions.property.nextjsFunctions">nextjsFunctions</a></code> | <code><a href="#cdk-nextjs.NextjsFunctions">NextjsFunctions</a></code> | *No description.* |
| <code><a href="#cdk-nextjs.NextjsGlobalFunctions.property.nextjsInvalidation">nextjsInvalidation</a></code> | <code><a href="#cdk-nextjs.NextjsInvalidation">NextjsInvalidation</a></code> | *No description.* |
| <code><a href="#cdk-nextjs.NextjsGlobalFunctions.property.nextjsRevalidation">nextjsRevalidation</a></code> | <code><a href="#cdk-nextjs.NextjsRevalidation">NextjsRevalidation</a></code> | *No description.* |
| <code><a href="#cdk-nextjs.NextjsGlobalFunctions.property.nextjsStaticAssets">nextjsStaticAssets</a></code> | <code><a href="#cdk-nextjs.NextjsStaticAssets">NextjsStaticAssets</a></code> | *No description.* |
| <code><a href="#cdk-nextjs.NextjsGlobalFunctions.property.nextjsVpc">nextjsVpc</a></code> | <code><a href="#cdk-nextjs.NextjsVpc">NextjsVpc</a></code> | *No description.* |

---

##### `node`<sup>Required</sup> <a name="node" id="cdk-nextjs.NextjsGlobalFunctions.property.node"></a>

```typescript
public readonly node: Node;
```

- *Type:* constructs.Node

The tree node.

---

##### `nextjsAssetsDeployment`<sup>Required</sup> <a name="nextjsAssetsDeployment" id="cdk-nextjs.NextjsGlobalFunctions.property.nextjsAssetsDeployment"></a>

```typescript
public readonly nextjsAssetsDeployment: NextjsAssetsDeployment;
```

- *Type:* <a href="#cdk-nextjs.NextjsAssetsDeployment">NextjsAssetsDeployment</a>

---

##### `nextjsBuild`<sup>Required</sup> <a name="nextjsBuild" id="cdk-nextjs.NextjsGlobalFunctions.property.nextjsBuild"></a>

```typescript
public readonly nextjsBuild: NextjsBuild;
```

- *Type:* <a href="#cdk-nextjs.NextjsBuild">NextjsBuild</a>

---

##### `nextjsDistribution`<sup>Required</sup> <a name="nextjsDistribution" id="cdk-nextjs.NextjsGlobalFunctions.property.nextjsDistribution"></a>

```typescript
public readonly nextjsDistribution: NextjsDistribution;
```

- *Type:* <a href="#cdk-nextjs.NextjsDistribution">NextjsDistribution</a>

---

##### `nextjsFileSystem`<sup>Required</sup> <a name="nextjsFileSystem" id="cdk-nextjs.NextjsGlobalFunctions.property.nextjsFileSystem"></a>

```typescript
public readonly nextjsFileSystem: NextjsFileSystem;
```

- *Type:* <a href="#cdk-nextjs.NextjsFileSystem">NextjsFileSystem</a>

---

##### `nextjsFunctions`<sup>Required</sup> <a name="nextjsFunctions" id="cdk-nextjs.NextjsGlobalFunctions.property.nextjsFunctions"></a>

```typescript
public readonly nextjsFunctions: NextjsFunctions;
```

- *Type:* <a href="#cdk-nextjs.NextjsFunctions">NextjsFunctions</a>

---

##### `nextjsInvalidation`<sup>Required</sup> <a name="nextjsInvalidation" id="cdk-nextjs.NextjsGlobalFunctions.property.nextjsInvalidation"></a>

```typescript
public readonly nextjsInvalidation: NextjsInvalidation;
```

- *Type:* <a href="#cdk-nextjs.NextjsInvalidation">NextjsInvalidation</a>

---

##### `nextjsRevalidation`<sup>Required</sup> <a name="nextjsRevalidation" id="cdk-nextjs.NextjsGlobalFunctions.property.nextjsRevalidation"></a>

```typescript
public readonly nextjsRevalidation: NextjsRevalidation;
```

- *Type:* <a href="#cdk-nextjs.NextjsRevalidation">NextjsRevalidation</a>

---

##### `nextjsStaticAssets`<sup>Required</sup> <a name="nextjsStaticAssets" id="cdk-nextjs.NextjsGlobalFunctions.property.nextjsStaticAssets"></a>

```typescript
public readonly nextjsStaticAssets: NextjsStaticAssets;
```

- *Type:* <a href="#cdk-nextjs.NextjsStaticAssets">NextjsStaticAssets</a>

---

##### `nextjsVpc`<sup>Required</sup> <a name="nextjsVpc" id="cdk-nextjs.NextjsGlobalFunctions.property.nextjsVpc"></a>

```typescript
public readonly nextjsVpc: NextjsVpc;
```

- *Type:* <a href="#cdk-nextjs.NextjsVpc">NextjsVpc</a>

---


### NextjsInvalidation <a name="NextjsInvalidation" id="cdk-nextjs.NextjsInvalidation"></a>

#### Initializers <a name="Initializers" id="cdk-nextjs.NextjsInvalidation.Initializer"></a>

```typescript
import { NextjsInvalidation } from 'cdk-nextjs'

new NextjsInvalidation(scope: Construct, id: string, props: NextjsInvalidationProps)
```

| **Name** | **Type** | **Description** |
| --- | --- | --- |
| <code><a href="#cdk-nextjs.NextjsInvalidation.Initializer.parameter.scope">scope</a></code> | <code>constructs.Construct</code> | *No description.* |
| <code><a href="#cdk-nextjs.NextjsInvalidation.Initializer.parameter.id">id</a></code> | <code>string</code> | *No description.* |
| <code><a href="#cdk-nextjs.NextjsInvalidation.Initializer.parameter.props">props</a></code> | <code><a href="#cdk-nextjs.NextjsInvalidationProps">NextjsInvalidationProps</a></code> | *No description.* |

---

##### `scope`<sup>Required</sup> <a name="scope" id="cdk-nextjs.NextjsInvalidation.Initializer.parameter.scope"></a>

- *Type:* constructs.Construct

---

##### `id`<sup>Required</sup> <a name="id" id="cdk-nextjs.NextjsInvalidation.Initializer.parameter.id"></a>

- *Type:* string

---

##### `props`<sup>Required</sup> <a name="props" id="cdk-nextjs.NextjsInvalidation.Initializer.parameter.props"></a>

- *Type:* <a href="#cdk-nextjs.NextjsInvalidationProps">NextjsInvalidationProps</a>

---

#### Methods <a name="Methods" id="Methods"></a>

| **Name** | **Description** |
| --- | --- |
| <code><a href="#cdk-nextjs.NextjsInvalidation.toString">toString</a></code> | Returns a string representation of this construct. |

---

##### `toString` <a name="toString" id="cdk-nextjs.NextjsInvalidation.toString"></a>

```typescript
public toString(): string
```

Returns a string representation of this construct.

#### Static Functions <a name="Static Functions" id="Static Functions"></a>

| **Name** | **Description** |
| --- | --- |
| <code><a href="#cdk-nextjs.NextjsInvalidation.isConstruct">isConstruct</a></code> | Checks if `x` is a construct. |

---

##### ~~`isConstruct`~~ <a name="isConstruct" id="cdk-nextjs.NextjsInvalidation.isConstruct"></a>

```typescript
import { NextjsInvalidation } from 'cdk-nextjs'

NextjsInvalidation.isConstruct(x: any)
```

Checks if `x` is a construct.

###### `x`<sup>Required</sup> <a name="x" id="cdk-nextjs.NextjsInvalidation.isConstruct.parameter.x"></a>

- *Type:* any

Any object.

---

#### Properties <a name="Properties" id="Properties"></a>

| **Name** | **Type** | **Description** |
| --- | --- | --- |
| <code><a href="#cdk-nextjs.NextjsInvalidation.property.node">node</a></code> | <code>constructs.Node</code> | The tree node. |

---

##### `node`<sup>Required</sup> <a name="node" id="cdk-nextjs.NextjsInvalidation.property.node"></a>

```typescript
public readonly node: Node;
```

- *Type:* constructs.Node

The tree node.

---


### NextjsRegionalContainers <a name="NextjsRegionalContainers" id="cdk-nextjs.NextjsRegionalContainers"></a>

Deploy Next.js load balanced with containers. Uses [Application Load Balancer](https://docs.aws.amazon.com/elasticloadbalancing/latest/application/introduction.html) for load balancing and [AWS Fargate](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/AWS_Fargate.html) for containers.

#### Initializers <a name="Initializers" id="cdk-nextjs.NextjsRegionalContainers.Initializer"></a>

```typescript
import { NextjsRegionalContainers } from 'cdk-nextjs'

new NextjsRegionalContainers(scope: Construct, id: string, props: NextjsRegionalContainersProps)
```

| **Name** | **Type** | **Description** |
| --- | --- | --- |
| <code><a href="#cdk-nextjs.NextjsRegionalContainers.Initializer.parameter.scope">scope</a></code> | <code>constructs.Construct</code> | *No description.* |
| <code><a href="#cdk-nextjs.NextjsRegionalContainers.Initializer.parameter.id">id</a></code> | <code>string</code> | *No description.* |
| <code><a href="#cdk-nextjs.NextjsRegionalContainers.Initializer.parameter.props">props</a></code> | <code><a href="#cdk-nextjs.NextjsRegionalContainersProps">NextjsRegionalContainersProps</a></code> | *No description.* |

---

##### `scope`<sup>Required</sup> <a name="scope" id="cdk-nextjs.NextjsRegionalContainers.Initializer.parameter.scope"></a>

- *Type:* constructs.Construct

---

##### `id`<sup>Required</sup> <a name="id" id="cdk-nextjs.NextjsRegionalContainers.Initializer.parameter.id"></a>

- *Type:* string

---

##### `props`<sup>Required</sup> <a name="props" id="cdk-nextjs.NextjsRegionalContainers.Initializer.parameter.props"></a>

- *Type:* <a href="#cdk-nextjs.NextjsRegionalContainersProps">NextjsRegionalContainersProps</a>

---

#### Methods <a name="Methods" id="Methods"></a>

| **Name** | **Description** |
| --- | --- |
| <code><a href="#cdk-nextjs.NextjsRegionalContainers.toString">toString</a></code> | Returns a string representation of this construct. |

---

##### `toString` <a name="toString" id="cdk-nextjs.NextjsRegionalContainers.toString"></a>

```typescript
public toString(): string
```

Returns a string representation of this construct.

#### Static Functions <a name="Static Functions" id="Static Functions"></a>

| **Name** | **Description** |
| --- | --- |
| <code><a href="#cdk-nextjs.NextjsRegionalContainers.isConstruct">isConstruct</a></code> | Checks if `x` is a construct. |

---

##### ~~`isConstruct`~~ <a name="isConstruct" id="cdk-nextjs.NextjsRegionalContainers.isConstruct"></a>

```typescript
import { NextjsRegionalContainers } from 'cdk-nextjs'

NextjsRegionalContainers.isConstruct(x: any)
```

Checks if `x` is a construct.

###### `x`<sup>Required</sup> <a name="x" id="cdk-nextjs.NextjsRegionalContainers.isConstruct.parameter.x"></a>

- *Type:* any

Any object.

---

#### Properties <a name="Properties" id="Properties"></a>

| **Name** | **Type** | **Description** |
| --- | --- | --- |
| <code><a href="#cdk-nextjs.NextjsRegionalContainers.property.node">node</a></code> | <code>constructs.Node</code> | The tree node. |
| <code><a href="#cdk-nextjs.NextjsRegionalContainers.property.nextjsAssetsDeployment">nextjsAssetsDeployment</a></code> | <code><a href="#cdk-nextjs.NextjsAssetsDeployment">NextjsAssetsDeployment</a></code> | *No description.* |
| <code><a href="#cdk-nextjs.NextjsRegionalContainers.property.nextjsBuild">nextjsBuild</a></code> | <code><a href="#cdk-nextjs.NextjsBuild">NextjsBuild</a></code> | *No description.* |
| <code><a href="#cdk-nextjs.NextjsRegionalContainers.property.nextjsContainers">nextjsContainers</a></code> | <code><a href="#cdk-nextjs.NextjsContainers">NextjsContainers</a></code> | *No description.* |
| <code><a href="#cdk-nextjs.NextjsRegionalContainers.property.nextjsFileSystem">nextjsFileSystem</a></code> | <code><a href="#cdk-nextjs.NextjsFileSystem">NextjsFileSystem</a></code> | *No description.* |
| <code><a href="#cdk-nextjs.NextjsRegionalContainers.property.nextjsVpc">nextjsVpc</a></code> | <code><a href="#cdk-nextjs.NextjsVpc">NextjsVpc</a></code> | *No description.* |

---

##### `node`<sup>Required</sup> <a name="node" id="cdk-nextjs.NextjsRegionalContainers.property.node"></a>

```typescript
public readonly node: Node;
```

- *Type:* constructs.Node

The tree node.

---

##### `nextjsAssetsDeployment`<sup>Required</sup> <a name="nextjsAssetsDeployment" id="cdk-nextjs.NextjsRegionalContainers.property.nextjsAssetsDeployment"></a>

```typescript
public readonly nextjsAssetsDeployment: NextjsAssetsDeployment;
```

- *Type:* <a href="#cdk-nextjs.NextjsAssetsDeployment">NextjsAssetsDeployment</a>

---

##### `nextjsBuild`<sup>Required</sup> <a name="nextjsBuild" id="cdk-nextjs.NextjsRegionalContainers.property.nextjsBuild"></a>

```typescript
public readonly nextjsBuild: NextjsBuild;
```

- *Type:* <a href="#cdk-nextjs.NextjsBuild">NextjsBuild</a>

---

##### `nextjsContainers`<sup>Required</sup> <a name="nextjsContainers" id="cdk-nextjs.NextjsRegionalContainers.property.nextjsContainers"></a>

```typescript
public readonly nextjsContainers: NextjsContainers;
```

- *Type:* <a href="#cdk-nextjs.NextjsContainers">NextjsContainers</a>

---

##### `nextjsFileSystem`<sup>Required</sup> <a name="nextjsFileSystem" id="cdk-nextjs.NextjsRegionalContainers.property.nextjsFileSystem"></a>

```typescript
public readonly nextjsFileSystem: NextjsFileSystem;
```

- *Type:* <a href="#cdk-nextjs.NextjsFileSystem">NextjsFileSystem</a>

---

##### `nextjsVpc`<sup>Required</sup> <a name="nextjsVpc" id="cdk-nextjs.NextjsRegionalContainers.property.nextjsVpc"></a>

```typescript
public readonly nextjsVpc: NextjsVpc;
```

- *Type:* <a href="#cdk-nextjs.NextjsVpc">NextjsVpc</a>

---


### NextjsRevalidation <a name="NextjsRevalidation" id="cdk-nextjs.NextjsRevalidation"></a>

[On-Demand Revalidation](https://nextjs.org/docs/app/building-your-application/caching#on-demand-revalidation) (i.e. `revalidateTag`, `revlidatePath`) doesn't work by default in Lambda environment because it tries to run every request completes when Lambda spins down. Therefore, we use a SQS Queue and Lambda function to run revalidation async.

#### Initializers <a name="Initializers" id="cdk-nextjs.NextjsRevalidation.Initializer"></a>

```typescript
import { NextjsRevalidation } from 'cdk-nextjs'

new NextjsRevalidation(scope: Construct, id: string, props: NextjsRevalidationProps)
```

| **Name** | **Type** | **Description** |
| --- | --- | --- |
| <code><a href="#cdk-nextjs.NextjsRevalidation.Initializer.parameter.scope">scope</a></code> | <code>constructs.Construct</code> | *No description.* |
| <code><a href="#cdk-nextjs.NextjsRevalidation.Initializer.parameter.id">id</a></code> | <code>string</code> | *No description.* |
| <code><a href="#cdk-nextjs.NextjsRevalidation.Initializer.parameter.props">props</a></code> | <code><a href="#cdk-nextjs.NextjsRevalidationProps">NextjsRevalidationProps</a></code> | *No description.* |

---

##### `scope`<sup>Required</sup> <a name="scope" id="cdk-nextjs.NextjsRevalidation.Initializer.parameter.scope"></a>

- *Type:* constructs.Construct

---

##### `id`<sup>Required</sup> <a name="id" id="cdk-nextjs.NextjsRevalidation.Initializer.parameter.id"></a>

- *Type:* string

---

##### `props`<sup>Required</sup> <a name="props" id="cdk-nextjs.NextjsRevalidation.Initializer.parameter.props"></a>

- *Type:* <a href="#cdk-nextjs.NextjsRevalidationProps">NextjsRevalidationProps</a>

---

#### Methods <a name="Methods" id="Methods"></a>

| **Name** | **Description** |
| --- | --- |
| <code><a href="#cdk-nextjs.NextjsRevalidation.toString">toString</a></code> | Returns a string representation of this construct. |

---

##### `toString` <a name="toString" id="cdk-nextjs.NextjsRevalidation.toString"></a>

```typescript
public toString(): string
```

Returns a string representation of this construct.

#### Static Functions <a name="Static Functions" id="Static Functions"></a>

| **Name** | **Description** |
| --- | --- |
| <code><a href="#cdk-nextjs.NextjsRevalidation.isConstruct">isConstruct</a></code> | Checks if `x` is a construct. |

---

##### ~~`isConstruct`~~ <a name="isConstruct" id="cdk-nextjs.NextjsRevalidation.isConstruct"></a>

```typescript
import { NextjsRevalidation } from 'cdk-nextjs'

NextjsRevalidation.isConstruct(x: any)
```

Checks if `x` is a construct.

###### `x`<sup>Required</sup> <a name="x" id="cdk-nextjs.NextjsRevalidation.isConstruct.parameter.x"></a>

- *Type:* any

Any object.

---

#### Properties <a name="Properties" id="Properties"></a>

| **Name** | **Type** | **Description** |
| --- | --- | --- |
| <code><a href="#cdk-nextjs.NextjsRevalidation.property.node">node</a></code> | <code>constructs.Node</code> | The tree node. |
| <code><a href="#cdk-nextjs.NextjsRevalidation.property.fn">fn</a></code> | <code>aws-cdk-lib.aws_lambda.Function</code> | *No description.* |
| <code><a href="#cdk-nextjs.NextjsRevalidation.property.queue">queue</a></code> | <code>aws-cdk-lib.aws_sqs.Queue</code> | *No description.* |

---

##### `node`<sup>Required</sup> <a name="node" id="cdk-nextjs.NextjsRevalidation.property.node"></a>

```typescript
public readonly node: Node;
```

- *Type:* constructs.Node

The tree node.

---

##### `fn`<sup>Required</sup> <a name="fn" id="cdk-nextjs.NextjsRevalidation.property.fn"></a>

```typescript
public readonly fn: Function;
```

- *Type:* aws-cdk-lib.aws_lambda.Function

---

##### `queue`<sup>Required</sup> <a name="queue" id="cdk-nextjs.NextjsRevalidation.property.queue"></a>

```typescript
public readonly queue: Queue;
```

- *Type:* aws-cdk-lib.aws_sqs.Queue

---


### NextjsStaticAssets <a name="NextjsStaticAssets" id="cdk-nextjs.NextjsStaticAssets"></a>

Creates S3 Bucket for public and _next/static assets.

#### Initializers <a name="Initializers" id="cdk-nextjs.NextjsStaticAssets.Initializer"></a>

```typescript
import { NextjsStaticAssets } from 'cdk-nextjs'

new NextjsStaticAssets(scope: Construct, id: string, props: NextjsStaticAssetsProps)
```

| **Name** | **Type** | **Description** |
| --- | --- | --- |
| <code><a href="#cdk-nextjs.NextjsStaticAssets.Initializer.parameter.scope">scope</a></code> | <code>constructs.Construct</code> | *No description.* |
| <code><a href="#cdk-nextjs.NextjsStaticAssets.Initializer.parameter.id">id</a></code> | <code>string</code> | *No description.* |
| <code><a href="#cdk-nextjs.NextjsStaticAssets.Initializer.parameter.props">props</a></code> | <code><a href="#cdk-nextjs.NextjsStaticAssetsProps">NextjsStaticAssetsProps</a></code> | *No description.* |

---

##### `scope`<sup>Required</sup> <a name="scope" id="cdk-nextjs.NextjsStaticAssets.Initializer.parameter.scope"></a>

- *Type:* constructs.Construct

---

##### `id`<sup>Required</sup> <a name="id" id="cdk-nextjs.NextjsStaticAssets.Initializer.parameter.id"></a>

- *Type:* string

---

##### `props`<sup>Required</sup> <a name="props" id="cdk-nextjs.NextjsStaticAssets.Initializer.parameter.props"></a>

- *Type:* <a href="#cdk-nextjs.NextjsStaticAssetsProps">NextjsStaticAssetsProps</a>

---

#### Methods <a name="Methods" id="Methods"></a>

| **Name** | **Description** |
| --- | --- |
| <code><a href="#cdk-nextjs.NextjsStaticAssets.toString">toString</a></code> | Returns a string representation of this construct. |

---

##### `toString` <a name="toString" id="cdk-nextjs.NextjsStaticAssets.toString"></a>

```typescript
public toString(): string
```

Returns a string representation of this construct.

#### Static Functions <a name="Static Functions" id="Static Functions"></a>

| **Name** | **Description** |
| --- | --- |
| <code><a href="#cdk-nextjs.NextjsStaticAssets.isConstruct">isConstruct</a></code> | Checks if `x` is a construct. |

---

##### ~~`isConstruct`~~ <a name="isConstruct" id="cdk-nextjs.NextjsStaticAssets.isConstruct"></a>

```typescript
import { NextjsStaticAssets } from 'cdk-nextjs'

NextjsStaticAssets.isConstruct(x: any)
```

Checks if `x` is a construct.

###### `x`<sup>Required</sup> <a name="x" id="cdk-nextjs.NextjsStaticAssets.isConstruct.parameter.x"></a>

- *Type:* any

Any object.

---

#### Properties <a name="Properties" id="Properties"></a>

| **Name** | **Type** | **Description** |
| --- | --- | --- |
| <code><a href="#cdk-nextjs.NextjsStaticAssets.property.node">node</a></code> | <code>constructs.Node</code> | The tree node. |
| <code><a href="#cdk-nextjs.NextjsStaticAssets.property.bucket">bucket</a></code> | <code>aws-cdk-lib.aws_s3.Bucket</code> | *No description.* |

---

##### `node`<sup>Required</sup> <a name="node" id="cdk-nextjs.NextjsStaticAssets.property.node"></a>

```typescript
public readonly node: Node;
```

- *Type:* constructs.Node

The tree node.

---

##### `bucket`<sup>Required</sup> <a name="bucket" id="cdk-nextjs.NextjsStaticAssets.property.bucket"></a>

```typescript
public readonly bucket: Bucket;
```

- *Type:* aws-cdk-lib.aws_s3.Bucket

---


### NextjsVpc <a name="NextjsVpc" id="cdk-nextjs.NextjsVpc"></a>

#### Initializers <a name="Initializers" id="cdk-nextjs.NextjsVpc.Initializer"></a>

```typescript
import { NextjsVpc } from 'cdk-nextjs'

new NextjsVpc(scope: Construct, id: string, props: NextjsVpcProps)
```

| **Name** | **Type** | **Description** |
| --- | --- | --- |
| <code><a href="#cdk-nextjs.NextjsVpc.Initializer.parameter.scope">scope</a></code> | <code>constructs.Construct</code> | *No description.* |
| <code><a href="#cdk-nextjs.NextjsVpc.Initializer.parameter.id">id</a></code> | <code>string</code> | *No description.* |
| <code><a href="#cdk-nextjs.NextjsVpc.Initializer.parameter.props">props</a></code> | <code><a href="#cdk-nextjs.NextjsVpcProps">NextjsVpcProps</a></code> | *No description.* |

---

##### `scope`<sup>Required</sup> <a name="scope" id="cdk-nextjs.NextjsVpc.Initializer.parameter.scope"></a>

- *Type:* constructs.Construct

---

##### `id`<sup>Required</sup> <a name="id" id="cdk-nextjs.NextjsVpc.Initializer.parameter.id"></a>

- *Type:* string

---

##### `props`<sup>Required</sup> <a name="props" id="cdk-nextjs.NextjsVpc.Initializer.parameter.props"></a>

- *Type:* <a href="#cdk-nextjs.NextjsVpcProps">NextjsVpcProps</a>

---

#### Methods <a name="Methods" id="Methods"></a>

| **Name** | **Description** |
| --- | --- |
| <code><a href="#cdk-nextjs.NextjsVpc.toString">toString</a></code> | Returns a string representation of this construct. |

---

##### `toString` <a name="toString" id="cdk-nextjs.NextjsVpc.toString"></a>

```typescript
public toString(): string
```

Returns a string representation of this construct.

#### Static Functions <a name="Static Functions" id="Static Functions"></a>

| **Name** | **Description** |
| --- | --- |
| <code><a href="#cdk-nextjs.NextjsVpc.isConstruct">isConstruct</a></code> | Checks if `x` is a construct. |

---

##### ~~`isConstruct`~~ <a name="isConstruct" id="cdk-nextjs.NextjsVpc.isConstruct"></a>

```typescript
import { NextjsVpc } from 'cdk-nextjs'

NextjsVpc.isConstruct(x: any)
```

Checks if `x` is a construct.

###### `x`<sup>Required</sup> <a name="x" id="cdk-nextjs.NextjsVpc.isConstruct.parameter.x"></a>

- *Type:* any

Any object.

---

#### Properties <a name="Properties" id="Properties"></a>

| **Name** | **Type** | **Description** |
| --- | --- | --- |
| <code><a href="#cdk-nextjs.NextjsVpc.property.node">node</a></code> | <code>constructs.Node</code> | The tree node. |
| <code><a href="#cdk-nextjs.NextjsVpc.property.vpc">vpc</a></code> | <code>aws-cdk-lib.aws_ec2.IVpc</code> | *No description.* |

---

##### `node`<sup>Required</sup> <a name="node" id="cdk-nextjs.NextjsVpc.property.node"></a>

```typescript
public readonly node: Node;
```

- *Type:* constructs.Node

The tree node.

---

##### `vpc`<sup>Required</sup> <a name="vpc" id="cdk-nextjs.NextjsVpc.property.vpc"></a>

```typescript
public readonly vpc: IVpc;
```

- *Type:* aws-cdk-lib.aws_ec2.IVpc

---


## Structs <a name="Structs" id="Structs"></a>

### AllowComputeProps <a name="AllowComputeProps" id="cdk-nextjs.AllowComputeProps"></a>

#### Initializer <a name="Initializer" id="cdk-nextjs.AllowComputeProps.Initializer"></a>

```typescript
import { AllowComputeProps } from 'cdk-nextjs'

const allowComputeProps: AllowComputeProps = { ... }
```

#### Properties <a name="Properties" id="Properties"></a>

| **Name** | **Type** | **Description** |
| --- | --- | --- |
| <code><a href="#cdk-nextjs.AllowComputeProps.property.connections">connections</a></code> | <code>aws-cdk-lib.aws_ec2.Connections</code> | *No description.* |
| <code><a href="#cdk-nextjs.AllowComputeProps.property.role">role</a></code> | <code>aws-cdk-lib.aws_iam.IRole</code> | *No description.* |

---

##### `connections`<sup>Required</sup> <a name="connections" id="cdk-nextjs.AllowComputeProps.property.connections"></a>

```typescript
public readonly connections: Connections;
```

- *Type:* aws-cdk-lib.aws_ec2.Connections

---

##### `role`<sup>Required</sup> <a name="role" id="cdk-nextjs.AllowComputeProps.property.role"></a>

```typescript
public readonly role: IRole;
```

- *Type:* aws-cdk-lib.aws_iam.IRole

---

### BaseNextjsConstructOverrides <a name="BaseNextjsConstructOverrides" id="cdk-nextjs.BaseNextjsConstructOverrides"></a>

Base overrides for the props passed to constructs within root/top-level Next.js constructs.

#### Initializer <a name="Initializer" id="cdk-nextjs.BaseNextjsConstructOverrides.Initializer"></a>

```typescript
import { BaseNextjsConstructOverrides } from 'cdk-nextjs'

const baseNextjsConstructOverrides: BaseNextjsConstructOverrides = { ... }
```

#### Properties <a name="Properties" id="Properties"></a>

| **Name** | **Type** | **Description** |
| --- | --- | --- |
| <code><a href="#cdk-nextjs.BaseNextjsConstructOverrides.property.nextjsAssetsDeploymentProps">nextjsAssetsDeploymentProps</a></code> | <code><a href="#cdk-nextjs.OptionalNextjsAssetsDeploymentProps">OptionalNextjsAssetsDeploymentProps</a></code> | *No description.* |
| <code><a href="#cdk-nextjs.BaseNextjsConstructOverrides.property.nextjsBuildProps">nextjsBuildProps</a></code> | <code><a href="#cdk-nextjs.OptionalNextjsBuildProps">OptionalNextjsBuildProps</a></code> | *No description.* |
| <code><a href="#cdk-nextjs.BaseNextjsConstructOverrides.property.nextjsFileSystemProps">nextjsFileSystemProps</a></code> | <code><a href="#cdk-nextjs.OptionalNextjsFileSystemProps">OptionalNextjsFileSystemProps</a></code> | *No description.* |
| <code><a href="#cdk-nextjs.BaseNextjsConstructOverrides.property.nextjsVpcProps">nextjsVpcProps</a></code> | <code><a href="#cdk-nextjs.OptionalNextjsVpcProps">OptionalNextjsVpcProps</a></code> | *No description.* |

---

##### `nextjsAssetsDeploymentProps`<sup>Optional</sup> <a name="nextjsAssetsDeploymentProps" id="cdk-nextjs.BaseNextjsConstructOverrides.property.nextjsAssetsDeploymentProps"></a>

```typescript
public readonly nextjsAssetsDeploymentProps: OptionalNextjsAssetsDeploymentProps;
```

- *Type:* <a href="#cdk-nextjs.OptionalNextjsAssetsDeploymentProps">OptionalNextjsAssetsDeploymentProps</a>

---

##### `nextjsBuildProps`<sup>Optional</sup> <a name="nextjsBuildProps" id="cdk-nextjs.BaseNextjsConstructOverrides.property.nextjsBuildProps"></a>

```typescript
public readonly nextjsBuildProps: OptionalNextjsBuildProps;
```

- *Type:* <a href="#cdk-nextjs.OptionalNextjsBuildProps">OptionalNextjsBuildProps</a>

---

##### `nextjsFileSystemProps`<sup>Optional</sup> <a name="nextjsFileSystemProps" id="cdk-nextjs.BaseNextjsConstructOverrides.property.nextjsFileSystemProps"></a>

```typescript
public readonly nextjsFileSystemProps: OptionalNextjsFileSystemProps;
```

- *Type:* <a href="#cdk-nextjs.OptionalNextjsFileSystemProps">OptionalNextjsFileSystemProps</a>

---

##### `nextjsVpcProps`<sup>Optional</sup> <a name="nextjsVpcProps" id="cdk-nextjs.BaseNextjsConstructOverrides.property.nextjsVpcProps"></a>

```typescript
public readonly nextjsVpcProps: OptionalNextjsVpcProps;
```

- *Type:* <a href="#cdk-nextjs.OptionalNextjsVpcProps">OptionalNextjsVpcProps</a>

---

### BaseNextjsOverrides <a name="BaseNextjsOverrides" id="cdk-nextjs.BaseNextjsOverrides"></a>

Base overrides for constructs shared between all root/top-level Next.js constructs.

#### Initializer <a name="Initializer" id="cdk-nextjs.BaseNextjsOverrides.Initializer"></a>

```typescript
import { BaseNextjsOverrides } from 'cdk-nextjs'

const baseNextjsOverrides: BaseNextjsOverrides = { ... }
```

#### Properties <a name="Properties" id="Properties"></a>

| **Name** | **Type** | **Description** |
| --- | --- | --- |
| <code><a href="#cdk-nextjs.BaseNextjsOverrides.property.nextjsAssetsDeployment">nextjsAssetsDeployment</a></code> | <code><a href="#cdk-nextjs.NextjsAssetDeploymentOverrides">NextjsAssetDeploymentOverrides</a></code> | *No description.* |
| <code><a href="#cdk-nextjs.BaseNextjsOverrides.property.nextjsBuild">nextjsBuild</a></code> | <code><a href="#cdk-nextjs.NextjsBuildOverrides">NextjsBuildOverrides</a></code> | *No description.* |
| <code><a href="#cdk-nextjs.BaseNextjsOverrides.property.nextjsFileSystem">nextjsFileSystem</a></code> | <code><a href="#cdk-nextjs.NextjsFileSystemOverrides">NextjsFileSystemOverrides</a></code> | *No description.* |
| <code><a href="#cdk-nextjs.BaseNextjsOverrides.property.nextjsVpc">nextjsVpc</a></code> | <code><a href="#cdk-nextjs.NextjsVpcOverrides">NextjsVpcOverrides</a></code> | *No description.* |

---

##### `nextjsAssetsDeployment`<sup>Optional</sup> <a name="nextjsAssetsDeployment" id="cdk-nextjs.BaseNextjsOverrides.property.nextjsAssetsDeployment"></a>

```typescript
public readonly nextjsAssetsDeployment: NextjsAssetDeploymentOverrides;
```

- *Type:* <a href="#cdk-nextjs.NextjsAssetDeploymentOverrides">NextjsAssetDeploymentOverrides</a>

---

##### `nextjsBuild`<sup>Optional</sup> <a name="nextjsBuild" id="cdk-nextjs.BaseNextjsOverrides.property.nextjsBuild"></a>

```typescript
public readonly nextjsBuild: NextjsBuildOverrides;
```

- *Type:* <a href="#cdk-nextjs.NextjsBuildOverrides">NextjsBuildOverrides</a>

---

##### `nextjsFileSystem`<sup>Optional</sup> <a name="nextjsFileSystem" id="cdk-nextjs.BaseNextjsOverrides.property.nextjsFileSystem"></a>

```typescript
public readonly nextjsFileSystem: NextjsFileSystemOverrides;
```

- *Type:* <a href="#cdk-nextjs.NextjsFileSystemOverrides">NextjsFileSystemOverrides</a>

---

##### `nextjsVpc`<sup>Optional</sup> <a name="nextjsVpc" id="cdk-nextjs.BaseNextjsOverrides.property.nextjsVpc"></a>

```typescript
public readonly nextjsVpc: NextjsVpcOverrides;
```

- *Type:* <a href="#cdk-nextjs.NextjsVpcOverrides">NextjsVpcOverrides</a>

---

### BuilderImageProps <a name="BuilderImageProps" id="cdk-nextjs.BuilderImageProps"></a>

#### Initializer <a name="Initializer" id="cdk-nextjs.BuilderImageProps.Initializer"></a>

```typescript
import { BuilderImageProps } from 'cdk-nextjs'

const builderImageProps: BuilderImageProps = { ... }
```

#### Properties <a name="Properties" id="Properties"></a>

| **Name** | **Type** | **Description** |
| --- | --- | --- |
| <code><a href="#cdk-nextjs.BuilderImageProps.property.buildArgs">buildArgs</a></code> | <code>{[ key: string ]: string}</code> | Build Args to be passed to `docker build` command. |
| <code><a href="#cdk-nextjs.BuilderImageProps.property.command">command</a></code> | <code>string</code> | `docker build ...` command to run in {@link NextBaseProps.buildContext }. Default interpolates other props. If you override, other props will have no effect on command. |
| <code><a href="#cdk-nextjs.BuilderImageProps.property.customDockerfilePath">customDockerfilePath</a></code> | <code>string</code> | Path to your custom builder.Dockerfile which will be copied into {@link NextBaseProps.buildContext }. It is recommended to override this prop to optimize build caching for your setup. |
| <code><a href="#cdk-nextjs.BuilderImageProps.property.envVarNames">envVarNames</a></code> | <code>string[]</code> | Environment variables names to pass from host to container during build process. |
| <code><a href="#cdk-nextjs.BuilderImageProps.property.exclude">exclude</a></code> | <code>string[]</code> | Lines in .dockerignore file which will be created in your {@link NextBaseProps.buildContext }. |
| <code><a href="#cdk-nextjs.BuilderImageProps.property.file">file</a></code> | <code>string</code> | Name of Dockerfile. |
| <code><a href="#cdk-nextjs.BuilderImageProps.property.platform">platform</a></code> | <code>aws-cdk-lib.aws_ecr_assets.Platform</code> | *No description.* |
| <code><a href="#cdk-nextjs.BuilderImageProps.property.skipBuild">skipBuild</a></code> | <code>boolean</code> | Skip building the builder image. |

---

##### `buildArgs`<sup>Optional</sup> <a name="buildArgs" id="cdk-nextjs.BuilderImageProps.property.buildArgs"></a>

```typescript
public readonly buildArgs: {[ key: string ]: string};
```

- *Type:* {[ key: string ]: string}

Build Args to be passed to `docker build` command.

---

##### `command`<sup>Optional</sup> <a name="command" id="cdk-nextjs.BuilderImageProps.property.command"></a>

```typescript
public readonly command: string;
```

- *Type:* string

`docker build ...` command to run in {@link NextBaseProps.buildContext }. Default interpolates other props. If you override, other props will have no effect on command.

---

##### `customDockerfilePath`<sup>Optional</sup> <a name="customDockerfilePath" id="cdk-nextjs.BuilderImageProps.property.customDockerfilePath"></a>

```typescript
public readonly customDockerfilePath: string;
```

- *Type:* string

Path to your custom builder.Dockerfile which will be copied into {@link NextBaseProps.buildContext }. It is recommended to override this prop to optimize build caching for your setup.

---

##### `envVarNames`<sup>Optional</sup> <a name="envVarNames" id="cdk-nextjs.BuilderImageProps.property.envVarNames"></a>

```typescript
public readonly envVarNames: string[];
```

- *Type:* string[]

Environment variables names to pass from host to container during build process.

Note, a shell script, cdk-nextjs-load-env-vars.sh is created within the
{@link NextBaseProps.buildContext } directory, which will contain all the
environment variables defined in this prop. If you've created your own
custom Dockerfile (passed in via {@link BuilderImageProps.customDockerfilePath})
then you need to make sure you're copying it into the image.

---

*Example*

```typescript
["MY_API_KEY"]
```


##### `exclude`<sup>Optional</sup> <a name="exclude" id="cdk-nextjs.BuilderImageProps.property.exclude"></a>

```typescript
public readonly exclude: string[];
```

- *Type:* string[]
- *Default:* ["node_modules", ".git", ".gitignore", ".md"]

Lines in .dockerignore file which will be created in your {@link NextBaseProps.buildContext }.

---

##### `file`<sup>Optional</sup> <a name="file" id="cdk-nextjs.BuilderImageProps.property.file"></a>

```typescript
public readonly file: string;
```

- *Type:* string
- *Default:* "builder.Dockerfile"

Name of Dockerfile.

---

##### `platform`<sup>Optional</sup> <a name="platform" id="cdk-nextjs.BuilderImageProps.property.platform"></a>

```typescript
public readonly platform: Platform;
```

- *Type:* aws-cdk-lib.aws_ecr_assets.Platform

---

##### `skipBuild`<sup>Optional</sup> <a name="skipBuild" id="cdk-nextjs.BuilderImageProps.property.skipBuild"></a>

```typescript
public readonly skipBuild: boolean;
```

- *Type:* boolean
- *Default:* false

Skip building the builder image.

---

### NextjsAssetDeploymentOverrides <a name="NextjsAssetDeploymentOverrides" id="cdk-nextjs.NextjsAssetDeploymentOverrides"></a>

#### Initializer <a name="Initializer" id="cdk-nextjs.NextjsAssetDeploymentOverrides.Initializer"></a>

```typescript
import { NextjsAssetDeploymentOverrides } from 'cdk-nextjs'

const nextjsAssetDeploymentOverrides: NextjsAssetDeploymentOverrides = { ... }
```

#### Properties <a name="Properties" id="Properties"></a>

| **Name** | **Type** | **Description** |
| --- | --- | --- |
| <code><a href="#cdk-nextjs.NextjsAssetDeploymentOverrides.property.dockerImageFunctionProps">dockerImageFunctionProps</a></code> | <code><a href="#cdk-nextjs.OptionalDockerImageFunctionProps">OptionalDockerImageFunctionProps</a></code> | *No description.* |

---

##### `dockerImageFunctionProps`<sup>Optional</sup> <a name="dockerImageFunctionProps" id="cdk-nextjs.NextjsAssetDeploymentOverrides.property.dockerImageFunctionProps"></a>

```typescript
public readonly dockerImageFunctionProps: OptionalDockerImageFunctionProps;
```

- *Type:* <a href="#cdk-nextjs.OptionalDockerImageFunctionProps">OptionalDockerImageFunctionProps</a>

---

### NextjsAssetsDeploymentProps <a name="NextjsAssetsDeploymentProps" id="cdk-nextjs.NextjsAssetsDeploymentProps"></a>

#### Initializer <a name="Initializer" id="cdk-nextjs.NextjsAssetsDeploymentProps.Initializer"></a>

```typescript
import { NextjsAssetsDeploymentProps } from 'cdk-nextjs'

const nextjsAssetsDeploymentProps: NextjsAssetsDeploymentProps = { ... }
```

#### Properties <a name="Properties" id="Properties"></a>

| **Name** | **Type** | **Description** |
| --- | --- | --- |
| <code><a href="#cdk-nextjs.NextjsAssetsDeploymentProps.property.accessPoint">accessPoint</a></code> | <code>aws-cdk-lib.aws_efs.AccessPoint</code> | *No description.* |
| <code><a href="#cdk-nextjs.NextjsAssetsDeploymentProps.property.buildImageDigest">buildImageDigest</a></code> | <code>string</code> | *No description.* |
| <code><a href="#cdk-nextjs.NextjsAssetsDeploymentProps.property.containerMountPathForEfs">containerMountPathForEfs</a></code> | <code>string</code> | *No description.* |
| <code><a href="#cdk-nextjs.NextjsAssetsDeploymentProps.property.dockerImageCode">dockerImageCode</a></code> | <code>aws-cdk-lib.aws_lambda.DockerImageCode</code> | *No description.* |
| <code><a href="#cdk-nextjs.NextjsAssetsDeploymentProps.property.vpc">vpc</a></code> | <code>aws-cdk-lib.aws_ec2.IVpc</code> | *No description.* |
| <code><a href="#cdk-nextjs.NextjsAssetsDeploymentProps.property.debug">debug</a></code> | <code>boolean</code> | *No description.* |
| <code><a href="#cdk-nextjs.NextjsAssetsDeploymentProps.property.overrides">overrides</a></code> | <code><a href="#cdk-nextjs.NextjsAssetDeploymentOverrides">NextjsAssetDeploymentOverrides</a></code> | *No description.* |
| <code><a href="#cdk-nextjs.NextjsAssetsDeploymentProps.property.relativePathToWorkspace">relativePathToWorkspace</a></code> | <code>string</code> | *No description.* |
| <code><a href="#cdk-nextjs.NextjsAssetsDeploymentProps.property.staticAssetsBucket">staticAssetsBucket</a></code> | <code>aws-cdk-lib.aws_s3.Bucket</code> | Required for `NextjsType.GlobalFunctions` and `NextjsType.GlobalContainers`. |

---

##### `accessPoint`<sup>Required</sup> <a name="accessPoint" id="cdk-nextjs.NextjsAssetsDeploymentProps.property.accessPoint"></a>

```typescript
public readonly accessPoint: AccessPoint;
```

- *Type:* aws-cdk-lib.aws_efs.AccessPoint

---

##### `buildImageDigest`<sup>Required</sup> <a name="buildImageDigest" id="cdk-nextjs.NextjsAssetsDeploymentProps.property.buildImageDigest"></a>

```typescript
public readonly buildImageDigest: string;
```

- *Type:* string

> [{@link NextjsBuild.buildImageDigest }]({@link NextjsBuild.buildImageDigest })

---

##### `containerMountPathForEfs`<sup>Required</sup> <a name="containerMountPathForEfs" id="cdk-nextjs.NextjsAssetsDeploymentProps.property.containerMountPathForEfs"></a>

```typescript
public readonly containerMountPathForEfs: string;
```

- *Type:* string

> [{@link NextjsBuild.containerMountPathForEfs }]({@link NextjsBuild.containerMountPathForEfs })

---

##### `dockerImageCode`<sup>Required</sup> <a name="dockerImageCode" id="cdk-nextjs.NextjsAssetsDeploymentProps.property.dockerImageCode"></a>

```typescript
public readonly dockerImageCode: DockerImageCode;
```

- *Type:* aws-cdk-lib.aws_lambda.DockerImageCode

---

##### `vpc`<sup>Required</sup> <a name="vpc" id="cdk-nextjs.NextjsAssetsDeploymentProps.property.vpc"></a>

```typescript
public readonly vpc: IVpc;
```

- *Type:* aws-cdk-lib.aws_ec2.IVpc

---

##### `debug`<sup>Optional</sup> <a name="debug" id="cdk-nextjs.NextjsAssetsDeploymentProps.property.debug"></a>

```typescript
public readonly debug: boolean;
```

- *Type:* boolean
- *Default:* true

---

##### `overrides`<sup>Optional</sup> <a name="overrides" id="cdk-nextjs.NextjsAssetsDeploymentProps.property.overrides"></a>

```typescript
public readonly overrides: NextjsAssetDeploymentOverrides;
```

- *Type:* <a href="#cdk-nextjs.NextjsAssetDeploymentOverrides">NextjsAssetDeploymentOverrides</a>

---

##### `relativePathToWorkspace`<sup>Optional</sup> <a name="relativePathToWorkspace" id="cdk-nextjs.NextjsAssetsDeploymentProps.property.relativePathToWorkspace"></a>

```typescript
public readonly relativePathToWorkspace: string;
```

- *Type:* string

> [{@link NextjsBaseProps.relativePathToWorkspace }]({@link NextjsBaseProps.relativePathToWorkspace })

---

##### `staticAssetsBucket`<sup>Optional</sup> <a name="staticAssetsBucket" id="cdk-nextjs.NextjsAssetsDeploymentProps.property.staticAssetsBucket"></a>

```typescript
public readonly staticAssetsBucket: Bucket;
```

- *Type:* aws-cdk-lib.aws_s3.Bucket

Required for `NextjsType.GlobalFunctions` and `NextjsType.GlobalContainers`.

---

### NextjsBaseProps <a name="NextjsBaseProps" id="cdk-nextjs.NextjsBaseProps"></a>

#### Initializer <a name="Initializer" id="cdk-nextjs.NextjsBaseProps.Initializer"></a>

```typescript
import { NextjsBaseProps } from 'cdk-nextjs'

const nextjsBaseProps: NextjsBaseProps = { ... }
```

#### Properties <a name="Properties" id="Properties"></a>

| **Name** | **Type** | **Description** |
| --- | --- | --- |
| <code><a href="#cdk-nextjs.NextjsBaseProps.property.buildContext">buildContext</a></code> | <code>string</code> | [Build context](https://docs.docker.com/build/building/context/) for `docker build`. This directory should contain your lockfile (i.e. pnpm-lock.yaml) for your Next.js app. If you're not in a monorepo, then this will be the same directory as your Next.js app. If you are in a monorepo, then this value should be the root of your monorepo. You then must pass the relative path to your Next.js app via {@link NextjsBaseProps.relativePathToWorkspace}. |
| <code><a href="#cdk-nextjs.NextjsBaseProps.property.healthCheckPath">healthCheckPath</a></code> | <code>string</code> | Path to API Route Handler that returns HTTP 200 to ensure compute health. |
| <code><a href="#cdk-nextjs.NextjsBaseProps.property.buildCommand">buildCommand</a></code> | <code>string</code> | Command to generate optimized version of your Next.js app in container; |
| <code><a href="#cdk-nextjs.NextjsBaseProps.property.relativePathToWorkspace">relativePathToWorkspace</a></code> | <code>string</code> | Use this if building in monorepo. |

---

##### `buildContext`<sup>Required</sup> <a name="buildContext" id="cdk-nextjs.NextjsBaseProps.property.buildContext"></a>

```typescript
public readonly buildContext: string;
```

- *Type:* string

[Build context](https://docs.docker.com/build/building/context/) for `docker build`. This directory should contain your lockfile (i.e. pnpm-lock.yaml) for your Next.js app. If you're not in a monorepo, then this will be the same directory as your Next.js app. If you are in a monorepo, then this value should be the root of your monorepo. You then must pass the relative path to your Next.js app via {@link NextjsBaseProps.relativePathToWorkspace}.

---

*Example*

```typescript
fileURLToPath(new URL("../..", import.meta.url)) (monorepo)
```


##### `healthCheckPath`<sup>Required</sup> <a name="healthCheckPath" id="cdk-nextjs.NextjsBaseProps.property.healthCheckPath"></a>

```typescript
public readonly healthCheckPath: string;
```

- *Type:* string

Path to API Route Handler that returns HTTP 200 to ensure compute health.

---

*Example*

```typescript
// api/health/route.ts
import { NextResponse } from "next/server";

export function GET() {
  return NextResponse.json("");
}
```


##### `buildCommand`<sup>Optional</sup> <a name="buildCommand" id="cdk-nextjs.NextjsBaseProps.property.buildCommand"></a>

```typescript
public readonly buildCommand: string;
```

- *Type:* string
- *Default:* "npm run build"

Command to generate optimized version of your Next.js app in container;

---

##### `relativePathToWorkspace`<sup>Optional</sup> <a name="relativePathToWorkspace" id="cdk-nextjs.NextjsBaseProps.property.relativePathToWorkspace"></a>

```typescript
public readonly relativePathToWorkspace: string;
```

- *Type:* string

Use this if building in monorepo.

This is the relative path from
{@link NextjsBaseProps.buildContext} or root workspace to nested workspace
containing Next.js app. See example below:

Let's say you have a monorepo with the following folder structure:
- my-monorepo/
  - packages/
    - ui/
      - package.json (nested)
  - package.json (root)

And your Next.js app directory is the ui folder. Then you would set {@link NextjsBaseProps.buildContext}
to `"/absolute/path/to/my-monorepo"` and {@link NextjsBaseProps.relativePathToWorkspace}
to `"./packages/ui"`.

Note, setting {@link NextjsBaseProps.buildContext} to the root of your
monorepo will invalidate container runtime (i.e. docker) build cache when any file is
changed in your monorepo. This is slows down deployments. Checkout how you
can use [turbo](https://turbo.build/) in [Deploying with Docker Guide](https://turbo.build/repo/docs/handbook/deploying-with-docker)
to achieve better build caching. It's as easy as running
`turbo prune my-app --docker` - no config file required.

---

*Example*

```typescript
"./packages/ui"
```


### NextjsBuildOverrides <a name="NextjsBuildOverrides" id="cdk-nextjs.NextjsBuildOverrides"></a>

#### Initializer <a name="Initializer" id="cdk-nextjs.NextjsBuildOverrides.Initializer"></a>

```typescript
import { NextjsBuildOverrides } from 'cdk-nextjs'

const nextjsBuildOverrides: NextjsBuildOverrides = { ... }
```

#### Properties <a name="Properties" id="Properties"></a>

| **Name** | **Type** | **Description** |
| --- | --- | --- |
| <code><a href="#cdk-nextjs.NextjsBuildOverrides.property.nextjsAssetDeploymentAssetImageCodeProps">nextjsAssetDeploymentAssetImageCodeProps</a></code> | <code>aws-cdk-lib.aws_lambda.AssetImageCodeProps</code> | *No description.* |
| <code><a href="#cdk-nextjs.NextjsBuildOverrides.property.nextjsContainersDockerImageAssetProps">nextjsContainersDockerImageAssetProps</a></code> | <code><a href="#cdk-nextjs.OptionalDockerImageAssetProps">OptionalDockerImageAssetProps</a></code> | *No description.* |
| <code><a href="#cdk-nextjs.NextjsBuildOverrides.property.nextjsFunctionsAssetImageCodeProps">nextjsFunctionsAssetImageCodeProps</a></code> | <code>aws-cdk-lib.aws_lambda.AssetImageCodeProps</code> | *No description.* |

---

##### `nextjsAssetDeploymentAssetImageCodeProps`<sup>Optional</sup> <a name="nextjsAssetDeploymentAssetImageCodeProps" id="cdk-nextjs.NextjsBuildOverrides.property.nextjsAssetDeploymentAssetImageCodeProps"></a>

```typescript
public readonly nextjsAssetDeploymentAssetImageCodeProps: AssetImageCodeProps;
```

- *Type:* aws-cdk-lib.aws_lambda.AssetImageCodeProps

---

##### `nextjsContainersDockerImageAssetProps`<sup>Optional</sup> <a name="nextjsContainersDockerImageAssetProps" id="cdk-nextjs.NextjsBuildOverrides.property.nextjsContainersDockerImageAssetProps"></a>

```typescript
public readonly nextjsContainersDockerImageAssetProps: OptionalDockerImageAssetProps;
```

- *Type:* <a href="#cdk-nextjs.OptionalDockerImageAssetProps">OptionalDockerImageAssetProps</a>

---

##### `nextjsFunctionsAssetImageCodeProps`<sup>Optional</sup> <a name="nextjsFunctionsAssetImageCodeProps" id="cdk-nextjs.NextjsBuildOverrides.property.nextjsFunctionsAssetImageCodeProps"></a>

```typescript
public readonly nextjsFunctionsAssetImageCodeProps: AssetImageCodeProps;
```

- *Type:* aws-cdk-lib.aws_lambda.AssetImageCodeProps

---

### NextjsBuildProps <a name="NextjsBuildProps" id="cdk-nextjs.NextjsBuildProps"></a>

#### Initializer <a name="Initializer" id="cdk-nextjs.NextjsBuildProps.Initializer"></a>

```typescript
import { NextjsBuildProps } from 'cdk-nextjs'

const nextjsBuildProps: NextjsBuildProps = { ... }
```

#### Properties <a name="Properties" id="Properties"></a>

| **Name** | **Type** | **Description** |
| --- | --- | --- |
| <code><a href="#cdk-nextjs.NextjsBuildProps.property.buildContext">buildContext</a></code> | <code>string</code> | *No description.* |
| <code><a href="#cdk-nextjs.NextjsBuildProps.property.nextjsType">nextjsType</a></code> | <code><a href="#cdk-nextjs.NextjsType">NextjsType</a></code> | *No description.* |
| <code><a href="#cdk-nextjs.NextjsBuildProps.property.buildCommand">buildCommand</a></code> | <code>string</code> | *No description.* |
| <code><a href="#cdk-nextjs.NextjsBuildProps.property.builderImageProps">builderImageProps</a></code> | <code><a href="#cdk-nextjs.BuilderImageProps">BuilderImageProps</a></code> | *No description.* |
| <code><a href="#cdk-nextjs.NextjsBuildProps.property.overrides">overrides</a></code> | <code><a href="#cdk-nextjs.NextjsBuildOverrides">NextjsBuildOverrides</a></code> | *No description.* |
| <code><a href="#cdk-nextjs.NextjsBuildProps.property.relativePathToWorkspace">relativePathToWorkspace</a></code> | <code>string</code> | *No description.* |

---

##### `buildContext`<sup>Required</sup> <a name="buildContext" id="cdk-nextjs.NextjsBuildProps.property.buildContext"></a>

```typescript
public readonly buildContext: string;
```

- *Type:* string

> [{@link NextjsBaseProps ["buildContext"]}]({@link NextjsBaseProps ["buildContext"]})

---

##### `nextjsType`<sup>Required</sup> <a name="nextjsType" id="cdk-nextjs.NextjsBuildProps.property.nextjsType"></a>

```typescript
public readonly nextjsType: NextjsType;
```

- *Type:* <a href="#cdk-nextjs.NextjsType">NextjsType</a>

---

##### `buildCommand`<sup>Optional</sup> <a name="buildCommand" id="cdk-nextjs.NextjsBuildProps.property.buildCommand"></a>

```typescript
public readonly buildCommand: string;
```

- *Type:* string

> [{@link NextjsBaseProps ["buildCommand"]}]({@link NextjsBaseProps ["buildCommand"]})

---

##### `builderImageProps`<sup>Optional</sup> <a name="builderImageProps" id="cdk-nextjs.NextjsBuildProps.property.builderImageProps"></a>

```typescript
public readonly builderImageProps: BuilderImageProps;
```

- *Type:* <a href="#cdk-nextjs.BuilderImageProps">BuilderImageProps</a>

---

##### `overrides`<sup>Optional</sup> <a name="overrides" id="cdk-nextjs.NextjsBuildProps.property.overrides"></a>

```typescript
public readonly overrides: NextjsBuildOverrides;
```

- *Type:* <a href="#cdk-nextjs.NextjsBuildOverrides">NextjsBuildOverrides</a>

---

##### `relativePathToWorkspace`<sup>Optional</sup> <a name="relativePathToWorkspace" id="cdk-nextjs.NextjsBuildProps.property.relativePathToWorkspace"></a>

```typescript
public readonly relativePathToWorkspace: string;
```

- *Type:* string

> [{@link NextjsBaseProps.relativePathToWorkspace }]({@link NextjsBaseProps.relativePathToWorkspace })

---

### NextjsComputeBaseProps <a name="NextjsComputeBaseProps" id="cdk-nextjs.NextjsComputeBaseProps"></a>

#### Initializer <a name="Initializer" id="cdk-nextjs.NextjsComputeBaseProps.Initializer"></a>

```typescript
import { NextjsComputeBaseProps } from 'cdk-nextjs'

const nextjsComputeBaseProps: NextjsComputeBaseProps = { ... }
```

#### Properties <a name="Properties" id="Properties"></a>

| **Name** | **Type** | **Description** |
| --- | --- | --- |
| <code><a href="#cdk-nextjs.NextjsComputeBaseProps.property.accessPoint">accessPoint</a></code> | <code>aws-cdk-lib.aws_efs.AccessPoint</code> | *No description.* |
| <code><a href="#cdk-nextjs.NextjsComputeBaseProps.property.containerMountPathForEfs">containerMountPathForEfs</a></code> | <code>string</code> | *No description.* |
| <code><a href="#cdk-nextjs.NextjsComputeBaseProps.property.healthCheckPath">healthCheckPath</a></code> | <code>string</code> | *No description.* |
| <code><a href="#cdk-nextjs.NextjsComputeBaseProps.property.vpc">vpc</a></code> | <code>aws-cdk-lib.aws_ec2.IVpc</code> | *No description.* |

---

##### `accessPoint`<sup>Required</sup> <a name="accessPoint" id="cdk-nextjs.NextjsComputeBaseProps.property.accessPoint"></a>

```typescript
public readonly accessPoint: AccessPoint;
```

- *Type:* aws-cdk-lib.aws_efs.AccessPoint

---

##### `containerMountPathForEfs`<sup>Required</sup> <a name="containerMountPathForEfs" id="cdk-nextjs.NextjsComputeBaseProps.property.containerMountPathForEfs"></a>

```typescript
public readonly containerMountPathForEfs: string;
```

- *Type:* string

---

##### `healthCheckPath`<sup>Required</sup> <a name="healthCheckPath" id="cdk-nextjs.NextjsComputeBaseProps.property.healthCheckPath"></a>

```typescript
public readonly healthCheckPath: string;
```

- *Type:* string

---

##### `vpc`<sup>Required</sup> <a name="vpc" id="cdk-nextjs.NextjsComputeBaseProps.property.vpc"></a>

```typescript
public readonly vpc: IVpc;
```

- *Type:* aws-cdk-lib.aws_ec2.IVpc

---

### NextjsContainersOverrides <a name="NextjsContainersOverrides" id="cdk-nextjs.NextjsContainersOverrides"></a>

#### Initializer <a name="Initializer" id="cdk-nextjs.NextjsContainersOverrides.Initializer"></a>

```typescript
import { NextjsContainersOverrides } from 'cdk-nextjs'

const nextjsContainersOverrides: NextjsContainersOverrides = { ... }
```

#### Properties <a name="Properties" id="Properties"></a>

| **Name** | **Type** | **Description** |
| --- | --- | --- |
| <code><a href="#cdk-nextjs.NextjsContainersOverrides.property.albFargateServiceProps">albFargateServiceProps</a></code> | <code>aws-cdk-lib.aws_ecs_patterns.ApplicationLoadBalancedFargateServiceProps</code> | *No description.* |
| <code><a href="#cdk-nextjs.NextjsContainersOverrides.property.ecsClusterProps">ecsClusterProps</a></code> | <code><a href="#cdk-nextjs.OptionalClusterProps">OptionalClusterProps</a></code> | *No description.* |
| <code><a href="#cdk-nextjs.NextjsContainersOverrides.property.taskImageOptions">taskImageOptions</a></code> | <code><a href="#cdk-nextjs.OptionalApplicationLoadBalancedTaskImageOptions">OptionalApplicationLoadBalancedTaskImageOptions</a></code> | *No description.* |

---

##### `albFargateServiceProps`<sup>Optional</sup> <a name="albFargateServiceProps" id="cdk-nextjs.NextjsContainersOverrides.property.albFargateServiceProps"></a>

```typescript
public readonly albFargateServiceProps: ApplicationLoadBalancedFargateServiceProps;
```

- *Type:* aws-cdk-lib.aws_ecs_patterns.ApplicationLoadBalancedFargateServiceProps

---

##### `ecsClusterProps`<sup>Optional</sup> <a name="ecsClusterProps" id="cdk-nextjs.NextjsContainersOverrides.property.ecsClusterProps"></a>

```typescript
public readonly ecsClusterProps: OptionalClusterProps;
```

- *Type:* <a href="#cdk-nextjs.OptionalClusterProps">OptionalClusterProps</a>

---

##### `taskImageOptions`<sup>Optional</sup> <a name="taskImageOptions" id="cdk-nextjs.NextjsContainersOverrides.property.taskImageOptions"></a>

```typescript
public readonly taskImageOptions: OptionalApplicationLoadBalancedTaskImageOptions;
```

- *Type:* <a href="#cdk-nextjs.OptionalApplicationLoadBalancedTaskImageOptions">OptionalApplicationLoadBalancedTaskImageOptions</a>

---

### NextjsContainersProps <a name="NextjsContainersProps" id="cdk-nextjs.NextjsContainersProps"></a>

#### Initializer <a name="Initializer" id="cdk-nextjs.NextjsContainersProps.Initializer"></a>

```typescript
import { NextjsContainersProps } from 'cdk-nextjs'

const nextjsContainersProps: NextjsContainersProps = { ... }
```

#### Properties <a name="Properties" id="Properties"></a>

| **Name** | **Type** | **Description** |
| --- | --- | --- |
| <code><a href="#cdk-nextjs.NextjsContainersProps.property.accessPoint">accessPoint</a></code> | <code>aws-cdk-lib.aws_efs.AccessPoint</code> | *No description.* |
| <code><a href="#cdk-nextjs.NextjsContainersProps.property.containerMountPathForEfs">containerMountPathForEfs</a></code> | <code>string</code> | *No description.* |
| <code><a href="#cdk-nextjs.NextjsContainersProps.property.healthCheckPath">healthCheckPath</a></code> | <code>string</code> | *No description.* |
| <code><a href="#cdk-nextjs.NextjsContainersProps.property.vpc">vpc</a></code> | <code>aws-cdk-lib.aws_ec2.IVpc</code> | *No description.* |
| <code><a href="#cdk-nextjs.NextjsContainersProps.property.dockerImageAsset">dockerImageAsset</a></code> | <code>aws-cdk-lib.aws_ecr_assets.DockerImageAsset</code> | *No description.* |
| <code><a href="#cdk-nextjs.NextjsContainersProps.property.fileSystem">fileSystem</a></code> | <code>aws-cdk-lib.aws_efs.FileSystem</code> | *No description.* |
| <code><a href="#cdk-nextjs.NextjsContainersProps.property.nextjsType">nextjsType</a></code> | <code><a href="#cdk-nextjs.NextjsType">NextjsType</a></code> | *No description.* |
| <code><a href="#cdk-nextjs.NextjsContainersProps.property.relativeEntrypointPath">relativeEntrypointPath</a></code> | <code>string</code> | *No description.* |
| <code><a href="#cdk-nextjs.NextjsContainersProps.property.overrides">overrides</a></code> | <code><a href="#cdk-nextjs.NextjsContainersOverrides">NextjsContainersOverrides</a></code> | *No description.* |

---

##### `accessPoint`<sup>Required</sup> <a name="accessPoint" id="cdk-nextjs.NextjsContainersProps.property.accessPoint"></a>

```typescript
public readonly accessPoint: AccessPoint;
```

- *Type:* aws-cdk-lib.aws_efs.AccessPoint

---

##### `containerMountPathForEfs`<sup>Required</sup> <a name="containerMountPathForEfs" id="cdk-nextjs.NextjsContainersProps.property.containerMountPathForEfs"></a>

```typescript
public readonly containerMountPathForEfs: string;
```

- *Type:* string

---

##### `healthCheckPath`<sup>Required</sup> <a name="healthCheckPath" id="cdk-nextjs.NextjsContainersProps.property.healthCheckPath"></a>

```typescript
public readonly healthCheckPath: string;
```

- *Type:* string

---

##### `vpc`<sup>Required</sup> <a name="vpc" id="cdk-nextjs.NextjsContainersProps.property.vpc"></a>

```typescript
public readonly vpc: IVpc;
```

- *Type:* aws-cdk-lib.aws_ec2.IVpc

---

##### `dockerImageAsset`<sup>Required</sup> <a name="dockerImageAsset" id="cdk-nextjs.NextjsContainersProps.property.dockerImageAsset"></a>

```typescript
public readonly dockerImageAsset: DockerImageAsset;
```

- *Type:* aws-cdk-lib.aws_ecr_assets.DockerImageAsset

---

##### `fileSystem`<sup>Required</sup> <a name="fileSystem" id="cdk-nextjs.NextjsContainersProps.property.fileSystem"></a>

```typescript
public readonly fileSystem: FileSystem;
```

- *Type:* aws-cdk-lib.aws_efs.FileSystem

---

##### `nextjsType`<sup>Required</sup> <a name="nextjsType" id="cdk-nextjs.NextjsContainersProps.property.nextjsType"></a>

```typescript
public readonly nextjsType: NextjsType;
```

- *Type:* <a href="#cdk-nextjs.NextjsType">NextjsType</a>

---

##### `relativeEntrypointPath`<sup>Required</sup> <a name="relativeEntrypointPath" id="cdk-nextjs.NextjsContainersProps.property.relativeEntrypointPath"></a>

```typescript
public readonly relativeEntrypointPath: string;
```

- *Type:* string

---

##### `overrides`<sup>Optional</sup> <a name="overrides" id="cdk-nextjs.NextjsContainersProps.property.overrides"></a>

```typescript
public readonly overrides: NextjsContainersOverrides;
```

- *Type:* <a href="#cdk-nextjs.NextjsContainersOverrides">NextjsContainersOverrides</a>

---

### NextjsDistributionOverrides <a name="NextjsDistributionOverrides" id="cdk-nextjs.NextjsDistributionOverrides"></a>

#### Initializer <a name="Initializer" id="cdk-nextjs.NextjsDistributionOverrides.Initializer"></a>

```typescript
import { NextjsDistributionOverrides } from 'cdk-nextjs'

const nextjsDistributionOverrides: NextjsDistributionOverrides = { ... }
```

#### Properties <a name="Properties" id="Properties"></a>

| **Name** | **Type** | **Description** |
| --- | --- | --- |
| <code><a href="#cdk-nextjs.NextjsDistributionOverrides.property.distributionProps">distributionProps</a></code> | <code><a href="#cdk-nextjs.OptionalDistributionProps">OptionalDistributionProps</a></code> | *No description.* |
| <code><a href="#cdk-nextjs.NextjsDistributionOverrides.property.dynamicBehaviorOptions">dynamicBehaviorOptions</a></code> | <code>aws-cdk-lib.aws_cloudfront.AddBehaviorOptions</code> | *No description.* |
| <code><a href="#cdk-nextjs.NextjsDistributionOverrides.property.dynamicCachePolicyProps">dynamicCachePolicyProps</a></code> | <code>aws-cdk-lib.aws_cloudfront.CachePolicyProps</code> | *No description.* |
| <code><a href="#cdk-nextjs.NextjsDistributionOverrides.property.dynamicHttpOriginProps">dynamicHttpOriginProps</a></code> | <code>aws-cdk-lib.aws_cloudfront_origins.HttpOriginProps</code> | *No description.* |
| <code><a href="#cdk-nextjs.NextjsDistributionOverrides.property.dynamicResponseHeadersPolicyProps">dynamicResponseHeadersPolicyProps</a></code> | <code>aws-cdk-lib.aws_cloudfront.ResponseHeadersPolicyProps</code> | *No description.* |
| <code><a href="#cdk-nextjs.NextjsDistributionOverrides.property.edgeFunctionProps">edgeFunctionProps</a></code> | <code><a href="#cdk-nextjs.OptionalFunctionProps">OptionalFunctionProps</a></code> | *No description.* |
| <code><a href="#cdk-nextjs.NextjsDistributionOverrides.property.imageBehaviorOptions">imageBehaviorOptions</a></code> | <code>aws-cdk-lib.aws_cloudfront.AddBehaviorOptions</code> | *No description.* |
| <code><a href="#cdk-nextjs.NextjsDistributionOverrides.property.imageCachePolicyProps">imageCachePolicyProps</a></code> | <code>aws-cdk-lib.aws_cloudfront.CachePolicyProps</code> | *No description.* |
| <code><a href="#cdk-nextjs.NextjsDistributionOverrides.property.imageResponseHeadersPolicyProps">imageResponseHeadersPolicyProps</a></code> | <code>aws-cdk-lib.aws_cloudfront.ResponseHeadersPolicyProps</code> | *No description.* |
| <code><a href="#cdk-nextjs.NextjsDistributionOverrides.property.s3OriginProps">s3OriginProps</a></code> | <code><a href="#cdk-nextjs.OptionalS3OriginProps">OptionalS3OriginProps</a></code> | *No description.* |
| <code><a href="#cdk-nextjs.NextjsDistributionOverrides.property.staticBehaviorOptions">staticBehaviorOptions</a></code> | <code>aws-cdk-lib.aws_cloudfront.AddBehaviorOptions</code> | *No description.* |
| <code><a href="#cdk-nextjs.NextjsDistributionOverrides.property.staticResponseHeadersPolicyProps">staticResponseHeadersPolicyProps</a></code> | <code>aws-cdk-lib.aws_cloudfront.ResponseHeadersPolicyProps</code> | *No description.* |

---

##### `distributionProps`<sup>Optional</sup> <a name="distributionProps" id="cdk-nextjs.NextjsDistributionOverrides.property.distributionProps"></a>

```typescript
public readonly distributionProps: OptionalDistributionProps;
```

- *Type:* <a href="#cdk-nextjs.OptionalDistributionProps">OptionalDistributionProps</a>

---

##### `dynamicBehaviorOptions`<sup>Optional</sup> <a name="dynamicBehaviorOptions" id="cdk-nextjs.NextjsDistributionOverrides.property.dynamicBehaviorOptions"></a>

```typescript
public readonly dynamicBehaviorOptions: AddBehaviorOptions;
```

- *Type:* aws-cdk-lib.aws_cloudfront.AddBehaviorOptions

---

##### `dynamicCachePolicyProps`<sup>Optional</sup> <a name="dynamicCachePolicyProps" id="cdk-nextjs.NextjsDistributionOverrides.property.dynamicCachePolicyProps"></a>

```typescript
public readonly dynamicCachePolicyProps: CachePolicyProps;
```

- *Type:* aws-cdk-lib.aws_cloudfront.CachePolicyProps

---

##### `dynamicHttpOriginProps`<sup>Optional</sup> <a name="dynamicHttpOriginProps" id="cdk-nextjs.NextjsDistributionOverrides.property.dynamicHttpOriginProps"></a>

```typescript
public readonly dynamicHttpOriginProps: HttpOriginProps;
```

- *Type:* aws-cdk-lib.aws_cloudfront_origins.HttpOriginProps

---

##### `dynamicResponseHeadersPolicyProps`<sup>Optional</sup> <a name="dynamicResponseHeadersPolicyProps" id="cdk-nextjs.NextjsDistributionOverrides.property.dynamicResponseHeadersPolicyProps"></a>

```typescript
public readonly dynamicResponseHeadersPolicyProps: ResponseHeadersPolicyProps;
```

- *Type:* aws-cdk-lib.aws_cloudfront.ResponseHeadersPolicyProps

---

##### `edgeFunctionProps`<sup>Optional</sup> <a name="edgeFunctionProps" id="cdk-nextjs.NextjsDistributionOverrides.property.edgeFunctionProps"></a>

```typescript
public readonly edgeFunctionProps: OptionalFunctionProps;
```

- *Type:* <a href="#cdk-nextjs.OptionalFunctionProps">OptionalFunctionProps</a>

---

##### `imageBehaviorOptions`<sup>Optional</sup> <a name="imageBehaviorOptions" id="cdk-nextjs.NextjsDistributionOverrides.property.imageBehaviorOptions"></a>

```typescript
public readonly imageBehaviorOptions: AddBehaviorOptions;
```

- *Type:* aws-cdk-lib.aws_cloudfront.AddBehaviorOptions

---

##### `imageCachePolicyProps`<sup>Optional</sup> <a name="imageCachePolicyProps" id="cdk-nextjs.NextjsDistributionOverrides.property.imageCachePolicyProps"></a>

```typescript
public readonly imageCachePolicyProps: CachePolicyProps;
```

- *Type:* aws-cdk-lib.aws_cloudfront.CachePolicyProps

---

##### `imageResponseHeadersPolicyProps`<sup>Optional</sup> <a name="imageResponseHeadersPolicyProps" id="cdk-nextjs.NextjsDistributionOverrides.property.imageResponseHeadersPolicyProps"></a>

```typescript
public readonly imageResponseHeadersPolicyProps: ResponseHeadersPolicyProps;
```

- *Type:* aws-cdk-lib.aws_cloudfront.ResponseHeadersPolicyProps

---

##### `s3OriginProps`<sup>Optional</sup> <a name="s3OriginProps" id="cdk-nextjs.NextjsDistributionOverrides.property.s3OriginProps"></a>

```typescript
public readonly s3OriginProps: OptionalS3OriginProps;
```

- *Type:* <a href="#cdk-nextjs.OptionalS3OriginProps">OptionalS3OriginProps</a>

---

##### `staticBehaviorOptions`<sup>Optional</sup> <a name="staticBehaviorOptions" id="cdk-nextjs.NextjsDistributionOverrides.property.staticBehaviorOptions"></a>

```typescript
public readonly staticBehaviorOptions: AddBehaviorOptions;
```

- *Type:* aws-cdk-lib.aws_cloudfront.AddBehaviorOptions

---

##### `staticResponseHeadersPolicyProps`<sup>Optional</sup> <a name="staticResponseHeadersPolicyProps" id="cdk-nextjs.NextjsDistributionOverrides.property.staticResponseHeadersPolicyProps"></a>

```typescript
public readonly staticResponseHeadersPolicyProps: ResponseHeadersPolicyProps;
```

- *Type:* aws-cdk-lib.aws_cloudfront.ResponseHeadersPolicyProps

---

### NextjsDistributionProps <a name="NextjsDistributionProps" id="cdk-nextjs.NextjsDistributionProps"></a>

#### Initializer <a name="Initializer" id="cdk-nextjs.NextjsDistributionProps.Initializer"></a>

```typescript
import { NextjsDistributionProps } from 'cdk-nextjs'

const nextjsDistributionProps: NextjsDistributionProps = { ... }
```

#### Properties <a name="Properties" id="Properties"></a>

| **Name** | **Type** | **Description** |
| --- | --- | --- |
| <code><a href="#cdk-nextjs.NextjsDistributionProps.property.assetsBucket">assetsBucket</a></code> | <code>aws-cdk-lib.aws_s3.IBucket</code> | Bucket containing static assets. |
| <code><a href="#cdk-nextjs.NextjsDistributionProps.property.dynamicUrl">dynamicUrl</a></code> | <code>string</code> | Dynamic (Next.js server) URL to add behavior to distribution. |
| <code><a href="#cdk-nextjs.NextjsDistributionProps.property.nextjsType">nextjsType</a></code> | <code><a href="#cdk-nextjs.NextjsType">NextjsType</a></code> | *No description.* |
| <code><a href="#cdk-nextjs.NextjsDistributionProps.property.publicDirEntries">publicDirEntries</a></code> | <code><a href="#cdk-nextjs.PublicDirEntry">PublicDirEntry</a>[]</code> | Path to directory of Next.js app's public directory. Used to add static behaviors to distribution. |
| <code><a href="#cdk-nextjs.NextjsDistributionProps.property.basePath">basePath</a></code> | <code>string</code> | *No description.* |
| <code><a href="#cdk-nextjs.NextjsDistributionProps.property.certificate">certificate</a></code> | <code>aws-cdk-lib.aws_certificatemanager.ICertificate</code> | Optional but only applicable for `NextjsType.GLOBAL_CONTAINERS`. |
| <code><a href="#cdk-nextjs.NextjsDistributionProps.property.distribution">distribution</a></code> | <code>aws-cdk-lib.aws_cloudfront.Distribution</code> | *No description.* |
| <code><a href="#cdk-nextjs.NextjsDistributionProps.property.functionArn">functionArn</a></code> | <code>string</code> | Required if `NextjsType.GLOBAL_FUNCTIONS`. |
| <code><a href="#cdk-nextjs.NextjsDistributionProps.property.overrides">overrides</a></code> | <code><a href="#cdk-nextjs.NextjsDistributionOverrides">NextjsDistributionOverrides</a></code> | Override props for every construct. |

---

##### `assetsBucket`<sup>Required</sup> <a name="assetsBucket" id="cdk-nextjs.NextjsDistributionProps.property.assetsBucket"></a>

```typescript
public readonly assetsBucket: IBucket;
```

- *Type:* aws-cdk-lib.aws_s3.IBucket

Bucket containing static assets.

Must be provided if you want to serve static files.

---

##### `dynamicUrl`<sup>Required</sup> <a name="dynamicUrl" id="cdk-nextjs.NextjsDistributionProps.property.dynamicUrl"></a>

```typescript
public readonly dynamicUrl: string;
```

- *Type:* string

Dynamic (Next.js server) URL to add behavior to distribution.

---

##### `nextjsType`<sup>Required</sup> <a name="nextjsType" id="cdk-nextjs.NextjsDistributionProps.property.nextjsType"></a>

```typescript
public readonly nextjsType: NextjsType;
```

- *Type:* <a href="#cdk-nextjs.NextjsType">NextjsType</a>

---

##### `publicDirEntries`<sup>Required</sup> <a name="publicDirEntries" id="cdk-nextjs.NextjsDistributionProps.property.publicDirEntries"></a>

```typescript
public readonly publicDirEntries: PublicDirEntry[];
```

- *Type:* <a href="#cdk-nextjs.PublicDirEntry">PublicDirEntry</a>[]

Path to directory of Next.js app's public directory. Used to add static behaviors to distribution.

---

##### `basePath`<sup>Optional</sup> <a name="basePath" id="cdk-nextjs.NextjsDistributionProps.property.basePath"></a>

```typescript
public readonly basePath: string;
```

- *Type:* string

---

##### `certificate`<sup>Optional</sup> <a name="certificate" id="cdk-nextjs.NextjsDistributionProps.property.certificate"></a>

```typescript
public readonly certificate: ICertificate;
```

- *Type:* aws-cdk-lib.aws_certificatemanager.ICertificate

Optional but only applicable for `NextjsType.GLOBAL_CONTAINERS`.

---

##### `distribution`<sup>Optional</sup> <a name="distribution" id="cdk-nextjs.NextjsDistributionProps.property.distribution"></a>

```typescript
public readonly distribution: Distribution;
```

- *Type:* aws-cdk-lib.aws_cloudfront.Distribution

---

##### `functionArn`<sup>Optional</sup> <a name="functionArn" id="cdk-nextjs.NextjsDistributionProps.property.functionArn"></a>

```typescript
public readonly functionArn: string;
```

- *Type:* string

Required if `NextjsType.GLOBAL_FUNCTIONS`.

---

##### `overrides`<sup>Optional</sup> <a name="overrides" id="cdk-nextjs.NextjsDistributionProps.property.overrides"></a>

```typescript
public readonly overrides: NextjsDistributionOverrides;
```

- *Type:* <a href="#cdk-nextjs.NextjsDistributionOverrides">NextjsDistributionOverrides</a>

Override props for every construct.

---

### NextjsFileSystemOverrides <a name="NextjsFileSystemOverrides" id="cdk-nextjs.NextjsFileSystemOverrides"></a>

#### Initializer <a name="Initializer" id="cdk-nextjs.NextjsFileSystemOverrides.Initializer"></a>

```typescript
import { NextjsFileSystemOverrides } from 'cdk-nextjs'

const nextjsFileSystemOverrides: NextjsFileSystemOverrides = { ... }
```

#### Properties <a name="Properties" id="Properties"></a>

| **Name** | **Type** | **Description** |
| --- | --- | --- |
| <code><a href="#cdk-nextjs.NextjsFileSystemOverrides.property.accessPointProps">accessPointProps</a></code> | <code>aws-cdk-lib.aws_efs.AccessPointProps</code> | *No description.* |
| <code><a href="#cdk-nextjs.NextjsFileSystemOverrides.property.fileSystemProps">fileSystemProps</a></code> | <code>aws-cdk-lib.aws_efs.FileSystemProps</code> | *No description.* |

---

##### `accessPointProps`<sup>Optional</sup> <a name="accessPointProps" id="cdk-nextjs.NextjsFileSystemOverrides.property.accessPointProps"></a>

```typescript
public readonly accessPointProps: AccessPointProps;
```

- *Type:* aws-cdk-lib.aws_efs.AccessPointProps

---

##### `fileSystemProps`<sup>Optional</sup> <a name="fileSystemProps" id="cdk-nextjs.NextjsFileSystemOverrides.property.fileSystemProps"></a>

```typescript
public readonly fileSystemProps: FileSystemProps;
```

- *Type:* aws-cdk-lib.aws_efs.FileSystemProps

---

### NextjsFileSystemProps <a name="NextjsFileSystemProps" id="cdk-nextjs.NextjsFileSystemProps"></a>

#### Initializer <a name="Initializer" id="cdk-nextjs.NextjsFileSystemProps.Initializer"></a>

```typescript
import { NextjsFileSystemProps } from 'cdk-nextjs'

const nextjsFileSystemProps: NextjsFileSystemProps = { ... }
```

#### Properties <a name="Properties" id="Properties"></a>

| **Name** | **Type** | **Description** |
| --- | --- | --- |
| <code><a href="#cdk-nextjs.NextjsFileSystemProps.property.vpc">vpc</a></code> | <code>aws-cdk-lib.aws_ec2.IVpc</code> | *No description.* |
| <code><a href="#cdk-nextjs.NextjsFileSystemProps.property.overrides">overrides</a></code> | <code><a href="#cdk-nextjs.NextjsFileSystemOverrides">NextjsFileSystemOverrides</a></code> | *No description.* |

---

##### `vpc`<sup>Required</sup> <a name="vpc" id="cdk-nextjs.NextjsFileSystemProps.property.vpc"></a>

```typescript
public readonly vpc: IVpc;
```

- *Type:* aws-cdk-lib.aws_ec2.IVpc

---

##### `overrides`<sup>Optional</sup> <a name="overrides" id="cdk-nextjs.NextjsFileSystemProps.property.overrides"></a>

```typescript
public readonly overrides: NextjsFileSystemOverrides;
```

- *Type:* <a href="#cdk-nextjs.NextjsFileSystemOverrides">NextjsFileSystemOverrides</a>

---

### NextjsFunctionsOverrides <a name="NextjsFunctionsOverrides" id="cdk-nextjs.NextjsFunctionsOverrides"></a>

#### Initializer <a name="Initializer" id="cdk-nextjs.NextjsFunctionsOverrides.Initializer"></a>

```typescript
import { NextjsFunctionsOverrides } from 'cdk-nextjs'

const nextjsFunctionsOverrides: NextjsFunctionsOverrides = { ... }
```

#### Properties <a name="Properties" id="Properties"></a>

| **Name** | **Type** | **Description** |
| --- | --- | --- |
| <code><a href="#cdk-nextjs.NextjsFunctionsOverrides.property.dockerImageFunctionProps">dockerImageFunctionProps</a></code> | <code><a href="#cdk-nextjs.OptionalDockerImageFunctionProps">OptionalDockerImageFunctionProps</a></code> | *No description.* |
| <code><a href="#cdk-nextjs.NextjsFunctionsOverrides.property.functionUrlProps">functionUrlProps</a></code> | <code><a href="#cdk-nextjs.OptionalFunctionUrlProps">OptionalFunctionUrlProps</a></code> | *No description.* |

---

##### `dockerImageFunctionProps`<sup>Optional</sup> <a name="dockerImageFunctionProps" id="cdk-nextjs.NextjsFunctionsOverrides.property.dockerImageFunctionProps"></a>

```typescript
public readonly dockerImageFunctionProps: OptionalDockerImageFunctionProps;
```

- *Type:* <a href="#cdk-nextjs.OptionalDockerImageFunctionProps">OptionalDockerImageFunctionProps</a>

---

##### `functionUrlProps`<sup>Optional</sup> <a name="functionUrlProps" id="cdk-nextjs.NextjsFunctionsOverrides.property.functionUrlProps"></a>

```typescript
public readonly functionUrlProps: OptionalFunctionUrlProps;
```

- *Type:* <a href="#cdk-nextjs.OptionalFunctionUrlProps">OptionalFunctionUrlProps</a>

---

### NextjsFunctionsProps <a name="NextjsFunctionsProps" id="cdk-nextjs.NextjsFunctionsProps"></a>

#### Initializer <a name="Initializer" id="cdk-nextjs.NextjsFunctionsProps.Initializer"></a>

```typescript
import { NextjsFunctionsProps } from 'cdk-nextjs'

const nextjsFunctionsProps: NextjsFunctionsProps = { ... }
```

#### Properties <a name="Properties" id="Properties"></a>

| **Name** | **Type** | **Description** |
| --- | --- | --- |
| <code><a href="#cdk-nextjs.NextjsFunctionsProps.property.accessPoint">accessPoint</a></code> | <code>aws-cdk-lib.aws_efs.AccessPoint</code> | *No description.* |
| <code><a href="#cdk-nextjs.NextjsFunctionsProps.property.containerMountPathForEfs">containerMountPathForEfs</a></code> | <code>string</code> | *No description.* |
| <code><a href="#cdk-nextjs.NextjsFunctionsProps.property.healthCheckPath">healthCheckPath</a></code> | <code>string</code> | *No description.* |
| <code><a href="#cdk-nextjs.NextjsFunctionsProps.property.vpc">vpc</a></code> | <code>aws-cdk-lib.aws_ec2.IVpc</code> | *No description.* |
| <code><a href="#cdk-nextjs.NextjsFunctionsProps.property.dockerImageCode">dockerImageCode</a></code> | <code>aws-cdk-lib.aws_lambda.DockerImageCode</code> | *No description.* |
| <code><a href="#cdk-nextjs.NextjsFunctionsProps.property.overrides">overrides</a></code> | <code><a href="#cdk-nextjs.NextjsFunctionsOverrides">NextjsFunctionsOverrides</a></code> | *No description.* |

---

##### `accessPoint`<sup>Required</sup> <a name="accessPoint" id="cdk-nextjs.NextjsFunctionsProps.property.accessPoint"></a>

```typescript
public readonly accessPoint: AccessPoint;
```

- *Type:* aws-cdk-lib.aws_efs.AccessPoint

---

##### `containerMountPathForEfs`<sup>Required</sup> <a name="containerMountPathForEfs" id="cdk-nextjs.NextjsFunctionsProps.property.containerMountPathForEfs"></a>

```typescript
public readonly containerMountPathForEfs: string;
```

- *Type:* string

---

##### `healthCheckPath`<sup>Required</sup> <a name="healthCheckPath" id="cdk-nextjs.NextjsFunctionsProps.property.healthCheckPath"></a>

```typescript
public readonly healthCheckPath: string;
```

- *Type:* string

---

##### `vpc`<sup>Required</sup> <a name="vpc" id="cdk-nextjs.NextjsFunctionsProps.property.vpc"></a>

```typescript
public readonly vpc: IVpc;
```

- *Type:* aws-cdk-lib.aws_ec2.IVpc

---

##### `dockerImageCode`<sup>Required</sup> <a name="dockerImageCode" id="cdk-nextjs.NextjsFunctionsProps.property.dockerImageCode"></a>

```typescript
public readonly dockerImageCode: DockerImageCode;
```

- *Type:* aws-cdk-lib.aws_lambda.DockerImageCode

---

##### `overrides`<sup>Optional</sup> <a name="overrides" id="cdk-nextjs.NextjsFunctionsProps.property.overrides"></a>

```typescript
public readonly overrides: NextjsFunctionsOverrides;
```

- *Type:* <a href="#cdk-nextjs.NextjsFunctionsOverrides">NextjsFunctionsOverrides</a>

---

### NextjsGlobalContainersConstructOverrides <a name="NextjsGlobalContainersConstructOverrides" id="cdk-nextjs.NextjsGlobalContainersConstructOverrides"></a>

#### Initializer <a name="Initializer" id="cdk-nextjs.NextjsGlobalContainersConstructOverrides.Initializer"></a>

```typescript
import { NextjsGlobalContainersConstructOverrides } from 'cdk-nextjs'

const nextjsGlobalContainersConstructOverrides: NextjsGlobalContainersConstructOverrides = { ... }
```

#### Properties <a name="Properties" id="Properties"></a>

| **Name** | **Type** | **Description** |
| --- | --- | --- |
| <code><a href="#cdk-nextjs.NextjsGlobalContainersConstructOverrides.property.nextjsAssetsDeploymentProps">nextjsAssetsDeploymentProps</a></code> | <code><a href="#cdk-nextjs.OptionalNextjsAssetsDeploymentProps">OptionalNextjsAssetsDeploymentProps</a></code> | *No description.* |
| <code><a href="#cdk-nextjs.NextjsGlobalContainersConstructOverrides.property.nextjsBuildProps">nextjsBuildProps</a></code> | <code><a href="#cdk-nextjs.OptionalNextjsBuildProps">OptionalNextjsBuildProps</a></code> | *No description.* |
| <code><a href="#cdk-nextjs.NextjsGlobalContainersConstructOverrides.property.nextjsFileSystemProps">nextjsFileSystemProps</a></code> | <code><a href="#cdk-nextjs.OptionalNextjsFileSystemProps">OptionalNextjsFileSystemProps</a></code> | *No description.* |
| <code><a href="#cdk-nextjs.NextjsGlobalContainersConstructOverrides.property.nextjsVpcProps">nextjsVpcProps</a></code> | <code><a href="#cdk-nextjs.OptionalNextjsVpcProps">OptionalNextjsVpcProps</a></code> | *No description.* |
| <code><a href="#cdk-nextjs.NextjsGlobalContainersConstructOverrides.property.nextjsContainersProps">nextjsContainersProps</a></code> | <code><a href="#cdk-nextjs.OptionalNextjsContainersProps">OptionalNextjsContainersProps</a></code> | *No description.* |
| <code><a href="#cdk-nextjs.NextjsGlobalContainersConstructOverrides.property.nextjsDistributionProps">nextjsDistributionProps</a></code> | <code><a href="#cdk-nextjs.OptionalNextjsDistributionProps">OptionalNextjsDistributionProps</a></code> | *No description.* |
| <code><a href="#cdk-nextjs.NextjsGlobalContainersConstructOverrides.property.nextjsInvalidationProps">nextjsInvalidationProps</a></code> | <code><a href="#cdk-nextjs.OptionalNextjsInvalidationProps">OptionalNextjsInvalidationProps</a></code> | *No description.* |
| <code><a href="#cdk-nextjs.NextjsGlobalContainersConstructOverrides.property.nextjsRevalidationProps">nextjsRevalidationProps</a></code> | <code><a href="#cdk-nextjs.NextjsRevalidationProps">NextjsRevalidationProps</a></code> | *No description.* |
| <code><a href="#cdk-nextjs.NextjsGlobalContainersConstructOverrides.property.nextjsStaticAssetsProps">nextjsStaticAssetsProps</a></code> | <code><a href="#cdk-nextjs.NextjsStaticAssetsProps">NextjsStaticAssetsProps</a></code> | *No description.* |

---

##### `nextjsAssetsDeploymentProps`<sup>Optional</sup> <a name="nextjsAssetsDeploymentProps" id="cdk-nextjs.NextjsGlobalContainersConstructOverrides.property.nextjsAssetsDeploymentProps"></a>

```typescript
public readonly nextjsAssetsDeploymentProps: OptionalNextjsAssetsDeploymentProps;
```

- *Type:* <a href="#cdk-nextjs.OptionalNextjsAssetsDeploymentProps">OptionalNextjsAssetsDeploymentProps</a>

---

##### `nextjsBuildProps`<sup>Optional</sup> <a name="nextjsBuildProps" id="cdk-nextjs.NextjsGlobalContainersConstructOverrides.property.nextjsBuildProps"></a>

```typescript
public readonly nextjsBuildProps: OptionalNextjsBuildProps;
```

- *Type:* <a href="#cdk-nextjs.OptionalNextjsBuildProps">OptionalNextjsBuildProps</a>

---

##### `nextjsFileSystemProps`<sup>Optional</sup> <a name="nextjsFileSystemProps" id="cdk-nextjs.NextjsGlobalContainersConstructOverrides.property.nextjsFileSystemProps"></a>

```typescript
public readonly nextjsFileSystemProps: OptionalNextjsFileSystemProps;
```

- *Type:* <a href="#cdk-nextjs.OptionalNextjsFileSystemProps">OptionalNextjsFileSystemProps</a>

---

##### `nextjsVpcProps`<sup>Optional</sup> <a name="nextjsVpcProps" id="cdk-nextjs.NextjsGlobalContainersConstructOverrides.property.nextjsVpcProps"></a>

```typescript
public readonly nextjsVpcProps: OptionalNextjsVpcProps;
```

- *Type:* <a href="#cdk-nextjs.OptionalNextjsVpcProps">OptionalNextjsVpcProps</a>

---

##### `nextjsContainersProps`<sup>Optional</sup> <a name="nextjsContainersProps" id="cdk-nextjs.NextjsGlobalContainersConstructOverrides.property.nextjsContainersProps"></a>

```typescript
public readonly nextjsContainersProps: OptionalNextjsContainersProps;
```

- *Type:* <a href="#cdk-nextjs.OptionalNextjsContainersProps">OptionalNextjsContainersProps</a>

---

##### `nextjsDistributionProps`<sup>Optional</sup> <a name="nextjsDistributionProps" id="cdk-nextjs.NextjsGlobalContainersConstructOverrides.property.nextjsDistributionProps"></a>

```typescript
public readonly nextjsDistributionProps: OptionalNextjsDistributionProps;
```

- *Type:* <a href="#cdk-nextjs.OptionalNextjsDistributionProps">OptionalNextjsDistributionProps</a>

---

##### `nextjsInvalidationProps`<sup>Optional</sup> <a name="nextjsInvalidationProps" id="cdk-nextjs.NextjsGlobalContainersConstructOverrides.property.nextjsInvalidationProps"></a>

```typescript
public readonly nextjsInvalidationProps: OptionalNextjsInvalidationProps;
```

- *Type:* <a href="#cdk-nextjs.OptionalNextjsInvalidationProps">OptionalNextjsInvalidationProps</a>

---

##### `nextjsRevalidationProps`<sup>Optional</sup> <a name="nextjsRevalidationProps" id="cdk-nextjs.NextjsGlobalContainersConstructOverrides.property.nextjsRevalidationProps"></a>

```typescript
public readonly nextjsRevalidationProps: NextjsRevalidationProps;
```

- *Type:* <a href="#cdk-nextjs.NextjsRevalidationProps">NextjsRevalidationProps</a>

---

##### `nextjsStaticAssetsProps`<sup>Optional</sup> <a name="nextjsStaticAssetsProps" id="cdk-nextjs.NextjsGlobalContainersConstructOverrides.property.nextjsStaticAssetsProps"></a>

```typescript
public readonly nextjsStaticAssetsProps: NextjsStaticAssetsProps;
```

- *Type:* <a href="#cdk-nextjs.NextjsStaticAssetsProps">NextjsStaticAssetsProps</a>

---

### NextjsGlobalContainersOverrides <a name="NextjsGlobalContainersOverrides" id="cdk-nextjs.NextjsGlobalContainersOverrides"></a>

#### Initializer <a name="Initializer" id="cdk-nextjs.NextjsGlobalContainersOverrides.Initializer"></a>

```typescript
import { NextjsGlobalContainersOverrides } from 'cdk-nextjs'

const nextjsGlobalContainersOverrides: NextjsGlobalContainersOverrides = { ... }
```

#### Properties <a name="Properties" id="Properties"></a>

| **Name** | **Type** | **Description** |
| --- | --- | --- |
| <code><a href="#cdk-nextjs.NextjsGlobalContainersOverrides.property.nextjsAssetsDeployment">nextjsAssetsDeployment</a></code> | <code><a href="#cdk-nextjs.NextjsAssetDeploymentOverrides">NextjsAssetDeploymentOverrides</a></code> | *No description.* |
| <code><a href="#cdk-nextjs.NextjsGlobalContainersOverrides.property.nextjsBuild">nextjsBuild</a></code> | <code><a href="#cdk-nextjs.NextjsBuildOverrides">NextjsBuildOverrides</a></code> | *No description.* |
| <code><a href="#cdk-nextjs.NextjsGlobalContainersOverrides.property.nextjsFileSystem">nextjsFileSystem</a></code> | <code><a href="#cdk-nextjs.NextjsFileSystemOverrides">NextjsFileSystemOverrides</a></code> | *No description.* |
| <code><a href="#cdk-nextjs.NextjsGlobalContainersOverrides.property.nextjsVpc">nextjsVpc</a></code> | <code><a href="#cdk-nextjs.NextjsVpcOverrides">NextjsVpcOverrides</a></code> | *No description.* |
| <code><a href="#cdk-nextjs.NextjsGlobalContainersOverrides.property.nextjsContainers">nextjsContainers</a></code> | <code><a href="#cdk-nextjs.NextjsContainersOverrides">NextjsContainersOverrides</a></code> | *No description.* |
| <code><a href="#cdk-nextjs.NextjsGlobalContainersOverrides.property.nextjsDistribution">nextjsDistribution</a></code> | <code><a href="#cdk-nextjs.NextjsDistributionOverrides">NextjsDistributionOverrides</a></code> | *No description.* |
| <code><a href="#cdk-nextjs.NextjsGlobalContainersOverrides.property.nextjsGlobalContainers">nextjsGlobalContainers</a></code> | <code><a href="#cdk-nextjs.NextjsGlobalContainersConstructOverrides">NextjsGlobalContainersConstructOverrides</a></code> | *No description.* |
| <code><a href="#cdk-nextjs.NextjsGlobalContainersOverrides.property.nextjsInvalidation">nextjsInvalidation</a></code> | <code><a href="#cdk-nextjs.NextjsInvalidationOverrides">NextjsInvalidationOverrides</a></code> | *No description.* |
| <code><a href="#cdk-nextjs.NextjsGlobalContainersOverrides.property.nextjsStaticAssets">nextjsStaticAssets</a></code> | <code><a href="#cdk-nextjs.NextjsStaticAssetsOverrides">NextjsStaticAssetsOverrides</a></code> | *No description.* |

---

##### `nextjsAssetsDeployment`<sup>Optional</sup> <a name="nextjsAssetsDeployment" id="cdk-nextjs.NextjsGlobalContainersOverrides.property.nextjsAssetsDeployment"></a>

```typescript
public readonly nextjsAssetsDeployment: NextjsAssetDeploymentOverrides;
```

- *Type:* <a href="#cdk-nextjs.NextjsAssetDeploymentOverrides">NextjsAssetDeploymentOverrides</a>

---

##### `nextjsBuild`<sup>Optional</sup> <a name="nextjsBuild" id="cdk-nextjs.NextjsGlobalContainersOverrides.property.nextjsBuild"></a>

```typescript
public readonly nextjsBuild: NextjsBuildOverrides;
```

- *Type:* <a href="#cdk-nextjs.NextjsBuildOverrides">NextjsBuildOverrides</a>

---

##### `nextjsFileSystem`<sup>Optional</sup> <a name="nextjsFileSystem" id="cdk-nextjs.NextjsGlobalContainersOverrides.property.nextjsFileSystem"></a>

```typescript
public readonly nextjsFileSystem: NextjsFileSystemOverrides;
```

- *Type:* <a href="#cdk-nextjs.NextjsFileSystemOverrides">NextjsFileSystemOverrides</a>

---

##### `nextjsVpc`<sup>Optional</sup> <a name="nextjsVpc" id="cdk-nextjs.NextjsGlobalContainersOverrides.property.nextjsVpc"></a>

```typescript
public readonly nextjsVpc: NextjsVpcOverrides;
```

- *Type:* <a href="#cdk-nextjs.NextjsVpcOverrides">NextjsVpcOverrides</a>

---

##### `nextjsContainers`<sup>Optional</sup> <a name="nextjsContainers" id="cdk-nextjs.NextjsGlobalContainersOverrides.property.nextjsContainers"></a>

```typescript
public readonly nextjsContainers: NextjsContainersOverrides;
```

- *Type:* <a href="#cdk-nextjs.NextjsContainersOverrides">NextjsContainersOverrides</a>

---

##### `nextjsDistribution`<sup>Optional</sup> <a name="nextjsDistribution" id="cdk-nextjs.NextjsGlobalContainersOverrides.property.nextjsDistribution"></a>

```typescript
public readonly nextjsDistribution: NextjsDistributionOverrides;
```

- *Type:* <a href="#cdk-nextjs.NextjsDistributionOverrides">NextjsDistributionOverrides</a>

---

##### `nextjsGlobalContainers`<sup>Optional</sup> <a name="nextjsGlobalContainers" id="cdk-nextjs.NextjsGlobalContainersOverrides.property.nextjsGlobalContainers"></a>

```typescript
public readonly nextjsGlobalContainers: NextjsGlobalContainersConstructOverrides;
```

- *Type:* <a href="#cdk-nextjs.NextjsGlobalContainersConstructOverrides">NextjsGlobalContainersConstructOverrides</a>

---

##### `nextjsInvalidation`<sup>Optional</sup> <a name="nextjsInvalidation" id="cdk-nextjs.NextjsGlobalContainersOverrides.property.nextjsInvalidation"></a>

```typescript
public readonly nextjsInvalidation: NextjsInvalidationOverrides;
```

- *Type:* <a href="#cdk-nextjs.NextjsInvalidationOverrides">NextjsInvalidationOverrides</a>

---

##### `nextjsStaticAssets`<sup>Optional</sup> <a name="nextjsStaticAssets" id="cdk-nextjs.NextjsGlobalContainersOverrides.property.nextjsStaticAssets"></a>

```typescript
public readonly nextjsStaticAssets: NextjsStaticAssetsOverrides;
```

- *Type:* <a href="#cdk-nextjs.NextjsStaticAssetsOverrides">NextjsStaticAssetsOverrides</a>

---

### NextjsGlobalContainersProps <a name="NextjsGlobalContainersProps" id="cdk-nextjs.NextjsGlobalContainersProps"></a>

#### Initializer <a name="Initializer" id="cdk-nextjs.NextjsGlobalContainersProps.Initializer"></a>

```typescript
import { NextjsGlobalContainersProps } from 'cdk-nextjs'

const nextjsGlobalContainersProps: NextjsGlobalContainersProps = { ... }
```

#### Properties <a name="Properties" id="Properties"></a>

| **Name** | **Type** | **Description** |
| --- | --- | --- |
| <code><a href="#cdk-nextjs.NextjsGlobalContainersProps.property.buildContext">buildContext</a></code> | <code>string</code> | [Build context](https://docs.docker.com/build/building/context/) for `docker build`. This directory should contain your lockfile (i.e. pnpm-lock.yaml) for your Next.js app. If you're not in a monorepo, then this will be the same directory as your Next.js app. If you are in a monorepo, then this value should be the root of your monorepo. You then must pass the relative path to your Next.js app via {@link NextjsBaseProps.relativePathToWorkspace}. |
| <code><a href="#cdk-nextjs.NextjsGlobalContainersProps.property.healthCheckPath">healthCheckPath</a></code> | <code>string</code> | Path to API Route Handler that returns HTTP 200 to ensure compute health. |
| <code><a href="#cdk-nextjs.NextjsGlobalContainersProps.property.buildCommand">buildCommand</a></code> | <code>string</code> | Command to generate optimized version of your Next.js app in container; |
| <code><a href="#cdk-nextjs.NextjsGlobalContainersProps.property.relativePathToWorkspace">relativePathToWorkspace</a></code> | <code>string</code> | Use this if building in monorepo. |
| <code><a href="#cdk-nextjs.NextjsGlobalContainersProps.property.basePath">basePath</a></code> | <code>string</code> | Prefix to the URI path the app will be served at. |
| <code><a href="#cdk-nextjs.NextjsGlobalContainersProps.property.distribution">distribution</a></code> | <code>aws-cdk-lib.aws_cloudfront.Distribution</code> | Bring your own distribution. |
| <code><a href="#cdk-nextjs.NextjsGlobalContainersProps.property.overrides">overrides</a></code> | <code><a href="#cdk-nextjs.NextjsGlobalContainersOverrides">NextjsGlobalContainersOverrides</a></code> | Override props of any construct. |

---

##### `buildContext`<sup>Required</sup> <a name="buildContext" id="cdk-nextjs.NextjsGlobalContainersProps.property.buildContext"></a>

```typescript
public readonly buildContext: string;
```

- *Type:* string

[Build context](https://docs.docker.com/build/building/context/) for `docker build`. This directory should contain your lockfile (i.e. pnpm-lock.yaml) for your Next.js app. If you're not in a monorepo, then this will be the same directory as your Next.js app. If you are in a monorepo, then this value should be the root of your monorepo. You then must pass the relative path to your Next.js app via {@link NextjsBaseProps.relativePathToWorkspace}.

---

*Example*

```typescript
fileURLToPath(new URL("../..", import.meta.url)) (monorepo)
```


##### `healthCheckPath`<sup>Required</sup> <a name="healthCheckPath" id="cdk-nextjs.NextjsGlobalContainersProps.property.healthCheckPath"></a>

```typescript
public readonly healthCheckPath: string;
```

- *Type:* string

Path to API Route Handler that returns HTTP 200 to ensure compute health.

---

*Example*

```typescript
// api/health/route.ts
import { NextResponse } from "next/server";

export function GET() {
  return NextResponse.json("");
}
```


##### `buildCommand`<sup>Optional</sup> <a name="buildCommand" id="cdk-nextjs.NextjsGlobalContainersProps.property.buildCommand"></a>

```typescript
public readonly buildCommand: string;
```

- *Type:* string
- *Default:* "npm run build"

Command to generate optimized version of your Next.js app in container;

---

##### `relativePathToWorkspace`<sup>Optional</sup> <a name="relativePathToWorkspace" id="cdk-nextjs.NextjsGlobalContainersProps.property.relativePathToWorkspace"></a>

```typescript
public readonly relativePathToWorkspace: string;
```

- *Type:* string

Use this if building in monorepo.

This is the relative path from
{@link NextjsBaseProps.buildContext} or root workspace to nested workspace
containing Next.js app. See example below:

Let's say you have a monorepo with the following folder structure:
- my-monorepo/
  - packages/
    - ui/
      - package.json (nested)
  - package.json (root)

And your Next.js app directory is the ui folder. Then you would set {@link NextjsBaseProps.buildContext}
to `"/absolute/path/to/my-monorepo"` and {@link NextjsBaseProps.relativePathToWorkspace}
to `"./packages/ui"`.

Note, setting {@link NextjsBaseProps.buildContext} to the root of your
monorepo will invalidate container runtime (i.e. docker) build cache when any file is
changed in your monorepo. This is slows down deployments. Checkout how you
can use [turbo](https://turbo.build/) in [Deploying with Docker Guide](https://turbo.build/repo/docs/handbook/deploying-with-docker)
to achieve better build caching. It's as easy as running
`turbo prune my-app --docker` - no config file required.

---

*Example*

```typescript
"./packages/ui"
```


##### `basePath`<sup>Optional</sup> <a name="basePath" id="cdk-nextjs.NextjsGlobalContainersProps.property.basePath"></a>

```typescript
public readonly basePath: string;
```

- *Type:* string

Prefix to the URI path the app will be served at.

Especially useful when
passing in your own `distribution`.

---

*Example*

```typescript
"/my-base-path"
```


##### `distribution`<sup>Optional</sup> <a name="distribution" id="cdk-nextjs.NextjsGlobalContainersProps.property.distribution"></a>

```typescript
public readonly distribution: Distribution;
```

- *Type:* aws-cdk-lib.aws_cloudfront.Distribution

Bring your own distribution.

Can be used with `basePath` to host multiple
apps on the same CloudFront distribution.

---

##### `overrides`<sup>Optional</sup> <a name="overrides" id="cdk-nextjs.NextjsGlobalContainersProps.property.overrides"></a>

```typescript
public readonly overrides: NextjsGlobalContainersOverrides;
```

- *Type:* <a href="#cdk-nextjs.NextjsGlobalContainersOverrides">NextjsGlobalContainersOverrides</a>

Override props of any construct.

---

### NextjsGlobalFunctionsConstructOverrides <a name="NextjsGlobalFunctionsConstructOverrides" id="cdk-nextjs.NextjsGlobalFunctionsConstructOverrides"></a>

#### Initializer <a name="Initializer" id="cdk-nextjs.NextjsGlobalFunctionsConstructOverrides.Initializer"></a>

```typescript
import { NextjsGlobalFunctionsConstructOverrides } from 'cdk-nextjs'

const nextjsGlobalFunctionsConstructOverrides: NextjsGlobalFunctionsConstructOverrides = { ... }
```

#### Properties <a name="Properties" id="Properties"></a>

| **Name** | **Type** | **Description** |
| --- | --- | --- |
| <code><a href="#cdk-nextjs.NextjsGlobalFunctionsConstructOverrides.property.nextjsAssetsDeploymentProps">nextjsAssetsDeploymentProps</a></code> | <code><a href="#cdk-nextjs.OptionalNextjsAssetsDeploymentProps">OptionalNextjsAssetsDeploymentProps</a></code> | *No description.* |
| <code><a href="#cdk-nextjs.NextjsGlobalFunctionsConstructOverrides.property.nextjsBuildProps">nextjsBuildProps</a></code> | <code><a href="#cdk-nextjs.OptionalNextjsBuildProps">OptionalNextjsBuildProps</a></code> | *No description.* |
| <code><a href="#cdk-nextjs.NextjsGlobalFunctionsConstructOverrides.property.nextjsFileSystemProps">nextjsFileSystemProps</a></code> | <code><a href="#cdk-nextjs.OptionalNextjsFileSystemProps">OptionalNextjsFileSystemProps</a></code> | *No description.* |
| <code><a href="#cdk-nextjs.NextjsGlobalFunctionsConstructOverrides.property.nextjsVpcProps">nextjsVpcProps</a></code> | <code><a href="#cdk-nextjs.OptionalNextjsVpcProps">OptionalNextjsVpcProps</a></code> | *No description.* |
| <code><a href="#cdk-nextjs.NextjsGlobalFunctionsConstructOverrides.property.nextjsDistributionProps">nextjsDistributionProps</a></code> | <code><a href="#cdk-nextjs.OptionalNextjsDistributionProps">OptionalNextjsDistributionProps</a></code> | *No description.* |
| <code><a href="#cdk-nextjs.NextjsGlobalFunctionsConstructOverrides.property.nextjsFunctionProps">nextjsFunctionProps</a></code> | <code><a href="#cdk-nextjs.NextjsFunctionsProps">NextjsFunctionsProps</a></code> | *No description.* |
| <code><a href="#cdk-nextjs.NextjsGlobalFunctionsConstructOverrides.property.nextjsInvalidationProps">nextjsInvalidationProps</a></code> | <code><a href="#cdk-nextjs.OptionalNextjsInvalidationProps">OptionalNextjsInvalidationProps</a></code> | *No description.* |
| <code><a href="#cdk-nextjs.NextjsGlobalFunctionsConstructOverrides.property.nextjsRevalidationProps">nextjsRevalidationProps</a></code> | <code><a href="#cdk-nextjs.NextjsRevalidationProps">NextjsRevalidationProps</a></code> | *No description.* |
| <code><a href="#cdk-nextjs.NextjsGlobalFunctionsConstructOverrides.property.nextjsStaticAssetsProps">nextjsStaticAssetsProps</a></code> | <code><a href="#cdk-nextjs.NextjsStaticAssetsProps">NextjsStaticAssetsProps</a></code> | *No description.* |

---

##### `nextjsAssetsDeploymentProps`<sup>Optional</sup> <a name="nextjsAssetsDeploymentProps" id="cdk-nextjs.NextjsGlobalFunctionsConstructOverrides.property.nextjsAssetsDeploymentProps"></a>

```typescript
public readonly nextjsAssetsDeploymentProps: OptionalNextjsAssetsDeploymentProps;
```

- *Type:* <a href="#cdk-nextjs.OptionalNextjsAssetsDeploymentProps">OptionalNextjsAssetsDeploymentProps</a>

---

##### `nextjsBuildProps`<sup>Optional</sup> <a name="nextjsBuildProps" id="cdk-nextjs.NextjsGlobalFunctionsConstructOverrides.property.nextjsBuildProps"></a>

```typescript
public readonly nextjsBuildProps: OptionalNextjsBuildProps;
```

- *Type:* <a href="#cdk-nextjs.OptionalNextjsBuildProps">OptionalNextjsBuildProps</a>

---

##### `nextjsFileSystemProps`<sup>Optional</sup> <a name="nextjsFileSystemProps" id="cdk-nextjs.NextjsGlobalFunctionsConstructOverrides.property.nextjsFileSystemProps"></a>

```typescript
public readonly nextjsFileSystemProps: OptionalNextjsFileSystemProps;
```

- *Type:* <a href="#cdk-nextjs.OptionalNextjsFileSystemProps">OptionalNextjsFileSystemProps</a>

---

##### `nextjsVpcProps`<sup>Optional</sup> <a name="nextjsVpcProps" id="cdk-nextjs.NextjsGlobalFunctionsConstructOverrides.property.nextjsVpcProps"></a>

```typescript
public readonly nextjsVpcProps: OptionalNextjsVpcProps;
```

- *Type:* <a href="#cdk-nextjs.OptionalNextjsVpcProps">OptionalNextjsVpcProps</a>

---

##### `nextjsDistributionProps`<sup>Optional</sup> <a name="nextjsDistributionProps" id="cdk-nextjs.NextjsGlobalFunctionsConstructOverrides.property.nextjsDistributionProps"></a>

```typescript
public readonly nextjsDistributionProps: OptionalNextjsDistributionProps;
```

- *Type:* <a href="#cdk-nextjs.OptionalNextjsDistributionProps">OptionalNextjsDistributionProps</a>

---

##### `nextjsFunctionProps`<sup>Optional</sup> <a name="nextjsFunctionProps" id="cdk-nextjs.NextjsGlobalFunctionsConstructOverrides.property.nextjsFunctionProps"></a>

```typescript
public readonly nextjsFunctionProps: NextjsFunctionsProps;
```

- *Type:* <a href="#cdk-nextjs.NextjsFunctionsProps">NextjsFunctionsProps</a>

---

##### `nextjsInvalidationProps`<sup>Optional</sup> <a name="nextjsInvalidationProps" id="cdk-nextjs.NextjsGlobalFunctionsConstructOverrides.property.nextjsInvalidationProps"></a>

```typescript
public readonly nextjsInvalidationProps: OptionalNextjsInvalidationProps;
```

- *Type:* <a href="#cdk-nextjs.OptionalNextjsInvalidationProps">OptionalNextjsInvalidationProps</a>

---

##### `nextjsRevalidationProps`<sup>Optional</sup> <a name="nextjsRevalidationProps" id="cdk-nextjs.NextjsGlobalFunctionsConstructOverrides.property.nextjsRevalidationProps"></a>

```typescript
public readonly nextjsRevalidationProps: NextjsRevalidationProps;
```

- *Type:* <a href="#cdk-nextjs.NextjsRevalidationProps">NextjsRevalidationProps</a>

---

##### `nextjsStaticAssetsProps`<sup>Optional</sup> <a name="nextjsStaticAssetsProps" id="cdk-nextjs.NextjsGlobalFunctionsConstructOverrides.property.nextjsStaticAssetsProps"></a>

```typescript
public readonly nextjsStaticAssetsProps: NextjsStaticAssetsProps;
```

- *Type:* <a href="#cdk-nextjs.NextjsStaticAssetsProps">NextjsStaticAssetsProps</a>

---

### NextjsGlobalFunctionsOverrides <a name="NextjsGlobalFunctionsOverrides" id="cdk-nextjs.NextjsGlobalFunctionsOverrides"></a>

#### Initializer <a name="Initializer" id="cdk-nextjs.NextjsGlobalFunctionsOverrides.Initializer"></a>

```typescript
import { NextjsGlobalFunctionsOverrides } from 'cdk-nextjs'

const nextjsGlobalFunctionsOverrides: NextjsGlobalFunctionsOverrides = { ... }
```

#### Properties <a name="Properties" id="Properties"></a>

| **Name** | **Type** | **Description** |
| --- | --- | --- |
| <code><a href="#cdk-nextjs.NextjsGlobalFunctionsOverrides.property.nextjsAssetsDeployment">nextjsAssetsDeployment</a></code> | <code><a href="#cdk-nextjs.NextjsAssetDeploymentOverrides">NextjsAssetDeploymentOverrides</a></code> | *No description.* |
| <code><a href="#cdk-nextjs.NextjsGlobalFunctionsOverrides.property.nextjsBuild">nextjsBuild</a></code> | <code><a href="#cdk-nextjs.NextjsBuildOverrides">NextjsBuildOverrides</a></code> | *No description.* |
| <code><a href="#cdk-nextjs.NextjsGlobalFunctionsOverrides.property.nextjsFileSystem">nextjsFileSystem</a></code> | <code><a href="#cdk-nextjs.NextjsFileSystemOverrides">NextjsFileSystemOverrides</a></code> | *No description.* |
| <code><a href="#cdk-nextjs.NextjsGlobalFunctionsOverrides.property.nextjsVpc">nextjsVpc</a></code> | <code><a href="#cdk-nextjs.NextjsVpcOverrides">NextjsVpcOverrides</a></code> | *No description.* |
| <code><a href="#cdk-nextjs.NextjsGlobalFunctionsOverrides.property.nextjsDistribution">nextjsDistribution</a></code> | <code><a href="#cdk-nextjs.NextjsDistributionOverrides">NextjsDistributionOverrides</a></code> | *No description.* |
| <code><a href="#cdk-nextjs.NextjsGlobalFunctionsOverrides.property.nextjsFunction">nextjsFunction</a></code> | <code><a href="#cdk-nextjs.NextjsFunctionsOverrides">NextjsFunctionsOverrides</a></code> | *No description.* |
| <code><a href="#cdk-nextjs.NextjsGlobalFunctionsOverrides.property.nextjsGlobalFunctions">nextjsGlobalFunctions</a></code> | <code><a href="#cdk-nextjs.NextjsGlobalFunctionsConstructOverrides">NextjsGlobalFunctionsConstructOverrides</a></code> | *No description.* |
| <code><a href="#cdk-nextjs.NextjsGlobalFunctionsOverrides.property.nextjsInvalidation">nextjsInvalidation</a></code> | <code><a href="#cdk-nextjs.NextjsInvalidationOverrides">NextjsInvalidationOverrides</a></code> | *No description.* |
| <code><a href="#cdk-nextjs.NextjsGlobalFunctionsOverrides.property.nextjsRevalidation">nextjsRevalidation</a></code> | <code><a href="#cdk-nextjs.NextjsRevalidationOverrides">NextjsRevalidationOverrides</a></code> | *No description.* |
| <code><a href="#cdk-nextjs.NextjsGlobalFunctionsOverrides.property.nextjsStaticAssets">nextjsStaticAssets</a></code> | <code><a href="#cdk-nextjs.NextjsStaticAssetsOverrides">NextjsStaticAssetsOverrides</a></code> | *No description.* |

---

##### `nextjsAssetsDeployment`<sup>Optional</sup> <a name="nextjsAssetsDeployment" id="cdk-nextjs.NextjsGlobalFunctionsOverrides.property.nextjsAssetsDeployment"></a>

```typescript
public readonly nextjsAssetsDeployment: NextjsAssetDeploymentOverrides;
```

- *Type:* <a href="#cdk-nextjs.NextjsAssetDeploymentOverrides">NextjsAssetDeploymentOverrides</a>

---

##### `nextjsBuild`<sup>Optional</sup> <a name="nextjsBuild" id="cdk-nextjs.NextjsGlobalFunctionsOverrides.property.nextjsBuild"></a>

```typescript
public readonly nextjsBuild: NextjsBuildOverrides;
```

- *Type:* <a href="#cdk-nextjs.NextjsBuildOverrides">NextjsBuildOverrides</a>

---

##### `nextjsFileSystem`<sup>Optional</sup> <a name="nextjsFileSystem" id="cdk-nextjs.NextjsGlobalFunctionsOverrides.property.nextjsFileSystem"></a>

```typescript
public readonly nextjsFileSystem: NextjsFileSystemOverrides;
```

- *Type:* <a href="#cdk-nextjs.NextjsFileSystemOverrides">NextjsFileSystemOverrides</a>

---

##### `nextjsVpc`<sup>Optional</sup> <a name="nextjsVpc" id="cdk-nextjs.NextjsGlobalFunctionsOverrides.property.nextjsVpc"></a>

```typescript
public readonly nextjsVpc: NextjsVpcOverrides;
```

- *Type:* <a href="#cdk-nextjs.NextjsVpcOverrides">NextjsVpcOverrides</a>

---

##### `nextjsDistribution`<sup>Optional</sup> <a name="nextjsDistribution" id="cdk-nextjs.NextjsGlobalFunctionsOverrides.property.nextjsDistribution"></a>

```typescript
public readonly nextjsDistribution: NextjsDistributionOverrides;
```

- *Type:* <a href="#cdk-nextjs.NextjsDistributionOverrides">NextjsDistributionOverrides</a>

---

##### `nextjsFunction`<sup>Optional</sup> <a name="nextjsFunction" id="cdk-nextjs.NextjsGlobalFunctionsOverrides.property.nextjsFunction"></a>

```typescript
public readonly nextjsFunction: NextjsFunctionsOverrides;
```

- *Type:* <a href="#cdk-nextjs.NextjsFunctionsOverrides">NextjsFunctionsOverrides</a>

---

##### `nextjsGlobalFunctions`<sup>Optional</sup> <a name="nextjsGlobalFunctions" id="cdk-nextjs.NextjsGlobalFunctionsOverrides.property.nextjsGlobalFunctions"></a>

```typescript
public readonly nextjsGlobalFunctions: NextjsGlobalFunctionsConstructOverrides;
```

- *Type:* <a href="#cdk-nextjs.NextjsGlobalFunctionsConstructOverrides">NextjsGlobalFunctionsConstructOverrides</a>

---

##### `nextjsInvalidation`<sup>Optional</sup> <a name="nextjsInvalidation" id="cdk-nextjs.NextjsGlobalFunctionsOverrides.property.nextjsInvalidation"></a>

```typescript
public readonly nextjsInvalidation: NextjsInvalidationOverrides;
```

- *Type:* <a href="#cdk-nextjs.NextjsInvalidationOverrides">NextjsInvalidationOverrides</a>

---

##### `nextjsRevalidation`<sup>Optional</sup> <a name="nextjsRevalidation" id="cdk-nextjs.NextjsGlobalFunctionsOverrides.property.nextjsRevalidation"></a>

```typescript
public readonly nextjsRevalidation: NextjsRevalidationOverrides;
```

- *Type:* <a href="#cdk-nextjs.NextjsRevalidationOverrides">NextjsRevalidationOverrides</a>

---

##### `nextjsStaticAssets`<sup>Optional</sup> <a name="nextjsStaticAssets" id="cdk-nextjs.NextjsGlobalFunctionsOverrides.property.nextjsStaticAssets"></a>

```typescript
public readonly nextjsStaticAssets: NextjsStaticAssetsOverrides;
```

- *Type:* <a href="#cdk-nextjs.NextjsStaticAssetsOverrides">NextjsStaticAssetsOverrides</a>

---

### NextjsGlobalFunctionsProps <a name="NextjsGlobalFunctionsProps" id="cdk-nextjs.NextjsGlobalFunctionsProps"></a>

#### Initializer <a name="Initializer" id="cdk-nextjs.NextjsGlobalFunctionsProps.Initializer"></a>

```typescript
import { NextjsGlobalFunctionsProps } from 'cdk-nextjs'

const nextjsGlobalFunctionsProps: NextjsGlobalFunctionsProps = { ... }
```

#### Properties <a name="Properties" id="Properties"></a>

| **Name** | **Type** | **Description** |
| --- | --- | --- |
| <code><a href="#cdk-nextjs.NextjsGlobalFunctionsProps.property.buildContext">buildContext</a></code> | <code>string</code> | [Build context](https://docs.docker.com/build/building/context/) for `docker build`. This directory should contain your lockfile (i.e. pnpm-lock.yaml) for your Next.js app. If you're not in a monorepo, then this will be the same directory as your Next.js app. If you are in a monorepo, then this value should be the root of your monorepo. You then must pass the relative path to your Next.js app via {@link NextjsBaseProps.relativePathToWorkspace}. |
| <code><a href="#cdk-nextjs.NextjsGlobalFunctionsProps.property.healthCheckPath">healthCheckPath</a></code> | <code>string</code> | Path to API Route Handler that returns HTTP 200 to ensure compute health. |
| <code><a href="#cdk-nextjs.NextjsGlobalFunctionsProps.property.buildCommand">buildCommand</a></code> | <code>string</code> | Command to generate optimized version of your Next.js app in container; |
| <code><a href="#cdk-nextjs.NextjsGlobalFunctionsProps.property.relativePathToWorkspace">relativePathToWorkspace</a></code> | <code>string</code> | Use this if building in monorepo. |
| <code><a href="#cdk-nextjs.NextjsGlobalFunctionsProps.property.basePath">basePath</a></code> | <code>string</code> | Prefix to the URI path the app will be served at. |
| <code><a href="#cdk-nextjs.NextjsGlobalFunctionsProps.property.distribution">distribution</a></code> | <code>aws-cdk-lib.aws_cloudfront.Distribution</code> | Bring your own distribution. |
| <code><a href="#cdk-nextjs.NextjsGlobalFunctionsProps.property.overrides">overrides</a></code> | <code><a href="#cdk-nextjs.NextjsGlobalFunctionsOverrides">NextjsGlobalFunctionsOverrides</a></code> | Override props of any construct. |

---

##### `buildContext`<sup>Required</sup> <a name="buildContext" id="cdk-nextjs.NextjsGlobalFunctionsProps.property.buildContext"></a>

```typescript
public readonly buildContext: string;
```

- *Type:* string

[Build context](https://docs.docker.com/build/building/context/) for `docker build`. This directory should contain your lockfile (i.e. pnpm-lock.yaml) for your Next.js app. If you're not in a monorepo, then this will be the same directory as your Next.js app. If you are in a monorepo, then this value should be the root of your monorepo. You then must pass the relative path to your Next.js app via {@link NextjsBaseProps.relativePathToWorkspace}.

---

*Example*

```typescript
fileURLToPath(new URL("../..", import.meta.url)) (monorepo)
```


##### `healthCheckPath`<sup>Required</sup> <a name="healthCheckPath" id="cdk-nextjs.NextjsGlobalFunctionsProps.property.healthCheckPath"></a>

```typescript
public readonly healthCheckPath: string;
```

- *Type:* string

Path to API Route Handler that returns HTTP 200 to ensure compute health.

---

*Example*

```typescript
// api/health/route.ts
import { NextResponse } from "next/server";

export function GET() {
  return NextResponse.json("");
}
```


##### `buildCommand`<sup>Optional</sup> <a name="buildCommand" id="cdk-nextjs.NextjsGlobalFunctionsProps.property.buildCommand"></a>

```typescript
public readonly buildCommand: string;
```

- *Type:* string
- *Default:* "npm run build"

Command to generate optimized version of your Next.js app in container;

---

##### `relativePathToWorkspace`<sup>Optional</sup> <a name="relativePathToWorkspace" id="cdk-nextjs.NextjsGlobalFunctionsProps.property.relativePathToWorkspace"></a>

```typescript
public readonly relativePathToWorkspace: string;
```

- *Type:* string

Use this if building in monorepo.

This is the relative path from
{@link NextjsBaseProps.buildContext} or root workspace to nested workspace
containing Next.js app. See example below:

Let's say you have a monorepo with the following folder structure:
- my-monorepo/
  - packages/
    - ui/
      - package.json (nested)
  - package.json (root)

And your Next.js app directory is the ui folder. Then you would set {@link NextjsBaseProps.buildContext}
to `"/absolute/path/to/my-monorepo"` and {@link NextjsBaseProps.relativePathToWorkspace}
to `"./packages/ui"`.

Note, setting {@link NextjsBaseProps.buildContext} to the root of your
monorepo will invalidate container runtime (i.e. docker) build cache when any file is
changed in your monorepo. This is slows down deployments. Checkout how you
can use [turbo](https://turbo.build/) in [Deploying with Docker Guide](https://turbo.build/repo/docs/handbook/deploying-with-docker)
to achieve better build caching. It's as easy as running
`turbo prune my-app --docker` - no config file required.

---

*Example*

```typescript
"./packages/ui"
```


##### `basePath`<sup>Optional</sup> <a name="basePath" id="cdk-nextjs.NextjsGlobalFunctionsProps.property.basePath"></a>

```typescript
public readonly basePath: string;
```

- *Type:* string

Prefix to the URI path the app will be served at.

Especially useful when
passing in your own `distribution`.

---

*Example*

```typescript
"/my-base-path"
```


##### `distribution`<sup>Optional</sup> <a name="distribution" id="cdk-nextjs.NextjsGlobalFunctionsProps.property.distribution"></a>

```typescript
public readonly distribution: Distribution;
```

- *Type:* aws-cdk-lib.aws_cloudfront.Distribution

Bring your own distribution.

Can be used with `basePath` to host multiple
apps on the same CloudFront distribution.

---

##### `overrides`<sup>Optional</sup> <a name="overrides" id="cdk-nextjs.NextjsGlobalFunctionsProps.property.overrides"></a>

```typescript
public readonly overrides: NextjsGlobalFunctionsOverrides;
```

- *Type:* <a href="#cdk-nextjs.NextjsGlobalFunctionsOverrides">NextjsGlobalFunctionsOverrides</a>

Override props of any construct.

---

### NextjsInvalidationOverrides <a name="NextjsInvalidationOverrides" id="cdk-nextjs.NextjsInvalidationOverrides"></a>

#### Initializer <a name="Initializer" id="cdk-nextjs.NextjsInvalidationOverrides.Initializer"></a>

```typescript
import { NextjsInvalidationOverrides } from 'cdk-nextjs'

const nextjsInvalidationOverrides: NextjsInvalidationOverrides = { ... }
```

#### Properties <a name="Properties" id="Properties"></a>

| **Name** | **Type** | **Description** |
| --- | --- | --- |
| <code><a href="#cdk-nextjs.NextjsInvalidationOverrides.property.awsCustomResourceProps">awsCustomResourceProps</a></code> | <code>aws-cdk-lib.custom_resources.AwsCustomResourceProps</code> | *No description.* |

---

##### `awsCustomResourceProps`<sup>Optional</sup> <a name="awsCustomResourceProps" id="cdk-nextjs.NextjsInvalidationOverrides.property.awsCustomResourceProps"></a>

```typescript
public readonly awsCustomResourceProps: AwsCustomResourceProps;
```

- *Type:* aws-cdk-lib.custom_resources.AwsCustomResourceProps

---

### NextjsInvalidationProps <a name="NextjsInvalidationProps" id="cdk-nextjs.NextjsInvalidationProps"></a>

#### Initializer <a name="Initializer" id="cdk-nextjs.NextjsInvalidationProps.Initializer"></a>

```typescript
import { NextjsInvalidationProps } from 'cdk-nextjs'

const nextjsInvalidationProps: NextjsInvalidationProps = { ... }
```

#### Properties <a name="Properties" id="Properties"></a>

| **Name** | **Type** | **Description** |
| --- | --- | --- |
| <code><a href="#cdk-nextjs.NextjsInvalidationProps.property.distribution">distribution</a></code> | <code>aws-cdk-lib.aws_cloudfront.IDistribution</code> | CloudFront Distribution to invalidate. |
| <code><a href="#cdk-nextjs.NextjsInvalidationProps.property.overrides">overrides</a></code> | <code><a href="#cdk-nextjs.NextjsInvalidationOverrides">NextjsInvalidationOverrides</a></code> | Override props for every construct. |

---

##### `distribution`<sup>Required</sup> <a name="distribution" id="cdk-nextjs.NextjsInvalidationProps.property.distribution"></a>

```typescript
public readonly distribution: IDistribution;
```

- *Type:* aws-cdk-lib.aws_cloudfront.IDistribution

CloudFront Distribution to invalidate.

---

##### `overrides`<sup>Optional</sup> <a name="overrides" id="cdk-nextjs.NextjsInvalidationProps.property.overrides"></a>

```typescript
public readonly overrides: NextjsInvalidationOverrides;
```

- *Type:* <a href="#cdk-nextjs.NextjsInvalidationOverrides">NextjsInvalidationOverrides</a>

Override props for every construct.

---

### NextjsRegionalContainersConstructOverrides <a name="NextjsRegionalContainersConstructOverrides" id="cdk-nextjs.NextjsRegionalContainersConstructOverrides"></a>

#### Initializer <a name="Initializer" id="cdk-nextjs.NextjsRegionalContainersConstructOverrides.Initializer"></a>

```typescript
import { NextjsRegionalContainersConstructOverrides } from 'cdk-nextjs'

const nextjsRegionalContainersConstructOverrides: NextjsRegionalContainersConstructOverrides = { ... }
```

#### Properties <a name="Properties" id="Properties"></a>

| **Name** | **Type** | **Description** |
| --- | --- | --- |
| <code><a href="#cdk-nextjs.NextjsRegionalContainersConstructOverrides.property.nextjsAssetsDeploymentProps">nextjsAssetsDeploymentProps</a></code> | <code><a href="#cdk-nextjs.OptionalNextjsAssetsDeploymentProps">OptionalNextjsAssetsDeploymentProps</a></code> | *No description.* |
| <code><a href="#cdk-nextjs.NextjsRegionalContainersConstructOverrides.property.nextjsBuildProps">nextjsBuildProps</a></code> | <code><a href="#cdk-nextjs.OptionalNextjsBuildProps">OptionalNextjsBuildProps</a></code> | *No description.* |
| <code><a href="#cdk-nextjs.NextjsRegionalContainersConstructOverrides.property.nextjsFileSystemProps">nextjsFileSystemProps</a></code> | <code><a href="#cdk-nextjs.OptionalNextjsFileSystemProps">OptionalNextjsFileSystemProps</a></code> | *No description.* |
| <code><a href="#cdk-nextjs.NextjsRegionalContainersConstructOverrides.property.nextjsVpcProps">nextjsVpcProps</a></code> | <code><a href="#cdk-nextjs.OptionalNextjsVpcProps">OptionalNextjsVpcProps</a></code> | *No description.* |
| <code><a href="#cdk-nextjs.NextjsRegionalContainersConstructOverrides.property.nextjsContainerProps">nextjsContainerProps</a></code> | <code><a href="#cdk-nextjs.OptionalNextjsContainersProps">OptionalNextjsContainersProps</a></code> | *No description.* |

---

##### `nextjsAssetsDeploymentProps`<sup>Optional</sup> <a name="nextjsAssetsDeploymentProps" id="cdk-nextjs.NextjsRegionalContainersConstructOverrides.property.nextjsAssetsDeploymentProps"></a>

```typescript
public readonly nextjsAssetsDeploymentProps: OptionalNextjsAssetsDeploymentProps;
```

- *Type:* <a href="#cdk-nextjs.OptionalNextjsAssetsDeploymentProps">OptionalNextjsAssetsDeploymentProps</a>

---

##### `nextjsBuildProps`<sup>Optional</sup> <a name="nextjsBuildProps" id="cdk-nextjs.NextjsRegionalContainersConstructOverrides.property.nextjsBuildProps"></a>

```typescript
public readonly nextjsBuildProps: OptionalNextjsBuildProps;
```

- *Type:* <a href="#cdk-nextjs.OptionalNextjsBuildProps">OptionalNextjsBuildProps</a>

---

##### `nextjsFileSystemProps`<sup>Optional</sup> <a name="nextjsFileSystemProps" id="cdk-nextjs.NextjsRegionalContainersConstructOverrides.property.nextjsFileSystemProps"></a>

```typescript
public readonly nextjsFileSystemProps: OptionalNextjsFileSystemProps;
```

- *Type:* <a href="#cdk-nextjs.OptionalNextjsFileSystemProps">OptionalNextjsFileSystemProps</a>

---

##### `nextjsVpcProps`<sup>Optional</sup> <a name="nextjsVpcProps" id="cdk-nextjs.NextjsRegionalContainersConstructOverrides.property.nextjsVpcProps"></a>

```typescript
public readonly nextjsVpcProps: OptionalNextjsVpcProps;
```

- *Type:* <a href="#cdk-nextjs.OptionalNextjsVpcProps">OptionalNextjsVpcProps</a>

---

##### `nextjsContainerProps`<sup>Optional</sup> <a name="nextjsContainerProps" id="cdk-nextjs.NextjsRegionalContainersConstructOverrides.property.nextjsContainerProps"></a>

```typescript
public readonly nextjsContainerProps: OptionalNextjsContainersProps;
```

- *Type:* <a href="#cdk-nextjs.OptionalNextjsContainersProps">OptionalNextjsContainersProps</a>

---

### NextjsRegionalContainersOverrides <a name="NextjsRegionalContainersOverrides" id="cdk-nextjs.NextjsRegionalContainersOverrides"></a>

#### Initializer <a name="Initializer" id="cdk-nextjs.NextjsRegionalContainersOverrides.Initializer"></a>

```typescript
import { NextjsRegionalContainersOverrides } from 'cdk-nextjs'

const nextjsRegionalContainersOverrides: NextjsRegionalContainersOverrides = { ... }
```

#### Properties <a name="Properties" id="Properties"></a>

| **Name** | **Type** | **Description** |
| --- | --- | --- |
| <code><a href="#cdk-nextjs.NextjsRegionalContainersOverrides.property.nextjsAssetsDeployment">nextjsAssetsDeployment</a></code> | <code><a href="#cdk-nextjs.NextjsAssetDeploymentOverrides">NextjsAssetDeploymentOverrides</a></code> | *No description.* |
| <code><a href="#cdk-nextjs.NextjsRegionalContainersOverrides.property.nextjsBuild">nextjsBuild</a></code> | <code><a href="#cdk-nextjs.NextjsBuildOverrides">NextjsBuildOverrides</a></code> | *No description.* |
| <code><a href="#cdk-nextjs.NextjsRegionalContainersOverrides.property.nextjsFileSystem">nextjsFileSystem</a></code> | <code><a href="#cdk-nextjs.NextjsFileSystemOverrides">NextjsFileSystemOverrides</a></code> | *No description.* |
| <code><a href="#cdk-nextjs.NextjsRegionalContainersOverrides.property.nextjsVpc">nextjsVpc</a></code> | <code><a href="#cdk-nextjs.NextjsVpcOverrides">NextjsVpcOverrides</a></code> | *No description.* |
| <code><a href="#cdk-nextjs.NextjsRegionalContainersOverrides.property.nextjsContainers">nextjsContainers</a></code> | <code><a href="#cdk-nextjs.NextjsContainersOverrides">NextjsContainersOverrides</a></code> | *No description.* |
| <code><a href="#cdk-nextjs.NextjsRegionalContainersOverrides.property.nextjsRegionalContainers">nextjsRegionalContainers</a></code> | <code><a href="#cdk-nextjs.NextjsRegionalContainersConstructOverrides">NextjsRegionalContainersConstructOverrides</a></code> | *No description.* |

---

##### `nextjsAssetsDeployment`<sup>Optional</sup> <a name="nextjsAssetsDeployment" id="cdk-nextjs.NextjsRegionalContainersOverrides.property.nextjsAssetsDeployment"></a>

```typescript
public readonly nextjsAssetsDeployment: NextjsAssetDeploymentOverrides;
```

- *Type:* <a href="#cdk-nextjs.NextjsAssetDeploymentOverrides">NextjsAssetDeploymentOverrides</a>

---

##### `nextjsBuild`<sup>Optional</sup> <a name="nextjsBuild" id="cdk-nextjs.NextjsRegionalContainersOverrides.property.nextjsBuild"></a>

```typescript
public readonly nextjsBuild: NextjsBuildOverrides;
```

- *Type:* <a href="#cdk-nextjs.NextjsBuildOverrides">NextjsBuildOverrides</a>

---

##### `nextjsFileSystem`<sup>Optional</sup> <a name="nextjsFileSystem" id="cdk-nextjs.NextjsRegionalContainersOverrides.property.nextjsFileSystem"></a>

```typescript
public readonly nextjsFileSystem: NextjsFileSystemOverrides;
```

- *Type:* <a href="#cdk-nextjs.NextjsFileSystemOverrides">NextjsFileSystemOverrides</a>

---

##### `nextjsVpc`<sup>Optional</sup> <a name="nextjsVpc" id="cdk-nextjs.NextjsRegionalContainersOverrides.property.nextjsVpc"></a>

```typescript
public readonly nextjsVpc: NextjsVpcOverrides;
```

- *Type:* <a href="#cdk-nextjs.NextjsVpcOverrides">NextjsVpcOverrides</a>

---

##### `nextjsContainers`<sup>Optional</sup> <a name="nextjsContainers" id="cdk-nextjs.NextjsRegionalContainersOverrides.property.nextjsContainers"></a>

```typescript
public readonly nextjsContainers: NextjsContainersOverrides;
```

- *Type:* <a href="#cdk-nextjs.NextjsContainersOverrides">NextjsContainersOverrides</a>

---

##### `nextjsRegionalContainers`<sup>Optional</sup> <a name="nextjsRegionalContainers" id="cdk-nextjs.NextjsRegionalContainersOverrides.property.nextjsRegionalContainers"></a>

```typescript
public readonly nextjsRegionalContainers: NextjsRegionalContainersConstructOverrides;
```

- *Type:* <a href="#cdk-nextjs.NextjsRegionalContainersConstructOverrides">NextjsRegionalContainersConstructOverrides</a>

---

### NextjsRegionalContainersProps <a name="NextjsRegionalContainersProps" id="cdk-nextjs.NextjsRegionalContainersProps"></a>

#### Initializer <a name="Initializer" id="cdk-nextjs.NextjsRegionalContainersProps.Initializer"></a>

```typescript
import { NextjsRegionalContainersProps } from 'cdk-nextjs'

const nextjsRegionalContainersProps: NextjsRegionalContainersProps = { ... }
```

#### Properties <a name="Properties" id="Properties"></a>

| **Name** | **Type** | **Description** |
| --- | --- | --- |
| <code><a href="#cdk-nextjs.NextjsRegionalContainersProps.property.buildContext">buildContext</a></code> | <code>string</code> | [Build context](https://docs.docker.com/build/building/context/) for `docker build`. This directory should contain your lockfile (i.e. pnpm-lock.yaml) for your Next.js app. If you're not in a monorepo, then this will be the same directory as your Next.js app. If you are in a monorepo, then this value should be the root of your monorepo. You then must pass the relative path to your Next.js app via {@link NextjsBaseProps.relativePathToWorkspace}. |
| <code><a href="#cdk-nextjs.NextjsRegionalContainersProps.property.healthCheckPath">healthCheckPath</a></code> | <code>string</code> | Path to API Route Handler that returns HTTP 200 to ensure compute health. |
| <code><a href="#cdk-nextjs.NextjsRegionalContainersProps.property.buildCommand">buildCommand</a></code> | <code>string</code> | Command to generate optimized version of your Next.js app in container; |
| <code><a href="#cdk-nextjs.NextjsRegionalContainersProps.property.relativePathToWorkspace">relativePathToWorkspace</a></code> | <code>string</code> | Use this if building in monorepo. |
| <code><a href="#cdk-nextjs.NextjsRegionalContainersProps.property.overrides">overrides</a></code> | <code><a href="#cdk-nextjs.NextjsRegionalContainersOverrides">NextjsRegionalContainersOverrides</a></code> | Override props of any construct. |

---

##### `buildContext`<sup>Required</sup> <a name="buildContext" id="cdk-nextjs.NextjsRegionalContainersProps.property.buildContext"></a>

```typescript
public readonly buildContext: string;
```

- *Type:* string

[Build context](https://docs.docker.com/build/building/context/) for `docker build`. This directory should contain your lockfile (i.e. pnpm-lock.yaml) for your Next.js app. If you're not in a monorepo, then this will be the same directory as your Next.js app. If you are in a monorepo, then this value should be the root of your monorepo. You then must pass the relative path to your Next.js app via {@link NextjsBaseProps.relativePathToWorkspace}.

---

*Example*

```typescript
fileURLToPath(new URL("../..", import.meta.url)) (monorepo)
```


##### `healthCheckPath`<sup>Required</sup> <a name="healthCheckPath" id="cdk-nextjs.NextjsRegionalContainersProps.property.healthCheckPath"></a>

```typescript
public readonly healthCheckPath: string;
```

- *Type:* string

Path to API Route Handler that returns HTTP 200 to ensure compute health.

---

*Example*

```typescript
// api/health/route.ts
import { NextResponse } from "next/server";

export function GET() {
  return NextResponse.json("");
}
```


##### `buildCommand`<sup>Optional</sup> <a name="buildCommand" id="cdk-nextjs.NextjsRegionalContainersProps.property.buildCommand"></a>

```typescript
public readonly buildCommand: string;
```

- *Type:* string
- *Default:* "npm run build"

Command to generate optimized version of your Next.js app in container;

---

##### `relativePathToWorkspace`<sup>Optional</sup> <a name="relativePathToWorkspace" id="cdk-nextjs.NextjsRegionalContainersProps.property.relativePathToWorkspace"></a>

```typescript
public readonly relativePathToWorkspace: string;
```

- *Type:* string

Use this if building in monorepo.

This is the relative path from
{@link NextjsBaseProps.buildContext} or root workspace to nested workspace
containing Next.js app. See example below:

Let's say you have a monorepo with the following folder structure:
- my-monorepo/
  - packages/
    - ui/
      - package.json (nested)
  - package.json (root)

And your Next.js app directory is the ui folder. Then you would set {@link NextjsBaseProps.buildContext}
to `"/absolute/path/to/my-monorepo"` and {@link NextjsBaseProps.relativePathToWorkspace}
to `"./packages/ui"`.

Note, setting {@link NextjsBaseProps.buildContext} to the root of your
monorepo will invalidate container runtime (i.e. docker) build cache when any file is
changed in your monorepo. This is slows down deployments. Checkout how you
can use [turbo](https://turbo.build/) in [Deploying with Docker Guide](https://turbo.build/repo/docs/handbook/deploying-with-docker)
to achieve better build caching. It's as easy as running
`turbo prune my-app --docker` - no config file required.

---

*Example*

```typescript
"./packages/ui"
```


##### `overrides`<sup>Optional</sup> <a name="overrides" id="cdk-nextjs.NextjsRegionalContainersProps.property.overrides"></a>

```typescript
public readonly overrides: NextjsRegionalContainersOverrides;
```

- *Type:* <a href="#cdk-nextjs.NextjsRegionalContainersOverrides">NextjsRegionalContainersOverrides</a>

Override props of any construct.

---

### NextjsRevalidationOverrides <a name="NextjsRevalidationOverrides" id="cdk-nextjs.NextjsRevalidationOverrides"></a>

#### Initializer <a name="Initializer" id="cdk-nextjs.NextjsRevalidationOverrides.Initializer"></a>

```typescript
import { NextjsRevalidationOverrides } from 'cdk-nextjs'

const nextjsRevalidationOverrides: NextjsRevalidationOverrides = { ... }
```

#### Properties <a name="Properties" id="Properties"></a>

| **Name** | **Type** | **Description** |
| --- | --- | --- |
| <code><a href="#cdk-nextjs.NextjsRevalidationOverrides.property.functionProps">functionProps</a></code> | <code><a href="#cdk-nextjs.OptionalFunctionProps">OptionalFunctionProps</a></code> | *No description.* |
| <code><a href="#cdk-nextjs.NextjsRevalidationOverrides.property.queueProps">queueProps</a></code> | <code>aws-cdk-lib.aws_sqs.QueueProps</code> | *No description.* |
| <code><a href="#cdk-nextjs.NextjsRevalidationOverrides.property.sqsEventSourceProps">sqsEventSourceProps</a></code> | <code>aws-cdk-lib.aws_lambda_event_sources.SqsEventSourceProps</code> | *No description.* |

---

##### `functionProps`<sup>Optional</sup> <a name="functionProps" id="cdk-nextjs.NextjsRevalidationOverrides.property.functionProps"></a>

```typescript
public readonly functionProps: OptionalFunctionProps;
```

- *Type:* <a href="#cdk-nextjs.OptionalFunctionProps">OptionalFunctionProps</a>

---

##### `queueProps`<sup>Optional</sup> <a name="queueProps" id="cdk-nextjs.NextjsRevalidationOverrides.property.queueProps"></a>

```typescript
public readonly queueProps: QueueProps;
```

- *Type:* aws-cdk-lib.aws_sqs.QueueProps

---

##### `sqsEventSourceProps`<sup>Optional</sup> <a name="sqsEventSourceProps" id="cdk-nextjs.NextjsRevalidationOverrides.property.sqsEventSourceProps"></a>

```typescript
public readonly sqsEventSourceProps: SqsEventSourceProps;
```

- *Type:* aws-cdk-lib.aws_lambda_event_sources.SqsEventSourceProps

---

### NextjsRevalidationProps <a name="NextjsRevalidationProps" id="cdk-nextjs.NextjsRevalidationProps"></a>

#### Initializer <a name="Initializer" id="cdk-nextjs.NextjsRevalidationProps.Initializer"></a>

```typescript
import { NextjsRevalidationProps } from 'cdk-nextjs'

const nextjsRevalidationProps: NextjsRevalidationProps = { ... }
```

#### Properties <a name="Properties" id="Properties"></a>

| **Name** | **Type** | **Description** |
| --- | --- | --- |
| <code><a href="#cdk-nextjs.NextjsRevalidationProps.property.fn">fn</a></code> | <code>aws-cdk-lib.aws_lambda.Function</code> | *No description.* |
| <code><a href="#cdk-nextjs.NextjsRevalidationProps.property.previewModeId">previewModeId</a></code> | <code>string</code> | *No description.* |
| <code><a href="#cdk-nextjs.NextjsRevalidationProps.property.overrides">overrides</a></code> | <code><a href="#cdk-nextjs.NextjsRevalidationOverrides">NextjsRevalidationOverrides</a></code> | *No description.* |

---

##### `fn`<sup>Required</sup> <a name="fn" id="cdk-nextjs.NextjsRevalidationProps.property.fn"></a>

```typescript
public readonly fn: Function;
```

- *Type:* aws-cdk-lib.aws_lambda.Function

---

##### `previewModeId`<sup>Required</sup> <a name="previewModeId" id="cdk-nextjs.NextjsRevalidationProps.property.previewModeId"></a>

```typescript
public readonly previewModeId: string;
```

- *Type:* string

---

##### `overrides`<sup>Optional</sup> <a name="overrides" id="cdk-nextjs.NextjsRevalidationProps.property.overrides"></a>

```typescript
public readonly overrides: NextjsRevalidationOverrides;
```

- *Type:* <a href="#cdk-nextjs.NextjsRevalidationOverrides">NextjsRevalidationOverrides</a>

---

### NextjsStaticAssetsOverrides <a name="NextjsStaticAssetsOverrides" id="cdk-nextjs.NextjsStaticAssetsOverrides"></a>

#### Initializer <a name="Initializer" id="cdk-nextjs.NextjsStaticAssetsOverrides.Initializer"></a>

```typescript
import { NextjsStaticAssetsOverrides } from 'cdk-nextjs'

const nextjsStaticAssetsOverrides: NextjsStaticAssetsOverrides = { ... }
```

#### Properties <a name="Properties" id="Properties"></a>

| **Name** | **Type** | **Description** |
| --- | --- | --- |
| <code><a href="#cdk-nextjs.NextjsStaticAssetsOverrides.property.bucketProps">bucketProps</a></code> | <code>aws-cdk-lib.aws_s3.BucketProps</code> | *No description.* |

---

##### `bucketProps`<sup>Optional</sup> <a name="bucketProps" id="cdk-nextjs.NextjsStaticAssetsOverrides.property.bucketProps"></a>

```typescript
public readonly bucketProps: BucketProps;
```

- *Type:* aws-cdk-lib.aws_s3.BucketProps

---

### NextjsStaticAssetsProps <a name="NextjsStaticAssetsProps" id="cdk-nextjs.NextjsStaticAssetsProps"></a>

#### Initializer <a name="Initializer" id="cdk-nextjs.NextjsStaticAssetsProps.Initializer"></a>

```typescript
import { NextjsStaticAssetsProps } from 'cdk-nextjs'

const nextjsStaticAssetsProps: NextjsStaticAssetsProps = { ... }
```

#### Properties <a name="Properties" id="Properties"></a>

| **Name** | **Type** | **Description** |
| --- | --- | --- |
| <code><a href="#cdk-nextjs.NextjsStaticAssetsProps.property.overrides">overrides</a></code> | <code><a href="#cdk-nextjs.NextjsStaticAssetsOverrides">NextjsStaticAssetsOverrides</a></code> | *No description.* |
| <code><a href="#cdk-nextjs.NextjsStaticAssetsProps.property.vpcId">vpcId</a></code> | <code>string</code> | Required if `NextjsType.REGIONAL_CONTAINERS`. |

---

##### `overrides`<sup>Optional</sup> <a name="overrides" id="cdk-nextjs.NextjsStaticAssetsProps.property.overrides"></a>

```typescript
public readonly overrides: NextjsStaticAssetsOverrides;
```

- *Type:* <a href="#cdk-nextjs.NextjsStaticAssetsOverrides">NextjsStaticAssetsOverrides</a>

---

##### `vpcId`<sup>Optional</sup> <a name="vpcId" id="cdk-nextjs.NextjsStaticAssetsProps.property.vpcId"></a>

```typescript
public readonly vpcId: string;
```

- *Type:* string

Required if `NextjsType.REGIONAL_CONTAINERS`.

---

### NextjsVpcOverrides <a name="NextjsVpcOverrides" id="cdk-nextjs.NextjsVpcOverrides"></a>

#### Initializer <a name="Initializer" id="cdk-nextjs.NextjsVpcOverrides.Initializer"></a>

```typescript
import { NextjsVpcOverrides } from 'cdk-nextjs'

const nextjsVpcOverrides: NextjsVpcOverrides = { ... }
```

#### Properties <a name="Properties" id="Properties"></a>

| **Name** | **Type** | **Description** |
| --- | --- | --- |
| <code><a href="#cdk-nextjs.NextjsVpcOverrides.property.vpcProps">vpcProps</a></code> | <code><a href="#cdk-nextjs.OptionalVpcProps">OptionalVpcProps</a></code> | *No description.* |

---

##### `vpcProps`<sup>Optional</sup> <a name="vpcProps" id="cdk-nextjs.NextjsVpcOverrides.property.vpcProps"></a>

```typescript
public readonly vpcProps: OptionalVpcProps;
```

- *Type:* <a href="#cdk-nextjs.OptionalVpcProps">OptionalVpcProps</a>

---

### NextjsVpcProps <a name="NextjsVpcProps" id="cdk-nextjs.NextjsVpcProps"></a>

#### Initializer <a name="Initializer" id="cdk-nextjs.NextjsVpcProps.Initializer"></a>

```typescript
import { NextjsVpcProps } from 'cdk-nextjs'

const nextjsVpcProps: NextjsVpcProps = { ... }
```

#### Properties <a name="Properties" id="Properties"></a>

| **Name** | **Type** | **Description** |
| --- | --- | --- |
| <code><a href="#cdk-nextjs.NextjsVpcProps.property.nextjsType">nextjsType</a></code> | <code><a href="#cdk-nextjs.NextjsType">NextjsType</a></code> | *No description.* |
| <code><a href="#cdk-nextjs.NextjsVpcProps.property.overrides">overrides</a></code> | <code><a href="#cdk-nextjs.NextjsVpcOverrides">NextjsVpcOverrides</a></code> | Override any construct. |
| <code><a href="#cdk-nextjs.NextjsVpcProps.property.vpc">vpc</a></code> | <code>aws-cdk-lib.aws_ec2.IVpc</code> | Bring your own VPC. |

---

##### `nextjsType`<sup>Required</sup> <a name="nextjsType" id="cdk-nextjs.NextjsVpcProps.property.nextjsType"></a>

```typescript
public readonly nextjsType: NextjsType;
```

- *Type:* <a href="#cdk-nextjs.NextjsType">NextjsType</a>

---

##### `overrides`<sup>Optional</sup> <a name="overrides" id="cdk-nextjs.NextjsVpcProps.property.overrides"></a>

```typescript
public readonly overrides: NextjsVpcOverrides;
```

- *Type:* <a href="#cdk-nextjs.NextjsVpcOverrides">NextjsVpcOverrides</a>

Override any construct.

---

##### `vpc`<sup>Optional</sup> <a name="vpc" id="cdk-nextjs.NextjsVpcProps.property.vpc"></a>

```typescript
public readonly vpc: IVpc;
```

- *Type:* aws-cdk-lib.aws_ec2.IVpc

Bring your own VPC.

---

### OptionalApplicationLoadBalancedTaskImageOptions <a name="OptionalApplicationLoadBalancedTaskImageOptions" id="cdk-nextjs.OptionalApplicationLoadBalancedTaskImageOptions"></a>

OptionalApplicationLoadBalancedTaskImageOptions.

#### Initializer <a name="Initializer" id="cdk-nextjs.OptionalApplicationLoadBalancedTaskImageOptions.Initializer"></a>

```typescript
import { OptionalApplicationLoadBalancedTaskImageOptions } from 'cdk-nextjs'

const optionalApplicationLoadBalancedTaskImageOptions: OptionalApplicationLoadBalancedTaskImageOptions = { ... }
```

#### Properties <a name="Properties" id="Properties"></a>

| **Name** | **Type** | **Description** |
| --- | --- | --- |
| <code><a href="#cdk-nextjs.OptionalApplicationLoadBalancedTaskImageOptions.property.command">command</a></code> | <code>string[]</code> | The command that's passed to the container. |
| <code><a href="#cdk-nextjs.OptionalApplicationLoadBalancedTaskImageOptions.property.containerName">containerName</a></code> | <code>string</code> | The container name value to be specified in the task definition. |
| <code><a href="#cdk-nextjs.OptionalApplicationLoadBalancedTaskImageOptions.property.containerPort">containerPort</a></code> | <code>number</code> | The port number on the container that is bound to the user-specified or automatically assigned host port. |
| <code><a href="#cdk-nextjs.OptionalApplicationLoadBalancedTaskImageOptions.property.dockerLabels">dockerLabels</a></code> | <code>{[ key: string ]: string}</code> | A key/value map of labels to add to the container. |
| <code><a href="#cdk-nextjs.OptionalApplicationLoadBalancedTaskImageOptions.property.enableLogging">enableLogging</a></code> | <code>boolean</code> | Flag to indicate whether to enable logging. |
| <code><a href="#cdk-nextjs.OptionalApplicationLoadBalancedTaskImageOptions.property.entryPoint">entryPoint</a></code> | <code>string[]</code> | The entry point that's passed to the container. |
| <code><a href="#cdk-nextjs.OptionalApplicationLoadBalancedTaskImageOptions.property.environment">environment</a></code> | <code>{[ key: string ]: string}</code> | The environment variables to pass to the container. |
| <code><a href="#cdk-nextjs.OptionalApplicationLoadBalancedTaskImageOptions.property.executionRole">executionRole</a></code> | <code>aws-cdk-lib.aws_iam.IRole</code> | The name of the task execution IAM role that grants the Amazon ECS container agent permission to call AWS APIs on your behalf. |
| <code><a href="#cdk-nextjs.OptionalApplicationLoadBalancedTaskImageOptions.property.family">family</a></code> | <code>string</code> | The name of a family that this task definition is registered to. |
| <code><a href="#cdk-nextjs.OptionalApplicationLoadBalancedTaskImageOptions.property.image">image</a></code> | <code>aws-cdk-lib.aws_ecs.ContainerImage</code> | The image used to start a container. |
| <code><a href="#cdk-nextjs.OptionalApplicationLoadBalancedTaskImageOptions.property.logDriver">logDriver</a></code> | <code>aws-cdk-lib.aws_ecs.LogDriver</code> | The log driver to use. |
| <code><a href="#cdk-nextjs.OptionalApplicationLoadBalancedTaskImageOptions.property.secrets">secrets</a></code> | <code>{[ key: string ]: aws-cdk-lib.aws_ecs.Secret}</code> | The secret to expose to the container as an environment variable. |
| <code><a href="#cdk-nextjs.OptionalApplicationLoadBalancedTaskImageOptions.property.taskRole">taskRole</a></code> | <code>aws-cdk-lib.aws_iam.IRole</code> | The name of the task IAM role that grants containers in the task permission to call AWS APIs on your behalf. |

---

##### `command`<sup>Optional</sup> <a name="command" id="cdk-nextjs.OptionalApplicationLoadBalancedTaskImageOptions.property.command"></a>

```typescript
public readonly command: string[];
```

- *Type:* string[]
- *Default:* none

The command that's passed to the container.

If there are multiple arguments, make sure that each argument is a separated string in the array.

This parameter maps to `Cmd` in the [Create a container](https://docs.docker.com/engine/api/v1.38/#operation/ContainerCreate) section
of the [Docker Remote API](https://docs.docker.com/engine/api/v1.38/) and the `COMMAND` parameter to
[docker run](https://docs.docker.com/engine/reference/commandline/run/).

For more information about the Docker `CMD` parameter, see https://docs.docker.com/engine/reference/builder/#cmd.

---

##### `containerName`<sup>Optional</sup> <a name="containerName" id="cdk-nextjs.OptionalApplicationLoadBalancedTaskImageOptions.property.containerName"></a>

```typescript
public readonly containerName: string;
```

- *Type:* string
- *Default:* none

The container name value to be specified in the task definition.

---

##### `containerPort`<sup>Optional</sup> <a name="containerPort" id="cdk-nextjs.OptionalApplicationLoadBalancedTaskImageOptions.property.containerPort"></a>

```typescript
public readonly containerPort: number;
```

- *Type:* number
- *Default:* 80

The port number on the container that is bound to the user-specified or automatically assigned host port.

If you are using containers in a task with the awsvpc or host network mode, exposed ports should be specified using containerPort.
If you are using containers in a task with the bridge network mode and you specify a container port and not a host port,
your container automatically receives a host port in the ephemeral port range.

Port mappings that are automatically assigned in this way do not count toward the 100 reserved ports limit of a container instance.

For more information, see
[hostPort](https://docs.aws.amazon.com/AmazonECS/latest/APIReference/API_PortMapping.html#ECS-Type-PortMapping-hostPort).

---

##### `dockerLabels`<sup>Optional</sup> <a name="dockerLabels" id="cdk-nextjs.OptionalApplicationLoadBalancedTaskImageOptions.property.dockerLabels"></a>

```typescript
public readonly dockerLabels: {[ key: string ]: string};
```

- *Type:* {[ key: string ]: string}
- *Default:* No labels.

A key/value map of labels to add to the container.

---

##### `enableLogging`<sup>Optional</sup> <a name="enableLogging" id="cdk-nextjs.OptionalApplicationLoadBalancedTaskImageOptions.property.enableLogging"></a>

```typescript
public readonly enableLogging: boolean;
```

- *Type:* boolean
- *Default:* true

Flag to indicate whether to enable logging.

---

##### `entryPoint`<sup>Optional</sup> <a name="entryPoint" id="cdk-nextjs.OptionalApplicationLoadBalancedTaskImageOptions.property.entryPoint"></a>

```typescript
public readonly entryPoint: string[];
```

- *Type:* string[]
- *Default:* none

The entry point that's passed to the container.

This parameter maps to `Entrypoint` in the [Create a container](https://docs.docker.com/engine/api/v1.38/#operation/ContainerCreate) section
of the [Docker Remote API](https://docs.docker.com/engine/api/v1.38/) and the `--entrypoint` option to
[docker run](https://docs.docker.com/engine/reference/commandline/run/).

For more information about the Docker `ENTRYPOINT` parameter, see https://docs.docker.com/engine/reference/builder/#entrypoint.

---

##### `environment`<sup>Optional</sup> <a name="environment" id="cdk-nextjs.OptionalApplicationLoadBalancedTaskImageOptions.property.environment"></a>

```typescript
public readonly environment: {[ key: string ]: string};
```

- *Type:* {[ key: string ]: string}
- *Default:* No environment variables.

The environment variables to pass to the container.

---

##### `executionRole`<sup>Optional</sup> <a name="executionRole" id="cdk-nextjs.OptionalApplicationLoadBalancedTaskImageOptions.property.executionRole"></a>

```typescript
public readonly executionRole: IRole;
```

- *Type:* aws-cdk-lib.aws_iam.IRole
- *Default:* No value

The name of the task execution IAM role that grants the Amazon ECS container agent permission to call AWS APIs on your behalf.

---

##### `family`<sup>Optional</sup> <a name="family" id="cdk-nextjs.OptionalApplicationLoadBalancedTaskImageOptions.property.family"></a>

```typescript
public readonly family: string;
```

- *Type:* string
- *Default:* Automatically generated name.

The name of a family that this task definition is registered to.

A family groups multiple versions of a task definition.

---

##### `image`<sup>Optional</sup> <a name="image" id="cdk-nextjs.OptionalApplicationLoadBalancedTaskImageOptions.property.image"></a>

```typescript
public readonly image: ContainerImage;
```

- *Type:* aws-cdk-lib.aws_ecs.ContainerImage
- *Default:* none

The image used to start a container.

Image or taskDefinition must be specified, not both.

---

##### `logDriver`<sup>Optional</sup> <a name="logDriver" id="cdk-nextjs.OptionalApplicationLoadBalancedTaskImageOptions.property.logDriver"></a>

```typescript
public readonly logDriver: LogDriver;
```

- *Type:* aws-cdk-lib.aws_ecs.LogDriver
- *Default:* AwsLogDriver if enableLogging is true

The log driver to use.

---

##### `secrets`<sup>Optional</sup> <a name="secrets" id="cdk-nextjs.OptionalApplicationLoadBalancedTaskImageOptions.property.secrets"></a>

```typescript
public readonly secrets: {[ key: string ]: Secret};
```

- *Type:* {[ key: string ]: aws-cdk-lib.aws_ecs.Secret}
- *Default:* No secret environment variables.

The secret to expose to the container as an environment variable.

---

##### `taskRole`<sup>Optional</sup> <a name="taskRole" id="cdk-nextjs.OptionalApplicationLoadBalancedTaskImageOptions.property.taskRole"></a>

```typescript
public readonly taskRole: IRole;
```

- *Type:* aws-cdk-lib.aws_iam.IRole
- *Default:* A task role is automatically created for you.

The name of the task IAM role that grants containers in the task permission to call AWS APIs on your behalf.

---

### OptionalCloudFrontFunctionProps <a name="OptionalCloudFrontFunctionProps" id="cdk-nextjs.OptionalCloudFrontFunctionProps"></a>

OptionalCloudFrontFunctionProps.

#### Initializer <a name="Initializer" id="cdk-nextjs.OptionalCloudFrontFunctionProps.Initializer"></a>

```typescript
import { OptionalCloudFrontFunctionProps } from 'cdk-nextjs'

const optionalCloudFrontFunctionProps: OptionalCloudFrontFunctionProps = { ... }
```

#### Properties <a name="Properties" id="Properties"></a>

| **Name** | **Type** | **Description** |
| --- | --- | --- |
| <code><a href="#cdk-nextjs.OptionalCloudFrontFunctionProps.property.autoPublish">autoPublish</a></code> | <code>boolean</code> | A flag that determines whether to automatically publish the function to the LIVE stage when it’s created. |
| <code><a href="#cdk-nextjs.OptionalCloudFrontFunctionProps.property.code">code</a></code> | <code>aws-cdk-lib.aws_cloudfront.FunctionCode</code> | The source code of the function. |
| <code><a href="#cdk-nextjs.OptionalCloudFrontFunctionProps.property.comment">comment</a></code> | <code>string</code> | A comment to describe the function. |
| <code><a href="#cdk-nextjs.OptionalCloudFrontFunctionProps.property.functionName">functionName</a></code> | <code>string</code> | A name to identify the function. |
| <code><a href="#cdk-nextjs.OptionalCloudFrontFunctionProps.property.keyValueStore">keyValueStore</a></code> | <code>aws-cdk-lib.aws_cloudfront.IKeyValueStore</code> | The Key Value Store to associate with this function. |
| <code><a href="#cdk-nextjs.OptionalCloudFrontFunctionProps.property.runtime">runtime</a></code> | <code>aws-cdk-lib.aws_cloudfront.FunctionRuntime</code> | The runtime environment for the function. |

---

##### `autoPublish`<sup>Optional</sup> <a name="autoPublish" id="cdk-nextjs.OptionalCloudFrontFunctionProps.property.autoPublish"></a>

```typescript
public readonly autoPublish: boolean;
```

- *Type:* boolean
- *Default:* true

A flag that determines whether to automatically publish the function to the LIVE stage when it’s created.

---

##### `code`<sup>Optional</sup> <a name="code" id="cdk-nextjs.OptionalCloudFrontFunctionProps.property.code"></a>

```typescript
public readonly code: FunctionCode;
```

- *Type:* aws-cdk-lib.aws_cloudfront.FunctionCode

The source code of the function.

---

##### `comment`<sup>Optional</sup> <a name="comment" id="cdk-nextjs.OptionalCloudFrontFunctionProps.property.comment"></a>

```typescript
public readonly comment: string;
```

- *Type:* string
- *Default:* same as `functionName`

A comment to describe the function.

---

##### `functionName`<sup>Optional</sup> <a name="functionName" id="cdk-nextjs.OptionalCloudFrontFunctionProps.property.functionName"></a>

```typescript
public readonly functionName: string;
```

- *Type:* string
- *Default:* generated from the `id`

A name to identify the function.

---

##### `keyValueStore`<sup>Optional</sup> <a name="keyValueStore" id="cdk-nextjs.OptionalCloudFrontFunctionProps.property.keyValueStore"></a>

```typescript
public readonly keyValueStore: IKeyValueStore;
```

- *Type:* aws-cdk-lib.aws_cloudfront.IKeyValueStore
- *Default:* no key value store is associated

The Key Value Store to associate with this function.

In order to associate a Key Value Store, the `runtime` must be
`cloudfront-js-2.0` or newer.

---

##### `runtime`<sup>Optional</sup> <a name="runtime" id="cdk-nextjs.OptionalCloudFrontFunctionProps.property.runtime"></a>

```typescript
public readonly runtime: FunctionRuntime;
```

- *Type:* aws-cdk-lib.aws_cloudfront.FunctionRuntime
- *Default:* FunctionRuntime.JS_1_0 (unless `keyValueStore` is specified, then `FunctionRuntime.JS_2_0`)

The runtime environment for the function.

---

### OptionalClusterProps <a name="OptionalClusterProps" id="cdk-nextjs.OptionalClusterProps"></a>

OptionalClusterProps.

#### Initializer <a name="Initializer" id="cdk-nextjs.OptionalClusterProps.Initializer"></a>

```typescript
import { OptionalClusterProps } from 'cdk-nextjs'

const optionalClusterProps: OptionalClusterProps = { ... }
```

#### Properties <a name="Properties" id="Properties"></a>

| **Name** | **Type** | **Description** |
| --- | --- | --- |
| <code><a href="#cdk-nextjs.OptionalClusterProps.property.capacity">capacity</a></code> | <code>aws-cdk-lib.aws_ecs.AddCapacityOptions</code> | The ec2 capacity to add to the cluster. |
| <code><a href="#cdk-nextjs.OptionalClusterProps.property.clusterName">clusterName</a></code> | <code>string</code> | The name for the cluster. |
| <code><a href="#cdk-nextjs.OptionalClusterProps.property.containerInsights">containerInsights</a></code> | <code>boolean</code> | If true CloudWatch Container Insights will be enabled for the cluster. |
| <code><a href="#cdk-nextjs.OptionalClusterProps.property.defaultCloudMapNamespace">defaultCloudMapNamespace</a></code> | <code>aws-cdk-lib.aws_ecs.CloudMapNamespaceOptions</code> | The service discovery namespace created in this cluster. |
| <code><a href="#cdk-nextjs.OptionalClusterProps.property.enableFargateCapacityProviders">enableFargateCapacityProviders</a></code> | <code>boolean</code> | Whether to enable Fargate Capacity Providers. |
| <code><a href="#cdk-nextjs.OptionalClusterProps.property.executeCommandConfiguration">executeCommandConfiguration</a></code> | <code>aws-cdk-lib.aws_ecs.ExecuteCommandConfiguration</code> | The execute command configuration for the cluster. |
| <code><a href="#cdk-nextjs.OptionalClusterProps.property.vpc">vpc</a></code> | <code>aws-cdk-lib.aws_ec2.IVpc</code> | The VPC where your ECS instances will be running or your ENIs will be deployed. |

---

##### `capacity`<sup>Optional</sup> <a name="capacity" id="cdk-nextjs.OptionalClusterProps.property.capacity"></a>

```typescript
public readonly capacity: AddCapacityOptions;
```

- *Type:* aws-cdk-lib.aws_ecs.AddCapacityOptions
- *Default:* no EC2 capacity will be added, you can use `addCapacity` to add capacity later.

The ec2 capacity to add to the cluster.

---

##### `clusterName`<sup>Optional</sup> <a name="clusterName" id="cdk-nextjs.OptionalClusterProps.property.clusterName"></a>

```typescript
public readonly clusterName: string;
```

- *Type:* string
- *Default:* CloudFormation-generated name

The name for the cluster.

---

##### `containerInsights`<sup>Optional</sup> <a name="containerInsights" id="cdk-nextjs.OptionalClusterProps.property.containerInsights"></a>

```typescript
public readonly containerInsights: boolean;
```

- *Type:* boolean
- *Default:* Container Insights will be disabled for this cluster.

If true CloudWatch Container Insights will be enabled for the cluster.

---

##### `defaultCloudMapNamespace`<sup>Optional</sup> <a name="defaultCloudMapNamespace" id="cdk-nextjs.OptionalClusterProps.property.defaultCloudMapNamespace"></a>

```typescript
public readonly defaultCloudMapNamespace: CloudMapNamespaceOptions;
```

- *Type:* aws-cdk-lib.aws_ecs.CloudMapNamespaceOptions
- *Default:* no service discovery namespace created, you can use `addDefaultCloudMapNamespace` to add a default service discovery namespace later.

The service discovery namespace created in this cluster.

---

##### `enableFargateCapacityProviders`<sup>Optional</sup> <a name="enableFargateCapacityProviders" id="cdk-nextjs.OptionalClusterProps.property.enableFargateCapacityProviders"></a>

```typescript
public readonly enableFargateCapacityProviders: boolean;
```

- *Type:* boolean
- *Default:* false

Whether to enable Fargate Capacity Providers.

---

##### `executeCommandConfiguration`<sup>Optional</sup> <a name="executeCommandConfiguration" id="cdk-nextjs.OptionalClusterProps.property.executeCommandConfiguration"></a>

```typescript
public readonly executeCommandConfiguration: ExecuteCommandConfiguration;
```

- *Type:* aws-cdk-lib.aws_ecs.ExecuteCommandConfiguration
- *Default:* no configuration will be provided.

The execute command configuration for the cluster.

---

##### `vpc`<sup>Optional</sup> <a name="vpc" id="cdk-nextjs.OptionalClusterProps.property.vpc"></a>

```typescript
public readonly vpc: IVpc;
```

- *Type:* aws-cdk-lib.aws_ec2.IVpc
- *Default:* creates a new VPC with two AZs

The VPC where your ECS instances will be running or your ENIs will be deployed.

---

### OptionalDistributionProps <a name="OptionalDistributionProps" id="cdk-nextjs.OptionalDistributionProps"></a>

OptionalDistributionProps.

#### Initializer <a name="Initializer" id="cdk-nextjs.OptionalDistributionProps.Initializer"></a>

```typescript
import { OptionalDistributionProps } from 'cdk-nextjs'

const optionalDistributionProps: OptionalDistributionProps = { ... }
```

#### Properties <a name="Properties" id="Properties"></a>

| **Name** | **Type** | **Description** |
| --- | --- | --- |
| <code><a href="#cdk-nextjs.OptionalDistributionProps.property.additionalBehaviors">additionalBehaviors</a></code> | <code>{[ key: string ]: aws-cdk-lib.aws_cloudfront.BehaviorOptions}</code> | Additional behaviors for the distribution, mapped by the pathPattern that specifies which requests to apply the behavior to. |
| <code><a href="#cdk-nextjs.OptionalDistributionProps.property.certificate">certificate</a></code> | <code>aws-cdk-lib.aws_certificatemanager.ICertificate</code> | A certificate to associate with the distribution. |
| <code><a href="#cdk-nextjs.OptionalDistributionProps.property.comment">comment</a></code> | <code>string</code> | Any comments you want to include about the distribution. |
| <code><a href="#cdk-nextjs.OptionalDistributionProps.property.defaultBehavior">defaultBehavior</a></code> | <code>aws-cdk-lib.aws_cloudfront.BehaviorOptions</code> | The default behavior for the distribution. |
| <code><a href="#cdk-nextjs.OptionalDistributionProps.property.defaultRootObject">defaultRootObject</a></code> | <code>string</code> | The object that you want CloudFront to request from your origin (for example, index.html) when a viewer requests the root URL for your distribution. If no default object is set, the request goes to the origin's root (e.g., example.com/). |
| <code><a href="#cdk-nextjs.OptionalDistributionProps.property.domainNames">domainNames</a></code> | <code>string[]</code> | Alternative domain names for this distribution. |
| <code><a href="#cdk-nextjs.OptionalDistributionProps.property.enabled">enabled</a></code> | <code>boolean</code> | Enable or disable the distribution. |
| <code><a href="#cdk-nextjs.OptionalDistributionProps.property.enableIpv6">enableIpv6</a></code> | <code>boolean</code> | Whether CloudFront will respond to IPv6 DNS requests with an IPv6 address. |
| <code><a href="#cdk-nextjs.OptionalDistributionProps.property.enableLogging">enableLogging</a></code> | <code>boolean</code> | Enable access logging for the distribution. |
| <code><a href="#cdk-nextjs.OptionalDistributionProps.property.errorResponses">errorResponses</a></code> | <code>aws-cdk-lib.aws_cloudfront.ErrorResponse[]</code> | How CloudFront should handle requests that are not successful (e.g., PageNotFound). |
| <code><a href="#cdk-nextjs.OptionalDistributionProps.property.geoRestriction">geoRestriction</a></code> | <code>aws-cdk-lib.aws_cloudfront.GeoRestriction</code> | Controls the countries in which your content is distributed. |
| <code><a href="#cdk-nextjs.OptionalDistributionProps.property.httpVersion">httpVersion</a></code> | <code>aws-cdk-lib.aws_cloudfront.HttpVersion</code> | Specify the maximum HTTP version that you want viewers to use to communicate with CloudFront. |
| <code><a href="#cdk-nextjs.OptionalDistributionProps.property.logBucket">logBucket</a></code> | <code>aws-cdk-lib.aws_s3.IBucket</code> | The Amazon S3 bucket to store the access logs in. |
| <code><a href="#cdk-nextjs.OptionalDistributionProps.property.logFilePrefix">logFilePrefix</a></code> | <code>string</code> | An optional string that you want CloudFront to prefix to the access log filenames for this distribution. |
| <code><a href="#cdk-nextjs.OptionalDistributionProps.property.logIncludesCookies">logIncludesCookies</a></code> | <code>boolean</code> | Specifies whether you want CloudFront to include cookies in access logs. |
| <code><a href="#cdk-nextjs.OptionalDistributionProps.property.minimumProtocolVersion">minimumProtocolVersion</a></code> | <code>aws-cdk-lib.aws_cloudfront.SecurityPolicyProtocol</code> | The minimum version of the SSL protocol that you want CloudFront to use for HTTPS connections. |
| <code><a href="#cdk-nextjs.OptionalDistributionProps.property.priceClass">priceClass</a></code> | <code>aws-cdk-lib.aws_cloudfront.PriceClass</code> | The price class that corresponds with the maximum price that you want to pay for CloudFront service. |
| <code><a href="#cdk-nextjs.OptionalDistributionProps.property.publishAdditionalMetrics">publishAdditionalMetrics</a></code> | <code>boolean</code> | Whether to enable additional CloudWatch metrics. |
| <code><a href="#cdk-nextjs.OptionalDistributionProps.property.sslSupportMethod">sslSupportMethod</a></code> | <code>aws-cdk-lib.aws_cloudfront.SSLMethod</code> | The SSL method CloudFront will use for your distribution. |
| <code><a href="#cdk-nextjs.OptionalDistributionProps.property.webAclId">webAclId</a></code> | <code>string</code> | Unique identifier that specifies the AWS WAF web ACL to associate with this CloudFront distribution. |

---

##### `additionalBehaviors`<sup>Optional</sup> <a name="additionalBehaviors" id="cdk-nextjs.OptionalDistributionProps.property.additionalBehaviors"></a>

```typescript
public readonly additionalBehaviors: {[ key: string ]: BehaviorOptions};
```

- *Type:* {[ key: string ]: aws-cdk-lib.aws_cloudfront.BehaviorOptions}
- *Default:* no additional behaviors are added.

Additional behaviors for the distribution, mapped by the pathPattern that specifies which requests to apply the behavior to.

---

##### `certificate`<sup>Optional</sup> <a name="certificate" id="cdk-nextjs.OptionalDistributionProps.property.certificate"></a>

```typescript
public readonly certificate: ICertificate;
```

- *Type:* aws-cdk-lib.aws_certificatemanager.ICertificate
- *Default:* the CloudFront wildcard certificate (*.cloudfront.net) will be used.

A certificate to associate with the distribution.

The certificate must be located in N. Virginia (us-east-1).

---

##### `comment`<sup>Optional</sup> <a name="comment" id="cdk-nextjs.OptionalDistributionProps.property.comment"></a>

```typescript
public readonly comment: string;
```

- *Type:* string
- *Default:* no comment

Any comments you want to include about the distribution.

---

##### `defaultBehavior`<sup>Optional</sup> <a name="defaultBehavior" id="cdk-nextjs.OptionalDistributionProps.property.defaultBehavior"></a>

```typescript
public readonly defaultBehavior: BehaviorOptions;
```

- *Type:* aws-cdk-lib.aws_cloudfront.BehaviorOptions

The default behavior for the distribution.

---

##### `defaultRootObject`<sup>Optional</sup> <a name="defaultRootObject" id="cdk-nextjs.OptionalDistributionProps.property.defaultRootObject"></a>

```typescript
public readonly defaultRootObject: string;
```

- *Type:* string
- *Default:* no default root object

The object that you want CloudFront to request from your origin (for example, index.html) when a viewer requests the root URL for your distribution. If no default object is set, the request goes to the origin's root (e.g., example.com/).

---

##### `domainNames`<sup>Optional</sup> <a name="domainNames" id="cdk-nextjs.OptionalDistributionProps.property.domainNames"></a>

```typescript
public readonly domainNames: string[];
```

- *Type:* string[]
- *Default:* The distribution will only support the default generated name (e.g., d111111abcdef8.cloudfront.net)

Alternative domain names for this distribution.

If you want to use your own domain name, such as www.example.com, instead of the cloudfront.net domain name,
you can add an alternate domain name to your distribution. If you attach a certificate to the distribution,
you must add (at least one of) the domain names of the certificate to this list.

---

##### `enabled`<sup>Optional</sup> <a name="enabled" id="cdk-nextjs.OptionalDistributionProps.property.enabled"></a>

```typescript
public readonly enabled: boolean;
```

- *Type:* boolean
- *Default:* true

Enable or disable the distribution.

---

##### `enableIpv6`<sup>Optional</sup> <a name="enableIpv6" id="cdk-nextjs.OptionalDistributionProps.property.enableIpv6"></a>

```typescript
public readonly enableIpv6: boolean;
```

- *Type:* boolean
- *Default:* true

Whether CloudFront will respond to IPv6 DNS requests with an IPv6 address.

If you specify false, CloudFront responds to IPv6 DNS requests with the DNS response code NOERROR and with no IP addresses.
This allows viewers to submit a second request, for an IPv4 address for your distribution.

---

##### `enableLogging`<sup>Optional</sup> <a name="enableLogging" id="cdk-nextjs.OptionalDistributionProps.property.enableLogging"></a>

```typescript
public readonly enableLogging: boolean;
```

- *Type:* boolean
- *Default:* false, unless `logBucket` is specified.

Enable access logging for the distribution.

---

##### `errorResponses`<sup>Optional</sup> <a name="errorResponses" id="cdk-nextjs.OptionalDistributionProps.property.errorResponses"></a>

```typescript
public readonly errorResponses: ErrorResponse[];
```

- *Type:* aws-cdk-lib.aws_cloudfront.ErrorResponse[]
- *Default:* No custom error responses.

How CloudFront should handle requests that are not successful (e.g., PageNotFound).

---

##### `geoRestriction`<sup>Optional</sup> <a name="geoRestriction" id="cdk-nextjs.OptionalDistributionProps.property.geoRestriction"></a>

```typescript
public readonly geoRestriction: GeoRestriction;
```

- *Type:* aws-cdk-lib.aws_cloudfront.GeoRestriction
- *Default:* No geographic restrictions

Controls the countries in which your content is distributed.

---

##### `httpVersion`<sup>Optional</sup> <a name="httpVersion" id="cdk-nextjs.OptionalDistributionProps.property.httpVersion"></a>

```typescript
public readonly httpVersion: HttpVersion;
```

- *Type:* aws-cdk-lib.aws_cloudfront.HttpVersion
- *Default:* HttpVersion.HTTP2

Specify the maximum HTTP version that you want viewers to use to communicate with CloudFront.

For viewers and CloudFront to use HTTP/2, viewers must support TLS 1.2 or later, and must support server name identification (SNI).

---

##### `logBucket`<sup>Optional</sup> <a name="logBucket" id="cdk-nextjs.OptionalDistributionProps.property.logBucket"></a>

```typescript
public readonly logBucket: IBucket;
```

- *Type:* aws-cdk-lib.aws_s3.IBucket
- *Default:* A bucket is created if `enableLogging` is true

The Amazon S3 bucket to store the access logs in.

Make sure to set `objectOwnership` to `s3.ObjectOwnership.OBJECT_WRITER` in your custom bucket.

---

##### `logFilePrefix`<sup>Optional</sup> <a name="logFilePrefix" id="cdk-nextjs.OptionalDistributionProps.property.logFilePrefix"></a>

```typescript
public readonly logFilePrefix: string;
```

- *Type:* string
- *Default:* no prefix

An optional string that you want CloudFront to prefix to the access log filenames for this distribution.

---

##### `logIncludesCookies`<sup>Optional</sup> <a name="logIncludesCookies" id="cdk-nextjs.OptionalDistributionProps.property.logIncludesCookies"></a>

```typescript
public readonly logIncludesCookies: boolean;
```

- *Type:* boolean
- *Default:* false

Specifies whether you want CloudFront to include cookies in access logs.

---

##### `minimumProtocolVersion`<sup>Optional</sup> <a name="minimumProtocolVersion" id="cdk-nextjs.OptionalDistributionProps.property.minimumProtocolVersion"></a>

```typescript
public readonly minimumProtocolVersion: SecurityPolicyProtocol;
```

- *Type:* aws-cdk-lib.aws_cloudfront.SecurityPolicyProtocol
- *Default:* SecurityPolicyProtocol.TLS_V1_2_2021 if the '@aws-cdk/aws-cloudfront:defaultSecurityPolicyTLSv1.2_2021' feature flag is set; otherwise, SecurityPolicyProtocol.TLS_V1_2_2019.

The minimum version of the SSL protocol that you want CloudFront to use for HTTPS connections.

CloudFront serves your objects only to browsers or devices that support at
least the SSL version that you specify.

---

##### `priceClass`<sup>Optional</sup> <a name="priceClass" id="cdk-nextjs.OptionalDistributionProps.property.priceClass"></a>

```typescript
public readonly priceClass: PriceClass;
```

- *Type:* aws-cdk-lib.aws_cloudfront.PriceClass
- *Default:* PriceClass.PRICE_CLASS_ALL

The price class that corresponds with the maximum price that you want to pay for CloudFront service.

If you specify PriceClass_All, CloudFront responds to requests for your objects from all CloudFront edge locations.
If you specify a price class other than PriceClass_All, CloudFront serves your objects from the CloudFront edge location
that has the lowest latency among the edge locations in your price class.

---

##### `publishAdditionalMetrics`<sup>Optional</sup> <a name="publishAdditionalMetrics" id="cdk-nextjs.OptionalDistributionProps.property.publishAdditionalMetrics"></a>

```typescript
public readonly publishAdditionalMetrics: boolean;
```

- *Type:* boolean
- *Default:* false

Whether to enable additional CloudWatch metrics.

---

##### `sslSupportMethod`<sup>Optional</sup> <a name="sslSupportMethod" id="cdk-nextjs.OptionalDistributionProps.property.sslSupportMethod"></a>

```typescript
public readonly sslSupportMethod: SSLMethod;
```

- *Type:* aws-cdk-lib.aws_cloudfront.SSLMethod
- *Default:* SSLMethod.SNI

The SSL method CloudFront will use for your distribution.

Server Name Indication (SNI) - is an extension to the TLS computer networking protocol by which a client indicates
which hostname it is attempting to connect to at the start of the handshaking process. This allows a server to present
multiple certificates on the same IP address and TCP port number and hence allows multiple secure (HTTPS) websites
(or any other service over TLS) to be served by the same IP address without requiring all those sites to use the same certificate.

CloudFront can use SNI to host multiple distributions on the same IP - which a large majority of clients will support.

If your clients cannot support SNI however - CloudFront can use dedicated IPs for your distribution - but there is a prorated monthly charge for
using this feature. By default, we use SNI - but you can optionally enable dedicated IPs (VIP).

See the CloudFront SSL for more details about pricing : https://aws.amazon.com/cloudfront/custom-ssl-domains/

---

##### `webAclId`<sup>Optional</sup> <a name="webAclId" id="cdk-nextjs.OptionalDistributionProps.property.webAclId"></a>

```typescript
public readonly webAclId: string;
```

- *Type:* string
- *Default:* No AWS Web Application Firewall web access control list (web ACL).

Unique identifier that specifies the AWS WAF web ACL to associate with this CloudFront distribution.

To specify a web ACL created using the latest version of AWS WAF, use the ACL ARN, for example
`arn:aws:wafv2:us-east-1:123456789012:global/webacl/ExampleWebACL/473e64fd-f30b-4765-81a0-62ad96dd167a`.
To specify a web ACL created using AWS WAF Classic, use the ACL ID, for example `473e64fd-f30b-4765-81a0-62ad96dd167a`.

---

### OptionalDockerImageAssetProps <a name="OptionalDockerImageAssetProps" id="cdk-nextjs.OptionalDockerImageAssetProps"></a>

OptionalDockerImageAssetProps.

#### Initializer <a name="Initializer" id="cdk-nextjs.OptionalDockerImageAssetProps.Initializer"></a>

```typescript
import { OptionalDockerImageAssetProps } from 'cdk-nextjs'

const optionalDockerImageAssetProps: OptionalDockerImageAssetProps = { ... }
```

#### Properties <a name="Properties" id="Properties"></a>

| **Name** | **Type** | **Description** |
| --- | --- | --- |
| <code><a href="#cdk-nextjs.OptionalDockerImageAssetProps.property.assetName">assetName</a></code> | <code>string</code> | Unique identifier of the docker image asset and its potential revisions. |
| <code><a href="#cdk-nextjs.OptionalDockerImageAssetProps.property.buildArgs">buildArgs</a></code> | <code>{[ key: string ]: string}</code> | Build args to pass to the `docker build` command. |
| <code><a href="#cdk-nextjs.OptionalDockerImageAssetProps.property.buildSecrets">buildSecrets</a></code> | <code>{[ key: string ]: string}</code> | Build secrets. |
| <code><a href="#cdk-nextjs.OptionalDockerImageAssetProps.property.buildSsh">buildSsh</a></code> | <code>string</code> | SSH agent socket or keys to pass to the `docker build` command. |
| <code><a href="#cdk-nextjs.OptionalDockerImageAssetProps.property.cacheDisabled">cacheDisabled</a></code> | <code>boolean</code> | Disable the cache and pass `--no-cache` to the `docker build` command. |
| <code><a href="#cdk-nextjs.OptionalDockerImageAssetProps.property.cacheFrom">cacheFrom</a></code> | <code>aws-cdk-lib.aws_ecr_assets.DockerCacheOption[]</code> | Cache from options to pass to the `docker build` command. |
| <code><a href="#cdk-nextjs.OptionalDockerImageAssetProps.property.cacheTo">cacheTo</a></code> | <code>aws-cdk-lib.aws_ecr_assets.DockerCacheOption</code> | Cache to options to pass to the `docker build` command. |
| <code><a href="#cdk-nextjs.OptionalDockerImageAssetProps.property.directory">directory</a></code> | <code>string</code> | The directory where the Dockerfile is stored. |
| <code><a href="#cdk-nextjs.OptionalDockerImageAssetProps.property.exclude">exclude</a></code> | <code>string[]</code> | File paths matching the patterns will be excluded. |
| <code><a href="#cdk-nextjs.OptionalDockerImageAssetProps.property.extraHash">extraHash</a></code> | <code>string</code> | Extra information to encode into the fingerprint (e.g. build instructions and other inputs). |
| <code><a href="#cdk-nextjs.OptionalDockerImageAssetProps.property.file">file</a></code> | <code>string</code> | Path to the Dockerfile (relative to the directory). |
| <code><a href="#cdk-nextjs.OptionalDockerImageAssetProps.property.followSymlinks">followSymlinks</a></code> | <code>aws-cdk-lib.SymlinkFollowMode</code> | A strategy for how to handle symlinks. |
| <code><a href="#cdk-nextjs.OptionalDockerImageAssetProps.property.ignoreMode">ignoreMode</a></code> | <code>aws-cdk-lib.IgnoreMode</code> | The ignore behavior to use for `exclude` patterns. |
| <code><a href="#cdk-nextjs.OptionalDockerImageAssetProps.property.invalidation">invalidation</a></code> | <code>aws-cdk-lib.aws_ecr_assets.DockerImageAssetInvalidationOptions</code> | Options to control which parameters are used to invalidate the asset hash. |
| <code><a href="#cdk-nextjs.OptionalDockerImageAssetProps.property.networkMode">networkMode</a></code> | <code>aws-cdk-lib.aws_ecr_assets.NetworkMode</code> | Networking mode for the RUN commands during build. |
| <code><a href="#cdk-nextjs.OptionalDockerImageAssetProps.property.outputs">outputs</a></code> | <code>string[]</code> | Outputs to pass to the `docker build` command. |
| <code><a href="#cdk-nextjs.OptionalDockerImageAssetProps.property.platform">platform</a></code> | <code>aws-cdk-lib.aws_ecr_assets.Platform</code> | Platform to build for. |
| <code><a href="#cdk-nextjs.OptionalDockerImageAssetProps.property.target">target</a></code> | <code>string</code> | Docker target to build to. |

---

##### `assetName`<sup>Optional</sup> <a name="assetName" id="cdk-nextjs.OptionalDockerImageAssetProps.property.assetName"></a>

```typescript
public readonly assetName: string;
```

- *Type:* string
- *Default:* no asset name

Unique identifier of the docker image asset and its potential revisions.

Required if using AppScopedStagingSynthesizer.

---

##### `buildArgs`<sup>Optional</sup> <a name="buildArgs" id="cdk-nextjs.OptionalDockerImageAssetProps.property.buildArgs"></a>

```typescript
public readonly buildArgs: {[ key: string ]: string};
```

- *Type:* {[ key: string ]: string}
- *Default:* no build args are passed

Build args to pass to the `docker build` command.

Since Docker build arguments are resolved before deployment, keys and
values cannot refer to unresolved tokens (such as `lambda.functionArn` or
`queue.queueUrl`).

---

##### `buildSecrets`<sup>Optional</sup> <a name="buildSecrets" id="cdk-nextjs.OptionalDockerImageAssetProps.property.buildSecrets"></a>

```typescript
public readonly buildSecrets: {[ key: string ]: string};
```

- *Type:* {[ key: string ]: string}
- *Default:* no build secrets

Build secrets.

Docker BuildKit must be enabled to use build secrets.

---

##### `buildSsh`<sup>Optional</sup> <a name="buildSsh" id="cdk-nextjs.OptionalDockerImageAssetProps.property.buildSsh"></a>

```typescript
public readonly buildSsh: string;
```

- *Type:* string
- *Default:* no --ssh flag

SSH agent socket or keys to pass to the `docker build` command.

Docker BuildKit must be enabled to use the ssh flag

---

##### `cacheDisabled`<sup>Optional</sup> <a name="cacheDisabled" id="cdk-nextjs.OptionalDockerImageAssetProps.property.cacheDisabled"></a>

```typescript
public readonly cacheDisabled: boolean;
```

- *Type:* boolean
- *Default:* cache is used

Disable the cache and pass `--no-cache` to the `docker build` command.

---

##### `cacheFrom`<sup>Optional</sup> <a name="cacheFrom" id="cdk-nextjs.OptionalDockerImageAssetProps.property.cacheFrom"></a>

```typescript
public readonly cacheFrom: DockerCacheOption[];
```

- *Type:* aws-cdk-lib.aws_ecr_assets.DockerCacheOption[]
- *Default:* no cache from options are passed to the build command

Cache from options to pass to the `docker build` command.

---

##### `cacheTo`<sup>Optional</sup> <a name="cacheTo" id="cdk-nextjs.OptionalDockerImageAssetProps.property.cacheTo"></a>

```typescript
public readonly cacheTo: DockerCacheOption;
```

- *Type:* aws-cdk-lib.aws_ecr_assets.DockerCacheOption
- *Default:* no cache to options are passed to the build command

Cache to options to pass to the `docker build` command.

---

##### `directory`<sup>Optional</sup> <a name="directory" id="cdk-nextjs.OptionalDockerImageAssetProps.property.directory"></a>

```typescript
public readonly directory: string;
```

- *Type:* string

The directory where the Dockerfile is stored.

Any directory inside with a name that matches the CDK output folder (cdk.out by default) will be excluded from the asset

---

##### `exclude`<sup>Optional</sup> <a name="exclude" id="cdk-nextjs.OptionalDockerImageAssetProps.property.exclude"></a>

```typescript
public readonly exclude: string[];
```

- *Type:* string[]
- *Default:* nothing is excluded

File paths matching the patterns will be excluded.

See `ignoreMode` to set the matching behavior.
Has no effect on Assets bundled using the `bundling` property.

---

##### `extraHash`<sup>Optional</sup> <a name="extraHash" id="cdk-nextjs.OptionalDockerImageAssetProps.property.extraHash"></a>

```typescript
public readonly extraHash: string;
```

- *Type:* string
- *Default:* hash is only based on source content

Extra information to encode into the fingerprint (e.g. build instructions and other inputs).

---

##### `file`<sup>Optional</sup> <a name="file" id="cdk-nextjs.OptionalDockerImageAssetProps.property.file"></a>

```typescript
public readonly file: string;
```

- *Type:* string
- *Default:* 'Dockerfile'

Path to the Dockerfile (relative to the directory).

---

##### `followSymlinks`<sup>Optional</sup> <a name="followSymlinks" id="cdk-nextjs.OptionalDockerImageAssetProps.property.followSymlinks"></a>

```typescript
public readonly followSymlinks: SymlinkFollowMode;
```

- *Type:* aws-cdk-lib.SymlinkFollowMode
- *Default:* SymlinkFollowMode.NEVER

A strategy for how to handle symlinks.

---

##### `ignoreMode`<sup>Optional</sup> <a name="ignoreMode" id="cdk-nextjs.OptionalDockerImageAssetProps.property.ignoreMode"></a>

```typescript
public readonly ignoreMode: IgnoreMode;
```

- *Type:* aws-cdk-lib.IgnoreMode
- *Default:* IgnoreMode.GLOB

The ignore behavior to use for `exclude` patterns.

---

##### `invalidation`<sup>Optional</sup> <a name="invalidation" id="cdk-nextjs.OptionalDockerImageAssetProps.property.invalidation"></a>

```typescript
public readonly invalidation: DockerImageAssetInvalidationOptions;
```

- *Type:* aws-cdk-lib.aws_ecr_assets.DockerImageAssetInvalidationOptions
- *Default:* hash all parameters

Options to control which parameters are used to invalidate the asset hash.

---

##### `networkMode`<sup>Optional</sup> <a name="networkMode" id="cdk-nextjs.OptionalDockerImageAssetProps.property.networkMode"></a>

```typescript
public readonly networkMode: NetworkMode;
```

- *Type:* aws-cdk-lib.aws_ecr_assets.NetworkMode
- *Default:* no networking mode specified (the default networking mode `NetworkMode.DEFAULT` will be used)

Networking mode for the RUN commands during build.

Support docker API 1.25+.

---

##### `outputs`<sup>Optional</sup> <a name="outputs" id="cdk-nextjs.OptionalDockerImageAssetProps.property.outputs"></a>

```typescript
public readonly outputs: string[];
```

- *Type:* string[]
- *Default:* no outputs are passed to the build command (default outputs are used)

Outputs to pass to the `docker build` command.

---

##### `platform`<sup>Optional</sup> <a name="platform" id="cdk-nextjs.OptionalDockerImageAssetProps.property.platform"></a>

```typescript
public readonly platform: Platform;
```

- *Type:* aws-cdk-lib.aws_ecr_assets.Platform
- *Default:* no platform specified (the current machine architecture will be used)

Platform to build for.

_Requires Docker Buildx_.

---

##### `target`<sup>Optional</sup> <a name="target" id="cdk-nextjs.OptionalDockerImageAssetProps.property.target"></a>

```typescript
public readonly target: string;
```

- *Type:* string
- *Default:* no target

Docker target to build to.

---

### OptionalDockerImageFunctionProps <a name="OptionalDockerImageFunctionProps" id="cdk-nextjs.OptionalDockerImageFunctionProps"></a>

OptionalDockerImageFunctionProps.

#### Initializer <a name="Initializer" id="cdk-nextjs.OptionalDockerImageFunctionProps.Initializer"></a>

```typescript
import { OptionalDockerImageFunctionProps } from 'cdk-nextjs'

const optionalDockerImageFunctionProps: OptionalDockerImageFunctionProps = { ... }
```

#### Properties <a name="Properties" id="Properties"></a>

| **Name** | **Type** | **Description** |
| --- | --- | --- |
| <code><a href="#cdk-nextjs.OptionalDockerImageFunctionProps.property.adotInstrumentation">adotInstrumentation</a></code> | <code>aws-cdk-lib.aws_lambda.AdotInstrumentationConfig</code> | Specify the configuration of AWS Distro for OpenTelemetry (ADOT) instrumentation. |
| <code><a href="#cdk-nextjs.OptionalDockerImageFunctionProps.property.allowAllOutbound">allowAllOutbound</a></code> | <code>boolean</code> | Whether to allow the Lambda to send all network traffic. |
| <code><a href="#cdk-nextjs.OptionalDockerImageFunctionProps.property.allowPublicSubnet">allowPublicSubnet</a></code> | <code>boolean</code> | Lambda Functions in a public subnet can NOT access the internet. |
| <code><a href="#cdk-nextjs.OptionalDockerImageFunctionProps.property.applicationLogLevel">applicationLogLevel</a></code> | <code>string</code> | Sets the application log level for the function. |
| <code><a href="#cdk-nextjs.OptionalDockerImageFunctionProps.property.applicationLogLevelV2">applicationLogLevelV2</a></code> | <code>aws-cdk-lib.aws_lambda.ApplicationLogLevel</code> | Sets the application log level for the function. |
| <code><a href="#cdk-nextjs.OptionalDockerImageFunctionProps.property.architecture">architecture</a></code> | <code>aws-cdk-lib.aws_lambda.Architecture</code> | The system architectures compatible with this lambda function. |
| <code><a href="#cdk-nextjs.OptionalDockerImageFunctionProps.property.code">code</a></code> | <code>aws-cdk-lib.aws_lambda.DockerImageCode</code> | The source code of your Lambda function. |
| <code><a href="#cdk-nextjs.OptionalDockerImageFunctionProps.property.codeSigningConfig">codeSigningConfig</a></code> | <code>aws-cdk-lib.aws_lambda.ICodeSigningConfig</code> | Code signing config associated with this function. |
| <code><a href="#cdk-nextjs.OptionalDockerImageFunctionProps.property.currentVersionOptions">currentVersionOptions</a></code> | <code>aws-cdk-lib.aws_lambda.VersionOptions</code> | Options for the `lambda.Version` resource automatically created by the `fn.currentVersion` method. |
| <code><a href="#cdk-nextjs.OptionalDockerImageFunctionProps.property.deadLetterQueue">deadLetterQueue</a></code> | <code>aws-cdk-lib.aws_sqs.IQueue</code> | The SQS queue to use if DLQ is enabled. |
| <code><a href="#cdk-nextjs.OptionalDockerImageFunctionProps.property.deadLetterQueueEnabled">deadLetterQueueEnabled</a></code> | <code>boolean</code> | Enabled DLQ. |
| <code><a href="#cdk-nextjs.OptionalDockerImageFunctionProps.property.deadLetterTopic">deadLetterTopic</a></code> | <code>aws-cdk-lib.aws_sns.ITopic</code> | The SNS topic to use as a DLQ. |
| <code><a href="#cdk-nextjs.OptionalDockerImageFunctionProps.property.description">description</a></code> | <code>string</code> | A description of the function. |
| <code><a href="#cdk-nextjs.OptionalDockerImageFunctionProps.property.environment">environment</a></code> | <code>{[ key: string ]: string}</code> | Key-value pairs that Lambda caches and makes available for your Lambda functions. |
| <code><a href="#cdk-nextjs.OptionalDockerImageFunctionProps.property.environmentEncryption">environmentEncryption</a></code> | <code>aws-cdk-lib.aws_kms.IKey</code> | The AWS KMS key that's used to encrypt your function's environment variables. |
| <code><a href="#cdk-nextjs.OptionalDockerImageFunctionProps.property.ephemeralStorageSize">ephemeralStorageSize</a></code> | <code>aws-cdk-lib.Size</code> | The size of the function’s /tmp directory in MiB. |
| <code><a href="#cdk-nextjs.OptionalDockerImageFunctionProps.property.events">events</a></code> | <code>aws-cdk-lib.aws_lambda.IEventSource[]</code> | Event sources for this function. |
| <code><a href="#cdk-nextjs.OptionalDockerImageFunctionProps.property.filesystem">filesystem</a></code> | <code>aws-cdk-lib.aws_lambda.FileSystem</code> | The filesystem configuration for the lambda function. |
| <code><a href="#cdk-nextjs.OptionalDockerImageFunctionProps.property.functionName">functionName</a></code> | <code>string</code> | A name for the function. |
| <code><a href="#cdk-nextjs.OptionalDockerImageFunctionProps.property.initialPolicy">initialPolicy</a></code> | <code>aws-cdk-lib.aws_iam.PolicyStatement[]</code> | Initial policy statements to add to the created Lambda Role. |
| <code><a href="#cdk-nextjs.OptionalDockerImageFunctionProps.property.insightsVersion">insightsVersion</a></code> | <code>aws-cdk-lib.aws_lambda.LambdaInsightsVersion</code> | Specify the version of CloudWatch Lambda insights to use for monitoring. |
| <code><a href="#cdk-nextjs.OptionalDockerImageFunctionProps.property.ipv6AllowedForDualStack">ipv6AllowedForDualStack</a></code> | <code>boolean</code> | Allows outbound IPv6 traffic on VPC functions that are connected to dual-stack subnets. |
| <code><a href="#cdk-nextjs.OptionalDockerImageFunctionProps.property.layers">layers</a></code> | <code>aws-cdk-lib.aws_lambda.ILayerVersion[]</code> | A list of layers to add to the function's execution environment. |
| <code><a href="#cdk-nextjs.OptionalDockerImageFunctionProps.property.logFormat">logFormat</a></code> | <code>string</code> | Sets the logFormat for the function. |
| <code><a href="#cdk-nextjs.OptionalDockerImageFunctionProps.property.loggingFormat">loggingFormat</a></code> | <code>aws-cdk-lib.aws_lambda.LoggingFormat</code> | Sets the loggingFormat for the function. |
| <code><a href="#cdk-nextjs.OptionalDockerImageFunctionProps.property.logGroup">logGroup</a></code> | <code>aws-cdk-lib.aws_logs.ILogGroup</code> | The log group the function sends logs to. |
| <code><a href="#cdk-nextjs.OptionalDockerImageFunctionProps.property.logRetention">logRetention</a></code> | <code>aws-cdk-lib.aws_logs.RetentionDays</code> | The number of days log events are kept in CloudWatch Logs. |
| <code><a href="#cdk-nextjs.OptionalDockerImageFunctionProps.property.logRetentionRetryOptions">logRetentionRetryOptions</a></code> | <code>aws-cdk-lib.aws_lambda.LogRetentionRetryOptions</code> | When log retention is specified, a custom resource attempts to create the CloudWatch log group. |
| <code><a href="#cdk-nextjs.OptionalDockerImageFunctionProps.property.logRetentionRole">logRetentionRole</a></code> | <code>aws-cdk-lib.aws_iam.IRole</code> | The IAM role for the Lambda function associated with the custom resource that sets the retention policy. |
| <code><a href="#cdk-nextjs.OptionalDockerImageFunctionProps.property.maxEventAge">maxEventAge</a></code> | <code>aws-cdk-lib.Duration</code> | The maximum age of a request that Lambda sends to a function for processing. |
| <code><a href="#cdk-nextjs.OptionalDockerImageFunctionProps.property.memorySize">memorySize</a></code> | <code>number</code> | The amount of memory, in MB, that is allocated to your Lambda function. |
| <code><a href="#cdk-nextjs.OptionalDockerImageFunctionProps.property.onFailure">onFailure</a></code> | <code>aws-cdk-lib.aws_lambda.IDestination</code> | The destination for failed invocations. |
| <code><a href="#cdk-nextjs.OptionalDockerImageFunctionProps.property.onSuccess">onSuccess</a></code> | <code>aws-cdk-lib.aws_lambda.IDestination</code> | The destination for successful invocations. |
| <code><a href="#cdk-nextjs.OptionalDockerImageFunctionProps.property.paramsAndSecrets">paramsAndSecrets</a></code> | <code>aws-cdk-lib.aws_lambda.ParamsAndSecretsLayerVersion</code> | Specify the configuration of Parameters and Secrets Extension. |
| <code><a href="#cdk-nextjs.OptionalDockerImageFunctionProps.property.profiling">profiling</a></code> | <code>boolean</code> | Enable profiling. |
| <code><a href="#cdk-nextjs.OptionalDockerImageFunctionProps.property.profilingGroup">profilingGroup</a></code> | <code>aws-cdk-lib.aws_codeguruprofiler.IProfilingGroup</code> | Profiling Group. |
| <code><a href="#cdk-nextjs.OptionalDockerImageFunctionProps.property.reservedConcurrentExecutions">reservedConcurrentExecutions</a></code> | <code>number</code> | The maximum of concurrent executions you want to reserve for the function. |
| <code><a href="#cdk-nextjs.OptionalDockerImageFunctionProps.property.retryAttempts">retryAttempts</a></code> | <code>number</code> | The maximum number of times to retry when the function returns an error. |
| <code><a href="#cdk-nextjs.OptionalDockerImageFunctionProps.property.role">role</a></code> | <code>aws-cdk-lib.aws_iam.IRole</code> | Lambda execution role. |
| <code><a href="#cdk-nextjs.OptionalDockerImageFunctionProps.property.runtimeManagementMode">runtimeManagementMode</a></code> | <code>aws-cdk-lib.aws_lambda.RuntimeManagementMode</code> | Sets the runtime management configuration for a function's version. |
| <code><a href="#cdk-nextjs.OptionalDockerImageFunctionProps.property.securityGroups">securityGroups</a></code> | <code>aws-cdk-lib.aws_ec2.ISecurityGroup[]</code> | The list of security groups to associate with the Lambda's network interfaces. |
| <code><a href="#cdk-nextjs.OptionalDockerImageFunctionProps.property.snapStart">snapStart</a></code> | <code>aws-cdk-lib.aws_lambda.SnapStartConf</code> | Enable SnapStart for Lambda Function. |
| <code><a href="#cdk-nextjs.OptionalDockerImageFunctionProps.property.systemLogLevel">systemLogLevel</a></code> | <code>string</code> | Sets the system log level for the function. |
| <code><a href="#cdk-nextjs.OptionalDockerImageFunctionProps.property.systemLogLevelV2">systemLogLevelV2</a></code> | <code>aws-cdk-lib.aws_lambda.SystemLogLevel</code> | Sets the system log level for the function. |
| <code><a href="#cdk-nextjs.OptionalDockerImageFunctionProps.property.timeout">timeout</a></code> | <code>aws-cdk-lib.Duration</code> | The function execution time (in seconds) after which Lambda terminates the function. |
| <code><a href="#cdk-nextjs.OptionalDockerImageFunctionProps.property.tracing">tracing</a></code> | <code>aws-cdk-lib.aws_lambda.Tracing</code> | Enable AWS X-Ray Tracing for Lambda Function. |
| <code><a href="#cdk-nextjs.OptionalDockerImageFunctionProps.property.vpc">vpc</a></code> | <code>aws-cdk-lib.aws_ec2.IVpc</code> | VPC network to place Lambda network interfaces. |
| <code><a href="#cdk-nextjs.OptionalDockerImageFunctionProps.property.vpcSubnets">vpcSubnets</a></code> | <code>aws-cdk-lib.aws_ec2.SubnetSelection</code> | Where to place the network interfaces within the VPC. |

---

##### `adotInstrumentation`<sup>Optional</sup> <a name="adotInstrumentation" id="cdk-nextjs.OptionalDockerImageFunctionProps.property.adotInstrumentation"></a>

```typescript
public readonly adotInstrumentation: AdotInstrumentationConfig;
```

- *Type:* aws-cdk-lib.aws_lambda.AdotInstrumentationConfig
- *Default:* No ADOT instrumentation

Specify the configuration of AWS Distro for OpenTelemetry (ADOT) instrumentation.

---

##### `allowAllOutbound`<sup>Optional</sup> <a name="allowAllOutbound" id="cdk-nextjs.OptionalDockerImageFunctionProps.property.allowAllOutbound"></a>

```typescript
public readonly allowAllOutbound: boolean;
```

- *Type:* boolean
- *Default:* true

Whether to allow the Lambda to send all network traffic.

If set to false, you must individually add traffic rules to allow the
Lambda to connect to network targets.

Do not specify this property if the `securityGroups` or `securityGroup` property is set.
Instead, configure `allowAllOutbound` directly on the security group.

---

##### `allowPublicSubnet`<sup>Optional</sup> <a name="allowPublicSubnet" id="cdk-nextjs.OptionalDockerImageFunctionProps.property.allowPublicSubnet"></a>

```typescript
public readonly allowPublicSubnet: boolean;
```

- *Type:* boolean
- *Default:* false

Lambda Functions in a public subnet can NOT access the internet.

Use this property to acknowledge this limitation and still place the function in a public subnet.

---

##### ~~`applicationLogLevel`~~<sup>Optional</sup> <a name="applicationLogLevel" id="cdk-nextjs.OptionalDockerImageFunctionProps.property.applicationLogLevel"></a>

- *Deprecated:* Use `applicationLogLevelV2` as a property instead.

```typescript
public readonly applicationLogLevel: string;
```

- *Type:* string
- *Default:* "INFO"

Sets the application log level for the function.

---

##### `applicationLogLevelV2`<sup>Optional</sup> <a name="applicationLogLevelV2" id="cdk-nextjs.OptionalDockerImageFunctionProps.property.applicationLogLevelV2"></a>

```typescript
public readonly applicationLogLevelV2: ApplicationLogLevel;
```

- *Type:* aws-cdk-lib.aws_lambda.ApplicationLogLevel
- *Default:* ApplicationLogLevel.INFO

Sets the application log level for the function.

---

##### `architecture`<sup>Optional</sup> <a name="architecture" id="cdk-nextjs.OptionalDockerImageFunctionProps.property.architecture"></a>

```typescript
public readonly architecture: Architecture;
```

- *Type:* aws-cdk-lib.aws_lambda.Architecture
- *Default:* Architecture.X86_64

The system architectures compatible with this lambda function.

---

##### `code`<sup>Optional</sup> <a name="code" id="cdk-nextjs.OptionalDockerImageFunctionProps.property.code"></a>

```typescript
public readonly code: DockerImageCode;
```

- *Type:* aws-cdk-lib.aws_lambda.DockerImageCode

The source code of your Lambda function.

You can point to a file in an
Amazon Simple Storage Service (Amazon S3) bucket or specify your source
code as inline text.

---

##### `codeSigningConfig`<sup>Optional</sup> <a name="codeSigningConfig" id="cdk-nextjs.OptionalDockerImageFunctionProps.property.codeSigningConfig"></a>

```typescript
public readonly codeSigningConfig: ICodeSigningConfig;
```

- *Type:* aws-cdk-lib.aws_lambda.ICodeSigningConfig
- *Default:* Not Sign the Code

Code signing config associated with this function.

---

##### `currentVersionOptions`<sup>Optional</sup> <a name="currentVersionOptions" id="cdk-nextjs.OptionalDockerImageFunctionProps.property.currentVersionOptions"></a>

```typescript
public readonly currentVersionOptions: VersionOptions;
```

- *Type:* aws-cdk-lib.aws_lambda.VersionOptions
- *Default:* default options as described in `VersionOptions`

Options for the `lambda.Version` resource automatically created by the `fn.currentVersion` method.

---

##### `deadLetterQueue`<sup>Optional</sup> <a name="deadLetterQueue" id="cdk-nextjs.OptionalDockerImageFunctionProps.property.deadLetterQueue"></a>

```typescript
public readonly deadLetterQueue: IQueue;
```

- *Type:* aws-cdk-lib.aws_sqs.IQueue
- *Default:* SQS queue with 14 day retention period if `deadLetterQueueEnabled` is `true`

The SQS queue to use if DLQ is enabled.

If SNS topic is desired, specify `deadLetterTopic` property instead.

---

##### `deadLetterQueueEnabled`<sup>Optional</sup> <a name="deadLetterQueueEnabled" id="cdk-nextjs.OptionalDockerImageFunctionProps.property.deadLetterQueueEnabled"></a>

```typescript
public readonly deadLetterQueueEnabled: boolean;
```

- *Type:* boolean
- *Default:* false unless `deadLetterQueue` is set, which implies DLQ is enabled.

Enabled DLQ.

If `deadLetterQueue` is undefined,
an SQS queue with default options will be defined for your Function.

---

##### `deadLetterTopic`<sup>Optional</sup> <a name="deadLetterTopic" id="cdk-nextjs.OptionalDockerImageFunctionProps.property.deadLetterTopic"></a>

```typescript
public readonly deadLetterTopic: ITopic;
```

- *Type:* aws-cdk-lib.aws_sns.ITopic
- *Default:* no SNS topic

The SNS topic to use as a DLQ.

Note that if `deadLetterQueueEnabled` is set to `true`, an SQS queue will be created
rather than an SNS topic. Using an SNS topic as a DLQ requires this property to be set explicitly.

---

##### `description`<sup>Optional</sup> <a name="description" id="cdk-nextjs.OptionalDockerImageFunctionProps.property.description"></a>

```typescript
public readonly description: string;
```

- *Type:* string
- *Default:* No description.

A description of the function.

---

##### `environment`<sup>Optional</sup> <a name="environment" id="cdk-nextjs.OptionalDockerImageFunctionProps.property.environment"></a>

```typescript
public readonly environment: {[ key: string ]: string};
```

- *Type:* {[ key: string ]: string}
- *Default:* No environment variables.

Key-value pairs that Lambda caches and makes available for your Lambda functions.

Use environment variables to apply configuration changes, such
as test and production environment configurations, without changing your
Lambda function source code.

---

##### `environmentEncryption`<sup>Optional</sup> <a name="environmentEncryption" id="cdk-nextjs.OptionalDockerImageFunctionProps.property.environmentEncryption"></a>

```typescript
public readonly environmentEncryption: IKey;
```

- *Type:* aws-cdk-lib.aws_kms.IKey
- *Default:* AWS Lambda creates and uses an AWS managed customer master key (CMK).

The AWS KMS key that's used to encrypt your function's environment variables.

---

##### `ephemeralStorageSize`<sup>Optional</sup> <a name="ephemeralStorageSize" id="cdk-nextjs.OptionalDockerImageFunctionProps.property.ephemeralStorageSize"></a>

```typescript
public readonly ephemeralStorageSize: Size;
```

- *Type:* aws-cdk-lib.Size
- *Default:* 512 MiB

The size of the function’s /tmp directory in MiB.

---

##### `events`<sup>Optional</sup> <a name="events" id="cdk-nextjs.OptionalDockerImageFunctionProps.property.events"></a>

```typescript
public readonly events: IEventSource[];
```

- *Type:* aws-cdk-lib.aws_lambda.IEventSource[]
- *Default:* No event sources.

Event sources for this function.

You can also add event sources using `addEventSource`.

---

##### `filesystem`<sup>Optional</sup> <a name="filesystem" id="cdk-nextjs.OptionalDockerImageFunctionProps.property.filesystem"></a>

```typescript
public readonly filesystem: FileSystem;
```

- *Type:* aws-cdk-lib.aws_lambda.FileSystem
- *Default:* will not mount any filesystem

The filesystem configuration for the lambda function.

---

##### `functionName`<sup>Optional</sup> <a name="functionName" id="cdk-nextjs.OptionalDockerImageFunctionProps.property.functionName"></a>

```typescript
public readonly functionName: string;
```

- *Type:* string
- *Default:* AWS CloudFormation generates a unique physical ID and uses that ID for the function's name. For more information, see Name Type.

A name for the function.

---

##### `initialPolicy`<sup>Optional</sup> <a name="initialPolicy" id="cdk-nextjs.OptionalDockerImageFunctionProps.property.initialPolicy"></a>

```typescript
public readonly initialPolicy: PolicyStatement[];
```

- *Type:* aws-cdk-lib.aws_iam.PolicyStatement[]
- *Default:* No policy statements are added to the created Lambda role.

Initial policy statements to add to the created Lambda Role.

You can call `addToRolePolicy` to the created lambda to add statements post creation.

---

##### `insightsVersion`<sup>Optional</sup> <a name="insightsVersion" id="cdk-nextjs.OptionalDockerImageFunctionProps.property.insightsVersion"></a>

```typescript
public readonly insightsVersion: LambdaInsightsVersion;
```

- *Type:* aws-cdk-lib.aws_lambda.LambdaInsightsVersion
- *Default:* No Lambda Insights

Specify the version of CloudWatch Lambda insights to use for monitoring.

---

##### `ipv6AllowedForDualStack`<sup>Optional</sup> <a name="ipv6AllowedForDualStack" id="cdk-nextjs.OptionalDockerImageFunctionProps.property.ipv6AllowedForDualStack"></a>

```typescript
public readonly ipv6AllowedForDualStack: boolean;
```

- *Type:* boolean
- *Default:* false

Allows outbound IPv6 traffic on VPC functions that are connected to dual-stack subnets.

Only used if 'vpc' is supplied.

---

##### `layers`<sup>Optional</sup> <a name="layers" id="cdk-nextjs.OptionalDockerImageFunctionProps.property.layers"></a>

```typescript
public readonly layers: ILayerVersion[];
```

- *Type:* aws-cdk-lib.aws_lambda.ILayerVersion[]
- *Default:* No layers.

A list of layers to add to the function's execution environment.

You can configure your Lambda function to pull in
additional code during initialization in the form of layers. Layers are packages of libraries or other dependencies
that can be used by multiple functions.

---

##### ~~`logFormat`~~<sup>Optional</sup> <a name="logFormat" id="cdk-nextjs.OptionalDockerImageFunctionProps.property.logFormat"></a>

- *Deprecated:* Use `loggingFormat` as a property instead.

```typescript
public readonly logFormat: string;
```

- *Type:* string
- *Default:* "Text"

Sets the logFormat for the function.

---

##### `loggingFormat`<sup>Optional</sup> <a name="loggingFormat" id="cdk-nextjs.OptionalDockerImageFunctionProps.property.loggingFormat"></a>

```typescript
public readonly loggingFormat: LoggingFormat;
```

- *Type:* aws-cdk-lib.aws_lambda.LoggingFormat
- *Default:* LoggingFormat.TEXT

Sets the loggingFormat for the function.

---

##### `logGroup`<sup>Optional</sup> <a name="logGroup" id="cdk-nextjs.OptionalDockerImageFunctionProps.property.logGroup"></a>

```typescript
public readonly logGroup: ILogGroup;
```

- *Type:* aws-cdk-lib.aws_logs.ILogGroup
- *Default:* `/aws/lambda/${this.functionName}` - default log group created by Lambda

The log group the function sends logs to.

By default, Lambda functions send logs to an automatically created default log group named /aws/lambda/\<function name\>.
However you cannot change the properties of this auto-created log group using the AWS CDK, e.g. you cannot set a different log retention.

Use the `logGroup` property to create a fully customizable LogGroup ahead of time, and instruct the Lambda function to send logs to it.

Providing a user-controlled log group was rolled out to commercial regions on 2023-11-16.
If you are deploying to another type of region, please check regional availability first.

---

##### `logRetention`<sup>Optional</sup> <a name="logRetention" id="cdk-nextjs.OptionalDockerImageFunctionProps.property.logRetention"></a>

```typescript
public readonly logRetention: RetentionDays;
```

- *Type:* aws-cdk-lib.aws_logs.RetentionDays
- *Default:* logs.RetentionDays.INFINITE

The number of days log events are kept in CloudWatch Logs.

When updating
this property, unsetting it doesn't remove the log retention policy. To
remove the retention policy, set the value to `INFINITE`.

This is a legacy API and we strongly recommend you move away from it if you can.
Instead create a fully customizable log group with `logs.LogGroup` and use the `logGroup` property
to instruct the Lambda function to send logs to it.
Migrating from `logRetention` to `logGroup` will cause the name of the log group to change.
Users and code and referencing the name verbatim will have to adjust.

In AWS CDK code, you can access the log group name directly from the LogGroup construct:
```ts
import * as logs from 'aws-cdk-lib/aws-logs';

declare const myLogGroup: logs.LogGroup;
myLogGroup.logGroupName;
```

---

##### `logRetentionRetryOptions`<sup>Optional</sup> <a name="logRetentionRetryOptions" id="cdk-nextjs.OptionalDockerImageFunctionProps.property.logRetentionRetryOptions"></a>

```typescript
public readonly logRetentionRetryOptions: LogRetentionRetryOptions;
```

- *Type:* aws-cdk-lib.aws_lambda.LogRetentionRetryOptions
- *Default:* Default AWS SDK retry options.

When log retention is specified, a custom resource attempts to create the CloudWatch log group.

These options control the retry policy when interacting with CloudWatch APIs.

This is a legacy API and we strongly recommend you migrate to `logGroup` if you can.
`logGroup` allows you to create a fully customizable log group and instruct the Lambda function to send logs to it.

---

##### `logRetentionRole`<sup>Optional</sup> <a name="logRetentionRole" id="cdk-nextjs.OptionalDockerImageFunctionProps.property.logRetentionRole"></a>

```typescript
public readonly logRetentionRole: IRole;
```

- *Type:* aws-cdk-lib.aws_iam.IRole
- *Default:* A new role is created.

The IAM role for the Lambda function associated with the custom resource that sets the retention policy.

This is a legacy API and we strongly recommend you migrate to `logGroup` if you can.
`logGroup` allows you to create a fully customizable log group and instruct the Lambda function to send logs to it.

---

##### `maxEventAge`<sup>Optional</sup> <a name="maxEventAge" id="cdk-nextjs.OptionalDockerImageFunctionProps.property.maxEventAge"></a>

```typescript
public readonly maxEventAge: Duration;
```

- *Type:* aws-cdk-lib.Duration
- *Default:* Duration.hours(6)

The maximum age of a request that Lambda sends to a function for processing.

Minimum: 60 seconds
Maximum: 6 hours

---

##### `memorySize`<sup>Optional</sup> <a name="memorySize" id="cdk-nextjs.OptionalDockerImageFunctionProps.property.memorySize"></a>

```typescript
public readonly memorySize: number;
```

- *Type:* number
- *Default:* 128

The amount of memory, in MB, that is allocated to your Lambda function.

Lambda uses this value to proportionally allocate the amount of CPU
power. For more information, see Resource Model in the AWS Lambda
Developer Guide.

---

##### `onFailure`<sup>Optional</sup> <a name="onFailure" id="cdk-nextjs.OptionalDockerImageFunctionProps.property.onFailure"></a>

```typescript
public readonly onFailure: IDestination;
```

- *Type:* aws-cdk-lib.aws_lambda.IDestination
- *Default:* no destination

The destination for failed invocations.

---

##### `onSuccess`<sup>Optional</sup> <a name="onSuccess" id="cdk-nextjs.OptionalDockerImageFunctionProps.property.onSuccess"></a>

```typescript
public readonly onSuccess: IDestination;
```

- *Type:* aws-cdk-lib.aws_lambda.IDestination
- *Default:* no destination

The destination for successful invocations.

---

##### `paramsAndSecrets`<sup>Optional</sup> <a name="paramsAndSecrets" id="cdk-nextjs.OptionalDockerImageFunctionProps.property.paramsAndSecrets"></a>

```typescript
public readonly paramsAndSecrets: ParamsAndSecretsLayerVersion;
```

- *Type:* aws-cdk-lib.aws_lambda.ParamsAndSecretsLayerVersion
- *Default:* No Parameters and Secrets Extension

Specify the configuration of Parameters and Secrets Extension.

---

##### `profiling`<sup>Optional</sup> <a name="profiling" id="cdk-nextjs.OptionalDockerImageFunctionProps.property.profiling"></a>

```typescript
public readonly profiling: boolean;
```

- *Type:* boolean
- *Default:* No profiling.

Enable profiling.

---

##### `profilingGroup`<sup>Optional</sup> <a name="profilingGroup" id="cdk-nextjs.OptionalDockerImageFunctionProps.property.profilingGroup"></a>

```typescript
public readonly profilingGroup: IProfilingGroup;
```

- *Type:* aws-cdk-lib.aws_codeguruprofiler.IProfilingGroup
- *Default:* A new profiling group will be created if `profiling` is set.

Profiling Group.

---

##### `reservedConcurrentExecutions`<sup>Optional</sup> <a name="reservedConcurrentExecutions" id="cdk-nextjs.OptionalDockerImageFunctionProps.property.reservedConcurrentExecutions"></a>

```typescript
public readonly reservedConcurrentExecutions: number;
```

- *Type:* number
- *Default:* No specific limit - account limit.

The maximum of concurrent executions you want to reserve for the function.

---

##### `retryAttempts`<sup>Optional</sup> <a name="retryAttempts" id="cdk-nextjs.OptionalDockerImageFunctionProps.property.retryAttempts"></a>

```typescript
public readonly retryAttempts: number;
```

- *Type:* number
- *Default:* 2

The maximum number of times to retry when the function returns an error.

Minimum: 0
Maximum: 2

---

##### `role`<sup>Optional</sup> <a name="role" id="cdk-nextjs.OptionalDockerImageFunctionProps.property.role"></a>

```typescript
public readonly role: IRole;
```

- *Type:* aws-cdk-lib.aws_iam.IRole
- *Default:* A unique role will be generated for this lambda function. Both supplied and generated roles can always be changed by calling `addToRolePolicy`.

Lambda execution role.

This is the role that will be assumed by the function upon execution.
It controls the permissions that the function will have. The Role must
be assumable by the 'lambda.amazonaws.com' service principal.

The default Role automatically has permissions granted for Lambda execution. If you
provide a Role, you must add the relevant AWS managed policies yourself.

The relevant managed policies are "service-role/AWSLambdaBasicExecutionRole" and
"service-role/AWSLambdaVPCAccessExecutionRole".

---

##### `runtimeManagementMode`<sup>Optional</sup> <a name="runtimeManagementMode" id="cdk-nextjs.OptionalDockerImageFunctionProps.property.runtimeManagementMode"></a>

```typescript
public readonly runtimeManagementMode: RuntimeManagementMode;
```

- *Type:* aws-cdk-lib.aws_lambda.RuntimeManagementMode
- *Default:* Auto

Sets the runtime management configuration for a function's version.

---

##### `securityGroups`<sup>Optional</sup> <a name="securityGroups" id="cdk-nextjs.OptionalDockerImageFunctionProps.property.securityGroups"></a>

```typescript
public readonly securityGroups: ISecurityGroup[];
```

- *Type:* aws-cdk-lib.aws_ec2.ISecurityGroup[]
- *Default:* If the function is placed within a VPC and a security group is not specified, either by this or securityGroup prop, a dedicated security group will be created for this function.

The list of security groups to associate with the Lambda's network interfaces.

Only used if 'vpc' is supplied.

---

##### `snapStart`<sup>Optional</sup> <a name="snapStart" id="cdk-nextjs.OptionalDockerImageFunctionProps.property.snapStart"></a>

```typescript
public readonly snapStart: SnapStartConf;
```

- *Type:* aws-cdk-lib.aws_lambda.SnapStartConf
- *Default:* No snapstart

Enable SnapStart for Lambda Function.

SnapStart is currently supported only for Java 11, 17 runtime

---

##### ~~`systemLogLevel`~~<sup>Optional</sup> <a name="systemLogLevel" id="cdk-nextjs.OptionalDockerImageFunctionProps.property.systemLogLevel"></a>

- *Deprecated:* Use `systemLogLevelV2` as a property instead.

```typescript
public readonly systemLogLevel: string;
```

- *Type:* string
- *Default:* "INFO"

Sets the system log level for the function.

---

##### `systemLogLevelV2`<sup>Optional</sup> <a name="systemLogLevelV2" id="cdk-nextjs.OptionalDockerImageFunctionProps.property.systemLogLevelV2"></a>

```typescript
public readonly systemLogLevelV2: SystemLogLevel;
```

- *Type:* aws-cdk-lib.aws_lambda.SystemLogLevel
- *Default:* SystemLogLevel.INFO

Sets the system log level for the function.

---

##### `timeout`<sup>Optional</sup> <a name="timeout" id="cdk-nextjs.OptionalDockerImageFunctionProps.property.timeout"></a>

```typescript
public readonly timeout: Duration;
```

- *Type:* aws-cdk-lib.Duration
- *Default:* Duration.seconds(3)

The function execution time (in seconds) after which Lambda terminates the function.

Because the execution time affects cost, set this value
based on the function's expected execution time.

---

##### `tracing`<sup>Optional</sup> <a name="tracing" id="cdk-nextjs.OptionalDockerImageFunctionProps.property.tracing"></a>

```typescript
public readonly tracing: Tracing;
```

- *Type:* aws-cdk-lib.aws_lambda.Tracing
- *Default:* Tracing.Disabled

Enable AWS X-Ray Tracing for Lambda Function.

---

##### `vpc`<sup>Optional</sup> <a name="vpc" id="cdk-nextjs.OptionalDockerImageFunctionProps.property.vpc"></a>

```typescript
public readonly vpc: IVpc;
```

- *Type:* aws-cdk-lib.aws_ec2.IVpc
- *Default:* Function is not placed within a VPC.

VPC network to place Lambda network interfaces.

Specify this if the Lambda function needs to access resources in a VPC.
This is required when `vpcSubnets` is specified.

---

##### `vpcSubnets`<sup>Optional</sup> <a name="vpcSubnets" id="cdk-nextjs.OptionalDockerImageFunctionProps.property.vpcSubnets"></a>

```typescript
public readonly vpcSubnets: SubnetSelection;
```

- *Type:* aws-cdk-lib.aws_ec2.SubnetSelection
- *Default:* the Vpc default strategy if not specified

Where to place the network interfaces within the VPC.

This requires `vpc` to be specified in order for interfaces to actually be
placed in the subnets. If `vpc` is not specify, this will raise an error.

Note: Internet access for Lambda Functions requires a NAT Gateway, so picking
public subnets is not allowed (unless `allowPublicSubnet` is set to `true`).

---

### OptionalEdgeFunctionProps <a name="OptionalEdgeFunctionProps" id="cdk-nextjs.OptionalEdgeFunctionProps"></a>

OptionalEdgeFunctionProps.

#### Initializer <a name="Initializer" id="cdk-nextjs.OptionalEdgeFunctionProps.Initializer"></a>

```typescript
import { OptionalEdgeFunctionProps } from 'cdk-nextjs'

const optionalEdgeFunctionProps: OptionalEdgeFunctionProps = { ... }
```

#### Properties <a name="Properties" id="Properties"></a>

| **Name** | **Type** | **Description** |
| --- | --- | --- |
| <code><a href="#cdk-nextjs.OptionalEdgeFunctionProps.property.adotInstrumentation">adotInstrumentation</a></code> | <code>aws-cdk-lib.aws_lambda.AdotInstrumentationConfig</code> | Specify the configuration of AWS Distro for OpenTelemetry (ADOT) instrumentation. |
| <code><a href="#cdk-nextjs.OptionalEdgeFunctionProps.property.allowAllOutbound">allowAllOutbound</a></code> | <code>boolean</code> | Whether to allow the Lambda to send all network traffic. |
| <code><a href="#cdk-nextjs.OptionalEdgeFunctionProps.property.allowPublicSubnet">allowPublicSubnet</a></code> | <code>boolean</code> | Lambda Functions in a public subnet can NOT access the internet. |
| <code><a href="#cdk-nextjs.OptionalEdgeFunctionProps.property.applicationLogLevel">applicationLogLevel</a></code> | <code>string</code> | Sets the application log level for the function. |
| <code><a href="#cdk-nextjs.OptionalEdgeFunctionProps.property.applicationLogLevelV2">applicationLogLevelV2</a></code> | <code>aws-cdk-lib.aws_lambda.ApplicationLogLevel</code> | Sets the application log level for the function. |
| <code><a href="#cdk-nextjs.OptionalEdgeFunctionProps.property.architecture">architecture</a></code> | <code>aws-cdk-lib.aws_lambda.Architecture</code> | The system architectures compatible with this lambda function. |
| <code><a href="#cdk-nextjs.OptionalEdgeFunctionProps.property.code">code</a></code> | <code>aws-cdk-lib.aws_lambda.Code</code> | The source code of your Lambda function. |
| <code><a href="#cdk-nextjs.OptionalEdgeFunctionProps.property.codeSigningConfig">codeSigningConfig</a></code> | <code>aws-cdk-lib.aws_lambda.ICodeSigningConfig</code> | Code signing config associated with this function. |
| <code><a href="#cdk-nextjs.OptionalEdgeFunctionProps.property.currentVersionOptions">currentVersionOptions</a></code> | <code>aws-cdk-lib.aws_lambda.VersionOptions</code> | Options for the `lambda.Version` resource automatically created by the `fn.currentVersion` method. |
| <code><a href="#cdk-nextjs.OptionalEdgeFunctionProps.property.deadLetterQueue">deadLetterQueue</a></code> | <code>aws-cdk-lib.aws_sqs.IQueue</code> | The SQS queue to use if DLQ is enabled. |
| <code><a href="#cdk-nextjs.OptionalEdgeFunctionProps.property.deadLetterQueueEnabled">deadLetterQueueEnabled</a></code> | <code>boolean</code> | Enabled DLQ. |
| <code><a href="#cdk-nextjs.OptionalEdgeFunctionProps.property.deadLetterTopic">deadLetterTopic</a></code> | <code>aws-cdk-lib.aws_sns.ITopic</code> | The SNS topic to use as a DLQ. |
| <code><a href="#cdk-nextjs.OptionalEdgeFunctionProps.property.description">description</a></code> | <code>string</code> | A description of the function. |
| <code><a href="#cdk-nextjs.OptionalEdgeFunctionProps.property.environment">environment</a></code> | <code>{[ key: string ]: string}</code> | Key-value pairs that Lambda caches and makes available for your Lambda functions. |
| <code><a href="#cdk-nextjs.OptionalEdgeFunctionProps.property.environmentEncryption">environmentEncryption</a></code> | <code>aws-cdk-lib.aws_kms.IKey</code> | The AWS KMS key that's used to encrypt your function's environment variables. |
| <code><a href="#cdk-nextjs.OptionalEdgeFunctionProps.property.ephemeralStorageSize">ephemeralStorageSize</a></code> | <code>aws-cdk-lib.Size</code> | The size of the function’s /tmp directory in MiB. |
| <code><a href="#cdk-nextjs.OptionalEdgeFunctionProps.property.events">events</a></code> | <code>aws-cdk-lib.aws_lambda.IEventSource[]</code> | Event sources for this function. |
| <code><a href="#cdk-nextjs.OptionalEdgeFunctionProps.property.filesystem">filesystem</a></code> | <code>aws-cdk-lib.aws_lambda.FileSystem</code> | The filesystem configuration for the lambda function. |
| <code><a href="#cdk-nextjs.OptionalEdgeFunctionProps.property.functionName">functionName</a></code> | <code>string</code> | A name for the function. |
| <code><a href="#cdk-nextjs.OptionalEdgeFunctionProps.property.handler">handler</a></code> | <code>string</code> | The name of the method within your code that Lambda calls to execute your function. |
| <code><a href="#cdk-nextjs.OptionalEdgeFunctionProps.property.initialPolicy">initialPolicy</a></code> | <code>aws-cdk-lib.aws_iam.PolicyStatement[]</code> | Initial policy statements to add to the created Lambda Role. |
| <code><a href="#cdk-nextjs.OptionalEdgeFunctionProps.property.insightsVersion">insightsVersion</a></code> | <code>aws-cdk-lib.aws_lambda.LambdaInsightsVersion</code> | Specify the version of CloudWatch Lambda insights to use for monitoring. |
| <code><a href="#cdk-nextjs.OptionalEdgeFunctionProps.property.ipv6AllowedForDualStack">ipv6AllowedForDualStack</a></code> | <code>boolean</code> | Allows outbound IPv6 traffic on VPC functions that are connected to dual-stack subnets. |
| <code><a href="#cdk-nextjs.OptionalEdgeFunctionProps.property.layers">layers</a></code> | <code>aws-cdk-lib.aws_lambda.ILayerVersion[]</code> | A list of layers to add to the function's execution environment. |
| <code><a href="#cdk-nextjs.OptionalEdgeFunctionProps.property.logFormat">logFormat</a></code> | <code>string</code> | Sets the logFormat for the function. |
| <code><a href="#cdk-nextjs.OptionalEdgeFunctionProps.property.loggingFormat">loggingFormat</a></code> | <code>aws-cdk-lib.aws_lambda.LoggingFormat</code> | Sets the loggingFormat for the function. |
| <code><a href="#cdk-nextjs.OptionalEdgeFunctionProps.property.logGroup">logGroup</a></code> | <code>aws-cdk-lib.aws_logs.ILogGroup</code> | The log group the function sends logs to. |
| <code><a href="#cdk-nextjs.OptionalEdgeFunctionProps.property.logRetention">logRetention</a></code> | <code>aws-cdk-lib.aws_logs.RetentionDays</code> | The number of days log events are kept in CloudWatch Logs. |
| <code><a href="#cdk-nextjs.OptionalEdgeFunctionProps.property.logRetentionRetryOptions">logRetentionRetryOptions</a></code> | <code>aws-cdk-lib.aws_lambda.LogRetentionRetryOptions</code> | When log retention is specified, a custom resource attempts to create the CloudWatch log group. |
| <code><a href="#cdk-nextjs.OptionalEdgeFunctionProps.property.logRetentionRole">logRetentionRole</a></code> | <code>aws-cdk-lib.aws_iam.IRole</code> | The IAM role for the Lambda function associated with the custom resource that sets the retention policy. |
| <code><a href="#cdk-nextjs.OptionalEdgeFunctionProps.property.maxEventAge">maxEventAge</a></code> | <code>aws-cdk-lib.Duration</code> | The maximum age of a request that Lambda sends to a function for processing. |
| <code><a href="#cdk-nextjs.OptionalEdgeFunctionProps.property.memorySize">memorySize</a></code> | <code>number</code> | The amount of memory, in MB, that is allocated to your Lambda function. |
| <code><a href="#cdk-nextjs.OptionalEdgeFunctionProps.property.onFailure">onFailure</a></code> | <code>aws-cdk-lib.aws_lambda.IDestination</code> | The destination for failed invocations. |
| <code><a href="#cdk-nextjs.OptionalEdgeFunctionProps.property.onSuccess">onSuccess</a></code> | <code>aws-cdk-lib.aws_lambda.IDestination</code> | The destination for successful invocations. |
| <code><a href="#cdk-nextjs.OptionalEdgeFunctionProps.property.paramsAndSecrets">paramsAndSecrets</a></code> | <code>aws-cdk-lib.aws_lambda.ParamsAndSecretsLayerVersion</code> | Specify the configuration of Parameters and Secrets Extension. |
| <code><a href="#cdk-nextjs.OptionalEdgeFunctionProps.property.profiling">profiling</a></code> | <code>boolean</code> | Enable profiling. |
| <code><a href="#cdk-nextjs.OptionalEdgeFunctionProps.property.profilingGroup">profilingGroup</a></code> | <code>aws-cdk-lib.aws_codeguruprofiler.IProfilingGroup</code> | Profiling Group. |
| <code><a href="#cdk-nextjs.OptionalEdgeFunctionProps.property.reservedConcurrentExecutions">reservedConcurrentExecutions</a></code> | <code>number</code> | The maximum of concurrent executions you want to reserve for the function. |
| <code><a href="#cdk-nextjs.OptionalEdgeFunctionProps.property.retryAttempts">retryAttempts</a></code> | <code>number</code> | The maximum number of times to retry when the function returns an error. |
| <code><a href="#cdk-nextjs.OptionalEdgeFunctionProps.property.role">role</a></code> | <code>aws-cdk-lib.aws_iam.IRole</code> | Lambda execution role. |
| <code><a href="#cdk-nextjs.OptionalEdgeFunctionProps.property.runtime">runtime</a></code> | <code>aws-cdk-lib.aws_lambda.Runtime</code> | The runtime environment for the Lambda function that you are uploading. |
| <code><a href="#cdk-nextjs.OptionalEdgeFunctionProps.property.runtimeManagementMode">runtimeManagementMode</a></code> | <code>aws-cdk-lib.aws_lambda.RuntimeManagementMode</code> | Sets the runtime management configuration for a function's version. |
| <code><a href="#cdk-nextjs.OptionalEdgeFunctionProps.property.securityGroups">securityGroups</a></code> | <code>aws-cdk-lib.aws_ec2.ISecurityGroup[]</code> | The list of security groups to associate with the Lambda's network interfaces. |
| <code><a href="#cdk-nextjs.OptionalEdgeFunctionProps.property.snapStart">snapStart</a></code> | <code>aws-cdk-lib.aws_lambda.SnapStartConf</code> | Enable SnapStart for Lambda Function. |
| <code><a href="#cdk-nextjs.OptionalEdgeFunctionProps.property.stackId">stackId</a></code> | <code>string</code> | The stack ID of Lambda@Edge function. |
| <code><a href="#cdk-nextjs.OptionalEdgeFunctionProps.property.systemLogLevel">systemLogLevel</a></code> | <code>string</code> | Sets the system log level for the function. |
| <code><a href="#cdk-nextjs.OptionalEdgeFunctionProps.property.systemLogLevelV2">systemLogLevelV2</a></code> | <code>aws-cdk-lib.aws_lambda.SystemLogLevel</code> | Sets the system log level for the function. |
| <code><a href="#cdk-nextjs.OptionalEdgeFunctionProps.property.timeout">timeout</a></code> | <code>aws-cdk-lib.Duration</code> | The function execution time (in seconds) after which Lambda terminates the function. |
| <code><a href="#cdk-nextjs.OptionalEdgeFunctionProps.property.tracing">tracing</a></code> | <code>aws-cdk-lib.aws_lambda.Tracing</code> | Enable AWS X-Ray Tracing for Lambda Function. |
| <code><a href="#cdk-nextjs.OptionalEdgeFunctionProps.property.vpc">vpc</a></code> | <code>aws-cdk-lib.aws_ec2.IVpc</code> | VPC network to place Lambda network interfaces. |
| <code><a href="#cdk-nextjs.OptionalEdgeFunctionProps.property.vpcSubnets">vpcSubnets</a></code> | <code>aws-cdk-lib.aws_ec2.SubnetSelection</code> | Where to place the network interfaces within the VPC. |

---

##### `adotInstrumentation`<sup>Optional</sup> <a name="adotInstrumentation" id="cdk-nextjs.OptionalEdgeFunctionProps.property.adotInstrumentation"></a>

```typescript
public readonly adotInstrumentation: AdotInstrumentationConfig;
```

- *Type:* aws-cdk-lib.aws_lambda.AdotInstrumentationConfig
- *Default:* No ADOT instrumentation

Specify the configuration of AWS Distro for OpenTelemetry (ADOT) instrumentation.

---

##### `allowAllOutbound`<sup>Optional</sup> <a name="allowAllOutbound" id="cdk-nextjs.OptionalEdgeFunctionProps.property.allowAllOutbound"></a>

```typescript
public readonly allowAllOutbound: boolean;
```

- *Type:* boolean
- *Default:* true

Whether to allow the Lambda to send all network traffic.

If set to false, you must individually add traffic rules to allow the
Lambda to connect to network targets.

Do not specify this property if the `securityGroups` or `securityGroup` property is set.
Instead, configure `allowAllOutbound` directly on the security group.

---

##### `allowPublicSubnet`<sup>Optional</sup> <a name="allowPublicSubnet" id="cdk-nextjs.OptionalEdgeFunctionProps.property.allowPublicSubnet"></a>

```typescript
public readonly allowPublicSubnet: boolean;
```

- *Type:* boolean
- *Default:* false

Lambda Functions in a public subnet can NOT access the internet.

Use this property to acknowledge this limitation and still place the function in a public subnet.

---

##### ~~`applicationLogLevel`~~<sup>Optional</sup> <a name="applicationLogLevel" id="cdk-nextjs.OptionalEdgeFunctionProps.property.applicationLogLevel"></a>

- *Deprecated:* Use `applicationLogLevelV2` as a property instead.

```typescript
public readonly applicationLogLevel: string;
```

- *Type:* string
- *Default:* "INFO"

Sets the application log level for the function.

---

##### `applicationLogLevelV2`<sup>Optional</sup> <a name="applicationLogLevelV2" id="cdk-nextjs.OptionalEdgeFunctionProps.property.applicationLogLevelV2"></a>

```typescript
public readonly applicationLogLevelV2: ApplicationLogLevel;
```

- *Type:* aws-cdk-lib.aws_lambda.ApplicationLogLevel
- *Default:* ApplicationLogLevel.INFO

Sets the application log level for the function.

---

##### `architecture`<sup>Optional</sup> <a name="architecture" id="cdk-nextjs.OptionalEdgeFunctionProps.property.architecture"></a>

```typescript
public readonly architecture: Architecture;
```

- *Type:* aws-cdk-lib.aws_lambda.Architecture
- *Default:* Architecture.X86_64

The system architectures compatible with this lambda function.

---

##### `code`<sup>Optional</sup> <a name="code" id="cdk-nextjs.OptionalEdgeFunctionProps.property.code"></a>

```typescript
public readonly code: Code;
```

- *Type:* aws-cdk-lib.aws_lambda.Code

The source code of your Lambda function.

You can point to a file in an
Amazon Simple Storage Service (Amazon S3) bucket or specify your source
code as inline text.

---

##### `codeSigningConfig`<sup>Optional</sup> <a name="codeSigningConfig" id="cdk-nextjs.OptionalEdgeFunctionProps.property.codeSigningConfig"></a>

```typescript
public readonly codeSigningConfig: ICodeSigningConfig;
```

- *Type:* aws-cdk-lib.aws_lambda.ICodeSigningConfig
- *Default:* Not Sign the Code

Code signing config associated with this function.

---

##### `currentVersionOptions`<sup>Optional</sup> <a name="currentVersionOptions" id="cdk-nextjs.OptionalEdgeFunctionProps.property.currentVersionOptions"></a>

```typescript
public readonly currentVersionOptions: VersionOptions;
```

- *Type:* aws-cdk-lib.aws_lambda.VersionOptions
- *Default:* default options as described in `VersionOptions`

Options for the `lambda.Version` resource automatically created by the `fn.currentVersion` method.

---

##### `deadLetterQueue`<sup>Optional</sup> <a name="deadLetterQueue" id="cdk-nextjs.OptionalEdgeFunctionProps.property.deadLetterQueue"></a>

```typescript
public readonly deadLetterQueue: IQueue;
```

- *Type:* aws-cdk-lib.aws_sqs.IQueue
- *Default:* SQS queue with 14 day retention period if `deadLetterQueueEnabled` is `true`

The SQS queue to use if DLQ is enabled.

If SNS topic is desired, specify `deadLetterTopic` property instead.

---

##### `deadLetterQueueEnabled`<sup>Optional</sup> <a name="deadLetterQueueEnabled" id="cdk-nextjs.OptionalEdgeFunctionProps.property.deadLetterQueueEnabled"></a>

```typescript
public readonly deadLetterQueueEnabled: boolean;
```

- *Type:* boolean
- *Default:* false unless `deadLetterQueue` is set, which implies DLQ is enabled.

Enabled DLQ.

If `deadLetterQueue` is undefined,
an SQS queue with default options will be defined for your Function.

---

##### `deadLetterTopic`<sup>Optional</sup> <a name="deadLetterTopic" id="cdk-nextjs.OptionalEdgeFunctionProps.property.deadLetterTopic"></a>

```typescript
public readonly deadLetterTopic: ITopic;
```

- *Type:* aws-cdk-lib.aws_sns.ITopic
- *Default:* no SNS topic

The SNS topic to use as a DLQ.

Note that if `deadLetterQueueEnabled` is set to `true`, an SQS queue will be created
rather than an SNS topic. Using an SNS topic as a DLQ requires this property to be set explicitly.

---

##### `description`<sup>Optional</sup> <a name="description" id="cdk-nextjs.OptionalEdgeFunctionProps.property.description"></a>

```typescript
public readonly description: string;
```

- *Type:* string
- *Default:* No description.

A description of the function.

---

##### `environment`<sup>Optional</sup> <a name="environment" id="cdk-nextjs.OptionalEdgeFunctionProps.property.environment"></a>

```typescript
public readonly environment: {[ key: string ]: string};
```

- *Type:* {[ key: string ]: string}
- *Default:* No environment variables.

Key-value pairs that Lambda caches and makes available for your Lambda functions.

Use environment variables to apply configuration changes, such
as test and production environment configurations, without changing your
Lambda function source code.

---

##### `environmentEncryption`<sup>Optional</sup> <a name="environmentEncryption" id="cdk-nextjs.OptionalEdgeFunctionProps.property.environmentEncryption"></a>

```typescript
public readonly environmentEncryption: IKey;
```

- *Type:* aws-cdk-lib.aws_kms.IKey
- *Default:* AWS Lambda creates and uses an AWS managed customer master key (CMK).

The AWS KMS key that's used to encrypt your function's environment variables.

---

##### `ephemeralStorageSize`<sup>Optional</sup> <a name="ephemeralStorageSize" id="cdk-nextjs.OptionalEdgeFunctionProps.property.ephemeralStorageSize"></a>

```typescript
public readonly ephemeralStorageSize: Size;
```

- *Type:* aws-cdk-lib.Size
- *Default:* 512 MiB

The size of the function’s /tmp directory in MiB.

---

##### `events`<sup>Optional</sup> <a name="events" id="cdk-nextjs.OptionalEdgeFunctionProps.property.events"></a>

```typescript
public readonly events: IEventSource[];
```

- *Type:* aws-cdk-lib.aws_lambda.IEventSource[]
- *Default:* No event sources.

Event sources for this function.

You can also add event sources using `addEventSource`.

---

##### `filesystem`<sup>Optional</sup> <a name="filesystem" id="cdk-nextjs.OptionalEdgeFunctionProps.property.filesystem"></a>

```typescript
public readonly filesystem: FileSystem;
```

- *Type:* aws-cdk-lib.aws_lambda.FileSystem
- *Default:* will not mount any filesystem

The filesystem configuration for the lambda function.

---

##### `functionName`<sup>Optional</sup> <a name="functionName" id="cdk-nextjs.OptionalEdgeFunctionProps.property.functionName"></a>

```typescript
public readonly functionName: string;
```

- *Type:* string
- *Default:* AWS CloudFormation generates a unique physical ID and uses that ID for the function's name. For more information, see Name Type.

A name for the function.

---

##### `handler`<sup>Optional</sup> <a name="handler" id="cdk-nextjs.OptionalEdgeFunctionProps.property.handler"></a>

```typescript
public readonly handler: string;
```

- *Type:* string

The name of the method within your code that Lambda calls to execute your function.

The format includes the file name. It can also include
namespaces and other qualifiers, depending on the runtime.
For more information, see https://docs.aws.amazon.com/lambda/latest/dg/foundation-progmodel.html.

Use `Handler.FROM_IMAGE` when defining a function from a Docker image.

NOTE: If you specify your source code as inline text by specifying the
ZipFile property within the Code property, specify index.function_name as
the handler.

---

##### `initialPolicy`<sup>Optional</sup> <a name="initialPolicy" id="cdk-nextjs.OptionalEdgeFunctionProps.property.initialPolicy"></a>

```typescript
public readonly initialPolicy: PolicyStatement[];
```

- *Type:* aws-cdk-lib.aws_iam.PolicyStatement[]
- *Default:* No policy statements are added to the created Lambda role.

Initial policy statements to add to the created Lambda Role.

You can call `addToRolePolicy` to the created lambda to add statements post creation.

---

##### `insightsVersion`<sup>Optional</sup> <a name="insightsVersion" id="cdk-nextjs.OptionalEdgeFunctionProps.property.insightsVersion"></a>

```typescript
public readonly insightsVersion: LambdaInsightsVersion;
```

- *Type:* aws-cdk-lib.aws_lambda.LambdaInsightsVersion
- *Default:* No Lambda Insights

Specify the version of CloudWatch Lambda insights to use for monitoring.

---

##### `ipv6AllowedForDualStack`<sup>Optional</sup> <a name="ipv6AllowedForDualStack" id="cdk-nextjs.OptionalEdgeFunctionProps.property.ipv6AllowedForDualStack"></a>

```typescript
public readonly ipv6AllowedForDualStack: boolean;
```

- *Type:* boolean
- *Default:* false

Allows outbound IPv6 traffic on VPC functions that are connected to dual-stack subnets.

Only used if 'vpc' is supplied.

---

##### `layers`<sup>Optional</sup> <a name="layers" id="cdk-nextjs.OptionalEdgeFunctionProps.property.layers"></a>

```typescript
public readonly layers: ILayerVersion[];
```

- *Type:* aws-cdk-lib.aws_lambda.ILayerVersion[]
- *Default:* No layers.

A list of layers to add to the function's execution environment.

You can configure your Lambda function to pull in
additional code during initialization in the form of layers. Layers are packages of libraries or other dependencies
that can be used by multiple functions.

---

##### ~~`logFormat`~~<sup>Optional</sup> <a name="logFormat" id="cdk-nextjs.OptionalEdgeFunctionProps.property.logFormat"></a>

- *Deprecated:* Use `loggingFormat` as a property instead.

```typescript
public readonly logFormat: string;
```

- *Type:* string
- *Default:* "Text"

Sets the logFormat for the function.

---

##### `loggingFormat`<sup>Optional</sup> <a name="loggingFormat" id="cdk-nextjs.OptionalEdgeFunctionProps.property.loggingFormat"></a>

```typescript
public readonly loggingFormat: LoggingFormat;
```

- *Type:* aws-cdk-lib.aws_lambda.LoggingFormat
- *Default:* LoggingFormat.TEXT

Sets the loggingFormat for the function.

---

##### `logGroup`<sup>Optional</sup> <a name="logGroup" id="cdk-nextjs.OptionalEdgeFunctionProps.property.logGroup"></a>

```typescript
public readonly logGroup: ILogGroup;
```

- *Type:* aws-cdk-lib.aws_logs.ILogGroup
- *Default:* `/aws/lambda/${this.functionName}` - default log group created by Lambda

The log group the function sends logs to.

By default, Lambda functions send logs to an automatically created default log group named /aws/lambda/\<function name\>.
However you cannot change the properties of this auto-created log group using the AWS CDK, e.g. you cannot set a different log retention.

Use the `logGroup` property to create a fully customizable LogGroup ahead of time, and instruct the Lambda function to send logs to it.

Providing a user-controlled log group was rolled out to commercial regions on 2023-11-16.
If you are deploying to another type of region, please check regional availability first.

---

##### `logRetention`<sup>Optional</sup> <a name="logRetention" id="cdk-nextjs.OptionalEdgeFunctionProps.property.logRetention"></a>

```typescript
public readonly logRetention: RetentionDays;
```

- *Type:* aws-cdk-lib.aws_logs.RetentionDays
- *Default:* logs.RetentionDays.INFINITE

The number of days log events are kept in CloudWatch Logs.

When updating
this property, unsetting it doesn't remove the log retention policy. To
remove the retention policy, set the value to `INFINITE`.

This is a legacy API and we strongly recommend you move away from it if you can.
Instead create a fully customizable log group with `logs.LogGroup` and use the `logGroup` property
to instruct the Lambda function to send logs to it.
Migrating from `logRetention` to `logGroup` will cause the name of the log group to change.
Users and code and referencing the name verbatim will have to adjust.

In AWS CDK code, you can access the log group name directly from the LogGroup construct:
```ts
import * as logs from 'aws-cdk-lib/aws-logs';

declare const myLogGroup: logs.LogGroup;
myLogGroup.logGroupName;
```

---

##### `logRetentionRetryOptions`<sup>Optional</sup> <a name="logRetentionRetryOptions" id="cdk-nextjs.OptionalEdgeFunctionProps.property.logRetentionRetryOptions"></a>

```typescript
public readonly logRetentionRetryOptions: LogRetentionRetryOptions;
```

- *Type:* aws-cdk-lib.aws_lambda.LogRetentionRetryOptions
- *Default:* Default AWS SDK retry options.

When log retention is specified, a custom resource attempts to create the CloudWatch log group.

These options control the retry policy when interacting with CloudWatch APIs.

This is a legacy API and we strongly recommend you migrate to `logGroup` if you can.
`logGroup` allows you to create a fully customizable log group and instruct the Lambda function to send logs to it.

---

##### `logRetentionRole`<sup>Optional</sup> <a name="logRetentionRole" id="cdk-nextjs.OptionalEdgeFunctionProps.property.logRetentionRole"></a>

```typescript
public readonly logRetentionRole: IRole;
```

- *Type:* aws-cdk-lib.aws_iam.IRole
- *Default:* A new role is created.

The IAM role for the Lambda function associated with the custom resource that sets the retention policy.

This is a legacy API and we strongly recommend you migrate to `logGroup` if you can.
`logGroup` allows you to create a fully customizable log group and instruct the Lambda function to send logs to it.

---

##### `maxEventAge`<sup>Optional</sup> <a name="maxEventAge" id="cdk-nextjs.OptionalEdgeFunctionProps.property.maxEventAge"></a>

```typescript
public readonly maxEventAge: Duration;
```

- *Type:* aws-cdk-lib.Duration
- *Default:* Duration.hours(6)

The maximum age of a request that Lambda sends to a function for processing.

Minimum: 60 seconds
Maximum: 6 hours

---

##### `memorySize`<sup>Optional</sup> <a name="memorySize" id="cdk-nextjs.OptionalEdgeFunctionProps.property.memorySize"></a>

```typescript
public readonly memorySize: number;
```

- *Type:* number
- *Default:* 128

The amount of memory, in MB, that is allocated to your Lambda function.

Lambda uses this value to proportionally allocate the amount of CPU
power. For more information, see Resource Model in the AWS Lambda
Developer Guide.

---

##### `onFailure`<sup>Optional</sup> <a name="onFailure" id="cdk-nextjs.OptionalEdgeFunctionProps.property.onFailure"></a>

```typescript
public readonly onFailure: IDestination;
```

- *Type:* aws-cdk-lib.aws_lambda.IDestination
- *Default:* no destination

The destination for failed invocations.

---

##### `onSuccess`<sup>Optional</sup> <a name="onSuccess" id="cdk-nextjs.OptionalEdgeFunctionProps.property.onSuccess"></a>

```typescript
public readonly onSuccess: IDestination;
```

- *Type:* aws-cdk-lib.aws_lambda.IDestination
- *Default:* no destination

The destination for successful invocations.

---

##### `paramsAndSecrets`<sup>Optional</sup> <a name="paramsAndSecrets" id="cdk-nextjs.OptionalEdgeFunctionProps.property.paramsAndSecrets"></a>

```typescript
public readonly paramsAndSecrets: ParamsAndSecretsLayerVersion;
```

- *Type:* aws-cdk-lib.aws_lambda.ParamsAndSecretsLayerVersion
- *Default:* No Parameters and Secrets Extension

Specify the configuration of Parameters and Secrets Extension.

---

##### `profiling`<sup>Optional</sup> <a name="profiling" id="cdk-nextjs.OptionalEdgeFunctionProps.property.profiling"></a>

```typescript
public readonly profiling: boolean;
```

- *Type:* boolean
- *Default:* No profiling.

Enable profiling.

---

##### `profilingGroup`<sup>Optional</sup> <a name="profilingGroup" id="cdk-nextjs.OptionalEdgeFunctionProps.property.profilingGroup"></a>

```typescript
public readonly profilingGroup: IProfilingGroup;
```

- *Type:* aws-cdk-lib.aws_codeguruprofiler.IProfilingGroup
- *Default:* A new profiling group will be created if `profiling` is set.

Profiling Group.

---

##### `reservedConcurrentExecutions`<sup>Optional</sup> <a name="reservedConcurrentExecutions" id="cdk-nextjs.OptionalEdgeFunctionProps.property.reservedConcurrentExecutions"></a>

```typescript
public readonly reservedConcurrentExecutions: number;
```

- *Type:* number
- *Default:* No specific limit - account limit.

The maximum of concurrent executions you want to reserve for the function.

---

##### `retryAttempts`<sup>Optional</sup> <a name="retryAttempts" id="cdk-nextjs.OptionalEdgeFunctionProps.property.retryAttempts"></a>

```typescript
public readonly retryAttempts: number;
```

- *Type:* number
- *Default:* 2

The maximum number of times to retry when the function returns an error.

Minimum: 0
Maximum: 2

---

##### `role`<sup>Optional</sup> <a name="role" id="cdk-nextjs.OptionalEdgeFunctionProps.property.role"></a>

```typescript
public readonly role: IRole;
```

- *Type:* aws-cdk-lib.aws_iam.IRole
- *Default:* A unique role will be generated for this lambda function. Both supplied and generated roles can always be changed by calling `addToRolePolicy`.

Lambda execution role.

This is the role that will be assumed by the function upon execution.
It controls the permissions that the function will have. The Role must
be assumable by the 'lambda.amazonaws.com' service principal.

The default Role automatically has permissions granted for Lambda execution. If you
provide a Role, you must add the relevant AWS managed policies yourself.

The relevant managed policies are "service-role/AWSLambdaBasicExecutionRole" and
"service-role/AWSLambdaVPCAccessExecutionRole".

---

##### `runtime`<sup>Optional</sup> <a name="runtime" id="cdk-nextjs.OptionalEdgeFunctionProps.property.runtime"></a>

```typescript
public readonly runtime: Runtime;
```

- *Type:* aws-cdk-lib.aws_lambda.Runtime

The runtime environment for the Lambda function that you are uploading.

For valid values, see the Runtime property in the AWS Lambda Developer
Guide.

Use `Runtime.FROM_IMAGE` when defining a function from a Docker image.

---

##### `runtimeManagementMode`<sup>Optional</sup> <a name="runtimeManagementMode" id="cdk-nextjs.OptionalEdgeFunctionProps.property.runtimeManagementMode"></a>

```typescript
public readonly runtimeManagementMode: RuntimeManagementMode;
```

- *Type:* aws-cdk-lib.aws_lambda.RuntimeManagementMode
- *Default:* Auto

Sets the runtime management configuration for a function's version.

---

##### `securityGroups`<sup>Optional</sup> <a name="securityGroups" id="cdk-nextjs.OptionalEdgeFunctionProps.property.securityGroups"></a>

```typescript
public readonly securityGroups: ISecurityGroup[];
```

- *Type:* aws-cdk-lib.aws_ec2.ISecurityGroup[]
- *Default:* If the function is placed within a VPC and a security group is not specified, either by this or securityGroup prop, a dedicated security group will be created for this function.

The list of security groups to associate with the Lambda's network interfaces.

Only used if 'vpc' is supplied.

---

##### `snapStart`<sup>Optional</sup> <a name="snapStart" id="cdk-nextjs.OptionalEdgeFunctionProps.property.snapStart"></a>

```typescript
public readonly snapStart: SnapStartConf;
```

- *Type:* aws-cdk-lib.aws_lambda.SnapStartConf
- *Default:* No snapstart

Enable SnapStart for Lambda Function.

SnapStart is currently supported only for Java 11, 17 runtime

---

##### `stackId`<sup>Optional</sup> <a name="stackId" id="cdk-nextjs.OptionalEdgeFunctionProps.property.stackId"></a>

```typescript
public readonly stackId: string;
```

- *Type:* string
- *Default:* `edge-lambda-stack-${region}`

The stack ID of Lambda@Edge function.

---

##### ~~`systemLogLevel`~~<sup>Optional</sup> <a name="systemLogLevel" id="cdk-nextjs.OptionalEdgeFunctionProps.property.systemLogLevel"></a>

- *Deprecated:* Use `systemLogLevelV2` as a property instead.

```typescript
public readonly systemLogLevel: string;
```

- *Type:* string
- *Default:* "INFO"

Sets the system log level for the function.

---

##### `systemLogLevelV2`<sup>Optional</sup> <a name="systemLogLevelV2" id="cdk-nextjs.OptionalEdgeFunctionProps.property.systemLogLevelV2"></a>

```typescript
public readonly systemLogLevelV2: SystemLogLevel;
```

- *Type:* aws-cdk-lib.aws_lambda.SystemLogLevel
- *Default:* SystemLogLevel.INFO

Sets the system log level for the function.

---

##### `timeout`<sup>Optional</sup> <a name="timeout" id="cdk-nextjs.OptionalEdgeFunctionProps.property.timeout"></a>

```typescript
public readonly timeout: Duration;
```

- *Type:* aws-cdk-lib.Duration
- *Default:* Duration.seconds(3)

The function execution time (in seconds) after which Lambda terminates the function.

Because the execution time affects cost, set this value
based on the function's expected execution time.

---

##### `tracing`<sup>Optional</sup> <a name="tracing" id="cdk-nextjs.OptionalEdgeFunctionProps.property.tracing"></a>

```typescript
public readonly tracing: Tracing;
```

- *Type:* aws-cdk-lib.aws_lambda.Tracing
- *Default:* Tracing.Disabled

Enable AWS X-Ray Tracing for Lambda Function.

---

##### `vpc`<sup>Optional</sup> <a name="vpc" id="cdk-nextjs.OptionalEdgeFunctionProps.property.vpc"></a>

```typescript
public readonly vpc: IVpc;
```

- *Type:* aws-cdk-lib.aws_ec2.IVpc
- *Default:* Function is not placed within a VPC.

VPC network to place Lambda network interfaces.

Specify this if the Lambda function needs to access resources in a VPC.
This is required when `vpcSubnets` is specified.

---

##### `vpcSubnets`<sup>Optional</sup> <a name="vpcSubnets" id="cdk-nextjs.OptionalEdgeFunctionProps.property.vpcSubnets"></a>

```typescript
public readonly vpcSubnets: SubnetSelection;
```

- *Type:* aws-cdk-lib.aws_ec2.SubnetSelection
- *Default:* the Vpc default strategy if not specified

Where to place the network interfaces within the VPC.

This requires `vpc` to be specified in order for interfaces to actually be
placed in the subnets. If `vpc` is not specify, this will raise an error.

Note: Internet access for Lambda Functions requires a NAT Gateway, so picking
public subnets is not allowed (unless `allowPublicSubnet` is set to `true`).

---

### OptionalFunctionProps <a name="OptionalFunctionProps" id="cdk-nextjs.OptionalFunctionProps"></a>

OptionalFunctionProps.

#### Initializer <a name="Initializer" id="cdk-nextjs.OptionalFunctionProps.Initializer"></a>

```typescript
import { OptionalFunctionProps } from 'cdk-nextjs'

const optionalFunctionProps: OptionalFunctionProps = { ... }
```

#### Properties <a name="Properties" id="Properties"></a>

| **Name** | **Type** | **Description** |
| --- | --- | --- |
| <code><a href="#cdk-nextjs.OptionalFunctionProps.property.adotInstrumentation">adotInstrumentation</a></code> | <code>aws-cdk-lib.aws_lambda.AdotInstrumentationConfig</code> | Specify the configuration of AWS Distro for OpenTelemetry (ADOT) instrumentation. |
| <code><a href="#cdk-nextjs.OptionalFunctionProps.property.allowAllOutbound">allowAllOutbound</a></code> | <code>boolean</code> | Whether to allow the Lambda to send all network traffic. |
| <code><a href="#cdk-nextjs.OptionalFunctionProps.property.allowPublicSubnet">allowPublicSubnet</a></code> | <code>boolean</code> | Lambda Functions in a public subnet can NOT access the internet. |
| <code><a href="#cdk-nextjs.OptionalFunctionProps.property.applicationLogLevel">applicationLogLevel</a></code> | <code>string</code> | Sets the application log level for the function. |
| <code><a href="#cdk-nextjs.OptionalFunctionProps.property.applicationLogLevelV2">applicationLogLevelV2</a></code> | <code>aws-cdk-lib.aws_lambda.ApplicationLogLevel</code> | Sets the application log level for the function. |
| <code><a href="#cdk-nextjs.OptionalFunctionProps.property.architecture">architecture</a></code> | <code>aws-cdk-lib.aws_lambda.Architecture</code> | The system architectures compatible with this lambda function. |
| <code><a href="#cdk-nextjs.OptionalFunctionProps.property.code">code</a></code> | <code>aws-cdk-lib.aws_lambda.Code</code> | The source code of your Lambda function. |
| <code><a href="#cdk-nextjs.OptionalFunctionProps.property.codeSigningConfig">codeSigningConfig</a></code> | <code>aws-cdk-lib.aws_lambda.ICodeSigningConfig</code> | Code signing config associated with this function. |
| <code><a href="#cdk-nextjs.OptionalFunctionProps.property.currentVersionOptions">currentVersionOptions</a></code> | <code>aws-cdk-lib.aws_lambda.VersionOptions</code> | Options for the `lambda.Version` resource automatically created by the `fn.currentVersion` method. |
| <code><a href="#cdk-nextjs.OptionalFunctionProps.property.deadLetterQueue">deadLetterQueue</a></code> | <code>aws-cdk-lib.aws_sqs.IQueue</code> | The SQS queue to use if DLQ is enabled. |
| <code><a href="#cdk-nextjs.OptionalFunctionProps.property.deadLetterQueueEnabled">deadLetterQueueEnabled</a></code> | <code>boolean</code> | Enabled DLQ. |
| <code><a href="#cdk-nextjs.OptionalFunctionProps.property.deadLetterTopic">deadLetterTopic</a></code> | <code>aws-cdk-lib.aws_sns.ITopic</code> | The SNS topic to use as a DLQ. |
| <code><a href="#cdk-nextjs.OptionalFunctionProps.property.description">description</a></code> | <code>string</code> | A description of the function. |
| <code><a href="#cdk-nextjs.OptionalFunctionProps.property.environment">environment</a></code> | <code>{[ key: string ]: string}</code> | Key-value pairs that Lambda caches and makes available for your Lambda functions. |
| <code><a href="#cdk-nextjs.OptionalFunctionProps.property.environmentEncryption">environmentEncryption</a></code> | <code>aws-cdk-lib.aws_kms.IKey</code> | The AWS KMS key that's used to encrypt your function's environment variables. |
| <code><a href="#cdk-nextjs.OptionalFunctionProps.property.ephemeralStorageSize">ephemeralStorageSize</a></code> | <code>aws-cdk-lib.Size</code> | The size of the function’s /tmp directory in MiB. |
| <code><a href="#cdk-nextjs.OptionalFunctionProps.property.events">events</a></code> | <code>aws-cdk-lib.aws_lambda.IEventSource[]</code> | Event sources for this function. |
| <code><a href="#cdk-nextjs.OptionalFunctionProps.property.filesystem">filesystem</a></code> | <code>aws-cdk-lib.aws_lambda.FileSystem</code> | The filesystem configuration for the lambda function. |
| <code><a href="#cdk-nextjs.OptionalFunctionProps.property.functionName">functionName</a></code> | <code>string</code> | A name for the function. |
| <code><a href="#cdk-nextjs.OptionalFunctionProps.property.handler">handler</a></code> | <code>string</code> | The name of the method within your code that Lambda calls to execute your function. |
| <code><a href="#cdk-nextjs.OptionalFunctionProps.property.initialPolicy">initialPolicy</a></code> | <code>aws-cdk-lib.aws_iam.PolicyStatement[]</code> | Initial policy statements to add to the created Lambda Role. |
| <code><a href="#cdk-nextjs.OptionalFunctionProps.property.insightsVersion">insightsVersion</a></code> | <code>aws-cdk-lib.aws_lambda.LambdaInsightsVersion</code> | Specify the version of CloudWatch Lambda insights to use for monitoring. |
| <code><a href="#cdk-nextjs.OptionalFunctionProps.property.ipv6AllowedForDualStack">ipv6AllowedForDualStack</a></code> | <code>boolean</code> | Allows outbound IPv6 traffic on VPC functions that are connected to dual-stack subnets. |
| <code><a href="#cdk-nextjs.OptionalFunctionProps.property.layers">layers</a></code> | <code>aws-cdk-lib.aws_lambda.ILayerVersion[]</code> | A list of layers to add to the function's execution environment. |
| <code><a href="#cdk-nextjs.OptionalFunctionProps.property.logFormat">logFormat</a></code> | <code>string</code> | Sets the logFormat for the function. |
| <code><a href="#cdk-nextjs.OptionalFunctionProps.property.loggingFormat">loggingFormat</a></code> | <code>aws-cdk-lib.aws_lambda.LoggingFormat</code> | Sets the loggingFormat for the function. |
| <code><a href="#cdk-nextjs.OptionalFunctionProps.property.logGroup">logGroup</a></code> | <code>aws-cdk-lib.aws_logs.ILogGroup</code> | The log group the function sends logs to. |
| <code><a href="#cdk-nextjs.OptionalFunctionProps.property.logRetention">logRetention</a></code> | <code>aws-cdk-lib.aws_logs.RetentionDays</code> | The number of days log events are kept in CloudWatch Logs. |
| <code><a href="#cdk-nextjs.OptionalFunctionProps.property.logRetentionRetryOptions">logRetentionRetryOptions</a></code> | <code>aws-cdk-lib.aws_lambda.LogRetentionRetryOptions</code> | When log retention is specified, a custom resource attempts to create the CloudWatch log group. |
| <code><a href="#cdk-nextjs.OptionalFunctionProps.property.logRetentionRole">logRetentionRole</a></code> | <code>aws-cdk-lib.aws_iam.IRole</code> | The IAM role for the Lambda function associated with the custom resource that sets the retention policy. |
| <code><a href="#cdk-nextjs.OptionalFunctionProps.property.maxEventAge">maxEventAge</a></code> | <code>aws-cdk-lib.Duration</code> | The maximum age of a request that Lambda sends to a function for processing. |
| <code><a href="#cdk-nextjs.OptionalFunctionProps.property.memorySize">memorySize</a></code> | <code>number</code> | The amount of memory, in MB, that is allocated to your Lambda function. |
| <code><a href="#cdk-nextjs.OptionalFunctionProps.property.onFailure">onFailure</a></code> | <code>aws-cdk-lib.aws_lambda.IDestination</code> | The destination for failed invocations. |
| <code><a href="#cdk-nextjs.OptionalFunctionProps.property.onSuccess">onSuccess</a></code> | <code>aws-cdk-lib.aws_lambda.IDestination</code> | The destination for successful invocations. |
| <code><a href="#cdk-nextjs.OptionalFunctionProps.property.paramsAndSecrets">paramsAndSecrets</a></code> | <code>aws-cdk-lib.aws_lambda.ParamsAndSecretsLayerVersion</code> | Specify the configuration of Parameters and Secrets Extension. |
| <code><a href="#cdk-nextjs.OptionalFunctionProps.property.profiling">profiling</a></code> | <code>boolean</code> | Enable profiling. |
| <code><a href="#cdk-nextjs.OptionalFunctionProps.property.profilingGroup">profilingGroup</a></code> | <code>aws-cdk-lib.aws_codeguruprofiler.IProfilingGroup</code> | Profiling Group. |
| <code><a href="#cdk-nextjs.OptionalFunctionProps.property.reservedConcurrentExecutions">reservedConcurrentExecutions</a></code> | <code>number</code> | The maximum of concurrent executions you want to reserve for the function. |
| <code><a href="#cdk-nextjs.OptionalFunctionProps.property.retryAttempts">retryAttempts</a></code> | <code>number</code> | The maximum number of times to retry when the function returns an error. |
| <code><a href="#cdk-nextjs.OptionalFunctionProps.property.role">role</a></code> | <code>aws-cdk-lib.aws_iam.IRole</code> | Lambda execution role. |
| <code><a href="#cdk-nextjs.OptionalFunctionProps.property.runtime">runtime</a></code> | <code>aws-cdk-lib.aws_lambda.Runtime</code> | The runtime environment for the Lambda function that you are uploading. |
| <code><a href="#cdk-nextjs.OptionalFunctionProps.property.runtimeManagementMode">runtimeManagementMode</a></code> | <code>aws-cdk-lib.aws_lambda.RuntimeManagementMode</code> | Sets the runtime management configuration for a function's version. |
| <code><a href="#cdk-nextjs.OptionalFunctionProps.property.securityGroups">securityGroups</a></code> | <code>aws-cdk-lib.aws_ec2.ISecurityGroup[]</code> | The list of security groups to associate with the Lambda's network interfaces. |
| <code><a href="#cdk-nextjs.OptionalFunctionProps.property.snapStart">snapStart</a></code> | <code>aws-cdk-lib.aws_lambda.SnapStartConf</code> | Enable SnapStart for Lambda Function. |
| <code><a href="#cdk-nextjs.OptionalFunctionProps.property.systemLogLevel">systemLogLevel</a></code> | <code>string</code> | Sets the system log level for the function. |
| <code><a href="#cdk-nextjs.OptionalFunctionProps.property.systemLogLevelV2">systemLogLevelV2</a></code> | <code>aws-cdk-lib.aws_lambda.SystemLogLevel</code> | Sets the system log level for the function. |
| <code><a href="#cdk-nextjs.OptionalFunctionProps.property.timeout">timeout</a></code> | <code>aws-cdk-lib.Duration</code> | The function execution time (in seconds) after which Lambda terminates the function. |
| <code><a href="#cdk-nextjs.OptionalFunctionProps.property.tracing">tracing</a></code> | <code>aws-cdk-lib.aws_lambda.Tracing</code> | Enable AWS X-Ray Tracing for Lambda Function. |
| <code><a href="#cdk-nextjs.OptionalFunctionProps.property.vpc">vpc</a></code> | <code>aws-cdk-lib.aws_ec2.IVpc</code> | VPC network to place Lambda network interfaces. |
| <code><a href="#cdk-nextjs.OptionalFunctionProps.property.vpcSubnets">vpcSubnets</a></code> | <code>aws-cdk-lib.aws_ec2.SubnetSelection</code> | Where to place the network interfaces within the VPC. |

---

##### `adotInstrumentation`<sup>Optional</sup> <a name="adotInstrumentation" id="cdk-nextjs.OptionalFunctionProps.property.adotInstrumentation"></a>

```typescript
public readonly adotInstrumentation: AdotInstrumentationConfig;
```

- *Type:* aws-cdk-lib.aws_lambda.AdotInstrumentationConfig
- *Default:* No ADOT instrumentation

Specify the configuration of AWS Distro for OpenTelemetry (ADOT) instrumentation.

---

##### `allowAllOutbound`<sup>Optional</sup> <a name="allowAllOutbound" id="cdk-nextjs.OptionalFunctionProps.property.allowAllOutbound"></a>

```typescript
public readonly allowAllOutbound: boolean;
```

- *Type:* boolean
- *Default:* true

Whether to allow the Lambda to send all network traffic.

If set to false, you must individually add traffic rules to allow the
Lambda to connect to network targets.

Do not specify this property if the `securityGroups` or `securityGroup` property is set.
Instead, configure `allowAllOutbound` directly on the security group.

---

##### `allowPublicSubnet`<sup>Optional</sup> <a name="allowPublicSubnet" id="cdk-nextjs.OptionalFunctionProps.property.allowPublicSubnet"></a>

```typescript
public readonly allowPublicSubnet: boolean;
```

- *Type:* boolean
- *Default:* false

Lambda Functions in a public subnet can NOT access the internet.

Use this property to acknowledge this limitation and still place the function in a public subnet.

---

##### ~~`applicationLogLevel`~~<sup>Optional</sup> <a name="applicationLogLevel" id="cdk-nextjs.OptionalFunctionProps.property.applicationLogLevel"></a>

- *Deprecated:* Use `applicationLogLevelV2` as a property instead.

```typescript
public readonly applicationLogLevel: string;
```

- *Type:* string
- *Default:* "INFO"

Sets the application log level for the function.

---

##### `applicationLogLevelV2`<sup>Optional</sup> <a name="applicationLogLevelV2" id="cdk-nextjs.OptionalFunctionProps.property.applicationLogLevelV2"></a>

```typescript
public readonly applicationLogLevelV2: ApplicationLogLevel;
```

- *Type:* aws-cdk-lib.aws_lambda.ApplicationLogLevel
- *Default:* ApplicationLogLevel.INFO

Sets the application log level for the function.

---

##### `architecture`<sup>Optional</sup> <a name="architecture" id="cdk-nextjs.OptionalFunctionProps.property.architecture"></a>

```typescript
public readonly architecture: Architecture;
```

- *Type:* aws-cdk-lib.aws_lambda.Architecture
- *Default:* Architecture.X86_64

The system architectures compatible with this lambda function.

---

##### `code`<sup>Optional</sup> <a name="code" id="cdk-nextjs.OptionalFunctionProps.property.code"></a>

```typescript
public readonly code: Code;
```

- *Type:* aws-cdk-lib.aws_lambda.Code

The source code of your Lambda function.

You can point to a file in an
Amazon Simple Storage Service (Amazon S3) bucket or specify your source
code as inline text.

---

##### `codeSigningConfig`<sup>Optional</sup> <a name="codeSigningConfig" id="cdk-nextjs.OptionalFunctionProps.property.codeSigningConfig"></a>

```typescript
public readonly codeSigningConfig: ICodeSigningConfig;
```

- *Type:* aws-cdk-lib.aws_lambda.ICodeSigningConfig
- *Default:* Not Sign the Code

Code signing config associated with this function.

---

##### `currentVersionOptions`<sup>Optional</sup> <a name="currentVersionOptions" id="cdk-nextjs.OptionalFunctionProps.property.currentVersionOptions"></a>

```typescript
public readonly currentVersionOptions: VersionOptions;
```

- *Type:* aws-cdk-lib.aws_lambda.VersionOptions
- *Default:* default options as described in `VersionOptions`

Options for the `lambda.Version` resource automatically created by the `fn.currentVersion` method.

---

##### `deadLetterQueue`<sup>Optional</sup> <a name="deadLetterQueue" id="cdk-nextjs.OptionalFunctionProps.property.deadLetterQueue"></a>

```typescript
public readonly deadLetterQueue: IQueue;
```

- *Type:* aws-cdk-lib.aws_sqs.IQueue
- *Default:* SQS queue with 14 day retention period if `deadLetterQueueEnabled` is `true`

The SQS queue to use if DLQ is enabled.

If SNS topic is desired, specify `deadLetterTopic` property instead.

---

##### `deadLetterQueueEnabled`<sup>Optional</sup> <a name="deadLetterQueueEnabled" id="cdk-nextjs.OptionalFunctionProps.property.deadLetterQueueEnabled"></a>

```typescript
public readonly deadLetterQueueEnabled: boolean;
```

- *Type:* boolean
- *Default:* false unless `deadLetterQueue` is set, which implies DLQ is enabled.

Enabled DLQ.

If `deadLetterQueue` is undefined,
an SQS queue with default options will be defined for your Function.

---

##### `deadLetterTopic`<sup>Optional</sup> <a name="deadLetterTopic" id="cdk-nextjs.OptionalFunctionProps.property.deadLetterTopic"></a>

```typescript
public readonly deadLetterTopic: ITopic;
```

- *Type:* aws-cdk-lib.aws_sns.ITopic
- *Default:* no SNS topic

The SNS topic to use as a DLQ.

Note that if `deadLetterQueueEnabled` is set to `true`, an SQS queue will be created
rather than an SNS topic. Using an SNS topic as a DLQ requires this property to be set explicitly.

---

##### `description`<sup>Optional</sup> <a name="description" id="cdk-nextjs.OptionalFunctionProps.property.description"></a>

```typescript
public readonly description: string;
```

- *Type:* string
- *Default:* No description.

A description of the function.

---

##### `environment`<sup>Optional</sup> <a name="environment" id="cdk-nextjs.OptionalFunctionProps.property.environment"></a>

```typescript
public readonly environment: {[ key: string ]: string};
```

- *Type:* {[ key: string ]: string}
- *Default:* No environment variables.

Key-value pairs that Lambda caches and makes available for your Lambda functions.

Use environment variables to apply configuration changes, such
as test and production environment configurations, without changing your
Lambda function source code.

---

##### `environmentEncryption`<sup>Optional</sup> <a name="environmentEncryption" id="cdk-nextjs.OptionalFunctionProps.property.environmentEncryption"></a>

```typescript
public readonly environmentEncryption: IKey;
```

- *Type:* aws-cdk-lib.aws_kms.IKey
- *Default:* AWS Lambda creates and uses an AWS managed customer master key (CMK).

The AWS KMS key that's used to encrypt your function's environment variables.

---

##### `ephemeralStorageSize`<sup>Optional</sup> <a name="ephemeralStorageSize" id="cdk-nextjs.OptionalFunctionProps.property.ephemeralStorageSize"></a>

```typescript
public readonly ephemeralStorageSize: Size;
```

- *Type:* aws-cdk-lib.Size
- *Default:* 512 MiB

The size of the function’s /tmp directory in MiB.

---

##### `events`<sup>Optional</sup> <a name="events" id="cdk-nextjs.OptionalFunctionProps.property.events"></a>

```typescript
public readonly events: IEventSource[];
```

- *Type:* aws-cdk-lib.aws_lambda.IEventSource[]
- *Default:* No event sources.

Event sources for this function.

You can also add event sources using `addEventSource`.

---

##### `filesystem`<sup>Optional</sup> <a name="filesystem" id="cdk-nextjs.OptionalFunctionProps.property.filesystem"></a>

```typescript
public readonly filesystem: FileSystem;
```

- *Type:* aws-cdk-lib.aws_lambda.FileSystem
- *Default:* will not mount any filesystem

The filesystem configuration for the lambda function.

---

##### `functionName`<sup>Optional</sup> <a name="functionName" id="cdk-nextjs.OptionalFunctionProps.property.functionName"></a>

```typescript
public readonly functionName: string;
```

- *Type:* string
- *Default:* AWS CloudFormation generates a unique physical ID and uses that ID for the function's name. For more information, see Name Type.

A name for the function.

---

##### `handler`<sup>Optional</sup> <a name="handler" id="cdk-nextjs.OptionalFunctionProps.property.handler"></a>

```typescript
public readonly handler: string;
```

- *Type:* string

The name of the method within your code that Lambda calls to execute your function.

The format includes the file name. It can also include
namespaces and other qualifiers, depending on the runtime.
For more information, see https://docs.aws.amazon.com/lambda/latest/dg/foundation-progmodel.html.

Use `Handler.FROM_IMAGE` when defining a function from a Docker image.

NOTE: If you specify your source code as inline text by specifying the
ZipFile property within the Code property, specify index.function_name as
the handler.

---

##### `initialPolicy`<sup>Optional</sup> <a name="initialPolicy" id="cdk-nextjs.OptionalFunctionProps.property.initialPolicy"></a>

```typescript
public readonly initialPolicy: PolicyStatement[];
```

- *Type:* aws-cdk-lib.aws_iam.PolicyStatement[]
- *Default:* No policy statements are added to the created Lambda role.

Initial policy statements to add to the created Lambda Role.

You can call `addToRolePolicy` to the created lambda to add statements post creation.

---

##### `insightsVersion`<sup>Optional</sup> <a name="insightsVersion" id="cdk-nextjs.OptionalFunctionProps.property.insightsVersion"></a>

```typescript
public readonly insightsVersion: LambdaInsightsVersion;
```

- *Type:* aws-cdk-lib.aws_lambda.LambdaInsightsVersion
- *Default:* No Lambda Insights

Specify the version of CloudWatch Lambda insights to use for monitoring.

---

##### `ipv6AllowedForDualStack`<sup>Optional</sup> <a name="ipv6AllowedForDualStack" id="cdk-nextjs.OptionalFunctionProps.property.ipv6AllowedForDualStack"></a>

```typescript
public readonly ipv6AllowedForDualStack: boolean;
```

- *Type:* boolean
- *Default:* false

Allows outbound IPv6 traffic on VPC functions that are connected to dual-stack subnets.

Only used if 'vpc' is supplied.

---

##### `layers`<sup>Optional</sup> <a name="layers" id="cdk-nextjs.OptionalFunctionProps.property.layers"></a>

```typescript
public readonly layers: ILayerVersion[];
```

- *Type:* aws-cdk-lib.aws_lambda.ILayerVersion[]
- *Default:* No layers.

A list of layers to add to the function's execution environment.

You can configure your Lambda function to pull in
additional code during initialization in the form of layers. Layers are packages of libraries or other dependencies
that can be used by multiple functions.

---

##### ~~`logFormat`~~<sup>Optional</sup> <a name="logFormat" id="cdk-nextjs.OptionalFunctionProps.property.logFormat"></a>

- *Deprecated:* Use `loggingFormat` as a property instead.

```typescript
public readonly logFormat: string;
```

- *Type:* string
- *Default:* "Text"

Sets the logFormat for the function.

---

##### `loggingFormat`<sup>Optional</sup> <a name="loggingFormat" id="cdk-nextjs.OptionalFunctionProps.property.loggingFormat"></a>

```typescript
public readonly loggingFormat: LoggingFormat;
```

- *Type:* aws-cdk-lib.aws_lambda.LoggingFormat
- *Default:* LoggingFormat.TEXT

Sets the loggingFormat for the function.

---

##### `logGroup`<sup>Optional</sup> <a name="logGroup" id="cdk-nextjs.OptionalFunctionProps.property.logGroup"></a>

```typescript
public readonly logGroup: ILogGroup;
```

- *Type:* aws-cdk-lib.aws_logs.ILogGroup
- *Default:* `/aws/lambda/${this.functionName}` - default log group created by Lambda

The log group the function sends logs to.

By default, Lambda functions send logs to an automatically created default log group named /aws/lambda/\<function name\>.
However you cannot change the properties of this auto-created log group using the AWS CDK, e.g. you cannot set a different log retention.

Use the `logGroup` property to create a fully customizable LogGroup ahead of time, and instruct the Lambda function to send logs to it.

Providing a user-controlled log group was rolled out to commercial regions on 2023-11-16.
If you are deploying to another type of region, please check regional availability first.

---

##### `logRetention`<sup>Optional</sup> <a name="logRetention" id="cdk-nextjs.OptionalFunctionProps.property.logRetention"></a>

```typescript
public readonly logRetention: RetentionDays;
```

- *Type:* aws-cdk-lib.aws_logs.RetentionDays
- *Default:* logs.RetentionDays.INFINITE

The number of days log events are kept in CloudWatch Logs.

When updating
this property, unsetting it doesn't remove the log retention policy. To
remove the retention policy, set the value to `INFINITE`.

This is a legacy API and we strongly recommend you move away from it if you can.
Instead create a fully customizable log group with `logs.LogGroup` and use the `logGroup` property
to instruct the Lambda function to send logs to it.
Migrating from `logRetention` to `logGroup` will cause the name of the log group to change.
Users and code and referencing the name verbatim will have to adjust.

In AWS CDK code, you can access the log group name directly from the LogGroup construct:
```ts
import * as logs from 'aws-cdk-lib/aws-logs';

declare const myLogGroup: logs.LogGroup;
myLogGroup.logGroupName;
```

---

##### `logRetentionRetryOptions`<sup>Optional</sup> <a name="logRetentionRetryOptions" id="cdk-nextjs.OptionalFunctionProps.property.logRetentionRetryOptions"></a>

```typescript
public readonly logRetentionRetryOptions: LogRetentionRetryOptions;
```

- *Type:* aws-cdk-lib.aws_lambda.LogRetentionRetryOptions
- *Default:* Default AWS SDK retry options.

When log retention is specified, a custom resource attempts to create the CloudWatch log group.

These options control the retry policy when interacting with CloudWatch APIs.

This is a legacy API and we strongly recommend you migrate to `logGroup` if you can.
`logGroup` allows you to create a fully customizable log group and instruct the Lambda function to send logs to it.

---

##### `logRetentionRole`<sup>Optional</sup> <a name="logRetentionRole" id="cdk-nextjs.OptionalFunctionProps.property.logRetentionRole"></a>

```typescript
public readonly logRetentionRole: IRole;
```

- *Type:* aws-cdk-lib.aws_iam.IRole
- *Default:* A new role is created.

The IAM role for the Lambda function associated with the custom resource that sets the retention policy.

This is a legacy API and we strongly recommend you migrate to `logGroup` if you can.
`logGroup` allows you to create a fully customizable log group and instruct the Lambda function to send logs to it.

---

##### `maxEventAge`<sup>Optional</sup> <a name="maxEventAge" id="cdk-nextjs.OptionalFunctionProps.property.maxEventAge"></a>

```typescript
public readonly maxEventAge: Duration;
```

- *Type:* aws-cdk-lib.Duration
- *Default:* Duration.hours(6)

The maximum age of a request that Lambda sends to a function for processing.

Minimum: 60 seconds
Maximum: 6 hours

---

##### `memorySize`<sup>Optional</sup> <a name="memorySize" id="cdk-nextjs.OptionalFunctionProps.property.memorySize"></a>

```typescript
public readonly memorySize: number;
```

- *Type:* number
- *Default:* 128

The amount of memory, in MB, that is allocated to your Lambda function.

Lambda uses this value to proportionally allocate the amount of CPU
power. For more information, see Resource Model in the AWS Lambda
Developer Guide.

---

##### `onFailure`<sup>Optional</sup> <a name="onFailure" id="cdk-nextjs.OptionalFunctionProps.property.onFailure"></a>

```typescript
public readonly onFailure: IDestination;
```

- *Type:* aws-cdk-lib.aws_lambda.IDestination
- *Default:* no destination

The destination for failed invocations.

---

##### `onSuccess`<sup>Optional</sup> <a name="onSuccess" id="cdk-nextjs.OptionalFunctionProps.property.onSuccess"></a>

```typescript
public readonly onSuccess: IDestination;
```

- *Type:* aws-cdk-lib.aws_lambda.IDestination
- *Default:* no destination

The destination for successful invocations.

---

##### `paramsAndSecrets`<sup>Optional</sup> <a name="paramsAndSecrets" id="cdk-nextjs.OptionalFunctionProps.property.paramsAndSecrets"></a>

```typescript
public readonly paramsAndSecrets: ParamsAndSecretsLayerVersion;
```

- *Type:* aws-cdk-lib.aws_lambda.ParamsAndSecretsLayerVersion
- *Default:* No Parameters and Secrets Extension

Specify the configuration of Parameters and Secrets Extension.

---

##### `profiling`<sup>Optional</sup> <a name="profiling" id="cdk-nextjs.OptionalFunctionProps.property.profiling"></a>

```typescript
public readonly profiling: boolean;
```

- *Type:* boolean
- *Default:* No profiling.

Enable profiling.

---

##### `profilingGroup`<sup>Optional</sup> <a name="profilingGroup" id="cdk-nextjs.OptionalFunctionProps.property.profilingGroup"></a>

```typescript
public readonly profilingGroup: IProfilingGroup;
```

- *Type:* aws-cdk-lib.aws_codeguruprofiler.IProfilingGroup
- *Default:* A new profiling group will be created if `profiling` is set.

Profiling Group.

---

##### `reservedConcurrentExecutions`<sup>Optional</sup> <a name="reservedConcurrentExecutions" id="cdk-nextjs.OptionalFunctionProps.property.reservedConcurrentExecutions"></a>

```typescript
public readonly reservedConcurrentExecutions: number;
```

- *Type:* number
- *Default:* No specific limit - account limit.

The maximum of concurrent executions you want to reserve for the function.

---

##### `retryAttempts`<sup>Optional</sup> <a name="retryAttempts" id="cdk-nextjs.OptionalFunctionProps.property.retryAttempts"></a>

```typescript
public readonly retryAttempts: number;
```

- *Type:* number
- *Default:* 2

The maximum number of times to retry when the function returns an error.

Minimum: 0
Maximum: 2

---

##### `role`<sup>Optional</sup> <a name="role" id="cdk-nextjs.OptionalFunctionProps.property.role"></a>

```typescript
public readonly role: IRole;
```

- *Type:* aws-cdk-lib.aws_iam.IRole
- *Default:* A unique role will be generated for this lambda function. Both supplied and generated roles can always be changed by calling `addToRolePolicy`.

Lambda execution role.

This is the role that will be assumed by the function upon execution.
It controls the permissions that the function will have. The Role must
be assumable by the 'lambda.amazonaws.com' service principal.

The default Role automatically has permissions granted for Lambda execution. If you
provide a Role, you must add the relevant AWS managed policies yourself.

The relevant managed policies are "service-role/AWSLambdaBasicExecutionRole" and
"service-role/AWSLambdaVPCAccessExecutionRole".

---

##### `runtime`<sup>Optional</sup> <a name="runtime" id="cdk-nextjs.OptionalFunctionProps.property.runtime"></a>

```typescript
public readonly runtime: Runtime;
```

- *Type:* aws-cdk-lib.aws_lambda.Runtime

The runtime environment for the Lambda function that you are uploading.

For valid values, see the Runtime property in the AWS Lambda Developer
Guide.

Use `Runtime.FROM_IMAGE` when defining a function from a Docker image.

---

##### `runtimeManagementMode`<sup>Optional</sup> <a name="runtimeManagementMode" id="cdk-nextjs.OptionalFunctionProps.property.runtimeManagementMode"></a>

```typescript
public readonly runtimeManagementMode: RuntimeManagementMode;
```

- *Type:* aws-cdk-lib.aws_lambda.RuntimeManagementMode
- *Default:* Auto

Sets the runtime management configuration for a function's version.

---

##### `securityGroups`<sup>Optional</sup> <a name="securityGroups" id="cdk-nextjs.OptionalFunctionProps.property.securityGroups"></a>

```typescript
public readonly securityGroups: ISecurityGroup[];
```

- *Type:* aws-cdk-lib.aws_ec2.ISecurityGroup[]
- *Default:* If the function is placed within a VPC and a security group is not specified, either by this or securityGroup prop, a dedicated security group will be created for this function.

The list of security groups to associate with the Lambda's network interfaces.

Only used if 'vpc' is supplied.

---

##### `snapStart`<sup>Optional</sup> <a name="snapStart" id="cdk-nextjs.OptionalFunctionProps.property.snapStart"></a>

```typescript
public readonly snapStart: SnapStartConf;
```

- *Type:* aws-cdk-lib.aws_lambda.SnapStartConf
- *Default:* No snapstart

Enable SnapStart for Lambda Function.

SnapStart is currently supported only for Java 11, 17 runtime

---

##### ~~`systemLogLevel`~~<sup>Optional</sup> <a name="systemLogLevel" id="cdk-nextjs.OptionalFunctionProps.property.systemLogLevel"></a>

- *Deprecated:* Use `systemLogLevelV2` as a property instead.

```typescript
public readonly systemLogLevel: string;
```

- *Type:* string
- *Default:* "INFO"

Sets the system log level for the function.

---

##### `systemLogLevelV2`<sup>Optional</sup> <a name="systemLogLevelV2" id="cdk-nextjs.OptionalFunctionProps.property.systemLogLevelV2"></a>

```typescript
public readonly systemLogLevelV2: SystemLogLevel;
```

- *Type:* aws-cdk-lib.aws_lambda.SystemLogLevel
- *Default:* SystemLogLevel.INFO

Sets the system log level for the function.

---

##### `timeout`<sup>Optional</sup> <a name="timeout" id="cdk-nextjs.OptionalFunctionProps.property.timeout"></a>

```typescript
public readonly timeout: Duration;
```

- *Type:* aws-cdk-lib.Duration
- *Default:* Duration.seconds(3)

The function execution time (in seconds) after which Lambda terminates the function.

Because the execution time affects cost, set this value
based on the function's expected execution time.

---

##### `tracing`<sup>Optional</sup> <a name="tracing" id="cdk-nextjs.OptionalFunctionProps.property.tracing"></a>

```typescript
public readonly tracing: Tracing;
```

- *Type:* aws-cdk-lib.aws_lambda.Tracing
- *Default:* Tracing.Disabled

Enable AWS X-Ray Tracing for Lambda Function.

---

##### `vpc`<sup>Optional</sup> <a name="vpc" id="cdk-nextjs.OptionalFunctionProps.property.vpc"></a>

```typescript
public readonly vpc: IVpc;
```

- *Type:* aws-cdk-lib.aws_ec2.IVpc
- *Default:* Function is not placed within a VPC.

VPC network to place Lambda network interfaces.

Specify this if the Lambda function needs to access resources in a VPC.
This is required when `vpcSubnets` is specified.

---

##### `vpcSubnets`<sup>Optional</sup> <a name="vpcSubnets" id="cdk-nextjs.OptionalFunctionProps.property.vpcSubnets"></a>

```typescript
public readonly vpcSubnets: SubnetSelection;
```

- *Type:* aws-cdk-lib.aws_ec2.SubnetSelection
- *Default:* the Vpc default strategy if not specified

Where to place the network interfaces within the VPC.

This requires `vpc` to be specified in order for interfaces to actually be
placed in the subnets. If `vpc` is not specify, this will raise an error.

Note: Internet access for Lambda Functions requires a NAT Gateway, so picking
public subnets is not allowed (unless `allowPublicSubnet` is set to `true`).

---

### OptionalFunctionUrlProps <a name="OptionalFunctionUrlProps" id="cdk-nextjs.OptionalFunctionUrlProps"></a>

OptionalFunctionUrlProps.

#### Initializer <a name="Initializer" id="cdk-nextjs.OptionalFunctionUrlProps.Initializer"></a>

```typescript
import { OptionalFunctionUrlProps } from 'cdk-nextjs'

const optionalFunctionUrlProps: OptionalFunctionUrlProps = { ... }
```

#### Properties <a name="Properties" id="Properties"></a>

| **Name** | **Type** | **Description** |
| --- | --- | --- |
| <code><a href="#cdk-nextjs.OptionalFunctionUrlProps.property.authType">authType</a></code> | <code>aws-cdk-lib.aws_lambda.FunctionUrlAuthType</code> | The type of authentication that your function URL uses. |
| <code><a href="#cdk-nextjs.OptionalFunctionUrlProps.property.cors">cors</a></code> | <code>aws-cdk-lib.aws_lambda.FunctionUrlCorsOptions</code> | The cross-origin resource sharing (CORS) settings for your function URL. |
| <code><a href="#cdk-nextjs.OptionalFunctionUrlProps.property.function">function</a></code> | <code>aws-cdk-lib.aws_lambda.IFunction</code> | The function to which this url refers. |
| <code><a href="#cdk-nextjs.OptionalFunctionUrlProps.property.invokeMode">invokeMode</a></code> | <code>aws-cdk-lib.aws_lambda.InvokeMode</code> | The type of invocation mode that your Lambda function uses. |

---

##### `authType`<sup>Optional</sup> <a name="authType" id="cdk-nextjs.OptionalFunctionUrlProps.property.authType"></a>

```typescript
public readonly authType: FunctionUrlAuthType;
```

- *Type:* aws-cdk-lib.aws_lambda.FunctionUrlAuthType
- *Default:* FunctionUrlAuthType.AWS_IAM

The type of authentication that your function URL uses.

---

##### `cors`<sup>Optional</sup> <a name="cors" id="cdk-nextjs.OptionalFunctionUrlProps.property.cors"></a>

```typescript
public readonly cors: FunctionUrlCorsOptions;
```

- *Type:* aws-cdk-lib.aws_lambda.FunctionUrlCorsOptions
- *Default:* No CORS configuration.

The cross-origin resource sharing (CORS) settings for your function URL.

---

##### `function`<sup>Optional</sup> <a name="function" id="cdk-nextjs.OptionalFunctionUrlProps.property.function"></a>

```typescript
public readonly function: IFunction;
```

- *Type:* aws-cdk-lib.aws_lambda.IFunction

The function to which this url refers.

It can also be an `Alias` but not a `Version`.

---

##### `invokeMode`<sup>Optional</sup> <a name="invokeMode" id="cdk-nextjs.OptionalFunctionUrlProps.property.invokeMode"></a>

```typescript
public readonly invokeMode: InvokeMode;
```

- *Type:* aws-cdk-lib.aws_lambda.InvokeMode
- *Default:* InvokeMode.BUFFERED

The type of invocation mode that your Lambda function uses.

---

### OptionalNextjsAssetsDeploymentProps <a name="OptionalNextjsAssetsDeploymentProps" id="cdk-nextjs.OptionalNextjsAssetsDeploymentProps"></a>

OptionalNextjsAssetsDeploymentProps.

#### Initializer <a name="Initializer" id="cdk-nextjs.OptionalNextjsAssetsDeploymentProps.Initializer"></a>

```typescript
import { OptionalNextjsAssetsDeploymentProps } from 'cdk-nextjs'

const optionalNextjsAssetsDeploymentProps: OptionalNextjsAssetsDeploymentProps = { ... }
```

#### Properties <a name="Properties" id="Properties"></a>

| **Name** | **Type** | **Description** |
| --- | --- | --- |
| <code><a href="#cdk-nextjs.OptionalNextjsAssetsDeploymentProps.property.accessPoint">accessPoint</a></code> | <code>aws-cdk-lib.aws_efs.AccessPoint</code> | *No description.* |
| <code><a href="#cdk-nextjs.OptionalNextjsAssetsDeploymentProps.property.buildImageDigest">buildImageDigest</a></code> | <code>string</code> | *No description.* |
| <code><a href="#cdk-nextjs.OptionalNextjsAssetsDeploymentProps.property.containerMountPathForEfs">containerMountPathForEfs</a></code> | <code>string</code> | *No description.* |
| <code><a href="#cdk-nextjs.OptionalNextjsAssetsDeploymentProps.property.debug">debug</a></code> | <code>boolean</code> | *No description.* |
| <code><a href="#cdk-nextjs.OptionalNextjsAssetsDeploymentProps.property.dockerImageCode">dockerImageCode</a></code> | <code>aws-cdk-lib.aws_lambda.DockerImageCode</code> | *No description.* |
| <code><a href="#cdk-nextjs.OptionalNextjsAssetsDeploymentProps.property.overrides">overrides</a></code> | <code><a href="#cdk-nextjs.NextjsAssetDeploymentOverrides">NextjsAssetDeploymentOverrides</a></code> | *No description.* |
| <code><a href="#cdk-nextjs.OptionalNextjsAssetsDeploymentProps.property.relativePathToWorkspace">relativePathToWorkspace</a></code> | <code>string</code> | *No description.* |
| <code><a href="#cdk-nextjs.OptionalNextjsAssetsDeploymentProps.property.staticAssetsBucket">staticAssetsBucket</a></code> | <code>aws-cdk-lib.aws_s3.Bucket</code> | Required for `NextjsType.GlobalFunctions` and `NextjsType.GlobalContainers`. |
| <code><a href="#cdk-nextjs.OptionalNextjsAssetsDeploymentProps.property.vpc">vpc</a></code> | <code>aws-cdk-lib.aws_ec2.IVpc</code> | *No description.* |

---

##### `accessPoint`<sup>Optional</sup> <a name="accessPoint" id="cdk-nextjs.OptionalNextjsAssetsDeploymentProps.property.accessPoint"></a>

```typescript
public readonly accessPoint: AccessPoint;
```

- *Type:* aws-cdk-lib.aws_efs.AccessPoint

---

##### `buildImageDigest`<sup>Optional</sup> <a name="buildImageDigest" id="cdk-nextjs.OptionalNextjsAssetsDeploymentProps.property.buildImageDigest"></a>

```typescript
public readonly buildImageDigest: string;
```

- *Type:* string

---

##### `containerMountPathForEfs`<sup>Optional</sup> <a name="containerMountPathForEfs" id="cdk-nextjs.OptionalNextjsAssetsDeploymentProps.property.containerMountPathForEfs"></a>

```typescript
public readonly containerMountPathForEfs: string;
```

- *Type:* string

---

##### `debug`<sup>Optional</sup> <a name="debug" id="cdk-nextjs.OptionalNextjsAssetsDeploymentProps.property.debug"></a>

```typescript
public readonly debug: boolean;
```

- *Type:* boolean
- *Default:* true

---

##### `dockerImageCode`<sup>Optional</sup> <a name="dockerImageCode" id="cdk-nextjs.OptionalNextjsAssetsDeploymentProps.property.dockerImageCode"></a>

```typescript
public readonly dockerImageCode: DockerImageCode;
```

- *Type:* aws-cdk-lib.aws_lambda.DockerImageCode

---

##### `overrides`<sup>Optional</sup> <a name="overrides" id="cdk-nextjs.OptionalNextjsAssetsDeploymentProps.property.overrides"></a>

```typescript
public readonly overrides: NextjsAssetDeploymentOverrides;
```

- *Type:* <a href="#cdk-nextjs.NextjsAssetDeploymentOverrides">NextjsAssetDeploymentOverrides</a>

---

##### `relativePathToWorkspace`<sup>Optional</sup> <a name="relativePathToWorkspace" id="cdk-nextjs.OptionalNextjsAssetsDeploymentProps.property.relativePathToWorkspace"></a>

```typescript
public readonly relativePathToWorkspace: string;
```

- *Type:* string

---

##### `staticAssetsBucket`<sup>Optional</sup> <a name="staticAssetsBucket" id="cdk-nextjs.OptionalNextjsAssetsDeploymentProps.property.staticAssetsBucket"></a>

```typescript
public readonly staticAssetsBucket: Bucket;
```

- *Type:* aws-cdk-lib.aws_s3.Bucket

Required for `NextjsType.GlobalFunctions` and `NextjsType.GlobalContainers`.

---

##### `vpc`<sup>Optional</sup> <a name="vpc" id="cdk-nextjs.OptionalNextjsAssetsDeploymentProps.property.vpc"></a>

```typescript
public readonly vpc: IVpc;
```

- *Type:* aws-cdk-lib.aws_ec2.IVpc

---

### OptionalNextjsBuildProps <a name="OptionalNextjsBuildProps" id="cdk-nextjs.OptionalNextjsBuildProps"></a>

OptionalNextjsBuildProps.

#### Initializer <a name="Initializer" id="cdk-nextjs.OptionalNextjsBuildProps.Initializer"></a>

```typescript
import { OptionalNextjsBuildProps } from 'cdk-nextjs'

const optionalNextjsBuildProps: OptionalNextjsBuildProps = { ... }
```

#### Properties <a name="Properties" id="Properties"></a>

| **Name** | **Type** | **Description** |
| --- | --- | --- |
| <code><a href="#cdk-nextjs.OptionalNextjsBuildProps.property.buildCommand">buildCommand</a></code> | <code>string</code> | *No description.* |
| <code><a href="#cdk-nextjs.OptionalNextjsBuildProps.property.buildContext">buildContext</a></code> | <code>string</code> | *No description.* |
| <code><a href="#cdk-nextjs.OptionalNextjsBuildProps.property.builderImageProps">builderImageProps</a></code> | <code><a href="#cdk-nextjs.BuilderImageProps">BuilderImageProps</a></code> | *No description.* |
| <code><a href="#cdk-nextjs.OptionalNextjsBuildProps.property.nextjsType">nextjsType</a></code> | <code><a href="#cdk-nextjs.NextjsType">NextjsType</a></code> | *No description.* |
| <code><a href="#cdk-nextjs.OptionalNextjsBuildProps.property.overrides">overrides</a></code> | <code><a href="#cdk-nextjs.NextjsBuildOverrides">NextjsBuildOverrides</a></code> | *No description.* |
| <code><a href="#cdk-nextjs.OptionalNextjsBuildProps.property.relativePathToWorkspace">relativePathToWorkspace</a></code> | <code>string</code> | *No description.* |

---

##### `buildCommand`<sup>Optional</sup> <a name="buildCommand" id="cdk-nextjs.OptionalNextjsBuildProps.property.buildCommand"></a>

```typescript
public readonly buildCommand: string;
```

- *Type:* string

---

##### `buildContext`<sup>Optional</sup> <a name="buildContext" id="cdk-nextjs.OptionalNextjsBuildProps.property.buildContext"></a>

```typescript
public readonly buildContext: string;
```

- *Type:* string

---

##### `builderImageProps`<sup>Optional</sup> <a name="builderImageProps" id="cdk-nextjs.OptionalNextjsBuildProps.property.builderImageProps"></a>

```typescript
public readonly builderImageProps: BuilderImageProps;
```

- *Type:* <a href="#cdk-nextjs.BuilderImageProps">BuilderImageProps</a>

---

##### `nextjsType`<sup>Optional</sup> <a name="nextjsType" id="cdk-nextjs.OptionalNextjsBuildProps.property.nextjsType"></a>

```typescript
public readonly nextjsType: NextjsType;
```

- *Type:* <a href="#cdk-nextjs.NextjsType">NextjsType</a>

---

##### `overrides`<sup>Optional</sup> <a name="overrides" id="cdk-nextjs.OptionalNextjsBuildProps.property.overrides"></a>

```typescript
public readonly overrides: NextjsBuildOverrides;
```

- *Type:* <a href="#cdk-nextjs.NextjsBuildOverrides">NextjsBuildOverrides</a>

---

##### `relativePathToWorkspace`<sup>Optional</sup> <a name="relativePathToWorkspace" id="cdk-nextjs.OptionalNextjsBuildProps.property.relativePathToWorkspace"></a>

```typescript
public readonly relativePathToWorkspace: string;
```

- *Type:* string

---

### OptionalNextjsContainersProps <a name="OptionalNextjsContainersProps" id="cdk-nextjs.OptionalNextjsContainersProps"></a>

OptionalNextjsContainersProps.

#### Initializer <a name="Initializer" id="cdk-nextjs.OptionalNextjsContainersProps.Initializer"></a>

```typescript
import { OptionalNextjsContainersProps } from 'cdk-nextjs'

const optionalNextjsContainersProps: OptionalNextjsContainersProps = { ... }
```

#### Properties <a name="Properties" id="Properties"></a>

| **Name** | **Type** | **Description** |
| --- | --- | --- |
| <code><a href="#cdk-nextjs.OptionalNextjsContainersProps.property.accessPoint">accessPoint</a></code> | <code>aws-cdk-lib.aws_efs.AccessPoint</code> | *No description.* |
| <code><a href="#cdk-nextjs.OptionalNextjsContainersProps.property.containerMountPathForEfs">containerMountPathForEfs</a></code> | <code>string</code> | *No description.* |
| <code><a href="#cdk-nextjs.OptionalNextjsContainersProps.property.dockerImageAsset">dockerImageAsset</a></code> | <code>aws-cdk-lib.aws_ecr_assets.DockerImageAsset</code> | *No description.* |
| <code><a href="#cdk-nextjs.OptionalNextjsContainersProps.property.fileSystem">fileSystem</a></code> | <code>aws-cdk-lib.aws_efs.FileSystem</code> | *No description.* |
| <code><a href="#cdk-nextjs.OptionalNextjsContainersProps.property.healthCheckPath">healthCheckPath</a></code> | <code>string</code> | *No description.* |
| <code><a href="#cdk-nextjs.OptionalNextjsContainersProps.property.nextjsType">nextjsType</a></code> | <code><a href="#cdk-nextjs.NextjsType">NextjsType</a></code> | *No description.* |
| <code><a href="#cdk-nextjs.OptionalNextjsContainersProps.property.overrides">overrides</a></code> | <code><a href="#cdk-nextjs.NextjsContainersOverrides">NextjsContainersOverrides</a></code> | *No description.* |
| <code><a href="#cdk-nextjs.OptionalNextjsContainersProps.property.relativeEntrypointPath">relativeEntrypointPath</a></code> | <code>string</code> | *No description.* |
| <code><a href="#cdk-nextjs.OptionalNextjsContainersProps.property.vpc">vpc</a></code> | <code>aws-cdk-lib.aws_ec2.IVpc</code> | *No description.* |

---

##### `accessPoint`<sup>Optional</sup> <a name="accessPoint" id="cdk-nextjs.OptionalNextjsContainersProps.property.accessPoint"></a>

```typescript
public readonly accessPoint: AccessPoint;
```

- *Type:* aws-cdk-lib.aws_efs.AccessPoint

---

##### `containerMountPathForEfs`<sup>Optional</sup> <a name="containerMountPathForEfs" id="cdk-nextjs.OptionalNextjsContainersProps.property.containerMountPathForEfs"></a>

```typescript
public readonly containerMountPathForEfs: string;
```

- *Type:* string

---

##### `dockerImageAsset`<sup>Optional</sup> <a name="dockerImageAsset" id="cdk-nextjs.OptionalNextjsContainersProps.property.dockerImageAsset"></a>

```typescript
public readonly dockerImageAsset: DockerImageAsset;
```

- *Type:* aws-cdk-lib.aws_ecr_assets.DockerImageAsset

---

##### `fileSystem`<sup>Optional</sup> <a name="fileSystem" id="cdk-nextjs.OptionalNextjsContainersProps.property.fileSystem"></a>

```typescript
public readonly fileSystem: FileSystem;
```

- *Type:* aws-cdk-lib.aws_efs.FileSystem

---

##### `healthCheckPath`<sup>Optional</sup> <a name="healthCheckPath" id="cdk-nextjs.OptionalNextjsContainersProps.property.healthCheckPath"></a>

```typescript
public readonly healthCheckPath: string;
```

- *Type:* string

---

##### `nextjsType`<sup>Optional</sup> <a name="nextjsType" id="cdk-nextjs.OptionalNextjsContainersProps.property.nextjsType"></a>

```typescript
public readonly nextjsType: NextjsType;
```

- *Type:* <a href="#cdk-nextjs.NextjsType">NextjsType</a>

---

##### `overrides`<sup>Optional</sup> <a name="overrides" id="cdk-nextjs.OptionalNextjsContainersProps.property.overrides"></a>

```typescript
public readonly overrides: NextjsContainersOverrides;
```

- *Type:* <a href="#cdk-nextjs.NextjsContainersOverrides">NextjsContainersOverrides</a>

---

##### `relativeEntrypointPath`<sup>Optional</sup> <a name="relativeEntrypointPath" id="cdk-nextjs.OptionalNextjsContainersProps.property.relativeEntrypointPath"></a>

```typescript
public readonly relativeEntrypointPath: string;
```

- *Type:* string

---

##### `vpc`<sup>Optional</sup> <a name="vpc" id="cdk-nextjs.OptionalNextjsContainersProps.property.vpc"></a>

```typescript
public readonly vpc: IVpc;
```

- *Type:* aws-cdk-lib.aws_ec2.IVpc

---

### OptionalNextjsDistributionProps <a name="OptionalNextjsDistributionProps" id="cdk-nextjs.OptionalNextjsDistributionProps"></a>

OptionalNextjsDistributionProps.

#### Initializer <a name="Initializer" id="cdk-nextjs.OptionalNextjsDistributionProps.Initializer"></a>

```typescript
import { OptionalNextjsDistributionProps } from 'cdk-nextjs'

const optionalNextjsDistributionProps: OptionalNextjsDistributionProps = { ... }
```

#### Properties <a name="Properties" id="Properties"></a>

| **Name** | **Type** | **Description** |
| --- | --- | --- |
| <code><a href="#cdk-nextjs.OptionalNextjsDistributionProps.property.assetsBucket">assetsBucket</a></code> | <code>aws-cdk-lib.aws_s3.IBucket</code> | Bucket containing static assets. |
| <code><a href="#cdk-nextjs.OptionalNextjsDistributionProps.property.basePath">basePath</a></code> | <code>string</code> | *No description.* |
| <code><a href="#cdk-nextjs.OptionalNextjsDistributionProps.property.certificate">certificate</a></code> | <code>aws-cdk-lib.aws_certificatemanager.ICertificate</code> | Optional but only applicable for `NextjsType.GLOBAL_CONTAINERS`. |
| <code><a href="#cdk-nextjs.OptionalNextjsDistributionProps.property.distribution">distribution</a></code> | <code>aws-cdk-lib.aws_cloudfront.Distribution</code> | *No description.* |
| <code><a href="#cdk-nextjs.OptionalNextjsDistributionProps.property.dynamicUrl">dynamicUrl</a></code> | <code>string</code> | Dynamic (Next.js server) URL to add behavior to distribution. |
| <code><a href="#cdk-nextjs.OptionalNextjsDistributionProps.property.functionArn">functionArn</a></code> | <code>string</code> | Required if `NextjsType.GLOBAL_FUNCTIONS`. |
| <code><a href="#cdk-nextjs.OptionalNextjsDistributionProps.property.nextjsType">nextjsType</a></code> | <code><a href="#cdk-nextjs.NextjsType">NextjsType</a></code> | *No description.* |
| <code><a href="#cdk-nextjs.OptionalNextjsDistributionProps.property.overrides">overrides</a></code> | <code><a href="#cdk-nextjs.NextjsDistributionOverrides">NextjsDistributionOverrides</a></code> | Override props for every construct. |
| <code><a href="#cdk-nextjs.OptionalNextjsDistributionProps.property.publicDirEntries">publicDirEntries</a></code> | <code><a href="#cdk-nextjs.PublicDirEntry">PublicDirEntry</a>[]</code> | Path to directory of Next.js app's public directory. Used to add static behaviors to distribution. |

---

##### `assetsBucket`<sup>Optional</sup> <a name="assetsBucket" id="cdk-nextjs.OptionalNextjsDistributionProps.property.assetsBucket"></a>

```typescript
public readonly assetsBucket: IBucket;
```

- *Type:* aws-cdk-lib.aws_s3.IBucket

Bucket containing static assets.

Must be provided if you want to serve static files.

---

##### `basePath`<sup>Optional</sup> <a name="basePath" id="cdk-nextjs.OptionalNextjsDistributionProps.property.basePath"></a>

```typescript
public readonly basePath: string;
```

- *Type:* string

---

##### `certificate`<sup>Optional</sup> <a name="certificate" id="cdk-nextjs.OptionalNextjsDistributionProps.property.certificate"></a>

```typescript
public readonly certificate: ICertificate;
```

- *Type:* aws-cdk-lib.aws_certificatemanager.ICertificate

Optional but only applicable for `NextjsType.GLOBAL_CONTAINERS`.

---

##### `distribution`<sup>Optional</sup> <a name="distribution" id="cdk-nextjs.OptionalNextjsDistributionProps.property.distribution"></a>

```typescript
public readonly distribution: Distribution;
```

- *Type:* aws-cdk-lib.aws_cloudfront.Distribution

---

##### `dynamicUrl`<sup>Optional</sup> <a name="dynamicUrl" id="cdk-nextjs.OptionalNextjsDistributionProps.property.dynamicUrl"></a>

```typescript
public readonly dynamicUrl: string;
```

- *Type:* string

Dynamic (Next.js server) URL to add behavior to distribution.

---

##### `functionArn`<sup>Optional</sup> <a name="functionArn" id="cdk-nextjs.OptionalNextjsDistributionProps.property.functionArn"></a>

```typescript
public readonly functionArn: string;
```

- *Type:* string

Required if `NextjsType.GLOBAL_FUNCTIONS`.

---

##### `nextjsType`<sup>Optional</sup> <a name="nextjsType" id="cdk-nextjs.OptionalNextjsDistributionProps.property.nextjsType"></a>

```typescript
public readonly nextjsType: NextjsType;
```

- *Type:* <a href="#cdk-nextjs.NextjsType">NextjsType</a>

---

##### `overrides`<sup>Optional</sup> <a name="overrides" id="cdk-nextjs.OptionalNextjsDistributionProps.property.overrides"></a>

```typescript
public readonly overrides: NextjsDistributionOverrides;
```

- *Type:* <a href="#cdk-nextjs.NextjsDistributionOverrides">NextjsDistributionOverrides</a>

Override props for every construct.

---

##### `publicDirEntries`<sup>Optional</sup> <a name="publicDirEntries" id="cdk-nextjs.OptionalNextjsDistributionProps.property.publicDirEntries"></a>

```typescript
public readonly publicDirEntries: PublicDirEntry[];
```

- *Type:* <a href="#cdk-nextjs.PublicDirEntry">PublicDirEntry</a>[]

Path to directory of Next.js app's public directory. Used to add static behaviors to distribution.

---

### OptionalNextjsFileSystemProps <a name="OptionalNextjsFileSystemProps" id="cdk-nextjs.OptionalNextjsFileSystemProps"></a>

OptionalNextjsFileSystemProps.

#### Initializer <a name="Initializer" id="cdk-nextjs.OptionalNextjsFileSystemProps.Initializer"></a>

```typescript
import { OptionalNextjsFileSystemProps } from 'cdk-nextjs'

const optionalNextjsFileSystemProps: OptionalNextjsFileSystemProps = { ... }
```

#### Properties <a name="Properties" id="Properties"></a>

| **Name** | **Type** | **Description** |
| --- | --- | --- |
| <code><a href="#cdk-nextjs.OptionalNextjsFileSystemProps.property.overrides">overrides</a></code> | <code><a href="#cdk-nextjs.NextjsFileSystemOverrides">NextjsFileSystemOverrides</a></code> | *No description.* |
| <code><a href="#cdk-nextjs.OptionalNextjsFileSystemProps.property.vpc">vpc</a></code> | <code>aws-cdk-lib.aws_ec2.IVpc</code> | *No description.* |

---

##### `overrides`<sup>Optional</sup> <a name="overrides" id="cdk-nextjs.OptionalNextjsFileSystemProps.property.overrides"></a>

```typescript
public readonly overrides: NextjsFileSystemOverrides;
```

- *Type:* <a href="#cdk-nextjs.NextjsFileSystemOverrides">NextjsFileSystemOverrides</a>

---

##### `vpc`<sup>Optional</sup> <a name="vpc" id="cdk-nextjs.OptionalNextjsFileSystemProps.property.vpc"></a>

```typescript
public readonly vpc: IVpc;
```

- *Type:* aws-cdk-lib.aws_ec2.IVpc

---

### OptionalNextjsInvalidationProps <a name="OptionalNextjsInvalidationProps" id="cdk-nextjs.OptionalNextjsInvalidationProps"></a>

OptionalNextjsInvalidationProps.

#### Initializer <a name="Initializer" id="cdk-nextjs.OptionalNextjsInvalidationProps.Initializer"></a>

```typescript
import { OptionalNextjsInvalidationProps } from 'cdk-nextjs'

const optionalNextjsInvalidationProps: OptionalNextjsInvalidationProps = { ... }
```

#### Properties <a name="Properties" id="Properties"></a>

| **Name** | **Type** | **Description** |
| --- | --- | --- |
| <code><a href="#cdk-nextjs.OptionalNextjsInvalidationProps.property.distribution">distribution</a></code> | <code>aws-cdk-lib.aws_cloudfront.IDistribution</code> | CloudFront Distribution to invalidate. |
| <code><a href="#cdk-nextjs.OptionalNextjsInvalidationProps.property.overrides">overrides</a></code> | <code><a href="#cdk-nextjs.NextjsInvalidationOverrides">NextjsInvalidationOverrides</a></code> | Override props for every construct. |

---

##### `distribution`<sup>Optional</sup> <a name="distribution" id="cdk-nextjs.OptionalNextjsInvalidationProps.property.distribution"></a>

```typescript
public readonly distribution: IDistribution;
```

- *Type:* aws-cdk-lib.aws_cloudfront.IDistribution

CloudFront Distribution to invalidate.

---

##### `overrides`<sup>Optional</sup> <a name="overrides" id="cdk-nextjs.OptionalNextjsInvalidationProps.property.overrides"></a>

```typescript
public readonly overrides: NextjsInvalidationOverrides;
```

- *Type:* <a href="#cdk-nextjs.NextjsInvalidationOverrides">NextjsInvalidationOverrides</a>

Override props for every construct.

---

### OptionalNextjsVpcProps <a name="OptionalNextjsVpcProps" id="cdk-nextjs.OptionalNextjsVpcProps"></a>

OptionalNextjsVpcProps.

#### Initializer <a name="Initializer" id="cdk-nextjs.OptionalNextjsVpcProps.Initializer"></a>

```typescript
import { OptionalNextjsVpcProps } from 'cdk-nextjs'

const optionalNextjsVpcProps: OptionalNextjsVpcProps = { ... }
```

#### Properties <a name="Properties" id="Properties"></a>

| **Name** | **Type** | **Description** |
| --- | --- | --- |
| <code><a href="#cdk-nextjs.OptionalNextjsVpcProps.property.nextjsType">nextjsType</a></code> | <code><a href="#cdk-nextjs.NextjsType">NextjsType</a></code> | *No description.* |
| <code><a href="#cdk-nextjs.OptionalNextjsVpcProps.property.overrides">overrides</a></code> | <code><a href="#cdk-nextjs.NextjsVpcOverrides">NextjsVpcOverrides</a></code> | Override any construct. |
| <code><a href="#cdk-nextjs.OptionalNextjsVpcProps.property.vpc">vpc</a></code> | <code>aws-cdk-lib.aws_ec2.IVpc</code> | Bring your own VPC. |

---

##### `nextjsType`<sup>Optional</sup> <a name="nextjsType" id="cdk-nextjs.OptionalNextjsVpcProps.property.nextjsType"></a>

```typescript
public readonly nextjsType: NextjsType;
```

- *Type:* <a href="#cdk-nextjs.NextjsType">NextjsType</a>

---

##### `overrides`<sup>Optional</sup> <a name="overrides" id="cdk-nextjs.OptionalNextjsVpcProps.property.overrides"></a>

```typescript
public readonly overrides: NextjsVpcOverrides;
```

- *Type:* <a href="#cdk-nextjs.NextjsVpcOverrides">NextjsVpcOverrides</a>

Override any construct.

---

##### `vpc`<sup>Optional</sup> <a name="vpc" id="cdk-nextjs.OptionalNextjsVpcProps.property.vpc"></a>

```typescript
public readonly vpc: IVpc;
```

- *Type:* aws-cdk-lib.aws_ec2.IVpc

Bring your own VPC.

---

### OptionalS3OriginProps <a name="OptionalS3OriginProps" id="cdk-nextjs.OptionalS3OriginProps"></a>

OptionalS3OriginProps.

#### Initializer <a name="Initializer" id="cdk-nextjs.OptionalS3OriginProps.Initializer"></a>

```typescript
import { OptionalS3OriginProps } from 'cdk-nextjs'

const optionalS3OriginProps: OptionalS3OriginProps = { ... }
```

#### Properties <a name="Properties" id="Properties"></a>

| **Name** | **Type** | **Description** |
| --- | --- | --- |
| <code><a href="#cdk-nextjs.OptionalS3OriginProps.property.connectionAttempts">connectionAttempts</a></code> | <code>number</code> | The number of times that CloudFront attempts to connect to the origin; |
| <code><a href="#cdk-nextjs.OptionalS3OriginProps.property.connectionTimeout">connectionTimeout</a></code> | <code>aws-cdk-lib.Duration</code> | The number of seconds that CloudFront waits when trying to establish a connection to the origin. |
| <code><a href="#cdk-nextjs.OptionalS3OriginProps.property.customHeaders">customHeaders</a></code> | <code>{[ key: string ]: string}</code> | A list of HTTP header names and values that CloudFront adds to requests it sends to the origin. |
| <code><a href="#cdk-nextjs.OptionalS3OriginProps.property.originAccessIdentity">originAccessIdentity</a></code> | <code>aws-cdk-lib.aws_cloudfront.IOriginAccessIdentity</code> | An optional Origin Access Identity of the origin identity cloudfront will use when calling your s3 bucket. |
| <code><a href="#cdk-nextjs.OptionalS3OriginProps.property.originId">originId</a></code> | <code>string</code> | A unique identifier for the origin. |
| <code><a href="#cdk-nextjs.OptionalS3OriginProps.property.originPath">originPath</a></code> | <code>string</code> | An optional path that CloudFront appends to the origin domain name when CloudFront requests content from the origin. |
| <code><a href="#cdk-nextjs.OptionalS3OriginProps.property.originShieldEnabled">originShieldEnabled</a></code> | <code>boolean</code> | Origin Shield is enabled by setting originShieldRegion to a valid region, after this to disable Origin Shield again you must set this flag to false. |
| <code><a href="#cdk-nextjs.OptionalS3OriginProps.property.originShieldRegion">originShieldRegion</a></code> | <code>string</code> | When you enable Origin Shield in the AWS Region that has the lowest latency to your origin, you can get better network performance. |

---

##### `connectionAttempts`<sup>Optional</sup> <a name="connectionAttempts" id="cdk-nextjs.OptionalS3OriginProps.property.connectionAttempts"></a>

```typescript
public readonly connectionAttempts: number;
```

- *Type:* number
- *Default:* 3

The number of times that CloudFront attempts to connect to the origin;

valid values are 1, 2, or 3 attempts.

---

##### `connectionTimeout`<sup>Optional</sup> <a name="connectionTimeout" id="cdk-nextjs.OptionalS3OriginProps.property.connectionTimeout"></a>

```typescript
public readonly connectionTimeout: Duration;
```

- *Type:* aws-cdk-lib.Duration
- *Default:* Duration.seconds(10)

The number of seconds that CloudFront waits when trying to establish a connection to the origin.

Valid values are 1-10 seconds, inclusive.

---

##### `customHeaders`<sup>Optional</sup> <a name="customHeaders" id="cdk-nextjs.OptionalS3OriginProps.property.customHeaders"></a>

```typescript
public readonly customHeaders: {[ key: string ]: string};
```

- *Type:* {[ key: string ]: string}
- *Default:* {}

A list of HTTP header names and values that CloudFront adds to requests it sends to the origin.

---

##### `originAccessIdentity`<sup>Optional</sup> <a name="originAccessIdentity" id="cdk-nextjs.OptionalS3OriginProps.property.originAccessIdentity"></a>

```typescript
public readonly originAccessIdentity: IOriginAccessIdentity;
```

- *Type:* aws-cdk-lib.aws_cloudfront.IOriginAccessIdentity
- *Default:* An Origin Access Identity will be created.

An optional Origin Access Identity of the origin identity cloudfront will use when calling your s3 bucket.

---

##### `originId`<sup>Optional</sup> <a name="originId" id="cdk-nextjs.OptionalS3OriginProps.property.originId"></a>

```typescript
public readonly originId: string;
```

- *Type:* string
- *Default:* an originid will be generated for you

A unique identifier for the origin.

This value must be unique within the distribution.

---

##### `originPath`<sup>Optional</sup> <a name="originPath" id="cdk-nextjs.OptionalS3OriginProps.property.originPath"></a>

```typescript
public readonly originPath: string;
```

- *Type:* string
- *Default:* '/'

An optional path that CloudFront appends to the origin domain name when CloudFront requests content from the origin.

Must begin, but not end, with '/' (e.g., '/production/images').

---

##### `originShieldEnabled`<sup>Optional</sup> <a name="originShieldEnabled" id="cdk-nextjs.OptionalS3OriginProps.property.originShieldEnabled"></a>

```typescript
public readonly originShieldEnabled: boolean;
```

- *Type:* boolean
- *Default:* true

Origin Shield is enabled by setting originShieldRegion to a valid region, after this to disable Origin Shield again you must set this flag to false.

---

##### `originShieldRegion`<sup>Optional</sup> <a name="originShieldRegion" id="cdk-nextjs.OptionalS3OriginProps.property.originShieldRegion"></a>

```typescript
public readonly originShieldRegion: string;
```

- *Type:* string
- *Default:* origin shield not enabled

When you enable Origin Shield in the AWS Region that has the lowest latency to your origin, you can get better network performance.

---

### OptionalVpcProps <a name="OptionalVpcProps" id="cdk-nextjs.OptionalVpcProps"></a>

OptionalVpcProps.

#### Initializer <a name="Initializer" id="cdk-nextjs.OptionalVpcProps.Initializer"></a>

```typescript
import { OptionalVpcProps } from 'cdk-nextjs'

const optionalVpcProps: OptionalVpcProps = { ... }
```

#### Properties <a name="Properties" id="Properties"></a>

| **Name** | **Type** | **Description** |
| --- | --- | --- |
| <code><a href="#cdk-nextjs.OptionalVpcProps.property.availabilityZones">availabilityZones</a></code> | <code>string[]</code> | Availability zones this VPC spans. |
| <code><a href="#cdk-nextjs.OptionalVpcProps.property.cidr">cidr</a></code> | <code>string</code> | The CIDR range to use for the VPC, e.g. '10.0.0.0/16'. Should be a minimum of /28 and maximum size of /16. The range will be split across all subnets per Availability Zone. |
| <code><a href="#cdk-nextjs.OptionalVpcProps.property.createInternetGateway">createInternetGateway</a></code> | <code>boolean</code> | If set to false then disable the creation of the default internet gateway. |
| <code><a href="#cdk-nextjs.OptionalVpcProps.property.defaultInstanceTenancy">defaultInstanceTenancy</a></code> | <code>aws-cdk-lib.aws_ec2.DefaultInstanceTenancy</code> | The default tenancy of instances launched into the VPC. |
| <code><a href="#cdk-nextjs.OptionalVpcProps.property.enableDnsHostnames">enableDnsHostnames</a></code> | <code>boolean</code> | Indicates whether the instances launched in the VPC get public DNS hostnames. |
| <code><a href="#cdk-nextjs.OptionalVpcProps.property.enableDnsSupport">enableDnsSupport</a></code> | <code>boolean</code> | Indicates whether the DNS resolution is supported for the VPC. |
| <code><a href="#cdk-nextjs.OptionalVpcProps.property.flowLogs">flowLogs</a></code> | <code>{[ key: string ]: aws-cdk-lib.aws_ec2.FlowLogOptions}</code> | Flow logs to add to this VPC. |
| <code><a href="#cdk-nextjs.OptionalVpcProps.property.gatewayEndpoints">gatewayEndpoints</a></code> | <code>{[ key: string ]: aws-cdk-lib.aws_ec2.GatewayVpcEndpointOptions}</code> | Gateway endpoints to add to this VPC. |
| <code><a href="#cdk-nextjs.OptionalVpcProps.property.ipAddresses">ipAddresses</a></code> | <code>aws-cdk-lib.aws_ec2.IIpAddresses</code> | The Provider to use to allocate IPv4 Space to your VPC. Options include static allocation or from a pool. |
| <code><a href="#cdk-nextjs.OptionalVpcProps.property.ipProtocol">ipProtocol</a></code> | <code>aws-cdk-lib.aws_ec2.IpProtocol</code> | The protocol of the vpc. |
| <code><a href="#cdk-nextjs.OptionalVpcProps.property.ipv6Addresses">ipv6Addresses</a></code> | <code>aws-cdk-lib.aws_ec2.IIpv6Addresses</code> | The Provider to use to allocate IPv6 Space to your VPC. Options include amazon provided CIDR block. |
| <code><a href="#cdk-nextjs.OptionalVpcProps.property.maxAzs">maxAzs</a></code> | <code>number</code> | Define the maximum number of AZs to use in this region. |
| <code><a href="#cdk-nextjs.OptionalVpcProps.property.natGatewayProvider">natGatewayProvider</a></code> | <code>aws-cdk-lib.aws_ec2.NatProvider</code> | What type of NAT provider to use. |
| <code><a href="#cdk-nextjs.OptionalVpcProps.property.natGateways">natGateways</a></code> | <code>number</code> | The number of NAT Gateways/Instances to create. The type of NAT gateway or instance will be determined by the `natGatewayProvider` parameter. |
| <code><a href="#cdk-nextjs.OptionalVpcProps.property.natGatewaySubnets">natGatewaySubnets</a></code> | <code>aws-cdk-lib.aws_ec2.SubnetSelection</code> | Configures the subnets which will have NAT Gateways/Instances. |
| <code><a href="#cdk-nextjs.OptionalVpcProps.property.reservedAzs">reservedAzs</a></code> | <code>number</code> | Define the number of AZs to reserve. |
| <code><a href="#cdk-nextjs.OptionalVpcProps.property.restrictDefaultSecurityGroup">restrictDefaultSecurityGroup</a></code> | <code>boolean</code> | If set to true then the default inbound & outbound rules will be removed from the default security group. |
| <code><a href="#cdk-nextjs.OptionalVpcProps.property.subnetConfiguration">subnetConfiguration</a></code> | <code>aws-cdk-lib.aws_ec2.SubnetConfiguration[]</code> | Configure the subnets to build for each AZ. |
| <code><a href="#cdk-nextjs.OptionalVpcProps.property.vpcName">vpcName</a></code> | <code>string</code> | The VPC name. |
| <code><a href="#cdk-nextjs.OptionalVpcProps.property.vpnConnections">vpnConnections</a></code> | <code>{[ key: string ]: aws-cdk-lib.aws_ec2.VpnConnectionOptions}</code> | VPN connections to this VPC. |
| <code><a href="#cdk-nextjs.OptionalVpcProps.property.vpnGateway">vpnGateway</a></code> | <code>boolean</code> | Indicates whether a VPN gateway should be created and attached to this VPC. |
| <code><a href="#cdk-nextjs.OptionalVpcProps.property.vpnGatewayAsn">vpnGatewayAsn</a></code> | <code>number</code> | The private Autonomous System Number (ASN) for the VPN gateway. |
| <code><a href="#cdk-nextjs.OptionalVpcProps.property.vpnRoutePropagation">vpnRoutePropagation</a></code> | <code>aws-cdk-lib.aws_ec2.SubnetSelection[]</code> | Where to propagate VPN routes. |

---

##### `availabilityZones`<sup>Optional</sup> <a name="availabilityZones" id="cdk-nextjs.OptionalVpcProps.property.availabilityZones"></a>

```typescript
public readonly availabilityZones: string[];
```

- *Type:* string[]
- *Default:* a subset of AZs of the stack

Availability zones this VPC spans.

Specify this option only if you do not specify `maxAzs`.

---

##### ~~`cidr`~~<sup>Optional</sup> <a name="cidr" id="cdk-nextjs.OptionalVpcProps.property.cidr"></a>

- *Deprecated:* Use ipAddresses instead

```typescript
public readonly cidr: string;
```

- *Type:* string
- *Default:* Vpc.DEFAULT_CIDR_RANGE

The CIDR range to use for the VPC, e.g. '10.0.0.0/16'. Should be a minimum of /28 and maximum size of /16. The range will be split across all subnets per Availability Zone.

---

##### `createInternetGateway`<sup>Optional</sup> <a name="createInternetGateway" id="cdk-nextjs.OptionalVpcProps.property.createInternetGateway"></a>

```typescript
public readonly createInternetGateway: boolean;
```

- *Type:* boolean
- *Default:* true

If set to false then disable the creation of the default internet gateway.

---

##### `defaultInstanceTenancy`<sup>Optional</sup> <a name="defaultInstanceTenancy" id="cdk-nextjs.OptionalVpcProps.property.defaultInstanceTenancy"></a>

```typescript
public readonly defaultInstanceTenancy: DefaultInstanceTenancy;
```

- *Type:* aws-cdk-lib.aws_ec2.DefaultInstanceTenancy
- *Default:* DefaultInstanceTenancy.Default (shared) tenancy

The default tenancy of instances launched into the VPC.

By setting this to dedicated tenancy, instances will be launched on
hardware dedicated to a single AWS customer, unless specifically specified
at instance launch time. Please note, not all instance types are usable
with Dedicated tenancy.

---

##### `enableDnsHostnames`<sup>Optional</sup> <a name="enableDnsHostnames" id="cdk-nextjs.OptionalVpcProps.property.enableDnsHostnames"></a>

```typescript
public readonly enableDnsHostnames: boolean;
```

- *Type:* boolean
- *Default:* true

Indicates whether the instances launched in the VPC get public DNS hostnames.

If this attribute is true, instances in the VPC get public DNS hostnames,
but only if the enableDnsSupport attribute is also set to true.

---

##### `enableDnsSupport`<sup>Optional</sup> <a name="enableDnsSupport" id="cdk-nextjs.OptionalVpcProps.property.enableDnsSupport"></a>

```typescript
public readonly enableDnsSupport: boolean;
```

- *Type:* boolean
- *Default:* true

Indicates whether the DNS resolution is supported for the VPC.

If this attribute is false, the Amazon-provided DNS server in the VPC that
resolves public DNS hostnames to IP addresses is not enabled. If this
attribute is true, queries to the Amazon provided DNS server at the
169.254.169.253 IP address, or the reserved IP address at the base of the
VPC IPv4 network range plus two will succeed.

---

##### `flowLogs`<sup>Optional</sup> <a name="flowLogs" id="cdk-nextjs.OptionalVpcProps.property.flowLogs"></a>

```typescript
public readonly flowLogs: {[ key: string ]: FlowLogOptions};
```

- *Type:* {[ key: string ]: aws-cdk-lib.aws_ec2.FlowLogOptions}
- *Default:* No flow logs.

Flow logs to add to this VPC.

---

##### `gatewayEndpoints`<sup>Optional</sup> <a name="gatewayEndpoints" id="cdk-nextjs.OptionalVpcProps.property.gatewayEndpoints"></a>

```typescript
public readonly gatewayEndpoints: {[ key: string ]: GatewayVpcEndpointOptions};
```

- *Type:* {[ key: string ]: aws-cdk-lib.aws_ec2.GatewayVpcEndpointOptions}
- *Default:* None.

Gateway endpoints to add to this VPC.

---

##### `ipAddresses`<sup>Optional</sup> <a name="ipAddresses" id="cdk-nextjs.OptionalVpcProps.property.ipAddresses"></a>

```typescript
public readonly ipAddresses: IIpAddresses;
```

- *Type:* aws-cdk-lib.aws_ec2.IIpAddresses
- *Default:* ec2.IpAddresses.cidr

The Provider to use to allocate IPv4 Space to your VPC. Options include static allocation or from a pool.

Note this is specific to IPv4 addresses.

---

##### `ipProtocol`<sup>Optional</sup> <a name="ipProtocol" id="cdk-nextjs.OptionalVpcProps.property.ipProtocol"></a>

```typescript
public readonly ipProtocol: IpProtocol;
```

- *Type:* aws-cdk-lib.aws_ec2.IpProtocol
- *Default:* IpProtocol.IPV4_ONLY

The protocol of the vpc.

Options are IPv4 only or dual stack.

---

##### `ipv6Addresses`<sup>Optional</sup> <a name="ipv6Addresses" id="cdk-nextjs.OptionalVpcProps.property.ipv6Addresses"></a>

```typescript
public readonly ipv6Addresses: IIpv6Addresses;
```

- *Type:* aws-cdk-lib.aws_ec2.IIpv6Addresses
- *Default:* Ipv6Addresses.amazonProvided

The Provider to use to allocate IPv6 Space to your VPC. Options include amazon provided CIDR block.

Note this is specific to IPv6 addresses.

---

##### `maxAzs`<sup>Optional</sup> <a name="maxAzs" id="cdk-nextjs.OptionalVpcProps.property.maxAzs"></a>

```typescript
public readonly maxAzs: number;
```

- *Type:* number
- *Default:* 3

Define the maximum number of AZs to use in this region.

If the region has more AZs than you want to use (for example, because of
EIP limits), pick a lower number here. The AZs will be sorted and picked
from the start of the list.

If you pick a higher number than the number of AZs in the region, all AZs
in the region will be selected. To use "all AZs" available to your
account, use a high number (such as 99).

Be aware that environment-agnostic stacks will be created with access to
only 2 AZs, so to use more than 2 AZs, be sure to specify the account and
region on your stack.

Specify this option only if you do not specify `availabilityZones`.

---

##### `natGatewayProvider`<sup>Optional</sup> <a name="natGatewayProvider" id="cdk-nextjs.OptionalVpcProps.property.natGatewayProvider"></a>

```typescript
public readonly natGatewayProvider: NatProvider;
```

- *Type:* aws-cdk-lib.aws_ec2.NatProvider
- *Default:* NatProvider.gateway()

What type of NAT provider to use.

Select between NAT gateways or NAT instances. NAT gateways
may not be available in all AWS regions.

---

##### `natGateways`<sup>Optional</sup> <a name="natGateways" id="cdk-nextjs.OptionalVpcProps.property.natGateways"></a>

```typescript
public readonly natGateways: number;
```

- *Type:* number
- *Default:* One NAT gateway/instance per Availability Zone

The number of NAT Gateways/Instances to create. The type of NAT gateway or instance will be determined by the `natGatewayProvider` parameter.

You can set this number lower than the number of Availability Zones in your
VPC in order to save on NAT cost. Be aware you may be charged for
cross-AZ data traffic instead.

---

##### `natGatewaySubnets`<sup>Optional</sup> <a name="natGatewaySubnets" id="cdk-nextjs.OptionalVpcProps.property.natGatewaySubnets"></a>

```typescript
public readonly natGatewaySubnets: SubnetSelection;
```

- *Type:* aws-cdk-lib.aws_ec2.SubnetSelection
- *Default:* All public subnets.

Configures the subnets which will have NAT Gateways/Instances.

You can pick a specific group of subnets by specifying the group name;
the picked subnets must be public subnets.

Only necessary if you have more than one public subnet group.

---

##### `reservedAzs`<sup>Optional</sup> <a name="reservedAzs" id="cdk-nextjs.OptionalVpcProps.property.reservedAzs"></a>

```typescript
public readonly reservedAzs: number;
```

- *Type:* number
- *Default:* 0

Define the number of AZs to reserve.

When specified, the IP space is reserved for the azs but no actual
resources are provisioned.

---

##### `restrictDefaultSecurityGroup`<sup>Optional</sup> <a name="restrictDefaultSecurityGroup" id="cdk-nextjs.OptionalVpcProps.property.restrictDefaultSecurityGroup"></a>

```typescript
public readonly restrictDefaultSecurityGroup: boolean;
```

- *Type:* boolean
- *Default:* true if '@aws-cdk/aws-ec2:restrictDefaultSecurityGroup' is enabled, false otherwise

If set to true then the default inbound & outbound rules will be removed from the default security group.

---

##### `subnetConfiguration`<sup>Optional</sup> <a name="subnetConfiguration" id="cdk-nextjs.OptionalVpcProps.property.subnetConfiguration"></a>

```typescript
public readonly subnetConfiguration: SubnetConfiguration[];
```

- *Type:* aws-cdk-lib.aws_ec2.SubnetConfiguration[]
- *Default:* The VPC CIDR will be evenly divided between 1 public and 1 private subnet per AZ.

Configure the subnets to build for each AZ.

Each entry in this list configures a Subnet Group; each group will contain a
subnet for each Availability Zone.

For example, if you want 1 public subnet, 1 private subnet, and 1 isolated
subnet in each AZ provide the following:

```ts
new ec2.Vpc(this, 'VPC', {
  subnetConfiguration: [
     {
       cidrMask: 24,
       name: 'ingress',
       subnetType: ec2.SubnetType.PUBLIC,
     },
     {
       cidrMask: 24,
       name: 'application',
       subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
     },
     {
       cidrMask: 28,
       name: 'rds',
       subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
     }
  ]
});
```

---

##### `vpcName`<sup>Optional</sup> <a name="vpcName" id="cdk-nextjs.OptionalVpcProps.property.vpcName"></a>

```typescript
public readonly vpcName: string;
```

- *Type:* string
- *Default:* this.node.path

The VPC name.

Since the VPC resource doesn't support providing a physical name, the value provided here will be recorded in the `Name` tag

---

##### `vpnConnections`<sup>Optional</sup> <a name="vpnConnections" id="cdk-nextjs.OptionalVpcProps.property.vpnConnections"></a>

```typescript
public readonly vpnConnections: {[ key: string ]: VpnConnectionOptions};
```

- *Type:* {[ key: string ]: aws-cdk-lib.aws_ec2.VpnConnectionOptions}
- *Default:* No connections.

VPN connections to this VPC.

---

##### `vpnGateway`<sup>Optional</sup> <a name="vpnGateway" id="cdk-nextjs.OptionalVpcProps.property.vpnGateway"></a>

```typescript
public readonly vpnGateway: boolean;
```

- *Type:* boolean
- *Default:* true when vpnGatewayAsn or vpnConnections is specified

Indicates whether a VPN gateway should be created and attached to this VPC.

---

##### `vpnGatewayAsn`<sup>Optional</sup> <a name="vpnGatewayAsn" id="cdk-nextjs.OptionalVpcProps.property.vpnGatewayAsn"></a>

```typescript
public readonly vpnGatewayAsn: number;
```

- *Type:* number
- *Default:* Amazon default ASN.

The private Autonomous System Number (ASN) for the VPN gateway.

---

##### `vpnRoutePropagation`<sup>Optional</sup> <a name="vpnRoutePropagation" id="cdk-nextjs.OptionalVpcProps.property.vpnRoutePropagation"></a>

```typescript
public readonly vpnRoutePropagation: SubnetSelection[];
```

- *Type:* aws-cdk-lib.aws_ec2.SubnetSelection[]
- *Default:* On the route tables associated with private subnets. If no private subnets exists, isolated subnets are used. If no isolated subnets exists, public subnets are used.

Where to propagate VPN routes.

---

### PublicDirEntry <a name="PublicDirEntry" id="cdk-nextjs.PublicDirEntry"></a>

#### Initializer <a name="Initializer" id="cdk-nextjs.PublicDirEntry.Initializer"></a>

```typescript
import { PublicDirEntry } from 'cdk-nextjs'

const publicDirEntry: PublicDirEntry = { ... }
```

#### Properties <a name="Properties" id="Properties"></a>

| **Name** | **Type** | **Description** |
| --- | --- | --- |
| <code><a href="#cdk-nextjs.PublicDirEntry.property.isDirectory">isDirectory</a></code> | <code>boolean</code> | *No description.* |
| <code><a href="#cdk-nextjs.PublicDirEntry.property.name">name</a></code> | <code>string</code> | *No description.* |

---

##### `isDirectory`<sup>Required</sup> <a name="isDirectory" id="cdk-nextjs.PublicDirEntry.property.isDirectory"></a>

```typescript
public readonly isDirectory: boolean;
```

- *Type:* boolean

---

##### `name`<sup>Required</sup> <a name="name" id="cdk-nextjs.PublicDirEntry.property.name"></a>

```typescript
public readonly name: string;
```

- *Type:* string

---



## Enums <a name="Enums" id="Enums"></a>

### NextjsType <a name="NextjsType" id="cdk-nextjs.NextjsType"></a>

#### Members <a name="Members" id="Members"></a>

| **Name** | **Description** |
| --- | --- |
| <code><a href="#cdk-nextjs.NextjsType.GLOBAL_CONTAINERS">GLOBAL_CONTAINERS</a></code> | *No description.* |
| <code><a href="#cdk-nextjs.NextjsType.GLOBAL_FUNCTIONS">GLOBAL_FUNCTIONS</a></code> | *No description.* |
| <code><a href="#cdk-nextjs.NextjsType.REGIONAL_CONTAINERS">REGIONAL_CONTAINERS</a></code> | *No description.* |

---

##### `GLOBAL_CONTAINERS` <a name="GLOBAL_CONTAINERS" id="cdk-nextjs.NextjsType.GLOBAL_CONTAINERS"></a>

---


##### `GLOBAL_FUNCTIONS` <a name="GLOBAL_FUNCTIONS" id="cdk-nextjs.NextjsType.GLOBAL_FUNCTIONS"></a>

---


##### `REGIONAL_CONTAINERS` <a name="REGIONAL_CONTAINERS" id="cdk-nextjs.NextjsType.REGIONAL_CONTAINERS"></a>

---

