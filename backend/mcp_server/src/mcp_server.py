"""
RAG Operations MCP Server

AgentCore Policy による Fine-grained access control のデモ:
- retrieve_doc: 一般ユーザー（user）もアクセス可能
- delete_data_source, sync_data_source, get_query_log: 管理者（admin）のみ
"""

from mcp.server.fastmcp import FastMCP
from pydantic import Field

mcp = FastMCP(name="rag-operations-mcp-server", host="0.0.0.0", stateless_http=True)

SAMPLE_DOCS = [
    {"id": "doc-001", "content": "経費精算の申請方法: 1. 社内ポータルにログイン 2. 経費精算メニューを選択 3. 領収書を添付して申請"},
    {"id": "doc-002", "content": "有給休暇の申請方法: 1. 勤怠システムにログイン 2. 申請→有給休暇を選択 3. 希望日を入力し上長承認へ提出"},
    {"id": "doc-003", "content": "システム障害時の連絡網: 1次対応→情シス当番(内線9999) 2次対応→部長承認後にベンダー連絡。深夜休日は緊急連絡簿を参照。"},
]


@mcp.tool()
def retrieve_doc(
    query: str = Field(description="検索クエリ"),
    top_k: int = Field(default=5, description="取得件数"),
) -> dict:
    """一般ユーザー向けのドキュメントを検索します。"""
    _ = (query, top_k)  # ダミー実装のため未使用
    return {"documents": SAMPLE_DOCS, "total": 1}


@mcp.tool()
def delete_data_source(
    data_source_id: str = Field(description="削除するデータソースID"),
    force: bool = Field(default=False, description="ベクトルデータを削除するか"),
) -> dict:
    """データソースを削除します。"""
    return {"status": "deleted", "data_source_id": data_source_id, "force": force}


@mcp.tool()
def sync_data_source(
    data_source_id: str = Field(description="データソースID"),
    full_sync: bool = Field(default=False, description="完全同期するか"),
) -> dict:
    """データソースを同期します。"""
    return {"status": "completed", "data_source_id": data_source_id, "full_sync": full_sync}


@mcp.tool()
def get_query_log(
    start_date: str = Field(description="開始日時（ISO 8601形式）"),
    end_date: str = Field(description="終了日時（ISO 8601形式）"),
) -> dict:
    """クエリログを取得します。"""
    return {
        "logs": [{"query": "success", "timestamp": "2025-12-20T10:00:00Z"}],
        "period": {"start": start_date, "end": end_date},
    }


if __name__ == "__main__":
    mcp.run(transport="streamable-http")
