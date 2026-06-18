import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { getDownloadUrl } from "@/lib/r2";

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

  // Attach signed download URLs for any output keys
  const urls: Record<string, string> = {};
  if (data.stitched_video_key) {
    urls.stitched_video = await getDownloadUrl(data.stitched_video_key);
  }
  if (data.tracked_video_key) {
    urls.tracked_video = await getDownloadUrl(data.tracked_video_key);
  }
  if (data.highlights) {
    const highlights = await Promise.all(
      data.highlights.map(async (h) => ({
        ...h,
        clip_url: await getDownloadUrl(h.clip_key),
      }))
    );
    return NextResponse.json({ ...data, urls, highlights });
  }

  return NextResponse.json({ ...data, urls });
}
