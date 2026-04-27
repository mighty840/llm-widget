// Priority-layered page context extractor.
// Layer order: explicit opt-in > JSON-LD > meta/title > microdata > semantic HTML > fallback
// Each layer has a char budget so no single source monopolises the context window.

const TOTAL_BUDGET = 6000;

const BUDGETS = {
  explicit:  1000,  // [data-llm-context] — site author knows best
  jsonld:    1000,  // <script type="application/ld+json"> — richest for e-commerce, local biz
  meta:       200,  // <title> + <meta description> + OG — always include, small
  links:      300,  // social/contact links — extracted before noise stripping
  microdata:  400,  // [itemprop] inline attributes — product name/price/availability
  semantic:  4000,  // main/article/section with noise stripped
  fallback:   400,  // body text, last resort
};

// Elements to strip from semantic content before extracting text
const NOISE_SELECTOR = [
  'nav', 'header', 'footer',
  '[id*="cookie"]', '[class*="cookie"]', '[class*="consent"]', '[class*="gdpr"]',
  '[class*="banner"]', '[id*="banner"]',
  '[class*="advertisement"]', '[class*="ad-container"]', '[id*="ad-slot"]',
  '[aria-hidden="true"]',
  'script', 'style', 'noscript', 'iframe',
  '[class*="related"]', '[class*="recommended"]', '[class*="newsletter"]',
  '[class*="social-share"]', '[class*="comment"]',
  'aside',
].join(',');

// Semantic section selectors — specific content containers first, broad wrappers last.
// Combined with bidirectional dedup below, once a specific element is captured its
// ancestor containers are automatically skipped (no double-counting).
const SEMANTIC_SELECTORS = [
  // Specific article/doc content (wins over any ancestor)
  '.vp-doc',                              // VitePress article
  '.markdown-body',                       // GitHub-rendered markdown
  '.article-body', '.article-content',
  '.prose',                               // Tailwind typography
  '.docs-content', '.documentation',
  // Semantic article element
  'article',
  // Named content areas
  '.content', '#content', '#page-content',
  // SaaS / landing pages — captured as individual sections
  '#features', '#pricing', '#about', '#hero', '#product',
  // E-commerce
  '.product-details', '.product-description', '#product-detail',
  // Generic named sections (captured individually before the page container swallows them)
  'section[id]',
  // Large containers — only reached if nothing specific above matched
  '[role="main"]', '#main', 'main',
];

// JSON-LD keys worth extracting (keeps output focused, avoids schema noise)
const JSONLD_KEEP = new Set([
  'name', 'description', 'headline', 'articleBody', 'text', 'abstract',
  'price', 'priceCurrency', 'lowPrice', 'highPrice', 'availability', 'sku', 'brand',
  'question', 'acceptedAnswer', 'answer',
  'openingHours', 'telephone', 'streetAddress', 'addressLocality', 'addressCountry',
  'author', 'datePublished', 'dateModified', 'keywords', 'articleSection',
  'hasMenuItem', 'itemOffered', 'servesCuisine',
  'ratingValue', 'reviewCount', 'bestRating',
  'softwareVersion', 'operatingSystem', 'featureList',
]);

// ─── Layer extractors ────────────────────────────────────────────────────────

function extractExplicit(): string {
  const parts: string[] = [];
  document.querySelectorAll<HTMLElement>('[data-llm-context]').forEach(el => {
    const t = el.innerText.replace(/\s+/g, ' ').trim();
    if (t) parts.push(t);
  });
  return parts.join('\n\n').slice(0, BUDGETS.explicit);
}

function flattenJsonLdObj(obj: unknown, depth = 0): string {
  if (depth > 4 || obj === null || typeof obj !== 'object') {
    return typeof obj === 'string' || typeof obj === 'number' ? String(obj) : '';
  }
  if (Array.isArray(obj)) {
    return obj.map(v => flattenJsonLdObj(v, depth)).filter(Boolean).join(', ');
  }
  const record = obj as Record<string, unknown>;
  // Unwrap @graph
  if (record['@graph']) return flattenJsonLdObj(record['@graph'], depth);
  return Object.entries(record)
    .filter(([k]) => JSONLD_KEEP.has(k))
    .map(([k, v]) => {
      const val = flattenJsonLdObj(v, depth + 1);
      return val ? `${k}: ${val}` : '';
    })
    .filter(Boolean)
    .join('\n');
}

function extractJsonLd(): string {
  const parts: string[] = [];
  document.querySelectorAll('script[type="application/ld+json"]').forEach(el => {
    try {
      const data = JSON.parse(el.textContent ?? '');
      const flat = flattenJsonLdObj(data);
      if (flat.length > 20) parts.push(flat);
    } catch { /* malformed JSON-LD — skip */ }
  });
  return parts.join('\n\n').slice(0, BUDGETS.jsonld);
}

function extractMeta(): string {
  const parts: string[] = [];
  const title = document.title.trim();
  if (title) parts.push(`Page: ${title}`);

  const metaDesc = document.querySelector<HTMLMetaElement>('meta[name="description"]')?.content?.trim();
  if (metaDesc) parts.push(`Description: ${metaDesc}`);

  const ogTitle = document.querySelector<HTMLMetaElement>('meta[property="og:title"]')?.content?.trim();
  const ogDesc  = document.querySelector<HTMLMetaElement>('meta[property="og:description"]')?.content?.trim();
  const ogType  = document.querySelector<HTMLMetaElement>('meta[property="og:type"]')?.content?.trim();
  const siteName = document.querySelector<HTMLMetaElement>('meta[property="og:site_name"]')?.content?.trim();

  if (siteName) parts.push(`Site: ${siteName}`);
  if (ogType)   parts.push(`Type: ${ogType}`);
  if (ogTitle && ogTitle !== title) parts.push(`OG title: ${ogTitle}`);
  if (ogDesc && ogDesc !== metaDesc) parts.push(`OG description: ${ogDesc}`);

  const articleDate = document.querySelector<HTMLMetaElement>('meta[property="article:published_time"]')?.content?.trim();
  if (articleDate) parts.push(`Published: ${articleDate.slice(0, 10)}`);

  return parts.join('\n').slice(0, BUDGETS.meta);
}

