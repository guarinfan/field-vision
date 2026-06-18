import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { triggerProcessingJob } from "@/lib/modal";

export async function POST(req: NextRequest) {
  const { session_id } = await req.json();

  if (!session_id) {
    return NextResponse.json({ error: "Missing session_id" }, { status: 400 });
  }

  const { data, error } = await supabaseAdmin
    .from("sessions")
    .select("left_video_key, right_video_key")
    .eq("id", session_id)
    .single();

  if (error || !data) {
    return NextResponse.json({ error: "Session not found" }, { status: 404 });
  }

  if (!data.left_video_key || !data.right_video_key) {
    return NextResponse.json({ error: "Both videos must be uploaded first" }, { status: 400 });
  }

  await supabaseAdmin
    .from("sessions")
    .update({ status: "processing", progress: 0 })
    .eq("id", session_id);

  const result = await triggerProcessingJob(session_id);

  return NextResponse.json({ ok: true, jobId: result.jobId });
}
