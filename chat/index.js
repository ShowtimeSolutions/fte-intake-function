const { AzureFunction } = require('@azure/functions');
const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');

// Google Sheets configuration
const SHEET_ID = '1KY-O6F-6rwSUsCvfQGQaADu985jTDCUJN4Oc0zKpiBA';
const TAB_NAME = 'Local Price Tracker';

// Cache for Google Sheets data (30 minutes)
let sheetsCache = {
    data: null,
    timestamp: null,
    ttl: 30 * 60 * 1000 // 30 minutes
};

// Initialize Google Sheets client
async function initializeGoogleSheets() {
    try {
        const serviceAccountAuth = new JWT({
            email: process.env.GOOGLE_SHEETS_CLIENT_EMAIL,
            key: process.env.GOOGLE_SHEETS_PRIVATE_KEY?.replace(/\\n/g, '\n'),
            scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
        });

        const doc = new GoogleSpreadsheet(SHEET_ID, serviceAccountAuth);
        await doc.loadInfo();
        
        return doc;
    } catch (error) {
        console.error('Error initializing Google Sheets:', error);
        throw error;
    }
}

// Load events data from Google Sheets with caching
async function loadEventsData() {
    const now = Date.now();
    
    // Return cached data if still valid
    if (sheetsCache.data && sheetsCache.timestamp && (now - sheetsCache.timestamp) < sheetsCache.ttl) {
        return sheetsCache.data;
    }

    try {
        const doc = await initializeGoogleSheets();
        const sheet = doc.sheetsByTitle[TAB_NAME];
        
        if (!sheet) {
            throw new Error(`Sheet "${TAB_NAME}" not found`);
        }

        const rows = await sheet.getRows();
        const events = rows.map(row => ({
            eventId: row.get('Event ID'),
            priceTrend: row.get('Price Trend'),
            artist: row.get('Artist'),
            venue: row.get('Venue'),
            date: row.get('Date'),
            vividLink: row.get('Vivid Link'),
            skyboxLink: row.get('SkyBox Link'),
            initialTrackingDate: row.get('Initial Tracking Date'),
            // Get the most recent price (first non-empty price column)
            currentPrice: getCurrentPrice(row)
        })).filter(event => event.artist && event.date); // Filter out empty rows

        // Update cache
        sheetsCache.data = events;
        sheetsCache.timestamp = now;
        
        return events;
    } catch (error) {
        console.error('Error loading events data:', error);
        // Return cached data if available, even if expired
        if (sheetsCache.data) {
            return sheetsCache.data;
        }
        throw error;
    }
}

// Extract current price from price columns
function getCurrentPrice(row) {
    for (let i = 1; i <= 42; i++) {
        const price = row.get(`Price #${i}`);
        if (price && price.trim() !== '') {
            return price;
        }
    }
    return null;
}

// Enhanced performance search with web search fallback
async function searchArtistPerformances(artistQuery) {
    try {
        const events = await loadEventsData();
        const query = artistQuery.toLowerCase().trim();
        
        const matches = events.filter(event => {
            const artist = event.artist.toLowerCase();
            // More flexible matching
            return artist.includes(query) || 
                   query.includes(artist) ||
                   // Handle partial matches
                   artist.split(/[-\s]+/).some(word => query.includes(word)) ||
                   query.split(/[-\s]+/).some(word => artist.includes(word));
        });

        return matches.sort((a, b) => new Date(a.date) - new Date(b.date));
    } catch (error) {
        console.error('Error searching artist performances:', error);
        return [];
    }
}

