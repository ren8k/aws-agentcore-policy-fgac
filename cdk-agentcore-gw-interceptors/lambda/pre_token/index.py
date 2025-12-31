import json
import os

RESOURCE_SERVER_ID = os.environ.get("RESOURCE_SERVER_ID", "")
TARGET_NAME = os.environ.get("TARGET_NAME", "")

# ============================================
# 擬似DB: ユーザー毎の許可スコープ
# 本番では DynamoDB 等から取得する
# ============================================
USER_PERMISSIONS_DB = {
    "admin@example.com": {
        "role": "admin",
        "scopes": ["*"],  # 全ツールアクセス可
    },
    "user@example.com": {
        "role": "user",
        "scopes": ["retrieve_doc"],
    },
}


def get_user_scopes(email: str) -> list[str]:
    """擬似DBからユーザーの許可スコープを取得"""
    user_data = USER_PERMISSIONS_DB.get(email, {})
    raw_scopes = user_data.get("scopes", [])

    # スコープを完全な形式に変換
    full_scopes = []
    for scope in raw_scopes:
        if scope == "*":
            # 全アクセス = ターゲット名のみ
            full_scopes.append(f"{RESOURCE_SERVER_ID}/{TARGET_NAME}")
        else:
            # ツール単位 = ターゲット名:ツール名
            full_scopes.append(f"{RESOURCE_SERVER_ID}/{TARGET_NAME}:{scope}")

    return full_scopes


def lambda_handler(event, context):
    print(f"[PRE_TOKEN] Event: {json.dumps(event)}")
    print(f"[PRE_TOKEN] RESOURCE_SERVER_ID: {RESOURCE_SERVER_ID}")
    print(f"[PRE_TOKEN] TARGET_NAME: {TARGET_NAME}")

    trigger_source = event.get("triggerSource", "")
    print(f"[PRE_TOKEN] triggerSource: {trigger_source}")

    email = event["request"]["userAttributes"].get("email", "")
    print(f"[PRE_TOKEN] User email: {email}")

    # 擬似DBからスコープを取得
    allowed_scopes = get_user_scopes(email)
    print(f"[PRE_TOKEN] Allowed scopes: {allowed_scopes}")

    event["response"]["claimsAndScopeOverrideDetails"] = {
        "accessTokenGeneration": {"scopesToAdd": allowed_scopes}
    }

    print(f"[PRE_TOKEN] Response: {json.dumps(event['response'])}")

    return event
