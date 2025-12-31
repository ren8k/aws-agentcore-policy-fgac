import * as cdk from "aws-cdk-lib";
import * as iam from "aws-cdk-lib/aws-iam";
import * as cr from "aws-cdk-lib/custom-resources";
import * as logs from "aws-cdk-lib/aws-logs";
import * as bedrockagentcore from "aws-cdk-lib/aws-bedrockagentcore";
import { Construct } from "constructs";
import * as agentcore from "@aws-cdk/aws-bedrock-agentcore-alpha";

/**
 * AgentCoreGatewayConstruct の Props
 *
 * customClaims を使用した JWT ベースの認可をサポート
 */
export interface AgentCoreGatewayConstructProps {
  /**
   * ユニークID（リソース名の接尾辞として使用）
   */
  readonly uniqueId: string;

  /**
   * Gateway のターゲット名
   */
  readonly targetName: string;

  /**
   * Gateway認証用の Discovery URL
   */
  readonly gatewayDiscoveryUrl: string;

  /**
   * Gateway認証用の Client ID
   */
  readonly gatewayClientId: string;

  /**
   * Runtime 認証用 OAuth2 Credential Provider ARN
   * AgentCoreIdentityConstruct で作成された credentialProviderArn を指定
   */
  readonly runtimeOAuth2CredentialProviderArn: string;

  /**
   * Runtime のスコープ文字列
   */
  readonly runtimeScopeString: string;

  /**
   * AgentCore Runtime
   */
  readonly runtime: agentcore.Runtime;

  /**
   * MCPサーバーのソースハッシュ（SyncGatewayTargets用）
   */
  readonly mcpServerHash: string;

  /**
   * Custom Claims 設定（オプション）
   * JWT トークンのカスタムクレームを検証してアクセス制御を行う
   * AWS API 形式で直接指定
   * @see https://docs.aws.amazon.com/bedrock-agentcore-control/latest/APIReference/API_CustomClaimValidationType.html
   */
  readonly customClaims?: Array<{
    inboundTokenClaimName: string;
    inboundTokenClaimValueType: "STRING" | "STRING_ARRAY";
    authorizingClaimMatchValue: {
      claimMatchOperator: "EQUALS" | "CONTAINS" | "CONTAINS_ANY";
      claimMatchValue: {
        matchValueString?: string;
        matchValueStringList?: string[];
      };
    };
  }>;
}

/**
 * AgentCore Gateway Construct
 *
 * 以下のリソースを作成:
 * - AgentCore Gateway Role
 * - AgentCore Gateway (AwsCustomResource)
 * - Gateway Target (CfnGatewayTarget)
 * - Synchronize Gateway Targets (AwsCustomResource)
 *
 * customClaims を使用した JWT ベースの認可をサポート
 */
export class AgentCoreGatewayConstruct extends Construct {
  public readonly gatewayRole: iam.Role;
  public readonly gatewayId: string;
  public readonly gatewayUrl: string;
  public readonly gatewayArn: string;
  public readonly gatewayName: string;
  /**
   * Gateway Target (CfnGatewayTarget)
   */
  public readonly gatewayTarget: bedrockagentcore.CfnGatewayTarget;
  /**
   * SyncGatewayTargets Custom Resource
   * MCP サーバーのツール定義が変更された場合に明示的な同期を行う
   */
  public readonly syncGatewayTargets: cr.AwsCustomResource;