// Web search fallback for performance queries
async function searchPerformanceWebFallback(artistQuery) {
    try {
        const searchQuery = `${artistQuery} chicago concerts 2025 tickets`;
        const response = await fetch(`https://google.serper.dev/search`, {
            method: 'POST',
            headers: {
                'X-API-KEY': process.env.SERPER_API_KEY,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                q: searchQuery,
                num: 5
            })
        });

        if (!response.ok) {
            return null;
        }

        const data = await response.json();
        
        // Extract performance information from search results
        const results = data.organic || [];
        let performanceInfo = '';

        for (const result of results) {
            const title = result.title.toLowerCase();
            const snippet = result.snippet.toLowerCase();
            
            // Look for date patterns and venue information
            const datePattern = /(?:january|february|march|april|may|june|july|august|september|october|november|december)\s+\d{1,2}|(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\s+\d{1,2}|\d{1,2}\/\d{1,2}\/\d{4}/i;
            const venuePattern = /(united center|soldier field|wrigley field|allstate arena|chicago theatre|house of blues)/i;
            
            const dateMatch = (title + ' ' + snippet).match(datePattern);
            const venueMatch = (title + ' ' + snippet).match(venuePattern);
            
            if (dateMatch || venueMatch) {
                performanceInfo = `Based on my research, ${artistQuery} appears to have upcoming shows in Chicago`;
                if (dateMatch) performanceInfo += ` around ${dateMatch[0]}`;
                if (venueMatch) performanceInfo += ` at ${venueMatch[0]}`;
                performanceInfo += '. This information might not be 100% accurate, so I recommend checking official sources.';
                break;
            }
        }

        return performanceInfo || `I found some search results for ${artistQuery} in Chicago, but couldn't extract specific performance details. This might not be 100% accurate, but there may be upcoming shows.`;
    } catch (error) {
        console.error('Error with web search fallback:', error);
        return null;
    }
}

// Enhanced event recommendations with better date filtering and pagination
async function getEventRecommendations(dateFilter = null, offset = 0, limit = 3) {
    try {
        const events = await loadEventsData();
        let filteredEvents = events;

        if (dateFilter) {
            const now = new Date();
            let startDate, endDate;

            if (dateFilter.includes('weekend') || dateFilter.includes('this weekend')) {
                // Get upcoming weekend (Friday to Sunday)
                const today = new Date();
                const dayOfWeek = today.getDay();
                const daysUntilFriday = dayOfWeek <= 5 ? (5 - dayOfWeek) : (7 - dayOfWeek + 5);
                startDate = new Date(today);
                startDate.setDate(today.getDate() + daysUntilFriday);
                endDate = new Date(startDate);
                endDate.setDate(startDate.getDate() + 2); // Friday to Sunday
            } else if (dateFilter.includes('next weekend')) {
                // Next weekend (7 days later)
                const today = new Date();
                const dayOfWeek = today.getDay();
                const daysUntilNextFriday = dayOfWeek <= 5 ? (5 - dayOfWeek + 7) : (7 - dayOfWeek + 5 + 7);
                startDate = new Date(today);
                startDate.setDate(today.getDate() + daysUntilNextFriday);
                endDate = new Date(startDate);
                endDate.setDate(startDate.getDate() + 2);
            } else if (dateFilter.includes('week') || dateFilter.includes('this week')) {
                // Next 7 days
                startDate = new Date();
                endDate = new Date();
                endDate.setDate(startDate.getDate() + 7);
            } else if (dateFilter.includes('month') || dateFilter.includes('this month')) {
                // Next 30 days
                startDate = new Date();
                endDate = new Date();
                endDate.setDate(startDate.getDate() + 30);
            } else if (dateFilter.includes('tonight') || dateFilter.includes('today')) {
                // Today only
                startDate = new Date();
                endDate = new Date();
                endDate.setDate(startDate.getDate() + 1);
            } else {
                // Default to next 14 days
                startDate = new Date();
                endDate = new Date();
                endDate.setDate(startDate.getDate() + 14);
            }

            filteredEvents = events.filter(event => {
                const eventDate = new Date(event.date);
                return eventDate >= startDate && eventDate <= endDate;
            });
        } else {
            // Default: upcoming events (next 30 days)
            const startDate = new Date();
            const endDate = new Date();
            endDate.setDate(startDate.getDate() + 30);
            
            filteredEvents = events.filter(event => {
                const eventDate = new Date(event.date);
                return eventDate >= startDate && eventDate <= endDate;
            });
        }

        // Sort by date and apply pagination
        const sortedEvents = filteredEvents.sort((a, b) => new Date(a.date) - new Date(b.date));
        const paginatedEvents = sortedEvents.slice(offset, offset + limit);
        
        return {
            events: paginatedEvents,
            total: sortedEvents.length,
            hasMore: (offset + limit) < sortedEvents.length
        };
    } catch (error) {
        console.error('Error getting event recommendations:', error);
        return { events: [], total: 0, hasMore: false };
    }
}

