// index.js — Azure Function (Node 18+)
// ------------------------------------

const { google } = require("googleapis");
const fetch = require("node-fetch");
const nodemailer = require("nodemailer");

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

/* =====================  Gmail confirmation  ===================== */
function buildConfirmationEmail(c) {
  const artist = c.artist_or_event || "your event";
  const qty = c.ticket_qty || "?";
  const budget = normalizeBudgetTier(c.budget_tier || c.budget || "") || "—";
  const date = c.date_or_date_range || "TBD";
  const name = c.name || "there";

  const subject = `We got your request: ${artist}`;
  const text =
`Hey ${name},

Thanks for using Fair Ticket Exchange!
We’ve logged your request:

• Artist/Event: ${artist}
• Qty: ${qty}
• Date/Range: ${date}
• Budget: ${budget}
• Notes: ${c.notes || "—"}

Our team will follow up by email with options.`;

  const html = `
  <div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif;line-height:1.5;">
    <p>Hey ${name},</p>
    <p>Thanks for using <strong>Fair Ticket Exchange</strong>! We’ve logged your request:</p>
    <ul>
      <li><strong>Artist/Event:</strong> ${artist}</li>
      <li><strong>Qty:</strong> ${qty}</li>
      <li><strong>Date/Range:</strong> ${date}</li>
      <li><strong>Budget:</strong> ${budget}</li>
      <li><strong>Notes:</strong> ${c.notes || "—"}</li>
    </ul>
    <p>Our team will follow up by email with the best options.</p>
    <p style="color:#7a7a7a;">— FTE Team</p>
  </div>`;
  return { subject, text, html };
}

async function sendConfirmationEmail(c) {
  // No-op if email isn't configured
  if (!process.env.GMAIL_USER || !process.env.GMAIL_APP_PASSWORD || !c?.email) return;

  const transporter = nodemailer.createTransport({
    service: "gmail",
    auth: {
      user: process.env.GMAIL_USER,
      pass: process.env.GMAIL_APP_PASSWORD,
    },
  });

  const { subject, text, html } = buildConfirmationEmail(c);
  const from = process.env.GMAIL_FROM || process.env.GMAIL_USER;
  const replyTo = process.env.GMAIL_REPLY_TO || from;
  const bcc = process.env.GMAIL_BCC || undefined;

  await transporter.sendMail({
    from,
    to: c.email,
    bcc,
    replyTo,
    subject,
    text,
    html,
  });
}

/* =====================  Turn-aware extraction  ===================== */
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

