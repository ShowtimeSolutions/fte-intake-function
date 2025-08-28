// index.js — Azure Function (Node 18+)
const { GoogleSpreadsheet } = require("google-spreadsheet");
const { JWT } = require("google-auth-library");
const fetch = require("node-fetch");

/* ============ ENV & CONSTANTS ============ */
const SHEET_ID = process.env.GOOGLE_SHEETS_DATA_ID || "1KY-O6F-6rwSUsCvfQGQaADu985jTDCUJN4Oc0zKpiBA"; // your tracker
const TAB_NAME = process.env.GOOGLE_SHEETS_DATA_TAB || "Local Price Tracker";

// Where chat requests are saved (same sheet/tab as your form target)
const CAPTURE_SHEET_ID = process.env.GOOGLE_SHEETS_ID || SHEET_ID;
const CAPTURE_RANGE = process.env.GOOGLE_SHEETS_RANGE || "Sheet1!A:I";

const SERPER_API_KEY = must("SERPER_API_KEY");
const OPENAI_API_KEY = must("OPENAI_API_KEY");
const OPENAI_API_BASE = (process.env.OPENAI_API_BASE || "https://api.openai.com/v1").replace(/\/+$/, "");

/* ============ UTIL ============ */
function must(name) {
  const v = process.env[name];
  if (!v || String(v).trim() === "") throw new Error(`Missing env var ${name}`);
  return v;
}
function parseServiceAccount() {
  // Support the single JSON var or split vars
  if (process.env.GOOGLE_SHEETS_CREDENTIALS) {
    const creds = JSON.parse(process.env.GOOGLE_SHEETS_CREDENTIALS);
    if (creds.private_key && creds.private_key.includes("\\n")) {
      creds.private_key = creds.private_key.replace(/\\n/g, "\n");
    }
    return { email: creds.client_email, key: creds.private_key };
  }
  if (process.env.GOOGLE_SHEETS_CLIENT_EMAIL && process.env.GOOGLE_SHEETS_PRIVATE_KEY) {
    return {
      email: process.env.GOOGLE_SHEETS_CLIENT_EMAIL,
      key: process.env.GOOGLE_SHEETS_PRIVATE_KEY.replace(/\\n/g, "\n"),
    };
  }
  throw new Error("Missing Google service account: set GOOGLE_SHEETS_CREDENTIALS (JSON) or GOOGLE_SHEETS_CLIENT_EMAIL + GOOGLE_SHEETS_PRIVATE_KEY.");
}

/* ============ GOOGLE SHEETS (READ) ============ */
let sheetsCache = { data: null, ts: 0, ttl: 30 * 60 * 1000 }; // 30 min

async function initDoc(sheetId) {
  const sa = parseServiceAccount();
  const auth = new JWT({
    email: sa.email,
    key: sa.key,
    scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"],
  });
  const doc = new GoogleSpreadsheet(sheetId, auth);
  await doc.loadInfo();
  return doc;
}
async function loadEventsData() {
  const now = Date.now();
  if (sheetsCache.data && now - sheetsCache.ts < sheetsCache.ttl) return sheetsCache.data;

  const doc = await initDoc(SHEET_ID);
  const sheet = doc.sheetsByTitle[TAB_NAME];
  if (!sheet) throw new Error(`Sheet tab "${TAB_NAME}" not found`);
  const rows = await sheet.getRows();

  const events = rows
    .map((row) => ({
      eventId: row.get("Event ID"),
      priceTrend: row.get("Price Trend"),
      artist: row.get("Artist"),
      venue: row.get("Venue"),
      date: row.get("Date"),
      vividLink: row.get("Vivid Link"),
      skyboxLink: row.get("SkyBox Link"),
      initialTrackingDate: row.get("Initial Tracking Date"),
      currentPrice: getCurrentPrice(row),
    }))
    .filter((e) => e.artist && e.date);

  sheetsCache = { data: events, ts: now, ttl: sheetsCache.ttl };
  return events;
}
function getCurrentPrice(row) {
  for (let i = 1; i <= 42; i++) {
    const p = row.get(`Price #${i}`);
    if (p && String(p).trim() !== "") return p;
  }
  return null;
}