// Web search fallback for recommendations
async function getRecommendationsWebFallback(dateFilter = null) {
    try {
        let searchQuery = 'chicago concerts events ';
        if (dateFilter && dateFilter.includes('weekend')) {
            searchQuery += 'this weekend';
        } else if (dateFilter && dateFilter.includes('week')) {
            searchQuery += 'this week';
        } else {
            searchQuery += 'upcoming';
        }
        
        const response = await fetch(`https://google.serper.dev/search`, {
            method: 'POST',
            headers: {
                'X-API-KEY': process.env.SERPER_API_KEY,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                q: searchQuery,
                num: 10
            })
        });

        if (!response.ok) {
            return null;
        }

        const data = await response.json();
        const results = data.organic || [];
        
        let recommendations = 'Based on my research, here are some upcoming events in Chicago:\n\n';
        let eventCount = 0;
        
        for (const result of results.slice(0, 5)) {
            const title = result.title;
            const snippet = result.snippet;
            
            // Look for event-like content
            if (title.toLowerCase().includes('concert') || 
                title.toLowerCase().includes('show') || 
                title.toLowerCase().includes('event') ||
                snippet.toLowerCase().includes('tickets')) {
                eventCount++;
                recommendations += `${eventCount}. ${title}\n`;
                if (eventCount >= 3) break;
            }
        }
        
        if (eventCount === 0) {
            return 'I found some search results for Chicago events, but couldn\'t extract specific event details. This might not be 100% accurate, but there appear to be upcoming shows available.';
        }
        
        recommendations += '\nThis information might not be 100% accurate, so I recommend checking official sources for details and tickets.';
        return recommendations;
    } catch (error) {
        console.error('Error with recommendations web search fallback:', error);
        return null;
    }
}

// Simplified price search using only Vivid Seats links from Google Sheets
async function getPriceFromDatabase(artistQuery) {
    try {
        const events = await loadEventsData();
        const query = artistQuery.toLowerCase().trim();
        
        const matches = events.filter(event => {
            const artist = event.artist.toLowerCase();
            return artist.includes(query) || 
                   query.includes(artist) ||
                   artist.split(/[-\s]+/).some(word => query.includes(word)) ||
                   query.split(/[-\s]+/).some(word => artist.includes(word));
        });

        if (matches.length > 0) {
            const event = matches[0]; // Get the first match
            
            // Only use the Vivid Seats link from column F
            if (event.vividLink) {
                const price = await getPriceFromVividSeats(event.vividLink);
                if (price) {
                    return {
                        price: price,
                        source: 'vivid_seats',
                        event: event
                    };
                }
            }
            
            return {
                price: null,
                source: 'vivid_seats',
                event: event
            };
        }
        
        return null;
    } catch (error) {
        console.error('Error getting price from database:', error);
        return null;
    }
}

// Web search fallback for pricing
async function getPriceWebFallback(artistQuery) {
    try {
        const searchQuery = `${artistQuery} chicago tickets price vivid seats`;
        const response = await fetch(`https://google.serper.dev/search`, {
            method: 'POST',
            headers: {
                'X-API-KEY': process.env.SERPER_API_KEY,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                q: searchQuery,
                num: 5
            })
        });

        if (!response.ok) {
            return null;
        }

        const data = await response.json();
        const results = data.organic || [];
        
        for (const result of results) {
            const title = result.title.toLowerCase();
            const snippet = result.snippet.toLowerCase();
            const content = title + ' ' + snippet;
            
            // Look for price patterns
            const pricePatterns = [
                /get in for \$(\d+)/i,
                /starting at \$(\d+)/i,
                /from \$(\d+)/i,
                /tickets from \$(\d+)/i,
                /\$(\d+)\+/,
                /price.*\$(\d+)/i
            ];

            for (const pattern of pricePatterns) {
                const match = content.match(pattern);
                if (match && match[1]) {
                    return `$${match[1]}`;
                }
            }
        }
        
        return null;
    } catch (error) {
        console.error('Error with price web search fallback:', error);
        return null;
    }
}
async function getPriceFromVividSeats(vividLink) {
    try {
        if (!vividLink || vividLink.trim() === '') {
            return null;
        }

        const response = await fetch(vividLink, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            }
        });

        if (!response.ok) {
            return null;
        }

        const html = await response.text();
        
        // Multiple price extraction patterns for Vivid Seats
        const pricePatterns = [
            /get in for \$(\d+)/i,
            /starting at \$(\d+)/i,
            /from \$(\d+)/i,
            /\$(\d+)\+/,
            /"price":\s*"?\$?(\d+)/i,
            /data-price="(\d+)"/i,
            /price-value[^>]*>\$(\d+)/i
        ];

        for (const pattern of pricePatterns) {
            const match = html.match(pattern);
            if (match && match[1]) {
                return `$${match[1]}`;
            }
        }

        return null;
    } catch (error) {
        console.error('Error getting price from Vivid Seats:', error);
        return null;
    }
}

