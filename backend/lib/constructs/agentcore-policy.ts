import * as cdk from "aws-cdk-lib";
import * as iam from "aws-cdk-lib/aws-iam";
import * as cr from "aws-cdk-lib/custom-resources";
import * as logs from "aws-cdk-lib/aws-logs";
import { Construct } from "constructs";

/**
 * AgentCorePolicyConstruct の Props
 */
export interface AgentCorePolicyConstructProps {
  /**
   * ユニークID（リソース名の接尾辞として使用）
   */
  readonly uniqueId: string;

  /**
   * Policy Engine ID
   */
  readonly policyEngineId: string;

  /**
   * Gateway ARN（Cedar Policy の resource に使用）
   */
  readonly gatewayArn: string;

  /**
   * Gateway Target 名（Cedar Policy の action に使用）
   * アクション名形式: "{TargetName}__{ToolName}"
   */
  readonly targetName: string;
}

/**
 * AgentCore Policy Construct
 *
 * Cedar Policy を作成します。
 * Cognito Pre Token Lambda で追加されたカスタムクレーム（role）を使用してアクセス制御を行います。
 *
 * ロールベースのアクセス制御:
 * - Admin (role="admin"): 全アクション許可
 * - User (role="user"): retrieve_doc のみ許可
 *
 * NOTE: カスタムクレームは principal.getTag() で取得可能
 */
export class AgentCorePolicyConstruct extends Construct {
  constructor(
    scope: Construct,
    id: string,
    props: AgentCorePolicyConstructProps
  ) {
    super(scope, id);

    const { uniqueId, policyEngineId, gatewayArn, targetName } = props;

    const sanitizedUniqueId = uniqueId.replace(/-/g, "_");

    // ポリシー定義
    // カスタムクレーム "role" を使用してロールベースのアクセス制御
    const policies: Array<{
      name: string;
      description: string;
      cedarStatement: string;
    }> = [
      {
        name: `admin_policy_${sanitizedUniqueId}`,
        description: "Admin: 全アクション許可（role=admin）",
        cedarStatement: `permit(
  principal is AgentCore::OAuthUser,
  action,
  resource == AgentCore::Gateway::"${gatewayArn}"
) when {
  principal.hasTag("role") &&
  principal.getTag("role") == "admin"
};`,
      },
      {
        name: `user_policy_${sanitizedUniqueId}`,
        description: "User: retrieve_doc のみ許可（role=user）",
        // NOTE: MCP Target のアクション名形式は "{TargetName}___{ToolName}" (トリプルアンダースコア)
        //       action == を使用して特定アクションのみ許可
        cedarStatement: `permit(
  principal is AgentCore::OAuthUser,
  action == AgentCore::Action::"${targetName}___retrieve_doc",
  resource == AgentCore::Gateway::"${gatewayArn}"
) when {
  principal.hasTag("role") &&
  principal.getTag("role") == "user"
};`,
      },
    ];

    // 各ポリシーを作成
    policies.forEach((policyDef, index) => {
      new cr.AwsCustomResource(
        this,
        `Policy_${index === 0 ? "admin" : "user"}`,
        {
          onCreate: {
            service: "bedrock-agentcore-control",
            action: "CreatePolicy",
            parameters: {
              policyEngineId: policyEngineId,
              name: policyDef.name,
              description: policyDef.description,
              definition: {
                cedar: {
                  statement: policyDef.cedarStatement,
                },
              },
              validationMode: "IGNORE_ALL_FINDINGS",
            },
            physicalResourceId: cr.PhysicalResourceId.fromResponse("policyId"),
          },
          onUpdate: {
            service: "bedrock-agentcore-control",
            action: "UpdatePolicy",
            parameters: {
              policyEngineId: policyEngineId,
              policyId: new cr.PhysicalResourceIdReference(),
              description: policyDef.description,
              definition: {
                cedar: {
                  statement: policyDef.cedarStatement,
                },
              },
              validationMode: "IGNORE_ALL_FINDINGS",
            },
          },
          onDelete: {
            service: "bedrock-agentcore-control",
            action: "DeletePolicy",
            parameters: {
              policyEngineId: policyEngineId,
              policyId: new cr.PhysicalResourceIdReference(),
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
        }
      );
    });
  }
}
