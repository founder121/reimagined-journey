# Real Estate AI Agent Team — Claude Instructions

## Project Overview
A multi-agent system for real estate investment analysis, lead generation,
marketing automation, and sales support. All agents share a common config
layer and write/read from the `data/` directory.

---

## Agent Commands

### `/realestate crawl [portal] [--pages N] [--state ST]`
Run the **web crawler agent** against a configured portal.  
Respects `robots.txt`; rate-limits every request per `portals.yml`.  
Output lands in `data/properties/`.

```
/realestate crawl zillow --pages 5 --state TX
/realestate crawl realtor --state FL
```

### `/realestate leads [source] [--type TYPE] [--limit N]`
Run the **lead-finder agent** to harvest publicly listed contacts.  
Sources are declared in `lead-sources.yml`.  
Output lands in `data/leads/`.

```
/realestate leads fsbo --limit 50
/realestate leads expired --type residential
```

### `/realestate analyze [--input FILE] [--strategy buy-hold|flip|wholesale]`
Run the **investment analyst agent** against a properties JSON file.  
Produces scored reports in `data/reports/`.

```
/realestate analyze --input data/properties/zillow-2024-01.json --strategy buy-hold
/realestate analyze --strategy flip
```

### `/realestate market [campaign] [--channel email|sms|social] [--leads FILE]`
Run the **marketing agent** to draft and queue outreach campaigns.  
Templates live in `config/`; output drafts land in `data/campaigns/`.

```
/realestate market motivated-sellers --channel email --leads data/leads/fsbo.json
/realestate market cash-buyers --channel sms
```

### `/realestate sales [--leads FILE] [--script cold-call|follow-up|offer]`
Run the **sales agent** to produce personalised call scripts and CRM notes.

```
/realestate sales --leads data/leads/fsbo.json --script cold-call
/realestate sales --script follow-up
```

### `/realestate status`
Print a summary of all recent agent runs and data file counts.

### `/realestate pipeline [--limit N]`
Run the full pipeline: crawl → leads → analyze → market → sales.

---

## File Layout

```
real-estate-agents/
├── CLAUDE.md              ← this file
├── PROJECT.md             ← business description
├── index.js               ← CLI entry point / router
├── package.json
├── config/
│   ├── portals.yml        ← portal crawler config
│   └── lead-sources.yml   ← lead-source config
├── agents/
│   ├── agent1-crawler.js
│   ├── agent2-leads.js
│   ├── agent3-analyst.js
│   ├── agent4-marketing.js
│   └── agent5-sales.js
├── utils/
│   ├── rateLimiter.js
│   ├── robotsChecker.js
│   ├── logger.js
│   └── fileStore.js
└── data/
    ├── properties/        ← crawler output (JSON)
    ├── leads/             ← lead-finder output (JSON)
    ├── reports/           ← analyst output (JSON/Markdown)
    └── campaigns/         ← marketing drafts (JSON/txt)
```

---

## Agent Responsibilities

| Agent | File | Input | Output |
|-------|------|-------|--------|
| Web Crawler | `agent1-crawler.js` | portal config | `data/properties/*.json` |
| Lead Finder | `agent2-leads.js` | lead-source config | `data/leads/*.json` |
| Analyst | `agent3-analyst.js` | properties JSON | `data/reports/*.json` |
| Marketing | `agent4-marketing.js` | leads JSON + campaign | `data/campaigns/*.json` |
| Sales | `agent5-sales.js` | leads JSON | stdout / `data/campaigns/` |

---

## Compliance Rules (Hardcoded)

1. **robots.txt is always checked** before any crawl (`utils/robotsChecker.js`).
2. **Rate limiting** — minimum delay between requests is read from `portals.yml`
   (default 3 s). The system never bursts.
3. **Lead data** — only public listing data (name, address, listing ID) is
   stored. No scraped private contact info.
4. **No hallucinated data** — agents must not invent properties, prices, or
   contact details. All values come from parsed source HTML/JSON.
5. **Data retention** — raw crawl output is timestamped; nothing is silently
   overwritten.

---

## Environment Variables

```
OPENAI_API_KEY      # or ANTHROPIC_API_KEY — used by analyst/marketing/sales
PROXY_URL           # optional rotating proxy for crawlers
LOG_LEVEL           # debug | info | warn | error  (default: info)
DATA_DIR            # override default ./data path
```

---

## Development Workflow

```bash
npm install          # install dependencies
npm test             # run Jest unit tests
npm run lint         # ESLint
node index.js --help # show all commands
```
