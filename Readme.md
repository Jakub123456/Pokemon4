# Cardmarket Pokémon card scraper

Node.js tool that uses [Puppeteer](https://pptr.dev/) to scan [Cardmarket](https://www.cardmarket.com/) Pokémon singles: it walks expansion listings, opens each card with fixed filters (English, Near Mint, Reverse Holo), then follows the cheapest sellers and flags listings where the seller price is below a configurable fraction of the 30-day average. Results are written to local files and appended to Google Sheets in near real time.

## Requirements

- **Node.js** (LTS recommended; CommonJS project with `googleapis` and `puppeteer`)
- **Google Chrome** — the launch path in `scraper.js` is set for macOS:
  - `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`  
  On Linux or Windows, edit `executablePath` in `puppeteer.launch()` to match your install.
- **Google Cloud service account** — JSON key file next to the script. The code expects the filename `poke-491015-130855de8aa7.json` (see `SERVICE_ACCOUNT_KEY` in `scraper.js`). The file is gitignored; do not commit it.
- **Google Sheets** — enable the Sheets API for the project, then share your target spreadsheets with the service account’s client email (…`@…iam.gserviceaccount.com`) as Editor. Spreadsheet IDs are constants at the top of `scraper.js` (`RESULTS_SPREADSHEET_ID`, `LOGS_SPREADSHEET_ID`); change them if you use your own sheets.

## Install

```bash
npm install
```

## Configuration

`cards.json` is required at the project root and is gitignored. Copy the example and edit it:

```bash
cp cards.example.json cards.json
```

### `cards.json` fields

```json
{
  "username": "your_cardmarket_username",
  "password": "your_cardmarket_password",
  "maxSellers": 5,
  "noDealLimit": 20,
  "dealThreshold": 0.5,
  "headless": false,
  "expansions": [
    { "expansion": "151", "idExpansion": 5402 },
    { "expansion": "Base-Set", "idExpansion": 1 }
  ]
}
```

| Field | Description | Default |
| --- | --- | --- |
| `username` | Cardmarket login (optional if a saved session exists in the Chrome profile) | `""` |
| `password` | Cardmarket password | `""` |
| `maxSellers` | How many cheapest sellers to take from each card’s offers table | `10` |
| `noDealLimit` | After this many consecutive inventory cards with no deal, stop scanning that seller | `20` |
| `dealThreshold` | Deal when `seller price / 30-day average <` this value (e.g. `0.5` = below 50% of average) | `0.5` |
| `headless` | Run Chrome headless | `false` |
| `expansions` | Non-empty array of expansion objects | required |
| `expansion` | Slug as in the Cardmarket URL path (`…/Singles/{expansion}?site=…`) | required |
| `idExpansion` | Optional metadata; stored in JSON output with each card. Listing URLs use `expansion` only, not this id. | — |

## Run

```bash
node scraper.js
```

### Browser profile

Puppeteer uses a persistent user data directory: `/tmp/cardmarket-chrome-profile`. That keeps you logged in between runs when credentials are omitted or after the first successful login.

## How it works

1. **Login** — Opens Cardmarket and signs in when username/password are set; otherwise relies on the persisted profile.
2. **Expansion listings** — For each `expansion` slug, paginates `perSite=50` and collects English singles detail links.
3. **Card page** — Opens each card, then applies filters via the **left-hand filter form**: Language English, minimum condition Near Mint, Reverse Holo yes (with fallbacks if a control is missing).
4. **Offers** — Reads the 30-day average and up to `maxSellers` cheapest sellers (name, price, condition, profile URL, country when the DOM exposes it).
5. **Per seller** — Opens the seller’s singles page with the same filter pattern, walks their listed cards in order, and compares each listing to the 30-day average.
6. **Early exit** — Stops scanning that seller after `noDealLimit` consecutive cards that are not deals.
7. **Deals** — A deal is `seller price / 30-day average < dealThreshold`. Each match increments that seller’s deal count; seller summaries and per-card rows are pushed to Sheets as the run progresses.

## Output

### Local files (project root)

| File | Role |
| --- | --- |
| `results.json` | Full structured run data (search card, expansion, sellers, per-card ratios, deal flags, URLs). Updated after each card and at the end. |
| `results.log` | Human-readable summary. |
| `result_screenshot.png` | Final viewport screenshot after a successful run. |
| `filtered_screenshot.png` | Screenshot after applying filters on a card page (debugging). |
| `error_screenshot.png` | Written when the main `try` block throws. |
| `error_<seller>.png` / `error_card_<n>.png` | Captures when a seller or card fails. |

All of the above except what you add to `.gitignore` for your own policy should stay out of version control if they contain personal data; `results.json`, `results.log`, and `*.png` are already ignored.

### Google Sheets

- **Results workbook** (`RESULTS_SPREADSHEET_ID`): **Sheet1** — one row per seller-inventory card checked; **Sheet2** — one row per seller with deal counts and euro sums/delta.
- **Logs workbook** (`LOGS_SPREADSHEET_ID`): **Sheet1** — appended run and step logs.

Headers are created automatically on first append when the first row is empty.

### Example console excerpt

```
║  RESULTS: Beedrill  (MEW 015) 151 - Singles
║  30-Day Average Price: 1,15 €
╠══════════════════════════════════════════════════════════╣
║  Kjetil38            | 0,50 €  | NM   | 1
║    Profile: https://www.cardmarket.com/en/Pokemon/Users/Kjetil38
║    └ Beedrill  (MEW 015): seller 0,50 € vs avg 1,15 € (43.5%) <<DEAL>>
║      https://www.cardmarket.com/en/Pokemon/Products/Singles/151/Beedrill-MEW015
```

## Helper scripts (development)

| Script | Purpose |
| --- | --- |
| `explore.js` | Inspect Cardmarket singles markup / form controls |
| `test_filters.js` | Exercise filter submission on a card detail page |
| `test_seller_filters.js` | Exercise filters on a seller’s singles page |

## Legal and etiquette

Automated access may be restricted by Cardmarket’s terms of use. Use reasonable delays, do not overload the site, and run this only for personal research in line with applicable rules and laws.
