"use client";

import { useEffect, useRef, useState, useCallback, Suspense } from "react";
import { useParams, useSearchParams, useRouter } from "next/navigation";
import { Loader2, Upload, CheckCircle2, Wifi, AlertCircle } from "lucide-react";
import { cn } from "@/lib/cn";
import { QRCodeSVG } from "qrcode.react";

type Side = "left" | "right";
type Phase =
  | "selecting"   // No side chosen yet — show picker
  | "ready"       // Camera on, QR shown, waiting for peer
  | "countdown"   // Both connected — 3-min countdown to recording
  | "recording"   // Recording in progress (auto-stops after 3 min)
  | "stopped"     // Recording finished, waiting for upload action
  | "uploading"   // Uploading blob to R2
  | "done"        // Upload complete
  | "error";

const RECORD_MS   = 3 * 60 * 1000; // recording duration
const POLL_MS     = 1200;           // signal poll interval

// ── IndexedDB helpers ─────────────────────────────────────────────────────────
const IDB_NAME = "fieldvision-pending";
const IDB_STORE = "uploads";

function openIDB(): Promise<IDBDatabase> {
  return new Promise((res, rej) => {
    const req = indexedDB.open(IDB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(IDB_STORE);
    req.onsuccess = () => res(req.result);
    req.onerror  = () => rej(req.error);
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

// ── Camera helpers ────────────────────────────────────────────────────────────
async function getUltraWideStream(): Promise<MediaStream> {
  const initial = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: "environment" },
    audio: false,
  });
  initial.getVideoTracks().forEach(t => t.stop());

  const devices     = await navigator.mediaDevices.enumerateDevices();
  const backCameras = devices.filter(
    d => d.kind === "videoinput" && !d.label.toLowerCase().includes("front")
  );

  const sorted = [...backCameras].sort((a, b) => {
    const aW = /ultra|wide|0\.5/i.test(a.label) ? -1 : 0;
    const bW = /ultra|wide|0\.5/i.test(b.label) ? -1 : 0;
    return aW - bW;
  });

  let bestStream: MediaStream | null = null;
  let bestMinZoom = Infinity;

  for (const device of sorted) {
    try {
      const s = await navigator.mediaDevices.getUserMedia({
        video: {
          deviceId:  { exact: device.deviceId },
          width:     { ideal: 1920 },
          height:    { ideal: 1080 },
          frameRate: { ideal: 30 },
        },
        audio: false,
      });
      const caps    = s.getVideoTracks()[0].getCapabilities() as any;
      const minZoom = caps?.zoom?.min ?? 1;
      if (minZoom < bestMinZoom) {
        bestStream?.getVideoTracks().forEach(t => t.stop());
        bestStream  = s;
        bestMinZoom = minZoom;
      } else {
        s.getVideoTracks().forEach(t => t.stop());
      }
    } catch { /* skip inaccessible device */ }
  }

  if (bestStream) {
    const videoDeviceId = bestStream.getVideoTracks()[0].getSettings().deviceId;
    bestStream.getVideoTracks().forEach(t => t.stop());
    return navigator.mediaDevices.getUserMedia({
      video: { deviceId: { exact: videoDeviceId }, width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 30 } },
      audio: true,
    });
  }

  return navigator.mediaDevices.getUserMedia({
    video: { facingMode: "environment", width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 30 } },
    audio: true,
  });
}

