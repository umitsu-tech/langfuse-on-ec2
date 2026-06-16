import { Stack, StackProps, CfnOutput } from "aws-cdk-lib";
import * as iam from "aws-cdk-lib/aws-iam";
import { Construct } from "constructs";
import { Stage } from "./config";

export interface GitHubOidcStackProps extends StackProps {
  readonly stage: Stage;
  /** GitHub リポジトリ (例: "ryuki-imachi/ai-agent-poc-template")。 */
  readonly repo: string;
}

/**
 * GitHub Actions OIDC 連携スタック。
 *
 * GitHub Actions が AWS の一時クレデンシャルを取得できるよう、
 * OIDC プロバイダーと IAM ロールを作成する。
 * Langfuse の起動・停止 workflow で使用する。
 */
export class GitHubOidcStack extends Stack {
  public readonly role: iam.IRole;

  constructor(scope: Construct, id: string, props: GitHubOidcStackProps) {
    super(scope, id, props);

    const providerArn = `arn:aws:iam::${this.account}:oidc-provider/token.actions.githubusercontent.com`;
    const provider = iam.OpenIdConnectProvider.fromOpenIdConnectProviderArn(
      this,
      "GitHubOidc",
      providerArn,
    );

    this.role = new iam.Role(this, "GitHubActionsRole", {
      roleName: `langfuse-github-actions-${props.stage}`,
      assumedBy: new iam.WebIdentityPrincipal(
        provider.openIdConnectProviderArn,
        {
          StringEquals: {
            "token.actions.githubusercontent.com:aud": "sts.amazonaws.com",
          },
          StringLike: {
            "token.actions.githubusercontent.com:sub": `repo:${props.repo}:*`,
          },
        },
      ),
      inlinePolicies: {
        LangfuseOps: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              sid: "Ec2StartStop",
              actions: [
                "ec2:StartInstances",
                "ec2:StopInstances",
                "ec2:DescribeInstances",
              ],
              resources: ["*"],
              conditions: {
                StringEquals: {
                  [`aws:ResourceTag/aws:cloudformation:stack-name`]:
                    `langfuse-${props.stage}`,
                },
              },
            }),
            new iam.PolicyStatement({
              sid: "Ec2DescribeAll",
              actions: ["ec2:DescribeInstances"],
              resources: ["*"],
            }),
            new iam.PolicyStatement({
              sid: "SsmGetParameter",
              actions: ["ssm:GetParameter"],
              resources: [
                `arn:aws:ssm:${this.region}:${this.account}:parameter/langfuse/${props.stage}/*`,
              ],
            }),
            new iam.PolicyStatement({
              sid: "SsmSendCommand",
              actions: [
                "ssm:SendCommand",
                "ssm:GetCommandInvocation",
              ],
              resources: ["*"],
            }),
          ],
        }),
      },
    });

    new CfnOutput(this, "RoleArn", {
      value: this.role.roleArn,
      description: "GitHub Actions の AWS_OIDC_ROLE_ARN シークレットに設定する値",
    });
  }
}
