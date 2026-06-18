import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";

export async function POST(req: NextRequest) {
  // Verify token
  const auth = req.headers.get("authorization");
  if (auth !== `Bearer ${process.env.MODAL_AUTH_TOKEN}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await req.json();
  const { session_id, status, progress, stitched_video_key, tracked_video_key, highlights, error_message } = body;

  if (!session_id) {
    return NextResponse.json({ error: "Missing session_id" }, { status: 400 });
  }

  const update: Record<string, unknown> = { status };

  if (progress !== undefined) update.progress = progress;
  if (stitched_video_key) update.stitched_video_key = stitched_video_key;
  if (tracked_video_key) update.tracked_video_key = tracked_video_key;
  if (highlights) update.highlights = highlights;
  if (error_message) update.error_message = error_message;

  const { error } = await supabaseAdmin
    .from("sessions")
    .update(update)
    .eq("id", session_id);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
