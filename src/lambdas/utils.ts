import type { CloudFormationCustomResourceHandler } from "aws-lambda";

export enum CfnResponseStatus {
  Success = "SUCCESS",
  Failed = "FAILED",
}

interface CfnResponseProps {
  event: Parameters<CloudFormationCustomResourceHandler>[0];
  context: Parameters<CloudFormationCustomResourceHandler>[1];
  responseStatus: CfnResponseStatus;
  responseData?: Record<string, string>;
  physicalResourceId?: string;
}

/**
 * Inspired by: https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/cfn-lambda-function-code-cfnresponsemodule.html
 */
export function cfnResponse(props: CfnResponseProps) {
  const body = JSON.stringify({
    Status: props.responseStatus,
    Reason:
      "See the details in CloudWatch Log Stream: " +
      props.context.logStreamName,
    PhysicalResourceId: props.physicalResourceId || props.context.logStreamName,
    StackId: props.event.StackId,
    RequestId: props.event.RequestId,
    LogicalResourceId: props.event.LogicalResourceId,
    Data: props.responseData,
  });
  return fetch(props.event.ResponseURL, {
    method: "PUT",
    body,
    headers: { "content-type": "", "content-length": body.length.toString() },
  });
}

export function debug(value: unknown) {
  if (process.env.DEBUG) console.log(JSON.stringify(value, null, 2));
}
