"use client";

import { useEffect, useRef, useState, useCallback, Suspense } from "react";
import { useParams, useSearchParams, useRouter } from "next/navigation";
import { Loader2, Upload, CheckCircle2, Wifi, AlertCircle } from "lucide-react";
import { cn } from "@/lib/cn";
import { QRCodeSVG } from "qrcode.react";

type Side = "left" | "right";
type Phase = "ready" | "recording" | "stopped" | "uploading" | "done" | "error";

// ── IndexedDB helpers for persisting blob across app close ─────────────────
const IDB_NAME = "fieldvision-pending";
const IDB_STORE = "uploads";

function openIDB(): Promise<IDBDatabase> {
  return new Promise((res, rej) => {
    const req = indexedDB.open(IDB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(IDB_STORE);
    req.onsuccess = () => res(req.result);
    req.onerror = () => rej(req.error);
  });
}
async function idbSave(key: string, blob: Blob) {
  const db = await openIDB();
  return new Promise<void>((res, rej) => {
    const tx = db.transaction(IDB_STORE, "readwrite");
    tx.objectStore(IDB_STORE).put(blob, key);
    tx.oncomplete = () => res();
    tx.onerror = () => rej(tx.error);
  });
}
async function idbLoad(key: string): Promise<Blob | null> {
  const db = await openIDB();
  return new Promise((res, rej) => {
    const tx = db.transaction(IDB_STORE, "readonly");
    const req = tx.objectStore(IDB_STORE).get(key);
    req.onsuccess = () => res(req.result ?? null);
    req.onerror = () => rej(req.error);
  });
}
async function idbDelete(key: string) {
  const db = await openIDB();
  return new Promise<void>((res, rej) => {
    const tx = db.transaction(IDB_STORE, "readwrite");
    tx.objectStore(IDB_STORE).delete(key);
    tx.oncomplete = () => res();
    tx.onerror = () => rej(tx.error);
  });
}

// ── Camera constraints ──────────────────────────────────────────────────────
// WB locked to daylight (5600K) so both phones match. Exposure left on auto
// so neither phone goes dark. Advanced constraints are best-effort on mobile.
const CAMERA_CONSTRAINTS: MediaStreamConstraints = {
  video: {
    facingMode: "environment",
    width: { ideal: 1920 },
    height: { ideal: 1080 },
    frameRate: { ideal: 30 },
    // @ts-expect-error — advanced is not in lib.dom.d.ts but supported on Android/iOS
    advanced: [{ whiteBalanceMode: "manual", colorTemperature: 5600 }],
  },
  audio: true,
};

export default function RecordPage() {
  return (
    <Suspense fallback={<div className="min-h-screen bg-black flex items-center justify-center"><Loader2 className="text-green-400 animate-spin" size={32} /></div>}>
      <RecordPageInner />
    </Suspense>
  );
}

function RecordPageInner() {
  const router = useRouter();
  const { id } = useParams<{ id: string }>();
  const searchParams = useSearchParams();
  const side = (searchParams.get("side") ?? "left") as Side;
  const isHost = searchParams.get("host") === "1";
  const otherSide: Side = side === "left" ? "right" : "left";
  const idbKey = `${id}-${side}`;

  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const pendingBlobRef = useRef<Blob | null>(null);

  const [phase, setPhase] = useState<Phase>("ready");
  const [peerConnected, setPeerConnected] = useState(false);
  const [cameraReady, setCameraReady] = useState(false);
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [recordingSeconds, setRecordingSeconds] = useState(0);
  const [showUploadPrompt, setShowUploadPrompt] = useState(false);
  const [pendingMB, setPendingMB] = useState(0);
  const [hasSavedBlob, setHasSavedBlob] = useState(false);
  const [origin, setOrigin] = useState("");

  useEffect(() => { setOrigin(window.location.origin); }, []);

  // Check IndexedDB for a pending upload on mount (user reopened the page)
  useEffect(() => {
    idbLoad(idbKey).then(blob => {
      if (blob && blob.size > 0) {
        pendingBlobRef.current = blob;
        setPendingMB(Math.round(blob.size / 1024 / 1024));
        setHasSavedBlob(true);
        setPhase("stopped");
      }
    }).catch(() => {});
  }, [idbKey]);

  // ── Camera ───────────────────────────────────────────────────────────────
  useEffect(() => {
    if (hasSavedBlob) return; // don't open camera if resuming a saved recording
    let active = true;
    (async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia(CAMERA_CONSTRAINTS);
        if (!active) { stream.getTracks().forEach(t => t.stop()); return; }
        streamRef.current = stream;
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
  }, [hasSavedBlob]);

  // ── DB polling for peer sync ──────────────────────────────────────────────
  const signal = useCallback(async (action: string) => {
    await fetch(`/api/sessions/${id}/signal`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action, side }),
    });
  }, [id, side]);

  useEffect(() => {
    signal("connect");
  }, [signal]);

  useEffect(() => {
    let stopped = false;
    let recordingStarted = false;
    let recordingStopped = false;

    const tick = async () => {
      if (stopped) return;
      try {
        const res = await fetch(`/api/sessions/${id}/signal`);
        const s = await res.json();
        const peerIsConn = side === "left" ? s.rightConnected : s.leftConnected;
        if (peerIsConn) setPeerConnected(true);
        if (s.startSignal && !recordingStarted) { recordingStarted = true; doStartRecording(); }
        if (s.stopSignal && !recordingStopped && recordingStarted) { recordingStopped = true; doStopRecording(); }
      } catch {}
    };

    const interval = setInterval(tick, 1500);
    tick();
    return () => { stopped = true; clearInterval(interval); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, side]);

  // ── Recording ────────────────────────────────────────────────────────────
  const doStartRecording = useCallback(() => {
    const stream = streamRef.current;
    if (!stream || recorderRef.current?.state === "recording") return;
    chunksRef.current = [];

    const mimeType = MediaRecorder.isTypeSupported("video/webm;codecs=vp9,opus")
      ? "video/webm;codecs=vp9,opus"
      : MediaRecorder.isTypeSupported("video/webm") ? "video/webm" : "video/mp4";

    let recorder: MediaRecorder;
    try { recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 8_000_000 }); }
    catch { recorder = new MediaRecorder(stream); }

    recorder.ondataavailable = (e) => { if (e.data?.size > 0) chunksRef.current.push(e.data); };
    recorder.onstop = () => setTimeout(() => onRecordingStopped(), 100);
    recorder.start(); // no timeslice — all data collected on stop
    recorderRef.current = recorder;
    setPhase("recording");
    setRecordingSeconds(0);
    timerRef.current = setInterval(() => setRecordingSeconds(s => s + 1), 1000);
  }, []);

  const doStopRecording = useCallback(() => {
    if (timerRef.current) clearInterval(timerRef.current);
    const rec = recorderRef.current;
    if (rec?.state === "recording") rec.stop();
  }, []);

  const onRecordingStopped = useCallback(() => {
    const chunks = chunksRef.current;
    if (!chunks.length) { setUploadError("No video data captured."); setPhase("error"); return; }
    const blob = new Blob(chunks, { type: chunks[0].type });
    pendingBlobRef.current = blob;
    setPendingMB(Math.round(blob.size / 1024 / 1024));
    setPhase("stopped");
    setShowUploadPrompt(true);
  }, []);

  const saveForLater = useCallback(async () => {
    const blob = pendingBlobRef.current;
    if (!blob) return;
    setShowUploadPrompt(false);
    try {
      await idbSave(idbKey, blob);
      setHasSavedBlob(true);
    } catch {
      // IndexedDB failed (private mode?) — fall back to download
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `fieldvision-${side}-${id.slice(0, 8)}.webm`;
      a.click();
      URL.revokeObjectURL(url);
    }
  }, [idbKey, id, side]);

  const doUpload = useCallback(async () => {
    const blob = pendingBlobRef.current;
    setShowUploadPrompt(false);
    setPhase("uploading");
    setUploadError(null);

    if (!blob || blob.size === 0) {
      setUploadError("No video data to upload.");
      setPhase("error");
      return;
    }

    const contentType = blob.type || "video/webm";

    try {
      // Get presigned URL
      const res = await fetch("/api/upload", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ session_id: id, camera: side, content_type: contentType }),
      });
      if (!res.ok) throw new Error(`Could not get upload URL (${res.status})`);
      const { url } = await res.json();
      if (!url) throw new Error("No upload URL returned");

      // Upload to R2
      await new Promise<void>((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open("PUT", url);
        xhr.setRequestHeader("Content-Type", contentType);
        xhr.upload.onprogress = (e) => {
          if (e.lengthComputable) setUploadProgress(Math.round((e.loaded / e.total) * 100));
        };
        xhr.onload = () => {
          if (xhr.status >= 200 && xhr.status < 300) resolve();
          else reject(new Error(`Upload to R2 failed (status ${xhr.status || "CORS blocked"}) — set CORS on your R2 bucket.`));
        };
        xhr.onerror = () => reject(new Error("Upload blocked by CORS — go to Cloudflare → R2 → bucket → Settings → CORS and add this domain."));
        xhr.send(blob);
      });

      // Notify server both sides may be done
      await fetch(`/api/sessions/${id}/upload-done`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ side }),
      });

      // Clean up saved blob
      await idbDelete(idbKey).catch(() => {});
      pendingBlobRef.current = null;
      setHasSavedBlob(false);

      setPhase("done");
      // Redirect to session page after short delay
      setTimeout(() => router.push(`/session/${id}`), 1500);
    } catch (e: any) {
      setUploadError(e.message);
      setPhase("stopped"); // go back to stopped so they can retry
    }
  }, [id, side, idbKey, router]);

  const handleStart = async () => { await signal("start"); doStartRecording(); };
  const handleStop = async () => { await signal("stop"); doStopRecording(); };

  const fmt = (s: number) => `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
  const qrUrl = origin ? `${origin}/session/${id}/record?side=${otherSide}` : "";

  // ── Saved-blob resume screen (user reopened after "wait for WiFi") ────────
  if (hasSavedBlob && phase !== "uploading" && phase !== "done") {
    return (
      <div className="min-h-screen bg-black flex flex-col items-center justify-center gap-6 px-8">
        <div className="text-center">
          <p className="text-xs text-gray-500 uppercase tracking-widest mb-2">FieldVision · {side} Camera</p>
          <Wifi size={48} className="text-green-400 mx-auto mb-4" />
          <h1 className="text-white text-xl font-bold">Pending upload</h1>
          <p className="text-gray-400 text-sm mt-2">
            Your {pendingMB} MB recording is saved on this device.
          </p>
        </div>
        {uploadError && (
          <div className="flex items-start gap-2 bg-red-950/40 border border-red-800/40 rounded-xl p-4 w-full">
            <AlertCircle size={16} className="text-red-400 mt-0.5 shrink-0" />
            <p className="text-red-300 text-sm">{uploadError}</p>
          </div>
        )}
        <button onClick={doUpload} className="w-full bg-green-500 text-black font-bold py-5 rounded-2xl text-lg flex items-center justify-center gap-2">
          <Upload size={20} /> Upload now
        </button>
        <p className="text-gray-600 text-xs text-center">Keep this page open if not uploading yet. The video is saved to this browser.</p>
      </div>
    );
  }

  // ── Upload progress / done screen ─────────────────────────────────────────
  if (phase === "uploading" || phase === "done") {
    return (
      <div className="min-h-screen bg-black flex flex-col items-center justify-center gap-6 px-8">
        {phase === "uploading" ? (
          <>
            <Upload size={48} className="text-green-400" />
            <p className="text-white text-xl font-bold">Uploading…</p>
            <div className="w-full max-w-xs bg-gray-800 rounded-full h-3">
              <div className="bg-green-500 h-3 rounded-full transition-all" style={{ width: `${uploadProgress}%` }} />
            </div>
            <p className="text-gray-400">{uploadProgress}%</p>
          </>
        ) : (
          <>
            <CheckCircle2 size={48} className="text-green-400" />
            <p className="text-white text-xl font-bold">Upload complete!</p>
            <p className="text-gray-400 text-sm text-center">Taking you to the session…</p>
          </>
        )}
      </div>
    );
  }

  // ── Main camera screen ────────────────────────────────────────────────────
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
          peerConnected ? "bg-green-900/40 text-green-400 border-green-800/40" : "bg-gray-900 text-gray-600 border-gray-800"
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

        {/* QR overlay — host only, until peer connects */}
        {cameraReady && isHost && !peerConnected && phase === "ready" && (
          <div className="absolute inset-0 bg-black/80 flex flex-col items-center justify-center gap-5 px-6">
            <div className="text-center">
              <p className="text-white font-semibold text-base">Have the <span className="capitalize">{otherSide}</span> camera phone scan this</p>
              <p className="text-gray-400 text-sm mt-1">Session {id.slice(0, 8)}</p>
            </div>
            {qrUrl && <div className="bg-white p-4 rounded-2xl"><QRCodeSVG value={qrUrl} size={200} bgColor="#ffffff" fgColor="#000000" /></div>}
            <div className="flex items-center gap-2 text-gray-400 text-sm"><Loader2 size={13} className="animate-spin" /><span>Waiting for {otherSide} camera…</span></div>
          </div>
        )}

        {/* Non-host waiting */}
        {cameraReady && !isHost && !peerConnected && phase === "ready" && (
          <div className="absolute inset-0 bg-black/80 flex flex-col items-center justify-center gap-4 px-6">
            <Loader2 className="text-green-400 animate-spin" size={40} />
            <p className="text-white font-semibold">Linking with {otherSide} camera…</p>
          </div>
        )}

        {/* Recording timer */}
        {phase === "recording" && (
          <div className="absolute top-4 left-1/2 -translate-x-1/2 flex items-center gap-2 bg-black/70 rounded-full px-4 py-2">
            <span className="w-2 h-2 rounded-full bg-red-500 animate-pulse" />
            <span className="text-white font-mono text-lg">{fmt(recordingSeconds)}</span>
          </div>
        )}

        {/* Camera error */}
        {cameraError && (
          <div className="absolute inset-0 bg-black/85 flex flex-col items-center justify-center gap-3 p-6">
            <p className="text-red-400 font-semibold text-center">{cameraError}</p>
            <p className="text-gray-500 text-sm text-center">Allow camera access and reload.</p>
          </div>
        )}

        {/* Upload prompt overlay */}
        {showUploadPrompt && (
          <div className="absolute inset-0 bg-black/92 flex flex-col items-center justify-center gap-6 px-8">
            <div className="text-center">
              <p className="text-white text-xl font-bold mb-2">Recording saved</p>
              <p className="text-gray-400 text-sm leading-relaxed">
                Your video is <span className="text-white font-semibold">{pendingMB} MB</span>.
                Upload now or wait for WiFi to avoid using mobile data.
              </p>
            </div>
            <div className="flex flex-col gap-3 w-full">
              <button onClick={doUpload} className="w-full bg-green-500 active:bg-green-600 text-black font-bold py-5 rounded-2xl text-lg">
                Upload now
              </button>
              <button onClick={saveForLater} className="w-full bg-gray-800 active:bg-gray-700 text-gray-200 font-semibold py-5 rounded-2xl text-lg flex items-center justify-center gap-2">
                <Wifi size={18} /> Wait for WiFi
              </button>
            </div>
            <p className="text-gray-600 text-xs text-center">If you wait, reopen this page to upload. The video is saved to this browser.</p>
          </div>
        )}
      </div>

      {/* Controls */}
      <div className="px-6 pb-10 pt-4 bg-black shrink-0 min-h-[100px] flex items-center">
        {!peerConnected && phase === "ready" && (
          <p className="w-full text-center text-gray-600 text-sm">
            {isHost ? "Start button appears once the other phone joins." : "Waiting for the other phone…"}
          </p>
        )}

        {peerConnected && phase === "ready" && (
          <button onClick={handleStart} className="w-full bg-red-500 active:bg-red-700 text-white font-bold py-5 rounded-2xl text-xl flex items-center justify-center gap-3">
            <span className="w-5 h-5 rounded-full bg-white" /> Start Recording
          </button>
        )}

        {phase === "recording" && (
          <button onClick={handleStop} className="w-full bg-white active:bg-gray-200 text-black font-bold py-5 rounded-2xl text-xl flex items-center justify-center gap-3">
            <span className="w-5 h-5 rounded-sm bg-black" /> Stop & Upload
          </button>
        )}

        {phase === "stopped" && !showUploadPrompt && (
          <button onClick={doUpload} className="w-full bg-green-500 text-black font-bold py-5 rounded-2xl text-lg flex items-center justify-center gap-2">
            <Upload size={20} /> Upload now
          </button>
        )}
      </div>
    </div>
  );
}
