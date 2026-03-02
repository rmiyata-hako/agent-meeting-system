"""
マルチエージェント商品リサーチシステム v2.0
=========================================
9つのエージェント人格が自律的にリサーチ・評価・議論を行い、
学習したSkillを蓄積して次回に活かす。

エージェント構成:
  Phase 1 - 調査: Searcher（サーチャー）
  Phase 2 - 並列評価: PL Evaluator / Marketer / Legal Checker / Supply Chain
  Phase 3 - 深堀り: Consumer Insight / Trend Analyst
  Phase 4 - 検証: Meta Cognition（ファシリテーター）
  Phase 5 - 記録: Secretary（議事録AI）

設計思想（くのーる氏のポストに触発）:
  - 書くAIと疑うAIの分離（Anti-Satisficing）
  - Skill蓄積による継続的な判断精度向上
  - 議論プロセスの完全可視化
"""
import os
import json
import asyncio
import time
import uuid
import threading
from pathlib import Path
from typing import Optional

# ── Gemini設定 ─────────────────────────────────────────────
_GEMINI_API_KEY = os.environ.get("GEMINI_API_KEY", "")
_GEMINI_MODEL = os.environ.get("GEMINI_MODEL", "gemini-2.0-flash")

# ── Claude設定（Anthropic API） ────────────────────────────
_CLAUDE_API_KEY = os.environ.get("ANTHROPIC_API_KEY", "")
_CLAUDE_MODEL = os.environ.get("CLAUDE_MODEL", "claude-sonnet-4-20250514")

# ── Groq設定（無料枠: Llama 3.3 70B） ────────────────────────
_GROQ_API_KEY = os.environ.get("GROQ_API_KEY", "")
_GROQ_MODEL = os.environ.get("GROQ_MODEL", "llama-3.3-70b-versatile")

# ── LLMプロバイダー設定 ─────────────────────────────────────
# エージェントごとにどのLLMを使うかを指定
# "gemini" / "claude" / "groq" / "auto"（利用可能な最適なものを自動選択）
DEFAULT_LLM_PROVIDER = os.environ.get("RESEARCH_LLM_PROVIDER", "auto")

AGENT_LLM_MAP: dict[str, str] = {
    # Phase 4のメタ認知はClaude（高品質推論）、それ以外はGemini/Groqで高速処理
    "searcher": "gemini",
    "pl_evaluator": "gemini",
    "marketer": "gemini",
    "legal_checker": "gemini",
    "supply_chain": "groq",       # Groq無料枠を活用（高速）
    "consumer_insight": "groq",   # Groq無料枠を活用（高速）
    "trend_analyst": "gemini",
    "meta_cognition": "claude",   # 高品質推論が必要 → Claude
    "secretary": "gemini",
    "reporter": "gemini",
}

# ── 株式会社はこ コンテキスト（全エージェントに共有） ──────────
COMPANY_CONTEXT = """
【自社情報: 株式会社はこ（ha-ko.co.jp）】
- 代表: 亀谷誠一郎
- 事業: プライベートエージェンシー®（BtoCマーケティングのワンストップ支援）
- 得意領域: DRM（ダイレクトレスポンスマーケティング）、記事LP、広告運用、Web行動心理学
- 規模: 従業員25名、年商約29億円
- 強み:
  1. 記事LP×DRMの知見が豊富（分析ダッシュボードも自社開発）
  2. 広告運用〜制作〜システムまでワンストップ対応
  3. Web行動心理学研究所（インフォデックス）の知見
  4. GAS/RPA/AI活用による効率化の内製力
  5. ヒートマップ・チャットbot等の自社開発ツール群
- 新規事業の方針: 海外で売れているがリ日本未上陸の商品を発掘し、国内代理店として契約・販売する
- 販売チャネルの強み: 記事LP + SNS広告 + EC（Amazon/楽天）のDRM型販売に圧倒的な実績
- この新規事業で活かせる自社アセット:
  1. 記事LP制作力（読了率・CVRを最大化するライティング）
  2. 広告運用力（Meta/Google/LINE等のダイレクト広告）
  3. 心理学ベースのクリエイティブ設計
  4. データ分析・ABテスト文化
"""

# ── トークン使用量トラッキング ─────────────────────────
class TokenTracker:
    """エージェントごとのトークン使用量を記録"""
    def __init__(self):
        self.usage: list[dict] = []
        self._lock = threading.Lock()

    def record(self, agent_id: str, agent_name: str, phase: int,
               input_tokens: int = 0, output_tokens: int = 0):
        total = input_tokens + output_tokens
        # Gemini Flash: 入力$0.075/1M, 出力$0.30/1M (概算)
        cost = (input_tokens * 0.075 + output_tokens * 0.30) / 1_000_000
        with self._lock:
            self.usage.append({
                "agent_id": agent_id,
                "agent_name": agent_name,
                "phase": phase,
                "input_tokens": input_tokens,
                "output_tokens": output_tokens,
                "total_tokens": total,
                "estimated_cost_usd": round(cost, 6),
            })

    def get_summary(self) -> dict:
        with self._lock:
            total_input = sum(u["input_tokens"] for u in self.usage)
            total_output = sum(u["output_tokens"] for u in self.usage)
            total_cost = sum(u["estimated_cost_usd"] for u in self.usage)
            return {
                "per_agent": list(self.usage),
                "total_input_tokens": total_input,
                "total_output_tokens": total_output,
                "total_tokens": total_input + total_output,
                "total_estimated_cost_usd": round(total_cost, 6),
            }

    def to_list(self) -> list[dict]:
        with self._lock:
            return list(self.usage)

# ── Supabase設定（Skill蓄積用） ────────────────────────────
_supabase_client = None

def _get_supabase():
    global _supabase_client
    if _supabase_client:
        return _supabase_client
    url = os.environ.get("SUPABASE_URL", "")
    key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "")
    if not url or not key:
        return None
    try:
        from supabase import create_client
        _supabase_client = create_client(url, key)
        return _supabase_client
    except Exception:
        return None


# ══════════════════════════════════════════════════════════════
# エージェント人格定義（9エージェント）
# ══════════════════════════════════════════════════════════════

