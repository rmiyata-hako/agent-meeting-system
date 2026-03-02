"""
レポーターAI + Google Docs連携 + 定期実行スケジューラ
====================================================
- 時報: 3時間ごとにリサーチ進捗と議論サマリーをGoogleドキュメントに記録
- 日報: 毎日9:00 JSTに当日の全議論と成果を議事録としてGoogleドキュメントに出力
- Google Docs APIを使用してドキュメントを作成・更新
"""
import os
import json
import asyncio
import time
import threading
from typing import Optional
from datetime import datetime, timezone, timedelta

JST = timezone(timedelta(hours=9))

# ── Google Docs / Drive 設定 ──────────────────────────────
_GOOGLE_SERVICE_ACCOUNT_JSON = os.environ.get("GOOGLE_SERVICE_ACCOUNT_JSON", "")
_GOOGLE_DOCS_FOLDER_ID = os.environ.get("GOOGLE_DOCS_FOLDER_ID", "")  # 保存先フォルダ

_google_creds = None
_docs_service = None
_drive_service = None


def _init_google_services():
    """Google Docs / Drive APIのサービスを初期化（サービスアカウント方式）"""
    global _google_creds, _docs_service, _drive_service
    if _docs_service:
        return True

    if not _GOOGLE_SERVICE_ACCOUNT_JSON:
        print("[GoogleDocs] GOOGLE_SERVICE_ACCOUNT_JSON not configured")
        return False

    try:
        from google.oauth2 import service_account
        from googleapiclient.discovery import build

        # JSON文字列 or ファイルパス
        if _GOOGLE_SERVICE_ACCOUNT_JSON.startswith("{"):
            import io
            info = json.loads(_GOOGLE_SERVICE_ACCOUNT_JSON)
            _google_creds = service_account.Credentials.from_service_account_info(
                info, scopes=[
                    "https://www.googleapis.com/auth/documents",
                    "https://www.googleapis.com/auth/drive.file",
                ]
            )
        else:
            _google_creds = service_account.Credentials.from_service_account_file(
                _GOOGLE_SERVICE_ACCOUNT_JSON, scopes=[
                    "https://www.googleapis.com/auth/documents",
                    "https://www.googleapis.com/auth/drive.file",
                ]
            )

        _docs_service = build("docs", "v1", credentials=_google_creds)
        _drive_service = build("drive", "v3", credentials=_google_creds)
        print("[GoogleDocs] Initialized successfully")
        return True
    except Exception as e:
        print(f"[GoogleDocs] Init failed: {e}")
        return False


def _create_google_doc(title: str) -> Optional[str]:
    """新しいGoogleドキュメントを作成してdocument_idを返す"""
    if not _init_google_services():
        return None
    try:
        doc = _docs_service.documents().create(body={"title": title}).execute()
        doc_id = doc["documentId"]

        # フォルダに移動（指定されている場合）
        if _GOOGLE_DOCS_FOLDER_ID and _drive_service:
            _drive_service.files().update(
                fileId=doc_id,
                addParents=_GOOGLE_DOCS_FOLDER_ID,
                fields="id, parents",
            ).execute()

        print(f"[GoogleDocs] Created: {title} ({doc_id})")
        return doc_id
    except Exception as e:
        print(f"[GoogleDocs] Create failed: {e}")
        return None


def _append_to_google_doc(doc_id: str, content: str):
    """Googleドキュメントにテキストを追記"""
    if not _init_google_services() or not doc_id:
        return
    try:
        # ドキュメントの末尾に追記
        doc = _docs_service.documents().get(documentId=doc_id).execute()
        body = doc.get("body", {})
        content_elements = body.get("content", [])
        end_index = content_elements[-1]["endIndex"] if content_elements else 1

        requests = [
            {
                "insertText": {
                    "location": {"index": end_index - 1},
                    "text": content,
                }
            }
        ]
        _docs_service.documents().batchUpdate(
            documentId=doc_id, body={"requests": requests}
        ).execute()
    except Exception as e:
        print(f"[GoogleDocs] Append failed: {e}")


def _write_google_doc(doc_id: str, sections: list[dict]):
    """Googleドキュメントに構造化コンテンツを書き込み
    sections: [{"heading": "見出し", "body": "本文"}, ...]
    """
    if not _init_google_services() or not doc_id:
        return
    try:
        # 全テキストを組み立て
        full_text = ""
        for section in sections:
            if section.get("heading"):
                full_text += f"\n{section['heading']}\n{'─' * 40}\n"
            if section.get("body"):
                full_text += f"{section['body']}\n\n"

        # ドキュメントの末尾に追記
        doc = _docs_service.documents().get(documentId=doc_id).execute()
        body = doc.get("body", {})
        content_elements = body.get("content", [])
        end_index = content_elements[-1]["endIndex"] if content_elements else 1

        requests = [
            {
                "insertText": {
                    "location": {"index": end_index - 1},
                    "text": full_text,
                }
            }
        ]
        _docs_service.documents().batchUpdate(
            documentId=doc_id, body={"requests": requests}
        ).execute()
        print(f"[GoogleDocs] Written {len(sections)} sections to {doc_id}")
    except Exception as e:
        print(f"[GoogleDocs] Write failed: {e}")


