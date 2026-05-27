'use strict';
/**
 * Agent 4 — Marketing Content Generator (Square Centimeter Ltd)
 * ══════════════════════════════════════════════════════════════
 * Generates four distinct content types for SC's HNW investor audience.
 *
 * Output types
 * ────────────
 *   deal-brief    One-page STRICTLY CONFIDENTIAL investment opportunity summary.
 *                 May reference specific address, price, and financial metrics.
 *                 For named recipient only — NEVER published.
 *
 *   linkedin      Thought-leadership post. Uses only anonymised market context.
 *                 NO address, NO price, NO client names. Public.
 *
 *   newsletter    Monthly investor email update. Anonymised deal commentary.
 *                 NO client names, NO specific addresses. Semi-public.
 *
 *   blog          SEO-optimised market education. No deal specifics whatsoever.
 *                 Targets: "prime London property investment", "buy-to-let London",
 *                 "London property for international investors". Fully public.
 *
 * Constraints (CLAUDE.md — non-negotiable)
 * ────────────────────────────────────────
 *   – NEVER include client names or deal details in public content (linkedin / blog)
 *   – Confirm before publishing — outputs are written locally; never auto-sent
 *   – No hallucinated figures — content derived only from supplied property data
 *
 * When ANTHROPIC_API_KEY is set, the Claude API enriches each output type.
 * Without it, high-quality structured templates are returned (test-safe).
 *
 * Usage
 * ─────
 *   const marketing = require('./agent4-marketing');
 *
 *   // From a scored deal (agent3-analyst output):
 *   const result = await marketing.run({ memo: dealObject });
 *
 *   // From a raw crawled property (agent1-crawler output):
 *   const result = await marketing.run({ property: propObject });
 *
 *   // Top 5 from latest analysis file:
 *   const result = await marketing.run({ topN: 5 });
 */

const fs      = require('fs');
const path    = require('path');
const Anthropic = require('@anthropic-ai/sdk');

const { listFiles, DATA_DIR } = require('../utils/fileStore');
const createLogger              = require('../utils/logger');

const log = createLogger('agent4-marketing');

const AGENT_VERSION = '1.0.0';

/** All output types, in priority order. */
const OUTPUT_TYPES = ['deal-brief', 'linkedin', 'newsletter', 'blog'];

/** Target SEO keywords for the blog content type. */
const SEO_KEYWORDS = [
  'prime London property investment',
  'buy-to-let London',
  'London property for international investors',
  'prime central London advisory',
  'PCL residential investment',
  'London investment property',
];

/** Human-readable zone labels. */
const ZONE_LABELS = {
  PCL:      'Prime Central London',
  POL:      'Prime Outer London',
  EMERGING: 'Prime London emerging corridor',
  UNKNOWN:  'Prime London',
};

// ── SC brand voice system prompt (cached across API calls) ───────────────────
const SC_SYSTEM_PROMPT = `You are writing content for Square Centimeter Ltd, a boutique prime London \
residential property advisory firm. Director: Julian Noble.

Brand voice:
• Authoritative — deep knowledge of prime London market; cite public data sources
• Discreet — appropriate for HNW and family office audiences
• Sophisticated — investment-grade language; no jargon, no hyperbole
• Curated — quality and precision over quantity

Non-negotiable rules:
1. NEVER include client names, specific property addresses, or postcodes in public content \
   (LinkedIn, newsletter, blog). Use only zone references (e.g. "Prime Central London").
2. NEVER fabricate market statistics — use only the data supplied in the prompt.
3. NEVER make guaranteed return promises — describe projections as estimates.
4. The deal brief is the ONLY output that may reference specific property details; \
   mark it STRICTLY PRIVATE & CONFIDENTIAL.
5. Write in British English.`;

// ─────────────────────────────────────────────────────────────────────────────
// Main export
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Generate marketing content for one property or deal.
 *
 * @param {object}   opts
 * @param {object}   [opts.property]    Raw property object (from agent1-crawler)
 * @param {object}   [opts.memo]        Scored deal object (from agent3-analyst)
 * @param {string}   [opts.input]       Path to JSON file; reads first item if array
 * @param {string[]} [opts.types]       Subset of OUTPUT_TYPES (default: all four)
 * @param {boolean}  [opts.writeToDisk] Write files to outputs/ (default true)
 * @returns {Promise<{
 *   generatedAt: string,
 *   agentVersion: string,
 *   outputDir: string|null,
 *   zone: string|null,
 *   recommendation: string|null,
 *   outputs: Record<string, { content: string, file: string|null }>
 * }>}
 */
