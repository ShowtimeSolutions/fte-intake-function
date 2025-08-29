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

/* =====================  Web Search  ===================== */
async function webSearch(query, location = "Chicago") {
  try {
    const searchQuery = location ? `${query} ${location}` : query;
    
    const response = await fetch("https://google.serper.dev/search", {
      method: "POST",
      headers: {
        "X-API-KEY": process.env.SERPER_API_KEY,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        q: searchQuery,
        num: 10
      })
    });

    if (!response.ok) {
      throw new Error(`Serper API error: ${response.status}`);
    }

    const data = await response.json();
    return (data.organic || []).map(result => ({
      title: result.title || "",
      snippet: result.snippet || "",
      link: result.link || ""
    }));
  } catch (error) {
    console.error('Web search error:', error);
    return [];
  }
}

async function getTicketPrices(query) {
  try {
    const vividQuery = `site:vividseats.com ${query} tickets Chicago`;
    
    const response = await fetch("https://google.serper.dev/search", {
      method: "POST",
      headers: {
        "X-API-KEY": process.env.SERPER_API_KEY,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        q: vividQuery,
        num: 5
      })
    });

    if (!response.ok) {
      throw new Error(`Serper API error: ${response.status}`);
    }

    const data = await response.json();
    const results = data.organic || [];
    
    for (const result of results) {
      const text = `${result.title} ${result.snippet}`;
      
      const pricePatterns = [
        /\$(\d{1,4}(?:,\d{3})*(?:\.\d{2})?)/g,
        /from \$(\d+)/i,
        /starting at \$(\d+)/i,
        /tickets from \$(\d+)/i,
        /get in \$(\d+)/i
      ];
      
      for (const pattern of pricePatterns) {
        const matches = [...text.matchAll(pattern)];
        if (matches.length > 0) {
          const prices = matches.map(match => parseFloat(match[1].replace(',', '')));
          return Math.min(...prices);
        }
      }
    }
    
    return null;
  } catch (error) {
    console.error('Price extraction error:', error);
    return null;
  }
}

function minPriceAcross(results) {
  const prices = [];
  for (const r of results) {
    const text = `${r.title} ${r.snippet}`;
    const matches = text.match(/\$(\d{1,4}(?:,\d{3})*)/g);
    if (matches) {
      for (const m of matches) {
        const num = parseFloat(m.replace(/[$,]/g, ""));
        if (num >= 10 && num <= 9999) prices.push(num);
      }
    }
  }
  return prices.length ? Math.min(...prices) : null;
}

function priceSummaryMessage(price) {
  if (price) {
    return `I found tickets starting from $${price} on Vivid Seats. How many tickets do you need?`;
  }
  return "I'm having trouble finding current pricing. What specific event are you looking for?";
}

function irrelevant(title, snippet) {
  const text = `${title} ${snippet}`.toLowerCase();
  return /\b(news|article|review|interview|biography|wiki|wikipedia|imdb|facebook|twitter|instagram)\b/.test(text);
}