# ══════════════════════════════════════════════════════════════
# レポーターAI（時報・日報エージェント）
# ══════════════════════════════════════════════════════════════

REPORTER_PERSONA = {
    "name": "レポーターAI",
    "icon": "📄",
    "role": "時報・日報レポート生成 → Googleドキュメント",
    "phase": 6,
    "color": "#0ea5e9",
    "system_prompt": """あなたは株式会社はこのリサーチチームの報告書作成AIです。

【役割】
- リサーチエージェント群の議論内容を、人間が読みやすいレポートにまとめる
- Googleドキュメントに記載する形式で出力する
- 時報（3時間ごと）と日報（毎日9:00 JST）の2種類のレポートを作成する

【時報レイアウト】
```
📊 時報レポート（HH:MM JST）
━━━━━━━━━━━━━━━━━━━━
■ 直近の動き
  - [セッションID] カテゴリ: ステータス
■ 新たに発見された商品
  - 商品名 / ブランド / 評価
■ 注目ポイント
  - エージェント間で議論になった点
■ 次のアクション
  - 優先順位付きのTODO
```

【日報レイアウト】
```
📋 日報（YYYY年MM月DD日）
━━━━━━━━━━━━━━━━━━━━
■ エグゼクティブサマリー（3行以内）
■ 本日のリサーチ成果
  - 調査セッション数
  - 発見商品数
  - Go判定の商品
■ 商品別議事録
  [商品ごとに全エージェントの見解サマリー]
■ メタ認知AIの指摘事項
■ 蓄積されたSkill
■ 明日のアクションアイテム
■ トークン使用量サマリー
```

【重要】
- ビジネスパーソンが短時間で読めるよう簡潔にまとめること
- 数字は具体的に記載すること
- 判断が必要な項目は明確に示すこと""",
}


async def generate_hourly_report(sessions_data: list[dict], llm_call_fn) -> dict:
    """時報レポートを生成"""
    now_jst = datetime.now(JST).strftime("%Y-%m-%d %H:%M")

    prompt = f"""以下のリサーチセッションデータを元に、時報レポートを作成してください。
現在時刻: {now_jst} JST

【セッションデータ】
{json.dumps(sessions_data, ensure_ascii=False, indent=2, default=str)}

以下のJSON形式で出力:
{{
  "report_type": "hourly",
  "timestamp": "{now_jst}",
  "sections": [
    {{"heading": "直近の動き", "body": "..."}},
    {{"heading": "新たに発見された商品", "body": "..."}},
    {{"heading": "注目ポイント", "body": "..."}},
    {{"heading": "次のアクション", "body": "..."}}
  ]
}}"""

    result_text = await llm_call_fn(REPORTER_PERSONA["system_prompt"], prompt,
                                     agent_id="reporter", agent_name="レポーターAI", phase=6)
    try:
        return json.loads(result_text)
    except json.JSONDecodeError:
        return {"report_type": "hourly", "timestamp": now_jst,
                "sections": [{"heading": "エラー", "body": result_text}]}


async def generate_daily_report(sessions_data: list[dict], skills_data: list[dict],
                                 token_summary: dict, llm_call_fn) -> dict:
    """日報レポートを生成"""
    today = datetime.now(JST).strftime("%Y年%m月%d日")

    prompt = f"""以下のデータを元に、本日の日報を作成してください。
日付: {today}

【本日のリサーチセッション】
{json.dumps(sessions_data, ensure_ascii=False, indent=2, default=str)}

【蓄積されたSkill】
{json.dumps(skills_data, ensure_ascii=False, indent=2, default=str)}

【トークン使用量】
{json.dumps(token_summary, ensure_ascii=False, indent=2, default=str)}

以下のJSON形式で出力:
{{
  "report_type": "daily",
  "date": "{today}",
  "sections": [
    {{"heading": "エグゼクティブサマリー", "body": "..."}},
    {{"heading": "本日のリサーチ成果", "body": "..."}},
    {{"heading": "商品別議事録", "body": "..."}},
    {{"heading": "メタ認知AIの指摘事項", "body": "..."}},
    {{"heading": "蓄積されたSkill", "body": "..."}},
    {{"heading": "明日のアクションアイテム", "body": "..."}},
    {{"heading": "トークン使用量サマリー", "body": "..."}}
  ]
}}"""

    result_text = await llm_call_fn(REPORTER_PERSONA["system_prompt"], prompt,
                                     agent_id="reporter", agent_name="レポーターAI", phase=6)
    try:
        return json.loads(result_text)
    except json.JSONDecodeError:
        return {"report_type": "daily", "date": today,
                "sections": [{"heading": "エラー", "body": result_text}]}


