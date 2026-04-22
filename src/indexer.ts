const SECTION_SELECTORS = [
  'main', 'article', '#about', '#hero', '#projects', '#work',
  '#experience', '#skills', '#contact', '[data-llm-context]',
];

const CHUNK_SIZE  = 600;
const TOTAL_LIMIT = 3500;

export function collectContext(): string {
  const seen = new Set<Element>();
  const chunks: string[] = [];

  for (const sel of SECTION_SELECTORS) {
    const els = document.querySelectorAll<HTMLElement>(sel);
    for (const el of els) {
      if (seen.has(el)) continue;
      seen.add(el);
      const text = el.innerText.replace(/\s+/g, ' ').trim();
      if (text.length > 40) chunks.push(text.slice(0, CHUNK_SIZE));
    }
  }

  // Fall back to body if nothing matched
  if (chunks.length === 0) {
    chunks.push(
      document.body.innerText.replace(/\s+/g, ' ').trim().slice(0, TOTAL_LIMIT),
    );
  }

  return chunks.join('\n\n').slice(0, TOTAL_LIMIT);
}
