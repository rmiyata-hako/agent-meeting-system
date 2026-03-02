/**
 * AIエージェント会議エンジン（ポーリング方式）
 *
 * Module-level Map でセッション状態を保持。
 * startMeeting() → バックグラウンドで Gemini API を順次呼び出し → getStatus() でポーリング。
 *
 * 開発環境: Node.js プロセスが生きている限り状態を保持
 * 本番環境: Supabase に移行予定
 */
import {
  ALL_AGENTS,
  MEETING_AGENTS,
  L1_AGENTS,
  L2_AGENTS,
  PIPELINE_PHASES,
  type AgentTier,
} from "@/lib/agents";

// ── 型定義 ─────────────────────────────────────────────

export interface AgentStatus {
  id: string;
  name: string;
  icon: string;
  tier: AgentTier;
  color: string;
  role: string;
  status: "waiting" | "thinking" | "done" | "error";
  speech?: string;
  error?: string;
  startedAt?: string;
  completedAt?: string;
  durationMs?: number;
}

export interface SpeechEntry {
  agentId: string;
  agentName: string;
  agentIcon: string;
  tier: AgentTier;
  color: string;
  role: string;
  speech: string;
  durationMs?: number;
  timestamp: string;
}

export interface DecisionEntry {
  agentName: string;
  agentIcon: string;
  text: string;
  timestamp: string;
}

export interface PhaseEntry {
  phase: number;
  label: string;
  description: string;
  timestamp: string;
}

export interface MeetingState {
  sessionId: string;
  topic: string;
  context: string;
  status: "running" | "completed" | "error";
  currentPhase: number;
  phaseLabel: string;
  phaseDescription: string;
  agents: Record<string, AgentStatus>;
  speeches: SpeechEntry[];
  decisions: DecisionEntry[];
  phases: PhaseEntry[];
  verdict?: {
    finalVerdict: string;
    confidence: number;
    summary: string;
  };
  allResults: Record<string, string>;
  error?: string;
  startedAt: string;
  updatedAt: string;
  version: number;
}

// ── In-memory Store ────────────────────────────────────
const store = new Map<string, MeetingState>();

export function getStatus(sessionId: string): MeetingState | undefined {
  return store.get(sessionId);
}

export function listSessions(): { sessionId: string; topic: string; status: string; startedAt: string }[] {
  return Array.from(store.values())
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
    .slice(0, 20)
    .map(({ sessionId, topic, status, startedAt }) => ({ sessionId, topic, status, startedAt }));
}

// ── Gemini API ─────────────────────────────────────────

const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "";
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-2.0-flash";
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;

async function callGemini(systemPrompt: string, userPrompt: string): Promise<string> {
  const body = {
    contents: [{ role: "user", parts: [{ text: userPrompt }] }],
    systemInstruction: { parts: [{ text: systemPrompt }] },
    generationConfig: {
      temperature: 0.7,
      maxOutputTokens: 2048,
      responseMimeType: "application/json",
    },
  };

  const res = await fetch(GEMINI_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => `HTTP ${res.status}`);
    throw new Error(`Gemini API error (${res.status}): ${errText}`);
  }

  const data = await res.json();
  return data?.candidates?.[0]?.content?.parts?.[0]?.text || "{}";
}

// ── 発言抽出 ───────────────────────────────────────────

function extractSpeech(jsonStr: string, agentId: string): string {
  try {
    const obj = JSON.parse(jsonStr);
    const speechFields: Record<string, string[]> = {
      hunter: ["market_size", "opportunities"],
      spy: ["competitive_position", "differentiation_opportunities"],
      buzzbee: ["buzz_potential", "viral_hooks"],
      hitomi: ["core_jtbd", "pain_points"],
      shipper: ["logistics_feasibility", "bottlenecks"],
      copyman: ["hook_analysis", "copy_suggestions"],
      databot: ["roi_estimate", "key_metrics"],
      kiroku: ["key_decisions", "consensus_level"],
      mirai: ["strategic_assessment", "strategic_priority"],
      soroban: ["financial_assessment", "break_even"],
      guardon: ["risk_assessment", "hallucination_flags"],
      matome: ["executive_summary", "final_verdict"],
      hrkun: ["team_overall_score", "team_blind_spots"],
      shagaitori: ["process_optimization", "next_evolution"],
    };

    const fields = speechFields[agentId] || Object.keys(obj).slice(0, 2);
    for (const f of fields) {
      const val = obj[f];
      if (!val) continue;
      if (typeof val === "string" && val.length > 0) return val.slice(0, 200);
      if (Array.isArray(val) && val.length > 0) {
        const items = val.slice(0, 3).map((v: unknown) =>
          typeof v === "string" ? v : typeof v === "object" && v !== null ? JSON.stringify(v).slice(0, 60) : String(v)
        );
        return items.join("、");
      }
    }
    for (const key of Object.keys(obj)) {
      if (typeof obj[key] === "string" && obj[key].length > 5) return obj[key].slice(0, 200);
    }
    return "分析完了しました";
  } catch {
    return jsonStr.slice(0, 150) || "分析完了しました";
  }
}

