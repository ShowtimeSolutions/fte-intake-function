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
 * Finalized row that BOTH the chat flow and the manual form write to.
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

/* =====================  Price / Formatting helpers  ===================== */
const PRICE_RE = /\$[ ]?(\d{2,4})(?:\s*-\s*\$?\d{2,4})?/gi;
const IRRELEVANT = (t, s) => /parking|hotel|restaurant|faq|blog/i.test(`${t} ${s}`);

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
  const vividOnly = items.filter(it => /vividseats\.com/i.test(it.link) && !IRRELEVANT(it.title, it.snippet));
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

/* =====================  OpenAI  ===================== */
function baseSystemPrompt() {
  return `
You are FTE’s intake assistant on a public website. Your job is to help the user get tickets in a friendly, efficient way.

Conversation policy:
- Start with a short, cheerful greeting.
- Ask ONE short question at a time for missing fields.
- If the user is browsing/undecided, you may search for events or provide starting prices when asked.
- Keep replies concise; plain language.
- When you have enough to create a ticket request, provide a one-sentence summary and ask for a quick **yes** to confirm.
- AFTER the user confirms, you MUST call the "capture_ticket_request" tool with the collected fields.
- ONLY open the manual form if the user explicitly asks you to open the form; otherwise finalize via "capture_ticket_request".
- Do not ask for City/Residence.

Fields to capture (for capture_ticket_request):
- artist_or_event (string, required)
- ticket_qty (integer, required)
- budget_tier (string, one of: "<$50","$50–$99","$100–$149","$150–$199","$200–$249","$250–$299","$300–$349","$350–$399","$400–$499","$500+")
- date_or_date_range (string, optional)
- name (string, required)
- email (string, required)
- phone (string, optional)
- notes (string, optional, 1–2 short sentences)

When the user asks about prices or “what’s on”, you may call "web_search" first and reply with a short summary (e.g., “Lowest starting price around $X”). Avoid bullets/links unless the user asks.

---

FEW-SHOT DIALOG EXAMPLES (style & flow)

[Example 1 — collect then capture]
User: "I want Jonas Brothers tickets"
Assistant: "Great choice! How many tickets do you need?"
User: "4"
Assistant: "What budget range per ticket? (e.g. $50–$99, $100–$149)"
User: "$100–$149"
Assistant: "Any preferred date or date range?"
User: "Aug 26"
Assistant: "Got it. What's the name and email to place the request?"
User: "Nick — nick@example.com"
Assistant: "Thanks! Summary: 4 Jonas Brothers tickets on Aug 26, budget $100–$149, under Nick (nick@example.com). Is that correct?"
User: "Yes"
Assistant: [CALL capture_ticket_request with the fields]

[Example 2 — price lookup then proceed]
User: "How much are Jonas Brothers tickets in Tinley Park?"
Assistant: [CALL web_search]
Assistant: "Summary: Lowest starting price around $38. Want to proceed with a request?"
User: "Yes"
Assistant: "How many tickets do you need?"
(continue asking one missing field at a time, then call capture_ticket_request)
`;
}

async function callOpenAI(messages) {
  const body = {
    model: "gpt-4.1-mini",
    temperature: 0.2,
    input: [{ role: "system", content: baseSystemPrompt() }, ...messages],
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

/** Force-finalization pass: after user says “yes”, compel the model to call capture_ticket_request. */
async function callOpenAIFinalize(messages) {
  const finalizeSystem = `
You must now finalize the ticket request based on the conversation so far.
- If all required fields are present (artist_or_event, ticket_qty, budget_tier, name, email), CALL "capture_ticket_request".
- If exactly one required field is missing, ask ONE short question for that field and stop.
- Do NOT re-start the conversation; do NOT ask for fields already provided.
- Do NOT open the manual form. Use capture_ticket_request.
`;
  const body = {
    model: "gpt-4.1-mini",
    temperature: 0.1,
    input: [{ role: "system", content: finalizeSystem }, ...messages],
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

/* =====================  Intent / Guard helpers  ===================== */
function looksLikeSearch(msg) {
  const q = (msg || "").toLowerCase();
  return /what.*(show|event)|show(s)?|event(s)?|happening|things to do|prices?|price|tickets?|concert|theater|theatre|sports|game|popular|upcoming|suggest|recommend/.test(q);
}
function looksLikePrice(msg) { return /(price|prices|cost|how much)/i.test(msg || ""); }
function wantsSuggestions(msg) { return /(suggest|recommend|popular|upcoming|what.*to do|what.*going on|ideas)/i.test(msg || ""); }
function mentionsChicago(msg) { return /(chicago|chi-town|chitown|tinley park|rosemont|wrigley|united center|soldier field)/i.test(msg || ""); }
function userConfirmedPurchase(text) { return /\b(yes|yeah|yep|sure|correct|that'?s right|looks good)\b/i.test(text || ""); }

/** Did the previous assistant message look like a summary + confirmation prompt? */
function assistantAskedToConfirm(msg) {
  const s = (msg || "").toLowerCase();
  return /summary|is that correct\??|does that look right\??|shall i proceed\??|confirm/i.test(s);
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
    // Direct manual form capture
    if (req.body?.direct_capture && req.body?.capture) {
      await appendToSheet(toRow(req.body.capture));
      context.res.status = 200;
      context.res.body = { message: "Saved your request. We’ll follow up soon!", captured: req.body.capture };
      return;
    }

    const messages = Array.isArray(req.body?.messages) ? req.body.messages : [];
    const lastUser = [...messages].reverse().find((m) => m.role === "user")?.content || "";
    const prevAssistant = [...messages].reverse().find((m) => m.role === "assistant")?.content || "";

    // If the user explicitly asks to open the form
    if (/\b(open|show|fill|use)\b.*\b(form|request form)\b/i.test(lastUser)) {
      context.res.status = 200;
      context.res.body = { message: "Opening the request form…", openForm: true };
      return;
    }

    // If the previous assistant asked for confirmation and the user said YES,
    // run a force-finalization pass that MUST call capture_ticket_request.
    if (assistantAskedToConfirm(prevAssistant) && userConfirmedPurchase(lastUser)) {
      const forced = await callOpenAIFinalize(messages);
      const calls = digToolCalls(forced);

      if (calls.length) {
        for (const c of calls) {
          const args = typeof c.arguments === "string" ? JSON.parse(c.arguments) : c.arguments;
          if (c.name === "capture_ticket_request") {
            await appendToSheet(toRow(args));
            context.res.status = 200;
            context.res.body = {
              message: "Thanks! I saved your request. We’ll follow up shortly to confirm details.",
              captured: args
            };
            return;
          }
        }
      }

      // If the model still didn’t call the tool, reply with the assistant text (likely one missing field)
      const forcedText = toAssistantText(forced) || "Almost there—what’s the last missing detail?";
      context.res.status = 200;
      context.res.body = { message: forcedText };
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

    // Normal model pass
    const data = await callOpenAI(messages);
    const calls = digToolCalls(data);
    context.log("Tool calls:", JSON.stringify(calls));

    // Run any tool calls the model asked for
    for (const c of calls) {
      const args = typeof c.arguments === "string" ? JSON.parse(c.arguments) : c.arguments;

      if (c.name === "capture_ticket_request") {
        await appendToSheet(toRow(args));
        context.res.status = 200;
        context.res.body = { message: "Thanks! I saved your request. We’ll follow up shortly to confirm details.", captured: args };
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
      assistantText = "Got it. Which artist or event are you looking for, and how many tickets do you need?";
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
