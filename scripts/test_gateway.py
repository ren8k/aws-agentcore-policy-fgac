#!/usr/bin/env python3
"""
3LO (Three-Legged OAuth) Gateway Test
ユーザー認証フローを使用してGatewayにアクセスする
"""

import json
import os
import urllib.parse
import webbrowser
from http.server import BaseHTTPRequestHandler, HTTPServer

import requests
from dotenv import load_dotenv

# Configuration (load from .env)
load_dotenv(override=True)

CLIENT_ID = os.getenv("CLIENT_ID")
GATEWAY_URL = os.getenv("GATEWAY_URL")
COGNITO_DOMAIN = os.getenv("COGNITO_DOMAIN")
REGION = os.getenv("REGION", "us-east-1")
MCP_TARGET_NAME = os.getenv("MCP_TARGET_NAME")

# OAuth settings
REDIRECT_URI = os.getenv("REDIRECT_URI", "http://localhost:8080/callback")
AUTH_URL = f"https://{COGNITO_DOMAIN}.auth.{REGION}.amazoncognito.com/oauth2/authorize"
TOKEN_URL = f"https://{COGNITO_DOMAIN}.auth.{REGION}.amazoncognito.com/oauth2/token"
LOGOUT_URL = f"https://{COGNITO_DOMAIN}.auth.{REGION}.amazoncognito.com/logout"

# Global to store auth code
auth_code = None


class CallbackHandler(BaseHTTPRequestHandler):
    """Handle OAuth callback"""

    def do_GET(self):
        global auth_code
        query = urllib.parse.urlparse(self.path).query
        params = urllib.parse.parse_qs(query)

        if "code" in params:
            auth_code = params["code"][0]
            self.send_response(200)
            self.send_header("Content-type", "text/html")
            self.end_headers()
            self.wfile.write(
                b"<html><body><h1>Login successful!</h1><p>You can close this window.</p></body></html>"
            )
        else:
            self.send_response(400)
            self.end_headers()
            self.wfile.write(b"Error: No code received")

    def log_message(self, format, *args):
        pass  # Suppress logs


def get_auth_url() -> str:
    """Build authorization URL (no custom scopes - server decides)"""
    params = {
        "response_type": "code",
        "client_id": CLIENT_ID,
        "redirect_uri": REDIRECT_URI,
        "scope": "openid email",  # 基本スコープのみ、カスタムスコープはPre Token Lambdaが付与
    }
    return f"{AUTH_URL}?{urllib.parse.urlencode(params)}"


def exchange_code_for_token(code: str) -> str:
    """Exchange authorization code for access token"""
    response = requests.post(
        TOKEN_URL,
        headers={"Content-Type": "application/x-www-form-urlencoded"},
        data={
            "grant_type": "authorization_code",
            "client_id": CLIENT_ID,
            "code": code,
            "redirect_uri": REDIRECT_URI,
        },
    )
    response.raise_for_status()
    token = response.json()["access_token"]

    # Decode and show token claims for debugging
    import base64

    payload = token.split(".")[1]
    payload += "=" * (4 - len(payload) % 4)  # padding
    claims = json.loads(base64.b64decode(payload))
    print("\n=== Token Claims ===")
    print(f"sub: {claims.get('sub')}")
    print(f"scope: {claims.get('scope')}")
    print(f"cognito:groups: {claims.get('cognito:groups')}")
    print("====================\n")
    print("\n=== Token Claims (all) ===")
    print(json.dumps(claims, indent=2, ensure_ascii=False))
    print("====================\n")

    return token


def login_with_browser() -> str:
    """Open browser for login and get access token"""
    global auth_code
    auth_code = None

    # Start local server
    server = HTTPServer(("localhost", 8080), CallbackHandler)

    # Open browser
    auth_url = get_auth_url()
    print("Opening browser for login...")
    print(f"URL: {auth_url}")
    webbrowser.open(auth_url)

    # Wait for callback (handle multiple requests until we get the code)
    print("Waiting for login callback...")
    while auth_code is None:
        server.handle_request()
    server.server_close()

    # Exchange code for token
    print("Exchanging code for token...")
    return exchange_code_for_token(auth_code)