// ── Format helpers ────────────────────────────────────────────────────────────
function fmt(totalSec: number) {
  const s = Math.max(0, Math.floor(totalSec));
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

// ── Page shell (Suspense wrapper) ─────────────────────────────────────────────
export default function RecordPage() {
  return (
    <Suspense
      fallback={
        <div className="min-h-screen bg-black flex items-center justify-center">
          <Loader2 className="text-green-400 animate-spin" size={32} />
        </div>
      }
    >
      <RecordPageInner />
    </Suspense>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────
function RecordPageInner() {
  const router      = useRouter();
  const { id }      = useParams<{ id: string }>();
  const searchParams = useSearchParams();
  const urlSide     = searchParams.get("side") as Side | null;

  // If URL has ?side=…, start directly; otherwise show picker
  const [side,  setSide]  = useState<Side | null>(urlSide);
  const [phase, setPhase] = useState<Phase>(urlSide ? "ready" : "selecting");

  const idbKey         = side ? `${id}-${side}` : "";
  const isCoordinator  = side === "left"; // left phone owns the QR + writes sync timestamp

  const videoRef      = useRef<HTMLVideoElement>(null);
  const streamRef     = useRef<MediaStream | null>(null);
  const recorderRef   = useRef<MediaRecorder | null>(null);
  const chunksRef     = useRef<Blob[]>([]);
  const autoStopRef   = useRef<ReturnType<typeof setTimeout> | null>(null);
  const syncStartedRef = useRef(false); // prevent coordinator from writing sync_start twice
  const pendingBlobRef = useRef<Blob | null>(null);

  const [peerConnected,   setPeerConnected]   = useState(false);
  const [cameraReady,     setCameraReady]     = useState(false);
  const [cameraError,     setCameraError]     = useState<string | null>(null);
  const [syncStartAt,     setSyncStartAt]     = useState<number | null>(null);
  const [countdownSecs,   setCountdownSecs]   = useState(0);
  const [recordingSecs,   setRecordingSecs]   = useState(0);
  const [uploadProgress,  setUploadProgress]  = useState(0);
  const [uploadError,     setUploadError]     = useState<string | null>(null);
  const [showUploadPrompt,setShowUploadPrompt]= useState(false);
  const [pendingMB,       setPendingMB]       = useState(0);
  const [hasSavedBlob,    setHasSavedBlob]    = useState(false);
  const [origin,          setOrigin]          = useState("");

  useEffect(() => { setOrigin(window.location.origin); }, []);
  useEffect(() => { const t = setTimeout(() => window.scrollTo(0, 1), 100); return () => clearTimeout(t); }, []);

  // ── Resume saved blob from previous session ──────────────────────────────
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
    return () => {
      active = false;
      streamRef.current?.getTracks().forEach(t => t.stop());
    };
  }, [side, hasSavedBlob]);

  // ── Signal: announce connection ───────────────────────────────────────────
  useEffect(() => {
    if (!side || !id) return;
    fetch(`/api/sessions/${id}/signal`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "connect", side }),
    }).catch(() => {});
  }, [side, id]);

  // ── Signal: poll for peer + sync timestamp ────────────────────────────────
  // Intentionally excludes `phase` from deps so the interval survives phase changes.
  useEffect(() => {
    if (!side || !id) return;
    let stopped = false;

    const tick = async () => {
      if (stopped) return;
      try {
        const res = await fetch(`/api/sessions/${id}/signal`);
        const s   = await res.json();

        const peerIsConn = side === "left" ? s.rightConnected : s.leftConnected;
        if (peerIsConn) setPeerConnected(true);

        // Coordinator: once both connected, write sync start timestamp (once only)
        if (isCoordinator && peerIsConn && !syncStartedRef.current) {
          syncStartedRef.current = true;
          await fetch(`/api/sessions/${id}/signal`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ action: "sync_start", side }),
          });
        }

        // Lift syncStartAt into state — separate effect drives the countdown
        if (s.syncStartAt) {
          setSyncStartAt((prev) => prev ?? s.syncStartAt);
        }
      } catch { /* network blip */ }
    };

    const interval = setInterval(tick, POLL_MS);
    tick();
    return () => { stopped = true; clearInterval(interval); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [side, id, isCoordinator]);

  // ── Countdown: driven by syncStartAt, fully independent of polling ──────────
  useEffect(() => {
    if (!syncStartAt) return;

    const secsUntil = (syncStartAt - Date.now()) / 1000;
    if (secsUntil <= 0) {
      doStartRecording();
      return;
    }

    setPhase("countdown");
    setCountdownSecs(Math.ceil(secsUntil));

    const timer = setInterval(() => {
      const remaining = (syncStartAt - Date.now()) / 1000;
      if (remaining <= 0) {
        clearInterval(timer);
        doStartRecording();
      } else {
        setCountdownSecs(Math.ceil(remaining));
      }
    }, 500);

    return () => clearInterval(timer);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [syncStartAt]);

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
    setRecordingSecs(RECORD_MS / 1000);

    // Countdown timer during recording
    const startedAt = Date.now();
    const recordTimer = setInterval(() => {
      const remaining = RECORD_MS / 1000 - (Date.now() - startedAt) / 1000;
      if (remaining <= 0) {
        clearInterval(recordTimer);
        doStopRecording();
      } else {
        setRecordingSecs(remaining);
      }
    }, 500);

    // Cleanup auto-stop reference
    autoStopRef.current = setTimeout(() => clearInterval(recordTimer), RECORD_MS + 2000);

    // Clean up sync timestamp from DB (best-effort, coordinator only)
    if (isCoordinator) {
      fetch(`/api/sessions/${id}/signal`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "clear_sync", side }),
      }).catch(() => {});
    }
  }, [isCoordinator, id, side]);

  const doStopRecording = useCallback(() => {
    if (autoStopRef.current) { clearTimeout(autoStopRef.current); autoStopRef.current = null; }
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

  // ── Upload ────────────────────────────────────────────────────────────────
  const doUpload = useCallback(async () => {
    const blob = pendingBlobRef.current;
    setShowUploadPrompt(false);
    setPhase("uploading");
    setUploadError(null);

    if (!blob || blob.size === 0 || !side) {
      setUploadError("No video data to upload.");
      setPhase("error");
      return;
    }

    const contentType = blob.type || "video/webm";
    try {
      const res = await fetch("/api/upload", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ session_id: id, camera: side, content_type: contentType }),
      });
      if (!res.ok) throw new Error(`Could not get upload URL (${res.status})`);
      const { url, key: uploadedKey } = await res.json();
      if (!url) throw new Error("No upload URL returned");

      await new Promise<void>((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open("PUT", url);
        xhr.setRequestHeader("Content-Type", contentType);
        xhr.upload.onprogress = (e) => {
          if (e.lengthComputable) setUploadProgress(Math.round((e.loaded / e.total) * 100));
        };
        xhr.onload  = () => { xhr.status >= 200 && xhr.status < 300 ? resolve() : reject(new Error(`Upload failed (${xhr.status})`)); };
        xhr.onerror = () => reject(new Error("Upload blocked by CORS — add this domain to your R2 bucket CORS settings."));
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
      const a   = document.createElement("a");
      a.href     = url;
      a.download = `fieldvision-${side}-${id.slice(0, 8)}.webm`;
      a.click();
      URL.revokeObjectURL(url);
    }
  }, [idbKey, id, side]);

  const qrUrl = origin && id ? `${origin}/session/${id}/record?side=right` : "";

  // ── SCREEN: Side picker ──────────────────────────────────────────────────
  if (phase === "selecting") {
    return (
      <div className="min-h-screen bg-black flex flex-col items-center justify-center gap-6 px-8">
        <div className="text-center mb-4">
          <p className="text-xs text-green-600 uppercase tracking-widest font-semibold mb-2">FieldVision · Sync Setup</p>
          <h1 className="text-white text-2xl font-bold">Which side are you?</h1>
          <p className="text-gray-500 text-sm mt-2">Select your camera's position on the field</p>
        </div>
        <button
          onClick={() => { setSide("left"); setPhase("ready"); }}
          className="w-full bg-green-500 active:bg-green-600 text-black font-bold py-6 rounded-2xl text-xl"
        >
          ◀ LEFT camera
        </button>
        <button
          onClick={() => { setSide("right"); setPhase("ready"); }}
          className="w-full bg-white active:bg-gray-200 text-black font-bold py-6 rounded-2xl text-xl"
        >
          RIGHT camera ▶
        </button>
        <p className="text-gray-600 text-xs text-center mt-2">
          The LEFT phone will show a QR code for the RIGHT phone to scan.
        </p>
      </div>
    );
  }

  // ── SCREEN: Pending upload resume ─────────────────────────────────────────
  if (hasSavedBlob && phase !== "uploading" && phase !== "done") {
    return (
      <div className="min-h-screen bg-black flex flex-col items-center justify-center gap-6 px-8">
        <div className="text-center">
          <p className="text-xs text-gray-500 uppercase tracking-widest mb-2">FieldVision · {side} Camera</p>
          <Wifi size={48} className="text-green-400 mx-auto mb-4" />
          <h1 className="text-white text-xl font-bold">Pending upload</h1>
          <p className="text-gray-400 text-sm mt-2">Your {pendingMB} MB recording is saved on this device.</p>
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
        <p className="text-gray-600 text-xs text-center">Keep this page open. The video is saved to this browser.</p>
      </div>
    );
  }

  // ── SCREEN: Upload progress / done ────────────────────────────────────────
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

  // ── SCREEN: Camera + all live phases (ready / countdown / recording / stopped)
  return (
    <div className="fixed inset-0 bg-black overflow-hidden">
      {/* Camera preview — always behind overlays */}
      <div className="absolute inset-0">
        {!cameraReady && !cameraError && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 z-10">
            <Loader2 className="text-green-400 animate-spin" size={36} />
            <p className="text-gray-500 text-sm">Opening wide camera…</p>
          </div>
        )}
        <video ref={videoRef} className="w-full h-full object-cover" muted playsInline autoPlay />
      </div>

      {/* ── Overlay: QR code (left/coordinator, waiting for peer) ─────────── */}
      {cameraReady && isCoordinator && !peerConnected && phase === "ready" && (
        <div className="absolute inset-0 bg-black/85 flex flex-col items-center justify-center gap-5 px-6 z-20">
          <div className="text-center">
            <p className="text-xs text-green-600 uppercase tracking-widest font-semibold mb-2">LEFT camera ready</p>
            <p className="text-white font-semibold text-lg">Have the RIGHT phone scan this</p>
            <p className="text-gray-500 text-sm mt-1">Session {id.slice(0, 8)}</p>
          </div>
          {qrUrl && (
            <div className="bg-white p-4 rounded-2xl">
              <QRCodeSVG value={qrUrl} size={220} bgColor="#ffffff" fgColor="#000000" />
            </div>
          )}
          <div className="flex items-center gap-2 text-gray-400 text-sm">
            <Loader2 size={13} className="animate-spin" />
            <span>Waiting for right camera…</span>
          </div>
        </div>
      )}

      {/* ── Overlay: Right phone joining ──────────────────────────────────── */}
      {cameraReady && !isCoordinator && !peerConnected && phase === "ready" && (
        <div className="absolute inset-0 bg-black/85 flex flex-col items-center justify-center gap-4 px-6 z-20">
          <Loader2 className="text-green-400 animate-spin" size={44} />
          <p className="text-xs text-green-600 uppercase tracking-widest font-semibold">RIGHT camera</p>
          <p className="text-white font-semibold text-lg">Linking with left camera…</p>
        </div>
      )}

      {/* ── Overlay: Countdown ────────────────────────────────────────────── */}
      {phase === "countdown" && (
        <div className="absolute inset-0 bg-black/75 flex flex-col items-center justify-center gap-6 px-8 z-20">
          <div className="text-center">
            <p className="text-xs text-green-500 uppercase tracking-widest font-semibold mb-3">
              Both cameras linked ✓
            </p>
            <p className="text-white text-base font-medium mb-6">Recording starts in</p>
            <p className="text-green-400 font-mono font-bold" style={{ fontSize: "5rem", lineHeight: 1 }}>
              {fmt(countdownSecs)}
            </p>
          </div>

          <div className="w-full max-w-xs bg-black/60 border border-green-900/50 rounded-2xl p-5 text-center">
            <p className="text-green-400 font-semibold text-sm mb-2">Set up now</p>
            <p className="text-gray-300 text-sm leading-relaxed">
              Elevate the tripod to the desired height. Aim at the centre circle. Lock the phone in position. Do not move once recording starts.
            </p>
          </div>

          <p className="text-gray-600 text-xs text-center">Recording will auto-stop after 3 minutes</p>
        </div>
      )}

      {/* ── Overlay: Recording timer ──────────────────────────────────────── */}
      {phase === "recording" && (
        <>
          <div className="absolute top-4 left-1/2 -translate-x-1/2 flex items-center gap-2 bg-black/70 rounded-full px-5 py-2.5 z-20">
            <span className="w-2.5 h-2.5 rounded-full bg-red-500 animate-pulse" />
            <span className="text-white font-mono text-2xl font-bold">{fmt(recordingSecs)}</span>
          </div>
          {/* Stop early button */}
          <div className="absolute bottom-10 left-6 right-6 z-20">
            <button
              onClick={doStopRecording}
              className="w-full bg-white/10 active:bg-white/20 border border-white/20 text-white font-semibold py-4 rounded-2xl text-base"
            >
              Stop recording early
            </button>
          </div>
        </>
      )}

      {/* ── Overlay: Camera error ─────────────────────────────────────────── */}
      {cameraError && (
        <div className="absolute inset-0 bg-black/90 flex flex-col items-center justify-center gap-3 p-6 z-20">
          <AlertCircle className="text-red-400" size={40} />
          <p className="text-red-400 font-semibold text-center">{cameraError}</p>
          <p className="text-gray-500 text-sm text-center">Allow camera access and reload.</p>
        </div>
      )}

      {/* ── Overlay: Upload prompt after auto-stop ────────────────────────── */}
      {showUploadPrompt && (
        <div className="absolute inset-0 bg-black/92 flex flex-col items-center justify-center gap-6 px-8 z-20">
          <div className="text-center">
            <CheckCircle2 size={48} className="text-green-400 mx-auto mb-4" />
            <p className="text-white text-xl font-bold mb-2">Recording complete!</p>
            <p className="text-gray-400 text-sm leading-relaxed">
              Your video is <span className="text-white font-semibold">{pendingMB} MB</span>.
              Upload now or wait for WiFi.
            </p>
          </div>
          {uploadError && (
            <div className="flex items-start gap-2 bg-red-950/40 border border-red-800/40 rounded-xl p-4 w-full">
              <AlertCircle size={16} className="text-red-400 mt-0.5 shrink-0" />
              <p className="text-red-300 text-sm">{uploadError}</p>
            </div>
          )}
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

      {/* ── Status pill ──────────────────────────────────────────────────── */}
      {phase !== "countdown" && phase !== "recording" && !showUploadPrompt && (
        <div className="absolute top-4 left-4 z-20">
          <div className={cn(
            "flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-medium border backdrop-blur-sm",
            peerConnected
              ? "bg-green-900/70 text-green-300 border-green-700/50"
              : "bg-black/60 text-gray-500 border-gray-700/50"
          )}>
            <span className={cn("w-1.5 h-1.5 rounded-full", peerConnected ? "bg-green-400" : "bg-gray-600")} />
            <span className="capitalize">{side}</span>
            <span className="text-gray-500 mx-0.5">·</span>
            <span className="capitalize">{side === "left" ? "right" : "left"}:</span>
            <span>{peerConnected ? "linked" : "waiting…"}</span>
          </div>
        </div>
      )}
    </div>
  );
}
