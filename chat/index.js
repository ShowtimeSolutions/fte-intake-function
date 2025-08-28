// index.js — Azure Function (Node 18+)
const { google } = require("googleapis");
const fetch = require("node-fetch");

/* =====================  ENV GUARDRAILS  ===================== */
function mustGetEnv(name) {
  const v = process.env[name];
  if (!v || String(v).trim() === "") {
    throw new Error(`Missing required environment variable ${name}`);
  }
  return v;
}
const OPENAI_API_KEY = mustGetEnv("OPENAI_API_KEY");
const OPENAI_API_BASE = (process.env.OPENAI_API_BASE || "https://api.openai.com/v1").replace(/\/+$/, "");
const SERPER_API_KEY = mustGetEnv("SERPER_API_KEY");
const SHEET_ID = mustGetEnv("GOOGLE_SHEETS_ID");
const SHEET_RANGE = process.env.GOOGLE_SHEETS_RANGE || "Sheet1!A:I";
const SHEETS_CREDS_RAW = mustGetEnv("GOOGLE_SHEETS_CREDENTIALS");

/* =====================  Google Sheets  ===================== */
function parseServiceAccount(jsonStr) {
  let creds = typeof jsonStr === "string" ? JSON.parse(jsonStr) : jsonStr;
  // Fix common newline escaping on the private key:
  if (creds.private_key && creds.private_key.includes("\\n")) {
    creds.private_key = creds.private_key.replace(/\\n/g, "\n");
  }
  return creds;
}

async function getSheetsClient() {
  const creds = parseServiceAccount(SHEETS_CREDS_RAW);
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
    spreadsheetId: SHEET_ID,
    range: SHEET_RANGE,
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
  const budgetTier = c?.budget_tier || "";                                         // D
  const dateRange = c?.date_or_date_range || "";                                   // E
  const name = c?.name || "";                                                      // F
  const email = c?.email || "";                                                    // G
  const phone = c?.phone || "";                                                    // H
  const notes = c?.notes || "";                                                    // I
  return [ts, artist, qty, budgetTier, dateRange, name, email, phone, notes];
}

/* =====================  Serper Search  ===================== */
async function webSearch(query, location, { preferTickets = true, max = 5 } = {}) {
  // Bias queries toward tickets sites (cleaner snippets with prices)
  const siteBias = preferTickets ? " (site:vividseats.com OR site:ticketmaster.com)" : "";
  const hasTicketsWord = /\bticket(s)?\b/i.test(query);
  const qFinal =
    query + (hasTicketsWord ? "" : " tickets") + (location ? ` ${location}` : "") + siteBias;

  const resp = await fetch("https://google.serper.dev/search", {
    method: "POST",
    headers: { "X-API-KEY": SERPER_API_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ q: qFinal, num: max }),
  });
  if (!resp.ok) throw new Error(`Serper error: ${await resp.text()}`);
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
    return `Summary: Lowest starting price around $${priceNum}.\n\nWould you like me to open the request form?`;
  }
  return `Summary: I couldn’t confirm a current starting price just yet.\n\nWould you like me to open the request form?`;
}

/* =====================  Guardrail extraction (turn-aware + backstop)  ===================== */
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

function extractTurnAware(messages) {
  const out = {
    artist_or_event: "", ticket_qty: "", budget_tier: "",
    date_or_date_range: "", name: "", email: "", phone: "", notes: ""
  };
  for (let i = 0; i < messages.length - 1; i++) {
    const a = messages[i], u = messages[i + 1];
    if (a.role !== "assistant" || u.role !== "user") continue;
    const q = String(a.content || "").toLowerCase();
    const ans = String(u.content || "");

    if (!out.artist_or_event && /(artist|event).*(interested|looking|tickets?)/.test(q)) {
      out.artist_or_event = ans.replace(/tickets?/ig, "").trim();
    }
    if (!out.ticket_qty && /(how many|quantity|qty)/.test(q)) {
      const m = ans.match(QTY_RE);
      if (m) out.ticket_qty = parseInt(m[1], 10);
    }
    if (!out.budget_tier && /(budget|price range|per ticket)/.test(q)) {
      out.budget_tier = normalizeBudgetTier(ans);
    }
    if (!out.date_or_date_range && /(date|when)/.test(q)) {
      const dm = ans.match(DATE_WORDS);
      out.date_or_date_range = dm ? dm[0] : ans.trim();
    }
    if (!out.name && /name/.test(q)) {
      if (!EMAIL_RE.test(ans) && !PHONE_RE.test(ans)) out.name = ans.trim();
    }
    if (!out.email && /(email|e-mail)/.test(q)) {
      const em = ans.match(EMAIL_RE);
      if (em) out.email = em[0];
    }
    if (!out.phone && /(phone|number)/.test(q)) {
      const pm = ans.match(PHONE_RE);
      if (pm) out.phone = pm[0];
    }
    if (/notes?|special|requests?/i.test(q)) {
      if (!/no|none|n\/a/i.test(ans)) out.notes = ans.trim();
    }
  }
  return out;
}

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
  const nameAskIdx = messages.findLastIndex(m => m.role === "assistant" && /name/i.test(String(m.content||"")));
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
  if (/ada|accessible/i.test(allText)) notes = (notes ?









