#!/usr/bin/env node
import * as cdk from "aws-cdk-lib";
import { GatewayInboundAuthCustomClaimStack } from "../lib/gateway-custom-claim-stack";

const app = new cdk.App();
new GatewayInboundAuthCustomClaimStack(app, "AgentCoreCustomClaimsStack9", {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
