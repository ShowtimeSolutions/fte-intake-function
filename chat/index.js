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

/* =====================  Serper Search  ===================== */
async function webSearch(query, location, { preferTickets = true, max = 5 } = {}) {
  // Bias queries toward ticket sites (cleaner snippets with prices)
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
/** Try a vivid-first price for a query. */
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

/* =====================  Guardrail extraction  ===================== */
// Map free-form budget phrases to your tiers.
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

/** Turn-aware extraction: watches assistant questions then grabs the next user reply. */
function extractTurnAware(messages) {
  const out = {
    artist_or_event: "",
    ticket_qty: "",
    budget_tier: "",
    date_or_date_range: "",
    name: "",
    email: "",
    phone: "",
    notes: ""
  };

  for (let i = 0; i < messages.length - 1; i++) {
    const a = messages[i];
    const u = messages[i + 1];
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
      // keep just a name-looking answer (strip emails/phones)
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
      // simple notes capture
      if (!/no|none|n\/a/i.test(ans)) out.notes = ans.trim();
    }
  }

  return out;
}

/** Heuristic extraction from the whole transcript (backstop). */
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

  // qty: last numeric 1–12 in user msgs
  let qty = null;
  for (let i = userTexts.length-1; i >= 0; i--) {
    const m = userTexts[i].match(QTY_RE);
    if (m) { qty = parseInt(m[1], 10); if (qty>0 && qty<=12) break; }
  }

  // budget tier: last budget-ish phrase
  let budget_tier = "";
  for (let i = userTexts.length-1; i >= 0; i--) {
    const bt = normalizeBudgetTier(userTexts[i]);
    if (bt) { budget_tier = bt; break; }
  }

  let date_or_date_range = "";
  const dm = allText.match(DATE_WORDS);
  if (dm) date_or_date_range = dm[0];

  // name: grab any standalone line that looks like a name
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
  if (/ada|accessible/i.test(allText)) notes = (notes ? notes + "; " : "") + "ADA/accessible";

  return {
    artist_or_event: artist || "",
    ticket_qty: qty ?? "",
    budget_tier,
    date_or_date_range,
    name,
    email,
    phone,
    notes
  };
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
  return /\b(yes|yep|yeah|correct|confirm|finalize|go ahead|proceed|place it|submit|that’s right|that's right|looks good|do it|book it)\b/i.test(text || "");
}
function userAskedForm(text) {
  return /\b(open|use|show)\b.*\b(form)\b|\bmanual request\b/i.test(text || "");
}

