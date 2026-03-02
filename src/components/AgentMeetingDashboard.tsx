"use client";
import { useState, useRef, useCallback, useEffect } from "react";
import {
  Loader2, Crown, Users, Send,
  AlertTriangle, CheckCircle, XCircle, Clock,
  MessageSquare, Download, Eye, Activity,
} from "lucide-react";
import { ALL_AGENTS, PIPELINE_PHASES, type AgentTier } from "@/lib/agents";

// ── 型定義 ──────────────────────────────────────────

interface ChatMessage {
  id: string;
  role: "user" | "facilitator" | "system" | "agent" | "decision" | "verdict" | "error";
  content: string;
  agentId?: string;
  agentName?: string;
  agentIcon?: string;
  agentTier?: AgentTier;
  agentColor?: string;
  agentRole?: string;
  durationMs?: number;
  questions?: string[];
  timestamp: string;
}

interface PollAgentStatus {
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

interface PollDecision {
  agentName: string;
  agentIcon: string;
  text: string;
  timestamp: string;
}

interface PollMeetingState {
  sessionId: string;
  topic: string;
  context: string;
  status: "running" | "completed" | "error";
  currentPhase: number;
  phaseLabel: string;
  phaseDescription: string;
  agents: Record<string, PollAgentStatus>;
  speeches: {
    agentId: string;
    agentName: string;
    agentIcon: string;
    tier: AgentTier;
    color: string;
    role: string;
    speech: string;
    durationMs?: number;
    timestamp: string;
  }[];
  decisions: PollDecision[];
  phases: { phase: number; label: string; description: string; timestamp: string }[];
  verdict?: { finalVerdict: string; confidence: number; summary: string };
  allResults: Record<string, string>;
  error?: string;
  startedAt: string;
  updatedAt: string;
  version: number;
}

// ── CSS ─────────────────────────────────────────────
const styles = `
@keyframes pulse-ring {
  0% { transform: scale(1); opacity: 0.6; }
  50% { transform: scale(1.15); opacity: 0.3; }
  100% { transform: scale(1); opacity: 0.6; }
}
@keyframes float-in {
  from { opacity: 0; transform: translateY(8px); }
  to { opacity: 1; transform: translateY(0); }
}
@keyframes glow {
  0%, 100% { box-shadow: 0 0 8px rgba(251, 191, 36, 0.3); }
  50% { box-shadow: 0 0 20px rgba(251, 191, 36, 0.6); }
}
@keyframes thinking-pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.5; }
}
.anim-float { animation: float-in 0.3s ease-out forwards; }
.anim-glow { animation: glow 2s ease-in-out infinite; }
.anim-thinking { animation: thinking-pulse 1.5s ease-in-out infinite; }
.arena-thinking::after {
  content: ''; position: absolute; inset: -3px; border-radius: 50%;
  border: 2px solid transparent; border-top-color: currentColor;
  animation: spin 1s linear infinite;
}
@keyframes spin { to { transform: rotate(360deg); } }
`;

const WELCOME: ChatMessage = {
  id: "welcome",
  role: "facilitator",
  content: "AIエージェント会議へようこそ。議題や検討したいことを自由にお伝えください。内容を確認し、必要に応じて詳細をお聞きします。",
  timestamp: new Date().toISOString(),
};

// ── メインコンポーネント ────────────────────────────
export function AgentMeetingDashboard() {
  // Chat
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([WELCOME]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);

  // Meeting
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [meeting, setMeeting] = useState<PollMeetingState | null>(null);
  const [view, setView] = useState<"chat" | "status" | "arena" | "detail">("chat");
  const [selectedAgent, setSelectedAgent] = useState<string | null>(null);

  // Polling refs
  const pollingRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const lastVersionRef = useRef(0);
  const lastSpeechCountRef = useRef(0);
  const lastDecisionCountRef = useRef(0);
  const lastPhaseRef = useRef(0);
  const chatEndRef = useRef<HTMLDivElement>(null);

  const running = meeting?.status === "running";
  const completed = meeting?.status === "completed";

  // ── 自動スクロール ───────────────────────────────
  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [chatMessages]);

  // ── チャット送信 ─────────────────────────────────
  const addMsg = useCallback((msg: Omit<ChatMessage, "id" | "timestamp">) => {
    setChatMessages((prev) => [
      ...prev,
      { ...msg, id: crypto.randomUUID(), timestamp: new Date().toISOString() },
    ]);
  }, []);

