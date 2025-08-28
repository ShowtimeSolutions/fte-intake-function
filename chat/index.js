// index.js — Azure Function (Node 18+)
// ------------------------------------
const fetch = require("node-fetch");
const { GoogleSpreadsheet } = require("google-spreadsheet");
const { JWT } = require("google-auth-library");

/* =====================  Google Sheets init (supports JSON or split vars)  ===================== */
const SHEET_ID = process.env.GOOGLE_SHEETS_ID || "1KY-O6F-6rwSUsCvfQGQaADu985jTDCUJN4Oc0zKpiBA";
const TAB_NAME = process.env.GOOGLE_SHEETS_TAB || "Local Price Tracker";

async function getSheetsDoc() {
  // Prefer a single JSON blob if provided
  const jsonCred = process.env.GOOGLE_SHEETS_CREDENTIALS;
  let clientEmail, privateKey;

  if (jsonCred) {
    try {
      const parsed = JSON.parse(jsonCred);
      clientEmail = parsed.client_email;
      privateKey = parsed.private_key;
    } catch (err) {
      throw new Error("GOOGLE_SHEETS_CREDENTIALS is not valid JSON");
    }
  } else {
    clientEmail = process.env.GOOGLE_SHEETS_CLIENT_EMAIL;
    privateKey = process.env.GOOGLE_SHEETS_PRIVATE_KEY;
    if (!clientEmail || !privateKey) {
      throw new Error(
        "Missing Google Sheets creds. Set either GOOGLE_SHEETS_CREDENTIALS (JSON) or GOOGLE_SHEETS_CLIENT_EMAIL and GOOGLE_SHEETS_PRIVATE_KEY."
      );
    }
  }

  const auth = new JWT({
    email: clientEmail,
    key: (privateKey || "").replace(/\\n/g, "\n"),
    scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"],
  });

  const doc = new GoogleSpreadsheet(SHEET_ID, auth);
  await doc.loadInfo();
  return doc;
}

/* =====================  Simple cache  ===================== */
let sheetsCache = { data: null, ts: 0, ttl: 30 * 60 * 1000 }; // 30m

async function loadEventsData() {
  const now = Date.now();
  if (sheetsCache.data && now - sheetsCache.ts < sheetsCache.ttl) return sheetsCache.data;

  const doc = await getSheetsDoc();
  const sheet = doc.sheetsByTitle[TAB_NAME];
  if (!sheet) throw new Error(`Sheet tab "${TAB_NAME}" not found`);

  const rows = await sheet.getRows();
  const events = rows
    .map((row) => ({
      eventId: row.get("Event ID"),
      artist: row.get("Artist"),
      venue: row.get("Venue"),
      date: row.get("Date"),
      vividLink: row.get("Vivid Link"),
      skyboxLink: row.get("SkyBox Link"),
      priceTrend: row.get("Price Trend"),
      initialTrackingDate: row.get("Initial Tracking Date"),
      currentPrice: getCurrentPrice(row),
    }))
    .filter((e) => e.artist && e.date);

  sheetsCache = { data: events, ts: now, ttl: sheetsCache.ttl };
  return events;
}

function getCurrentPrice(row) {
  // scan first non-empty "Price #N"
  for (let i = 1; i <= 42; i++) {
    const v = row.get(`Price #${i}`);
    if (v && String(v).trim()) return v;
  }
  return null;
}

/* =====================  Search / Recos / Prices  ===================== */
async function searchArtistPerformances(artistQuery) {
  try {
    const events = await loadEventsData();
    const q = (artistQuery || "").toLowerCase().trim();
    const matches = events.filter((e) => {
      const a = (e.artist || "").toLowerCase();
      return (
        a.includes(q) ||
        q.includes(a) ||
        a.split(/[-\s]+/).some((w) => q.includes(w)) ||
        q.split(/[-\s]+/).some((w) => a.includes(w))
      );
    });
    return matches.sort((a, b) => new Date(a.date) - new Date(b.date));
  } catch (e) {
    console.error("searchArtistPerformances error:", e);
    return [];
  }
}

