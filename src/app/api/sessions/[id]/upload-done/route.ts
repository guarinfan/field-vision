import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { videoKey } from "@/lib/r2";
import type { Session } from "@/types/database";

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { side, key: uploadedKey } = await req.json();
  const { id } = await params;

  if (side !== "left" && side !== "right") {
    return NextResponse.json({ error: "Invalid side" }, { status: 400 });
  }

  const field = side === "left" ? "left_video_key" : "right_video_key";
  // Use the key reported by the client (same key used for the presigned URL)
  const key = uploadedKey || videoKey(id, side);

  // Mark this side as fully uploaded now that the PUT to R2 completed
  await supabaseAdmin.from("sessions").update({ [field]: key }).eq("id", id);

  // Check if both sides are now uploaded
  const { data } = await supabaseAdmin
    .from("sessions")
    .select("left_video_key, right_video_key")
    .eq("id", id)
    .single();

  const session = data as unknown as Session;

  if (session?.left_video_key && session?.right_video_key) {
    // Both uploaded — trigger processing
    await fetch(`${process.env.NEXT_PUBLIC_SITE_URL ?? ""}/api/process`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session_id: id }),
    });
  }

  return NextResponse.json({ ok: true });
}
