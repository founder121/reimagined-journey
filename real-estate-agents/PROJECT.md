# Square Centimeter Ltd — AI Agent Team
## PROJECT.md

**Company:** Square Centimeter Ltd
**Director:** Julian Noble
**Registered:** 27 October 2023 — Companies House, United Kingdom
**Location:** London, United Kingdom
**Status:** Active

---

## What This Project Does

This system is Square Centimeter's AI-powered operational backbone. It automates the
intelligence, analysis, marketing, and client management workflows that support the firm's
core advisory business — sourcing and advising on prime London residential property
investments for high-net-worth and international clients.

The system runs entirely through Claude Code via the `/sc` CLI.

---

## Business Context

Square Centimeter operates as a boutique property advisory and investment firm. It is not
a traditional estate agency. Its value is in curated deal sourcing, investment-grade
analysis, and discreet advisory for sophisticated investors.

**Primary clients:**
- International investors (Middle East, Asia, Europe, Americas)
- Family offices seeking London residential exposure
- High-net-worth individuals and expats acquiring prime London assets
- Developers seeking co-investment or advisory partnerships

**Core services:**
- Prime London property investment advisory
- Deal sourcing and investment analysis
- Acquisition structuring and negotiation support
- Cross-market investment insight (international capital into UK market)

**Target market:**
- Prime Central London (PCL): SW1, SW3, SW7, SW10, W1, W8, WC2, EC1, E1W
- Prime Outer London (POL): Notting Hill, Islington, Fulham, Richmond, Chiswick
- Emerging corridors: Nine Elms, White City, King's Cross, Stratford, Battersea
- Typical deal range: £500,000 – £10,000,000+

---

## System Architecture

```
/real-estate-agents/
├── CLAUDE.md                        ← Agent instructions and operational rules
├── PROJECT.md                       ← This file
├── index.js                         ← CLI router (/sc commands)
├── config/
│   ├── portals.yml                  ← Property listing sources
│   └── lead-sources.yml             ← Investor lead sources and scoring weights
├── agents/
│   ├── agent1-crawler.js            ← Property Scout
│   ├── agent2-leads.js              ← Investor Lead Finder
│   ├── agent3-analyst.js            ← Investment Analyst
│   ├── agent4-marketing.js          ← Marketing Agent
│   └── agent5-sales.js              ← Client Relations Agent
├── utils/
│   └── fileStore.js                 ← File I/O, directory management
├── __tests__/
│   ├── agent1-crawler.test.js
│   ├── agent2-leads.test.js
│   ├── agent3-analyst.test.js
│   ├── agent4-marketing.test.js
│   └── agent5-sales.test.js
├── data/
│   ├── pipeline.md                  ← Items awaiting Julian Noble's review
│   ├── tracker.md                   ← All agent activity log
│   ├── scan-history.tsv             ← Crawl history (timestamp, source, records)
│   └── leads/
│       ├── raw/                     ← Unprocessed leads from Agent 2
│       ├── qualified/               ← Qualified leads from Agent 5
│       └── contacted/               ← Outreach completed
├── reports/
│   └── memo-[address]-YYYY-MM-DD.md ← Investment memos from Agent 3
└── outputs/
    └── marketing-[type]-YYYY-MM-DD/ ← Marketing content from Agent 4
```

---

## The Five Agents

### Agent 1 — Property Scout
**File:** `agents/agent1-crawler.js`
**Command:** `/sc scan`

Crawls prime London property listings from Rightmove, Zoopla, OnTheMarket, Knight Frank,
Savills, and JLL. Parses UK-specific fields: price, postcode, TfL zone, tenure
(leasehold/freehold), service charge, ground rent, developer/vendor, days on market.
Flags PCL/POL properties, new launches, price reductions, and off-market indicators.

**Output:** `data/raw/listings-YYYY-MM-DD.csv` + `.json`

---

### Agent 2 — Investor Lead Finder
**File:** `agents/agent2-leads.js`
**Command:** `/sc leads`

Finds and scores potential HNW investor leads from public sources: HMLR (Land Registry),
Companies House, LinkedIn, and property press. Applies a 4-dimensional scoring model:
investment intent, capital capacity, accessibility, and strategic fit with Square Centimeter.
Identifies motivated vendors (estate sales, relocations, corporate disposals) as well as
active buyers entering the prime London market.

**Output:** `data/leads/raw/leads-YYYY-MM-DD.csv`

**Lead score dimensions:**

| Dimension | Weight |
|-----------|--------|
| Investment intent signal | 40% |
| Capital capacity (£500k+) | 25% |
| Accessibility / contactability | 20% |
| Strategic fit with SC advisory | 15% |

---

### Agent 3 — Investment Analyst
**File:** `agents/agent3-analyst.js`
**Command:** `/sc analyze`

Produces investment-grade property analysis suitable for sharing with HNW clients.
Scores properties 0–100 across five dimensions and outputs an `ACQUIRE / MONITOR / PASS`
recommendation with full financial workings.

