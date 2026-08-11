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
  ('Veena', '🎵')
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
