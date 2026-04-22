import type { MLCEngine, InitProgressReport } from '@mlc-ai/web-llm';

export type ProgressCallback = (pct: number, text: string) => void;

const MODELS: Record<string, string> = {
  'qwen-1.5b':     'Qwen2.5-1.5B-Instruct-q4f32_1-MLC',
  'qwen-1.5b-f16': 'Qwen2.5-1.5B-Instruct-q4f16_1-MLC',
  'qwen-0.5b':     'Qwen2.5-0.5B-Instruct-q4f32_1-MLC',
  'qwen-0.5b-f16': 'Qwen2.5-0.5B-Instruct-q4f16_1-MLC',
  'smollm-1.7b':   'SmolLM2-1.7B-Instruct-q4f32_1-MLC',
};

export class InferenceEngine {
  private engine: MLCEngine | null = null;
  private busy = false;

  async load(modelKey: string, onProgress: ProgressCallback): Promise<void> {
    if (this.busy) throw new Error('Engine already loading');
    this.busy = true;
    try {
      const modelId = MODELS[modelKey] ?? MODELS['qwen-1.5b'];
      const { CreateMLCEngine } = await import('@mlc-ai/web-llm');
      this.engine = await CreateMLCEngine(modelId, {
        initProgressCallback: (r: InitProgressReport) => {
          onProgress(Math.round(r.progress * 100), r.text);
        },
      });
      // Warmup: compile shaders now so errors surface on load, not first message
      await this.engine.chat.completions.create({
        messages: [{ role: 'user', content: 'hi' }],
        max_tokens: 1,
        stream: false,
      });
    } catch (e) {
      this.engine = null;
      const msg = e instanceof Error ? e.message : String(e);
      throw new Error(msg.split('\n')[0].slice(0, 200));
    } finally {
      this.busy = false;
    }
  }

  async *generate(
    systemPrompt: string,
    history: { role: 'user' | 'assistant'; content: string }[],
    userMessage: string,
  ): AsyncGenerator<string> {
    if (!this.engine) throw new Error('Engine not loaded');
    const stream = await this.engine.chat.completions.create({
      messages: [
        { role: 'system', content: systemPrompt },
        ...history,
        { role: 'user', content: userMessage },
      ],
      stream: true,
      temperature: 0.7,
      max_tokens: 512,
    });
    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta?.content;
      if (delta) yield delta;
    }
  }

  interrupt(): void {
    this.engine?.interruptGenerate();
  }

  destroy(): void {
    this.engine?.unload();
    this.engine = null;
  }
}