// ── 決定事項抽出 ───────────────────────────────────────

function extractDecisions(jsonStr: string, agentId: string): string[] {
  try {
    const obj = JSON.parse(jsonStr);
    if (agentId === "matome") {
      const items: string[] = [];
      if (obj.final_verdict) items.push(`最終判定: ${obj.final_verdict}`);
      if (obj.next_actions) {
        for (const a of obj.next_actions.slice(0, 3)) {
          items.push(typeof a === "string" ? a : a.action || JSON.stringify(a));
        }
      }
      return items;
    }
    if (agentId === "kiroku" && obj.key_decisions) {
      return obj.key_decisions.slice(0, 5).map((d: unknown) => typeof d === "string" ? d : JSON.stringify(d));
    }
    if (agentId === "guardon" && obj.legal_risks) {
      return obj.legal_risks.slice(0, 3).map((r: { type?: string; detail?: string }) =>
        `⚠️ ${r.type || "リスク"}: ${r.detail || ""}`
      );
    }
    if (agentId === "hrkun" && obj.skills_to_add) {
      return obj.skills_to_add.slice(0, 5).map((s: { skill_name?: string; reason?: string; agent_id?: string }) =>
        `💼 ${s.agent_id || "チーム"} → ${s.skill_name || ""}: ${s.reason || ""}`
      );
    }
    if (agentId === "shagaitori" && obj.process_optimization) {
      return obj.process_optimization.slice(0, 3).map((p: { proposed_change?: string }) =>
        `🏢 ${p.proposed_change || ""}`
      );
    }
    return [];
  } catch {
    return [];
  }
}

// ── 会議開始 ───────────────────────────────────────────

export function startMeeting(sessionId: string, topic: string, context: string): MeetingState {
  const agents: Record<string, AgentStatus> = {};
  ALL_AGENTS.forEach((a) => {
    agents[a.id] = {
      id: a.id,
      name: a.nickname,
      icon: a.icon,
      tier: a.tier,
      color: a.color,
      role: a.role,
      status: "waiting",
    };
  });

  const state: MeetingState = {
    sessionId,
    topic,
    context,
    status: "running",
    currentPhase: 0,
    phaseLabel: "",
    phaseDescription: "",
    agents,
    speeches: [],
    decisions: [],
    phases: [],
    allResults: {},
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    version: 0,
  };

  store.set(sessionId, state);
  return state;
}

/**
 * バックグラウンドで会議パイプラインを実行する Promise を返す。
 * 呼び出し側で after() や void で制御可能。
 */
export function runMeetingPipeline(sessionId: string, topic: string, context: string): Promise<void> {
  return processMeeting(sessionId, topic, context).catch((err) => {
    const s = store.get(sessionId);
    if (s) {
      s.status = "error";
      s.error = err instanceof Error ? err.message : "不明なエラー";
      s.updatedAt = new Date().toISOString();
      s.version++;
    }
  });
}

// ── バックグラウンド処理 ───────────────────────────────

function bump(state: MeetingState) {
  state.updatedAt = new Date().toISOString();
  state.version++;
}

function setPhase(state: MeetingState, phaseIndex: number) {
  const p = PIPELINE_PHASES[phaseIndex];
  state.currentPhase = p.phase;
  state.phaseLabel = p.label;
  state.phaseDescription = p.description;
  state.phases.push({
    phase: p.phase,
    label: p.label,
    description: p.description,
    timestamp: new Date().toISOString(),
  });
  bump(state);
}

