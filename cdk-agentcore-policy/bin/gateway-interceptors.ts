#!/usr/bin/env node
import * as cdk from "aws-cdk-lib";
import { GatewayPolicyStack } from "../lib/gateway-interceptors-stack";

const app = new cdk.App();
new GatewayPolicyStack(app, "AgentCorePolicyStack", {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
