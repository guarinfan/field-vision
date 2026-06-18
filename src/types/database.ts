export type SessionStatus = "created" | "uploading" | "processing" | "done" | "error";

export interface Session {
  id: string;
  created_at: string;
  status: SessionStatus;
  team_name: string | null;
  match_date: string | null;
  left_video_key: string | null;
  right_video_key: string | null;
  stitched_video_key: string | null;
  tracked_video_key: string | null;
  highlights: Highlight[] | null;
  error_message: string | null;
  progress: number | null;
}

export interface Highlight {
  label: string;
  start_sec: number;
  end_sec: number;
  clip_key: string;
}

export type Database = {
  public: {
    Tables: {
      sessions: {
        Row: Session;
        Insert: Partial<Session> & { id: string };
        Update: Partial<Session>;
      };
    };
  };
};
