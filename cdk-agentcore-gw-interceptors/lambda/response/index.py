import json
import os
import time
import urllib.request

from jose import jwk, jwt
from jose.utils import base64url_decode

JWKS_URL = os.environ["JWKS_URL"]
CLIENT_ID = os.environ["CLIENT_ID"]

with urllib.request.urlopen(JWKS_URL) as f:
    keys = json.loads(f.read().decode("utf-8"))["keys"]


def decode_jwt_payload(token):
    headers = jwt.get_unverified_headers(token)
    key = next((k for k in keys if k["kid"] == headers["kid"]), None)
    if not key:
        raise Exception("Public key not found")

    public_key = jwk.construct(key)
    message, encoded_signature = token.rsplit(".", 1)
    if not public_key.verify(message.encode("utf8"), base64url_decode(encoded_signature.encode("utf-8"))):
        raise Exception("Signature verification failed")

    claims = jwt.get_unverified_claims(token)
    if time.time() > claims["exp"]:
        raise Exception("Token expired")
    if claims["client_id"] != CLIENT_ID or claims.get("token_use") != "access":
        raise Exception("Invalid token")
    return claims


def filter_tools(tools, scopes):
    """Filter tools based on user scopes."""
    if not scopes:
        return []
    filtered = []
    for tool in tools:
        name = tool.get("name", "")
        # Skip system-generated MCP tools without target separator
        if "___" not in name:
            continue
        target, action = name.split("___", 1)
        for scope in scopes:
            # Remove resource server prefix to get actual scope
            actual = scope.split("/")[-1] if "/" in scope else scope
            if actual == target or actual == f"{target}:{action}":
                filtered.append(tool)
                break
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
            scopes = claims.get("scope", "").split()

            print(f"[RESPONSE_INTERCEPTOR] Scopes: {scopes}")
            print(f"[RESPONSE_INTERCEPTOR] Tools before filter: {[t.get('name') for t in tools]}")

            filtered = filter_tools(tools, scopes)
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
