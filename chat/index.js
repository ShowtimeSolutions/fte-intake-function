const { google } = require("googleapis");

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
    requestBody: { values: [row] }
  });
}

function toRow(c) {
  const timestamp = new Date().toLocaleString("en-US", { timeZone: "America/Chicago" }); // A
  const artistOrEvent = c?.artist_or_event || "";                                         // B
  const qty = Number.isFinite(c?.ticket_qty)
    ? c.ticket_qty
    : (parseInt(c?.ticket_qty || "", 10) || "");                                          // C
  const name = c?.name || "";                                                             // D
  const email = c?.email || "";                                                           // E
  const phone = c?.phone || "";                                                           // F
  const residence = c?.city_or_residence || c?.city || "";                                // G
  const budget = c?.budget || "";                                                         // H
  const notes = c?.notes || "";                                                           // I
  return [timestamp, artistOrEvent, qty, name, email, phone, residence, budget, notes];
}

// ---------- OpenAI ----------
async function callOpenAI(messages) {
  const sysPrompt = `
You are FTE's intake assistant. Collect ticket details and concise notes.

Fields:
- artist_or_event (string)
- ticket_qty (integer)
- name (string)
- email (string)
- phone (string)
- city_or_residence (string)
- budget (string)
- date_or_date_range (string)
- notes (string) // 1–2 short sentences with special requests, ADA, flexibility

Ask minimal follow-ups. Confirm key details. Then call capture_ticket_request.
Keep replies short and friendly.
`;

  const resp = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
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
              notes: { type: "string" }
            },
            required: ["artist_or_event", "ticket_qty", "name", "email"]
          }
        }
      ],
      tool_choice: "auto"
    })
  });

  if (!resp.ok) throw new Error(await resp.text());
  return resp.json();
}

// Helpers to parse OpenAI Responses API
function digToolCalls(x) {
  if (!x) return [];
  if (Array.isArray(x)) return x.flatMap(digToolCalls);
  const out = [];
  if (x.type === "tool_call" && x.name === "capture_ticket_request") out.push(x);
  if (x.output) out.push(...digToolCalls(x.output));
  if (x.content) out.push(...digToolCalls(x.content));
  return out;
}

function toText(nodes) {
  if (!nodes) return "";
  if (typeof nodes === "string") return nodes;
  if (Array.isArray(nodes)) return nodes.map(toText).join("");
  if (typeof nodes === "object") {
    if (nodes.type === "output_text" || nodes.type === "text") return nodes.text || nodes.content || "";
    return [nodes.text, nodes.content, nodes.output].map(toText).join("");
  }
  return "";
}

// ---------- Azure Function entry ----------
module.exports = async function (context, req) {
  context.res = {
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type"
    }
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
    const data = await callOpenAI(messages);

    let captured = null;
    const calls = digToolCalls(data);
    if (calls.length) {
      const args = calls[0].arguments || calls[0].args;
      captured = typeof args === "string" ? JSON.parse(args) : args;
      const row = toRow(captured);
      await appendToSheet(row);
    }

    const assistantText = toText(data?.output ?? data?.content ?? []) || "Got it!";
    context.res.status = 200;
    context.res.body = { message: assistantText, captured };
  } catch (e) {
    context.log.error(e);
    context.res.status = 500;
    context.res.body = { error: String(e) };
  }
};
