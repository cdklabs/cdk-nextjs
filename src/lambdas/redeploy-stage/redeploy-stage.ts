/* eslint-disable import/no-extraneous-dependencies */
import {
  APIGatewayClient,
  CreateDeploymentCommand,
  DeleteDeploymentCommand,
  GetDeploymentsCommand,
  GetStagesCommand,
} from "@aws-sdk/client-api-gateway";
import getDebug from "debug";

const debug = getDebug("cdk-nextjs:redeploy-stage");

/**
 * Marks the deployments this function makes, so a later run prunes only its
 * own. CloudFormation owns every other deployment on the API and deletes them
 * itself.
 */
export const REDEPLOY_DESCRIPTION_PREFIX = "cdk-nextjs: redeploy after";

const apiGateway = new APIGatewayClient({});

export interface RedeployStageInput {
  readonly restApiId: string;
  readonly stageName: string;
  /** The stack status that triggered the run, for the description. */
  readonly stackStatus: string;
}

/**
 * Deploys `stageName` again from the API as it is now, then deletes the
 * deployments earlier runs made that no stage still points at.
 *
 * Why: CloudFormation creates the new `AWS::ApiGateway::Deployment` while
 * resources removed from the template still exist (it deletes them only in
 * `UPDATE_COMPLETE_CLEANUP_IN_PROGRESS`), so that snapshot keeps them. A
 * removed function group's `/api/{proxy+}` stays routable, to a Lambda that is
 * then deleted, and API Gateway answers 500 until the next deployment. This
 * runs on `UPDATE_COMPLETE`, after cleanup, so its snapshot is the real tree.
 */
export async function redeployStage({
  restApiId,
  stageName,
  stackStatus,
}: RedeployStageInput): Promise<string> {
  const created = await apiGateway.send(
    new CreateDeploymentCommand({
      restApiId,
      stageName,
      description: `${REDEPLOY_DESCRIPTION_PREFIX} ${stackStatus}`,
    }),
  );
  const deploymentId = created.id!;
  debug(`Deployed ${restApiId}/${stageName} as ${deploymentId}`);

  const { item: stages = [] } = await apiGateway.send(
    new GetStagesCommand({ restApiId }),
  );
  const referenced = new Set(stages.map((stage) => stage.deploymentId));

  let position: string | undefined;
  do {
    const page = await apiGateway.send(
      new GetDeploymentsCommand({ restApiId, position, limit: 500 }),
    );
    for (const deployment of page.items ?? []) {
      if (
        !deployment.id ||
        deployment.id === deploymentId ||
        referenced.has(deployment.id) ||
        !deployment.description?.startsWith(REDEPLOY_DESCRIPTION_PREFIX)
      ) {
        continue;
      }
      try {
        await apiGateway.send(
          new DeleteDeploymentCommand({
            restApiId,
            deploymentId: deployment.id,
          }),
        );
        debug(`Deleted previous redeploy ${deployment.id}`);
      } catch (error) {
        // Pruning is housekeeping: the stage already serves the new deployment.
        // A stage created meanwhile can reference it (400), or another run got
        // there first (404); either way the next run tries again.
        console.warn(
          `Could not delete deployment ${deployment.id} of ${restApiId}:`,
          error,
        );
      }
    }
    position = page.position;
  } while (position);

  return deploymentId;
}
