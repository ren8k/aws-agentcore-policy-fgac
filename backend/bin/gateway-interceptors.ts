#!/usr/bin/env node
import * as cdk from "aws-cdk-lib";
import { GatewayInterceptorStack } from "../lib/gateway-interceptors-stack";

const app = new cdk.App();
new GatewayInterceptorStack(app, "GatewayInterceptorStack", {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