AGENT_PERSONAS = {
    # ── Phase 1: 調査 ──
    "searcher": {
        "name": "リサーチャー",
        "nickname": "ハンター",   # 世界中の原石を嗅ぎ当てるハンター
        "icon": "🔍",
        "role": "海外商品サーチャー",
        "phase": 1,
        "color": "#3b82f6",
        "llm": "gemini",
        "system_prompt": """あなたは海外市場の商品リサーチ専門AIです。

【役割】
- 海外（北米・欧州・韓国・中国・東南アジア）で販売されている商品で、日本未上陸または認知度が低い商品を発見する
- Amazon.com、Target、Walmart、Sephora、iHerb等の海外ECサイトの人気商品を調査する
- Reddit、TikTok、Instagram等のSNSでバズっている商品トレンドを把握する

【出力ルール】
- 実在する商品のみ提案すること
- 情報の確実性を"confirmed"/"likely"/"unverified"で明示すること
- 1回の調査で3〜5商品をリストアップすること
- 過去のSkill（提供される場合）を参考に、より精度の高い調査を行うこと""",
    },

    # ── Phase 2: 並列評価 ──
    "pl_evaluator": {
        "name": "PL評価者",
        "nickname": "ソロバン",   # 算盤を弾いて損得を冷静に見極める
        "icon": "📊",
        "role": "収益性・市場性評価",
        "phase": 2,
        "color": "#22c55e",
        "llm": "gemini",
        "system_prompt": """あなたは事業のPL（損益計算書）視点から商品の市場性と収益性を評価する専門AIです。

【役割】
- 代理店として日本で販売する場合の事業性を評価する
- 定量的な視点を重視し、数値ベースで議論する

【評価軸】
1. market_size_estimate: 日本での想定市場規模（年間、円ベース概算）
2. competition_level: 競合の激しさ（"低"/"中"/"高"）と主要競合
3. gross_margin_estimate: 想定粗利率（%）- 仕入原価・輸送費・関税を考慮
4. initial_investment: 初期投資見込み（仕入れ最小ロット・認証費用等）
5. breakeven_months: 損益分岐までの概算月数
6. risk_factors: リスク要因（為替、規制、季節性、トレンド寿命等）
7. scalability: スケーラビリティ（"低"/"中"/"高"）
8. overall_rating: 総合評価（S/A/B/C/D）
9. confidence: 評価の確信度（1-5）とその根拠

【重要】
- 楽観的すぎず、現実的な数字を出すこと
- リスクは正直に指摘すること
- 確信度が低い場合はその理由を明記すること""",
    },

    "marketer": {
        "name": "マーケター",
        "nickname": "バズ美",   # 日本市場でバズらせるプロ
        "icon": "📣",
        "role": "日本ECマーケティング戦略",
        "phase": 2,
        "color": "#f59e0b",
        "llm": "gemini",
        "system_prompt": """あなたは日本のEC市場に特化したマーケティング戦略AIです。

【役割】
- 海外商品を日本のECで販売する際のプロモーション戦略を立案する
- Amazon Japan、楽天市場、Yahoo!ショッピング、自社EC等のプラットフォーム戦略を策定する
- SNSマーケティング、インフルエンサー施策、広告戦略を提案する

【提案項目】
1. target_persona: ターゲットペルソナ（年齢層、性別、ライフスタイル、課題）
2. platform_strategy: 推奨販売プラットフォームとその理由
3. positioning: 日本市場でのポジショニング（価格帯・ブランディング方針）
4. launch_strategy: ローンチ戦略（初動の集客施策）
5. sns_strategy: SNS活用戦略（プラットフォーム選定・コンテンツ方針）
6. ad_budget_estimate: 月間広告予算目安（円）
7. differentiator: 日本の類似商品との差別化ポイント
8. naming_suggestion: 日本市場向けの商品名・キャッチコピー案
9. conversion_potential: EC上でのCVR見込み（"低"/"中"/"高"）
10. confidence: 確信度（1-5）とその根拠

【重要】
- 日本の消費者心理・購買行動を踏まえること
- 予算感はスモールスタートを前提とすること""",
    },

    "legal_checker": {
        "name": "法務・規制チェッカー",
        "nickname": "ガードン",   # 規制の壁から事業を守る門番
        "icon": "⚖️",
        "role": "法規制・コンプライアンス確認",
        "phase": 2,
        "color": "#ef4444",
        "llm": "gemini",
        "system_prompt": """あなたは輸入ビジネスの法務・規制に特化した専門AIです。

【役割】
- 海外商品を日本に輸入・販売する際の法規制リスクを評価する
- 必要な許認可・届出・認証を洗い出す

【チェック項目】
1. applicable_laws: 適用される法律（薬機法/食品衛生法/JAS法/PL法/PSE・PSC/電波法/消費生活用製品安全法等）
2. required_certifications: 必要な認証・届出（一覧）
3. certification_cost_estimate: 認証取得の概算費用・期間
4. labeling_requirements: 表示義務（成分表示、原産国表示、注意書き等）
5. import_restrictions: 輸入制限・禁止事項
6. risk_level: 法的リスクレベル（"低"/"中"/"高"/"要専門家確認"）
7. compliance_roadmap: コンプライアンス確保までのステップ
8. confidence: 確信度（1-5）。法改正等で不確実な場合は必ず明記

【重要】
- 規制見落とし=事業失敗。保守的に判断すること
- 不確実な場合は「要専門家確認」を推奨すること
- 最新の法改正に注意を喚起すること""",
    },

    "supply_chain": {
        "name": "サプライチェーンAI",
        "nickname": "シッパー",   # 海の向こうから届けるプロ
        "icon": "🚢",
        "role": "物流・通関・調達戦略",
        "phase": 2,
        "color": "#8b5cf6",
        "llm": "groq",
        "system_prompt": """あなたは国際物流とサプライチェーンの専門AIです。

【役割】
- 海外商品の仕入れから日本での配送までのサプライチェーンを設計する
- コスト最適化と在庫リスクのバランスを提案する

【評価項目】
1. sourcing_method: 仕入れ方法（直接取引/卸経由/代理店契約）
2. moq: 最小発注数量（MOQ）の見込み
3. lead_time: リードタイム（発注〜入庫）
4. shipping_method: 推奨輸送方法（航空便/海上便/混載）
5. customs_duty: 関税率・通関手続きの注意点
6. warehousing: 倉庫戦略（自社/3PL/FBA）
7. fulfillment_cost: フルフィルメントコスト概算（1個あたり）
8. inventory_risk: 在庫リスク評価
9. scalability_plan: スケールアップ時の物流戦略
10. confidence: 確信度（1-5）

【重要】
- 初期はスモールスタート前提で設計すること
- FBA（Fulfillment by Amazon）の活用可否を必ず検討すること
- 為替リスク・輸送遅延リスクを考慮すること""",
    },

    # ── Phase 3: 深堀り ──
    "consumer_insight": {
        "name": "消費者インサイトAI",
        "nickname": "ヒトミ",   # 消費者の本音を見抜く瞳
        "icon": "👤",
        "role": "消費者需要検証・レビュー分析",
        "phase": 3,
        "color": "#ec4899",
        "llm": "groq",
        "system_prompt": """あなたは消費者インサイトと需要検証の専門AIです。

【役割】
- 「売れそう」→「本当に欲しがる人がいるか」を検証する
- 海外レビュー・SNSの声を分析し、日本の消費者に響くかを判断する

【分析項目】
1. demand_validation: 需要は本物か？（根拠を示す）
2. overseas_sentiment: 海外での評判サマリー（ポジティブ/ネガティブ要因）
3. japan_fit_score: 日本市場との適合度（1-10）と理由
4. pain_point_match: 日本の消費者の課題とのマッチ度
5. cultural_barriers: 文化的障壁（パッケージデザイン、味覚、サイズ感等）
6. word_of_mouth_potential: 口コミ拡散ポテンシャル（"低"/"中"/"高"）
7. seasonal_factor: 季節性の有無
8. repeat_purchase_likelihood: リピート購入の見込み（"低"/"中"/"高"）
9. confidence: 確信度（1-5）

【重要】
- 楽観的な予測を避け、実データに基づくこと
- 日本独自の消費者行動（品質重視、レビュー依存度等）を考慮すること""",
    },

    "trend_analyst": {
        "name": "トレンドアナリスト",
        "nickname": "ミライ",   # 3年後の未来を読む先見の目
        "icon": "📈",
        "role": "中長期トレンド分析・一過性判定",
        "phase": 3,
        "color": "#06b6d4",
        "llm": "gemini",
        "system_prompt": """あなたは市場トレンドの中長期分析を行う専門AIです。

【役割】
- サーチャーが見つけた「今バズっている商品」が一過性か持続的かを判定する
- 3年後の市場見通しを立てる

【分析項目】
1. trend_type: トレンド種別（"一過性バズ"/"成長初期"/"成熟期"/"衰退期"）
2. trend_lifecycle_months: トレンドの残存期間見込み（月数）
3. underlying_drivers: トレンドの根本要因（技術革新/ライフスタイル変化/規制変更等）
4. similar_precedents: 類似の過去事例とその結末
5. japan_trend_lag: 日本への波及タイムラグ見込み
6. market_growth_forecast: 市場成長率予測（年率）
7. disruption_risk: ディスラプションリスク（より良い代替品の登場等）
8. timing_verdict: 参入タイミング判定（"今すぐ"/"6ヶ月以内"/"様子見"/"見送り"）
9. confidence: 確信度（1-5）

【重要】
- 短期的なバズに惑わされず、構造的変化を見ること
- 過去の類似トレンドの失敗事例も必ず言及すること""",
    },

    # ── Phase 4: 検証（メタ認知） ──
    "meta_cognition": {
        "name": "メタ認知AI",
        "nickname": "ツッコミ",   # 甘い判断に容赦なくツッコむ
        "icon": "🧠",
        "role": "議論品質モニタリング・バイアス検知",
        "phase": 4,
        "color": "#6366f1",
        "llm": "claude",   # 高品質推論が必要
        "system_prompt": """あなたはエージェント群の議論品質を監視するメタ認知AIです。
くのーる氏の提唱するAnti-Satisficing原則に基づき、他のエージェントが「十分」と判断した出力を疑う役割です。

【役割】
- 各エージェントの出力を横断的にチェックし、盲点・バイアス・矛盾を検出する
- 「ここが甘い」「ここは検証が足りない」を指摘する
- 議論全体の品質スコアを算出する

【チェック項目】
1. blind_spots: 見落とされている視点・リスク
2. biases_detected: 検出されたバイアス（楽観バイアス、確証バイアス等）
3. contradictions: エージェント間の矛盾点
4. low_confidence_areas: 確信度が低いにも関わらず強い結論を出している箇所
5. missing_data: 判断に必要だが欠けているデータ
6. over_optimistic_claims: 楽観的すぎる主張
7. quality_score: 議論全体の品質スコア（1-10）
8. improvement_suggestions: 議論の質を上げるための提案
9. go_nogo_recommendation: 最終的なGo/No-Go推奨とその理由

【重要】
- 他のエージェントに忖度しないこと
- 「全員が賛成している」場合こそ疑うこと（集団思考の罠）
- 具体的な指摘と根拠を示すこと""",
    },

    # ── Phase 5: 記録 ──
    "secretary": {
        "name": "議事録AI",
        "nickname": "まとめ",   # 議論を中立にまとめる書記
        "icon": "📝",
        "role": "中立的な議事録・Skill抽出",
        "phase": 5,
        "color": "#64748b",
        "llm": "gemini",
        "system_prompt": """あなたは議事録を取り、学習Skillを抽出する中立的なAIです。

【役割】
- 全エージェントの発言を客観的に記録・要約する
- 意見の相違点を明確にし、バイアスなく整理する
- 今回の議論から得られた「Skill（学び）」を抽出する

【出力構成】
1. executive_summary: エグゼクティブサマリー（3行以内）
2. products_discussed: 議論された商品リスト
3. per_product_summary: 商品ごとの全エージェント見解まとめ
4. recommended_actions: 推奨アクション（優先度付き）
5. next_research_topics: 次回調査すべきテーマ
6. learned_skills: 今回の議論で得られたSkill（次回に活かす知見）
   - skill_type: "market_insight"/"regulation"/"pricing"/"logistics"/"consumer"/"trend"
   - description: 学びの内容
   - applicable_categories: 適用可能なカテゴリ
   - source_product: 情報源の商品名

【Skill抽出の指針】
- 「この商品で学んだことは、別の商品でも使える」汎用的な知見を抽出
- 具体的かつ再利用可能な形で記述すること
- 失敗・リスクからの学びも含めること""",
    },

    # ── Phase 6: レポート（時報・日報） ──
    "reporter": {
        "name": "レポーターAI",
        "nickname": "キロク",   # 時報・日報を書く記録係
        "icon": "📄",
        "role": "時報・日報レポート → Googleドキュメント",
        "phase": 6,
        "color": "#0ea5e9",
        "llm": "gemini",
        "system_prompt": """あなたは株式会社はこのリサーチチームの報告書作成AI「キロク」です。

【役割】
- リサーチエージェント群の議論内容を、人間が読みやすいレポートにまとめる
- Googleドキュメントに記載する形式で出力する
- 時報（3時間ごと）と日報（毎日9:00 JST）の2種類のレポートを作成する

【時報レイアウト】
📊 時報レポート（HH:MM JST）
  ■ 直近の動き（セッション・ステータス）
  ■ 新たに発見された商品（商品名/ブランド/評価）
  ■ 注目ポイント（エージェント間で議論になった点）
  ■ 次のアクション（優先順位付き）

【日報レイアウト】
📋 日報（YYYY年MM月DD日）
  ■ エグゼクティブサマリー（3行以内）
  ■ 本日のリサーチ成果（調査数・発見商品数・Go判定）
  ■ 商品別議事録（全エージェントのあだ名で記載）
  ■ ツッコミの指摘事項
  ■ 蓄積されたSkill
  ■ 明日のアクションアイテム
  ■ トークン使用量サマリー

【重要】
- 各エージェントの発言はあだ名で記載すること
  （ハンター/ソロバン/バズ美/ガードン/シッパー/ヒトミ/ミライ/ツッコミ/まとめ）
- ビジネスパーソンが短時間で読めるよう簡潔に
- 数字は具体的に記載すること""",
    },
}


