"use client";

import { useEffect, useRef, useState, Suspense } from "react";
import { useParams } from "next/navigation";
import { Loader2, Radio, Square, RotateCcw } from "lucide-react";
import { cn } from "@/lib/cn";
import { QRCodeSVG } from "qrcode.react";

type RecPhase = "idle" | "starting" | "recording" | "stopped";

const POLL_MS = 1000;

function fmt(totalSec: number) {
  const s = Math.max(0, Math.floor(totalSec));
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

export default function ControlPage() {
  return (
    <Suspense
      fallback={
        <div className="min-h-screen bg-black flex items-center justify-center">
          <Loader2 className="text-green-400 animate-spin" size={32} />
        </div>
      }
    >
      <ControlPageInner />
    </Suspense>
  );
}

function ControlPageInner() {
  const { id } = useParams<{ id: string }>();

  const [leftConnected,  setLeftConnected]  = useState(false);
  const [rightConnected, setRightConnected] = useState(false);
  const [phase,          setPhase]          = useState<RecPhase>("idle");
  const [elapsedSecs,    setElapsedSecs]    = useState(0);
  const [origin,         setOrigin]         = useState("");

  const recordingTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const startedAtRef      = useRef<number>(0);
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

        // Reflect stop signal back to coordinator UI
        if (s.stopped && !seenStopRef.current) {
          seenStopRef.current = true;
          if (recordingTimerRef.current) {
            clearInterval(recordingTimerRef.current);
            recordingTimerRef.current = null;
          }
          setPhase("stopped");
        }

        // If coordinator was refreshed during an active recording, restore UI
        if (s.startAt && !s.stopped && !seenStartRef.current) {
          seenStartRef.current = true;
          const startDelay = s.startAt - Date.now();
          if (startDelay > 0) {
            setPhase("starting");
            setTimeout(() => beginRecordingTimer(), startDelay);
          } else {
            beginRecordingTimer();
          }
        }
      } catch { /* ignore */ }
    };

    const interval = setInterval(tick, POLL_MS);
    tick();
    return () => { stopped = true; clearInterval(interval); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  function beginRecordingTimer() {
    setPhase("recording");
    startedAtRef.current = Date.now();
    setElapsedSecs(0);
    if (recordingTimerRef.current) clearInterval(recordingTimerRef.current);
    recordingTimerRef.current = setInterval(() => {
      setElapsedSecs(Math.floor((Date.now() - startedAtRef.current) / 1000));
    }, 500);
  }

  const handleStart = async () => {
    if (phase !== "idle") return;
    seenStartRef.current = true;
    seenStopRef.current  = false;
    setPhase("starting");
    await fetch(`/api/sessions/${id}/signal`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "start" }),
    });
    // UI transitions to "recording" after 3 s buffer (matching START_BUFFER_MS)
    setTimeout(() => beginRecordingTimer(), 3000);
  };

  const handleStop = async () => {
    if (phase !== "recording") return;
    if (recordingTimerRef.current) {
      clearInterval(recordingTimerRef.current);
      recordingTimerRef.current = null;
    }
    setPhase("stopped");
    seenStopRef.current = true;
    await fetch(`/api/sessions/${id}/signal`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "stop" }),
    });
  };

  const handleReset = async () => {
    seenStartRef.current = false;
    seenStopRef.current  = false;
    setPhase("idle");
    setElapsedSecs(0);
    await fetch(`/api/sessions/${id}/signal`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "reset" }),
    });
  };

  const bothConnected = leftConnected && rightConnected;
  const qrUrl = origin && id ? `${origin}/session/${id}/record` : "";

  return (
    <div className="min-h-screen bg-black px-5 py-8 flex flex-col gap-6 max-w-sm mx-auto">
      {/* Header */}
      <div>
        <p className="text-xs text-green-600 uppercase tracking-widest font-semibold">FieldVision · Coordinator</p>
        <h1 className="text-white text-xl font-bold mt-1">Recording Control</h1>
        <p className="text-gray-600 text-xs mt-0.5 font-mono">{id.slice(0, 16)}…</p>
      </div>

      {/* QR code */}
      <div className="bg-green-950/30 border border-green-900/40 rounded-2xl p-5">
        <p className="text-xs text-green-500 font-semibold uppercase tracking-widest mb-3 text-center">
          Camera phones scan this
        </p>
        {qrUrl ? (
          <div className="flex justify-center">
            <div className="bg-white p-3 rounded-xl">
              <QRCodeSVG value={qrUrl} size={180} bgColor="#ffffff" fgColor="#000000" />
            </div>
          </div>
        ) : (
          <div className="flex justify-center items-center h-[180px]">
            <Loader2 className="text-green-700 animate-spin" size={24} />
          </div>
        )}
        <p className="text-xs text-gray-600 text-center mt-3">
          Each phone picks LEFT or RIGHT after scanning
        </p>
      </div>

      {/* Camera status */}
      <div className="grid grid-cols-2 gap-3">
        {(["left", "right"] as const).map((side) => {
          const connected = side === "left" ? leftConnected : rightConnected;
          return (
            <div
              key={side}
              className={cn(
                "rounded-xl border p-4 flex flex-col items-center gap-2 transition-colors",
                connected
                  ? "border-green-500/50 bg-green-900/20"
                  : "border-green-900/30 bg-black"
              )}
            >
              <span className={cn(
                "w-3 h-3 rounded-full",
                connected ? "bg-green-400" : "bg-gray-700"
              )} />
              <span className="text-xs font-semibold uppercase tracking-widest capitalize text-green-300">
                {side}
              </span>
              <span className={cn("text-xs", connected ? "text-green-500" : "text-gray-600")}>
                {connected ? "Connected" : "Waiting…"}
              </span>
            </div>
          );
        })}
      </div>

      {/* Recording controls */}
      <div className="flex flex-col gap-3">
        {phase === "idle" && (
          <button
            onClick={handleStart}
            disabled={!bothConnected}
            className={cn(
              "w-full py-6 rounded-2xl text-xl font-bold flex items-center justify-center gap-3 transition-all",
              bothConnected
                ? "bg-red-500 active:bg-red-600 text-white"
                : "bg-gray-900 text-gray-700 border border-gray-800 cursor-not-allowed"
            )}
          >
            <Radio size={24} />
            {bothConnected ? "Start Recording" : "Waiting for cameras…"}
          </button>
        )}

        {phase === "starting" && (
          <div className="w-full py-6 rounded-2xl bg-yellow-900/30 border border-yellow-700/40 flex flex-col items-center gap-2">
            <Loader2 className="text-yellow-400 animate-spin" size={28} />
            <p className="text-yellow-300 font-semibold">Starting in 3 s…</p>
            <p className="text-yellow-700 text-xs">Cameras are arming</p>
          </div>
        )}

        {phase === "recording" && (
          <>
            <div className="w-full py-4 rounded-2xl bg-red-950/30 border border-red-800/40 flex items-center justify-center gap-3">
              <span className="w-3 h-3 rounded-full bg-red-500 animate-pulse" />
              <span className="text-red-300 font-mono text-3xl font-bold">{fmt(elapsedSecs)}</span>
            </div>
            <button
              onClick={handleStop}
              className="w-full py-6 rounded-2xl bg-white active:bg-gray-200 text-black text-xl font-bold flex items-center justify-center gap-3"
            >
              <Square size={22} fill="black" />
              Stop Recording
            </button>
          </>
        )}

        {phase === "stopped" && (
          <>
            <div className="w-full py-4 rounded-2xl bg-green-950/30 border border-green-700/40 text-center">
              <p className="text-green-400 font-semibold">Recording stopped</p>
              <p className="text-green-700 text-sm mt-1">Camera phones are uploading…</p>
            </div>
            <button
              onClick={handleReset}
              className="w-full py-5 rounded-2xl bg-gray-900 active:bg-gray-800 border border-gray-700 text-gray-300 font-semibold flex items-center justify-center gap-2"
            >
              <RotateCcw size={16} />
              Record again
            </button>
          </>
        )}
      </div>

      {/* Instructions */}
      {phase === "idle" && (
        <div className="bg-green-950/20 border border-green-900/30 rounded-xl p-4 text-sm text-gray-500 space-y-1.5">
          <p>1. Both camera phones scan the QR above</p>
          <p>2. Each picks LEFT or RIGHT camera</p>
          <p>3. Both mount on tripod in wide-lens mode</p>
          <p>4. Raise tripod to desired height and lock</p>
          <p>5. Press <span className="text-white">Start Recording</span> when ready</p>
        </div>
      )}
    </div>
  );
}
