// index.js — Azure Function (Node 18+)
// ------------------------------------
const { google } = require("googleapis");
const fetch = require("node-fetch");

// ---------- Google Sheets ----------
async function getSheetsClient() {
  const creds = JSON.parse(process.env.GOOGLE_SHEETS_CREDENTIALS);
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
  const spreadsheetId = process.env.GOOGLE_SHEETS_ID;
  const range = process.env.GOOGLE_SHEETS_RANGE || "Sheet1!A:I";
  await sheets.spreadsheets.values.append({
    spreadsheetId,
    range,
    valueInputOption: "USER_ENTERED",
    requestBody: { values: [row] },
  });
}

function toRow(c) {
  const timestamp = new Date().toLocaleString("en-US", {
    timeZone: "America/Chicago",
  }); // A
  const artistOrEvent = c?.artist_or_event || ""; // B
  const qty =
    Number.isFinite(c?.ticket_qty) ? c.ticket_qty : parseInt(c?.ticket_qty || "", 10) || ""; // C
  const name = c?.name || ""; // D
  const email = c?.email || ""; // E
  const phone = c?.phone || ""; // F
  const residence = c?.city_or_residence || c?.city || ""; // G
  const budget = c?.budget || ""; // H
  const notes = c?.notes || ""; // I
  return [timestamp, artistOrEvent, qty, name, email, phone, residence, budget, notes];
}

// ---------- Serper Web Search (with ticket-site bias) ----------
async function webSearch(query, location, { preferTickets = true } = {}) {
  // Bias toward ticket sites for cleaner, parseable snippets
  const siteBias = preferTickets
    ? " (site:vividseats.com OR site:ticketmaster.com)"
    : "";

  const hasTicketsWord = /\bticket(s)?\b/i.test(query);
  const qFinal =
    query +
    (hasTicketsWord ? "" : " tickets") +
    (location ? ` ${location}` : "") +
    siteBias;

  const resp = await fetch("https://google.serper.dev/search", {
    method: "POST",
    headers: {
      "X-API-KEY": process.env.SERPER_API_KEY,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ q: qFinal, num: 5 }),
  });
  if (!resp.ok) throw new Error(await resp.text());
  const data = await resp.json();

  const items = (data.organic || []).map((r, i) => ({
    n: i + 1,
    title: r.title,
    link: r.link,
    snippet: r.snippet,
  }));
  return items;
}

