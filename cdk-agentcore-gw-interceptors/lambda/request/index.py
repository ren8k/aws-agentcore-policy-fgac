import json
import os

import jwt

TARGET_NAME = os.environ["TARGET_NAME"]
JWKS_URL = os.environ["JWKS_URL"]
CLIENT_ID = os.environ["CLIENT_ID"]

# JWKS クライアントを初期化（キーのキャッシュ機能付き）
jwks_client = jwt.PyJWKClient(JWKS_URL)

# ============================================
# ロールベースのアクセス制御設定
# agentcore-policy.ts の Cedar Policy と同等のロジック
# ============================================
ROLE_PERMISSIONS = {
    "admin": ["*"],  # 全ツール許可
    "user": ["retrieve_doc"],  # retrieve_doc のみ許可
    # guest やその他のロールは許可なし
}


def decode_jwt_payload(token: str) -> dict:
    """JWT トークンを検証してペイロードを取得する。

    Args:
        token: Bearer トークンから抽出した JWT 文字列

    Returns:
        検証済みの JWT クレーム

    Raises:
        jwt.InvalidTokenError: トークンが無効な場合
    """
    # JWKS から署名キーを取得
    signing_key = jwks_client.get_signing_key_from_jwt(token)

    # トークンを検証してデコード
    claims = jwt.decode(
        token,
        signing_key.key,
        algorithms=["RS256"],
        options={
            "require": ["exp", "client_id", "token_use"],
        },
    )

    # カスタムクレームの検証
    if claims.get("client_id") != CLIENT_ID:
        raise jwt.InvalidTokenError("Invalid client_id")
    if claims.get("token_use") != "access":
        raise jwt.InvalidTokenError("Invalid token_use")

    return claims


def check_authorization(role: str, tool_name: str) -> bool:
    """ロールに基づいてツールの実行可否を判断"""
    allowed_tools = ROLE_PERMISSIONS.get(role, [])
    if not allowed_tools:
        return False
    # "*" は全ツールアクセス可能
    if "*" in allowed_tools:
        return True
    # 特定のツールが許可されているかチェック
    return tool_name in allowed_tools


def extract_tool_name(body):
    params = body.get("params", {})
    name = params.get("name", "")
    # Tool names are of the form: <target>___<toolName>
    return name.split("___")[-1] if "___" in name else name


def build_error_response(message, body):
    """Return an MCP-style error response"""
    return {
        "interceptorOutputVersion": "1.0",
        "mcp": {
            "transformedGatewayResponse": {
                "statusCode": 403,
                "headers": {"Content-Type": "application/json"},
                "body": {
                    "jsonrpc": "2.0",
                    "id": body.get("id"),
                    "error": {"code": -32000, "message": message},
                },
            }
        },
    }


def build_pass_through(body):
    """Build pass-through response for requests. Auth header not needed - Gateway handles outbound auth."""
    return {
        "interceptorOutputVersion": "1.0",
        "mcp": {
            "transformedGatewayRequest": {
                "headers": {"Content-Type": "application/json"},
                "body": body,
            }
        },
    }


def lambda_handler(event, context):
    print(f"[REQUEST_INTERCEPTOR] Event: {json.dumps(event)}")

    mcp = event.get("mcp", {})
    req = mcp.get("gatewayRequest", {})
    headers = req.get("headers", {})
    body = req.get("body", {})
    auth = headers.get("Authorization", "")

    print(f"[REQUEST_INTERCEPTOR] Method: {body.get('method', '')}")
    print(f"[REQUEST_INTERCEPTOR] Has auth: {bool(auth)}")

    if not auth.startswith("Bearer "):
        print("[REQUEST_INTERCEPTOR] No Bearer token")
        return build_error_response("No token", body)

    try:
        token = auth.replace("Bearer ", "")
        claims = decode_jwt_payload(token)

        # カスタムクレームから role を取得
        role = claims.get("role", "guest")
        method = body.get("method", "")
        tool_name = extract_tool_name(body)

        print(f"[REQUEST_INTERCEPTOR] Role: {role}")
        print(f"[REQUEST_INTERCEPTOR] Tool name: {tool_name}")
        print(f"[REQUEST_INTERCEPTOR] TARGET_NAME: {TARGET_NAME}")

        # Allow MCP protocol methods and system tools without tool-level authorization
        if method != "tool/list":
            print(f"[REQUEST_INTERCEPTOR] Pass through (protocol method: {method} or system tool: {tool_name})")
            return build_pass_through(body)

        authorized = check_authorization(role, tool_name)
        print(f"[REQUEST_INTERCEPTOR] Authorization check: {authorized}")

        if not tool_name or not authorized:
            print(f"[REQUEST_INTERCEPTOR] Denied: {tool_name} (role={role})")
            return build_error_response(f"Insufficient permission: {tool_name}", body)
    except Exception as e:
        print(f"[REQUEST_INTERCEPTOR] Error: {e}")
        return build_error_response(f"Invalid token: {e}", body)

    print(f"[REQUEST_INTERCEPTOR] Allowed: {tool_name} (role={role})")
    return build_pass_through(body)
