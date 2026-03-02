import { NextRequest } from "next/server";
import {
  ALL_AGENTS,
  MEETING_AGENTS,
  L1_AGENTS,
  L2_AGENTS,
  L3_AGENTS,
  PIPELINE_PHASES,
} from "@/lib/agents";

const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "";
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-2.0-flash";
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;

// ── Gemini API 呼び出し ──────────────────────────────────────
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

// ── JSONから一言サマリーを抽出 ──────────────────────────────
function extractSpeech(jsonStr: string, agentId: string): string {
  try {
    const obj = JSON.parse(jsonStr);
    // 各エージェントごとに最も「発言」らしいフィールドを取得
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
    // フォールバック: 最初のstring値
    for (const key of Object.keys(obj)) {
      if (typeof obj[key] === "string" && obj[key].length > 5) return obj[key].slice(0, 200);
    }
    return "分析完了しました";
  } catch {
    return jsonStr.slice(0, 150) || "分析完了しました";
  }
}

// ── 決定事項を抽出 ──────────────────────────────────────────
function extractDecisions(jsonStr: string, agentId: string): string[] {
  try {
    const obj = JSON.parse(jsonStr);
    // まとめ -> next_actions / conditions
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
    // キロク -> key_decisions
    if (agentId === "kiroku" && obj.key_decisions) {
      return obj.key_decisions.slice(0, 5).map((d: unknown) => typeof d === "string" ? d : JSON.stringify(d));
    }
    // ガードン -> legal_risks
    if (agentId === "guardon" && obj.legal_risks) {
      return obj.legal_risks.slice(0, 3).map((r: { type?: string; detail?: string }) =>
        `⚠️ ${r.type || "リスク"}: ${r.detail || ""}`
      );
    }
    // HRくん -> skills_to_add
    if (agentId === "hrkun" && obj.skills_to_add) {
      return obj.skills_to_add.slice(0, 5).map((s: { skill_name?: string; reason?: string; agent_id?: string }) =>
        `💼 ${s.agent_id || "チーム"} → ${s.skill_name || ""}: ${s.reason || ""}`
      );
    }
    // シャガイトリ -> process_optimization
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

// ── SSEヘルパー ──────────────────────────────────────────────
function sse(
  encoder: TextEncoder,
  controller: ReadableStreamDefaultController,
  type: string,
  data: Record<string, unknown>
) {
  const payload = JSON.stringify({ type, ts: new Date().toISOString(), ...data });
  controller.enqueue(encoder.encode(`data: ${payload}\n\n`));
}

// ── POST ハンドラー ──────────────────────────────────────────
export async function POST(req: NextRequest) {
  const { topic, context } = await req.json();

  if (!topic) {
    return new Response(JSON.stringify({ error: "topic は必須です" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  if (!GEMINI_API_KEY) {
    return new Response(
      JSON.stringify({ error: "GEMINI_API_KEY が設定されていません" }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }

  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      const userPrompt = `## 議題\n${topic}\n\n${context ? `## 追加コンテキスト\n${context}` : ""}`;
      const agentResults: Record<string, string> = {};

      // エージェント実行 + speech/decision イベント発火
      async function runAgent(
        agentId: string,
        prompt: string
      ) {
        const agent = ALL_AGENTS.find((a) => a.id === agentId)!;

        sse(encoder, controller, "agent_start", {
          agent_id: agent.id,
          agent_name: agent.nickname,
          agent_icon: agent.icon,
          tier: agent.tier,
          role: agent.role,
          color: agent.color,
        });

        try {
          const result = await callGemini(agent.systemPrompt, prompt);
          agentResults[agent.id] = result;

          // 自然言語の発言を抽出して送出
          const speech = extractSpeech(result, agent.id);
          sse(encoder, controller, "speech", {
            agent_id: agent.id,
            agent_name: agent.nickname,
            agent_icon: agent.icon,
            tier: agent.tier,
            color: agent.color,
            role: agent.role,
            speech,
          });

          // 決定事項を抽出して送出
          const decisions = extractDecisions(result, agent.id);
          if (decisions.length > 0) {
            sse(encoder, controller, "decision", {
              agent_id: agent.id,
              agent_name: agent.nickname,
              agent_icon: agent.icon,
              decisions,
            });
          }

          // 生JSONも送出（詳細ビュー用）
          sse(encoder, controller, "agent_result", {
            agent_id: agent.id,
            agent_name: agent.nickname,
            agent_icon: agent.icon,
            tier: agent.tier,
            result,
          });
        } catch (err) {
          const message = err instanceof Error ? err.message : "不明なエラー";
          sse(encoder, controller, "agent_error", {
            agent_id: agent.id,
            agent_name: agent.nickname,
            agent_icon: agent.icon,
            error: message,
          });
        }
      }

      try {
        // ── Phase 1: L1 並行実行 ────────────────────────────
        sse(encoder, controller, "phase", {
          phase: 1,
          label: PIPELINE_PHASES[0].label,
          description: PIPELINE_PHASES[0].description,
        });

        const l1Agents = L1_AGENTS.filter((a) => a.id !== "kiroku");
        await Promise.all(l1Agents.map((a) => runAgent(a.id, userPrompt)));

        // ── Phase 2: L2 並行レビュー ────────────────────────
        sse(encoder, controller, "phase", {
          phase: 2,
          label: PIPELINE_PHASES[1].label,
          description: PIPELINE_PHASES[1].description,
        });

        await Promise.all(
          L2_AGENTS.map((agent) => {
            const reviewData = (agent.reviewTargets || [])
              .map((tid) => {
                const ta = ALL_AGENTS.find((a) => a.id === tid);
                const r = agentResults[tid];
                if (!ta || !r) return null;
                return `### ${ta.icon} ${ta.nickname}（${ta.role}）の報告:\n${r}`;
              })
              .filter(Boolean)
              .join("\n\n");

            const prompt = `${userPrompt}\n\n---\n## L1実行部隊からの報告\n\n${reviewData}`;
            return runAgent(agent.id, prompt);
          })
        );

        // ── Phase 3: キロク（議事録） ───────────────────────
        sse(encoder, controller, "phase", {
          phase: 3,
          label: PIPELINE_PHASES[2].label,
          description: PIPELINE_PHASES[2].description,
        });

        const allSummary = ALL_AGENTS.filter(
          (a) => a.id !== "kiroku" && a.id !== "matome" && agentResults[a.id]
        )
          .map((a) => `### ${a.icon} ${a.nickname}（${a.role} / ${a.tier}）:\n${agentResults[a.id]}`)
          .join("\n\n");

        await runAgent("kiroku", `${userPrompt}\n\n---\n## 全エージェントの議論結果\n\n${allSummary}`);

        // ── Phase 4: L3 最終判断 ────────────────────────────
        sse(encoder, controller, "phase", {
          phase: 4,
          label: PIPELINE_PHASES[3].label,
          description: PIPELINE_PHASES[3].description,
        });

        const l2Summary = L2_AGENTS.map(
          (a) => `### ${a.icon} ${a.nickname}（${a.role}）:\n${agentResults[a.id] || "（結果なし）"}`
        ).join("\n\n");

        await runAgent(
          "matome",
          `${userPrompt}\n\n---\n## L2リーダーからのレビュー報告\n\n${l2Summary}\n\n---\n## 議事録\n${agentResults["kiroku"] || "（なし）"}`
        );

        // ── Phase 5: HRくん（スキルフィードバック） ──────────
        sse(encoder, controller, "phase", {
          phase: 5,
          label: PIPELINE_PHASES[4].label,
          description: PIPELINE_PHASES[4].description,
        });

        const meetingResultsSummary = MEETING_AGENTS
          .filter((a) => agentResults[a.id])
          .map((a) => `### ${a.icon} ${a.nickname}（${a.role} / ${a.tier}）:\n${agentResults[a.id]}`)
          .join("\n\n");

        await runAgent(
          "hrkun",
          `${userPrompt}\n\n---\n## 会議全体の結果（全メンバーの出力）\n\n${meetingResultsSummary}\n\n---\n## 最終判定（まとめ）\n${agentResults["matome"] || "（なし）"}`
        );

        // ── Phase 6: シャガイトリ（構造改善レポート） ────────
        sse(encoder, controller, "phase", {
          phase: 6,
          label: PIPELINE_PHASES[5].label,
          description: PIPELINE_PHASES[5].description,
        });

        await runAgent(
          "shagaitori",
          `${userPrompt}\n\n---\n## 会議全体の結果\n\n${meetingResultsSummary}\n\n---\n## 最終判定\n${agentResults["matome"] || "（なし）"}\n\n---\n## HRくんのフィードバック\n${agentResults["hrkun"] || "（なし）"}`
        );

        // ── 完了 ────────────────────────────────────────────
        sse(encoder, controller, "done", { agentResults });
      } catch (err) {
        const message = err instanceof Error ? err.message : "パイプラインエラー";
        sse(encoder, controller, "error", { error: message });
      }

      controller.close();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
