"use client";
import { useState, useEffect, useCallback } from "react";
import { apiFetch } from "@/lib/utils";
import {
  Search, Play, Clock, CheckCircle, AlertCircle, Loader2,
  ChevronDown, ChevronUp, Brain, TrendingUp, Scale, Truck,
  Users, BarChart3, FileText, ShieldCheck, RefreshCw, Zap,
  MessageSquare,
} from "lucide-react";

// ── 型定義 ──────────────────────────────────────────
interface AgentInfo {
  id: string;
  name: string;
  nickname: string;
  icon: string;
  role: string;
  phase: number;
  color: string;
  llm: string;
}

interface TimelineEntry {
  timestamp: string;
  agent_id: string;
  agent_name: string;
  agent_icon: string;
  event_type: "start" | "result" | "challenge" | "skill";
  content: string;
  metadata: Record<string, unknown>;
}

interface TokenUsageEntry {
  agent_id: string;
  agent_name: string;
  phase: number;
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  estimated_cost_usd: number;
}

interface TokenUsageSummary {
  per_agent: TokenUsageEntry[];
  total_input_tokens: number;
  total_output_tokens: number;
  total_tokens: number;
  total_estimated_cost_usd: number;
}

interface ResearchStatus {
  session_id: string;
  status: string;
  progress: number;
  message: string;
  timeline: TimelineEntry[];
  token_usage?: TokenUsageSummary;
}

interface SessionSummary {
  session_id: string;
  created_at: string;
  category: string;
  keyword: string;
  status: string;
  progress: number;
  message: string;
}

interface FullSession {
  session_id: string;
  created_at: string;
  category: string;
  keyword: string;
  status: string;
  progress: number;
  message: string;
  agent_results: Record<string, unknown>;
  minutes: Record<string, unknown> | null;
  timeline: TimelineEntry[];
  token_usage?: TokenUsageSummary;
}