# ══════════════════════════════════════════════════════════════
# マルチLLM APIコール（Gemini / Claude / Groq）
# ══════════════════════════════════════════════════════════════

def _resolve_llm_provider(agent_id: str) -> str:
    """エージェントに割り当てられたLLMプロバイダーを解決する"""
    # エージェント個別設定 → AGENT_LLM_MAP → DEFAULT_LLM_PROVIDER
    persona = AGENT_PERSONAS.get(agent_id, {})
    provider = persona.get("llm") or AGENT_LLM_MAP.get(agent_id) or DEFAULT_LLM_PROVIDER

    if provider == "auto":
        # 利用可能なプロバイダーを優先順に選択
        if _GEMINI_API_KEY:
            return "gemini"
        if _GROQ_API_KEY:
            return "groq"
        if _CLAUDE_API_KEY:
            return "claude"
        return "gemini"  # フォールバック

    # 指定されたプロバイダーのAPIキーがなければフォールバック
    if provider == "claude" and not _CLAUDE_API_KEY:
        return "gemini" if _GEMINI_API_KEY else "groq"
    if provider == "groq" and not _GROQ_API_KEY:
        return "gemini" if _GEMINI_API_KEY else "claude"

    return provider


async def _call_gemini(system_prompt: str, user_prompt: str, json_mode: bool = True) -> tuple[str, int, int]:
    """Gemini APIコール。(text, input_tokens, output_tokens) を返す"""
    from google import genai
    client = genai.Client(api_key=_GEMINI_API_KEY)
    config = {}
    if json_mode:
        config["response_mime_type"] = "application/json"
    full_system = f"{system_prompt}\n\n{COMPANY_CONTEXT}"
    response = await asyncio.to_thread(
        client.models.generate_content,
        model=_GEMINI_MODEL,
        contents=f"{full_system}\n\n---\n\n{user_prompt}",
        config=config if config else None,
    )
    usage = getattr(response, "usage_metadata", None)
    input_t = getattr(usage, "prompt_token_count", 0) if usage else 0
    output_t = getattr(usage, "candidates_token_count", 0) if usage else 0
    return response.text, input_t, output_t


async def _call_claude(system_prompt: str, user_prompt: str, json_mode: bool = True) -> tuple[str, int, int]:
    """Claude (Anthropic) APIコール"""
    import httpx
    full_system = f"{system_prompt}\n\n{COMPANY_CONTEXT}"
    if json_mode:
        user_prompt += "\n\nJSON形式で出力してください。JSONのみを返し、それ以外のテキストは含めないでください。"
    headers = {
        "x-api-key": _CLAUDE_API_KEY,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
    }
    body = {
        "model": _CLAUDE_MODEL,
        "max_tokens": 4096,
        "system": full_system,
        "messages": [{"role": "user", "content": user_prompt}],
    }
    async with httpx.AsyncClient(timeout=120) as client:
        resp = await client.post("https://api.anthropic.com/v1/messages", headers=headers, json=body)
        data = resp.json()
    text = data.get("content", [{}])[0].get("text", "")
    usage = data.get("usage", {})
    return text, usage.get("input_tokens", 0), usage.get("output_tokens", 0)


async def _call_groq(system_prompt: str, user_prompt: str, json_mode: bool = True) -> tuple[str, int, int]:
    """Groq APIコール（無料枠: Llama 3.3 70B）"""
    import httpx
    full_system = f"{system_prompt}\n\n{COMPANY_CONTEXT}"
    if json_mode:
        user_prompt += "\n\nJSON形式で出力してください。JSONのみを返し、それ以外のテキストは含めないでください。"
    headers = {
        "Authorization": f"Bearer {_GROQ_API_KEY}",
        "Content-Type": "application/json",
    }
    body = {
        "model": _GROQ_MODEL,
        "messages": [
            {"role": "system", "content": full_system},
            {"role": "user", "content": user_prompt},
        ],
        "max_tokens": 4096,
        "temperature": 0.7,
    }
    if json_mode:
        body["response_format"] = {"type": "json_object"}
    async with httpx.AsyncClient(timeout=120) as client:
        resp = await client.post("https://api.groq.com/openai/v1/chat/completions", headers=headers, json=body)
        data = resp.json()
    choice = data.get("choices", [{}])[0]
    text = choice.get("message", {}).get("content", "")
    usage = data.get("usage", {})
    return text, usage.get("prompt_tokens", 0), usage.get("completion_tokens", 0)


async def _call_llm(system_prompt: str, user_prompt: str,
                     json_mode: bool = True,
                     agent_id: str = "", agent_name: str = "", phase: int = 0,
                     token_tracker: Optional[TokenTracker] = None) -> str:
    """マルチLLM統合コール。エージェントに割り当てられたLLMを自動選択する"""
    provider = _resolve_llm_provider(agent_id)

    try:
        if provider == "claude":
            text, input_t, output_t = await _call_claude(system_prompt, user_prompt, json_mode)
        elif provider == "groq":
            text, input_t, output_t = await _call_groq(system_prompt, user_prompt, json_mode)
        else:  # gemini (default)
            text, input_t, output_t = await _call_gemini(system_prompt, user_prompt, json_mode)

        # トークン使用量を記録
        if token_tracker and agent_id:
            token_tracker.record(agent_id, f"{agent_name}({provider})", phase, input_t, output_t)

        return text
    except Exception as e:
        # プライマリが失敗した場合、Geminiにフォールバック
        if provider != "gemini" and _GEMINI_API_KEY:
            try:
                text, input_t, output_t = await _call_gemini(system_prompt, user_prompt, json_mode)
                if token_tracker and agent_id:
                    token_tracker.record(agent_id, f"{agent_name}(gemini-fallback)", phase, input_t, output_t)
                return text
            except Exception:
                pass
        return json.dumps({"error": str(e)}, ensure_ascii=False)


# ══════════════════════════════════════════════════════════════
# Skill蓄積システム（Supabase連携）
# ══════════════════════════════════════════════════════════════

async def load_skills(category: str = "", limit: int = 20) -> list[dict]:
    """過去のSkillをSupabaseから読み込む"""
    sb = _get_supabase()
    if not sb:
        return []
    try:
        query = sb.table("research_skills").select("*").order("created_at", desc=True).limit(limit)
        if category:
            query = query.or_(f"applicable_categories.cs.{{{category}}},applicable_categories.cs.{{all}}")
        result = await asyncio.to_thread(lambda: query.execute())
        return result.data or []
    except Exception:
        return []


async def save_skills(session_id: str, skills: list[dict]):
    """Skillを Supabase に保存"""
    sb = _get_supabase()
    if not sb or not skills:
        return
    try:
        rows = []
        for skill in skills:
            rows.append({
                "session_id": session_id,
                "skill_type": skill.get("skill_type", "general"),
                "description": skill.get("description", ""),
                "applicable_categories": skill.get("applicable_categories", []),
                "source_product": skill.get("source_product", ""),
                "created_at": time.strftime("%Y-%m-%dT%H:%M:%S"),
            })
        await asyncio.to_thread(lambda: sb.table("research_skills").insert(rows).execute())
    except Exception:
        pass


async def save_decision_log(session_id: str, product_name: str, decision: str, reasoning: dict):
    """判断経緯をSupabaseに保存"""
    sb = _get_supabase()
    if not sb:
        return
    try:
        row = {
            "session_id": session_id,
            "product_name": product_name,
            "decision": decision,
            "reasoning": json.dumps(reasoning, ensure_ascii=False),
            "created_at": time.strftime("%Y-%m-%dT%H:%M:%S"),
        }
        await asyncio.to_thread(lambda: sb.table("research_decisions").insert(row).execute())
    except Exception:
        pass


# ══════════════════════════════════════════════════════════════
# タイムライン（議論可視化用）
# ══════════════════════════════════════════════════════════════

class DiscussionTimeline:
    """エージェント間の議論をタイムライン形式で記録"""

    def __init__(self):
        self.entries: list[dict] = []
        self._lock = threading.Lock()

    def add(self, agent_id: str, event_type: str, content: str, metadata: dict = None):
        with self._lock:
            self.entries.append({
                "timestamp": time.strftime("%Y-%m-%dT%H:%M:%S"),
                "agent_id": agent_id,
                "agent_name": AGENT_PERSONAS.get(agent_id, {}).get("nickname", "") or AGENT_PERSONAS.get(agent_id, {}).get("name", agent_id),
                "agent_formal_name": AGENT_PERSONAS.get(agent_id, {}).get("name", agent_id),
                "agent_icon": AGENT_PERSONAS.get(agent_id, {}).get("icon", ""),
                "event_type": event_type,  # "start" / "result" / "challenge" / "skill"
                "content": content,
                "metadata": metadata or {},
            })

    def to_list(self) -> list[dict]:
        with self._lock:
            return list(self.entries)


# ══════════════════════════════════════════════════════════════
# エージェント実行関数
# ══════════════════════════════════════════════════════════════

