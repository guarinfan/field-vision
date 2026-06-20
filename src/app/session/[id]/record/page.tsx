"use client";

import { useEffect, useRef, useState, useCallback, Suspense } from "react";
import { useParams, useSearchParams } from "next/navigation";
import { supabase } from "@/lib/supabase";
import { Loader2, Upload, CheckCircle2 } from "lucide-react";
import { cn } from "@/lib/cn";
import { QRCodeSVG } from "qrcode.react";

type Side = "left" | "right";
type Phase =
  | "waiting-peer"   // showing QR, camera not open yet
  | "opening-camera" // peer connected, opening camera
  | "ready"          // camera open, waiting to record
  | "recording"
  | "uploading"
  | "done"
  | "error";

// Camera constraints broadcast to both phones so settings are identical
const SHARED_CAMERA_CONSTRAINTS: MediaStreamConstraints = {
  video: {
    facingMode: "environment",
    width: { ideal: 1920 },
    height: { ideal: 1080 },
    frameRate: { ideal: 30 },
  },
  audio: true,
};

// Advanced camera lock applied after stream opens (Android Chrome)
const ADVANCED_LOCK = [{
  whiteBalanceMode: "manual",
  colorTemperature: 5500,
  exposureMode: "manual",
  iso: 100,
  zoom: 1.0,
}];

export default function RecordPage() {
  return (
    <Suspense fallback={
      <div className="min-h-screen bg-black flex items-center justify-center">
        <Loader2 className="text-green-400 animate-spin" size={32} />
      </div>
    }>
      <RecordPageInner />
    </Suspense>
  );
}

