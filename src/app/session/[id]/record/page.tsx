"use client";

import { useEffect, useRef, useState, useCallback, Suspense } from "react";
import { useParams, useSearchParams, useRouter } from "next/navigation";
import { Loader2, Upload, CheckCircle2, Wifi, AlertCircle } from "lucide-react";
import { cn } from "@/lib/cn";
import { QRCodeSVG } from "qrcode.react";

type Side  = "left" | "right";
type Phase = "selecting" | "ready" | "recording" | "stopped" | "uploading" | "done" | "error";

const POLL_MS = 1000;

// ── IndexedDB helpers ─────────────────────────────────────────────────────────
const IDB_NAME  = "fieldvision-pending";
const IDB_STORE = "uploads";

function openIDB(): Promise<IDBDatabase> {
  return new Promise((res, rej) => {
    const req = indexedDB.open(IDB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(IDB_STORE);
    req.onsuccess = () => res(req.result);
    req.onerror   = () => rej(req.error);
  });
}
async function idbSave(key: string, blob: Blob) {
  const db = await openIDB();
  return new Promise<void>((res, rej) => {
    const tx = db.transaction(IDB_STORE, "readwrite");
    tx.objectStore(IDB_STORE).put(blob, key);
    tx.oncomplete = () => res();
    tx.onerror    = () => rej(tx.error);
  });
}
async function idbLoad(key: string): Promise<Blob | null> {
  const db = await openIDB();
  return new Promise((res, rej) => {
    const tx  = db.transaction(IDB_STORE, "readonly");
    const req = tx.objectStore(IDB_STORE).get(key);
    req.onsuccess = () => res(req.result ?? null);
    req.onerror   = () => rej(req.error);
  });
}
async function idbDelete(key: string) {
  const db = await openIDB();
  return new Promise<void>((res, rej) => {
    const tx = db.transaction(IDB_STORE, "readwrite");
    tx.objectStore(IDB_STORE).delete(key);
    tx.oncomplete = () => res();
    tx.onerror    = () => rej(tx.error);
  });
}

// ── Camera: pick widest back camera ──────────────────────────────────────────
async function getUltraWideStream(): Promise<MediaStream> {
  const initial = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" }, audio: false });
  initial.getVideoTracks().forEach(t => t.stop());

  const devices     = await navigator.mediaDevices.enumerateDevices();
  const backCameras = devices.filter(d => d.kind === "videoinput" && !d.label.toLowerCase().includes("front"));
  const sorted      = [...backCameras].sort((a, b) => (/ultra|wide|0\.5/i.test(a.label) ? -1 : 0) - (/ultra|wide|0\.5/i.test(b.label) ? -1 : 0));

  let bestStream: MediaStream | null = null;
  let bestMinZoom = Infinity;

  for (const device of sorted) {
    try {
      const s       = await navigator.mediaDevices.getUserMedia({ video: { deviceId: { exact: device.deviceId }, width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 30 } }, audio: false });
      const caps    = s.getVideoTracks()[0].getCapabilities() as any;
      const minZoom = caps?.zoom?.min ?? 1;
      if (minZoom < bestMinZoom) { bestStream?.getVideoTracks().forEach(t => t.stop()); bestStream = s; bestMinZoom = minZoom; }
      else s.getVideoTracks().forEach(t => t.stop());
    } catch { /* skip */ }
  }

  if (bestStream) {
    const vid = bestStream.getVideoTracks()[0].getSettings().deviceId;
    bestStream.getVideoTracks().forEach(t => t.stop());
    return navigator.mediaDevices.getUserMedia({ video: { deviceId: { exact: vid }, width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 30 } }, audio: true });
  }
  return navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment", width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 30 } }, audio: true });
}