// Enhanced OpenAI chat completion with Google Sheets integration
async function getChatCompletion(messages) {
    const systemPrompt = `You are a helpful ticket assistant for Fair Ticket Exchange. You help customers find tickets for events in the Chicago area.

IMPORTANT QUERY CLASSIFICATION:
1. PERFORMANCE QUERIES: "does X play", "is X performing", "when is X playing" → Use searchArtistPerformances()
2. PRICE QUERIES: "what's the price", "how much", "cost of tickets" → Use getPriceFromDatabase() 
3. RECOMMENDATION QUERIES: "recommendations", "what's happening", "events this weekend" → Use getEventRecommendations()

RESPONSE GUIDELINES:
- For performance queries: Answer if/when they're performing, include date and venue
- For price queries: Provide the price from our database or Vivid Seats
- For recommendations: List 3 events at a time with pagination
- Always be conversational and helpful
- If you can't find info in database, offer to do research with disclaimer about accuracy

CONVERSATION FLOW:
1. Greet and ask how you can help
2. Classify their query type
3. Search database first
4. If not found, offer research with accuracy disclaimer
5. Collect ticket details: artist/event, quantity, budget, date preference
6. Get contact info: name, email, phone (optional)
7. Confirm details and submit to Google Sheets

Budget ranges: "<$50", "$50–$99", "$100–$149", "$150–$199", "$200–$249", "$250–$299", "$300–$349", "$350–$399", "$400–$499", "$500+"`;

    try {
        const response = await fetch(`${process.env.OPENAI_API_BASE}/v1/chat/completions`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                model: 'gpt-4',
                messages: [
                    { role: 'system', content: systemPrompt },
                    ...messages
                ],
                max_tokens: 500,
                temperature: 0.7
            })
        });

        if (!response.ok) {
            throw new Error(`OpenAI API error: ${response.status}`);
        }

        const data = await response.json();
        return data.choices[0].message.content;
    } catch (error) {
        console.error('Error with OpenAI API:', error);
        return "I'm having trouble processing your request right now. Please try again.";
    }
}