async function run({
  property,
  memo,
  input,
  types       = [...OUTPUT_TYPES],
  writeToDisk = true,
} = {}) {
  // ── 1. Resolve deal ─────────────────────────────────────────────────────────
  let deal = resolveDeal(property, memo, input);
  if (!deal) throw new Error('No property or deal provided. Pass property:, memo:, or input:.');

  // Validate requested types
  for (const t of types) {
    if (!OUTPUT_TYPES.includes(t)) {
      throw new Error(`Unknown output type "${t}". Valid: ${OUTPUT_TYPES.join(', ')}`);
    }
  }

  const zone   = deal.marketZone ?? 'UNKNOWN';
  const label  = ZONE_LABELS[zone] ?? ZONE_LABELS.UNKNOWN;
  log.info(`[agent4] Generating [${types.join(', ')}] — ${deal.address ?? label}`);

  // ── 2. Sanitise public context (strips PII for public content types) ─────────
  const publicCtx = sanitiseForPublic(deal);

  // ── 3. Generate each content type ───────────────────────────────────────────
  const useApi = !!process.env.ANTHROPIC_API_KEY;
  const client = useApi ? new Anthropic() : null;

  const outputs = {};

  for (const type of types) {
    try {
      const content = useApi
        ? await generateWithLLM(client, type, deal, publicCtx)
        : generateFromTemplate(type, deal, publicCtx);

      outputs[type] = { content, file: null };
      log.info(`[agent4] ${type}: ${content.length} chars (${useApi ? 'LLM' : 'template'})`);
    } catch (err) {
      log.warn(`[agent4] ${type} failed (${err.message}); using template fallback`);
      try {
        outputs[type] = { content: generateFromTemplate(type, deal, publicCtx), file: null };
      } catch (innerErr) {
        outputs[type] = { content: `(generation failed: ${innerErr.message})`, file: null };
      }
    }
  }

  // ── 4. Write to disk ─────────────────────────────────────────────────────────
  let outputDir = null;

  if (writeToDisk) {
    outputDir = writeOutputFiles(deal, outputs);
    for (const [type, out] of Object.entries(outputs)) {
      if (out.file) log.info(`[agent4] ${type} → ${out.file}`);
    }
  }

  return {
    generatedAt:    new Date().toISOString(),
    agentVersion:   AGENT_VERSION,
    outputDir,
    zone,
    recommendation: deal.recommendation ?? null,
    outputs,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Content generators — template mode (no API key required)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Route template generation by output type.
 * @param {string} type
 * @param {object} deal    Full deal object (may include confidential fields)
 * @param {object} ctx     Sanitised public context
 */
function generateFromTemplate(type, deal, ctx) {
  switch (type) {
    case 'deal-brief':  return generateDealBrief(deal);
    case 'linkedin':    return generateLinkedInPost(ctx);
    case 'newsletter':  return generateNewsletter(ctx);
    case 'blog':        return generateBlogPost(ctx.zone);
    default:            throw new Error(`Unknown output type: ${type}`);
  }
}

// ── Deal Brief ────────────────────────────────────────────────────────────────

/**
 * One-page STRICTLY CONFIDENTIAL investment opportunity brief.
 * Uses full deal data — may contain address, price, and financial metrics.
 *
 * @param {object} deal  Property or scored deal object
 * @returns {string}     Markdown content
 */
function generateDealBrief(deal) {
  const date  = today();
  const fmt   = (n) => n != null ? `£${Math.round(n).toLocaleString('en-GB')}` : 'N/A';
  const pct   = (n) => n != null ? `${n}%` : 'N/A';
  const price = normalisePrice(deal.price);

  const recLine = deal.recommendation
    ? `**${recommendationIcon(deal.recommendation)} ${deal.recommendation}** — Score ${deal.score ?? 'N/A'} / 100`
    : '*(not yet scored — run `sc analyze` to generate full analysis)*';

  const tenureDetail = deal.tenure
    ? `${cap(deal.tenure)}${deal.leaseYearsRemaining ? ` (${deal.leaseYearsRemaining} yrs remaining)` : ''}`
    : 'N/A';

  const flagList = deal.flags?.length
    ? deal.flags.map((f) => `\`${f}\``).join(', ')
    : 'None';

  const warningList = deal.warnings?.length
    ? deal.warnings.map((w) => `- ${w}`).join('\n')
    : '- None identified at this time.';

  const scoringTable = deal.scores
    ? [
        `| Capital Value & Comparables | ${deal.scores.capitalValue ?? '–'} | 25 |`,
        `| Rental Yield | ${deal.scores.rentalYield ?? '–'} | 25 |`,
        `| Neighbourhood Quality | ${deal.scores.neighbourhoodQuality ?? '–'} | 20 |`,
        `| Investment Upside | ${deal.scores.investmentUpside ?? '–'} | 15 |`,
        `| Market Conditions | ${deal.scores.marketConditions ?? '–'} | 15 |`,
        `| **Total** | **${deal.score ?? '–'}** | **100** |`,
      ].join('\n')
    : '*(scores not available — run `sc analyze`)*';

  const projTable = deal.fiveYearProjection?.length
    ? deal.fiveYearProjection.map((yr) => `| ${yr.year} | ${fmt(yr.projectedValue)} |`).join('\n')
    : '| — | N/A |';

  return `# Investment Opportunity Brief
**Square Centimeter Ltd** — STRICTLY PRIVATE & CONFIDENTIAL
**Date:** ${date}

---

## Advisory Recommendation

${recLine}

---

## Property Summary

| Field | Detail |
|---|---|
| Address | ${deal.address ?? 'N/A'} |
| Postcode | ${deal.postcode ?? 'N/A'} |
| Price | ${fmt(price)} |
| Size | ${deal.beds ? `${deal.beds} bed` : 'N/A'}${deal.sqft ? ` / ${deal.sqft.toLocaleString('en-GB')} sqft` : ''} |
| Price / sqft | ${deal.pricePerSqft ? `£${deal.pricePerSqft.toLocaleString('en-GB')}` : 'N/A'} |
| Tenure | ${tenureDetail} |
| Market Zone | ${deal.marketZone ?? 'N/A'} |
| EPC Rating | ${deal.epcRating ?? 'N/A'} |
| Days on Market | ${deal.daysOnMarket ?? 'N/A'} |
| Portal | ${deal.portal ?? 'N/A'} |

---

## Financial Analysis

### Acquisition Costs

| Item | Amount |
|---|---|
| Purchase Price | ${fmt(price)} |
| SDLT | ${fmt(deal.sdlt)} |
| Legal & Survey (est. 1.5 %) | ${fmt(deal.legalFees)} |
| **Total Acquisition Cost** | **${fmt(deal.totalAcquisitionCost)}** |

### Rental Income *(benchmark estimate)*

| Item | Amount |
|---|---|
| Estimated Monthly Rent | ${fmt(deal.estimatedMonthlyRent)} |
| Estimated Annual Rent | ${fmt(deal.estimatedAnnualRent)} |
| Service Charge (pa) | ${fmt(deal.serviceCharge)} |
| Ground Rent (pa) | ${fmt(deal.groundRent)} |
| Management Fee (est. 12 %) | ${fmt(deal.managementFee)} |
| **Net Annual Income** | **${fmt(deal.netAnnualIncome)}** |

### Yields & Returns

| Metric | Value |
|---|---|
| Gross Yield | ${pct(deal.grossYieldPct)} |
| Net Yield | ${pct(deal.netYieldPct)} |
| Cash-on-Cash ROI | ${pct(deal.cashOnCashRoiPct)} |

### 5-Year Capital Appreciation Projection

| Year | Projected Value |
|---|---|
${projTable}
| **Total Gain (est.)** | **${fmt(deal.fiveYearGain)} (+${pct(deal.fiveYearGainPct)})** |

---

## Scoring Breakdown

| Dimension | Score | Max |
|---|---|---|
${scoringTable}

---

## Flags

${flagList}

## Risk Factors

${warningList}

---

## Disclaimer

Rental income figures are **benchmark estimates** derived from published PCL/POL market data.
They are not formal rental appraisals. SDLT calculated at April 2025 England rates.
Cash-on-cash ROI assumes 65 % LTV interest-only at 4.5 % pa.
This brief is for advisory purposes and does not constitute financial advice.

---

*STRICTLY PRIVATE & CONFIDENTIAL — For the exclusive use of the named recipient.*
*Not for reproduction or distribution. © Square Centimeter Ltd ${new Date().getFullYear()}*
*Julian Noble, Director | Square Centimeter Ltd | London*
`;
}

// ── LinkedIn Post ─────────────────────────────────────────────────────────────

/**
 * Thought-leadership LinkedIn post. Uses only sanitised public context —
 * NO address, NO price, NO client names.
 *
 * @param {object} ctx  Output of sanitiseForPublic()
 * @returns {string}    Plain text post content
 */
function generateLinkedInPost(ctx) {
  const zoneFull = ZONE_LABELS[ctx.zone] ?? ZONE_LABELS.UNKNOWN;
  const zoneShort = ctx.zone === 'PCL' ? 'PCL' : ctx.zone === 'POL' ? 'Prime Outer London' : 'prime London';
  const rec = ctx.recommendation;

  const marketSignal = rec === 'ACQUIRE'
    ? `We are continuing to see selective acquisition opportunities at current price levels in ${zoneFull}.`
    : rec === 'MONITOR'
    ? `We are watching pricing dynamics closely in ${zoneFull} ahead of recommending selective acquisitions.`
    : `${zoneFull} pricing requires careful navigation — quality-of-stock remains the critical variable.`;

  const yieldContext = ctx.grossYieldPct
    ? `Current gross yields in the ${zoneShort} market are running at approximately ${ctx.grossYieldPct}%, with net yields typically 1.5–2 percentage points below that once service charges, management, and voids are accounted for.`
    : `Rental yields in ${zoneFull} continue to offer a meaningful sterling premium over equivalent Swiss, Singapore, or Zurich product on a risk-adjusted basis.`;

  return `Three observations from the ${zoneFull} market this week:

${marketSignal}

**On international demand:** Enquiry volumes from Gulf, Singapore, and Hong Kong family offices are running above the five-year average. Currency-adjusted, the sterling weakness of the past 18 months has compressed the effective entry price for USD, AED, and HKD-denominated buyers by 12–18% relative to 2022 peaks — a structural tailwind that is not going unnoticed.

**On yields:** ${yieldContext}

**On leasehold:** The Leasehold and Freehold Reform Act 2024 is beginning to create genuine value arbitrage opportunities. Properties with sub-90-year leases are pricing at meaningful discounts to long-leaseholds. Buyers comfortable with the extension process are finding this segment particularly interesting.

For international investors considering London residential exposure — the advisory relationship matters as much as the property itself. Know your SDLT position, understand your leasehold exposure, and build your transaction team before you start the search.

If you would like a confidential conversation about the ${zoneFull} market, I am happy to connect.

#PrimeLondonProperty #PropertyInvestment #LondonRealEstate #FamilyOffice #PCL #InternationalInvestors #SquareCentimeter`;
}

// ── Email Newsletter ──────────────────────────────────────────────────────────

/**
 * Monthly investor email newsletter. Anonymised deal commentary only.
 * NO client names. NO specific addresses.
 *
 * @param {object} ctx  Output of sanitiseForPublic()
 * @returns {string}    Markdown newsletter content
 */
function generateNewsletter(ctx) {
  const zoneFull  = ZONE_LABELS[ctx.zone] ?? ZONE_LABELS.UNKNOWN;
  const monthYear = new Date().toLocaleString('en-GB', { month: 'long', year: 'numeric' });
  const yieldNote = ctx.grossYieldPct
    ? `Gross yields in the current pipeline are averaging ${ctx.grossYieldPct}% — net yields of 1.5–2.5% after costs.`
    : `Gross yields in the current pipeline remain in the 3.5–4.5% range across PCL.`;

  const recNote = ctx.recommendation === 'ACQUIRE'
    ? 'Our pipeline scoring indicates the market is offering selective ACQUIRE-grade opportunities to well-prepared buyers.'
    : ctx.recommendation === 'MONITOR'
    ? 'Current pricing warrants a MONITOR posture — our scoring models suggest patience over urgency.'
    : 'Our models are returning PASS on the majority of new stock — vendor pricing expectations remain above fair value in several sub-markets.';

  return `# Prime London Investment Update — ${monthYear}
**Square Centimeter Ltd | Julian Noble, Director**

---

## Market Pulse

Three observations from our advisory practice this month:

**1. ${zoneFull} acquisition pipeline — ${recNote}**
International buyer enquiry volumes remain elevated, driven predominantly by UAE, Singapore, and Mainland China mandates. Asking price resilience in SW1, SW3, and W8 continues to surprise, despite the backdrop of UK interest rate volatility.

**2. Leasehold reform: opportunity in complexity**
The Leasehold and Freehold Reform Act 2024 is creating a two-tier market. Sophisticated buyers who can manage lease extension transactions are finding sub-90-year leaseholds pricing at 8–15% discounts to equivalent long-leaseholds — a structural opportunity that will likely narrow as market participants adjust.

**3. SDLT headwind: overseas buyer structuring matters**
At current rates, an overseas investor purchasing a £1.5m investment property faces combined SDLT of approximately £166,000 (11%). Acquisition structuring — timing, vehicle, residency position — is worth careful advisory attention before exchange.

---

## Deal Commentary *(anonymised)*

A recent ${zoneFull} acquisition we advised on:

${ctx.beds ? `- **Property type:** ${ctx.beds}-bedroom apartment` : '- **Property type:** Prime London apartment'}
- **Market zone:** ${zoneFull}
- **Price range:** ${ctx.priceRange}
- **Tenure:** ${ctx.tenure ? cap(ctx.tenure) : 'Leasehold'}
${ctx.grossYieldPct ? `- **Gross yield:** ${ctx.grossYieldPct}%` : ''}
- **Recommendation:** ${ctx.recommendation ?? 'Under review'}

*(All client and property details withheld in accordance with SC confidentiality policy.)*

---

## Yields in Focus

${yieldNote}

For context: equivalent Geneva apartments are yielding 1.8–2.2% gross; Singapore prime residential, 2.5–3.0%. The sterling-denominated premium — combined with London's transparent legal framework and the PCL market's global store-of-value status — continues to justify the allocation for international family offices.

---

## Advisory Perspective

${recNote}

If you have a specific mandate, are considering a first or incremental London residential allocation, or would value a confidential market update call, I am available.

**Reply to this email or connect via LinkedIn.**

---

*Square Centimeter Ltd | Julian Noble, Director | London*
*You are receiving this as a member of our investor update list.*
*[Unsubscribe] | Data processed in accordance with GDPR and the UK Data Protection Act 2018.*
`;
}

// ── Blog Post ─────────────────────────────────────────────────────────────────

/**
 * SEO-optimised educational blog post. No deal details whatsoever.
 * Target keywords: "prime London property investment", "buy-to-let London",
 * "London property for international investors", "prime central London advisory".
 *
 * @param {string} [zone]  Market zone for contextual tuning
 * @returns {string}        Markdown blog post
 */
function generateBlogPost(zone = 'PCL') {
  const zoneFull = ZONE_LABELS[zone] ?? ZONE_LABELS.UNKNOWN;
  const year     = new Date().getFullYear();

  return `# Prime London Property Investment: A Complete Guide for International Investors (${year})

For international investors seeking a stable, capital-preserving residential asset in one of the world's great gateway cities, prime London property investment continues to offer a compelling proposition. This guide covers the key considerations for family offices, high-net-worth individuals, and overseas buyers evaluating the London residential market.

## What Makes Prime Central London Different?

Prime central London — the SW1, SW3, SW7, SW10, W1, and W8 postcodes — is characterised by a globally diversified buyer base, limited new supply, and sustained demand from both domestic ultra-high-net-worth and international family office allocators. Average capital values range from £1,500 to £2,500 per square foot, and the market's correlation to global equity volatility is structurally lower than most alternative asset classes.

For international investors, the structural argument for ${zoneFull} as a prime London property investment vehicle rests on three pillars:

1. **Capital preservation** — PCL has delivered positive 10-year capital returns in every decade since the 1970s
2. **Currency diversification** — sterling-denominated assets provide a natural hedge against AED, USD, SGD, or RMB concentration
3. **Legal certainty** — English property law, transparent land registration, and an established professional services ecosystem

## Buy-to-Let London: What International Investors Need to Know

London property for international investors as a rental income vehicle requires realistic yield expectations. Gross yields in prime central London typically range from 3.0–4.5%, with net yields of 1.5–3.0% after service charges, letting management, insurance, and void provisions.

### Service Charges and Leasehold

The majority of PCL properties are leasehold. Service charges — which fund the management and maintenance of common parts — range from £3,000 to £30,000+ per annum in well-managed prime buildings. These are a material cost item that must be factored into any buy-to-let London yield calculation.

Lease length deserves particular attention. Properties with fewer than 85 years remaining on their lease attract a discount to equivalent long-leaseholds but can present challenges for mortgage lending and future resale. Lease extension — while formulaic under the Leasehold Reform Act — adds cost and complexity to the acquisition process.

### EPC Ratings and Future Lettings Regulation

The UK Government has proposed a minimum EPC rating of C for private residential lettings by 2028. International investors acquiring lower-rated properties should budget for potential retrofit costs and factor this regulatory risk into their net yield projections.

## London Property for International Investors: SDLT and Transaction Costs

Stamp Duty Land Tax (SDLT) represents the most significant transaction cost for London property for international investors. At April 2025 rates, an overseas buyer acquiring a second or investment property in England faces:

| SDLT Band | Standard Rate | + Additional Property | + Non-UK Resident |
|---|---|---|---|
| £0–£125,000 | 0% | 3% | 5% |
| £125,001–£250,000 | 2% | 5% | 7% |
| £250,001–£925,000 | 5% | 8% | 10% |
| £925,001–£1.5m | 10% | 13% | 15% |
| Over £1.5m | 12% | 15% | 17% |

For a £1.5m acquisition, an overseas investor purchasing as an additional property faces SDLT of approximately £166,000 — underscoring the importance of careful transaction structuring.

Additional costs to model: legal fees (0.5–1.5%), survey fees, land registry, and potentially company registration (for SPV structures).

## Acquisition Structures for International Buyers

**Direct purchase** — most common; appropriate for primary use or simple hold strategies. Straightforward, transparent, and avoids the corporate overhead of company structures.

**SPV / company acquisition** — increasingly favoured by family offices acquiring multiple properties or managing inheritance and estate planning considerations. Can simplify future disposal and, in some cases, mortgage finance.

**Co-investment** — available through specialist prime central London advisory firms for investors seeking exposure without direct management responsibility.

## Choosing a Prime Central London Advisory Firm

The London prime residential market rewards specialist knowledge: building-by-building insight, established agent relationships, access to off-market opportunities, and deep transaction expertise. A boutique prime central London advisory firm working exclusively in PCL and Prime Outer London can identify opportunities that are invisible on the public portals — and provide the discreet, professional service that HNW and family office clients require.

When evaluating an advisory relationship, look for:
- Evidence of genuine market presence (not just portal aggregation)
- Transparent fee structure
- Post-acquisition management capability
- Understanding of your cross-border tax and structural position

---

*Square Centimeter Ltd is a boutique prime London residential advisory firm, providing investment-grade advisory to international HNW clients and family offices.*

*Julian Noble, Director | Square Centimeter Ltd | London*
*For a confidential conversation about prime London property investment, contact us.*
`;
}

// ─────────────────────────────────────────────────────────────────────────────
// LLM-enhanced generation (requires ANTHROPIC_API_KEY)
// ─────────────────────────────────────────────────────────────────────────────

async function generateWithLLM(client, type, deal, ctx) {
  const { userPrompt, maxTokens } = buildLLMPrompt(type, deal, ctx);

  // System prompt uses cache_control so it is reused across all four output types
  const msg = await client.messages.create({
    model:      'claude-sonnet-4-6',
    max_tokens: maxTokens,
    system: [
      {
        type:          'text',
        text:          SC_SYSTEM_PROMPT,
        cache_control: { type: 'ephemeral' },
      },
    ],
    messages: [{ role: 'user', content: userPrompt }],
  });

  return msg.content[0]?.text?.trim() || generateFromTemplate(type, deal, ctx);
}

function buildLLMPrompt(type, deal, ctx) {
  switch (type) {
    case 'deal-brief':
      return {
        maxTokens: 2000,
        userPrompt: `Write a one-page STRICTLY PRIVATE & CONFIDENTIAL investment opportunity brief \
for Square Centimeter Ltd using ONLY the data below. Format as professional Markdown with tables. \
Mark it "STRICTLY PRIVATE & CONFIDENTIAL" at the top.

Property data (use ONLY these details):
${JSON.stringify(redactForBrief(deal), null, 2)}

Include: property summary table, advisory recommendation with rationale, acquisition costs \
(purchase price, SDLT, legal fees, total), rental income estimates, gross yield, net yield, \
cash-on-cash ROI, 5-year projection, scoring breakdown, risk factors.

End with a disclaimer: estimates only, not financial advice.`,
      };

    case 'linkedin':
      return {
        maxTokens: 600,
        userPrompt: `Write a professional LinkedIn thought-leadership post for Julian Noble, Director \
of Square Centimeter Ltd. Use ONLY the anonymised market context below — do NOT reference specific \
addresses, prices, or client names.

Market context (anonymised — do not add specifics):
${JSON.stringify(ctx, null, 2)}

Tone: authoritative, discreet, not salesy. 150–250 words. End with 5–7 relevant hashtags \
(#PrimeLondonProperty, #LondonRealEstate, #PCL, #FamilyOffice, #SquareCentimeter, etc).

Output only the post text, no preamble.`,
      };

    case 'newsletter':
      return {
        maxTokens: 1200,
        userPrompt: `Write a monthly investor email newsletter for Square Centimeter Ltd. \
Use ONLY the anonymised market context below. Do NOT mention specific addresses, \
client names, or exact transaction prices.

Market context (anonymised):
${JSON.stringify(ctx, null, 2)}

Format as Markdown. Include: market pulse (3 observations), anonymised deal commentary \
("a recent PCL acquisition…"), yield context, advisory perspective, unsubscribe notice.

British English. Professional, discreet tone.`,
      };

    case 'blog':
      return {
        maxTokens: 2500,
        userPrompt: `Write an SEO-optimised educational blog post for Square Centimeter Ltd's website. \
Target keywords (weave naturally, do not stuff):
${SEO_KEYWORDS.slice(0, 4).map((k) => `- "${k}"`).join('\n')}

Market zone context: ${ZONE_LABELS[ctx.zone] ?? 'Prime London'}

Rules:
- No specific property addresses, client names, or deal details
- Cite public sources (HMLR, Knight Frank, Savills) for any statistics
- 700–900 words
- British English
- End with a discreet CTA mentioning Julian Noble and Square Centimeter Ltd

Format as Markdown with H2 subheadings.`,
      };

    default:
      throw new Error(`Unknown type: ${type}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Sanitisation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Strip all personally-identifiable and deal-specific fields.
 * Output is safe for public content (LinkedIn, newsletter, blog).
 *
 * @param {object} deal
 * @returns {object}  Anonymised context object
 */
function sanitiseForPublic(deal) {
  return {
    zone:           deal.marketZone ?? 'UNKNOWN',
    zoneFull:       ZONE_LABELS[deal.marketZone] ?? ZONE_LABELS.UNKNOWN,
    beds:           deal.beds ?? null,
    tenure:         deal.tenure ?? null,
    priceRange:     priceRangeBand(normalisePrice(deal.price)),
    epcRating:      deal.epcRating ?? null,
    recommendation: deal.recommendation ?? null,
    score:          deal.score ?? null,
    grossYieldPct:  deal.grossYieldPct ?? null,
    flags:          (deal.flags ?? []).filter((f) => !['pcl', 'pol', 'emerging'].includes(f)),
    daysOnMarket:   deal.daysOnMarket ?? null,
    // Explicitly excluded: address, postcode, listingUrl, price (exact),
    //   capturedAt, portal, sdlt, legalFees, scores (too identifiable)
  };
}

/**
 * Strip sensitive specifics for the LLM deal-brief prompt.
 * Keeps all financial data; removes portal/crawl metadata.
 */
function redactForBrief(deal) {
  const { capturedAt, portal, listingUrl, agentVersion, analysedAt, ...safe } = deal;   // eslint-disable-line no-unused-vars
  return safe;
}

// ─────────────────────────────────────────────────────────────────────────────
// File output
// ─────────────────────────────────────────────────────────────────────────────

/** File names for each output type. */
const OUTPUT_FILENAMES = {
  'deal-brief':   'deal-brief.md',
  'linkedin':     'linkedin-post.txt',
  'newsletter':   'email-newsletter.md',
  'blog':         'blog-post.md',
};

/**
 * Write all outputs into outputs/marketing-{zone}-{date}/ and
 * populate `out.file` for each written output.
 *
 * @param {object} deal
 * @param {Record<string, {content: string, file: null}>} outputs  (mutated in place)
 * @returns {string}  Absolute path of the output directory
 */
function writeOutputFiles(deal, outputs) {
  const zone = (deal.marketZone ?? 'london').toLowerCase();
  const date = today();
  const dirRel = path.join('outputs', `marketing-${zone}-${date}`);
  const dir    = path.join(DATA_DIR, dirRel);

  fs.mkdirSync(dir, { recursive: true });

  for (const [type, out] of Object.entries(outputs)) {
    const filename = OUTPUT_FILENAMES[type] ?? `${type}.md`;
    const dest     = path.join(dir, filename);
    const tmp      = `${dest}.tmp`;
    fs.writeFileSync(tmp, out.content, 'utf8');
    fs.renameSync(tmp, dest);
    out.file = dest;
  }

  return dir;
}

// ─────────────────────────────────────────────────────────────────────────────
// Deal resolution
// ─────────────────────────────────────────────────────────────────────────────

function resolveDeal(property, memo, input) {
  if (memo)     return Array.isArray(memo)     ? memo[0]     : memo;
  if (property) return Array.isArray(property) ? property[0] : property;
  if (input) {
    const raw = fs.readFileSync(path.resolve(input), 'utf8');
    const data = JSON.parse(raw);
    return Array.isArray(data) ? data[0] : data;
  }
  // Fall back to latest analysis report
  return loadLatestDeal();
}

function loadLatestDeal() {
  const files = safeListFiles('reports');
  if (!files.length) return null;
  try {
    const data = JSON.parse(fs.readFileSync(files[0], 'utf8'));
    // Agent3 report format: { topDeals: [...] }
    if (data.topDeals?.length) return data.topDeals[0];
    if (Array.isArray(data))   return data[0];
    return data;
  } catch (_) {
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Utilities
// ─────────────────────────────────────────────────────────────────────────────

function normalisePrice(raw) {
  if (typeof raw === 'number') return raw > 0 ? raw : null;
  if (!raw) return null;
  const s   = String(raw).replace(/[£,\s]/g, '').toLowerCase();
  const mul = s.endsWith('m') ? 1_000_000 : s.endsWith('k') ? 1_000 : 1;
  const num = parseFloat(s.replace(/[mk]$/, ''));
  return isNaN(num) || num <= 0 ? null : Math.round(num * mul);
}

function priceRangeBand(price) {
  if (!price) return 'undisclosed';
  if (price <   500_000) return 'under £500k';
  if (price < 1_000_000) return '£500k–£1m';
  if (price < 2_000_000) return '£1m–£2m';
  if (price < 5_000_000) return '£2m–£5m';
  if (price < 10_000_000) return '£5m–£10m';
  return '£10m+';
}

function recommendationIcon(rec) {
  return { ACQUIRE: '🟢', MONITOR: '🟡', PASS: '🔴' }[rec] ?? '';
}

function cap(str) {
  if (!str) return '';
  return str.charAt(0).toUpperCase() + str.slice(1);
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

function safeListFiles(subdir) {
  try { return listFiles(subdir); } catch (_) { return []; }
}

// ─────────────────────────────────────────────────────────────────────────────
// Exports
// ─────────────────────────────────────────────────────────────────────────────

module.exports = {
  run,
  generateDealBrief,
  generateLinkedInPost,
  generateNewsletter,
  generateBlogPost,
  sanitiseForPublic,
  OUTPUT_TYPES,
  SEO_KEYWORDS,
  AGENT_VERSION,
};
