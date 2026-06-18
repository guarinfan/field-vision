-- Run this in your Supabase SQL editor to set up the sessions table.

create table if not exists sessions (
  id                 uuid primary key,
  created_at         timestamptz default now(),
  status             text not null default 'created'
                       check (status in ('created','uploading','processing','done','error')),
  team_name          text,
  match_date         date,
  left_video_key     text,
  right_video_key    text,
  stitched_video_key text,
  tracked_video_key  text,
  highlights         jsonb,
  error_message      text,
  progress           int default 0
);

-- Enable Realtime so the frontend receives live updates
alter publication supabase_realtime add table sessions;

-- Row-level security (optional but recommended for production)
alter table sessions enable row level security;

-- Allow anyone to read/write for now (lock down per-user later)
create policy "Public access" on sessions for all using (true) with check (true);
