import * as cdk from "aws-cdk-lib";
import * as lambda from "aws-cdk-lib/aws-lambda";
import { Construct } from "constructs";
import * as path from "path";

/**
 * InterceptorLambdaConstruct の Props
 */
export interface InterceptorLambdaConstructProps {
  /**
   * ターゲット名（Request Interceptor Lambda で使用）
   */
  readonly targetName: string;

  /**
   * JWKS URL（JWTトークン検証用）
   */
  readonly jwksUrl: string;

  /**
   * Cognito Client ID（Request/Response Interceptor Lambda で使用）
   */
  readonly clientId: string;
}

/**
 * Interceptor Lambda Functions Construct
 *
 * 以下のリソースを作成:
 * - 共有の依存関係レイヤー
 * - Request Interceptor Lambda
 * - Response Interceptor Lambda
 */
export class InterceptorLambdaConstruct extends Construct {
  public readonly depsLayer: lambda.LayerVersion;
  public readonly requestInterceptor: lambda.Function;
  public readonly responseInterceptor: lambda.Function;

  constructor(
    scope: Construct,
    id: string,
    props: InterceptorLambdaConstructProps
  ) {
    super(scope, id);

    const { targetName, jwksUrl, clientId } = props;

    // Lambda Layer for dependencies
    this.depsLayer = new lambda.LayerVersion(this, "DepsLayer", {
      code: lambda.Code.fromAsset(path.join(__dirname, "../../lambda/layer"), {
        bundling: {
          image: lambda.Runtime.PYTHON_3_13.bundlingImage,
          platform: "linux/arm64",
          command: [
            "bash",
            "-c",
            "pip install -r requirements.txt -t /asset-output/python --platform manylinux2014_aarch64 --only-binary=:all:",
          ],
        },
      }),
      compatibleRuntimes: [lambda.Runtime.PYTHON_3_13],
      compatibleArchitectures: [lambda.Architecture.ARM_64],
    });

    // Request Interceptor Lambda
    // Uses custom claims (role, allowed_tools) for authorization
    this.requestInterceptor = new lambda.Function(this, "RequestInterceptor", {
      runtime: lambda.Runtime.PYTHON_3_13,
      handler: "index.lambda_handler",
      code: lambda.Code.fromAsset(path.join(__dirname, "../../lambda/request")),
      layers: [this.depsLayer],
      architecture: lambda.Architecture.ARM_64,
      timeout: cdk.Duration.seconds(30),
      description: `[REQUEST] AgentCore Gateway Interceptor for ${targetName}`,
      environment: {
        TARGET_NAME: targetName,
        JWKS_URL: jwksUrl,
        CLIENT_ID: clientId,
      },
    });

    // Response Interceptor Lambda
    this.responseInterceptor = new lambda.Function(
      this,
      "ResponseInterceptor",
      {
        runtime: lambda.Runtime.PYTHON_3_13,
        handler: "index.lambda_handler",
        code: lambda.Code.fromAsset(
          path.join(__dirname, "../../lambda/response")
        ),
        layers: [this.depsLayer],
        architecture: lambda.Architecture.ARM_64,
        timeout: cdk.Duration.seconds(30),
        description: `[RESPONSE] AgentCore Gateway Interceptor for ${targetName}`,
        environment: {
          JWKS_URL: jwksUrl,
          CLIENT_ID: clientId,
        },
      }
    );
  }
}
