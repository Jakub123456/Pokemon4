require("dotenv").config();
const puppeteer = require("puppeteer-extra");
const StealthPlugin = require("puppeteer-extra-plugin-stealth");
puppeteer.use(StealthPlugin());
const fs = require("fs");
const path = require("path");
const { google } = require("googleapis");

// ─── Log to file + stdout ────────────────────────────────────────────────────
const logStream = fs.createWriteStream(path.join(__dirname, "logs.txt"), { flags: "a" });
const _origLog = console.log.bind(console);
const _origError = console.error.bind(console);
function writeLog(prefix, args) {
  const line = `[${new Date().toISOString()}] ${prefix}${args.map(a => (typeof a === "string" ? a : JSON.stringify(a))).join(" ")}`;
  logStream.write(line + "\n");
}
console.log = (...args) => { _origLog(...args); writeLog("", args); };
console.error = (...args) => { _origError(...args); writeLog("[ERROR] ", args); };

// Custom error for Cloudflare blocks — triggers browser restart
class CloudflareBlockError extends Error {
  constructor(message) {
    super(message);
    this.name = "CloudflareBlockError";
  }
}

const LOGIN_URL = "https://www.cardmarket.com/en/Pokemon";
const CARDS_FILE = "cards.json";
const INPUT_SPREADSHEET_ID = "1JC06pXo7gqa7nI--JqhJf64NSmNSoFMBCvpPWIAzZ6A";
const INPUT_TAB = "List";
const SERVICE_ACCOUNT_KEY = path.join(__dirname, "poke-491015-130855de8aa7.json");

// Google Sheets: "Card Prices" spreadsheet — set this to your spreadsheet ID
const PRICES_SPREADSHEET_ID = "1Hlpj3w0ZfmkSrjoHgntWEHvry8-oYjVS9z7YNsRKGdg";

// ─── Google Sheets helpers ───────────────────────────────────────────────────

async function getSheetsClient() {
  const auth = new google.auth.GoogleAuth({
    keyFile: SERVICE_ACCOUNT_KEY,
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
  const client = await auth.getClient();
  return google.sheets({ version: "v4", auth: client });
}

let headerWritten = false;

const SHEET_HEADERS = [
  "Timestamp",
  "Expansion",
  "Card Name",
  "Edition Code",
  "Pokemon ID",
  "ReverseHolo Filter",
  "Rarity",
  "Number",
  "Printed In",
  "Species",
  "Available Items",
  "From",
  "Price Trend",
  "30-Day Avg",
  "7-Day Avg",
  "1-Day Avg",
  "Card URL",
  "Seller 1 Name", "Seller 1 Country", "Seller 1 Price", "Seller 1 Profile",
  "Seller 2 Name", "Seller 2 Country", "Seller 2 Price", "Seller 2 Profile",
  "Seller 3 Name", "Seller 3 Country", "Seller 3 Price", "Seller 3 Profile",
  "Seller 4 Name", "Seller 4 Country", "Seller 4 Price", "Seller 4 Profile",
  "Seller 5 Name", "Seller 5 Country", "Seller 5 Price", "Seller 5 Profile",
];

async function ensureHeader() {
  if (headerWritten) return;
  try {
    const sheets = await getSheetsClient();
    const existing = await sheets.spreadsheets.values
      .get({ spreadsheetId: PRICES_SPREADSHEET_ID, range: "Sheet1!A1:A1" })
      .catch(() => null);
    if (!existing || !existing.data.values || existing.data.values.length === 0) {
      await sheets.spreadsheets.values.append({
        spreadsheetId: PRICES_SPREADSHEET_ID,
        range: "Sheet1!A1",
        valueInputOption: "RAW",
        requestBody: { values: [SHEET_HEADERS] },
      });
    }
  } catch (err) {
    console.log(`   Warning: Failed to write header: ${err.message}`);
  }
  headerWritten = true;
}

async function appendRowToSheet(row) {
  try {
    await ensureHeader();
    const sheets = await getSheetsClient();
    await sheets.spreadsheets.values.append({
      spreadsheetId: PRICES_SPREADSHEET_ID,
      range: "Sheet1!A1",
      valueInputOption: "RAW",
      requestBody: { values: [row] },
    });
  } catch (err) {
    console.log(`   Warning: Failed to append row: ${err.message}`);
  }
}

// ─── Config & input parsing ──────────────────────────────────────────────────

function loadConfig() {
  if (!fs.existsSync(CARDS_FILE)) {
    console.error(`Config file "${CARDS_FILE}" not found.`);
    process.exit(1);
  }
  const config = JSON.parse(fs.readFileSync(CARDS_FILE, "utf-8"));
  return {
    username: config.username || "",
    password: config.password || "",
    headless: config.headless !== undefined ? config.headless : false,
    simpleBrowser: config.simpleBrowser || false,
    continueFrom: config.continueFrom || "",
  };
}

async function loadInputFromSheet() {
  const sheets = await getSheetsClient();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: INPUT_SPREADSHEET_ID,
    range: `${INPUT_TAB}!A:F`,
  });
  const rows = res.data.values || [];
  if (rows.length <= 1) {
    console.log("No cards found in input sheet.");
    return [];
  }
  // First row is the header, data starts at row 2
  const cards = [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    const editionName = (r[0] || "").trim();
    const editionCode = (r[1] || "").trim();
    const pokemonId = (r[3] || "").trim();
    if (!editionName || !editionCode || !pokemonId) continue;
    cards.push({
      editionName,
      editionCode,
      pokemonName: (r[2] || "").trim(),
      pokemonId,
      reverseHolo: (r[4] || "").trim(),
      rarity: (r[5] || "").trim(),
    });
  }
  console.log(`Loaded ${cards.length} card(s) from Google Sheet "${INPUT_TAB}"`);
  return cards;
}

// ─── Browser helpers ─────────────────────────────────────────────────────────

// Rotating realistic user agents
// ─── Session Profile Builder ────────────────────────────────────────────────
// Builds a consistent fingerprint: OS ↔ UA ↔ platform ↔ resolution ↔ locale ↔ timezone

