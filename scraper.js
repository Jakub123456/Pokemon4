const puppeteer = require("puppeteer");
const fs = require("fs");
const path = require("path");
const { google } = require("googleapis");

const LOGIN_URL = "https://www.cardmarket.com/en/Pokemon";
const CARDS_FILE = "cards.json";
const SERVICE_ACCOUNT_KEY = path.join(__dirname, "poke-491015-130855de8aa7.json");
const LOGS_SPREADSHEET_ID = "1A5vor-VWtTYo4NMM9yrxOPdBbJyr6NEuLpeSN5wi1C4";
const RESULTS_SPREADSHEET_ID = "1U8XiRcGgPLRau70gzeiLwgzxaCeLgJd1DR6VzmJJKUc";

// Google Sheets auth and helpers
async function getSheetsClient() {
  const auth = new google.auth.GoogleAuth({
    keyFile: SERVICE_ACCOUNT_KEY,
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
  const client = await auth.getClient();
  return google.sheets({ version: "v4", auth: client });
}

// Google Sheets: ensure headers exist, then provide append helpers
let sheetsResultHeaderDone = false;
let sheetsSummaryHeaderDone = false;
let sheetsLogsHeaderDone = false;

async function ensureResultsHeader() {
  if (sheetsResultHeaderDone) return;
  try {
    const sheets = await getSheetsClient();
    const existing = await sheets.spreadsheets.values.get({
      spreadsheetId: RESULTS_SPREADSHEET_ID,
      range: "Sheet1!A1:A1",
    }).catch(() => null);
    if (!existing || !existing.data.values || existing.data.values.length === 0) {
      await sheets.spreadsheets.values.append({
        spreadsheetId: RESULTS_SPREADSHEET_ID,
        range: "Sheet1!A1",
        valueInputOption: "RAW",
        requestBody: { values: [["Timestamp", "Search Card", "Expansion", "Card Name", "30-Day Avg", "Seller", "Seller Price", "Condition", "Seller Card", "Seller Card Price", "Card 30-Day Avg", "Ratio", "Is Deal", "Card URL", "Seller Profile"]] },
      });
    }
  } catch (err) {
    console.log(`   Warning: Failed to write results header: ${err.message}`);
  }
  sheetsResultHeaderDone = true;
}

async function ensureSummaryHeader() {
  if (sheetsSummaryHeaderDone) return;
  try {
    const sheets = await getSheetsClient();
    const existing = await sheets.spreadsheets.values.get({
      spreadsheetId: RESULTS_SPREADSHEET_ID,
      range: "Sheet2!A1:A1",
    }).catch(() => null);
    if (!existing || !existing.data.values || existing.data.values.length === 0) {
      await sheets.spreadsheets.values.append({
        spreadsheetId: RESULTS_SPREADSHEET_ID,
        range: "Sheet2!A1",
        valueInputOption: "RAW",
        requestBody: { values: [["Timestamp", "Seller", "Country", "Seller Page", "Number of Deals", "Sum of Deal Prices (€)", "Sum of Deal 30-Day Averages (€)", "Delta (€)"]] },
      });
    }
  } catch (err) {
    console.log(`   Warning: Failed to write summary header: ${err.message}`);
  }
  sheetsSummaryHeaderDone = true;
}

// Append a single card result row to Results Sheet1
async function appendCardResultToSheet(searchCard, expansion, cardName, avgPrice30Days, sellerName, sellerPrice, condition, dealCard) {
  try {
    await ensureResultsHeader();
    const sheets = await getSheetsClient();
    const timestamp = new Date().toISOString();
    const row = [
      timestamp,
      searchCard,
      expansion,
      cardName,
      avgPrice30Days || "",
      sellerName,
      sellerPrice || "",
      condition || "",
      dealCard.name || "",
      dealCard.sellerPrice || "",
      dealCard.avgPrice30Days || "",
      dealCard.ratio !== null && dealCard.ratio !== undefined ? `${(dealCard.ratio * 100).toFixed(1)}%` : "N/A",
      dealCard.isDeal ? "YES" : "NO",
      dealCard.cardUrl || "",
      dealCard.profileUrl || "",
    ];
    await sheets.spreadsheets.values.append({
      spreadsheetId: RESULTS_SPREADSHEET_ID,
      range: "Sheet1!A1",
      valueInputOption: "RAW",
      requestBody: { values: [row] },
    });
  } catch (err) {
    console.log(`   Warning: Failed to append card result to Sheet: ${err.message}`);
  }
}

// Append a seller summary row to Results Sheet2 after all their cards are analyzed
async function appendSellerSummaryToSheet(sellerName, country, profileUrl, cardDetails) {
  try {
    await ensureSummaryHeader();
    const sheets = await getSheetsClient();
    const timestamp = new Date().toISOString();
    let dealCount = 0, dealSellerSum = 0, dealAvgSum = 0;
    for (const card of cardDetails) {
      if (card.isDeal) {
        dealCount++;
        const sp = parsePrice(card.sellerPrice);
        const ap = parsePrice(card.avgPrice30Days);
        if (sp !== null) dealSellerSum += sp;
        if (ap !== null) dealAvgSum += ap;
      }
    }
    const delta = dealAvgSum - dealSellerSum;
    const row = [timestamp, sellerName, country || "", profileUrl, dealCount, dealSellerSum.toFixed(2), dealAvgSum.toFixed(2), delta.toFixed(2)];
    await sheets.spreadsheets.values.append({
      spreadsheetId: RESULTS_SPREADSHEET_ID,
      range: "Sheet2!A1",
      valueInputOption: "RAW",
      requestBody: { values: [row] },
    });
  } catch (err) {
    console.log(`   Warning: Failed to append seller summary to Sheet: ${err.message}`);
  }
}

// Append one or more log rows to the Logs sheet immediately
async function appendLogToSheet(...rows) {
  try {
    const sheets = await getSheetsClient();
    if (!sheetsLogsHeaderDone) {
      const timestamp = new Date().toISOString();
      rows.unshift(["=== Cardmarket Scraper Run ===", timestamp], []);
      sheetsLogsHeaderDone = true;
    }
    await sheets.spreadsheets.values.append({
      spreadsheetId: LOGS_SPREADSHEET_ID,
      range: "Sheet1!A1",
      valueInputOption: "RAW",
      requestBody: { values: rows },
    });
  } catch (err) {
    console.log(`   Warning: Failed to append log to Sheet: ${err.message}`);
  }
}

// Credentials and settings are loaded from cards.json at runtime

function loadConfig() {
  if (!fs.existsSync(CARDS_FILE)) {
    console.error(`Input file "${CARDS_FILE}" not found.`);
    console.error('Example format:\n{\n  "maxSellers": 10,\n  "noDealLimit": 20,\n  "expansions": [\n    { "expansion": "151", "idExpansion": 5402 }\n  ]\n}');
    process.exit(1);
  }
  const raw = fs.readFileSync(CARDS_FILE, "utf-8");
  const config = JSON.parse(raw);

  const expansions = config.expansions || [];
  if (expansions.length === 0) {
    console.error(`"${CARDS_FILE}" must contain a non-empty "expansions" array.`);
    process.exit(1);
  }

  console.log(`Loaded ${expansions.length} expansion(s) from config\n`);

  return {
    username: config.username || "",
    password: config.password || "",
    maxSellers: config.maxSellers || 10,
    noDealLimit: config.noDealLimit || 20,
    dealThreshold: config.dealThreshold || 0.5,
    headless: config.headless !== undefined ? config.headless : false,
    expansions,
  };
}

// Load all card links from an expansion's listing page(s)
async function loadExpansionCards(page, expansion) {
  const perSite = 50;
  const allCards = [];
  let siteNum = 1;
  let hasMore = true;

  while (hasMore) {
    const url = `https://www.cardmarket.com/en/Pokemon/Products/Singles/${encodeURIComponent(expansion)}?site=${siteNum}&perSite=${perSite}`;
    console.log(`   Loading page ${siteNum}: ${url}`);
    await safeGoto(page, url);
    await humanDelay(2000, 3000);

    const pageCards = await page.evaluate(() => {
      const cards = [];
      const seen = new Set();
      // Only match English card detail links
      for (const a of document.querySelectorAll('a[href*="/en/Pokemon/Products/Singles/"]')) {
        const href = a.getAttribute("href") || "";
        const basePath = href.split("?")[0];
        const segments = basePath.split("/").filter(Boolean);
        // Card detail: /en/Pokemon/Products/Singles/{expansion}/{card-name} = 6 segments
        // Expansion listing: /en/Pokemon/Products/Singles/{expansion} = 5 segments
        const singlesIdx = segments.indexOf("Singles");
        if (singlesIdx >= 0 && segments.length > singlesIdx + 2 && !seen.has(basePath)) {
          let text = a.textContent.trim();
          // Clean up "From X,XX €" suffix from listing page links
          text = text.replace(/From\s+\d+[,.]\d+\s*€.*$/, "").trim();
          if (text && text.length > 1) {
            seen.add(basePath);
            cards.push({ href: basePath, name: text });
          }
        }
      }
      return cards;
    });

    console.log(`   Found ${pageCards.length} cards on page ${siteNum}`);
    if (pageCards.length > 0) {
      console.log(`   First: ${pageCards[0].name} (${pageCards[0].href})`);
      console.log(`   Last: ${pageCards[pageCards.length - 1].name} (${pageCards[pageCards.length - 1].href})`);
    }
    allCards.push(...pageCards);

    // If we got fewer than perSite, we've reached the last page
    if (pageCards.length < perSite) {
      hasMore = false;
    } else {
      siteNum++;
    }
  }

  return allCards;
}

async function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Random delay between min and max ms to look more human
async function humanDelay(minMs = 2000, maxMs = 5000) {
  const ms = Math.floor(Math.random() * (maxMs - minMs)) + minMs;
  return delay(ms);
}

// Navigate to a URL with Cloudflare protection handling and retries
async function safeGoto(page, url, retries = 3) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      await page.goto(url, { waitUntil: "networkidle2", timeout: 60000 });

      // Check for Cloudflare challenge page
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
        console.log(`      Cloudflare challenge detected (attempt ${attempt}/${retries}), waiting...`);
        // Wait for the challenge to resolve (Cloudflare typically takes 5-15s)
        await delay(15000);

        // Check if it resolved
        const stillBlocked = await page.evaluate(() => {
          const title = document.title.toLowerCase();
          return title.includes("just a moment") || title.includes("cloudflare");
        });

        if (stillBlocked && attempt < retries) {
          console.log(`      Still blocked, waiting longer before retry...`);
          await delay(30000 * attempt);
          continue;
        } else if (stillBlocked) {
          throw new Error("Cloudflare challenge not resolved after all retries");
        }
      }

      // Add a human-like delay after each page load
      await humanDelay(2000, 4000);
      return; // Success
    } catch (err) {
      if (attempt < retries && (err.message.includes("detached") || err.message.includes("closed") || err.message.includes("timeout") || err.message.includes("Target"))) {
        console.log(`      Navigation error (attempt ${attempt}/${retries}): ${err.message}`);
        console.log(`      Waiting ${20 * attempt}s before retry...`);
        await delay(20000 * attempt);
        // If frame was detached, try to get a fresh page reference
        try {
          const pages = await page.browser().pages();
          if (pages.length > 0) {
            const activePage = pages[pages.length - 1];
            if (activePage !== page) {
              // Cloudflare may have opened a new tab/page
              console.log(`      Switching to active page...`);
            }
          }
        } catch {}
        continue;
      }
      throw err;
    }
  }
}

