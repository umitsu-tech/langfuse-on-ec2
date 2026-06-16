import * as fs from "fs";
import * as path from "path";
import { Stack, StackProps, CfnOutput, Tags } from "aws-cdk-lib";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as iam from "aws-cdk-lib/aws-iam";
import * as ssm from "aws-cdk-lib/aws-ssm";
import { Construct } from "constructs";
import { Stage } from "./config";

export interface LangfuseStackProps extends StackProps {
  readonly stage: Stage;
  /** Backend (DB) の EC2 インスタンスタイプ。省略時 t4g.small。 */
  readonly backendInstanceType?: ec2.InstanceType;
  /** Frontend (web/worker) の EC2 インスタンスタイプ。省略時 t4g.small。 */
  readonly frontendInstanceType?: ec2.InstanceType;
  /** テスト用: VPC を外部から注入する。省略時は default VPC を lookup。 */
  readonly vpc?: ec2.IVpc;
}

/**
 * Langfuse セルフホストスタック (M3)。
 *
 * EC2 t4g.small × 2台 + docker-compose で Langfuse v3 を起動する。
 * - Frontend EC2: langfuse-web, langfuse-worker, MinIO
 * - Backend EC2:  postgres, redis, clickhouse
 *
 * 停止中は EBS だけ課金、起動は GitHub Actions workflow_dispatch で実施。
 */
export class LangfuseStack extends Stack {
  public readonly frontendInstanceId: string;
  public readonly backendInstanceId: string;

  constructor(scope: Construct, id: string, props: LangfuseStackProps) {
    super(scope, id, props);

    const vpc =
      props.vpc ?? ec2.Vpc.fromLookup(this, "DefaultVpc", { isDefault: true });

    // ---- Security Groups ----

    const frontendSg = new ec2.SecurityGroup(this, "FrontendSg", {
      vpc,
      description: "Langfuse Frontend (web + worker + minio)",
      allowAllOutbound: true,
    });
    frontendSg.addIngressRule(
      ec2.Peer.anyIpv4(),
      ec2.Port.tcp(3000),
      "Langfuse UI",
    );

    const backendSg = new ec2.SecurityGroup(this, "BackendSg", {
      vpc,
      description: "Langfuse Backend (postgres + redis + clickhouse)",
      allowAllOutbound: true,
    });
    backendSg.addIngressRule(frontendSg, ec2.Port.tcp(5432), "PostgreSQL");
    backendSg.addIngressRule(frontendSg, ec2.Port.tcp(6379), "Redis");
    backendSg.addIngressRule(frontendSg, ec2.Port.tcp(8123), "ClickHouse HTTP");
    backendSg.addIngressRule(frontendSg, ec2.Port.tcp(9000), "ClickHouse TCP");

    // ---- IAM Role (SSM 接続用、両 EC2 で共有) ----

    const role = new iam.Role(this, "Ec2Role", {
      assumedBy: new iam.ServicePrincipal("ec2.amazonaws.com"),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName(
          "AmazonSSMManagedInstanceCore",
        ),
      ],
    });

    const machineImage = ec2.MachineImage.latestAmazonLinux2023({
      cpuType: ec2.AmazonLinuxCpuType.ARM_64,
    });

    // ---- Backend EC2 ----

    const backendInstance = new ec2.Instance(this, "BackendInstance", {
      vpc,
      instanceType:
        props.backendInstanceType ?? new ec2.InstanceType("t4g.small"),
      machineImage,
      securityGroup: backendSg,
      role,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      associatePublicIpAddress: true,
      blockDevices: [
        {
          deviceName: "/dev/xvda",
          volume: ec2.BlockDeviceVolume.ebs(10, {
            volumeType: ec2.EbsDeviceVolumeType.GP3,
          }),
        },
        {
          deviceName: "/dev/xvdf",
          volume: ec2.BlockDeviceVolume.ebs(20, {
            volumeType: ec2.EbsDeviceVolumeType.GP3,
          }),
        },
      ],
    });
    Tags.of(backendInstance).add(
      "Name",
      `langfuse-backend-${props.stage}`,
    );

    const backendCompose = fs.readFileSync(
      path.join(__dirname, "..", "..", "langfuse", "backend", "docker-compose.yml"),
      "utf-8",
    );

