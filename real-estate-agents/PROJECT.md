# Real Estate AI Agent Team

## Vision

An autonomous, composable team of five AI agents that handles the full
real estate investment workflow — from sourcing properties and motivated
sellers online, through investment analysis and underwriting, to marketing
outreach and sales scripts — all orchestrated from a single CLI or Claude
Code slash-command.

---

## Problem Statement

Real estate investors spend 60-80 % of their time on repeatable research tasks:

- Combing listing portals for off-market opportunities
- Tracking motivated-seller signals (FSBO, expired listings, probate)
- Running comparable-sales and ROI calculations
- Drafting personalised outreach emails / SMS
- Writing cold-call scripts and follow-up sequences

These tasks are high-volume, low-judgement, and perfectly suited for AI
automation — freeing the investor to focus on deal-making.

---

## Target Users

| Persona | Use Case |
|---------|----------|
| Wholesaler | Find motivated sellers, build cash-buyer lists |
| Fix & Flip Investor | Screen rehab candidates, estimate ARV |
| Buy-and-Hold Landlord | Cashflow analysis, cap-rate comparison |
| Real Estate Agent | Prospect expired listings, auto-draft follow-ups |
| Property Manager | Market vacancies, qualify tenant leads |

---

## Agent Architecture

```
┌──────────────────────────────────────────────────────────┐
│                        index.js  (CLI router)            │
└─────┬───────────┬──────────┬───────────┬────────────┬────┘
      │           │          │           │            │
  Agent 1     Agent 2    Agent 3     Agent 4      Agent 5
  Crawler    LeadFinder  Analyst    Marketing     Sales
      │           │          │           │            │
   data/       data/      data/       data/       stdout
 properties/  leads/    reports/   campaigns/   + campaigns/
```

### Agent 1 — Web Crawler (`agent1-crawler.js`)
- Fetches listing pages from configured portals (Zillow, Realtor.com,
  Redfin, LoopNet, etc.)
- Respects `robots.txt` and configurable per-domain rate limits
- Parses address, price, beds/baths, DOM, lot size, tax info
- Emits clean JSON to `data/properties/`

### Agent 2 — Lead Finder (`agent2-leads.js`)
- Sources motivated-seller signals: FSBO, expired MLS, probate filings,
  pre-foreclosure (all from public county records / listing portals)
- De-duplicates against existing `data/leads/` records
- Stores only legally public data: name from listing, property address,
  listing source URL, days on market

### Agent 3 — Investment Analyst (`agent3-analyst.js`)
- Consumes `data/properties/*.json`
- Calculates: ARV, MAO (Maximum Allowable Offer), cap rate, GRM,
  estimated rehab cost bands, monthly cashflow projection
- Scores each deal 0–100 with configurable strategy weights
  (buy-hold / flip / wholesale)
- Writes ranked report to `data/reports/`

### Agent 4 — Marketing Agent (`agent4-marketing.js`)
- Loads a leads file and a campaign template
- Uses an LLM to personalise subject lines, email body, and SMS copy
- Groups sends into batches respecting provider rate limits
- Stores drafted messages (not yet sent) in `data/campaigns/`
- Integrates with SendGrid (email) and Twilio (SMS) when keys are present

### Agent 5 — Sales Agent (`agent5-sales.js`)
- Reads a leads file and produces call scripts matched to the lead's
  situation (FSBO → curiosity opener; expired → problem/solution frame)
- Generates objection-handling trees and follow-up cadence plans
- Writes CRM-ready notes (compatible with HubSpot / Podio JSON import)

---

## Data Flow

```
Portal HTML/JSON
      │
  [Agent 1]  →  data/properties/{portal}-{date}.json
                        │
                   [Agent 3]  →  data/reports/analysis-{date}.json
                                         │
Public Filings / FSBO listings           │
      │                                  │
  [Agent 2]  →  data/leads/{source}-{date}.json
                        │
                   [Agent 4]  →  data/campaigns/{campaign}-{date}.json
                        │
                   [Agent 5]  →  call scripts / CRM notes
```

---

## Technology Stack

| Layer | Choice | Reason |
|-------|--------|--------|
| Runtime | Node.js 20 LTS | async I/O, rich scraping ecosystem |
| HTTP / crawl | `agent-browser` + `axios` | headless Chrome fallback |
| HTML parsing | `cheerio` | fast, jQuery-like |
| YAML config | `js-yaml` | human-editable portal configs |
| LLM calls | Anthropic Claude API | analyst, marketing, sales agents |
| Rate limiting | custom `utils/rateLimiter.js` | per-domain token bucket |
| robots.txt | custom `utils/robotsChecker.js` | RFC-compliant parser |
| Logging | `winston` | structured JSON logs |
| Testing | `jest` | unit tests per agent |
| CLI | `commander` | `/realestate` subcommand routing |

---

## Compliance & Ethics

This system is designed for **lawful, ethical use only**:

1. **robots.txt respected** — no portal is crawled if its `robots.txt`
   disallows the path.
2. **Rate limiting** — requests are spaced per portal configuration
   (minimum 3 s default) to avoid overloading servers.
3. **Public data only** — lead data is limited to information the owner
   voluntarily published in a public listing or public filing.
4. **No spoofing** — the crawler identifies itself with a descriptive
   User-Agent string.
5. **TCPA / CAN-SPAM awareness** — the marketing agent includes required
   opt-out language and never sends to DNC-registered numbers without
   consent verification.
6. **No fabricated data** — all values are parsed from real source
   documents; the analyst LLM prompt explicitly prohibits hallucination
   of prices, addresses, or comps.

---

## Roadmap

- [ ] v0.1 — Crawler + Analyst (property data pipeline)
- [ ] v0.2 — Lead Finder (motivated-seller sourcing)
- [ ] v0.3 — Marketing Agent (email/SMS drafting)
- [ ] v0.4 — Sales Agent (call scripts, CRM export)
- [ ] v0.5 — Full pipeline (`/realestate pipeline`)
- [ ] v1.0 — Web dashboard, deal tracker, notification hooks
