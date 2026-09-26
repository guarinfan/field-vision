/**
 * Phone-to-phone signaling via DB bitmask + sync timestamp.
 *
 * `progress` bitmask (bits 0-3):
 *   bit 0 (1)  — left phone connected
 *   bit 1 (2)  — right phone connected
 *   bit 2 (4)  — start recording signal (legacy manual start)
 *   bit 3 (8)  — stop recording signal  (legacy manual stop)
 *
 * `error_message` is borrowed during recording phase (before processing starts)
 * to store the auto-sync countdown timestamp as JSON: {"_sync":{"start_at":ms}}
 * It is overwritten by real errors only after status becomes "processing".
 */

import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";

const COUNTDOWN_MS = 3 * 60 * 1000; // 3 minutes

async function getRow(id: string) {
  const { data } = await supabaseAdmin
    .from("sessions")
    .select("progress, error_message")
    .eq("id", id)
    .single();
  return data as { progress: number; error_message: string | null } | null;
}

async function setProgressBit(id: string, bit: number) {
  const row = await getRow(id);
  const current = row?.progress ?? 0;
  await supabaseAdmin
    .from("sessions")
    .update({ progress: current | bit })
    .eq("id", id);
}

// GET — poll for current sync state
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const row = await getRow(id);
  const p = row?.progress ?? 0;

  let syncStartAt: number | null = null;
  try {
    const msg = row?.error_message ?? "";
    if (msg.startsWith('{"_sync":')) {
      syncStartAt = JSON.parse(msg)._sync?.start_at ?? null;
    }
  } catch { /* ignore */ }

  return NextResponse.json({
    leftConnected:  Boolean(p & 1),
    rightConnected: Boolean(p & 2),
    startSignal:    Boolean(p & 4),
    stopSignal:     Boolean(p & 8),
    syncStartAt,
  });
}

// POST — set a signal bit or write the sync countdown timestamp
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const { action, side } = await req.json();

  if (action === "connect") {
    await setProgressBit(id, side === "left" ? 1 : 2);
  } else if (action === "sync_start") {
    // Left (coordinator) phone calls this once both are connected.
    // Stores start_at = now + 3 min so both phones can count down to the same moment.
    const start_at = Date.now() + COUNTDOWN_MS;
    await supabaseAdmin
      .from("sessions")
      .update({ error_message: JSON.stringify({ _sync: { start_at } }) })
      .eq("id", id);
  } else if (action === "start") {
    await setProgressBit(id, 4);
  } else if (action === "stop") {
    await setProgressBit(id, 8);
  } else if (action === "reset") {
    const row = await getRow(id);
    const current = row?.progress ?? 0;
    await supabaseAdmin
      .from("sessions")
      .update({ progress: current & ~12 }) // clear bits 2 and 3
      .eq("id", id);
  } else if (action === "clear_sync") {
    // Called after recording starts to clean up borrowed error_message field
    const row = await getRow(id);
    const msg = row?.error_message ?? "";
    if (msg.startsWith('{"_sync":')) {
      await supabaseAdmin
        .from("sessions")
        .update({ error_message: null })
        .eq("id", id);
    }
  }

  return NextResponse.json({ ok: true });
}