    backendInstance.addUserData(
      "#!/bin/bash",
      "set -euo pipefail",

      "# Docker",
      "dnf update -y",
      "dnf install -y docker",
      "systemctl enable docker && systemctl start docker",
      "mkdir -p /usr/local/lib/docker/cli-plugins",
      "curl -SL https://github.com/docker/compose/releases/latest/download/docker-compose-linux-aarch64 -o /usr/local/lib/docker/cli-plugins/docker-compose",
      "chmod +x /usr/local/lib/docker/cli-plugins/docker-compose",

      "# Data EBS (20 GB)",
      "while [ ! -b /dev/nvme1n1 ]; do sleep 1; done",
      "if ! blkid /dev/nvme1n1; then mkfs.ext4 /dev/nvme1n1; fi",
      "mkdir -p /data",
      "mount /dev/nvme1n1 /data",
      'echo "UUID=$(blkid -s UUID -o value /dev/nvme1n1) /data ext4 defaults,nofail 0 2" >> /etc/fstab',

      "# Volume dirs",
      "mkdir -p /data/postgres /data/redis /data/clickhouse/data /data/clickhouse/logs",
      "chown 101:101 /data/clickhouse/data /data/clickhouse/logs",

      "# Compose file",
      "mkdir -p /opt/langfuse",
      `cat > /opt/langfuse/docker-compose.yml << 'COMPOSE_EOF'\n${backendCompose}\nCOMPOSE_EOF`,

      "# .env",
      `cat > /opt/langfuse/.env << 'ENV_EOF'
POSTGRES_PASSWORD=langfuse-poc-2026
CLICKHOUSE_PASSWORD=langfuse-poc-2026
REDIS_PASSWORD=langfuse-poc-2026
ENV_EOF`,

      "# Systemd service",
      `cat > /etc/systemd/system/langfuse-backend.service << 'SVC_EOF'
[Unit]
Description=Langfuse Backend (postgres + redis + clickhouse)
Requires=docker.service
After=docker.service

[Service]
Type=oneshot
RemainAfterExit=yes
WorkingDirectory=/opt/langfuse
ExecStart=/usr/bin/docker compose up -d
ExecStop=/usr/bin/docker compose down
TimeoutStartSec=180

[Install]
WantedBy=multi-user.target
SVC_EOF`,
      "systemctl daemon-reload",
      "systemctl enable langfuse-backend.service",
      "systemctl start langfuse-backend.service",
    );

    // ---- Frontend EC2 ----

    const frontendInstance = new ec2.Instance(this, "FrontendInstance", {
      vpc,
      instanceType:
        props.frontendInstanceType ?? new ec2.InstanceType("t4g.small"),
      machineImage,
      securityGroup: frontendSg,
      role,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      associatePublicIpAddress: true,
    });
    Tags.of(frontendInstance).add(
      "Name",
      `langfuse-frontend-${props.stage}`,
    );

    // Docker コンテナが IMDSv2 経由で instance profile を使えるよう hop limit=2。
    const cfnFrontend = frontendInstance.instance;
    cfnFrontend.addPropertyOverride("MetadataOptions.HttpTokens", "required");
    cfnFrontend.addPropertyOverride(
      "MetadataOptions.HttpPutResponseHopLimit",
      2,
    );

    const frontendCompose = fs.readFileSync(
      path.join(__dirname, "..", "..", "langfuse", "frontend", "docker-compose.yml"),
      "utf-8",
    );

    const backendIp = backendInstance.instancePrivateIp;

