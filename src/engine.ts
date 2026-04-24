import type { MLCEngine, InitProgressReport } from '@mlc-ai/web-llm';

export type ProgressCallback = (pct: number, text: string) => void;

export interface RemoteConfig {
  apiUrl: string;
  apiKey?: string;
  model: string;
}

// WebGPU path — MLC-compiled, quantised for GPU.
const WEBGPU_MODELS: Record<string, string> = {
  'qwen-1.5b':  'Qwen2.5-1.5B-Instruct-q4f32_1-MLC',
  'qwen-0.5b':  'Qwen2.5-0.5B-Instruct-q4f32_1-MLC',
  'smollm-1.7b':'SmolLM2-1.7B-Instruct-q4f32_1-MLC',
};

// CPU path — ONNX quantised models on HuggingFace Hub.
// Loaded only when device === 'wasm' to avoid bundling transformers.js.
const WASM_MODELS: Record<string, string> = {
  'cpu-sm':     'HuggingFaceTB/SmolLM2-360M-Instruct',
  'cpu-md':     'HuggingFaceTB/SmolLM2-1.7B-Instruct',
  'qwen-0.5b':  'onnx-community/Qwen2.5-0.5B-Instruct',
  'qwen-1.5b':  'onnx-community/Qwen2.5-1.5B-Instruct',
};

// esm.sh rewrites all bare specifiers (e.g. 'onnxruntime-web/webgpu') to absolute
// CDN URLs at serve time. jsDelivr's static bundle leaves them as-is, which causes
// "bare specifier not remapped" errors in browsers without an import map.
// Stored in a variable so Vite can't statically analyse and bundle it.
const HF_CDN = 'https://esm.sh/@huggingface/transformers';