// Country → locale/timezone mapping
const COUNTRY_PROFILES = {
  DE: { timezone: "Europe/Berlin", lang: "de-DE", languages: ["de-DE", "de", "en"] },
  FR: { timezone: "Europe/Paris", lang: "fr-FR", languages: ["fr-FR", "fr", "en"] },
  NL: { timezone: "Europe/Amsterdam", lang: "nl-NL", languages: ["nl-NL", "nl", "en"] },
  ES: { timezone: "Europe/Madrid", lang: "es-ES", languages: ["es-ES", "es", "en"] },
  IT: { timezone: "Europe/Rome", lang: "it-IT", languages: ["it-IT", "it", "en"] },
  PL: { timezone: "Europe/Warsaw", lang: "pl-PL", languages: ["pl-PL", "pl", "en"] },
  AT: { timezone: "Europe/Vienna", lang: "de-AT", languages: ["de-AT", "de", "en"] },
  BE: { timezone: "Europe/Brussels", lang: "nl-BE", languages: ["nl-BE", "fr-BE", "en"] },
  SE: { timezone: "Europe/Stockholm", lang: "sv-SE", languages: ["sv-SE", "sv", "en"] },
  PT: { timezone: "Europe/Lisbon", lang: "pt-PT", languages: ["pt-PT", "pt", "en"] },
  CZ: { timezone: "Europe/Prague", lang: "cs-CZ", languages: ["cs-CZ", "cs", "en"] },
  DK: { timezone: "Europe/Copenhagen", lang: "da-DK", languages: ["da-DK", "da", "en"] },
  FI: { timezone: "Europe/Helsinki", lang: "fi-FI", languages: ["fi-FI", "fi", "en"] },
  IE: { timezone: "Europe/Dublin", lang: "en-IE", languages: ["en-IE", "en"] },
  NO: { timezone: "Europe/Oslo", lang: "nb-NO", languages: ["nb-NO", "no", "en"] },
  RO: { timezone: "Europe/Bucharest", lang: "ro-RO", languages: ["ro-RO", "ro", "en"] },
  HU: { timezone: "Europe/Budapest", lang: "hu-HU", languages: ["hu-HU", "hu", "en"] },
  GR: { timezone: "Europe/Athens", lang: "el-GR", languages: ["el-GR", "el", "en"] },
  SK: { timezone: "Europe/Bratislava", lang: "sk-SK", languages: ["sk-SK", "sk", "en"] },
  BG: { timezone: "Europe/Sofia", lang: "bg-BG", languages: ["bg-BG", "bg", "en"] },
  HR: { timezone: "Europe/Zagreb", lang: "hr-HR", languages: ["hr-HR", "hr", "en"] },
  LT: { timezone: "Europe/Vilnius", lang: "lt-LT", languages: ["lt-LT", "lt", "en"] },
  LV: { timezone: "Europe/Riga", lang: "lv-LV", languages: ["lv-LV", "lv", "en"] },
  EE: { timezone: "Europe/Tallinn", lang: "et-EE", languages: ["et-EE", "et", "en"] },
  SI: { timezone: "Europe/Ljubljana", lang: "sl-SI", languages: ["sl-SI", "sl", "en"] },
  LU: { timezone: "Europe/Luxembourg", lang: "fr-LU", languages: ["fr-LU", "de-LU", "en"] },
};

// OS profiles with matching UA templates, platform strings, and typical resolutions
const OS_PROFILES = {
  windows: {
    platform: "Win32",
    resolutions: [
      { width: 1920, height: 1080 },
      { width: 1366, height: 768 },
      { width: 1536, height: 864 },
      { width: 1280, height: 720 },
    ],
    deviceScaleFactor: 1,
    chrome: (v) => `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${v}.0.0.0 Safari/537.36`,
    edge: (v) => `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${v}.0.0.0 Safari/537.36 Edg/${v}.0.0.0`,
    firefox: (v) => `Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:${v}.0) Gecko/20100101 Firefox/${v}.0`,
  },
  mac: {
    platform: "MacIntel",
    resolutions: [
      { width: 1440, height: 900 },
      { width: 1680, height: 1050 },
      { width: 1920, height: 1080 },
      { width: 2560, height: 1440 },
    ],
    deviceScaleFactor: 2, // Retina
    chrome: (v) => `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${v}.0.0.0 Safari/537.36`,
    safari: () => `Mozilla/5.0 (Macintosh; Intel Mac OS X 14_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.2 Safari/605.1.15`,
    firefox: (v) => `Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:${v}.0) Gecko/20100101 Firefox/${v}.0`,
  },
  linux: {
    platform: "Linux x86_64",
    resolutions: [
      { width: 1920, height: 1080 },
      { width: 1366, height: 768 },
      { width: 1280, height: 1024 },
    ],
    deviceScaleFactor: 1,
    chrome: (v) => `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${v}.0.0.0 Safari/537.36`,
    firefox: (v) => `Mozilla/5.0 (X11; Linux x86_64; rv:${v}.0) Gecko/20100101 Firefox/${v}.0`,
  },
};

const CHROME_VERSIONS = [130, 131, 132, 133];
const FIREFOX_VERSIONS = [132, 133, 134];

// Current session profile (set by buildSessionProfile)
let currentSessionProfile = null;

/**
 * Build a fully consistent session profile.
 * @param {string|null} country   - proxy country code (e.g. "DE")
 * @param {boolean} useSimpleBrowser - true = Puppeteer Chromium, false = System Chrome
 * @returns {object} session profile with ua, platform, resolution, locale, timezone, etc.
 */
function buildSessionProfile(country, useSimpleBrowser) {
  // 1. Pick OS — System Chrome on Mac only runs on macOS
  let osKey;
  if (!useSimpleBrowser) {
    // System Chrome = macOS (since executablePath points to /Applications/Google Chrome.app)
    osKey = "mac";
  } else {
    // Puppeteer Chromium — pick any OS
    const osKeys = ["windows", "mac", "linux"];
    osKey = osKeys[Math.floor(Math.random() * osKeys.length)];
  }
  const os = OS_PROFILES[osKey];

  // 2. Pick browser brand — must produce a Chromium-based UA for Puppeteer compatibility
  //    (Firefox/Safari UAs are only cosmetic — the actual engine is still Chromium)
  //    So we stick to Chrome/Edge UAs which are truthful for the engine.
  let ua;
  const chromeVer = CHROME_VERSIONS[Math.floor(Math.random() * CHROME_VERSIONS.length)];
  if (osKey === "windows" && Math.random() > 0.6) {
    // 40% chance of Edge on Windows
    ua = os.edge(chromeVer);
  } else {
    ua = os.chrome(chromeVer);
  }

  // 3. Pick resolution matching OS
  const resolution = os.resolutions[Math.floor(Math.random() * os.resolutions.length)];

  // 4. Locale/timezone from proxy country
  const countryProfile = (country && COUNTRY_PROFILES[country]) || COUNTRY_PROFILES["DE"];

  // 5. Build Accept-Language with quality values for realism
  //    e.g. "de-DE,de;q=0.9,en;q=0.8"
  const langs = countryProfile.languages;
  const acceptLanguage = langs
    .map((l, i) => (i === 0 ? l : `${l};q=${(1 - i * 0.1).toFixed(1)}`))
    .join(",");

  return {
    osKey,
    ua,
    platform: os.platform,
    resolution,
    deviceScaleFactor: os.deviceScaleFactor,
    timezone: countryProfile.timezone,
    locale: countryProfile.lang,
    languages: langs,
    acceptLanguage,
    country: country || "DE",
  };
}

function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