function fmt(totalSec: number) {
  const s = Math.max(0, Math.floor(totalSec));
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

// ── Page shell ────────────────────────────────────────────────────────────────
export default function RecordPage() {
  return (
    <Suspense fallback={<div className="min-h-screen bg-black flex items-center justify-center"><Loader2 className="text-green-400 animate-spin" size={32} /></div>}>
      <RecordPageInner />
    </Suspense>
  );
}

// ── Main component ────────────────────────────────────────────────────────────
function RecordPageInner() {
  const router       = useRouter();
  const { id }       = useParams<{ id: string }>();
  const searchParams = useSearchParams();
  const urlSide      = searchParams.get("side") as Side | null;

  const [side,  setSide]  = useState<Side | null>(urlSide);
  const [phase, setPhase] = useState<Phase>(urlSide ? "ready" : "selecting");

  const idbKey = side ? `${id}-${side}` : "";

  const videoRef       = useRef<HTMLVideoElement>(null);
  const streamRef      = useRef<MediaStream | null>(null);
  const recorderRef    = useRef<MediaRecorder | null>(null);
  const chunksRef      = useRef<Blob[]>([]);
  const pendingBlobRef = useRef<Blob | null>(null);
  const scheduledRef   = useRef(false); // prevent double-scheduling start
  const stoppedRef     = useRef(false); // prevent double-stop

  const [cameraReady,      setCameraReady]      = useState(false);
  const [cameraError,      setCameraError]      = useState<string | null>(null);
  const [elapsedSecs,      setElapsedSecs]      = useState(0);
  const [uploadProgress,   setUploadProgress]   = useState(0);
  const [uploadError,      setUploadError]      = useState<string | null>(null);
  const [showUploadPrompt, setShowUploadPrompt] = useState(false);
  const [pendingMB,        setPendingMB]        = useState(0);
  const [hasSavedBlob,     setHasSavedBlob]     = useState(false);

  useEffect(() => { const t = setTimeout(() => window.scrollTo(0, 1), 100); return () => clearTimeout(t); }, []);

  // ── Saved blob resume ────────────────────────────────────────────────────
  useEffect(() => {
    if (!idbKey) return;
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
    if (!side || hasSavedBlob) return;
    let active = true;
    (async () => {
      try {
        const stream = await getUltraWideStream();
        if (!active) { stream.getTracks().forEach(t => t.stop()); return; }
        streamRef.current = stream;
        if (videoRef.current) { videoRef.current.srcObject = stream; await videoRef.current.play(); }
        if (active) setCameraReady(true);
      } catch (e: any) {
        if (active) setCameraError(e.message ?? "Camera error");
      }
    })();
    return () => { active = false; streamRef.current?.getTracks().forEach(t => t.stop()); };
  }, [side, hasSavedBlob]);

  // ── Announce connection ───────────────────────────────────────────────────
  useEffect(() => {
    if (!side || !id) return;
    fetch(`/api/sessions/${id}/signal`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "connect", side }),
    }).catch(() => {});
  }, [side, id]);

  // ── Poll for start / stop signals ─────────────────────────────────────────
  useEffect(() => {
    if (!side || !id) return;
    let alive = true;

    const tick = async () => {
      if (!alive) return;
      try {
        const res = await fetch(`/api/sessions/${id}/signal`);
        const s   = await res.json();

        // Coordinator pressed Start → schedule recording at s.startAt
        if (s.startAt && !scheduledRef.current) {
          scheduledRef.current = true;
          const delay = Math.max(0, s.startAt - Date.now());
          setTimeout(() => { if (alive) doStartRecording(); }, delay);
        }

        // Coordinator pressed Stop
        if (s.stopped && !stoppedRef.current) {
          stoppedRef.current = true;
          doStopRecording();
        }
      } catch { /* blip */ }
    };

    const interval = setInterval(tick, POLL_MS);
    tick();
    return () => { alive = false; clearInterval(interval); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [side, id]);

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
    recorder.onstop = () => setTimeout(onRecordingStopped, 100);
    recorder.start();
    recorderRef.current = recorder;

    setPhase("recording");
    setElapsedSecs(0);
    const startedAt = Date.now();
    const timer = setInterval(() => setElapsedSecs(Math.floor((Date.now() - startedAt) / 1000)), 500);
    // Store timer ref on recorder so doStopRecording can clear it
    (recorder as any)._elapsedTimer = timer;
  }, []);

  const doStopRecording = useCallback(() => {
    const rec = recorderRef.current;
    if (rec?.state === "recording") {
      if ((rec as any)._elapsedTimer) clearInterval((rec as any)._elapsedTimer);
      rec.stop();
    }
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

  // ── Upload ────────────────────────────────────────────────────────────────
  const doUpload = useCallback(async () => {
    const blob = pendingBlobRef.current;
    setShowUploadPrompt(false);
    setPhase("uploading");
    setUploadError(null);
    if (!blob || blob.size === 0 || !side) { setUploadError("No video data."); setPhase("error"); return; }

    const contentType = blob.type || "video/webm";
    try {
      const res = await fetch("/api/upload", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ session_id: id, camera: side, content_type: contentType }),
      });
      if (!res.ok) throw new Error(`Upload URL error (${res.status})`);
      const { url, key: uploadedKey } = await res.json();
      if (!url) throw new Error("No upload URL");

      await new Promise<void>((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open("PUT", url);
        xhr.setRequestHeader("Content-Type", contentType);
        xhr.upload.onprogress = (e) => { if (e.lengthComputable) setUploadProgress(Math.round((e.loaded / e.total) * 100)); };
        xhr.onload  = () => (xhr.status >= 200 && xhr.status < 300 ? resolve() : reject(new Error(`Upload failed (${xhr.status})`)));
        xhr.onerror = () => reject(new Error("Upload blocked — add this domain to R2 bucket CORS settings."));
        xhr.send(blob);
      });

      await fetch(`/api/sessions/${id}/upload-done`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ side, key: uploadedKey }),
      });

      await idbDelete(idbKey).catch(() => {});
      pendingBlobRef.current = null;
      setHasSavedBlob(false);
      setPhase("done");
      setTimeout(() => router.push(`/session/${id}`), 1500);
    } catch (e: any) {
      setUploadError(e.message);
      setPhase("stopped");
    }
  }, [id, side, idbKey, router]);

  const saveForLater = useCallback(async () => {
    const blob = pendingBlobRef.current;
    if (!blob || !side) return;
    setShowUploadPrompt(false);
    try {
      await idbSave(idbKey, blob);
      setHasSavedBlob(true);
    } catch {
      const url = URL.createObjectURL(blob);
      const a   = Object.assign(document.createElement("a"), { href: url, download: `fieldvision-${side}-${id.slice(0, 8)}.webm` });
      a.click();
      URL.revokeObjectURL(url);
    }
  }, [idbKey, id, side]);

  // ── SCREEN: Side picker ───────────────────────────────────────────────────
  if (phase === "selecting") {
    return (
      <div className="min-h-screen bg-black flex flex-col items-center justify-center gap-6 px-8">
        <div className="text-center mb-2">
          <p className="text-xs text-green-600 uppercase tracking-widest font-semibold mb-2">FieldVision · Camera Setup</p>
          <h1 className="text-white text-2xl font-bold">Which side are you?</h1>
          <p className="text-gray-500 text-sm mt-2">Select your position on the field</p>
        </div>
        <button onClick={() => { setSide("left");  setPhase("ready"); }} className="w-full bg-green-500 active:bg-green-600 text-black font-bold py-6 rounded-2xl text-xl">◀ LEFT camera</button>
        <button onClick={() => { setSide("right"); setPhase("ready"); }} className="w-full bg-white active:bg-gray-200 text-black font-bold py-6 rounded-2xl text-xl">RIGHT camera ▶</button>
        <p className="text-gray-600 text-xs text-center mt-1">The coordinator phone controls when recording starts and stops.</p>
      </div>
    );
  }

  // ── SCREEN: Saved blob resume ─────────────────────────────────────────────
  if (hasSavedBlob && phase !== "uploading" && phase !== "done") {
    return (
      <div className="min-h-screen bg-black flex flex-col items-center justify-center gap-6 px-8">
        <Wifi size={48} className="text-green-400" />
        <div className="text-center">
          <h1 className="text-white text-xl font-bold">Pending upload</h1>
          <p className="text-gray-400 text-sm mt-2">Your {pendingMB} MB recording is saved on this device.</p>
        </div>
        {uploadError && <div className="flex items-start gap-2 bg-red-950/40 border border-red-800/40 rounded-xl p-4 w-full"><AlertCircle size={16} className="text-red-400 mt-0.5 shrink-0" /><p className="text-red-300 text-sm">{uploadError}</p></div>}
        <button onClick={doUpload} className="w-full bg-green-500 text-black font-bold py-5 rounded-2xl text-lg flex items-center justify-center gap-2"><Upload size={20} /> Upload now</button>
      </div>
    );
  }

  // ── SCREEN: Upload progress / done ────────────────────────────────────────
  if (phase === "uploading" || phase === "done") {
    return (
      <div className="min-h-screen bg-black flex flex-col items-center justify-center gap-6 px-8">
        {phase === "uploading" ? (
          <><Upload size={48} className="text-green-400" /><p className="text-white text-xl font-bold">Uploading…</p><div className="w-full max-w-xs bg-gray-800 rounded-full h-3"><div className="bg-green-500 h-3 rounded-full transition-all" style={{ width: `${uploadProgress}%` }} /></div><p className="text-gray-400">{uploadProgress}%</p></>
        ) : (
          <><CheckCircle2 size={48} className="text-green-400" /><p className="text-white text-xl font-bold">Upload complete!</p><p className="text-gray-400 text-sm">Taking you to the session…</p></>
        )}
      </div>
    );
  }

  // ── SCREEN: Camera + live phases ──────────────────────────────────────────
  return (
    <div className="fixed inset-0 bg-black overflow-hidden">
      {/* Camera preview */}
      <div className="absolute inset-0">
        {!cameraReady && !cameraError && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 z-10">
            <Loader2 className="text-green-400 animate-spin" size={36} />
            <p className="text-gray-500 text-sm">Opening wide camera…</p>
          </div>
        )}
        <video ref={videoRef} className="w-full h-full object-cover" muted playsInline autoPlay />
      </div>

      {/* Overlay: waiting for coordinator start */}
      {cameraReady && phase === "ready" && (
        <div className="absolute inset-0 bg-black/70 flex flex-col items-center justify-center gap-5 px-8 z-20">
          <div className="text-center">
            <p className="text-xs text-green-500 uppercase tracking-widest font-semibold mb-3">
              {side?.toUpperCase()} camera · Wide lens
            </p>
            <Loader2 className="text-green-400 animate-spin mx-auto mb-4" size={44} />
            <p className="text-white font-semibold text-lg">Waiting for coordinator</p>
            <p className="text-gray-500 text-sm mt-2">Mount phone on tripod in wide-lens mode.<br/>The coordinator will start recording.</p>
          </div>
        </div>
      )}

      {/* Recording timer */}
      {phase === "recording" && (
        <div className="absolute top-4 left-1/2 -translate-x-1/2 flex items-center gap-2 bg-black/70 rounded-full px-5 py-2.5 z-20">
          <span className="w-2.5 h-2.5 rounded-full bg-red-500 animate-pulse" />
          <span className="text-white font-mono text-2xl font-bold">{fmt(elapsedSecs)}</span>
        </div>
      )}

      {/* Camera error */}
      {cameraError && (
        <div className="absolute inset-0 bg-black/90 flex flex-col items-center justify-center gap-3 p-6 z-20">
          <AlertCircle className="text-red-400" size={40} />
          <p className="text-red-400 font-semibold text-center">{cameraError}</p>
          <p className="text-gray-500 text-sm text-center">Allow camera access and reload.</p>
        </div>
      )}

      {/* Upload prompt overlay */}
      {showUploadPrompt && (
        <div className="absolute inset-0 bg-black/92 flex flex-col items-center justify-center gap-6 px-8 z-20">
          <CheckCircle2 size={48} className="text-green-400" />
          <div className="text-center">
            <p className="text-white text-xl font-bold mb-2">Recording complete!</p>
            <p className="text-gray-400 text-sm">Your video is <span className="text-white font-semibold">{pendingMB} MB</span>.</p>
          </div>
          {uploadError && <div className="flex items-start gap-2 bg-red-950/40 border border-red-800/40 rounded-xl p-4 w-full"><AlertCircle size={16} className="text-red-400 mt-0.5 shrink-0" /><p className="text-red-300 text-sm">{uploadError}</p></div>}
          <div className="flex flex-col gap-3 w-full">
            <button onClick={doUpload} className="w-full bg-green-500 active:bg-green-600 text-black font-bold py-5 rounded-2xl text-lg">Upload now</button>
            <button onClick={saveForLater} className="w-full bg-gray-800 active:bg-gray-700 text-gray-200 font-semibold py-5 rounded-2xl text-lg flex items-center justify-center gap-2"><Wifi size={18} /> Wait for WiFi</button>
          </div>
        </div>
      )}

      {/* Side badge */}
      {!showUploadPrompt && phase !== "recording" && (
        <div className="absolute top-4 left-4 z-20">
          <div className="flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-medium border bg-black/60 text-gray-400 border-gray-700/50 backdrop-blur-sm">
            <span className="w-1.5 h-1.5 rounded-full bg-green-500" />
            <span className="capitalize">{side}</span>
            <span className="text-gray-600 mx-0.5">·</span>
            <span>wide lens</span>
          </div>
        </div>
      )}
    </div>
  );
}
