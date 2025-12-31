import * as iam from "aws-cdk-lib/aws-iam";
import * as cr from "aws-cdk-lib/custom-resources";
import * as logs from "aws-cdk-lib/aws-logs";
import { Construct } from "constructs";

/**
 * AgentCoreIdentityConstruct の Props
 */
export interface AgentCoreIdentityConstructProps {
  /**
   * ユニークID（リソース名の接尾辞として使用）
   */
  readonly uniqueId: string;

  /**
   * OAuth2 Provider 名のプレフィックス
   */
  readonly namePrefix: string;

  /**
   * OAuth2 Discovery URL
   */
  readonly discoveryUrl: string;

  /**
   * OAuth2 Client ID
   */
  readonly clientId: string;

  /**
   * OAuth2 Client Secret
   */
  readonly clientSecret: string;
}

/**
 * AgentCore Identity Construct
 *
 * OAuth2 Credential Provider を作成します。
 * Gateway Target が Runtime に接続する際の認証に使用されます。
 */
export class AgentCoreIdentityConstruct extends Construct {
  /**
   * OAuth2 Credential Provider ARN
   */
  public readonly credentialProviderArn: string;

  /**
   * OAuth2 Credential Provider 名
   */
  public readonly credentialProviderName: string;

  constructor(
    scope: Construct,
    id: string,
    props: AgentCoreIdentityConstructProps
  ) {
    super(scope, id);

    const { uniqueId, namePrefix, discoveryUrl, clientId, clientSecret } =
      props;

    this.credentialProviderName = `${namePrefix}-${uniqueId}`;

    const oauth2ProviderConfigInput = {
      customOauth2ProviderConfig: {
        oauthDiscovery: {
          discoveryUrl,
        },
        clientId,
        clientSecret,
      },
    };

    const oauth2Provider = new cr.AwsCustomResource(
      this,
      "OAuth2CredentialProvider",
      {
        onCreate: {
          service: "bedrock-agentcore-control",
          action: "CreateOauth2CredentialProvider",
          parameters: {
            name: this.credentialProviderName,
            credentialProviderVendor: "CustomOauth2",
            oauth2ProviderConfigInput,
          },
          physicalResourceId: cr.PhysicalResourceId.fromResponse(
            "credentialProviderArn"
          ),
        },
        onUpdate: {
          service: "bedrock-agentcore-control",
          action: "UpdateOauth2CredentialProvider",
          parameters: {
            name: this.credentialProviderName,
            credentialProviderVendor: "CustomOauth2",
            oauth2ProviderConfigInput,
          },
          physicalResourceId: cr.PhysicalResourceId.fromResponse(
            "credentialProviderArn"
          ),
        },
        onDelete: {
          service: "bedrock-agentcore-control",
          action: "DeleteOauth2CredentialProvider",
          parameters: {
            name: this.credentialProviderName,
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

    this.credentialProviderArn = oauth2Provider.getResponseField(
      "credentialProviderArn"
    );
  }
}