async def run_searcher(category: str, keyword: str, skills: list[dict],
                       timeline: DiscussionTimeline, token_tracker: Optional[TokenTracker] = None) -> dict:
    """Phase 1: サーチャーが海外商品を調査"""
    timeline.add("searcher", "start", f"カテゴリ「{category or '全般'}」、キーワード「{keyword or '指定なし'}」で調査開始")

    skills_context = ""
    if skills:
        skills_text = "\n".join([f"- {s['description']}" for s in skills[:10]])
        skills_context = f"\n\n【過去の学習Skill（参考にすること）】\n{skills_text}"

    persona = AGENT_PERSONAS["searcher"]
    user_prompt = f"""以下の条件で海外商品をリサーチしてください。

調査カテゴリ: {category or "指定なし（幅広く調査）"}
キーワード: {keyword or "指定なし"}
調査日: {time.strftime("%Y-%m-%d")}
{skills_context}

条件:
- 海外で人気があり、日本で未販売または認知度が低い商品を3〜5つ発見してください
- 情報の確実性レベルを必ず明記してください

以下のJSON形式で出力:
{{
  "research_date": "{time.strftime("%Y-%m-%d")}",
  "category_focus": "{category or '全般'}",
  "products": [
    {{
      "product_name": "商品名（英語 / 日本語訳）",
      "brand": "ブランド名",
      "category": "カテゴリ",
      "origin_country": "主要販売国",
      "price_range_usd": "$XX - $XX",
      "key_features": ["特長1", "特長2", "特長3"],
      "popularity_signal": "人気の根拠",
      "japan_availability": "未上陸/並行輸入のみ/認知度低",
      "regulatory_note": "規制上の注意点",
      "info_confidence": "confirmed/likely/unverified"
    }}
  ],
  "market_trends": "全体的なトレンド所感"
}}"""

    result_text = await _call_llm(persona["system_prompt"], user_prompt,
                                      agent_id="searcher", agent_name=persona["name"],
                                      phase=1, token_tracker=token_tracker)
    try:
        result = json.loads(result_text)
    except json.JSONDecodeError:
        result = {"raw_text": result_text, "error": "JSON parse failed"}

    product_count = len(result.get("products", []))
    timeline.add("searcher", "result", f"{product_count}件の候補商品を発見", {"product_count": product_count})
    return result


async def _run_evaluator(agent_id: str, products_data: dict, skills: list[dict],
                         timeline: DiscussionTimeline, extra_prompt: str = "",
                         token_tracker: Optional[TokenTracker] = None) -> dict:
    """Phase 2 共通: 評価系エージェントを実行"""
    persona = AGENT_PERSONAS[agent_id]
    timeline.add(agent_id, "start", f"{persona['name']}が分析を開始")

    skills_context = ""
    relevant_skills = [s for s in skills if s.get("skill_type") in _skill_type_map().get(agent_id, [])]
    if relevant_skills:
        skills_text = "\n".join([f"- {s['description']}" for s in relevant_skills[:5]])
        skills_context = f"\n\n【過去の学習Skill（参考にすること）】\n{skills_text}"

    user_prompt = f"""以下の商品リストについて、あなたの専門分野から評価してください。
{skills_context}

【調査された商品データ】
{json.dumps(products_data, ensure_ascii=False, indent=2)}

{extra_prompt}

JSON形式で出力してください。各評価には confidence（確信度 1-5）を必ず含めてください。"""

    result_text = await _call_llm(persona["system_prompt"], user_prompt,
                                      agent_id=agent_id, agent_name=persona["name"],
                                      phase=persona["phase"], token_tracker=token_tracker)
    try:
        result = json.loads(result_text)
    except json.JSONDecodeError:
        result = {"raw_text": result_text, "error": "JSON parse failed"}

    timeline.add(agent_id, "result", f"{persona['name']}の分析完了")
    return result


def _skill_type_map() -> dict[str, list[str]]:
    return {
        "pl_evaluator": ["market_insight", "pricing"],
        "marketer": ["consumer", "market_insight"],
        "legal_checker": ["regulation"],
        "supply_chain": ["logistics"],
        "consumer_insight": ["consumer", "market_insight"],
        "trend_analyst": ["trend", "market_insight"],
    }


async def run_pl_evaluator(products_data: dict, skills: list[dict], timeline: DiscussionTimeline, token_tracker: Optional[TokenTracker] = None) -> dict:
    return await _run_evaluator("pl_evaluator", products_data, skills, timeline, token_tracker=token_tracker, extra_prompt="""
出力形式:
{
  "evaluations": [
    {
      "product_name": "商品名",
      "market_size_estimate": "想定市場規模（年間）",
      "competition_level": "低/中/高",
      "major_competitors": ["競合1", "競合2"],
      "gross_margin_estimate": "XX%",
      "cost_breakdown": {"product_cost_ratio": "XX%", "shipping_customs": "XX%", "platform_fee": "XX%", "marketing": "XX%"},
      "initial_investment": "初期投資見込み",
      "breakeven_months": "損益分岐月数",
      "risk_factors": ["リスク1", "リスク2"],
      "scalability": "低/中/高",
      "overall_rating": "S/A/B/C/D",
      "verdict": "一言コメント（50字以内）",
      "confidence": 3
    }
  ],
  "portfolio_recommendation": "ポートフォリオとしての所感"
}""")


async def run_marketer(products_data: dict, skills: list[dict], timeline: DiscussionTimeline, token_tracker: Optional[TokenTracker] = None) -> dict:
    return await _run_evaluator("marketer", products_data, skills, timeline, token_tracker=token_tracker, extra_prompt="""
出力形式:
{
  "strategies": [
    {
      "product_name": "商品名",
      "target_persona": "ターゲット像",
      "platform_strategy": "推奨プラットフォームと理由",
      "positioning": "ポジショニング方針",
      "launch_strategy": "ローンチ戦略",
      "sns_strategy": "SNS活用戦略",
      "ad_budget_estimate": "月間広告予算目安",
      "differentiator": "差別化ポイント",
      "naming_suggestion": "日本向け商品名・キャッチコピー案",
      "concerns": "懸念点",
      "conversion_potential": "低/中/高",
      "confidence": 3
    }
  ],
  "cross_selling_ideas": "クロスセルの可能性"
}""")


async def run_legal_checker(products_data: dict, skills: list[dict], timeline: DiscussionTimeline, token_tracker: Optional[TokenTracker] = None) -> dict:
    return await _run_evaluator("legal_checker", products_data, skills, timeline, token_tracker=token_tracker, extra_prompt="""
出力形式:
{
  "assessments": [
    {
      "product_name": "商品名",
      "applicable_laws": ["適用法律1", "適用法律2"],
      "required_certifications": ["認証1", "認証2"],
      "certification_cost_estimate": "概算費用・期間",
      "labeling_requirements": "表示義務",
      "import_restrictions": "輸入制限事項",
      "risk_level": "低/中/高/要専門家確認",
      "compliance_roadmap": ["ステップ1", "ステップ2"],
      "confidence": 3
    }
  ],
  "overall_regulatory_risk": "全体的な規制リスク所感"
}""")


async def run_supply_chain(products_data: dict, skills: list[dict], timeline: DiscussionTimeline, token_tracker: Optional[TokenTracker] = None) -> dict:
    return await _run_evaluator("supply_chain", products_data, skills, timeline, token_tracker=token_tracker, extra_prompt="""
出力形式:
{
  "logistics_plans": [
    {
      "product_name": "商品名",
      "sourcing_method": "仕入れ方法",
      "moq": "最小発注数量",
      "lead_time": "リードタイム",
      "shipping_method": "推奨輸送方法",
      "customs_duty": "関税率・注意点",
      "warehousing": "倉庫戦略",
      "fulfillment_cost": "1個あたりコスト概算",
      "inventory_risk": "在庫リスク評価",
      "scalability_plan": "スケールアップ戦略",
      "confidence": 3
    }
  ],
  "supply_chain_summary": "サプライチェーン全体所感"
}""")


async def run_consumer_insight(products_data: dict, all_evaluations: dict, skills: list[dict],
                                timeline: DiscussionTimeline, token_tracker: Optional[TokenTracker] = None) -> dict:
    """Phase 3: 消費者インサイト（Phase 2結果も参照）"""
    persona = AGENT_PERSONAS["consumer_insight"]
    timeline.add("consumer_insight", "start", "消費者インサイト分析を開始")

    user_prompt = f"""以下の商品リストと各エージェントの評価を踏まえ、消費者視点での需要検証を行ってください。

【商品データ】
{json.dumps(products_data, ensure_ascii=False, indent=2)}

【各エージェントの評価サマリー】
{json.dumps(all_evaluations, ensure_ascii=False, indent=2)}

出力形式:
{{
  "insights": [
    {{
      "product_name": "商品名",
      "demand_validation": "需要は本物か？（根拠を示す）",
      "overseas_sentiment": "海外での評判サマリー",
      "japan_fit_score": 7,
      "pain_point_match": "課題とのマッチ度",
      "cultural_barriers": "文化的障壁",
      "word_of_mouth_potential": "低/中/高",
      "seasonal_factor": "季節性の有無",
      "repeat_purchase_likelihood": "低/中/高",
      "confidence": 3
    }}
  ],
  "consumer_summary": "消費者視点の全体所感"
}}"""

    result_text = await _call_llm(persona["system_prompt"], user_prompt,
                                      agent_id="consumer_insight", agent_name=persona["name"],
                                      phase=3, token_tracker=token_tracker)
    try:
        result = json.loads(result_text)
    except json.JSONDecodeError:
        result = {"raw_text": result_text, "error": "JSON parse failed"}

    timeline.add("consumer_insight", "result", "消費者インサイト分析完了")
    return result