function RecordPageInner() {
  const { id } = useParams<{ id: string }>();
  const searchParams = useSearchParams();
  const side = (searchParams.get("side") ?? "left") as Side;
  const otherSide: Side = side === "left" ? "right" : "left";

  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const channelRef = useRef<ReturnType<typeof supabase.channel> | null>(null);

  const [phase, setPhase] = useState<Phase>("waiting-peer");
  const phaseRef = useRef<Phase>("waiting-peer");
  const setPhaseSync = (p: Phase) => { phaseRef.current = p; setPhase(p); };
  const [peerPhase, setPeerPhase] = useState<Phase | null>(null);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [recordingSeconds, setRecordingSeconds] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [origin, setOrigin] = useState("");

  useEffect(() => { setOrigin(window.location.origin); }, []);

  // Update our presence state (peers see this immediately, even if they join later)
  const broadcast = useCallback((p: Phase) => {
    channelRef.current?.track({ side, phase: p });
  }, [side]);

  // Open camera with locked settings (identical on both phones)
  const openCamera = useCallback(async () => {
    setPhaseSync("opening-camera");
    try {
      const stream = await navigator.mediaDevices.getUserMedia(SHARED_CAMERA_CONSTRAINTS);
      streamRef.current = stream;

      const videoTrack = stream.getVideoTracks()[0];
      if (videoTrack) {
        try {
          await videoTrack.applyConstraints({ advanced: ADVANCED_LOCK } as any);
        } catch {
          // Advanced lock not supported on this device — continue anyway
        }
      }

      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        videoRef.current.play();
      }

      setPhaseSync("ready");
      broadcast("ready");
    } catch (e: any) {
      setError(`Camera error: ${e.message}`);
      setPhaseSync("error");
    }
  }, [broadcast]);

  // Start recording
  const startRecording = useCallback(() => {
    const stream = streamRef.current;
    if (!stream) return;

    chunksRef.current = [];
    const mimeType = MediaRecorder.isTypeSupported("video/mp4;codecs=h264")
      ? "video/mp4;codecs=h264"
      : MediaRecorder.isTypeSupported("video/webm;codecs=h264")
      ? "video/webm;codecs=h264"
      : "video/webm";

    const recorder = new MediaRecorder(stream, {
      mimeType,
      videoBitsPerSecond: 8_000_000,
    });
    recorder.ondataavailable = (e) => { if (e.data.size > 0) chunksRef.current.push(e.data); };
    recorder.onstop = () => uploadRecording();
    recorder.start(1000);
    recorderRef.current = recorder;

    setPhaseSync("recording");
    broadcast("recording");
    setRecordingSeconds(0);
    timerRef.current = setInterval(() => setRecordingSeconds((s) => s + 1), 1000);
  }, [broadcast]);

  const stopRecording = useCallback(() => {
    if (timerRef.current) clearInterval(timerRef.current);
    recorderRef.current?.stop();
  }, []);

  const uploadRecording = useCallback(async () => {
    setPhaseSync("uploading");
    broadcast("uploading");

    const chunks = chunksRef.current;
    if (!chunks.length) { setError("No video recorded"); setPhase("error"); return; }

    const blob = new Blob(chunks, { type: chunks[0].type });

    try {
      const res = await fetch("/api/upload", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ session_id: id, side }),
      });
      const { url } = await res.json();

      await new Promise<void>((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open("PUT", url);
        xhr.setRequestHeader("Content-Type", blob.type);
        xhr.upload.onprogress = (e) => {
          if (e.lengthComputable) setUploadProgress(Math.round((e.loaded / e.total) * 100));
        };
        xhr.onload = () => (xhr.status < 300 ? resolve() : reject(new Error(`${xhr.status}`)));
        xhr.onerror = () => reject(new Error("Upload error"));
        xhr.send(blob);
      });

      await fetch(`/api/sessions/${id}/upload-done`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ side }),
      });

      setPhaseSync("done");
      broadcast("done");
    } catch (e: any) {
      setError(e.message);
      setPhaseSync("error");
    }
  }, [id, side, broadcast]);

  // Supabase Realtime channel — uses Presence so late joiners get state immediately
  useEffect(() => {
    const channel = supabase.channel(`recording:${id}`, {
      config: { presence: { key: side } },
    });

    // Presence: fires whenever anyone joins/leaves/updates
    channel.on("presence", { event: "sync" }, () => {
      const state = channel.presenceState<{ phase: Phase }>();
      const peers = Object.entries(state).filter(([k]) => k !== side);
      if (peers.length === 0) return;
      const [[, presences]] = peers;
      const peerP = (presences[0] as any).phase as Phase;
      setPeerPhase(peerP);

      if (peerP === "waiting-peer" && phaseRef.current === "waiting-peer") {
        openCamera();
      }
    });

    // Broadcast for start/stop control signals
    channel.on("broadcast", { event: "control" }, ({ payload }) => {
      if (payload.action === "start") startRecording();
      if (payload.action === "stop") stopRecording();
    });

    channel.subscribe(async (status) => {
      if (status === "SUBSCRIBED") {
        await channel.track({ side, phase: "waiting-peer" });
      }
    });

    channelRef.current = channel;
    return () => { supabase.removeChannel(channel); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  const sendControl = (action: "start" | "stop") => {
    channelRef.current?.send({
      type: "broadcast",
      event: "control",
      payload: { action },
    });
    if (action === "start") startRecording();
    if (action === "stop") stopRecording();
  };

  const fmt = (s: number) =>
    `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;

  const peerLabel = peerPhase
    ? { "waiting-peer": "Waiting", "opening-camera": "Opening camera…", ready: "Ready", recording: "Recording", uploading: "Uploading…", done: "Done", error: "Error" }[peerPhase]
    : null;

  // ── Phase: waiting for peer ───────────────────────────────────────────────
  if (phase === "waiting-peer") {
    const qrUrl = origin ? `${origin}/session/${id}/record?side=${otherSide}` : "";
    return (
      <div className="min-h-screen bg-black flex flex-col items-center justify-center px-6 py-12 gap-6">
        <div className="text-center">
          <p className="text-xs text-gray-500 uppercase tracking-widest mb-1">FieldVision</p>
          <h1 className="text-white text-xl font-bold capitalize">{side} Camera</h1>
          <p className="text-gray-500 text-sm mt-1">Your side is set. Have the other phone scan this:</p>
        </div>

        {qrUrl ? (
          <div className="bg-white p-5 rounded-3xl shadow-xl">
            <QRCodeSVG value={qrUrl} size={220} bgColor="#ffffff" fgColor="#000000" />
          </div>
        ) : (
          <Loader2 className="text-green-400 animate-spin" size={32} />
        )}

        <div className="flex items-center gap-2 text-gray-500 text-sm">
          <span className="capitalize font-semibold text-white">{otherSide} camera</span>
          <span>·</span>
          <Loader2 size={14} className="animate-spin text-gray-600" />
          <span>Waiting to connect…</span>
        </div>

        <p className="text-gray-700 text-xs text-center max-w-xs">
          Both cameras will open simultaneously once the second phone scans and joins.
        </p>
      </div>
    );
  }

  // ── Phase: opening camera ─────────────────────────────────────────────────
  if (phase === "opening-camera") {
    return (
      <div className="min-h-screen bg-black flex flex-col items-center justify-center gap-4">
        <Loader2 className="text-green-400 animate-spin" size={40} />
        <p className="text-white font-semibold">Both connected — opening camera…</p>
      </div>
    );
  }

  // ── Phase: camera open (ready / recording / uploading / done / error) ─────
  return (
    <div className="min-h-screen bg-black flex flex-col">
      {/* Header */}
      <div className="flex items-center justify-between px-4 pt-safe pt-4 pb-2">
        <div>
          <p className="text-xs text-gray-600 uppercase tracking-widest">FieldVision</p>
          <h1 className="text-white font-bold text-lg capitalize">{side} Camera</h1>
        </div>
        {peerLabel && (
          <div className={cn(
            "flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium border",
            peerPhase === "ready" || peerPhase === "recording"
              ? "bg-green-900/40 text-green-400 border-green-800/40"
              : "bg-gray-800 text-gray-400 border-gray-700"
          )}>
            <span className={cn(
              "w-1.5 h-1.5 rounded-full",
              peerPhase === "recording" ? "bg-red-500 animate-pulse" :
              peerPhase === "ready" ? "bg-green-500" : "bg-gray-500"
            )} />
            <span className="capitalize">{otherSide}:</span>
            <span>{peerLabel}</span>
          </div>
        )}
      </div>

      {/* Camera preview */}
      <div className="relative flex-1 bg-black overflow-hidden">
        <video
          ref={videoRef}
          className="w-full h-full object-cover"
          muted
          playsInline
          autoPlay
        />

        {/* Recording timer */}
        {phase === "recording" && (
          <div className="absolute top-4 left-1/2 -translate-x-1/2 flex items-center gap-2 bg-black/70 rounded-full px-4 py-2">
            <span className="w-2 h-2 rounded-full bg-red-500 animate-pulse" />
            <span className="text-white font-mono text-lg">{fmt(recordingSeconds)}</span>
          </div>
        )}

        {/* Upload overlay */}
        {phase === "uploading" && (
          <div className="absolute inset-0 bg-black/85 flex flex-col items-center justify-center gap-4">
            <Upload size={40} className="text-green-400" />
            <p className="text-white text-lg font-semibold">Uploading…</p>
            <div className="w-64 bg-gray-800 rounded-full h-2">
              <div className="bg-green-500 h-2 rounded-full transition-all" style={{ width: `${uploadProgress}%` }} />
            </div>
            <p className="text-gray-400 text-sm">{uploadProgress}%</p>
          </div>
        )}

        {/* Done overlay */}
        {phase === "done" && (
          <div className="absolute inset-0 bg-black/85 flex flex-col items-center justify-center gap-4">
            <CheckCircle2 size={48} className="text-green-400" />
            <p className="text-white text-lg font-semibold">Upload complete!</p>
            <p className="text-gray-400 text-sm text-center px-8">
              Processing begins once both cameras have uploaded.
            </p>
          </div>
        )}

        {/* Error overlay */}
        {phase === "error" && (
          <div className="absolute inset-0 bg-black/85 flex flex-col items-center justify-center gap-3 p-6">
            <p className="text-red-400 font-semibold text-center">{error}</p>
            <button onClick={openCamera} className="bg-white text-black rounded-full px-6 py-2 text-sm font-medium">
              Retry
            </button>
          </div>
        )}
      </div>

      {/* Bottom controls */}
      <div className="px-6 pb-10 pt-4 bg-black">
        {phase === "ready" && (
          <button
            onClick={() => sendControl("start")}
            className="w-full bg-red-500 active:bg-red-700 text-white font-bold py-5 rounded-2xl text-lg flex items-center justify-center gap-3"
          >
            <span className="w-4 h-4 rounded-full bg-white" />
            Start Recording
          </button>
        )}

        {phase === "recording" && (
          <button
            onClick={() => sendControl("stop")}
            className="w-full bg-white active:bg-gray-200 text-black font-bold py-5 rounded-2xl text-lg flex items-center justify-center gap-3"
          >
            <span className="w-4 h-4 rounded-sm bg-black" />
            Stop & Upload
          </button>
        )}
      </div>
    </div>
  );
}
