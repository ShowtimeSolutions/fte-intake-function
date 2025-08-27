// index.js — Azure Function (Node 18+) - ENHANCED FINAL VERSION
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
  const siteBias = preferTickets ? " (site:vividseats.com OR site:ticketmaster.com OR site:stubhub.com)" : "";
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

/* =====================  Chicago Events Recommendations - ENHANCED  ===================== */
let chicagoEventsCache = null;
let cacheTimestamp = null;
const CACHE_DURATION = 30 * 60 * 1000; // 30 minutes

async function getChicagoEvents() {
  // Check cache first
  if (chicagoEventsCache && cacheTimestamp && (Date.now() - cacheTimestamp < CACHE_DURATION)) {
    return chicagoEventsCache;
  }

  try {
    // Enhanced search strategy - target major venues and popular events
    const searchQueries = [
      "United Center Chicago concerts site:vividseats.com",
      "Soldier Field Chicago events site:vividseats.com", 
      "Wrigley Field Chicago concerts site:vividseats.com",
      "Chicago Theatre concerts site:vividseats.com",
      "Riviera Theatre Chicago concerts site:vividseats.com"
    ];
    
    const events = [];
    
    // Search multiple venues for better event coverage
    for (const query of searchQueries) {
      try {
        const searchResults = await webSearch(query, null, { preferTickets: true, max: 5 });
        
        for (const result of searchResults) {
          // Enhanced event extraction
          const eventMatch = result.title.match(/^(.+?)\s*(?:tickets|at|•|\-|chicago)/i);
          const dateMatch = result.snippet.match(/(Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s+(\w+\s+\d+)(?:\s*•\s*(\d+:\d+\s*[AP]M))?/i) ||
                           result.snippet.match(/(\w+\s+\d+)(?:\s*•\s*(\d+:\d+\s*[AP]M))?/i);
          const venueMatch = result.snippet.match(/(?:at\s+|•\s*)([^•]+?)(?:\s*•|\s*From|\s*$)/i) ||
                           result.title.match(/at\s+([^•\-]+)/i);
          const priceMatch = result.snippet.match(/From\s*\$(\d+)/i) || result.snippet.match(/\$(\d+)/);

          if (eventMatch && eventMatch[1]) {
            const eventName = eventMatch[1].trim();
            
            // Skip if already added or if it's parking/irrelevant
            if (events.some(e => e.name.toLowerCase().includes(eventName.toLowerCase())) ||
                /parking|hotel|restaurant|merchandise/i.test(eventName)) {
              continue;
            }

            const event = {
              name: eventName,
              date: dateMatch ? (dateMatch[1] ? `${dateMatch[1]} ${dateMatch[2] || ''}` : dateMatch[1]) : 'TBD',
              time: (dateMatch && dateMatch[3]) ? dateMatch[3] : '',
              venue: venueMatch ? venueMatch[1].trim() : 'Chicago Area',
              price: priceMatch ? parseInt(priceMatch[1]) : null,
              link: result.link
            };
            events.push(event);
          }
        }
      } catch (error) {
        console.error(`Error searching ${query}:`, error);
        continue;
      }
    }

    // Enhanced fallback events with real Chicago attractions
    if (events.length < 3) {
      const fallbackEvents = [
        { name: "Dua Lipa", date: "Fri Sep 5", venue: "United Center", price: 106, time: "7:30 PM" },
        { name: "Dua Lipa", date: "Sat Sep 6", venue: "United Center", price: 106, time: "7:30 PM" },
        { name: "Chicago Bulls", date: "This Season", venue: "United Center", price: 85 },
        { name: "Chicago Bears", date: "This Season", venue: "Soldier Field", price: 120 },
        { name: "Chicago Cubs", date: "Various Dates", venue: "Wrigley Field", price: 45 },
        { name: "Chicago White Sox", date: "Various Dates", venue: "Guaranteed Rate Field", price: 35 },
        { name: "Chicago Symphony Orchestra", date: "This Weekend", venue: "Symphony Center", price: 65 },
        { name: "Second City Comedy", date: "Nightly", venue: "Second City", price: 30 },
        { name: "Blue Man Group", date: "Various Dates", venue: "Charles Playhouse", price: 55 }
      ];
      
      // Add fallback events that aren't already in the list
      for (const fallback of fallbackEvents) {
        if (events.length >= 9) break;
        if (!events.some(e => e.name.toLowerCase().includes(fallback.name.toLowerCase()))) {
          events.push(fallback);
        }
      }
    }

    // Cache the results
    chicagoEventsCache = events.slice(0, 9); // Store up to 9 events (3 sets of 3)
    cacheTimestamp = Date.now();
    
    return chicagoEventsCache;
  } catch (error) {
    console.error('Error fetching Chicago events:', error);
    // Return enhanced fallback events
    return [
      { name: "Dua Lipa", date: "Fri Sep 5", venue: "United Center", price: 106, time: "7:30 PM" },
      { name: "Chicago Bulls", date: "This Season", venue: "United Center", price: 85 },
      { name: "Chicago Bears", date: "This Season", venue: "Soldier Field", price: 120 }
    ];
  }
}

/* =====================  Price helpers - ENHANCED  ===================== */
// More comprehensive price regex patterns
const PRICE_PATTERNS = [
  /\$\s*(\d{2,4})(?:\s*-\s*\$?\d{2,4})?/gi,  // $100 or $100-$200
  /from\s*\$\s*(\d{2,4})/gi,                  // from $100
  /starting\s*at\s*\$\s*(\d{2,4})/gi,         // starting at $100
  /as\s*low\s*as\s*\$\s*(\d{2,4})/gi,         // as low as $100
  /(\d{2,4})\s*dollars?/gi,                   // 100 dollars
];

const irrelevant = (t, s) => /parking|hotel|restaurant|faq|blog|merchandise|merch|food|drink/i.test(`${t} ${s}`);

function extractPrices(text) {
  if (!text) return [];
  const prices = [];
  
  for (const pattern of PRICE_PATTERNS) {
    pattern.lastIndex = 0; // Reset regex
    let match;
    while ((match = pattern.exec(text))) {
      const val = parseInt(match[1], 10);
      if (!isNaN(val) && val >= 20 && val <= 2000) { // Reasonable ticket price range
        prices.push(val);
      }
    }
  }
  
  return [...new Set(prices)]; // Remove duplicates
}

function minPriceAcross(items) {
  let allPrices = [];
  for (const item of items || []) {
    if (!irrelevant(item.title, item.snippet)) {
      const prices = extractPrices(`${item.title} ${item.snippet}`);
      allPrices.push(...prices);
    }
  }
  return allPrices.length > 0 ? Math.min(...allPrices) : null;
}

// ENHANCED: Vivid Seats-only price comparison function
async function getAccurateTicketPrices(query) {
  try {
    // Search only Vivid Seats with enhanced query
    const enhancedQuery = `${query} tickets site:vividseats.com`;
    const vividSeatsResults = await webSearch(enhancedQuery, null, { preferTickets: true, max: 5 });
    
    const vividSeatsPrice = minPriceAcross(vividSeatsResults.filter(item => !irrelevant(item.title, item.snippet)));
    
    if (vividSeatsPrice) {
      return { price: vividSeatsPrice, source: 'Vivid Seats' };
    }
    
    return null;
  } catch (error) {
    console.error('Price search error:', error);
    return null;
  }
}

// NEW: Check if artist is performing (without price focus)
async function checkArtistPerformance(query) {
  try {
    const searchResults = await webSearch(`${query} site:vividseats.com`, null, { preferTickets: true, max: 3 });
    
    for (const result of searchResults) {
      // Look for date information in title and snippet
      const dateMatch = result.snippet.match(/(Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s+(\w+\s+\d+)(?:\s*•\s*(\d+:\d+\s*[AP]M))?/i) ||
                       result.title.match(/(\w+\s+\d+)/i);
      const venueMatch = result.snippet.match(/(?:at\s+|•\s*)([^•]+?)(?:\s*•|\s*From|\s*$)/i) ||
                        result.title.match(/at\s+([^•\-]+)/i);
      
      if (dateMatch) {
        const date = dateMatch[1] ? `${dateMatch[1]} ${dateMatch[2] || ''}` : dateMatch[1];
        const venue = venueMatch ? venueMatch[1].trim() : 'Chicago';
        const time = (dateMatch && dateMatch[3]) ? ` at ${dateMatch[3]}` : '';
        
        return {
          isPerforming: true,
          date: date,
          venue: venue,
          time: time
        };
      }
    }
    
    return { isPerforming: false };
  } catch (error) {
    console.error('Performance check error:', error);
    return { isPerforming: false };
  }
}

function priceSummaryMessage(priceData) {
  if (priceData && priceData.price) {
    return `I found tickets starting from $${priceData.price} on ${priceData.source}. How many tickets do you need?`;
  }
  return `I'll help you find the best prices. How many tickets are you looking for?`;
}

function performanceSummaryMessage(performanceData, artistName) {
  if (performanceData.isPerforming) {
    return `Yes! ${artistName} is performing on ${performanceData.date}${performanceData.time} at ${performanceData.venue}. Would you like ticket information?`;
  }
  return `I don't see any upcoming ${artistName} shows in Chicago right now. Would you like me to check for other artists or events?`;
}

/* =====================  Budget Range - IMPROVED  ===================== */
function normalizeBudgetTier(text = "") {
  const t = text.toLowerCase();
  const num = parseInt(t.replace(/[^\d]/g, ""), 10);
  
  // Direct matches first
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
  
  // Numeric mapping - find closest range
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
    const nm = allText.match(/\bmy name is ([a-z ,."-]{2,60})/i) || allText.match(/\bi am ([a-z ,."-]{2,60})/i);
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

/* =====================  OpenAI - ENHANCED  ===================== */
async function callOpenAI(messages) {
  const sysPrompt = `
You are FTE's polite, fast, and helpful ticket intake assistant on a public website.

GOALS
- Help the user pick or request tickets with minimum back-and-forth.
- Be conversational, but ask only one short question at a time for missing details.
- When the user confirms the details ("yes", "proceed", "go ahead", etc.), CALL the capture_ticket_request tool immediately with the fields you know.
- If the user wants ideas, dates, or prices, use the web_search tool first and reply with a short summary.

DATA TO CAPTURE (for capture_ticket_request)
- artist_or_event (required) — e.g., "Jonas Brothers"
- ticket_qty (required, integer)
- budget_tier (required, choose one exactly): "<$50","$50–$99","$100–$149","$150–$199","$200–$249","$250–$299","$300–$349","$350–$399","$400–$499","$500+"
- date_or_date_range (optional)
- name (required)
- email (required)
- phone (optional)
- notes (optional, short phrases only)

BUDGET INTERACTION
- When asking about budget, ask naturally: "What's your budget range per ticket?"
- Don't list all the options upfront
- Based on their response, assign to the closest budget tier from the list above

STYLE
- Short, friendly messages.
- Never ask for City/Residence.
- Do not tell the user to fill a form. If they ask for the form, the website will open it.
- After the user confirms the summary, CALL capture_ticket_request instead of asking again.

QUERY CLASSIFICATION - IMPORTANT:
- PRICE queries: "what's the price", "how much", "cost", "price for" → Use web_search with search_type="price"
- PERFORMANCE queries: "does X play", "is X performing", "when is X", "X in chicago" → Use web_search with search_type="performance"  
- RECOMMENDATION queries: "recommendations", "what's happening", "suggestions", "what's on" → Use web_search with search_type="recommendations"

IMPORTANT
- Do not restart the conversation after the user confirms. Proceed to capture.
- If you already know all the required details (artist/event, ticket_qty, budget_tier, name, email),
  you should immediately CALL capture_ticket_request after the user confirms, instead of asking again.
- If the user says "no", "not sure", or "undecided", keep the chat light and offer to search events.
- Always lean toward moving the user forward rather than looping back.
- ONLY return prices when explicitly asked for prices, not when asked if someone is performing.

TONE
- Friendly, concise, approachable.
- Use plain conversational English (no technical language).
- Encourage the user lightly, but don't oversell.
`.trim();

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
      },
      {
        type: "function",
        function: {
          name: "web_search",
          description: "Search the web for events, venues, dates, ticket info, or prices.",
          parameters: {
            type: "object",
            properties: {
              q: { type: "string", description: "Search query (include artist/venue and 'tickets' when relevant)" },
              location: { type: "string", description: "City/Region (optional)" },
              search_type: { 
                type: "string", 
                enum: ["price", "performance", "recommendations", "general"],
                description: "Type of search: price (for pricing), performance (for dates/venues), recommendations (for suggestions), general (default)"
              }
            },
            required: ["q"]
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

/* =====================  Response helpers - SIMPLIFIED  ===================== */
function extractToolCalls(response) {
  const message = response?.choices?.[0]?.message;
  return message?.tool_calls || [];
}

function extractAssistantText(response) {
  const message = response?.choices?.[0]?.message;
  return message?.content || "";
}

/* =====================  Intent helpers - ENHANCED  ===================== */
function looksLikeSearch(msg) {
  const q = (msg || "").toLowerCase();
  return /what.*(show|event)|show(s)?|event(s)?|happening|things to do|prices?|price|tickets?|concert|theater|theatre|sports|game|popular|upcoming|suggest|recommend/.test(q);
}

// ENHANCED: Better price detection
function looksLikePrice(msg) { 
  return /(what.*price|how much|cost|price for|price of)/i.test(msg || ""); 
}

// NEW: Performance/date detection  
function looksLikePerformance(msg) {
  return /(does.*play|is.*performing|when is|.*in chicago|.*coming to|.*tour)/i.test(msg || "");
}

// ENHANCED: Better suggestion detection
function wantsSuggestions(msg) { 
  return /(suggest|recommend|popular|upcoming|what.*to do|what.*going on|ideas|recommendations|recomendations|what.*happening|what's on)/i.test(msg || ""); 
}

function mentionsChicago(msg) { 
  return /(chicago|chi-town|chitown|tinley park|rosemont|wrigley|united center|soldier field)/i.test(msg || ""); 
}

/* =====================  Recommendation State Management  ===================== */
let recommendationState = {};

/* =====================  Azure Function entry - ENHANCED  ===================== */
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

  try {
    const { messages = [], sessionId = 'default' } = req.body || {};
    
    if (!Array.isArray(messages) || messages.length === 0) {
      context.res.status = 400;
      context.res.body = { error: "Invalid messages format" };
      return;
    }

    const lastUserMessage = messages[messages.length - 1];
    const userText = String(lastUserMessage?.content || "");

    // Handle special cases
    if (userAskedForm(userText)) {
      context.res.status = 200;
      context.res.body = { 
        message: "I'll open the manual request form for you.",
        action: "open_form"
      };
      return;
    }

    // Call OpenAI
    const openaiResponse = await callOpenAI(messages);
    const toolCalls = extractToolCalls(openaiResponse);
    const assistantText = extractAssistantText(openaiResponse);

    // Process tool calls
    let finalMessage = assistantText;
    let shouldCapture = false;
    let captureData = null;

    for (const toolCall of toolCalls) {
      const toolName = toolCall.function?.name;
      const toolArgs = JSON.parse(toolCall.function?.arguments || "{}");

      if (toolName === "web_search") {
        try {
          const searchType = toolArgs.search_type || "general";
          
          if (searchType === "recommendations" || wantsSuggestions(userText)) {
            // Handle recommendations - get Chicago events
            const events = await getChicagoEvents();
            
            // Initialize or get current state
            if (!recommendationState[sessionId]) {
              recommendationState[sessionId] = { currentIndex: 0 };
            }
            
            const state = recommendationState[sessionId];
            const startIndex = state.currentIndex;
            const endIndex = Math.min(startIndex + 3, events.length);
            const currentEvents = events.slice(startIndex, endIndex);
            
            if (currentEvents.length > 0) {
              const eventList = currentEvents.map(event => 
                `• ${event.name} - ${event.date}${event.time ? ` at ${event.time}` : ''} at ${event.venue}${event.price ? `, from $${event.price}` : ''}`
              ).join('\n');
              
              state.currentIndex = endIndex;
              const hasMore = endIndex < events.length;
              
              finalMessage = `Here are some popular Chicago events:\n${eventList}${hasMore ? '\n\nWant to see more options?' : '\n\nWhich one interests you?'}`;
            } else {
              finalMessage = "I'm having trouble finding current events. What specific artist or show are you looking for?";
            }
            
          } else if (searchType === "price" || looksLikePrice(userText)) {
            // Price search - use Vivid Seats only
            const priceData = await getAccurateTicketPrices(toolArgs.q);
            finalMessage = priceSummaryMessage(priceData);
            
          } else if (searchType === "performance" || looksLikePerformance(userText)) {
            // Performance check - answer if they're performing, not price
            const artistMatch = toolArgs.q.match(/(\w+(?:\s+\w+)*)/);
            const artistName = artistMatch ? artistMatch[1] : "the artist";
            
            const performanceData = await checkArtistPerformance(toolArgs.q);
            finalMessage = performanceSummaryMessage(performanceData, artistName);
            
          } else {
            // General search
            const searchResults = await webSearch(toolArgs.q, toolArgs.location);
            const price = minPriceAcross(searchResults);
            if (price) {
              finalMessage = `I found tickets starting around $${price}. How many tickets do you need?`;
            } else {
              finalMessage = "I'm having trouble finding that information. Can you be more specific about what you're looking for?";
            }
          }
        } catch (error) {
          console.error('Search error:', error);
          finalMessage = "I'm having trouble with the search right now. What specific event are you looking for?";
        }
      } else if (toolName === "capture_ticket_request") {
        shouldCapture = true;
        captureData = toolArgs;
        finalMessage = `Perfect! I've captured your request for ${toolArgs.ticket_qty} tickets to ${toolArgs.artist_or_event}. Our team will reach out to you at ${toolArgs.email} with the best options within your ${toolArgs.budget_tier} budget. Thanks, ${toolArgs.name}!`;
      }
    }

    // Capture to Google Sheets if needed
    if (shouldCapture && captureData) {
      try {
        const row = toRow(captureData);
        await appendToSheet(row);
        console.log('Successfully captured to Google Sheets:', captureData);
      } catch (error) {
        console.error('Google Sheets error:', error);
        // Don't fail the whole request if sheets fails
      }
    }

    context.res.status = 200;
    context.res.body = { 
      message: finalMessage,
      captured: shouldCapture
    };

  } catch (e) {
    console.error('Function error:', e);
    context.res.status = 500;
    context.res.body = { error: String(e) };
  }
};



// // index.js — Azure Function (Node 18+) - FIXED VERSION
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
//   const siteBias = preferTickets ? " (site:vividseats.com OR site:ticketmaster.com OR site:stubhub.com)" : "";
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

// /* =====================  Price helpers - IMPROVED  ===================== */
// // More comprehensive price regex patterns
// const PRICE_PATTERNS = [
//   /\$\s*(\d{2,4})(?:\s*-\s*\$?\d{2,4})?/gi,  // $100 or $100-$200
//   /from\s*\$\s*(\d{2,4})/gi,                  // from $100
//   /starting\s*at\s*\$\s*(\d{2,4})/gi,         // starting at $100
//   /as\s*low\s*as\s*\$\s*(\d{2,4})/gi,         // as low as $100
//   /(\d{2,4})\s*dollars?/gi,                   // 100 dollars
// ];

// const irrelevant = (t, s) => /parking|hotel|restaurant|faq|blog|merchandise|merch|food|drink/i.test(`${t} ${s}`);

// function extractPrices(text) {
//   if (!text) return [];
//   const prices = [];
  
//   for (const pattern of PRICE_PATTERNS) {
//     pattern.lastIndex = 0; // Reset regex
//     let match;
//     while ((match = pattern.exec(text))) {
//       const val = parseInt(match[1], 10);
//       if (!isNaN(val) && val >= 20 && val <= 2000) { // Reasonable ticket price range
//         prices.push(val);
//       }
//     }
//   }
  
//   return [...new Set(prices)]; // Remove duplicates
// }

// function minPriceAcross(items) {
//   let allPrices = [];
//   for (const item of items || []) {
//     if (!irrelevant(item.title, item.snippet)) {
//       const prices = extractPrices(`${item.title} ${item.snippet}`);
//       allPrices.push(...prices);
//     }
//   }
//   return allPrices.length > 0 ? Math.min(...allPrices) : null;
// }

// async function getTicketPrices(query) {
//   try {
//     // Search multiple ticket sites
//     const searches = await Promise.all([
//       webSearch(`${query} tickets site:vividseats.com`, null, { preferTickets: true, max: 3 }),
//       webSearch(`${query} tickets site:ticketmaster.com`, null, { preferTickets: true, max: 3 }),
//       webSearch(`${query} tickets site:stubhub.com`, null, { preferTickets: true, max: 3 }),
//     ]);
    
//     const allResults = searches.flat();
//     const relevantResults = allResults.filter(item => !irrelevant(item.title, item.snippet));
    
//     return minPriceAcross(relevantResults);
//   } catch (error) {
//     console.error('Price search error:', error);
//     return null;
//   }
// }

// function priceSummaryMessage(priceNum) {
//   if (priceNum != null) {
//     return `I found tickets starting around $${priceNum}. What's your budget range?`;
//   }
//   return `I'll help you find the best prices. What's your budget range?`;
// }

// /* =====================  Guardrail extraction  ===================== */
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

// /** Turn-aware extraction */
// function extractTurnAware(messages) {
//   const out = { artist_or_event:"", ticket_qty:"", budget_tier:"", date_or_date_range:"", name:"", email:"", phone:"", notes:"" };
//   for (let i = 0; i < messages.length - 1; i++) {
//     const a = messages[i], u = messages[i + 1];
//     if (a.role !== "assistant" || u.role !== "user") continue;
//     const q = String(a.content || "").toLowerCase();
//     const ans = String(u.content || "");
//     if (!out.artist_or_event && /(artist|event).*(interested|looking|tickets?)/.test(q)) out.artist_or_event = ans.replace(/tickets?/ig, "").trim();
//     if (!out.ticket_qty && /(how many|quantity|qty)/.test(q)) { const m = ans.match(QTY_RE); if (m) out.ticket_qty = parseInt(m[1], 10); }
//     if (!out.budget_tier && /(budget|price range|per ticket)/.test(q)) out.budget_tier = normalizeBudgetTier(ans);
//     if (!out.date_or_date_range && /(date|when)/.test(q)) { const dm = ans.match(DATE_WORDS); out.date_or_date_range = dm ? dm[0] : ans.trim(); }
//     if (!out.name && /name/.test(q)) { if (!EMAIL_RE.test(ans) && !PHONE_RE.test(ans)) out.name = ans.trim(); }
//     if (!out.email && /(email|e-mail)/.test(q)) { const em = ans.match(EMAIL_RE); if (em) out.email = em[0]; }
//     if (!out.phone && /(phone|number)/.test(q)) { const pm = ans.match(PHONE_RE); if (pm) out.phone = pm[0]; }
//     if (/notes?|special|requests?/i.test(q)) { if (!/no|none|n\/a/i.test(ans)) out.notes = ans.trim(); }
//   }
//   return out;
// }

// /** Backstop extraction */
// function extractFromTranscript(messages) {
//   const userTexts = messages.filter(m => m.role === "user").map(m => String(m.content||""));
//   const allText = messages.map(m => String(m.content || "")).join("\n");

//   let artist = "";
//   for (const t of userTexts) {
//     const m = t.match(/(?:see|want|looking.*for|tickets? for|go to|interested in)\s+(.+)/i);
//     if (m) { artist = m[1].replace(/tickets?$/i, "").trim(); break; }
//   }
//   if (!artist && userTexts.length) artist = userTexts[0].trim();
//   if (/^hi|hello|hey$/i.test(artist)) artist = "";

//   let qty = null;
//   for (let i = userTexts.length-1; i >= 0; i--) {
//     const m = userTexts[i].match(QTY_RE);
//     if (m) { qty = parseInt(m[1], 10); if (qty>0 && qty<=12) break; }
//   }

//   let budget_tier = "";
//   for (let i = userTexts.length-1; i >= 0; i--) {
//     const bt = normalizeBudgetTier(userTexts[i]);
//     if (bt) { budget_tier = bt; break; }
//   }

//   let date_or_date_range = "";
//   const dm = allText.match(DATE_WORDS);
//   if (dm) date_or_date_range = dm[0];

//   let name = "";
//   const nameAskIdx = messages.findLastIndex?.(m => m.role === "assistant" && /name/i.test(String(m.content||""))) ?? -1;
//   if (nameAskIdx >= 0 && messages[nameAskIdx + 1]?.role === "user") {
//     const ans = String(messages[nameAskIdx + 1].content || "");
//     if (!EMAIL_RE.test(ans) && !PHONE_RE.test(ans)) name = ans.trim();
//   }
//   if (!name) {
//     const nm = allText.match(/\bmy name is ([a-z ,.'-]{2,60})/i) || allText.match(/\bi am ([a-z ,.'-]{2,60})/i);
//     if (nm) name = nm[1].trim();
//   }

//   const email = (allText.match(EMAIL_RE) || [""])[0];
//   const phone = (allText.match(PHONE_RE) || [""])[0];

//   let notes = "";
//   if (/aisle/i.test(allText)) notes = (notes ? notes + "; " : "") + "Aisle seat preferred";
//   if (/ada|accessible/i.test(allText)) notes = (notes ? notes + "; " : "") + "ADA/accessible";

//   return { artist_or_event: artist || "", ticket_qty: qty ?? "", budget_tier, date_or_date_range, name, email, phone, notes };
// }

// function mergeCapture(a, b) {
//   return {
//     artist_or_event: a.artist_or_event || b.artist_or_event || "",
//     ticket_qty: a.ticket_qty || b.ticket_qty || "",
//     budget_tier: a.budget_tier || b.budget_tier || "",
//     date_or_date_range: a.date_or_date_range || b.date_or_date_range || "",
//     name: a.name || b.name || "",
//     email: a.email || b.email || "",
//     phone: a.phone || b.phone || "",
//     notes: a.notes || b.notes || ""
//   };
// }

// function haveRequired(c) {
//   return !!(c.artist_or_event && c.ticket_qty && c.budget_tier && c.name && c.email);
// }
// function userConfirmed(text) {
//   return /\b(yes|yep|yeah|correct|confirm|finalize|go ahead|proceed|place it|submit|that's right|looks good|do it|book it)\b/i.test(text || "");
// }
// function userAskedForm(text) {
//   return /\b(open|use|show)\b.*\b(form)\b|\bmanual request\b/i.test(text || "");
// }

// /* =====================  OpenAI - FIXED  ===================== */
// async function callOpenAI(messages) {
//   const sysPrompt = `
// You are FTE's polite, fast, and helpful ticket intake assistant on a public website.

// GOALS
// - Help the user pick or request tickets with minimum back-and-forth.
// - Be conversational, but ask only one short question at a time for missing details.
// - When the user confirms the details ("yes", "proceed", "go ahead", etc.), CALL the capture_ticket_request tool immediately with the fields you know.
// - If the user wants ideas, dates, or prices, use the web_search tool first and reply with a short summary.

// DATA TO CAPTURE (for capture_ticket_request)
// - artist_or_event (required) — e.g., "Jonas Brothers"
// - ticket_qty (required, integer)
// - budget_tier (required, choose one exactly): "<$50","$50–$99","$100–$149","$150–$199","$200–$249","$250–$299","$300–$349","$350–$399","$400–$499","$500+"
// - date_or_date_range (optional)
// - name (required)
// - email (required)
// - phone (optional)
// - notes (optional, short phrases only)

// STYLE
// - Short, friendly messages.
// - Never ask for City/Residence.
// - Do not tell the user to fill a form. If they ask for the form, the website will open it.
// - After the user confirms the summary, CALL capture_ticket_request instead of asking again.

// PRICE / IDEAS
// - If the user asks "what's on" / "what's happening" / "recommendations" / "prices", call web_search first.
// - For price searches, be specific with the query including the artist/event name.
// - Suggestions: provide a short list (3–5 lines) if they ask for ideas.

// IMPORTANT
// - Do not restart the conversation after the user confirms. Proceed to capture.
// - If you already know all the required details (artist/event, ticket_qty, budget_tier, name, email),
//   you should immediately CALL capture_ticket_request after the user confirms, instead of asking again.
// - If the user says "no", "not sure", or "undecided", keep the chat light and offer to search events.
// - Always lean toward moving the user forward rather than looping back.

// TONE
// - Friendly, concise, approachable.
// - Use plain conversational English (no technical language).
// - Encourage the user lightly, but don't oversell.
// `.trim();

//   const body = {
//     model: "gpt-4o-mini", // Fixed model name
//     temperature: 0.2,
//     messages: [{ role: "system", content: sysPrompt }, ...messages], // Fixed: use 'messages' not 'input'
//     tools: [
//       {
//         type: "function",
//         function: { // Fixed: wrap in 'function' object
//           name: "capture_ticket_request",
//           description: "Finalize a ticket request and log to Google Sheets.",
//           parameters: {
//             type: "object",
//             properties: {
//               artist_or_event: { type: "string" },
//               ticket_qty: { type: "integer" },
//               budget_tier: {
//                 type: "string",
//                 enum: [
//                   "<$50","$50–$99","$100–$149","$150–$199",
//                   "$200–$249","$250–$299","$300–$349","$350–$399",
//                   "$400–$499","$500+"
//                 ]
//               },
//               date_or_date_range: { type: "string" },
//               name: { type: "string" },
//               email: { type: "string" },
//               phone: { type: "string" },
//               notes: { type: "string" }
//             },
//             required: ["artist_or_event", "ticket_qty", "budget_tier", "name", "email"]
//           }
//         }
//       },
//       {
//         type: "function",
//         function: { // Fixed: wrap in 'function' object
//           name: "web_search",
//           description: "Search the web for events, venues, dates, ticket info, or prices.",
//           parameters: {
//             type: "object",
//             properties: {
//               q: { type: "string", description: "Search query (include artist/venue and 'tickets' when relevant)" },
//               location: { type: "string", description: "City/Region (optional)" }
//             },
//             required: ["q"]
//           }
//         }
//       }
//     ],
//     tool_choice: "auto"
//   };

//   const resp = await fetch("https://api.openai.com/v1/chat/completions", { // Fixed: correct endpoint
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

// /* =====================  Response helpers - SIMPLIFIED  ===================== */
// function extractToolCalls(response) {
//   const message = response?.choices?.[0]?.message;
//   return message?.tool_calls || [];
// }

// function extractAssistantText(response) {
//   const message = response?.choices?.[0]?.message;
//   return message?.content || "";
// }

// /* =====================  Intent helpers  ===================== */
// function looksLikeSearch(msg) {
//   const q = (msg || "").toLowerCase();
//   return /what.*(show|event)|show(s)?|event(s)?|happening|things to do|prices?|price|tickets?|concert|theater|theatre|sports|game|popular|upcoming|suggest|recommend/.test(q);
// }
// function looksLikePrice(msg) { return /(price|prices|cost|how much)/i.test(msg || ""); }
// function wantsSuggestions(msg) { return /(suggest|recommend|popular|upcoming|what.*to do|what.*going on|ideas)/i.test(msg || ""); }
// function mentionsChicago(msg) { return /(chicago|chi-town|chitown|tinley park|rosemont|wrigley|united center|soldier field)/i.test(msg || ""); }

// /* =====================  Azure Function entry - COMPLETED  ===================== */
// module.exports = async function (context, req) {
//   context.res = {
//     headers: {
//       "Access-Control-Allow-Origin": "*",
//       "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
//       "Access-Control-Allow-Headers": "Content-Type, Authorization",
//       "Content-Type": "application/json"
//     }
//   };

//   if (req.method === "OPTIONS") {
//     context.res.status = 200;
//     context.res.body = {};
//     return;
//   }

//   try {
//     const { messages = [] } = req.body || {};
    
//     if (!Array.isArray(messages) || messages.length === 0) {
//       context.res.status = 400;
//       context.res.body = { error: "Invalid messages format" };
//       return;
//     }

//     const lastUserMessage = messages[messages.length - 1];
//     const userText = String(lastUserMessage?.content || "");

//     // Handle special cases
//     if (userAskedForm(userText)) {
//       context.res.status = 200;
//       context.res.body = { 
//         message: "I'll open the manual request form for you.",
//         action: "open_form"
//       };
//       return;
//     }

//     // Call OpenAI
//     const openaiResponse = await callOpenAI(messages);
//     const toolCalls = extractToolCalls(openaiResponse);
//     const assistantText = extractAssistantText(openaiResponse);

//     // Process tool calls
//     let finalMessage = assistantText;
//     let shouldCapture = false;
//     let captureData = null;

//     for (const toolCall of toolCalls) {
//       const toolName = toolCall.function?.name;
//       const toolArgs = JSON.parse(toolCall.function?.arguments || "{}");

//       if (toolName === "web_search") {
//         try {
//           const searchResults = await webSearch(toolArgs.q, toolArgs.location);
          
//           if (looksLikePrice(userText) || /price/i.test(toolArgs.q)) {
//             // Price search
//             const price = await getTicketPrices(toolArgs.q);
//             finalMessage = priceSummaryMessage(price);
//           } else if (wantsSuggestions(userText)) {
//             // Recommendations
//             const suggestions = searchResults
//               .filter(r => !irrelevant(r.title, r.snippet))
//               .slice(0, 5)
//               .map(r => `• ${r.title}`)
//               .join('\n');
//             finalMessage = suggestions ? 
//               `Here are some popular events:\n${suggestions}\n\nWhich one interests you?` :
//               "I'm having trouble finding current events. What specific artist or show are you looking for?";
//           } else {
//             // General search - extract price if available
//             const price = minPriceAcross(searchResults);
//             if (price) {
//               finalMessage = `I found tickets starting around $${price}. How many tickets do you need?`;
//             }
//           }
//         } catch (error) {
//           console.error('Search error:', error);
//           finalMessage = "I'm having trouble with the search right now. What specific event are you looking for?";
//         }
//       } else if (toolName === "capture_ticket_request") {
//         shouldCapture = true;
//         captureData = toolArgs;
//         finalMessage = `Perfect! I've captured your request for ${toolArgs.ticket_qty} tickets to ${toolArgs.artist_or_event}. Our team will reach out to you at ${toolArgs.email} with the best options within your ${toolArgs.budget_tier} budget. Thanks, ${toolArgs.name}!`;
//       }
//     }

//     // Capture to Google Sheets if needed
//     if (shouldCapture && captureData) {
//       try {
//         const row = toRow(captureData);
//         await appendToSheet(row);
//         console.log('Successfully captured to Google Sheets:', captureData);
//       } catch (error) {
//         console.error('Google Sheets error:', error);
//         // Don't fail the whole request if sheets fails
//       }
//     }

//     context.res.status = 200;
//     context.res.body = { 
//       message: finalMessage,
//       captured: shouldCapture
//     };

//   } catch (e) {
//     console.error('Function error:', e);
//     context.res.status = 500;
//     context.res.body = { error: String(e) };
//   }
// };