  constructor(
    scope: Construct,
    id: string,
    props: AgentCoreGatewayConstructProps
  ) {
    super(scope, id);

    const {
      uniqueId,
      targetName,
      gatewayDiscoveryUrl,
      gatewayClientId,
      runtimeOAuth2CredentialProviderArn,
      runtimeScopeString,
      runtime,
      mcpServerHash,
      customClaims,
    } = props;

    const stack = cdk.Stack.of(this);

    // AgentCore Gateway Role
    this.gatewayRole = new iam.Role(this, "GatewayRole", {
      roleName: `agentcore-gateway-role-${uniqueId}`,
      assumedBy: new iam.ServicePrincipal("bedrock-agentcore.amazonaws.com", {
        conditions: {
          StringEquals: {
            "aws:SourceAccount": stack.account,
          },
          ArnLike: {
            "aws:SourceArn": `arn:aws:bedrock-agentcore:${stack.region}:${stack.account}:*`,
          },
        },
      }),
      inlinePolicies: {
        AgentCorePolicy: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              effect: iam.Effect.ALLOW,
              actions: [
                "bedrock-agentcore:*",
                "bedrock:*",
                "agent-credential-provider:*",
                "iam:PassRole",
                "secretsmanager:GetSecretValue",
                "lambda:InvokeFunction",
              ],
              resources: ["*"],
            }),
          ],
        }),
      },
    });

    // Gateway の設定
    this.gatewayName = `gateway-policy-${uniqueId}`;

    // customJWTAuthorizer 設定
    const customJWTAuthorizerConfig: Record<string, unknown> = {
      discoveryUrl: gatewayDiscoveryUrl,
      allowedClients: [gatewayClientId],
      ...(customClaims && { customClaims }),
    };

    // AgentCore Gateway (AwsCustomResource)
    const gatewayCreateParams: Record<string, unknown> = {
      name: this.gatewayName,
      roleArn: this.gatewayRole.roleArn,
      protocolType: "MCP",
      protocolConfiguration: {
        mcp: {
          supportedVersions: ["2025-03-26"],
          searchType: "SEMANTIC",
        },
      },
      authorizerType: "CUSTOM_JWT",
      authorizerConfiguration: {
        customJWTAuthorizer: customJWTAuthorizerConfig,
      },
      exceptionLevel: "DEBUG",
    };

    const gatewayUpdateParams: Record<string, unknown> = {
      ...gatewayCreateParams,
      gatewayIdentifier: new cr.PhysicalResourceIdReference(),
    };

    const agentCoreGateway = new cr.AwsCustomResource(this, "Gateway", {
      onCreate: {
        service: "bedrock-agentcore-control",
        action: "CreateGateway",
        parameters: gatewayCreateParams,
        physicalResourceId: cr.PhysicalResourceId.fromResponse("gatewayId"),
      },
      onUpdate: {
        service: "bedrock-agentcore-control",
        action: "UpdateGateway",
        parameters: gatewayUpdateParams,
        physicalResourceId: cr.PhysicalResourceId.fromResponse("gatewayId"),
      },
      onDelete: {
        service: "bedrock-agentcore-control",
        action: "DeleteGateway",
        parameters: {
          gatewayIdentifier: new cr.PhysicalResourceIdReference(),
        },
      },
      policy: cr.AwsCustomResourcePolicy.fromStatements([
        new iam.PolicyStatement({
          actions: ["bedrock-agentcore:*"],
          resources: ["*"],
        }),
        // CreateGateway API は roleArn を渡すため iam:PassRole が必要
        new iam.PolicyStatement({
          actions: ["iam:PassRole"],
          resources: [this.gatewayRole.roleArn],
        }),
      ]),
      logRetention: logs.RetentionDays.ONE_WEEK,
      timeout: cdk.Duration.minutes(5),
    });

    this.gatewayId = agentCoreGateway.getResponseField("gatewayId");
    this.gatewayUrl = agentCoreGateway.getResponseField("gatewayUrl");
    this.gatewayArn = agentCoreGateway.getResponseField("gatewayArn");

    // Runtime ARN を encoded URL形式に変換
    const encodedRuntimeArn = cdk.Fn.join("", [
      "https://bedrock-agentcore.",
      stack.region,
      ".amazonaws.com/runtimes/",
      cdk.Fn.join(
        "%2F",
        cdk.Fn.split(
          "/",
          cdk.Fn.join("%3A", cdk.Fn.split(":", runtime.agentRuntimeArn))
        )
      ),
      "/invocations?qualifier=DEFAULT",
    ]);

    // Gateway Target (CfnGatewayTarget)
    this.gatewayTarget = new bedrockagentcore.CfnGatewayTarget(
      this,
      "GatewayTarget",
      {
        name: targetName,
        gatewayIdentifier: this.gatewayId,
        targetConfiguration: {
          mcp: {
            mcpServer: {
              endpoint: encodedRuntimeArn,
            },
          },
        },
        credentialProviderConfigurations: [
          {
            credentialProviderType: "OAUTH",
            credentialProvider: {
              oauthCredentialProvider: {
                providerArn: runtimeOAuth2CredentialProviderArn,
                scopes: [runtimeScopeString],
              },
            },
          },
        ],
      }
    );

    // Synchronize Gateway Targets
    // NOTE: CreateGatewayTarget 時に暗黙的な同期が行われるため、onCreate は不要
    //       MCP サーバーのツール定義が変更された場合（mcpServerHash 変更時）に onUpdate で明示的な同期を行う
    this.syncGatewayTargets = new cr.AwsCustomResource(
      this,
      "SyncGatewayTargets",
      {
        installLatestAwsSdk: true,
        // onCreate は不要（CreateGatewayTarget 時に暗黙的同期が行われる）
        onUpdate: {
          service: "bedrock-agentcore-control",
          action: "SynchronizeGatewayTargets",
          parameters: {
            gatewayIdentifier: this.gatewayId,
            targetIdList: [this.gatewayTarget.attrTargetId],
          },
          physicalResourceId: cr.PhysicalResourceId.of(
            `SyncGatewayTargets-${uniqueId}-${mcpServerHash}`
          ),
        },
        policy: cr.AwsCustomResourcePolicy.fromStatements([
          new iam.PolicyStatement({
            actions: ["bedrock-agentcore:*"],
            resources: ["*"],
          }),
        ]),
        logRetention: logs.RetentionDays.ONE_WEEK,
        timeout: cdk.Duration.minutes(5),
      }
    );

    // SyncGatewayTargets は GatewayTarget の作成完了を待つ必要がある
    this.syncGatewayTargets.node.addDependency(this.gatewayTarget);
  }
}