/* =====================  OpenAI  ===================== */
async function callOpenAI(messages) {
  const sysPrompt = `
You are FTE’s polite, fast, and helpful ticket intake assistant on a public website.

GOALS
- Help the user pick or request tickets with minimum back-and-forth.
- Be conversational, but ask only one short question at a time for missing details.
- When the user confirms the details ("yes", "proceed", "go ahead", etc.), call the capture_ticket_request tool immediately with the fields you know.
- If the user wants ideas, dates, or prices, use the web_search tool first and reply with a short summary (no links, no long lists unless they ask).

DATA TO CAPTURE (for capture_ticket_request)
- artist_or_event (required) — e.g., "Jonas Brothers"
- ticket_qty (required, integer)
- budget_tier (required, choose one exactly): "<$50","$50–$99","$100–$149","$150–$199","$200–$249","$250–$299","$300–$349","$350–$399","$400–$499","$500+"
- date_or_date_range (optional)
- name (required)
- email (required)
- phone (optional)
- notes (optional, short phrases only)

STYLE
- Short, friendly messages.
- Never ask for City/Residence.
- Do not tell the user to fill a form. If they ask for the form, the website will open it.
- After the user confirms the summary, CALL capture_ticket_request instead of asking again.

PRICE / IDEAS
- If the user asks “what’s on” / “what’s happening” / “recommendations” / “prices”, call web_search first.
- Price replies: “Summary: Lowest starting price around $X.” (nothing else).
- Suggestions: a short list (3–5 lines) if they ask for ideas; otherwise keep it brief.

IMPORTANT
- Do not restart the conversation after the user confirms. Proceed to capture.
- If you already know all


// // index.js — Azure Function (Node 18+)
// // ------------------------------------
// const { google } = require("googleapis");
// const fetch = require("node-fetch");

// /* =====================  Google Sheets  ===================== */
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
//     requestBody: { values: [row] },
//   });
// }

// /**
//  * Unified row (A..I):
//  *  A Timestamp
//  *  B Artist_or_event
//  *  C Ticket_qty
//  *  D Budget_tier
//  *  E Date_or_date_range
//  *  F Name
//  *  G Email
//  *  H Phone
//  *  I Notes
//  */
// function toRow(c) {
//   const ts = new Date().toLocaleString("en-US", { timeZone: "America/Chicago" }); // A
//   const artist = c?.artist_or_event || "";                                        // B
//   const qty = Number.isFinite(c?.ticket_qty)
//     ? c.ticket_qty
//     : (parseInt(c?.ticket_qty || "", 10) || "");                                   // C
//   const budgetTier = c?.budget_tier || c?.budget || "";                            // D
//   const dateRange = c?.date_or_date_range || "";                                   // E
//   const name = c?.name || "";                                                      // F
//   const email = c?.email || "";                                                    // G
//   const phone = c?.phone || "";                                                    // H
//   const notes = c?.notes || "";                                                    // I
//   return [ts, artist, qty, budgetTier, dateRange, name, email, phone, notes];
// }

// /* =====================  Serper Search  ===================== */
// async function webSearch(query, location, { preferTickets = true, max = 5 } = {}) {
//   // Bias queries toward ticket sites (cleaner snippets with prices)
//   const siteBias = preferTickets ? " (site:vividseats.com OR site:ticketmaster.com)" : "";
//   const hasTicketsWord = /\bticket(s)?\b/i.test(query);
//   const qFinal =
//     query + (hasTicketsWord ? "" : " tickets") + (location ? ` ${location}` : "") + siteBias;

//   const resp = await fetch("https://google.serper.dev/search", {
//     method: "POST",
//     headers: { "X-API-KEY": process.env.SERPER_API_KEY, "Content-Type": "application/json" },
//     body: JSON.stringify({ q: qFinal, num: max }),
//   });
//   if (!resp.ok) throw new Error(await resp.text());
//   const data = await resp.json();

//   return (data.organic || []).map((r, i) => ({
//     n: i + 1,
//     title: r.title || "",
//     link: r.link || "",
//     snippet: r.snippet || "",
//   }));
// }

// /* =====================  Price helpers  ===================== */
// const PRICE_RE = /\$[ ]?(\d{2,4})(?:\s*-\s*\$?\d{2,4})?/gi;
// const irrelevant = (t, s) => /parking|hotel|restaurant|faq|blog/i.test(`${t} ${s}`);

// function firstPrice(text) {
//   if (!text) return null;
//   let m; PRICE_RE.lastIndex = 0;
//   while ((m = PRICE_RE.exec(text))) {
//     const val = parseInt(m[1], 10);
//     if (!isNaN(val) && val >= 30) return val; // ignore super-low noise
//   }
//   return null;
// }
// function minPriceAcross(items) {
//   let best = null;
//   for (const it of items || []) {
//     const val = firstPrice(`${it.title} ${it.snippet}`);
//     if (val != null) best = best == null ? val : Math.min(best, val);
//   }
//   return best;
// }
// /** Try a vivid-first price for a query. */
// async function vividStartingPrice(q) {
//   const items = await webSearch(`${q} tickets site:vividseats.com`, null, { preferTickets: true, max: 5 });
//   const vividOnly = items.filter(it => /vividseats\.com/i.test(it.link) && !irrelevant(it.title, it.snippet));
//   const first = vividOnly[0];
//   if (!first) return null;
//   const p = firstPrice(`${first.title} ${first.snippet}`);
//   return p != null ? p : null;
// }
// function priceSummaryMessage(priceNum) {
//   if (priceNum != null) {
//     return `Summary: Lowest starting price around $${priceNum}.` + `\n\nWould you like me to open the request form?`;
//   }
//   return `Summary: I couldn’t confirm a current starting price just yet.` + `\n\nWould you like me to open the request form?`;
// }

// /* =====================  Deterministic extraction  ===================== */
// function normalizeBudgetTier(text = "") {
//   const t = text.toLowerCase();
//   const num = parseInt(t.replace(/[^\d]/g, ""), 10);

//   if (/(<\s*\$?50|under\s*50|less\s*than\s*\$?50)/i.test(text)) return "<$50";
//   if (/\b(50[\s–-]?99|50-99|50 to 99)\b/i.test(text)) return "$50–$99";
//   if (/\b(100[\s–-]?149|100-149|100 to 149)\b/i.test(text)) return "$100–$149";
//   if (/\b(150[\s–-]?199|150-199|150 to 199)\b/i.test(text)) return "$150–$199";
//   if (/\b(200[\s–-]?249|200-249|200 to 249)\b/i.test(text)) return "$200–$249";
//   if (/\b(250[\s–-]?299|250-299|250 to 299)\b/i.test(text)) return "$250–$299";
//   if (/\b(300[\s–-]?349|300-349|300 to 349)\b/i.test(text)) return "$300–$349";
//   if (/\b(350[\s–-]?399|350-399|350 to 399)\b/i.test(text)) return "$350–$399";
//   if (/(400|450)/i.test(text)) return "$400–$499";
//   if (/\$?500\+|over\s*\$?500|>\s*\$?500/i.test(text)) return "$500+";

//   if (!isNaN(num)) {
//     if (num < 50) return "<$50";
//     if (num < 100) return "$50–$99";
//     if (num < 150) return "$100–$149";
//     if (num < 200) return "$150–$199";
//     if (num < 250) return "$200–$249";
//     if (num < 300) return "$250–$299";
//     if (num < 350) return "$300–$349";
//     if (num < 400) return "$350–$399";
//     if (num < 500) return "$400–$499";
//     return "$500+";
//   }
//   return "";
// }

// const EMAIL_RE = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i;
// const PHONE_RE = /\b(\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}\b/;
// const QTY_RE   = /\b(\d{1,2})\b/;
// const DATE_WORDS = /\b(today|tonight|tomorrow|this\s*(week|weekend)|\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s*\d{1,2}(?:,\s*\d{4})?)\b/i;

// /** Heuristic extraction from the whole transcript. */
// function extractFromTranscript(messages) {
//   const userTexts = messages.filter(m => m.role === "user").map(m => String(m.content||""));
//   const allText = messages.map(m => String(m.content || "")).join("\n");

//   // artist/event: pick last user line that looks like an artist/event ask
//   let artist = "";
//   for (let i = userTexts.length - 1; i >= 0; i--) {
//     const t = userTexts[i];
//     if (/\b(tickets?|concert|show|event)\b/i.test(t) || /jonas|taylor|drake|bears|bulls|cubs|concert/i.test(t)) {
//       artist = t.replace(/(tickets?|concert|show|event)/ig, "").trim();
//       if (!/^hi|hello|hey$/i.test(artist)) break;
//     }
//   }
//   if (!artist && userTexts.length) artist = userTexts[0].trim();
//   artist = artist.replace(/^[\s"']+|[\s"']+$/g, "");
//   if (/^hi|hello|hey$/i.test(artist)) artist = "";

//   // qty
//   let qty = null;
//   for (let i = userTexts.length-1; i >= 0; i--) {
//     const m = userTexts[i].match(QTY_RE);
//     if (m) { qty = parseInt(m[1], 10); if (qty>0 && qty<=12) break; }
//   }

//   // budget
//   let budget_tier = "";
//   for (let i = userTexts.length-1; i >= 0; i--) {
//     const bt = normalizeBudgetTier(userTexts[i]);
//     if (bt) { budget_tier = bt; break; }
//   }

//   // date / date range
//   let date_or_date_range = "";
//   const dm = allText.match(DATE_WORDS);
//   if (dm) date_or_date_range = dm[0];

//   // name
//   let name = "";
//   const nameMatch = allText.match(/\bmy name is ([a-z ,.'-]{2,60})/i) || allText.match(/\bi am ([a-z ,.'-]{2,60})/i);
//   if (nameMatch) name = nameMatch[1].trim();
//   for (const t of userTexts) { // “Nick Lynch, nick@…”
//     if (!name && /[,]/.test(t) && EMAIL_RE.test(t)) { name = t.split(",")[0].trim(); break; }
//   }

//   // email / phone
//   const email = (allText.match(EMAIL_RE) || [""])[0];
//   const phone = (allText.match(PHONE_RE) || [""])[0];

//   // notes
//   let notes = "";
//   if (/aisle/i.test(allText)) notes = (notes ? notes + "; " : "") + "Aisle seat preferred";
//   if (/ada|accessible/i.test(allText)) notes = (notes ? notes + "; " : "") + "ADA/accessible";

//   return {
//     artist_or_event: artist || "",
//     ticket_qty: qty ?? "",
//     budget_tier,
//     date_or_date_range,
//     name,
//     email,
//     phone,
//     notes
//   };
// }

// function haveRequired(c) {
//   return !!(c.artist_or_event && c.ticket_qty && c.budget_tier && c.name && c.email);
// }
// function userConfirmed(text) {
//   return /\b(yes|yep|yeah|correct|confirm|finalize|go ahead|place it|submit|that’s right|that's right|looks good|proceed)\b/i.test(text || "");
// }
// function userAskedForm(text) {
//   return /\b(open|use|show)\b.*\b(form)\b|\bmanual request\b/i.test(text || "");
// }

// /* =====================  OpenAI  ===================== */
// async function callOpenAI(messages) {
//   const sysPrompt = `
// You are FTE’s intake assistant on a public website.

// Behavior:
// - Be conversational and concise. Ask one missing field at a time (artist/event, ticket_qty, budget_tier, date_or_date_range, name, email, optional phone/notes).
// - When the user confirms the details are correct, CALL the capture_ticket_request tool with the fields below.
// - Do NOT ask for City/Residence.
// - If the user asks about what's on or prices, call web_search and reply with a one-line summary price (no links).
// - Never tell the user to fill a form; the website handles that if they ask to open it.

// Fields:
// - artist_or_event (string, required)
// - ticket_qty (integer, required)
// - budget_tier (string; "<$50","$50–$99","$100–$149","$150–$199","$200–$249","$250–$299","$300–$349","$350–$399","$400–$499","$500+")
// - date_or_date_range (string, optional)
// - name (string, required)
// - email (string, required)
// - phone (string, optional)
// - notes (string, optional, short)
// `;

//   const body = {
//     model: "gpt-4.1-mini",
//     temperature: 0.2,
//     input: [{ role: "system", content: sysPrompt }, ...messages],
//     tools: [
//       {
//         type: "function",
//         name: "capture_ticket_request",
//         description: "Finalize a ticket request and log to Google Sheets.",
//         parameters: {
//           type: "object",
//           properties: {
//             artist_or_event: { type: "string" },
//             ticket_qty: { type: "integer" },
//             budget_tier: {
//               type: "string",
//               enum: [
//                 "<$50","$50–$99","$100–$149","$150–$199",
//                 "$200–$249","$250–$299","$300–$349","$350–$399",
//                 "$400–$499","$500+"
//               ]
//             },
//             date_or_date_range: { type: "string" },
//             name: { type: "string" },
//             email: { type: "string" },
//             phone: { type: "string" },
//             notes: { type: "string" }
//           },
//           required: ["artist_or_event", "ticket_qty", "budget_tier", "name", "email"]
//         }
//       },
//       {
//         type: "function",
//         name: "web_search",
//         description: "Search the web for events, venues, dates, ticket info, or prices.",
//         parameters: {
//           type: "object",
//           properties: {
//             q: { type: "string", description: "Search query (include artist/venue and 'tickets' when relevant)" },
//             location: { type: "string", description: "City/Region (optional)" }
//           },
//           required: ["q"]
//         }
//       }
//     ],
//     tool_choice: "auto"
//   };

//   const resp = await fetch("https://api.openai.com/v1/responses", {
//     method: "POST",
//     headers: {
//       Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
//       "Content-Type": "application/json"
//     },
//     body: JSON.stringify(body)
//   });

//   if (!resp.ok) throw new Error(await resp.text());
//   return resp.json();
// }

// /* =====================  Responses helpers  ===================== */
// function digToolCalls(x) {
//   if (!x) return [];
//   if (Array.isArray(x)) return x.flatMap(digToolCalls);
//   const out = [];
//   if (x.type === "tool_call" && x.name) out.push(x);
//   if (x.output) out.push(...digToolCalls(x.output));
//   if (x.content) out.push(...digToolCalls(x.content));
//   return out;
// }
// function toAssistantText(obj) {
//   const tryList = [obj?.output_text, obj?.text, obj?.content, obj?.output];
//   const flat = (node) => {
//     if (!node) return "";
//     if (typeof node === "string") return node;
//     if (Array.isArray(node)) return node.map(flat).join("");
//     if (typeof node === "object") return [node.text, node.content, node.output].map(flat).join("");
//     return "";
//   };
//   for (const cand of tryList) {
//     const s = flat(cand).trim();
//     if (s) return s;
//   }
//   return "";
// }

// /* =====================  Intent helpers  ===================== */
// function looksLikeSearch(msg) {
//   const q = (msg || "").toLowerCase();
//   return /what.*(show|event)|show(s)?|event(s)?|happening|things to do|prices?|price|tickets?|concert|theater|theatre|sports|game|popular|upcoming|suggest|recommend/.test(q);
// }
// function looksLikePrice(msg) { return /(price|prices|cost|how much)/i.test(msg || ""); }
// function wantsSuggestions(msg) { return /(suggest|recommend|popular|upcoming|what.*to do|what.*going on|ideas)/i.test(msg || ""); }
// function mentionsChicago(msg) { return /(chicago|chi-town|chitown|tinley park|rosemont|wrigley|united center|soldier field)/i.test(msg || ""); }

// /* =====================  Azure Function entry  ===================== */
// module.exports = async function (context, req) {
//   context.res = {
//     headers: {
//       "Access-Control-Allow-Origin": "*",
//       "Access-Control-Allow-Methods": "POST, OPTIONS",
//       "Access-Control-Allow-Headers": "Content-Type"
//     }
//   };

//   if (req.method === "OPTIONS") { context.res.status = 204; return; }
//   if (req.method !== "POST") { context.res.status = 405; context.res.body = { error: "Method not allowed" }; return; }

//   try {
//     // Manual modal capture from Framer
//     if (req.body?.direct_capture && req.body?.capture) {
//       await appendToSheet(toRow(req.body.capture));
//       context.res.status = 200;
//       context.res.body = { message: "Saved your request. We’ll follow up soon!", captured: req.body.capture };
//       return;
//     }

//     const messages = Array.isArray(req.body?.messages) ? req.body.messages : [];
//     const lastUser = [...messages].reverse().find((m) => m.role === "user")?.content || "";
//     const lastAssistant = [...messages].reverse().find((m) => m.role === "assistant")?.content || "";

//     // If user explicitly asks for the form, instruct UI to open it
//     if (userAskedForm(lastUser)) {
//       context.res.status = 200;
//       context.res.body = { message: "Opening the manual request form…", openForm: true };
//       return;
//     }

//     // ---------- Deterministic finalize: if transcript already has everything AND user confirms, capture directly
//     const extracted = extractFromTranscript(messages);
//     if (haveRequired(extracted) && userConfirmed(lastUser)) {
//       await appendToSheet(toRow(extracted));
//       context.res.status = 200;
//       context.res.body = {
//         message: "Thanks! I saved your request and we’ll follow up shortly to confirm details.",
//         captured: extracted
//       };
//       return;
//     }

//     // ---------- Quick path: suggestions in Chicago
//     if (!haveRequired(extracted) && wantsSuggestions(lastUser) && mentionsChicago(lastUser)) {
//       const items = await webSearch("popular shows Chicago", "Chicago IL", { preferTickets: true, max: 5 });
//       const best = minPriceAcross(items);
//       const msg = priceSummaryMessage(best);
//       context.res.status = 200;
//       context.res.body = { message: msg, results: [] };
//       return;
//     }

//     // ---------- Model pass
//     const data = await callOpenAI(messages);
//     const calls = digToolCalls(data);
//     context.log("Tool calls:", JSON.stringify(calls));

//     // Run tools the model requested
//     for (const c of calls) {
//       const args = typeof c.arguments === "string" ? JSON.parse(c.arguments) : c.arguments;

//       if (c.name === "capture_ticket_request") {
//         await appendToSheet(toRow(args));
//         context.res.status = 200;
//         context.res.body = {
//           message: "Thanks! I saved your request and we’ll follow up shortly to confirm details.",
//           captured: args
//         };
//         return;
//       }

//       if (c.name === "web_search") {
//         let bestNum = null;
//         if (looksLikePrice(args.q)) bestNum = await vividStartingPrice(args.q);
//         if (bestNum == null) {
//           const results = await webSearch(args.q, args.location, { preferTickets: true });
//           bestNum = minPriceAcross(results);
//         }
//         const msg = priceSummaryMessage(bestNum);
//         context.res.status = 200;
//         context.res.body = { message: msg };
//         return;
//       }
//     }

//     // ---------- Fallbacks (only if we don't already have a complete request)
//     if (!haveRequired(extracted) && looksLikeSearch(lastUser)) {
//       let bestNum = null;
//       if (looksLikePrice(lastUser)) bestNum = await vividStartingPrice(lastUser);
//       if (bestNum == null) {
//         const results = await webSearch(lastUser, null, { preferTickets: true });
//         bestNum = minPriceAcross(results);
//       }
//       const msg = priceSummaryMessage(bestNum);
//       context.res.status = 200;
//       context.res.body = { message: msg, note: "fallback_search" };
//       return;
//     }

//     // No tool call & not a search → pass through assistant text (keep conversation moving)
//     let assistantText = toAssistantText(data);
//     if (!assistantText) {
//       // helpful nudge, not "Got it"
//       if (!haveRequired(extracted)) {
//         assistantText = "Great — which artist or event are you looking for, and how many tickets do you need?";
//       } else {
//         assistantText = "I’ve got your details. If everything looks good, say “proceed” and I’ll place your request.";
//       }
//     }
//     context.res.status = 200;
//     context.res.body = { message: assistantText };
//   } catch (e) {
//     context.log.error(e);
//     context.res.status = 500;
//     context.res.body = { error: String(e) };
//   }
// };






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