// --- Extract/format helpers (no links, clean bullets, summary) ---
const PRICE_RE = /\$[ ]?(\d{2,4})(?:\s*-\s*\$?\d{2,4})?/i;
const DATE_RE  = /\b(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)?\s*(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\.?[a-z]*\s*\d{1,2}(?:,\s*\d{4})?(?:\s*•?\s*\d{1,2}:\d{2}\s*(?:AM|PM))?/i;

function firstMatch(re, text) {
  const m = (text || "").match(re);
  return m ? m[0] : null;
}
function clean(s) {
  return (s || "").replace(/\s+/g, " ").trim();
}
// Drop irrelevant items (e.g., parking pages)
function isIrrelevant(item) {
  const t = `${item.title} ${item.snippet}`.toLowerCase();
  return /parking|hotel|restaurant|faq|blog/.test(t);
}
// Normalize one search card into “Artist @ Venue (Date): Starting at $XX”
function normalizeCompact(item) {
  const title = clean(item.title);
  const snip  = clean(item.snippet);

  const price = firstMatch(PRICE_RE, `${title} ${snip}`);     // "$37"
  const date  = firstMatch(DATE_RE,  `${title} ${snip}`);     // "Tue Aug 26 • 7:30PM"

  let artist  = title.split(" - ")[0] || title;
  if (/^(Concerts|Tickets|Live|Events|Sports)/i.test(artist)) {
    const m = snip.match(/^[A-Z][A-Za-z0-9 .&'’-]+/);
    if (m) artist = m[0];
  }

  let venue = null;
  if (snip) {
    const parts = snip.split(". ");
    const vSeg = parts.find((p) =>
      /(Amphitheatre|Amphitheater|Center|Centre|Arena|Theatre|Theater|Stadium|Field|Park|Hall|Ballpark)/i.test(p)
    );
    if (vSeg) venue = vSeg.replace(/^From \$\d+.*/i, "");
  }

  const line =
    `${clean(artist)}${venue ? " @ " + clean(venue) : ""}` +
    `${date ? " (" + clean(date) + ")" : ""}` +
    `${price ? `: Starting at ${price}` : ""}`;

  return {
    line: clean(line),
    priceNumber: price ? parseInt(price.replace(/\D/g, ""), 10) : null
  };
}
function compactList(items, max = 5) {
  const filtered = (items || []).filter((it) => !isIrrelevant(it)).slice(0, max);
  const normalized = filtered.map(normalizeCompact).filter(x => x.line);
  return normalized;
}
function lowestStartingPriceFromRaw(items) {
  let best = null;
  for (const it of items || []) {
    const m = (it.title + " " + it.snippet).match(/\$[ ]?(\d{2,4})/);
    if (m) {
      const val = parseInt(m[1], 10);
      if (!isNaN(val) && val >= 20) best = best == null ? val : Math.min(best, val);
    }
  }
  return best ? `$${best}` : null;
}
function buildSearchMessage(items) {
  const compact = compactList(items, 5);
  const lowest = lowestStartingPriceFromRaw(items);
  const bullets = compact.map(r => `• ${r.line}`).join("\n");

  const summary = lowest
    ? `Summary: Lowest starting price around ${lowest}.`
    : `Summary: Here are a few options.`;

  return `${summary}\n\n${bullets}\n\nWould you like me to open the request form?`;
}

// --- “Popular shows in Chicago” suggestion path ---
async function suggestChicago() {
  // Prefer the Vivid Explore page in Google results
  const items = await webSearch("popular shows Chicago", "Chicago IL", { preferTickets: true });
  return buildSearchMessage(items);
}

// ---------- OpenAI ----------
async function callOpenAI(messages) {
  const sysPrompt = `
You are FTE's intake assistant. You can (1) collect ticket request details and save them,
or (2) search the web for events/venues/dates when the user is still deciding.

When the user asks about events, what's on, dates, venues, availability, or prices,
you MUST call the web_search tool FIRST with a good query (include location if known).

Do NOT ask for personal or contact details in chat. If the user wants to proceed,
just confirm and the website will open a form to collect details.

Tools you may call:
- capture_ticket_request: when the user is ready to submit details.
- web_search: when the user asks for ideas, dates, venues, availability, or prices.

Keep replies short & friendly. Fields for capture:
  artist_or_event (string), ticket_qty (integer), name, email, phone,
  city_or_residence, budget, date_or_date_range, notes (1–2 sentences).
`;

  const body = {
    model: "gpt-4.1-mini",
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
            name: { type: "string" },
            email: { type: "string" },
            phone: { type: "string" },
            city_or_residence: { type: "string" },
            budget: { type: "string" },
            date_or_date_range: { type: "string" },
            notes: { type: "string" },
          },
          required: ["artist_or_event", "ticket_qty", "name", "email"],
        },
      },
      {
        type: "function",
        name: "web_search",
        description: "Search the web for events, venues, dates, ticket info.",
        parameters: {
          type: "object",
          properties: {
            q: { type: "string", description: "Search query" },
            location: { type: "string", description: "City/Region" },
          },
          required: ["q"],
        },
      },
    ],
    tool_choice: "auto",
  };

  const resp = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!resp.ok) throw new Error(await resp.text());
  return resp.json();
}

// ---------- Responses API helpers ----------
function digToolCalls(x) {
  if (!x) return [];
  if (Array.isArray(x)) return x.flatMap(digToolCalls);
  const out = [];
  if (x.type === "tool_call" && x.name) out.push(x);
  if (x.output) out.push(...digToolCalls(x.output));
  if (x.content) out.push(...digToolCalls(x.content));
  return out;
}
function toText(nodes) {
  if (!nodes) return "";
  if (typeof nodes === "string") return nodes;
  if (Array.isArray(nodes)) return nodes.map(toText).join("");
  if (typeof nodes === "object") {
    if (nodes.type === "output_text" || nodes.type === "text")
      return nodes.text || nodes.content || "";
    return [nodes.text, nodes.content, nodes.output].map(toText).join("");
  }
  return "";
}