async function getEventRecommendations(dateFilter = null, offset = 0, limit = 3) {
  try {
    const events = await loadEventsData();

    const window = (() => {
      const start = new Date();
      const end = new Date();
      const t = (s, d) => end.setDate(start.getDate() + d);
      if (!dateFilter) return { start, end: new Date(end.setDate(start.getDate() + 30)) };
      const f = dateFilter.toLowerCase();
      if (f.includes("weekend")) {
        const today = new Date();
        const dow = today.getDay();
        const daysUntilFri = dow <= 5 ? 5 - dow : 7 - dow + 5;
        const s2 = new Date(today);
        s2.setDate(today.getDate() + daysUntilFri);
        const e2 = new Date(s2);
        e2.setDate(s2.getDate() + 2);
        return { start: s2, end: e2 };
      }
      if (f.includes("week")) {
        end.setDate(start.getDate() + 7);
        return { start, end };
      }
      if (f.includes("month")) {
        end.setDate(start.getDate() + 30);
        return { start, end };
      }
      if (f.includes("tonight") || f.includes("today")) {
        end.setDate(start.getDate() + 1);
        return { start, end };
      }
      end.setDate(start.getDate() + 14);
      return { start, end };
    })();

    const filtered = events.filter((e) => {
      const d = new Date(e.date);
      return d >= window.start && d <= window.end;
    });

    const sorted = filtered.sort((a, b) => new Date(a.date) - new Date(b.date));
    const page = sorted.slice(offset, offset + limit);
    return { events: page, total: sorted.length, hasMore: offset + limit < sorted.length };
  } catch (e) {
    console.error("getEventRecommendations error:", e);
    return { events: [], total: 0, hasMore: false };
  }
}

async function getPriceFromVividSeats(vividLink) {
  try {
    if (!vividLink || !String(vividLink).trim()) return null;
    const res = await fetch(vividLink, {
      headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" },
    });
    if (!res.ok) return null;
    const html = await res.text();

    const patterns = [
      /get in for \$(\d+)/i,
      /starting at \$(\d+)/i,
      /from \$(\d+)/i,
      /\$(\d+)\+/,
      /"price":\s*"?\$?(\d+)/i,
      /data-price="(\d+)"/i,
      /price-value[^>]*>\$(\d+)/i,
    ];
    for (const re of patterns) {
      const m = html.match(re);
      if (m && m[1]) return `$${m[1]}`;
    }
    return null;
  } catch (e) {
    console.error("getPriceFromVividSeats error:", e);
    return null;
  }
}

async function getPriceFromDatabase(artistQuery) {
  const events = await loadEventsData();
  const q = (artistQuery || "").toLowerCase().trim();
  const matches = events.filter((e) => (e.artist || "").toLowerCase().includes(q));
  if (!matches.length) return null;

  const event = matches[0];
  if (event.vividLink) {
    const p = await getPriceFromVividSeats(event.vividLink);
    return { price: p, source: "vivid_seats", event };
  }
  return { price: null, source: "vivid_seats", event };
}

/* =====================  OpenAI chat (safe base URL default)  ===================== */
async function getChatCompletion(messages) {
  const systemPrompt = `You are a helpful ticket assistant for Fair Ticket Exchange. You help customers find tickets for events in the Chicago area.

IMPORTANT QUERY CLASSIFICATION:
1) PERFORMANCE QUERIES → use the in-database search first (searchArtistPerformances).
2) PRICE QUERIES → try getPriceFromDatabase (uses Vivid Seats link in our sheet) before any web search.
3) RECOMMENDATION QUERIES → use getEventRecommendations (3 items/page).

FLOW:
- Be conversational and brief; one question at a time.
- If database has it, answer directly. If not, say you can research (not 100% accurate).
- When the user provides artist, quantity, budget, date, name, and email, you can summarize and confirm next steps.`;

  const base = (process.env.OPENAI_API_BASE || "https://api.openai.com").replace(/\/+$/, "");
  try {
    const resp = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-4o-mini", // smaller, fast default; change if you prefer
        messages: [{ role: "system", content: systemPrompt }, ...messages],
        max_tokens: 500,
        temperature: 0.7,
      }),
    });
    if (!resp.ok) throw new Error(`OpenAI API error: ${resp.status}`);
    const data = await resp.json();
    return data.choices?.[0]?.message?.content || "Thanks! How can I help with tickets?";
  } catch (e) {
    console.error("OpenAI API error:", e);
    return "I'm having trouble processing your request right now. Please try again.";
  }
}

