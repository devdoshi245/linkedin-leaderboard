// Slack Events API webhook → LinkedIn Leaderboard
//
// Deploy as a Supabase Edge Function named `slack-events` with JWT
// verification DISABLED (Slack sends no Authorization header).
//
// Required secrets:
//   SLACK_SIGNING_SECRET  — Slack app → Basic Information → Signing Secret
//   SLACK_BOT_TOKEN       — Slack app → OAuth → Bot User OAuth Token (xoxb-…)
//                           used once per person to match their Slack profile
//                           name to a leaderboard member.
// Optional:
//   SLACK_CHANNEL_ID      — comma-separated allowlist of channel IDs (C0…).
//                           When set, events from any other channel are
//                           ignored, even if the bot is a member there.
// (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are injected automatically.)

import { createClient } from "npm:@supabase/supabase-js@2";

declare const EdgeRuntime: { waitUntil(p: Promise<unknown>): void } | undefined;

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

const TIMEZONE = "Asia/Kolkata";
const BUCKET = "leaderboard";
const SNAPSHOT_FILE = "leaderboard.json";
const LINKEDIN_RE = /https?:\/\/(?:[a-z0-9-]+\.)*linkedin\.com\/[^\s<>|"']+/i;

Deno.serve(async (req) => {
  if (req.method !== "POST") {
    // Opening the function URL in a browser (GET) rebuilds the snapshot —
    // used to seed the board file after setup and as a manual refresh.
    await rebuildSnapshot();
    return new Response("ok");
  }
  const body = await req.text();

  let payload: any;
  try {
    payload = JSON.parse(body);
  } catch {
    return new Response("bad request", { status: 400 });
  }

  // Slack URL-verification handshake. Echoing the challenge is harmless and
  // lets the URL verify even before secrets are configured.
  if (payload.type === "url_verification") {
    return new Response(payload.challenge ?? "", {
      headers: { "Content-Type": "text/plain" },
    });
  }

  if (!(await verifySlackSignature(req, body))) {
    return new Response("invalid signature", { status: 401 });
  }

  if (payload.type === "event_callback") {
    // Ack within Slack's 3s window; do the real work after.
    const work = handleEvent(payload.event).catch((e) =>
      console.error("event handling failed:", e),
    );
    if (typeof EdgeRuntime !== "undefined" && EdgeRuntime?.waitUntil) {
      EdgeRuntime.waitUntil(work);
    } else {
      await work;
    }
  }
  return new Response("ok");
});

/* ---------------- Slack signature ---------------- */

async function verifySlackSignature(req: Request, body: string): Promise<boolean> {
  const secret = Deno.env.get("SLACK_SIGNING_SECRET");
  if (!secret) {
    console.error("SLACK_SIGNING_SECRET is not set — rejecting request");
    return false;
  }
  const ts = req.headers.get("x-slack-request-timestamp");
  const sig = req.headers.get("x-slack-signature");
  if (!ts || !sig) return false;
  if (Math.abs(Date.now() / 1000 - parseFloat(ts)) > 60 * 5) return false; // replay guard

  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, enc.encode(`v0:${ts}:${body}`));
  const expected = "v0=" +
    Array.from(new Uint8Array(mac)).map((b) => b.toString(16).padStart(2, "0")).join("");

  if (expected.length !== sig.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ sig.charCodeAt(i);
  return diff === 0;
}

/* ---------------- event handling ---------------- */

function extractLinkedInUrl(text: string): string | null {
  const m = (text || "").match(LINKEDIN_RE);
  return m ? m[0].replace(/[>,.)\]]+$/, "") : null;
}

function channelAllowed(channel: string | undefined): boolean {
  const allow = (Deno.env.get("SLACK_CHANNEL_ID") ?? "")
    .split(",").map((s) => s.trim()).filter(Boolean);
  return allow.length === 0 || (!!channel && allow.includes(channel));
}

async function handleEvent(ev: any): Promise<void> {
  if (!ev || ev.type !== "message") return;
  if (!channelAllowed(ev.channel)) return;
  if (ev.bot_id || ev.subtype === "bot_message") return;

  if (ev.subtype === "message_deleted") {
    const ts = ev.deleted_ts || ev.previous_message?.ts;
    if (ts) {
      const { error } = await supabase.from("posts").delete().eq("slack_ts", ts);
      if (error) console.error("delete failed:", error);
      await rebuildSnapshot();
    }
    return;
  }

  if (ev.subtype === "message_changed") {
    const msg = ev.message ?? {};
    if (msg.bot_id) return;
    const url = extractLinkedInUrl(msg.text);
    if (url) {
      await recordPost(msg.user, url, msg.ts, ev.channel);
    } else {
      // URL edited out → the post no longer counts
      await supabase.from("posts").delete().eq("slack_ts", msg.ts);
      await rebuildSnapshot();
    }
    return;
  }

  // Plain messages plus the subtypes that still carry user text
  if (ev.subtype && !["file_share", "thread_broadcast"].includes(ev.subtype)) return;

  const url = extractLinkedInUrl(ev.text);
  if (!url) return;
  await recordPost(ev.user, url, ev.ts, ev.channel);
}

