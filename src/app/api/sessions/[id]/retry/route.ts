import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { triggerProcessingJob } from "@/lib/modal";
import type { Session } from "@/types/database";

export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  const { data, error } = await supabaseAdmin
    .from("sessions")
    .select("*")
    .eq("id", id)
    .single();

  if (error || !data) return NextResponse.json({ error: "Session not found" }, { status: 404 });

  const session = data as unknown as Session;

  if (!session.left_video_key || !session.right_video_key) {
    return NextResponse.json({ error: "Both videos must be uploaded before retrying" }, { status: 400 });
  }

  await supabaseAdmin
    .from("sessions")
    .update({ status: "processing", progress: 0, error_message: null })
    .eq("id", id);

  const result = await triggerProcessingJob(id, session.left_video_key, session.right_video_key);
  return NextResponse.json({ ok: true, jobId: result.jobId });
}
