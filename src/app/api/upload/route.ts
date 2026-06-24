import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { getUploadUrl, videoKey } from "@/lib/r2";

export async function POST(req: NextRequest) {
  const { session_id, camera, content_type } = await req.json();

  if (!session_id || (camera !== "left" && camera !== "right")) {
    return NextResponse.json({ error: "Invalid params" }, { status: 400 });
  }

  const key = videoKey(session_id, camera);
  const url = await getUploadUrl(key, content_type || "video/webm");

  // Only mark as uploading — the key is written to DB only after upload actually completes
  await supabaseAdmin
    .from("sessions")
    .update({ status: "uploading" })
    .eq("id", session_id);

  return NextResponse.json({ url, key });
}