**Scoring dimensions:**

| Dimension | Description |
|-----------|-------------|
| Capital Value & Comparables | PCL benchmarks, recent comparable sales |
| Rental Income Potential | Gross yield, net yield, AST and short-let projections |
| Neighbourhood Quality | Schools, TfL zone, amenities, crime index |
| Investment Upside | Appreciation potential, regeneration pipeline, planning uplift |
| Market Conditions | Prime London cycle position, international capital flow trends |

**Calculations produced:**
- Gross yield and net yield
- Cash-on-cash ROI
- Estimated rental income (AST and short-let)
- 5-year capital appreciation projection
- SDLT estimate (including surcharge for overseas buyers)
- Service charge impact on net return
- Lease length warning (flag if < 85 years)

**Output:** `reports/memo-[address-slug]-YYYY-MM-DD.md`

---

### Agent 4 — Marketing Agent
**File:** `agents/agent4-marketing.js`
**Command:** `/sc market top5`

Generates curated, investment-grade marketing content positioning Square Centimeter as
London's premier boutique property adviser. Never salesy or generic — always authoritative
and discreet, appropriate for HNW and family office audiences.

**Content types produced:**
- Deal opportunity brief (one-page investment summary for a specific property)
- LinkedIn thought leadership post (market insight, London trends, deal commentary)
- Monthly investor email newsletter (prime market update format)
- SEO blog post (targeting international HNW investor search terms)

**Output:** `outputs/marketing-[type]-YYYY-MM-DD/`

---

### Agent 5 — Client Relations Agent
**File:** `agents/agent5-sales.js`
**Command:** `/sc outreach`

Manages the investor relationship pipeline on behalf of Julian Noble. Qualifies leads,
prepares briefing notes ahead of calls, schedules viewings, and manages follow-up cadence.
Flags overdue leads (no contact in 7+ days) for immediate attention.

**Qualification criteria:**
- Budget (minimum £500,000)
- Asset class preference (new build, period, mixed-use)
- Timeline (immediate / 3–6 months / 6–12 months)
- UK residency and tax status (resident, non-dom, overseas)
- Preferred London locations (PCL postcodes vs outer zones)

**Output:** `data/leads/qualified/qualified-YYYY-MM-DD.csv` + meeting briefing notes

---

## CLI Commands

```bash
/sc scan          # Scan prime London listings
/sc leads         # Find new HNW investor leads
/sc analyze       # Analyse a property — generates investment memo
/sc market top5   # Generate marketing content for top 5 opportunities
/sc outreach      # Prepare outreach list for overdue qualified leads
/sc report        # Full pipeline report across all agents
/sc list          # Show latest listings from data/raw/
/sc status        # Pipeline counts: raw / qualified / contacted / converted
/sc pipeline      # Show items awaiting Julian Noble's review
```

---

## Data Flow

```
/sc scan
  Agent 1 → data/raw/listings-YYYY-MM-DD.csv

/sc leads
  Agent 2 → data/leads/raw/leads-YYYY-MM-DD.csv

/sc analyze
  Agent 3 (reads data/raw/) → reports/memo-[address]-YYYY-MM-DD.md

/sc market top5
  Agent 4 (reads reports/) → outputs/marketing-[type]-YYYY-MM-DD/

/sc outreach
  Agent 5 (reads data/leads/qualified/) → data/leads/contacted/
  Agent 5 → data/tracker.md

/sc report
  All agents → reports/pipeline-report-YYYY-MM-DD.md
```

---

## Operational Rules

1. **No hallucinated data** — all figures from crawled or user-supplied sources only
2. **Respect robots.txt** — checked before scraping any domain
3. **Rate limiting** — max 1 request/second per domain with random jitter
4. **Public data only** — contact info from public/legal sources only
5. **Client confidentiality** — no client names or deal details in public-facing content
6. **Confirm before acting** — approval required before any outreach or publishing
7. **Leasehold warning** — always flag lease length < 85 years prominently
8. **SDLT awareness** — always include overseas buyer surcharge in cost calculations
9. **Julian Noble review** — high-value items flagged to `data/pipeline.md` before action
10. **Error logging** — all agent errors logged to `data/tracker.md` with timestamp

---

## Dependencies

```bash
npm install -g agent-browser   # JavaScript-heavy site crawling
```

---

## Brand Voice

| Attribute | Description |
|-----------|-------------|
| Authoritative | Deep knowledge of prime London market cycles and capital flows |
| Discreet | Appropriate for HNW, family office, and non-dom audiences |
| Sophisticated | Investment-grade language — no jargon, no hype |
| Curated | Quality and selectivity in every output — never volume-driven |

---

## Key Contacts

| Role | Name |
|------|------|
| Founder & Director | Julian Noble |
| Company | Square Centimeter Ltd |
| Registered | Companies House, United Kingdom |
| Founded | 27 October 2023 |
