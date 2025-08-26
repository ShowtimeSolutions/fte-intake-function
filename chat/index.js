// index.js — Azure Function (Node 18+)
// ------------------------------------
const { google } = require("googleapis");
const fetch = require("node-fetch");

/* =====================  Google Sheets  ===================== */
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

/**
 * Finalized row (shared by chat + manual form)
 * Columns (A..I):
 *  A Timestamp
 *  B Artist_or_event
 *  C Ticket_qty
 *  D Budget_tier
 *  E Date_or_date_range
 *  F Name
 *  G Email
 *  H Phone
 *  I Notes
 */
function toRow(c) {
  const ts = new Date().toLocaleString("en-US", { timeZone: "America/Chicago" }); // A
  const artist = c?.artist_or_event || "";                                        // B
  const qty = Number.isFinite(c?.ticket_qty)
    ? c.ticket_qty
    : (parseInt(c?.ticket_qty || "", 10) || "");                                  // C
  const budgetTier = c?.budget_tier || c?.budget || "";                           // D
  const dateRange = c?.date_or_date_range || "";                                  // E
  const name = c?.name || "";                                                     // F
  const email = c?.email || "";                                                   // G
  const phone = c?.phone || "";                                                   // H
  const notes = c?.notes || "";                                                   // I
  return [ts, artist, qty, budgetTier, dateRange, name, email, phone, notes];
}

