import { InferenceEngine } from './engine';
import { collectContext } from './indexer';

type Status = 'idle' | 'loading' | 'ready' | 'error' | 'unsupported';
interface Msg { role: 'user' | 'assistant'; content: string }

type GPUTier = 'low' | 'mid' | 'high';
interface GPUProbe {
  ok: boolean;
  reason?: string;
  gpuName: string;
  vramMB: number;
  tier: GPUTier;
  recommendedModel: string;
  tierLabel: string;
  tierColor: string;
  warning?: string;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#x27;');
}

// Patterns that indicate an integrated / low-VRAM GPU
const INTEGRATED_PATTERNS = /renoir|vega\s*\d|radeon\s*graphics|uhd\s*graphics|iris|xe\s*graphics|mali|adreno|apple\s*m\d|integrated/i;
const HIGH_END_PATTERNS = /rtx\s*[234]\d{3}|rx\s*[67][89]\d{2}|rx\s*7\d{3}|a[456789]\d{3}|m[12]\s*(ultra|max|pro)/i;

async function probeGPU(): Promise<GPUProbe> {
  type NavWithGPU = Navigator & {
    gpu?: { requestAdapter(opts?: object): Promise<GPUAdapter | null> };
    deviceMemory?: number;
  };
  const nav = navigator as NavWithGPU;

  if (!nav.gpu) {
    return { ok: false, reason: 'WebGPU API not available. Use Chrome 113+.', gpuName: 'Unknown', vramMB: 0, tier: 'low', recommendedModel: 'qwen-0.5b', tierLabel: '', tierColor: '' };
  }

  const adapter = await nav.gpu.requestAdapter();
  if (!adapter) {
    return { ok: false, reason: 'No GPU adapter found. Try enabling chrome://flags/#enable-unsafe-webgpu or updating GPU drivers.', gpuName: 'Unknown', vramMB: 0, tier: 'low', recommendedModel: 'qwen-0.5b', tierLabel: '', tierColor: '' };
  }

  // Get GPU name — requestAdapterInfo() is Chrome 121+
  let gpuName = 'Unknown GPU';
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const info = await (adapter as any).requestAdapterInfo?.();
    gpuName = info?.description || info?.device || gpuName;
  } catch { /* not available */ }

  // maxBufferSize is the best available VRAM proxy from WebGPU
  const maxBufBytes = (adapter.limits as GPUSupportedLimits & { maxBufferSize?: number }).maxBufferSize ?? 0;
  const maxBufMB = Math.round(maxBufBytes / (1024 * 1024));

  // For integrated GPUs we can also look at system RAM
  const systemRamGB = nav.deviceMemory ?? 4;
  const isIntegrated = INTEGRATED_PATTERNS.test(gpuName);
  const isHighEnd    = HIGH_END_PATTERNS.test(gpuName);

  // Estimate usable VRAM
  let vramMB: number;
  if (isIntegrated) {
    // Integrated GPUs share system RAM; browsers typically see 512MB–2GB
    vramMB = Math.min(maxBufMB || 1024, Math.round(systemRamGB * 256)); // ~25% of RAM
  } else {
    vramMB = maxBufMB || (isHighEnd ? 6144 : 2048);
  }

  // Tier + model selection
  let tier: GPUTier;
  let recommendedModel: string;
  let tierLabel: string;
  let tierColor: string;
  let warning: string | undefined;

  // iOS Safari has a ~256 MB per-buffer WebGPU limit — models >500 MB crash the tab.
  // Detect via UA (no reliable API alternative) and cap at 0.5b before any tier logic.
  const isIOS = /iP(hone|ad|od)/.test(navigator.userAgent);
  if (isIOS) {
    return {
      ok: true, gpuName: gpuName || 'Apple GPU', vramMB,
      tier: 'mid', recommendedModel: 'qwen-0.5b',
      tierLabel: 'Apple Silicon',
      tierColor: '#00e5ff',
      warning: 'iOS WebGPU has a ~256 MB buffer limit. Using the 0.5B model to stay within it — larger models crash the tab.',
    };
  }

  if (isIntegrated || vramMB < 1500) {
    tier = 'low';
    recommendedModel = 'qwen-0.5b';   // ~400 MB
    tierLabel = 'Integrated / Low VRAM';
    tierColor = '#f59e0b';
    warning = isIntegrated
      ? 'Integrated GPU detected. Running the lightweight 0.5B model to stay within your shared VRAM budget.'
      : 'Low VRAM detected. Using the 0.5B model for reliability.';
  } else if (!isHighEnd && vramMB < 4096) {
    tier = 'mid';
    recommendedModel = 'qwen-1.5b';   // ~1.5 GB q4f32
    tierLabel = 'Mid-range GPU';
    tierColor = '#8b5cf6';
  } else {
    tier = 'high';
    recommendedModel = 'qwen-1.5b';   // could serve larger models here
    tierLabel = 'Capable GPU';
    tierColor = '#00e5ff';
  }

  return { ok: true, gpuName, vramMB, tier, recommendedModel, tierLabel, tierColor, warning };
}

