// index.js — Azure Function (Node 18+) — streamlined (no live price search)

const { google } = require("googleapis");
const fetch = require("node-fetch"); // still fine to keep

/* =============== Google Sheets =============== */
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
 * Unified row (A..I):
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
    : (parseInt(c?.ticket_qty || "", 10) || "");                                   // C
  const budgetTier = c?.budget_tier || c?.budget || "";                            // D
  const dateRange = c?.date_or_date_range || "";                                   // E
  const name = c?.name || "";                                                      // F
  const email = c?.email || "";                                                    // G
  const phone = c?.phone || "";                                                    // H
  const notes = c?.notes || "";                                                    // I
  return [ts, artist, qty, budgetTier, dateRange, name, email, phone, notes];
}

/* =============== Budget normalization (no options shown to user) =============== */
function normalizeBudgetTier(text = "") {
  const t = text.toLowerCase();
  const num = parseInt(t.replace(/[^\d]/g, ""), 10);
  if (/(<\s*\$?50|under\s*50|less\s*than\s*\$?50)/i.test(text)) return "<$50";
  if (/\b(50[\s–-]?99|50-99|50 to 99)\b/i.test(text)) return "$50–$99";
  if (/\b(100[\s–-]?149|100-149|100 to 149)\b/i.test(text)) return "$100–$149";
  if (/\b(150[\s–-]?199|150-199|150 to 199)\b/i.test(text)) return "$150–$199";
  if (/\b(200[\s–-]?249|200-249|200 to 249)\b/i.test(text)) return "$200–$249";
  if (/\b(250[\s–-]?299|250-299|250 to 299)\b/i.test(text)) return "$250–$299";
  if (/\b(300[\s–-]?349|300-349|300 to 349)\b/i.test(text)) return "$300–$349";
  if (/\b(350[\s–-]?399|350-399|350 to 399)\b/i.test(text)) return "$350–$399";
  if (/(400|450)/i.test(text)) return "$400–$499";
  if (/\$?500\+|over\s*\$?500|>\s*\$?500/i.test(text)) return "$500+";
  if (!isNaN(num)) {
    if (num < 50) return "<$50";
    if (num < 100) return "$50–$99";
    if (num < 150) return "$100–$149";
    if (num < 200) return "$150–$199";
    if (num < 250) return "$200–$249";
    if (num < 300) return "$250–$299";
    if (num < 350) return "$300–$349";
    if (num < 400) return "$350–$399";
    if (num < 500) return "$400–$499";
    return "$500+";
  }
  return "";
}

const EMAIL_RE = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i;
const PHONE_RE = /\b(\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}\b/;
const QTY_RE   = /\b(\d{1,2})\b/;
const DATE_WORDS = /\b(today|tonight|tomorrow|this\s*(week|weekend)|\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s*\d{1,2}(?:,\s*\d{4})?)\b/i;

/** Turn-aware extraction */
function extractTurnAware(messages) {
  const out = { artist_or_event:"", ticket_qty:"", budget_tier:"", date_or_date_range:"", name:"", email:"", phone:"", notes:"" };
  for (let i = 0; i < messages.length - 1; i++) {
    const a = messages[i], u = messages[i + 1];
    if (a.role !== "assistant" || u.role !== "user") continue;
    const q = String(a.content || "").toLowerCase();
    const ans = String(u.content || "");

    if (!out.artist_or_event && /(artist|event).*(interested|looking|tickets?)/.test(q)) out.artist_or_event = ans.replace(/tickets?/ig, "").trim();
    if (!out.ticket_qty && /(how many|quantity|qty)/.test(q)) { const m = ans.match(QTY_RE); if (m) out.ticket_qty = parseInt(m[1], 10); }
    if (!out.budget_tier && /(budget|price range|per ticket)/.test(q)) out.budget_tier = normalizeBudgetTier(ans);
    if (!out.date_or_date_range && /(date|when)/.test(q)) { const dm = ans.match(DATE_WORDS); out.date_or_date_range = dm ? dm[0] : ans.trim(); }
    if (!out.name && /name/.test(q)) { if (!EMAIL_RE.test(ans) && !PHONE_RE.test(ans)) out.name = ans.trim(); }
    if (!out.email && /(email|e-mail)/.test(q)) { const em = ans.match(EMAIL_RE); if (em) out.email = em[0]; }
    if (!out.phone && /(phone|number)/.test(q)) { const pm = ans.match(PHONE_RE); if (pm) out.phone = pm[0]; }
    if (/notes?|special|requests?/i.test(q)) { if (!/no|none|n\/a/i.test(ans)) out.notes = ans.trim(); }
  }
  return out;
}

