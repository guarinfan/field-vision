/**
 * Phone-to-phone signaling via DB bitmask stored in the `progress` field.
 * Used only during the "created"/"uploading" status phases (before processing).
 *
 * Bit layout (progress field):
 *   bit 0 (1)  — left phone connected
 *   bit 1 (2)  — right phone connected
 *   bit 2 (4)  — start recording signal
 *   bit 3 (8)  — stop recording signal
 */

import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";

async function getProgress(id: string): Promise<number> {
  const { data } = await supabaseAdmin
    .from("sessions")
    .select("progress")
    .eq("id", id)
    .single();
  return (data as any)?.progress ?? 0;
}

async function setProgressBit(id: string, bit: number) {
  const current = await getProgress(id);
  await supabaseAdmin
    .from("sessions")
    .update({ progress: (current | bit) })
    .eq("id", id);
}

// GET /api/sessions/[id]/signal — poll for current state
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const p = await getProgress(id);
  return NextResponse.json({
    leftConnected:  Boolean(p & 1),
    rightConnected: Boolean(p & 2),
    startSignal:    Boolean(p & 4),
    stopSignal:     Boolean(p & 8),
  });
}

// POST /api/sessions/[id]/signal — set a signal bit
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const { action, side } = await req.json();

  if (action === "connect") {
    await setProgressBit(id, side === "left" ? 1 : 2);
  } else if (action === "start") {
    await setProgressBit(id, 4);
  } else if (action === "stop") {
    await setProgressBit(id, 8);
  } else if (action === "reset") {
    // Clear signal bits before upload (keep connection bits)
    const current = await getProgress(id);
    await supabaseAdmin
      .from("sessions")
      .update({ progress: current & ~12 }) // clear bits 2 and 3
      .eq("id", id);
  }

  return NextResponse.json({ ok: true });
}
