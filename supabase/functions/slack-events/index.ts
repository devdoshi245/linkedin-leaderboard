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
// Matches full linkedin.com URLs and LinkedIn's own lnkd.in short links
// (the mobile share sheet produces those).
const LINKEDIN_RE = /https?:\/\/(?:[a-z0-9-]+\.)*(?:linkedin\.com|lnkd\.in)\/[^\s<>|"']+/i;

// Quality scoring (optional — activates when APIFY_TOKEN + GEMINI_API_KEY +
// SCORE_HOOK_SECRET are set): Apify fetches the post content, Gemini scores it
// 1-10, and posts scoring >= STANDOUT_MIN get 💎 treatment on the dashboard.
// Raw scores are never published; only standouts appear in the snapshot.
const APIFY_ACTOR = "apimaestro~linkedin-post-detail";
const GEMINI_MODEL = "gemini-2.5-flash";
const STANDOUT_MIN = 8;

Deno.serve(async (req) => {
  if (req.method !== "POST") {
    // Opening the function URL in a browser (GET) rebuilds the snapshot —
    // used to seed the board file after setup and as a manual refresh.
    await rebuildSnapshot();
    return new Response("ok");
  }
  const body = await req.text();

  // Hook-secret paths: engagement sweep (cron), engagement callback, score callback
  const reqUrl = new URL(req.url);
  const hookSecret = Deno.env.get("SCORE_HOOK_SECRET");
  if (hookSecret && reqUrl.searchParams.get("hook") === hookSecret) {
    if (reqUrl.searchParams.get("sweep")) return await handleEngagementSweep();
    if (reqUrl.searchParams.get("eng")) return await handleEngagementCallback(reqUrl, body);
    return await handleScoreCallback(reqUrl, body);
  }

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

// lnkd.in short links redirect to the real post URL — resolve them so the
// stored URL is canonical (dedupe, scraping, and feed links all benefit).
// Never throws; falls back to the original URL.
async function resolveLinkedInUrl(url: string): Promise<string> {
  try {
    let current = url;
    for (let hop = 0; hop < 3; hop++) {
      const host = new URL(current).hostname.toLowerCase();
      if (!host.endsWith("lnkd.in")) break;
      const res = await fetch(current, {
        method: "GET",
        redirect: "manual",
        headers: { "User-Agent": "Mozilla/5.0" },
      });
      const loc = res.headers.get("location");
      // drain/cancel the body so the connection is released
      try { await res.body?.cancel(); } catch { /* ignore */ }
      if (!loc) break;
      current = new URL(loc, current).toString();
    }
    const u = new URL(current);
    if (u.hostname.toLowerCase().endsWith("linkedin.com")) {
      u.search = ""; // strip utm/tracking noise
      return u.toString();
    }
    return url;
  } catch (e) {
    console.error("url resolution failed:", e);
    return url;
  }
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
  url = await resolveLinkedInUrl(url);
  const member = await resolveMember(slackUserId);
  if (!member) {
    console.log(`no leaderboard member matched slack user ${slackUserId} — ignoring`);
    return;
  }
  const postedAt = new Date(parseFloat(ts) * 1000).toISOString();
  const payload: Record<string, unknown> = {
    member_id: member.id,
    slack_user_id: slackUserId,
    url,
    slack_ts: ts,
    channel: channel ?? null,
    posted_at: postedAt,
  };
  // If this message was already counted with a DIFFERENT url (edited link),
  // reset its measurements so the sweep re-measures and Gemini re-scores the
  // new post. Conditional on purpose: Slack retries and same-URL edits must
  // not wipe valid measurements.
  const { data: existing } = await supabase
    .from("posts").select("url").eq("slack_ts", ts).maybeSingle();
  if (existing && existing.url !== url) {
    Object.assign(payload, {
      quality_score: null, reactions: null, comments: null,
      reposts: null, engagement: null, engagement_at: null,
    });
  }
  const { data: row, error } = await supabase.from("posts").upsert(
    payload,
    // Update on conflict so an edited message replaces its URL; Slack retries
    // rewrite identical values, so counting stays deduped either way.
    { onConflict: "slack_ts", ignoreDuplicates: false },
  ).select("id").single();
  if (error) {
    console.error("insert failed:", error);
    return;
  }
  if (row) await startScoring(row.id, url);
  await rebuildSnapshot();
}

/* ---------------- quality scoring ---------------- */

// Start an Apify post-detail run whose completion webhook calls this function
// back with the given query params. Must never throw: an Apify hiccup may not
// block counting or the rebuild.
async function startActorRun(postUrl: string, callbackParams: string): Promise<void> {
  try {
    const token = Deno.env.get("APIFY_TOKEN");
    const secret = Deno.env.get("SCORE_HOOK_SECRET");
    const base = Deno.env.get("SUPABASE_URL");
    if (!token || !secret || !base) return; // not configured — counting still works
    const callback =
      `${base}/functions/v1/slack-events?hook=${encodeURIComponent(secret)}&${callbackParams}`;
    const webhooks = btoa(JSON.stringify([
      { eventTypes: ["ACTOR.RUN.SUCCEEDED"], requestUrl: callback },
    ]));
    const res = await fetch(
      `https://api.apify.com/v2/acts/${APIFY_ACTOR}/runs?webhooks=${encodeURIComponent(webhooks)}`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ post_urls: [postUrl] }),
      },
    );
    if (!res.ok) console.error("apify run start failed:", res.status, await res.text());
  } catch (e) {
    console.error("apify run start failed:", e);
  }
}

