import { App, Stack } from "aws-cdk-lib";
import { Template, Match } from "aws-cdk-lib/assertions";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import { LangfuseStack } from "../lib/langfuse-stack";

const ENV = { account: "123456789012", region: "ap-northeast-1" };

function synth(): Template {
  const app = new App();

  const vpcStack = new Stack(app, "VpcStack", { env: ENV });
  const vpc = new ec2.Vpc(vpcStack, "Vpc", { maxAzs: 2 });

  const stack = new LangfuseStack(app, "TestLangfuse", {
    env: ENV,
    stage: "dev",
    vpc,
  });
  return Template.fromStack(stack);
}

describe("LangfuseStack", () => {
  let template: Template;

  beforeAll(() => {
    template = synth();
  });

  test("EC2 インスタンスが 2 台作られる", () => {
    template.resourceCountIs("AWS::EC2::Instance", 2);
  });

  test("Backend は t4g.small + EBS 20GB データボリューム付き", () => {
    template.hasResourceProperties("AWS::EC2::Instance", {
      InstanceType: "t4g.small",
      BlockDeviceMappings: Match.arrayWith([
        Match.objectLike({
          DeviceName: "/dev/xvdf",
          Ebs: Match.objectLike({
            VolumeSize: 20,
            VolumeType: "gp3",
          }),
        }),
      ]),
    });
  });

  test("Security Group が 2 つ作られる", () => {
    template.resourceCountIs("AWS::EC2::SecurityGroup", 2);
  });

  test("Backend SG は Frontend SG からの DB ポートを許可する Ingress ルールが 4 つある", () => {
    // SG 間参照は SecurityGroupIngress リソースとして別途作られる
    for (const port of [5432, 6379, 8123, 9000]) {
      template.hasResourceProperties("AWS::EC2::SecurityGroupIngress", {
        IpProtocol: "tcp",
        FromPort: port,
        ToPort: port,
      });
    }
  });

  test("Frontend SG は port 3000 を 0.0.0.0/0 に許可", () => {
    template.hasResourceProperties("AWS::EC2::SecurityGroup", {
      GroupDescription: "Langfuse Frontend (web + worker + minio)",
      SecurityGroupIngress: Match.arrayWith([
        Match.objectLike({
          IpProtocol: "tcp",
          FromPort: 3000,
          ToPort: 3000,
          CidrIp: "0.0.0.0/0",
        }),
      ]),
    });
  });

  test("IAM Role に SSMManagedInstanceCore が付与されている", () => {
    template.hasResourceProperties("AWS::IAM::Role", {
      ManagedPolicyArns: Match.arrayWith([
        Match.objectLike({
          "Fn::Join": Match.arrayWith([
            Match.arrayWith([
              Match.stringLikeRegexp("AmazonSSMManagedInstanceCore"),
            ]),
          ]),
        }),
      ]),
    });
  });

  test("SSM Parameter が 2 つ作られる (Backend/Frontend Instance ID)", () => {
    template.resourceCountIs("AWS::SSM::Parameter", 2);
    template.hasResourceProperties("AWS::SSM::Parameter", {
      Name: "/langfuse/dev/backend-instance-id",
    });
    template.hasResourceProperties("AWS::SSM::Parameter", {
      Name: "/langfuse/dev/frontend-instance-id",
    });
  });

  test("CfnOutput が出力される", () => {
    template.hasOutput("BackendInstanceId", {});
    template.hasOutput("FrontendInstanceId", {});
    template.hasOutput("BackendPrivateIp", {});
  });
});
