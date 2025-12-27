#!/usr/bin/env python3
"""
Streamlit Demo: FGAC (Fine-Grained Access Control) with AgentCore Gateway
Interceptor Lambda によるユーザー毎の Tool 制御をデモ
"""

import asyncio
import base64
import json
import logging
import os
import urllib.parse

import requests
import streamlit as st
from dotenv import load_dotenv
from mcp.client.streamable_http import streamablehttp_client
from strands import Agent
from strands.models import BedrockModel
from strands.tools.mcp import MCPClient

logger = logging.getLogger(__name__)

# =============================================================================
# Configuration (load from .env)
# =============================================================================
load_dotenv(override=True)

CLIENT_ID = os.getenv("CLIENT_ID")
GATEWAY_URL = os.getenv("GATEWAY_URL")
COGNITO_DOMAIN = os.getenv("COGNITO_DOMAIN")
REGION = os.getenv("REGION", "us-east-1")
MODEL_ID = os.getenv("MODEL_ID", "openai.gpt-oss-20b-1:0")
SYSTEM_PROMPT = os.getenv("SYSTEM_PROMPT", "")

# Must match Cognito App Client URLs (configured in CDK)
REDIRECT_URI = os.getenv("REDIRECT_URI", "http://localhost:8080/callback")
LOGOUT_REDIRECT_URI = os.getenv("LOGOUT_REDIRECT_URI", "http://localhost:8080/logout")
AUTH_URL = f"https://{COGNITO_DOMAIN}.auth.{REGION}.amazoncognito.com/oauth2/authorize"
TOKEN_URL = f"https://{COGNITO_DOMAIN}.auth.{REGION}.amazoncognito.com/oauth2/token"
LOGOUT_URL = f"https://{COGNITO_DOMAIN}.auth.{REGION}.amazoncognito.com/logout"


# =============================================================================
# OAuth Functions
# =============================================================================
def get_auth_url() -> str:
    """Build Cognito authorization URL"""
    params = {
        "response_type": "code",
        "client_id": CLIENT_ID,
        "redirect_uri": REDIRECT_URI,
        "scope": "openid email",
    }
    return f"{AUTH_URL}?{urllib.parse.urlencode(params)}"


def get_logout_url() -> str:
    """Build Cognito logout URL"""
    params = {
        "client_id": CLIENT_ID,
        "logout_uri": LOGOUT_REDIRECT_URI,
    }
    return f"{LOGOUT_URL}?{urllib.parse.urlencode(params)}"


def exchange_code_for_token(code: str) -> dict:
    """Exchange authorization code for tokens"""
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
    return response.json()


def decode_token(token: str) -> dict:
    """Decode JWT token payload (without verification)"""
    payload = token.split(".")[1]
    payload += "=" * (4 - len(payload) % 4)
    return json.loads(base64.b64decode(payload))


# =============================================================================
# Utility Functions
# =============================================================================
def redirect_to(url: str):
    """Redirect browser to URL and stop execution"""
    st.markdown(
        f'<meta http-equiv="refresh" content="0;url={url}">',
        unsafe_allow_html=True,
    )
    st.stop()


def create_mcp_client(access_token: str) -> MCPClient:
    """Create MCP client with Bearer token authentication"""
    headers = {"Authorization": f"Bearer {access_token}"}
    return MCPClient(lambda: streamablehttp_client(GATEWAY_URL, headers=headers, timeout=300))


def extract_response_text(result) -> str:
    """Extract text content from Agent result"""
    if hasattr(result, "message") and result.message:
        content = result.message.get("content", [])
        response_text = ""
        for block in content:
            if isinstance(block, dict) and block.get("text"):
                response_text += block["text"]
        if response_text:
            return response_text
    return str(result)


def extract_tool_info(chunk) -> tuple:
    """Extract tool information from streaming chunk"""
    event = chunk.get("event", {})
    if "contentBlockStart" in event:
        tool_use = event["contentBlockStart"].get("start", {}).get("toolUse", {})
        return tool_use.get("toolUseId"), tool_use.get("name")
    return None, None


def extract_text(chunk) -> str:
    """Extract text from streaming chunk"""
    if text := chunk.get("data"):
        return text
    elif delta := chunk.get("delta", {}).get("text"):
        return delta
    return ""


async def stream_response(agent: Agent, question: str, container) -> str:
    """Stream agent response with tool execution display"""
    text_holder = container.empty()
    buffer = ""

    async for chunk in agent.stream_async(question):
        if isinstance(chunk, dict):
            # Detect and display tool execution
            tool_id, tool_name = extract_tool_info(chunk)
            if tool_id and tool_name:
                if buffer:
                    text_holder.markdown(buffer)
                    buffer = ""
                # Format tool name for display
                display_name = tool_name.split("___")[-1] if "___" in tool_name else tool_name
                tool_text = f"🔧 **{display_name}** ツールを実行中..."
                container.info(tool_text)
                text_holder = container.empty()

            # Extract and display text
            if text := extract_text(chunk):
                buffer += text
                text_holder.markdown(buffer + "▌")

    # Final display
    if buffer:
        text_holder.markdown(buffer)

    return buffer