function startScoring(postId: number, postUrl: string): Promise<void> {
  return startActorRun(postUrl, `post=${postId}`);
}

/* ---------------- engagement (popularity) ---------------- */

// Cron calls this hourly: find posts that crossed the 24h mark and measure
// their engagement exactly once. A 7-day horizon stops endless retries for
// posts whose measurement keeps failing.
async function handleEngagementSweep(): Promise<Response> {
  try {
    const cutoff = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
    const horizon = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString();
    const { data: due, error } = await supabase
      .from("posts")
      .select("id,url")
      .is("engagement_at", null)
      .not("url", "is", null)
      .lte("posted_at", cutoff)
      .gte("posted_at", horizon)
      .limit(10);
    if (error) {
      console.error("sweep query failed:", error);
      return new Response("sweep query failed", { status: 500 });
    }
    // Respond fast (pg_net's timeout is short) and start the runs in the background.
    const work = (async () => {
      for (const p of due ?? []) {
        await startActorRun(p.url as string, `eng=${p.id}`);
      }
    })();
    if (typeof EdgeRuntime !== "undefined" && EdgeRuntime?.waitUntil) {
      EdgeRuntime.waitUntil(work);
    } else {
      await work;
    }
    return new Response(`sweep queued for ${due?.length ?? 0} post(s)`);
  } catch (e) {
    console.error("sweep failed:", e);
    return new Response("error", { status: 500 });
  }
}

