/**
 * Phone-to-phone signaling for 3-phone recording system.
 *
 * `progress` bitmask (bits 0-1):
 *   bit 0 (1)  — left camera phone connected
 *   bit 1 (2)  — right camera phone connected
 *
 * `error_message` is borrowed during recording phase to store sync state:
 *   {"_sync": {"start_at": <unix ms + 3s buffer>, "stopped": true|false}}
 *
 * Overwritten by real error strings only after status becomes "processing".
 */

import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";

const START_BUFFER_MS = 3000; // cameras get 3 s advance notice before recording starts

async function getRow(id: string) {
  const { data } = await supabaseAdmin
    .from("sessions")
    .select("progress, error_message")
    .eq("id", id)
    .single();
  return data as { progress: number; error_message: string | null } | null;
}

function parseSync(msg: string | null): Record<string, unknown> {
  try {
    if (msg?.startsWith('{"_sync":')) return (JSON.parse(msg)._sync as Record<string, unknown>) ?? {};
  } catch { /* ignore */ }
  return {};
}

async function writeSync(id: string, patch: Record<string, unknown>) {
  const row = await getRow(id);
  const existing = parseSync(row?.error_message ?? null);
  await supabaseAdmin
    .from("sessions")
    .update({ error_message: JSON.stringify({ _sync: { ...existing, ...patch } }) })
    .eq("id", id);
}

// GET — poll current sync state
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const row  = await getRow(id);
  const p    = row?.progress ?? 0;
  const sync = parseSync(row?.error_message ?? null);

  return NextResponse.json({
    leftConnected:  Boolean(p & 1),
    rightConnected: Boolean(p & 2),
    startAt:        (sync.start_at as number) ?? null,   // unix ms when recording should start
    stopped:        Boolean(sync.stopped),
  });
}

// POST — signal actions from coordinator or camera phones
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const { action, side } = await req.json();

  if (action === "connect") {
    const row     = await getRow(id);
    const current = row?.progress ?? 0;
    const bit     = side === "left" ? 1 : 2;
    await supabaseAdmin.from("sessions").update({ progress: current | bit }).eq("id", id);

  } else if (action === "start") {
    // Coordinator hits Start — give cameras a 3 s head-start to see the signal
    await writeSync(id, { start_at: Date.now() + START_BUFFER_MS, stopped: false });

  } else if (action === "stop") {
    await writeSync(id, { stopped: true });

  } else if (action === "reset") {
    // Clear all state for a fresh recording attempt
    await supabaseAdmin
      .from("sessions")
      .update({ progress: 0, error_message: null })
      .eq("id", id);
  }

  return NextResponse.json({ ok: true });
}
