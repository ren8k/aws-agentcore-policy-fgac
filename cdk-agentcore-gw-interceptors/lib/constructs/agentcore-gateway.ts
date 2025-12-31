import * as cdk from "aws-cdk-lib";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as cr from "aws-cdk-lib/custom-resources";
import * as logs from "aws-cdk-lib/aws-logs";
import * as bedrockagentcore from "aws-cdk-lib/aws-bedrockagentcore";
import { Construct } from "constructs";
import * as agentcore from "@aws-cdk/aws-bedrock-agentcore-alpha";

/**
 * AgentCoreGatewayConstruct の Props
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
   * Request Interceptor Lambda
   */
  readonly requestInterceptor: lambda.Function;

  /**
   * Response Interceptor Lambda
   */
  readonly responseInterceptor: lambda.Function;

  /**
   * AgentCore Runtime
   */
  readonly runtime: agentcore.Runtime;

  /**
   * MCPサーバーのソースハッシュ（SyncGatewayTargets用）
   */
  readonly mcpServerHash: string;
}

/**
 * AgentCore Gateway Construct
 *
 * 以下のリソースを作成:
 * - AgentCore Gateway Role
 * - AgentCore Gateway (L1 Construct) with Interceptors
 * - Gateway Target (L1 Construct)
 * - Synchronize Gateway Targets (Custom Resource)
 */
export class AgentCoreGatewayConstruct extends Construct {
  public readonly gatewayRole: iam.Role;
  public readonly gatewayId: string;
  public readonly gatewayUrl: string;
  public readonly gatewayArn: string;

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
      requestInterceptor,
      responseInterceptor,
      runtime,
      mcpServerHash,
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
    const gatewayName = `gateway-interceptor-${uniqueId}`;

    // AgentCore Gateway (L1 Construct)
    const agentCoreGateway = new bedrockagentcore.CfnGateway(this, "Gateway", {
      name: gatewayName,
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
        customJwtAuthorizer: {
          discoveryUrl: gatewayDiscoveryUrl,
          allowedClients: [gatewayClientId],
        },
      },
      exceptionLevel: "DEBUG",
    });

    // InterceptorConfigurations は現在の aws-cdk-lib の型定義に含まれていないため
    // addPropertyOverride を使用して追加
    agentCoreGateway.addPropertyOverride("InterceptorConfigurations", [
      {
        Interceptor: {
          Lambda: {
            Arn: requestInterceptor.functionArn,
          },
        },
        InterceptionPoints: ["REQUEST"],
        InputConfiguration: {
          PassRequestHeaders: true,
        },
      },
      {
        Interceptor: {
          Lambda: {
            Arn: responseInterceptor.functionArn,
          },
        },
        InterceptionPoints: ["RESPONSE"],
        InputConfiguration: {
          PassRequestHeaders: false,
        },
      },
    ]);

    this.gatewayId = agentCoreGateway.attrGatewayIdentifier;
    this.gatewayUrl = agentCoreGateway.attrGatewayUrl;
    this.gatewayArn = agentCoreGateway.attrGatewayArn;

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
    const gatewayTarget = new bedrockagentcore.CfnGatewayTarget(
      this,
      "GatewayTarget",
      {
        name: targetName,
        gatewayIdentifier: agentCoreGateway.attrGatewayIdentifier,
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
    // SynchronizeGatewayTargets API には対応する CloudFormation リソースがないため
    // AwsCustomResource を使用
    const syncGatewayTargets = new cr.AwsCustomResource(
      this,
      "SyncGatewayTargets",
      {
        installLatestAwsSdk: true,
        onCreate: {
          service: "bedrock-agentcore-control",
          action: "SynchronizeGatewayTargets",
          parameters: {
            gatewayIdentifier: agentCoreGateway.attrGatewayIdentifier,
            targetIdList: [gatewayTarget.attrTargetId],
          },
          physicalResourceId: cr.PhysicalResourceId.of(
            `SyncGatewayTargets-${uniqueId}-${mcpServerHash}`
          ),
        },
        onUpdate: {
          service: "bedrock-agentcore-control",
          action: "SynchronizeGatewayTargets",
          parameters: {
            gatewayIdentifier: agentCoreGateway.attrGatewayIdentifier,
            targetIdList: [gatewayTarget.attrTargetId],
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
    syncGatewayTargets.node.addDependency(gatewayTarget);
  }
}
