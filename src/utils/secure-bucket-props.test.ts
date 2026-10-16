import { App, Stack } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { Bucket } from "aws-cdk-lib/aws-s3";
import { SECURE_BUCKET_PROPS } from "./secure-bucket-props";

describe("SECURE_BUCKET_PROPS", () => {
  let template: Template;

  beforeEach(() => {
    const stack = new Stack(new App(), "TestStack");
    new Bucket(stack, "Bucket", SECURE_BUCKET_PROPS);
    template = Template.fromStack(stack);
  });

  it("makes a private, S3-encrypted bucket deleted with the stack", () => {
    template.hasResource("AWS::S3::Bucket", {
      DeletionPolicy: "Delete",
      Properties: {
        PublicAccessBlockConfiguration: {
          BlockPublicAcls: true,
          BlockPublicPolicy: true,
          IgnorePublicAcls: true,
          RestrictPublicBuckets: true,
        },
        BucketEncryption: {
          ServerSideEncryptionConfiguration: [
            { ServerSideEncryptionByDefault: { SSEAlgorithm: "AES256" } },
          ],
        },
      },
    });
    template.resourceCountIs("Custom::S3AutoDeleteObjects", 1);
  });

  it("denies plain HTTP and TLS below 1.2", () => {
    template.hasResourceProperties("AWS::S3::BucketPolicy", {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Effect: "Deny",
            Action: "s3:*",
            Condition: { Bool: { "aws:SecureTransport": "false" } },
          }),
          Match.objectLike({
            Effect: "Deny",
            Action: "s3:*",
            Condition: { NumericLessThan: { "s3:TlsVersion": 1.2 } },
          }),
        ]),
      },
    });
  });
});