async function login(page, username, password) {
  console.log("1. Navigating to Cardmarket...");
  await safeGoto(page, LOGIN_URL);

  // Check if already logged in (persistent Chrome profile may have session)
  const alreadyLoggedIn = await page.evaluate((user) => {
    const headerText = document.body ? document.body.innerText : "";
    return headerText.toUpperCase().includes(user.toUpperCase());
  }, username);

  if (alreadyLoggedIn) {
    console.log("   Already logged in! Skipping login step.");
    return;
  }

  // The login form is in the top header bar with username/password inputs
  // and a "LOG IN" button
  console.log("   Entering credentials in header bar...");

  // Clear and type username
  const usernameField = await page.waitForSelector(
    'input[name="username"]',
    { timeout: 10000 }
  );
  await usernameField.click({ clickCount: 3 });
  await usernameField.type(username, { delay: 50 });

  // Clear and type password
  const passwordField = await page.$('input[name="userPassword"]');
  if (passwordField) {
    await passwordField.click({ clickCount: 3 });
    await passwordField.type(password, { delay: 50 });
  } else {
    const pwField = await page.$('input[type="password"]');
    await pwField.click({ clickCount: 3 });
    await pwField.type(PASSWORD, { delay: 50 });
  }

  // Click the LOG IN button
  console.log("   Clicking LOG IN button...");
  const loginBtn = await page.$('input[value="Log in"], input[value="LOG IN"]');
  if (loginBtn) {
    await Promise.all([
      page.waitForNavigation({ waitUntil: "networkidle2", timeout: 30000 }).catch(() => {}),
      loginBtn.click(),
    ]);
  } else {
    // Find by iterating buttons/inputs
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
  console.log(`   Current URL after login: ${page.url()}`);
  console.log("   Login complete!");
}

// Helper: fill the filter form on card detail or seller page, then submit.
// Card detail page: form #FilterForm (POST Product_Filter_FilterProduct)
//   - Language: checkboxes input[name="language[1]"] (1=English)
//   - Condition: select[name="minCondition"] (2=Near Mint)
//   - Reverse Holo: select[name="extra[isReverseHolo]"] (Y=Yes)
//   - Submit: input[type="submit"][name="apply"] value="Filter"
//
// Seller detail page: form with action FilterUserInventory (no id)
//   - Language: select[name="idLanguage"] (1=English)
//   - Condition: select[name="condition"] (2=Near Mint)
//   - Reverse Holo: select[name="isReverseHolo"] (Y=Yes)
//   - Submit: NO apply button, only reset. Must use form.requestSubmit() or add hidden submit.
async function fillAndSubmitFilterForm(page, { language = true, minCondition = true, reverseHolo = false } = {}) {
  // Open the filter sidebar (collapsed by default on card detail pages)
  console.log("      Opening filter sidebar...");
  await page.evaluate(() => {
    const filterIcon = document.querySelector(".fonticon-filter");
    if (filterIcon) filterIcon.click();
  });
  await delay(1000);

  const result = await page.evaluate(({ lang, cond, holo }) => {
    const applied = [];

    // Detect which page type we're on
    const cardForm = document.querySelector("#FilterForm");
    const sellerForm = Array.from(document.querySelectorAll("form")).find(
      f => f.action && f.action.includes("FilterUserInventory")
    );

    const form = cardForm || sellerForm;
    if (!form) return { success: false, reason: "No filter form found on page" };

    const isSellerPage = !cardForm && !!sellerForm;
    applied.push(`Page type: ${isSellerPage ? "seller" : "card detail"}`);

    // 1. Language = English
    if (lang) {
      if (isSellerPage) {
        // Seller page: select[name="idLanguage"] value="1"
        const langSelect = form.querySelector('select[name="idLanguage"]');
        if (langSelect) {
          langSelect.value = "1";
          applied.push("Language=English (select idLanguage=1)");
        } else {
          applied.push("Language select (idLanguage) not found");
        }
      } else {
        // Card detail page: checkbox input[name="language[1]"]
        const langCheckbox = form.querySelector('input[name="language[1]"]');
        if (langCheckbox) {
          langCheckbox.checked = true;
          applied.push("Language=English (checkbox language[1])");
        } else {
          applied.push("Language checkbox not found");
        }
      }
    }

    // 2. Min. Condition = Near Mint (value "2")
    if (cond) {
      if (isSellerPage) {
        const condSelect = form.querySelector('select[name="condition"]');
        if (condSelect) {
          condSelect.value = "2";
          applied.push("Condition=NearMint (select condition=2)");
        } else {
          applied.push("Condition select not found");
        }
      } else {
        const condSelect = form.querySelector('select[name="minCondition"]');
        if (condSelect) {
          condSelect.value = "2";
          applied.push("MinCondition=NearMint (select minCondition=2)");
        } else {
          applied.push("MinCondition select not found");
        }
      }
    }

    // 3. Reverse Holo = Yes (value "Y")
    if (holo) {
      if (isSellerPage) {
        const holoSelect = form.querySelector('select[name="isReverseHolo"]');
        if (holoSelect) {
          holoSelect.value = "Y";
          applied.push("ReverseHolo=Yes (select isReverseHolo=Y)");
        } else {
          applied.push("ReverseHolo select not found");
        }
      } else {
        const holoSelect = form.querySelector('select[name="extra[isReverseHolo]"]');
        if (holoSelect) {
          holoSelect.value = "Y";
          applied.push("ReverseHolo=Yes (select extra[isReverseHolo]=Y)");
        } else {
          applied.push("ReverseHolo select not found (may not exist for this card)");
        }
      }
    }

    return { success: true, applied, isSellerPage };
  }, { lang: language, cond: minCondition, holo: reverseHolo });

  if (!result.success) {
    console.log(`      ✗ ${result.reason}`);
    return false;
  }

  for (const msg of result.applied) {
    console.log(`      ✓ ${msg}`);
  }

  // Submit the form
  console.log("      Submitting filter form...");
  try {
    if (result.isSellerPage) {
      // Seller page has no apply button — submit via JS
      await Promise.all([
        page.waitForNavigation({ waitUntil: "networkidle2", timeout: 30000 }),
        page.evaluate(() => {
          const form = Array.from(document.querySelectorAll("form")).find(
            f => f.action && f.action.includes("FilterUserInventory")
          );
          if (form) form.requestSubmit();
        }),
      ]);
    } else {
      // Card detail page has the Filter button
      await Promise.all([
        page.waitForNavigation({ waitUntil: "networkidle2", timeout: 30000 }),
        page.click('#FilterForm input[type="submit"][name="apply"]'),
      ]);
    }
    await humanDelay(2000, 3000);
    console.log(`      ✓ Filters submitted. URL: ${page.url()}`);
    return true;
  } catch (err) {
    console.log(`      ✗ Error submitting filters: ${err.message}`);
    return false;
  }
}

// Apply filters on a card detail page (Language=English, MinCondition=NearMint, ReverseHolo=Yes)
async function applyFilters(page) {
  console.log("\n4. Applying filters via left menu (English, Near Mint, Reverse Holo)...");
  await delay(2000);

  await fillAndSubmitFilterForm(page, { language: true, minCondition: true, reverseHolo: true });
}

async function extractData(page, maxSellers) {
  console.log("\n5-6. Extracting price and seller data...");

  // Take screenshot after filters
  await page.screenshot({ path: "filtered_screenshot.png", fullPage: false });

  const data = await page.evaluate((maxSellers) => {
    const result = {
      cardName: "",
      avgPrice30Days: "",
      cheapestSellers: [],
    };

    // Get card name from h1
    const nameEl = document.querySelector("h1");
    result.cardName = nameEl ? nameEl.textContent.trim() : "Unknown";

    // Get 30-days average price from the info section
    // The page uses dt/dd pairs for card info
    const dtElements = document.querySelectorAll("dt");
    for (const dt of dtElements) {
      const text = dt.textContent.trim().toLowerCase();
      if (text.includes("30-day") || text.includes("30 day")) {
        const dd = dt.nextElementSibling;
        if (dd) {
          result.avgPrice30Days = dd.textContent.trim();
        }
        break;
      }
    }

    // Get the 3 cheapest sellers from the offers table
    // The table has rows with: seller info | product info (condition badge) | offer (price)
    // Look for seller rows in the table body
    const sellerRows = document.querySelectorAll(
      ".table-body > .article-row"
    );

    for (const row of sellerRows) {
      if (result.cheapestSellers.length >= maxSellers) break;

      // Seller name and profile link - look for user links
      let sellerName = "";
      let sellerProfileHref = "";
      let sellerCountry = "";
      const sellerLinks = row.querySelectorAll("a");
      for (const link of sellerLinks) {
        const href = link.getAttribute("href") || "";
        if (href.includes("/Users/") || href.includes("/user/")) {
          sellerName = link.textContent.trim();
          sellerProfileHref = href;

          // Extract country from the icon element near the seller name
          // Cardmarket uses span.icon with aria-label="Item location: Country"
          const sellerNameSpan = link.closest(".seller-name, .seller-info");
          if (sellerNameSpan) {
            const icons = sellerNameSpan.querySelectorAll("span.icon[aria-label], span.icon[data-bs-original-title]");
            for (const icon of icons) {
              const label = icon.getAttribute("aria-label") || icon.getAttribute("data-bs-original-title") || "";
              const match = label.match(/Item location:\s*(.+)/i);
              if (match) {
                sellerCountry = match[1].trim();
                break;
              }
            }
          }
          break;
        }
      }
      // Fallback: get any link text that looks like a seller name
      if (!sellerName) {
        for (const link of sellerLinks) {
          const text = link.textContent.trim();
          if (text && !text.includes("€") && text.length > 1 && !["NM","EX","MT","GD","LP","PL","PO"].includes(text)) {
            sellerName = text;
            break;
          }
        }
      }

      // Price - look for price in the offer column
      // The price contains a € symbol and looks like "0,02 €"
      let price = "";
      const allEls = row.querySelectorAll("*");
      for (const el of allEls) {
        // Only match leaf nodes to avoid concatenated text
        if (el.children.length === 0) {
          const text = el.textContent.trim();
          if (text.match(/^\d+[,.]\d+\s*€$/) && text.includes(",")) {
            price = text;
            break;
          }
        }
      }

      // Condition
      let condition = "";
      const badges = row.querySelectorAll("span");
      for (const badge of badges) {
        const text = badge.textContent.trim();
        if (["MT", "NM", "EX", "GD", "LP", "PL", "PO"].includes(text)) {
          condition = text;
          break;
        }
      }

      if (sellerName || price) {
        result.cheapestSellers.push({
          rank: result.cheapestSellers.length + 1,
          seller: sellerName || "Unknown",
          sellerUrl: sellerProfileHref ? `https://www.cardmarket.com${sellerProfileHref}` : "",
          price: price || "N/A",
          condition: condition || "N/A",
          country: sellerCountry || "",
        });
      }
    }

    return result;
  }, maxSellers);

  return data;
}

// Parse a Cardmarket price string like "0,17 €" into a float
function parsePrice(priceStr) {
  if (!priceStr || priceStr === "N/A") return null;
  // Remove €, trim, replace comma with dot
  const cleaned = priceStr.replace("€", "").trim().replace(",", ".");
  const val = parseFloat(cleaned);
  return isNaN(val) ? null : val;
}

// Step 6: Visit a seller's profile and navigate to their Singles
async function goToSellerSingles(page, sellerName) {
  console.log(`\n   6. Visiting seller profile: ${sellerName}...`);

  // Navigate to the seller's offers page for Singles
  const sellerUrl = `https://www.cardmarket.com/en/Pokemon/Users/${sellerName}/Offers/Singles`;
  await safeGoto(page, sellerUrl);

  console.log(`      Loaded: ${page.url()}`);
}

// Step 7: Apply filters on seller's singles page by clicking left menu
async function applySellerFilters(page) {
  console.log("   7. Applying filters (English, Near Mint, Reverse Holo) on seller page via left menu...");
  await delay(2000);

  await fillAndSubmitFilterForm(page, { language: true, minCondition: true, reverseHolo: true });
}

// Step 8: Get all card links and their listed prices from the seller's singles page (with pagination)
async function getSellerCardLinks(page) {
  console.log(`   8. Finding cards on seller's page...`);

  const allCardLinks = [];
  const seen = new Set();
  let siteNum = 1;
  let hasMore = true;

  while (hasMore) {
    // Extract cards from the current page
    const pageCards = await page.evaluate(() => {
      const results = [];
      const rows = document.querySelectorAll(".table-body > .article-row");
      for (const row of rows) {
        let cardHref = null;
        let cardName = "";
        const links = row.querySelectorAll('a[href*="/Products/Singles/"]');
        for (const a of links) {
          const href = a.getAttribute("href");
          if (href) {
            const basePath = href.split("?")[0];
            const text = a.textContent.trim();
            if (text && text.length > 1) {
              cardHref = basePath;
              cardName = text;
              break;
            }
          }
        }
        if (!cardHref) continue;

        let sellerPrice = "";
        const allEls = row.querySelectorAll("*");
        for (const el of allEls) {
          if (el.children.length === 0) {
            const t = el.textContent.trim();
            if (t.match(/^\d+[,.]\d+\s*€$/) && t.includes(",")) {
              sellerPrice = t;
              break;
            }
          }
        }
        results.push({ href: cardHref, name: cardName, sellerPrice });
      }
      return results;
    });

    // Deduplicate and add to results
    let newCount = 0;
    for (const card of pageCards) {
      if (!seen.has(card.href)) {
        seen.add(card.href);
        allCardLinks.push(card);
        newCount++;
      }
    }

    console.log(`      Page ${siteNum}: found ${pageCards.length} cards (${newCount} new)`);

    // Check if there's a next page
    if (pageCards.length === 0 || newCount === 0) {
      hasMore = false;
    } else {
      // Navigate to the next page by appending/updating &site= in the URL
      siteNum++;
      const currentUrl = new URL(page.url());
      currentUrl.searchParams.set("site", String(siteNum));
      await safeGoto(page, currentUrl.toString());
      await humanDelay(1500, 2500);
    }
  }

  console.log(`      Total: ${allCardLinks.length} card links`);
  for (const c of allCardLinks) {
    console.log(`        - ${c.name}: ${c.href} (seller price: ${c.sellerPrice || "N/A"})`);
  }

  return allCardLinks;
}

// Step 8 continued: Get the 30-day avg price for a card from its detail page
// The seller's price is already known from their profile page (step 8 getSellerCardLinks)
async function getCardPriceInfo(page, cardHref, knownSellerPrice) {
  // Navigate to the card detail page (no URL params)
  const cardUrl = `https://www.cardmarket.com${cardHref}`;

  console.log(`        Navigating to: ${cardUrl}`);
  await safeGoto(page, cardUrl);

  // Apply filters by filling the filter form and submitting
  console.log(`        Applying filters on card detail page...`);
  await delay(2000);

  await fillAndSubmitFilterForm(page, { language: true, minCondition: true, reverseHolo: true });

  const info = await page.evaluate(() => {
    const result = {
      cardName: "",
      avgPrice30Days: null,
    };

    // Get card name
    const h1 = document.querySelector("h1");
    result.cardName = h1 ? h1.textContent.trim() : "Unknown";

    // Get 30-days average price
    const dtElements = document.querySelectorAll("dt");
    for (const dt of dtElements) {
      const text = dt.textContent.trim().toLowerCase();
      if (text.includes("30-day") || text.includes("30 day")) {
        const dd = dt.nextElementSibling;
        if (dd) {
          result.avgPrice30Days = dd.textContent.trim();
        }
        break;
      }
    }

    return result;
  });

  // Use the seller's price from their profile page
  info.sellerPrice = knownSellerPrice || null;

  return info;
}

// Step 9: Analyze cards for deals (price below dealThreshold of 30-day avg)
function analyzeDeal(avgPrice30DaysStr, sellerPriceStr, dealThreshold) {
  const avg = parsePrice(avgPrice30DaysStr);
  const price = parsePrice(sellerPriceStr);
  if (avg === null || price === null || avg === 0) return { isDeal: false, ratio: null };
  const ratio = price / avg;
  return { isDeal: ratio < dealThreshold, ratio };
}

async function saveResults(allResults) {
  const jsonOutput = {
    timestamp: new Date().toISOString(),
    cardsChecked: allResults.length,
    results: allResults,
  };
  fs.writeFileSync("results.json", JSON.stringify(jsonOutput, null, 2));

  const logLines = [];
  logLines.push(`=== Cardmarket Scraper Results ===`);
  logLines.push(`Date: ${jsonOutput.timestamp}`);
  logLines.push(`Cards checked: ${allResults.length}`);
  logLines.push(``);

  for (const result of allResults) {
    logLines.push(`========================================`);
    logLines.push(`Card: ${result.card}`);
    logLines.push(`Search: expansion="${result.search.expansion}" name="${result.search.name}"`);
    logLines.push(`30-Day Average Price: ${result.avgPrice30Days || "N/A"}`);
    logLines.push(``);
    for (const seller of result.sellers) {
      logLines.push(`--- ${seller.name} | ${seller.price} | ${seller.condition} | Deals: ${seller.dealCount} ---`);
      if (seller.profileUrl) logLines.push(`Profile: ${seller.profileUrl}`);
      for (const card of seller.cards) {
        const dealTag = card.isDeal ? " <<DEAL>>" : "";
        logLines.push(`  ${card.name}: seller ${card.sellerPrice || "N/A"} vs avg ${card.avgPrice30Days || "N/A"} (${card.ratio})${dealTag}`);
        if (card.cardUrl) logLines.push(`    ${card.cardUrl}`);
      }
      logLines.push(``);
    }
  }
  fs.writeFileSync("results.log", logLines.join("\n"));
  console.log("   Results saved to results.json and results.log");
}

async function main() {
  console.log("=== Cardmarket Pokemon Card Scraper ===\n");

  // Load config first so we can use headless setting
  const config = loadConfig();
  const MAX_SELLERS = config.maxSellers;
  const NO_DEAL_LIMIT = config.noDealLimit;
  const DEAL_THRESHOLD = config.dealThreshold;
  console.log(`Settings: maxSellers=${MAX_SELLERS}, noDealLimit=${NO_DEAL_LIMIT}, dealThreshold=${(DEAL_THRESHOLD * 100).toFixed(0)}%, headless=${config.headless}\n`);

  const browser = await puppeteer.launch({
    headless: config.headless,
    defaultViewport: { width: 1280, height: 900 },
    executablePath:
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    userDataDir: "/tmp/cardmarket-chrome-profile",
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-blink-features=AutomationControlled",
    ],
  });

  const page = await browser.newPage();

  // Set a realistic user agent
  await page.setUserAgent(
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
  );

  try {
    // Step 1: Login
    await login(page, config.username, config.password);

    const allResults = [];
    const processedSellers = new Set();
    let globalCardIndex = 0;

    // Loop through each expansion
    for (const expansion of config.expansions) {
      console.log(`\n${"=".repeat(60)}`);
      console.log(`= EXPANSION: ${expansion.expansion}`);
      console.log(`${"=".repeat(60)}`);

      // Step 2: Load all card links from the expansion
      console.log("\n2. Loading all cards from expansion...");
      const expansionCards = await loadExpansionCards(page, expansion.expansion);
      console.log(`\n   Total cards in expansion: ${expansionCards.length}`);

      if (expansionCards.length === 0) {
        console.log("   No cards found — skipping expansion.");
        continue;
      }

      // Process each card
      for (let ci = 0; ci < expansionCards.length; ci++) {
        const card = expansionCards[ci];
        globalCardIndex++;

        console.log(`\n${"#".repeat(60)}`);
        console.log(`# CARD ${ci + 1}/${expansionCards.length}: ${card.name}`);
        console.log(`${"#".repeat(60)}`);

        const cardEntry = { expansion: expansion.expansion, idExpansion: expansion.idExpansion, name: card.name };

        try {
        // Step 3: Navigate to the card detail page
        console.log(`\n3. Opening card: ${card.href}`);
        const cardUrl = `https://www.cardmarket.com${card.href}`;
        await safeGoto(page, cardUrl);
        await humanDelay(2000, 3000);
        console.log(`   Card detail page loaded: ${page.url()}`);

      // Step 4: Apply filters
      await applyFilters(page);

      // Step 5: Extract data (30-day avg + 3 cheapest sellers)
      const data = await extractData(page, MAX_SELLERS);

      console.log("\n========== INITIAL RESULTS ==========");
      console.log(`Card: ${data.cardName}`);
      console.log(`30-Day Average Price: ${data.avgPrice30Days || "N/A"}`);
      console.log(`\nTop 3 Cheapest Sellers:`);

      if (data.cheapestSellers.length === 0) {
        console.log("  No sellers found with current filters.");
      } else {
        for (const seller of data.cheapestSellers) {
          console.log(
            `  ${seller.rank}. ${seller.seller} - ${seller.price} (${seller.condition})${seller.country ? " [" + seller.country + "]" : ""}`
          );
        }
      }
      console.log("======================================\n");

      // Log card search result to Google Sheet immediately
      await appendLogToSheet(
        ["Card", data.cardName, "30-Day Avg", data.avgPrice30Days || "N/A"],
        ["Search", `expansion="${cardEntry.expansion}" name="${cardEntry.name}"`]
      );

      // Steps 6-9: For each of the 3 cheapest sellers, visit their profile,
      // check their first 3 cards, and count deals
      for (const seller of data.cheapestSellers) {
        seller.dealCount = 0;
        seller.cardDetails = [];

        // Skip if this seller was already processed in this run
        if (processedSellers.has(seller.seller)) {
          console.log(`\n===== Skipping seller: ${seller.seller} (already processed) =====`);
          continue;
        }

        console.log(`\n===== Analyzing seller: ${seller.seller} =====`);

        const sellerCountry = seller.country || "";
        if (sellerCountry) console.log(`      Country: ${sellerCountry}`);

        // Log seller start to Google Sheet
        await appendLogToSheet([`  Seller: ${seller.seller}`, `Price: ${seller.price}`, `Condition: ${seller.condition}`, `Country: ${sellerCountry}`]);

        try {
          // Step 6: Go to seller profile -> Singles
          await goToSellerSingles(page, seller.seller);

          // Step 7: Apply filters (English, Near Mint)
          await applySellerFilters(page);

          // Step 8: Get all card links from the seller's page
          const cardLinks = await getSellerCardLinks(page);

          // Step 8 continued: Visit each card and get price info
          // Stop if no deal is found in the last N consecutive cards checked
          let cardsSinceLastDeal = 0;

          for (const card of cardLinks) {
            console.log(`\n      Checking card: ${card.name}... (${cardsSinceLastDeal}/${NO_DEAL_LIMIT} since last deal)`);
            console.log(`        Seller's listed price (from profile): ${card.sellerPrice || "N/A"}`);

            const priceInfo = await getCardPriceInfo(page, card.href, card.sellerPrice);

            console.log(`        Card: ${priceInfo.cardName}`);
            console.log(`        30-Day Avg: ${priceInfo.avgPrice30Days || "N/A"}`);
            console.log(`        Seller Price: ${priceInfo.sellerPrice || "N/A"}`);

            // Step 9: Check if deal (price < 50% of 30-day avg)
            const deal = analyzeDeal(priceInfo.avgPrice30Days, priceInfo.sellerPrice, DEAL_THRESHOLD);

            if (deal.ratio !== null) {
              const pct = (deal.ratio * 100).toFixed(1);
              console.log(`        Price/Avg ratio: ${pct}%`);
              if (deal.isDeal) {
                seller.dealCount++;
                cardsSinceLastDeal = 0;
                console.log(`        >> DEAL! Price is below ${(DEAL_THRESHOLD * 100).toFixed(0)}% of 30-day average`);
              } else {
                cardsSinceLastDeal++;
              }
            } else {
              cardsSinceLastDeal++;
            }

            const cardDetail = {
              name: priceInfo.cardName,
              cardUrl: `https://www.cardmarket.com${card.href}`,
              avgPrice30Days: priceInfo.avgPrice30Days,
              sellerPrice: priceInfo.sellerPrice,
              ratio: deal.ratio,
              isDeal: deal.isDeal,
            };
            seller.cardDetails.push(cardDetail);

            // Write this card result to Google Sheets immediately
            await appendCardResultToSheet(
              cardEntry.name, cardEntry.expansion, data.cardName, data.avgPrice30Days,
              seller.seller, seller.price, seller.condition,
              { ...cardDetail, profileUrl: seller.sellerUrl }
            );
            const ratioStr = deal.ratio !== null ? `${(deal.ratio * 100).toFixed(1)}%` : "N/A";
            await appendLogToSheet([`    ${priceInfo.cardName}`, `Seller: ${priceInfo.sellerPrice || "N/A"}`, `Avg: ${priceInfo.avgPrice30Days || "N/A"}`, `Ratio: ${ratioStr}`, deal.isDeal ? "DEAL" : ""]);

            // Stop checking this seller if no deal found in last 20 cards
            if (cardsSinceLastDeal >= NO_DEAL_LIMIT) {
              console.log(`\n      Stopping: no deal found in last ${NO_DEAL_LIMIT} cards — moving to next seller.`);
              break;
            }
          }
        } catch (err) {
          console.log(`      Error analyzing seller ${seller.seller}: ${err.message}`);
          await page.screenshot({
            path: `error_${seller.seller}.png`,
            fullPage: false,
          });
        }

        // Write seller summary to Google Sheet after all their cards are analyzed
        await appendSellerSummaryToSheet(seller.seller, sellerCountry, seller.sellerUrl, seller.cardDetails || []);
        await appendLogToSheet([`  Seller done: ${seller.seller}`, `Deals: ${seller.dealCount}`]);
        processedSellers.add(seller.seller);
      }

      // Print per-card results
      console.log(`\n\n╔══════════════════════════════════════════════════════════╗`);
      console.log(`║  RESULTS: ${data.cardName}`);
      console.log(`║  30-Day Average Price: ${data.avgPrice30Days || "N/A"}`);
      console.log("╠══════════════════════════════════════════════════════════╣");
      console.log(`║  Seller             | Price   | Cond | Deals (<${(DEAL_THRESHOLD * 100).toFixed(0)}% avg) ║`);
      console.log("╠══════════════════════════════════════════════════════════╣");

      for (const seller of data.cheapestSellers) {
        const name = seller.seller.padEnd(19);
        const price = (seller.price || "N/A").padEnd(7);
        const cond = (seller.condition || "N/A").padEnd(4);
        const deals = String(seller.dealCount || 0);
        console.log(`║  ${name} | ${price} | ${cond} | ${deals}`);
        if (seller.sellerUrl) {
          console.log(`║    Profile: ${seller.sellerUrl}`);
        }

        if (seller.cardDetails) {
          for (const card of seller.cardDetails) {
            const ratio = card.ratio !== null ? `${(card.ratio * 100).toFixed(1)}%` : "N/A";
            const dealMarker = card.isDeal ? " <<DEAL>>" : "";
            console.log(
              `║    └ ${card.name}: seller ${card.sellerPrice || "N/A"} vs avg ${card.avgPrice30Days || "N/A"} (${ratio})${dealMarker}`
            );
            if (card.cardUrl) {
              console.log(`║      ${card.cardUrl}`);
            }
          }
        }
      }

      console.log("╚══════════════════════════════════════════════════════════╝");

      allResults.push({
        search: { expansion: cardEntry.expansion, name: cardEntry.name },
        card: data.cardName,
        avgPrice30Days: data.avgPrice30Days,
        sellers: data.cheapestSellers.map((s) => ({
          name: s.seller,
          profileUrl: s.sellerUrl,
          price: s.price,
          condition: s.condition,
          dealCount: s.dealCount || 0,
          cards: (s.cardDetails || []).map((c) => ({
            name: c.name,
            cardUrl: c.cardUrl,
            sellerPrice: c.sellerPrice,
            avgPrice30Days: c.avgPrice30Days,
            ratio: c.ratio !== null ? `${(c.ratio * 100).toFixed(1)}%` : "N/A",
            isDeal: c.isDeal,
          })),
        })),
      });

      // Save partial results after each card (local files)
      await saveResults(allResults);
      await appendLogToSheet([]);

      } catch (cardErr) {
        console.log(`\n!! Error processing card "${cardEntry.name}": ${cardErr.message}`);
        await page.screenshot({ path: `error_card_${ci + 1}.png`, fullPage: false }).catch(() => {});
        // Save whatever we have so far
        await saveResults(allResults);
      }
      } // end card loop
    } // end expansion loop

    // Final save
    await saveResults(allResults);
    console.log(`\nAll done! Processed ${allResults.length} card(s).`);

    // Take a screenshot for reference
    await page.screenshot({
      path: "result_screenshot.png",
      fullPage: false,
    });
    console.log("Screenshot saved to result_screenshot.png");
  } catch (error) {
    console.error(`\nError: ${error.message}`);
    await page.screenshot({ path: "error_screenshot.png", fullPage: false });
    console.log("Error screenshot saved to error_screenshot.png");
  } finally {
    await browser.close();
  }
}

main();
