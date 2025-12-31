import { FileSystem } from "aws-cdk-lib";
import * as cognito from "aws-cdk-lib/aws-cognito";
import { Construct } from "constructs";
import * as path from "path";
import { Platform } from "aws-cdk-lib/aws-ecr-assets";
import { ContainerImageBuild } from "deploy-time-build";
import * as agentcore from "@aws-cdk/aws-bedrock-agentcore-alpha";
import { ProtocolType } from "@aws-cdk/aws-bedrock-agentcore-alpha";

/**
 * AgentCoreRuntimeConstruct の Props
 */
export interface AgentCoreRuntimeConstructProps {
  /**
   * ユニークID（リソース名の接尾辞として使用）
   */
  readonly uniqueId: string;

  /**
   * Runtime認証用の Cognito User Pool
   */
  readonly runtimeUserPool: cognito.UserPool;

  /**
   * Runtime認証用の Cognito User Pool Client
   */
  readonly runtimeUserPoolClient: cognito.UserPoolClient;
}

/**
 * AgentCore Runtime Construct
 *
 * 以下のリソースを作成:
 * - ContainerImageBuild (ECRへのイメージビルド)
 * - AgentCore Runtime (L2 Construct)
 */
export class AgentCoreRuntimeConstruct extends Construct {
  public readonly runtime: agentcore.Runtime;
  public readonly mcpServerHash: string;

  constructor(scope: Construct, id: string, props: AgentCoreRuntimeConstructProps) {
    super(scope, id);

    const { uniqueId, runtimeUserPool, runtimeUserPoolClient } = props;

    // MCP Server directory
    const mcpServerDir = path.join(__dirname, "../../mcp_server");
    const mcpServerExclude = [".venv", "__pycache__", "*.pyc", ".git"];

    // MCPサーバーのソースハッシュ（SyncGatewayTargetsのトリガーに使用）
    this.mcpServerHash = FileSystem.fingerprint(mcpServerDir, {
      exclude: mcpServerExclude,
    });

    // ContainerImageBuild
    const image = new ContainerImageBuild(this, "Image", {
      directory: mcpServerDir,
      platform: Platform.LINUX_ARM64,
      exclude: mcpServerExclude,
    });

    const agentRuntimeArtifact = agentcore.AgentRuntimeArtifact.fromEcrRepository(
      image.repository,
      image.imageTag
    );

    // AgentCore Runtime (L2 Construct)
    this.runtime = new agentcore.Runtime(this, "Runtime", {
      runtimeName: `runtimeMcp_${uniqueId}`,
      agentRuntimeArtifact: agentRuntimeArtifact,
      description: "MCP Server for AgentCore Gateway",
      protocolConfiguration: ProtocolType.MCP,
      authorizerConfiguration: agentcore.RuntimeAuthorizerConfiguration.usingCognito(
        runtimeUserPool,
        [runtimeUserPoolClient]
      ),
    });
  }
}
