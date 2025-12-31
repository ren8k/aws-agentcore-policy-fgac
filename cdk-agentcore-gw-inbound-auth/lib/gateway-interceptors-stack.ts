import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import {
  GatewayCognitoConstruct,
  RuntimeCognitoConstruct,
  AgentCoreRuntimeConstruct,
  AgentCoreIdentityConstruct,
  AgentCoreGatewayConstruct,
} from "./constructs";

/**
 * ============================================================================
 * GatewayInboundAuthCustomClaimsStack
 *
 * このスタックは以下のリソースを作成します：
 *
 * 1. Cognito User Pool (Gateway用・Runtime用)
 *    - Pre Token Generation Lambda でカスタムクレーム (role) を追加
 * 2. AgentCore Runtime (L2 Construct)
 * 3. AgentCore Identity (OAuth2 Credential Provider)
 *    - Runtime用 (outbound auth - Gateway → Runtime)
 * 4. AgentCore Gateway Role
 * 5. AgentCore Gateway (Custom Resource - customClaims サポート)
 *    - customJWTAuthorizer.customClaims で role="admin" のみ許可
 * 6. Gateway Target (CfnGatewayTarget L1 Construct)
 * 7. [Custom Resource] SynchronizeGatewayTargets (onUpdate のみ)
 *
 * NOTE: Policy Engine/Cedar Policy は使用せず、customClaims で認可を実現
 *       role="admin" のユーザーのみ Gateway にアクセス可能
 *
 * ============================================================================
 */
export class GatewayInboundAuthCustomClaimsStack extends cdk.Stack {
  // Cognito
  public readonly gatewayCognito: GatewayCognitoConstruct;
  public readonly runtimeCognito: RuntimeCognitoConstruct;

  // AgentCore
  public readonly agentCoreRuntime: AgentCoreRuntimeConstruct;
  public readonly agentCoreIdentity: AgentCoreIdentityConstruct;
  public readonly agentCoreGateway: AgentCoreGatewayConstruct;

  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // ========================================
    // 固定のユニークID（デプロイ毎に変わらない）
    // 初回デプロイ後は変更しないこと
    // ========================================
    const uniqueId = id.toLowerCase();
    const targetName = `mcp-target-${uniqueId}`; // AgentCore Gateway Target

    // ========================================
    // テストユーザー設定
    // - admin@example.com: role="admin" → アクセス可能
    // - user@example.com: role="user" → アクセス拒否
    // ========================================
    const testUsers = [
      { email: "admin@example.com", password: "Pass123!" },
      { email: "user@example.com", password: "Pass123!" },
    ];
    const callbackUrls = ["http://localhost:8080/callback"];
    const logoutUrls = ["http://localhost:8080/logout"];

    // ========================================
    // Gateway Cognito Construct
    // ========================================
    this.gatewayCognito = new GatewayCognitoConstruct(
      this,
      "GatewayCognitoGroup",
      {
        uniqueId,
        targetName,
        testUsers,
        callbackUrls,
        logoutUrls,
      }
    );

    // ========================================
    // Runtime Cognito Construct
    // ========================================
    this.runtimeCognito = new RuntimeCognitoConstruct(
      this,
      "RuntimeCognitoGroup",
      {
        uniqueId,
      }
    );

    // ========================================
    // AgentCore Runtime Construct
    // ========================================
    this.agentCoreRuntime = new AgentCoreRuntimeConstruct(
      this,
      "AgentCoreRuntimeGroup",
      {
        uniqueId,
        runtimeUserPool: this.runtimeCognito.userPool,
        runtimeUserPoolClient: this.runtimeCognito.userPoolClient,
      }
    );

    // ========================================
    // AgentCore Identity Construct (OAuth2 Credential Provider)
    // - Runtime への認証に使用
    // ========================================
    this.agentCoreIdentity = new AgentCoreIdentityConstruct(
      this,
      "AgentCoreIdentityGroup",
      {
        uniqueId,
        namePrefix: "runtime-oauth2-provider",
        discoveryUrl: this.runtimeCognito.discoveryUrl,
        clientId: this.runtimeCognito.userPoolClient.userPoolClientId,
        clientSecret: this.runtimeCognito.clientSecret,
      }
    );

    // ========================================
    // AgentCore Gateway Construct
    // - customClaims で role="admin" のみ許可
    // - Policy Engine は使用しない
    // ========================================
    this.agentCoreGateway = new AgentCoreGatewayConstruct(
      this,
      "AgentCoreGatewayGroup",
      {
        uniqueId,
        targetName,
        gatewayDiscoveryUrl: this.gatewayCognito.discoveryUrl,
        gatewayClientId: this.gatewayCognito.userPoolClient.userPoolClientId,
        runtimeOAuth2CredentialProviderArn:
          this.agentCoreIdentity.credentialProviderArn,
        runtimeScopeString: this.runtimeCognito.scopeString,
        runtime: this.agentCoreRuntime.runtime,
        mcpServerHash: this.agentCoreRuntime.mcpServerHash,
        // customClaims: role="admin" のユーザーのみアクセス許可
        customClaims: [
          {
            inboundTokenClaimName: "role",
            inboundTokenClaimValueType: "STRING",
            authorizingClaimMatchValue: {
              claimMatchOperator: "EQUALS",
              claimMatchValue: { matchValueString: "admin" },
            },
          },
        ],
      }
    );

    // ========================================
    // Outputs
    // ========================================
    new cdk.CfnOutput(this, "GatewayCognitoClientId", {
      value: this.gatewayCognito.userPoolClient.userPoolClientId,
      description: "Gateway Cognito Client ID",
    });
    new cdk.CfnOutput(this, "AgentCoreGatewayUrl", {
      value: this.agentCoreGateway.gatewayUrl,
      description: "AgentCore Gateway URL",
    });
    new cdk.CfnOutput(this, "AgentCoreGatewayArn", {
      value: this.agentCoreGateway.gatewayArn,
      description: "AgentCore Gateway ARN",
    });
    new cdk.CfnOutput(this, "GatewayCognitoDomain", {
      value: this.gatewayCognito.domainPrefix,
      description: "Gateway Cognito Domain Prefix (for streamlit app)",
    });
    new cdk.CfnOutput(this, "AgentCoreGatewayTargetName", {
      value: targetName,
      description: "AgentCore Gateway Target Name",
    });
  }
}