// Process user message and determine action
async function processUserMessage(userMessage, conversationHistory = []) {
    const message = userMessage.toLowerCase().trim();
    
    // Check for performance queries
    if (message.includes('does ') && (message.includes('play') || message.includes('perform')) ||
        message.includes('is ') && (message.includes('playing') || message.includes('performing')) ||
        message.includes('when is')) {
        
        // Extract artist name
        const artistMatch = message.match(/(?:does|is|when is)\s+([^?]+?)(?:\s+(?:play|perform|playing|performing))/i);
        if (artistMatch) {
            const artist = artistMatch[1].trim();
            const performances = await searchArtistPerformances(artist);
            
            if (performances.length > 0) {
                const performance = performances[0];
                const date = new Date(performance.date).toLocaleDateString('en-US', {
                    weekday: 'short',
                    month: 'short',
                    day: 'numeric'
                });
                return `Yes! ${performance.artist} is performing on ${date} at ${performance.venue}. Would you like ticket information?`;
            } else {
                // Use web search fallback
                const webResult = await searchPerformanceWebFallback(artist);
                if (webResult) {
                    return webResult;
                } else {
                    return `I don't have that information in my database at the moment, but if you'd like I can do some research and let you know. This might not be 100% accurate but here's what I found through a web search.`;
                }
            }
        }
    }
    
    // Check for price queries
    if (message.includes('price') || message.includes('cost') || message.includes('how much')) {
        // Extract artist/event name
        const priceMatch = message.match(/(?:price|cost|how much).*?(?:for|of)\s+([^?]+)/i);
        if (priceMatch) {
            const artist = priceMatch[1].trim();
            const priceResult = await getPriceFromDatabase(artist);
            
            if (priceResult && priceResult.price) {
                return `I found tickets starting from ${priceResult.price} on Vivid Seats. How many tickets do you need?`;
            } else if (priceResult && priceResult.event) {
                // Found event but couldn't get price from Vivid Seats link
                const webPrice = await getPriceWebFallback(artist);
                if (webPrice) {
                    return `I found the event but couldn't get the current price from Vivid Seats. Based on my research, tickets appear to start around ${webPrice}. This might not be 100% accurate but here's what I found.`;
                } else {
                    return `I found the event but don't have current pricing available. Let me do some research and get back to you with pricing information.`;
                }
            } else {
                // No event found in database, try web search
                const webPrice = await getPriceWebFallback(artist);
                if (webPrice) {
                    return `I don't have that information in my database at the moment, but based on my research, tickets appear to start around ${webPrice}. This might not be 100% accurate but here's what I found.`;
                } else {
                    return `I don't have that information in my database at the moment, but if you'd like I can do some research and let you know. This might not be 100% accurate but here's what I can find.`;
                }
            }
        }
    }
    
    // Check for recommendation queries
    if (message.includes('recommend') || message.includes('what') && message.includes('happening') ||
        message.includes('events') || message.includes('shows') || message.includes('weekend') ||
        message.includes('recomend') || message.includes('recomendations')) { // Handle typos
        
        let dateFilter = null;
        if (message.includes('weekend')) dateFilter = 'weekend';
        else if (message.includes('week')) dateFilter = 'week';
        else if (message.includes('month')) dateFilter = 'month';
        else if (message.includes('tonight') || message.includes('today')) dateFilter = 'tonight';
        
        const recommendationResult = await getEventRecommendations(dateFilter, 0, 3);
        
        if (recommendationResult.events.length > 0) {
            let response = "Here are some great events coming up:\n\n";
            
            recommendationResult.events.forEach((event, index) => {
                const date = new Date(event.date).toLocaleDateString('en-US', {
                    weekday: 'short',
                    month: 'short',
                    day: 'numeric'
                });
                const price = event.currentPrice ? ` - Starting at ${event.currentPrice}` : '';
                response += `${index + 1}. ${event.artist} - ${date} at ${event.venue}${price}\n`;
            });
            
            if (recommendationResult.hasMore) {
                response += `\nWould you like to see more events? I have ${recommendationResult.total - 3} more suggestions.`;
            }
            
            return response;
        } else {
            // Use web search fallback
            const webResult = await getRecommendationsWebFallback(dateFilter);
            if (webResult) {
                return webResult;
            } else {
                return `I don't have current event recommendations in my database, but if you'd like I can do some research and let you know what's happening. This might not be 100% accurate but here's what I can find.`;
            }
        }
    }
    
    // Default to OpenAI for general conversation
    const messages = [
        ...conversationHistory,
        { role: 'user', content: userMessage }
    ];
    
    return await getChatCompletion(messages);
}

// Main Azure Function
module.exports = async function (context, req) {
    // Enable CORS
    context.res = {
        headers: {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type, Authorization'
        }
    };

    // Handle preflight requests
    if (req.method === 'OPTIONS') {
        context.res.status = 200;
        return;
    }

    try {
        const { message, conversationHistory } = req.body;

        if (!message) {
            context.res = {
                ...context.res,
                status: 400,
                body: { error: 'Message is required' }
            };
            return;
        }

        const response = await processUserMessage(message, conversationHistory || []);

        context.res = {
            ...context.res,
            status: 200,
            body: { response }
        };

    } catch (error) {
        console.error('Error processing request:', error);
        context.res = {
            ...context.res,
            status: 500,
            body: { error: 'Internal server error' }
        };
    }
};

// Export functions for testing
module.exports.searchArtistPerformances = searchArtistPerformances;
module.exports.getEventRecommendations = getEventRecommendations;
module.exports.getPriceFromVividSeats = getPriceFromVividSeats;



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







