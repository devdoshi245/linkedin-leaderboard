/* LinkedIn Leaderboard — frontend
 * Reads a public JSON snapshot from Supabase Storage (no API key needed) and
 * polls it every few seconds. If an anon key is configured, it also subscribes
 * to Supabase Realtime for instant updates. */

(function () {
  "use strict";

  const CONFIG = window.LEADERBOARD_CONFIG || {};
  const SNAPSHOT_URL =
    CONFIG.SUPABASE_URL + "/storage/v1/object/public/leaderboard/leaderboard.json";
  const POLL_MS = CONFIG.POLL_MS || 4000;
  const STALE_AFTER_MS = 20000;

  const VIEWS = { week: "week", month: "month", total: "total" };
  const MILESTONES = [10, 25, 50, 100, 200];

  const $ = (id) => document.getElementById(id);
  const els = {
    tagline: $("tagline"), livePill: $("livePill"), liveLabel: $("liveLabel"),
    themeToggle: $("themeToggle"), statTotal: $("statTotal"), statWeek: $("statWeek"),
    statToday: $("statToday"), statChamp: $("statChamp"), podium: $("podium"),
    board: $("board"), emptyMsg: $("emptyMsg"), chart: $("chart"), feed: $("feed"),
    feedEmpty: $("feedEmpty"), channelHint: $("channelHint"), updatedAt: $("updatedAt"),
    toast: $("toast"), confetti: $("confetti"), tooltip: $("tooltip"),
  };

  const state = {
    raw: null,            // snapshot as fetched (members carry per-day counts)
    rawStr: null,         // for change detection
    data: null,           // derived view-model (totals/week/month/streak/daily)
    view: "total",
    prevTotals: null,     // { name: total } from previous snapshot, for celebrations
    prevRanks: {},        // { view: { name: rank } } for ▲ indicators
    seenFeedKeys: new Set(),
    lastOkFetch: 0,
    firstLoad: true,
  };

  /* ---------- theme ---------- */
  function applyTheme(mode) {
    if (mode === "dark" || mode === "light") {
      document.documentElement.setAttribute("data-theme", mode);
    } else {
      const dark = window.matchMedia("(prefers-color-scheme: dark)").matches;
      document.documentElement.setAttribute("data-theme", dark ? "dark" : "light");
    }
  }
  const savedTheme = localStorage.getItem("lb-theme");
  applyTheme(savedTheme);
  els.themeToggle.addEventListener("click", () => {
    const cur = document.documentElement.getAttribute("data-theme");
    const next = cur === "dark" ? "light" : "dark";
    localStorage.setItem("lb-theme", next);
    applyTheme(next);
  });
  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
    if (!localStorage.getItem("lb-theme")) applyTheme(null);
  });

  /* ---------- static chrome ---------- */
  if (CONFIG.TEAM_NAME) els.tagline.textContent = CONFIG.TEAM_NAME + " · Post. Climb. Gloat.";
  if (CONFIG.CHANNEL_HINT) els.channelHint.textContent = CONFIG.CHANNEL_HINT;

  /* ---------- helpers ---------- */
  function timeAgo(iso) {
    if (!iso) return "";
    const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
    if (s < 45) return "just now";
    if (s < 3600) return Math.round(s / 60) + "m ago";
    if (s < 86400) return Math.round(s / 3600) + "h ago";
    const d = Math.round(s / 86400);
    return d === 1 ? "yesterday" : d + "d ago";
  }
  const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  function prettyDay(ymd) { // "2026-08-11" -> "Aug 11"
    const p = String(ymd).split("-");
    return (MONTHS[(+p[1] || 1) - 1] || "") + " " + (+p[2] || "");
  }
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }
  function metric(m, view) { return Number(m[view] || 0); }
  function sorted(members, view) {
    return [...members].sort((a, b) =>
      metric(b, view) - metric(a, view) ||
      Number(b.total || 0) - Number(a.total || 0) ||
      String(a.name).localeCompare(String(b.name)));
  }
  function titleFor(m, rank, view) {
    if (metric(m, view) === 0) return "👻 Yet to post";
    if (rank === 0) return "👑 LinkedIn Legend";
    if (rank === 1) return "🥈 Almost Legend";
    if (rank === 2) return "🥉 Rising Star";
    if (Number(m.streak || 0) >= 3) return "🔥 On a roll";
    return "💼 Grinding";
  }

  /* ---------- derived stats ----------
   * The snapshot ships raw per-day counts per member ({"2026-08-11": 2, …});
   * totals, week/month, streaks, and the daily series are computed here at
   * render time so the board rolls over correctly at midnight / Monday even
   * when nobody has posted for a while. */
  function dayInTz(date, tz) {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
    }).format(date);
  }
  function shiftDay(ymd, delta) {
    const d = new Date(ymd + "T00:00:00Z");
    d.setUTCDate(d.getUTCDate() + delta);
    return d.toISOString().slice(0, 10);
  }
  function derive(raw) {
    const tz = raw.timezone || "Asia/Kolkata";
    const now = new Date();
    const today = dayInTz(now, tz);
    const dow = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].indexOf(
      new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short" }).format(now));
    const weekStart = shiftDay(today, -Math.max(0, dow)); // Monday of this week
    const monthStart = today.slice(0, 8) + "01";

    const members = (raw.members || []).map((m) => {
      const days = m.days;
      if (!days) {
        // legacy snapshot shape with precomputed aggregates
        return { ...m, total: Number(m.total || 0), week: Number(m.week || 0),
                 month: Number(m.month || 0), streak: Number(m.streak || 0) };
      }
      let total = 0, week = 0, month = 0;
      for (const day in days) {
        const c = Number(days[day]) || 0;
        total += c;
        if (day >= weekStart) week += c;
        if (day >= monthStart) month += c;
      }
      let streak = 0;
      let cursor = days[today] ? today
        : days[shiftDay(today, -1)] ? shiftDay(today, -1) : null;
      while (cursor && days[cursor]) { streak++; cursor = shiftDay(cursor, -1); }
      return { ...m, total, week, month, streak };
    });

    let daily;
    if (members.some((m) => m.days)) {
      daily = [];
      for (let i = 13; i >= 0; i--) {
        const day = shiftDay(today, -i);
        daily.push({
          date: day,
          count: members.reduce((n, m) => n + (m.days ? Number(m.days[day]) || 0 : 0), 0),
        });
      }
    } else {
      daily = Array.isArray(raw.daily) ? raw.daily : [];
    }
    return { ...raw, members, daily };
  }

  /* ---------- rendering ---------- */
  function render() {
    if (!state.raw) return;
    const d = derive(state.raw);
    state.data = d;
    if (!Array.isArray(d.members)) return;
    renderStats(d);
    renderPodium(d);
    renderBoard(d);
    renderFeed(d);
    renderChart(d);
    els.updatedAt.textContent = d.updatedAt
      ? "Board data updated " + timeAgo(d.updatedAt) : "";
  }

  function renderStats(d) {
    const total = d.members.reduce((n, m) => n + Number(m.total || 0), 0);
    const week = d.members.reduce((n, m) => n + Number(m.week || 0), 0);
    const daily = Array.isArray(d.daily) ? d.daily : [];
    const today = daily.length ? Number(daily[daily.length - 1].count || 0) : 0;
    els.statTotal.textContent = total;
    els.statWeek.textContent = week;
    els.statToday.textContent = today;
    const champ = sorted(d.members, "total")[0];
    els.statChamp.textContent =
      champ && Number(champ.total || 0) > 0 ? (champ.emoji || "🙂") + " " + champ.name.split(" ")[0] : "Up for grabs";
  }

  function renderPodium(d) {
    const top = sorted(d.members, state.view).slice(0, 3);
    // visual order: 2nd, 1st, 3rd
    const order = [top[1], top[0], top[2]];
    const cls = ["pod-2", "pod-1", "pod-3"];
    const medal = ["2", "1", "3"];
    els.podium.innerHTML = order.map((m, i) => {
      if (!m) return "<div></div>";
      const n = metric(m, state.view);
      const ghost = n === 0 ? " ghost" : "";
      const crown = cls[i] === "pod-1" && n > 0 ? '<span class="crown">👑</span>' : "";
      return (
        '<div class="pod ' + cls[i] + ghost + '">' +
          '<div class="avatar">' + crown + esc(m.emoji || "🙂") + "</div>" +
          '<div class="pod-name">' + esc(m.name) + "</div>" +
          '<div class="pod-count">' + n + (n === 1 ? " post" : " posts") + "</div>" +
          '<div class="pod-base">' + medal[i] + "</div>" +
        "</div>");
    }).join("");
  }

  function renderBoard(d) {
    const list = sorted(d.members, state.view);
    const max = Math.max(1, ...list.map((m) => metric(m, state.view)));
    const prev = state.prevRanks[state.view] || {};
    const ranks = {};
    els.board.innerHTML = list.map((m, i) => {
      ranks[m.name] = i;
      const n = metric(m, state.view);
      const movedUp = prev[m.name] !== undefined && i < prev[m.name];
      const streak = Number(m.streak || 0) >= 2
        ? '<span class="streak" title="' + m.streak + '-day posting streak">🔥 ' + m.streak + "d</span>" : "";
      return (
        '<li class="row">' +
          '<div class="rank">' + (i + 1) + "</div>" +
          '<div class="avatar">' + esc(m.emoji || "🙂") + "</div>" +
          '<div class="who">' +
            '<div class="who-name">' + esc(m.name) + (movedUp ? '<span class="up">▲</span>' : "") + "</div>" +
            '<div class="who-title">' + titleFor(m, i, state.view) +
              (m.lastPostAt ? ' · last post ' + timeAgo(m.lastPostAt) : "") + "</div>" +
          "</div>" +
          '<div class="count-cell">' + streak +
            '<div class="count-bar"><div class="count-fill" style="width:' + Math.round((n / max) * 100) + '%"></div></div>' +
            '<div class="count-num">' + n + "</div>" +
          "</div>" +
        "</li>");
    }).join("");
    state.prevRanks[state.view] = ranks;
    const anyPosts = list.some((m) => Number(m.total || 0) > 0);
    els.emptyMsg.hidden = anyPosts;
  }

  function renderFeed(d) {
    const recent = Array.isArray(d.recent) ? d.recent.slice(0, 12) : [];
    els.feedEmpty.hidden = recent.length > 0;
    els.feed.innerHTML = recent.map((p) => {
      const key = (p.url || "") + "|" + (p.at || "");
      const isNew = !state.firstLoad && !state.seenFeedKeys.has(key);
      state.seenFeedKeys.add(key);
      const link = p.url
        ? '<a href="' + esc(p.url) + '" target="_blank" rel="noopener noreferrer">View ↗</a>' : "";
      return (
        '<li class="' + (isNew ? "new" : "") + '">' +
          '<span class="f-emoji">' + esc(p.emoji || "🙂") + "</span>" +
          '<div class="f-body"><div class="f-name">' + esc(p.name) + "</div>" +
          '<div class="f-time">' + timeAgo(p.at) + "</div></div>" + link +
        "</li>");
    }).join("");
  }

  /* ---------- chart (single series, last 14 days) ---------- */
  function roundedTopBar(x, y, w, h, r) {
    if (h <= 0) return "";
    r = Math.min(r, w / 2, h);
    return "M" + x + "," + (y + h) +
      " L" + x + "," + (y + r) +
      " Q" + x + "," + y + " " + (x + r) + "," + y +
      " L" + (x + w - r) + "," + y +
      " Q" + (x + w) + "," + y + " " + (x + w) + "," + (y + r) +
      " L" + (x + w) + "," + (y + h) + " Z";
  }

  function renderChart(d) {
    const daily = Array.isArray(d.daily) ? d.daily.slice(-14) : [];
    if (!daily.length) { els.chart.innerHTML = '<p class="empty">No activity data yet</p>'; return; }
    const W = 320, H = 150, padL = 6, padR = 6, padT = 20, padB = 24;
    const plotW = W - padL - padR, plotH = H - padT - padB;
    const max = Math.max(1, ...daily.map((x) => Number(x.count || 0)));
    const n = daily.length;
    const gap = 4;
    const bw = Math.max(6, (plotW - gap * (n - 1)) / n);
    const maxIdx = daily.reduce((bi, x, i) => (Number(x.count || 0) > Number(daily[bi].count || 0) ? i : bi), 0);

    let bars = "", hovers = "", labels = "", maxLabel = "";
    daily.forEach((day, i) => {
      const c = Number(day.count || 0);
      const x = padL + i * (bw + gap);
      const h = (c / max) * plotH;
      const y = padT + plotH - h;
      if (c > 0) bars += '<path class="chart-bar" d="' + roundedTopBar(x, y, bw, h, 3) + '"></path>';
      if (i === maxIdx && c > 0) {
        maxLabel = '<text class="chart-max-label" x="' + (x + bw / 2) + '" y="' + (y - 5) + '" text-anchor="middle">' + c + "</text>";
      }
      if (i % 2 === (n - 1) % 2) { // label every other day, always including the last
        labels += '<text class="chart-label" x="' + (x + bw / 2) + '" y="' + (H - 8) + '" text-anchor="middle">' + esc(String(+day.date.split("-")[2] || "")) + "</text>";
      }
      hovers += '<rect data-i="' + i + '" x="' + (x - gap / 2) + '" y="0" width="' + (bw + gap) + '" height="' + H + '" fill="transparent"></rect>';
    });

    const midY = padT + plotH / 2;
    els.chart.innerHTML =
      '<svg viewBox="0 0 ' + W + " " + H + '" role="img" aria-label="Bar chart of posts per day over the last 14 days">' +
        '<line class="chart-grid" x1="' + padL + '" y1="' + midY + '" x2="' + (W - padR) + '" y2="' + midY + '"></line>' +
        '<line class="chart-baseline" x1="' + padL + '" y1="' + (padT + plotH) + '" x2="' + (W - padR) + '" y2="' + (padT + plotH) + '"></line>' +
        bars + maxLabel + labels + hovers +
      "</svg>";

    const svg = els.chart.querySelector("svg");
    svg.addEventListener("mousemove", (e) => {
      const t = e.target.closest("rect[data-i]");
      if (!t) { els.tooltip.hidden = true; return; }
      const day = daily[+t.getAttribute("data-i")];
      if (!day) { els.tooltip.hidden = true; return; }
      const c = Number(day.count || 0);
      els.tooltip.textContent = prettyDay(day.date) + " · " + c + (c === 1 ? " post" : " posts");
      els.tooltip.style.left = e.clientX + "px";
      els.tooltip.style.top = e.clientY + "px";
      els.tooltip.hidden = false;
    });
    svg.addEventListener("mouseleave", () => { els.tooltip.hidden = true; });
  }

  /* ---------- celebrations ---------- */
  let toastTimer = null;
  function showToast(msg) {
    els.toast.textContent = msg;
    els.toast.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => els.toast.classList.remove("show"), 4200);
  }

  const confettiColors = ["#2a78d6", "#eda100", "#eb6834", "#e87ba4", "#1baf7a", "#4a3aa7"];
  function fireConfetti() {
    const canvas = els.confetti;
    const ctx = canvas.getContext("2d");
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
    const parts = [];
    for (let i = 0; i < 140; i++) {
      const fromLeft = i % 2 === 0;
      parts.push({
        x: fromLeft ? -10 : canvas.width + 10,
        y: canvas.height * (0.25 + Math.random() * 0.4),
        vx: (fromLeft ? 1 : -1) * (4 + Math.random() * 7),
        vy: -(6 + Math.random() * 6),
        g: 0.22 + Math.random() * 0.12,
        s: 5 + Math.random() * 6,
        r: Math.random() * Math.PI,
        vr: (Math.random() - 0.5) * 0.3,
        c: confettiColors[i % confettiColors.length],
      });
    }
    const t0 = performance.now();
    function tick(t) {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      for (const p of parts) {
        p.x += p.vx; p.vy += p.g; p.y += p.vy; p.r += p.vr; p.vx *= 0.99;
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate(p.r);
        ctx.fillStyle = p.c;
        ctx.fillRect(-p.s / 2, -p.s / 2, p.s, p.s * 0.6);
        ctx.restore();
      }
      if (t - t0 < 2400) requestAnimationFrame(tick);
      else ctx.clearRect(0, 0, canvas.width, canvas.height);
    }
    requestAnimationFrame(tick);
  }

  function celebrate(d) {
    if (!state.prevTotals) return;
    for (const m of d.members) {
      const prev = state.prevTotals[m.name];
      const now = Number(m.total || 0);
      if (prev === undefined || now <= prev) continue;
      const milestone = MILESTONES.find((ms) => prev < ms && now >= ms);
      if (milestone) {
        showToast("🎉 " + (m.emoji || "") + " " + m.name + " just hit " + milestone + " posts! Legend behavior.");
      } else {
        showToast((m.emoji || "") + " " + m.name + " just posted! 🔥 That's " + now + ".");
      }
      fireConfetti();
      break; // one celebration per refresh is plenty
    }
  }

  /* ---------- data ---------- */
  async function fetchData() {
    try {
      const res = await fetch(SNAPSHOT_URL + "?t=" + Date.now(), { cache: "no-store" });
      if (res.status === 400 || res.status === 404) {
        // board file not created yet — that's an empty board, not an outage
        state.lastOkFetch = Date.now();
        if (!state.raw) {
          els.statTotal.textContent = els.statWeek.textContent = els.statToday.textContent = "0";
          els.statChamp.textContent = "Up for grabs";
          els.emptyMsg.hidden = false;
        }
      } else {
        if (!res.ok) throw new Error("HTTP " + res.status);
        const raw = await res.json();
        state.lastOkFetch = Date.now();
        const rawStr = JSON.stringify(raw);
        const changed = rawStr !== state.rawStr;
        state.raw = raw;
        state.rawStr = rawStr;
        const d = derive(raw);
        if (changed) {
          celebrate(d);
          render();
        }
        state.prevTotals = Object.fromEntries(d.members.map((m) => [m.name, Number(m.total || 0)]));
        state.firstLoad = false;
      }
    } catch (err) {
      // keep showing the last good data; the pill goes stale below
    }
    const fresh = Date.now() - state.lastOkFetch < STALE_AFTER_MS;
    els.livePill.classList.toggle("stale", !fresh);
    els.liveLabel.textContent = fresh ? "LIVE" : "RECONNECTING…";
  }

  /* ---------- view toggle ---------- */
  document.querySelectorAll(".seg-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".seg-btn").forEach((b) => {
        b.classList.toggle("active", b === btn);
        b.setAttribute("aria-selected", b === btn ? "true" : "false");
      });
      state.view = VIEWS[btn.dataset.view] || "total";
      render();
    });
  });

  /* ---------- optional realtime (instant updates) ---------- */
  if (CONFIG.SUPABASE_ANON_KEY) {
    import("https://esm.sh/@supabase/supabase-js@2")
      .then(({ createClient }) => {
        const sb = createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_ANON_KEY);
        sb.channel("posts-live")
          .on("postgres_changes", { event: "*", schema: "public", table: "posts" }, () => {
            // snapshot is rebuilt right after the insert — grab it a beat later
            setTimeout(fetchData, 900);
            setTimeout(fetchData, 2500);
          })
          .subscribe();
      })
      .catch(() => { /* polling still covers us */ });
  }

  /* ---------- go ---------- */
  fetchData();
  setInterval(() => { if (!document.hidden) fetchData(); }, POLL_MS);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) fetchData(); });
  setInterval(() => { if (state.raw) render(); }, 60000); // refresh relative times + midnight rollover
})();
