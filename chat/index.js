// index.js — Azure Function (Node 18+)
// ------------------------------------
const { google } = require("googleapis");
const fetch = require("node-fetch");

/* ========== ENV ========== */
function must(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var ${name}`);
  return v;
}

const CAPTURE_SHEET_ID   = must("GOOGLE_SHEETS_ID");               // where chat + manual form are saved
const CAPTURE_RANGE      = process.env.GOOGLE_SHEETS_RANGE || "Sheet1!A:I";

const TRACKER_SHEET_ID   = process.env.GOOGLE_SHEETS_TRACKER_ID || CAPTURE_SHEET_ID; // allow separate file if you ever split it
const TRACKER_TAB        = process.env.GOOGLE_SHEETS_TRACKER_TAB || "Local Price Tracker"; // your screenshot tab name

const SERPER_API_KEY     = must("SERPER_API_KEY");
const OPENAI_API_KEY     = must("OPENAI_API_KEY");
const OPENAI_API_BASE    = (process.env.OPENAI_API_BASE || "https://api.openai.com/v1").replace(/\/+$/,"");

/* ========== Google Sheets ========== */
async function getSheetsClient() {
  const creds = JSON.parse(must("GOOGLE_SHEETS_CREDENTIALS"));
  const auth = new google.auth.JWT(
    creds.client_email,
    null,
    creds.private_key,
    ["https://www.googleapis.com/auth/spreadsheets"]
  );
  await auth.authorize();
  return google.sheets({ version: "v4", auth });
}

async function appendToSheet(row) {
  const sheets = await getSheetsClient();
  await sheets.spreadsheets.values.append({
    spreadsheetId: CAPTURE_SHEET_ID,
    range: CAPTURE_RANGE,
    valueInputOption: "USER_ENTERED",
    requestBody: { values: [row] },
  });
}

/* Generic reader for a tab */
async function readTab(spreadsheetId, tabName) {
  const sheets = await getSheetsClient();
  const range = `${tabName}!A:Z`;
  const resp = await sheets.spreadsheets.values.get({ spreadsheetId, range });
  const rows = resp.data.values || [];
  if (!rows.length) return { headers: [], rows: [] };
  const headers = rows[0].map((h) => String(h || "").trim());
  const dataRows = rows.slice(1);
  return { headers, rows: dataRows };
}

/* ========== Row builder for captured requests ========== */
function toRow(c) {
  const ts = new Date().toLocaleString("en-US", { timeZone: "America/Chicago" }); // A
  const artist = c?.artist_or_event || "";                                        // B
  const qty = Number.isFinite(c?.ticket_qty) ? c.ticket_qty : (parseInt(c?.ticket_qty || "", 10) || ""); // C
  const budgetTier = c?.budget_tier || c?.budget || "";                            // D
  const dateRange = c?.date_or_date_range || "";                                   // E
  const name = c?.name || "";                                                      // F
  const email = c?.email || "";                                                    // G
  const phone = c?.phone || "";                                                    // H
  const notes = c?.notes || "";                                                    // I
  return [ts, artist, qty, budgetTier, dateRange, name, email, phone, notes];
}

/* ========== Tracker-powered suggestions & prices ========== */
function indexBy(headers, ...candidates) {
  const lc = headers.map(h => h.toLowerCase());
  for (const cand of candidates) {
    const i = lc.findIndex(h => h === cand || h.includes(cand));
    if (i !== -1) return i;
  }
  return -1;
}

const PRICE_RE = /\$[ ]?(\d{2,4})(?:\s*-\s*\$?\d{2,4})?/gi;
function firstPriceVal(text) {
  if (!text) return null;
  let m; PRICE_RE.lastIndex = 0;
  while ((m = PRICE_RE.exec(text))) {
    const val = parseInt(m[1], 10);
    if (!isNaN(val) && val >= 20) return val;
  }
  return null;
}

/* Pull a rough starting price for an artist from tracker tab */
async function localPriceForArtist(artist) {
  if (!artist) return null;
  const { headers, rows } = await readTab(TRACKER_SHEET_ID, TRACKER_TAB);
  if (!headers.length || !rows.length) return null;

  const artistIdx = indexBy(headers, "artist_or_event", "artist", "event", "title");
  const priceIdx  = indexBy(headers, "price", "starting_price", "from", "lowest", "price #1");

  let best = null;

  for (const r of rows) {
    const a = artistIdx !== -1 ? String(r[artistIdx] || "") : "";
    if (!a) continue;
    if (!a.toLowerCase().includes(String(artist).toLowerCase())) continue;

    if (priceIdx !== -1) {
      const p = firstPriceVal(String(r[priceIdx] || ""));
      if (p != null) best = best == null ? p : Math.min(best, p);
    } else {
      // scan whole row for a $ value
      for (const cell of r) {
        const p = firstPriceVal(String(cell || ""));
        if (p != null) { best = best == null ? p : Math.min(best, p); }
      }
    }
  }
  return best;
}

/* Small list of suggestions for a city from tracker tab */
async function localSuggestions(city = "chicago", max = 5) {
  const { headers, rows } = await readTab(TRACKER_SHEET_ID, TRACKER_TAB);
  if (!headers.length || !rows.length) return [];

  const artistIdx = indexBy(headers, "artist_or_event", "artist", "event", "title");
  const cityIdx   = indexBy(headers, "city", "location");
  const dateIdx   = indexBy(headers, "date", "when");
  const priceIdx  = indexBy(headers, "price", "starting_price", "from", "lowest", "price #1");

  const out = [];
  for (const r of rows) {
    const a = artistIdx !== -1 ? String(r[artistIdx] || "") : "";
    if (!a) continue;

    const c = cityIdx !== -1 ? String(r[cityIdx] || "") : "";
    if (c && city && !c.toLowerCase().includes(city.toLowerCase())) continue;

    const d = dateIdx !== -1 ? String(r[dateIdx] || "") : "";
    let pNum = null;
    if (priceIdx !== -1) pNum = firstPriceVal(String(r[priceIdx] || ""));
    if (pNum == null) {
      for (const cell of r) {
        const p = firstPriceVal(String(cell || ""));
        if (p != null) { pNum = p; break; }
      }
    }
    const line = `${a}${d ? ` (${d})` : ""}${pNum != null ? `: Starting at $${pNum}` : ""}`;
    out.push({ line, p: pNum ?? Infinity });
    if (out.length >= max) break;
  }
  return out;
}

/* ========== Serper web search (fallback) ========== */
async function webSearch(query, location, { preferTickets = true, max = 5 } = {}) {
  const siteBias = preferTickets ? " (site:vividseats.com OR site:ticketmaster.com)" : "";
  const hasTicketsWord = /\bticket(s)?\b/i.test(query);
  const qFinal = query + (hasTicketsWord ? "" : " tickets") + (location ? ` ${location}` : "") + siteBias;

  const resp = await fetch("https://google.serper.dev/search", {
    method: "POST",
    headers: { "X-API-KEY": SERPER_API_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ q: qFinal, num: max }),
  });
  if (!resp.ok) throw new Error(await resp.text());
  const data = await resp.json();
  return (data.organic || []).map((r, i) => ({
    n: i + 1,
    title: r.title || "",
    link: r.link || "",
    snippet: r.snippet || "",
  }));
}

function minPriceAcross(items) {
  let best = null;
  for (const it of items || []) {
    const val = firstPriceVal(`${it.title} ${it.snippet}`);
    if (val != null) best = best == null ? val : Math.min(best, val);
  }
  return best;
}

function priceSummaryMessage(priceNum) {
  if (priceNum != null) return `Summary: Lowest starting price around $${priceNum}.\n\nWould you like me to open the request form?`;
  return `Summary: I couldn’t confirm a current starting price just yet.\n\nWould you like me to open the request form?`;
}

/* ========== OpenAI Responses API ========== */
async function callOpenAI(messages) {
  const sysPrompt = `
You are FTE’s polite, fast, and helpful ticket intake assistant on a public website.

GOALS
- Help the user pick or request tickets with minimum back-and-forth.
- Be conversational and ask only one short question at a time for missing details.
- When the user confirms details, CALL capture_ticket_request immediately.
- For ideas/dates/prices, try local tracker first (handled by the server) or call web_search and return a one-line price summary (no links).

DATA TO CAPTURE
- artist_or_event (required) — e.g., "Jonas Brothers"
- ticket_qty (required, integer)
- budget_tier (required; one of "<$50","$50–$99","$100–$149","$150–$199","$200–$249","$250–$299","$300–$349","$350–$399","$400–$499","$500+")
- date_or_date_range (optional)
- name (required), email (required), phone (optional), notes (optional)

STYLE
- Short, friendly replies.
- Never ask for City/Residence.
- Never tell them to fill a form; the website opens it if they ask.
- After they confirm the summary, CALL capture_ticket_request instead of asking again.
`;

  const body = {
    model: "gpt-4.1-mini",
    temperature: 0.2,
    input: [{ role: "system", content: sysPrompt }, ...messages],
    tools: [
      {
        type: "function",
        name: "capture_ticket_request",
        description: "Finalize a ticket request and log to Google Sheets.",
        parameters: {
          type: "object",
          properties: {
            artist_or_event: { type: "string" },
            ticket_qty: { type: "integer" },
            budget_tier: {
              type: "string",
              enum: [
                "<$50","$50–$99","$100–$149","$150–$199",
                "$200–$249","$250–$299","$300–$349","$350–$399",
                "$400–$499","$500+"
              ]
            },
            date_or_date_range: { type: "string" },
            name: { type: "string" },
            email: { type: "string" },
            phone: { type: "string" },
            notes: { type: "string" }
          },
          required: ["artist_or_event", "ticket_qty", "budget_tier", "name", "email"]
        }
      },
      {
        type: "function",
        name: "web_search",
        description: "Search the web for events, venues, dates, ticket info, or prices.",
        parameters: {
          type: "object",
          properties: {
            q: { type: "string" },
            location: { type: "string" }
          },
          required: ["q"]
        }
      }
    ],
    tool_choice: "auto"
  };

  const resp = await fetch(`${OPENAI_API_BASE}/responses`, {
    method: "POST",
    headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  if (!resp.ok) throw new Error(await resp.text());
  return resp.json();
}

/* ========== Response helpers ========== */
function digToolCalls(x) {
  if (!x) return [];
  if (Array.isArray(x)) return x.flatMap(digToolCalls);
  const out = [];
  if (x.type === "tool_call" && x.name) out.push(x);
  if (x.output) out.push(...digToolCalls(x.output));
  if (x.content) out.push(...digToolCalls(x.content));
  return out;
}
function toAssistantText(obj) {
  const tryList = [obj?.output_text, obj?.text, obj?.content, obj?.output];
  const flat = (node) => {
    if (!node) return "";
    if (typeof node === "string") return node;
    if (Array.isArray(node)) return node.map(flat).join("");
    if (typeof node === "object") return [node.text, node.content, node.output].map(flat).join("");
    return "";
  };
  for (const cand of tryList) {
    const s = flat(cand).trim();
    if (s) return s;
  }
  return "";
}

/* ========== Intent helpers ========== */
function looksLikeSearch(msg) {
  const q = (msg || "").toLowerCase();
  return /what.*(show|event)|show(s)?|event(s)?|happening|things to do|prices?|price|tickets?|concert|theater|theatre|sports|game|popular|upcoming|suggest|recommend/.test(q);
}
function looksLikePrice(msg) { return /(price|prices|cost|how much)/i.test(msg || ""); }
function wantsSuggestions(msg) { return /(suggest|recommend|popular|upcoming|what.*to do|what.*going on|ideas)/i.test(msg || ""); }

/* ========== Azure Function entry ========== */
module.exports = async function (context, req) {
  context.res = {
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type"
    }
  };

  if (req.method === "OPTIONS") { context.res.status = 204; return; }
  if (req.method !== "POST") { context.res.status = 405; context.res.body = { error: "Method not allowed" }; return; }

  try {
    // 1) Manual form submission (your Framer modal)
    if (req.body?.direct_capture && req.body?.capture) {
      await appendToSheet(toRow(req.body.capture));
      context.res.status = 200;
      context.res.body = { message: "Saved your request. We’ll follow up soon!", captured: req.body.capture };
      return;
    }

    const messages = Array.isArray(req.body?.messages) ? req.body.messages : [];
    const lastUser = [...messages].reverse().find((m) => m.role === "user")?.content || "";

    // 2) Suggestions path: prefer local tracker
    if (wantsSuggestions(lastUser)) {
      const local = await localSuggestions("chicago", 5);
      if (local.length) {
        const summary = local.map((x) => `• ${x.line}`).join("\n");
        context.res.status = 200;
        context.res.body = { message: `${summary}\n\nWant me to start a request for any of these?` };
        return;
      }
      const results = await webSearch(lastUser, "Chicago", { preferTickets: true, max: 5 });
      const best = minPriceAcross(results);
      const msg = priceSummaryMessage(best);
      context.res.status = 200;
      context.res.body = { message: msg };
      return;
    }

    // 3) OpenAI model pass
    const data = await callOpenAI(messages);
    const calls = digToolCalls(data);
    context.log("Tool calls:", JSON.stringify(calls));

    for (const c of calls) {
      const args = typeof c.arguments === "string" ? JSON.parse(c.arguments) : c.arguments;

      if (c.name === "capture_ticket_request") {
        await appendToSheet(toRow(args));
        context.res.status = 200;
        context.res.body = {
          message: "Thanks! I saved your request and we’ll follow up shortly to confirm details.",
          captured: args
        };
        return;
      }

      if (c.name === "web_search") {
        // Try tracker first for artist price; fallback to web
        const artistGuess = String(args.q || "").replace(/tickets?|price|prices?/ig, "").trim();
        let bestNum = await localPriceForArtist(artistGuess);
        if (bestNum == null) {
          const results = await webSearch(args.q, args.location, { preferTickets: true });
          bestNum = minPriceAcross(results);
        }
        const msg = priceSummaryMessage(bestNum);
        context.res.status = 200;
        context.res.body = { message: msg };
        return;
      }
    }

    // 4) No tools called → just return model text
    const assistantText = toAssistantText(data) || "Great — which artist or event are you looking for, and how many tickets do you need?";
    context.res.status = 200;
    context.res.body = { message: assistantText };
  } catch (e) {
    context.log.error(e);
    context.res.status = 500;
    context.res.body = { error: String(e) };
  }
};