async def run_trend_analyst(products_data: dict, all_evaluations: dict, skills: list[dict],
                             timeline: DiscussionTimeline, token_tracker: Optional[TokenTracker] = None) -> dict:
    """Phase 3: トレンド分析（Phase 2結果も参照）"""
    persona = AGENT_PERSONAS["trend_analyst"]
    timeline.add("trend_analyst", "start", "トレンド分析を開始")

    user_prompt = f"""以下の商品リストと各エージェントの評価を踏まえ、トレンドの持続性を分析してください。

【商品データ】
{json.dumps(products_data, ensure_ascii=False, indent=2)}

【各エージェントの評価サマリー】
{json.dumps(all_evaluations, ensure_ascii=False, indent=2)}

出力形式:
{{
  "trend_analyses": [
    {{
      "product_name": "商品名",
      "trend_type": "一過性バズ/成長初期/成熟期/衰退期",
      "trend_lifecycle_months": 24,
      "underlying_drivers": "根本要因",
      "similar_precedents": "類似の過去事例",
      "japan_trend_lag": "日本への波及タイムラグ",
      "market_growth_forecast": "市場成長率予測",
      "disruption_risk": "ディスラプションリスク",
      "timing_verdict": "今すぐ/6ヶ月以内/様子見/見送り",
      "confidence": 3
    }}
  ],
  "macro_trend_summary": "マクロトレンド所感"
}}"""

    result_text = await _call_llm(persona["system_prompt"], user_prompt,
                                      agent_id="trend_analyst", agent_name=persona["name"],
                                      phase=3, token_tracker=token_tracker)
    try:
        result = json.loads(result_text)
    except json.JSONDecodeError:
        result = {"raw_text": result_text, "error": "JSON parse failed"}

    timeline.add("trend_analyst", "result", "トレンド分析完了")
    return result


async def run_meta_cognition(all_results: dict, timeline: DiscussionTimeline, token_tracker: Optional[TokenTracker] = None) -> dict:
    """Phase 4: メタ認知AI（全エージェントの出力を検証）"""
    persona = AGENT_PERSONAS["meta_cognition"]
    timeline.add("meta_cognition", "start", "議論品質の検証を開始（Anti-Satisficing）")

    user_prompt = f"""以下の全エージェントの出力を横断的にチェックし、盲点・バイアス・矛盾を検出してください。

【全エージェントの出力】
{json.dumps(all_results, ensure_ascii=False, indent=2)}

出力形式:
{{
  "quality_assessment": {{
    "quality_score": 7,
    "blind_spots": ["見落とし1", "見落とし2"],
    "biases_detected": [
      {{"type": "バイアスの種類", "agent": "該当エージェント", "detail": "具体的内容"}}
    ],
    "contradictions": [
      {{"agents": ["agent1", "agent2"], "topic": "矛盾のテーマ", "detail": "具体的内容"}}
    ],
    "low_confidence_warnings": ["確信度が低い領域の警告"],
    "missing_data": ["不足しているデータ"],
    "over_optimistic_claims": ["楽観的すぎる主張"]
  }},
  "per_product_verdict": [
    {{
      "product_name": "商品名",
      "go_nogo": "GO/CONDITIONAL/NOGO",
      "confidence": 3,
      "key_concern": "最大の懸念",
      "required_validation": "Go前に検証すべきこと"
    }}
  ],
  "improvement_suggestions": ["議論改善提案1", "議論改善提案2"]
}}"""

    result_text = await _call_llm(persona["system_prompt"], user_prompt,
                                      agent_id="meta_cognition", agent_name=persona["name"],
                                      phase=4, token_tracker=token_tracker)
    try:
        result = json.loads(result_text)
    except json.JSONDecodeError:
        result = {"raw_text": result_text, "error": "JSON parse failed"}

    timeline.add("meta_cognition", "result", "議論品質の検証完了")

    # チャレンジ（指摘事項）をタイムラインに追加
    qa = result.get("quality_assessment", {})
    for bs in qa.get("blind_spots", []):
        timeline.add("meta_cognition", "challenge", f"盲点の指摘: {bs}")
    for contradiction in qa.get("contradictions", []):
        timeline.add("meta_cognition", "challenge",
                      f"矛盾を検出: {contradiction.get('detail', '')}")

    return result


async def run_secretary(all_results: dict, meta_result: dict, timeline: DiscussionTimeline, token_tracker: Optional[TokenTracker] = None) -> dict:
    """Phase 5: 議事録AI（全結果を要約 + Skill抽出）"""
    persona = AGENT_PERSONAS["secretary"]
    timeline.add("secretary", "start", "議事録の作成とSkill抽出を開始")

    user_prompt = f"""以下の全エージェントの議論内容を中立的に議事録としてまとめ、
さらに今回の議論から得られたSkill（学び）を抽出してください。

【各エージェントの報告】
{json.dumps(all_results, ensure_ascii=False, indent=2)}

【メタ認知AIの検証結果】
{json.dumps(meta_result, ensure_ascii=False, indent=2)}

以下のJSON形式で出力:
{{
  "executive_summary": "エグゼクティブサマリー（3行以内）",
  "products_discussed": ["商品名1", "商品名2"],
  "per_product_summary": [
    {{
      "product_name": "商品名",
      "searcher_highlight": "サーチャーの主要ポイント",
      "pl_highlight": "PL評価者の主要ポイント",
      "marketer_highlight": "マーケターの主要ポイント",
      "legal_highlight": "法務チェッカーの主要ポイント",
      "supply_chain_highlight": "サプライチェーンAIの主要ポイント",
      "consumer_highlight": "消費者インサイトの主要ポイント",
      "trend_highlight": "トレンドアナリストの主要ポイント",
      "meta_verdict": "メタ認知AIの判定（GO/CONDITIONAL/NOGO）",
      "consensus": "合意点",
      "disagreements": "意見の相違点",
      "risk_consensus": "リスクに関する合意",
      "final_recommendation": "最終推奨（最優先/要検討/保留/見送り）"
    }}
  ],
  "recommended_actions": [
    {{
      "priority": "最優先/要検討/保留",
      "product_name": "商品名",
      "action": "具体的なアクション",
      "owner": "担当すべき役割",
      "deadline_suggestion": "推奨期限",
      "reason": "理由"
    }}
  ],
  "next_research_topics": ["次回テーマ1", "次回テーマ2"],
  "learned_skills": [
    {{
      "skill_type": "market_insight/regulation/pricing/logistics/consumer/trend",
      "description": "学びの内容（汎用的・再利用可能な形で）",
      "applicable_categories": ["適用カテゴリ1", "適用カテゴリ2"],
      "source_product": "情報源の商品名"
    }}
  ],
  "discussion_quality_note": "メタ認知AIの指摘を踏まえた議論品質の総括"
}}"""

    result_text = await _call_llm(persona["system_prompt"], user_prompt,
                                      agent_id="secretary", agent_name=persona["name"],
                                      phase=5, token_tracker=token_tracker)
    try:
        result = json.loads(result_text)
    except json.JSONDecodeError:
        result = {"raw_text": result_text, "error": "JSON parse failed"}

    # Skill抽出をタイムラインに記録
    for skill in result.get("learned_skills", []):
        timeline.add("secretary", "skill", f"Skill蓄積: {skill.get('description', '')}")

    timeline.add("secretary", "result", "議事録作成完了")
    return result


# ══════════════════════════════════════════════════════════════
# セッション管理 & フルパイプライン
# ══════════════════════════════════════════════════════════════

_research_sessions: dict[str, dict] = {}
_session_lock = threading.Lock()


def create_session(category: str = "", keyword: str = "") -> str:
    session_id = str(uuid.uuid4())[:8]
    with _session_lock:
        _research_sessions[session_id] = {
            "session_id": session_id,
            "created_at": time.strftime("%Y-%m-%dT%H:%M:%S"),
            "category": category,
            "keyword": keyword,
            "status": "pending",
            "progress": 0,
            "message": "セッション作成完了",
            "agent_results": {},
            "minutes": None,
            "timeline": [],
            "token_usage": {},
        }
    return session_id


def get_session(session_id: str) -> Optional[dict]:
    with _session_lock:
        session = _research_sessions.get(session_id)
        if not session:
            return None
        # 内部オブジェクトをシリアライズ可能な形に変換
        result = dict(session)
        if isinstance(result.get("_timeline_obj"), DiscussionTimeline):
            result["timeline"] = result["_timeline_obj"].to_list()
        if isinstance(result.get("_token_tracker"), TokenTracker):
            result["token_usage"] = result["_token_tracker"].get_summary()
        result.pop("_timeline_obj", None)
        result.pop("_token_tracker", None)
        return result


def get_all_sessions() -> list[dict]:
    with _session_lock:
        sessions = []
        for s in _research_sessions.values():
            summary = {
                "session_id": s["session_id"],
                "created_at": s["created_at"],
                "category": s["category"],
                "keyword": s["keyword"],
                "status": s["status"],
                "progress": s["progress"],
                "message": s["message"],
            }
            sessions.append(summary)
        return sorted(sessions, key=lambda x: x["created_at"], reverse=True)