async function handleEngagementCallback(reqUrl: URL, body: string): Promise<Response> {
  try {
    const postId = parseInt(reqUrl.searchParams.get("eng") ?? "", 10);
    const datasetId = JSON.parse(body)?.resource?.defaultDatasetId;
    if (!postId || !datasetId) return new Response("bad hook payload", { status: 400 });

    const token = Deno.env.get("APIFY_TOKEN");
    const res = await fetch(
      `https://api.apify.com/v2/datasets/${datasetId}/items?clean=true&limit=1`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    if (!res.ok) {
      console.error("dataset fetch failed:", res.status);
      return new Response("dataset fetch failed", { status: 502 });
    }
    const items = await res.json();
    const stats = items?.[0]?.stats;

    // Post deleted/private: record a zero measurement so the sweep stops retrying.
    const reactions = Number(stats?.total_reactions ?? 0);
    const comments = Number(stats?.comments ?? 0);
    const reposts = Number(stats?.shares ?? 0);
    const engagement = reactions + 2 * comments + 3 * reposts;

    const { error } = await supabase.from("posts").update({
      reactions, comments, reposts, engagement,
      engagement_at: new Date().toISOString(),
    }).eq("id", postId);
    if (error) {
      console.error("engagement update failed:", error);
      return new Response("db update failed", { status: 500 });
    }
    await rebuildSnapshot();
    // Self-healing second pass (same rationale as scoring)
    const again = new Promise((r) => setTimeout(r, 5000)).then(() => rebuildSnapshot());
    if (typeof EdgeRuntime !== "undefined" && EdgeRuntime?.waitUntil) {
      EdgeRuntime.waitUntil(again);
    }
  } catch (e) {
    console.error("engagement callback failed:", e);
    return new Response("error", { status: 500 });
  }
  return new Response("ok");
}

// Non-2xx responses make Apify retry the webhook with backoff, so transient
// failures return 5xx (the whole path is idempotent); permanent conditions
// (no text, scoring unconfigured, unparseable score) return 200 to stop retries.
async function handleScoreCallback(reqUrl: URL, body: string): Promise<Response> {
  try {
    const postId = parseInt(reqUrl.searchParams.get("post") ?? "", 10);
    const datasetId = JSON.parse(body)?.resource?.defaultDatasetId;
    if (!postId || !datasetId) return new Response("bad hook payload", { status: 400 });

    const token = Deno.env.get("APIFY_TOKEN");
    const res = await fetch(
      `https://api.apify.com/v2/datasets/${datasetId}/items?clean=true&limit=1`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    if (!res.ok) {
      console.error("dataset fetch failed:", res.status);
      return new Response("dataset fetch failed", { status: 502 });
    }
    const items = await res.json();
    const item = items?.[0];

    // Credit the post's real LinkedIn AUTHOR when they're on the board — so a
    // teammate pasting the founders' links still scores points for the founders.
    const reattributed = await reattributeByAuthor(postId, item);

    const text: string | undefined = item?.post?.text;
    if (!text || !text.trim()) {
      console.log(`no post text for post ${postId} — leaving unscored`);
      if (reattributed) await rebuildSnapshot();
      return new Response("ok");
    }

    const score = await scoreWithGemini(text); // throws on retryable failures
    if (score === null) {
      if (reattributed) await rebuildSnapshot();
      return new Response("ok");
    }
    const { error } = await supabase
      .from("posts").update({ quality_score: score }).eq("id", postId);
    if (error) {
      console.error("score update failed:", error);
      return new Response("db update failed", { status: 500 });
    }
    await rebuildSnapshot();
    // Self-healing second pass: a concurrent event-driven rebuild that read the
    // table before our score landed could overwrite this upload moments later.
    const again = new Promise((r) => setTimeout(r, 5000)).then(() => rebuildSnapshot());
    if (typeof EdgeRuntime !== "undefined" && EdgeRuntime?.waitUntil) {
      EdgeRuntime.waitUntil(again);
    }
  } catch (e) {
    console.error("score callback failed:", e);
    return new Response("error", { status: 500 });
  }
  return new Response("ok");
}

// If the scraped post's author matches a board member (full name, else unique
// first name), move the credit to them. Returns true when the row changed.
async function reattributeByAuthor(postId: number, item: any): Promise<boolean> {
  try {
    const authorName = item?.author?.name;
    if (!authorName) return false;
    const { data: members } = await supabase.from("members").select("id,name");
    if (!members) return false;
    const n = norm(String(authorName));
    let match = members.find((m) => norm(m.name) === n);
    if (!match) {
      const first = n.split(" ")[0];
      const hits = members.filter((m) => norm(m.name).split(" ")[0] === first);
      if (hits.length === 1) match = hits[0];
    }
    if (!match) return false; // author not on the board — Slack poster keeps credit
    const { data: row } = await supabase
      .from("posts").select("member_id").eq("id", postId).maybeSingle();
    if (!row || row.member_id === match.id) return false;
    const { error } = await supabase
      .from("posts").update({ member_id: match.id }).eq("id", postId);
    if (error) {
      console.error("author reattribution failed:", error);
      return false;
    }
    console.log(`post ${postId} re-attributed to ${match.name} (LinkedIn author: ${authorName})`);
    return true;
  } catch (e) {
    console.error("author reattribution failed:", e);
    return false;
  }
}

async function scoreWithGemini(text: string): Promise<number | null> {
  const key = Deno.env.get("GEMINI_API_KEY");
  if (!key) return null;
  const prompt =
    "You score LinkedIn posts for a friendly internal team leaderboard. " +
    "Score this post 1-10 for quality: substance and real insight (not generic " +
    "platitudes), personal voice or original angle, structure and readability, " +
    "value to the reader. Penalize pure link-drops, engagement bait, and " +
    "hashtag stuffing. Return only JSON.\n\nPOST:\n" + text.slice(0, 4000);
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`,
    {
      method: "POST",
      headers: { "x-goog-api-key": key, "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          responseMimeType: "application/json",
          responseSchema: {
            type: "OBJECT",
            properties: { score: { type: "INTEGER" } },
            required: ["score"],
          },
          temperature: 0.2,
          thinkingConfig: { thinkingBudget: 0 },
        },
      }),
    },
  );
  if (!res.ok) {
    const detail = await res.text();
    console.error("gemini error:", res.status, detail.slice(0, 300));
    // Rate limits / server errors are worth an Apify webhook retry; auth or
    // bad-request errors won't improve on retry — skip permanently.
    if (res.status === 429 || res.status >= 500) {
      throw new Error(`gemini transient failure: ${res.status}`);
    }
    return null;
  }
  try {
    const data = await res.json();
    const score = JSON.parse(data.candidates[0].content.parts[0].text).score;
    return Math.max(1, Math.min(10, Math.round(Number(score))));
  } catch (e) {
    console.error("gemini parse failed:", e);
    return null;
  }
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
type PostRow = {
  member_id: number; url: string | null; posted_at: string;
  quality_score: number | null;
  reactions: number | null; comments: number | null;
  reposts: number | null; engagement: number | null;
};
async function fetchAllPosts(): Promise<PostRow[] | null> {
  const PAGE = 1000;
  const all: PostRow[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from("posts")
      .select("member_id,url,posted_at,quality_score,reactions,comments,reposts,engagement")
      .order("posted_at", { ascending: false })
      .range(from, from + PAGE - 1);
    if (error) {
      // Signal failure — a failed read must never masquerade as "zero posts"
      // or the rebuild would overwrite the live board with an empty one.
      console.error("posts page failed:", error);
      return null;
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
  if (posts === null) {
    console.error("posts fetch failed — keeping the existing snapshot untouched");
    return;
  }

  const hourFmt = new Intl.DateTimeFormat("en-GB", {
    timeZone: TIMEZONE, hour: "2-digit", hour12: false,
  });

  const byMember = new Map<
    number,
    {
      days: Record<string, number>; hype: Record<string, number>;
      last: string | null; earlyBird: boolean; nightOwl: boolean;
    }
  >();
  for (const m of members) {
    byMember.set(m.id, { days: {}, hype: {}, last: null, earlyBird: false, nightOwl: false });
  }

  let firstBlood: { memberId: number; at: string } | null = null;
  for (const post of posts) {
    const bucket = byMember.get(post.member_id);
    if (!bucket) continue;
    const day = dayInTz(post.posted_at);
    bucket.days[day] = (bucket.days[day] ?? 0) + 1;
    if (post.engagement != null && post.engagement > 0) {
      bucket.hype[day] = (bucket.hype[day] ?? 0) + post.engagement;
    }
    if (!bucket.last || post.posted_at > bucket.last) bucket.last = post.posted_at;
    const hour = parseInt(hourFmt.format(new Date(post.posted_at)), 10);
    if (hour < 9) bucket.earlyBird = true;
    if (hour >= 22) bucket.nightOwl = true;
    if (!firstBlood || post.posted_at < firstBlood.at) {
      firstBlood = { memberId: post.member_id, at: post.posted_at };
    }
  }

  const memberById = new Map(members.map((m) => [m.id, m]));

  const recent = posts.slice(0, 12).map((p) => {
    const m = memberById.get(p.member_id);
    return {
      name: m?.name ?? "?", emoji: m?.emoji ?? "🙂", url: p.url, at: p.posted_at,
      standout: (p.quality_score ?? 0) >= STANDOUT_MIN,
    };
  });

  // Only standouts are published — low scores stay private by design.
  const standouts = posts
    .filter((p) => (p.quality_score ?? 0) >= STANDOUT_MIN)
    .slice(0, 50)
    .map((p) => {
      const m = memberById.get(p.member_id);
      return {
        name: m?.name ?? "?", emoji: m?.emoji ?? "🙂", url: p.url,
        at: p.posted_at, score: p.quality_score,
      };
    });

  // Most-engaged posts for the Popularity board's highlight
  const topPosts = [...posts]
    .filter((p) => (p.engagement ?? 0) > 0)
    .sort((a, b) => (b.engagement ?? 0) - (a.engagement ?? 0))
    .slice(0, 5)
    .map((p) => {
      const m = memberById.get(p.member_id);
      return {
        name: m?.name ?? "?", emoji: m?.emoji ?? "🙂", url: p.url, at: p.posted_at,
        points: p.engagement, reactions: p.reactions ?? 0,
        comments: p.comments ?? 0, reposts: p.reposts ?? 0,
      };
    });

  const snapshot = {
    updatedAt: new Date().toISOString(),
    timezone: TIMEZONE,
    members: members.map((m) => {
      const bucket = byMember.get(m.id)!;
      const badges: string[] = [];
      if (bucket.earlyBird) badges.push("early_bird");
      if (bucket.nightOwl) badges.push("night_owl");
      if (firstBlood?.memberId === m.id) badges.push("first_blood");
      return {
        id: m.id, name: m.name, emoji: m.emoji,
        days: bucket.days, hype: bucket.hype, lastPostAt: bucket.last, badges,
      };
    }),
    recent,
    standouts,
    topPosts,
  };

  const { error } = await supabase.storage.from(BUCKET).upload(
    SNAPSHOT_FILE,
    new Blob([JSON.stringify(snapshot)], { type: "application/json" }),
    { upsert: true, contentType: "application/json", cacheControl: "0" },
  );
  if (error) console.error("snapshot upload failed:", error);
}
