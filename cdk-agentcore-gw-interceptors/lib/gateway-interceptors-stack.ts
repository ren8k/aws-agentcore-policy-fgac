import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import {
  GatewayCognitoConstruct,
  RuntimeCognitoConstruct,
  InterceptorLambdaConstruct,
  AgentCoreRuntimeConstruct,
  AgentCoreIdentityConstruct,
  AgentCoreGatewayConstruct,
} from "./constructs";

/**
 * ============================================================================
 * GatewayInterceptorStack
 *
 * このスタックは以下のリソースを作成します：
 *
 * 1. Cognito User Pool (Gateway用・Runtime用)
 * 2. Lambda関数 (Request Interceptor・Response Interceptor)
 * 3. AgentCore Runtime (L2 Construct)
 * 4. AgentCore Identity (OAuth2 Credential Provider)
 *    - Runtime用 (outbound auth - Gateway → Runtime)
 * 5. AgentCore Gateway Role
 * 6. AgentCore Gateway with Interceptors (CfnGateway L1 Construct)
 *    - InterceptorConfigurations は型定義未対応のため addPropertyOverride で追加
 * 7. Gateway Target (CfnGatewayTarget L1 Construct)
 * 8. [Custom Resource] SynchronizeGatewayTargets
 *
 * ============================================================================
 */
export class GatewayInterceptorStack extends cdk.Stack {
  // Cognito
  public readonly gatewayCognito: GatewayCognitoConstruct;
  public readonly runtimeCognito: RuntimeCognitoConstruct;

  // Lambda
  public readonly interceptorLambdas: InterceptorLambdaConstruct;

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
    // Interceptor Lambdas Construct
    // ========================================
    this.interceptorLambdas = new InterceptorLambdaConstruct(
      this,
      "InterceptorLambdasGroup",
      {
        targetName,
        resourceServerId:
          this.gatewayCognito.resourceServer.userPoolResourceServerId,
        jwksUrl: `https://cognito-idp.${this.region}.amazonaws.com/${this.gatewayCognito.userPool.userPoolId}/.well-known/jwks.json`,
        clientId: this.gatewayCognito.userPoolClient.userPoolClientId,
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
        requestInterceptor: this.interceptorLambdas.requestInterceptor,
        responseInterceptor: this.interceptorLambdas.responseInterceptor,
        runtime: this.agentCoreRuntime.runtime,
        mcpServerHash: this.agentCoreRuntime.mcpServerHash,
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