    frontendInstance.addUserData(
      "#!/bin/bash",
      "set -euo pipefail",

      "# Docker",
      "dnf update -y",
      "dnf install -y docker",
      "systemctl enable docker && systemctl start docker",
      "mkdir -p /usr/local/lib/docker/cli-plugins",
      "curl -SL https://github.com/docker/compose/releases/latest/download/docker-compose-linux-aarch64 -o /usr/local/lib/docker/cli-plugins/docker-compose",
      "chmod +x /usr/local/lib/docker/cli-plugins/docker-compose",

      "# Compose file",
      "mkdir -p /opt/langfuse",
      `cat > /opt/langfuse/docker-compose.yml << 'COMPOSE_EOF'\n${frontendCompose}\nCOMPOSE_EOF`,

      // .env — backendIp は CDK Token (CloudFormation が解決する)。
      // heredoc のクォートなし (ENV_EOF) で CloudFormation 解決値を埋め込む。
      `cat > /opt/langfuse/.env << ENV_EOF
NEXTAUTH_URL=http://localhost:3000
NEXTAUTH_SECRET=langfuse-poc-nextauth-secret-2026
SALT=langfuse-poc-salt-2026
ENCRYPTION_KEY=a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2
DATABASE_URL=postgresql://langfuse:langfuse-poc-2026@${backendIp}:5432/langfuse
CLICKHOUSE_URL=http://${backendIp}:8123
CLICKHOUSE_MIGRATION_URL=clickhouse://${backendIp}:9000
CLICKHOUSE_USER=langfuse
CLICKHOUSE_PASSWORD=langfuse-poc-2026
CLICKHOUSE_CLUSTER_ENABLED=false
REDIS_HOST=${backendIp}
REDIS_PORT=6379
REDIS_AUTH=langfuse-poc-2026
REDIS_TLS_ENABLED=false
LANGFUSE_S3_EVENT_UPLOAD_BUCKET=langfuse
LANGFUSE_S3_EVENT_UPLOAD_REGION=auto
LANGFUSE_S3_EVENT_UPLOAD_ACCESS_KEY_ID=minio
LANGFUSE_S3_EVENT_UPLOAD_SECRET_ACCESS_KEY=langfuse-poc-minio-2026
LANGFUSE_S3_EVENT_UPLOAD_ENDPOINT=http://minio:9000
LANGFUSE_S3_EVENT_UPLOAD_FORCE_PATH_STYLE=true
LANGFUSE_S3_EVENT_UPLOAD_PREFIX=events/
LANGFUSE_S3_MEDIA_UPLOAD_BUCKET=langfuse
LANGFUSE_S3_MEDIA_UPLOAD_REGION=auto
LANGFUSE_S3_MEDIA_UPLOAD_ACCESS_KEY_ID=minio
LANGFUSE_S3_MEDIA_UPLOAD_SECRET_ACCESS_KEY=langfuse-poc-minio-2026
LANGFUSE_S3_MEDIA_UPLOAD_ENDPOINT=http://minio:9000
LANGFUSE_S3_MEDIA_UPLOAD_FORCE_PATH_STYLE=true
LANGFUSE_S3_MEDIA_UPLOAD_PREFIX=media/
MINIO_PASSWORD=langfuse-poc-minio-2026
LANGFUSE_S3_BATCH_EXPORT_ENABLED=false
TELEMETRY_ENABLED=true
LANGFUSE_ENABLE_EXPERIMENTAL_FEATURES=false
ENV_EOF`,

      // 起動ごとに public IP から NEXTAUTH_URL を更新するスクリプト。
      `cat > /opt/langfuse/update-env.sh << 'SCRIPT_EOF'
#!/bin/bash
TOKEN=$(curl -sf -X PUT "http://169.254.169.254/latest/api/token" -H "X-aws-ec2-metadata-token-ttl-seconds: 60")
PUBLIC_IP=$(curl -sf -H "X-aws-ec2-metadata-token: $TOKEN" http://169.254.169.254/latest/meta-data/public-ipv4)
if [ -n "$PUBLIC_IP" ]; then
  sed -i "s|^NEXTAUTH_URL=.*|NEXTAUTH_URL=http://\${PUBLIC_IP}:3000|" /opt/langfuse/.env
fi
SCRIPT_EOF`,
      "chmod +x /opt/langfuse/update-env.sh",

      // Systemd service
      `cat > /etc/systemd/system/langfuse-frontend.service << 'SVC_EOF'
[Unit]
Description=Langfuse Frontend (web + worker + minio)
Requires=docker.service
After=docker.service

[Service]
Type=oneshot
RemainAfterExit=yes
WorkingDirectory=/opt/langfuse
ExecStartPre=/opt/langfuse/update-env.sh
ExecStart=/usr/bin/docker compose up -d
ExecStop=/usr/bin/docker compose down
TimeoutStartSec=180

[Install]
WantedBy=multi-user.target
SVC_EOF`,
      "systemctl daemon-reload",
      "systemctl enable langfuse-frontend.service",
      "systemctl start langfuse-frontend.service",
    );

    // ---- SSM Parameters (GitHub Actions から参照) ----

    new ssm.StringParameter(this, "BackendInstanceIdParam", {
      parameterName: `/langfuse/${props.stage}/backend-instance-id`,
      stringValue: backendInstance.instanceId,
    });

    new ssm.StringParameter(this, "FrontendInstanceIdParam", {
      parameterName: `/langfuse/${props.stage}/frontend-instance-id`,
      stringValue: frontendInstance.instanceId,
    });

    this.frontendInstanceId = frontendInstance.instanceId;
    this.backendInstanceId = backendInstance.instanceId;

    // ---- Outputs ----

    new CfnOutput(this, "BackendInstanceId", {
      value: backendInstance.instanceId,
      description: "Backend EC2 Instance ID",
    });
    new CfnOutput(this, "FrontendInstanceId", {
      value: frontendInstance.instanceId,
      description: "Frontend EC2 Instance ID",
    });
    new CfnOutput(this, "BackendPrivateIp", {
      value: backendInstance.instancePrivateIp,
      description: "Backend private IP (Frontend の .env に埋め込み済み)",
    });
    new CfnOutput(this, "SsmBackendInstanceId", {
      value: `/langfuse/${props.stage}/backend-instance-id`,
      description: "SSM parameter path for Backend Instance ID",
    });
    new CfnOutput(this, "SsmFrontendInstanceId", {
      value: `/langfuse/${props.stage}/frontend-instance-id`,
      description: "SSM parameter path for Frontend Instance ID",
    });
  }
}
