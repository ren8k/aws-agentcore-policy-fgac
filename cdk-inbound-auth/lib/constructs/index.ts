// Constructs for GatewayPolicyStack (AgentCore Policy based FGAC)
export * from "./gateway-cognito";
export * from "./runtime-cognito";
export * from "./agentcore-runtime";
export * from "./agentcore-identity";
export * from "./agentcore-gateway";
export * from "./agentcore-policy-engine";
export * from "./agentcore-policy";

// NOTE: interceptor-lambda.ts は削除されました
// AgentCore Policy で Fine-grained access control を実現しています