// ── メインコンポーネント ──────────────────────────────
export function ResearchDashboard() {
  const [activeSession, setActiveSession] = useState<string | null>(null);
  const [status, setStatus] = useState<ResearchStatus | null>(null);
  const [fullSession, setFullSession] = useState<FullSession | null>(null);
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [category, setCategory] = useState("");
  const [keyword, setKeyword] = useState("");
  const [starting, setStarting] = useState(false);
  const [activeTab, setActiveTab] = useState<"timeline" | "minutes" | "agents" | "skills" | "tokens">("timeline");

  // エージェント一覧を取得
  useEffect(() => {
    apiFetch<{ agents: AgentInfo[] }>("/api/research/agents")
      .then((r) => setAgents(r.agents))
      .catch(() => {});
    apiFetch<SessionSummary[]>("/api/research/sessions")
      .then((r) => setSessions(r))
      .catch(() => {});
  }, []);

  // ポーリング
  const poll = useCallback(async (sid: string) => {
    try {
      const s = await apiFetch<ResearchStatus>(`/api/research/status/${sid}`);
      setStatus(s);
      if (s.status === "done" || s.status === "error") {
        // 完了したら全データを取得
        const full = await apiFetch<FullSession>(`/api/research/session/${sid}`);
        setFullSession(full);
        // セッション一覧を更新
        apiFetch<SessionSummary[]>("/api/research/sessions").then(setSessions).catch(() => {});
      } else {
        setTimeout(() => poll(sid), 3000);
      }
    } catch {
      setTimeout(() => poll(sid), 5000);
    }
  }, []);

  // リサーチ開始
  const startResearch = async () => {
    setStarting(true);
    try {
      const res = await apiFetch<{ session_id: string }>("/api/research/start", {
        method: "POST",
        body: JSON.stringify({ category, keyword }),
      });
      setActiveSession(res.session_id);
      setFullSession(null);
      setActiveTab("timeline");
      poll(res.session_id);
    } catch (e: unknown) {
      alert(e instanceof Error ? e.message : "エラーが発生しました");
    } finally {
      setStarting(false);
    }
  };

  // 過去セッションを開く
  const openSession = async (sid: string) => {
    setActiveSession(sid);
    try {
      const full = await apiFetch<FullSession>(`/api/research/session/${sid}`);
      setFullSession(full);
      setStatus({
        session_id: sid,
        status: full.status,
        progress: full.progress,
        message: full.message,
        timeline: full.timeline,
      });
    } catch {
      alert("セッションの読み込みに失敗しました");
    }
  };

  const isRunning = status && !["done", "error", "pending"].includes(status.status) && activeSession;
  const timeline = fullSession?.timeline || status?.timeline || [];

  return (
    <div className="space-y-6">
      {/* ヘッダー */}
      <div>
        <h1 className="text-2xl font-bold text-slate-900 flex items-center gap-2">
          <span className="text-3xl">🌏</span> 海外商品リサーチ
        </h1>
        <p className="text-sm text-slate-500 mt-1">
          10のAIエージェント（Gemini / Claude / Groq）が自律的にリサーチ・評価・議論を行い、代理店ビジネスの候補商品を提案します
        </p>
      </div>

      {/* 新規リサーチ開始 */}
      <div className="bg-white rounded-2xl border border-slate-200 p-5 shadow-sm">
        <h2 className="text-sm font-semibold text-slate-700 mb-3 flex items-center gap-2">
          <Search className="w-4 h-4" />
          新規リサーチ
        </h2>
        <div className="flex flex-col sm:flex-row gap-3">
          <div className="flex-1">
            <label className="text-xs text-slate-500 mb-1 block">カテゴリ</label>
            <select
              value={category}
              onChange={(e) => setCategory(e.target.value)}
              className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm bg-white"
            >
              <option value="">全般（幅広く調査）</option>
              <option value="健康食品・サプリメント">健康食品・サプリメント</option>
              <option value="美容・スキンケア">美容・スキンケア</option>
              <option value="ガジェット・テック">ガジェット・テック</option>
              <option value="ペット用品">ペット用品</option>
              <option value="ベビー・キッズ">ベビー・キッズ</option>
              <option value="ホーム・インテリア">ホーム・インテリア</option>
              <option value="フード・飲料">フード・飲料</option>
              <option value="フィットネス・ウェルネス">フィットネス・ウェルネス</option>
            </select>
          </div>
          <div className="flex-1">
            <label className="text-xs text-slate-500 mb-1 block">キーワード（任意）</label>
            <input
              type="text"
              value={keyword}
              onChange={(e) => setKeyword(e.target.value)}
              placeholder="例: プロテイン、スマートリング..."
              className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm"
            />
          </div>
          <div className="flex items-end">
            <button
              onClick={startResearch}
              disabled={starting || !!isRunning}
              className="flex items-center gap-2 bg-indigo-600 text-white px-5 py-2 rounded-lg text-sm font-semibold hover:bg-indigo-700 disabled:opacity-50 transition-all whitespace-nowrap"
            >
              {starting || isRunning ? <Loader2 className="w-4 h-4 animate-spin" /> : <Play className="w-4 h-4" />}
              {isRunning ? "リサーチ中..." : "リサーチ開始"}
            </button>
          </div>
        </div>
      </div>

      {/* エージェント一覧（フェーズ表示） */}
      <div className="bg-white rounded-2xl border border-slate-200 p-5 shadow-sm">
        <h2 className="text-sm font-semibold text-slate-700 mb-3 flex items-center gap-2">
          <Brain className="w-4 h-4" />
          エージェント構成（6フェーズ）
        </h2>
        <div className="space-y-3">
          {[1, 2, 3, 4, 5, 6].map((phase) => {
            const phaseAgents = agents.filter((a) => a.phase === phase);
            if (phaseAgents.length === 0) return null;
            const phaseLabels: Record<number, string> = {
              1: "調査",
              2: "並列評価",
              3: "深堀り",
              4: "検証（Anti-Satisficing）",
              5: "記録 & Skill抽出",
              6: "時報・日報レポート",
            };
            const llmBadge: Record<string, { label: string; className: string }> = {
              gemini: { label: "Gemini", className: "bg-blue-50 text-blue-500" },
              claude: { label: "Claude", className: "bg-orange-50 text-orange-500" },
              groq: { label: "Groq", className: "bg-emerald-50 text-emerald-500" },
            };
            return (
              <div key={phase} className="flex items-center gap-2">
                <span className="text-xs font-bold text-slate-400 w-24 shrink-0">Phase {phase}: {phaseLabels[phase]}</span>
                <div className="flex gap-2 flex-wrap">
                  {phaseAgents.map((a) => {
                    const badge = llmBadge[a.llm] || llmBadge.gemini;
                    return (
                      <span
                        key={a.id}
                        className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-medium border"
                        style={{ borderColor: a.color, color: a.color, backgroundColor: `${a.color}10` }}
                        title={`${a.name}（${a.role}）- ${a.llm}`}
                      >
                        <span>{a.icon}</span>
                        {a.nickname || a.name}
                        <span className={`text-[9px] px-1 py-0.5 rounded ${badge.className}`}>{badge.label}</span>
                      </span>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
        {/* 進捗バー */}
        {status && activeSession && (
          <div className="mt-4 pt-4 border-t border-slate-100">
            <div className="flex items-center justify-between mb-2">
              <span className="text-xs font-medium text-slate-600">{status.message}</span>
              <span className="text-xs font-bold text-indigo-600">{status.progress}%</span>
            </div>
            <div className="w-full bg-slate-100 rounded-full h-2">
              <div
                className="h-2 rounded-full transition-all duration-500"
                style={{
                  width: `${status.progress}%`,
                  background: status.status === "error" ? "#ef4444" :
                    status.status === "done" ? "#22c55e" : "#6366f1",
                }}
              />
            </div>
          </div>
        )}
      </div>

      {/* タブナビ */}
      {(timeline.length > 0 || fullSession) && (
        <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
          <div className="flex border-b border-slate-200">
            {([
              { id: "timeline" as const, label: "議論タイムライン", icon: MessageSquare },
              { id: "minutes" as const, label: "議事録", icon: FileText },
              { id: "agents" as const, label: "エージェント詳細", icon: BarChart3 },
              { id: "skills" as const, label: "蓄積Skill", icon: Zap },
              { id: "tokens" as const, label: "トークン使用量", icon: BarChart3 },
            ]).map(({ id, label, icon: Icon }) => (
              <button
                key={id}
                onClick={() => setActiveTab(id)}
                className={`flex-1 flex items-center justify-center gap-1.5 py-3 text-xs font-semibold border-b-2 transition-all
                  ${activeTab === id ? "border-indigo-600 text-indigo-700 bg-indigo-50/50" : "border-transparent text-slate-500 hover:text-slate-700"}`}
              >
                <Icon className="w-3.5 h-3.5" />
                {label}
              </button>
            ))}
          </div>

          <div className="p-5">
            {activeTab === "timeline" && <TimelineView entries={timeline} agents={agents} />}
            {activeTab === "minutes" && fullSession?.minutes && <MinutesView minutes={fullSession.minutes} />}
            {activeTab === "minutes" && !fullSession?.minutes && (
              <p className="text-sm text-slate-400 text-center py-8">
                {isRunning ? "議事録を作成中..." : "議事録はまだありません"}
              </p>
            )}
            {activeTab === "agents" && fullSession?.agent_results && <AgentDetailView results={fullSession.agent_results} agents={agents} />}
            {activeTab === "agents" && !fullSession?.agent_results && (
              <p className="text-sm text-slate-400 text-center py-8">エージェント結果はまだありません</p>
            )}
            {activeTab === "skills" && fullSession?.minutes && <SkillsView minutes={fullSession.minutes} />}
            {activeTab === "skills" && !fullSession?.minutes && (
              <p className="text-sm text-slate-400 text-center py-8">Skillはまだ抽出されていません</p>
            )}
            {activeTab === "tokens" && <TokenUsageView usage={fullSession?.token_usage || status?.token_usage} agents={agents} />}
          </div>
        </div>
      )}

      {/* 過去セッション一覧 */}
      {sessions.length > 0 && (
        <div className="bg-white rounded-2xl border border-slate-200 p-5 shadow-sm">
          <h2 className="text-sm font-semibold text-slate-700 mb-3 flex items-center gap-2">
            <Clock className="w-4 h-4" />
            過去のリサーチセッション
          </h2>
          <div className="space-y-2">
            {sessions.map((s) => (
              <button
                key={s.session_id}
                onClick={() => openSession(s.session_id)}
                className={`w-full flex items-center gap-3 p-3 rounded-xl text-left text-sm transition-all hover:bg-slate-50
                  ${activeSession === s.session_id ? "bg-indigo-50 border border-indigo-200" : "border border-slate-100"}`}
              >
                <StatusIcon status={s.status} />
                <div className="flex-1 min-w-0">
                  <p className="font-medium text-slate-700 truncate">
                    {s.category || "全般"} {s.keyword && `/ ${s.keyword}`}
                  </p>
                  <p className="text-xs text-slate-400">{s.created_at.replace("T", " ")}</p>
                </div>
                <span className={`text-xs font-bold px-2 py-0.5 rounded-full ${
                  s.status === "done" ? "bg-green-100 text-green-700" :
                  s.status === "error" ? "bg-red-100 text-red-700" :
                  "bg-amber-100 text-amber-700"
                }`}>
                  {s.status === "done" ? "完了" : s.status === "error" ? "エラー" : `${s.progress}%`}
                </span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ── タイムラインビュー ──────────────────────────────
function TimelineView({ entries, agents }: { entries: TimelineEntry[]; agents: AgentInfo[] }) {
  if (entries.length === 0) return <p className="text-sm text-slate-400 text-center py-8">まだ議論が開始されていません</p>;

  const getColor = (agentId: string) => agents.find((a) => a.id === agentId)?.color || "#64748b";

  return (
    <div className="space-y-0">
      {entries.map((entry, i) => (
        <div key={i} className="flex gap-3 group">
          {/* 縦線 + ドット */}
          <div className="flex flex-col items-center">
            <div
              className="w-3 h-3 rounded-full shrink-0 mt-1 border-2 border-white shadow-sm"
              style={{ backgroundColor: getColor(entry.agent_id) }}
            />
            {i < entries.length - 1 && (
              <div className="w-0.5 flex-1 min-h-[24px]" style={{ backgroundColor: `${getColor(entry.agent_id)}30` }} />
            )}
          </div>
          {/* 内容 */}
          <div className="pb-4 flex-1 min-w-0">
            <div className="flex items-center gap-2 mb-0.5">
              <span className="text-sm">{entry.agent_icon}</span>
              <span className="text-xs font-bold" style={{ color: getColor(entry.agent_id) }}>{entry.agent_name}</span>
              <span className="text-[10px] text-slate-300">{entry.timestamp.split("T")[1]}</span>
              {entry.event_type === "challenge" && (
                <span className="text-[10px] font-bold text-red-500 bg-red-50 px-1.5 py-0.5 rounded">指摘</span>
              )}
              {entry.event_type === "skill" && (
                <span className="text-[10px] font-bold text-purple-500 bg-purple-50 px-1.5 py-0.5 rounded">Skill</span>
              )}
            </div>
            <p className={`text-sm ${entry.event_type === "challenge" ? "text-red-600" : "text-slate-600"}`}>
              {entry.content}
            </p>
          </div>
        </div>
      ))}
    </div>
  );
}

// ── 議事録ビュー ──────────────────────────────────
function MinutesView({ minutes }: { minutes: Record<string, unknown> }) {
  const m = minutes as {
    executive_summary?: string;
    products_discussed?: string[];
    per_product_summary?: Array<Record<string, string>>;
    recommended_actions?: Array<Record<string, string>>;
    next_research_topics?: string[];
    learned_skills?: Array<Record<string, unknown>>;
    discussion_quality_note?: string;
  };

  return (
    <div className="space-y-6">
      {/* エグゼクティブサマリー */}
      {m.executive_summary && (
        <div className="bg-indigo-50 rounded-xl p-4">
          <h3 className="text-xs font-bold text-indigo-700 mb-2">Executive Summary</h3>
          <p className="text-sm text-indigo-900 whitespace-pre-line">{m.executive_summary}</p>
        </div>
      )}

      {/* 商品ごとのまとめ */}
      {m.per_product_summary?.map((product, i) => (
        <ProductSummaryCard key={i} product={product} />
      ))}

      {/* 推奨アクション */}
      {m.recommended_actions && m.recommended_actions.length > 0 && (
        <div>
          <h3 className="text-sm font-bold text-slate-700 mb-2 flex items-center gap-2">
            <CheckCircle className="w-4 h-4 text-green-500" /> 推奨アクション
          </h3>
          <div className="space-y-2">
            {m.recommended_actions.map((action, i) => (
              <div key={i} className="flex items-start gap-3 p-3 rounded-lg border border-slate-100">
                <span className={`shrink-0 text-xs font-bold px-2 py-0.5 rounded-full ${
                  action.priority === "最優先" ? "bg-red-100 text-red-700" :
                  action.priority === "要検討" ? "bg-amber-100 text-amber-700" :
                  "bg-slate-100 text-slate-600"
                }`}>{action.priority}</span>
                <div className="min-w-0">
                  <p className="text-sm font-medium text-slate-700">{action.product_name}: {action.action}</p>
                  <p className="text-xs text-slate-500 mt-0.5">{action.reason}</p>
                  {action.owner && <p className="text-xs text-slate-400 mt-0.5">担当: {action.owner}</p>}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* 次回テーマ */}
      {m.next_research_topics && m.next_research_topics.length > 0 && (
        <div>
          <h3 className="text-sm font-bold text-slate-700 mb-2">次回調査テーマ</h3>
          <div className="flex flex-wrap gap-2">
            {m.next_research_topics.map((topic, i) => (
              <span key={i} className="text-xs px-3 py-1.5 bg-slate-100 text-slate-600 rounded-full">{topic}</span>
            ))}
          </div>
        </div>
      )}

      {/* 議論品質ノート */}
      {m.discussion_quality_note && (
        <div className="bg-amber-50 rounded-xl p-4 border border-amber-200">
          <h3 className="text-xs font-bold text-amber-700 mb-1 flex items-center gap-1">
            <Brain className="w-3.5 h-3.5" /> ツッコミ（メタ認知AI）による議論品質評価
          </h3>
          <p className="text-sm text-amber-900">{m.discussion_quality_note}</p>
        </div>
      )}
    </div>
  );
}

// ── 商品サマリーカード ──────────────────────────────
function ProductSummaryCard({ product }: { product: Record<string, string> }) {
  const [open, setOpen] = useState(true);

  const highlights = [
    { key: "searcher_highlight", label: "ハンター", icon: "🔍", color: "#3b82f6" },
    { key: "pl_highlight", label: "ソロバン", icon: "📊", color: "#22c55e" },
    { key: "marketer_highlight", label: "バズ美", icon: "📣", color: "#f59e0b" },
    { key: "legal_highlight", label: "ガードン", icon: "⚖️", color: "#ef4444" },
    { key: "supply_chain_highlight", label: "シッパー", icon: "🚢", color: "#8b5cf6" },
    { key: "consumer_highlight", label: "ヒトミ", icon: "👤", color: "#ec4899" },
    { key: "trend_highlight", label: "ミライ", icon: "📈", color: "#06b6d4" },
  ];

  const verdictColor: Record<string, string> = {
    "最優先": "bg-green-100 text-green-700 border-green-200",
    "要検討": "bg-amber-100 text-amber-700 border-amber-200",
    "保留": "bg-slate-100 text-slate-600 border-slate-200",
    "見送り": "bg-red-100 text-red-700 border-red-200",
    "GO": "bg-green-100 text-green-700 border-green-200",
    "CONDITIONAL": "bg-amber-100 text-amber-700 border-amber-200",
    "NOGO": "bg-red-100 text-red-700 border-red-200",
  };

  return (
    <div className="border border-slate-200 rounded-xl overflow-hidden">
      <button
        onClick={() => setOpen(!open)}
        className="w-full flex items-center justify-between p-4 hover:bg-slate-50 transition-all"
      >
        <div className="flex items-center gap-3">
          <span className="text-lg">📦</span>
          <span className="font-bold text-slate-800 text-sm">{product.product_name}</span>
          {product.meta_verdict && (
            <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full border ${verdictColor[product.meta_verdict] || "bg-slate-100 text-slate-600"}`}>
              {product.meta_verdict}
            </span>
          )}
          {product.final_recommendation && (
            <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full border ${verdictColor[product.final_recommendation] || "bg-slate-100 text-slate-600"}`}>
              {product.final_recommendation}
            </span>
          )}
        </div>
        {open ? <ChevronUp className="w-4 h-4 text-slate-400" /> : <ChevronDown className="w-4 h-4 text-slate-400" />}
      </button>
      {open && (
        <div className="px-4 pb-4 space-y-3 border-t border-slate-100 pt-3">
          {highlights.map(({ key, label, icon, color }) =>
            product[key] ? (
              <div key={key} className="flex items-start gap-2">
                <span className="text-sm shrink-0">{icon}</span>
                <div className="min-w-0">
                  <span className="text-[10px] font-bold" style={{ color }}>{label}</span>
                  <p className="text-xs text-slate-600 mt-0.5">{product[key]}</p>
                </div>
              </div>
            ) : null
          )}
          {product.consensus && (
            <div className="bg-green-50 rounded-lg p-2.5 mt-2">
              <p className="text-xs font-bold text-green-700 mb-0.5">合意</p>
              <p className="text-xs text-green-800">{product.consensus}</p>
            </div>
          )}
          {product.disagreements && product.disagreements !== "なし" && (
            <div className="bg-red-50 rounded-lg p-2.5">
              <p className="text-xs font-bold text-red-700 mb-0.5">意見の相違</p>
              <p className="text-xs text-red-800">{product.disagreements}</p>
            </div>
          )}
          {product.risk_consensus && (
            <div className="bg-amber-50 rounded-lg p-2.5">
              <p className="text-xs font-bold text-amber-700 mb-0.5">リスク合意</p>
              <p className="text-xs text-amber-800">{product.risk_consensus}</p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── エージェント詳細ビュー ──────────────────────────
function AgentDetailView({ results, agents }: { results: Record<string, unknown>; agents: AgentInfo[] }) {
  const [selectedAgent, setSelectedAgent] = useState<string | null>(null);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-2">
        {agents.map((a) => {
          const hasResult = !!results[a.id];
          return (
            <button
              key={a.id}
              onClick={() => setSelectedAgent(selectedAgent === a.id ? null : a.id)}
              disabled={!hasResult}
              className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold border transition-all
                ${selectedAgent === a.id ? "border-2 shadow-sm" : "border"}
                ${!hasResult ? "opacity-30 cursor-not-allowed" : "hover:shadow-sm cursor-pointer"}`}
              style={{
                borderColor: a.color,
                color: selectedAgent === a.id ? "white" : a.color,
                backgroundColor: selectedAgent === a.id ? a.color : `${a.color}10`,
              }}
            >
              <span>{a.icon}</span> {a.nickname || a.name}
            </button>
          );
        })}
      </div>

      {selectedAgent && results[selectedAgent] && (
        <div className="bg-slate-50 rounded-xl p-4 max-h-96 overflow-y-auto">
          <pre className="text-xs text-slate-700 whitespace-pre-wrap font-mono">
            {JSON.stringify(results[selectedAgent], null, 2)}
          </pre>
        </div>
      )}

      {!selectedAgent && (
        <p className="text-sm text-slate-400 text-center py-4">
          エージェントをクリックして詳細を表示
        </p>
      )}
    </div>
  );
}

// ── Skill蓄積ビュー ──────────────────────────────
function SkillsView({ minutes }: { minutes: Record<string, unknown> }) {
  const m = minutes as { learned_skills?: Array<Record<string, unknown>> };
  const skills = m.learned_skills || [];

  const skillTypeColors: Record<string, { bg: string; text: string }> = {
    market_insight: { bg: "bg-blue-100", text: "text-blue-700" },
    regulation: { bg: "bg-red-100", text: "text-red-700" },
    pricing: { bg: "bg-green-100", text: "text-green-700" },
    logistics: { bg: "bg-purple-100", text: "text-purple-700" },
    consumer: { bg: "bg-pink-100", text: "text-pink-700" },
    trend: { bg: "bg-cyan-100", text: "text-cyan-700" },
  };

  if (skills.length === 0) {
    return <p className="text-sm text-slate-400 text-center py-8">このセッションではSkillが抽出されていません</p>;
  }

  return (
    <div className="space-y-3">
      <p className="text-xs text-slate-500">
        今回の議論から{skills.length}件のSkillが抽出されました。次回のリサーチで自動的に参照されます。
      </p>
      {skills.map((skill, i) => {
        const type = (skill.skill_type as string) || "general";
        const colors = skillTypeColors[type] || { bg: "bg-slate-100", text: "text-slate-700" };
        return (
          <div key={i} className="border border-slate-200 rounded-xl p-3">
            <div className="flex items-center gap-2 mb-1.5">
              <Zap className="w-3.5 h-3.5 text-amber-500" />
              <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${colors.bg} ${colors.text}`}>
                {type}
              </span>
              {skill.source_product && (
                <span className="text-[10px] text-slate-400">from: {skill.source_product as string}</span>
              )}
            </div>
            <p className="text-sm text-slate-700">{skill.description as string}</p>
            {(skill.applicable_categories as string[])?.length > 0 && (
              <div className="flex gap-1.5 mt-2">
                {(skill.applicable_categories as string[]).map((cat, j) => (
                  <span key={j} className="text-[10px] px-2 py-0.5 bg-slate-100 text-slate-500 rounded-full">{cat}</span>
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ── トークン使用量ビュー ──────────────────────────────
function TokenUsageView({ usage, agents }: { usage?: TokenUsageSummary; agents: AgentInfo[] }) {
  if (!usage || !usage.per_agent || usage.per_agent.length === 0) {
    return <p className="text-sm text-slate-400 text-center py-8">トークン使用データはまだありません</p>;
  }

  const getColor = (agentId: string) => agents.find((a) => a.id === agentId)?.color || "#64748b";
  const maxTokens = Math.max(...usage.per_agent.map((u) => u.total_tokens), 1);

  return (
    <div className="space-y-4">
      {/* 合計 */}
      <div className="grid grid-cols-3 gap-3">
        <div className="bg-blue-50 rounded-xl p-3 text-center">
          <p className="text-[10px] text-blue-500 font-semibold">入力トークン</p>
          <p className="text-lg font-bold text-blue-700">{(usage.total_input_tokens).toLocaleString()}</p>
        </div>
        <div className="bg-green-50 rounded-xl p-3 text-center">
          <p className="text-[10px] text-green-500 font-semibold">出力トークン</p>
          <p className="text-lg font-bold text-green-700">{(usage.total_output_tokens).toLocaleString()}</p>
        </div>
        <div className="bg-purple-50 rounded-xl p-3 text-center">
          <p className="text-[10px] text-purple-500 font-semibold">推定コスト</p>
          <p className="text-lg font-bold text-purple-700">${usage.total_estimated_cost_usd.toFixed(4)}</p>
        </div>
      </div>

      {/* エージェント別 */}
      <h3 className="text-xs font-bold text-slate-600">エージェント別使用量</h3>
      <div className="space-y-2">
        {usage.per_agent.map((entry, i) => (
          <div key={i} className="flex items-center gap-3">
            <div className="w-28 shrink-0 flex items-center gap-1.5">
              <span className="text-sm">{agents.find((a) => a.id === entry.agent_id)?.icon || ""}</span>
              <span className="text-xs font-medium text-slate-600 truncate">{entry.agent_name}</span>
            </div>
            <div className="flex-1 bg-slate-100 rounded-full h-4 relative overflow-hidden">
              <div
                className="h-full rounded-full transition-all"
                style={{
                  width: `${(entry.total_tokens / maxTokens) * 100}%`,
                  backgroundColor: getColor(entry.agent_id),
                  opacity: 0.7,
                }}
              />
              <span className="absolute inset-0 flex items-center justify-end pr-2 text-[10px] font-bold text-slate-600">
                {entry.total_tokens.toLocaleString()}
              </span>
            </div>
            <span className="text-[10px] text-slate-400 w-16 text-right">${entry.estimated_cost_usd.toFixed(4)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── ステータスアイコン ──────────────────────────────
function StatusIcon({ status }: { status: string }) {
  if (status === "done") return <CheckCircle className="w-5 h-5 text-green-500 shrink-0" />;
  if (status === "error") return <AlertCircle className="w-5 h-5 text-red-500 shrink-0" />;
  return <Loader2 className="w-5 h-5 text-amber-500 animate-spin shrink-0" />;
}
