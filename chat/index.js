const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');
const fetch = require('node-fetch');

// Google Sheets configuration using your environment variables
const SHEET_ID = process.env.GOOGLE_SHEETS_ID || '1KY-O6F-6rwSUsCvfQGQaADu985jTDCUJN4Oc0zKpiBA';
const TAB_NAME = 'Local Price Tracker';

// Cache for Google Sheets data (30 minutes)
let sheetsCache = {
    data: null,
    timestamp: null,
    ttl: 30 * 60 * 1000 // 30 minutes
};

// Cache for search results (30 minutes)
let searchCache = {
    data: new Map(),
    ttl: 30 * 60 * 1000 // 30 minutes
};

// Initialize Google Sheets client using your credentials format
async function initializeGoogleSheets() {
    try {
        // Parse the credentials JSON from your environment variable
        const credentials = JSON.parse(process.env.GOOGLE_SHEETS_CREDENTIALS);
        
        const serviceAccountAuth = new JWT({
            email: credentials.client_email,
            key: credentials.private_key.replace(/\\n/g, '\n'),
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

// Enhanced performance search with database first, web search fallback
async function searchArtistPerformances(artistQuery) {
    try {
        const events = await loadEventsData();
        const query = artistQuery.toLowerCase().trim();
        
        const matches = events.filter(event => {
            const artist = event.artist.toLowerCase();
            // More flexible matching
            return artist.includes(query) || query.includes(artist) || 
                   artist.split(' ').some(word => query.includes(word)) ||
                   query.split(' ').some(word => artist.includes(word));
        });

        if (matches.length > 0) {
            const match = matches[0];
            return {
                artist: match.artist,
                isPerforming: true,
                date: match.date,
                venue: match.venue,
                vividLink: match.vividLink,
                source: 'database'
            };
        }

        // Fallback to web search if not found in database
        const webResult = await getPerformanceWebFallback(artistQuery);
        return webResult;
    } catch (error) {
        console.error('Error searching artist performances:', error);
        // Fallback to web search on error
        return await getPerformanceWebFallback(artistQuery);
    }
}

// Web search fallback for artist performances
async function getPerformanceWebFallback(artistQuery) {
    try {
        const query = `${artistQuery} Chicago concert tour dates 2024 2025`;
        
        const response = await fetch(`https://google.serper.dev/search`, {
            method: 'POST',
            headers: {
                'X-API-KEY': process.env.SERPER_API_KEY,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                q: query,
                num: 10
            })
        });

        if (!response.ok) {
            throw new Error(`Serper API error: ${response.status}`);
        }

        const data = await response.json();
        const results = data.organic || [];
        
        for (const result of results) {
            const title = result.title || '';
            const snippet = result.snippet || '';
            
            if ((title.toLowerCase().includes('chicago') || snippet.toLowerCase().includes('chicago')) &&
                (title.toLowerCase().includes(artistQuery.toLowerCase()) || 
                 snippet.toLowerCase().includes(artistQuery.toLowerCase()))) {
                
                // Try to extract date information
                const dateMatch = snippet.match(/\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]* \d{1,2}|\b\d{1,2}\/\d{1,2}\/\d{2,4}|\b\d{4}-\d{2}-\d{2}/i);
                const venueMatch = snippet.match(/(United Center|Soldier Field|Wrigley Field|Chicago Theatre|Aragon Ballroom)/i);
                
                return {
                    artist: artistQuery,
                    isPerforming: true,
                    date: dateMatch ? dateMatch[0] : 'Date TBD',
                    venue: venueMatch ? venueMatch[0] : 'Venue TBD',
                    source: 'web search'
                };
            }
        }
        
        return {
            artist: artistQuery,
            isPerforming: false,
            date: null,
            venue: null,
            source: 'web search'
        };
    } catch (error) {
        console.error('Error with performance web search fallback:', error);
        return null;
    }
}

// Enhanced event recommendations with database first, web search fallback
async function getEventRecommendations(dateFilter = null, offset = 0, limit = 3) {
    try {
        const events = await loadEventsData();
        
        // Filter events by date if specified
        let filteredEvents = events;
        if (dateFilter) {
            const now = new Date();
            const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
            
            filteredEvents = events.filter(event => {
                const eventDate = new Date(event.date);
                
                if (dateFilter === 'weekend') {
                    const nextSaturday = new Date(today);
                    nextSaturday.setDate(today.getDate() + (6 - today.getDay()));
                    const nextSunday = new Date(nextSaturday);
                    nextSunday.setDate(nextSaturday.getDate() + 1);
                    
                    return eventDate >= nextSaturday && eventDate <= nextSunday;
                } else if (dateFilter === 'tonight') {
                    return eventDate.toDateString() === today.toDateString();
                } else if (dateFilter === 'tomorrow') {
                    const tomorrow = new Date(today);
                    tomorrow.setDate(today.getDate() + 1);
                    return eventDate.toDateString() === tomorrow.toDateString();
                }
                
                return true;
            });
        }

        // Sort by date (upcoming first)
        filteredEvents.sort((a, b) => new Date(a.date) - new Date(b.date));
        
        // Apply pagination
        const paginatedEvents = filteredEvents.slice(offset, offset + limit);
        const hasMore = filteredEvents.length > offset + limit;

        if (paginatedEvents.length > 0) {
            const eventList = paginatedEvents.map((event, index) => 
                `${offset + index + 1}. ${event.artist} at ${event.venue} on ${event.date}${event.currentPrice ? ` - from $${event.currentPrice}` : ''}`
            ).join('\n');

            return {
                events: [`Here are some upcoming events in Chicago from our database:\n\n${eventList}${hasMore ? '\n\nWould you like to see more events?' : ''}`],
                total: filteredEvents.length,
                hasMore: hasMore
            };
        }

        // Fallback to web search if no database results
        const webResult = await getRecommendationsWebFallback(dateFilter);
        if (webResult) {
            return {
                events: [webResult],
                total: 1,
                hasMore: false
            };
        }

        return { events: [], total: 0, hasMore: false };
    } catch (error) {
        console.error('Error getting event recommendations:', error);
        // Fallback to web search on error
        const webResult = await getRecommendationsWebFallback(dateFilter);
        if (webResult) {
            return {
                events: [webResult],
                total: 1,
                hasMore: false
            };
        }
        return { events: [], total: 0, hasMore: false };
    }
}

// Web search fallback for recommendations
async function getRecommendationsWebFallback(dateFilter = null) {
    try {
        const query = dateFilter ? 
            `Chicago events ${dateFilter} concerts shows tickets` : 
            'Chicago events this weekend concerts shows tickets';
            
        const response = await fetch(`https://google.serper.dev/search`, {
            method: 'POST',
            headers: {
                'X-API-KEY': process.env.SERPER_API_KEY,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                q: query,
                num: 10
            })
        });

        if (!response.ok) {
            throw new Error(`Serper API error: ${response.status}`);
        }

        const data = await response.json();
        const results = data.organic || [];
        
        let recommendations = 'Based on my research, here are some upcoming events in Chicago:\n\n';
        let eventCount = 0;
        
        for (const result of results) {
            const title = result.title || '';
            const snippet = result.snippet || '';
            
            if ((title.toLowerCase().includes('chicago') || snippet.toLowerCase().includes('chicago')) &&
                (title.toLowerCase().includes('concert') || title.toLowerCase().includes('show') || 
                 title.toLowerCase().includes('event') || snippet.toLowerCase().includes('event') ||
                 snippet.toLowerCase().includes('tickets'))) {
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

// Enhanced price search using database first, then Vivid Seats link
async function getPriceFromVividSeats(artistQuery, venue = null) {
    try {
        const events = await loadEventsData();
        const query = artistQuery.toLowerCase().trim();
        
        // First, try to find in database
        const matches = events.filter(event => {
            const artist = event.artist.toLowerCase();
            const eventVenue = event.venue ? event.venue.toLowerCase() : '';
            
            const artistMatch = artist.includes(query) || query.includes(artist) || 
                               artist.split(' ').some(word => query.includes(word)) ||
                               query.split(' ').some(word => artist.includes(word));
            
            const venueMatch = !venue || eventVenue.includes(venue.toLowerCase()) || 
                              venue.toLowerCase().includes(eventVenue);
            
            return artistMatch && venueMatch;
        });

        if (matches.length > 0) {
            const match = matches[0];
            
            // If we have a current price from database, use it
            if (match.currentPrice) {
                return {
                    price: parseFloat(match.currentPrice.replace(/[^0-9.]/g, '')),
                    source: 'our database',
                    url: match.vividLink
                };
            }
            
            // If we have a Vivid Seats link, scrape the current price
            if (match.vividLink) {
                const scrapedPrice = await scrapeVividSeatsPrice(match.vividLink);
                if (scrapedPrice) {
                    return {
                        price: scrapedPrice,
                        source: 'Vivid Seats',
                        url: match.vividLink
                    };
                }
            }
        }

        // Fallback to web search
        return await getPriceWebFallback(artistQuery, venue);
    } catch (error) {
        console.error('Error getting price from database:', error);
        // Fallback to web search on error
        return await getPriceWebFallback(artistQuery, venue);
    }
}

// Scrape price from Vivid Seats link (simplified version using search)
async function scrapeVividSeatsPrice(vividLink) {
    try {
        // Extract event info from Vivid Seats URL for search
        const urlParts = vividLink.split('/');
        const eventSlug = urlParts[urlParts.length - 1] || urlParts[urlParts.length - 2];
        
        const query = `site:vividseats.com ${eventSlug.replace(/-/g, ' ')} tickets price`;
        
        const response = await fetch(`https://google.serper.dev/search`, {
            method: 'POST',
            headers: {
                'X-API-KEY': process.env.SERPER_API_KEY,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                q: query,
                num: 3
            })
        });

        if (!response.ok) {
            throw new Error(`Serper API error: ${response.status}`);
        }

        const data = await response.json();
        const results = data.organic || [];
        
        for (const result of results) {
            const snippet = result.snippet || '';
            const title = result.title || '';
            
            // Multiple price extraction patterns
            const pricePatterns = [
                /\$(\d{1,4}(?:,\d{3})*(?:\.\d{2})?)/g,
                /from \$(\d+)/i,
                /starting at \$(\d+)/i,
                /tickets from \$(\d+)/i,
                /get in \$(\d+)/i
            ];
            
            for (const pattern of pricePatterns) {
                const matches = [...(snippet + ' ' + title).matchAll(pattern)];
                if (matches.length > 0) {
                    const prices = matches.map(match => parseFloat(match[1].replace(',', '')));
                    return Math.min(...prices);
                }
            }
        }
        
        return null;
    } catch (error) {
        console.error('Error scraping Vivid Seats price:', error);
        return null;
    }
}

// Web search fallback for pricing
async function getPriceWebFallback(artistQuery, venue = null) {
    try {
        const cacheKey = `price_${artistQuery.toLowerCase()}_${venue || ''}`;
        const cached = searchCache.data.get(cacheKey);
        
        if (cached && (Date.now() - cached.timestamp) < searchCache.ttl) {
            return cached.data;
        }

        const query = venue ? 
            `site:vividseats.com ${artistQuery} ${venue} tickets` :
            `site:vividseats.com ${artistQuery} Chicago tickets`;
            
        const response = await fetch(`https://google.serper.dev/search`, {
            method: 'POST',
            headers: {
                'X-API-KEY': process.env.SERPER_API_KEY,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                q: query,
                num: 5
            })
        });

        if (!response.ok) {
            throw new Error(`Serper API error: ${response.status}`);
        }

        const data = await response.json();
        const results = data.organic || [];
        
        for (const result of results) {
            const snippet = result.snippet || '';
            const title = result.title || '';
            
            // Multiple price extraction patterns
            const pricePatterns = [
                /\$(\d{1,4}(?:,\d{3})*(?:\.\d{2})?)/g,
                /from \$(\d+)/i,
                /starting at \$(\d+)/i,
                /tickets from \$(\d+)/i,
                /get in \$(\d+)/i
            ];
            
            for (const pattern of pricePatterns) {
                const matches = [...(snippet + ' ' + title).matchAll(pattern)];
                if (matches.length > 0) {
                    const prices = matches.map(match => parseFloat(match[1].replace(',', '')));
                    const minPrice = Math.min(...prices);
                    
                    const result = {
                        price: minPrice,
                        source: 'Vivid Seats',
                        url: result.link
                    };
                    
                    searchCache.data.set(cacheKey, {
                        data: result,
                        timestamp: Date.now()
                    });
                    
                    return result;
                }
            }
        }
        
        return null;
    } catch (error) {
        console.error('Error getting price from Vivid Seats:', error);
        return null;
    }
}

// OpenAI Chat Completion
async function getChatCompletion(messages) {
    try {
        const response = await fetch(`${process.env.OPENAI_API_BASE}/v1/chat/completions`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`
            },
            body: JSON.stringify({
                model: 'gpt-4',
                messages: messages,
                max_tokens: 500,
                temperature: 0.7
            })
        });

        if (!response.ok) {
            throw new Error(`OpenAI API error: ${response.status} ${response.statusText}`);
        }

        const data = await response.json();
        return data.choices[0].message.content;
    } catch (error) {
        console.error('Error with OpenAI API:', error);
        throw error;
    }
}

// Process user message with enhanced query classification
async function processUserMessage(userMessage, conversationState) {
    try {
        const systemPrompt = `You are a helpful ticket assistant for Fair Ticket Exchange. Your job is to help users find tickets and event information.

QUERY CLASSIFICATION:
1. PERFORMANCE QUERIES: "does X play", "is X performing", "when is X playing" → Use searchArtistPerformances()
2. PRICE QUERIES: "what's the price", "how much", "cost of tickets" → Use getPriceFromVividSeats() 
3. RECOMMENDATION QUERIES: "recommendations", "what's happening", "events this weekend" → Use getEventRecommendations()

RESPONSE GUIDELINES:
- For performance queries: Answer if/when they're performing, include date and venue
- For price queries: Provide the price from our database or Vivid Seats
- For recommendations: List events from our database with pagination
- Always be conversational and helpful
- If you can't find info in database, offer to do research with disclaimer about accuracy

CONVERSATION FLOW:
1. Greet users warmly
2. Help with their query (performance/price/recommendations)
3. If they want tickets, ask: artist/event, quantity, budget, date preference
4. Collect: name, email, phone (optional), notes (optional)
5. Confirm details before submitting

Current conversation state: ${JSON.stringify(conversationState)}

Determine the search_type based on the user's message:
- "performance" for questions about if/when artists are performing
- "price" for questions about ticket prices
- "recommendations" for requests for event suggestions
- "conversation" for general chat or ticket booking flow`;

        const messages = [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userMessage }
        ];

        // Classify the query type
        let searchType = 'conversation';
        const lowerMessage = userMessage.toLowerCase();
        
        if (lowerMessage.includes('does') && (lowerMessage.includes('play') || lowerMessage.includes('perform')) ||
            lowerMessage.includes('when is') || lowerMessage.includes('is performing')) {
            searchType = 'performance';
        } else if (lowerMessage.includes('price') || lowerMessage.includes('cost') || lowerMessage.includes('how much')) {
            searchType = 'price';
        } else if (lowerMessage.includes('recommend') || lowerMessage.includes('what\'s happening') || 
                   lowerMessage.includes('events') || lowerMessage.includes('shows')) {
            searchType = 'recommendations';
        }

        let searchResult = null;
        
        // Perform appropriate search based on query type
        if (searchType === 'performance') {
            // Extract artist name from query
            const artistMatch = lowerMessage.match(/does (.+?) play|is (.+?) performing|when is (.+?) playing/);
            if (artistMatch) {
                const artist = artistMatch[1] || artistMatch[2] || artistMatch[3];
                searchResult = await searchArtistPerformances(artist.trim());
            }
        } else if (searchType === 'price') {
            // Extract artist/event name from query
            const priceMatch = lowerMessage.match(/price (?:for|of) (.+)|how much (?:is|are|for) (.+)|cost of (.+)/);
            if (priceMatch) {
                const artist = priceMatch[1] || priceMatch[2] || priceMatch[3];
                searchResult = await getPriceFromVividSeats(artist.trim());
            }
        } else if (searchType === 'recommendations') {
            // Extract date filter if present
            let dateFilter = null;
            if (lowerMessage.includes('weekend')) dateFilter = 'weekend';
            if (lowerMessage.includes('tonight')) dateFilter = 'tonight';
            if (lowerMessage.includes('tomorrow')) dateFilter = 'tomorrow';
            
            const recommendations = await getEventRecommendations(dateFilter);
            if (recommendations.events.length > 0) {
                searchResult = recommendations.events[0]; // Get first recommendation
            }
        }

        // Add search result to system prompt if available
        if (searchResult) {
            messages[0].content += `\n\nSEARCH RESULT: ${JSON.stringify(searchResult)}`;
        }

        const response = await getChatCompletion(messages);
        return response;
    } catch (error) {
        console.error('Error processing user message:', error);
        return "I'm having trouble processing your request right now. Please try again in a moment.";
    }
}

// Main Azure Function
module.exports = async function (context, req) {
    // Handle CORS
    context.res = {
        headers: {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type, Authorization'
        }
    };

    if (req.method === 'OPTIONS') {
        context.res.status = 200;
        return;
    }

    try {
        const { message, conversationState = {} } = req.body || {};

        if (!message) {
            context.res = {
                ...context.res,
                status: 400,
                body: { error: 'Message is required' }
            };
            return;
        }

        const response = await processUserMessage(message, conversationState);

        context.res = {
            ...context.res,
            status: 200,
            body: { 
                response: response,
                conversationState: conversationState
            }
        };

    } catch (error) {
        console.error('Function execution error:', error);
        context.res = {
            ...context.res,
            status: 500,
            body: { 
                error: 'Something went wrong. Please try again.',
                details: error.message 
            }
        };
    }
};

// Export functions for testing
module.exports.searchArtistPerformances = searchArtistPerformances;
module.exports.getPriceFromVividSeats = getPriceFromVividSeats;
module.exports.getEventRecommendations = getEventRecommendations;








