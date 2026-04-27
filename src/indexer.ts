// Priority-layered page context extractor.
// Layer order: explicit opt-in > JSON-LD > meta/title > links > microdata > semantic HTML > fallback
// "Fixed" layers (meta, links, jsonld, explicit) are always included — they are small and always
// relevant. Semantic content is either BM25-chunked (local models, selectChunks()) or returned
// as a flat block (remote/capable models, collectContext()).

const FIXED_BUDGET   = 2000; // meta + links + jsonld + explicit (always included)
const CHUNK_BUDGET   = 3000; // semantic context for local models (query-selected)
const FLAT_BUDGET    = 8000; // semantic context for remote/capable models (full dump)
const TOTAL_BUDGET   = FIXED_BUDGET + FLAT_BUDGET;

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
// Combined with bidirectional dedup, once a specific element is captured its ancestor
// containers are automatically skipped.
const SEMANTIC_SELECTORS = [
  '.vp-doc',                              // VitePress article
  '.markdown-body',                       // GitHub-rendered markdown
  '.article-body', '.article-content',
  '.prose',                               // Tailwind typography
  '.docs-content', '.documentation',
  'article',
  '.content', '#content', '#page-content',
  '#features', '#pricing', '#about', '#hero', '#product',
  '.product-details', '.product-description', '#product-detail',
  'section[id]',
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

const SOCIAL_DOMAINS = [
  'github.com', 'gitlab.com',
  'twitter.com', 'x.com',
  'linkedin.com', 'instagram.com',
  'youtube.com', 'youtu.be',
  'bsky.app', 'npmjs.com', 'pypi.org',
];

// Common English stopwords — excluded from BM25 token sets.
const STOPWORDS = new Set([
  'the','and','for','are','but','not','you','all','can','was','had',
  'has','its','with','this','that','from','they','will','have','been',
  'were','their','what','when','who','how','which','also','more','into',
  'than','then','our','out','use','used','each','one','two','about',
]);

// ─── Fixed layers (always included, query-independent) ───────────────────────

function extractExplicit(): string {
  const parts: string[] = [];
  document.querySelectorAll<HTMLElement>('[data-llm-context]').forEach(el => {
    const t = el.innerText.replace(/\s+/g, ' ').trim();
    if (t) parts.push(t);
  });
  return parts.join('\n\n').slice(0, 1000);
}

function flattenJsonLdObj(obj: unknown, depth = 0): string {
  if (depth > 4 || obj === null || typeof obj !== 'object') {
    return typeof obj === 'string' || typeof obj === 'number' ? String(obj) : '';
  }
  if (Array.isArray(obj)) return obj.map(v => flattenJsonLdObj(v, depth)).filter(Boolean).join(', ');
  const record = obj as Record<string, unknown>;
  if (record['@graph']) return flattenJsonLdObj(record['@graph'], depth);
  return Object.entries(record)
    .filter(([k]) => JSONLD_KEEP.has(k))
    .map(([k, v]) => { const val = flattenJsonLdObj(v, depth + 1); return val ? `${k}: ${val}` : ''; })
    .filter(Boolean).join('\n');
}

function extractJsonLd(): string {
  const parts: string[] = [];
  document.querySelectorAll('script[type="application/ld+json"]').forEach(el => {
    try { const flat = flattenJsonLdObj(JSON.parse(el.textContent ?? '')); if (flat.length > 20) parts.push(flat); }
    catch { /* malformed JSON-LD */ }
  });
  return parts.join('\n\n').slice(0, 1000);
}

function extractMeta(): string {
  const parts: string[] = [];
  const title = document.title.trim();
  if (title) parts.push(`Page: ${title}`);
  const metaDesc = document.querySelector<HTMLMetaElement>('meta[name="description"]')?.content?.trim();
  if (metaDesc) parts.push(`Description: ${metaDesc}`);
  const ogTitle   = document.querySelector<HTMLMetaElement>('meta[property="og:title"]')?.content?.trim();
  const ogDesc    = document.querySelector<HTMLMetaElement>('meta[property="og:description"]')?.content?.trim();
  const ogType    = document.querySelector<HTMLMetaElement>('meta[property="og:type"]')?.content?.trim();
  const siteName  = document.querySelector<HTMLMetaElement>('meta[property="og:site_name"]')?.content?.trim();
  if (siteName) parts.push(`Site: ${siteName}`);
  if (ogType)   parts.push(`Type: ${ogType}`);
  if (ogTitle && ogTitle !== title) parts.push(`OG title: ${ogTitle}`);
  if (ogDesc && ogDesc !== metaDesc) parts.push(`OG description: ${ogDesc}`);
  const articleDate = document.querySelector<HTMLMetaElement>('meta[property="article:published_time"]')?.content?.trim();
  if (articleDate) parts.push(`Published: ${articleDate.slice(0, 10)}`);
  return parts.join('\n').slice(0, 200);
}

// Extract social/contact hrefs from the whole document before any noise stripping.
// Social links live in headers/footers which cleanText() strips out entirely.
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
  return parts.join('\n').slice(0, 300);
}

