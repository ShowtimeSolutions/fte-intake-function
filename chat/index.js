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










