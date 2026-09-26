"use client";

import { useEffect, useRef, useState, Suspense } from "react";
import { useParams } from "next/navigation";
import { Loader2, Radio, Square, RotateCcw, CheckCircle2 } from "lucide-react";
import { cn } from "@/lib/cn";
import { QRCodeSVG } from "qrcode.react";

type RecPhase = "waiting" | "ready" | "starting" | "recording" | "stopped";

const POLL_MS       = 1000;
const START_DELAY   = 3000; // ms cameras get as head-start

function fmt(totalSec: number) {
  const s = Math.max(0, Math.floor(totalSec));
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

export default function ControlPage() {
  return (
    <Suspense fallback={<div className="min-h-screen bg-black flex items-center justify-center"><Loader2 className="text-green-400 animate-spin" size={32} /></div>}>
      <ControlPageInner />
    </Suspense>
  );
}

function ControlPageInner() {
  const { id } = useParams<{ id: string }>();

  const [leftConnected,  setLeftConnected]  = useState(false);
  const [rightConnected, setRightConnected] = useState(false);
  const [phase,          setPhase]          = useState<RecPhase>("waiting");
  const [elapsedSecs,    setElapsedSecs]    = useState(0);
  const [origin,         setOrigin]         = useState("");
  const [showStartSheet, setShowStartSheet] = useState(false);

  const recordingTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const startedAtRef      = useRef<number>(0);
  const seenBothRef       = useRef(false);
  const seenStartRef      = useRef(false);
  const seenStopRef       = useRef(false);

  useEffect(() => { setOrigin(window.location.origin); }, []);

  // ── Poll signal ───────────────────────────────────────────────────────────
  useEffect(() => {
    if (!id) return;
    let stopped = false;

    const tick = async () => {
      if (stopped) return;
      try {
        const res = await fetch(`/api/sessions/${id}/signal`);
        const s   = await res.json();
        setLeftConnected(s.leftConnected);
        setRightConnected(s.rightConnected);

        // Show start prompt the first time both cameras are connected
        const both = s.leftConnected && s.rightConnected;
        if (both && !seenBothRef.current && phase === "waiting") {
          seenBothRef.current = true;
          setPhase("ready");
          setShowStartSheet(true);
        }

        // Restore UI if coordinator refreshed during an active recording
        if (s.startAt && !s.stopped && !seenStartRef.current) {
          seenStartRef.current = true;
          setShowStartSheet(false);
          const delay = s.startAt - Date.now();
          if (delay > 0) { setPhase("starting"); setTimeout(() => beginTimer(), delay); }
          else beginTimer();
        }
        if (s.stopped && !seenStopRef.current) {
          seenStopRef.current = true;
          endTimer();
        }
      } catch { /* blip */ }
    };

    const interval = setInterval(tick, POLL_MS);
    tick();
    return () => { stopped = true; clearInterval(interval); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, phase]);

  function beginTimer() {
    setPhase("recording");
    startedAtRef.current = Date.now();
    setElapsedSecs(0);
    if (recordingTimerRef.current) clearInterval(recordingTimerRef.current);
    recordingTimerRef.current = setInterval(() => {
      setElapsedSecs(Math.floor((Date.now() - startedAtRef.current) / 1000));
    }, 500);
  }

  function endTimer() {
    if (recordingTimerRef.current) { clearInterval(recordingTimerRef.current); recordingTimerRef.current = null; }
    setPhase("stopped");
  }

  const handleStart = async () => {
    seenStartRef.current = true;
    setShowStartSheet(false);
    setPhase("starting");
    await fetch(`/api/sessions/${id}/signal`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "start" }),
    });
    setTimeout(() => beginTimer(), START_DELAY);
  };

  const handleStop = async () => {
    if (phase !== "recording") return;
    endTimer();
    seenStopRef.current = true;
    await fetch(`/api/sessions/${id}/signal`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "stop" }),
    });
  };

  const handleReset = async () => {
    seenBothRef.current  = false;
    seenStartRef.current = false;
    seenStopRef.current  = false;
    setPhase("waiting");
    setElapsedSecs(0);
    setShowStartSheet(false);
    await fetch(`/api/sessions/${id}/signal`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "reset" }),
    });
  };

  const qrUrl      = origin && id ? `${origin}/session/${id}/record` : "";
  const bothConnected = leftConnected && rightConnected;

  return (
    <div className="min-h-screen bg-black px-5 py-8 flex flex-col gap-6 max-w-sm mx-auto">
      {/* Header */}
      <div>
        <p className="text-xs text-green-600 uppercase tracking-widest font-semibold">FieldVision · Coordinator</p>
        <h1 className="text-white text-xl font-bold mt-1">Recording Session</h1>
        <p className="text-gray-700 text-xs mt-0.5 font-mono">{id?.slice(0, 16)}…</p>
      </div>

      {/* Camera status chips */}
      <div className="grid grid-cols-2 gap-3">
        {(["left", "right"] as const).map(side => {
          const connected = side === "left" ? leftConnected : rightConnected;
          return (
            <div key={side} className={cn("rounded-xl border p-4 flex flex-col items-center gap-2 transition-all duration-300", connected ? "border-green-500/60 bg-green-900/20" : "border-green-900/30 bg-black")}>
              <span className={cn("w-3 h-3 rounded-full transition-colors", connected ? "bg-green-400" : "bg-gray-700")} />
              <span className="text-xs font-semibold uppercase tracking-widest capitalize text-green-300">{side}</span>
              <span className={cn("text-xs", connected ? "text-green-500" : "text-gray-600")}>{connected ? "Connected" : "Waiting…"}</span>
            </div>
          );
        })}
      </div>

      {/* QR code — shown while waiting/ready */}
      {(phase === "waiting" || phase === "ready") && (
        <div className="bg-green-950/20 border border-green-900/40 rounded-2xl p-5">
          <p className="text-xs text-green-500 font-semibold uppercase tracking-widest mb-3 text-center">
            Camera phones scan this QR
          </p>
          {qrUrl ? (
            <div className="flex justify-center">
              <div className="bg-white p-3 rounded-xl">
                <QRCodeSVG value={qrUrl} size={190} bgColor="#ffffff" fgColor="#000000" />
              </div>
            </div>
          ) : (
            <div className="flex justify-center items-center h-[190px]"><Loader2 className="text-green-700 animate-spin" size={24} /></div>
          )}
          <p className="text-xs text-gray-600 text-center mt-3">Each phone picks LEFT or RIGHT after scanning</p>
        </div>
      )}

      {/* Starting indicator */}
      {phase === "starting" && (
        <div className="flex flex-col items-center gap-3 py-6">
          <Loader2 className="text-yellow-400 animate-spin" size={36} />
          <p className="text-yellow-300 font-semibold">Starting in 3 s…</p>
          <p className="text-yellow-700 text-sm">Both cameras are arming</p>
        </div>
      )}

      {/* Recording */}
      {phase === "recording" && (
        <div className="flex flex-col gap-4">
          <div className="rounded-2xl bg-red-950/30 border border-red-800/40 py-6 flex flex-col items-center gap-2">
            <span className="w-3 h-3 rounded-full bg-red-500 animate-pulse" />
            <span className="text-red-300 font-mono font-bold" style={{ fontSize: "4rem", lineHeight: 1 }}>{fmt(elapsedSecs)}</span>
            <span className="text-red-700 text-xs uppercase tracking-widest">Recording</span>
          </div>
          <button onClick={handleStop} className="w-full py-6 rounded-2xl bg-white active:bg-gray-200 text-black text-xl font-bold flex items-center justify-center gap-3">
            <Square size={22} fill="black" /> Stop Recording
          </button>
        </div>
      )}

      {/* Stopped */}
      {phase === "stopped" && (
        <div className="flex flex-col gap-4">
          <div className="rounded-2xl bg-green-950/30 border border-green-700/40 py-6 flex flex-col items-center gap-3">
            <CheckCircle2 size={36} className="text-green-400" />
            <p className="text-green-300 font-semibold text-lg">Session ended</p>
            <p className="text-green-700 text-sm text-center">Camera phones will show an upload prompt.</p>
          </div>
          <button onClick={handleReset} className="w-full py-4 rounded-2xl bg-gray-900 active:bg-gray-800 border border-gray-700 text-gray-300 font-semibold flex items-center justify-center gap-2">
            <RotateCcw size={16} /> Record again
          </button>
        </div>
      )}

      {/* Instructions (waiting only) */}
      {phase === "waiting" && (
        <div className="bg-green-950/10 border border-green-900/20 rounded-xl p-4 text-sm text-gray-600 space-y-1.5">
          <p>1. Both camera phones scan the QR above</p>
          <p>2. Each picks LEFT or RIGHT</p>
          <p>3. Mount on tripod, raise to height, lock</p>
          <p>4. Tap <span className="text-white">Start Recording</span> when ready</p>
        </div>
      )}

      {/* ── Bottom sheet: both cameras ready ────────────────────────────────── */}
      {showStartSheet && (
        <div className="fixed inset-0 z-50 flex items-end justify-center">
          {/* Backdrop */}
          <div className="absolute inset-0 bg-black/60" onClick={() => setShowStartSheet(false)} />
          {/* Sheet */}
          <div className="relative w-full max-w-sm bg-gray-950 border border-green-800/60 rounded-t-3xl px-6 pt-6 pb-10 z-10">
            <div className="w-10 h-1 bg-gray-700 rounded-full mx-auto mb-6" />
            <div className="flex items-center gap-3 mb-2">
              <CheckCircle2 size={28} className="text-green-400 shrink-0" />
              <h2 className="text-white text-xl font-bold">Both cameras ready</h2>
            </div>
            <p className="text-gray-500 text-sm mb-2">Left and right cameras are connected and in wide-lens mode.</p>
            <div className="flex items-center gap-3 mb-6 text-sm">
              <span className="flex items-center gap-1.5 text-green-400"><span className="w-2 h-2 rounded-full bg-green-400" /> Left camera</span>
              <span className="flex items-center gap-1.5 text-green-400"><span className="w-2 h-2 rounded-full bg-green-400" /> Right camera</span>
            </div>
            <p className="text-gray-500 text-xs mb-6">Raise the tripod to the desired height, aim at the center circle, and lock it in place before starting.</p>
            <button onClick={handleStart} className="w-full py-5 rounded-2xl bg-red-500 active:bg-red-600 text-white text-xl font-bold flex items-center justify-center gap-3">
              <Radio size={22} /> Start Recording
            </button>
            <button onClick={() => setShowStartSheet(false)} className="w-full py-3 mt-3 text-gray-600 text-sm font-medium">
              Not yet — go back
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
