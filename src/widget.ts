import { InferenceEngine } from './engine';
import type { RemoteConfig } from './engine';
import { indexPage, selectChunks } from './indexer';
import type { Chunk } from './indexer';

declare const __IDJET_VERSION__: string;
declare const __IDJET_HASH__: string;
const IDJET_VERSION = typeof __IDJET_VERSION__ !== 'undefined' ? __IDJET_VERSION__ : 'dev';
const IDJET_HASH    = typeof __IDJET_HASH__    !== 'undefined' ? __IDJET_HASH__    : '';
console.info(`%cIdjet v${IDJET_VERSION}${IDJET_HASH ? ` · ${IDJET_HASH}` : ''} — in-browser LLM`, 'color:#00e5ff;font-weight:bold');

type Status = 'idle' | 'loading' | 'ready' | 'error';
interface Msg { role: 'user' | 'assistant'; content: string }

type GPUTier = 'cpu' | 'low' | 'mid' | 'high';
interface GPUProbe {
  ok: boolean;
  device: 'webgpu' | 'wasm';
  gpuName: string;
  vramMB: number;
  tier: GPUTier;
  recommendedModel: string;
  tierLabel: string;
  tierColor: string;
  warning?: string;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#x27;');
}

// XSS-safe markdown: escape HTML first, then apply markdown transformations.
function renderMarkdown(raw: string): string {
  let s = raw.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  // Fenced code blocks (must come before inline code)
  s = s.replace(/```[\w]*\n?([\s\S]*?)```/g, '<pre><code>$1</code></pre>');
  // Inline code
  s = s.replace(/`([^`\n]+)`/g, '<code>$1</code>');
  // Bold + italic
  s = s.replace(/\*\*\*([^*\n]+)\*\*\*/g, '<strong><em>$1</em></strong>');
  s = s.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/\*([^*\n]+)\*/g, '<em>$1</em>');
  // Headings → bold (panel too narrow for real h-tags)
  s = s.replace(/^#{1,6} (.+)$/gm, '<strong>$1</strong>');
  // Lists
  s = s.replace(/^[*\-+] (.+)$/gm, '• $1');
  s = s.replace(/^\d+\. (.+)$/gm, (_, item: string) => `• ${item}`);
  // Line breaks
  s = s.replace(/\n/g, '<br>');
  return s;
}

// ─── GPU probe ────────────────────────────────────────────────────────────────

const INTEGRATED_PATTERNS  = /renoir|vega\s*\d|radeon\s*graphics|uhd\s*graphics|iris|xe\s*graphics|mali|adreno|integrated/i;
const APPLE_SILICON_PATTERNS = /apple\s*m\d|apple\s*gpu/i;
const HIGH_END_PATTERNS    = /rtx\s*[234]\d{3}|rx\s*[67][89]\d{2}|rx\s*7\d{3}|a[456789]\d{3}|m[12]\s*(ultra|max|pro)/i;

async function probeGPU(): Promise<GPUProbe> {
  type NavWithGPU = Navigator & {
    gpu?: { requestAdapter(opts?: object): Promise<GPUAdapter | null> };
    deviceMemory?: number;
  };
  const nav = navigator as NavWithGPU;

  const cpuFallback = (label: string, warning: string): GPUProbe => ({
    ok: true, device: 'wasm', gpuName: 'CPU', vramMB: 0, tier: 'cpu',
    recommendedModel: 'cpu-sm', tierLabel: label, tierColor: '#64748b', warning,
  });

  if (!nav.gpu) return cpuFallback('CPU Mode', 'WebGPU not available — CPU inference via WebAssembly (~1 tok/sec, works everywhere).');
  const adapter = await nav.gpu.requestAdapter().catch(() => null);
  if (!adapter) return cpuFallback('CPU Mode', 'No GPU adapter found — falling back to CPU inference.');

  let gpuName = 'Unknown GPU';
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const info = await (adapter as any).requestAdapterInfo?.();
    gpuName = info?.description || info?.device || gpuName;
  } catch { /* Chrome 121+ only */ }

  const maxBufMB = Math.round(((adapter.limits as GPUSupportedLimits & { maxBufferSize?: number }).maxBufferSize ?? 0) / (1024 * 1024));
  const systemRamGB = nav.deviceMemory ?? 4;
  const isIntegrated   = INTEGRATED_PATTERNS.test(gpuName);
  const isAppleSilicon = APPLE_SILICON_PATTERNS.test(gpuName);
  const isHighEnd      = HIGH_END_PATTERNS.test(gpuName) || isAppleSilicon;
  const vramMB = isIntegrated
    ? Math.min(maxBufMB || 1024, Math.round(systemRamGB * 256))
    : (maxBufMB || (isHighEnd ? 6144 : 2048));

  if (/iP(hone|ad|od)/.test(navigator.userAgent)) {
    return cpuFallback('iOS CPU Mode', 'iOS WebGPU has a 256 MB per-buffer cap — using CPU inference instead.');
  }

  if (isIntegrated || vramMB < 1500) {
    return { ok: true, device: 'webgpu', gpuName, vramMB, tier: 'low',
      recommendedModel: 'qwen-0.5b', tierLabel: 'Integrated / Low VRAM', tierColor: '#f59e0b',
      warning: isIntegrated ? 'Integrated GPU — using 0.5B model to stay within shared VRAM.' : 'Low VRAM — using 0.5B model.' };
  }
  if (!isHighEnd && vramMB < 4096) {
    return { ok: true, device: 'webgpu', gpuName, vramMB, tier: 'mid',
      recommendedModel: 'qwen-1.5b', tierLabel: 'Mid-range GPU', tierColor: '#8b5cf6' };
  }
  return { ok: true, device: 'webgpu', gpuName, vramMB, tier: 'high',
    recommendedModel: 'qwen-1.5b', tierLabel: isAppleSilicon ? 'Apple Silicon' : 'Capable GPU', tierColor: '#00e5ff' };
}

// ─── CSS ─────────────────────────────────────────────────────────────────────

function buildCSS(pos: string): string {
  const isBottom = !pos.includes('top');
  const isLeft   = !pos.includes('right');
  const vEdge    = isBottom ? 'bottom' : 'top';
  const hEdge    = isLeft   ? 'left'   : 'right';
  const panelV   = isBottom ? `bottom: 90px; top: auto;` : `top: 90px; bottom: auto;`;
  const slideDir = isBottom ? 'translateY(12px)' : 'translateY(-12px)';

  return `
  :host { all: initial; font-family: ui-monospace, 'Cascadia Code', monospace; }

  .btn-trigger {
    position: fixed; ${vEdge}: 24px; ${hEdge}: 24px; z-index: 2147483647;
    width: 52px; height: 52px; border-radius: 50%;
    background: linear-gradient(135deg, #00e5ff1a, #8b5cf61a);
    border: 1px solid #00e5ff66; backdrop-filter: blur(12px);
    cursor: pointer; font-size: 20px;
    display: flex; align-items: center; justify-content: center;
    transition: transform 0.2s ease;
    box-shadow: 0 0 20px rgba(0,229,255,0.15); color: #e2e8f0;
  }
  .btn-trigger:hover { transform: scale(1.1); }

  .panel {
    position: fixed; ${panelV} ${hEdge}: 24px; z-index: 2147483646;
    width: 360px; max-width: calc(100vw - 32px);
    height: min(480px, calc(100dvh - 110px));
    background: #0a0e1a; border: 1px solid #1e2d4a; border-radius: 16px;
    display: flex; flex-direction: column; overflow: hidden;
    box-shadow: 0 0 50px rgba(139,92,246,0.12);
    animation: slideIn 0.2s ease;
  }
  @keyframes slideIn {
    from { opacity: 0; transform: ${slideDir}; }
    to   { opacity: 1; transform: translateY(0); }
  }

  @media (max-width: 420px) {
    .panel { width: calc(100vw - 16px); ${hEdge}: 8px; ${isBottom ? 'bottom: 80px;' : 'top: 80px;'} }
    .btn-trigger { ${hEdge}: 12px; }
  }

  .header {
    display: flex; align-items: center; gap: 8px; padding: 10px 14px;
    background: linear-gradient(90deg, #00e5ff0d, #8b5cf60d);
    border-bottom: 1px solid #1e2d4a; flex-shrink: 0;
  }
  .dot { width: 7px; height: 7px; border-radius: 50%; background: #475569; flex-shrink: 0; transition: background 0.3s, box-shadow 0.3s; }
  .dot.live { background: #00e5ff; box-shadow: 0 0 8px #00e5ff; }
  .title { font-size: 12px; font-weight: 900; color: #e2e8f0; letter-spacing: 0.1em; }
  .subtitle { font-size: 11px; color: #475569; margin-left: auto; }
  .btn-icon {
    background: none; border: none; cursor: pointer; color: #475569;
    font-size: 14px; padding: 2px 4px; border-radius: 4px; line-height: 1;
    transition: color 0.2s;
  }
  .btn-icon:hover { color: #94a3b8; }

  .body {
    flex: 1; overflow-y: auto; padding: 14px;
    display: flex; flex-direction: column; gap: 10px;
    scrollbar-width: thin; scrollbar-color: #8b5cf6 #0f1629;
  }

  .center {
    display: flex; flex-direction: column;
    align-items: center; justify-content: center;
    height: 100%; gap: 16px; text-align: center; padding: 0 20px;
  }
  .emoji { font-size: 40px; line-height: 1; }
  .desc { font-size: 12px; color: #64748b; line-height: 1.6; }
  .hint { font-size: 11px; color: #334155; }

  .btn-load {
    padding: 9px 28px; border-radius: 8px;
    background: #00e5ff; color: #050810;
    font-size: 13px; font-weight: 700; font-family: inherit;
    border: none; cursor: pointer; transition: opacity 0.2s;
  }
  .btn-load:hover { opacity: 0.88; }
  .btn-cancel {
    padding: 6px 18px; border-radius: 8px;
    background: none; border: 1px solid #334155; color: #475569;
    font-size: 12px; font-family: inherit; cursor: pointer;
    transition: border-color 0.2s, color 0.2s;
  }
  .btn-cancel:hover { border-color: #64748b; color: #94a3b8; }

  .progress-bar-track { width: 100%; height: 5px; background: #1e2d4a; border-radius: 99px; overflow: hidden; }
  .progress-bar-fill {
    height: 100%; width: 0%;
    background: linear-gradient(90deg, #00e5ff, #8b5cf6);
    border-radius: 99px; transition: width 0.4s ease;
  }
  .progress-label { display: flex; justify-content: space-between; margin-top: 6px; font-size: 11px; }
  .progress-text { color: #475569; }
  .progress-pct  { color: #00e5ff; font-weight: 700; }

  .msg { display: flex; flex-direction: column; }
  .msg.user { align-items: flex-end; }
  .msg.assistant { align-items: flex-start; }
  .bubble {
    max-width: 86%; font-size: 13px; line-height: 1.5;
    border-radius: 12px; padding: 8px 12px; word-break: break-word;
  }
  .bubble.user { background: #00e5ff15; border: 1px solid #00e5ff33; color: #e2e8f0; }
  .bubble.assistant { background: #0f1629; border: 1px solid #1e2d4a; color: #94a3b8; }
  .bubble pre { background: #050810; border: 1px solid #1e2d4a; border-radius: 6px; padding: 8px; overflow-x: auto; margin: 6px 0; }
  .bubble code { font-family: inherit; font-size: 12px; color: #00e5ff; }
  .bubble pre code { color: #94a3b8; }
  .bubble strong { color: #e2e8f0; }
  .bubble em { color: #a78bfa; }
  .msg-actions { display: flex; gap: 4px; margin-top: 4px; opacity: 0; transition: opacity 0.15s; }
  .msg:hover .msg-actions { opacity: 1; }
  .btn-copy {
    background: none; border: 1px solid #1e2d4a; border-radius: 5px;
    color: #475569; font-size: 10px; font-family: inherit;
    padding: 2px 7px; cursor: pointer; transition: color 0.15s, border-color 0.15s;
  }
  .btn-copy:hover { color: #00e5ff; border-color: #00e5ff44; }

  @keyframes blink { 0%,80%,100%{opacity:0} 40%{opacity:1} }
  .typing span { display:inline-block; width:5px; height:5px; border-radius:50%; background:#64748b; animation: blink 1.4s infinite both; }
  .typing span:nth-child(2) { animation-delay:.2s }
  .typing span:nth-child(3) { animation-delay:.4s }

  .input-bar { display: flex; gap: 8px; flex-shrink: 0; padding: 10px 12px; border-top: 1px solid #1e2d4a; }
  .input {
    flex: 1; background: #0f1629; border: 1px solid #1e2d4a;
    border-radius: 8px; color: #e2e8f0; font-size: 13px;
    font-family: inherit; padding: 8px 12px; outline: none; transition: border-color 0.2s;
  }
  .input:focus { border-color: #8b5cf666; }
  .input::placeholder { color: #334155; }
  .btn-send {
    padding: 8px 14px; border-radius: 8px; border: none;
    font-size: 14px; font-family: inherit; font-weight: 700;
    cursor: pointer; transition: background 0.2s, color 0.2s;
    background: #00e5ff; color: #050810;
  }
  .btn-send:disabled { background: #1e2d4a; color: #475569; cursor: default; }
  .btn-stop { padding:8px 12px; border-radius:8px; border:1px solid #ef444455; background:#ef444411; color:#f87171; font-size:12px; font-family:inherit; cursor:pointer; }
  .btn-stop:hover { background:#ef444422; }
  `;
}

// ─── Widget ───────────────────────────────────────────────────────────────────

export class LLMChatWidget extends HTMLElement {
  private shadow: ShadowRoot;
  private engine = new InferenceEngine();
  private status: Status = 'idle';
  private errorMsg = '';
  private messages: Msg[] = [];
  private generating = false;
  private loading = false;
  private panelVisible = false;
  private rendered = false;
  private hangTimer: ReturnType<typeof setTimeout> | null = null;
  private gpuProbe: GPUProbe | null = null;
  private fixedContext = '';
  private flatContext  = '';
  private chunks: Chunk[] = [];
  private lastIndexedUrl = '';

  get aiName()            { return this.getAttribute('name')          ?? 'AI Assistant'; }
  get modelKey()          { return this.getAttribute('model')         ?? 'qwen-1.5b'; }
  get position()          { return this.getAttribute('data-position') ?? 'bottom-left'; }
  get extraSystemPrompt() { return this.getAttribute('system-prompt') ?? ''; }
  get greeting() {
    return this.getAttribute('greeting') ??
      "Hi! I'm an AI assistant running entirely in your browser. Ask me anything about this page.";
  }
  get apiUrl()   { return this.getAttribute('data-api-url')   ?? ''; }
  get apiKey()   { return this.getAttribute('data-api-key')   ?? ''; }
  get apiModel() { return this.getAttribute('data-api-model') ?? 'gpt-4o-mini'; }

  private get storageKey() { return `idjet:${location.hostname}:messages`; }

  constructor() {
    super();
    this.shadow = this.attachShadow({ mode: 'open' });
  }

  connectedCallback() {
    if (this.rendered) return;
    this.rendered = true;
    this.render();
    this.watchUrlChanges();
  }

  disconnectedCallback() {
    this.stopGeneration();
    this.engine.destroy();
    window.removeEventListener('popstate', this.onUrlChange);
  }

  private emit(event: string, detail?: unknown) {
    this.dispatchEvent(new CustomEvent(`idjet:${event}`, { bubbles: true, composed: true, detail }));
  }

  private readonly onUrlChange = () => {
    if (location.href !== this.lastIndexedUrl) this.reindex();
  };

  private watchUrlChanges() {
    window.addEventListener('popstate', this.onUrlChange);
    const titleEl = document.querySelector('title');
    if (titleEl) new MutationObserver(this.onUrlChange).observe(titleEl, { childList: true });
  }

  private reindex() {
    const result = indexPage();
    this.fixedContext = result.fixedContext;
    this.flatContext  = result.flatContext;
    this.chunks       = result.chunks;
    this.lastIndexedUrl = location.href;
  }

  private saveHistory() {
    try { localStorage.setItem(this.storageKey, JSON.stringify(this.messages)); } catch { /* private browsing */ }
  }

  private loadHistory(): Msg[] | null {
    try {
      const raw = localStorage.getItem(this.storageKey);
      return raw ? (JSON.parse(raw) as Msg[]) : null;
    } catch { return null; }
  }

  private render() {
    this.shadow.innerHTML = `<style>${buildCSS(this.position)}</style>
      <button class="btn-trigger" id="trigger" aria-label="Open AI chat">◈</button>`;
    this.shadow.getElementById('trigger')!.addEventListener('click', () => this.togglePanel());
  }

  private headerHTML() {
    const clearBtn = this.status === 'ready'
      ? `<button class="btn-icon" id="clear" title="Clear chat">&#128465;</button>`
      : '';
    return `
      <div class="header">
        <span class="dot ${this.status === 'ready' ? 'live' : ''}"></span>
        <span class="title">${escapeHtml(this.aiName.toUpperCase())}</span>
        <span class="subtitle">${escapeHtml(this.statusLabel())}</span>
        ${clearBtn}
      </div>`;
  }

  private renderPanel(): string {
    return `
      <div class="panel" id="panel" role="dialog" aria-label="AI Chat" aria-modal="true">
        ${this.headerHTML()}
        <div class="body" id="body" aria-live="polite">${this.renderBody()}</div>
        ${this.status === 'ready' ? `
        <div class="input-bar">
          <input class="input" id="input" placeholder="Ask something..." autocomplete="off" ${this.generating ? 'disabled' : ''} />
          ${this.generating
            ? `<button class="btn-stop" id="stop">&#9632; Stop</button>`
            : `<button class="btn-send" id="send">&#8593;</button>`}
        </div>` : ''}
      </div>`;
  }

  private renderBody(): string {
    switch (this.status) {
      case 'idle': {
        if (this.apiUrl) {
          return `<div class="center">
            <span class="emoji">&#127760;</span>
            <p class="desc">Server-side inference &mdash; instant responses, no download</p>
            <button class="btn-load" id="load">Connect &rarr;</button>
            <p class="hint">Model: <strong style="color:#e2e8f0">${escapeHtml(this.apiModel)}</strong></p>
            <p class="hint" style="margin-top:8px;color:#1e3a4a;font-size:10px;letter-spacing:0.08em">IDJET v${IDJET_VERSION}${IDJET_HASH ? ` &middot; ${IDJET_HASH}` : ''}</p>
          </div>`;
        }
        const p = this.gpuProbe;
        const gpuLine = p
          ? `<span style="color:${escapeHtml(p.tierColor)};font-weight:700">${escapeHtml(p.tierLabel)}</span> &nbsp;·&nbsp; <span style="color:#64748b">${escapeHtml(p.gpuName)}</span>`
          : `<span style="color:#475569">Detecting…</span>`;
        const sizeMap: Record<string, string> = {
          'cpu-sm': '~200 MB · CPU · works everywhere',
          'qwen-0.5b': '~400 MB · WebGPU',
          'qwen-1.5b': '~900 MB · WebGPU · best quality',
        };
        const modelLabel = p ? `Model: <strong style="color:#e2e8f0">${escapeHtml(p.recommendedModel)}</strong> · ${sizeMap[p.recommendedModel] ?? 'auto'}` : 'Model: auto';
        const warnHtml = p?.warning ? `<p class="hint" style="color:#f59e0b;margin-top:-4px">${escapeHtml(p.warning)}</p>` : '';
        return `<div class="center">
          <span class="emoji">&#129504;</span>
          <p class="desc" style="margin-bottom:4px">${gpuLine}</p>
          <p class="desc" style="color:#475569;font-size:11px;margin-bottom:8px">${modelLabel}</p>
          ${warnHtml}
          <button class="btn-load" id="load">Load AI &rarr;</button>
          <p class="hint">Runs in your browser &middot; no server &middot; cached after first load</p>
          <p class="hint" style="margin-top:8px;color:#1e3a4a;font-size:10px;letter-spacing:0.08em">IDJET v${IDJET_VERSION}${IDJET_HASH ? ` &middot; ${IDJET_HASH}` : ''}</p>
        </div>`;
      }

      case 'loading': return `
        <div class="center">
          <p id="phase-title" style="font-size:13px;font-weight:700;color:#00e5ff">Downloading model weights</p>
          <div style="width:100%">
            <div class="progress-bar-track"><div class="progress-bar-fill" id="bar"></div></div>
            <div class="progress-label">
              <span class="progress-text" id="prog-text"></span>
              <span class="progress-pct" id="prog-pct">0%</span>
            </div>
          </div>
          <p id="phase-hint" class="hint">Cached to your browser after this</p>
          <button class="btn-cancel" id="cancel-load">Cancel</button>
        </div>`;

      case 'error': return `
        <div class="center">
          <span class="emoji">&#10005;</span>
          <p class="desc" style="color:#f87171;margin-bottom:4px">Failed to load model.</p>
          <p class="hint" style="color:#64748b;font-size:11px;line-height:1.5;margin-bottom:8px">${escapeHtml(this.errorMsg)}</p>
          <button class="btn-load" id="retry">Try again</button>
        </div>`;

      case 'ready':
        return ''; // Messages appended via appendMessageToDOM
    }
  }

  private statusLabel(): string {
    if (this.status === 'ready' && this.apiUrl) return `${escapeHtml(this.apiModel)} · Server`;
    const p = this.gpuProbe;
    if (this.status === 'ready')   return `${escapeHtml(p?.recommendedModel ?? this.modelKey)} · ${p?.device === 'wasm' ? 'CPU' : 'WebGPU'}`;
    if (this.status === 'loading') return 'loading...';
    return 'offline';
  }

  private appendMessageToDOM(msg: Msg, idx: number): void {
    const body = this.shadow.getElementById('body');
    if (!body) return;
    const row = document.createElement('div');
    row.className = `msg ${msg.role}`;
    row.dataset.idx = String(idx);
    const bubble = document.createElement('div');
    bubble.className = `bubble ${msg.role}`;
    bubble.id = `msg-${idx}`;
    bubble.setAttribute('role', msg.role === 'assistant' ? 'status' : 'none');
    if (msg.content) {
      if (msg.role === 'assistant') {
        bubble.innerHTML = renderMarkdown(msg.content);
      } else {
        bubble.textContent = msg.content;
      }
    } else {
      bubble.innerHTML = '<div class="typing"><span></span><span></span><span></span></div>';
    }
    row.appendChild(bubble);
    if (msg.role === 'assistant' && msg.content) {
      row.appendChild(this.makeCopyBtn(idx));
    }
    body.appendChild(row);
    body.scrollTop = body.scrollHeight;
  }

  private makeCopyBtn(idx: number): HTMLDivElement {
    const actions = document.createElement('div');
    actions.className = 'msg-actions';
    const btn = document.createElement('button');
    btn.className = 'btn-copy';
    btn.textContent = 'copy';
    btn.addEventListener('click', () => {
      const content = this.messages[idx]?.content ?? '';
      navigator.clipboard?.writeText(content).then(() => {
        btn.textContent = 'copied!';
        setTimeout(() => { btn.textContent = 'copy'; }, 1500);
      }).catch(() => { btn.textContent = 'failed'; });
    });
    actions.appendChild(btn);
    return actions;
  }

  // During streaming: plain text. On completion: render markdown.
  private patchLastMessage(delta: string): void {
    const idx = this.messages.length - 1;
    this.messages[idx].content += delta;
    const bubble = this.shadow.getElementById(`msg-${idx}`);
    if (bubble) {
      bubble.textContent = this.messages[idx].content; // plain text during streaming
      const body = this.shadow.getElementById('body');
      if (body) body.scrollTop = body.scrollHeight;
    }
  }

  private finalizeLastMessage(): void {
    const idx = this.messages.length - 1;
    const msg = this.messages[idx];
    if (msg?.role !== 'assistant') return;
    const bubble = this.shadow.getElementById(`msg-${idx}`);
    if (bubble) {
      bubble.innerHTML = renderMarkdown(msg.content); // render markdown on completion
      // Add copy button if not already there
      const row = bubble.parentElement;
      if (row && !row.querySelector('.msg-actions')) {
        row.appendChild(this.makeCopyBtn(idx));
      }
    }
  }

  private bindPanelEvents() {
    this.shadow.getElementById('load')?.addEventListener('click', () => void this.loadModel());
    this.shadow.getElementById('retry')?.addEventListener('click', () => {
      this.status = 'idle'; this.errorMsg = ''; this.rebuildPanel();
    });
    this.shadow.getElementById('cancel-load')?.addEventListener('click', () => {
      this.engine.destroy();
      this.engine = new InferenceEngine();
      this.loading = false;
      if (this.hangTimer) { clearTimeout(this.hangTimer); this.hangTimer = null; }
      this.status = 'idle';
      this.repaintBody();
    });
    this.shadow.getElementById('clear')?.addEventListener('click', () => this.clearChat());

    const input = this.shadow.getElementById('input') as HTMLInputElement | null;
    input?.addEventListener('keydown', (e: KeyboardEvent) => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void this.send(); }
    });
    this.shadow.getElementById('send')?.addEventListener('click', () => void this.send());
    this.shadow.getElementById('stop')?.addEventListener('click', () => this.stopGeneration());
    this.shadow.getElementById('panel')?.addEventListener('keydown', (e: Event) => {
      if ((e as KeyboardEvent).key === 'Escape') this.togglePanel();
    });
  }

  private clearChat() {
    this.messages = [{ role: 'assistant', content: this.greeting }];
    try { localStorage.removeItem(this.storageKey); } catch { /* ok */ }
    const body = this.shadow.getElementById('body');
    if (body) {
      body.innerHTML = '';
      this.messages.forEach((m, i) => this.appendMessageToDOM(m, i));
    }
    this.emit('clear');
  }

  private togglePanel() {
    this.panelVisible = !this.panelVisible;
    const trigger = this.shadow.getElementById('trigger')!;
    trigger.textContent = this.panelVisible ? '✕' : '◈';

    const existing = this.shadow.getElementById('panel');
    if (this.panelVisible) {
      this.emit('open');
      if (!existing) {
        const div = document.createElement('div');
        div.innerHTML = this.renderPanel();
        this.shadow.appendChild(div.firstElementChild!);
        if (this.status === 'ready') this.messages.forEach((m, i) => this.appendMessageToDOM(m, i));
        this.bindPanelEvents();
        setTimeout(() => (this.shadow.getElementById('input') as HTMLInputElement | null)?.focus(), 50);
        if (!this.gpuProbe && this.status === 'idle') {
          probeGPU().then(probe => {
            this.gpuProbe = probe;
            if (this.status === 'idle') this.repaintBody();
          });
        }
      }
    } else {
      this.emit('close');
      if (this.generating) this.stopGeneration();
      existing?.remove();
    }
  }

  private updateProgress(pct: number, text: string) {
    if (this.hangTimer) clearTimeout(this.hangTimer);
    this.hangTimer = setTimeout(() => this.showHangWarning(), 45_000);

    const bar    = this.shadow.getElementById('bar') as HTMLElement | null;
    const pctEl  = this.shadow.getElementById('prog-pct');
    const textEl = this.shadow.getElementById('prog-text');
    const titleEl = this.shadow.getElementById('phase-title');
    const hintEl  = this.shadow.getElementById('phase-hint');

    if (bar)    bar.style.width = `${pct}%`;
    if (pctEl)  pctEl.textContent = `${pct}%`;
    if (textEl) textEl.textContent = text.slice(0, 52);

    if (text.includes('shader') || text.includes('Loading GPU')) {
      const m = text.match(/\[(\d+)\/(\d+)\]/);
      if (titleEl) titleEl.textContent = `Compiling GPU shaders${m ? ` (${m[1]}/${m[2]})` : ''}`;
      if (hintEl)  hintEl.textContent  = 'First load only — cached after this. AMD GPUs may take 3–5 min.';
    } else if (text.includes('Fetch') || text.includes('fetch') || text.includes('param') || text.includes('Downloading')) {
      if (titleEl) titleEl.textContent = 'Downloading model weights';
      if (hintEl)  hintEl.textContent  = 'Cached to your browser after this';
    } else if (text.includes('Loading inference runtime')) {
      if (titleEl) titleEl.textContent = 'Loading inference runtime';
      if (hintEl)  hintEl.textContent  = 'One-time fetch from CDN — browser-cached after this';
    } else if (text.includes('Init') || text.includes('init') || text.includes('Loading')) {
      if (titleEl) titleEl.textContent = 'Initializing model';
      if (hintEl)  hintEl.textContent  = 'Almost ready...';
    }
  }

  private showHangWarning() {
    const hintEl  = this.shadow.getElementById('phase-hint');
    const titleEl = this.shadow.getElementById('phase-title');
    if (hintEl) {
      hintEl.innerHTML = `<span style="color:#f59e0b">⚠ Taking a while — not a bug.</span><br>
        First-time WebGPU shader compilation on slow/integrated GPUs can take 15–40 min.<br><br>
        <strong style="color:#00e5ff">Chrome caches compiled shaders</strong> — every load after this is instant.`;
      hintEl.style.cssText = 'font-size:11px;line-height:1.6;color:#64748b';
    }
    if (titleEl) titleEl.style.color = '#f59e0b';
  }

  private async loadModel() {
    if (this.loading) return;
    this.loading = true;
    try {
      // Remote API path — no download, no GPU probe, instant ready.
      if (this.apiUrl) {
        const remote: RemoteConfig = {
          apiUrl: this.apiUrl,
          model: this.apiModel,
          ...(this.apiKey ? { apiKey: this.apiKey } : {}),
        };
        await this.engine.load(this.apiModel, 'remote', () => {}, remote);
        this.status = 'ready';
        const saved = this.loadHistory();
        this.messages = (saved && saved.length > 1) ? saved : [{ role: 'assistant', content: this.greeting }];
        this.rebuildPanel();
        this.emit('ready', { device: 'remote', model: this.apiModel });
        return;
      }

      const probe = this.gpuProbe ?? await probeGPU();
      this.gpuProbe = probe;
      const attrModel = this.getAttribute('model');
      const modelToLoad = (probe.tier === 'high' && attrModel) ? attrModel : probe.recommendedModel;

      this.status = 'loading';
      this.repaintBody();

      const [,] = await Promise.all([
        this._loadWithRetry(modelToLoad, probe),
        Promise.resolve().then(() => this.reindex()),
      ]);

      this.status = 'ready';
      const saved = this.loadHistory();
      this.messages = (saved && saved.length > 1) ? saved : [{ role: 'assistant', content: this.greeting }];
      this.rebuildPanel();
      this.emit('ready', { device: this.gpuProbe.device, model: modelToLoad });
    } catch (err) {
      console.error('[idjet]', err);
      this.errorMsg = escapeHtml(err instanceof Error ? err.message.slice(0, 160) : String(err).slice(0, 160));
      this.status = 'error';
      this.repaintBody();
    } finally {
      this.loading = false;
      if (this.hangTimer) { clearTimeout(this.hangTimer); this.hangTimer = null; }
    }
  }

  // If WebGPU load throws, automatically retry on CPU before surfacing the error.
  private async _loadWithRetry(modelToLoad: string, probe: GPUProbe) {
    const onProgress = (pct: number, text: string) => this.updateProgress(pct, text);
    if (probe.device !== 'webgpu') {
      return this.engine.load(modelToLoad, 'wasm', onProgress);
    }
    try {
      return await this.engine.load(modelToLoad, 'webgpu', onProgress);
    } catch (gpuErr) {
      console.warn('[idjet] WebGPU failed, retrying on CPU:', gpuErr);
      const titleEl = this.shadow.getElementById('phase-title');
      if (titleEl) titleEl.textContent = 'GPU failed — retrying on CPU…';
      this.engine.destroy();
      this.engine = new InferenceEngine();
      this.gpuProbe = { ...probe, device: 'wasm', tier: 'cpu', recommendedModel: 'cpu-sm',
        tierLabel: 'CPU Mode (GPU fallback)', tierColor: '#64748b' };
      return this.engine.load('cpu-sm', 'wasm', onProgress);
    }
  }

  private repaintBody() {
    const body = this.shadow.getElementById('body');
    if (!body) return;
    body.innerHTML = this.renderBody();
    if (this.status === 'ready') {
      this.messages.forEach((m, i) => this.appendMessageToDOM(m, i));
      body.scrollTop = body.scrollHeight;
    }
    this.bindPanelEvents();
  }

  private rebuildPanel() {
    const panel = this.shadow.getElementById('panel');
    if (!panel) return;
    panel.innerHTML = `
      ${this.headerHTML()}
      <div class="body" id="body" aria-live="polite">${this.renderBody()}</div>
      ${this.status === 'ready' ? `
      <div class="input-bar">
        <input class="input" id="input" placeholder="Ask something..." autocomplete="off" />
        <button class="btn-send" id="send">&#8593;</button>
      </div>` : ''}`;
    if (this.status === 'ready') this.messages.forEach((m, i) => this.appendMessageToDOM(m, i));
    this.bindPanelEvents();
  }

  private stopGeneration(): void {
    if (!this.generating) return;
    this.engine.interrupt();
    this.generating = false;
    const send = this.shadow.getElementById('send') as HTMLButtonElement | null;
    const stop = this.shadow.getElementById('stop');
    if (send) { send.disabled = false; send.textContent = '↑'; }
    stop?.remove();
  }

  private async send() {
    const input = this.shadow.getElementById('input') as HTMLInputElement | null;
    const text = input?.value.trim();
    if (!text || this.generating) return;

    // Remote/capable models: full flat context (big context window, handles more).
    // Local 1.5B models: BM25 chunk selection — focused context beats noisy long context
    // for small models due to the "lost in the middle" degradation.
    const isRemote = !!this.apiUrl;
    const ctx = isRemote
      ? (this.flatContext  || indexPage().flatContext)
      : selectChunks(text, this.chunks.length > 0 ? this.chunks : indexPage().chunks, 3000)
        || this.fixedContext;

    if (input) input.value = '';
    this.generating = true;
    this.emit('message', { role: 'user', content: text });

    const sendBtn = this.shadow.getElementById('send') as HTMLButtonElement | null;
    if (sendBtn) { sendBtn.disabled = true; sendBtn.textContent = '·'; }
    const inputBar = sendBtn?.parentElement;
    if (inputBar && !this.shadow.getElementById('stop')) {
      const stopBtn = document.createElement('button');
      stopBtn.className = 'btn-stop'; stopBtn.id = 'stop'; stopBtn.textContent = '■ Stop';
      stopBtn.addEventListener('click', () => this.stopGeneration());
      if (sendBtn) inputBar.replaceChild(stopBtn, sendBtn);
      else inputBar.appendChild(stopBtn);
    }
    if (input) input.disabled = true;

    // Keep only the last 6 turns (3 exchanges) — small models hallucinate when
    // stale history crowds out fresh page context in a limited context window.
    const history = this.messages.slice(1).slice(-6);
    this.messages.push({ role: 'user', content: text });
    this.appendMessageToDOM(this.messages[this.messages.length - 1], this.messages.length - 1);
    this.messages.push({ role: 'assistant', content: '' });
    this.appendMessageToDOM(this.messages[this.messages.length - 1], this.messages.length - 1);

    // Yield one frame so the browser paints the typing indicator before the GPU prefill
    // locks the main thread on the first inference call.
    await new Promise<void>(r => setTimeout(r, 0));

    // For CPU/small models, inject context directly into the user message — small models
    // often ignore system prompts and hallucinate without explicit in-message grounding.
    const isCPU = this.gpuProbe?.device === 'wasm';
    const systemPrompt = [
      `You are a web page assistant. Answer ONLY using the provided page context.`,
      `Do NOT use outside knowledge. If the answer is not in the context, say exactly: "I don't see that on this page."`,
      this.extraSystemPrompt,
      ctx ? `\nPage context:\n${ctx}` : '\n(No page context available.)',
    ].filter(Boolean).join('\n');

    const userMessage = (isCPU && ctx)
      ? `Page context:\n${ctx}\n\nQuestion: ${text}\n\nAnswer based ONLY on the page context above.`
      : text;

    try {
      for await (const delta of this.engine.generate(systemPrompt, history, userMessage)) {
        this.patchLastMessage(delta);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message.slice(0, 140) : String(err).slice(0, 140);
      console.error('[idjet] generation error:', err);
      this.patchLastMessage(`⚠ ${msg || 'generation failed'}`);
    } finally {
      this.generating = false;
      this.finalizeLastMessage();
      this.saveHistory();
      this.emit('response', { content: this.messages[this.messages.length - 1].content });

      const inputBarEl = this.shadow.querySelector('.input-bar') as HTMLElement | null;
      if (inputBarEl) {
        this.shadow.getElementById('stop')?.remove();
        let existingSend = this.shadow.getElementById('send') as HTMLButtonElement | null;
        if (!existingSend) {
          existingSend = document.createElement('button');
          existingSend.className = 'btn-send'; existingSend.id = 'send';
          existingSend.addEventListener('click', () => void this.send());
          inputBarEl.appendChild(existingSend);
        }
        existingSend.disabled = false; existingSend.textContent = '↑';
      }
      const inputEl = this.shadow.getElementById('input') as HTMLInputElement | null;
      if (inputEl) { inputEl.disabled = false; inputEl.focus(); }
    }
  }
}