/* =====================  Backstop extraction  ===================== */
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
  return !!(c.artist_or_event && c.ticket_qty && c.name && c.email);
}
function userConfirmed(text) {
  return /\b(yes|yep|yeah|correct|confirm|finalize|go ahead|proceed|place it|submit|that's right|looks good|do it|book it)\b/i.test(text || "");
}
function userAskedForm(text) {
  return /\b(open|use|show)\b.*\b(form)\b|\bmanual request\b/i.test(text || "");
}

/* =====================  Hard-coded recommendations  ===================== */
// Keep your big list here; a few placeholders so the code runs.
const RECOMMENDED_SHOWS = [
  { artist: "Damon Darling", venue: "Zanies Comedy Club Rosemont", date: "2025-08-30" },
  { artist: "Mc Magic", venue: "Vic Theatre", date: "2025-08-30" },
  { artist: "Trace Adkins", venue: "Park Centennial Park West", date: "2025-08-30" },
  { artist: "Adam Beyer", venue: "Prysm Nightclub", date: "2025-08-30" },
  { artist: "Of The Trees", venue: "Garcias Chicago", date: "2025-08-30" },
  { artist: "Whiskey Friends   Tribute To Morgan Wallen", venue: "City Live At The Lakefront", date: "2025-08-30" },
  { artist: "Atliens", venue: "Joes On Weed Street", date: "2025-08-30" },
  { artist: "The Whispers", venue: "Club Hills Country Club Hills Theater", date: "2025-08-30" },
  { artist: "Nghtmre", venue: "Tao Chicago", date: "2025-08-30" },
  { artist: "Fromis 9", venue: "Chicago Theatre", date: "2025-08-30" },
  { artist: "Nate Jackson", venue: "Chicago Improv", date: "2025-08-30" },
  { artist: "Excision", venue: "House Of Blues Chicago", date: "2025-08-30" },
  { artist: "Peephole   System Of A Down Tribute", venue: "Cubby Bear", date: "2025-08-30" },
  { artist: "Twihard   A Twilight Musical Parody", venue: "Apollo Theater Chicago", date: "2025-08-30" },
  { artist: "Come From Away", venue: "Paramount Theatre Aurora", date: "2025-08-30" },
  { artist: "Come From Away", venue: "Paramount Theatre Aurora", date: "2025-08-30" },
  { artist: "Million Dollar Quartet", venue: "Paramount Theatre Aurora", date: "2025-08-30" },
  { artist: "Calo Flamenco", venue: "Rosemont Theatre", date: "2025-08-30" },
  { artist: "System Of A Down", venue: "Soldier Field Parking", date: "2025-08-31" },
  { artist: "Junior H", venue: "Park Credit Union 1 Amphitheatre", date: "2025-08-31" },
  { artist: "Chicago White Sox", venue: "Rate Field", date: "2025-08-31" },
  { artist: "John Summit", venue: "Radius Chicago", date: "2025-08-31" },
  { artist: "Zakir Khan", venue: "Chicago Theatre", date: "2025-08-31" },
  { artist: "Zeds Dead", venue: "Ramova Theatre", date: "2025-08-31" },
  { artist: "North Coast Music Festival", venue: "Seatgeek Stadium", date: "2025-08-31" },
  { artist: "Arc Music Festival", venue: "Union Park", date: "2025-08-31" },
  { artist: "Streetlight Manifesto", venue: "Salt Shed", date: "2025-08-31" },
  { artist: "Challenge Mania Live", venue: "City Winery", date: "2025-08-31" },
  { artist: "Daily Bread", venue: "House Of Blues Chicago", date: "2025-08-31" },
  { artist: "Oliver", venue: "Beverly Arts Center", date: "2025-08-31" },
  { artist: "Come From Away", venue: "Paramount Theatre Aurora", date: "2025-08-31" },
  { artist: "Come From Away", venue: "Paramount Theatre Aurora", date: "2025-08-31" },
  { artist: "Twihard   A Twilight Musical Parody", venue: "Apollo Theater Chicago", date: "2025-08-31" },
  { artist: "La Original Banda El Limon", venue: "Park Ravinia", date: "2025-08-31" },
  { artist: "Demetria Taylor", venue: "Buddy Guys Legends", date: "2025-08-31" },
  { artist: "New Colony Six", venue: "Charles Arcada Theatre", date: "2025-08-31" },
  { artist: "Twenty Sided Tavern", venue: "Broadway Playhouse At Water Tower Place", date: "2025-08-31" },
  { artist: "Catch Me If You Can", venue: "Marriott Theatre Lincolnshire", date: "2025-08-31" },
  { artist: "Spitalfield", venue: "Beat Kitchen", date: "2025-08-31" },
  { artist: "Rockin Brew Fest", venue: "Buffalo Silver Creek Event Center At Four Winds", date: "2025-08-31" },
  { artist: "Kane County Cougars", venue: "Medicine Field", date: "2025-08-31" },
  { artist: "Twenty Sided Tavern", venue: "Broadway Playhouse At Water Tower Place", date: "2025-08-31" },
  { artist: "Taste Of Polonia", venue: "Copernicus Center", date: "2025-08-31" },
  { artist: "System Of A Down", venue: "Soldier Field", date: "2025-09-01" },
  { artist: "Chicago Cubs", venue: "Field", date: "2025-09-01" },
  { artist: "Junior H", venue: "Park Credit Union 1 Amphitheatre", date: "2025-09-01" },
  { artist: "Taste Of Polonia", venue: "Copernicus Center", date: "2025-09-01" },
  { artist: "Yacht Rock Night", venue: "City Winery", date: "2025-09-01" },
  { artist: "Kane County Cougars", venue: "Medicine Field", date: "2025-09-01" },
  { artist: "Kamil Bednarek", venue: "Copernicus Center", date: "2025-09-01" },
  { artist: "The Second City 65 Anniversary Show", venue: "Second City Chicago", date: "2025-09-01" },
  { artist: "Gary Southshore Railcats", venue: "Steel Yard", date: "2025-09-01" },
  { artist: "Chicago Architecture Center River Cruise Aboard Chicagos First Lady", venue: "Chicagos First Lady", date: "2025-09-01" },
  { artist: "Drunk Shakespeare", venue: "The Lion Theatre", date: "2025-09-01" },
  { artist: "The Extra Shift Show", venue: "Bookclub", date: "2025-09-01" },
  { artist: "Chicago Cubs", venue: "Field", date: "2025-09-02" },
  { artist: "Babymonster", venue: "Allstate Arena", date: "2025-09-02" },
  { artist: "Molly Nilsson", venue: "Empty Bottle", date: "2025-09-02" },
  { artist: "Twenty Sided Tavern", venue: "Broadway Playhouse At Water Tower Place", date: "2025-09-02" },
  { artist: "Lloyd Cole", venue: "City Winery", date: "2025-09-02" },
  { artist: "The Second City Mainstage 113Th Revue", venue: "Second City Chicago", date: "2025-09-02" },
  { artist: "This Too Shall Slap", venue: "Second City Chicago", date: "2025-09-02" },
  { artist: "44   The Unofficial Obama Musical", venue: "Fine Arts Building Chicago", date: "2025-09-02" },
  { artist: "Hokusai Exhibition", venue: "Ellyn Cleve Carney Museum Of Art", date: "2025-09-02" },
  { artist: "Drunk Shakespeare", venue: "The Lion Theatre", date: "2025-09-02" },
  { artist: "Chicago Architecture Center River Cruise Aboard Chicagos First Lady", venue: "Chicagos First Lady", date: "2025-09-02" },
  { artist: "The Red Clay Strays", venue: "Salt Shed", date: "2025-09-03" },
  { artist: "Chicago Cubs", venue: "Field", date: "2025-09-03" },
  { artist: "The Black Keys", venue: "Huntington Bank Pavilion At Northerly Island", date: "2025-09-03" },
  { artist: "Kofi B", venue: "City Winery", date: "2025-09-03" },
  { artist: "Chicago Sky", venue: "Arena", date: "2025-09-03" },
  { artist: "Finn Wolfhard", venue: "Thalia Hall", date: "2025-09-03" },
  { artist: "Red Hot Chilli Pipers   Tribute", venue: "North Shore Center", date: "2025-09-03" },
  { artist: "Come From Away", venue: "Paramount Theatre Aurora", date: "2025-09-03" },
  { artist: "Come From Away", venue: "Paramount Theatre Aurora", date: "2025-09-03" },
  { artist: "Tsushimamire", venue: "Empty Bottle", date: "2025-09-03" },
  { artist: "Glitterfox", venue: "Schubas", date: "2025-09-03" },
  { artist: "Million Dollar Quartet", venue: "Paramount Theatre Aurora", date: "2025-09-03" },
  { artist: "Caskey", venue: "Subterranean", date: "2025-09-03" },
  { artist: "Twenty Sided Tavern", venue: "Broadway Playhouse At Water Tower Place", date: "2025-09-03" },
  { artist: "3L3D3P", venue: "Beat Kitchen", date: "2025-09-03" },
  { artist: "This Too Shall Slap", venue: "Second City Chicago", date: "2025-09-03" },
  { artist: "44   The Unofficial Obama Musical", venue: "Fine Arts Building Chicago", date: "2025-09-03" },
  { artist: "The Second City Mainstage 113Th Revue", venue: "Second City Chicago", date: "2025-09-03" },
  { artist: "Hokusai Exhibition", venue: "Ellyn Cleve Carney Museum Of Art", date: "2025-09-03" },
  { artist: "Drunk Shakespeare", venue: "The Lion Theatre", date: "2025-09-03" },
  { artist: "Chicago Architecture Center River Cruise Aboard Chicagos First Lady", venue: "Chicagos First Lady", date: "2025-09-03" },
  { artist: "The Red Clay Strays", venue: "Salt Shed", date: "2025-09-04" },
  { artist: "Kai", venue: "Rosemont Theatre", date: "2025-09-04" },
  { artist: "K Camp", venue: "Vic Theatre", date: "2025-09-04" },
  { artist: "Cease And Resist", venue: "Cubby Bear", date: "2025-09-04" },
  { artist: "The Steeldrivers", venue: "Thalia Hall", date: "2025-09-04" },
  { artist: "Kip Moore", venue: "Point Bulldog Park", date: "2025-09-04" },
  { artist: "Come From Away", venue: "Paramount Theatre Aurora", date: "2025-09-04" },
  { artist: "The First Lady Of Television", venue: "North Shore Center", date: "2025-09-04" },
  { artist: "Magnolia Boulevard", venue: "Fitzgeralds Berwyn", date: "2025-09-04" },
  { artist: "Mckinley Dixon", venue: "Schubas", date: "2025-09-04" },
  { artist: "Aj Lee And Blue Summit", venue: "Old Town School Of Folk", date: "2025-09-04" },
  { artist: "Bee Gees Gold   A Tribute To The Bee Gees", venue: "Charles Arcada Theatre", date: "2025-09-04" },
  { artist: "Twenty Sided Tavern", venue: "Broadway Playhouse At Water Tower Place", date: "2025-09-04" },
  { artist: "Catch Me If You Can", venue: "Marriott Theatre Lincolnshire", date: "2025-09-04" },
  { artist: "Louden Swain", venue: "Beat Kitchen", date: "2025-09-04" },
  { artist: "The Sideguys   David Sanborn Tribute", venue: "City Winery", date: "2025-09-04" },
  { artist: "The Second City Mainstage 113Th Revue", venue: "Second City Chicago", date: "2025-09-04" },
  { artist: "This Too Shall Slap", venue: "Second City Chicago", date: "2025-09-04" },
  { artist: "Wait Wait Dont Tell Me", venue: "Studebaker Theater", date: "2025-09-04" },
  { artist: "Ryan Hamilton", venue: "Chicago Improv", date: "2025-09-04" },
  { artist: "Alec Flynn", venue: "Zanies Comedy Club Chicago", date: "2025-09-04" },
  { artist: "Da Werst Guise", venue: "Bookclub", date: "2025-09-04" },
  { artist: "The Second City Etc 49Th Revue", venue: "Second City Chicago", date: "2025-09-04" },
  { artist: "Narcotic Wasteland", venue: "Chicago The Wc Social Club", date: "2025-09-04" },
  { artist: "Hokusai Exhibition", venue: "Ellyn Cleve Carney Museum Of Art", date: "2025-09-04" },
  { artist: "Dua Lipa", venue: "United Center", date: "2025-09-05" },
  { artist: "Le Sserafim", venue: "Wintrust Arena", date: "2025-09-05" },
  { artist: "Wwe   World Wrestling Entertainment", venue: "Arena", date: "2025-09-05" },
  { artist: "Northwestern Wildcats Football", venue: "Medicine Field At Martin Stadium", date: "2025-09-06" },
  { artist: "Chris Distefano", venue: "Chicago Theatre", date: "2025-09-05" },
  { artist: "Chicago Cubs", venue: "Field", date: "2025-09-05" },
  { artist: "Pup   The Band", venue: "Salt Shed", date: "2025-09-05" },
  { artist: "Ani Difranco", venue: "Cahn Auditorium", date: "2025-09-05" },
  { artist: "The Beach Boys", venue: "Genesee Theatre", date: "2025-09-05" },
  { artist: "Twrp", venue: "Thalia Hall", date: "2025-09-05" },
  { artist: "Christian French", venue: "Reggies Chicago", date: "2025-09-05" },
  { artist: "Dystinct", venue: "House Of Blues Chicago", date: "2025-09-05" },
  { artist: "The First Lady Of Television", venue: "North Shore Center", date: "2025-09-05" },
  { artist: "Come From Away", venue: "Paramount Theatre Aurora", date: "2025-09-05" },
  { artist: "Million Dollar Quartet", venue: "Paramount Theatre Aurora", date: "2025-09-05" },
  { artist: "The Emo Night Tour", venue: "Bottom Lounge", date: "2025-09-05" },
  { artist: "Kashmir   Led Zeppelin Tribute", venue: "Charles Arcada Theatre", date: "2025-09-05" },
  { artist: "10Cc", venue: "Park West", date: "2025-09-05" },
  { artist: "Catch Me If You Can", venue: "Marriott Theatre Lincolnshire", date: "2025-09-05" },
  { artist: "Nrbq", venue: "Evanston Space", date: "2025-09-05" },
  { artist: "Twenty Sided Tavern", venue: "Broadway Playhouse At Water Tower Place", date: "2025-09-05" },
  { artist: "Erthe St James", venue: "City Winery", date: "2025-09-05" },
  { artist: "Loni Love", venue: "City Winery", date: "2025-09-05" },
  { artist: "Apex Martin", venue: "Sound Bar", date: "2025-09-05" },
  { artist: "Sim Gaming Expo", venue: "Renaissance Schaumburg Convention Center", date: "2025-09-05" },
  { artist: "Dua Lipa", venue: "United Center", date: "2025-09-06" },
  { artist: "Chicago Cubs", venue: "Field", date: "2025-09-06" },
  { artist: "D4Vd", venue: "Salt Shed", date: "2025-09-06" },
  { artist: "Charlie Wilson", venue: "Huntington Bank Pavilion At Northerly Island", date: "2025-09-06" },
  { artist: "Geoff Tate", venue: "Plaines Des Plaines Theatre", date: "2025-09-06" },
  { artist: "Kruder And Dorfmeister", venue: "Auditorium Theatre Chicago", date: "2025-09-06" },
  { artist: "44   The Unofficial Obama Musical", venue: "Fine Arts Building Chicago", date: "2025-09-06" },
  { artist: "Evanston Folk Festival", venue: "Dawes Park", date: "2025-09-06" },
  { artist: "Leonid And Friends", venue: "City Blue Chip Casino", date: "2025-09-06" },
  { artist: "George Porter Jr", venue: "Garcias Chicago", date: "2025-09-06" },
  { artist: "The Miracle In Mundelein", venue: "Rise Dispensary", date: "2025-09-06" },
  { artist: "Wanda Sykes", venue: "Hard Rock Casino Northern Indiana", date: "2025-09-06" },
  { artist: "Lauren Alaina", venue: "The Venue At Horseshoe Casino Hammond", date: "2025-09-06" },
  { artist: "Twenty Sided Tavern", venue: "Broadway Playhouse At Water Tower Place", date: "2025-09-06" },
  { artist: "Caroline Rhea", venue: "North Shore Center", date: "2025-09-06" },
  { artist: "Blue Heaven", venue: "Black Ensemble Theater", date: "2025-09-06" },
  { artist: "Satin Jackets", venue: "Subterranean", date: "2025-09-06" },
  { artist: "Chicago Fire", venue: "Stadium", date: "2025-09-06" },
  { artist: "Nrbq", venue: "Fitzgeralds Berwyn", date: "2025-09-06" },
  { artist: "Moonhole", venue: "Cubby Bear", date: "2025-09-06" },
  { artist: "Talking Sopranos", venue: "Athenaeum Center", date: "2025-09-06" },
  { artist: "Ashland Avenue", venue: "Goodman Theatre", date: "2025-09-06" },
  { artist: "The 30 Party", venue: "House Of Blues Chicago", date: "2025-09-06" },
  { artist: "The Taylor Party   Taylor Swift Tribute", venue: "House Of Blues Chicago", date: "2025-09-06" },
  { artist: "The First Lady Of Television", venue: "North Shore Center", date: "2025-09-06" },
  { artist: "The Who", venue: "United Center", date: "2025-09-07" },
  { artist: "Chicago Bears", venue: "Field", date: "2025-08-01" },
  { artist: "Chicago Cubs", venue: "Field", date: "2025-09-07" },
  { artist: "Eladio Carrion", venue: "Rosemont Theatre", date: "2025-09-07" },
  { artist: "Beach Bunny", venue: "Salt Shed", date: "2025-09-07" },
  { artist: "Doug Benson", venue: "Seatgeek Stadium", date: "2025-09-07" },
  { artist: "Chicago Stars Fc", venue: "Stadium", date: "2025-09-07" },
  { artist: "Rosanne Cash", venue: "Cahn Auditorium", date: "2025-09-07" },
  { artist: "The Miracle In Mundelein", venue: "Rise Dispensary", date: "2025-09-07" },
  { artist: "The First Lady Of Television", venue: "North Shore Center", date: "2025-09-07" },
  { artist: "Ashland Avenue", venue: "Goodman Theatre", date: "2025-09-07" },
  { artist: "Ashland Avenue", venue: "Goodman Theatre", date: "2025-09-07" },
  { artist: "The First Lady Of Television", venue: "North Shore Center", date: "2025-09-07" },
  { artist: "Million Dollar Quartet", venue: "Paramount Theatre Aurora", date: "2025-09-07" },
  { artist: "Bad Planning", venue: "Bottom Lounge", date: "2025-09-07" },
  { artist: "Catch Me If You Can", venue: "Marriott Theatre Lincolnshire", date: "2025-09-07" },
  { artist: "Catch Me If You Can", venue: "Marriott Theatre Lincolnshire", date: "2025-09-07" },
  { artist: "Blanco White", venue: "Subterranean", date: "2025-09-07" },
  { artist: "Twenty Sided Tavern", venue: "Broadway Playhouse At Water Tower Place", date: "2025-09-07" },
  { artist: "Twenty Sided Tavern", venue: "Broadway Playhouse At Water Tower Place", date: "2025-09-07" },
  { artist: "Gettin Grown Podcast", venue: "City Winery", date: "2025-09-07" },
  { artist: "Sim Gaming Expo", venue: "Renaissance Schaumburg Convention Center", date: "2025-09-07" },
  { artist: "Bnxn", venue: "Thalia Hall", date: "2025-09-07" },
  { artist: "Gunhild Carling", venue: "City Winery", date: "2025-09-07" },
  { artist: "The Second City Mainstage 113Th Revue", venue: "Second City Chicago", date: "2025-09-07" },
  { artist: "Chicago Bears", venue: "Field", date: "2026-03-03" },
  { artist: "Clipse", venue: "Salt Shed", date: "2025-09-08" },
  { artist: "Berlioz", venue: "House Of Blues Chicago", date: "2025-09-08" },
  { artist: "Premium Tailgate Party", venue: "Tailgate Lot", date: "2025-09-08" },
  { artist: "Umphreys Mcgee", venue: "Garcias Chicago", date: "2025-09-08" },
  { artist: "Chicago Bears Official Fan Experience Package", venue: "Field", date: "2025-09-08" },
  { artist: "Bonnie Prince Billy", venue: "Evanston Space", date: "2025-09-08" },
  { artist: "Teddys Jams", venue: "City Winery", date: "2025-09-08" },
  { artist: "The Second City 65 Anniversary Show", venue: "Second City Chicago", date: "2025-09-08" },
  { artist: "Drunk Shakespeare", venue: "The Lion Theatre", date: "2025-09-08" },
  { artist: "Cirque Italia   Water Circus", venue: "Northfield Square Mall", date: "2025-09-08" },
  { artist: "Chicago Architecture Center River Cruise Aboard Chicagos First Lady", venue: "Chicagos First Lady", date: "2025-09-08" },
  { artist: "Bonnie Raitt", venue: "Chicago Theatre", date: "2025-09-09" },
  { artist: "Tedeschi Trucks Band", venue: "Huntington Bank Pavilion At Northerly Island", date: "2025-09-09" },
  { artist: "The Who   Rock Band", venue: "United Center", date: "2025-09-09" },
  { artist: "Waxahatchee", venue: "Salt Shed", date: "2025-09-09" },
  { artist: "Supergrass", venue: "Riviera Theatre", date: "2025-09-09" },
  { artist: "Whose Live Anyway", venue: "Harris Theater", date: "2025-09-09" },
  { artist: "Chicago White Sox", venue: "Rate Field", date: "2025-09-09" },
  { artist: "What We Said Live", venue: "Thalia Hall", date: "2025-09-09" },
  { artist: "Fu Manchu", venue: "The Outset", date: "2025-09-09" },
  { artist: "Bonnie Prince Billy", venue: "Evanston Space", date: "2025-09-09" },
  { artist: "Formerly The Fox", venue: "Cubby Bear", date: "2025-09-09" },
  { artist: "The First Lady Of Television", venue: "North Shore Center", date: "2025-09-09" },
  { artist: "Torri Griffin", venue: "City Winery", date: "2025-09-09" },
  { artist: "Twenty Sided Tavern", venue: "Broadway Playhouse At Water Tower Place", date: "2025-09-09" },
  { artist: "Triples", venue: "Vic Theatre", date: "2025-09-09" },
  { artist: "44   The Unofficial Obama Musical", venue: "Fine Arts Building Chicago", date: "2025-09-09" },
  { artist: "This Too Shall Slap", venue: "Second City Chicago", date: "2025-09-09" },
  { artist: "The Second City Mainstage 113Th Revue", venue: "Second City Chicago", date: "2025-09-09" },
  { artist: "Chicago Architecture Center River Cruise Aboard Chicagos First Lady", venue: "Chicagos First Lady", date: "2025-09-09" },
  { artist: "Drunk Shakespeare", venue: "The Lion Theatre", date: "2025-09-09" },
  { artist: "Hokusai Exhibition", venue: "Ellyn Cleve Carney Museum Of Art", date: "2025-09-09" },
  { artist: "Wet Leg", venue: "Salt Shed", date: "2025-09-10" },
  { artist: "Tv On The Radio", venue: "Riviera Theatre", date: "2025-09-10" },
  { artist: "Ringo Starr And His All Starr Band", venue: "Chicago Theatre", date: "2025-09-10" },
  { artist: "Chicago White Sox", venue: "Rate Field", date: "2025-09-10" },
  { artist: "Roger Mcguinn", venue: "North Shore Center", date: "2025-09-10" },
  { artist: "Doobie Brothers", venue: "Park Credit Union 1 Amphitheatre", date: "2025-09-10" },
  { artist: "Wisp", venue: "Metro Chicago", date: "2025-09-10" },
  { artist: "Saliva", venue: "The Vixen", date: "2025-09-10" },
  { artist: "Ashland Avenue", venue: "Goodman Theatre", date: "2025-09-10" },
  { artist: "Catch Me If You Can", venue: "Marriott Theatre Lincolnshire", date: "2025-09-10" },
  { artist: "The First Lady Of Television", venue: "North Shore Center", date: "2025-09-10" },
  { artist: "The First Lady Of Television", venue: "North Shore Center", date: "2025-09-10" },
  { artist: "Delvon Lamarr Organ Trio", venue: "Evanston Space", date: "2025-09-10" },
  { artist: "Delvon Lamarr Organ Trio", venue: "Evanston Space", date: "2025-09-10" },
  { artist: "Twenty Sided Tavern", venue: "Broadway Playhouse At Water Tower Place", date: "2025-09-10" },
  { artist: "Molly Tuttle", venue: "Thalia Hall", date: "2025-09-10" },
  { artist: "Castle Rat", venue: "Reggies Chicago", date: "2025-09-10" },
    { artist: "Infinite 80S   Tribute", venue: "City Winery", date: "2025-09-10" },
  { artist: "The Second City Mainstage 113Th Revue", venue: "Second City Chicago", date: "2025-09-10" },
  { artist: "This Too Shall Slap", venue: "Second City Chicago", date: "2025-09-10" },
  { artist: "44   The Unofficial Obama Musical", venue: "Fine Arts Building Chicago", date: "2025-09-10" },
  { artist: "Chicago Architecture Center River Cruise Aboard Chicagos First Lady", venue: "Chicagos First Lady", date: "2025-09-10" },
  { artist: "Drunk Shakespeare", venue: "The Lion Theatre", date: "2025-09-10" },
  { artist: "Hokusai Exhibition", venue: "Ellyn Cleve Carney Museum Of Art", date: "2025-09-10" },
  { artist: "Chicago Sky", venue: "Arena", date: "2025-09-11" },
  { artist: "The Story So Far", venue: "Salt Shed", date: "2025-09-11" },
  { artist: "Marcin   Marcin Patrzalek", venue: "Park West", date: "2025-09-11" },
  { artist: "The 502S", venue: "Riviera Theatre", date: "2025-09-11" },
  { artist: "Noah Reid", venue: "Vic Theatre", date: "2025-09-11" },
  { artist: "Chicago White Sox", venue: "Rate Field", date: "2025-09-11" },
  { artist: "Hazlett", venue: "House Of Blues Chicago", date: "2025-09-11" },
  { artist: "Tee Grizzley", venue: "Avondale Music Hall", date: "2025-09-11" },
  { artist: "Catch Me If You Can", venue: "Marriott Theatre Lincolnshire", date: "2025-09-11" },
  { artist: "Brooks Nielsen", venue: "Metro Chicago", date: "2025-09-11" },
  { artist: "Night Moves", venue: "Thalia Hall", date: "2025-09-11" },
  { artist: "Tropa Magica", venue: "Subterranean", date: "2025-09-11" },
  { artist: "Ashland Avenue", venue: "Goodman Theatre", date: "2025-09-11" },
  { artist: "Paul Thorn", venue: "Fitzgeralds Berwyn", date: "2025-09-11" },
  { artist: "Million Dollar Quartet", venue: "Paramount Theatre Aurora", date: "2025-09-11" },
  { artist: "We Are Scientists", venue: "Empty Bottle", date: "2025-09-11" },
  { artist: "Age Of Madness", venue: "Bottom Lounge", date: "2025-09-11" },
  { artist: "Free Fallin   Tom Petty Tribute", venue: "Charles Arcada Theatre", date: "2025-09-11" },
  { artist: "Nikita Nichelle", venue: "City Winery", date: "2025-09-11" },
  { artist: "Darius", venue: "Concord Music Hall", date: "2025-09-11" },
  { artist: "Twenty Sided Tavern", venue: "Broadway Playhouse At Water Tower Place", date: "2025-09-11" },
  { artist: "Bridget Mcguire", venue: "Zanies Comedy Club Rosemont", date: "2025-09-11" },
  { artist: "The Woggles", venue: "Reggies Chicago", date: "2025-09-11" },
  { artist: "The Second City Mainstage 113Th Revue", venue: "Second City Chicago", date: "2025-09-11" },
  { artist: "This Too Shall Slap", venue: "Second City Chicago", date: "2025-09-11" },
  { artist: "Chicago Cubs", venue: "Field", date: "2025-09-12" },
  { artist: "Yungblud", venue: "Riviera Theatre", date: "2025-09-12" },
  { artist: "Yousuke Yukimatsu", venue: "Ramova Theatre", date: "2025-09-12" },
  { artist: "Howard Jones", venue: "Plaines Rivers Casino Des Plaines", date: "2025-09-12" },
  { artist: "Mchenry Music Festival", venue: "Petersen Park", date: "2025-09-12" },
  { artist: "Haim", venue: "United Center", date: "2025-09-12" },
  { artist: "Elevation Rhythm", venue: "Vic Theatre", date: "2025-09-12" },
  { artist: "Eden Munoz", venue: "Rosemont Theatre", date: "2025-09-12" },
  { artist: "Gabby Barrett", venue: "Valparaiso Central Park Plaza", date: "2025-09-12" },
  { artist: "Vitamin String Quartet", venue: "North Shore Center", date: "2025-09-12" },
  { artist: "Jeopardy", venue: "Chicago Theatre", date: "2025-09-12" },
  { artist: "Monster Jam", venue: "Arena", date: "2025-09-12" },
  { artist: "Waylon Wyatt", venue: "Joes On Weed Street", date: "2025-09-12" },
  { artist: "Mirador", venue: "Metro Chicago", date: "2025-09-12" },
  { artist: "Mariachi Vargas De Tecalitlan", venue: "Auditorium Theatre Chicago", date: "2025-09-12" },
  { artist: "Slow Crush", venue: "Reggies Chicago", date: "2025-09-12" },
  { artist: "Bob   Bobby Ray Simmons Jr", venue: "House Of Blues Chicago", date: "2025-09-12" },
  { artist: "Sidepiece", venue: "Recess", date: "2025-09-12" },
  { artist: "Deon Cole", venue: "Hard Rock Casino Northern Indiana", date: "2025-09-12" },
  { artist: "Ixnay   Offspring Tribute Band", venue: "Chicago The Wc Social Club", date: "2025-09-12" },
  { artist: "Paul Thorn", venue: "Fitzgeralds Berwyn", date: "2025-09-12" },
  { artist: "Million Dollar Quartet", venue: "Paramount Theatre Aurora", date: "2025-09-12" },
  { artist: "The First Lady Of Television", venue: "North Shore Center", date: "2025-09-12" },
  { artist: "Ashland Avenue", venue: "Goodman Theatre", date: "2025-09-12" },
  { artist: "Nature Tv", venue: "Schubas", date: "2025-09-12" },
  { artist: "Jason Aldean", venue: "Park Credit Union 1 Amphitheatre", date: "2025-09-13" },
  { artist: "Northwestern Wildcats Football", venue: "Medicine Field At Martin Stadium", date: "2025-06-03" },
  { artist: "Chicago Cubs", venue: "Field", date: "2025-09-13" },
  { artist: "Monster Jam", venue: "Arena", date: "2025-09-13" },
  { artist: "Mojo Brookzz   Dyon Brooks", venue: "Chicago Theatre", date: "2025-09-13" },
  { artist: "Mt Joy", venue: "United Center", date: "2025-09-13" },
  { artist: "Mchenry Music Festival", venue: "Petersen Park", date: "2025-09-13" },
  { artist: "Staind", venue: "Hard Rock Casino Northern Indiana", date: "2025-09-13" },
  { artist: "Luann De Lesseps", venue: "Vic Theatre", date: "2025-09-13" },
  { artist: "Cmat", venue: "Park West", date: "2025-09-13" },
  { artist: "Chicago Fire", venue: "Field", date: "2025-09-13" },
  { artist: "Little Brother", venue: "Metro Chicago", date: "2025-09-13" },
  { artist: "Amira Elfeky", venue: "Cobra Lounge", date: "2025-09-13" },
  { artist: "Monster Jam", venue: "Arena", date: "2025-09-13" },
  { artist: "Chicago Philharmonic Orchestra", venue: "Auditorium Theatre Chicago", date: "2025-09-13" },
  { artist: "Rememories", venue: "Cubby Bear", date: "2025-09-13" },
  { artist: "Frankie Cosmos", venue: "Thalia Hall", date: "2025-09-13" },
  { artist: "Head East", venue: "Plaines Des Plaines Theatre", date: "2025-09-13" },
  { artist: "Ray Wylie Hubbard", venue: "Fitzgeralds Berwyn", date: "2025-09-13" },
  { artist: "Paul Cebar Tomorrow Sound", venue: "Fitzgeralds Berwyn", date: "2025-09-13" },
  { artist: "Ashland Avenue", venue: "Goodman Theatre", date: "2025-09-13" },
  { artist: "The First Lady Of Television", venue: "North Shore Center", date: "2025-09-13" },
  { artist: "Cozy Worldwide", venue: "House Of Blues Chicago", date: "2025-08-22" },
  { artist: "Ashland Avenue", venue: "Goodman Theatre", date: "2025-09-13" },
  { artist: "The First Lady Of Television", venue: "North Shore Center", date: "2025-09-13" },
  { artist: "Chicago Cubs", venue: "Field", date: "2025-09-14" },
  { artist: "Conan Gray", venue: "Park Credit Union 1 Amphitheatre", date: "2025-09-14" },
  { artist: "Mudvayne", venue: "Byline Bank Aragon Ballroom", date: "2025-09-14" },
  { artist: "Monster Jam", venue: "Arena", date: "2025-09-14" },
  { artist: "Alan Parsons Live Project", venue: "Genesee Theatre", date: "2025-09-14" },
  { artist: "The Boyz", venue: "Chicago Theatre", date: "2025-09-14" },
  { artist: "Mchenry Music Festival", venue: "Petersen Park", date: "2025-09-11" },
  { artist: "Geordie Greep", venue: "Metro Chicago", date: "2025-09-14" },
  { artist: "Monster Jam", venue: "Arena", date: "2025-09-14" },
  { artist: "Chicago Stars Fc", venue: "Stadium", date: "2025-09-14" },
  { artist: "Hamza Namira", venue: "Thalia Hall", date: "2025-09-14" },
  { artist: "The Screwtape Letters", venue: "Athenaeum Center", date: "2025-09-14" },
  { artist: "Vola", venue: "Lincoln Hall", date: "2025-09-14" },
  { artist: "Odisseo", venue: "Avondale Music Hall", date: "2025-09-14" },
  { artist: "Ashland Avenue", venue: "Goodman Theatre", date: "2025-09-14" },
  { artist: "Million Dollar Quartet", venue: "Paramount Theatre Aurora", date: "2025-09-14" },
  { artist: "The First Lady Of Television", venue: "North Shore Center", date: "2025-09-14" },
  { artist: "Louie Thesinger", venue: "House Of Blues Chicago", date: "2025-09-14" },
  { artist: "Illinois Rock And Roll Museum Hall Of Fame Induction Ceremony", venue: "Rialto Square Theatre", date: "2025-09-14" },
  { artist: "Million Dollar Quartet", venue: "Paramount Theatre Aurora", date: "2025-09-14" },
  { artist: "Ivri", venue: "Schubas", date: "2025-09-14" },
  { artist: "Catch Me If You Can", venue: "Marriott Theatre Lincolnshire", date: "2025-09-14" },
  { artist: "Kid Congo Powers", venue: "Beat Kitchen", date: "2025-09-14" },
  { artist: "Nick Pontarelli Band", venue: "Charles Arcada Theatre", date: "2025-09-14" },
  { artist: "Catch Me If You Can", venue: "Marriott Theatre Lincolnshire", date: "2025-09-14" },
  { artist: "Lady Gaga", venue: "United Center", date: "2025-09-15" },
  { artist: "Pixies", venue: "Salt Shed", date: "2025-09-15" },
  { artist: "Chicago White Sox", venue: "Rate Field", date: "2025-09-15" },
  { artist: "Se So Neon", venue: "Metro Chicago", date: "2025-09-15" },
  { artist: "Yeule", venue: "The Outset", date: "2025-09-15" },
  { artist: "X Ambassadors", venue: "Vic Theatre", date: "2025-09-15" },
  { artist: "Daisy The Great", venue: "Subterranean", date: "2025-09-15" },
  { artist: "Funkadesi", venue: "City Winery", date: "2025-09-15" },
  { artist: "The Second City 65 Anniversary Show", venue: "Second City Chicago", date: "2025-09-15" },
  { artist: "Chicago Architecture Center River Cruise Aboard Chicagos First Lady", venue: "Chicagos First Lady", date: "2025-09-15" },
  { artist: "Drunk Shakespeare", venue: "The Lion Theatre", date: "2025-09-15" },
  { artist: "Plantasia", venue: "Garfield Park Conservatory", date: "2025-09-15" },
  { artist: "Jackson T Stephens Cup", venue: "Shoreacres", date: "2025-09-15" },
  { artist: "Jackson T Stephens Cup", venue: "Shoreacres", date: "2025-09-15" },
  { artist: "Shoreline Mafia", venue: "Riviera Theatre", date: "2025-09-16" },
  { artist: "Chicago White Sox", venue: "Rate Field", date: "2025-09-16" },
  { artist: "The Waterboys", venue: "Thalia Hall", date: "2025-09-16" },
  { artist: "The Hellp", venue: "Vic Theatre", date: "2025-09-16" },
  { artist: "Amble", venue: "Bottom Lounge", date: "2025-09-16" },
  { artist: "Lea Salonga", venue: "Athenaeum Center", date: "2025-09-16" },
  { artist: "Billy Bob Thornton", venue: "Joes Live Rosemont", date: "2025-09-16" },
  { artist: "Kula Shaker", venue: "Metro Chicago", date: "2025-09-16" },
  { artist: "Hunx And His Punx", venue: "Empty Bottle", date: "2025-09-16" },
  { artist: "Fruition", venue: "Evanston Space", date: "2025-09-16" },
  { artist: "Jazz Emu", venue: "Lincoln Hall", date: "2025-09-16" },
  { artist: "Nihilistic Easyrider", venue: "Subterranean", date: "2025-09-16" },
  { artist: "Twenty Sided Tavern", venue: "Broadway Playhouse At Water Tower Place", date: "2025-09-16" },
  { artist: "Sandy Redd", venue: "City Winery", date: "2025-09-16" },
  { artist: "Duckwrth", venue: "The Promontory", date: "2025-09-16" },
  { artist: "44   The Unofficial Obama Musical", venue: "Fine Arts Building Chicago", date: "2025-09-16" },
  { artist: "This Too Shall Slap", venue: "Second City Chicago", date: "2025-09-16" },
  { artist: "The Second City Mainstage 113Th Revue", venue: "Second City Chicago", date: "2025-09-16" },
  { artist: "Liliac", venue: "Dundee Rochaus", date: "2025-09-16" },
  { artist: "Hokusai Exhibition", venue: "Ellyn Cleve Carney Museum Of Art", date: "2025-09-16" },
  { artist: "Drunk Shakespeare", venue: "The Lion Theatre", date: "2025-09-16" },
  { artist: "Jackson T Stephens Cup", venue: "Shoreacres", date: "2025-09-16" },
  { artist: "Kelsey Waldon", venue: "Garcias Chicago", date: "2025-09-16" },
  { artist: "Chicago Architecture Center River Cruise Aboard Chicagos First Lady", venue: "Chicagos First Lady", date: "2025-09-16" },
  { artist: "Micro Wrestling Federation", venue: "Vegas Saloon", date: "2025-09-16" },
  { artist: "Lady Gaga", venue: "United Center", date: "2025-09-17" },
  { artist: "Alex G   Alexander Giannascoli", venue: "Salt Shed", date: "2025-09-17" },
  { artist: "Spacey Jane", venue: "Lake City The Complex", date: "2025-09-17" },
  { artist: "Chicago White Sox", venue: "Rate Field", date: "2025-09-17" },
  { artist: "Lea Salonga", venue: "Athenaeum Center", date: "2025-09-17" },
  { artist: "Steven Wilson", venue: "Auditorium Theatre Chicago", date: "2025-09-17" },
  { artist: "Foxwarren", venue: "Thalia Hall", date: "2025-09-17" },
  { artist: "Dorothy", venue: "House Of Blues Chicago", date: "2025-09-17" },
  { artist: "The Damned", venue: "Vic Theatre", date: "2025-09-17" },
  { artist: "The First Lady Of Television", venue: "North Shore Center", date: "2025-09-17" },
  { artist: "The First Lady Of Television", venue: "North Shore Center", date: "2025-09-17" },
  { artist: "Peach Prc", venue: "Bottom Lounge", date: "2025-09-17" },
  { artist: "Million Dollar Quartet", venue: "Paramount Theatre Aurora", date: "2025-09-17" },
  { artist: "Grease", venue: "Heights Metropolis Performing Arts Centre", date: "2025-09-17" },
  { artist: "Raiders Of The Lost Ark", venue: "Woodstock Opera House", date: "2025-09-17" },
  { artist: "Firetalkrecs", venue: "Empty Bottle", date: "2025-09-17" },
  { artist: "Catch Me If You Can", venue: "Marriott Theatre Lincolnshire", date: "2025-09-17" },
  { artist: "Catch Me If You Can", venue: "Marriott Theatre Lincolnshire", date: "2025-09-17" },
  { artist: "Andy And Shani", venue: "Copernicus Center", date: "2025-09-17" },
  { artist: "Shahar", venue: "City Winery", date: "2025-09-17" },
  { artist: "Twenty Sided Tavern", venue: "Broadway Playhouse At Water Tower Place", date: "2025-09-17" },
  { artist: "The Second City Mainstage 113Th Revue", venue: "Second City Chicago", date: "2025-09-17" },
  { artist: "This Too Shall Slap", venue: "Second City Chicago", date: "2025-09-17" },
  { artist: "44   The Unofficial Obama Musical", venue: "Fine Arts Building Chicago", date: "2025-09-17" },
  { artist: "Baths", venue: "Sleeping Village", date: "2025-09-17" },
  { artist: "Lady Gaga", venue: "United Center", date: "2025-09-18" },
  { artist: "Tom Odell", venue: "Vic Theatre", date: "2025-09-23" },
  { artist: "Viagra Boys", venue: "Salt Shed", date: "2025-09-18" },
  { artist: "Susto", venue: "Garcias Chicago", date: "2025-09-18" },
  { artist: "Spacey Jane", venue: "Metro Chicago", date: "2025-09-18" },
  { artist: "Nxworries", venue: "Riviera Theatre", date: "2025-09-18" },
  { artist: "Smokedope2016", venue: "Avondale Music Hall", date: "2025-09-18" },
  { artist: "Tophouse", venue: "Park West", date: "2025-09-18" },
  { artist: "Catch Me If You Can", venue: "Marriott Theatre Lincolnshire", date: "2025-09-18" },
  { artist: "Ashland Avenue", venue: "Goodman Theatre", date: "2025-09-18" },
  { artist: "The Cactus Blossoms", venue: "Fitzgeralds Berwyn", date: "2025-09-18" },
  { artist: "Joffrey Ballet", venue: "Lyric Opera House", date: "2025-09-18" },
  { artist: "Ashland Avenue", venue: "Goodman Theatre", date: "2025-09-18" },
  { artist: "The First Lady Of Television", venue: "North Shore Center", date: "2025-09-18" },
  { artist: "Chicago Symphony Orchestra", venue: "Chicago Symphony Center", date: "2025-09-18" },
  { artist: "Guerilla Toss", venue: "Empty Bottle", date: "2025-09-18" },
  { artist: "Knuckle Puck", venue: "Bottom Lounge", date: "2025-09-18" },
  { artist: "Grease", venue: "Heights Metropolis Performing Arts Centre", date: "2025-09-18" },
  { artist: "Harf", venue: "Subterranean", date: "2025-09-18" },
  { artist: "Yaya Bey", venue: "Lincoln Hall", date: "2025-09-18" },
  { artist: "Walter Trout", venue: "Evanston Space", date: "2025-09-18" },
  { artist: "Mac Sabbath", venue: "Reggies Chicago", date: "2025-09-18" },
  { artist: "Twenty Sided Tavern", venue: "Broadway Playhouse At Water Tower Place", date: "2025-09-18" },
  { artist: "Walter Trout", venue: "Evanston Space", date: "2025-09-18" },
  { artist: "The Baseball Project   Band", venue: "Thalia Hall", date: "2025-09-18" },
  { artist: "Lorde", venue: "United Center", date: "2025-09-19" },
  { artist: "Luke Bryan", venue: "Grove Berning Family Farms", date: "2025-08-19" },
  { artist: "Riot Fest", venue: "Douglass Park", date: "2025-09-19" },
  { artist: "Riot Fest", venue: "Douglass Park", date: "2025-09-19" },
  { artist: "Big Wild", venue: "Salt Shed", date: "2025-09-19" },
  { artist: "Chris Stussy", venue: "Radius Chicago", date: "2025-09-19" },
  { artist: "Che", venue: "Avondale Music Hall", date: "2025-09-19" },
  { artist: "Quinn Xcii", venue: "Huntington Bank Pavilion At Northerly Island", date: "2025-09-19" },
  { artist: "Chicago White Sox", venue: "Rate Field", date: "2025-09-19" },
  { artist: "Loverboy", venue: "Charles Arcada Theatre", date: "2025-09-19" },
  { artist: "The Front Bottoms", venue: "Bottom Lounge", date: "2025-09-19" },
  { artist: "Leonid And Friends", venue: "North Shore Center", date: "2025-09-19" },
  { artist: "Christone Kingfish Ingram", venue: "Park West", date: "2025-09-19" },
  { artist: "Steven Curtis Chapman", venue: "Lake Willow Creek Community Church", date: "2025-09-19" },
  { artist: "Hokus Pokus Live", venue: "Riviera Theatre", date: "2025-09-19" },
  { artist: "Sextile", venue: "The Outset", date: "2025-09-19" },
  { artist: "Blessthefall", venue: "House Of Blues Chicago", date: "2025-09-19" },
  { artist: "George Janko", venue: "Athenaeum Center", date: "2025-09-19" },
  { artist: "Joffrey Ballet", venue: "Lyric Opera House", date: "2025-09-19" },
  { artist: "Uncle Lucius", venue: "Fitzgeralds Berwyn", date: "2025-09-19" },
  { artist: "Ashland Avenue", venue: "Goodman Theatre", date: "2025-09-19" },
  { artist: "Chicago Symphony Orchestra", venue: "Chicago Symphony Center", date: "2025-09-19" },
  { artist: "Million Dollar Quartet", venue: "Paramount Theatre Aurora", date: "2025-09-19" },
  { artist: "The First Lady Of Television", venue: "North Shore Center", date: "2025-09-19" },
  { artist: "Walk Off The Earth", venue: "Genesee Theatre", date: "2025-09-19" },
  { artist: "Ethel Cain", venue: "Salt Shed", date: "2025-09-20" },
  { artist: "Ramon Ayala", venue: "Allstate Arena", date: "2025-09-20" },
  { artist: "Goose", venue: "Huntington Bank Pavilion At Northerly Island", date: "2025-09-20" },
  { artist: "The Academy Is", venue: "Concord Music Hall", date: "2025-09-20" },
  { artist: "Alkaline Trio", venue: "Metro Chicago", date: "2025-09-20" },
  { artist: "Chicago White Sox", venue: "Rate Field", date: "2025-09-20" },
  { artist: "Wardruna", venue: "Auditorium Theatre Chicago", date: "2025-09-20" },
  { artist: "Riot Fest", venue: "Douglass Park", date: "2025-09-20" },
  { artist: "Lee Brice", venue: "Rosemont Theatre", date: "2025-09-20" },
  { artist: "Tacos And Tequila Festival", venue: "Northwestern Medicine Field", date: "2025-09-20" },
  { artist: "Atif Aslam", venue: "Arie Crown Theater", date: "2025-09-20" },
  { artist: "Leonid And Friends", venue: "Charles Arcada Theatre", date: "2025-09-20" },
  { artist: "Joffrey Ballet", venue: "Lyric Opera House", date: "2025-09-20" },
  { artist: "Riot Fest", venue: "Douglass Park", date: "2025-09-20" },
  { artist: "Esteriore Brothers", venue: "Copernicus Center", date: "2025-09-20" },
  { artist: "Arnez J", venue: "Chicago Improv", date: "2025-09-20" },
  { artist: "Jessica Simpson", venue: "Genesee Theatre", date: "2025-09-20" },
  { artist: "Gary Gulman", venue: "Athenaeum Center", date: "2025-09-20" },
  { artist: "Dial M For Murder", venue: "Terrace Drury Lane Theatre Oakbrook Terrace", date: "2025-09-20" },
  { artist: "Dial M For Murder", venue: "Terrace Drury Lane Theatre Oakbrook Terrace", date: "2025-09-20" },
  { artist: "Kavita Krishnamurthy", venue: "Hard Rock Casino Northern Indiana", date: "2025-09-20" },
  { artist: "Grease", venue: "Heights Metropolis Performing Arts Centre", date: "2025-09-20" },
  { artist: "Wiz Khalifa", venue: "Amphitheater At Founders Square", date: "2025-09-20" },
  { artist: "Badshah", venue: "Estates Now Arena", date: "2025-09-20" },
  { artist: "Joffrey Ballet", venue: "Lyric Opera House", date: "2025-09-20" },
  { artist: "Chicago Bears", venue: "Field", date: "2026-03-04" },
  { artist: "Txt   Tomorrow X Together", venue: "Allstate Arena", date: "2025-09-21" },
  { artist: "Riot Fest", venue: "Douglass Park", date: "2025-09-21" },
  { artist: "Prof", venue: "Vic Theatre", date: "2025-09-21" },
  { artist: "Chicago White Sox", venue: "Rate Field", date: "2025-09-21" },
  { artist: "Chicago Bears Official Fan Experience Package", venue: "Field", date: "2025-09-21" },
  { artist: "Hoda Kotb", venue: "Athenaeum Center", date: "2025-09-21" },
  { artist: "Premium Tailgate Party", venue: "Tailgate Lot", date: "2025-09-21" },
  { artist: "Dial M For Murder", venue: "Terrace Drury Lane Theatre Oakbrook Terrace", date: "2025-09-21" },
  { artist: "Beherit", venue: "Dundee Rochaus", date: "2025-09-21" },
  { artist: "Los Amigos Invisibles", venue: "The Outset", date: "2025-09-21" },
  { artist: "Joffrey Ballet", venue: "Lyric Opera House", date: "2025-09-21" },
  { artist: "Ashland Avenue", venue: "Goodman Theatre", date: "2025-09-21" },
  { artist: "Les Greene And The Swayzees", venue: "Fitzgeralds Berwyn", date: "2025-09-21" },
  { artist: "Les Greene And The Swayzees", venue: "Fitzgeralds Berwyn", date: "2025-09-21" },
  { artist: "Marky Ramone", venue: "Metro Chicago", date: "2025-09-21" },
  { artist: "The First Lady Of Television", venue: "North Shore Center", date: "2025-09-21" },
  { artist: "Svyatoslav Vakarchuks", venue: "North Shore Center", date: "2025-09-21" },
  { artist: "Grease", venue: "Heights Metropolis Performing Arts Centre", date: "2025-09-21" },
  { artist: "Million Dollar Quartet", venue: "Paramount Theatre Aurora", date: "2025-09-21" },
  { artist: "Andrey Makarevich", venue: "North Shore Center", date: "2025-09-21" },
  { artist: "Debby Boone", venue: "Charles Arcada Theatre", date: "2025-09-21" },
  { artist: "Country Royalty", venue: "Charles Arcada Theatre", date: "2025-09-21" },
  { artist: "Country Royalty", venue: "Charles Arcada Theatre", date: "2025-09-21" },
  { artist: "Didjits", venue: "Empty Bottle", date: "2025-09-21" },
  { artist: "Kali Uchis", venue: "United Center", date: "2025-09-22" },
  { artist: "Polo And Pan", venue: "Salt Shed", date: "2025-09-22" },
  { artist: "Txt   Tomorrow X Together", venue: "Allstate Arena", date: "2025-09-22" },
  { artist: "Nourished By Time", venue: "Lincoln Hall", date: "2025-09-22" },
  { artist: "Brian Jonestown Massacre", venue: "Metro Chicago", date: "2025-09-22" },
  { artist: "The Seven Wonders   Tribute To Fleetwood Mac", venue: "City Winery", date: "2025-09-22" },
  { artist: "The Second City 65 Anniversary Show", venue: "Second City Chicago", date: "2025-09-22" },
  { artist: "Drunk Shakespeare", venue: "The Lion Theatre", date: "2025-09-22" },
  { artist: "Chicago Architecture Center River Cruise Aboard Chicagos First Lady", venue: "Chicagos First Lady", date: "2025-09-22" },
  { artist: "Kali Uchis", venue: "United Center", date: "2025-09-23" },
  { artist: "Chicago Cubs", venue: "Field", date: "2025-09-23" },
  { artist: "Deltron 3030", venue: "House Of Blues Chicago", date: "2025-09-23" },
  { artist: "Bandalos Chinos", venue: "Thalia Hall", date: "2025-09-23" },
  { artist: "Emotional Oranges", venue: "Riviera Theatre", date: "2025-09-23" },
  { artist: "James Marriott", venue: "Bottom Lounge", date: "2025-09-23" },
  { artist: "Isabella Lovestory", venue: "Subterranean", date: "2025-09-23" },
  { artist: "Issa Rae", venue: "Chicago Theatre", date: "2025-09-23" },
  { artist: "Ashland Avenue", venue: "Goodman Theatre", date: "2025-09-23" },
  { artist: "The Super Carlin Brothers", venue: "City Winery", date: "2025-09-23" },
  { artist: "Twenty Sided Tavern", venue: "Broadway Playhouse At Water Tower Place", date: "2025-09-23" },
  { artist: "Radio Free Alice", venue: "Schubas", date: "2025-09-23" },
  { artist: "The Second City Mainstage 113Th Revue", venue: "Second City Chicago", date: "2025-09-23" },
  { artist: "This Too Shall Slap", venue: "Second City Chicago", date: "2025-09-23" },
  { artist: "He Is Legend", venue: "The Forge Joliet", date: "2025-09-23" },
  { artist: "Rome Sweet Rome", venue: "Chicago Shakespeare Theatre", date: "2025-09-23" },
  { artist: "Chicago Architecture Center River Cruise Aboard Chicagos First Lady", venue: "Chicagos First Lady", date: "2025-09-23" },
  { artist: "Drunk Shakespeare", venue: "The Lion Theatre", date: "2025-09-23" },
  { artist: "Nba Youngboy", venue: "United Center", date: "2025-09-24" },
  { artist: "Twenty One Pilots", venue: "Park Credit Union 1 Amphitheatre", date: "2025-09-24" },
  { artist: "Chicago Cubs", venue: "Field", date: "2025-09-24" },
  { artist: "Se Regalan Dudas Podcast", venue: "House Of Blues Chicago", date: "2025-09-24" },
  { artist: "Ethan Regan", venue: "Lincoln Hall", date: "2025-09-24" },
  { artist: "Gillian Welch", venue: "Auditorium Theatre Chicago", date: "2025-09-24" },
  { artist: "Ashland Avenue", venue: "Goodman Theatre", date: "2025-09-24" },
  { artist: "The First Lady Of Television", venue: "North Shore Center", date: "2025-09-24" },
  { artist: "The First Lady Of Television", venue: "North Shore Center", date: "2025-09-24" },
  { artist: "Barstool Sports", venue: "Joes On Weed", date: "2025-09-24" },
  { artist: "The Dreggs", venue: "Schubas", date: "2025-09-24" },
  { artist: "Northwestern Wildcats Womens Volleyball", venue: "Ryan Arena", date: "2025-09-24" },
  { artist: "God Save The Queen   Queen Tribute", venue: "Charles Arcada Theatre", date: "2025-09-24" },
  { artist: "Vision Video", venue: "Bottom Lounge", date: "2025-09-24" },
  { artist: "Bass Drum Of Death", venue: "Beat Kitchen", date: "2025-09-24" },
  { artist: "Catch Me If You Can", venue: "Marriott Theatre Lincolnshire", date: "2025-09-24" },
  { artist: "Catch Me If You Can", venue: "Marriott Theatre Lincolnshire", date: "2025-09-24" },
  { artist: "Spanish Love Songs", venue: "Subterranean", date: "2025-09-24" },
  { artist: "Palmyra", venue: "Evanston Space", date: "2025-09-24" },
  { artist: "Twenty Sided Tavern", venue: "Broadway Playhouse At Water Tower Place", date: "2025-09-24" },
  { artist: "Taco", venue: "City Winery", date: "2025-09-24" },
  { artist: "This Too Shall Slap", venue: "Second City Chicago", date: "2025-09-24" },
  { artist: "The Second City Mainstage 113Th Revue", venue: "Second City Chicago", date: "2025-09-24" },
  { artist: "Nation Of Language", venue: "Thalia Hall", date: "2025-09-24" },
  { artist: "Ava The Secret Conversations", venue: "Fine Arts Building Chicago", date: "2025-09-24" },
  { artist: "Keith Urban", venue: "United Center", date: "2025-09-25" },
  { artist: "Chicago Cubs", venue: "Field", date: "2025-09-25" },
  { artist: "Louis Ck", venue: "Chicago Theatre", date: "2025-09-25" },
  { artist: "Deltron 3030", venue: "House Of Blues Chicago", date: "2025-09-25" },
  { artist: "Sam Fender", venue: "Byline Bank Aragon Ballroom", date: "2025-09-25" },
  { artist: "Renee Rapp", venue: "Allstate Arena", date: "2025-09-25" },
  { artist: "Ken Burns", venue: "Auditorium Theatre Chicago", date: "2025-09-25" },
  { artist: "Joffrey Ballet", venue: "Lyric Opera House", date: "2025-09-25" },
  { artist: "Jefferson Starship", venue: "Charles Arcada Theatre", date: "2025-09-25" },
  { artist: "Panda Bear", venue: "Thalia Hall", date: "2025-09-25" },
  { artist: "Big Jay Oakerson", venue: "Chicago Improv", date: "2025-09-25" },
  { artist: "Wait Wait Dont Tell Me", venue: "Studebaker Theater", date: "2025-09-25" },
  { artist: "The Last Revel", venue: "Garcias Chicago", date: "2025-09-25" },
  { artist: "Kashmir   Led Zeppelin Tribute", venue: "Plaines Des Plaines Theatre", date: "2025-09-25" },
  { artist: "Ashland Avenue", venue: "Goodman Theatre", date: "2025-09-25" },
  { artist: "The First Lady Of Television", venue: "North Shore Center", date: "2025-09-25" },
  { artist: "Anamanaguchi", venue: "Metro Chicago", date: "2025-09-25" },
  { artist: "Ashland Avenue", venue: "Goodman Theatre", date: "2025-09-25" },
  { artist: "Million Dollar Quartet", venue: "Paramount Theatre Aurora", date: "2025-09-25" },
  { artist: "Chicago Symphony Orchestra", venue: "Chicago Symphony Center", date: "2025-09-25" },
  { artist: "Divorce", venue: "Schubas", date: "2025-09-25" },
  { artist: "Grease", venue: "Heights Metropolis Performing Arts Centre", date: "2025-09-25" },
  { artist: "Hunter Hayes", venue: "Genesee Theatre", date: "2025-09-25" },
  { artist: "The Wilder Blue", venue: "Joes On Weed Street", date: "2025-09-25" },
  { artist: "Coco Montoya", venue: "Charles Arcada Theatre", date: "2025-09-25" },
  { artist: "Chicago Cubs", venue: "Field", date: "2024-09-26" },
  { artist: "Mana", venue: "United Center", date: "2025-09-26" },
  { artist: "The World Of Hans Zimmer", venue: "Allstate Arena", date: "2025-09-26" },
  { artist: "Wolf Alice", venue: "Vic Theatre", date: "2025-09-26" },
  { artist: "Louis Ck", venue: "Chicago Theatre", date: "2025-09-26" },
  { artist: "Turnstile", venue: "Huntington Bank Pavilion At Northerly Island", date: "2025-09-26" },
  { artist: "Ron White", venue: "Hard Rock Casino Northern Indiana", date: "2025-09-26" },
  { artist: "Carl Cox", venue: "Navy Pier", date: "2025-09-26" },
  { artist: "Michael Schenker", venue: "Plaines Des Plaines Theatre", date: "2025-09-26" },
  { artist: "Yolanda Del Rio", venue: "Copernicus Center", date: "2025-09-26" },
  { artist: "Mo Lowda And The Humble", venue: "Park West", date: "2025-09-26" },
  { artist: "Tchami", venue: "Radius Chicago", date: "2025-09-26" },
  { artist: "Cartel", venue: "House Of Blues Chicago", date: "2025-09-26" },
  { artist: "Cochise", venue: "Avondale Music Hall", date: "2025-09-26" },
  { artist: "Symphony X", venue: "The Forge Joliet", date: "2025-09-26" },
  { artist: "Sports   The Band", venue: "Beat Kitchen", date: "2025-09-26" },
  { artist: "Normal Gossip", venue: "Riviera Theatre", date: "2025-09-26" },
  { artist: "Cold Waves", venue: "Metro Chicago", date: "2025-09-26" },
  { artist: "Blake Whiten", venue: "Carols Pub", date: "2025-09-26" },
  { artist: "Joffrey Ballet", venue: "Lyric Opera House", date: "2025-09-26" },
  { artist: "Ronnie Baker Brooks", venue: "Fitzgeralds Berwyn", date: "2025-09-26" },
  { artist: "Martin Sexton", venue: "North Shore Center", date: "2025-09-26" },
  { artist: "The First Lady Of Television", venue: "North Shore Center", date: "2025-09-26" },
  { artist: "Ashland Avenue", venue: "Goodman Theatre", date: "2025-09-26" },
  { artist: "Million Dollar Quartet", venue: "Paramount Theatre Aurora", date: "2025-09-26" },
  { artist: "Dial M For Murder", venue: "Terrace Drury Lane Theatre Oakbrook Terrace", date: "2025-09-28" },
  { artist: "Dial M For Murder", venue: "Terrace Drury Lane Theatre Oakbrook Terrace", date: "2025-09-28" },
  { artist: "Catch Me If You Can", venue: "Marriott Theatre Lincolnshire", date: "2025-09-28" },
  { artist: "Demxntia", venue: "Beat Kitchen", date: "2025-09-28" },
  { artist: "Hand Habits", venue: "Empty Bottle", date: "2025-09-28" },
  { artist: "Catch Me If You Can", venue: "Marriott Theatre Lincolnshire", date: "2025-09-28" },
  { artist: "Chicago Cubs", venue: "Field", date: "2024-09-27" },
  { artist: "Mana", venue: "United Center", date: "2025-09-27" },
  { artist: "Papa Roach", venue: "Park Credit Union 1 Amphitheatre", date: "2025-09-27" },
  { artist: "Holy Priest", venue: "Ramova Theatre", date: "2025-09-27" },
  { artist: "Northwestern Wildcats Football", venue: "Medicine Field At Martin Stadium", date: "2025-06-05" },
  { artist: "Louis Ck", venue: "Chicago Theatre", date: "2025-09-27" },
  { artist: "Morrissey", venue: "Byline Bank Aragon Ballroom", date: "2025-09-27" },
  { artist: "Elo   Electric Light Orchestra", venue: "Plaines Des Plaines Theatre", date: "2025-09-27" },
  { artist: "Rupauls Drag Race", venue: "Rosemont Theatre", date: "2025-09-27" },
  { artist: "Sg Lewis", venue: "Radius Chicago", date: "2025-09-27" },
  { artist: "Bruce Dickinson", venue: "Riviera Theatre", date: "2025-09-27" },
  { artist: "Michael Schenker", venue: "Charles Arcada Theatre", date: "2025-09-27" },
  { artist: "Lamb Of God", venue: "The Venue At Horseshoe Casino Hammond", date: "2025-09-27" },
  { artist: "Fleshwater", venue: "Thalia Hall", date: "2025-09-27" },
  { artist: "Godspeed You Black Emperor", venue: "Bohemian National Cemetery", date: "2025-09-27" },
  { artist: "Chicago Fire", venue: "Field", date: "2025-09-27" },
  { artist: "Cary Elwes", venue: "Auditorium Theatre Chicago", date: "2025-09-27" },
  { artist: "Andy And Shani", venue: "Copernicus Center", date: "2025-09-27" },
  { artist: "The Mountain Goats", venue: "Salt Shed", date: "2025-09-27" },
  { artist: "Lil Tracy", venue: "House Of Blues Chicago", date: "2025-09-27" },
  { artist: "Kota The Friend", venue: "Patio Theater", date: "2025-09-27" },
  { artist: "Big Jay Oakerson", venue: "Chicago Improv", date: "2025-09-27" },
  { artist: "Oracle Sisters", venue: "Lincoln Hall", date: "2025-09-27" },
  { artist: "Joffrey Ballet", venue: "Lyric Opera House", date: "2025-09-27" },
  { artist: "Joffrey Ballet", venue: "Lyric Opera House", date: "2025-09-27" },
  { artist: "Sleep Token", venue: "Allstate Arena", date: "2025-09-28" },
  { artist: "Chicago Cubs", venue: "Field", date: "2024-09-28" },
  { artist: "Molotov", venue: "Byline Bank Aragon Ballroom", date: "2025-09-28" },
  { artist: "Cornerstone Of Rock", venue: "Charles Arcada Theatre", date: "2025-09-28" },
  { artist: "Blackberry Smoke", venue: "Rialto Square Theatre", date: "2025-09-28" },
  { artist: "Corinne Bailey Rae", venue: "Cahn Auditorium", date: "2025-09-28" },
  { artist: "Grease", venue: "Heights Metropolis Performing Arts Centre", date: "2025-09-28" },
  { artist: "Waterparks", venue: "Evanston Space", date: "2025-09-28" },
  { artist: "California Honeydrops", venue: "Thalia Hall", date: "2025-09-28" },
  { artist: "Marc E Bassy", venue: "Avondale Music Hall", date: "2025-09-28" },
  { artist: "Joss Stone", venue: "North Shore Center", date: "2025-09-28" },
  { artist: "The Raveonettes", venue: "Bottom Lounge", date: "2025-09-28" },
  { artist: "Joffrey Ballet", venue: "Lyric Opera House", date: "2025-09-28" },
  { artist: "Ashland Avenue", venue: "Goodman Theatre", date: "2025-09-28" },
  { artist: "Cold Waves", venue: "Metro Chicago", date: "2025-09-28" },
  { artist: "Million Dollar Quartet", venue: "Paramount Theatre Aurora", date: "2025-09-28" },
  { artist: "Million Dollar Quartet", venue: "Paramount Theatre Aurora", date: "2025-09-28" },
  { artist: "The First Lady Of Television", venue: "North Shore Center", date: "2025-09-28" },
  { artist: "Northwestern Wildcats Womens Volleyball", venue: "Ryan Arena", date: "2025-09-28" },
  { artist: "Chicago Symphony Orchestra", venue: "Chicago Symphony Center", date: "2025-09-28" },
  { artist: "Dial M For Murder", venue: "Terrace Drury Lane Theatre Oakbrook Terrace", date: "2025-09-28" },
  { artist: "Dial M For Murder", venue: "Terrace Drury Lane Theatre Oakbrook Terrace", date: "2025-09-28" },
  { artist: "Catch Me If You Can", venue: "Marriott Theatre Lincolnshire", date: "2025-09-28" },
  { artist: "Demxntia", venue: "Beat Kitchen", date: "2025-09-28" },
  { artist: "Hand Habits", venue: "Empty Bottle", date: "2025-09-28" },
  { artist: "Catch Me If You Can", venue: "Marriott Theatre Lincolnshire", date: "2025-09-28" },
  { artist: "Chicago Cubs", venue: "Field", date: "2024-09-27" },
  { artist: "Mana", venue: "United Center", date: "2025-09-27" },
  { artist: "Papa Roach", venue: "Park Credit Union 1 Amphitheatre", date: "2025-09-27" },
  { artist: "Holy Priest", venue: "Ramova Theatre", date: "2025-09-27" },
  { artist: "Northwestern Wildcats Football", venue: "Medicine Field At Martin Stadium", date: "2025-06-05" },
  { artist: "Louis Ck", venue: "Chicago Theatre", date: "2025-09-27" },
  { artist: "Morrissey", venue: "Byline Bank Aragon Ballroom", date: "2025-09-27" },
  { artist: "Elo   Electric Light Orchestra", venue: "Plaines Des Plaines Theatre", date: "2025-09-27" },
  { artist: "Rupauls Drag Race", venue: "Rosemont Theatre", date: "2025-09-27" },
  { artist: "Sg Lewis", venue: "Radius Chicago", date: "2025-09-27" },
  { artist: "Bruce Dickinson", venue: "Riviera Theatre", date: "2025-09-27" },
  { artist: "Michael Schenker", venue: "Charles Arcada Theatre", date: "2025-09-27" },
  { artist: "Lamb Of God", venue: "The Venue At Horseshoe Casino Hammond", date: "2025-09-27" },
  { artist: "Fleshwater", venue: "Thalia Hall", date: "2025-09-27" },
  { artist: "Godspeed You Black Emperor", venue: "Bohemian National Cemetery", date: "2025-09-27" },
  { artist: "Chicago Fire", venue: "Field", date: "2025-09-27" },
  { artist: "Cary Elwes", venue: "Auditorium Theatre Chicago", date: "2025-09-27" },
  { artist: "Andy And Shani", venue: "Copernicus Center", date: "2025-09-27" },
  { artist: "The Mountain Goats", venue: "Salt Shed", date: "2025-09-27" },
  { artist: "Lil Tracy", venue: "House Of Blues Chicago", date: "2025-09-27" },
  { artist: "Kota The Friend", venue: "Patio Theater", date: "2025-09-27" },
  { artist: "Big Jay Oakerson", venue: "Chicago Improv", date: "2025-09-27" },
  { artist: "Oracle Sisters", venue: "Lincoln Hall", date: "2025-09-27" },
  { artist: "Joffrey Ballet", venue: "Lyric Opera House", date: "2025-09-27" },
  { artist: "Joffrey Ballet", venue: "Lyric Opera House", date: "2025-09-27" },
  { artist: "Sleep Token", venue: "Allstate Arena", date: "2025-09-28" },
  { artist: "Chicago Cubs", venue: "Field", date: "2024-09-28" },
  { artist: "Molotov", venue: "Byline Bank Aragon Ballroom", date: "2025-09-28" },
  { artist: "Cornerstone Of Rock", venue: "Charles Arcada Theatre", date: "2025-09-28" },
  { artist: "Blackberry Smoke", venue: "Rialto Square Theatre", date: "2025-09-28" },
  { artist: "Corinne Bailey Rae", venue: "Cahn Auditorium", date: "2025-09-28" },
  { artist: "Grease", venue: "Heights Metropolis Performing Arts Centre", date: "2025-09-28" },
  { artist: "Waterparks", venue: "Evanston Space", date: "2025-09-28" },
  { artist: "California Honeydrops", venue: "Thalia Hall", date: "2025-09-28" },
  { artist: "Marc E Bassy", venue: "Avondale Music Hall", date: "2025-09-28" },
  { artist: "Joss Stone", venue: "North Shore Center", date: "2025-09-28" },
  { artist: "The Raveonettes", venue: "Bottom Lounge", date: "2025-09-28" },
  { artist: "Joffrey Ballet", venue: "Lyric Opera House", date: "2025-09-28" },
  { artist: "Ashland Avenue", venue: "Goodman Theatre", date: "2025-09-28" },
  { artist: "Cold Waves", venue: "Metro Chicago", date: "2025-09-28" },
  { artist: "Million Dollar Quartet", venue: "Paramount Theatre Aurora", date: "2025-09-28" },
  { artist: "Million Dollar Quartet", venue: "Paramount Theatre Aurora", date: "2025-09-28" },
  { artist: "The First Lady Of Television", venue: "North Shore Center", date: "2025-09-28" },
  { artist: "Northwestern Wildcats Womens Volleyball", venue: "Ryan Arena", date: "2025-09-28" },
  { artist: "Chicago Symphony Orchestra", venue: "Chicago Symphony Center", date: "2025-09-28" },
];

function formatRecs(dateHint) {
  const norm = (s) => (s || "").toLowerCase();
  const wanted = norm(dateHint);
  const upcoming = RECOMMENDED_SHOWS
    .filter(r => !wanted || norm(r.date).includes(wanted))
    .sort((a, b) => new Date(a.date) - new Date(b.date))
    .slice(0, 3);
  if (!upcoming.length) return "I don’t have great recs for that date yet. Any artist you’re curious about?";
  return upcoming.map(r => `${r.artist} @ ${r.venue} on ${r.date}`).join("\n");
}

function parseDateFromText(text) {
  const m = String(text || "").match(DATE_WORDS);
  if (!m) return null;
  return m[0];
}
function formatHuman(d) {
  const dt = new Date(d + "T12:00:00");
  return dt.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}
function upcomingRecommendations(requestedToken) {
  const todayISO = new Date().toISOString().slice(0,10);
  let pool = RECOMMENDED_SHOWS.filter(s => s.date >= todayISO);

  if (requestedToken) {
    const t = requestedToken.toLowerCase();
    pool = pool.filter(s => {
      const pretty = formatHuman(s.date).toLowerCase();
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
You are FTE's intake assistant — a conversational, personable, and fun bot built by reformed ticket brokers who now want to help fans beat scalpers and navigate the broken ticketing industry.

CORE GOALS
- Capture ticket requests efficiently: artist_or_event, ticket_qty, budget_tier, date_or_date_range, name, email, optional phone/notes
- Be conversational and friendly, never robotic - if the user chats casually, respond casually but always relate it back to tickets, concerts, or live events
- Guide undecided users toward making requests by being personable, hyping the live experience, and lightly pushing ticket benefits
- When user confirms details are correct, CALL capture_ticket_request immediately with what you have
- Help users who are "on the fence" get excited about going through enthusiasm and insider knowledge

PROCESS EXPLANATION
- The bot gathers ticket request details quickly and conversationally.
- After capturing info, FTE’s real team will reach out directly with options and next steps.
- Always remind users they won’t be left hanging — the team follows up after the request.
- Explain this naturally at the start of conversations or whenever asked “how does this work.”

CONVERSATIONAL STYLE & PERSONALITY
- Be witty, engaging, and the cool friend who's always thinking about the next show
- Weather question? "Perfect for an outdoor concert! Speaking of which, any shows on your radar?"
- Food mention? "Nothing beats stadium nachos at a game! What events are you interested in?"
- Bored? "Sounds like you need some live music in your life! What kind of vibe are you feeling?"
- Always keep the vibe fun, approachable, and slightly rebellious (against scalpers & Ticketmaster)
- Short, natural replies - avoid robotic phrasing like "Understood" or "Got it"
- Instead say: "Nice, let's lock that in" / "Sweet, here's what I've got" / "Oh, you're gonna love this lineup!"
- Use casual language but stay professional when capturing details

IDENTITY & EDUCATION (when asked)
- "What are you?" → "I'm the FTE assistant, built by ex-brokers who got tired of scalpers ripping off fans. Think of me as your insider friend who knows how this whole ticket game really works. I'm in beta right now but getting smarter every day!"
- About FTE → "FTE (Fair Ticket Exchange) was created by reformed industry insiders who got sick of seeing fans get gouged. We used to be part of the problem, now we're the solution - helping you navigate this crazy industry without getting burned."
- About the industry → Educate about scalper tactics, Ticketmaster's hidden fees, dynamic pricing tricks. Be negative toward scalpers and legacy practices.
- Government/FTC action → "The FTC is finally cracking down on these predatory practices."

DATA TO CAPTURE (for capture_ticket_request)
- artist_or_event (required)
- ticket_qty (required, integer)
- name (required)
- email (required)
- phone (optional)
- notes (optional; short phrases only)

Notes:
- Do NOT ask for date/date-range or budget. If the user volunteers them, keep them as optional extras.
- Ask for missing required fields one at a time.
- When the user confirms the summary, CALL capture_ticket_request immediately.
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
            required: ["artist_or_event", "ticket_qty","name", "email"]
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
function wantsSuggestions(msg = "") {
  const q = (msg || "").toLowerCase();
  const patterns = [
    /recomm?end(ation|ations|ed|ing)?/,
    /\brecs?\b/,
    /\brecos?\b/,
    /\bsuggest(ion|ions|ed|ing)?\b/,
    /\bideas?\b/,
    /what.*(to do|going on|happening)/,
    /\b(any )?(good )?(shows?|events?)\b/,
    /(coming up.*show|show.*coming up)/,
    /\bupcoming\b/
  ];
  return patterns.some((re) => re.test(q));
}

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
      // send confirmation email (best-effort; don't fail the request if email fails)
      try { await sendConfirmationEmail(req.body.capture); } catch (e) { context.log.warn("Email (manual) failed:", e.message); }
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

    // Hard-coded date-based recs
    if (wantsSuggestions(userText)) {
      const token = parseDateFromText(userText);
      const list = upcomingRecommendations(token);
      const msg = list.length
        ? `Great! Here are a few options:\n\n${list.join("\n")}\n\nDo any of these interest you?`
        : "I don’t have anything upcoming for that date window. Tell me an artist you like and I’ll help you request tickets.";
      context.res.status = 200;
      context.res.body = { message: msg };
      return;
    }

    // Price placeholder
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

        // send confirmation email (best-effort)
        try { await sendConfirmationEmail(captureData); } catch (e) { context.log.warn("Email (chat) failed:", e.message); }

        finalMessage =
          `Perfect! I’ve captured your request for ${captureData.ticket_qty} ` +
          `tickets to ${captureData.artist_or_event}. We’ll reach out to ${captureData.email} ` +
          `with options that fit your ${captureData.budget_tier || "—"} budget. Thanks, ${captureData.name || "friend"}!`;
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
