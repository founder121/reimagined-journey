# Square Centimeter Ltd — AI Agent Team
## CLAUDE.md — Operational Instructions
**Company:** Square Centimeter Ltd
**Founded:** 27 October 2023
**Location:** London, United Kingdom
**Director:** Julian Noble
**Focus:** Prime London residential property investment and advisory
**Client Profile:** International investors, family offices, high-net-worth individuals
---
## Purpose
This AI agent system supports Square Centimeter's core advisory operations:
- Sourcing and analysing prime London residential investment opportunities
- Identifying and qualifying high-net-worth investor leads
- Producing investment-grade analysis and deal memos
- Supporting international client outreach and marketing
- Tracking deal pipeline from discovery to acquisition
---
## Agents Overview
| Agent | File | Role |
|-------|------|------|
| Agent 1 | agent1-crawler.js | Property Scout — London prime market listings |
| Agent 2 | agent2-leads.js | Investor Lead Finder — HNW & international buyers |
| Agent 3 | agent3-analyst.js | Investment Analyst — deal scoring & advisory memos |
| Agent 4 | agent4-marketing.js | Marketing — content for investors & developers |
| Agent 5 | agent5-sales.js | Client Relations — lead qualification & follow-up |
---
## Commands
```bash
/sc scan              # Agent 1 — Scan prime London listings from portals.yml
/sc leads             # Agent 2 — Find new HNW investor leads
/sc analyze           # Agent 3 — Analyse a property and generate investment memo
/sc market top5       # Agent 4 — Identify top 5 marketing opportunities
/sc outreach          # Agent 5 — Prepare investor outreach list
/sc report            # Generate full pipeline report across all agents
```
---
## Agent Instructions
### Agent 1 — Property Scout (`agent1-crawler.js`)
**Focus:** Prime and emerging London residential developments and investment properties
- Read listing sources from `portals.yml`
- Target markets: Prime Central London (PCL), Prime Outer London, emerging growth corridors
- Key platforms: Rightmove, Zoopla, OnTheMarket, Knight Frank, Savills, JLL, developer sites
- Collect: address, price, tenure (leasehold/freehold), beds, sqft, service charge, ground rent,
  developer/vendor, days on market, price history, planning status if available
- Flag properties with: new development launches, off-market indicators, price reductions,
  motivated vendors, permitted development potential
- Rate limit: max 1 request/second per domain — always respect `robots.txt`
- Output: `data/raw/listings-YYYY-MM-DD.csv` and `data/raw/listings-YYYY-MM-DD.json`
- Log each scan to `data/scan-history.tsv` (timestamp, source, records collected)
### Agent 2 — Investor Lead Finder (`agent2-leads.js`)
**Focus:** International HNW investors, family offices, overseas buyers entering the UK market
- Read sources from `lead-sources.yml`
- Target lead types:
  - International investors (Middle East, Asia, Europe, Americas) with UK property interest
  - Family offices seeking London residential exposure
  - Expats and non-domiciled individuals acquiring prime London assets
  - Developers seeking advisory or co-investment partnerships
  - Motivated vendors of prime assets (estate sales, relocation, corporate disposals)
- Sources: Companies House filings, Land Registry data, LinkedIn, property conference attendees,
  professional networks, legal/accountancy firm announcements — **public data only**
- Score each lead using `lead_score_weights` from config
- Output: `data/leads/raw/leads-YYYY-MM-DD.csv`
- Columns: name, company, nationality, property_interest, budget_range, contact_email,
  contact_phone, linkedin_url, motivation, lead_score (1–10), source_url, date_found,
  status (`new` | `contacted` | `responded` | `meeting_booked` | `converted` | `dead`)
### Agent 3 — Investment Analyst (`agent3-analyst.js`)
**Focus:** Prime London residential — investment-grade deal analysis for HNW clients
- Analyse properties using Square Centimeter's weighted scoring framework:
  - **Capital Value & Comparables** — PCL benchmarks, recent comparable sales
  - **Rental Income Potential** — gross yield, net yield, AST and short-let projections
  - **Neighbourhood Quality** — schools (state and independent), transport (TfL zones),
    amenities, walkability, crime index
  - **Investment Upside** — capital appreciation potential, regeneration pipeline,
    planning uplift opportunities
  - **Market Conditions** — London prime market cycle position, demand/supply dynamics,
    international capital flow trends
- Output: Property Score (0–100) with `ACQUIRE` / `MONITOR` / `PASS` recommendation
- Calculate: gross yield, net yield, cash-on-cash ROI, estimated rental income,
  5-year capital appreciation projection, stamp duty (SDLT) estimate,
  service charge impact on net return
