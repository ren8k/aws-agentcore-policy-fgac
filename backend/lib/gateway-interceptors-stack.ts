import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import {
  GatewayCognitoConstruct,
  RuntimeCognitoConstruct,
  AgentCoreRuntimeConstruct,
  AgentCoreGatewayConstruct,
  AgentCorePolicyEngineConstruct,
  AgentCorePolicyConstruct,
} from "./constructs";

/**
 * ============================================================================
 * GatewayPolicyStack (旧名: GatewayInterceptorStack)
 *
 * このスタックは以下のリソースを作成します：
 *
 * 1. Cognito User Pool (Gateway用・Runtime用)
 * 2. AgentCore Runtime (L2 Construct)
 * 3. AgentCore Policy Engine (Custom Resource)
 * 4. AgentCore Gateway Role
 * 5. [Custom Resource] OAuth2 Credential Provider (AgenCore Identity)
 *    - Runtime用 (outbound auth - Gateway → Runtime)
 * 6. AgentCore Gateway (CfnGateway L1 Construct)
 * 7. Gateway Target (CfnGatewayTarget L1 Construct)
 * 8. [Custom Resource] SynchronizeGatewayTargets
 * 9. Cedar Policies (Custom Resources)
 *    - Admin Policy: 全アクション許可（完全一致）
 *    - User Policy: retrieve_doc のみ許可（完全一致）
 *
 * NOTE: Interceptor Lambda は削除され、AgentCore Policy で FGAC を実現
 *
 * ============================================================================
 */
export class GatewayInterceptorStack extends cdk.Stack {
  // Cognito
  public readonly gatewayCognito: GatewayCognitoConstruct;
  public readonly runtimeCognito: RuntimeCognitoConstruct;

  // AgentCore
  public readonly agentCoreRuntime: AgentCoreRuntimeConstruct;
  public readonly agentCoreGateway: AgentCoreGatewayConstruct;

  // Policy
  public readonly agentCorePolicyEngine: AgentCorePolicyEngineConstruct;
  public readonly agentCorePolicy: AgentCorePolicyConstruct;

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
    // AgentCore Policy Engine Construct
    // NOTE: Gateway より先に作成する必要がある
    // ========================================
    this.agentCorePolicyEngine = new AgentCorePolicyEngineConstruct(
      this,
      "AgentCorePolicyEngineGroup",
      {
        uniqueId,
      }
    );

    // ========================================
    // AgentCore Gateway Construct
    // - Policy Engine を CreateGateway 時にアタッチ
    // ========================================
    this.agentCoreGateway = new AgentCoreGatewayConstruct(
      this,
      "AgentCoreGatewayGroup",
      {
        uniqueId,
        targetName,
        gatewayDiscoveryUrl: this.gatewayCognito.discoveryUrl,
        gatewayClientId: this.gatewayCognito.userPoolClient.userPoolClientId,
        runtimeDiscoveryUrl: this.runtimeCognito.discoveryUrl,
        runtimeClientId: this.runtimeCognito.userPoolClient.userPoolClientId,
        runtimeClientSecret: this.runtimeCognito.clientSecret,
        runtimeScopeString: this.runtimeCognito.scopeString,
        runtime: this.agentCoreRuntime.runtime,
        mcpServerHash: this.agentCoreRuntime.mcpServerHash,
        // Policy Engine 設定
        policyEngineConfig: {
          policyEngineArn: this.agentCorePolicyEngine.policyEngineArn,
          mode: "ENFORCE",
        },
      }
    );

    // ========================================
    // AgentCore Policy Construct (Cedar Policies)
    // - Gateway Target 作成完了後に実行
    //   (CreateGatewayTarget 時に暗黙的な同期が行われ、ツールスキーマが登録される)
    // - カスタムクレーム (role) を使用してロールベースのアクセス制御
    // ========================================
    this.agentCorePolicy = new AgentCorePolicyConstruct(
      this,
      "AgentCorePolicyGroup",
      {
        uniqueId,
        policyEngineId: this.agentCorePolicyEngine.policyEngineId,
        gatewayArn: this.agentCoreGateway.gatewayArn,
        targetName,
        // Gateway Target 作成完了後にポリシー作成
        // NOTE: CreateGatewayTarget 時に暗黙的な同期が行われ、ツールスキーマが Policy Engine に登録される
        dependsOn: this.agentCoreGateway.gatewayTarget,
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
    new cdk.CfnOutput(this, "PolicyEngineArn", {
      value: this.agentCorePolicyEngine.policyEngineArn,
      description: "AgentCore Policy Engine ARN",
    });
  }
}