/* ============ SEARCH / PRICE HELPERS ============ */
async function searchArtistPerformances(artistQuery) {
  try {
    const events = await loadEventsData();
    const q = artistQuery.toLowerCase().trim();
    const matches = events.filter((e) => {
      const a = e.artist.toLowerCase();
      return (
        a.includes(q) ||
        q.includes(a) ||
        a.split(/[-\s]+/).some((w) => q.includes(w)) ||
        q.split(/[-\s]+/).some((w) => a.includes(w))
      );
    });
    return matches.sort((a, b) => new Date(a.date) - new Date(b.date));
  } catch (e) {
    console.error("searchArtistPerformances:", e);
    return [];
  }
}
async function getEventRecommendations(dateFilter = null, offset = 0, limit = 3) {
  try {
    const events = await loadEventsData();
    let startDate, endDate;
    const today = new Date();
    if (dateFilter?.includes("weekend")) {
      const dow = today.getDay();
      const daysUntilFri = dow <= 5 ? 5 - dow : 12 - dow;
      startDate = new Date(today);
      startDate.setDate(today.getDate() + daysUntilFri);
      endDate = new Date(startDate);
      endDate.setDate(startDate.getDate() + 2);
    } else if (dateFilter?.includes("week")) {
      startDate = today;
      endDate = new Date(today);
      endDate.setDate(today.getDate() + 7);
    } else if (dateFilter?.includes("month")) {
      startDate = today;
      endDate = new Date(today);
      endDate.setDate(today.getDate() + 30);
    } else if (dateFilter?.includes("tonight") || dateFilter?.includes("today")) {
      startDate = today;
      endDate = new Date(today);
      endDate.setDate(today.getDate() + 1);
    } else {
      startDate = today;
      endDate = new Date(today);
      endDate.setDate(today.getDate() + 14);
    }
    const filtered = events.filter((e) => {
      const d = new Date(e.date);
      return d >= startDate && d <= endDate;
    });
    const sorted = filtered.sort((a, b) => new Date(a.date) - new Date(b.date));
    const slice = sorted.slice(offset, offset + limit);
    return { events: slice, total: sorted.length, hasMore: offset + limit < sorted.length };
  } catch (e) {
    console.error("getEventRecommendations:", e);
    return { events: [], total: 0, hasMore: false };
  }
}
async function getPriceFromVividSeats(vividLink) {
  try {
    if (!vividLink || !vividLink.trim()) return null;
    const resp = await fetch(vividLink, {
      headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" },
    });
    if (!resp.ok) return null;
    const html = await resp.text();
    const pats = [
      /get in for \$(\d+)/i,
      /starting at \$(\d+)/i,
      /from \$(\d+)/i,
      /\$(\d+)\+/,
      /"price":\s*"?\$?(\d+)/i,
      /data-price="(\d+)"/i,
      /price-value[^>]*>\$(\d+)/i,
    ];
    for (const re of pats) {
      const m = html.match(re);
      if (m?.[1]) return `$${m[1]}`;
    }
    return null;
  } catch (e) {
    console.error("getPriceFromVividSeats:", e);
    return null;
  }
}
async function getPriceFromDatabase(artistQuery) {
  try {
    const events = await loadEventsData();
    const q = artistQuery.toLowerCase().trim();
    const matches = events.filter((e) => {
      const a = e.artist.toLowerCase();
      return (
        a.includes(q) ||
        q.includes(a) ||
        a.split(/[-\s]+/).some((w) => q.includes(w)) ||
        q.split(/[-\s]+/).some((w) => a.includes(w))
      );
    });
    if (!matches.length) return null;
    const event = matches[0];
    if (event.vividLink) {
      const p = await getPriceFromVividSeats(event.vividLink);
      if (p) return { price: p, source: "vivid_seats", event };
    }
    return { price: null, source: "vivid_seats", event };
  } catch (e) {
    console.error("getPriceFromDatabase:", e);
    return null;
  }
}