async function runAgent(
  state: MeetingState,
  agentId: string,
  prompt: string,
): Promise<void> {
  const agent = ALL_AGENTS.find((a) => a.id === agentId)!;
  const agentState = state.agents[agentId];

  agentState.status = "thinking";
  agentState.startedAt = new Date().toISOString();
  bump(state);

  const t0 = Date.now();

  try {
    const result = await callGemini(agent.systemPrompt, prompt);
    const durationMs = Date.now() - t0;
    state.allResults[agent.id] = result;

    const speech = extractSpeech(result, agent.id);
    agentState.status = "done";
    agentState.speech = speech;
    agentState.completedAt = new Date().toISOString();
    agentState.durationMs = durationMs;

    state.speeches.push({
      agentId: agent.id,
      agentName: agent.nickname,
      agentIcon: agent.icon,
      tier: agent.tier,
      color: agent.color,
      role: agent.role,
      speech,
      durationMs,
      timestamp: new Date().toISOString(),
    });

    const decisions = extractDecisions(result, agent.id);
    for (const text of decisions) {
      state.decisions.push({
        agentName: agent.nickname,
        agentIcon: agent.icon,
        text,
        timestamp: new Date().toISOString(),
      });
    }

    // 最終判定（まとめ）の場合、verdictを設定
    if (agentId === "matome") {
      try {
        const parsed = JSON.parse(result);
        if (parsed.final_verdict) {
          state.verdict = {
            finalVerdict: parsed.final_verdict,
            confidence: parsed.confidence_level || 0,
            summary: parsed.executive_summary || "",
          };
        }
      } catch { /* ignore */ }
    }

    bump(state);
  } catch (err) {
    const message = err instanceof Error ? err.message : "不明なエラー";
    agentState.status = "error";
    agentState.error = message;
    agentState.durationMs = Date.now() - t0;
    bump(state);
  }
}

async function processMeeting(sessionId: string, topic: string, context: string) {
  const state = store.get(sessionId);
  if (!state) return;

  const userPrompt = `## 議題\n${topic}\n\n${context ? `## 追加コンテキスト\n${context}` : ""}`;

  // ── Phase 1: L1 並行実行 ────────────────────
  setPhase(state, 0);
  const l1Agents = L1_AGENTS.filter((a) => a.id !== "kiroku");
  await Promise.all(l1Agents.map((a) => runAgent(state, a.id, userPrompt)));

  // ── Phase 2: L2 並行レビュー ────────────────
  setPhase(state, 1);
  await Promise.all(
    L2_AGENTS.map((agent) => {
      const reviewData = (agent.reviewTargets || [])
        .map((tid) => {
          const ta = ALL_AGENTS.find((a) => a.id === tid);
          const r = state.allResults[tid];
          if (!ta || !r) return null;
          return `### ${ta.icon} ${ta.nickname}（${ta.role}）の報告:\n${r}`;
        })
        .filter(Boolean)
        .join("\n\n");
      const prompt = `${userPrompt}\n\n---\n## L1実行部隊からの報告\n\n${reviewData}`;
      return runAgent(state, agent.id, prompt);
    })
  );

  // ── Phase 3: キロク ─────────────────────────
  setPhase(state, 2);
  const allSummary = ALL_AGENTS.filter(
    (a) => a.id !== "kiroku" && a.id !== "matome" && state.allResults[a.id]
  )
    .map((a) => `### ${a.icon} ${a.nickname}（${a.role} / ${a.tier}）:\n${state.allResults[a.id]}`)
    .join("\n\n");
  await runAgent(state, "kiroku", `${userPrompt}\n\n---\n## 全エージェントの議論結果\n\n${allSummary}`);

  // ── Phase 4: L3 最終判断 ────────────────────
  setPhase(state, 3);
  const l2Summary = L2_AGENTS.map(
    (a) => `### ${a.icon} ${a.nickname}（${a.role}）:\n${state.allResults[a.id] || "（結果なし）"}`
  ).join("\n\n");
  await runAgent(
    state,
    "matome",
    `${userPrompt}\n\n---\n## L2リーダーからのレビュー報告\n\n${l2Summary}\n\n---\n## 議事録\n${state.allResults["kiroku"] || "（なし）"}`
  );

  // ── Phase 5: HRくん ─────────────────────────
  setPhase(state, 4);
  const meetingResultsSummary = MEETING_AGENTS
    .filter((a) => state.allResults[a.id])
    .map((a) => `### ${a.icon} ${a.nickname}（${a.role} / ${a.tier}）:\n${state.allResults[a.id]}`)
    .join("\n\n");
  await runAgent(
    state,
    "hrkun",
    `${userPrompt}\n\n---\n## 会議全体の結果（全メンバーの出力）\n\n${meetingResultsSummary}\n\n---\n## 最終判定（まとめ）\n${state.allResults["matome"] || "（なし）"}`
  );

  // ── Phase 6: シャガイトリ ───────────────────
  setPhase(state, 5);
  await runAgent(
    state,
    "shagaitori",
    `${userPrompt}\n\n---\n## 会議全体の結果\n\n${meetingResultsSummary}\n\n---\n## 最終判定\n${state.allResults["matome"] || "（なし）"}\n\n---\n## HRくんのフィードバック\n${state.allResults["hrkun"] || "（なし）"}`
  );

  // ── 完了 ────────────────────────────────────
  state.status = "completed";
  bump(state);
}