/* =====================  Serper Search  ===================== */
async function webSearch(query, location, { preferTickets = true, max = 5 } = {}) {
  const siteBias = preferTickets ? " (site:vividseats.com OR site:ticketmaster.com)" : "";
  const hasTicketsWord = /\bticket(s)?\b/i.test(query);
  const qFinal =
    query + (hasTicketsWord ? "" : " tickets") + (location ? ` ${location}` : "") + siteBias;

  const resp = await fetch("https://google.serper.dev/search", {
    method: "POST",
    headers: { "X-API-KEY": process.env.SERPER_API_KEY, "Content-Type": "application/json" },
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

/* =====================  Price helpers  ===================== */
const PRICE_RE = /\$[ ]?(\d{2,4})(?:\s*-\s*\$?\d{2,4})?/gi;
const irrelevant = (t, s) => /parking|hotel|restaurant|faq|blog/i.test(`${t} ${s}`);

function firstPrice(text) {
  if (!text) return null;
  let m; PRICE_RE.lastIndex = 0;
  while ((m = PRICE_RE.exec(text))) {
    const val = parseInt(m[1], 10);
    if (!isNaN(val) && val >= 30) return val;
  }
  return null;
}
function minPriceAcross(items) {
  let best = null;
  for (const it of items || []) {
    const val = firstPrice(`${it.title} ${it.snippet}`);
    if (val != null) best = best == null ? val : Math.min(best, val);
  }
  return best;
}

async function vividStartingPrice(q) {
  const items = await webSearch(`${q} tickets site:vividseats.com`, null, { preferTickets: true, max: 5 });
  const vividOnly = items.filter(it => /vividseats\.com/i.test(it.link) && !irrelevant(it.title, it.snippet));
  const first = vividOnly[0];
  if (!first) return null;
  const p = firstPrice(`${first.title} ${first.snippet}`);
  return p != null ? p : null;
}

function priceSummaryMessage(priceNum) {
  if (priceNum != null) {
    return `Summary: Lowest starting price around $${priceNum}.` + `\n\nWould you like me to open the request form?`;
  }
  return `Summary: I couldn’t confirm a current starting price just yet.` + `\n\nWould you like me to open the request form?`;
}

/* =====================  Budget helpers  ===================== */
const BUDGET_ENUM = [
  "<$50","$50–$99","$100–$149","$150–$199",
  "$200–$249","$250–$299","$300–$349","$350–$399",
  "$400–$499","$500+"
];
function mapBudgetToTier(text) {
  if (!text) return "";
  const t = String(text).toLowerCase();

  // Direct range mention
  for (const tier of BUDGET_ENUM) {
    const plain = tier.replace("–", "-");
    const re = new RegExp(plain.replace("$","\\$").replace("+","\\+"), "i");
    if (re.test(t)) return tier;
  }

  // "around 100", "~120", "about $140"
  const m = t.match(/\$?\s?(\d{2,4})/);
  if (m) {
    const n = parseInt(m[1], 10);
    if (!isNaN(n)) {
      if (n < 50) return "<$50";
      if (n < 100) return "$50–$99";
      if (n < 150) return "$100–$149";
      if (n < 200) return "$150–$199";
      if (n < 250) return "$200–$249";
      if (n < 300) return "$250–$299";
      if (n < 350) return "$300–$349";
      if (n < 400) return "$350–$399";
      if (n < 500) return "$400–$499";
      return "$500+";
    }
  }
  return "";
}

/* =====================  OpenAI  ===================== */
async function callOpenAI(messages) {
  const sysPrompt = `
You are FTE’s intake assistant on a public website.

**Critical rule:** When all required fields are present, DO NOT stall or say “almost there”.
Immediately call the tool \`capture_ticket_request\` with the fields. Be decisive.

Conversation policy:
- Start friendly and keep replies short.
- Ask one missing detail at a time (artist/event, qty, budget tier, date, name, email; phone/notes optional).
- Accept combined answers like "Nick Lynch, nick@example.com".
- If asked about prices/what’s on, you may call \`web_search\` and reply with a brief summary (no links).
- Never ask for City/Residence.

Fields to capture:
- artist_or_event (string, required)
- ticket_qty (integer, required)
- budget_tier (string, one of: "<$50","$50–$99","$100–$149","$150–$199","$200–$249","$250–$299","$300–$349","$350–$399","$400–$499","$500+")
- date_or_date_range (string, optional)
- name (string, required)
- email (string, required)
- phone (string, optional)
- notes (string, optional, 1–2 short sentences)
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
            budget_tier: { type: "string", enum: BUDGET_ENUM },
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
            q: { type: "string", description: "Search query (include artist/venue and 'tickets' when relevant)" },
            location: { type: "string", description: "City/Region (optional)" }
          },
          required: ["q"]
        }
      }
    ],
    tool_choice: "auto"
  };

  const resp = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });

  if (!resp.ok) throw new Error(await resp.text());
  return resp.json();
}

/* =====================  Responses helpers  ===================== */
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

/* =====================  Intent helpers  ===================== */
function looksLikeSearch(msg) {
  const q = (msg || "").toLowerCase();
  return /what.*(show|event)|show(s)?|event(s)?|happening|things to do|prices?|price|tickets?|concert|theater|theatre|sports|game|popular|upcoming|suggest|recommend/.test(q);
}
function looksLikePrice(msg) { return /(price|prices|cost|how much)/i.test(msg || ""); }
function wantsSuggestions(msg) { return /(suggest|recommend|popular|upcoming|what.*to do|what.*going on|ideas)/i.test(msg || ""); }
function mentionsChicago(msg) { return /(chicago|chi-town|chitown|tinley park|rosemont|wrigley|united center|soldier field)/i.test(msg || ""); }
function userConfirmedPurchase(text) { return /\b(yes|yeah|yep|sure|submit|buy|purchase|book|go ahead|let'?s do it|looks good|confirm)\b/i.test(text || ""); }

/* =====================  Force-save helpers  ===================== */
/** Find the most recent assistant "Summary:" message */
function getLatestSummary(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === "assistant" && /summary:/i.test(m.content || "")) {
      return m.content;
    }
  }
  return "";
}

/** Extract fields from our summary sentence formats */
function parseFromSummary(text) {
  if (!text) return null;

  // Example:
  // "Summary: 4 Jonas Brothers tickets for today, budget $100–$149, under Nick Lynch (nick@example.com). Is that correct?"
  const out = {};

  // qty + artist
  const m1 = text.match(/summary:\s*(\d+)\s+(.+?)\s+tickets/i);
  if (m1) {
    out.ticket_qty = parseInt(m1[1], 10);
    out.artist_or_event = m1[2].trim();
  }

  // date (optional) — look after "for ..."
  const m2 = text.match(/\btickets\s+for\s+([^,\.]+)/i);
  if (m2) out.date_or_date_range = m2[1].trim();

  // budget tier
  const m3 = text.match(/\bbudget\s+([$\d–\-+<> ]+)/i);
  if (m3) out.budget_tier = mapBudgetToTier(m3[1]);

  // name & email
  const m4 = text.match(/\bunder\s+([^(\.]+)\s*\(([^)]+)\)/i);
  if (m4) {
    out.name = m4[1].trim();
    out.email = m4[2].trim();
  } else {
    // sometimes name/email may be phrased differently
    const email = (text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i) || [])[0];
    if (email) out.email = email;
  }

  // If we got the required fields return it, else null
  if (out.artist_or_event && Number.isFinite(out.ticket_qty) && out.budget_tier && out.name && out.email) {
    return out;
  }
  return null;
}

/** Light scan of the whole transcript to enrich missing optional fields */
function enrichOptionalFromTranscript(obj, messages) {
  const transcript = messages.map(m => m.content || "").join("\n");
  if (!obj.email) {
    const e = (transcript.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i) || [])[0];
    if (e) obj.email = e;
  }
  if (!obj.phone) {
    const p = (transcript.match(/\b(\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b/) || [])[0];
    if (p) obj.phone = p;
  }
  if (!obj.notes) {
    const lower = transcript.toLowerCase();
    if (/aisle/.test(lower)) obj.notes = "Aisle seats";
    else if (/wheelchair|ada/.test(lower)) obj.notes = "ADA/wheelchair";
  }
  return obj;
}

/** Try to force-save a captured request based on YES + latest summary */
async function maybeForceSaveOnYes(messages, context) {
  const lastUser = [...messages].reverse().find(m => m.role === "user")?.content || "";
  if (!userConfirmedPurchase(lastUser)) return null;

  const summary = getLatestSummary(messages);
  if (!summary) return null;

  let captured = parseFromSummary(summary);
  if (!captured) return null;

  captured = enrichOptionalFromTranscript(captured, messages);

  await appendToSheet(toRow(captured));
  context.res.status = 200;
  context.res.body = {
    message: "✅ Your request has been placed! We’ll follow up shortly.",
    captured
  };
  return captured;
}

/* =====================  Azure Function entry  ===================== */
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
    // Manual form capture (Framer modal)
    if (req.body?.direct_capture && req.body?.capture) {
      await appendToSheet(toRow(req.body.capture));
      context.res.status = 200;
      context.res.body = { message: "Saved your request. We’ll follow up soon!", captured: req.body.capture };
      return;
    }

    const messages = Array.isArray(req.body?.messages) ? req.body.messages : [];
    const lastUser = [...messages].reverse().find((m) => m.role === "user")?.content || "";

    // NEW: If user said "yes" after a Summary → force-save now (backend guarantee)
    const forced = await maybeForceSaveOnYes(messages, context);
    if (forced) return;

    // Suggestions (Chicago)
    if (wantsSuggestions(lastUser) && mentionsChicago(lastUser)) {
      const items = await webSearch("popular shows Chicago", "Chicago IL", { preferTickets: true, max: 5 });
      const best = minPriceAcross(items);
      const msg = priceSummaryMessage(best);
      context.res.status = 200;
      context.res.body = { message: msg, results: [] };
      return;
    }

    // Model pass
    const data = await callOpenAI(messages);
    const calls = digToolCalls(data);
    context.log("Tool calls:", JSON.stringify(calls));

    // Execute any tool calls requested by the model
    for (const c of calls) {
      const args = typeof c.arguments === "string" ? JSON.parse(c.arguments) : c.arguments;

      if (c.name === "capture_ticket_request") {
        await appendToSheet(toRow(args));
        context.res.status = 200;
        context.res.body = { message: "✅ Your request has been placed! We’ll follow up shortly.", captured: args };
        return;
      }

      if (c.name === "web_search") {
        let bestNum = null;
        if (looksLikePrice(args.q)) bestNum = await vividStartingPrice(args.q);
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

    // Fallback: user asked a search/price question but model didn’t call tools
    if (looksLikeSearch(lastUser)) {
      let bestNum = null;
      if (looksLikePrice(lastUser)) bestNum = await vividStartingPrice(lastUser);





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