// ---------- Tiny intent / confirmation helpers ----------
function looksLikeSearch(msg) {
  const q = (msg || "").toLowerCase();
  return /what.*(show|event)|show(s)?|event(s)?|happening|things to do|prices?|price|tickets?|concert|theater|theatre|sports|game|popular|upcoming|suggest|recommend/.test(q);
}
function looksLikePrice(msg) {
  return /(price|prices|cost|how much)/i.test(msg || "");
}
function wantsSuggestions(msg) {
  return /(suggest|recommend|popular|upcoming|what.*to do|what.*going on|ideas)/i.test(msg || "");
}
function mentionsChicago(msg) {
  return /(chicago|chi-town|chitown|windy city|tinley park|rosemont|wrigley|united center|soldier field)/i.test(msg || "");
}
function userConfirmedPurchase(text) {
  return /\b(yes|yeah|yep|sure|submit|buy|purchase|book|go ahead|let'?s do it|looks good)\b/i.test(text || "");
}

// ---------- Azure Function entry ----------
module.exports = async function (context, req) {
  context.res = {
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    },
  };

  if (req.method === "OPTIONS") {
    context.res.status = 204;
    return;
  }
  if (req.method !== "POST") {
    context.res.status = 405;
    context.res.body = { error: "Method not allowed" };
    return;
  }

  try {
    // --- Support direct form capture from Framer (your RequestForm) ---
    if (req.body?.direct_capture && req.body?.capture) {
      await appendToSheet(toRow(req.body.capture));
      context.res.status = 200;
      context.res.body = { message: "Saved your request. We’ll follow up soon!", captured: req.body.capture };
      return;
    }

    const messages = Array.isArray(req.body?.messages) ? req.body.messages : [];
    const lastUser =
      [...messages].reverse().find((m) => m.role === "user")?.content || "";

    // If user said "yes/submit/buy", instruct UI to open the form.
    if (userConfirmedPurchase(lastUser)) {
      context.res.status = 200;
      context.res.body = {
        message: "Great — opening the request form…",
        openForm: true, // <-- Framer only opens modal if this flag is present
      };
      return;
    }

    // Quick path: user asked for suggestions (esp. Chicago)
    if (wantsSuggestions(lastUser) && mentionsChicago(lastUser)) {
      const msg = await suggestChicago(); // formats bullets, no links
      context.res.status = 200;
      context.res.body = { message: msg, results: [] };
      return;
    }

    // First model pass
    const data = await callOpenAI(messages);
    const calls = digToolCalls(data);
    context.log("Tool calls detected:", JSON.stringify(calls));

    let captured = null;

    // If the model asked for any tools, run them and answer
    for (const c of calls) {
      const args =
        typeof c.arguments === "string" ? JSON.parse(c.arguments) : c.arguments;

      if (c.name === "capture_ticket_request") {
        captured = args;
        await appendToSheet(toRow(captured));
        context.res.status = 200;
        context.res.body = {
          message:
            "Thanks! I saved your request. We’ll follow up shortly to confirm details.",
          captured,
        };
        return;
      }

      if (c.name === "web_search") {
        const results = await webSearch(args.q, args.location, { preferTickets: true });
        const msg = buildSearchMessage(results); // summary + clean bullets (no links)
        context.res.status = 200;
        context.res.body = { message: msg, results };
        return;
      }
    }

    // Fallback: no tool calls but the user clearly asked for search/price/suggestions
    if (looksLikeSearch(lastUser)) {
      // If asking price-like, keep same query; bias to Vivid Seats
      const q = looksLikePrice(lastUser)
        ? `${lastUser} site:vividseats.com`
        : lastUser;
      const results = await webSearch(q, /*location*/ null, { preferTickets: true });
      const msg = buildSearchMessage(results); // summary + bullets (no links)
      context.res.status = 200;
      context.res.body = { message: msg, results, note: "fallback_search" };
      return;
    }

    // No tools and not a searchy message → plain assistant text
    const assistantText =
      toText(data?.output ?? data?.content ?? []) || "Got it!";
    context.res.status = 200;
    context.res.body = { message: assistantText, captured: null };
  } catch (e) {
    context.log.error(e);
    context.res.status = 500;
    context.res.body = { error: String(e) };
  }
};


// const { google } = require("googleapis");

// // ---------- Google Sheets ----------
// async function getSheetsClient() {
//   const creds = JSON.parse(process.env.GOOGLE_SHEETS_CREDENTIALS);
//   const auth = new google.auth.JWT(
//     creds.client_email,
//     null,
//     creds.private_key,
//     ["https://www.googleapis.com/auth/spreadsheets"]
//   );
//   await auth.authorize();
//   return google.sheets({ version: "v4", auth });
// }

// async function appendToSheet(row) {
//   const sheets = await getSheetsClient();
//   const spreadsheetId = process.env.GOOGLE_SHEETS_ID;
//   const range = process.env.GOOGLE_SHEETS_RANGE || "Sheet1!A:I";
//   await sheets.spreadsheets.values.append({
//     spreadsheetId,
//     range,
//     valueInputOption: "USER_ENTERED",
//     requestBody: { values: [row] }
//   });
// }