const CSS = `
  :host { all: initial; font-family: ui-monospace, 'Cascadia Code', monospace; }

  .btn-trigger {
    position: fixed; bottom: 24px; left: 24px; z-index: 2147483647;
    width: 52px; height: 52px; border-radius: 50%;
    background: linear-gradient(135deg, #00e5ff1a, #8b5cf61a);
    border: 1px solid #00e5ff66;
    backdrop-filter: blur(12px);
    cursor: pointer; font-size: 20px;
    display: flex; align-items: center; justify-content: center;
    transition: transform 0.2s ease;
    box-shadow: 0 0 20px rgba(0,229,255,0.15);
    color: #e2e8f0;
  }
  .btn-trigger:hover { transform: scale(1.1); }

  .panel {
    position: fixed; bottom: 90px; left: 24px; z-index: 2147483646;
    width: 360px; max-width: calc(100vw - 32px);
    height: min(480px, calc(100dvh - 110px));
    background: #0a0e1a;
    border: 1px solid #1e2d4a;
    border-radius: 16px;
    display: flex; flex-direction: column;
    overflow: hidden;
    box-shadow: 0 0 50px rgba(139,92,246,0.12);
    animation: slideUp 0.2s ease;
  }
  @keyframes slideUp {
    from { opacity: 0; transform: translateY(12px); }
    to   { opacity: 1; transform: translateY(0); }
  }

  /* Mobile responsive */
  @media (max-width: 420px) {
    .panel { width: calc(100vw - 16px); left: 8px; bottom: 80px; }
    .btn-trigger { left: 12px; }
  }

  .header {
    display: flex; align-items: center; gap: 10px;
    padding: 12px 16px;
    background: linear-gradient(90deg, #00e5ff0d, #8b5cf60d);
    border-bottom: 1px solid #1e2d4a;
    flex-shrink: 0;
  }
  .dot {
    width: 7px; height: 7px; border-radius: 50%;
    background: #475569; flex-shrink: 0;
    transition: background 0.3s, box-shadow 0.3s;
  }
  .dot.live { background: #00e5ff; box-shadow: 0 0 8px #00e5ff; }
  .title { font-size: 12px; font-weight: 900; color: #e2e8f0; letter-spacing: 0.1em; }
  .subtitle { font-size: 11px; color: #475569; margin-left: auto; }

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
    border: none; cursor: pointer;
    transition: opacity 0.2s;
  }
  .btn-load:hover { opacity: 0.88; }

  .progress-bar-track {
    width: 100%; height: 5px; background: #1e2d4a;
    border-radius: 99px; overflow: hidden;
  }
  .progress-bar-fill {
    height: 100%; width: 0%;
    background: linear-gradient(90deg, #00e5ff, #8b5cf6);
    border-radius: 99px; transition: width 0.4s ease;
  }
  .progress-label {
    display: flex; justify-content: space-between;
    margin-top: 6px; font-size: 11px;
  }
  .progress-text { color: #475569; }
  .progress-pct  { color: #00e5ff; font-weight: 700; }

  .msg { display: flex; }
  .msg.user { justify-content: flex-end; }
  .bubble {
    max-width: 86%; font-size: 13px; line-height: 1.5;
    border-radius: 12px; padding: 8px 12px;
  }
  .bubble.user {
    background: #00e5ff15; border: 1px solid #00e5ff33; color: #e2e8f0;
  }
  .bubble.assistant {
    background: #0f1629; border: 1px solid #1e2d4a; color: #94a3b8;
  }

  /* Typing dots animation */
  @keyframes blink { 0%,80%,100%{opacity:0} 40%{opacity:1} }
  .typing span { display:inline-block; width:5px; height:5px; border-radius:50%; background:#64748b; animation: blink 1.4s infinite both; }
  .typing span:nth-child(2) { animation-delay:.2s }
  .typing span:nth-child(3) { animation-delay:.4s }

  .input-bar {
    display: flex; gap: 8px; flex-shrink: 0;
    padding: 10px 12px; border-top: 1px solid #1e2d4a;
  }
  .input {
    flex: 1; background: #0f1629; border: 1px solid #1e2d4a;
    border-radius: 8px; color: #e2e8f0; font-size: 13px;
    font-family: inherit; padding: 8px 12px; outline: none;
    transition: border-color 0.2s;
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

  /* Stop button */
  .btn-stop { padding:8px 12px; border-radius:8px; border:1px solid #ef444455; background:#ef444411; color:#f87171; font-size:12px; font-family:inherit; cursor:pointer; }
  .btn-stop:hover { background:#ef444422; }
`;

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
  private lastProgressAt = 0;
  private hangTimer: ReturnType<typeof setTimeout> | null = null;
  private gpuProbe: GPUProbe | null = null;
  private context = '';
  private lastIndexedUrl = '';

  get aiName()   { return this.getAttribute('name')  ?? 'AI Assistant'; }
  get modelKey() { return this.getAttribute('model') ?? 'qwen-1.5b'; }
  get greeting() {
    return this.getAttribute('greeting') ??
      "Hi! I'm an AI assistant running entirely in your browser. Ask me anything about this page.";
  }

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

  // Re-index when SPA navigates to a new page
  private readonly onUrlChange = () => {
    if (location.href !== this.lastIndexedUrl) this.reindex();
  };

  private watchUrlChanges() {
    window.addEventListener('popstate', this.onUrlChange);
    // Also catch pushState-based navigation via MutationObserver on <title>
    const titleEl = document.querySelector('title');
    if (titleEl) {
      new MutationObserver(this.onUrlChange).observe(titleEl, { childList: true });
    }
  }

  private reindex() {
    this.context = collectContext();
    this.lastIndexedUrl = location.href;
  }

  private render() {
    this.shadow.innerHTML = `
      <style>${CSS}</style>
      <button class="btn-trigger" id="trigger" aria-label="Open AI chat">◈</button>
    `;
    this.shadow.getElementById('trigger')!
      .addEventListener('click', () => this.togglePanel());
  }

  private renderPanel(): string {
    return `
      <div class="panel" id="panel" role="dialog" aria-label="AI Chat" aria-modal="true">
        <div class="header">
          <span class="dot ${this.status === 'ready' ? 'live' : ''}"></span>
          <span class="title">${escapeHtml(this.aiName.toUpperCase())}</span>
          <span class="subtitle">${escapeHtml(this.statusLabel())}</span>
        </div>
        <div class="body" id="body" aria-live="polite">${this.renderBody()}</div>
        ${this.status === 'ready' ? `
        <div class="input-bar">
          <input class="input" id="input" placeholder="Ask something..." autocomplete="off" ${this.generating ? 'disabled' : ''} />
          ${this.generating
            ? `<button class="btn-stop" id="stop">&#9632; Stop</button>`
            : `<button class="btn-send" id="send">&#8593;</button>`
          }
        </div>` : ''}
      </div>
    `;
  }

  private renderBody(): string {
    switch (this.status) {
      case 'idle': {
        const p = this.gpuProbe;
        const gpuLine = p?.ok
          ? `<span style="color:${escapeHtml(p.tierColor)};font-weight:700">${escapeHtml(p.tierLabel)}</span>
             &nbsp;·&nbsp; <span style="color:#64748b">${escapeHtml(p.gpuName)}</span>`
          : `<span style="color:#475569">Detecting GPU…</span>`;
        const modelInfo = p?.ok
          ? `Model: <strong style="color:#e2e8f0">${escapeHtml(p.recommendedModel)}</strong>`
          : 'Model: auto-selected based on your GPU';
        const sizeInfo = p?.recommendedModel === 'qwen-0.5b'
          ? '~400 MB · fast on integrated GPUs'
          : p?.recommendedModel === 'qwen-1.5b'
          ? '~1.5 GB · best quality for mid-range+'
          : '~400 MB · cached after first load';
        const warningHtml = p?.warning
          ? `<p class="hint" style="color:#f59e0b;margin-top:-4px">${escapeHtml(p.warning)}</p>`
          : '';
        return `
        <div class="center">
          <span class="emoji">&#129504;</span>
          <p class="desc" style="margin-bottom:4px">${gpuLine}</p>
          <p class="desc" style="color:#475569;font-size:11px;margin-bottom:8px">${modelInfo} &middot; ${sizeInfo}</p>
          ${warningHtml}
          <button class="btn-load" id="load">Load AI &rarr;</button>
          <p class="hint">Runs entirely in your browser &middot; no server &middot; cached after first load</p>
        </div>`;
      }

      case 'loading': return `
        <div class="center">
          <p id="phase-title" style="font-size:13px;font-weight:700;color:#00e5ff">Downloading model weights</p>
          <div style="width:100%">
            <div class="progress-bar-track">
              <div class="progress-bar-fill" id="bar"></div>
            </div>
            <div class="progress-label">
              <span class="progress-text" id="prog-text"></span>
              <span class="progress-pct" id="prog-pct">0%</span>
            </div>
          </div>
          <p id="phase-hint" class="hint">Cached to your browser after this</p>
        </div>`;

      case 'unsupported': return `
        <div class="center">
          <span class="emoji">&#9888;</span>
          <p class="desc">WebGPU is not available in this browser.</p>
          <p class="hint">Try Chrome 113+ on a desktop machine.</p>
        </div>`;

      case 'error': return `
        <div class="center">
          <span class="emoji">&#10005;</span>
          <p class="desc" style="color:#f87171;margin-bottom:4px">Failed to load model.</p>
          <p class="hint" style="color:#64748b;font-size:11px;line-height:1.5;margin-bottom:8px">${escapeHtml(this.errorMsg)}</p>
          ${(this.errorMsg.includes('adapter') || this.errorMsg.includes('GPU') || this.errorMsg.includes('shader')) ? `
          <p class="hint" style="margin-bottom:8px">On Chrome/Linux: chrome://flags/#enable-unsafe-webgpu &rarr; Enable</p>` : ''}
          <button class="btn-load" id="retry">Try again</button>
        </div>`;

      case 'ready':
        // Messages are populated via appendMessageToDOM
        return '';
    }
  }

  private statusLabel(): string {
    if (this.status === 'ready')    return `${escapeHtml(this.gpuProbe?.recommendedModel ?? this.modelKey)} · WebGPU`;
    if (this.status === 'loading')  return 'loading...';
    return 'offline';
  }

  private appendMessageToDOM(msg: Msg, idx: number): void {
    const body = this.shadow.getElementById('body');
    if (!body) return;
    const row = document.createElement('div');
    row.className = `msg ${msg.role}`;
    const bubble = document.createElement('div');
    bubble.className = `bubble ${msg.role}`;
    bubble.id = `msg-${idx}`;
    bubble.setAttribute('role', msg.role === 'assistant' ? 'status' : 'none');
    if (msg.content) {
      bubble.textContent = msg.content;
    } else {
      // Typing indicator
      bubble.innerHTML = '<div class="typing"><span></span><span></span><span></span></div>';
    }
    row.appendChild(bubble);
    body.appendChild(row);
    body.scrollTop = body.scrollHeight;
  }

  private patchLastMessage(delta: string): void {
    this.messages[this.messages.length - 1].content += delta;
    const idx = this.messages.length - 1;
    const bubble = this.shadow.getElementById(`msg-${idx}`);
    if (bubble) {
      bubble.textContent = this.messages[idx].content;
      const body = this.shadow.getElementById('body');
      if (body) body.scrollTop = body.scrollHeight;
    }
  }

  private bindPanelEvents() {
    this.shadow.getElementById('load')?.addEventListener('click', () => this.loadModel());

    this.shadow.getElementById('retry')?.addEventListener('click', () => {
      this.status = 'idle';
      this.errorMsg = '';
      this.rebuildPanel();
    });

    const input = this.shadow.getElementById('input') as HTMLInputElement | null;
    input?.addEventListener('keydown', (e: KeyboardEvent) => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void this.send(); }
    });

    this.shadow.getElementById('send')?.addEventListener('click', () => void this.send());
    this.shadow.getElementById('stop')?.addEventListener('click', () => this.stopGeneration());

    const panel = this.shadow.getElementById('panel');
    panel?.addEventListener('keydown', (e: Event) => {
      if ((e as KeyboardEvent).key === 'Escape') this.togglePanel();
    });
  }

  private togglePanel() {
    this.panelVisible = !this.panelVisible;
    const trigger = this.shadow.getElementById('trigger')!;
    trigger.textContent = this.panelVisible ? '✕' : '◈';

    const existing = this.shadow.getElementById('panel');
    if (this.panelVisible) {
      if (!existing) {
        const div = document.createElement('div');
        div.innerHTML = this.renderPanel();
        const panel = div.firstElementChild!;
        this.shadow.appendChild(panel);
        if (this.status === 'ready') {
          this.messages.forEach((m, i) => this.appendMessageToDOM(m, i));
        }
        this.bindPanelEvents();
        setTimeout(() => (this.shadow.getElementById('input') as HTMLInputElement | null)?.focus(), 50);

        // Probe GPU in the background when panel first opens (only once)
        if (!this.gpuProbe && this.status === 'idle') {
          probeGPU().then(probe => {
            this.gpuProbe = probe;
            // Repaint idle screen with GPU info
            if (this.status === 'idle') this.repaintBody();
          });
        }
      }
    } else {
      if (this.generating) this.stopGeneration();
      existing?.remove();
    }
  }

  private updateProgress(pct: number, text: string) {
    this.lastProgressAt = Date.now();

    // Clear any existing hang warning timer and reset it
    if (this.hangTimer) clearTimeout(this.hangTimer);
    this.hangTimer = setTimeout(() => this.showHangWarning(), 45_000); // 45s no progress = warn

    const bar      = this.shadow.getElementById('bar') as HTMLElement | null;
    const pctEl    = this.shadow.getElementById('prog-pct');
    const textEl   = this.shadow.getElementById('prog-text');
    const titleEl  = this.shadow.getElementById('phase-title');
    const hintEl   = this.shadow.getElementById('phase-hint');

    if (bar)    bar.style.width = `${pct}%`;
    if (pctEl)  pctEl.textContent = `${pct}%`;
    if (textEl) textEl.textContent = text.slice(0, 48);

    // Detect phase from WebLLM progress text and update title accordingly
    if (text.includes('shader') || text.includes('Loading GPU')) {
      const match = text.match(/\[(\d+)\/(\d+)\]/);
      const ofTotal = match ? ` (${match[1]}/${match[2]})` : '';
      if (titleEl) titleEl.textContent = `Compiling GPU shaders${ofTotal}`;
      if (hintEl)  hintEl.textContent  = 'First load only — cached after this. AMD GPUs may take 3–5 min here.';
    } else if (text.includes('Fetch') || text.includes('fetch') || text.includes('param')) {
      if (titleEl) titleEl.textContent = 'Downloading model weights';
      if (hintEl)  hintEl.textContent  = 'Cached to your browser after this';
    } else if (text.includes('Init') || text.includes('init') || text.includes('Loading')) {
      if (titleEl) titleEl.textContent = 'Initializing model';
      if (hintEl)  hintEl.textContent  = 'Almost ready...';
    }
  }

  private showHangWarning() {
    const hintEl  = this.shadow.getElementById('phase-hint');
    const titleEl = this.shadow.getElementById('phase-title');
    if (hintEl) {
      hintEl.innerHTML = `
        <span style="color:#f59e0b">⚠ This is taking a while — not a bug.</span><br>
        Your GPU is compiling WebGPU shaders for the first time. On integrated or low-end GPUs this can take 15–40 minutes.<br><br>
        <strong style="color:#00e5ff">Good news:</strong> Chrome caches the compiled shaders. Every load after this will be instant. You only pay this cost once.
      `;
      hintEl.style.fontSize = '11px';
      hintEl.style.lineHeight = '1.6';
      hintEl.style.color = '#64748b';
    }
    if (titleEl) titleEl.style.color = '#f59e0b';
  }

  private async loadModel() {
    if (this.loading) return;
    this.loading = true;
    try {
      // Use cached probe result or run it now
      const probe = this.gpuProbe ?? await probeGPU();
      this.gpuProbe = probe;
      if (!probe.ok) {
        this.errorMsg = escapeHtml(probe.reason ?? 'WebGPU not available.');
        this.status = 'error';
        this.repaintBody();
        return;
      }

      // Use probed recommended model; fall back to attribute override if explicitly set
      const modelToLoad = this.getAttribute('model') ?? probe.recommendedModel;

      this.status = 'loading';
      this.repaintBody();

      // Index page content in parallel with model download — hides the ~2ms cost
      // inside the 30-90s download. Captures page state at the moment user engaged.
      const [,] = await Promise.all([
        this.engine.load(modelToLoad, (pct, text) => this.updateProgress(pct, text)),
        Promise.resolve().then(() => this.reindex()),
      ]);

      this.status = 'ready';
      this.messages = [{ role: 'assistant', content: this.greeting }];
      this.rebuildPanel();
    } catch (err) {
      console.error('[llm-widget]', err);
      const raw = err instanceof Error ? err.message.slice(0, 160) : String(err).slice(0, 160);
      this.errorMsg = escapeHtml(raw);
      this.status = 'error';
      this.repaintBody();
    } finally {
      this.loading = false;
      if (this.hangTimer) { clearTimeout(this.hangTimer); this.hangTimer = null; }
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
      <div class="header">
        <span class="dot ${this.status === 'ready' ? 'live' : ''}"></span>
        <span class="title">${escapeHtml(this.aiName.toUpperCase())}</span>
        <span class="subtitle">${escapeHtml(this.statusLabel())}</span>
      </div>
      <div class="body" id="body" aria-live="polite">${this.renderBody()}</div>
      ${this.status === 'ready' ? `
      <div class="input-bar">
        <input class="input" id="input" placeholder="Ask something..." autocomplete="off" />
        <button class="btn-send" id="send">&#8593;</button>
      </div>` : ''}
    `;
    if (this.status === 'ready') {
      this.messages.forEach((m, i) => this.appendMessageToDOM(m, i));
    }
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

    // Use cached context (indexed at load time, refreshed on URL change)
    const ctx = this.context || collectContext();

    if (input) input.value = '';
    this.generating = true;

    // Immediately disable send in DOM
    const sendBtn = this.shadow.getElementById('send') as HTMLButtonElement | null;
    if (sendBtn) {
      sendBtn.disabled = true;
      sendBtn.textContent = '·';
    }

    // Show stop button
    const inputBar = sendBtn?.parentElement;
    if (inputBar && !this.shadow.getElementById('stop')) {
      const stopBtn = document.createElement('button');
      stopBtn.className = 'btn-stop';
      stopBtn.id = 'stop';
      stopBtn.textContent = '■ Stop';
      stopBtn.addEventListener('click', () => this.stopGeneration());
      if (sendBtn) {
        inputBar.replaceChild(stopBtn, sendBtn);
      } else {
        inputBar.appendChild(stopBtn);
      }
    }

    if (input) input.disabled = true;

    const history = this.messages.slice(1); // skip greeting
    this.messages.push({ role: 'user', content: text });
    this.appendMessageToDOM(this.messages[this.messages.length - 1], this.messages.length - 1);

    this.messages.push({ role: 'assistant', content: '' });
    this.appendMessageToDOM(this.messages[this.messages.length - 1], this.messages.length - 1);

    const systemPrompt = `You are a helpful assistant on a website.
Answer questions concisely based on the page context below.
If something is not covered, say so honestly.

Page context:
${ctx}`;

    try {
      for await (const delta of this.engine.generate(systemPrompt, history, text)) {
        this.patchLastMessage(delta);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message.slice(0, 140) : String(err).slice(0, 140);
      console.error('[llm-widget] generation error:', err);
      this.patchLastMessage(`⚠ ${msg || 'generation failed'}`);
    } finally {
      this.generating = false;
      // Restore input bar
      const inputBarEl = this.shadow.querySelector('.input-bar') as HTMLElement | null;
      if (inputBarEl) {
        const stopEl = this.shadow.getElementById('stop');
        if (stopEl) stopEl.remove();
        let existingSend = this.shadow.getElementById('send') as HTMLButtonElement | null;
        if (!existingSend) {
          existingSend = document.createElement('button');
          existingSend.className = 'btn-send';
          existingSend.id = 'send';
          existingSend.textContent = '↑';
          existingSend.addEventListener('click', () => void this.send());
          inputBarEl.appendChild(existingSend);
        }
        existingSend.disabled = false;
        existingSend.textContent = '↑';
      }
      const inputEl = this.shadow.getElementById('input') as HTMLInputElement | null;
      if (inputEl) {
        inputEl.disabled = false;
        inputEl.focus();
      }
    }
  }
}