async def run_full_research(session_id: str):
    """フルリサーチパイプライン（5フェーズ）"""
    with _session_lock:
        session = _research_sessions.get(session_id)
        if not session:
            return

    timeline = DiscussionTimeline()
    token_tracker = TokenTracker()
    session["_timeline_obj"] = timeline
    session["_token_tracker"] = token_tracker

    try:
        # ── 過去Skillの読み込み ──
        skills = await load_skills(session["category"])
        if skills:
            timeline.add("system", "start", f"過去のSkill {len(skills)}件を読み込み済み")

        # ── Phase 1: サーチャーが商品調査 ──
        session["status"] = "searching"
        session["progress"] = 5
        session["message"] = "Phase 1/5: サーチャーが海外商品を調査中..."
        session["timeline"] = timeline.to_list()

        searcher_result = await run_searcher(session["category"], session["keyword"], skills, timeline, token_tracker)
        session["agent_results"]["searcher"] = searcher_result
        session["progress"] = 15
        session["timeline"] = timeline.to_list()
        session["token_usage"] = token_tracker.get_summary()

        # ── Phase 2: 4エージェントが並列評価 ──
        session["status"] = "evaluating"
        session["progress"] = 20
        session["message"] = "Phase 2/5: PL・マーケ・法務・物流が並列分析中..."
        session["timeline"] = timeline.to_list()

        pl_result, marketer_result, legal_result, sc_result = await asyncio.gather(
            run_pl_evaluator(searcher_result, skills, timeline, token_tracker),
            run_marketer(searcher_result, skills, timeline, token_tracker),
            run_legal_checker(searcher_result, skills, timeline, token_tracker),
            run_supply_chain(searcher_result, skills, timeline, token_tracker),
        )
        session["agent_results"]["pl_evaluator"] = pl_result
        session["agent_results"]["marketer"] = marketer_result
        session["agent_results"]["legal_checker"] = legal_result
        session["agent_results"]["supply_chain"] = sc_result
        session["progress"] = 50
        session["timeline"] = timeline.to_list()
        session["token_usage"] = token_tracker.get_summary()

        # ── Phase 3: 消費者インサイト + トレンド分析（並列） ──
        session["status"] = "deep_analysis"
        session["progress"] = 55
        session["message"] = "Phase 3/5: 消費者インサイトとトレンド分析中..."
        session["timeline"] = timeline.to_list()

        phase2_summary = {
            "pl": pl_result,
            "marketer": marketer_result,
            "legal": legal_result,
            "supply_chain": sc_result,
        }
        consumer_result, trend_result = await asyncio.gather(
            run_consumer_insight(searcher_result, phase2_summary, skills, timeline, token_tracker),
            run_trend_analyst(searcher_result, phase2_summary, skills, timeline, token_tracker),
        )
        session["agent_results"]["consumer_insight"] = consumer_result
        session["agent_results"]["trend_analyst"] = trend_result
        session["progress"] = 70
        session["timeline"] = timeline.to_list()
        session["token_usage"] = token_tracker.get_summary()

        # ── Phase 4: メタ認知AI（全結果を検証） ──
        session["status"] = "verifying"
        session["progress"] = 75
        session["message"] = "Phase 4/5: メタ認知AIが議論品質を検証中（Anti-Satisficing）..."
        session["timeline"] = timeline.to_list()

        all_results = session["agent_results"]
        meta_result = await run_meta_cognition(all_results, timeline, token_tracker)
        session["agent_results"]["meta_cognition"] = meta_result
        session["progress"] = 85
        session["timeline"] = timeline.to_list()
        session["token_usage"] = token_tracker.get_summary()

        # ── Phase 5: 議事録AI（要約 + Skill抽出） ──
        session["status"] = "summarizing"
        session["progress"] = 88
        session["message"] = "Phase 5/5: 議事録AIが要約とSkill抽出中..."
        session["timeline"] = timeline.to_list()

        minutes = await run_secretary(all_results, meta_result, timeline, token_tracker)
        session["minutes"] = minutes
        session["progress"] = 95
        session["timeline"] = timeline.to_list()
        session["token_usage"] = token_tracker.get_summary()

        # ── Skill保存 & 判断ログ保存 ──
        learned_skills = minutes.get("learned_skills", [])
        await save_skills(session_id, learned_skills)

        for product_summary in minutes.get("per_product_summary", []):
            await save_decision_log(
                session_id,
                product_summary.get("product_name", ""),
                product_summary.get("final_recommendation", ""),
                product_summary,
            )

        session["progress"] = 100
        session["status"] = "done"
        session["message"] = "リサーチ完了（9エージェント × 5フェーズ）"
        session["timeline"] = timeline.to_list()
        session["token_usage"] = token_tracker.get_summary()

    except Exception as e:
        session["status"] = "error"
        session["message"] = f"エラー: {str(e)}"
        session["timeline"] = timeline.to_list()
        session["token_usage"] = token_tracker.get_summary()


# ══════════════════════════════════════════════════════════════
# Supabase保存・読み込み（セッション永続化）
# ══════════════════════════════════════════════════════════════

async def save_session_to_supabase(session_id: str):
    """完了したセッションをSupabaseに永続化"""
    sb = _get_supabase()
    if not sb:
        return
    session = get_session(session_id)
    if not session:
        return
    try:
        row = {
            "session_id": session_id,
            "created_at": session["created_at"],
            "category": session["category"],
            "keyword": session["keyword"],
            "status": session["status"],
            "data": json.dumps(session, ensure_ascii=False, default=str),
        }
        await asyncio.to_thread(
            lambda: sb.table("research_sessions").upsert(row, on_conflict="session_id").execute()
        )
    except Exception:
        pass


async def load_sessions_from_supabase() -> list[dict]:
    """Supabaseから過去セッションを読み込む"""
    sb = _get_supabase()
    if not sb:
        return []
    try:
        result = await asyncio.to_thread(
            lambda: sb.table("research_sessions").select("*").order("created_at", desc=True).limit(50).execute()
        )
        sessions = []
        for row in result.data or []:
            try:
                data = json.loads(row["data"]) if isinstance(row["data"], str) else row["data"]
                sessions.append(data)
            except (json.JSONDecodeError, KeyError):
                pass
        return sessions
    except Exception:
        return []


# ══════════════════════════════════════════════════════════════
# ケーススタディ分析モード（成功事例の要因分析）
# ══════════════════════════════════════════════════════════════

# 議事録ファイル出力先
MINUTES_OUTPUT_DIR = Path(os.environ.get("DATA_DIR", "/tmp/lp_data")) / "minutes"
MINUTES_OUTPUT_DIR.mkdir(parents=True, exist_ok=True)


def _write_minutes_file(session_id: str, content: str, append: bool = True):
    """議事録をローカルファイルに出力（Google Docs未設定時のフォールバック）"""
    filepath = MINUTES_OUTPUT_DIR / f"minutes_{session_id}.md"
    mode = "a" if append else "w"
    with open(filepath, mode, encoding="utf-8") as f:
        f.write(content)
    return str(filepath)


def _format_minutes_header(session_id: str, topic: str) -> str:
    """議事録のヘッダーを生成"""
    now = time.strftime("%Y年%m月%d日 %H:%M:%S")
    return f"""# 📋 ケーススタディ議事録
**議題:** {topic}
**セッションID:** {session_id}
**開始日時:** {now}
**参加エージェント:** ハンター / ソロバン / バズ美 / ガードン / シッパー / ヒトミ / ミライ / ツッコミ / まとめ / キロク

---

"""


def _format_agent_entry(nickname: str, icon: str, phase: str, content: str) -> str:
    """エージェント発言を議事録フォーマットに変換"""
    now = time.strftime("%H:%M:%S")
    return f"""
## {icon} {nickname}（{phase}）[{now}]

{content}

---
"""


