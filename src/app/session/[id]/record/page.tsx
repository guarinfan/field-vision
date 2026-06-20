"use client";

import { useEffect, useRef, useState, useCallback, Suspense } from "react";
import { useParams, useSearchParams } from "next/navigation";
import { supabase } from "@/lib/supabase";
import { Loader2, Upload, CheckCircle2, Wifi, WifiOff } from "lucide-react";
import { cn } from "@/lib/cn";

type Side = "left" | "right";
type PhoneStatus = "connecting" | "ready" | "recording" | "uploading" | "done" | "error";

interface PeerState {
  status: PhoneStatus;
  side: Side;
}

const STATUS_LABEL: Record<PhoneStatus, string> = {
  connecting: "Connecting…",
  ready: "Ready",
  recording: "Recording",
  uploading: "Uploading…",
  done: "Done",
  error: "Error",
};

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

  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);

  const [status, setStatus] = useState<PhoneStatus>("connecting");
  const [peer, setPeer] = useState<PeerState | null>(null);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [recordingSeconds, setRecordingSeconds] = useState(0);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const otherSide: Side = side === "left" ? "right" : "left";

  // Publish our state to the Supabase channel
  const publish = useCallback((s: PhoneStatus) => {
    supabase.channel(`recording:${id}`).send({
      type: "broadcast",
      event: "state",
      payload: { side, status: s },
    });
  }, [id, side]);

  // Start camera with locked settings
  const startCamera = useCallback(async () => {
    try {
      const constraints: MediaStreamConstraints = {
        video: {
          facingMode: "environment",
          width: { ideal: 1920 },
          height: { ideal: 1080 },
          frameRate: { ideal: 30 },
        },
        audio: true,
      };

      const stream = await navigator.mediaDevices.getUserMedia(constraints);
      streamRef.current = stream;

      // Try to lock camera settings (Android Chrome supports this)
      const videoTrack = stream.getVideoTracks()[0];
      if (videoTrack && "applyConstraints" in videoTrack) {
        try {
          await videoTrack.applyConstraints({
            // @ts-ignore — advanced constraints not in TS types yet
            advanced: [{
              whiteBalanceMode: "manual",
              colorTemperature: 5500,
              exposureMode: "manual",
              exposureTime: 1 / 500,
              iso: 100,
              zoom: 1.0,
            }],
          });
        } catch {
          // Advanced constraints not supported on this browser/device — continue anyway
        }
      }

      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        videoRef.current.play();
      }

      setStatus("ready");
      publish("ready");
    } catch (e: any) {
      setError(`Camera error: ${e.message}`);
      setStatus("error");
    }
  }, [publish]);

  // Record + upload
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
    recorder.ondataavailable = (e) => {
      if (e.data.size > 0) chunksRef.current.push(e.data);
    };
    recorder.onstop = () => uploadRecording();

    recorder.start(1000); // collect chunks every 1s
    recorderRef.current = recorder;

    setStatus("recording");
    publish("recording");
    setRecordingSeconds(0);
    timerRef.current = setInterval(() => setRecordingSeconds((s) => s + 1), 1000);
  }, [publish]);

  const stopRecording = useCallback(() => {
    if (timerRef.current) clearInterval(timerRef.current);
    recorderRef.current?.stop();
  }, []);

  const uploadRecording = useCallback(async () => {
    setStatus("uploading");
    publish("uploading");

    const chunks = chunksRef.current;
    if (!chunks.length) { setError("No video recorded"); return; }

    const ext = chunks[0].type.includes("mp4") ? "mp4" : "webm";
    const blob = new Blob(chunks, { type: chunks[0].type });

    try {
      // Get presigned upload URL
      const res = await fetch("/api/upload", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ session_id: id, side }),
      });
      const { url } = await res.json();

      // Upload directly to R2
      await new Promise<void>((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open("PUT", url);
        xhr.setRequestHeader("Content-Type", blob.type);
        xhr.upload.onprogress = (e) => {
          if (e.lengthComputable) setUploadProgress(Math.round((e.loaded / e.total) * 100));
        };
        xhr.onload = () => (xhr.status < 300 ? resolve() : reject(new Error(`Upload failed: ${xhr.status}`)));
        xhr.onerror = () => reject(new Error("Upload error"));
        xhr.send(blob);
      });

      // Mark this side as uploaded in the session
      await fetch(`/api/sessions/${id}/upload-done`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ side }),
      });

      setStatus("done");
      publish("done");
    } catch (e: any) {
      setError(e.message);
      setStatus("error");
    }
  }, [id, side, publish]);

  // Supabase Realtime — listen for peer state + start/stop signals
  useEffect(() => {
    const channel = supabase
      .channel(`recording:${id}`)
      .on("broadcast", { event: "state" }, ({ payload }) => {
        if (payload.side === otherSide) {
          setPeer({ side: payload.side, status: payload.status });
        }
      })
      .on("broadcast", { event: "control" }, ({ payload }) => {
        if (payload.action === "start") startRecording();
        if (payload.action === "stop") stopRecording();
      })
      .subscribe(() => {
        startCamera();
      });

    return () => { supabase.removeChannel(channel); };
  }, [id, otherSide, startCamera, startRecording, stopRecording]);

  const sendControl = (action: "start" | "stop") => {
    supabase.channel(`recording:${id}`).send({
      type: "broadcast",
      event: "control",
      payload: { action },
    });
    if (action === "start") startRecording();
    if (action === "stop") stopRecording();
  };

  const bothReady = status === "ready" && peer?.status === "ready";
  const isRecording = status === "recording";

  const fmt = (s: number) => `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;

  return (
    <div className="min-h-screen bg-black flex flex-col">
      {/* Header */}
      <div className="flex items-center justify-between px-4 pt-4 pb-2">
        <div>
          <p className="text-xs text-gray-500 uppercase tracking-widest">FieldVision</p>
          <h1 className="text-white font-bold text-lg capitalize">{side} Camera</h1>
        </div>
        <div className="flex items-center gap-2">
          {/* Peer status indicator */}
          <div className={cn(
            "flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium",
            peer ? "bg-green-900/40 text-green-400" : "bg-gray-800 text-gray-500"
          )}>
            {peer ? <Wifi size={12} /> : <WifiOff size={12} />}
            {peer ? `${otherSide} cam: ${STATUS_LABEL[peer.status]}` : `Waiting for ${otherSide} cam…`}
          </div>
        </div>
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
        {isRecording && (
          <div className="absolute top-4 left-1/2 -translate-x-1/2 flex items-center gap-2 bg-black/70 rounded-full px-4 py-2">
            <span className="w-2 h-2 rounded-full bg-red-500 animate-pulse" />
            <span className="text-white font-mono text-lg">{fmt(recordingSeconds)}</span>
          </div>
        )}

        {/* Upload progress overlay */}
        {status === "uploading" && (
          <div className="absolute inset-0 bg-black/80 flex flex-col items-center justify-center gap-4">
            <Upload size={40} className="text-green-400" />
            <p className="text-white text-lg font-semibold">Uploading…</p>
            <div className="w-64 bg-gray-700 rounded-full h-2">
              <div
                className="bg-green-500 h-2 rounded-full transition-all"
                style={{ width: `${uploadProgress}%` }}
              />
            </div>
            <p className="text-gray-400 text-sm">{uploadProgress}%</p>
          </div>
        )}

        {/* Done overlay */}
        {status === "done" && (
          <div className="absolute inset-0 bg-black/80 flex flex-col items-center justify-center gap-4">
            <CheckCircle2 size={48} className="text-green-400" />
            <p className="text-white text-lg font-semibold">Upload complete!</p>
            <p className="text-gray-400 text-sm text-center px-8">
              Processing will begin once both cameras have uploaded.
            </p>
          </div>
        )}

        {/* Error overlay */}
        {status === "error" && (
          <div className="absolute inset-0 bg-black/80 flex flex-col items-center justify-center gap-3 p-6">
            <p className="text-red-400 font-semibold text-center">{error}</p>
            <button
              onClick={startCamera}
              className="bg-white text-black rounded-full px-6 py-2 text-sm font-medium"
            >
              Retry
            </button>
          </div>
        )}
      </div>

      {/* Controls */}
      <div className="px-6 pb-8 pt-4 bg-black">
        {status === "connecting" && (
          <div className="flex items-center justify-center gap-2 text-gray-400">
            <Loader2 size={18} className="animate-spin" />
            <span>Starting camera…</span>
          </div>
        )}

        {status === "ready" && !bothReady && (
          <div className="text-center text-gray-400 text-sm">
            Waiting for {otherSide} camera to connect…
          </div>
        )}

        {bothReady && (
          <button
            onClick={() => sendControl("start")}
            className="w-full bg-red-500 hover:bg-red-600 text-white font-bold py-5 rounded-2xl text-lg flex items-center justify-center gap-3"
          >
            <span className="w-4 h-4 rounded-full bg-white" />
            Start Recording
          </button>
        )}

        {isRecording && (
          <button
            onClick={() => sendControl("stop")}
            className="w-full bg-white hover:bg-gray-100 text-black font-bold py-5 rounded-2xl text-lg flex items-center justify-center gap-3"
          >
            <span className="w-4 h-4 rounded-sm bg-black" />
            Stop & Upload
          </button>
        )}
      </div>
    </div>
  );
}