# =============================================================================
# Session State Management
# =============================================================================
def init_session_state():
    """Initialize session state if not exists"""
    if "access_token" not in st.session_state:
        reset_session_state()


def reset_session_state():
    """Reset all session state to initial values"""
    st.session_state.access_token = None
    st.session_state.user_info = None
    st.session_state.tools = []
    st.session_state.mcp_client = None
    st.session_state.agent = None


def close_mcp_client():
    """Close MCP client if exists"""
    if st.session_state.mcp_client:
        try:
            st.session_state.mcp_client.__exit__(None, None, None)
        except Exception:
            logger.debug("MCP client close failed", exc_info=True)


# =============================================================================
# OAuth Callback Handler
# =============================================================================
def handle_oauth_callback():
    """Handle OAuth callback and setup session"""
    if "code" not in st.query_params:
        return
    if st.session_state.access_token is not None:
        return

    try:
        code: str = st.query_params["code"]
        tokens = exchange_code_for_token(code)

        # Store access token
        st.session_state.access_token = tokens["access_token"]

        # Extract user info from tokens
        id_claims = decode_token(tokens["id_token"])
        access_claims = decode_token(tokens["access_token"])
        st.session_state.user_info = {
            "email": id_claims.get("email"),
            "scope": access_claims.get("scope"),
        }

        # Clear query params and rerun
        st.query_params.clear()
        st.rerun()

    except Exception as e:
        st.error(f"Login failed: {e}")


def initialize_mcp():
    """Ensure MCP client and tools are initialized"""
    if st.session_state.mcp_client is None:
        st.session_state.mcp_client = create_mcp_client(st.session_state.access_token)
        st.session_state.mcp_client.__enter__()
        st.session_state.tools = st.session_state.mcp_client.list_tools_sync()


def initialize_agent():
    """Ensure agent is initialized (requires tools to be initialized first)"""
    if st.session_state.agent is None:
        model = BedrockModel(model_id=MODEL_ID)
        st.session_state.agent = Agent(
            model=model,
            system_prompt=SYSTEM_PROMPT,
            tools=st.session_state.tools,
            callback_handler=None,
        )


# =============================================================================
# UI Components
# =============================================================================
def render_sidebar():
    """Render sidebar with user info, tools, and logout button"""
    with st.sidebar:
        render_user_info()
        render_tools_list()
        render_logout_button()


def render_user_info():
    """Render user info section in sidebar"""
    st.markdown("### 👤 User Info")
    user_info = st.session_state.user_info or {}
    st.markdown(f"**Email:** {user_info.get('email', 'N/A')}")

    # scope = user_info.get("scope", "")
    # if scope:
    #     st.markdown("**Scopes:**")
    #     for s in scope.split():
    #         st.markdown(f"- `{s}`")


def render_tools_list():
    """Render available tools list in sidebar"""
    st.markdown("### 🔧 Available Tools")
    if st.session_state.tools:
        for tool in st.session_state.tools:
            name = tool.tool_name
            display_name = name.split("___")[-1] if "___" in name else name
            st.markdown(f"- `{display_name}`")
    else:
        st.warning("No tools available")


def render_logout_button():
    """Render logout button in sidebar"""
    st.divider()
    if st.button("🚪 Logout"):
        close_mcp_client()
        reset_session_state()
        redirect_to(get_logout_url())


def render_chat_history(messages):
    """Render chat message history"""
    st.markdown("### 💬 Chat with Agent")
    for message in messages:
        last_block = message["content"][-1]
        if "toolUse" in last_block:
            tool_name = last_block["toolUse"]["name"].split("___")[-1]
            st.info(f"🔧 **{tool_name}** ツールを実行中...")
        elif "text" in last_block:
            with st.chat_message(message["role"]):
                st.markdown(last_block["text"])


def handle_chat_input():
    """Handle chat input and agent response with streaming"""
    if prompt := st.chat_input("メッセージを入力..."):
        with st.chat_message("user"):
            st.markdown(prompt)

        # Get and display agent response with streaming
        with st.chat_message("assistant"):
            try:
                container = st.container()
                # Run async streaming
                loop = asyncio.new_event_loop()
                loop.run_until_complete(stream_response(st.session_state.agent, prompt, container))
                loop.close()
            except Exception as e:
                error_msg = f"Error: {e}"
                st.error(error_msg)


# =============================================================================
# Main App
# =============================================================================
def app():
    """Main application UI"""
    st.set_page_config(page_title="FGAC Demo", page_icon="🔐", layout="wide")
    st.title("🔐 FGAC Demo: Tool Access Control")

    # Initialize MCP client, tools, and agent (must be before render_sidebar)
    initialize_mcp()
    initialize_agent()

    # Render components
    render_sidebar()
    render_chat_history(st.session_state.agent.messages)
    handle_chat_input()


def main():
    """Entry point - handles routing based on auth state"""
    init_session_state()
    handle_oauth_callback()

    if st.session_state.access_token is None:
        redirect_to(get_auth_url())
    else:
        app()


if __name__ == "__main__":
    main()
