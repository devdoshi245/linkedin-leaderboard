-- LinkedIn Leaderboard — database setup
-- Run this once in the Supabase SQL Editor (safe to re-run).

create table if not exists public.members (
  id serial primary key,
  name text not null unique,
  emoji text not null default '🙂',
  slack_user_id text unique,
  created_at timestamptz not null default now()
);

create table if not exists public.posts (
  id bigserial primary key,
  member_id int not null references public.members(id) on delete cascade,
  slack_user_id text,
  url text,
  slack_ts text not null unique,   -- Slack message timestamp = idempotency key
  channel text,
  posted_at timestamptz not null default now()
);

-- AI quality score (1-10), written by the optional scoring pipeline.
-- Kept as an idempotent alter so re-running this file upgrades old installs.
alter table public.posts add column if not exists quality_score int;

-- Post engagement (measured once, ~24h after posting) for the Popularity board.
alter table public.posts add column if not exists reactions int;
alter table public.posts add column if not exists comments int;
alter table public.posts add column if not exists reposts int;
alter table public.posts add column if not exists engagement int;      -- hype points
alter table public.posts add column if not exists engagement_at timestamptz;

-- Hourly engagement sweep (requires the scoring secrets to be configured).
-- Replace YOUR_SCORE_HOOK_SECRET with the SCORE_HOOK_SECRET function secret:
-- create extension if not exists pg_cron;
-- create extension if not exists pg_net;
-- select cron.schedule('engagement-sweep', '7 * * * *',
--   $$select net.http_post(
--       url := 'https://YOUR_PROJECT.supabase.co/functions/v1/slack-events?hook=YOUR_SCORE_HOOK_SECRET&sweep=1',
--       body := '{}'::jsonb,
--       timeout_milliseconds := 30000)$$);

-- Read-only for the public (anon key); writes happen only via the
-- edge function, which uses the service role and bypasses RLS.
alter table public.members enable row level security;
alter table public.posts enable row level security;

drop policy if exists "public read members" on public.members;
create policy "public read members" on public.members for select using (true);

drop policy if exists "public read posts" on public.posts;
create policy "public read posts" on public.posts for select using (true);

-- The roster (first names only — keeps Slack profile-name matching forgiving)
insert into public.members (name, emoji) values
  ('Dev', '🦁'),
  ('Satyam', '🚀'),
  ('Meenal', '🌟'),
  ('Fiza', '🎨'),
  ('Sachin', '⚡'),
  ('Mandeep', '🎯'),
  ('Shivam', '🐯'),
  ('Shirish', '🦉'),
  ('Christina', '🦋'),
  ('Sasha', '🦊'),
  ('Jainendra', '🛸'),
  ('Megha', '🌈'),
  ('Veena', '🎵'),
  ('Sujan', '🦅')
on conflict (name) do nothing;

-- Public storage bucket for the leaderboard.json snapshot the dashboard reads.
insert into storage.buckets (id, name, public)
values ('leaderboard', 'leaderboard', true)
on conflict (id) do update set public = true;

-- Realtime on posts (used for instant updates when the dashboard has the anon key)
do $$
begin
  alter publication supabase_realtime add table public.posts;
exception
  when duplicate_object then null;
end $$;