/** Backstop extraction */
function extractFromTranscript(messages) {
  const userTexts = messages.filter(m => m.role === "user").map(m => String(m.content||""));
  const allText = messages.map(m => String(m.content || "")).join("\n");

  let artist = "";
  for (const t of userTexts) {
    const m = t.match(/(?:see|want|looking.*for|tickets? for|go to|interested in)\s+(.+)/i);
    if (m) { artist = m[1].replace(/tickets?$/i, "").trim(); break; }
  }
  if (!artist && userTexts.length) artist = userTexts[0].trim();
  if (/^hi|hello|hey$/i.test(artist)) artist = "";

  let qty = null;
  for (let i = userTexts.length-1; i >= 0; i--) {
    const m = userTexts[i].match(QTY_RE);
    if (m) { qty = parseInt(m[1], 10); if (qty>0 && qty<=12) break; }
  }

  let budget_tier = "";
  for (let i = userTexts.length-1; i >= 0; i--) {
    const bt = normalizeBudgetTier(userTexts[i]);
    if (bt) { budget_tier = bt; break; }
  }

  let date_or_date_range = "";
  const dm = allText.match(DATE_WORDS);
  if (dm) date_or_date_range = dm[0];

  let name = "";
  const nameAskIdx = messages.findLastIndex?.(m => m.role === "assistant" && /name/i.test(String(m.content||""))) ?? -1;
  if (nameAskIdx >= 0 && messages[nameAskIdx + 1]?.role === "user") {
    const ans = String(messages[nameAskIdx + 1].content || "");
    if (!EMAIL_RE.test(ans) && !PHONE_RE.test(ans)) name = ans.trim();
  }
  if (!name) {
    const nm = allText.match(/\bmy name is ([a-z ,.'-]{2,60})/i) || allText.match(/\bi am ([a-z ,.'-]{2,60})/i);
    if (nm) name = nm[1].trim();
  }

  const email = (allText.match(EMAIL_RE) || [""])[0];
  const phone = (allText.match(PHONE_RE) || [""])[0];

  let notes = "";
  if (/aisle/i.test(allText)) notes = (notes ? notes + "; " : "") + "Aisle seat preferred";
  if (/ada|accessible/i.test(allText)) notes = (notes ? notes + "; " : "") + "ADA/accessible";

  return { artist_or_event: artist || "", ticket_qty: qty ?? "", budget_tier, date_or_date_range, name, email, phone, notes };
}

function mergeCapture(a, b) {
  return {
    artist_or_event: a.artist_or_event || b.artist_or_event || "",
    ticket_qty: a.ticket_qty || b.ticket_qty || "",
    budget_tier: a.budget_tier || b.budget_tier || "",
    date_or_date_range: a.date_or_date_range || b.date_or_date_range || "",
    name: a.name || b.name || "",
    email: a.email || b.email || "",
    phone: a.phone || b.phone || "",
    notes: a.notes || b.notes || ""
  };
}

