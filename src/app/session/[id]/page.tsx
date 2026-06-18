"use client";

import { useEffect, useState, useCallback } from "react";
import { useParams } from "next/navigation";
import { Loader2, CheckCircle2, AlertCircle, Play, Download, Trophy, Film } from "lucide-react";
import { supabase } from "@/lib/supabase";
import type { Session, Highlight } from "@/types/database";
import { cn } from "@/lib/cn";

interface SessionWithUrls extends Session {
  urls?: {
    stitched_video?: string;
    tracked_video?: string;
  };
  highlights?: (Highlight & { clip_url?: string })[];
}

const STATUS_STEPS = ["created", "uploading", "processing", "done"] as const;

const PROGRESS_LABELS: Record<string, string> = {
  created: "Session created",
  uploading: "Uploading videos",
  processing: "AI processing",
  done: "Complete",
};

export default function SessionPage() {
  const { id } = useParams<{ id: string }>();
  const [session, setSession] = useState<SessionWithUrls | null>(null);
  const [activeTab, setActiveTab] = useState<"panoramic" | "tracked" | "highlights">("panoramic");
  const [activeHighlight, setActiveHighlight] = useState<number>(0);

  const fetchSession = useCallback(async () => {
    const res = await fetch(`/api/sessions/${id}`);
    if (res.ok) {
      const data = await res.json();
      setSession(data);
    }
  }, [id]);

  useEffect(() => {
    fetchSession();
  }, [fetchSession]);

  // Realtime subscription for live status updates
  useEffect(() => {
    const channel = supabase
      .channel(`session:${id}`)
      .on(
        "postgres_changes",
        { event: "UPDATE", schema: "public", table: "sessions", filter: `id=eq.${id}` },
        () => { fetchSession(); }
      )
      .subscribe();

    return () => { supabase.removeChannel(channel); };
  }, [id, fetchSession]);

  if (!session) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <Loader2 className="text-green-400 animate-spin" size={32} />
      </div>
    );
  }

  const currentStepIndex = STATUS_STEPS.indexOf(session.status as typeof STATUS_STEPS[number]);
  const isProcessing = session.status === "processing";
  const isDone = session.status === "done";
  const isError = session.status === "error";

  return (
    <div className="min-h-screen px-4 py-8 max-w-5xl mx-auto">
      {/* Header */}
      <div className="flex items-start justify-between mb-8">
        <div>
          <a href="/" className="text-green-500 text-sm font-medium hover:text-green-400 mb-2 inline-block">&larr; FieldVision</a>
          <h1 className="text-2xl font-bold">{session.team_name || "Match Session"}</h1>
          <p className="text-green-200/50 text-sm">{session.match_date || ""} · <span className="font-mono text-xs text-green-700">{id}</span></p>
        </div>
        <StatusBadge status={session.status} />
      </div>

      {/* Progress steps */}
      {!isDone && !isError && (
        <div className="bg-green-950/30 border border-green-900/40 rounded-2xl p-6 mb-8">
          <div className="flex items-center gap-0 mb-6">
            {STATUS_STEPS.map((s, i) => (
              <div key={s} className="flex items-center flex-1 last:flex-none">
                <div className="flex flex-col items-center gap-1">
                  <div className={cn(
                    "w-7 h-7 rounded-full flex items-center justify-center text-xs transition-all",
                    i < currentStepIndex ? "bg-green-500 text-black" :
                      i === currentStepIndex ? "bg-green-500/30 border-2 border-green-500 text-green-300" :
                        "bg-green-900/40 text-green-700 border border-green-800/40"
                  )}>
                    {i < currentStepIndex ? <CheckCircle2 size={14} /> : i + 1}
                  </div>
                  <span className={cn(
                    "text-[10px] font-medium whitespace-nowrap",
                    i === currentStepIndex ? "text-green-300" : i < currentStepIndex ? "text-green-500" : "text-green-800"
                  )}>
                    {PROGRESS_LABELS[s]}
                  </span>
                </div>
                {i < STATUS_STEPS.length - 1 && (
                  <div className={cn("flex-1 h-px mx-2 mb-4", i < currentStepIndex ? "bg-green-500/60" : "bg-green-900/40")} />
                )}
              </div>
            ))}
          </div>

          {isProcessing && (
            <div className="flex flex-col gap-2">
              <div className="flex justify-between text-xs text-green-500">
                <span>Processing with AI...</span>
                <span>{session.progress ?? 0}%</span>
              </div>
              <div className="w-full bg-green-900/30 rounded-full h-2">
                <div
                  className="bg-green-500 h-2 rounded-full transition-all duration-500"
                  style={{ width: `${session.progress ?? 0}%` }}
                />
              </div>
              <p className="text-xs text-green-700 mt-1">
                Stitching videos, running ball tracking, detecting highlights...
              </p>
            </div>
          )}
        </div>
      )}

      {/* Error state */}
      {isError && (
        <div className="bg-red-950/30 border border-red-800/40 rounded-2xl p-6 mb-8 flex items-start gap-3">
          <AlertCircle size={20} className="text-red-400 mt-0.5 shrink-0" />
          <div>
            <p className="font-semibold text-red-300">Processing failed</p>
            <p className="text-sm text-red-400/70 mt-1">{session.error_message || "An unknown error occurred."}</p>
          </div>
        </div>
      )}

      {/* Results */}
      {isDone && (
        <>
          {/* Tabs */}
          <div className="flex gap-1 p-1 bg-green-950/30 rounded-xl border border-green-900/30 mb-6 w-fit">
            {[
              { key: "panoramic", label: "Full Panorama", icon: Film },
              { key: "tracked", label: "Ball Tracking", icon: Play },
              { key: "highlights", label: "Highlights", icon: Trophy },
            ].map(({ key, label, icon: Icon }) => (
              <button
                key={key}
                onClick={() => setActiveTab(key as typeof activeTab)}
                className={cn(
                  "flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-colors",
                  activeTab === key
                    ? "bg-green-500 text-black"
                    : "text-green-400 hover:text-green-300"
                )}
              >
                <Icon size={14} />
                {label}
              </button>
            ))}
          </div>

          {/* Panoramic view */}
          {activeTab === "panoramic" && session.urls?.stitched_video && (
            <div className="rounded-2xl overflow-hidden border border-green-900/40 bg-black">
              <video
                src={session.urls.stitched_video}
                controls
                className="w-full aspect-video"
                playsInline
              />
              <div className="flex items-center justify-between px-4 py-3 border-t border-green-900/30">
                <span className="text-xs text-green-600 font-mono">STITCHED PANORAMA</span>
                <a
                  href={session.urls.stitched_video}
                  download
                  className="flex items-center gap-1 text-green-400 hover:text-green-300 text-xs font-medium"
                >
                  <Download size={12} /> Download
                </a>
              </div>
            </div>
          )}

          {/* Ball tracking */}
          {activeTab === "tracked" && session.urls?.tracked_video && (
            <div className="rounded-2xl overflow-hidden border border-green-900/40 bg-black">
              <video
                src={session.urls.tracked_video}
                controls
                className="w-full aspect-video"
                playsInline
              />
              <div className="flex items-center justify-between px-4 py-3 border-t border-green-900/30">
                <span className="text-xs text-green-600 font-mono">AI BALL + PLAYER TRACKING</span>
                <a
                  href={session.urls.tracked_video}
                  download
                  className="flex items-center gap-1 text-green-400 hover:text-green-300 text-xs font-medium"
                >
                  <Download size={12} /> Download
                </a>
              </div>
            </div>
          )}

          {/* Highlights */}
          {activeTab === "highlights" && session.highlights && session.highlights.length > 0 && (
            <div className="grid md:grid-cols-[1fr_300px] gap-4">
              <div className="rounded-2xl overflow-hidden border border-green-900/40 bg-black">
                <video
                  src={session.highlights[activeHighlight]?.clip_url}
                  controls
                  autoPlay
                  className="w-full aspect-video"
                  playsInline
                />
                <div className="px-4 py-3 border-t border-green-900/30">
                  <p className="text-sm font-semibold text-green-300">
                    {session.highlights[activeHighlight]?.label}
                  </p>
                </div>
              </div>

              <div className="flex flex-col gap-2">
                {session.highlights.map((h, i) => (
                  <button
                    key={i}
                    onClick={() => setActiveHighlight(i)}
                    className={cn(
                      "flex items-center gap-3 p-3 rounded-xl border text-left transition-colors",
                      activeHighlight === i
                        ? "border-green-500/60 bg-green-900/30"
                        : "border-green-900/30 bg-green-950/20 hover:border-green-700/40"
                    )}
                  >
                    <div className="bg-green-500/20 rounded-lg p-2 shrink-0">
                      <Trophy size={14} className="text-green-400" />
                    </div>
                    <div>
                      <p className="text-sm font-medium text-green-200">{h.label}</p>
                      <p className="text-xs text-green-600 font-mono">
                        {Math.floor(h.start_sec / 60)}:{String(h.start_sec % 60).padStart(2, "0")}
                      </p>
                    </div>
                  </button>
                ))}
              </div>
            </div>
          )}

          {activeTab === "highlights" && (!session.highlights || session.highlights.length === 0) && (
            <div className="text-center py-16 text-green-700">
              <Trophy size={32} className="mx-auto mb-3 opacity-30" />
              <p>No highlights detected in this match.</p>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const configs: Record<string, { label: string; className: string }> = {
    created: { label: "Created", className: "bg-green-900/30 text-green-500 border-green-800/40" },
    uploading: { label: "Uploading", className: "bg-blue-900/30 text-blue-400 border-blue-800/40" },
    processing: { label: "Processing", className: "bg-yellow-900/30 text-yellow-400 border-yellow-800/40" },
    done: { label: "Ready", className: "bg-green-500/20 text-green-300 border-green-500/40" },
    error: { label: "Error", className: "bg-red-900/30 text-red-400 border-red-800/40" },
  };
  const c = configs[status] ?? configs.created;
  return (
    <span className={cn("text-xs font-semibold px-3 py-1 rounded-full border", c.className)}>
      {c.label}
    </span>
  );
}