function extractMicrodata(): string {
  const HIGH_VALUE = new Set([
    'name','description','price','priceCurrency','availability',
    'sku','brand','ratingValue','reviewCount',
    'streetAddress','addressLocality','telephone','openingHours',
  ]);
  const parts: string[] = [];
  const seen = new Set<string>();
  document.querySelectorAll<HTMLElement>('[itemprop]').forEach(el => {
    const prop = el.getAttribute('itemprop') ?? '';
    if (!HIGH_VALUE.has(prop)) return;
    const val = (el.getAttribute('content') || el.getAttribute('datetime') || el.innerText).replace(/\s+/g, ' ').trim();
    if (!val) return;
    const entry = `${prop}: ${val}`;
    if (!seen.has(entry)) { seen.add(entry); parts.push(entry); }
  });
  return parts.join('\n').slice(0, 400);
}

// Assembles the fixed (non-semantic) layers into a single string.
function buildFixedContext(): string {
  return [extractExplicit(), extractJsonLd(), extractMeta(), extractLinks(), extractMicrodata()]
    .filter(Boolean).join('\n\n').slice(0, FIXED_BUDGET);
}

// ─── Semantic content ────────────────────────────────────────────────────────

function cleanText(el: HTMLElement): string {
  const buf: string[] = [];
  function walk(node: Node) {
    if (node.nodeType === Node.TEXT_NODE) {
      const t = (node.textContent ?? '').replace(/\s+/g, ' ');
      if (t.trim()) buf.push(t);
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const el = node as HTMLElement;
    if (el.matches?.(NOISE_SELECTOR)) return;
    if (el.getAttribute('aria-hidden') === 'true') return;
    for (const child of el.childNodes) walk(child);
  }
  walk(el);
  return buf.join('').replace(/\s+/g, ' ').trim();
}

// Returns all distinct semantic content elements on the page, deduplicated
// bidirectionally (no element that is an ancestor or descendant of another).
// Both extractSemanticFlat() and chunkPage() use this so they cover the same content.
function findContentElements(): HTMLElement[] {
  const seen = new Set<Element>();
  const els: HTMLElement[] = [];
  for (const sel of SEMANTIC_SELECTORS) {
    document.querySelectorAll<HTMLElement>(sel).forEach(el => {
      if ([...seen].some(s => s.contains(el) || el.contains(s))) return;
      seen.add(el);
      els.push(el);
    });
  }
  return els.length > 0 ? els : [document.body];
}

// ─── Flat extraction (for remote/capable models) ─────────────────────────────

function extractSemanticFlat(): string {
  const els = findContentElements();
  const parts: string[] = [];
  let used = 0;
  for (const el of els) {
    if (used >= FLAT_BUDGET) break;
    const text = cleanText(el);
    if (text.length > 40) { parts.push(text); used += text.length; }
  }
  return parts.join('\n\n').slice(0, FLAT_BUDGET);
}

// ─── Chunked extraction (for local models, used with selectChunks()) ─────────

export interface Chunk {
  heading: string;
  text: string;         // heading + body, ready to inject into prompt
  tokens: string[];     // tokenised for BM25
}

function tokenize(text: string): string[] {
  return text.toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .split(/\s+/)
    .filter(t => t.length > 2 && !STOPWORDS.has(t));
}

function makeChunk(heading: string, body: string): Chunk | null {
  const text = (heading ? `${heading}\n${body}` : body).trim();
  if (text.length < 40) return null;
  return { heading, text, tokens: tokenize(text) };
}

// Chunk a single element by h1-h3 heading boundaries.
function chunkElement(root: HTMLElement, defaultHeading: string): Chunk[] {
  const chunks: Chunk[] = [];
  let currentHeading = defaultHeading;
  const bodyParts: string[] = [];

  function flush() {
    const body = bodyParts.join(' ').replace(/\s+/g, ' ').trim();
    bodyParts.length = 0;
    const chunk = makeChunk(currentHeading, body);
    if (chunk) chunks.push(chunk);
  }

  function walk(node: Node) {
    if (node.nodeType === Node.TEXT_NODE) {
      const t = (node.textContent ?? '').replace(/\s+/g, ' ').trim();
      if (t) bodyParts.push(t);
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const el = node as HTMLElement;
    if (el.matches?.(NOISE_SELECTOR)) return;
    if (el.getAttribute('aria-hidden') === 'true') return;
    if (/^h[1-3]$/.test(el.tagName.toLowerCase())) {
      flush();
      currentHeading = el.textContent?.replace(/\s+/g, ' ').trim() ?? '';
      return;
    }
    for (const child of el.childNodes) walk(child);
  }

  walk(root);
  flush();
  return chunks;
}

// Split all semantic content elements into heading-based chunks.
// Falls back to sliding windows when no heading structure is found.
export function chunkPage(): Chunk[] {
  const els = findContentElements();
  const allChunks: Chunk[] = [];

  for (const el of els) {
    // Use the element's own heading text or its id/aria-label as the section label
    const sectionLabel = (
      el.querySelector('h1,h2,h3')?.textContent?.trim() ??
      el.getAttribute('aria-label') ??
      el.id ??
      ''
    );
    const elChunks = chunkElement(el, sectionLabel);
    allChunks.push(...elChunks);
  }

  // No heading structure found across any element — window the combined text
  if (allChunks.length <= els.length) {
    const fullText = els.map(el => cleanText(el)).join('\n\n');
    return windowChunks(fullText);
  }

  return allChunks;
}

function windowChunks(text: string, size = 600, overlap = 100): Chunk[] {
  // Split on word boundaries within the size window
  const chunks: Chunk[] = [];
  let start = 0;
  while (start < text.length) {
    const end = Math.min(start + size, text.length);
    // Walk back to a word boundary
    let cut = end;
    if (end < text.length) {
      const boundary = text.lastIndexOf(' ', end);
      if (boundary > start) cut = boundary;
    }
    const slice = text.slice(start, cut).trim();
    const chunk = makeChunk('', slice);
    if (chunk) chunks.push(chunk);
    start = cut - overlap;
    if (start < 0) start = 0;
    if (start >= text.length || cut === text.length) break;
  }
  return chunks;
}

// BM25 retrieval — returns the top chunks for a query, up to `budget` chars.
// Chunks are sorted by relevance score; zero-scoring chunks are omitted.
export function selectChunks(query: string, chunks: Chunk[], budget: number): string {
  if (chunks.length === 0) return '';

  const queryTokens = tokenize(query);
  if (queryTokens.length === 0) {
    // No meaningful query terms — return document order up to budget
    let out = '';
    for (const c of chunks) {
      if (out.length + c.text.length + 2 > budget) break;
      out += (out ? '\n\n' : '') + c.text;
    }
    return out;
  }

  const N = chunks.length;

  // Document frequency per term
  const df = new Map<string, number>();
  for (const c of chunks) {
    new Set(c.tokens).forEach(t => df.set(t, (df.get(t) ?? 0) + 1));
  }

  // IDF: log((N - df + 0.5) / (df + 0.5) + 1)
  const idf = new Map<string, number>();
  df.forEach((freq, term) => idf.set(term, Math.log((N - freq + 0.5) / (freq + 0.5) + 1)));

  const avgLen = chunks.reduce((s, c) => s + c.tokens.length, 0) / N;
  const k1 = 1.5, b = 0.75;

  const scored = chunks.map(chunk => {
    const tf = new Map<string, number>();
    chunk.tokens.forEach(t => tf.set(t, (tf.get(t) ?? 0) + 1));
    const dl = chunk.tokens.length;
    let score = 0;
    for (const term of queryTokens) {
      const f = tf.get(term) ?? 0;
      if (f === 0) continue;
      score += (idf.get(term) ?? 0) * (f * (k1 + 1)) / (f + k1 * (1 - b + b * dl / avgLen));
    }
    return { chunk, score };
  });

  scored.sort((a, b) => b.score - a.score);

  const hasMatches = scored[0]?.score > 0;

  // No BM25 overlap (vocabulary mismatch — e.g. "working on" vs "builds") →
  // fall back to document order so the model still sees the full page.
  const candidates = hasMatches
    ? scored.filter(s => s.score > 0).map(s => s.chunk)
    : chunks; // original document order

  let out = '';
  for (const chunk of candidates) {
    if (out.length + chunk.text.length + 2 > budget) {
      if (!out) out = chunk.text.slice(0, budget);
      break;
    }
    out += (out ? '\n\n' : '') + chunk.text;
  }
  return out;
}

// ─── Public API ──────────────────────────────────────────────────────────────

export interface IndexResult {
  fixedContext: string;  // meta + links + jsonld + explicit (always inject)
  flatContext:  string;  // fixedContext + full semantic dump (for capable models)
  chunks:       Chunk[]; // semantic chunks for BM25 retrieval (for local models)
  sources:      string[];
}

export function indexPage(): IndexResult {
  const fixedContext = buildFixedContext();
  const semantic     = extractSemanticFlat();
  const flatContext  = [fixedContext, semantic].filter(Boolean).join('\n\n').slice(0, TOTAL_BUDGET);
  const chunks       = chunkPage();

  const sources: string[] = [];
  if (fixedContext) sources.push('fixed');
  if (semantic)     sources.push('semantic');

  return { fixedContext, flatContext, chunks, sources };
}

// Convenience: returns flat context (backward compat for remote/simple use).
export function collectContext(): string {
  return indexPage().flatContext;
}
