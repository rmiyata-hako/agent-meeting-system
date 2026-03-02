-- ══════════════════════════════════════════════════════════════
-- マルチエージェント商品リサーチシステム - Supabase テーブル定義
-- ══════════════════════════════════════════════════════════════

-- リサーチセッション（メインテーブル）
CREATE TABLE IF NOT EXISTS research_sessions (
    id BIGSERIAL PRIMARY KEY,
    session_id TEXT UNIQUE NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    category TEXT DEFAULT '',
    keyword TEXT DEFAULT '',
    status TEXT DEFAULT 'pending',
    data JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_research_sessions_created
    ON research_sessions (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_research_sessions_status
    ON research_sessions (status);

-- エージェントが蓄積するSkill（学習知見）
CREATE TABLE IF NOT EXISTS research_skills (
    id BIGSERIAL PRIMARY KEY,
    session_id TEXT REFERENCES research_sessions(session_id),
    skill_type TEXT NOT NULL DEFAULT 'general',
    description TEXT NOT NULL,
    applicable_categories TEXT[] DEFAULT '{}',
    source_product TEXT DEFAULT '',
    usage_count INT DEFAULT 0,
    effectiveness_score REAL DEFAULT 0.0,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_research_skills_type
    ON research_skills (skill_type);
CREATE INDEX IF NOT EXISTS idx_research_skills_categories
    ON research_skills USING GIN (applicable_categories);

-- 商品ごとの判断ログ（Go/No-Go の経緯）
CREATE TABLE IF NOT EXISTS research_decisions (
    id BIGSERIAL PRIMARY KEY,
    session_id TEXT REFERENCES research_sessions(session_id),
    product_name TEXT NOT NULL,
    decision TEXT NOT NULL,
    reasoning JSONB DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_research_decisions_session
    ON research_decisions (session_id);

-- トークン使用量トラッキング
CREATE TABLE IF NOT EXISTS research_token_usage (
    id BIGSERIAL PRIMARY KEY,
    session_id TEXT REFERENCES research_sessions(session_id),
    agent_id TEXT NOT NULL,
    agent_name TEXT NOT NULL,
    phase INT NOT NULL,
    input_tokens INT DEFAULT 0,
    output_tokens INT DEFAULT 0,
    total_tokens INT DEFAULT 0,
    estimated_cost_usd REAL DEFAULT 0.0,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_token_usage_session
    ON research_token_usage (session_id);
CREATE INDEX IF NOT EXISTS idx_token_usage_agent
    ON research_token_usage (agent_id);

-- Skill進化ログ（Skillの精度が向上した経緯を記録）
CREATE TABLE IF NOT EXISTS research_skill_evolution (
    id BIGSERIAL PRIMARY KEY,
    skill_id BIGINT REFERENCES research_skills(id),
    session_id TEXT REFERENCES research_sessions(session_id),
    change_type TEXT NOT NULL, -- "created" / "reinforced" / "refined" / "deprecated"
    old_description TEXT,
    new_description TEXT,
    trigger_reason TEXT, -- なぜ変更されたか
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- RLS（Row Level Security）は必要に応じて有効化
-- ALTER TABLE research_sessions ENABLE ROW LEVEL SECURITY;
-- ALTER TABLE research_skills ENABLE ROW LEVEL SECURITY;
-- ALTER TABLE research_decisions ENABLE ROW LEVEL SECURITY;
-- ALTER TABLE research_token_usage ENABLE ROW LEVEL SECURITY;
