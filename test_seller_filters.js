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

  // Navigate to a seller's singles page
  console.log("Navigating to seller singles page...");
  await page.goto("https://www.cardmarket.com/en/Pokemon/Users/Creation07/Offers/Singles", {
    waitUntil: "networkidle2",
    timeout: 60000,
  });
  await delay(5000);

  console.log(`Page loaded: ${page.url()}`);
  await page.screenshot({ path: "test_seller_1_loaded.png", fullPage: false });

  // Check if filter form exists and dump its fields
  const formInfo = await page.evaluate(() => {
    const form = document.querySelector("#FilterForm");
    if (!form) return { exists: false, formCount: document.querySelectorAll("form").length, formIds: Array.from(document.querySelectorAll("form")).map(f => f.id || f.action) };

    const info = { exists: true, formId: form.id, action: form.action, fields: [] };

    // All inputs
    const inputs = form.querySelectorAll("input, select");
    for (const el of inputs) {
      if (el.tagName === "SELECT") {
        info.fields.push({
          type: "select",
          name: el.name,
          value: el.value,
          selectedText: el.options[el.selectedIndex]?.text,
          options: Array.from(el.options).map(o => ({ value: o.value, text: o.text, selected: o.selected })),
        });
      } else if (el.type === "checkbox") {
        info.fields.push({
          type: "checkbox",
          name: el.name,
          value: el.value,
          checked: el.checked,
        });
      } else if (el.type === "hidden") {
        info.fields.push({
          type: "hidden",
          name: el.name,
          value: el.value,
        });
      } else {
        info.fields.push({
          type: el.type,
          name: el.name,
          value: el.value,
        });
      }
    }

    // Submit buttons
    const submits = form.querySelectorAll('input[type="submit"], button[type="submit"]');
    info.submitButtons = Array.from(submits).map(s => ({ name: s.name, value: s.value || s.textContent }));

    return info;
  });

  console.log("\n=== SELLER PAGE FILTER FORM (#FilterForm) ===");
  console.log(JSON.stringify(formInfo, null, 2));

  // Dump the actual filter form (the one with FilterUserInventory action)
  const sellerFilterForm = await page.evaluate(() => {
    const forms = document.querySelectorAll("form");
    for (const form of forms) {
      if (form.action.includes("Filter")) {
        const info = { action: form.action, id: form.id, classes: form.className, fields: [] };
        const inputs = form.querySelectorAll("input, select");
        for (const el of inputs) {
          if (el.tagName === "SELECT") {
            info.fields.push({
              type: "select",
              name: el.name,
              value: el.value,
              selectedText: el.options[el.selectedIndex]?.text,
              options: Array.from(el.options).map(o => ({ value: o.value, text: o.text, selected: o.selected })),
            });
          } else if (el.type === "checkbox") {
            info.fields.push({ type: "checkbox", name: el.name, value: el.value, checked: el.checked });
          } else if (el.type === "submit") {
            info.fields.push({ type: "submit", name: el.name, value: el.value });
          } else {
            info.fields.push({ type: el.type, name: el.name, value: el.value });
          }
        }
        return info;
      }
    }
    return null;
  });
  console.log("\n=== ACTUAL SELLER FILTER FORM ===");
  console.log(JSON.stringify(sellerFilterForm, null, 2));

  // Also check if there's a fonticon-filter to open sidebar
  const sidebarInfo = await page.evaluate(() => {
    const filterIcon = document.querySelector(".fonticon-filter");
    const section = document.querySelector("section#filter");
    return {
      hasFilterIcon: !!filterIcon,
      hasFilterSection: !!section,
      sectionClasses: section?.className,
    };
  });
  console.log("\n=== SIDEBAR INFO ===");
  console.log(JSON.stringify(sidebarInfo, null, 2));

  await browser.close();
  console.log("\nDone!");
})();