async def write_report_to_google_docs(report: dict, doc_id: Optional[str] = None) -> Optional[str]:
    """レポートをGoogleドキュメントに書き込み"""
    report_type = report.get("report_type", "unknown")
    timestamp = report.get("timestamp", report.get("date", ""))

    if not doc_id:
        # 日報は日ごとに新しいドキュメント、時報は同じドキュメントに追記
        if report_type == "daily":
            title = f"📋 日報 - {timestamp}"
        else:
            title = f"📊 リサーチレポート - {datetime.now(JST).strftime('%Y-%m-%d')}"
        doc_id = _create_google_doc(title)

    if not doc_id:
        print("[Reporter] Google Docs unavailable, skipping write")
        return None

    sections = report.get("sections", [])
    if report_type == "hourly":
        header = f"\n\n{'═' * 50}\n📊 時報（{timestamp}）\n{'═' * 50}\n"
        _append_to_google_doc(doc_id, header)

    _write_google_doc(doc_id, sections)
    return doc_id


# ══════════════════════════════════════════════════════════════
# 定期実行スケジューラ
# ══════════════════════════════════════════════════════════════

_scheduler_running = False
_scheduler_config = {
    "hourly_enabled": False,
    "hourly_interval_hours": 3,
    "daily_enabled": False,
    "daily_hour_jst": 9,
    "daily_minute_jst": 0,
    "google_doc_id_hourly": None,  # 時報用ドキュメントID（日次でリセット）
    "google_doc_id_daily": None,   # 日報用ドキュメントID
}
_scheduler_lock = threading.Lock()
_last_hourly_report = None
_last_daily_report = None


def get_scheduler_config() -> dict:
    with _scheduler_lock:
        return dict(_scheduler_config)


def update_scheduler_config(config: dict):
    with _scheduler_lock:
        _scheduler_config.update(config)


async def start_scheduler(get_sessions_fn, get_skills_fn, llm_call_fn):
    """定期レポートスケジューラを開始"""
    global _scheduler_running, _last_hourly_report, _last_daily_report

    if _scheduler_running:
        return
    _scheduler_running = True
    print("[Scheduler] Started")

    while _scheduler_running:
        try:
            now_jst = datetime.now(JST)
            config = get_scheduler_config()

            # ── 時報チェック ──
            if config["hourly_enabled"]:
                interval = config["hourly_interval_hours"]
                should_run_hourly = False

                if _last_hourly_report is None:
                    should_run_hourly = True
                else:
                    elapsed = (now_jst - _last_hourly_report).total_seconds() / 3600
                    if elapsed >= interval:
                        should_run_hourly = True

                if should_run_hourly:
                    print(f"[Scheduler] Running hourly report at {now_jst.strftime('%H:%M')}")
                    try:
                        sessions = get_sessions_fn()
                        report = await generate_hourly_report(sessions, llm_call_fn)
                        doc_id = await write_report_to_google_docs(
                            report, config.get("google_doc_id_hourly")
                        )
                        if doc_id:
                            with _scheduler_lock:
                                _scheduler_config["google_doc_id_hourly"] = doc_id
                        _last_hourly_report = now_jst
                    except Exception as e:
                        print(f"[Scheduler] Hourly report error: {e}")

            # ── 日報チェック ──
            if config["daily_enabled"]:
                target_hour = config["daily_hour_jst"]
                target_minute = config["daily_minute_jst"]
                should_run_daily = False

                if _last_daily_report is None or _last_daily_report.date() < now_jst.date():
                    if now_jst.hour == target_hour and now_jst.minute >= target_minute:
                        should_run_daily = True

                if should_run_daily:
                    print(f"[Scheduler] Running daily report at {now_jst.strftime('%H:%M')}")
                    try:
                        sessions = get_sessions_fn()
                        skills = await get_skills_fn()
                        # トークン集計
                        token_summary = {"note": "日次集計"}
                        report = await generate_daily_report(
                            sessions, skills, token_summary, llm_call_fn
                        )
                        doc_id = await write_report_to_google_docs(report)
                        _last_daily_report = now_jst
                        # 時報用ドキュメントIDをリセット（新日 = 新ドキュメント）
                        with _scheduler_lock:
                            _scheduler_config["google_doc_id_hourly"] = None
                    except Exception as e:
                        print(f"[Scheduler] Daily report error: {e}")

        except Exception as e:
            print(f"[Scheduler] Error: {e}")

        # 60秒ごとにチェック
        await asyncio.sleep(60)


def stop_scheduler():
    global _scheduler_running
    _scheduler_running = False
    print("[Scheduler] Stopped")