/* ============ SIMPLE SERPER FALLBACKS (kept from your working build) ============ */
async function searchPerformanceWebFallback(artistQuery) {
  try {
    const response = await fetch("https://google.serper.dev/search", {
      method: "POST",
      headers: { "X-API-KEY": SERPER_API_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({ q: `${artistQuery} chicago concerts 2025 tickets`, num: 5 }),
    });
    if (!response.ok) return null;
    const data = await response.json();
    const results = data.organic || [];
    for (const r of results) {
      const content = `${r.title} ${r.snippet}`.toLowerCase();
      const datePat = /(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s+\d{1,2}|\d{1,2}\/\d{1,2}\/\d{4}/i;
      const venuePat = /(united center|soldier field|wrigley field|allstate arena|chicago theatre|house of blues)/i;
      const d = content.match(datePat);
      const v = content.match(venuePat);
      if (d || v) {
        return `Based on my quick research, ${artistQuery} appears to have upcoming shows in Chicago${d ? ` around ${d[0]}` : ""}${v ? ` at ${v[0]}` : ""}. This may not be 100% accurate.`;
      }
    }
    return null;
  } catch {
    return null;
  }
}
async function getRecommendationsWebFallback(dateFilter = null) {
  try {
    let q = "chicago concerts events ";
    q += dateFilter?.includes("weekend") ? "this weekend" : dateFilter?.includes("week") ? "this week" : "upcoming";
    const response = await fetch("https://google.serper.dev/search", {
      method: "POST",
      headers: { "X-API-KEY": SERPER_API_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({ q, num: 10 }),
    });
    if (!response.ok) return null;
    const data = await response.json();
    const results = data.organic || [];
    const picks = [];
    for (const r of results) {
      const t = (r.title || "").toLowerCase();
      const s = (r.snippet || "").toLowerCase();
      if (t.includes("concert") || t.includes("show") || t.includes("event") || s.includes("tickets")) {
        picks.push(r.title);
        if (picks.length >= 3) break;
      }
    }
    if (!picks.length) return null;
    return `Here are a few things in Chicago:\n\n1) ${picks[0]}\n2) ${picks[1] || ""}\n3) ${picks[2] || ""}\n\n(This is from quick web research and may not be 100% accurate.)`.trim();
  } catch {
    return null;
  }
}
async function getPriceWebFallback(artistQuery) {
  try {
    const response = await fetch("https://google.serper.dev/search", {
      method: "POST",
      headers: { "X-API-KEY": SERPER_API_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({ q: `${artistQuery} chicago tickets price vivid seats`, num: 5 }),
    });
    if (!response.ok) return null;
    const data = await response.json();
    const results = data.organic || [];
    const pats = [/get in for \$(\d+)/i, /starting at \$(\d+)/i, /from \$(\d+)/i, /tickets from \$(\d+)/i, /\$(\d+)\+/];
    for (const r of results) {
      const content = `${r.title} ${r.snippet}`;
      for (const re of pats) {
        const m = content.match(re);
        if (m?.[1]) return `$${m[1]}`;
      }
    }
    return null;
  } catch {
    return null;
  }
}

/* ============ OPENAI (for general chat turn) ============ */
async function getChatCompletion(messages) {
  const systemPrompt =
    `You are a helpful ticket assistant for Fair Ticket Exchange (Chicago area).
- Detect queries: performance, price, or recommendations.
- First try the local database helpers the app provides (already run outside of you); otherwise continue the convo.
- Keep replies short and conversational.
- When user wants to place a request, collect: artist/event, ticket qty, budget tier ("<$50","$50–$99","$100–$149","$150–$199","$200–$249","$250–$299","$300–$349","$350–$399","$400–$499","$500+"), date/range (optional), name, email, phone (optional), notes (optional).
- Summarize and ask to confirm before we save.`;

  const resp = await fetch(`${OPENAI_API_BASE}/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "gpt-4o-mini", // safe, inexpensive; change if you use Azure deployment name via OPENAI_API_BASE
      messages: [{ role: "system", content: systemPrompt }, ...messages],
      temperature: 0.6,
      max_tokens: 500,
    }),
  });
  if (!resp.ok) {
    const t = await resp.text();
    throw new Error(`OpenAI error ${resp.status}: ${t}`);
  }
  const data = await resp.json();
  return data.choices?.[0]?.message?.content || "Okay.";
}

/* ============ CAPTURE (WRITE) ============ */
function toRow(c) {
  const ts = new Date().toLocaleString("en-US", { timeZone: "America/Chicago" });
  return [
    ts,
    c.artist_or_event || "",
    Number.isFinite(c.ticket_qty) ? c.ticket_qty : parseInt(c.ticket_qty || "", 10) || "",
    c.budget_tier || "",
    c.date_or_date_range || "",
    c.name || "",
    c.email || "",
    c.phone || "",
    c.notes || "",
  ];
}
async function appendCaptureRow(row) {
  // Use Sheets API v4 for writing (googleapis), but since you're already using google-spreadsheet for read-only,
  // the simplest write path is to call your existing HTTP function endpoint OR switch to googleapis here.
  // To keep your “working” behavior unchanged, we’ll write via googleapis values.append using a second auth object.
  const { google } = require("googleapis");
  const sa = parseServiceAccount();
  const auth = new (require("google-auth-library").JWT)(
    sa.email,
    null,
    sa.key,
    ["https://www.googleapis.com/auth/spreadsheets"]
  );
  await auth.authorize();
  const sheets = google.sheets({ version: "v4", auth });
  await sheets.spreadsheets.values.append({
    spreadsheetId: CAPTURE_SHEET_ID,
    range: CAPTURE_RANGE,
    valueInputOption: "USER_ENTERED",
    requestBody: { values: [row] },
  });
}

/* ============ INTENT LAYER (VERY LIGHT) ============ */
function isPerf(msg) {
  const m = msg.toLowerCase();
  return (m.includes("does ") && (m.includes("play") || m.includes("perform"))) ||
         (m.includes("is ") && (m.includes("playing") || m.includes("performing"))) ||
         m.includes("when is");
}
function isPrice(msg) {
  const m = msg.toLowerCase();
  return m.includes("price") || m.includes("cost") || m.includes("how much");
}
function isRecs(msg) {
  const m = msg.toLowerCase();
  return m.includes("recommend") || (m.includes("what") && m.includes("happening")) ||
         m.includes("events") || m.includes("shows") || m.includes("weekend");
}

/* ============ REQUEST HANDLER ============ */
module.exports = async function (context, req) {
  // CORS
  context.res = {
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
    },
  };
  if (req.method === "OPTIONS") { context.res.status = 200; return; }

  try {
    // Manual form direct save
    if (req.body?.direct_capture && req.body?.capture) {
      await appendCaptureRow(toRow(req.body.capture));
      context.res.status = 200;
      context.res.body = { response: "Saved your request. We’ll follow up soon!" };
      return;
    }

    const { message, conversationHistory = [] } = req.body || {};
    if (!message) {
      context.res.status = 400;
      context.res.body = { error: "Message is required" };
      return;
    }

    // Fast lanes that use your Google Sheet first
    if (isPerf(message)) {
      const artist = message.replace(/^(does|is|when is)\s*/i, "").replace(/(play|perform(ing)?)\??$/i, "").trim();
      const hits = await searchArtistPerformances(artist);
      if (hits.length) {
        const show = hits[0];
        const date = new Date(show.date).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
        context.res.status = 200;
        context.res.body = { response: `Yes! ${show.artist} is performing on ${date} at ${show.venue}. Want ticket info?` };
        return;
      }
      const web = await searchPerformanceWebFallback(artist);
      if (web) { context.res.status = 200; context.res.body = { response: web }; return; }
    }

    if (isPrice(message)) {
      const m = message.match(/(?:price|cost|how much).*?(?:for|of)\s+([^?]+)/i);
      const artist = (m && m[1]) ? m[1].trim() : message.replace(/(price|cost|how much)/ig, "").trim();
      const got = await getPriceFromDatabase(artist);
      if (got?.price) { context.res.status = 200; context.res.body = { response: `I found tickets starting from ${got.price} on Vivid Seats. How many tickets do you need?` }; return; }
      if (got?.event) {
        const web = await getPriceWebFallback(artist);
        if (web) { context.res.status = 200; context.res.body = { response: `I found the event but couldn't fetch a live price. Based on quick research, tickets start around ${web}.` }; return; }
        context.res.status = 200; context.res.body = { response: "I found the event but don’t see a current price yet. I can keep checking and update you." }; return;
      }
      const web = await getPriceWebFallback(artist);
      if (web) { context.res.status = 200; context.res.body = { response: `I don’t see it in our tracker, but quick research suggests tickets start around ${web}.` }; return; }
    }

    if (isRecs(message)) {
      const df = /weekend/i.test(message) ? "weekend" : /week/i.test(message) ? "week" : /month/i.test(message) ? "month" : /today|tonight/i.test(message) ? "tonight" : null;
      const recs = await getEventRecommendations(df, 0, 3);
      if (recs.events.length) {
        let out = "Here are a few picks:\n\n";
        recs.events.forEach((e, i) => {
          const d = new Date(e.date).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
          out += `${i + 1}. ${e.artist} — ${d} at ${e.venue}${e.currentPrice ? ` (from ${e.currentPrice})` : ""}\n`;
        });
        if (recs.hasMore) out += `\nWant to see more? I have ${recs.total - 3} additional suggestions.`;
        context.res.status = 200;
        context.res.body = { response: out.trim() };
        return;
      }
      const web = await getRecommendationsWebFallback(df);
      if (web) { context.res.status = 200; context.res.body = { response: web }; return; }
    }

    // Otherwise: general chat turn with OpenAI
    const response = await getChatCompletion([
      ...conversationHistory,
      { role: "user", content: message },
    ]);
    context.res.status = 200;
    context.res.body = { response };
  } catch (err) {
    console.error("chat function error:", err);
    context.res.status = 500;
    context.res.body = { error: err.message || String(err) };
  }
};

