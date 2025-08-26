// index.js — Azure Function (Node 18+)
// -----------------------------------
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
  });
  const artistOrEvent = c?.artist_or_event || "";
  const qty = Number.isFinite(c?.ticket_qty)
    ? c.ticket_qty
    : parseInt(c?.ticket_qty || "", 10) || "";
  const name = c?.name || "";
  const email = c?.email || "";
  const phone = c?.phone || "";
  const residence = c?.city_or_residence || c?.city || "";
  const budget = c?.budget || "";
  const notes = c?.notes || "";
  return [timestamp, artistOrEvent, qty, name, email, phone, residence, budget, notes];
}

// ---------- Serper Web Search ----------
async function webSearch(query, location) {
  const resp = await fetch("https://google.serper.dev/search", {
    method: "POST",
    headers: {
      "X-API-KEY": process.env.SERPER_API_KEY,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      q: query + (location ? ` ${location}` : ""),
      num: 5,
    }),
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

function formatSearchResults(items) {
  if (!items?.length) return "I didn’t find anything useful yet.";
  const lines = items.map(
    (r) => `• ${r.title}\n  ${r.snippet}\n  ${r.link}`
  );
  return `Here are a few options I found:\n\n${lines.join("\n\n")}`;
}

// --- Price helper: pull a plausible $ amount from snippets/titles ---
function guessPriceFromResults(items) {
  const priceRE = /\$[ ]?(\d{2,4})(?:\s*-\s*\$?\d{2,4})?/g; // $150 or $150 - $300
  let best = null;

  for (const r of items || []) {
    const hay = `${r.title} ${r.snippet}`;
    let m;
    while ((m = priceRE.exec(hay))) {
      const val = parseInt(m[1], 10);
      if (!isNaN(val) && val >= 20) {
        if (!best || val < best) best = val; // take the lowest reasonable price
      }
    }
  }
  return best ? `$${best.toString()}` : null;
}

// ---------- OpenAI ----------
async function callOpenAI(messages) {
  const sysPrompt = `
You are FTE's intake assistant. You can (1) collect ticket request details and save them,
or (2) search the web for events/venues/dates when the user is still deciding.

When the user asks about events, shows, what's on, dates, venues, availability, or prices,
you MUST call the web_search tool FIRST with a good query (include location if known).

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

// ---------- Helpers for Responses API ----------
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

// Small intent heuristic for fallback
function looksLikeSearch(msg) {
  const q = (msg || "").toLowerCase();
  return /what.*(show|event)|show(s)?|event(s)?|happening|things to do|prices?|price|tickets?|concert|theater|sports|game/.test(
    q
  );
}
function looksLikePrice(msg) {
  return /(price|prices|cost|how much)/i.test(msg || "");
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
    const messages = Array.isArray(req.body?.messages) ? req.body.messages : [];
    const lastUser = [...messages].reverse().find((m) => m.role === "user")?.content || "";

    // First model pass
    const data = await callOpenAI(messages);
    const calls = digToolCalls(data);
    context.log("Tool calls detected:", JSON.stringify(calls));

    let captured = null;

    // If model asked for any tools, run them and answer
    for (const c of calls) {
      const args = typeof c.arguments === "string" ? JSON.parse(c.arguments) : c.arguments;

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
        const results = await webSearch(args.q, args.location);
        // Price hint (nice-to-have)
        const price = looksLikePrice(args.q) ? guessPriceFromResults(results) : null;
        const msg =
          price
            ? `${formatSearchResults(results)}\n\nRough current price I’m seeing: **${price}** (varies by seat/date). Want to submit a request?`
            : formatSearchResults(results);
        context.res.status = 200;
        context.res.body = { message: msg, results };
        return;
      }
    }

    // ---- Fallback: no tool calls, but looks like search/price -> do it ourselves
    if (looksLikeSearch(lastUser)) {
      // Prefer Vivid Seats when user asked price-ish questions
      const q = looksLikePrice(lastUser)
        ? `${lastUser} site:vividseats.com`
        : lastUser;
      const results = await webSearch(q);
      const price = looksLikePrice(lastUser) ? guessPriceFromResults(results) : null;
      const msg =
        price
          ? `${formatSearchResults(results)}\n\nRough current price I’m seeing: **${price}** (varies by seat/date). Want to submit a request?`
          : formatSearchResults(results);
      context.res.status = 200;
      context.res.body = { message: msg, results, note: "fallback_search" };
      return;
    }

    // No tools and not a searchy message → plain assistant text
    const assistantText = toText(data?.output ?? data?.content ?? []) || "Got it!";
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
