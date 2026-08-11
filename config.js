// Public configuration — safe to commit. No secrets live in this file.
window.LEADERBOARD_CONFIG = {
  // Supabase project URL (public — same value any visitor can see in network calls)
  SUPABASE_URL: "https://cuixaylpnioceqwdibad.supabase.co",

  // OPTIONAL: the project's *anon public* key (Supabase → Settings → API → anon).
  // The anon key is designed to be public; the database is read-only for it (RLS).
  // With it set, the board updates instantly via realtime websockets.
  // Without it, the board polls every 4 seconds — still feels live.
  SUPABASE_ANON_KEY: "",

  TEAM_NAME: "OneGTM Lab",
  CHANNEL_HINT: "#linkedin-leaderboard",
  POLL_MS: 4000,
};
