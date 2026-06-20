"use client";

import { useEffect, useRef, useState, useCallback, Suspense } from "react";
import { useParams, useSearchParams } from "next/navigation";
import { Loader2, Upload, CheckCircle2 } from "lucide-react";
import { cn } from "@/lib/cn";
import { QRCodeSVG } from "qrcode.react";

type Side = "left" | "right";
type Phase = "ready" | "recording" | "uploading" | "done" | "error";

const CAMERA_CONSTRAINTS: MediaStreamConstraints = {
  video: { facingMode: "environment", width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 30 } },
  audio: true,
};
// Only lock white balance — manual exposure mode makes Phone 2 dark
const ADVANCED_LOCK = [{ whiteBalanceMode: "manual", colorTemperature: 5500, zoom: 1.0 }];

export default function RecordPage() {
  return (
    <Suspense fallback={<div className="min-h-screen bg-black flex items-center justify-center"><Loader2 className="text-green-400 animate-spin" size={32} /></div>}>
      <RecordPageInner />
    </Suspense>
  );
}

function RecordPageInner() {
  const { id } = useParams<{ id: string }>();
  const searchParams = useSearchParams();
  const side = (searchParams.get("side") ?? "left") as Side;
  // "host" = the phone that created the session; shows QR. Other phone just waits.
  const isHost = searchParams.get("host") === "1";
  const otherSide: Side = side === "left" ? "right" : "left";

  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const [phase, setPhase] = useState<Phase>("ready");
  const [peerConnected, setPeerConnected] = useState(false);
  const [cameraReady, setCameraReady] = useState(false);
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [recordingSeconds, setRecordingSeconds] = useState(0);
  const [showUploadPrompt, setShowUploadPrompt] = useState(false);
  const pendingBlobRef = useRef<Blob | null>(null);
  const [origin, setOrigin] = useState("");

  useEffect(() => { setOrigin(window.location.origin); }, []);

  // ── Camera ───────────────────────────────────────────────────────────────
  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia(CAMERA_CONSTRAINTS);
        if (!active) { stream.getTracks().forEach(t => t.stop()); return; }
        streamRef.current = stream;
        try {
          await stream.getVideoTracks()[0]?.applyConstraints({ advanced: ADVANCED_LOCK } as any);
        } catch {}
        if (videoRef.current) { videoRef.current.srcObject = stream; await videoRef.current.play(); }
        if (active) setCameraReady(true);
      } catch (e: any) {
        if (active) setCameraError(e.message ?? "Camera error");
      }
    })();
    return () => {
      active = false;
      streamRef.current?.getTracks().forEach(t => t.stop());
    };
  }, []);

  // ── Signaling via DB polling ──────────────────────────────────────────────
  const signal = useCallback(async (action: string) => {
    await fetch(`/api/sessions/${id}/signal`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action, side }),
    });
  }, [id, side]);

  const pollSignal = useCallback(async (): Promise<{
    leftConnected: boolean; rightConnected: boolean;
    startSignal: boolean; stopSignal: boolean;
  }> => {
    const res = await fetch(`/api/sessions/${id}/signal`);
    return res.json();
  }, [id]);

  // Register this phone as connected
  useEffect(() => {
    signal("connect");
  }, [signal]);

  // Poll for peer connection + start/stop signals
  useEffect(() => {
    let stopped = false;
    let recordingStarted = false;
    let recordingStopped = false;

    const tick = async () => {
      if (stopped) return;
      try {
        const s = await pollSignal();
        const myConnected   = side === "left" ? s.leftConnected  : s.rightConnected;
        const peerIsConn    = side === "left" ? s.rightConnected : s.leftConnected;
        if (peerIsConn) setPeerConnected(true);

        if (s.startSignal && !recordingStarted) {
          recordingStarted = true;
          doStartRecording();
        }
        if (s.stopSignal && !recordingStopped && recordingStarted) {
          recordingStopped = true;
          doStopRecording();
        }
      } catch {}
    };

    const interval = setInterval(tick, 1500);
    tick(); // immediate first check
    return () => { stopped = true; clearInterval(interval); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, side]);

  // ── Recording ────────────────────────────────────────────────────────────
  const doStartRecording = useCallback(() => {
    const stream = streamRef.current;
    if (!stream) return;
    if (recorderRef.current?.state === "recording") return; // already recording
    chunksRef.current = [];

    // video/webm works on all browsers; mp4 on iOS Safari only
    const mimeType = MediaRecorder.isTypeSupported("video/webm;codecs=vp9,opus")
      ? "video/webm;codecs=vp9,opus"
      : MediaRecorder.isTypeSupported("video/webm")
      ? "video/webm"
      : "video/mp4";

    let recorder: MediaRecorder;
    try {
      recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 8_000_000 });
    } catch {
      recorder = new MediaRecorder(stream); // fallback: let browser decide
    }

    recorder.ondataavailable = (e) => { if (e.data?.size > 0) chunksRef.current.push(e.data); };
    recorder.onstop = () => {
      // Small delay to ensure all ondataavailable events have fired
      setTimeout(() => promptUpload(), 100);
    };
    // No timeslice — collect everything at stop for maximum reliability
    recorder.start();
    recorderRef.current = recorder;
    setPhase("recording");
    setRecordingSeconds(0);
    timerRef.current = setInterval(() => setRecordingSeconds(s => s + 1), 1000);
  }, []);

  const doStopRecording = useCallback(() => {
    if (timerRef.current) clearInterval(timerRef.current);
    const recorder = recorderRef.current;
    if (!recorder || recorder.state !== "recording") return;
    recorder.stop(); // fires ondataavailable with all remaining data, then onstop
  }, []);

  const promptUpload = useCallback(() => {
    const chunks = chunksRef.current;
    if (!chunks.length) { setUploadError("No video recorded"); setPhase("error"); return; }
    const blob = new Blob(chunks, { type: chunks[0].type });
    pendingBlobRef.current = blob;
    setShowUploadPrompt(true);
  }, []);

  const doUpload = useCallback(async () => {
    const uploadBlob = pendingBlobRef.current;
    setShowUploadPrompt(false);
    setPhase("uploading");
    if (!uploadBlob || uploadBlob.size === 0) {
      setUploadError("No video data recorded. Try again.");
      setPhase("error");
      return;
    }
    const contentType = uploadBlob.type || "video/webm";
    try {
      const res = await fetch("/api/upload", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ session_id: id, camera: side, content_type: contentType }),
      });
      if (!res.ok) throw new Error(`Upload URL failed: ${res.status}`);
      const { url } = await res.json();
      if (!url) throw new Error("No upload URL returned");
      await new Promise<void>((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open("PUT", url);
        xhr.setRequestHeader("Content-Type", contentType);
        xhr.upload.onprogress = (e) => { if (e.lengthComputable) setUploadProgress(Math.round((e.loaded / e.total) * 100)); };
        xhr.onload = () => xhr.status < 300 ? resolve() : reject(new Error(`R2 upload failed: ${xhr.status}`));
        xhr.onerror = () => reject(new Error("Network error during upload"));
        xhr.send(uploadBlob);
      });
      await fetch(`/api/sessions/${id}/upload-done`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ side }),
      });
      setPhase("done");
    } catch (e: any) {
      setUploadError(e.message);
      setPhase("error");
    }
  }, [id, side]);

  // Tap Start / Stop — write signal to DB, then act locally
  const handleStart = async () => {
    await signal("start");
    doStartRecording();
  };
  const handleStop = async () => {
    await signal("stop");
    doStopRecording();
  };

  const fmt = (s: number) => `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
  const qrUrl = origin ? `${origin}/session/${id}/record?side=${otherSide}` : "";

  return (
    <div className="min-h-screen bg-black flex flex-col">
      {/* Header */}
      <div className="flex items-center justify-between px-4 pt-4 pb-2 shrink-0">
        <div>
          <p className="text-xs text-gray-600 uppercase tracking-widest">FieldVision</p>
          <h1 className="text-white font-bold text-lg capitalize">{side} Camera</h1>
        </div>
        <div className={cn(
          "flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium border",
          peerConnected
            ? "bg-green-900/40 text-green-400 border-green-800/40"
            : "bg-gray-900 text-gray-600 border-gray-800"
        )}>
          <span className={cn("w-1.5 h-1.5 rounded-full", peerConnected ? "bg-green-500" : "bg-gray-700")} />
          <span className="capitalize">{otherSide}:</span>
          <span>{peerConnected ? "Connected" : "Waiting…"}</span>
        </div>
      </div>

      {/* Camera */}
      <div className="relative flex-1 overflow-hidden bg-black">
        {!cameraReady && !cameraError && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3">
            <Loader2 className="text-green-400 animate-spin" size={36} />
            <p className="text-gray-500 text-sm">Opening camera…</p>
          </div>
        )}

        <video ref={videoRef} className="w-full h-full object-cover" muted playsInline autoPlay />

        {/* QR overlay — only on host phone, until peer connects */}
        {cameraReady && isHost && !peerConnected && phase === "ready" && (
          <div className="absolute inset-0 bg-black/80 flex flex-col items-center justify-center gap-5 px-6">
            <div className="text-center">
              <p className="text-white font-semibold text-base">
                Have the <span className="capitalize">{otherSide}</span> camera phone scan this
              </p>
              <p className="text-gray-400 text-sm mt-1">Session {id.slice(0, 8)}</p>
            </div>
            {qrUrl ? (
              <div className="bg-white p-4 rounded-2xl">
                <QRCodeSVG value={qrUrl} size={200} bgColor="#ffffff" fgColor="#000000" />
              </div>
            ) : <Loader2 className="text-white animate-spin" size={32} />}
            <div className="flex items-center gap-2 text-gray-400 text-sm">
              <Loader2 size={13} className="animate-spin" />
              <span>Waiting for {otherSide} camera…</span>
            </div>
          </div>
        )}

        {/* Non-host waiting screen (no QR) */}
        {cameraReady && !isHost && !peerConnected && phase === "ready" && (
          <div className="absolute inset-0 bg-black/80 flex flex-col items-center justify-center gap-4 px-6">
            <Loader2 className="text-green-400 animate-spin" size={40} />
            <p className="text-white font-semibold">Linking with {otherSide} camera…</p>
            <p className="text-gray-500 text-sm text-center">Hold on, connecting to the other phone.</p>
          </div>
        )}

        {/* Timer */}
        {phase === "recording" && (
          <div className="absolute top-4 left-1/2 -translate-x-1/2 flex items-center gap-2 bg-black/70 rounded-full px-4 py-2">
            <span className="w-2 h-2 rounded-full bg-red-500 animate-pulse" />
            <span className="text-white font-mono text-lg">{fmt(recordingSeconds)}</span>
          </div>
        )}

        {/* WiFi upload prompt */}
        {showUploadPrompt && (
          <div className="absolute inset-0 bg-black/90 flex flex-col items-center justify-center gap-6 px-8">
            <div className="text-center">
              <p className="text-white text-xl font-bold mb-2">Ready to upload</p>
              <p className="text-gray-400 text-sm leading-relaxed">
                Your video is {Math.round((pendingBlobRef.current?.size ?? 0) / 1024 / 1024)} MB.{" "}
                Upload now or wait until you're on WiFi to avoid using mobile data.
              </p>
            </div>
            <div className="flex flex-col gap-3 w-full">
              <button
                onClick={doUpload}
                className="w-full bg-green-500 active:bg-green-600 text-black font-bold py-4 rounded-2xl text-base"
              >
                Upload now
              </button>
              <button
                onClick={() => setShowUploadPrompt(false)}
                className="w-full bg-gray-800 active:bg-gray-700 text-gray-300 font-semibold py-4 rounded-2xl text-base"
              >
                Wait for WiFi
              </button>
            </div>
            {/* If they dismiss and want to upload later */}
            <p className="text-gray-600 text-xs text-center">
              If you wait, keep this page open and tap Upload when ready.
            </p>
          </div>
        )}

        {/* Manual upload button shown after dismissing prompt */}
        {!showUploadPrompt && phase === "ready" && pendingBlobRef.current && (
          <div className="absolute bottom-0 left-0 right-0 bg-black/80 px-6 py-4">
            <button
              onClick={doUpload}
              className="w-full bg-green-500 text-black font-bold py-4 rounded-2xl text-base flex items-center justify-center gap-2"
            >
              <Upload size={18} /> Upload video now
            </button>
          </div>
        )}

        {/* Upload */}
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

        {/* Done */}
        {phase === "done" && (
          <div className="absolute inset-0 bg-black/85 flex flex-col items-center justify-center gap-4">
            <CheckCircle2 size={48} className="text-green-400" />
            <p className="text-white text-lg font-semibold">Upload complete!</p>
            <p className="text-gray-400 text-sm text-center px-8">Processing begins once both cameras have uploaded.</p>
          </div>
        )}

        {/* Camera error */}
        {cameraError && (
          <div className="absolute inset-0 bg-black/85 flex flex-col items-center justify-center gap-3 p-6">
            <p className="text-red-400 font-semibold text-center">{cameraError}</p>
            <p className="text-gray-500 text-sm text-center">Allow camera access and reload the page.</p>
          </div>
        )}

        {/* Upload error */}
        {phase === "error" && uploadError && (
          <div className="absolute inset-0 bg-black/85 flex flex-col items-center justify-center gap-3 p-6">
            <p className="text-red-400 font-semibold text-center">{uploadError}</p>
            <button onClick={doUpload} className="bg-white text-black rounded-full px-6 py-2 text-sm font-medium mt-2">Retry</button>
          </div>
        )}
      </div>

      {/* Controls */}
      <div className="px-6 pb-10 pt-4 bg-black shrink-0 min-h-[100px] flex items-center">
        {!peerConnected && (
          <p className="w-full text-center text-gray-600 text-sm">
            {isHost ? "Start button appears once the other phone joins." : "Waiting for the other phone…"}
          </p>
        )}

        {peerConnected && phase === "ready" && (
          <button
            onClick={handleStart}
            className="w-full bg-red-500 active:bg-red-700 text-white font-bold py-5 rounded-2xl text-xl flex items-center justify-center gap-3"
          >
            <span className="w-5 h-5 rounded-full bg-white" />
            Start Recording
          </button>
        )}

        {phase === "recording" && (
          <button
            onClick={handleStop}
            className="w-full bg-white active:bg-gray-200 text-black font-bold py-5 rounded-2xl text-xl flex items-center justify-center gap-3"
          >
            <span className="w-5 h-5 rounded-sm bg-black" />
            Stop & Upload
          </button>
        )}
      </div>
    </div>
  );
}
