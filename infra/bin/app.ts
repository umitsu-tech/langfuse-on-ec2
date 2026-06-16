#!/usr/bin/env node
import { App } from "aws-cdk-lib";
import { APP_NAME, REGION, Stage } from "../lib/config";
import { GitHubOidcStack } from "../lib/github-oidc-stack";
import { LangfuseStack } from "../lib/langfuse-stack";

const app = new App();

const stage = (app.node.tryGetContext("stage") as Stage) ?? "dev";

const env = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region: REGION,
};

new LangfuseStack(app, `${APP_NAME}-${stage}`, {
  env,
  stage,
});

const repo = app.node.tryGetContext("repo") as string | undefined;
if (repo) {
  new GitHubOidcStack(app, `${APP_NAME}-github-oidc-${stage}`, {
    env,
    stage,
    repo,
  });
}
