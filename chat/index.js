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

// ---------- Serper Web Search (ticket-site bias option) ----------
async function webSearch(query, location, { preferTickets = true } = {}) {
  const siteBias = preferTickets
    ? " (site:vividseats.com OR site:ticketmaster.com OR site:seatgeek.com OR site:stubhub.com OR site:axs.com OR site:livenation.com)"
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
    body: JSON.stringify({ q: qFinal, num: 8 }),
  });
  if (!resp.ok) throw new Error(await resp.text());
  const data = await resp.json();

  const items = (data.organic || []).map((r, i) => ({
    n: i + 1,
    title: r.title || "",
    link: r.link || "",
    snippet: r.snippet || "",
  }));
  return items;
}

/* ============================================================
   SMART PRICE EXTRACTION (trust-weighted & “starting at” first)
   ============================================================ */

const TRUST = {
  "vividseats.com": 3,
  "ticketmaster.com": 3,
  "seatgeek.com": 2.5,
  "stubhub.com": 2.5,
  "axs.com": 2.5,
  "livenation.com": 2.5,
};

const BAD_PHRASES = /(parking|average historical price|cheapest day|vip packages?)/i;

function getDomain(url) {
  try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return ""; }
}

// prefer “From/Starting at $X”; fall back to bare $X; trust-weight results
function extractPriceCandidates(items, focusText = "") {
  const want = (focusText || "").toLowerCase();
  const mustWords = want.split(/[^a-z0-9]+/i).filter(w => w.length > 2);

  const reStrong = /(from|starting at)\s*\$([0-9]{2,4})/i;
  const reAnyDollar = /\$\s*([0-9]{2,4})/g;

  const out = [];
  for (const r of items || []) {
    const dom = getDomain(r.link);
    const hay = `${r.title} ${r.snippet}`;

    if (BAD_PHRASES.test(hay)) continue;

    const okWords = mustWords.length ? mustWords.every(w => hay.toLowerCase().includes(w)) : true;
    if (!okWords) continue;

    const strong = hay.match(reStrong);
    if (strong) {
      const val = parseInt(strong[2], 10);
      if (!isNaN(val) && val >= 20) out.push({ price: val, dom, strict: true, r });
      continue;
    }
    let m;
    while ((m = reAnyDollar.exec(hay))) {
      const val = parseInt(m[1], 10);
      if (!isNaN(val) && val >= 20) out.push({ price: val, dom, strict: false, r });
    }
  }

  for (const c of out) {
    c.score = (TRUST[c.dom] || 1) * (c.strict ? 2 : 1) * (1 / (c.price || 1));
  }
  out.sort((a, b) => b.score - a.score);
  return out;
}

async function smartWebPriceSearch(userQ) {
  const baseQ = (userQ || "").replace(/\b(prices?|cost|how much|starting at)\b/ig, "").trim();

  // Try trusted sites first
  const siteBatches = [
    "site:vividseats.com",
    "site:ticketmaster.com",
    "site:seatgeek.com OR site:stubhub.com",
    "site:axs.com OR site:livenation.com",
  ];

  for (const sites of siteBatches) {
    const q = `${baseQ} tickets ${sites}`;
    const items = await webSearch(q, null, { preferTickets: false });
    const candidates = extractPriceCandidates(items, baseQ);
    if (candidates.length) return { items, candidates };
  }

  // Fallback: general
  const items = await webSearch(baseQ, null, { preferTickets: true });
  const candidates = extractPriceCandidates(items, baseQ);
  return { items, candidates };
}

// summary-only response (no bullets/links)
function buildSummaryMessage(lowestPriceText) {
  const summary = lowestPriceText
    ? `Summary: Lowest starting price around ${lowestPriceText}.`
    : `Summary: I couldn’t confirm a current starting price just yet.`;
  return `${summary}\n\nWould you like me to open the request form?`;
}

/* -------------------------------------------
   Chicago suggestions (bias to Explore page)
   ------------------------------------------- */
async function suggestChicago() {
  // Heavily bias to Vivid’s Explore Chicago page
  const items = await webSearch(
    "popular shows Chicago site:vividseats.com/explore?location=chicago%2C+il",
    "Chicago IL",
    { preferTickets: true }
  );
  // We still reply with a summary (you asked to avoid bullets/links)
  // If you want a list later, we can add a separate formatter.
  const { candidates } = await smartWebPriceSearch("Chicago concerts");
  const lowest = candidates.length ? `$${candidates[0].price}` : null;
  return buildSummaryMessage(lowest);
}

/* -----------------
     OpenAI call
   ----------------- */
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

/* -----------------------------
   Responses API small helpers
   ----------------------------- */
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

/* --------------------------------------------
   Tiny intent / confirmation helpers (same)
   -------------------------------------------- */
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

/* ----------------------------
      Azure Function entry
   ---------------------------- */
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
    // Support direct form capture from Framer (RequestForm)
    if (req.body?.direct_capture && req.body?.capture) {
      await appendToSheet(toRow(req.body.capture));
      context.res.status = 200;
      context.res.body = { message: "Saved your request. We’ll follow up soon!", captured: req.body.capture };
      return;
    }

    const messages = Array.isArray(req.body?.messages) ? req.body.messages : [];
    const lastUser =
      [...messages].reverse().find((m) => m.role === "user")?.content || "";

    // User confirmed purchase → open form in UI
    if (userConfirmedPurchase(lastUser)) {
      context.res.status = 200;
      context.res.body = {
        message: "Great — opening the request form…",
        openForm: true,
      };
      return;
    }

    // Quick path: suggestions in Chicago
    if (wantsSuggestions(lastUser) && mentionsChicago(lastUser)) {
      const msg = await suggestChicago(); // summary-only
      context.res.status = 200;
      context.res.body = { message: msg, results: [] };
      return;
    }

    // First model pass
    const data = await callOpenAI(messages);
    const calls = digToolCalls(data);
    context.log("Tool calls detected:", JSON.stringify(calls));

    let captured = null;

    // Tool handling
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
        const q = (args?.q || "").trim();
        const { candidates } = await smartWebPriceSearch(q);
        const lowest = candidates.length ? `$${candidates[0].price}` : null;

        context.res.status = 200;
        context.res.body = { message: buildSummaryMessage(lowest) };
        return;
      }
    }

    // Fallback: no tool calls but looks like search/price → do our own
    if (looksLikeSearch(lastUser)) {
      const { candidates } = await smartWebPriceSearch(lastUser);
      const lowest = candidates.length ? `$${candidates[0].price}` : null;

      context.res.status = 200;
      context.res.body = { message: buildSummaryMessage(lowest), note: "fallback_search" };
      return;
    }

    // Plain assistant text
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