const SOCIAL_DOMAINS = [
  'github.com', 'gitlab.com',
  'twitter.com', 'x.com',
  'linkedin.com',
  'instagram.com',
  'youtube.com', 'youtu.be',
  'bsky.app',
  'npmjs.com',
  'pypi.org',
];

// Extract social/contact hrefs from the entire document before noise stripping.
// Headers, footers, and navbars are stripped by cleanText() but typically hold the
// only place a site lists its GitHub/Twitter/LinkedIn URLs.
function extractLinks(): string {
  const seen = new Set<string>();
  const parts: string[] = [];
  document.querySelectorAll<HTMLAnchorElement>('a[href]').forEach(a => {
    try {
      const url = new URL(a.href);
      if (!SOCIAL_DOMAINS.some(d => url.hostname === d || url.hostname.endsWith(`.${d}`))) return;
      const href = a.href.replace(/\/$/, '');
      if (seen.has(href)) return;
      seen.add(href);
      const label = a.textContent?.replace(/\s+/g, ' ').trim() || a.getAttribute('aria-label') || '';
      parts.push(label ? `${label}: ${href}` : href);
    } catch { /* malformed href */ }
  });
  return parts.join('\n').slice(0, BUDGETS.links);
}

function extractMicrodata(): string {
  // itemprop attributes — inline structured data (Microdata spec)
  // Especially useful for e-commerce product pages and local business info
  const HIGH_VALUE_PROPS = new Set([
    'name', 'description', 'price', 'priceCurrency', 'availability',
    'sku', 'brand', 'ratingValue', 'reviewCount',
    'streetAddress', 'addressLocality', 'telephone', 'openingHours',
  ]);
  const parts: string[] = [];
  const seen = new Set<string>();

  document.querySelectorAll<HTMLElement>('[itemprop]').forEach(el => {
    const prop = el.getAttribute('itemprop') ?? '';
    if (!HIGH_VALUE_PROPS.has(prop)) return;
    const val = (el.getAttribute('content') || el.getAttribute('datetime') || el.innerText)
      .replace(/\s+/g, ' ').trim();
    if (!val || val.length < 1) return;
    const entry = `${prop}: ${val}`;
    if (!seen.has(entry)) {
      seen.add(entry);
      parts.push(entry);
    }
  });
  return parts.join('\n').slice(0, BUDGETS.microdata);
}

function cleanText(el: HTMLElement): string {
  // Build a text representation of an element with noise removed.
  // Works on the live DOM — we walk children and skip noise nodes.
  const buf: string[] = [];
  function walk(node: Node) {
    if (node.nodeType === Node.TEXT_NODE) {
      const t = (node.textContent ?? '').replace(/\s+/g, ' ');
      if (t.trim()) buf.push(t);
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const el = node as HTMLElement;
    // Skip noise elements
    if (el.matches?.(NOISE_SELECTOR)) return;
    // Skip visually hidden
    if (el.getAttribute('aria-hidden') === 'true') return;
    for (const child of el.childNodes) walk(child);
  }
  walk(el);
  return buf.join('').replace(/\s+/g, ' ').trim();
}

function extractSemantic(): string {
  const seen = new Set<Element>();
  const parts: string[] = [];
  let used = 0;

  for (const sel of SEMANTIC_SELECTORS) {
    if (used >= BUDGETS.semantic) break;
    document.querySelectorAll<HTMLElement>(sel).forEach(el => {
      if (seen.has(el) || used >= BUDGETS.semantic) return;
      // Skip if this element is a descendant of something already captured,
      // or if it's an ancestor of something already captured (bidirectional).
      if ([...seen].some(s => s.contains(el) || el.contains(s))) return;
      seen.add(el);
      const text = cleanText(el);
      if (text.length > 40) {
        parts.push(text);
        used += text.length;
      }
    });
  }
  return parts.join('\n\n').slice(0, BUDGETS.semantic);
}

function extractFallback(): string {
  // Last resort: body text minus noise, hard-truncated
  return cleanText(document.body).slice(0, BUDGETS.fallback);
}

// ─── Public API ──────────────────────────────────────────────────────────────

export interface IndexResult {
  context: string;    // assembled prompt string
  sources: string[];  // which layers contributed (for debugging)
  chars: number;
}

export function collectContext(): string {
  return indexPage().context;
}

export function indexPage(): IndexResult {
  const layers: { name: string; text: string }[] = [
    { name: 'explicit',  text: extractExplicit()  },
    { name: 'jsonld',    text: extractJsonLd()    },
    { name: 'meta',      text: extractMeta()      },
    { name: 'links',     text: extractLinks()     },
    { name: 'microdata', text: extractMicrodata() },
    { name: 'semantic',  text: extractSemantic()  },
  ];

  const parts = layers.filter(l => l.text.length > 0);

  // Only use body fallback if nothing else produced useful content
  if (parts.every(l => l.name !== 'semantic' && l.name !== 'explicit')) {
    const fb = extractFallback();
    if (fb) parts.push({ name: 'fallback', text: fb });
  }

  const context = parts
    .map(l => l.text)
    .join('\n\n')
    .slice(0, TOTAL_BUDGET);

  return {
    context,
    sources: parts.map(l => l.name),
    chars: context.length,
  };
}
