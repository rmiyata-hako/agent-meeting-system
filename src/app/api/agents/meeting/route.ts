import { NextRequest, after } from "next/server";
import { startMeeting, getStatus, runMeetingPipeline } from "@/lib/meeting-engine";

/**
 * POST: 会議を開始
 * Body: { topic, context?, sessionId? }
 *
 * after() で Gemini パイプラインをバックグラウンド実行。
 * Vercel サーバーレスでもレスポンス送信後に処理が継続する。
 */
export async function POST(req: NextRequest) {
  const { topic, context, sessionId } = await req.json();

  if (!topic) {
    return Response.json({ error: "topic は必須です" }, { status: 400 });
  }

  if (!process.env.GEMINI_API_KEY) {
    return Response.json({ error: "GEMINI_API_KEY が設定されていません" }, { status: 500 });
  }

  const id = sessionId || crypto.randomUUID();
  const state = startMeeting(id, topic, context || "");

  // Next.js after() — レスポンス送信後にバックグラウンド処理を実行
  // Vercel では waitUntil 相当で、関数が処理完了まで生存する
  after(async () => {
    await runMeetingPipeline(id, topic, context || "");
  });

  return Response.json({
    sessionId: state.sessionId,
    status: state.status,
    message: "会議を開始しました",
  });
}

/**
 * GET: 会議のステータスをポーリング
 * Query: ?sessionId=xxx
 *
 * POST と同じルートファイルに配置することで
 * Vercel サーバーレスでも同一インスタンスの Map を共有できる。
 */
export async function GET(req: NextRequest) {
  const sessionId = req.nextUrl.searchParams.get("sessionId");

  if (!sessionId) {
    return Response.json({ error: "sessionId クエリパラメータが必要です" }, { status: 400 });
  }

  const state = getStatus(sessionId);

  if (!state) {
    return Response.json({ error: "セッションが見つかりません" }, { status: 404 });
  }

  return Response.json(state);
}
