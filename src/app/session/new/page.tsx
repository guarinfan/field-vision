"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { ChevronRight, Loader2, Upload, Camera, CheckCircle2 } from "lucide-react";
import { useRef } from "react";
import { cn } from "@/lib/cn";

export default function NewSessionPage() {
  const router   = useRouter();
  const [teamName,       setTeamName]       = useState("");
  const [matchDate,      setMatchDate]      = useState("");
  const [isCoordinator,  setIsCoordinator]  = useState(false);
  const [creating,       setCreating]       = useState(false);
  const [error,          setError]          = useState<string | null>(null);
  // Upload path state (secondary)
  const [sessionId,      setSessionId]      = useState<string | null>(null);
  const [showUpload,     setShowUpload]      = useState(false);
  const [leftDone,       setLeftDone]       = useState(false);
  const [rightDone,      setRightDone]      = useState(false);
  const [leftProgress,   setLeftProgress]   = useState(0);
  const [rightProgress,  setRightProgress]  = useState(0);
  const [leftUploading,  setLeftUploading]  = useState(false);
  const [rightUploading, setRightUploading] = useState(false);
  const leftRef  = useRef<HTMLInputElement>(null);
  const rightRef = useRef<HTMLInputElement>(null);

  async function activateSession() {
    if (!teamName.trim()) return;
    setCreating(true);
    setError(null);
    try {
      const res = await fetch("/api/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ team_name: teamName.trim(), match_date: matchDate }),
      });
      if (!res.ok) throw new Error("Failed to create session");
      const { id } = await res.json();
      if (isCoordinator) {
        router.push(`/session/${id}/control`);
      } else {
        setSessionId(id);
        setShowUpload(true);
      }
    } catch (e: any) {
      setError(e.message);
      setCreating(false);
    }
  }

  async function uploadVideo(camera: "left" | "right", file: File) {
    const setUploading = camera === "left" ? setLeftUploading : setRightUploading;
    const setProgress  = camera === "left" ? setLeftProgress  : setRightProgress;
    const setDone      = camera === "left" ? setLeftDone      : setRightDone;
    setUploading(true);
    try {
      const res = await fetch("/api/upload", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ session_id: sessionId, camera, content_type: file.type || "video/mp4" }),
      });
      if (!res.ok) throw new Error("Upload URL error");
      const { url, key } = await res.json();
      await new Promise<void>((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.upload.onprogress = (e) => { if (e.lengthComputable) setProgress(Math.round(e.loaded / e.total * 100)); };
        xhr.onload = async () => {
          if (xhr.status >= 200 && xhr.status < 300) {
            await fetch(`/api/sessions/${sessionId}/upload-done`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ side: camera, key }) });
            setDone(true); setProgress(100); resolve();
          } else reject(new Error(`Upload failed (${xhr.status})`));
        };
        xhr.onerror = () => reject(new Error("Upload error"));
        xhr.open("PUT", url);
        xhr.send(file);
      });
    } catch (e: any) {
      setError(e.message);
    } finally {
      setUploading(false);
    }
  }

  async function startProcessing() {
    if (!sessionId) return;
    setCreating(true);
    await fetch("/api/process", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ session_id: sessionId }) });
    router.push(`/session/${sessionId}`);
  }

  // ── Upload view (secondary path) ─────────────────────────────────────────
  if (showUpload) {
    return (
      <div className="min-h-screen px-4 py-12 flex flex-col items-center">
        <div className="w-full max-w-lg">
          <a href="/" className="text-green-500 text-sm font-medium hover:text-green-400 mb-6 inline-block">&larr; FieldVision</a>
          <h1 className="text-2xl font-bold mb-1">Upload Footage</h1>
          <p className="text-green-200/50 text-sm mb-8">{teamName}</p>
          <div className="flex flex-col gap-5">
            {(["left", "right"] as const).map(camera => {
              const done       = camera === "left" ? leftDone      : rightDone;
              const uploading  = camera === "left" ? leftUploading : rightUploading;
              const progress   = camera === "left" ? leftProgress  : rightProgress;
              const inputRef   = camera === "left" ? leftRef       : rightRef;
              return (
                <div key={camera} className={cn("border rounded-xl p-5 flex flex-col gap-3 transition-colors", done ? "border-green-500/60 bg-green-900/20" : "border-green-800/40 bg-green-950/20")}>
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      <div className="bg-green-500/20 border border-green-500/30 rounded-lg p-2"><Camera size={16} className="text-green-400" /></div>
                      <div>
                        <p className="font-semibold text-sm capitalize">{camera} Camera</p>
                        <p className="text-xs text-green-300/50">{camera === "left" ? "Left half of pitch" : "Right half of pitch"}</p>
                      </div>
                    </div>
                    {done && <CheckCircle2 size={18} className="text-green-400" />}
                    {uploading && <Loader2 size={18} className="text-green-400 animate-spin" />}
                  </div>
                  {uploading && <div className="w-full bg-green-900/30 rounded-full h-1.5"><div className="bg-green-500 h-1.5 rounded-full transition-all" style={{ width: `${progress}%` }} /></div>}
                  {!done && !uploading && (
                    <button onClick={() => inputRef.current?.click()} className="text-xs text-green-500 hover:text-green-300 text-left">Click to select video file →</button>
                  )}
                  <input ref={inputRef} type="file" accept="video/mp4,video/*" className="hidden" onChange={e => { const f = e.target.files?.[0]; if (f) uploadVideo(camera, f); }} />
                </div>
              );
            })}
            {error && <p className="text-red-400 text-sm">{error}</p>}
            <button disabled={!leftDone || !rightDone || creating} onClick={startProcessing} className="flex items-center justify-center gap-2 bg-green-500 hover:bg-green-400 disabled:opacity-40 disabled:cursor-not-allowed text-black font-bold px-6 py-3 rounded-xl transition-colors">
              {creating ? <Loader2 size={16} className="animate-spin" /> : <><ChevronRight size={16} /> Start AI Processing</>}
            </button>
          </div>
        </div>
      </div>
    );
  }

  // ── Main create view ──────────────────────────────────────────────────────
  return (
    <div className="min-h-screen px-4 py-12 flex flex-col items-center">
      <div className="w-full max-w-md">
        <a href="/" className="text-green-500 text-sm font-medium hover:text-green-400 mb-6 inline-block">&larr; FieldVision</a>

        <h1 className="text-3xl font-bold mb-1">New Session</h1>
        <p className="text-green-200/50 text-sm mb-8">Name your match and activate the recording session.</p>

        <div className="flex flex-col gap-5">
          {/* Team / Match name */}
          <div>
            <label className="block text-sm font-medium text-green-300 mb-1.5">Team / Match name <span className="text-red-400">*</span></label>
            <input
              value={teamName}
              onChange={e => setTeamName(e.target.value)}
              placeholder="e.g. FC Galaxy vs United SC"
              className="w-full bg-green-950/30 border border-green-800/50 rounded-xl px-4 py-3 text-sm text-green-100 placeholder:text-green-700 focus:outline-none focus:border-green-500 transition-colors"
            />
          </div>

          {/* Match date */}
          <div>
            <label className="block text-sm font-medium text-green-300 mb-1.5">Match date</label>
            <input
              type="date"
              value={matchDate}
              onChange={e => setMatchDate(e.target.value)}
              className="w-full bg-green-950/30 border border-green-800/50 rounded-xl px-4 py-3 text-sm text-green-100 focus:outline-none focus:border-green-500 transition-colors"
            />
          </div>

          {/* Coordinator checkbox */}
          <label className={cn(
            "flex items-start gap-4 border rounded-xl p-4 cursor-pointer transition-colors",
            isCoordinator ? "border-green-500/60 bg-green-900/20" : "border-green-800/40 bg-green-950/20 hover:border-green-700/60"
          )}>
            <div className={cn(
              "w-5 h-5 rounded flex items-center justify-center border-2 shrink-0 mt-0.5 transition-colors",
              isCoordinator ? "bg-green-500 border-green-500" : "border-green-700 bg-transparent"
            )}>
              {isCoordinator && <svg viewBox="0 0 10 8" className="w-3 h-3 text-black fill-current"><path d="M1 4l3 3 5-6" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round" strokeLinejoin="round" /></svg>}
            </div>
            <input type="checkbox" checked={isCoordinator} onChange={e => setIsCoordinator(e.target.checked)} className="sr-only" />
            <div>
              <p className="text-sm font-semibold text-green-200">I am the coordinator</p>
              <p className="text-xs text-green-700 mt-0.5">You'll control when recording starts and stops. Camera phones scan a QR code to join.</p>
            </div>
          </label>

          {error && <p className="text-red-400 text-sm">{error}</p>}

          {/* Activate button */}
          <button
            onClick={activateSession}
            disabled={!teamName.trim() || creating}
            className="flex items-center justify-center gap-2 bg-green-500 hover:bg-green-400 active:bg-green-600 disabled:opacity-40 disabled:cursor-not-allowed text-black font-bold px-6 py-4 rounded-xl text-base transition-colors"
          >
            {creating
              ? <Loader2 size={18} className="animate-spin" />
              : isCoordinator
                ? <><ChevronRight size={18} /> Activate Session</>
                : <><Upload size={18} /> Continue to Upload</>
            }
          </button>
        </div>
      </div>
    </div>
  );
}
