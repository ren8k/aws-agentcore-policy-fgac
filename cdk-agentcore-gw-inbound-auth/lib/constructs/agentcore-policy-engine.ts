import * as cdk from "aws-cdk-lib";
import * as iam from "aws-cdk-lib/aws-iam";
import * as cr from "aws-cdk-lib/custom-resources";
import * as logs from "aws-cdk-lib/aws-logs";
import { Construct } from "constructs";

/**
 * AgentCorePolicyEngineConstruct の Props
 */
export interface AgentCorePolicyEngineConstructProps {
  /**
   * ユニークID（リソース名の接尾辞として使用）
   */
  readonly uniqueId: string;
}

/**
 * AgentCore Policy Engine Construct
 *
 * Policy Engine を作成します。
 * Cedar Policy は AgentCorePolicyConstruct で作成されます。
 *
 * NOTE: Gateway へのアタッチは AgentCoreGatewayConstruct で行う
 *       (CreateGateway API の policyEngineConfiguration を使用)
 */
export class AgentCorePolicyEngineConstruct extends Construct {
  public readonly policyEngineArn: string;
  public readonly policyEngineId: string;

  constructor(
    scope: Construct,
    id: string,
    props: AgentCorePolicyEngineConstructProps
  ) {
    super(scope, id);

    const { uniqueId } = props;

    // ==================================================
    // Policy Engine の作成
    // ==================================================
    const policyEngineName = `PolicyEngine_${uniqueId.replace(/-/g, "_")}`;

    const policyEngine = new cr.AwsCustomResource(this, "PolicyEngine", {
      onCreate: {
        service: "bedrock-agentcore-control",
        action: "CreatePolicyEngine",
        parameters: {
          name: policyEngineName,
          description: `Policy engine for AgentCore FGAC (${uniqueId})`,
        },
        physicalResourceId: cr.PhysicalResourceId.fromResponse("policyEngineId"),
      },
      onDelete: {
        service: "bedrock-agentcore-control",
        action: "DeletePolicyEngine",
        parameters: {
          policyEngineId: new cr.PhysicalResourceIdReference(),
        },
      },
      installLatestAwsSdk: true,
      policy: cr.AwsCustomResourcePolicy.fromStatements([
        new iam.PolicyStatement({
          actions: ["bedrock-agentcore:*"],
          resources: ["*"],
        }),
      ]),
      logRetention: logs.RetentionDays.ONE_WEEK,
      timeout: cdk.Duration.minutes(5),
    });

    this.policyEngineId = policyEngine.getResponseField("policyEngineId");
    this.policyEngineArn = policyEngine.getResponseField("policyEngineArn");
  }
}
