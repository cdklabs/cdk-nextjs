import { Duration } from "aws-cdk-lib";
import { AnyPrincipal, Effect, PolicyStatement } from "aws-cdk-lib/aws-iam";
import { Function as LambdaFunction } from "aws-cdk-lib/aws-lambda";
import {
  SqsEventSource,
  SqsEventSourceProps,
} from "aws-cdk-lib/aws-lambda-event-sources";
import { Queue, QueueProps } from "aws-cdk-lib/aws-sqs";
import { Construct } from "constructs";
import { OptionalFunctionProps } from "./generated-structs/OptionalFunctionProps";
import { RevalidateFunction } from "./lambdas/revalidate/revalidate-function";

export interface NextjsRevalidationOverrides {
  readonly queueProps?: QueueProps;
  readonly functionProps?: OptionalFunctionProps;
  readonly sqsEventSourceProps?: SqsEventSourceProps;
}

export interface NextjsRevalidationProps {
  readonly fn: LambdaFunction;
  readonly overrides?: NextjsRevalidationOverrides;
  readonly previewModeId: string;
}

/**
 * [On-Demand Revalidation](https://nextjs.org/docs/app/building-your-application/caching#on-demand-revalidation)
 * (i.e. `revalidateTag`, `revlidatePath`) doesn't work by default in Lambda
 * environment because it tries to run every request completes when Lambda
 * spins down. Therefore, we use a SQS Queue and Lambda function to run
 * revalidation async.
 */
export class NextjsRevalidation extends Construct {
  queue: Queue;
  fn: LambdaFunction;

  private props: NextjsRevalidationProps;

  constructor(scope: Construct, id: string, props: NextjsRevalidationProps) {
    super(scope, id);
    this.props = props;
    this.queue = this.createQueue();
    this.fn = this.createFunction();
  }

  private createQueue() {
    const queue = new Queue(this, "Queue", {
      fifo: true,
      contentBasedDeduplication: true,
      ...this.props.overrides?.queueProps,
    });
    // https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/sqs-least-privilege-policy.html
    queue.addToResourcePolicy(
      new PolicyStatement({
        sid: "DenyUnsecureTransport",
        actions: ["sqs:*"],
        effect: Effect.DENY,
        principals: [new AnyPrincipal()],
        resources: [queue.queueArn],
        conditions: {
          Bool: { "aws:SecureTransport": "false" },
        },
      }),
    );
    // Allow server to send messages to the queue
    queue.grantSendMessages(this.props.fn);
    this.props.fn.addEnvironment("CDK_NEXTJS_QUEUE_URL", queue.queueUrl);
    return queue;
  }

  private createFunction() {
    const fn = new RevalidateFunction(this, "Fn", {
      environment: {
        PREVIEW_MODE_ID: this.props.previewModeId,
      },
      timeout: Duration.seconds(20),
      ...this.props.overrides?.functionProps,
    });
    fn.addEventSource(
      new SqsEventSource(this.queue, {
        ...this.props.overrides?.sqsEventSourceProps,
      }),
    );
    return fn;
  }
}
