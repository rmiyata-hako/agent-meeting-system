-- ══════════════════════════════════════════════════════════════
-- AIエージェント会議システム - Supabase テーブル定義
-- ══════════════════════════════════════════════════════════════
-- 対象: 14エージェント × 6フェーズ パイプラインの全データ永続化
-- 用途: 議事録保管、決定事項追跡、スキル進化、パフォーマンス評価

-- ══ 会議セッション（メインテーブル） ══════════════════════════
CREATE TABLE IF NOT EXISTS meeting_sessions (
    id          BIGSERIAL PRIMARY KEY,
    session_id  TEXT UNIQUE NOT NULL,           -- UUID v4
    topic       TEXT NOT NULL,                  -- 議題
    context     TEXT DEFAULT '',                -- 追加コンテキスト
    verdict     TEXT,                           -- GO / NOGO / CONDITIONAL
    confidence  INT,                            -- 確信度 0-100
    summary     TEXT,                           -- エグゼクティブサマリー
    speech_logs JSONB DEFAULT '[]'::jsonb,      -- 全発言ログ（リプレイ用）
    phase_logs  JSONB DEFAULT '[]'::jsonb,      -- フェーズ遷移ログ
    agent_results JSONB DEFAULT '{}'::jsonb,    -- エージェント別生JSON結果
    hr_feedback JSONB DEFAULT '{}'::jsonb,      -- HRくんのフィードバック全体
    ex_report   JSONB DEFAULT '{}'::jsonb,      -- シャガイトリの構造改善レポート
    created_by  TEXT,                           -- Google OAuth email
    starred     BOOLEAN DEFAULT FALSE,          -- お気に入り
    tags        TEXT[] DEFAULT '{}',            -- タグ
    status      TEXT DEFAULT 'running',         -- running / completed / error
    duration_ms INT,                            -- 会議所要時間（ミリ秒）
    created_at  TIMESTAMPTZ DEFAULT NOW(),
    updated_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_meeting_sessions_created
    ON meeting_sessions (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_meeting_sessions_verdict
    ON meeting_sessions (verdict);
CREATE INDEX IF NOT EXISTS idx_meeting_sessions_status
    ON meeting_sessions (status);
CREATE INDEX IF NOT EXISTS idx_meeting_sessions_tags
    ON meeting_sessions USING GIN (tags);
CREATE INDEX IF NOT EXISTS idx_meeting_sessions_topic
    ON meeting_sessions USING GIN (to_tsvector('simple', topic));

-- ══ 会議の決定事項 ══════════════════════════════════════════
CREATE TABLE IF NOT EXISTS meeting_decisions (
    id            BIGSERIAL PRIMARY KEY,
    session_id    TEXT NOT NULL REFERENCES meeting_sessions(session_id),
    agent_id      TEXT NOT NULL,                -- エージェントID
    agent_name    TEXT NOT NULL,                -- エージェント表示名
    agent_icon    TEXT,                         -- エージェントアイコン
    decision_text TEXT NOT NULL,                -- 決定内容
    category      TEXT DEFAULT 'general',       -- verdict / action / risk / skill
    created_at    TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_meeting_decisions_session
    ON meeting_decisions (session_id);
CREATE INDEX IF NOT EXISTS idx_meeting_decisions_category
    ON meeting_decisions (category);

-- ══ HRくん評価レコード ══════════════════════════════════════
-- 会議ごとに各エージェントの評価を保存
CREATE TABLE IF NOT EXISTS meeting_hr_reviews (
    id               BIGSERIAL PRIMARY KEY,
    session_id       TEXT NOT NULL REFERENCES meeting_sessions(session_id),
    agent_id         TEXT NOT NULL,
    agent_name       TEXT NOT NULL,
    output_quality   TEXT,                      -- A / B / C / D
    role_fulfillment INT,                       -- 0-100
    collaboration    INT,                       -- 0-100
    strengths        TEXT[] DEFAULT '{}',
    skill_gaps       TEXT[] DEFAULT '{}',
    improvements     TEXT[] DEFAULT '{}',
    new_skills       TEXT[] DEFAULT '{}',
    created_at       TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_hr_reviews_session
    ON meeting_hr_reviews (session_id);
CREATE INDEX IF NOT EXISTS idx_hr_reviews_agent
    ON meeting_hr_reviews (agent_id);

-- ══ エージェントスキルスナップショット ══════════════════════
-- agents.ts のスキル定義が変更されるたびに記録
CREATE TABLE IF NOT EXISTS agent_skill_snapshots (
    id          BIGSERIAL PRIMARY KEY,
    agent_id    TEXT NOT NULL,
    agent_name  TEXT NOT NULL,
    tier        TEXT NOT NULL,                  -- L1 / L2 / L3 / HR / EX
    skills      TEXT[] NOT NULL,
    thinking_fw TEXT,                           -- thinkingFramework
    version     INT DEFAULT 1,
    change_log  TEXT,                           -- 変更理由
    triggered_by TEXT,                          -- session_id（どの会議がきっかけか）
    created_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_skill_snapshots_agent
    ON agent_skill_snapshots (agent_id);
CREATE INDEX IF NOT EXISTS idx_skill_snapshots_created
    ON agent_skill_snapshots (created_at DESC);

-- ══ 会議トークン使用量 ══════════════════════════════════════
-- 会議のコスト追跡（research_token_usage と同構造）
CREATE TABLE IF NOT EXISTS meeting_token_usage (
    id              BIGSERIAL PRIMARY KEY,
    session_id      TEXT NOT NULL REFERENCES meeting_sessions(session_id),
    agent_id        TEXT NOT NULL,
    agent_name      TEXT NOT NULL,
    phase           INT NOT NULL,               -- 1-6
    input_tokens    INT DEFAULT 0,
    output_tokens   INT DEFAULT 0,
    total_tokens    INT DEFAULT 0,
    estimated_cost  REAL DEFAULT 0.0,           -- USD
    llm_provider    TEXT DEFAULT 'gemini',       -- gemini / claude / groq
    llm_model       TEXT,
    latency_ms      INT,                        -- レスポンス時間
    created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_meeting_tokens_session
    ON meeting_token_usage (session_id);
CREATE INDEX IF NOT EXISTS idx_meeting_tokens_agent
    ON meeting_token_usage (agent_id);

-- ══ 更新時刻の自動更新トリガー ══════════════════════════════
CREATE OR REPLACE FUNCTION update_meeting_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS meeting_sessions_updated_at ON meeting_sessions;
CREATE TRIGGER meeting_sessions_updated_at
  BEFORE UPDATE ON meeting_sessions
  FOR EACH ROW EXECUTE FUNCTION update_meeting_updated_at();

-- ══ RLS（本番デプロイ時に有効化） ══════════════════════════
-- service_role key はRLSをバイパスするため、バックエンド経由のみアクセス可能
-- ALTER TABLE meeting_sessions ENABLE ROW LEVEL SECURITY;
-- ALTER TABLE meeting_decisions ENABLE ROW LEVEL SECURITY;
-- ALTER TABLE meeting_hr_reviews ENABLE ROW LEVEL SECURITY;
-- ALTER TABLE agent_skill_snapshots ENABLE ROW LEVEL SECURITY;
-- ALTER TABLE meeting_token_usage ENABLE ROW LEVEL SECURITY;

-- ══ ビュー: 会議サマリー（フロントエンド表示用） ══════════════
CREATE OR REPLACE VIEW meeting_summary_view AS
SELECT
    ms.session_id,
    ms.topic,
    ms.verdict,
    ms.confidence,
    ms.summary,
    ms.starred,
    ms.tags,
    ms.status,
    ms.created_by,
    ms.created_at,
    ms.duration_ms,
    (SELECT COUNT(*) FROM meeting_decisions md WHERE md.session_id = ms.session_id) AS decision_count,
    (SELECT AVG(mhr.role_fulfillment) FROM meeting_hr_reviews mhr WHERE mhr.session_id = ms.session_id) AS avg_performance,
    (SELECT SUM(mtu.estimated_cost) FROM meeting_token_usage mtu WHERE mtu.session_id = ms.session_id) AS total_cost_usd
FROM meeting_sessions ms
ORDER BY ms.created_at DESC;