async function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function humanDelay(minMs = 2000, maxMs = 5000) {
  // Use a slightly random distribution to feel more natural
  const base = Math.floor(Math.random() * (maxMs - minMs)) + minMs;
  const jitter = Math.floor(Math.random() * 800) - 400; // ±400ms jitter
  return delay(Math.max(500, base + jitter));
}

// Simulate random mouse movements and scrolling to look human
async function simulateHumanActivity(page) {
  try {
    const viewport = page.viewport() || { width: 1280, height: 900 };
    // Random mouse move
    const x = Math.floor(Math.random() * viewport.width * 0.8) + viewport.width * 0.1;
    const y = Math.floor(Math.random() * viewport.height * 0.6) + viewport.height * 0.1;
    await page.mouse.move(x, y, { steps: Math.floor(Math.random() * 5) + 3 });
    // Occasionally scroll a bit
    if (Math.random() > 0.5) {
      const scrollY = Math.floor(Math.random() * 300) - 100;
      await page.evaluate((dy) => window.scrollBy(0, dy), scrollY);
      await delay(300 + Math.floor(Math.random() * 500));
    }
  } catch {}
}

// Set up page using currentSessionProfile — ensures UA, platform, locale, timezone all match
async function setupAntiDetection(page) {
  const sp = currentSessionProfile;
  if (!sp) return;

  // User agent
  await page.setUserAgent(sp.ua);

  // Viewport matches the OS-appropriate resolution
  await page.setViewport({
    width: sp.resolution.width,
    height: sp.resolution.height,
    deviceScaleFactor: sp.deviceScaleFactor,
  });

  // Accept-Language header with quality values
  await page.setExtraHTTPHeaders({
    "Accept-Language": sp.acceptLanguage,
  });

  // Timezone matching proxy country
  await page.emulateTimezone(sp.timezone);

  // Override navigator properties to match the profile
  await page.evaluateOnNewDocument((profile) => {
    // navigator.languages — match Accept-Language
    Object.defineProperty(navigator, "languages", { get: () => profile.languages });

    // navigator.language — primary language
    Object.defineProperty(navigator, "language", { get: () => profile.languages[0] });

    // navigator.platform — match OS
    Object.defineProperty(navigator, "platform", { get: () => profile.platform });

    // Hide webdriver flag
    Object.defineProperty(navigator, "webdriver", { get: () => false });

    // navigator.hardwareConcurrency — realistic range
    Object.defineProperty(navigator, "hardwareConcurrency", { get: () => profile.cpuCores });

    // navigator.deviceMemory — realistic range
    Object.defineProperty(navigator, "deviceMemory", { get: () => profile.deviceMemory });

    // Realistic plugins (Chrome-based)
    Object.defineProperty(navigator, "plugins", {
      get: () => [
        { name: "Chrome PDF Plugin", filename: "internal-pdf-viewer" },
        { name: "Chrome PDF Viewer", filename: "mhjfbmdgcfjbbpaeojofohoefgiehjai" },
        { name: "Native Client", filename: "internal-nacl-plugin" },
      ],
    });

    // Realistic mimeTypes
    Object.defineProperty(navigator, "mimeTypes", {
      get: () => [
        { type: "application/pdf", suffixes: "pdf", description: "Portable Document Format" },
      ],
    });

    // Prevent detection via permissions API
    const originalQuery = window.navigator.permissions.query;
    window.navigator.permissions.query = (parameters) =>
      parameters.name === "notifications"
        ? Promise.resolve({ state: Notification.permission })
        : originalQuery(parameters);

    // Screen dimensions should match viewport
    Object.defineProperty(screen, "width", { get: () => profile.screenWidth });
    Object.defineProperty(screen, "height", { get: () => profile.screenHeight });
    Object.defineProperty(screen, "availWidth", { get: () => profile.screenWidth });
    Object.defineProperty(screen, "availHeight", { get: () => profile.screenHeight - 40 }); // taskbar
    Object.defineProperty(screen, "colorDepth", { get: () => 24 });
    Object.defineProperty(screen, "pixelDepth", { get: () => 24 });
  }, {
    languages: sp.languages,
    platform: sp.platform,
    cpuCores: pick([4, 8, 12, 16]),
    deviceMemory: pick([4, 8, 16]),
    screenWidth: sp.resolution.width,
    screenHeight: sp.resolution.height,
  });

  console.log(`   [Session] OS: ${sp.osKey}, Country: ${sp.country}`);
  console.log(`   [Session] UA: ${sp.ua}`);
  console.log(`   [Session] Platform: ${sp.platform}, Resolution: ${sp.resolution.width}x${sp.resolution.height} @${sp.deviceScaleFactor}x`);
  console.log(`   [Session] Timezone: ${sp.timezone}, Locale: ${sp.locale}, Accept-Language: ${sp.acceptLanguage}`);
}

async function safeGoto(page, url, retries = 3) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      await page.goto(url, { waitUntil: "networkidle2", timeout: 60000 });

      const isCloudflare = await page.evaluate(() => {
        const title = document.title.toLowerCase();
        const body = document.body ? document.body.innerText.toLowerCase() : "";
        return (
          title.includes("just a moment") ||
          title.includes("attention required") ||
          title.includes("cloudflare") ||
          body.includes("checking your browser") ||
          body.includes("verify you are human") ||
          body.includes("ray id")
        );
      });

      if (isCloudflare) {
        console.log(`      Cloudflare challenge detected (attempt ${attempt}/${retries}), waiting for it to resolve...`);
        await delay(15000);
        const stillBlocked = await page.evaluate(() => {
          const title = document.title.toLowerCase();
          return title.includes("just a moment") || title.includes("cloudflare") || title.includes("attention");
        });
        if (stillBlocked && attempt < retries) {
          console.log(`      Still blocked, waiting longer before retry...`);
          await delay(30000 * attempt);
          continue;
        } else if (stillBlocked) {
          throw new CloudflareBlockError("Cloudflare challenge not resolved after all retries");
        }
        console.log(`      Cloudflare resolved!`);
      }

      // Simulate human activity after page load
      await simulateHumanActivity(page);
      await humanDelay(2000, 4000);
      return;
    } catch (err) {
      if (attempt < retries && (err.message.includes("detached") || err.message.includes("closed") || err.message.includes("timeout") || err.message.includes("Target"))) {
        console.log(`      Navigation error (attempt ${attempt}/${retries}): ${err.message}`);
        await delay(20000 * attempt);
        continue;
      }
      throw err;
    }
  }
}

// ─── Login ───────────────────────────────────────────────────────────────────

