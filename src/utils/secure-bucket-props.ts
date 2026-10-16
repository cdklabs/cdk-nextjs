import { RemovalPolicy } from "aws-cdk-lib";
import {
  BlockPublicAccess,
  BucketEncryption,
  BucketProps,
} from "aws-cdk-lib/aws-s3";

/**
 * Defaults for every bucket cdk-nextjs creates: private, S3-managed
 * encryption, HTTPS only at TLS 1.2 or later, and emptied and deleted with the
 * stack. Spread first, so each construct's `overrides` still win.
 */
export const SECURE_BUCKET_PROPS: BucketProps = {
  removalPolicy: RemovalPolicy.DESTROY,
  autoDeleteObjects: true,
  enforceSSL: true,
  blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
  encryption: BucketEncryption.S3_MANAGED,
  minimumTLSVersion: 1.2,
};
