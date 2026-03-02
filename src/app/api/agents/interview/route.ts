import { NextRequest } from "next/server";

const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "";
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-2.0-flash";
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;

const FACILITATOR_PROMPT = `あなたはAIエージェント会議（14体のAI専門家チーム）のファシリテーターです。
名前は「議長AI」、アイコンは🏛️です。

## 会議メンバー
L1実行部隊: ハンター(市場調査)、シパイ(競合分析)、バズ美(SNS分析)、ヒトミ(消費者インサイト)、シッパー(物流)、コピーマン(コピーライティング)、データボット(数値分析)、キロク(議事録)
L2リーダー: ミライ(戦略)、ソロバン(収益)、ガードン(リスク管理)
L3統括: まとめ(最終判断 GO/NOGO)
HR: HRくん(スキルフィードバック)
EX: シャガイトリ(社外取締役・構造改善)

## あなたの役割
ユーザーから議題・指示を受け取り、会議を有効にするための事前ヒアリングを行います。

## 判断基準
- 議題の具体的内容（何を検討するか）が明確であれば会議を開始できます
- 完璧な情報は不要。エージェントが分析で補える部分は会議中に対応します
- ただし議題が曖昧すぎる場合（「なんか面白いこと」等）は確認が必要です
- ユーザーが「始めて」「開始」等と言ったら即座に会議開始してください

## 会話スタイル
- フレンドリーだが簡潔に
- 質問は1-3個に絞る（聞きすぎない）
- 自分の分析を交えて質問する（「〜という理解で合っていますか？」）

## 出力形式（必ずJSON）
情報が十分な場合:
{ "status": "ready", "message": "確認メッセージ", "topic": "整理された議題（1行）", "context": "整理されたコンテキスト" }

情報が不足している場合:
{ "status": "needs_info", "message": "質問メッセージ（自然な日本語で）", "questions": ["質問1", "質問2"] }`;

export async function POST(req: NextRequest) {
  const { messages } = await req.json();

  if (!GEMINI_API_KEY) {
    return Response.json({ error: "GEMINI_API_KEY が設定されていません" }, { status: 500 });
  }

  const conversationText = (messages as { role: string; content: string }[])
    .map((m) => `${m.role === "user" ? "ユーザー" : "ファシリテーター"}: ${m.content}`)
    .join("\n\n");

  const body = {
    contents: [{ role: "user", parts: [{ text: conversationText }] }],
    systemInstruction: { parts: [{ text: FACILITATOR_PROMPT }] },
    generationConfig: {
      temperature: 0.5,
      maxOutputTokens: 1024,
      responseMimeType: "application/json",
    },
  };

  try {
    const res = await fetch(GEMINI_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => `HTTP ${res.status}`);
      throw new Error(`Gemini API error: ${errText}`);
    }

    const data = await res.json();
    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text || "{}";

    try {
      return Response.json(JSON.parse(text));
    } catch {
      // JSON parse 失敗 → そのまま会議開始
      return Response.json({
        status: "ready",
        message: "会議を開始します。",
        topic: messages[0]?.content || "",
        context: "",
      });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return Response.json({ error: message }, { status: 500 });
  }
}