- Tone: professional, discreet, investment-grade — suitable for sharing with HNW clients
- Output: `reports/memo-[address-slug]-YYYY-MM-DD.md`
- **No hallucinated figures** — all data must come from crawled or user-supplied sources
### Agent 4 — Marketing Agent (`agent4-marketing.js`)
**Focus:** Positioning Square Centimeter as London's premier boutique property adviser
- Audience: international HNW investors, family offices, wealth managers, property investors
- Generate:
  - Deal opportunity briefs (discreet, one-page investment summaries for specific properties)
  - LinkedIn thought leadership posts (market insight, deal commentary, London trends)
  - Email newsletters for investor database (monthly market update format)
  - SEO blog posts targeting: "prime London property investment", "buy-to-let London",
    "London property for international investors", "prime central London advisory"
  - Event/webinar content for investor outreach campaigns
- Tone: authoritative, discreet, sophisticated — never salesy or generic
- Output: `outputs/marketing-[type]-YYYY-MM-DD/`
  - `deal-brief.md`, `linkedin-post.txt`, `email-newsletter.md`, `blog-post.md`
### Agent 5 — Client Relations Agent (`agent5-sales.js`)
**Focus:** Qualifying and nurturing HNW investor relationships for Square Centimeter
- Qualify inbound leads on: investment budget, target asset class, timeline, UK residency status,
  tax position (non-dom, offshore structure), preferred London locations
- Respond to property enquiries using listing data and analysis memos
- Prepare meeting briefing notes for Julian Noble ahead of investor calls
- Schedule viewings and advisory consultations (output calendar block)
- Follow up on leads in `data/leads/qualified/` at appropriate intervals
- Output: `data/leads/qualified/qualified-YYYY-MM-DD.csv`
- Log all client interactions to `data/tracker.md`
- Tone: warm, professional, discreet — representing a boutique advisory firm
---
## Data Pipeline
```
agent1-crawler   →  data/raw/              (property listings)
agent2-leads     →  data/leads/raw/        (raw investor leads)
agent5-sales     →  data/leads/qualified/  (qualified leads)
agent5-sales     →  data/leads/contacted/  (outreach completed)
agent3-analyst   →  reports/               (investment memos)
agent4-marketing →  outputs/               (marketing content)
```
---
## Lead Scoring Weights (Investor Leads)
```yaml
investment_intent_signal:    40%   # clear intent to acquire London property
capital_capacity:            25%   # budget aligned with prime market (£500k+)
accessibility:               20%   # contactable, warm intro or public profile
strategic_fit:               15%   # aligns with Square Centimeter's advisory focus
```
---
## Configuration Files
- `portals.yml` — Prime London property listing sources and fields to collect
- `lead-sources.yml` — Investor lead sources, motivation signals, scoring weights
---
## Market Context (Feed into all agents)
- **Target market:** Prime Central London (PCL) and Prime Outer London (POL)
- **Key PCL postcodes:** SW1, SW3, SW7, SW10, W1, W8, WC2, EC1, E1W
- **Emerging areas of interest:** Nine Elms, White City, King's Cross, Stratford, Battersea
- **Typical deal range:** £500,000 – £10,000,000+
- **Client base:** Non-dom investors, overseas family offices, expat buyers, developers
- **Key investment structures:** Direct purchase, SPV/company acquisition, co-investment
---
## Constraints (Non-Negotiable)
1. **No hallucinated data** — all figures from crawled or user-supplied sources only
2. **Respect robots.txt** — check before scraping any domain
3. **Rate limit** — max 1 request/second per domain, add random jitter
4. **Public data only** — contact info from public/legal sources only (no private records)
5. **No protected data** — never scrape login-gated, paywalled, or confidential data
6. **Validate all calculations** — investment figures must be cross-checked before output
7. **Client confidentiality** — never include client names or deal details in public-facing content
8. **Confirm before sending** — always request approval before outreach or publishing content
---
## Brand Voice
- **Authoritative** — deep knowledge of prime London market
- **Discreet** — suitable for HNW and family office audiences
- **Sophisticated** — investment-grade language, no jargon or hype
- **Curated** — quality over quantity in every output
---
## Dependencies
```bash
npm install -g agent-browser   # JavaScript-heavy site crawling
```
---
## File Naming Conventions
- Raw listings: `listings-YYYY-MM-DD.csv`
- Raw leads: `leads-YYYY-MM-DD.csv`
- Investment memos: `memo-[address-slug]-YYYY-MM-DD.md`
- Marketing output: `[type]-YYYY-MM-DD/`
- Scan log: append rows to `data/scan-history.tsv`
---
## Notes for Claude Code
- Always read `portals.yml` and `lead-sources.yml` before any scan
- Update `data/tracker.md` after every agent run
- Use `data/pipeline.md` to flag items requiring Julian Noble's review
- All investment memos must include an SDLT estimate and net yield calculation
- When analysing leasehold properties, flag lease length and service charge prominently
- Ask for confirmation before any outreach, publishing, or client-facing output
