import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { triggerProcessingJob } from "@/lib/modal";
import type { Session } from "@/types/database";

export async function POST(req: NextRequest) {
  const { session_id } = await req.json();

  if (!session_id) {
    return NextResponse.json({ error: "Missing session_id" }, { status: 400 });
  }

  const { data, error } = await supabaseAdmin
    .from("sessions")
    .select("*")
    .eq("id", session_id)
    .single();

  if (error || !data) {
    return NextResponse.json({ error: "Session not found" }, { status: 404 });
  }

  const session = data as unknown as Session;

  if (!session.left_video_key || !session.right_video_key) {
    return NextResponse.json({ error: "Both videos must be uploaded first" }, { status: 400 });
  }

  await supabaseAdmin
    .from("sessions")
    .update({ status: "processing", progress: 0 })
    .eq("id", session_id);

  const result = await triggerProcessingJob(session_id, session.left_video_key!, session.right_video_key!);

  return NextResponse.json({ ok: true, jobId: result.jobId });
}
