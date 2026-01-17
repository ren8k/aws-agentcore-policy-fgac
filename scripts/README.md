# Scripts

AgentCore Gateway の動作確認・テスト用スクリプト集です。

## 前提条件

- Python >= 3.12
- uv (Python パッケージマネージャー)
- CDK プロジェクトがデプロイ済みであること
- プロジェクトルートに `.env` ファイルが設定済みであること

## セットアップ

```bash
cd scripts
uv sync
```

## スクリプト一覧

### test_gateway.py

AgentCore Gateway への疎通確認スクリプトです。

ブラウザで Cognito ログイン画面を開き、認証後に各 MCP ツールを順次呼び出して動作を確認します。

```bash
uv run python test_gateway.py
```

**確認内容:**

- `tools/list` で利用可能なツール一覧を取得
- `x_amz_bedrock_agentcore_search` (AWS マネージドツール) の実行
- 各 MCP ツール (`retrieve_doc`, `get_query_log`, `sync_data_source`, `delete_data_source`) の実行

**ログアウト:**

```bash
uv run python test_gateway.py logout
```

### test_gateway_latency.py

AgentCore Gateway のレイテンシー計測スクリプトです。

`tools/list` の呼び出しを 50 回実行し、平均レイテンシーと標準偏差を計測します。各アクセス制御方式のパフォーマンス比較に使用できます。

```bash
uv run python test_gateway_latency.py
```

**出力例:**

```
=== list_tools レイテンシー計測結果 ===
試行回数:     50 回
平均実行時間: 704.02 ms
標準偏差:     26.21 ms
最小値:       650.12 ms
最大値:       780.45 ms
```

### fgac_demo.py

Streamlit アプリケーションから Strands Agent 経由で AgentCore Gateway を利用できることを確認するデモアプリです。

Cognito 認証でログインしたユーザーのロールに応じて、利用可能なツールが動的に変わる様子を対話形式で確認できます。

```bash
bash run_app.sh
```

ポート 8080 で Streamlit アプリが起動し、ブラウザで `http://localhost:8080` にアクセスできます。

**機能:**

- Cognito OAuth 認証によるログイン/ログアウト
- サイドバーにユーザー情報と利用可能なツール一覧を表示
- Strands Agent を使ったチャット形式での MCP ツール実行
- ストリーミングレスポンス対応
