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

function toRow(c) {
  const timestamp = new Date().toLocaleString("en-US", { timeZone: "America/Chicago" }); // A
  const artistOrEvent = c?.artist_or_event || "";                                        // B
  const qty = Number.isFinite(c?.ticket_qty) ? c.ticket_qty : parseInt(c?.ticket_qty || "", 10) || ""; // C
  const name = c?.name || "";                                                            // D
  const email = c?.email || "";                                                          // E
  const phone = c?.phone || "";                                                          // F
  const residence = c?.city_or_residence || c?.city || "";                               // G
  const budget = c?.budget || "";                                                        // H
  const notes = c?.notes || "";                                                          // I
  return [timestamp, artistOrEvent, qty, name, email, phone, residence, budget, notes];
}

/* =====================  Serper Search  ===================== */
async function webSearch(query, location, { preferTickets = true, max = 5 } = {}) {
  // Bias queries toward tickets sites (cleaner snippets with prices)
  const siteBias = preferTickets ? " (site:vividseats.com OR site:ticketmaster.com)" : "";
  const hasTicketsWord = /\bticket(s)?\b/i.test(query);
  const qFinal = query + (hasTicketsWord ? "" : " tickets") + (location ? ` ${location}` : "") + siteBias;

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

/* =====================  Price / Formatting helpers  ===================== */
const PRICE_RE = /\$[ ]?(\d{2,4})(?:\s*-\s*\$?\d{2,4})?/gi;
const DATE_RE  = /\b(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)?\s*(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\.?[a-z]*\s*\d{1,2}(?:,\s*\d{4})?(?:\s*•?\s*\d{1,2}:\d{2}\s*(?:AM|PM))?/i;

const isParking = (s) => /parking/i.test(s || "");
const irrelevant = (t, s) => /parking|hotel|restaurant|faq|blog/i.test(`${t} ${s}`);

function firstPrice(text) {
  if (!text) return null;
  let m; PRICE_RE.lastIndex = 0;
  while ((m = PRICE_RE.exec(text))) {
    const val = parseInt(m[1], 10);
    if (!isNaN(val) && val >= 30) return val; // ignore super-low noise
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

/** Try to grab the first non-parking Vivid Seats price for (artist, city). */
async function vividStartingPrice(artist, city) {
  const q = `${artist} ${city ? city + " " : ""}tickets site:vividseats.com`;
  const items = await webSearch(q, null, { preferTickets: true, max: 5 });
  const vividOnly = items.filter(it => /vividseats\.com/i.test(it.link) && !isParking(it.link) && !irrelevant(it.title, it.snippet));
  const first = vividOnly[0];
  if (!first) return null;
  const p = firstPrice(`${first.title} ${first.snippet}`);
  return p != null ? p : null;
}

/** Build the short message (summary only, no bullets). */
function priceSummaryMessage(priceNum) {
  if (priceNum != null) {
    return `Summary: Lowest starting price around $${priceNum}.` + `\n\nWould you like me to open the request form?`;
  }
  return `Summary: I couldn’t confirm a current starting price just yet.` + `\n\nWould you like me to open the request form?`;
}

/* =====================  OpenAI  ===================== */
async function callOpenAI(messages) {
  const sysPrompt = `
You are FTE’s intake assistant for tickets. Your goals:
1) If the user is deciding or asks about shows, prices, availability, dates or venues → SEARCH first (use the web_search tool).
2) If the user wants to proceed → confirm and the website will open a form to collect contact details. Do NOT collect personal info in chat.
3) Keep replies short, friendly, and proactive. Ask only the next missing detail to complete a request.

Dialog policy (enforced):
- If event/artist missing → ask: “Which artist or event (and city)?”
- If artist present and qty missing → ask: “How many tickets?”
- If qty present and city/date missing → ask for city and rough date (“when/where?”).
- If those present and budget missing → ask: “What’s your rough budget per ticket?”
- If user confirms proceed → say you’ll open the form (the UI handles it).
- For price questions → search; return just a concise summary of the lowest starting price you can find.
- Never ask for name/email/phone in chat. Those go into the form only.

Fields when we finally capture:
artist_or_event (string), ticket_qty (integer), city_or_residence (string),
date_or_date_range (string), budget (string), notes (string).
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
            city_or_residence: { type: "string" },
            date_or_date_range: { type: "string" },
            budget: { type: "string" },
            notes: { type: "string" }
          },
          required: ["artist_or_event", "ticket_qty"]
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

/** Extracts assistant reply from Responses API safely. */
function toAssistantText(obj) {
  // Common places the text can live:
  const tryList = [
    obj?.output_text,               // new field sometimes present
    obj?.text,                      // root text
    obj?.content,                   // may be array or string
    obj?.output                     // nested nodes
  ];

  const flatten = (node) => {
    if (!node) return "";
    if (typeof node === "string") return node;
    if (Array.isArray(node)) return node.map(flatten).join("");
    if (typeof node === "object") {
      return [node.text, node.content, node.output].map(flatten).join("");
    }
    return "";
  };

  for (const cand of tryList) {
    const s = flatten(cand).trim();
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
function userConfirmedPurchase(text) { return /\b(yes|yeah|yep|sure|submit|buy|purchase|book|go ahead|let'?s do it|looks good)\b/i.test(text || ""); }

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
    // Direct form capture from Framer RequestForm
    if (req.body?.direct_capture && req.body?.capture) {
      await appendToSheet(toRow(req.body.capture));
      context.res.status = 200;
      context.res.body = { message: "Saved your request. We’ll follow up soon!", captured: req.body.capture };
      return;
    }

    const messages = Array.isArray(req.body?.messages) ? req.body.messages : [];
    const lastUser = [...messages].reverse().find((m) => m.role === "user")?.content || "";

    // Explicit “yes/submit/buy” → instruct UI to open the form
    if (userConfirmedPurchase(lastUser)) {
      context.res.status = 200;
      context.res.body = { message: "Great — opening the request form…", openForm: true };
      return;
    }

    // Quick path: “suggestions in Chicago”
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

    let captured = null;

    // Run any tool calls the model asked for
    for (const c of calls) {
      const args = typeof c.arguments === "string" ? JSON.parse(c.arguments) : c.arguments;

      if (c.name === "capture_ticket_request") {
        captured = args;
        await appendToSheet(toRow(captured));
        context.res.status = 200;
        context.res.body = { message: "Thanks! I saved your request. We’ll follow up shortly to confirm details.", captured };
        return;
      }

      if (c.name === "web_search") {
        // If it looks like a price query, attempt a vivid-first price
        let bestNum = null;
        if (looksLikePrice(args.q)) {
          // Try to infer artist & city from the query text (simple heuristic)
          const artist = args.q.replace(/(price|prices|ticket|tickets|how much)/gi, "").trim();
          const cityMatch = args.location || (artist.match(/\b(chicago|tinley park|rosemont|detroit|milwaukee|madison|indianapolis)\b/i) || [])[0];
          bestNum = await vividStartingPrice(artist, cityMatch || "");
        }
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
      // Price-leaning fallback: bias to Vivid Seats
      let bestNum = null;
      if (looksLikePrice(lastUser)) {
        bestNum = await vividStartingPrice(lastUser, "");
      }
      if (bestNum == null) {
        const results = await webSearch(lastUser, null, { preferTickets: true });
        bestNum = minPriceAcross(results);
      }
      const msg = priceSummaryMessage(bestNum);
      context.res.status = 200;
      context.res.body = { message: msg, note: "fallback_search" };
      return;
    }

    // No tool calls and not a search → return assistant text (never empty)
    let assistantText = toAssistantText(data);
    if (!assistantText) {
      // Helpful follow-up instead of “Got it!”
      assistantText = "Got it. How many tickets are you looking for, and what’s your rough budget per ticket?";
    }
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