async function login(page, username, password) {
  console.log("1. Navigating to Cardmarket...");
  await safeGoto(page, LOGIN_URL);

  const alreadyLoggedIn = await page.evaluate((user) => {
    const headerText = document.body ? document.body.innerText : "";
    return headerText.toUpperCase().includes(user.toUpperCase());
  }, username);

  if (alreadyLoggedIn) {
    console.log("   Already logged in! Skipping login step.");
    return;
  }

  console.log("   Entering credentials...");
  const usernameField = await page.waitForSelector('input[name="username"]', { timeout: 10000 });
  await usernameField.click({ clickCount: 3 });
  await usernameField.type(username, { delay: 50 });

  const passwordField = await page.$('input[name="userPassword"]') || await page.$('input[type="password"]');
  if (passwordField) {
    await passwordField.click({ clickCount: 3 });
    await passwordField.type(password, { delay: 50 });
  }

  console.log("   Clicking LOG IN button...");
  const loginBtn = await page.$('input[value="Log in"], input[value="LOG IN"]');
  if (loginBtn) {
    await Promise.all([
      page.waitForNavigation({ waitUntil: "networkidle2", timeout: 30000 }).catch(() => {}),
      loginBtn.click(),
    ]);
  } else {
    const inputs = await page.$$('input[type="submit"]');
    for (const input of inputs) {
      const val = await page.evaluate((el) => el.value, input);
      if (val.toLowerCase().includes("log in") || val.toLowerCase().includes("login")) {
        await Promise.all([
          page.waitForNavigation({ waitUntil: "networkidle2", timeout: 30000 }).catch(() => {}),
          input.click(),
        ]);
        break;
      }
    }
  }

  await delay(3000);
  console.log(`   Login complete! URL: ${page.url()}`);
}

// ─── Step 2-3: Search for a card via the main search bar ────────────────────

async function searchForCard(page, editionCode, pokemonId) {
  const searchQuery = `${editionCode} ${pokemonId}`;
  // e.g. "ROS048" — padded form
  const exactPattern = `${editionCode}${pokemonId}`.toUpperCase();
  // e.g. "ROS48" — leading zeros stripped from the number
  const strippedNum = String(parseInt(pokemonId, 10));
  const strippedPattern = `${editionCode}${strippedNum}`.toUpperCase();
  const strippedQuery = `${editionCode} ${strippedNum}`;

  const MAX_SEARCH_ATTEMPTS = 2;
  const MAX_RESULT_PAGES = 15;

  // Helper: scan current page for a Singles card link matching either pattern
  const findExactMatch = () =>
    page.evaluate((exactPattern, strippedPattern, edCode, padNum, stripNum) => {
      const candidates = [];
      for (const a of document.querySelectorAll('a[href*="/en/Pokemon/Products/Singles/"]')) {
        const href = a.getAttribute("href") || "";
        const basePath = href.split("?")[0];
        const segments = basePath.split("/").filter(Boolean);
        const singlesIdx = segments.indexOf("Singles");
        if (singlesIdx >= 0 && segments.length > singlesIdx + 2) {
          const text = a.textContent.trim();
          if (text && text.length > 1) {
            candidates.push({ href: basePath, name: text });
          }
        }
      }
      // 1. Try matching by URL slug (works when Cardmarket includes set code in the slug)
      const slug = (c) => (c.href.split("/").pop() || "").toUpperCase();
      const slugMatch = candidates.find(
        (r) => slug(r).endsWith(exactPattern) || slug(r).endsWith(strippedPattern)
      );
      if (slugMatch) return { exact: slugMatch, candidateCount: candidates.length };

      // 2. Fallback: match by card description text, e.g. "(EVS 029)" or "(EVS 29)"
      //    Cardmarket always shows the set code in the link text even when the URL slug omits it.
      const textPatterns = [
        `(${edCode} ${padNum})`,
        `(${edCode} ${stripNum})`,
      ].map(p => p.toUpperCase());
      const textMatch = candidates.find(
        (r) => textPatterns.some(p => r.name.toUpperCase().includes(p))
      );
      return { exact: textMatch || null, candidateCount: candidates.length };
    }, exactPattern, strippedPattern, editionCode.toUpperCase(), pokemonId, strippedNum);

  // Helper: type a query into the search bar (assumes Singles already selected)
  async function typeQuery(searchInput, query) {
    await searchInput.click({ clickCount: 3 });
    await searchInput.type(query, { delay: 80 });
  }

  // Helper: navigate to the full results page by clicking "Show All" or pressing Enter
  async function goToFullResults(searchInput) {
    const showAllHref = await page.evaluate(() => {
      for (const a of document.querySelectorAll("a")) {
        const text = a.textContent.trim().toLowerCase();
        if (text.includes("show all") || text.includes("all results") || text.includes("view all")) {
          return a.getAttribute("href") || null;
        }
      }
      return null;
    });

    if (showAllHref) {
      console.log(`   Clicking "Show All" (${showAllHref})...`);
      await Promise.all([
        page.waitForNavigation({ waitUntil: "networkidle2", timeout: 30000 }).catch(() => {}),
        page.evaluate((href) => {
          for (const a of document.querySelectorAll("a")) {
            if (a.getAttribute("href") === href) { a.click(); return; }
          }
        }, showAllHref),
      ]);
    } else {
      console.log(`   No "Show All" link found. Pressing Enter to submit search...`);
      await Promise.all([
        page.waitForNavigation({ waitUntil: "networkidle2", timeout: 30000 }).catch(() => {}),
        searchInput.press("Enter"),
      ]);
    }
    await humanDelay(2000, 3000);
    console.log(`   Full results page: ${page.url()}`);
  }

  // Helper: paginate through up to MAX_RESULT_PAGES pages looking for an exact match
  async function scanAllResultPages() {
    for (let pageNum = 1; pageNum <= MAX_RESULT_PAGES; pageNum++) {
      const r = await findExactMatch();
      if (r.exact) {
        console.log(`   Found exact match on results page ${pageNum} (${r.candidateCount} candidates): ${r.exact.name}`);
        return r.exact;
      }
      console.log(`   Page ${pageNum}: no match (${r.candidateCount} candidates). Looking for next page...`);

      // Find "next page" link
      const nextHref = await page.evaluate(() => {
        // Cardmarket pagination: look for a link with aria-label containing "next", or text "›"/"»"/"Next"
        for (const a of document.querySelectorAll("a")) {
          const aria = (a.getAttribute("aria-label") || "").toLowerCase();
          const text = a.textContent.trim();
          if (
            aria.includes("next") ||
            text === "›" || text === "»" ||
            text.toLowerCase() === "next"
          ) {
            const href = a.getAttribute("href");
            if (href) return href;
          }
        }
        return null;
      });

      if (!nextHref) {
        console.log(`   No next page link found after page ${pageNum}. End of results.`);
        break;
      }

      const nextUrl = nextHref.startsWith("http")
        ? nextHref
        : `https://www.cardmarket.com${nextHref}`;
      console.log(`   Going to next page: ${nextUrl}`);
      await safeGoto(page, nextUrl);
      await humanDelay(1500, 2500);
    }
    return null;
  }

  for (let attempt = 1; attempt <= MAX_SEARCH_ATTEMPTS; attempt++) {
    console.log(`   Search attempt ${attempt}/${MAX_SEARCH_ATTEMPTS} for "${searchQuery}"...`);

    // 2a. Select "Singles" in the main search bar category dropdown
    console.log(`   Selecting "Singles" in search bar category...`);
    const categorySet = await page.evaluate(() => {
      const selects = document.querySelectorAll("select");
      for (const sel of selects) {
        for (const opt of sel.options) {
          if (opt.text.trim() === "Singles") {
            sel.value = opt.value;
            sel.dispatchEvent(new Event("change", { bubbles: true }));
            return { success: true, selectedValue: opt.value };
          }
        }
      }
      return { success: false, reason: "No 'Singles' option found in any dropdown" };
    });

    if (categorySet.success) {
      console.log(`   Category set to "Singles" (value=${categorySet.selectedValue})`);
    } else {
      console.log(`   Warning: ${categorySet.reason}`);
      if (attempt >= MAX_SEARCH_ATTEMPTS) {
        throw new CloudflareBlockError("Page loaded but search bar category dropdown missing — likely Cloudflare soft block");
      }
    }

    // 2b. Type the original padded query (e.g. "ROS 048")
    const searchInput = await page.$('input[name="searchString"]');
    if (!searchInput) {
      if (attempt >= MAX_SEARCH_ATTEMPTS) {
        throw new CloudflareBlockError("Main search bar input not found — likely Cloudflare soft block");
      }
      console.log(`   Search input not found. Waiting before retry...`);
      await humanDelay(3000, 5000);
      continue;
    }

    console.log(`   Typing "${searchQuery}" in the main search bar...`);
    await typeQuery(searchInput, searchQuery);

    // 2c. Wait for autocomplete, check for exact match
    console.log(`   Waiting for autocomplete results...`);
    await humanDelay(2000, 4000);

    let result = await findExactMatch();
    if (result.exact) {
      console.log(`   Found exact match in autocomplete (${result.candidateCount} candidates): ${result.exact.name}`);
      return result.exact;
    }

    // Extended wait and re-check
    console.log(`   No exact match yet (${result.candidateCount} candidates). Waiting longer...`);
    await humanDelay(3000, 5000);
    result = await findExactMatch();
    if (result.exact) {
      console.log(`   Found exact match after extended wait (${result.candidateCount} candidates): ${result.exact.name}`);
      return result.exact;
    }

    // 2d. Retry autocomplete with stripped query (e.g. "ROS 48") if different
    if (strippedQuery !== searchQuery) {
      console.log(`   No match for "${searchQuery}". Trying stripped query "${strippedQuery}"...`);
      await typeQuery(searchInput, strippedQuery);
      await humanDelay(2000, 4000);
      result = await findExactMatch();
      if (result.exact) {
        console.log(`   Found exact match with stripped query (${result.candidateCount} candidates): ${result.exact.name}`);
        return result.exact;
      }
      await humanDelay(2000, 3000);
      result = await findExactMatch();
      if (result.exact) {
        console.log(`   Found exact match with stripped query (extended wait, ${result.candidateCount} candidates): ${result.exact.name}`);
        return result.exact;
      }
      console.log(`   No match with stripped query either (${result.candidateCount} candidates). Going to full results...`);
    } else {
      console.log(`   No match in autocomplete (${result.candidateCount} candidates). Going to full results...`);
    }

    // 2e. Navigate to full results page and paginate
    await goToFullResults(searchInput);
    const match = await scanAllResultPages();
    if (match) return match;

    console.log(`   No exact match found across all result pages.`);

    if (attempt < MAX_SEARCH_ATTEMPTS) {
      console.log(`   Retrying from main page...`);
      await safeGoto(page, LOGIN_URL);
      await humanDelay(2000, 3000);
    }
  }

  console.log(`   Card "${searchQuery}" not found after ${MAX_SEARCH_ATTEMPTS} attempts. Skipping.`);
  return null;
}

