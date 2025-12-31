import * as cdk from "aws-cdk-lib";
import * as cognito from "aws-cdk-lib/aws-cognito";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as cr from "aws-cdk-lib/custom-resources";
import * as logs from "aws-cdk-lib/aws-logs";
import { Construct } from "constructs";
import * as path from "path";

/**
 * GatewayCognitoConstruct の Props
 */
export interface GatewayCognitoConstructProps {
  /**
   * ユニークID（リソース名の接尾辞として使用）
   */
  readonly uniqueId: string;

  /**
   * AgentCore Gateway のターゲット名（Pre Token Lambda で使用）
   */
  readonly targetName: string;

  /**
   * テストユーザー設定
   */
  readonly testUsers: Array<{ email: string; password: string }>;

  /**
   * OAuth コールバックURL
   */
  readonly callbackUrls: string[];

  /**
   * OAuth ログアウトURL
   */
  readonly logoutUrls: string[];
}

/**
 * Gateway用 Cognito User Pool Construct
 *
 * 以下のリソースを作成:
 * - Pre Token Generation Lambda
 * - Cognito User Pool
 * - Cognito Domain
 * - Resource Server
 * - User Pool Client
 * - Managed Login Branding
 * - Test Users
 */
export class GatewayCognitoConstruct extends Construct {
  public readonly userPool: cognito.UserPool;
  public readonly userPoolClient: cognito.UserPoolClient;
  public readonly resourceServer: cognito.UserPoolResourceServer;
  public readonly preTokenLambda: lambda.Function;
  public readonly discoveryUrl: string;
  public readonly domainPrefix: string;

  constructor(
    scope: Construct,
    id: string,
    props: GatewayCognitoConstructProps
  ) {
    super(scope, id);

    const { uniqueId, targetName, testUsers, callbackUrls, logoutUrls } = props;
    const stack = cdk.Stack.of(this);

    // Pre Token Generation Lambda
    this.preTokenLambda = new lambda.Function(this, "PreTokenGeneration", {
      runtime: lambda.Runtime.PYTHON_3_13,
      handler: "index.lambda_handler",
      code: lambda.Code.fromAsset(
        path.join(__dirname, "../../lambda/pre_token")
      ),
      timeout: cdk.Duration.seconds(10),
      environment: {
        RESOURCE_SERVER_ID: `gateway-interceptor-id-${uniqueId}`,
        TARGET_NAME: targetName,
      },
    });

    // Cognito User Pool
    this.userPool = new cognito.UserPool(this, "UserPool", {
      userPoolName: `gateway-interceptor-pool-${uniqueId}`,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      signInAliases: { email: true },
      autoVerify: { email: false },
    });

    // V2_0 トリガーを使用して scopesToAdd を有効化
    this.userPool.addTrigger(
      cognito.UserPoolOperation.PRE_TOKEN_GENERATION_CONFIG,
      this.preTokenLambda,
      cognito.LambdaVersion.V2_0
    );

    // OAuth token endpoint用のドメインを追加（マネージドログイン有効化）
    this.domainPrefix = `gw-pool-${uniqueId}`.toLowerCase();
    const poolDomain = this.userPool.addDomain("Domain", {
      cognitoDomain: {
        domainPrefix: this.domainPrefix,
      },
      managedLoginVersion: cognito.ManagedLoginVersion.NEWER_MANAGED_LOGIN,
    });

    // Resource Server
    this.resourceServer = new cognito.UserPoolResourceServer(
      this,
      "ResourceServer",
      {
        userPool: this.userPool,
        identifier: `gateway-interceptor-id-${uniqueId}`,
      }
    );

    // User Pool Client
    this.userPoolClient = new cognito.UserPoolClient(this, "Client", {
      userPool: this.userPool,
      userPoolClientName: `gateway-interceptor-client-${uniqueId}`,
      generateSecret: false,
      oAuth: {
        flows: {
          authorizationCodeGrant: true, // 3lo
        },
        callbackUrls: callbackUrls,
        logoutUrls: logoutUrls,
        scopes: [
          cognito.OAuthScope.OPENID,
          cognito.OAuthScope.EMAIL,
          cognito.OAuthScope.PROFILE,
        ],
      },
    });

    // マネージドログインブランディング
    const managedLoginBranding = new cognito.CfnManagedLoginBranding(
      this,
      "ManagedLoginBranding",
      {
        userPoolId: this.userPool.userPoolId,
        clientId: this.userPoolClient.userPoolClientId,
        useCognitoProvidedValues: true,
      }
    );
    managedLoginBranding.node.addDependency(this.userPool);
    managedLoginBranding.node.addDependency(this.userPoolClient);

    // テストユーザー作成
    testUsers.forEach((user, index) => {
      const testUser = new cognito.CfnUserPoolUser(
        this,
        `TestUser${index + 1}`,
        {
          userPoolId: this.userPool.userPoolId,
          username: user.email,
          userAttributes: [{ name: "email_verified", value: "true" }],
          messageAction: "SUPPRESS",
        }
      );
      testUser.node.addDependency(this.userPool);

      const setPassword = new cr.AwsCustomResource(
        this,
        `SetPassword${index + 1}`,
        {
          onCreate: {
            service: "CognitoIdentityServiceProvider",
            action: "adminSetUserPassword",
            parameters: {
              UserPoolId: this.userPool.userPoolId,
              Username: user.email,
              Password: user.password,
              Permanent: true,
            },
            physicalResourceId: cr.PhysicalResourceId.of(
              `SetPassword${index + 1}`
            ),
          },
          policy: cr.AwsCustomResourcePolicy.fromSdkCalls({
            resources: [this.userPool.userPoolArn],
          }),
          logRetention: logs.RetentionDays.ONE_WEEK,
        }
      );
      setPassword.node.addDependency(testUser);
    });

    // Discovery URL
    this.discoveryUrl = `https://cognito-idp.${stack.region}.amazonaws.com/${this.userPool.userPoolId}/.well-known/openid-configuration`;
  }
}