def call_gateway(token: str, method: str, params: dict = None) -> dict:
    """Call Gateway endpoint with MCP protocol"""
    response = requests.post(
        GATEWAY_URL,
        headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
        },
        json={
            "jsonrpc": "2.0",
            "id": 1,
            "method": method,
            "params": params or {},
        },
    )
    return response.json()


def test_gateway(test_name: str):
    """Test Gateway access with 3LO authentication"""
    print(f"\n{'=' * 60}")
    print(f"Testing: {test_name}")
    print("(Scopes are determined by Pre Token Lambda based on user)")
    print(f"{'=' * 60}")

    try:
        token = login_with_browser()
        print("✓ Token obtained")

        # Test 1: List tools
        print("\n1. Listing available tools...")
        result = call_gateway(token, "tools/list")
        tools = result.get("result", {}).get("tools", [])
        print(f"Available tools: {[t['name'] for t in tools]}")

        # Test 2: x_amz_bedrock_agentcore_search (AWSマネージドツール - ツール検索)
        print("\n2. Calling x_amz_bedrock_agentcore_search (AWS managed tool)...")
        result = call_gateway(
            token,
            "tools/call",
            {"name": "x_amz_bedrock_agentcore_search", "arguments": {"query": "データソース"}},
        )
        print(f"Result: {json.dumps(result, indent=2, ensure_ascii=False)}")

        # Test 3: retrieve_doc (ドキュメント検索 - 一般ユーザー向け)
        print("\n3. Calling retrieve_doc...")
        tool_name = f"{MCP_TARGET_NAME}___retrieve_doc"
        result = call_gateway(
            token,
            "tools/call",
            {"name": tool_name, "arguments": {"query": "テスト検索", "top_k": 3}},
        )
        print(f"Result: {json.dumps(result, indent=2, ensure_ascii=False)}")

        # Test 4: get_query_log (クエリログ取得)
        print("\n4. Calling get_query_log...")
        tool_name = f"{MCP_TARGET_NAME}___get_query_log"
        result = call_gateway(
            token,
            "tools/call",
            {
                "name": tool_name,
                "arguments": {
                    "start_date": "2024-01-01T00:00:00Z",
                    "end_date": "2024-12-31T23:59:59Z",
                },
            },
        )
        print(f"Result: {json.dumps(result, indent=2, ensure_ascii=False)}")

        # Test 5: sync_data_source (データソース同期)
        print("\n5. Calling sync_data_source...")
        tool_name = f"{MCP_TARGET_NAME}___sync_data_source"
        result = call_gateway(
            token,
            "tools/call",
            {
                "name": tool_name,
                "arguments": {"data_source_id": "test-data-source-001", "full_sync": False},
            },
        )
        print(f"Result: {json.dumps(result, indent=2, ensure_ascii=False)}")

        # Test 6: delete_data_source (データソース削除 - 管理者のみ)
        print("\n6. Calling delete_data_source...")
        tool_name = f"{MCP_TARGET_NAME}___delete_data_source"
        result = call_gateway(
            token,
            "tools/call",
            {
                "name": tool_name,
                "arguments": {"data_source_id": "test-data-source-001", "force": False},
            },
        )
        print(f"Result: {json.dumps(result, indent=2, ensure_ascii=False)}")

    except Exception as e:
        print(f"✗ Error: {e}")


def logout():
    """Open browser to logout from Cognito"""
    logout_url = f"{LOGOUT_URL}?client_id={CLIENT_ID}&logout_uri={REDIRECT_URI}"
    print(f"Opening logout URL: {logout_url}")
    webbrowser.open(logout_url)


if __name__ == "__main__":
    import sys

    if len(sys.argv) > 1 and sys.argv[1] == "logout":
        logout()
        sys.exit(0)

    # Test: Login as user1 (admin) or user2 (user) to see different behavior
    # Scopes are determined server-side by Pre Token Lambda based on user email
    # admin (user1@example.com): all tools work (retrieve_doc, get_query_log, sync_data_source, delete_data_source)
    # user (user2@example.com): only retrieve_doc works
    test_gateway("RAG Operations Test (admin, user)")