// ─── Step 5: Apply filters on card detail page ──────────────────────────────

async function applyCardFilters(page, reverseHolo) {
  console.log("   5. Applying filters...");

  // Open the filter sidebar
  await page.evaluate(() => {
    const filterIcon = document.querySelector(".fonticon-filter");
    if (filterIcon) filterIcon.click();
  });
  await delay(1500);

  // Determine reverseHolo filter value
  // "Yes" => "Y", "No" => "N", "Any" or empty => "" (don't change)
  let holoValue = "";
  if (reverseHolo.toLowerCase() === "yes") holoValue = "Y";
  else if (reverseHolo.toLowerCase() === "no") holoValue = "N";
  // "Any" => leave default

  const result = await page.evaluate(({ holoValue }) => {
    const applied = [];
    const form = document.querySelector("#FilterForm");
    if (!form) return { success: false, reason: "No #FilterForm found" };

    // 1. Language = English (checkbox)
    const langCb = form.querySelector('input[name="language[1]"]');
    if (langCb) {
      langCb.checked = true;
      applied.push("Language = English");
    } else {
      applied.push("Language checkbox not found");
    }

    // 2. Min. Condition = Near Mint (value "2")
    const condSelect = form.querySelector('select[name="minCondition"]');
    if (condSelect) {
      condSelect.value = "2";
      applied.push("Min Condition = Near Mint");
    } else {
      applied.push("minCondition select not found");
    }

    // 3. Seller Location: check all EXCEPT United Kingdom and Switzerland
    const countryCheckboxes = form.querySelectorAll('input[name^="sellerCountry["]');
    const excludeCountries = ["united kingdom", "switzerland", "japan", "singapore", "canada"];
    let checkedCount = 0;
    let uncheckedCount = 0;

    for (const cb of countryCheckboxes) {
      // Find the label/text associated with this checkbox
      let countryName = "";

      // Try: label element with matching for attribute
      const id = cb.id;
      if (id) {
        const label = form.querySelector(`label[for="${id}"]`);
        if (label) countryName = label.textContent.trim();
      }

      // Fallback: closest parent's text content or adjacent text
      if (!countryName) {
        const parent = cb.closest("label");
        if (parent) countryName = parent.textContent.trim();
      }
      if (!countryName) {
        // Check next sibling text
        const next = cb.nextSibling;
        if (next && next.nodeType === 3) countryName = next.textContent.trim();
        if (!countryName && next && next.nodeType === 1) countryName = next.textContent.trim();
      }

      // Also try aria-label or title on nearby elements
      if (!countryName) {
        const wrapper = cb.closest(".form-check, .checkbox, div");
        if (wrapper) {
          const spans = wrapper.querySelectorAll("span[aria-label], span[title]");
          for (const s of spans) {
            const label = s.getAttribute("aria-label") || s.getAttribute("title") || "";
            if (label) { countryName = label; break; }
          }
          if (!countryName) countryName = wrapper.textContent.trim();
        }
      }

      const isExcluded = excludeCountries.some(
        (exc) => countryName.toLowerCase().includes(exc)
      );

      if (isExcluded) {
        cb.checked = false;
        uncheckedCount++;
        applied.push(`Seller Location: UNCHECKED "${countryName}"`);
      } else {
        cb.checked = true;
        checkedCount++;
      }
    }

    if (countryCheckboxes.length > 0) {
      applied.push(`Seller Location: checked ${checkedCount}, unchecked ${uncheckedCount} (excl. UK, CH, JP, SG, CA)`);
    } else {
      applied.push("Seller Location checkboxes not found");
    }

    // 4. Reverse Holo
    if (holoValue) {
      const holoSelect = form.querySelector('select[name="extra[isReverseHolo]"]');
      if (holoSelect) {
        holoSelect.value = holoValue;
        applied.push(`ReverseHolo = ${holoValue === "Y" ? "Yes" : "No"}`);
      } else {
        applied.push("ReverseHolo select not found");
      }
    } else {
      applied.push("ReverseHolo = Any (not filtered)");
    }

    return { success: true, applied };
  }, { holoValue });

  if (!result.success) {
    console.log(`      Filter error: ${result.reason}`);
    return false;
  }
  for (const msg of result.applied) {
    console.log(`      ${msg}`);
  }

  // Submit the filter form
  console.log("      Submitting filters...");
  try {
    await Promise.all([
      page.waitForNavigation({ waitUntil: "networkidle2", timeout: 30000 }),
      page.click('#FilterForm input[type="submit"][name="apply"]'),
    ]);
    await humanDelay(2000, 3000);
    console.log(`      Filters applied. URL: ${page.url()}`);
    return true;
  } catch (err) {
    // Fallback: JS submit
    try {
      await Promise.all([
        page.waitForNavigation({ waitUntil: "networkidle2", timeout: 30000 }),
        page.evaluate(() => {
          const form = document.querySelector("#FilterForm");
          const btn = form.querySelector('input[type="submit"][name="apply"]');
          if (btn) btn.click();
          else form.requestSubmit();
        }),
      ]);
      await humanDelay(2000, 3000);
      console.log(`      Filters applied (JS fallback). URL: ${page.url()}`);
      return true;
    } catch (err2) {
      console.log(`      Error submitting filters: ${err2.message}`);
      return false;
    }
  }
}