async function recordPost(
  slackUserId: string | undefined,
  url: string,
  ts: string | undefined,
  channel: string | undefined,
): Promise<void> {
  if (!slackUserId || !ts) return;
  const member = await resolveMember(slackUserId);
  if (!member) {
    console.log(`no leaderboard member matched slack user ${slackUserId} — ignoring`);
    return;
  }
  const postedAt = new Date(parseFloat(ts) * 1000).toISOString();
  const { error } = await supabase.from("posts").upsert(
    {
      member_id: member.id,
      slack_user_id: slackUserId,
      url,
      slack_ts: ts,
      channel: channel ?? null,
      posted_at: postedAt,
    },
    // Update on conflict so an edited message replaces its URL; Slack retries
    // rewrite identical values, so counting stays deduped either way.
    { onConflict: "slack_ts", ignoreDuplicates: false },
  );
  if (error) {
    console.error("insert failed:", error);
    return;
  }
  await rebuildSnapshot();
}

/* ---------------- member matching ---------------- */

function norm(s: string): string {
  return s.toLowerCase().replace(/\s+/g, " ").trim();
}

async function resolveMember(
  slackUserId: string,
): Promise<{ id: number; name: string } | null> {
  const { data: existing } = await supabase
    .from("members").select("id,name").eq("slack_user_id", slackUserId).maybeSingle();
  if (existing) return existing;

  const token = Deno.env.get("SLACK_BOT_TOKEN");
  if (!token) {
    console.warn("SLACK_BOT_TOKEN not set — cannot match new Slack users by name");
    return null;
  }

  const res = await fetch(
    "https://slack.com/api/users.info?user=" + encodeURIComponent(slackUserId),
    { headers: { Authorization: `Bearer ${token}` } },
  );
  const info = await res.json();
  if (!info.ok) {
    console.error("users.info failed:", info.error);
    return null;
  }
  const p = info.user?.profile ?? {};
  const candidates: string[] = [
    p.real_name_normalized, p.real_name, p.display_name_normalized,
    p.display_name, info.user?.name,
  ].filter(Boolean).map(norm);

  const { data: members } = await supabase
    .from("members").select("id,name,slack_user_id");
  if (!members) return null;

  const unclaimed = members.filter((m) => !m.slack_user_id);

  // 1) exact full-name match
  let match = unclaimed.find((m) => candidates.includes(norm(m.name)));

  // 2) unique first-name match (covers "Shivam" and display names like "satyam")
  if (!match) {
    for (const c of candidates) {
      const first = c.split(" ")[0];
      const hits = unclaimed.filter((m) => norm(m.name).split(" ")[0] === first);
      if (hits.length === 1) { match = hits[0]; break; }
    }
  }
  if (!match) return null;

  const { error } = await supabase
    .from("members").update({ slack_user_id: slackUserId }).eq("id", match.id);
  if (error) console.error("failed to save slack_user_id:", error);
  return { id: match.id, name: match.name };
}

/* ---------------- snapshot ---------------- */

function dayInTz(iso: string | Date): string {
  // "YYYY-MM-DD" in TIMEZONE (en-CA locale formats as ISO)
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: TIMEZONE, year: "numeric", month: "2-digit", day: "2-digit",
  }).format(typeof iso === "string" ? new Date(iso) : iso);
}

// PostgREST caps a single response at 1000 rows — page through everything.
async function fetchAllPosts(): Promise<
  { member_id: number; url: string | null; posted_at: string }[]
> {
  const PAGE = 1000;
  const all: { member_id: number; url: string | null; posted_at: string }[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from("posts")
      .select("member_id,url,posted_at")
      .order("posted_at", { ascending: false })
      .range(from, from + PAGE - 1);
    if (error) {
      console.error("posts page failed:", error);
      break;
    }
    all.push(...(data ?? []));
    if (!data || data.length < PAGE) break;
  }
  return all;
}

// The snapshot carries raw per-day counts per member; the dashboard computes
// week/month/streak/today client-side so the numbers roll over at midnight
// without needing a rebuild.
async function rebuildSnapshot(): Promise<void> {
  const [membersRes, posts] = await Promise.all([
    supabase.from("members").select("id,name,emoji").order("id"),
    fetchAllPosts(),
  ]);
  const members = membersRes.data;
  if (!members) {
    console.error("could not load members:", membersRes.error);
    return;
  }

  const byMember = new Map<
    number,
    { days: Record<string, number>; last: string | null }
  >();
  for (const m of members) byMember.set(m.id, { days: {}, last: null });

  for (const post of posts) {
    const bucket = byMember.get(post.member_id);
    if (!bucket) continue;
    const day = dayInTz(post.posted_at);
    bucket.days[day] = (bucket.days[day] ?? 0) + 1;
    if (!bucket.last || post.posted_at > bucket.last) bucket.last = post.posted_at;
  }

  const memberById = new Map(members.map((m) => [m.id, m]));

  const recent = posts.slice(0, 12).map((p) => {
    const m = memberById.get(p.member_id);
    return { name: m?.name ?? "?", emoji: m?.emoji ?? "🙂", url: p.url, at: p.posted_at };
  });

  const snapshot = {
    updatedAt: new Date().toISOString(),
    timezone: TIMEZONE,
    members: members.map((m) => {
      const bucket = byMember.get(m.id)!;
      return {
        id: m.id, name: m.name, emoji: m.emoji,
        days: bucket.days, lastPostAt: bucket.last,
      };
    }),
    recent,
  };

  const { error } = await supabase.storage.from(BUCKET).upload(
    SNAPSHOT_FILE,
    new Blob([JSON.stringify(snapshot)], { type: "application/json" }),
    { upsert: true, contentType: "application/json", cacheControl: "0" },
  );
  if (error) console.error("snapshot upload failed:", error);
}