  const handleSend = useCallback(async () => {
    if (!input.trim() || sending || running) return;
    const text = input.trim();
    setInput("");

    addMsg({ role: "user", content: text });
    setSending(true);

    // 会話履歴を構築
    const history = [...chatMessages, { id: "", role: "user" as const, content: text, timestamp: "" }]
      .filter((m) => m.role === "user" || m.role === "facilitator")
      .map((m) => ({ role: m.role === "user" ? "user" : "assistant", content: m.content }));

    try {
      const res = await fetch("/api/agents/interview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: history }),
      });

      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();

      if (data.error) throw new Error(data.error);

      if (data.status === "ready") {
        addMsg({
          role: "facilitator",
          content: data.message || "了解しました。会議を開始します。",
        });

        // 会議開始
        addMsg({ role: "system", content: "🏛️ 14体のAIエージェント会議を開始します..." });
        await startMeeting(data.topic, data.context);
      } else {
        addMsg({
          role: "facilitator",
          content: data.message,
          questions: data.questions,
        });
      }
    } catch (err) {
      addMsg({
        role: "error",
        content: err instanceof Error ? err.message : "通信エラーが発生しました",
      });
    } finally {
      setSending(false);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [input, sending, running, chatMessages]);

  // ── 会議開始 ─────────────────────────────────────
  const startMeeting = useCallback(async (topic: string, context: string) => {
    lastVersionRef.current = 0;
    lastSpeechCountRef.current = 0;
    lastDecisionCountRef.current = 0;
    lastPhaseRef.current = 0;

    const res = await fetch("/api/agents/meeting", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ topic, context }),
    });