// function toRow(c) {
//   const timestamp = new Date().toLocaleString("en-US", { timeZone: "America/Chicago" }); // A
//   const artistOrEvent = c?.artist_or_event || "";                                         // B
//   const qty = Number.isFinite(c?.ticket_qty)
//     ? c.ticket_qty
//     : (parseInt(c?.ticket_qty || "", 10) || "");                                          // C
//   const name = c?.name || "";                                                             // D
//   const email = c?.email || "";                                                           // E
//   const phone = c?.phone || "";                                                           // F
//   const residence = c?.city_or_residence || c?.city || "";                                // G
//   const budget = c?.budget || "";                                                         // H
//   const notes = c?.notes || "";                                                           // I
//   return [timestamp, artistOrEvent, qty, name, email, phone, residence, budget, notes];
// }

// // ---------- OpenAI ----------
// async function callOpenAI(messages) {
//   const sysPrompt = `
// You are FTE's intake assistant. Collect ticket details and concise notes.

// Fields:
// - artist_or_event (string)
// - ticket_qty (integer)
// - name (string)
// - email (string)
// - phone (string)
// - city_or_residence (string)
// - budget (string)
// - date_or_date_range (string)
// - notes (string) // 1–2 short sentences with special requests, ADA, flexibility

// Ask minimal follow-ups. Confirm key details. Then call capture_ticket_request.
// Keep replies short and friendly.
// `;

//   const resp = await fetch("https://api.openai.com/v1/responses", {
//     method: "POST",
//     headers: {
//       Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
//       "Content-Type": "application/json"
//     },
//     body: JSON.stringify({
//       model: "gpt-4.1-mini",
//       input: [{ role: "system", content: sysPrompt }, ...messages],
//       tools: [
//         {
//           type: "function",
//           name: "capture_ticket_request",
//           description: "Finalize a ticket request and log to Google Sheets.",
//           parameters: {
//             type: "object",
//             properties: {
//               artist_or_event: { type: "string" },
//               ticket_qty: { type: "integer" },
//               name: { type: "string" },
//               email: { type: "string" },
//               phone: { type: "string" },
//               city_or_residence: { type: "string" },
//               budget: { type: "string" },
//               date_or_date_range: { type: "string" },
//               notes: { type: "string" }
//             },
//             required: ["artist_or_event", "ticket_qty", "name", "email"]
//           }
//         }
//       ],
//       tool_choice: "auto"
//     })
//   });

//   if (!resp.ok) throw new Error(await resp.text());
//   return resp.json();
// }

// // Helpers to parse OpenAI Responses API
// function digToolCalls(x) {
//   if (!x) return [];
//   if (Array.isArray(x)) return x.flatMap(digToolCalls);
//   const out = [];
//   if (x.type === "tool_call" && x.name === "capture_ticket_request") out.push(x);
//   if (x.output) out.push(...digToolCalls(x.output));
//   if (x.content) out.push(...digToolCalls(x.content));
//   return out;
// }

// function toText(nodes) {
//   if (!nodes) return "";
//   if (typeof nodes === "string") return nodes;
//   if (Array.isArray(nodes)) return nodes.map(toText).join("");
//   if (typeof nodes === "object") {
//     if (nodes.type === "output_text" || nodes.type === "text") return nodes.text || nodes.content || "";
//     return [nodes.text, nodes.content, nodes.output].map(toText).join("");
//   }
//   return "";
// }

// // ---------- Azure Function entry ----------
// module.exports = async function (context, req) {
//   context.res = {
//     headers: {
//       "Access-Control-Allow-Origin": "*",
//       "Access-Control-Allow-Methods": "POST, OPTIONS",
//       "Access-Control-Allow-Headers": "Content-Type"
//     }
//   };

//   if (req.method === "OPTIONS") {
//     context.res.status = 204;
//     return;
//   }
//   if (req.method !== "POST") {
//     context.res.status = 405;
//     context.res.body = { error: "Method not allowed" };
//     return;
//   }

//   try {
//     const messages = Array.isArray(req.body?.messages) ? req.body.messages : [];
//     const data = await callOpenAI(messages);

//     let captured = null;
//     const calls = digToolCalls(data);
//     if (calls.length) {
//       const args = calls[0].arguments || calls[0].args;
//       captured = typeof args === "string" ? JSON.parse(args) : args;
//       const row = toRow(captured);
//       await appendToSheet(row);
//     }

//     const assistantText = toText(data?.output ?? data?.content ?? []) || "Got it!";
//     context.res.status = 200;
//     context.res.body = { message: assistantText, captured };
//   } catch (e) {
//     context.log.error(e);
//     context.res.status = 500;
//     context.res.body = { error: String(e) };
//   }
// };
