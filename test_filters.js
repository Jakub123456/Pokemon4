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

  // Navigate to a card detail page (Beedrill from 151)
  console.log("Navigating to card detail page...");
  await page.goto("https://www.cardmarket.com/en/Pokemon/Products/Singles/151/Beedrill-MEW015", {
    waitUntil: "networkidle2",
    timeout: 60000,
  });
  await delay(5000);

  console.log(`Page loaded: ${page.url()}`);
  await page.screenshot({ path: "test_filter_1_loaded.png", fullPage: false });

  // Check if filter form exists
  const formInfo = await page.evaluate(() => {
    const form = document.querySelector("#FilterForm");
    if (!form) return { exists: false };

    const info = { exists: true, fields: [] };

    // Language checkboxes
    const langCheckboxes = form.querySelectorAll('input[name^="language"]');
    for (const cb of langCheckboxes) {
      info.fields.push({
        type: "checkbox",
        name: cb.name,
        value: cb.value,
        checked: cb.checked,
        id: cb.id,
      });
    }

    // Min. Condition select
    const condSelect = form.querySelector('select[name="minCondition"]');
    if (condSelect) {
      info.fields.push({
        type: "select",
        name: "minCondition",
        value: condSelect.value,
        selectedText: condSelect.options[condSelect.selectedIndex]?.text,
        options: Array.from(condSelect.options).map(o => ({ value: o.value, text: o.text, selected: o.selected })),
      });
    }

    // Extra selects (isReverseHolo, isSigned, isAltered)
    const extraSelects = form.querySelectorAll('select[name^="extra"]');
    for (const sel of extraSelects) {
      info.fields.push({
        type: "select",
        name: sel.name,
        value: sel.value,
        selectedText: sel.options[sel.selectedIndex]?.text,
        options: Array.from(sel.options).map(o => ({ value: o.value, text: o.text, selected: o.selected })),
      });
    }

    // Submit button
    const submitBtn = form.querySelector('input[type="submit"][name="apply"]');
    info.hasSubmitBtn = !!submitBtn;
    if (submitBtn) info.submitBtnValue = submitBtn.value;

    return info;
  });

  console.log("\n=== FILTER FORM INFO (BEFORE) ===");
  console.log(JSON.stringify(formInfo, null, 2));

  if (!formInfo.exists) {
    console.log("Filter form not found! Trying to open sidebar...");
    await page.evaluate(() => {
      const filterIcon = document.querySelector(".fonticon-filter.cursor-pointer");
      if (filterIcon) filterIcon.click();
    });
    await delay(2000);
    await page.screenshot({ path: "test_filter_2_sidebar_opened.png", fullPage: false });
  }

  // Now fill the form
  console.log("\n=== FILLING FILTER FORM ===");

  const fillResult = await page.evaluate(() => {
    const form = document.querySelector("#FilterForm");
    if (!form) return { success: false, reason: "form not found" };

    const applied = [];

    // 1. Check English checkbox
    const langCb = form.querySelector('input[name="language[1]"]');
    if (langCb) {
      langCb.checked = true;
      applied.push(`Language English checkbox checked=${langCb.checked}`);
    } else {
      applied.push("Language[1] checkbox NOT FOUND");
    }

    // 2. Set Min. Condition to Near Mint (value=2)
    const condSel = form.querySelector('select[name="minCondition"]');
    if (condSel) {
      condSel.value = "2";
      applied.push(`MinCondition set to value=${condSel.value} (${condSel.options[condSel.selectedIndex]?.text})`);
    } else {
      applied.push("MinCondition select NOT FOUND");
    }

    // 3. Set Reverse Holo = Yes
    const holoSel = form.querySelector('select[name="extra[isReverseHolo]"]');
    if (holoSel) {
      holoSel.value = "Y";
      applied.push(`ReverseHolo set to value=${holoSel.value} (${holoSel.options[holoSel.selectedIndex]?.text})`);
    } else {
      applied.push("ReverseHolo select NOT FOUND");
    }

    return { success: true, applied };
  });

  console.log(JSON.stringify(fillResult, null, 2));

  // Verify values are set
  const afterFill = await page.evaluate(() => {
    const form = document.querySelector("#FilterForm");
    if (!form) return null;
    return {
      langChecked: form.querySelector('input[name="language[1]"]')?.checked,
      minCondition: form.querySelector('select[name="minCondition"]')?.value,
      reverseHolo: form.querySelector('select[name="extra[isReverseHolo]"]')?.value,
    };
  });
  console.log("\n=== VALUES AFTER FILL ===");
  console.log(JSON.stringify(afterFill, null, 2));

  await page.screenshot({ path: "test_filter_3_filled.png", fullPage: false });

  // Check visibility of the submit button
  const btnVisibility = await page.evaluate(() => {
    const btn = document.querySelector('#FilterForm input[type="submit"][name="apply"]');
    if (!btn) return { exists: false };
    const rect = btn.getBoundingClientRect();
    const style = window.getComputedStyle(btn);
    const parentSection = btn.closest("section#filter");
    const parentStyle = parentSection ? window.getComputedStyle(parentSection) : null;
    return {
      exists: true,
      rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      display: style.display,
      visibility: style.visibility,
      parentDisplay: parentStyle?.display,
      parentVisibility: parentStyle?.visibility,
      parentClasses: parentSection?.className,
    };
  });
  console.log("\n=== SUBMIT BUTTON VISIBILITY ===");
  console.log(JSON.stringify(btnVisibility, null, 2));

  // Try opening the filter sidebar first by clicking the funnel icon
  console.log("\n=== OPENING FILTER SIDEBAR ===");
  const opened = await page.evaluate(() => {
    // The funnel icon in the left sidebar
    const filterIcon = document.querySelector(".fonticon-filter");
    if (filterIcon) {
      filterIcon.click();
      return { clicked: "fonticon-filter" };
    }
    // Also try the section#filter toggle
    const section = document.querySelector("section#filter");
    if (section) {
      section.classList.remove("d-none");
      section.style.display = "block";
      return { toggled: "section#filter" };
    }
    return { nothingFound: true };
  });
  console.log(JSON.stringify(opened, null, 2));
  await delay(2000);
  await page.screenshot({ path: "test_filter_3b_sidebar_opened.png", fullPage: false });

  // Check visibility again
  const btnVisibility2 = await page.evaluate(() => {
    const btn = document.querySelector('#FilterForm input[type="submit"][name="apply"]');
    if (!btn) return { exists: false };
    const rect = btn.getBoundingClientRect();
    const style = window.getComputedStyle(btn);
    return {
      rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      display: style.display,
      visibility: style.visibility,
    };
  });
  console.log("Button visibility after opening sidebar:");
  console.log(JSON.stringify(btnVisibility2, null, 2));

  // Now try submitting - first via page.click, then fallback to JS click
  console.log("\n=== SUBMITTING FILTER ===");

  // Approach 1: Try page.click (needs element to be visible)
  try {
    await Promise.all([
      page.waitForNavigation({ waitUntil: "networkidle2", timeout: 15000 }),
      page.click('#FilterForm input[type="submit"][name="apply"]'),
    ]);
    console.log(`Submitted via page.click! New URL: ${page.url()}`);
  } catch (err) {
    console.log(`page.click failed: ${err.message}`);

    // Approach 2: Submit via JavaScript click
    console.log("Trying JS click...");
    try {
      await Promise.all([
        page.waitForNavigation({ waitUntil: "networkidle2", timeout: 15000 }),
        page.evaluate(() => {
          document.querySelector('#FilterForm input[type="submit"][name="apply"]').click();
        }),
      ]);
      console.log(`Submitted via JS click! New URL: ${page.url()}`);
    } catch (err2) {
      console.log(`JS click failed: ${err2.message}`);

      // Approach 3: Submit the form directly with a hidden input for "apply"
      console.log("Trying form.requestSubmit...");
      try {
        await Promise.all([
          page.waitForNavigation({ waitUntil: "networkidle2", timeout: 15000 }),
          page.evaluate(() => {
            const form = document.querySelector("#FilterForm");
            const btn = form.querySelector('input[type="submit"][name="apply"]');
            form.requestSubmit(btn);
          }),
        ]);
        console.log(`Submitted via requestSubmit! New URL: ${page.url()}`);
      } catch (err3) {
        console.log(`requestSubmit failed: ${err3.message}`);
      }
    }
  }

  await delay(3000);
  await page.screenshot({ path: "test_filter_4_submitted.png", fullPage: false });

  // Check the resulting page's filter state
  const afterSubmit = await page.evaluate(() => {
    const form = document.querySelector("#FilterForm");
    if (!form) return { formExists: false };
    return {
      formExists: true,
      langChecked: form.querySelector('input[name="language[1]"]')?.checked,
      minCondition: form.querySelector('select[name="minCondition"]')?.value,
      reverseHolo: form.querySelector('select[name="extra[isReverseHolo]"]')?.value,
      url: window.location.href,
    };
  });
  console.log("\n=== FILTER STATE AFTER SUBMIT ===");
  console.log(JSON.stringify(afterSubmit, null, 2));

  await browser.close();
  console.log("\nDone!");
})();
