# 🏆 LinkedIn Leaderboard

A live, friendly-competition dashboard for the team. Post a LinkedIn link in the
Slack channel → your count goes up on the board within seconds. Crowns, streaks,
confetti — the works.

**Live board:** https://devdoshi245.github.io/linkedin-leaderboard/

## How it works

```
Slack channel                Supabase                              GitHub Pages
─────────────                ────────                              ────────────
 someone posts a   events    ┌──────────────────┐   writes   ┌──────────────────┐
 linkedin.com URL ─────────► │ Edge Function     │ ─────────► │ posts table       │
                             │ "slack-events"    │            │ (source of truth) │
                             │ · verifies Slack  │            └────────┬─────────┘
                             │   signature       │   rebuilds          │
                             │ · matches poster  │ ────────────────────▼
                             │   to a member     │            leaderboard.json
                             └──────────────────┘            (public Storage file)
                                                                      ▲
                                                    dashboard polls every 4s
                                                    (or instant via Realtime)
```

- The dashboard is a static page (GitHub Pages). It reads a **public JSON
  snapshot** from Supabase Storage — no API key in the browser required.
- The edge function is the only writer. It verifies every request with the
  Slack signing secret, dedupes by Slack message timestamp (retries and
  double-delivery are harmless), handles deleted/edited messages, and rebuilds
  the snapshot after every change.
- First time a person posts, the function matches their Slack profile name to
  a leaderboard member (via `users.info`) and remembers the mapping.

## Features

- 👑 Animated podium for the top 3, full ranked list with progress bars
- 🎉 Confetti + toast the moment someone posts (milestone parties at 10/25/50/100)
- 📅 This week / This month / All-time views (weeks start Monday, IST)
- 🔥 Daily posting streaks
- 📈 14-day activity chart, 🕑 live activity feed with links to the posts
- 🌗 Light/dark theme, mobile friendly

## Setup

### 1. Supabase (~3 minutes)

1. Open the project's **SQL Editor**, paste [`supabase/setup.sql`](supabase/setup.sql), run it.
   Creates `members` (seeded with the team) + `posts`, read-only RLS, the public
   `leaderboard` storage bucket, and realtime on `posts`.
2. **Edge Functions → Deploy new function**, name it exactly `slack-events`,
   paste [`supabase/functions/slack-events/index.ts`](supabase/functions/slack-events/index.ts).
   In the function's settings, **turn OFF "Verify JWT"** (Slack can't send auth
   headers). Or with the CLI: `supabase functions deploy slack-events` (the
   included `config.toml` disables JWT verification).
3. **Edge Functions → slack-events → Secrets**, add:
   - `SLACK_SIGNING_SECRET` — from step 2 below
   - `SLACK_BOT_TOKEN` — from step 2 below

### 2. Slack (~3 minutes)

1. Go to https://api.slack.com/apps → **Create New App → From a manifest** →
   pick your workspace → paste [`slack-app-manifest.yml`](slack-app-manifest.yml).
2. **Install to Workspace** (Install App page) and approve.
3. Copy two values into the Supabase secrets from step 1.3:
   - **Basic Information → Signing Secret** → `SLACK_SIGNING_SECRET`
   - **OAuth & Permissions → Bot User OAuth Token** (`xoxb-…`) → `SLACK_BOT_TOKEN`
4. **Event Subscriptions** → confirm the Request URL shows **Verified** ✓
   (it points at the edge function).
5. In the leaderboard channel, run `/invite @leaderboard-bot`.
   The bot only receives events for channels it's in.

That's it. Post a LinkedIn URL in the channel and watch the board.

### 3. Dashboard (already deployed)

Hosted on GitHub Pages from this repo (`main` branch, root). Configuration
lives in [`config.js`](config.js):

- `SUPABASE_ANON_KEY` *(optional)* — paste the project's **anon public** key
  (Supabase → Settings → API) to upgrade from 4-second polling to instant
  realtime updates. The anon key is safe to publish: the database is
  read-only for it.
- `TEAM_NAME` / `CHANNEL_HINT` — cosmetic labels.

## Rules of the game

- Any message in the channel containing a `linkedin.com` link = **+1** for the poster.
- Reposting the same message twice counts twice (be honorable 😄), but Slack
  retries/edits never double-count — deduped by message timestamp.
- Deleting your Slack message removes the point. Editing the link out does too.
- Messages from people not on the board are ignored.

## Adding / removing people

Run SQL in Supabase (`insert into members (name, emoji) values ('New Person', '🦊');`
or `delete from members where name = '…';`). The board picks it up on the next post —
or invoke the function's snapshot rebuild by posting any LinkedIn link.

## Troubleshooting

| Symptom | Check |
|---|---|
| Request URL won't verify | Function deployed? JWT verification off? |
| Posts don't count | Bot invited to the channel? Secrets set? Edge function logs (Supabase → Edge Functions → Logs) |
| Person not matched | Their Slack profile name should resemble their leaderboard name; or set it manually: `update members set slack_user_id = 'U0…' where name = '…';` |
| Board feels slow | Add the anon key to `config.js` for instant realtime |