// Cache the loaded module so we don't fetch it twice (load + generate both need it).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _hfModule: any = null;
async function getHF() {
  if (!_hfModule) _hfModule = await import(/* @vite-ignore */ HF_CDN);
  return _hfModule;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyPipeline = any;

export class InferenceEngine {
  private mlcEngine: MLCEngine | null = null;
  private hfPipe: AnyPipeline = null;
  private device: 'webgpu' | 'wasm' | 'remote' = 'webgpu';
  private remoteConfig: RemoteConfig | null = null;
  private remoteAbort: AbortController | null = null;
  private busy = false;
  private stopRequested = false;

  async load(
    modelKey: string,
    device: 'webgpu' | 'wasm' | 'remote',
    onProgress: ProgressCallback,
    remote?: RemoteConfig,
  ): Promise<void> {
    if (this.busy) throw new Error('Engine already loading');
    this.busy = true;
    this.device = device;
    try {
      if (device === 'remote') {
        await this._loadRemote(remote!, onProgress);
      } else if (device === 'webgpu') {
        await this._loadWebGPU(modelKey, onProgress);
      } else {
        await this._loadWASM(modelKey, onProgress);
      }
    } finally {
      this.busy = false;
    }
  }

  private async _loadRemote(config: RemoteConfig, onProgress: ProgressCallback) {
    this.remoteConfig = config;
    onProgress(100, 'Ready');
  }

  private async _loadWebGPU(modelKey: string, onProgress: ProgressCallback) {
    const modelId = WEBGPU_MODELS[modelKey] ?? WEBGPU_MODELS['qwen-0.5b'];
    const { CreateMLCEngine } = await import('@mlc-ai/web-llm');
    this.mlcEngine = await CreateMLCEngine(modelId, {
      initProgressCallback: (r: InitProgressReport) => {
        onProgress(Math.round(r.progress * 100), r.text);
      },
    });
    // Warmup to surface shader errors early.
    await this.mlcEngine.chat.completions.create({
      messages: [{ role: 'user', content: 'hi' }],
      max_tokens: 1, stream: false,
    });
  }

  private async _loadWASM(modelKey: string, onProgress: ProgressCallback) {
    onProgress(0, 'Loading inference runtime from CDN…');
    const { pipeline } = await getHF();

    const modelId = WASM_MODELS[modelKey] ?? WASM_MODELS['cpu-sm'];
    onProgress(5, `Loading ${modelId}…`);

    this.hfPipe = await pipeline('text-generation', modelId, {
      device: 'wasm',
      dtype: 'q4',
      progress_callback: (prog: { status: string; progress?: number; file?: string }) => {
        const raw = prog.progress ?? 0;
        const pct = Math.round(raw > 1 ? raw : raw * 100);
        if (prog.status === 'download' || prog.status === 'progress') {
          const fname = prog.file ? prog.file.split('/').pop() : '';
          onProgress(pct, fname ? `Downloading ${fname}` : 'Downloading…');
        } else if (prog.status === 'loading' || prog.status === 'initiate') {
          onProgress(pct || 5, 'Loading model…');
        } else if (prog.status === 'ready' || prog.status === 'done') {
          onProgress(100, 'Ready');
        }
      },
    });
  }

  async *generate(
    systemPrompt: string,
    history: { role: 'user' | 'assistant'; content: string }[],
    userMessage: string,
  ): AsyncGenerator<string> {
    this.stopRequested = false;
    if (this.device === 'remote') {
      yield* this._generateRemote(systemPrompt, history, userMessage);
    } else if (this.device === 'webgpu') {
      yield* this._generateWebGPU(systemPrompt, history, userMessage);
    } else {
      yield* this._generateWASM(systemPrompt, history, userMessage);
    }
  }

  private async *_generateRemote(
    systemPrompt: string,
    history: { role: 'user' | 'assistant'; content: string }[],
    userMessage: string,
  ): AsyncGenerator<string> {
    const { apiUrl, apiKey, model } = this.remoteConfig!;
    this.remoteAbort = new AbortController();

    const response = await fetch(`${apiUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(apiKey ? { 'Authorization': `Bearer ${apiKey}` } : {}),
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: systemPrompt },
          ...history,
          { role: 'user', content: userMessage },
        ],
        stream: true,
        max_tokens: 1024,
        temperature: 0.7,
      }),
      signal: this.remoteAbort.signal,
    });

    if (!response.ok) {
      const body = await response.text().catch(() => response.statusText);
      throw new Error(`Remote API ${response.status}: ${body.slice(0, 120)}`);
    }

    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    try {
      for (;;) {
        if (this.stopRequested) break;
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop()!; // keep incomplete line

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || trimmed === 'data: [DONE]') continue;
          if (!trimmed.startsWith('data: ')) continue;
          try {
            const json = JSON.parse(trimmed.slice(6));
            const delta = json.choices?.[0]?.delta?.content;
            if (delta) yield delta;
          } catch { /* malformed SSE chunk */ }
        }
      }
    } finally {
      reader.cancel().catch(() => {});
      this.remoteAbort = null;
    }
  }

  private async *_generateWebGPU(
    systemPrompt: string,
    history: { role: 'user' | 'assistant'; content: string }[],
    userMessage: string,
  ): AsyncGenerator<string> {
    if (!this.mlcEngine) throw new Error('Engine not loaded');
    const stream = await this.mlcEngine.chat.completions.create({
      messages: [
        { role: 'system', content: systemPrompt },
        ...history,
        { role: 'user', content: userMessage },
      ],
      stream: true, temperature: 0.7, max_tokens: 512,
    });
    for await (const chunk of stream) {
      if (this.stopRequested) break;
      const delta = chunk.choices[0]?.delta?.content;
      if (delta) yield delta;
    }
  }

  private async *_generateWASM(
    systemPrompt: string,
    history: { role: 'user' | 'assistant'; content: string }[],
    userMessage: string,
  ): AsyncGenerator<string> {
    if (!this.hfPipe) throw new Error('Engine not loaded');

    const messages = [
      { role: 'system', content: systemPrompt },
      ...history,
      { role: 'user', content: userMessage },
    ];

    // Bridge TextStreamer callback → AsyncGenerator via micro-queue.
    const queue: (string | null)[] = [];
    let wakeup: (() => void) | null = null;
    const push = (val: string | null) => {
      queue.push(val);
      const w = wakeup; wakeup = null; w?.();
    };

    const { TextStreamer } = await getHF();
    const streamer = new TextStreamer(this.hfPipe.tokenizer, {
      skip_prompt: true,
      skip_special_tokens: true,
      callback_function: (text: string) => {
        if (!this.stopRequested) push(text);
      },
    });

    const genPromise = this.hfPipe(messages, {
      max_new_tokens: 512, temperature: 0.7, do_sample: true, streamer,
    }).then(() => push(null)).catch(() => push(null));

    for (;;) {
      if (queue.length === 0) await new Promise<void>(r => { wakeup = r; });
      const val = queue.shift()!;
      if (val === null || this.stopRequested) break;
      yield val;
    }
    await genPromise;
  }

  interrupt(): void {
    this.stopRequested = true;
    this.mlcEngine?.interruptGenerate();
    this.remoteAbort?.abort();
  }

  destroy(): void {
    this.remoteAbort?.abort();
    this.remoteAbort = null;
    this.remoteConfig = null;
    this.mlcEngine?.unload();
    this.mlcEngine = null;
    this.hfPipe?.dispose?.();
    this.hfPipe = null;
  }
}
