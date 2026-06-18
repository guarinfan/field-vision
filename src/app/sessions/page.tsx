"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { supabase } from "@/lib/supabase";
import type { Session } from "@/types/database";
import { cn } from "@/lib/cn";
import { Plus, Film, Clock, CheckCircle2, AlertCircle, Loader2 } from "lucide-react";

export default function SessionsPage() {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function load() {
      const { data } = await supabase
        .from("sessions")
        .select("*")
        .order("created_at", { ascending: false })
        .limit(50);
      setSessions((data as unknown as Session[]) ?? []);
      setLoading(false);
    }
    load();
  }, []);

  return (
    <div className="min-h-screen px-4 py-8 max-w-3xl mx-auto">
      <div className="flex items-center justify-between mb-8">
        <div>
          <a href="/" className="text-green-500 text-sm font-medium hover:text-green-400 mb-2 inline-block">
            &larr; FieldVision
          </a>
          <h1 className="text-2xl font-bold">Match Sessions</h1>
        </div>
        <Link
          href="/session/new"
          className="flex items-center gap-2 bg-green-500 hover:bg-green-400 text-black font-semibold text-sm px-4 py-2 rounded-lg transition-colors"
        >
          <Plus size={14} /> New Session
        </Link>
      </div>

      {loading && (
        <div className="flex items-center justify-center py-24">
          <Loader2 className="text-green-500 animate-spin" size={24} />
        </div>
      )}

      {!loading && sessions.length === 0 && (
        <div className="flex flex-col items-center gap-4 py-24 text-green-700">
          <Film size={36} className="opacity-30" />
          <p>No sessions yet.</p>
          <Link
            href="/session/new"
            className="text-green-400 hover:text-green-300 text-sm font-medium underline underline-offset-2"
          >
            Create your first session
          </Link>
        </div>
      )}

      {!loading && sessions.length > 0 && (
        <div className="flex flex-col gap-3">
          {sessions.map((s) => (
            <Link
              key={s.id}
              href={`/session/${s.id}`}
              className="flex items-center justify-between p-4 bg-green-950/30 border border-green-900/40 rounded-xl hover:border-green-700/50 transition-colors"
            >
              <div className="flex items-center gap-4">
                <div className="bg-green-900/40 p-2.5 rounded-lg">
                  <Film size={16} className="text-green-400" />
                </div>
                <div>
                  <p className="font-semibold text-green-100 text-sm">
                    {s.team_name || "Untitled Match"}
                  </p>
                  <p className="text-xs text-green-600 flex items-center gap-1.5 mt-0.5">
                    <Clock size={10} />
                    {s.match_date ?? new Date(s.created_at).toLocaleDateString()}
                  </p>
                </div>
              </div>
              <StatusPill status={s.status} progress={s.progress} />
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}

function StatusPill({ status, progress }: { status: string; progress: number | null }) {
  const map: Record<string, { label: string; icon: React.ReactNode; className: string }> = {
    created:    { label: "Created",    icon: <Clock size={11} />,        className: "text-green-600 bg-green-900/30 border-green-800/40" },
    uploading:  { label: "Uploading",  icon: <Loader2 size={11} className="animate-spin" />, className: "text-blue-400 bg-blue-900/30 border-blue-800/40" },
    processing: { label: `${progress ?? 0}%`, icon: <Loader2 size={11} className="animate-spin" />, className: "text-yellow-400 bg-yellow-900/30 border-yellow-800/40" },
    done:       { label: "Ready",      icon: <CheckCircle2 size={11} />, className: "text-green-300 bg-green-500/20 border-green-500/40" },
    error:      { label: "Error",      icon: <AlertCircle size={11} />,  className: "text-red-400 bg-red-900/30 border-red-800/40" },
  };
  const c = map[status] ?? map.created;
  return (
    <span className={cn("flex items-center gap-1.5 text-xs font-semibold px-2.5 py-1 rounded-full border", c.className)}>
      {c.icon} {c.label}
    </span>
  );
}
