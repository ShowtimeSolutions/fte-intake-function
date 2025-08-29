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

/* =====================  Budget tiering  ===================== */
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
const DATE_WORDS = /\b(today|tonight|tomorrow|this\s*(week|weekend)|(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s*\d{1,2}(?:,\s*\d{4})?)\b/i;

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

function haveRequired(c) {
  return !!(c.artist_or_event && c.ticket_qty && c.budget_tier && c.name && c.email);
}
function userConfirmed(text) {
  return /\b(yes|yep|yeah|correct|confirm|finalize|go ahead|proceed|place it|submit|that's right|looks good|do it|book it)\b/i.test(text || "");
}
function userAskedForm(text) {
  return /\b(open|use|show)\b.*\b(form)\b|\bmanual request\b/i.test(text || "");
}

/* =====================  Hard-coded recommendations  ===================== */
/** Edit/extend this list whenever you like. Use ISO dates. */
const RECOMMENDED_SHOWS = [
  { artist: "Jonas Brothers", venue: "United Center", date: "2025-08-18" },
  { artist: "Taylor Swift",   venue: "Soldier Field",  date: "2025-09-12" },
  { artist: "Ed Sheeran",     venue: "Wrigley Field",  date: "2025-09-05" },
  { artist: "Billie Eilish",  venue: "United Center",  date: "2025-08-29" },
  { artist: "The Weeknd",     venue: "United Center",  date: "2025-10-03" },
];

function formatRecs(dateHint) {
  const norm = (s) => (s || "").toLowerCase();
  const wanted = norm(dateHint);
  const upcoming = RECS
    .filter(r => !wanted || norm(r.date).includes(wanted))
    .sort((a, b) => new Date(a.date) - new Date(b.date))
    .slice(0, 3);
  if (!upcoming.length) return "I don’t have great recs for that date yet. Any artist you’re curious about?";
  return upcoming.map(r => `${r.artist} @ ${r.venue} on ${r.date}`).join("\n");
}

function parseDateFromText(text) {
  const m = String(text || "").match(DATE_WORDS);
  if (!m) return null;
  // very light parser: keep original token, we only need a filter string
  return m[0];
}
function formatHuman(d) {
  // input ISO 'YYYY-MM-DD' -> 'Aug 18'
  const dt = new Date(d + "T12:00:00");
  return dt.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}
function upcomingRecommendations(requestedToken) {
  const todayISO = new Date().toISOString().slice(0,10);
  let pool = RECOMMENDED_SHOWS.filter(s => s.date >= todayISO);

  // if user mentioned a specific month/day token, lightly filter by month/day text
  if (requestedToken) {
    const t = requestedToken.toLowerCase();
    pool = pool.filter(s => {
      const pretty = formatHuman(s.date).toLowerCase(); // 'aug 18'
      return pretty.includes(t.replace(",", ""));
    });
    if (pool.length === 0) pool = RECOMMENDED_SHOWS.filter(s => s.date >= todayISO);
  }

  return pool
    .sort((a,b) => a.date.localeCompare(b.date))
    .slice(0, 3)
    .map((s, i) => `${i+1}. ${s.artist} @ ${s.venue} on ${formatHuman(s.date)}`);
}

/* =====================  OpenAI  ===================== */
async function callOpenAI(messages) {
  const sysPrompt = `
You are FTE’s polite, fast, helpful ticket-intake assistant on a public website.

GOALS
- Help the user request tickets with minimal back-and-forth.
- Ask only one short question at a time for missing info.
- When the user confirms details, CALL the capture_ticket_request tool immediately.

DATA TO CAPTURE
- artist_or_event (required)
- ticket_qty (required integer)
- budget_tier (required; DEDUCE from whatever budget text they give — do not list choices)
- date_or_date_range (optional)
- name (required)
- email (required)
- phone (optional)
- notes (optional; very short)

PRICES
- If the user asks for prices say: “I can’t pull exact prices right now, but that feature is coming soon — our team will follow up with current pricing and how to get the best deal.”

RECOMMENDATIONS
- The server will send any recommendation lists. Don’t search for events yourself.

IMPORTANT
- Don’t restart once the user confirms — proceed to capture.
- Keep the tone conversational and concise.
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

function getToolCalls(openaiResp) {
  return openaiResp?.choices?.[0]?.message?.tool_calls || [];
}
function getAssistantText(openaiResp) {
  return openaiResp?.choices?.[0]?.message?.content || "";
}

/* =====================  Intent helpers  ===================== */
function looksLikePrice(msg) { return /(price|prices|cost|how much)/i.test(msg || ""); }
function wantsSuggestions(msg) { return /(suggest|recommend|popular|upcoming|what.*to do|what.*going on|ideas)/i.test((msg||"").toLowerCase()); }

/* =====================  Azure Function entry  ===================== */
module.exports = async function (context, req) {
  context.res = {
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
      "Content-Type": "application/json"
    }
  };

  if (req.method === "OPTIONS") { context.res.status = 200; context.res.body = {}; return; }

  // Manual modal capture from Framer
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

    // Open the manual form on request
    if (userAskedForm(userText)) {
      context.res.status = 200;
      context.res.body = { message: "Opening the manual request form…", openForm: true };
      return;
    }

    // --- NEW: hard-coded recommendations with the exact format requested
    if (wantsSuggestions(userText)) {
      const token = parseDateFromText(userText); // optional date token in their message
      const list = upcomingRecommendations(token);
      const msg = list.length
        ? `Great! Here are a few options:\n\n${list.join("\n")}\n\nDo any of these interest you?`
        : "I don’t have anything upcoming for that date window. Tell me an artist you like and I’ll help you request tickets.";

      context.res.status = 200;
      context.res.body = { message: msg };
      return;
    }

    // If the user asks about price, show the placeholder message (no scraping)
    if (looksLikePrice(userText)) {
      context.res.status = 200;
      context.res.body = {
        message:
          "I can’t pull exact prices right now, but that feature is coming soon — our team will follow up with current pricing and tips to get the best deal. Want me to place a request for you?"
      };
      return;
    }

    // ----- Let the model run the chat flow (and call capture tool when ready)
    const openaiResponse = await callOpenAI(messages);
    const toolCalls = getToolCalls(openaiResponse);
    let finalMessage = getAssistantText(openaiResponse);
    let captureData = null;

    for (const call of toolCalls) {
      const name = call.function?.name;
      const args = JSON.parse(call.function?.arguments || "{}");
      if (name === "capture_ticket_request") {
        captureData = args;
      }
    }

    if (captureData) {
      try {
        // Ensure budget tier is normalized if the model guessed loosely
        captureData.budget_tier = normalizeBudgetTier(captureData.budget_tier || "");
        const row = toRow(captureData);
        await appendToSheet(row);
        finalMessage =
          `Perfect! I’ve captured your request for ${captureData.ticket_qty} ` +
          `tickets to ${captureData.artist_or_event}. We’ll reach out to ${captureData.email} ` +
          `with options that fit your ${captureData.budget_tier} budget. Thanks, ${captureData.name}!`;
      } catch (e) {
        context.log.error("Sheet append failed:", e);
      }
    }

    context.res.status = 200;
    context.res.body = { message: finalMessage || "Got it!" };

  } catch (e) {
    context.log.error(e);
    context.res.status = 500;
    context.res.body = { error: String(e) };
  }
};