function haveRequired(c) {
  return !!(c.artist_or_event && c.ticket_qty && c.budget_tier && c.name && c.email);
}
function userConfirmed(text) {
  return /\b(yes|yep|yeah|correct|confirm|finalize|go ahead|proceed|place it|submit|that's right|looks good|do it|book it)\b/i.test(text || "");
}
function userAskedForm(text) {
  return /\b(open|use|show)\b.*\b(form)\b|\bmanual request\b/i.test(text || "");
}

/* =============== Simple “hard-coded” recommendations =============== */
const RECO_LIST = [
  { artist: "Jonas Brothers", venue: "United Center", date: "2025-08-26" },
  { artist: "Taylor Swift",   venue: "Soldier Field", date: "2025-09-02" },
  { artist: "Bad Bunny",      venue: "Allstate Arena", date: "2025-08-31" },
  { artist: "Blink-182",      venue: "United Center", date: "2025-09-05" },
  { artist: "Metallica",      venue: "Soldier Field", date: "2025-09-12" },
  { artist: "Bruce Springsteen", venue: "Wrigley Field", date: "2025-09-18" },
];

function parseMaybeDate(text) {
  const d = new Date(text);
  return isNaN(d.getTime()) ? null : d;
}
function fmt(dStr) {
  return new Date(dStr).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}
function pickRecommendations(userText) {
  const today = new Date(); today.setHours(0,0,0,0);
  const asked = parseMaybeDate(userText);
  const pool = RECO_LIST
    .filter(x => {
      const dx = new Date(x.date);
      dx.setHours(0,0,0,0);
      if (asked) return dx.getTime() === asked.setHours(0,0,0,0);
      return dx >= today;
    })
    .sort((a,b) => new Date(a.date) - new Date(b.date))
    .slice(0,3);

  if (pool.length === 0) return "I don’t have any picks for that date yet. Want to try another date or artist?";
  const lines = pool.map(x => `• ${x.artist} @ ${x.venue} on ${fmt(x.date)}`).join("\n");
  return `Here are a few picks:\n${lines}\n\nInterested in one of these?`;
}

/* =============== OpenAI (tool only for capture) =============== */
async function callOpenAI(messages) {
  const sysPrompt = `
You are FTE’s polite, fast, and helpful ticket intake assistant on a public website.

GOALS
- Help the user request tickets with minimum back-and-forth.
- Be conversational—ask only one short question at a time for missing details.
- When the user confirms ("yes", "proceed", "go ahead", etc.), CALL the capture_ticket_request tool with the fields you know.

DATA TO CAPTURE
- artist_or_event (required)
- ticket_qty (required, integer)
- budget_tier (required; DEDUCE the tier from the user's free text; do NOT list choices)
- date_or_date_range (optional)
- name (required)
- email (required)
- phone (optional)
- notes (optional; short phrases only)

STYLE
- Short, friendly messages.
- Never ask for City/Residence.
- Do not tell the user to fill a form; if they ask, the website will open it.
- After the user confirms the summary, CALL capture_ticket_request — do not ask again.

PRICES
- Do NOT fetch live prices. If asked: "I can’t pull exact prices right now, but that feature is coming soon—our team will follow up with current pricing and tips to get the best deal."

RECOMMENDATIONS
- If they ask for ideas, let the server provide suggestions. Keep your reply short and continue the intake only if they pick one.

IMPORTANT
- Don’t restart after confirmation—proceed to capture.
- If you already have all required details (artist_or_event, ticket_qty, budget_tier, name, email) after the user confirms, CALL capture_ticket_request.
`;

  const body = {
    model: "gpt-4o-mini",
    temperature: 0.2,
    messages: [{ role: "system", content: sysPrompt }, ...messages],
    tools: [
      {
        type: "function",
        function: {
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
      }
    ],
    tool_choice: "auto"
  };

  const resp = await fetch("https://api.openai.com/v1/chat/completions", {
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

function extractToolCalls(response) {
  const message = response?.choices?.[0]?.message;
  return message?.tool_calls || [];
}
function extractAssistantText(response) {
  const message = response?.choices?.[0]?.message;
  return message?.content || "";
}

/* =============== Intent helpers =============== */
function looksLikePrice(msg) { return /(price|prices|cost|how much)/i.test(msg || ""); }
function wantsSuggestions(msg) { return /(suggest|recommend|popular|upcoming|what.*to do|what.*going on|ideas|what.*happening|what.*shows)/i.test(msg || ""); }

/* =============== Azure Function entry =============== */
module.exports = async function (context, req) {
  context.res = {
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
      "Content-Type": "application/json"
    }
  };

  if (req.method === "OPTIONS") {
    context.res.status = 200;
    context.res.body = {};
    return;
  }

  // Direct capture from the inline form
  if (req.body?.direct_capture && req.body?.capture) {
    try {
      await appendToSheet(toRow(req.body.capture));
      context.res.status = 200;
      context.res.body = { message: "Saved your request. We’ll follow up soon!" };
    } catch (e) {
      context.res.status = 500;
      context.res.body = { error: String(e) };
    }
    return;
  }

  try {
    const { messages = [] } = req.body || {};
    if (!Array.isArray(messages) || messages.length === 0) {
      context.res.status = 400;
      context.res.body = { error: "Invalid messages format" };
      return;
    }

    const lastUserMessage = messages[messages.length - 1];
    const userText = String(lastUserMessage?.content || "");

    // Manual form
    if (userAskedForm(userText)) {
      context.res.status = 200;
      context.res.body = {
        message: "I'll open the manual request form for you.",
        action: "open_form"
      };
      return;
    }

    // Prices: canned message
    if (looksLikePrice(userText)) {
      context.res.status = 200;
      context.res.body = {
        message: "I can’t pull exact prices right now, but that feature is coming soon—our team will follow up with current pricing and tips to get the best deal."
      };
      return;
    }

    // Recommendations: return 3 from hard-coded list
    if (wantsSuggestions(userText)) {
      context.res.status = 200;
      context.res.body = { message: pickRecommendations(userText) };
      return;
    }

    // Otherwise, run the normal intake (LLM + capture tool)
    const openaiResponse = await callOpenAI(messages);
    const toolCalls = extractToolCalls(openaiResponse);
    let finalMessage = extractAssistantText(openaiResponse);
    let shouldCapture = false;
    let captureData = null;

    for (const tc of toolCalls) {
      const toolName = tc.function?.name;
      const toolArgs = JSON.parse(tc.function?.arguments || "{}");
      if (toolName === "capture_ticket_request") {
        shouldCapture = true;
        captureData = toolArgs;
        finalMessage =
          `Perfect! I've captured your request for ${toolArgs.ticket_qty} tickets to ${toolArgs.artist_or_event}. ` +
          `Our team will reach out to you at ${toolArgs.email} with the best options within your ${toolArgs.budget_tier} budget. ` +
          `Thanks, ${toolArgs.name}!`;
      }
    }

    if (shouldCapture && captureData) {
      try {
        await appendToSheet(toRow(captureData));
      } catch (e) {
        // don't fail chat if Sheets write hiccups
        console.error("Sheets append error:", e);
      }
    }

    context.res.status = 200;
    context.res.body = { message: finalMessage, captured: shouldCapture };

  } catch (e) {
    console.error("Function error:", e);
    context.res.status = 500;
    context.res.body = { error: String(e) };
  }
};