/* =====================  Router for user messages  ===================== */
function includesAny(s, arr) {
  const t = (s || "").toLowerCase();
  return arr.some((w) => t.includes(w));
}

async function processUserMessage(userMessage, conversationHistory = []) {
  const msg = (userMessage || "").toLowerCase().trim();

  // Performance queries
  if (
    (msg.startsWith("does ") && (msg.includes(" play") || msg.includes(" perform"))) ||
    (msg.startsWith("is ") && (msg.includes(" playing") || msg.includes(" performing"))) ||
    msg.startsWith("when is ")
  ) {
    const m = msg.match(/(?:does|is|when is)\s+([^?]+?)(?:\s+(?:play|perform|playing|performing))?/i);
    if (m) {
      const artist = (m[1] || "").trim();
      const shows = await searchArtistPerformances(artist);
      if (shows.length) {
        const s = shows[0];
        const date = new Date(s.date).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
        return `Yes — ${s.artist} is on ${date} at ${s.venue}. Want ticket info?`;
      }
    }
  }

  // Price queries
  if (includesAny(msg, ["price", "cost", "how much"])) {
    const m = msg.match(/(?:price|cost|how much).*?(?:for|of)\s+([^?]+)/i);
    const artist = m ? m[1].trim() : msg.replace(/(price|cost|how much)/gi, "").trim();
    if (artist) {
      const res = await getPriceFromDatabase(artist);
      if (res?.price) return `I’m seeing tickets from ${res.price}. How many tickets do you need?`;
      if (res?.event) return `I found the event but don’t have a live price yet. I can still help you request tickets—how many do you need?`;
    }
  }

  // Recommendations
  if (includesAny(msg, ["recommend", "what's happening", "happening", "events", "shows", "weekend"])) {
    let filter = null;
    if (msg.includes("weekend")) filter = "weekend";
    else if (msg.includes("week")) filter = "week";
    else if (msg.includes("month")) filter = "month";
    else if (msg.includes("tonight") || msg.includes("today")) filter = "tonight";

    const rec = await getEventRecommendations(filter, 0, 3);
    if (rec.events.length) {
      let out = "Here are a few upcoming options:\n\n";
      rec.events.forEach((e, i) => {
        const d = new Date(e.date).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
        out += `${i + 1}. ${e.artist} — ${d} at ${e.venue}${e.currentPrice ? ` (from ${e.currentPrice})` : ""}\n`;
      });
      if (rec.hasMore) out += `\nWant to see more? I have ${rec.total - 3} additional picks.`;
      return out;
    }
  }

  // Fall back to LLM
  const messages = [...conversationHistory, { role: "user", content: userMessage }];
  return await getChatCompletion(messages);
}

/* =====================  Azure Function entry  ===================== */
module.exports = async function (context, req) {
  context.res = {
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
    },
  };
  if (req.method === "OPTIONS") {
    context.res.status = 200;
    return;
  }

  try {
    const { message, conversationHistory } = req.body || {};
    if (!message) {
      context.res.status = 400;
      context.res.body = { error: "Message is required" };
      return;
    }

    const reply = await processUserMessage(message, conversationHistory || []);
    context.res.status = 200;
    context.res.body = { response: reply };
  } catch (e) {
    console.error("Function error:", e);
    context.res.status = 500;
    context.res.body = { error: `Internal server error: ${e.message || e}` };
  }
};

// Optional: export helpers for tests
module.exports.searchArtistPerformances = searchArtistPerformances;
module.exports.getEventRecommendations = getEventRecommendations;
module.exports.getPriceFromVividSeats = getPriceFromVividSeats;