    if (!res.ok) throw new Error("会議の開始に失敗しました");
    const data = await res.json();
    setSessionId(data.sessionId);
    setView("status");
  }, []);

  // ── ポーリング ───────────────────────────────────
  useEffect(() => {
    if (!sessionId) return;

    const poll = async () => {
      try {
        const res = await fetch(`/api/agents/meeting?sessionId=${sessionId}`);
        if (!res.ok) return;
        const state: PollMeetingState = await res.json();

        if (state.version <= lastVersionRef.current) return;
        lastVersionRef.current = state.version;
        setMeeting(state);

        // 新しいフェーズをチャットに追加
        for (const p of state.phases) {
          if (p.phase > lastPhaseRef.current) {
            lastPhaseRef.current = p.phase;
            setChatMessages((prev) => [
              ...prev,
              {
                id: crypto.randomUUID(),
                role: "system",
                content: `⚡ Phase ${p.phase}: ${p.label} — ${p.description}`,
                timestamp: p.timestamp,
              },
            ]);
          }
        }

        // 新しい発言をチャットに追加
        const newSpeeches = state.speeches.slice(lastSpeechCountRef.current);
        for (const s of newSpeeches) {
          setChatMessages((prev) => [
            ...prev,
            {
              id: crypto.randomUUID(),
              role: "agent",
              content: s.speech,
              agentId: s.agentId,
              agentName: s.agentName,
              agentIcon: s.agentIcon,
              agentTier: s.tier,
              agentColor: s.color,
              agentRole: s.role,
              durationMs: s.durationMs,
              timestamp: s.timestamp,
            },
          ]);
        }
        lastSpeechCountRef.current = state.speeches.length;

        // 新しい決定をチャットに追加
        const newDecisions = state.decisions.slice(lastDecisionCountRef.current);
        for (const d of newDecisions) {
          setChatMessages((prev) => [
            ...prev,
            {
              id: crypto.randomUUID(),
              role: "decision",
              content: d.text,
              agentName: d.agentName,
              agentIcon: d.agentIcon,
              timestamp: d.timestamp,
            },
          ]);
        }
        lastDecisionCountRef.current = state.decisions.length;

        // 完了時
        if (state.status === "completed") {
          if (state.verdict) {
            setChatMessages((prev) => [
              ...prev,
              {
                id: crypto.randomUUID(),
                role: "verdict",
                content: `${state.verdict!.finalVerdict} (確信度: ${state.verdict!.confidence}%)`,
                timestamp: new Date().toISOString(),
              },
            ]);
          }
          setChatMessages((prev) => [
            ...prev,
            {
              id: crypto.randomUUID(),
              role: "facilitator",
              content: "会議が完了しました。結果について質問があればどうぞ。新しい議題を入力すると、次の会議を開始できます。",
              timestamp: new Date().toISOString(),
            },
          ]);
          if (pollingRef.current) clearInterval(pollingRef.current);
        }

        // エラー時
        if (state.status === "error") {
          setChatMessages((prev) => [
            ...prev,
            {
              id: crypto.randomUUID(),
              role: "error",
              content: state.error || "会議中にエラーが発生しました",
              timestamp: new Date().toISOString(),
            },
          ]);
          if (pollingRef.current) clearInterval(pollingRef.current);
        }
      } catch { /* next poll will retry */ }
    };

    poll();
    pollingRef.current = setInterval(poll, 1500);

    return () => {
      if (pollingRef.current) clearInterval(pollingRef.current);
    };
  }, [sessionId]);

  // ── 議事録ダウンロード ───────────────────────────
  const downloadMinutes = useCallback(() => {
    if (!meeting) return;
    const now = new Date().toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" });

    const decisionsHtml = meeting.decisions
      .map((d) => `<li>${d.agentIcon} <strong>${d.agentName}</strong>: ${d.text}</li>`)
      .join("\n");

    const speechHtml = meeting.speeches
      .map((s) =>
        `<div style="margin-bottom:12px;padding:10px;border-left:3px solid ${s.color};background:#f8fafc;border-radius:6px">
          <strong>${s.agentIcon} ${s.agentName}</strong> <span style="color:#94a3b8;font-size:12px">${s.tier} / ${s.role} (${((s.durationMs || 0) / 1000).toFixed(1)}s)</span>
          <p style="margin:6px 0 0;color:#334155">${s.speech}</p>
        </div>`
      )
      .join("\n");

    const verdict = meeting.verdict?.finalVerdict || "未確定";
    const summary = meeting.verdict?.summary || "";

    const html = `<!DOCTYPE html>
<html lang="ja"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>AIエージェント会議 議事録</title>
<style>
body{font-family:-apple-system,BlinkMacSystemFont,"Hiragino Sans",sans-serif;max-width:800px;margin:0 auto;padding:20px;background:#f8fafc;color:#1e293b;line-height:1.7}
h1{font-size:20px;border-bottom:2px solid #e2e8f0;padding-bottom:10px}
h2{font-size:16px;color:#475569;margin-top:24px}
.verdict{display:inline-block;font-size:24px;font-weight:900;padding:8px 24px;border-radius:12px;margin:12px 0}
.GO{background:#dcfce7;color:#166534} .NOGO{background:#fef2f2;color:#991b1b} .CONDITIONAL{background:#fef3c7;color:#92400e}
ul{padding-left:20px} li{margin-bottom:6px}
.meta{color:#94a3b8;font-size:13px}
</style></head><body>
<h1>AIエージェント会議 議事録</h1>
<p class="meta">議題: ${meeting.topic}<br>日時: ${now}</p>
<h2>最終判定</h2>
<div class="verdict ${verdict}">${verdict}</div>
${summary ? `<p>${summary}</p>` : ""}
<h2>決定事項</h2>
<ul>${decisionsHtml || "<li>なし</li>"}</ul>
<h2>発言ログ</h2>
${speechHtml || "<p>発言なし</p>"}
</body></html>`;

    const blob = new Blob([html], { type: "text/html" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `meeting-minutes-${Date.now()}.html`;
    a.click();
    URL.revokeObjectURL(url);
  }, [meeting]);

  // ── 進捗 ─────────────────────────────────────────
  const agents = meeting?.agents || {};
  const doneCount = Object.values(agents).filter((a) => a.status === "done").length;
  const totalCount = ALL_AGENTS.length;
  const progress = meeting ? Math.round((doneCount / totalCount) * 100) : 0;

  // ── キー操作 ─────────────────────────────────────
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  return (
    <div className="space-y-4">
      <style dangerouslySetInnerHTML={{ __html: styles }} />

      {/* ── ヘッダー ── */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-slate-900 flex items-center gap-2">
            <span className="text-2xl">🏛️</span> AIエージェント会議
          </h1>
          <p className="text-xs text-slate-400 mt-0.5">
            14体のAIエージェント（L1-L3 + HR + 社外取締役） × Gemini API — ポーリング方式
          </p>
        </div>
        {completed && (
          <button
            onClick={downloadMinutes}
            className="flex items-center gap-1.5 px-3 py-1.5 bg-slate-100 hover:bg-slate-200 rounded-lg text-xs font-semibold text-slate-600 transition-all"
          >
            <Download className="w-3.5 h-3.5" /> 議事録を保存
          </button>
        )}
      </div>

      {/* ── フェーズバー ── */}
      {meeting && (
        <div className="bg-gradient-to-r from-slate-900 via-slate-800 to-slate-900 rounded-2xl p-4 text-white shadow-lg">
          <div className="flex items-center justify-between mb-2">
            <div className="flex items-center gap-3">
              <div className="flex items-center gap-1.5">
                {[1, 2, 3, 4, 5, 6].map((p) => (
                  <div
                    key={p}
                    className={`w-8 h-8 rounded-lg flex items-center justify-center text-xs font-black transition-all duration-500 ${
                      p < meeting.currentPhase
                        ? "bg-green-500 text-white"
                        : p === meeting.currentPhase
                          ? "bg-amber-500 text-white anim-glow"
                          : "bg-slate-700 text-slate-500"
                    }`}
                  >
                    {p < meeting.currentPhase ? "✓" : p}
                  </div>
                ))}
              </div>
              <div>
                <p className="text-sm font-bold">
                  {running ? meeting.phaseLabel || "処理中..." : "会議完了"}
                </p>
                <p className="text-[10px] text-slate-400">{meeting.topic}</p>
              </div>
            </div>
            <div className="text-right">
              <p className="text-2xl font-black tabular-nums">{progress}%</p>
              <p className="text-[10px] text-slate-400">
                {doneCount}/{totalCount} 完了
              </p>
            </div>
          </div>
          <div className="w-full bg-slate-700 rounded-full h-1.5 overflow-hidden">
            <div
              className="h-full rounded-full transition-all duration-700 ease-out"
              style={{
                width: `${progress}%`,
                background: progress === 100 ? "#22c55e" : "linear-gradient(90deg, #f59e0b, #f97316)",
              }}
            />
          </div>
        </div>
      )}

      {/* ── メインエリア ── */}
      {meeting ? (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          {/* 左: タブビュー (2/3) */}
          <div className="lg:col-span-2 space-y-3">
            <div className="flex gap-1 bg-slate-100 rounded-lg p-1">
              {([
                { id: "chat" as const, label: "チャット", icon: MessageSquare },
                { id: "status" as const, label: "ステータス", icon: Activity },
                { id: "arena" as const, label: "評議会", icon: Users },
                { id: "detail" as const, label: "詳細データ", icon: Eye },
              ]).map(({ id, label, icon: Icon }) => (
                <button
                  key={id}
                  onClick={() => setView(id)}
                  className={`flex-1 flex items-center justify-center gap-1.5 py-2 rounded-md text-xs font-semibold transition-all ${
                    view === id ? "bg-white text-slate-800 shadow-sm" : "text-slate-500 hover:text-slate-700"
                  }`}
                >
                  <Icon className="w-3.5 h-3.5" /> {label}
                </button>
              ))}
            </div>

            {view === "chat" && (
              <ChatView messages={chatMessages} chatEndRef={chatEndRef} />
            )}
            {view === "status" && (
              <StatusPanel meeting={meeting} />
            )}
            {view === "arena" && (
              <ArenaView
                agents={agents}
                onAgentClick={(id) => { setSelectedAgent(id); setView("detail"); }}
              />
            )}
            {view === "detail" && (
              <DetailView
                agents={agents}
                allResults={meeting.allResults}
                selectedAgent={selectedAgent}
                onSelect={setSelectedAgent}
              />
            )}

            {/* チャット入力（常時表示） */}
            <ChatInput
              input={input}
              setInput={setInput}
              onSend={handleSend}
              onKeyDown={handleKeyDown}
              disabled={sending || running}
              placeholder={running ? "会議中... 完了後に入力できます" : "メッセージを入力..."}
              sending={sending}
            />
          </div>

          {/* 右: サイドパネル (1/3) */}
          <div className="space-y-4">
            <DecisionBoard decisions={meeting.decisions} />
            {meeting.verdict && <VerdictCard verdict={meeting.verdict} />}
            {completed && (
              <button
                onClick={downloadMinutes}
                className="w-full flex items-center justify-center gap-2 py-3 bg-gradient-to-r from-amber-500 to-orange-500 text-white rounded-xl font-bold text-sm hover:from-amber-600 hover:to-orange-600 transition-all shadow-lg"
              >
                <Download className="w-4 h-4" /> 議事録をHTMLで保存
              </button>
            )}
          </div>
        </div>
      ) : (
        /* 会議前: チャットのみ表示 */
        <div className="max-w-2xl mx-auto space-y-3">
          <ChatView messages={chatMessages} chatEndRef={chatEndRef} />
          <ChatInput
            input={input}
            setInput={setInput}
            onSend={handleSend}
            onKeyDown={handleKeyDown}
            disabled={sending}
            placeholder="議題や検討したいことを入力してください..."
            sending={sending}
          />
        </div>
      )}
    </div>
  );
}

// ── チャットビュー ──────────────────────────────────────

function ChatView({
  messages,
  chatEndRef,
}: {
  messages: ChatMessage[];
  chatEndRef: React.RefObject<HTMLDivElement | null>;
}) {
  return (
    <div className="bg-white rounded-2xl border border-slate-200 shadow-sm p-4 max-h-[520px] overflow-y-auto space-y-3">
      {messages.map((msg) => {
        if (msg.role === "user") {
          return (
            <div key={msg.id} className="flex justify-end anim-float">
              <div className="max-w-[80%] bg-blue-600 text-white rounded-2xl rounded-br-md px-4 py-2.5 text-sm">
                {msg.content}
              </div>
            </div>
          );
        }

        if (msg.role === "facilitator") {
          return (
            <div key={msg.id} className="flex gap-2.5 anim-float">
              <div className="w-8 h-8 rounded-full bg-slate-800 flex items-center justify-center text-sm shrink-0">
                🏛️
              </div>
              <div className="max-w-[85%]">
                <span className="text-[10px] font-bold text-slate-400">議長AI</span>
                <div className="bg-slate-100 rounded-2xl rounded-tl-md px-4 py-2.5 text-sm text-slate-700 mt-0.5">
                  {msg.content}
                  {msg.questions && msg.questions.length > 0 && (
                    <ul className="mt-2 space-y-1">
                      {msg.questions.map((q, i) => (
                        <li key={i} className="text-slate-600 text-xs pl-2 border-l-2 border-amber-400">
                          {q}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </div>
            </div>
          );
        }

        if (msg.role === "system") {
          return (
            <div key={msg.id} className="flex justify-center anim-float">
              <span className="text-[11px] text-slate-400 bg-slate-50 px-3 py-1 rounded-full">
                {msg.content}
              </span>
            </div>
          );
        }

        if (msg.role === "agent") {
          return (
            <div key={msg.id} className="flex gap-2.5 anim-float">
              <div
                className="w-8 h-8 rounded-full flex items-center justify-center text-sm border-2 bg-white shrink-0"
                style={{ borderColor: msg.agentColor || "#64748b" }}
              >
                {msg.agentIcon}
              </div>
              <div className="max-w-[85%]">
                <div className="flex items-center gap-1.5">
                  <span className="text-[10px] font-bold" style={{ color: msg.agentColor }}>
                    {msg.agentName}
                  </span>
                  <TierBadge tier={msg.agentTier} />
                  {msg.durationMs != null && (
                    <span className="text-[9px] text-slate-300">
                      {(msg.durationMs / 1000).toFixed(1)}s
                    </span>
                  )}
                </div>
                <div
                  className="rounded-2xl rounded-tl-md px-4 py-2.5 text-sm text-slate-700 mt-0.5"
                  style={{ backgroundColor: `${msg.agentColor || "#64748b"}10`, borderLeft: `3px solid ${msg.agentColor || "#64748b"}` }}
                >
                  「{msg.content}」
                </div>
              </div>
            </div>
          );
        }

        if (msg.role === "decision") {
          return (
            <div key={msg.id} className="flex justify-center anim-float">
              <div className="inline-flex items-center gap-1.5 bg-green-50 border border-green-200 rounded-full px-3 py-1 text-[11px] text-green-700 font-semibold">
                <CheckCircle className="w-3 h-3" />
                {msg.agentIcon} {msg.content}
              </div>
            </div>
          );
        }

        if (msg.role === "verdict") {
          const isGo = msg.content.startsWith("GO");
          const isNogo = msg.content.startsWith("NOGO");
          return (
            <div key={msg.id} className="flex justify-center anim-float">
              <div className={`text-center px-6 py-3 rounded-2xl border-2 ${
                isGo ? "bg-green-50 border-green-300" :
                isNogo ? "bg-red-50 border-red-300" :
                "bg-amber-50 border-amber-300"
              }`}>
                <p className="text-[10px] text-slate-400 mb-1">👑 最終判定</p>
                <p className={`text-2xl font-black ${
                  isGo ? "text-green-700" : isNogo ? "text-red-700" : "text-amber-700"
                }`}>
                  {msg.content}
                </p>
              </div>
            </div>
          );
        }

        if (msg.role === "error") {
          return (
            <div key={msg.id} className="flex justify-center anim-float">
              <div className="inline-flex items-center gap-1.5 bg-red-50 border border-red-200 rounded-lg px-3 py-1.5 text-xs text-red-600">
                <AlertTriangle className="w-3.5 h-3.5" /> {msg.content}
              </div>
            </div>
          );
        }

        return null;
      })}
      <div ref={chatEndRef} />
    </div>
  );
}

// ── チャット入力 ────────────────────────────────────────

function ChatInput({
  input,
  setInput,
  onSend,
  onKeyDown,
  disabled,
  placeholder,
  sending,
}: {
  input: string;
  setInput: (v: string) => void;
  onSend: () => void;
  onKeyDown: (e: React.KeyboardEvent) => void;
  disabled: boolean;
  placeholder: string;
  sending: boolean;
}) {
  return (
    <div className="flex items-center gap-2 bg-white rounded-2xl border border-slate-200 shadow-sm px-4 py-2">
      <input
        type="text"
        value={input}
        onChange={(e) => setInput(e.target.value)}
        onKeyDown={onKeyDown}
        disabled={disabled}
        placeholder={placeholder}
        className="flex-1 text-sm outline-none bg-transparent disabled:opacity-50 disabled:cursor-not-allowed"
      />
      <button
        onClick={onSend}
        disabled={disabled || !input.trim()}
        className="w-8 h-8 rounded-full bg-blue-600 text-white flex items-center justify-center hover:bg-blue-700 disabled:opacity-30 disabled:cursor-not-allowed transition-all shrink-0"
      >
        {sending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
      </button>
    </div>
  );
}

// ── ステータスパネル（詳細表示） ─────────────────────────

function StatusPanel({ meeting }: { meeting: PollMeetingState }) {
  // 現在のフェーズで分析中のエージェントを特定
  const thinkingAgents = Object.values(meeting.agents).filter((a) => a.status === "thinking");
  const currentActivity = thinkingAgents.length > 0
    ? `${thinkingAgents.map((a) => `${a.icon} ${a.name}`).join("、")} が分析中...`
    : meeting.status === "completed" ? "全エージェント完了" : "処理中...";

  return (
    <div className="bg-white rounded-2xl border border-slate-200 shadow-sm p-4 max-h-[520px] overflow-y-auto space-y-4">
      {/* 現在のアクティビティ */}
      <div className="bg-gradient-to-r from-slate-800 to-slate-700 rounded-xl px-4 py-3 text-white">
        <div className="flex items-center gap-2 mb-1">
          <Activity className="w-3.5 h-3.5 text-amber-400" />
          <span className="text-xs font-bold">現在のアクティビティ</span>
        </div>
        <p className="text-sm">{currentActivity}</p>
      </div>

      {/* フェーズ別エージェントステータス */}
      {PIPELINE_PHASES.map((phase) => {
        const isActive = meeting.currentPhase === phase.phase;
        const isDone = meeting.currentPhase > phase.phase;
        const phaseAgents = phase.agents.map((id) => meeting.agents[id]).filter(Boolean);

        return (
          <div key={phase.phase} className={`rounded-xl border p-3 transition-all ${
            isActive ? "border-amber-300 bg-amber-50/50" :
            isDone ? "border-green-200 bg-green-50/30" :
            "border-slate-100 opacity-50"
          }`}>
            {/* フェーズヘッダー */}
            <div className="flex items-center gap-2 mb-2">
              <div className={`w-6 h-6 rounded-md flex items-center justify-center text-xs font-black ${
                isDone ? "bg-green-500 text-white" :
                isActive ? "bg-amber-500 text-white" :
                "bg-slate-200 text-slate-400"
              }`}>
                {isDone ? "✓" : phase.phase}
              </div>
              <div className="flex-1 min-w-0">
                <span className="text-xs font-bold text-slate-700">{phase.label}</span>
                <span className="text-[9px] text-slate-400 ml-2">{phase.description}</span>
              </div>
              {isActive && (
                <span className="text-[9px] bg-amber-100 text-amber-700 px-2 py-0.5 rounded-full font-bold anim-thinking">
                  ACTIVE
                </span>
              )}
            </div>

            {/* エージェントリスト */}
            <div className="space-y-1">
              {phaseAgents.map((a) => (
                <AgentStatusRow key={a.id} agent={a} />
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function AgentStatusRow({ agent }: { agent: PollAgentStatus }) {
  const elapsed = agent.startedAt && !agent.completedAt
    ? ((Date.now() - new Date(agent.startedAt).getTime()) / 1000).toFixed(1)
    : null;

  return (
    <div className="flex items-center gap-2 py-1 px-2 rounded-lg hover:bg-white/60 transition-all">
      <span className="text-sm">{agent.icon}</span>
      <span className="text-xs font-semibold text-slate-700 w-20 truncate">{agent.name}</span>

      {/* ステータス */}
      {agent.status === "done" && (
        <>
          <CheckCircle className="w-3.5 h-3.5 text-green-500" />
          <span className="text-[10px] text-green-600 font-semibold">完了</span>
          {agent.durationMs != null && (
            <span className="text-[10px] text-slate-400 tabular-nums ml-auto">
              {(agent.durationMs / 1000).toFixed(1)}s
            </span>
          )}
        </>
      )}
      {agent.status === "thinking" && (
        <>
          <Loader2 className="w-3.5 h-3.5 text-amber-500 animate-spin" />
          <span className="text-[10px] text-amber-600 font-semibold anim-thinking">分析中</span>
          {elapsed && (
            <span className="text-[10px] text-amber-400 tabular-nums ml-auto">
              {elapsed}s...
            </span>
          )}
        </>
      )}
      {agent.status === "waiting" && (
        <>
          <Clock className="w-3.5 h-3.5 text-slate-300" />
          <span className="text-[10px] text-slate-400">待機</span>
        </>
      )}
      {agent.status === "error" && (
        <>
          <XCircle className="w-3.5 h-3.5 text-red-500" />
          <span className="text-[10px] text-red-600 font-semibold truncate">{agent.error || "エラー"}</span>
        </>
      )}

      {/* 一言サマリー（完了時） */}
      {agent.status === "done" && agent.speech && (
        <span className="text-[9px] text-slate-400 truncate ml-1 max-w-[140px]" title={agent.speech}>
          — {agent.speech}
        </span>
      )}
    </div>
  );
}

// ── Tier バッジ ─────────────────────────────────────────

function TierBadge({ tier }: { tier?: AgentTier }) {
  if (!tier) return null;
  const colors: Record<string, { text: string; bg: string }> = {
    L1: { text: "#64748b", bg: "#f1f5f9" },
    L2: { text: "#6366f1", bg: "#eef2ff" },
    L3: { text: "#d97706", bg: "#fef3c720" },
    HR: { text: "#0ea5e9", bg: "#e0f2fe" },
    EX: { text: "#7c3aed", bg: "#ede9fe" },
  };
  const c = colors[tier] || colors.L1;
  return (
    <span className="text-[9px] px-1.5 py-0.5 rounded-full font-bold" style={{ color: c.text, backgroundColor: c.bg }}>
      {tier}
    </span>
  );
}

// ── 評議会アリーナ ──────────────────────────────────────

function ArenaView({
  agents,
  onAgentClick,
}: {
  agents: Record<string, PollAgentStatus>;
  onAgentClick: (id: string) => void;
}) {
  const tiers: { tier: AgentTier; label: string; ids: string[] }[] = [
    { tier: "EX", label: "社外取締役", ids: ALL_AGENTS.filter((a) => a.tier === "EX").map((a) => a.id) },
    { tier: "L3", label: "統括", ids: ALL_AGENTS.filter((a) => a.tier === "L3").map((a) => a.id) },
    { tier: "L2", label: "リーダー", ids: ALL_AGENTS.filter((a) => a.tier === "L2").map((a) => a.id) },
    { tier: "L1", label: "実行部隊", ids: ALL_AGENTS.filter((a) => a.tier === "L1").map((a) => a.id) },
    { tier: "HR", label: "人事・育成", ids: ALL_AGENTS.filter((a) => a.tier === "HR").map((a) => a.id) },
  ];

  return (
    <div className="bg-gradient-to-b from-slate-50 to-slate-100 rounded-2xl border border-slate-200 p-6 min-h-[420px] flex flex-col items-center justify-center gap-6 relative overflow-hidden">
      <div className="absolute inset-0 opacity-5">
        <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-80 h-80 border-2 border-slate-400 rounded-full" />
        <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-52 h-52 border border-slate-400 rounded-full" />
      </div>

      {tiers.map(({ tier, label, ids }) => (
        <div key={tier} className="relative z-10 flex flex-col items-center gap-1.5">
          <span className="text-[10px] font-bold text-slate-400 tracking-wider uppercase">
            {tier} {label}
          </span>
          <div className="flex items-center gap-3 flex-wrap justify-center">
            {ids.map((id) => {
              const a = agents[id];
              if (!a) return null;
              const isDone = a.status === "done";
              const isThinking = a.status === "thinking";

              return (
                <button
                  key={id}
                  onClick={() => onAgentClick(id)}
                  className={`relative flex flex-col items-center gap-0.5 p-2 rounded-xl transition-all duration-300 cursor-pointer hover:scale-105
                    ${isDone ? "opacity-100" : a.status === "waiting" ? "opacity-40" : "opacity-100"}`}
                  title={`${a.name}（${a.role}）${a.speech ? ": " + a.speech : ""}`}
                >
                  <div
                    className={`relative w-12 h-12 rounded-full flex items-center justify-center text-xl border-2 bg-white transition-all duration-300 shadow-sm ${
                      isThinking ? "arena-thinking anim-glow" : ""
                    }`}
                    style={{ borderColor: isDone || isThinking ? a.color : "#e2e8f0", color: a.color }}
                  >
                    {a.icon}
                    <div
                      className={`absolute -bottom-0.5 -right-0.5 w-3.5 h-3.5 rounded-full border-2 border-white ${
                        isDone ? "bg-green-500" :
                        isThinking ? "bg-amber-500" :
                        a.status === "error" ? "bg-red-500" :
                        "bg-slate-300"
                      }`}
                    />
                  </div>
                  <span className="text-[10px] font-bold" style={{ color: isDone || isThinking ? a.color : "#94a3b8" }}>
                    {a.name}
                  </span>
                  {isDone && a.durationMs != null && (
                    <span className="text-[8px] text-slate-400">{(a.durationMs / 1000).toFixed(1)}s</span>
                  )}
                </button>
              );
            })}
          </div>
          {tier !== "HR" && <div className="w-0.5 h-4 bg-slate-200 mx-auto" />}
        </div>
      ))}
    </div>
  );
}

// ── 決定ボード ──────────────────────────────────────────

function DecisionBoard({ decisions }: { decisions: PollDecision[] }) {
  if (decisions.length === 0) {
    return (
      <div className="bg-white rounded-2xl border border-slate-200 p-4 shadow-sm">
        <div className="flex items-center gap-2 mb-2">
          <CheckCircle className="w-4 h-4 text-slate-300" />
          <span className="text-xs font-bold text-slate-400">決定ボード</span>
        </div>
        <p className="text-xs text-slate-300 text-center py-3">決定事項はまだありません</p>
      </div>
    );
  }

  return (
    <div className="bg-white rounded-2xl border border-slate-200 p-4 shadow-sm max-h-80 overflow-y-auto">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <CheckCircle className="w-4 h-4 text-green-500" />
          <span className="text-xs font-bold text-slate-700">決定ボード</span>
        </div>
        <span className="text-[10px] bg-green-100 text-green-700 px-2 py-0.5 rounded-full font-bold">
          {decisions.length}件
        </span>
      </div>
      <div className="space-y-2">
        {decisions.map((d, i) => (
          <div key={i} className="flex items-start gap-2 p-2 bg-green-50 rounded-lg border border-green-100 anim-float">
            <span className="text-sm shrink-0">{d.agentIcon}</span>
            <div className="min-w-0">
              <p className="text-xs text-green-800 leading-relaxed">{d.text}</p>
              <p className="text-[9px] text-green-500 mt-0.5">{d.agentName}</p>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── 最終判定カード ──────────────────────────────────────

function VerdictCard({ verdict }: { verdict: { finalVerdict: string; confidence: number; summary: string } }) {
  const s: Record<string, { bg: string; border: string; text: string }> = {
    GO: { bg: "bg-green-50", border: "border-green-300", text: "text-green-800" },
    NOGO: { bg: "bg-red-50", border: "border-red-300", text: "text-red-800" },
    CONDITIONAL: { bg: "bg-amber-50", border: "border-amber-300", text: "text-amber-800" },
  };
  const v = s[verdict.finalVerdict] || s.CONDITIONAL;

  return (
    <div className={`${v.bg} rounded-2xl border-2 ${v.border} p-4 shadow-sm anim-float`}>
      <div className="flex items-center gap-2 mb-2">
        <Crown className="w-4 h-4 text-amber-500" />
        <span className="text-xs font-bold text-slate-600">最終判定</span>
      </div>
      <div className="text-center mb-3">
        <span className={`text-3xl font-black ${v.text}`}>{verdict.finalVerdict}</span>
        <p className="text-xs text-slate-500 mt-1">確信度 {verdict.confidence}%</p>
      </div>
      {verdict.summary && (
        <p className="text-xs text-slate-600 leading-relaxed">{verdict.summary}</p>
      )}
    </div>
  );
}

// ── 詳細データビュー ────────────────────────────────────

function DetailView({
  agents,
  allResults,
  selectedAgent,
  onSelect,
}: {
  agents: Record<string, PollAgentStatus>;
  allResults: Record<string, string>;
  selectedAgent: string | null;
  onSelect: (id: string | null) => void;
}) {
  const tiers: { tier: AgentTier; label: string; color: string }[] = [
    { tier: "EX", label: "EX 社外取締役", color: "#7c3aed" },
    { tier: "L3", label: "L3 統括", color: "#d97706" },
    { tier: "L2", label: "L2 リーダー", color: "#6366f1" },
    { tier: "L1", label: "L1 実行部隊", color: "#64748b" },
    { tier: "HR", label: "HR 人事・育成", color: "#0ea5e9" },
  ];

  const selected = selectedAgent ? agents[selectedAgent] : null;
  const selectedResult = selectedAgent ? allResults[selectedAgent] : null;

  let parsedResult: Record<string, unknown> | null = null;
  if (selectedResult) {
    try { parsedResult = JSON.parse(selectedResult); }
    catch { parsedResult = { raw: selectedResult }; }
  }

  return (
    <div className="bg-white rounded-2xl border border-slate-200 p-4 shadow-sm space-y-4">
      <div className="space-y-3">
        {tiers.map(({ tier, label, color }) => {
          const tierAgents = ALL_AGENTS.filter((a) => a.tier === tier);
          return (
            <div key={tier}>
              <span className="text-[10px] font-bold mb-1 block" style={{ color }}>{label}</span>
              <div className="flex flex-wrap gap-1.5">
                {tierAgents.map((def) => {
                  const a = agents[def.id];
                  const isSelected = selectedAgent === def.id;
                  return (
                    <button
                      key={def.id}
                      onClick={() => onSelect(isSelected ? null : def.id)}
                      disabled={!a || a.status === "waiting"}
                      className={`inline-flex items-center gap-1 px-2 py-1 rounded-lg text-xs font-semibold border transition-all
                        ${isSelected ? "shadow-sm" : ""}
                        ${!a || a.status === "waiting" ? "opacity-30 cursor-not-allowed" : "hover:shadow-sm cursor-pointer"}`}
                      style={{
                        borderColor: def.color,
                        color: isSelected ? "white" : def.color,
                        backgroundColor: isSelected ? def.color : `${def.color}10`,
                      }}
                    >
                      {def.icon} {def.nickname}
                      {a?.status === "done" && <CheckCircle className="w-2.5 h-2.5" />}
                      {a?.status === "thinking" && <Loader2 className="w-2.5 h-2.5 animate-spin" />}
                    </button>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>

      {selected && parsedResult && (
        <div className="border-t border-slate-100 pt-3">
          <div className="flex items-center gap-2 mb-2">
            <span className="text-lg">{selected.icon}</span>
            <span className="text-sm font-bold" style={{ color: selected.color }}>{selected.name}</span>
            <span className="text-xs text-slate-400">{selected.role}</span>
            {selected.durationMs != null && (
              <span className="text-[10px] text-slate-300 ml-auto">{(selected.durationMs / 1000).toFixed(1)}s</span>
            )}
          </div>
          <pre className="text-xs text-slate-600 whitespace-pre-wrap font-mono bg-slate-50 rounded-xl p-3 max-h-72 overflow-y-auto">
            {JSON.stringify(parsedResult, null, 2)}
          </pre>
        </div>
      )}

      {!selectedAgent && (
        <p className="text-xs text-slate-400 text-center py-6">
          エージェントをクリックして詳細データを表示
        </p>
      )}
    </div>
  );
}
