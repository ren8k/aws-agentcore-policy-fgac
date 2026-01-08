import json
import os

import jwt

JWKS_URL = os.environ["JWKS_URL"]
CLIENT_ID = os.environ["CLIENT_ID"]

# JWKS クライアントを初期化（キーのキャッシュ機能付き）
jwks_client = jwt.PyJWKClient(JWKS_URL)

# ============================================
# ロールベースのアクセス制御設定
# request/index.py と同じ設定
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


def filter_tools(tools: list, role: str) -> list:
    """ロールに基づいてツールをフィルタリング"""
    allowed_tools = ROLE_PERMISSIONS.get(role, [])
    if not allowed_tools:
        return []

    # "*" は全ツール許可
    if "*" in allowed_tools:
        return tools

    filtered = []
    for tool in tools:
        name = tool.get("name", "")
        # Tool names are of the form: <target>___<toolName>
        tool_name = name.split("___")[-1] if "___" in name else name
        if tool_name in allowed_tools:
            filtered.append(tool)
    return filtered


def lambda_handler(event, context):
    print(f"[RESPONSE_INTERCEPTOR] Event: {json.dumps(event)}")

    mcp = event.get("mcp", {})
    resp = mcp.get("gatewayResponse", {})
    headers = resp.get("headers", {})
    body = resp.get("body") or {}  # the body of notifications/initialized is null
    auth = headers.get("Authorization", "")

    print(f"[RESPONSE_INTERCEPTOR] Has auth: {bool(auth)}")
    print(f"[RESPONSE_INTERCEPTOR] Body keys: {list(body.keys()) if body else 'empty'}")

    result = body.get("result", {})
    tools = result.get("tools", []) or result.get("structuredContent", {}).get("tools", [])

    if not tools:
        print("[RESPONSE_INTERCEPTOR] No tools in response, skipping filter")
        filtered_body = body
    else:
        try:
            token = auth.replace("Bearer ", "") if auth.startswith("Bearer ") else ""
            claims = decode_jwt_payload(token)
            role = claims.get("role", "guest")

            print(f"[RESPONSE_INTERCEPTOR] Role: {role}")
            print(f"[RESPONSE_INTERCEPTOR] Tools before filter: {[t.get('name') for t in tools]}")

            filtered = filter_tools(tools, role)
            print(f"[RESPONSE_INTERCEPTOR] Tools after filter: {[t.get('name') for t in filtered]}")

            filtered_body = body.copy()
            if "structuredContent" in filtered_body["result"]:
                # For semantic search results
                filtered_body["result"]["structuredContent"]["tools"] = filtered
                filtered_body["result"]["content"] = [
                    {"type": "text", "text": json.dumps({"tools": filtered})}
                ]
            else:
                # For list_tools results
                filtered_body["result"]["tools"] = filtered
        except Exception as e:
            print(f"[RESPONSE_INTERCEPTOR] Error: {e}")
            filtered_body = body

    output = {
        "interceptorOutputVersion": "1.0",
        "mcp": {
            "transformedGatewayResponse": {
                "statusCode": 200,
                "headers": {"Content-Type": "application/json"},
                "body": filtered_body,
            }
        },
    }
    print(f"[RESPONSE_INTERCEPTOR] Output: {json.dumps(output)}")
    return output
