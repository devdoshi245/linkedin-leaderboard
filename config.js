// Public configuration — safe to commit. No secrets live in this file.
window.LEADERBOARD_CONFIG = {
  // Supabase project URL (public — same value any visitor can see in network calls)
  SUPABASE_URL: "https://cuixaylpnioceqwdibad.supabase.co",

  // OPTIONAL: the project's *anon public* key (Supabase → Settings → API → anon).
  // The anon key is designed to be public; the database is read-only for it (RLS).
  // With it set, the board updates instantly via realtime websockets.
  // Without it, the board polls every 4 seconds — still feels live.
  SUPABASE_ANON_KEY: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImN1aXhheWxwbmlvY2Vxd2RpYmFkIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODY0MzY0ODcsImV4cCI6MjEwMjAxMjQ4N30.0Jlr5tLNyoL2pcga33IzCAftkQEq-Z-Xd5XTIIme_h0",

  TEAM_NAME: "OneGTMLab",
  CHANNEL_HINT: "#linkedin-leaderboard",
  POLL_MS: 4000,
};
