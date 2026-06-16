import { RemovalPolicy } from "aws-cdk-lib";

export const APP_NAME = "langfuse";

export const REGION = "ap-northeast-1";

export type Stage = "dev" | "prod";

export function removalPolicy(stage: Stage): RemovalPolicy {
  return stage === "prod" ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY;
}
