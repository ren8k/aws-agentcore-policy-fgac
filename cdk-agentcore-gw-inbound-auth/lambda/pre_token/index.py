import json
import os

TARGET_NAME = os.environ.get("TARGET_NAME", "")

# ============================================
# 擬似DB: ユーザー毎の権限
# 本番では DynamoDB 等から取得する
# ============================================
USER_PERMISSIONS_DB = {
    "admin@example.com": {
        "role": "admin",
        "allowed_tools": ["*"],  # 全ツールアクセス可
    },
    "user@example.com": {
        "role": "user",
        "allowed_tools": ["retrieve_doc"],
    },
}


def get_user_claims(email: str) -> dict:
    """擬似DBからユーザーの権限をカスタムクレームとして取得"""
    user_data = USER_PERMISSIONS_DB.get(email, {})
    role = user_data.get("role", "guest")
    allowed_tools = user_data.get("allowed_tools", [])

    return {
        "role": role,
        "allowed_tools": json.dumps(allowed_tools),  # 配列はJSON文字列として格納
    }


def lambda_handler(event, context):
    print(f"[PRE_TOKEN] Event: {json.dumps(event)}")
    print(f"[PRE_TOKEN] TARGET_NAME: {TARGET_NAME}")

    trigger_source = event.get("triggerSource", "")
    print(f"[PRE_TOKEN] triggerSource: {trigger_source}")

    email = event["request"]["userAttributes"].get("email", "")
    print(f"[PRE_TOKEN] User email: {email}")

    # 擬似DBからカスタムクレームを取得
    custom_claims = get_user_claims(email)
    print(f"[PRE_TOKEN] Custom claims: {custom_claims}")

    # claimsToAddOrOverride でカスタムクレームを追加
    event["response"]["claimsAndScopeOverrideDetails"] = {
        "accessTokenGeneration": {"claimsToAddOrOverride": custom_claims}
    }

    print(f"[PRE_TOKEN] Response: {json.dumps(event['response'])}")

    return event
