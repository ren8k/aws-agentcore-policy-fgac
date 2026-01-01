import * as cdk from "aws-cdk-lib";
import * as cognito from "aws-cdk-lib/aws-cognito";
import * as iam from "aws-cdk-lib/aws-iam";
import * as cr from "aws-cdk-lib/custom-resources";
import * as logs from "aws-cdk-lib/aws-logs";
import { Construct } from "constructs";

/**
 * RuntimeCognitoConstruct の Props
 */
export interface RuntimeCognitoConstructProps {
  /**
   * ユニークID（リソース名の接尾辞として使用）
   */
  readonly uniqueId: string;
}

/**
 * Runtime用 Cognito User Pool Construct
 *
 * 以下のリソースを作成:
 * - Cognito User Pool (Runtime)
 * - Cognito Domain
 * - Resource Server with 'tools' scope
 * - User Pool Client (M2M認証用、client_credentials)
 * - Custom Resource for Client Secret retrieval
 */
export class RuntimeCognitoConstruct extends Construct {
  public readonly userPool: cognito.UserPool;
  public readonly userPoolClient: cognito.UserPoolClient;
  public readonly resourceServer: cognito.UserPoolResourceServer;
  public readonly clientSecret: string;
  public readonly discoveryUrl: string;
  public readonly scopeString: string;

  constructor(
    scope: Construct,
    id: string,
    props: RuntimeCognitoConstructProps
  ) {
    super(scope, id);

    const { uniqueId } = props;
    const stack = cdk.Stack.of(this);

    // Cognito User Pool for Runtime
    this.userPool = new cognito.UserPool(this, "UserPool", {
      userPoolName: `runtime-pool-${uniqueId}`,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // Runtime OAuth token endpoint用のドメインを追加
    const poolDomain = this.userPool.addDomain("Domain", {
      cognitoDomain: {
        domainPrefix: `rt-pool-${uniqueId}`.toLowerCase(),
      },
    });

    // Runtime Resource Server with simple 'tools' scope
    const runtimeScope = {
      scopeName: "tools",
      scopeDescription:
        "Scope for search, list and invoke the agentcore gateway",
    };

    this.resourceServer = new cognito.UserPoolResourceServer(
      this,
      "ResourceServer",
      {
        userPool: this.userPool,
        identifier: `runtime-id-${uniqueId}`,
        scopes: [runtimeScope],
      }
    );

    // User Pool Client (M2M認証用)
    this.userPoolClient = new cognito.UserPoolClient(this, "Client", {
      userPool: this.userPool,
      userPoolClientName: `runtime-client-${uniqueId}`,
      generateSecret: true,
      oAuth: {
        flows: { clientCredentials: true },
        scopes: [
          cognito.OAuthScope.resourceServer(this.resourceServer, runtimeScope),
        ],
      },
    });

    // Scope String (OAuth2Provider で使用)
    this.scopeString = `${this.resourceServer.userPoolResourceServerId}/${runtimeScope.scopeName}`;

    // Custom Resource: Cognito Client Secret を取得
    const describeClientParams = {
      UserPoolId: this.userPool.userPoolId,
      ClientId: this.userPoolClient.userPoolClientId,
    };

    const describeClient = new cr.AwsCustomResource(
      this,
      "DescribeUserPoolClient",
      {
        onCreate: {
          service: "CognitoIdentityServiceProvider",
          action: "describeUserPoolClient",
          parameters: describeClientParams,
          physicalResourceId: cr.PhysicalResourceId.of("DescribeRuntimeClient"),
        },
        onUpdate: {
          service: "CognitoIdentityServiceProvider",
          action: "describeUserPoolClient",
          parameters: describeClientParams,
          physicalResourceId: cr.PhysicalResourceId.of("DescribeRuntimeClient"),
        },
        policy: cr.AwsCustomResourcePolicy.fromStatements([
          new iam.PolicyStatement({
            actions: ["cognito-idp:DescribeUserPoolClient"],
            resources: [this.userPool.userPoolArn],
          }),
        ]),
        logRetention: logs.RetentionDays.ONE_WEEK,
      }
    );

    this.clientSecret = describeClient.getResponseField(
      "UserPoolClient.ClientSecret"
    );

    // Discovery URL
    this.discoveryUrl = `https://cognito-idp.${stack.region}.amazonaws.com/${this.userPool.userPoolId}/.well-known/openid-configuration`;
  }
}
