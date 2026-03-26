# Cardmarket Pokemon Card Scraper

A Puppeteer-based scraper that finds underpriced Pokemon cards on Cardmarket by comparing seller prices against 30-day averages, then logs results to Google Sheets.

## Prerequisites

- Node.js
- Google Chrome installed at `/Applications/Google Chrome.app`
- A Google Cloud service account key (`poke-491015-130855de8aa7.json`) with Sheets API access

## Setup

```bash
npm install
```

## How to run

```bash
node scraper.js
```

## Configuration

The scraper reads from **`cards.json`**:

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
|---|---|---|
| `username` | Cardmarket login username | — |
| `password` | Cardmarket login password | — |
| `maxSellers` | Max cheapest sellers to check per card | `10` |
| `noDealLimit` | Stop checking a seller after this many consecutive cards with no deal | `20` |
| `dealThreshold` | Price ratio below which a card counts as a deal (e.g. `0.5` = 50% of 30-day avg) | `0.5` |
| `headless` | Run Chrome in headless mode | `false` |
| `expansions` | List of expansions to scrape | — |
| `expansion` | Expansion name as it appears in the Cardmarket URL path | — |
| `idExpansion` | Numeric expansion ID used in the Cardmarket query string | — |

## How it works

1. **Login** — Opens Cardmarket and logs in via the header bar (skips if session exists from persistent Chrome profile).

2. **Load expansion cards** — For each expansion, paginates through the listing pages and collects all card links.

3. **Open each card** — Navigates to each card's detail page and applies filters via URL parameters:
   - Language = English
   - Min. Condition = Near Mint
   - Extra = Reverse Holo

4. **Extract seller data** — Records the 30-day average price and the cheapest sellers (up to `maxSellers`) with their prices, conditions, profile links, and country.

5. **Explore each seller** — For each seller (skipping duplicates), navigates to their Singles offers page and applies Language + Condition filters.

6. **Check seller's inventory** — Visits each card the seller offers, extracts the 30-day average, and calculates the price ratio. Stops early if `noDealLimit` consecutive cards have no deal.

7. **Identify deals** — A card is a "deal" when `seller price / 30-day average < dealThreshold`.

## Output

### Local files

- **results.json** — Structured JSON with all sellers, cards, prices, deal flags, and links.
- **results.log** — Human-readable text summary.
- **result_screenshot.png** — Screenshot of the last page visited.

### Google Sheets

Results are also pushed to two Google Spreadsheets in real time:

- **Results sheet (Sheet1)** — One row per card checked, with timestamp, card name, expansion, seller, prices, ratio, deal flag, and URLs.
- **Summary sheet (Sheet2)** — One row per seller, with deal count, sum of deal prices, sum of 30-day averages, and delta (potential savings).
- **Logs sheet** — Run logs appended to a separate spreadsheet for monitoring.

### Example console output

```
║  RESULTS: Beedrill  (MEW 015) 151 - Singles
║  30-Day Average Price: 1,15 €
╠══════════════════════════════════════════════════════════╣
║  Kjetil38            | 0,50 €  | NM   | 1
║    Profile: https://www.cardmarket.com/en/Pokemon/Users/Kjetil38
║    └ Beedrill  (MEW 015): seller 0,50 € vs avg 1,15 € (43.5%) <<DEAL>>
║      https://www.cardmarket.com/en/Pokemon/Products/Singles/151/Beedrill-MEW015
```

## Other scripts

| Script | Purpose |
|---|---|
| `explore.js` | Explores the Cardmarket Singles page and dumps all form elements (for development) |
| `test_filters.js` | Tests filter application on a card detail page |
| `test_seller_filters.js` | Tests filter application on a seller's singles page |
