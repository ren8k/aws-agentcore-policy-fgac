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
 * NOTE: AgentCore Policy を使用するため、Interceptor Lambda は不要になりました
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
   * Runtime認証用の Discovery URL
   */
  readonly runtimeDiscoveryUrl: string;

  /**
   * Runtime認証用の Client ID
   */
  readonly runtimeClientId: string;

  /**
   * Runtime認証用の Client Secret
   */
  readonly runtimeClientSecret: string;

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
   * Policy Engine 設定（オプション）
   * 指定された場合、Gateway 作成時に Policy Engine をアタッチ
   * NOTE: Cedar Policy は AgentCorePolicyConstruct で作成
   */
  readonly policyEngineConfig?: {
    /**
     * Policy Engine ARN
     */
    policyEngineArn: string;

    /**
     * Policy Engine のモード（デフォルト: ENFORCE）
     */
    mode?: "LOG_ONLY" | "ENFORCE";
  };
}

/**
 * AgentCore Gateway Construct
 *
 * 以下のリソースを作成:
 * - AgentCore Gateway Role
 * - OAuth2 Credential Provider (Runtime用 AgentCore Identity)
 * - AgentCore Gateway (L1 Construct) with Policy Engine
 * - Gateway Target (L1 Construct)
 * - Synchronize Gateway Targets (Custom Resource)
 *
 * NOTE: AgentCore Policy を使用するため、Interceptor は設定しません。
 *       Policy Engine は CreateGateway 時に policyEngineConfiguration で設定します。
 *       Cedar Policy は AgentCorePolicyConstruct で作成します。
 */
export class AgentCoreGatewayConstruct extends Construct {
  public readonly gatewayRole: iam.Role;
  public readonly gatewayId: string;
  public readonly gatewayUrl: string;
  public readonly gatewayArn: string;
  public readonly gatewayName: string;
  public readonly runtimeOAuth2CredentialProviderArn: string;
  /**
   * Gateway Target (CfnGatewayTarget)
   * CreateGatewayTarget 時に暗黙的な同期が行われ、ツールスキーマが Policy Engine に登録される
   * Policy 作成時に依存関係を設定するために公開
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
      runtimeDiscoveryUrl,
      runtimeClientId,
      runtimeClientSecret,
      runtimeScopeString,
      runtime,
      mcpServerHash,
      policyEngineConfig,
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
            // Policy Engine トレースを CloudWatch Logs に記録するための権限
            new iam.PolicyStatement({
              effect: iam.Effect.ALLOW,
              actions: [
                "logs:CreateLogGroup",
                "logs:CreateLogStream",
                "logs:PutLogEvents",
                "logs:DescribeLogGroups",
                "logs:DescribeLogStreams",
              ],
              resources: ["*"],
            }),
          ],
        }),
      },
    });

    // OAuth2 Credential Provider for Runtime (AgentCore Identity)
    const runtimeOAuth2ProviderName = `runtime-oauth2-provider-${uniqueId}`;

    const runtimeOAuth2ProviderConfigInput = {
      customOauth2ProviderConfig: {
        oauthDiscovery: {
          discoveryUrl: runtimeDiscoveryUrl,
        },
        clientId: runtimeClientId,
        clientSecret: runtimeClientSecret,
      },
    };

    const runtimeOAuth2Provider = new cr.AwsCustomResource(
      this,
      "RuntimeOAuth2CredentialProvider",
      {
        onCreate: {
          service: "bedrock-agentcore-control",
          action: "CreateOauth2CredentialProvider",
          parameters: {
            name: runtimeOAuth2ProviderName,
            credentialProviderVendor: "CustomOauth2",
            oauth2ProviderConfigInput: runtimeOAuth2ProviderConfigInput,
          },
          physicalResourceId: cr.PhysicalResourceId.fromResponse(
            "credentialProviderArn"
          ),
        },
        onUpdate: {
          service: "bedrock-agentcore-control",
          action: "UpdateOauth2CredentialProvider",
          parameters: {
            name: runtimeOAuth2ProviderName,
            credentialProviderVendor: "CustomOauth2",
            oauth2ProviderConfigInput: runtimeOAuth2ProviderConfigInput,
          },
          physicalResourceId: cr.PhysicalResourceId.fromResponse(
            "credentialProviderArn"
          ),
        },
        onDelete: {
          service: "bedrock-agentcore-control",
          action: "DeleteOauth2CredentialProvider",
          parameters: {
            name: runtimeOAuth2ProviderName,
          },
        },
        policy: cr.AwsCustomResourcePolicy.fromStatements([
          new iam.PolicyStatement({
            actions: ["bedrock-agentcore:*", "secretsmanager:*"],
            resources: ["*"],
          }),
        ]),
        logRetention: logs.RetentionDays.ONE_WEEK,
      }
    );

    this.runtimeOAuth2CredentialProviderArn =
      runtimeOAuth2Provider.getResponseField("credentialProviderArn");

    // Gateway の設定
    this.gatewayName = `gateway-policy-${uniqueId}`;

    // AgentCore Gateway (AwsCustomResource)
    // NOTE: CloudFormation の AWS::BedrockAgentCore::Gateway は PolicyEngineConfiguration を
    //       サポートしていないため、AwsCustomResource で CreateGateway API を直接呼び出す
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
        customJWTAuthorizer: {
          discoveryUrl: gatewayDiscoveryUrl,
          allowedClients: [gatewayClientId],
        },
      },
      exceptionLevel: "DEBUG",
    };

    // Policy Engine 設定を追加（オプション）
    if (policyEngineConfig) {
      gatewayCreateParams.policyEngineConfiguration = {
        arn: policyEngineConfig.policyEngineArn,
        mode: policyEngineConfig.mode ?? "ENFORCE",
      };
    }

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

    // Gateway Target (L1 Construct)
    // NOTE: CreateGatewayTarget 時に暗黙的な同期が行われ、ツールスキーマが Policy Engine に登録される
    //       READY 状態のターゲットはすぐに使用可能
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
                providerArn: runtimeOAuth2Provider.getResponseField(
                  "credentialProviderArn"
                ),
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