// ─── Step 6: Extract card details from detail page ──────────────────────────

async function extractCardDetails(page) {
  const data = await page.evaluate(() => {
    const result = {
      cardName: "",
      rarity: "",
      number: "",
      printedIn: "",
      species: "",
      availableItems: "",
      fromPrice: "",
      priceTrend: "",
      avg30Days: "",
      avg7Days: "",
      avg1Day: "",
    };

    // Card name from h1
    const h1 = document.querySelector("h1");
    result.cardName = h1 ? h1.textContent.trim() : "Unknown";

    // Extract all dt/dd pairs for card info
    const dtElements = document.querySelectorAll("dt");
    for (const dt of dtElements) {
      const label = dt.textContent.trim().toLowerCase();
      const dd = dt.nextElementSibling;
      if (!dd) continue;
      const value = dd.textContent.trim();

      if (label.includes("rarity")) {
        // Rarity value may be an icon — check for alt text, title, or aria-label
        result.rarity = value;
        if (!value) {
          const img = dd.querySelector("img");
          if (img) result.rarity = img.getAttribute("alt") || img.getAttribute("title") || "";
          if (!result.rarity) {
            const span = dd.querySelector("span[aria-label], span[title], span[data-bs-original-title]");
            if (span) result.rarity = span.getAttribute("aria-label") || span.getAttribute("title") || span.getAttribute("data-bs-original-title") || "";
          }
        }
      } else if (label === "number") {
        result.number = value;
      } else if (label.includes("printed in")) {
        result.printedIn = value;
      } else if (label.includes("species")) {
        result.species = value;
      } else if (label.includes("available items")) {
        result.availableItems = value;
      } else if (label === "from") {
        result.fromPrice = value;
      } else if (label.includes("price trend")) {
        result.priceTrend = value;
      } else if (label.includes("30-day") || label.includes("30 day")) {
        result.avg30Days = value;
      } else if (label.includes("7-day") || label.includes("7 day")) {
        result.avg7Days = value;
      } else if (label.includes("1-day") || label.includes("1 day")) {
        result.avg1Day = value;
      }
    }

    // Extract top 5 sellers from the offers table
    result.sellers = [];
    const sellerRows = document.querySelectorAll(".table-body > .article-row");
    for (const row of sellerRows) {
      if (result.sellers.length >= 5) break;

      // Seller name and profile link
      let sellerName = "";
      let sellerProfileHref = "";
      let sellerCountry = "";

      const sellerLinks = row.querySelectorAll("a");
      for (const link of sellerLinks) {
        const href = link.getAttribute("href") || "";
        if (href.includes("/Users/") || href.includes("/user/")) {
          sellerName = link.textContent.trim();
          sellerProfileHref = href;
          break;
        }
      }

      // Country from icon aria-label "Item location: Country"
      const icons = row.querySelectorAll("span[aria-label], span[data-bs-original-title]");
      for (const icon of icons) {
        const label = icon.getAttribute("aria-label") || icon.getAttribute("data-bs-original-title") || "";
        const match = label.match(/Item location:\s*(.+)/i);
        if (match) {
          sellerCountry = match[1].trim();
          break;
        }
      }

      // Price — leaf element matching "X,XX €"
      let price = "";
      const allEls = row.querySelectorAll("*");
      for (const el of allEls) {
        if (el.children.length === 0) {
          const text = el.textContent.trim();
          if (text.match(/^\d+[,.]\d+\s*€$/) && text.includes(",")) {
            price = text;
            break;
          }
        }
      }

      if (sellerName || price) {
        result.sellers.push({
          name: sellerName || "Unknown",
          country: sellerCountry || "",
          profileUrl: sellerProfileHref ? "https://www.cardmarket.com" + sellerProfileHref : "",
          price: price || "N/A",
        });
      }
    }

    return result;
  });

  return data;
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  console.log("=== Cardmarket Price Scraper ===\n");

  if (!PRICES_SPREADSHEET_ID) {
    console.error('ERROR: Set PRICES_SPREADSHEET_ID at the top of ScrapePrices.js to your "Card Prices" Google Sheet ID.');
    process.exit(1);
  }

  const config = loadConfig();
  const inputCards = await loadInputFromSheet();

  if (inputCards.length === 0) {
    console.log("No cards to process.");
    return;
  }

  // Apify residential proxy setup (EU countries, excluding UK and CH)
  const EU_COUNTRIES = [
    "DE", "FR", "NL", "BE", "AT", "IT", "ES", "PT", "PL", "CZ",
    "SE", "DK", "FI", "NO", "IE", "HU", "RO", "BG", "HR", "SK",
    "SI", "LT", "LV", "EE", "GR", "LU",
  ];
  const apifyUser = process.env.APIFYUSERNAME;
  const apifyPass = process.env.APIFYPASSWORD;
  const useProxy = !!(apifyUser && apifyPass);

  if (useProxy) {
    console.log(`Proxy: Apify residential`);
    console.log(`  Server: http://proxy.apify.com:8000`);
    console.log(`  Type: Residential, EU countries (excl. UK/CH)`);
    console.log(`  IP rotation: every 1-5 cards`);
  } else {
    console.log("Proxy: None (APIFYUSERNAME/APIFYPASSWORD not set in .env)");
  }

  // Proxy rotation state
  let proxyCardCount = 0;
  let proxyRotateAfter = 0; // will be set on first launch
  let currentUserDataDir = null;

  // Browser type rotation: alternate between system Chrome and Puppeteer Chromium
  let useSimpleBrowser = !!config.simpleBrowser;

  const MAX_LAUNCH_RETRIES = 5;

  // Launch a single browser attempt (no retry logic here)
  async function _launchOnce() {
    const country = useProxy ? EU_COUNTRIES[Math.floor(Math.random() * EU_COUNTRIES.length)] : null;
    const sessionId = useProxy ? `cm_${Date.now()}_${Math.floor(Math.random() * 100000)}` : null;
    proxyRotateAfter = 1 + Math.floor(Math.random() * 5);
    proxyCardCount = 0;

    // Build a consistent session profile: OS ↔ UA ↔ platform ↔ resolution ↔ locale
    currentSessionProfile = buildSessionProfile(country, useSimpleBrowser);

    const launchOptions = {
      headless: config.headless,
      defaultViewport: null,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        `--window-size=${currentSessionProfile.resolution.width},${currentSessionProfile.resolution.height}`,
        "--disable-blink-features=AutomationControlled",
        ...(useProxy ? ["--proxy-server=http://proxy.apify.com:8000"] : []),
      ],
      ignoreDefaultArgs: ["--enable-automation"],
    };
    if (!useSimpleBrowser) {
      launchOptions.executablePath = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
      if (useProxy) {
        launchOptions.userDataDir = `/tmp/cardmarket-chrome-${sessionId}`;
      } else {
        launchOptions.userDataDir = "/tmp/cardmarket-chrome-profile";
      }
    }
    currentUserDataDir = launchOptions.userDataDir || null;

    console.log(`   [Session] Browser: ${useSimpleBrowser ? "Puppeteer Chromium" : "System Chrome"}`);
    const newBrowser = await puppeteer.launch(launchOptions);
    const newPage = await newBrowser.newPage();
    await setupAntiDetection(newPage);

    if (useProxy) {
      const username = `groups-RESIDENTIAL,session-${sessionId},country-${country}`;
      await newPage.authenticate({ username, password: apifyPass });
      console.log(`   [Proxy] New session → country: ${country}, session: ${sessionId} (next rotation in ${proxyRotateAfter} cards)`);
    }

    // Navigate to Cardmarket on the fresh browser
    console.log("   [Session] Navigating to Cardmarket...");
    await safeGoto(newPage, LOGIN_URL);

    return { browser: newBrowser, page: newPage };
  }

  // Launch (or relaunch) browser with a fully consistent session profile
  // On connection failure: close browser, rotate proxy/browser type, and retry
  async function launchBrowser(existingBrowser, rotateBrowserType = false) {
    if (existingBrowser) {
      console.log("\n   [Session] Closing browser...");
      try { await existingBrowser.close(); } catch (e) { /* already closed */ }
      if (currentUserDataDir && currentUserDataDir !== "/tmp/cardmarket-chrome-profile") {
        try { fs.rmSync(currentUserDataDir, { recursive: true, force: true }); } catch (e) { /* best effort */ }
      }
      currentUserDataDir = null;
      await new Promise(r => setTimeout(r, 2000 + Math.random() * 3000));
    }

    if (rotateBrowserType) {
      useSimpleBrowser = !useSimpleBrowser;
    }

    for (let attempt = 1; attempt <= MAX_LAUNCH_RETRIES; attempt++) {
      try {
        return await _launchOnce();
      } catch (err) {
        console.error(`\n   [Session] Launch failed (attempt ${attempt}/${MAX_LAUNCH_RETRIES}): ${err.message}`);

        // Close the browser that just failed (may be partially open)
        try {
          const pages = await (err._browser || {}).pages?.() || [];
          if (pages.length) await err._browser.close();
        } catch (e) { /* nothing to close */ }

        if (attempt >= MAX_LAUNCH_RETRIES) {
          throw new Error(`Failed to launch browser after ${MAX_LAUNCH_RETRIES} attempts: ${err.message}`);
        }

        // Rotate proxy + browser type for next attempt
        useSimpleBrowser = !useSimpleBrowser;
        const waitSec = 5 + Math.floor(Math.random() * 10) * attempt;
        console.log(`   [Session] Switching to ${useSimpleBrowser ? "Puppeteer Chromium" : "System Chrome"}, new proxy. Waiting ${waitSec}s...`);
        await delay(waitSec * 1000);
      }
    }
  }

  // Initial launch
  let { browser, page } = await launchBrowser(null);

  try {
    // Step 2-3: Process each card from input
    // If continueFrom is set, skip cards until we reach the matching EditionCode + PokemonID
    let startIndex = 0;
    if (config.continueFrom) {
      const cf = config.continueFrom.replace(/\s+/g, " ").trim().toUpperCase();
      for (let j = 0; j < inputCards.length; j++) {
        const key = `${inputCards[j].editionCode} ${inputCards[j].pokemonId}`.toUpperCase();
        if (key === cf) {
          startIndex = j;
          break;
        }
      }
      console.log(`\n   continueFrom: "${config.continueFrom}" — skipping to card ${startIndex + 1}/${inputCards.length}`);
    }

    let cardsSinceBreak = 0;
    let consecutiveSkips = 0; // track consecutive skips to detect soft blocks

    const MAX_BLOCK_RETRIES = 3; // max browser restarts per card when blocked

    for (let i = startIndex; i < inputCards.length; i++) {
      const card = inputCards[i];
      const searchName = `${card.editionCode} ${card.pokemonId}`;

      // Take a longer break every 15-25 cards to mimic a real user
      cardsSinceBreak++;
      const breakInterval = 15 + Math.floor(Math.random() * 11);
      if (cardsSinceBreak >= breakInterval) {
        const pauseSec = 15 + Math.floor(Math.random() * 30);
        console.log(`\n   [Pause] Taking a ${pauseSec}s break to look human...`);
        await delay(pauseSec * 1000);
        cardsSinceBreak = 0;
      }

      console.log(`\n${"=".repeat(60)}`);
      console.log(`= CARD ${i + 1}/${inputCards.length}: ${searchName} (Expansion: ${card.editionName})`);
      console.log(`=   ReverseHolo: ${card.reverseHolo || "Any"}, Rarity: ${card.rarity || "N/A"}`);
      console.log(`${"=".repeat(60)}`);

      let details = null;
      let cardUrl = null;
      let blocked = false;

      for (let blockRetry = 0; blockRetry < MAX_BLOCK_RETRIES; blockRetry++) {
        try {
          // Step 2: Search via main search bar (Singles category)
          console.log(`\n2-3. Searching main search bar for "${searchName}"...`);
          const match = await searchForCard(page, card.editionCode, card.pokemonId);

          if (!match) {
            consecutiveSkips++;
            // If 3+ cards in a row return no results, it's likely a soft block
            if (consecutiveSkips >= 3) {
              console.log(`   No search results found (${consecutiveSkips} consecutive failures — likely soft block).`);
              throw new CloudflareBlockError(`${consecutiveSkips} consecutive cards returned no results — likely Cloudflare soft block`);
            }
            console.log(`   No search results found. Skipping. (consecutive: ${consecutiveSkips})`);
            break;
          }

          console.log(`   First result: ${match.name} (${match.href})`);

          // Step 4: Navigate to card detail page
          console.log("\n4. Opening card detail page...");
          cardUrl = `https://www.cardmarket.com${match.href}`;
          await safeGoto(page, cardUrl);
          await humanDelay(2000, 3000);
          console.log(`   Loaded: ${page.url()}`);

          // Step 5: Apply filters
          await applyCardFilters(page, card.reverseHolo);

          // Step 6: Extract card details
          console.log("\n   6. Extracting card details...");
          details = await extractCardDetails(page);

          // Check if Cloudflare interstitial was returned instead of card data
          if (details.cardName && /^(www\.|http)/.test(details.cardName)) {
            console.log(`      Card name looks like a URL ("${details.cardName}") — Cloudflare page detected.`);
            throw new CloudflareBlockError("Card detail page returned Cloudflare interstitial");
          }

          blocked = false;
          consecutiveSkips = 0; // reset on success
          break; // success — exit retry loop
        } catch (err) {
          const isCloudflare = err instanceof CloudflareBlockError;
          const isRecoverable = isCloudflare ||
            err.message.includes("net::ERR_") ||
            err.message.includes("timeout") ||
            err.message.includes("Timeout") ||
            err.message.includes("Navigation") ||
            err.message.includes("detached") ||
            err.message.includes("closed") ||
            err.message.includes("Target") ||
            err.message.includes("Session") ||
            err.message.includes("Protocol") ||
            err.message.includes("ECONNREFUSED") ||
            err.message.includes("ECONNRESET") ||
            err.message.includes("ETIMEDOUT") ||
            err.message.includes("socket hang up") ||
            err.message.includes("ERR_PROXY") ||
            err.message.includes("ERR_TUNNEL") ||
            err.message.includes("ERR_CONNECTION") ||
            err.message.includes("ERR_EMPTY_RESPONSE") ||
            err.message.includes("ERR_FAILED");

          if (!isRecoverable) {
            throw err; // truly unexpected error — don't swallow
          }

          blocked = true;
          const errorType = isCloudflare ? "Cloudflare block" : "Connection/navigation error";
          console.log(`\n   [ERROR] ${errorType} on card ${searchName} (attempt ${blockRetry + 1}/${MAX_BLOCK_RETRIES})`);
          console.log(`   [ERROR] ${err.message}`);
          if (blockRetry < MAX_BLOCK_RETRIES - 1) {
            console.log("   [ERROR] Rotating proxy + browser type and restarting session...");
            const waitSec = 10 + Math.floor(Math.random() * 20);
            console.log(`   [ERROR] Waiting ${waitSec}s before restart...`);
            await delay(waitSec * 1000);
            try {
              const result = await launchBrowser(browser, true);
              browser = result.browser;
              page = result.page;
            } catch (launchErr) {
              console.log(`   [ERROR] Browser relaunch failed: ${launchErr.message}`);
              console.log("   [ERROR] Trying once more with opposite browser type...");
              await delay(5000);
              const result = await launchBrowser(null, true);
              browser = result.browser;
              page = result.page;
            }
            console.log("   [ERROR] New session ready. Retrying card...\n");
          } else {
            console.log(`   [ERROR] All ${MAX_BLOCK_RETRIES} attempts exhausted. Skipping card.`);
          }
        }
      }

      // Skip saving if blocked or no details
      if (blocked || !details || (details.cardName && /^(www\.|http)/.test(details.cardName))) {
        continue;
      }

      console.log(`      Card Name:    ${details.cardName}`);
      console.log(`      Rarity:       ${details.rarity}`);
      console.log(`      Number:       ${details.number}`);
      console.log(`      Printed In:   ${details.printedIn}`);
      console.log(`      Species:      ${details.species}`);
      console.log(`      Available:    ${details.availableItems}`);
      console.log(`      From:         ${details.fromPrice}`);
      console.log(`      Price Trend:  ${details.priceTrend}`);
      console.log(`      30-Day Avg:   ${details.avg30Days}`);
      console.log(`      7-Day Avg:    ${details.avg7Days}`);
      console.log(`      1-Day Avg:    ${details.avg1Day}`);

      // Log top 5 sellers
      if (details.sellers && details.sellers.length > 0) {
        console.log(`\n      Top ${details.sellers.length} Sellers:`);
        for (let s = 0; s < details.sellers.length; s++) {
          const sel = details.sellers[s];
          console.log(`        ${s + 1}. ${sel.name} | ${sel.country} | ${sel.price} | ${sel.profileUrl}`);
        }
      } else {
        console.log("\n      No sellers found.");
      }

      // Step 7: Save to Google Sheet
      console.log("\n   7. Saving to Google Sheet...");
      const timestamp = new Date().toISOString();
      const row = [
        timestamp,
        card.editionName,
        details.cardName,
        card.editionCode,
        card.pokemonId,
        card.reverseHolo || "Any",
        details.rarity || card.rarity || "",
        details.number,
        details.printedIn,
        details.species,
        details.availableItems,
        details.fromPrice,
        details.priceTrend,
        details.avg30Days,
        details.avg7Days,
        details.avg1Day,
        cardUrl,
      ];
      // Append seller columns (5 sellers x 4 fields)
      for (let s = 0; s < 5; s++) {
        const sel = (details.sellers && details.sellers[s]) || {};
        row.push(sel.name || "", sel.country || "", sel.price || "", sel.profileUrl || "");
      }
      await appendRowToSheet(row);
      console.log("      Saved!");

      // Rotate proxy IP after processing 1-5 cards — restart browser session
      proxyCardCount++;
      if (proxyCardCount >= proxyRotateAfter) {
        const result = await launchBrowser(browser);
        browser = result.browser;
        page = result.page;
      }
    }

    console.log(`\n\nAll done! Processed ${inputCards.length} card(s).`);
  } catch (error) {
    console.error(`\nError: ${error.message}`);
    try {
      await page.screenshot({ path: "error_prices_screenshot.png", fullPage: false });
      console.log("Error screenshot saved to error_prices_screenshot.png");
    } catch (e) { /* browser may already be closed */ }
  } finally {
    await browser.close();
  }
}

main();
