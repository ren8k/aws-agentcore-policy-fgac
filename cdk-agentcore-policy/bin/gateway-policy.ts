#!/usr/bin/env node
import * as cdk from "aws-cdk-lib";
import { GatewayPolicyStack } from "../lib/gateway-policy-stack";

const app = new cdk.App();
new GatewayPolicyStack(app, "AgentCorePolicyStack0", {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
