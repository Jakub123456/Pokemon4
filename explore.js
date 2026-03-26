const puppeteer = require("puppeteer");

async function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

(async () => {
  const browser = await puppeteer.launch({
    headless: false,
    defaultViewport: { width: 1280, height: 900 },
    executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    userDataDir: "/tmp/cardmarket-chrome-profile",
    args: ["--no-sandbox", "--disable-blink-features=AutomationControlled"],
  });

  const page = await browser.newPage();
  await page.setUserAgent("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36");

  await page.goto("https://www.cardmarket.com/en/Pokemon/Products/Singles", { waitUntil: "networkidle2", timeout: 60000 });

  // Wait for Cloudflare to resolve and page to fully load
  console.log("Waiting for page to fully load...");
  await delay(10000);

  // If Cloudflare redirected, wait for the real page
  await page.waitForSelector("select, input[type='text']", { timeout: 30000 }).catch(() => {});
  await delay(2000);

  await page.screenshot({ path: "explore_singles_form.png", fullPage: false });

  const title = await page.title();
  console.log(`Page title: ${title}`);

  // Dump all form elements
  const formInfo = await page.evaluate(() => {
    const selects = Array.from(document.querySelectorAll("select")).map(s => ({
      id: s.id, name: s.name,
      optionCount: s.options.length,
      firstOptions: Array.from(s.options).slice(0, 15).map(o => ({ value: o.value, text: o.textContent.trim() }))
    }));
    const inputs = Array.from(document.querySelectorAll("input")).map(i => ({
      id: i.id, name: i.name, type: i.type, placeholder: i.placeholder, value: i.value
    }));
    return { selects, inputs };
  });
  console.log(JSON.stringify(formInfo, null, 2));

  await browser.close();
})();
