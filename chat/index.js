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
  { artist: "Castle Rat", venue: "Reggies Chicago", date: "2025-09-10" }
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
function wantsSuggestions(msg = "") {
  const q = (msg || "").toLowerCase();

  // common words/phrases + misspellings + short forms
  const patterns = [
    /recomm?end(ation|ations|ed|ing)?/,   // recommend / recomend / recommendation(s)
    /\brecs?\b/,                          // rec / recs
    /\brecos?\b/,                         // reco / recos
    /\bsuggest(ion|ions|ed|ing)?\b/,      // suggest / suggestions
    /\bideas?\b/,                         // idea / ideas
    /what.*(to do|going on|happening)/,   // what's to do / what's going on / what's happening
    /\b(any )?(good )?(shows?|events?)\b/,// any (good) shows/events
    /(coming up.*show|show.*coming up)/,  // show coming up?
    /\bupcoming\b/                        // upcoming
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

