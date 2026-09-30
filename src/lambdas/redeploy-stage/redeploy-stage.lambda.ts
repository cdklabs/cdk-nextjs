import type { EventBridgeHandler } from "aws-lambda";
import { redeployStage } from "./redeploy-stage";

/**
 * The `detail` of a "CloudFormation Stack Status Change" event, as documented
 * in the CloudFormation User Guide ("Stack Status Change event detail").
 */
interface StackStatusChangeDetail {
  readonly "stack-id": string;
  readonly "status-details": {
    readonly status: string;
    readonly "status-reason"?: string;
  };
}

/**
 * Invoked by `NextjsApi`'s EventBridge rule when its stack finishes an update;
 * see {@link redeployStage}. The API and stage come from the environment rather
 * than the event: the rule only matches this stack, and the event names the
 * stack, not the API.
 */
export const handler: EventBridgeHandler<
  "CloudFormation Stack Status Change",
  StackStatusChangeDetail,
  void
> = async (event) => {
  const restApiId = process.env.REST_API_ID;
  const stageName = process.env.STAGE_NAME;
  if (!restApiId || !stageName) {
    throw new Error("REST_API_ID and STAGE_NAME must be set.");
  }
  await redeployStage({
    restApiId,
    stageName,
    stackStatus: event.detail["status-details"].status,
  });
};