async def run_case_study_analysis(session_id: str):
    """ケーススタディ分析パイプライン: 成功事例を全エージェントが議論する"""
    with _session_lock:
        session = _research_sessions.get(session_id)
        if not session:
            return

    timeline = DiscussionTimeline()
    token_tracker = TokenTracker()
    session["_timeline_obj"] = timeline
    session["_token_tracker"] = token_tracker

    topic = session.get("keyword", "")
    category = session.get("category", "")

    # 議事録ファイルのヘッダーを書き込み
    minutes_path = _write_minutes_file(
        session_id,
        _format_minutes_header(session_id, topic),
        append=False,
    )
    session["minutes_file"] = minutes_path

    try:
        # ── Phase 1: ハンター（リサーチャー）── 事例調査 ──
        session["status"] = "searching"
        session["progress"] = 5
        session["message"] = "Phase 1: ハンターが事例調査中..."
        session["timeline"] = timeline.to_list()
        timeline.add("searcher", "start", f"ケーススタディ「{topic}」の調査を開始")

        searcher_prompt = f"""以下の成功事例について徹底的にリサーチしてください。

【分析対象】{topic}
【カテゴリ】{category}

【調査項目】
1. 商品の概要（どこの国の商品か、何がユニークか）
2. 海外での展開状況（どの国でいつから販売、売上規模）
3. 日本上陸の経緯（いつ、どのように日本市場に参入したか）
4. 日本での販売チャネルと戦略
5. 類似商品・競合（日本市場に既にあった類似商品）
6. 成功を示すデータ（売上、店舗数、受賞歴等）

以下のJSON形式で出力:
{{
  "product_name": "商品名",
  "brand": "ブランド名",
  "origin_country": "発祥国",
  "overview": "商品概要",
  "overseas_history": "海外展開の経緯",
  "japan_entry": "日本参入の経緯と時期",
  "japan_channels": "日本での販売チャネル",
  "success_metrics": "成功を示す数字・データ",
  "competitors": ["競合商品1", "競合商品2"],
  "unique_factors": ["ユニークな点1", "ユニークな点2"],
  "market_trends": "関連する市場トレンド"
}}"""

        searcher_result = await _call_llm(
            AGENT_PERSONAS["searcher"]["system_prompt"], searcher_prompt,
            agent_id="searcher", agent_name="ハンター", phase=1,
            token_tracker=token_tracker,
        )
        try:
            searcher_data = json.loads(searcher_result)
        except json.JSONDecodeError:
            searcher_data = {"raw_text": searcher_result}

        session["agent_results"]["searcher"] = searcher_data
        timeline.add("searcher", "result", "事例調査完了")
        session["progress"] = 12
        session["timeline"] = timeline.to_list()
        session["token_usage"] = token_tracker.get_summary()

        # 議事録に追記
        _write_minutes_file(session_id, _format_agent_entry(
            "ハンター", "🔍", "Phase 1 - 事例調査",
            json.dumps(searcher_data, ensure_ascii=False, indent=2),
        ))

        # ── Phase 2: 4エージェント並列分析 ──
        session["status"] = "evaluating"
        session["progress"] = 15
        session["message"] = "Phase 2: ソロバン・バズ美・ガードン・シッパーが並列分析中..."
        session["timeline"] = timeline.to_list()

        case_data_str = json.dumps(searcher_data, ensure_ascii=False, indent=2)

        # ソロバン（PL評価）
        pl_prompt = f"""以下の成功事例について、PL（収益性）の観点から成功要因を分析してください。

【事例データ】
{case_data_str}

【分析項目】
1. なぜ利益が出る構造になっているのか（粗利構造、価格戦略）
2. 初期投資とスケール戦略
3. 競合との価格差と価値提案
4. 日本市場での収益モデルの巧みさ
5. 我々（株式会社はこ）が同じカテゴリで代理店事業を行う場合の参考ポイント

JSON形式で出力:
{{
  "profitability_analysis": "収益構造の分析",
  "pricing_strategy": "価格戦略がなぜ成功したか",
  "investment_strategy": "初期投資とスケール戦略の分析",
  "competitive_advantage": "競合に対する優位性",
  "business_model_insight": "ビジネスモデルの巧みさ",
  "lessons_for_hako": "株式会社はこへの示唆",
  "confidence": 4
}}"""

        # バズ美（マーケティング分析）
        mkt_prompt = f"""以下の成功事例について、マーケティング戦略の観点から成功要因を分析してください。

【事例データ】
{case_data_str}

【分析項目】
1. ブランディング戦略（なぜ消費者の心を掴んだか）
2. プロモーション施策（広告、SNS、インフルエンサー等）
3. ターゲティングの妙（誰に刺さったか、なぜ）
4. 販売チャネル戦略（EC vs 実店舗、モール vs 自社）
5. 記事LP・DRM的な観点での成功ポイント（はこの得意領域との親和性）

JSON形式で出力:
{{
  "branding_analysis": "ブランディング成功の要因",
  "promotion_strategy": "プロモーション施策の分析",
  "targeting_insight": "ターゲティングの妙",
  "channel_strategy": "販売チャネル戦略の分析",
  "drm_compatibility": "記事LP・DRM施策との親和性",
  "viral_factors": "口コミ・バイラル要因",
  "lessons_for_hako": "株式会社はこへの示唆",
  "confidence": 4
}}"""

        # ガードン（法務・規制分析）
        legal_prompt = f"""以下の成功事例について、法務・規制面からの成功要因を分析してください。

【事例データ】
{case_data_str}

【分析項目】
1. 輸入・販売にあたりどのような規制をクリアしたか
2. 認証・届出で巧みだった点
3. 日本の法規制とどう折り合いをつけたか
4. 表示義務・安全基準の対応
5. 同カテゴリで新規参入する場合の法的ハードル

JSON形式で出力:
{{
  "regulatory_clearance": "クリアした規制の分析",
  "certification_strategy": "認証取得の戦略",
  "compliance_approach": "コンプライアンス対応の分析",
  "labeling_strategy": "表示義務への対応",
  "entry_barriers": "新規参入時の法的ハードル",
  "lessons_for_hako": "株式会社はこへの示唆",
  "confidence": 3
}}"""

        # シッパー（物流・調達分析）
        sc_prompt = f"""以下の成功事例について、サプライチェーン・物流の観点から成功要因を分析してください。

【事例データ】
{case_data_str}

【分析項目】
1. 調達・製造戦略（どこでどう作っているか）
2. 輸送・通関の工夫
3. 在庫管理・倉庫戦略
4. フルフィルメント戦略（自社 vs FBA vs 3PL）
5. スケールアップ時の物流最適化

JSON形式で出力:
{{
  "sourcing_analysis": "調達・製造戦略の分析",
  "logistics_strategy": "輸送・通関の工夫",
  "inventory_management": "在庫管理戦略",
  "fulfillment_approach": "フルフィルメント戦略",
  "scale_logistics": "スケール時の物流戦略",
  "lessons_for_hako": "株式会社はこへの示唆",
  "confidence": 3
}}"""

        timeline.add("pl_evaluator", "start", "ソロバンがPL分析を開始")
        timeline.add("marketer", "start", "バズ美がマーケティング分析を開始")
        timeline.add("legal_checker", "start", "ガードンが法務分析を開始")
        timeline.add("supply_chain", "start", "シッパーが物流分析を開始")

        pl_task = _call_llm(
            AGENT_PERSONAS["pl_evaluator"]["system_prompt"], pl_prompt,
            agent_id="pl_evaluator", agent_name="ソロバン", phase=2,
            token_tracker=token_tracker,
        )
        mkt_task = _call_llm(
            AGENT_PERSONAS["marketer"]["system_prompt"], mkt_prompt,
            agent_id="marketer", agent_name="バズ美", phase=2,
            token_tracker=token_tracker,
        )
        legal_task = _call_llm(
            AGENT_PERSONAS["legal_checker"]["system_prompt"], legal_prompt,
            agent_id="legal_checker", agent_name="ガードン", phase=2,
            token_tracker=token_tracker,
        )
        sc_task = _call_llm(
            AGENT_PERSONAS["supply_chain"]["system_prompt"], sc_prompt,
            agent_id="supply_chain", agent_name="シッパー", phase=2,
            token_tracker=token_tracker,
        )

        pl_raw, mkt_raw, legal_raw, sc_raw = await asyncio.gather(
            pl_task, mkt_task, legal_task, sc_task,
        )

        def _safe_json(raw: str) -> dict:
            try:
                return json.loads(raw)
            except json.JSONDecodeError:
                return {"raw_text": raw}

        pl_data = _safe_json(pl_raw)
        mkt_data = _safe_json(mkt_raw)
        legal_data = _safe_json(legal_raw)
        sc_data = _safe_json(sc_raw)

        session["agent_results"]["pl_evaluator"] = pl_data
        session["agent_results"]["marketer"] = mkt_data
        session["agent_results"]["legal_checker"] = legal_data
        session["agent_results"]["supply_chain"] = sc_data

        timeline.add("pl_evaluator", "result", "ソロバンのPL分析完了")
        timeline.add("marketer", "result", "バズ美のマーケティング分析完了")
        timeline.add("legal_checker", "result", "ガードンの法務分析完了")
        timeline.add("supply_chain", "result", "シッパーの物流分析完了")

        session["progress"] = 45
        session["timeline"] = timeline.to_list()
        session["token_usage"] = token_tracker.get_summary()

        # 議事録に4エージェント分を追記
        _write_minutes_file(session_id, _format_agent_entry(
            "ソロバン", "📊", "Phase 2 - PL・収益性分析",
            json.dumps(pl_data, ensure_ascii=False, indent=2),
        ))
        _write_minutes_file(session_id, _format_agent_entry(
            "バズ美", "📣", "Phase 2 - マーケティング分析",
            json.dumps(mkt_data, ensure_ascii=False, indent=2),
        ))
        _write_minutes_file(session_id, _format_agent_entry(
            "ガードン", "⚖️", "Phase 2 - 法務・規制分析",
            json.dumps(legal_data, ensure_ascii=False, indent=2),
        ))
        _write_minutes_file(session_id, _format_agent_entry(
            "シッパー", "🚢", "Phase 2 - 物流・サプライチェーン分析",
            json.dumps(sc_data, ensure_ascii=False, indent=2),
        ))

        # ── Phase 3: ヒトミ・ミライ（消費者インサイト＋トレンド）──
        session["status"] = "deep_analysis"
        session["progress"] = 50
        session["message"] = "Phase 3: ヒトミ・ミライが深堀り分析中..."
        session["timeline"] = timeline.to_list()

        phase2_summary = json.dumps({
            "pl": pl_data, "marketer": mkt_data,
            "legal": legal_data, "supply_chain": sc_data,
        }, ensure_ascii=False, indent=2)

        consumer_prompt = f"""以下の成功事例と各エージェントの分析を踏まえ、消費者視点から成功要因を深堀りしてください。

【事例データ】
{case_data_str}

【各エージェントの分析】
{phase2_summary}

【分析項目】
1. 消費者のどんなペインポイントを解決したか
2. 購買決定の心理的トリガー（なぜ買おうと思うか）
3. リピート購入・LTV（長期的な顧客価値）の要因
4. 口コミ・レビューの特徴（何が語られるか）
5. 日本の消費者特有の受容ポイント
6. 類似商品との比較で何が決定打だったか

JSON形式で出力:
{{
  "pain_point_solved": "解決したペインポイント",
  "purchase_triggers": "購買決定の心理トリガー",
  "ltv_factors": "リピート・LTVの要因",
  "review_patterns": "口コミ・レビューの特徴",
  "japan_consumer_fit": "日本消費者への適合ポイント",
  "decisive_differentiator": "競合との決定的な差別化要因",
  "lessons_for_hako": "株式会社はこへの示唆",
  "confidence": 4
}}"""

        trend_prompt = f"""以下の成功事例と各エージェントの分析を踏まえ、トレンド・タイミングの観点から成功要因を分析してください。

【事例データ】
{case_data_str}

【各エージェントの分析】
{phase2_summary}

【分析項目】
1. 参入タイミングはなぜ正しかったか（早すぎず遅すぎず）
2. どんなマクロトレンドに乗ったか
3. 一過性ではなく持続している理由
4. 市場の成熟度と今後の見通し
5. 同じトレンドに乗れる次の商品カテゴリは何か
6. 類似の成功パターンを持つ他の事例

JSON形式で出力:
{{
  "timing_analysis": "参入タイミングの分析",
  "macro_trends": "乗ったマクロトレンド",
  "sustainability_factors": "持続している理由",
  "market_outlook": "市場の今後の見通し",
  "next_opportunities": "同トレンドで狙える次のカテゴリ",
  "similar_success_cases": "類似の成功パターン事例",
  "lessons_for_hako": "株式会社はこへの示唆",
  "confidence": 4
}}"""

        timeline.add("consumer_insight", "start", "ヒトミが消費者インサイト分析を開始")
        timeline.add("trend_analyst", "start", "ミライがトレンド分析を開始")

        consumer_raw, trend_raw = await asyncio.gather(
            _call_llm(
                AGENT_PERSONAS["consumer_insight"]["system_prompt"], consumer_prompt,
                agent_id="consumer_insight", agent_name="ヒトミ", phase=3,
                token_tracker=token_tracker,
            ),
            _call_llm(
                AGENT_PERSONAS["trend_analyst"]["system_prompt"], trend_prompt,
                agent_id="trend_analyst", agent_name="ミライ", phase=3,
                token_tracker=token_tracker,
            ),
        )

        consumer_data = _safe_json(consumer_raw)
        trend_data = _safe_json(trend_raw)
        session["agent_results"]["consumer_insight"] = consumer_data
        session["agent_results"]["trend_analyst"] = trend_data

        timeline.add("consumer_insight", "result", "ヒトミの消費者インサイト分析完了")
        timeline.add("trend_analyst", "result", "ミライのトレンド分析完了")
        session["progress"] = 65
        session["timeline"] = timeline.to_list()
        session["token_usage"] = token_tracker.get_summary()

        _write_minutes_file(session_id, _format_agent_entry(
            "ヒトミ", "👤", "Phase 3 - 消費者インサイト分析",
            json.dumps(consumer_data, ensure_ascii=False, indent=2),
        ))
        _write_minutes_file(session_id, _format_agent_entry(
            "ミライ", "📈", "Phase 3 - トレンド・タイミング分析",
            json.dumps(trend_data, ensure_ascii=False, indent=2),
        ))

        # ── Phase 4: ツッコミ（メタ認知）── 全体検証 ──
        session["status"] = "verifying"
        session["progress"] = 70
        session["message"] = "Phase 4: ツッコミが議論品質を検証中（Anti-Satisficing）..."
        session["timeline"] = timeline.to_list()
        timeline.add("meta_cognition", "start", "ツッコミが議論品質を検証中（Anti-Satisficing）")

        all_results = session["agent_results"]
        all_results_str = json.dumps(all_results, ensure_ascii=False, indent=2)

        meta_prompt = f"""以下の全エージェントのケーススタディ分析を横断的にチェックし、
盲点・バイアス・矛盾を検出してください。また「成功した」という前提に引きずられていないか厳しく検証してください。

【議題】{topic}の成功要因分析

【全エージェントの分析結果】
{all_results_str}

【検証項目】
1. 「後知恵バイアス」に陥っていないか（成功したから正しかったと言っているだけではないか）
2. 見落としている失敗リスクや偶然の要素はないか
3. エージェント間で矛盾する分析はないか
4. 楽観的すぎる評価はないか
5. 「はこへの示唆」が現実的かどうか
6. 本当の成功要因は何か（エージェントの分析を統合した見解）

JSON形式で出力:
{{
  "hindsight_bias_check": "後知恵バイアスの検証結果",
  "overlooked_factors": ["見落とされた要素1", "見落とされた要素2"],
  "contradictions": ["矛盾点1", "矛盾点2"],
  "over_optimistic_claims": ["楽観的すぎる主張1"],
  "hako_feasibility_check": "はこへの示唆の現実性チェック",
  "true_success_factors": "本当の成功要因（統合見解）",
  "quality_score": 7,
  "improvement_suggestions": ["改善提案1", "改善提案2"]
}}"""

        meta_raw = await _call_llm(
            AGENT_PERSONAS["meta_cognition"]["system_prompt"], meta_prompt,
            agent_id="meta_cognition", agent_name="ツッコミ", phase=4,
            token_tracker=token_tracker,
        )
        meta_data = _safe_json(meta_raw)
        session["agent_results"]["meta_cognition"] = meta_data

        timeline.add("meta_cognition", "result", "ツッコミの検証完了")
        for item in meta_data.get("overlooked_factors", []):
            timeline.add("meta_cognition", "challenge", f"見落とし指摘: {item}")
        for item in meta_data.get("contradictions", []):
            timeline.add("meta_cognition", "challenge", f"矛盾指摘: {item}")

        session["progress"] = 82
        session["timeline"] = timeline.to_list()
        session["token_usage"] = token_tracker.get_summary()

        _write_minutes_file(session_id, _format_agent_entry(
            "ツッコミ", "🧠", "Phase 4 - 議論品質検証（Anti-Satisficing）",
            json.dumps(meta_data, ensure_ascii=False, indent=2),
        ))

        # ── Phase 5: まとめ（議事録AI）── 最終統合 ──
        session["status"] = "summarizing"
        session["progress"] = 85
        session["message"] = "Phase 5: まとめが最終議事録とSkill抽出中..."
        session["timeline"] = timeline.to_list()
        timeline.add("secretary", "start", "まとめが最終議事録を作成中")

        secretary_prompt = f"""以下の全エージェントのケーススタディ議論を中立的に議事録としてまとめ、
さらに今回の議論から得られたSkill（今後の代理店ビジネスに活かせる学び）を抽出してください。

【議題】{topic}の成功要因分析

【全エージェントの分析結果】
{all_results_str}

【ツッコミ（メタ認知AI）の検証結果】
{json.dumps(meta_data, ensure_ascii=False, indent=2)}

以下のJSON形式で出力:
{{
  "executive_summary": "エグゼクティブサマリー（3行以内で成功の核心を要約）",
  "success_factors_ranking": [
    {{"rank": 1, "factor": "最大の成功要因", "detail": "具体的な説明", "agents_who_pointed_out": ["ソロバン", "バズ美"]}},
    {{"rank": 2, "factor": "2番目の成功要因", "detail": "具体的な説明", "agents_who_pointed_out": ["ヒトミ"]}}
  ],
  "per_agent_highlight": {{
    "ハンター": "事例調査の主要ポイント",
    "ソロバン": "PL分析の主要ポイント",
    "バズ美": "マーケティング分析の主要ポイント",
    "ガードン": "法務分析の主要ポイント",
    "シッパー": "物流分析の主要ポイント",
    "ヒトミ": "消費者インサイトの主要ポイント",
    "ミライ": "トレンド分析の主要ポイント",
    "ツッコミ": "メタ認知検証の主要ポイント"
  }},
  "hako_action_items": [
    {{"priority": "最優先", "action": "具体的なアクション", "reason": "理由", "related_agents": ["ソロバン", "バズ美"]}}
  ],
  "next_research_topics": ["次に調査すべきテーマ1", "次に調査すべきテーマ2"],
  "learned_skills": [
    {{
      "skill_type": "market_insight",
      "description": "学びの内容（汎用的な形で）",
      "applicable_categories": ["適用カテゴリ1"],
      "source_product": "{topic}"
    }}
  ],
  "discussion_quality_note": "ツッコミの指摘を踏まえた議論品質の総括"
}}"""

        secretary_raw = await _call_llm(
            AGENT_PERSONAS["secretary"]["system_prompt"], secretary_prompt,
            agent_id="secretary", agent_name="まとめ", phase=5,
            token_tracker=token_tracker,
        )
        secretary_data = _safe_json(secretary_raw)
        session["minutes"] = secretary_data
        session["agent_results"]["secretary"] = secretary_data

        timeline.add("secretary", "result", "議事録作成完了")
        for skill in secretary_data.get("learned_skills", []):
            timeline.add("secretary", "skill", f"Skill蓄積: {skill.get('description', '')}")

        session["progress"] = 92
        session["timeline"] = timeline.to_list()
        session["token_usage"] = token_tracker.get_summary()

        _write_minutes_file(session_id, _format_agent_entry(
            "まとめ", "📝", "Phase 5 - 最終議事録 & Skill抽出",
            json.dumps(secretary_data, ensure_ascii=False, indent=2),
        ))

        # ── Phase 6: キロク（最終レポート整形） ──
        session["status"] = "reporting"
        session["progress"] = 95
        session["message"] = "Phase 6: キロクが最終レポートを整形中..."
        session["timeline"] = timeline.to_list()
        timeline.add("reporter", "start", "キロクが最終レポートを整形中")

        reporter_prompt = f"""以下のケーススタディ議論の全結果を、ビジネスパーソンが読みやすい最終レポート形式にまとめてください。
各エージェントの発言はあだ名（ハンター/ソロバン/バズ美/ガードン/シッパー/ヒトミ/ミライ/ツッコミ/まとめ）で記載してください。

【議題】{topic}の成功要因分析
【まとめAIの議事録】
{json.dumps(secretary_data, ensure_ascii=False, indent=2)}
【トークン使用量】
{json.dumps(token_tracker.get_summary(), ensure_ascii=False, indent=2)}

以下のJSON形式で出力:
{{
  "report_title": "レポートタイトル",
  "executive_summary": "エグゼクティブサマリー（3行以内）",
  "full_report_markdown": "Markdown形式の完全なレポート本文（見出し付き、全エージェントの発言をあだ名で引用）",
  "action_items_summary": "アクションアイテムのサマリー",
  "token_usage_note": "トークン使用量の要約"
}}"""

        reporter_raw = await _call_llm(
            AGENT_PERSONAS["reporter"]["system_prompt"], reporter_prompt,
            agent_id="reporter", agent_name="キロク", phase=6,
            token_tracker=token_tracker,
        )
        reporter_data = _safe_json(reporter_raw)
        session["agent_results"]["reporter"] = reporter_data

        timeline.add("reporter", "result", "最終レポート完成")
        session["progress"] = 100
        session["status"] = "done"
        session["message"] = "ケーススタディ分析完了（全10エージェント × 6フェーズ）"
        session["timeline"] = timeline.to_list()
        session["token_usage"] = token_tracker.get_summary()

        # 最終レポートを議事録ファイルに追記
        final_report = reporter_data.get("full_report_markdown", json.dumps(reporter_data, ensure_ascii=False, indent=2))
        _write_minutes_file(session_id, _format_agent_entry(
            "キロク", "📄", "Phase 6 - 最終レポート",
            final_report,
        ))
        _write_minutes_file(session_id, f"""
## 📊 トークン使用量

```json
{json.dumps(token_tracker.get_summary(), ensure_ascii=False, indent=2)}
```

---
**議論終了: {time.strftime("%Y年%m月%d日 %H:%M:%S")}**
""")

        # Skill保存
        learned_skills = secretary_data.get("learned_skills", [])
        await save_skills(session_id, learned_skills)

    except Exception as e:
        session["status"] = "error"
        session["message"] = f"エラー: {str(e)}"
        session["timeline"] = timeline.to_list()
        session["token_usage"] = token_tracker.get_summary()
        import traceback
        _write_minutes_file(session_id, f"\n\n## ❌ エラー発生\n\n```\n{traceback.format_exc()}\n```\n")
