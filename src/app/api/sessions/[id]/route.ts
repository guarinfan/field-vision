import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { getDownloadUrl } from "@/lib/r2";
import type { Session } from "@/types/database";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  const { data, error } = await supabaseAdmin
    .from("sessions")
    .select("*")
    .eq("id", id)
    .single();

  if (error || !data) {
    return NextResponse.json({ error: "Session not found" }, { status: 404 });
  }

  const session = data as unknown as Session;
  const urls: Record<string, string> = {};

  if (session.stitched_video_key) {
    urls.stitched_video = await getDownloadUrl(session.stitched_video_key);
  }
  if (session.tracked_video_key) {
    urls.tracked_video = await getDownloadUrl(session.tracked_video_key);
  }
  if (session.highlights) {
    const highlights = await Promise.all(
      session.highlights.map(async (h) => ({
        ...h,
        clip_url: await getDownloadUrl(h.clip_key),
      }))
    );
    return NextResponse.json({ ...session, urls, highlights });
  }

  return NextResponse.json({ ...session, urls });
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const { error } = await supabaseAdmin.from("sessions").delete().eq("id", id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