/* =====================  Budget Tier Normalization  ===================== */
const QTY_RE = /\b(\d{1,2})\s*(?:ticket|tix|seat)/i;
const EMAIL_RE = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/;
const PHONE_RE = /\b(?:\+?1[-.\s]?)?\(?([0-9]{3})\)?[-.\s]?([0-9]{3})[-.\s]?([0-9]{4})\b/;
const DATE_WORDS = /\b(?:tonight|tomorrow|this weekend|next week|friday|saturday|sunday|monday|tuesday|wednesday|thursday|january|february|march|april|may|june|july|august|september|october|november|december|\d{1,2}\/\d{1,2}|\d{1,2}-\d{1,2}|jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\b/i;

function normalizeBudgetTier(text) {
  const t = (text || "").toLowerCase().replace(/[^\w\s$-]/g, " ");
  
  if (/under.*50|less.*50|below.*50|<.*50|\$?50.*less|\$?50.*under/.test(t)) return "<$50";
  if (/50.*99|50.*100|50.*to.*99|50.*-.*99|\$50.*\$99/.test(t)) return "$50–$99";
  if (/100.*149|100.*150|100.*to.*149|100.*-.*149|\$100.*\$149/.test(t)) return "$100–$149";
  if (/150.*199|150.*200|150.*to.*199|150.*-.*199|\$150.*\$199/.test(t)) return "$150–$199";
  if (/200.*249|200.*250|200.*to.*249|200.*-.*249|\$200.*\$249/.test(t)) return "$200–$249";
  if (/250.*299|250.*300|250.*to.*299|250.*-.*299|\$250.*\$299/.test(t)) return "$250–$299";
  if (/300.*349|300.*350|300.*to.*349|300.*-.*349|\$300.*\$349/.test(t)) return "$300–$349";
  if (/350.*399|350.*400|350.*to.*399|350.*-.*399|\$350.*\$399/.test(t)) return "$350–$399";
  if (/400.*499|400.*500|400.*to.*499|400.*-.*499|\$400.*\$499/.test(t)) return "$400–$499";
  if (/500.*more|500.*plus|over.*500|above.*500|500\+|\$500\+/.test(t)) return "$500+";
  
  const num = parseInt((t.match(/\$?(\d+)/) || ["", "0"])[1], 10);
  if (num < 50) return "<$50";
  if (num < 100) return "$50–$99";
  if (num < 150) return "$100–$149";
  if (num < 200) return "$150–$199";
  if (num < 250) return "$200–$249";
  if (num < 300) return "$250–$299";
  if (num < 350) return "$300–$349";
  if (num < 400) return "$350–$399";
  if (num < 500) return "$400–$499";
  if (num >= 500) return "$500+";
  
  return "";
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

/* =====================  OpenAI - FIXED  ===================== */
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

STYLE
- Short, friendly messages.
- Never ask for City/Residence.
- Do not tell the user to fill a form. If they ask for the form, the website will open it.
- After the user confirms the summary, CALL capture_ticket_request instead of asking again.

PRICE / IDEAS
- If the user asks "what's on" / "what's happening" / "recommendations" / "prices", call web_search first.
- For price searches, be specific with the query including the artist/event name.
- Suggestions: provide a short list (3–5 lines) if they ask for ideas.

IMPORTANT
- Do not restart the conversation after the user confirms. Proceed to capture.
- If you already know all the required details (artist/event, ticket_qty, budget_tier, name, email),
  you should immediately CALL capture_ticket_request after the user confirms, instead of asking again.
- If the user says "no", "not sure", or "undecided", keep the chat light and offer to search events.
- Always lean toward moving the user forward rather than looping back.

TONE
- Friendly, concise, approachable.
- Use plain conversational English (no technical language).
- Encourage the user lightly, but don't oversell.
`.trim();

  const body = {
    model: "gpt-4o-mini", // Fixed model name
    temperature: 0.2,
    messages: [{ role: "system", content: sysPrompt }, ...messages], // Fixed: use 'messages' not 'input'
    tools: [
      {
        type: "function",
        function: { // Fixed: wrap in 'function' object
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
        function: { // Fixed: wrap in 'function' object
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
      }
    ],
    tool_choice: "auto"
  };

  const resp = await fetch(`${process.env.OPENAI_API_BASE}/v1/chat/completions`, {
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

/* =====================  Intent helpers  ===================== */
function looksLikeSearch(msg) {
  const q = (msg || "").toLowerCase();
  return /what.*(show|event)|show(s)?|event(s)?|happening|things to do|prices?|price|tickets?|concert|theater|theatre|sports|game|popular|upcoming|suggest|recommend/.test(q);
}

function looksLikePrice(msg) { return /(price|prices|cost|how much)/i.test(msg || ""); }
function wantsSuggestions(msg) { return /(suggest|recommend|popular|upcoming|what.*to do|what.*going on|ideas)/i.test(msg || ""); }
function mentionsChicago(msg) { return /(chicago|chi-town|chitown|tinley park|rosemont|wrigley|united center|soldier field)/i.test(msg || ""); }

/* =====================  Azure Function entry - WITH FORM SUPPORT  ===================== */
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
    // ✅ NEW: Handle direct form submissions
    if (req.body?.direct_capture && req.body?.capture) {
      try {
        const formData = req.body.capture;
        const row = toRow(formData);
        await appendToSheet(row);
        
        context.res.status = 200;
        context.res.body = { 
          message: "Form submitted successfully!",
          captured: true
        };
        return;
      } catch (error) {
        console.error('Form submission error:', error);
        context.res.status = 500;
        context.res.body = { error: "Failed to save form data" };
        return;
      }
    }

    // ✅ EXISTING: Handle chatbot messages
    const { messages = [] } = req.body || {};
    
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
          const searchResults = await webSearch(toolArgs.q, toolArgs.location);
          
          if (looksLikePrice(userText) || /price/i.test(toolArgs.q)) {
            // Price search
            const price = await getTicketPrices(toolArgs.q);
            finalMessage = priceSummaryMessage(price);
          } else if (wantsSuggestions(userText)) {
            // Recommendations
            const suggestions = searchResults
              .filter(r => !irrelevant(r.title, r.snippet))
              .slice(0, 5)
              .map(r => `• ${r.title}`)
              .join('\n');
            finalMessage = suggestions ? 
              `Here are some popular events:\n${suggestions}\n\nWhich one interests you?` :
              "I'm having trouble finding current events. What specific artist or show are you looking for?";
          } else {
            // General search - extract price if available
            const price = minPriceAcross(searchResults);
            if (price) {
              finalMessage = `I found tickets starting around $${price}. How many tickets do you need?`;
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
