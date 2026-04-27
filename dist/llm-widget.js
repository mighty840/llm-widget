//#region src/engine.ts
var e = {
	"qwen-1.5b": "Qwen2.5-1.5B-Instruct-q4f32_1-MLC",
	"qwen-0.5b": "Qwen2.5-0.5B-Instruct-q4f32_1-MLC",
	"smollm-1.7b": "SmolLM2-1.7B-Instruct-q4f32_1-MLC"
}, t = {
	"cpu-sm": "HuggingFaceTB/SmolLM2-360M-Instruct",
	"cpu-md": "HuggingFaceTB/SmolLM2-1.7B-Instruct",
	"qwen-0.5b": "onnx-community/Qwen2.5-0.5B-Instruct",
	"qwen-1.5b": "onnx-community/Qwen2.5-1.5B-Instruct"
}, n = "https://esm.sh/@huggingface/transformers", r = null;
async function i() {
	return r || (r = await import(
		/* @vite-ignore */
		n
)), r;
}
var a = class {
	constructor() {
		this.mlcEngine = null, this.hfPipe = null, this.device = "webgpu", this.remoteConfig = null, this.remoteAbort = null, this.busy = !1, this.stopRequested = !1;
	}
	async load(e, t, n, r) {
		if (this.busy) throw Error("Engine already loading");
		this.busy = !0, this.device = t;
		try {
			t === "remote" ? await this._loadRemote(r, n) : t === "webgpu" ? await this._loadWebGPU(e, n) : await this._loadWASM(e, n);
		} finally {
			this.busy = !1;
		}
	}
	async _loadRemote(e, t) {
		this.remoteConfig = e, t(100, "Ready");
	}
	async _loadWebGPU(t, n) {
		let r = e[t] ?? e["qwen-0.5b"], { CreateMLCEngine: i } = await import("./lib-CDS2ucrV.js");
		this.mlcEngine = await i(r, { initProgressCallback: (e) => {
			n(Math.round(e.progress * 100), e.text);
		} }), await this.mlcEngine.chat.completions.create({
			messages: [{
				role: "user",
				content: "hi"
			}],
			max_tokens: 1,
			stream: !1
		});
	}
	async _loadWASM(e, n) {
		n(0, "Loading inference runtime from CDN…");
		let { pipeline: r } = await i(), a = t[e] ?? t["cpu-sm"];
		n(5, `Loading ${a}…`), this.hfPipe = await r("text-generation", a, {
			device: "wasm",
			dtype: "q4",
			progress_callback: (e) => {
				let t = e.progress ?? 0, r = Math.round(t > 1 ? t : t * 100);
				if (e.status === "download" || e.status === "progress") {
					let t = e.file ? e.file.split("/").pop() : "";
					n(r, t ? `Downloading ${t}` : "Downloading…");
				} else e.status === "loading" || e.status === "initiate" ? n(r || 5, "Loading model…") : (e.status === "ready" || e.status === "done") && n(100, "Ready");
			}
		});
	}
	async *generate(e, t, n) {
		this.stopRequested = !1, this.device === "remote" ? yield* this._generateRemote(e, t, n) : this.device === "webgpu" ? yield* this._generateWebGPU(e, t, n) : yield* this._generateWASM(e, t, n);
	}
	async *_generateRemote(e, t, n) {
		let { apiUrl: r, apiKey: i, model: a } = this.remoteConfig;
		this.remoteAbort = new AbortController();
		let o = await fetch(`${r.replace(/\/$/, "")}/chat/completions`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				...i ? { Authorization: `Bearer ${i}` } : {}
			},
			body: JSON.stringify({
				model: a,
				messages: [
					{
						role: "system",
						content: e
					},
					...t,
					{
						role: "user",
						content: n
					}
				],
				stream: !0,
				max_tokens: 1024,
				temperature: .7
			}),
			signal: this.remoteAbort.signal
		});
		if (!o.ok) {
			let e = await o.text().catch(() => o.statusText);
			throw Error(`Remote API ${o.status}: ${e.slice(0, 120)}`);
		}
		let s = o.body.getReader(), c = new TextDecoder(), l = "";
		try {
			for (; !this.stopRequested;) {
				let { done: e, value: t } = await s.read();
				if (e) break;
				l += c.decode(t, { stream: !0 });
				let n = l.split("\n");
				l = n.pop();
				for (let e of n) {
					let t = e.trim();
					if (!(!t || t === "data: [DONE]") && t.startsWith("data: ")) try {
						let e = JSON.parse(t.slice(6)).choices?.[0]?.delta?.content;
						e && (yield e);
					} catch {}
				}
			}
		} finally {
			s.cancel().catch(() => {}), this.remoteAbort = null;
		}
	}
	async *_generateWebGPU(e, t, n) {
		if (!this.mlcEngine) throw Error("Engine not loaded");
		let r = await this.mlcEngine.chat.completions.create({
			messages: [
				{
					role: "system",
					content: e
				},
				...t,
				{
					role: "user",
					content: n
				}
			],
			stream: !0,
			temperature: .7,
			max_tokens: 512
		});
		for await (let e of r) {
			if (this.stopRequested) break;
			let t = e.choices[0]?.delta?.content;
			t && (yield t);
		}
	}
	async *_generateWASM(e, t, n) {
		if (!this.hfPipe) throw Error("Engine not loaded");
		let r = [
			{
				role: "system",
				content: e
			},
			...t,
			{
				role: "user",
				content: n
			}
		], a = [], o = null, s = (e) => {
			a.push(e);
			let t = o;
			o = null, t?.();
		}, { TextStreamer: c } = await i(), l = new c(this.hfPipe.tokenizer, {
			skip_prompt: !0,
			skip_special_tokens: !0,
			callback_function: (e) => {
				this.stopRequested || s(e);
			}
		}), u = this.hfPipe(r, {
			max_new_tokens: 512,
			temperature: .7,
			do_sample: !0,
			streamer: l
		}).then(() => s(null)).catch(() => s(null));
		for (;;) {
			a.length === 0 && await new Promise((e) => {
				o = e;
			});
			let e = a.shift();
			if (e === null || this.stopRequested) break;
			yield e;
		}
		await u;
	}
	interrupt() {
		this.stopRequested = !0, this.mlcEngine?.interruptGenerate(), this.remoteAbort?.abort();
	}
	destroy() {
		this.remoteAbort?.abort(), this.remoteAbort = null, this.remoteConfig = null, this.mlcEngine?.unload(), this.mlcEngine = null, this.hfPipe?.dispose?.(), this.hfPipe = null;
	}
}, o = 6e3, s = {
	explicit: 1e3,
	jsonld: 1e3,
	meta: 200,
	microdata: 400,
	semantic: 4e3,
	fallback: 400
}, c = [
	"nav",
	"header",
	"footer",
	"[id*=\"cookie\"]",
	"[class*=\"cookie\"]",
	"[class*=\"consent\"]",
	"[class*=\"gdpr\"]",
	"[class*=\"banner\"]",
	"[id*=\"banner\"]",
	"[class*=\"advertisement\"]",
	"[class*=\"ad-container\"]",
	"[id*=\"ad-slot\"]",
	"[aria-hidden=\"true\"]",
	"script",
	"style",
	"noscript",
	"iframe",
	"[class*=\"related\"]",
	"[class*=\"recommended\"]",
	"[class*=\"newsletter\"]",
	"[class*=\"social-share\"]",
	"[class*=\"comment\"]",
	"aside"
].join(","), l = [
	"[role=\"main\"]",
	"main",
	"article",
	"#content",
	"#main",
	"#page-content",
	"#features",
	"#pricing",
	"#about",
	"#hero",
	"#product",
	".vp-doc",
	".content",
	".article-body",
	".markdown-body",
	".prose",
	".documentation",
	".docs-content",
	".product-details",
	".product-description",
	"#product-detail",
	"section[id]"
], u = new Set(/* @__PURE__ */ "name.description.headline.articleBody.text.abstract.price.priceCurrency.lowPrice.highPrice.availability.sku.brand.question.acceptedAnswer.answer.openingHours.telephone.streetAddress.addressLocality.addressCountry.author.datePublished.dateModified.keywords.articleSection.hasMenuItem.itemOffered.servesCuisine.ratingValue.reviewCount.bestRating.softwareVersion.operatingSystem.featureList".split("."));
function d() {
	let e = [];
	return document.querySelectorAll("[data-llm-context]").forEach((t) => {
		let n = t.innerText.replace(/\s+/g, " ").trim();
		n && e.push(n);
	}), e.join("\n\n").slice(0, s.explicit);
}
function f(e, t = 0) {
	if (t > 4 || typeof e != "object" || !e) return typeof e == "string" || typeof e == "number" ? String(e) : "";
	if (Array.isArray(e)) return e.map((e) => f(e, t)).filter(Boolean).join(", ");
	let n = e;
	return n["@graph"] ? f(n["@graph"], t) : Object.entries(n).filter(([e]) => u.has(e)).map(([e, n]) => {
		let r = f(n, t + 1);
		return r ? `${e}: ${r}` : "";
	}).filter(Boolean).join("\n");
}
function p() {
	let e = [];
	return document.querySelectorAll("script[type=\"application/ld+json\"]").forEach((t) => {
		try {
			let n = f(JSON.parse(t.textContent ?? ""));
			n.length > 20 && e.push(n);
		} catch {}
	}), e.join("\n\n").slice(0, s.jsonld);
}
function m() {
	let e = [], t = document.title.trim();
	t && e.push(`Page: ${t}`);
	let n = document.querySelector("meta[name=\"description\"]")?.content?.trim();
	n && e.push(`Description: ${n}`);
	let r = document.querySelector("meta[property=\"og:title\"]")?.content?.trim(), i = document.querySelector("meta[property=\"og:description\"]")?.content?.trim(), a = document.querySelector("meta[property=\"og:type\"]")?.content?.trim(), o = document.querySelector("meta[property=\"og:site_name\"]")?.content?.trim();
	o && e.push(`Site: ${o}`), a && e.push(`Type: ${a}`), r && r !== t && e.push(`OG title: ${r}`), i && i !== n && e.push(`OG description: ${i}`);
	let c = document.querySelector("meta[property=\"article:published_time\"]")?.content?.trim();
	return c && e.push(`Published: ${c.slice(0, 10)}`), e.join("\n").slice(0, s.meta);
}
function h() {
	let e = new Set([
		"name",
		"description",
		"price",
		"priceCurrency",
		"availability",
		"sku",
		"brand",
		"ratingValue",
		"reviewCount",
		"streetAddress",
		"addressLocality",
		"telephone",
		"openingHours"
	]), t = [], n = /* @__PURE__ */ new Set();
	return document.querySelectorAll("[itemprop]").forEach((r) => {
		let i = r.getAttribute("itemprop") ?? "";
		if (!e.has(i)) return;
		let a = (r.getAttribute("content") || r.getAttribute("datetime") || r.innerText).replace(/\s+/g, " ").trim();
		if (!a || a.length < 1) return;
		let o = `${i}: ${a}`;
		n.has(o) || (n.add(o), t.push(o));
	}), t.join("\n").slice(0, s.microdata);
}
function g(e) {
	let t = [];
	function n(e) {
		if (e.nodeType === Node.TEXT_NODE) {
			let n = (e.textContent ?? "").replace(/\s+/g, " ");
			n.trim() && t.push(n);
			return;
		}
		if (e.nodeType !== Node.ELEMENT_NODE) return;
		let r = e;
		if (!r.matches?.(c) && r.getAttribute("aria-hidden") !== "true") for (let e of r.childNodes) n(e);
	}
	return n(e), t.join("").replace(/\s+/g, " ").trim();
}
function _() {
	let e = /* @__PURE__ */ new Set(), t = [], n = 0;
	for (let r of l) {
		if (n >= s.semantic) break;
		document.querySelectorAll(r).forEach((r) => {
			if (e.has(r) || n >= s.semantic || [...e].some((e) => e.contains(r))) return;
			e.add(r);
			let i = g(r);
			i.length > 40 && (t.push(i), n += i.length);
		});
	}
	return t.join("\n\n").slice(0, s.semantic);
}
function v() {
	return g(document.body).slice(0, s.fallback);
}
function y() {
	return b().context;
}
function b() {
	let e = [
		{
			name: "explicit",
			text: d()
		},
		{
			name: "jsonld",
			text: p()
		},
		{
			name: "meta",
			text: m()
		},
		{
			name: "microdata",
			text: h()
		},
		{
			name: "semantic",
			text: _()
		}
	].filter((e) => e.text.length > 0);
	if (e.every((e) => e.name !== "semantic" && e.name !== "explicit")) {
		let t = v();
		t && e.push({
			name: "fallback",
			text: t
		});
	}
	let t = e.map((e) => e.text).join("\n\n").slice(0, o);
	return {
		context: t,
		sources: e.map((e) => e.name),
		chars: t.length
	};
}
//#endregion
//#region src/widget.ts
var x = "0.2.6", S = "a7a6c9d";
console.info(`%cIdjet v${x}${` · ${S}`} — in-browser LLM`, "color:#00e5ff;font-weight:bold");
function C(e) {
	return e.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#x27;");
}
function w(e) {
	let t = e.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
	return t = t.replace(/```[\w]*\n?([\s\S]*?)```/g, "<pre><code>$1</code></pre>"), t = t.replace(/`([^`\n]+)`/g, "<code>$1</code>"), t = t.replace(/\*\*\*([^*\n]+)\*\*\*/g, "<strong><em>$1</em></strong>"), t = t.replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>"), t = t.replace(/\*([^*\n]+)\*/g, "<em>$1</em>"), t = t.replace(/^#{1,6} (.+)$/gm, "<strong>$1</strong>"), t = t.replace(/^[*\-+] (.+)$/gm, "• $1"), t = t.replace(/^\d+\. (.+)$/gm, (e, t) => `• ${t}`), t = t.replace(/\n/g, "<br>"), t;
}
var T = /renoir|vega\s*\d|radeon\s*graphics|uhd\s*graphics|iris|xe\s*graphics|mali|adreno|integrated/i, E = /apple\s*m\d|apple\s*gpu/i, D = /rtx\s*[234]\d{3}|rx\s*[67][89]\d{2}|rx\s*7\d{3}|a[456789]\d{3}|m[12]\s*(ultra|max|pro)/i;
async function O() {
	let e = navigator, t = (e, t) => ({
		ok: !0,
		device: "wasm",
		gpuName: "CPU",
		vramMB: 0,
		tier: "cpu",
		recommendedModel: "cpu-sm",
		tierLabel: e,
		tierColor: "#64748b",
		warning: t
	});
	if (!e.gpu) return t("CPU Mode", "WebGPU not available — CPU inference via WebAssembly (~1 tok/sec, works everywhere).");
	let n = await e.gpu.requestAdapter().catch(() => null);
	if (!n) return t("CPU Mode", "No GPU adapter found — falling back to CPU inference.");
	let r = "Unknown GPU";
	try {
		let e = await n.requestAdapterInfo?.();
		r = e?.description || e?.device || r;
	} catch {}
	let i = Math.round((n.limits.maxBufferSize ?? 0) / (1024 * 1024)), a = e.deviceMemory ?? 4, o = T.test(r), s = E.test(r), c = D.test(r) || s, l = o ? Math.min(i || 1024, Math.round(a * 256)) : i || (c ? 6144 : 2048);
	return /iP(hone|ad|od)/.test(navigator.userAgent) ? t("iOS CPU Mode", "iOS WebGPU has a 256 MB per-buffer cap — using CPU inference instead.") : o || l < 1500 ? {
		ok: !0,
		device: "webgpu",
		gpuName: r,
		vramMB: l,
		tier: "low",
		recommendedModel: "qwen-0.5b",
		tierLabel: "Integrated / Low VRAM",
		tierColor: "#f59e0b",
		warning: o ? "Integrated GPU — using 0.5B model to stay within shared VRAM." : "Low VRAM — using 0.5B model."
	} : !c && l < 4096 ? {
		ok: !0,
		device: "webgpu",
		gpuName: r,
		vramMB: l,
		tier: "mid",
		recommendedModel: "qwen-1.5b",
		tierLabel: "Mid-range GPU",
		tierColor: "#8b5cf6"
	} : {
		ok: !0,
		device: "webgpu",
		gpuName: r,
		vramMB: l,
		tier: "high",
		recommendedModel: "qwen-1.5b",
		tierLabel: s ? "Apple Silicon" : "Capable GPU",
		tierColor: "#00e5ff"
	};
}
function k(e) {
	let t = !e.includes("top"), n = !e.includes("right"), r = t ? "bottom" : "top", i = n ? "left" : "right";
	return `
  :host { all: initial; font-family: ui-monospace, 'Cascadia Code', monospace; }

  .btn-trigger {
    position: fixed; ${r}: 24px; ${i}: 24px; z-index: 2147483647;
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
    position: fixed; ${t ? "bottom: 90px; top: auto;" : "top: 90px; bottom: auto;"} ${i}: 24px; z-index: 2147483646;
    width: 360px; max-width: calc(100vw - 32px);
    height: min(480px, calc(100dvh - 110px));
    background: #0a0e1a; border: 1px solid #1e2d4a; border-radius: 16px;
    display: flex; flex-direction: column; overflow: hidden;
    box-shadow: 0 0 50px rgba(139,92,246,0.12);
    animation: slideIn 0.2s ease;
  }
  @keyframes slideIn {
    from { opacity: 0; transform: ${t ? "translateY(12px)" : "translateY(-12px)"}; }
    to   { opacity: 1; transform: translateY(0); }
  }

  @media (max-width: 420px) {
    .panel { width: calc(100vw - 16px); ${i}: 8px; ${t ? "bottom: 80px;" : "top: 80px;"} }
    .btn-trigger { ${i}: 12px; }
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
var A = class extends HTMLElement {
	get aiName() {
		return this.getAttribute("name") ?? "AI Assistant";
	}
	get modelKey() {
		return this.getAttribute("model") ?? "qwen-1.5b";
	}
	get position() {
		return this.getAttribute("data-position") ?? "bottom-left";
	}
	get extraSystemPrompt() {
		return this.getAttribute("system-prompt") ?? "";
	}
	get greeting() {
		return this.getAttribute("greeting") ?? "Hi! I'm an AI assistant running entirely in your browser. Ask me anything about this page.";
	}
	get apiUrl() {
		return this.getAttribute("data-api-url") ?? "";
	}
	get apiKey() {
		return this.getAttribute("data-api-key") ?? "";
	}
	get apiModel() {
		return this.getAttribute("data-api-model") ?? "gpt-4o-mini";
	}
	get storageKey() {
		return `idjet:${location.hostname}:messages`;
	}
	constructor() {
		super(), this.engine = new a(), this.status = "idle", this.errorMsg = "", this.messages = [], this.generating = !1, this.loading = !1, this.panelVisible = !1, this.rendered = !1, this.hangTimer = null, this.gpuProbe = null, this.context = "", this.lastIndexedUrl = "", this.onUrlChange = () => {
			location.href !== this.lastIndexedUrl && this.reindex();
		}, this.shadow = this.attachShadow({ mode: "open" });
	}
	connectedCallback() {
		this.rendered || (this.rendered = !0, this.render(), this.watchUrlChanges());
	}
	disconnectedCallback() {
		this.stopGeneration(), this.engine.destroy(), window.removeEventListener("popstate", this.onUrlChange);
	}
	emit(e, t) {
		this.dispatchEvent(new CustomEvent(`idjet:${e}`, {
			bubbles: !0,
			composed: !0,
			detail: t
		}));
	}
	watchUrlChanges() {
		window.addEventListener("popstate", this.onUrlChange);
		let e = document.querySelector("title");
		e && new MutationObserver(this.onUrlChange).observe(e, { childList: !0 });
	}
	reindex() {
		this.context = y(), this.lastIndexedUrl = location.href;
	}
	saveHistory() {
		try {
			localStorage.setItem(this.storageKey, JSON.stringify(this.messages));
		} catch {}
	}
	loadHistory() {
		try {
			let e = localStorage.getItem(this.storageKey);
			return e ? JSON.parse(e) : null;
		} catch {
			return null;
		}
	}
	render() {
		this.shadow.innerHTML = `<style>${k(this.position)}</style>
      <button class="btn-trigger" id="trigger" aria-label="Open AI chat">◈</button>`, this.shadow.getElementById("trigger").addEventListener("click", () => this.togglePanel());
	}
	headerHTML() {
		let e = this.status === "ready" ? "<button class=\"btn-icon\" id=\"clear\" title=\"Clear chat\">&#128465;</button>" : "";
		return `
      <div class="header">
        <span class="dot ${this.status === "ready" ? "live" : ""}"></span>
        <span class="title">${C(this.aiName.toUpperCase())}</span>
        <span class="subtitle">${C(this.statusLabel())}</span>
        ${e}
      </div>`;
	}
	renderPanel() {
		return `
      <div class="panel" id="panel" role="dialog" aria-label="AI Chat" aria-modal="true">
        ${this.headerHTML()}
        <div class="body" id="body" aria-live="polite">${this.renderBody()}</div>
        ${this.status === "ready" ? `
        <div class="input-bar">
          <input class="input" id="input" placeholder="Ask something..." autocomplete="off" ${this.generating ? "disabled" : ""} />
          ${this.generating ? "<button class=\"btn-stop\" id=\"stop\">&#9632; Stop</button>" : "<button class=\"btn-send\" id=\"send\">&#8593;</button>"}
        </div>` : ""}
      </div>`;
	}
	renderBody() {
		switch (this.status) {
			case "idle": {
				if (this.apiUrl) return `<div class="center">
            <span class="emoji">&#127760;</span>
            <p class="desc">Server-side inference &mdash; instant responses, no download</p>
            <button class="btn-load" id="load">Connect &rarr;</button>
            <p class="hint">Model: <strong style="color:#e2e8f0">${C(this.apiModel)}</strong></p>
            <p class="hint" style="margin-top:8px;color:#1e3a4a;font-size:10px;letter-spacing:0.08em">IDJET v${x}${` &middot; ${S}`}</p>
          </div>`;
				let e = this.gpuProbe;
				return `<div class="center">
          <span class="emoji">&#129504;</span>
          <p class="desc" style="margin-bottom:4px">${e ? `<span style="color:${C(e.tierColor)};font-weight:700">${C(e.tierLabel)}</span> &nbsp;·&nbsp; <span style="color:#64748b">${C(e.gpuName)}</span>` : "<span style=\"color:#475569\">Detecting…</span>"}</p>
          <p class="desc" style="color:#475569;font-size:11px;margin-bottom:8px">${e ? `Model: <strong style="color:#e2e8f0">${C(e.recommendedModel)}</strong> · ${{
					"cpu-sm": "~200 MB · CPU · works everywhere",
					"qwen-0.5b": "~400 MB · WebGPU",
					"qwen-1.5b": "~900 MB · WebGPU · best quality"
				}[e.recommendedModel] ?? "auto"}` : "Model: auto"}</p>
          ${e?.warning ? `<p class="hint" style="color:#f59e0b;margin-top:-4px">${C(e.warning)}</p>` : ""}
          <button class="btn-load" id="load">Load AI &rarr;</button>
          <p class="hint">Runs in your browser &middot; no server &middot; cached after first load</p>
          <p class="hint" style="margin-top:8px;color:#1e3a4a;font-size:10px;letter-spacing:0.08em">IDJET v${x}${` &middot; ${S}`}</p>
        </div>`;
			}
			case "loading": return "\n        <div class=\"center\">\n          <p id=\"phase-title\" style=\"font-size:13px;font-weight:700;color:#00e5ff\">Downloading model weights</p>\n          <div style=\"width:100%\">\n            <div class=\"progress-bar-track\"><div class=\"progress-bar-fill\" id=\"bar\"></div></div>\n            <div class=\"progress-label\">\n              <span class=\"progress-text\" id=\"prog-text\"></span>\n              <span class=\"progress-pct\" id=\"prog-pct\">0%</span>\n            </div>\n          </div>\n          <p id=\"phase-hint\" class=\"hint\">Cached to your browser after this</p>\n          <button class=\"btn-cancel\" id=\"cancel-load\">Cancel</button>\n        </div>";
			case "error": return `
        <div class="center">
          <span class="emoji">&#10005;</span>
          <p class="desc" style="color:#f87171;margin-bottom:4px">Failed to load model.</p>
          <p class="hint" style="color:#64748b;font-size:11px;line-height:1.5;margin-bottom:8px">${C(this.errorMsg)}</p>
          <button class="btn-load" id="retry">Try again</button>
        </div>`;
			case "ready": return "";
		}
	}
	statusLabel() {
		if (this.status === "ready" && this.apiUrl) return `${C(this.apiModel)} · Server`;
		let e = this.gpuProbe;
		return this.status === "ready" ? `${C(e?.recommendedModel ?? this.modelKey)} · ${e?.device === "wasm" ? "CPU" : "WebGPU"}` : this.status === "loading" ? "loading..." : "offline";
	}
	appendMessageToDOM(e, t) {
		let n = this.shadow.getElementById("body");
		if (!n) return;
		let r = document.createElement("div");
		r.className = `msg ${e.role}`, r.dataset.idx = String(t);
		let i = document.createElement("div");
		i.className = `bubble ${e.role}`, i.id = `msg-${t}`, i.setAttribute("role", e.role === "assistant" ? "status" : "none"), e.content ? e.role === "assistant" ? i.innerHTML = w(e.content) : i.textContent = e.content : i.innerHTML = "<div class=\"typing\"><span></span><span></span><span></span></div>", r.appendChild(i), e.role === "assistant" && e.content && r.appendChild(this.makeCopyBtn(t)), n.appendChild(r), n.scrollTop = n.scrollHeight;
	}
	makeCopyBtn(e) {
		let t = document.createElement("div");
		t.className = "msg-actions";
		let n = document.createElement("button");
		return n.className = "btn-copy", n.textContent = "copy", n.addEventListener("click", () => {
			let t = this.messages[e]?.content ?? "";
			navigator.clipboard?.writeText(t).then(() => {
				n.textContent = "copied!", setTimeout(() => {
					n.textContent = "copy";
				}, 1500);
			}).catch(() => {
				n.textContent = "failed";
			});
		}), t.appendChild(n), t;
	}
	patchLastMessage(e) {
		let t = this.messages.length - 1;
		this.messages[t].content += e;
		let n = this.shadow.getElementById(`msg-${t}`);
		if (n) {
			n.textContent = this.messages[t].content;
			let e = this.shadow.getElementById("body");
			e && (e.scrollTop = e.scrollHeight);
		}
	}
	finalizeLastMessage() {
		let e = this.messages.length - 1, t = this.messages[e];
		if (t?.role !== "assistant") return;
		let n = this.shadow.getElementById(`msg-${e}`);
		if (n) {
			n.innerHTML = w(t.content);
			let r = n.parentElement;
			r && !r.querySelector(".msg-actions") && r.appendChild(this.makeCopyBtn(e));
		}
	}
	bindPanelEvents() {
		this.shadow.getElementById("load")?.addEventListener("click", () => void this.loadModel()), this.shadow.getElementById("retry")?.addEventListener("click", () => {
			this.status = "idle", this.errorMsg = "", this.rebuildPanel();
		}), this.shadow.getElementById("cancel-load")?.addEventListener("click", () => {
			this.engine.destroy(), this.engine = new a(), this.loading = !1, this.hangTimer && (clearTimeout(this.hangTimer), this.hangTimer = null), this.status = "idle", this.repaintBody();
		}), this.shadow.getElementById("clear")?.addEventListener("click", () => this.clearChat()), this.shadow.getElementById("input")?.addEventListener("keydown", (e) => {
			e.key === "Enter" && !e.shiftKey && (e.preventDefault(), this.send());
		}), this.shadow.getElementById("send")?.addEventListener("click", () => void this.send()), this.shadow.getElementById("stop")?.addEventListener("click", () => this.stopGeneration()), this.shadow.getElementById("panel")?.addEventListener("keydown", (e) => {
			e.key === "Escape" && this.togglePanel();
		});
	}
	clearChat() {
		this.messages = [{
			role: "assistant",
			content: this.greeting
		}];
		try {
			localStorage.removeItem(this.storageKey);
		} catch {}
		let e = this.shadow.getElementById("body");
		e && (e.innerHTML = "", this.messages.forEach((e, t) => this.appendMessageToDOM(e, t))), this.emit("clear");
	}
	togglePanel() {
		this.panelVisible = !this.panelVisible;
		let e = this.shadow.getElementById("trigger");
		e.textContent = this.panelVisible ? "✕" : "◈";
		let t = this.shadow.getElementById("panel");
		if (this.panelVisible) {
			if (this.emit("open"), !t) {
				let e = document.createElement("div");
				e.innerHTML = this.renderPanel(), this.shadow.appendChild(e.firstElementChild), this.status === "ready" && this.messages.forEach((e, t) => this.appendMessageToDOM(e, t)), this.bindPanelEvents(), setTimeout(() => this.shadow.getElementById("input")?.focus(), 50), !this.gpuProbe && this.status === "idle" && O().then((e) => {
					this.gpuProbe = e, this.status === "idle" && this.repaintBody();
				});
			}
		} else this.emit("close"), this.generating && this.stopGeneration(), t?.remove();
	}
	updateProgress(e, t) {
		this.hangTimer && clearTimeout(this.hangTimer), this.hangTimer = setTimeout(() => this.showHangWarning(), 45e3);
		let n = this.shadow.getElementById("bar"), r = this.shadow.getElementById("prog-pct"), i = this.shadow.getElementById("prog-text"), a = this.shadow.getElementById("phase-title"), o = this.shadow.getElementById("phase-hint");
		if (n && (n.style.width = `${e}%`), r && (r.textContent = `${e}%`), i && (i.textContent = t.slice(0, 52)), t.includes("shader") || t.includes("Loading GPU")) {
			let e = t.match(/\[(\d+)\/(\d+)\]/);
			a && (a.textContent = `Compiling GPU shaders${e ? ` (${e[1]}/${e[2]})` : ""}`), o && (o.textContent = "First load only — cached after this. AMD GPUs may take 3–5 min.");
		} else t.includes("Fetch") || t.includes("fetch") || t.includes("param") || t.includes("Downloading") ? (a && (a.textContent = "Downloading model weights"), o && (o.textContent = "Cached to your browser after this")) : t.includes("Loading inference runtime") ? (a && (a.textContent = "Loading inference runtime"), o && (o.textContent = "One-time fetch from CDN — browser-cached after this")) : (t.includes("Init") || t.includes("init") || t.includes("Loading")) && (a && (a.textContent = "Initializing model"), o && (o.textContent = "Almost ready..."));
	}
	showHangWarning() {
		let e = this.shadow.getElementById("phase-hint"), t = this.shadow.getElementById("phase-title");
		e && (e.innerHTML = "<span style=\"color:#f59e0b\">⚠ Taking a while — not a bug.</span><br>\n        First-time WebGPU shader compilation on slow/integrated GPUs can take 15–40 min.<br><br>\n        <strong style=\"color:#00e5ff\">Chrome caches compiled shaders</strong> — every load after this is instant.", e.style.cssText = "font-size:11px;line-height:1.6;color:#64748b"), t && (t.style.color = "#f59e0b");
	}
	async loadModel() {
		if (!this.loading) {
			this.loading = !0;
			try {
				if (this.apiUrl) {
					let e = {
						apiUrl: this.apiUrl,
						model: this.apiModel,
						...this.apiKey ? { apiKey: this.apiKey } : {}
					};
					await this.engine.load(this.apiModel, "remote", () => {}, e), this.status = "ready";
					let t = this.loadHistory();
					this.messages = t && t.length > 1 ? t : [{
						role: "assistant",
						content: this.greeting
					}], this.rebuildPanel(), this.emit("ready", {
						device: "remote",
						model: this.apiModel
					});
					return;
				}
				let e = this.gpuProbe ?? await O();
				this.gpuProbe = e;
				let t = this.getAttribute("model"), n = e.tier === "high" && t ? t : e.recommendedModel;
				this.status = "loading", this.repaintBody();
				let [,] = await Promise.all([this._loadWithRetry(n, e), Promise.resolve().then(() => this.reindex())]);
				this.status = "ready";
				let r = this.loadHistory();
				this.messages = r && r.length > 1 ? r : [{
					role: "assistant",
					content: this.greeting
				}], this.rebuildPanel(), this.emit("ready", {
					device: this.gpuProbe.device,
					model: n
				});
			} catch (e) {
				console.error("[idjet]", e), this.errorMsg = C(e instanceof Error ? e.message.slice(0, 160) : String(e).slice(0, 160)), this.status = "error", this.repaintBody();
			} finally {
				this.loading = !1, this.hangTimer && (clearTimeout(this.hangTimer), this.hangTimer = null);
			}
		}
	}
	async _loadWithRetry(e, t) {
		let n = (e, t) => this.updateProgress(e, t);
		if (t.device !== "webgpu") return this.engine.load(e, "wasm", n);
		try {
			return await this.engine.load(e, "webgpu", n);
		} catch (e) {
			console.warn("[idjet] WebGPU failed, retrying on CPU:", e);
			let r = this.shadow.getElementById("phase-title");
			return r && (r.textContent = "GPU failed — retrying on CPU…"), this.engine.destroy(), this.engine = new a(), this.gpuProbe = {
				...t,
				device: "wasm",
				tier: "cpu",
				recommendedModel: "cpu-sm",
				tierLabel: "CPU Mode (GPU fallback)",
				tierColor: "#64748b"
			}, this.engine.load("cpu-sm", "wasm", n);
		}
	}
	repaintBody() {
		let e = this.shadow.getElementById("body");
		e && (e.innerHTML = this.renderBody(), this.status === "ready" && (this.messages.forEach((e, t) => this.appendMessageToDOM(e, t)), e.scrollTop = e.scrollHeight), this.bindPanelEvents());
	}
	rebuildPanel() {
		let e = this.shadow.getElementById("panel");
		e && (e.innerHTML = `
      ${this.headerHTML()}
      <div class="body" id="body" aria-live="polite">${this.renderBody()}</div>
      ${this.status === "ready" ? "\n      <div class=\"input-bar\">\n        <input class=\"input\" id=\"input\" placeholder=\"Ask something...\" autocomplete=\"off\" />\n        <button class=\"btn-send\" id=\"send\">&#8593;</button>\n      </div>" : ""}`, this.status === "ready" && this.messages.forEach((e, t) => this.appendMessageToDOM(e, t)), this.bindPanelEvents());
	}
	stopGeneration() {
		if (!this.generating) return;
		this.engine.interrupt(), this.generating = !1;
		let e = this.shadow.getElementById("send"), t = this.shadow.getElementById("stop");
		e && (e.disabled = !1, e.textContent = "↑"), t?.remove();
	}
	async send() {
		let e = this.shadow.getElementById("input"), t = e?.value.trim();
		if (!t || this.generating) return;
		let n = this.context || y();
		e && (e.value = ""), this.generating = !0, this.emit("message", {
			role: "user",
			content: t
		});
		let r = this.shadow.getElementById("send");
		r && (r.disabled = !0, r.textContent = "·");
		let i = r?.parentElement;
		if (i && !this.shadow.getElementById("stop")) {
			let e = document.createElement("button");
			e.className = "btn-stop", e.id = "stop", e.textContent = "■ Stop", e.addEventListener("click", () => this.stopGeneration()), r ? i.replaceChild(e, r) : i.appendChild(e);
		}
		e && (e.disabled = !0);
		let a = this.messages.slice(1);
		this.messages.push({
			role: "user",
			content: t
		}), this.appendMessageToDOM(this.messages[this.messages.length - 1], this.messages.length - 1), this.messages.push({
			role: "assistant",
			content: ""
		}), this.appendMessageToDOM(this.messages[this.messages.length - 1], this.messages.length - 1);
		let o = this.gpuProbe?.device === "wasm", s = [
			"You are a web page assistant. Answer ONLY using the provided page context.",
			"Do NOT use outside knowledge. If the answer is not in the context, say exactly: \"I don't see that on this page.\"",
			this.extraSystemPrompt,
			n ? `\nPage context:\n${n}` : "\n(No page context available.)"
		].filter(Boolean).join("\n"), c = o && n ? `Page context:\n${n}\n\nQuestion: ${t}\n\nAnswer based ONLY on the page context above.` : t;
		try {
			for await (let e of this.engine.generate(s, a, c)) this.patchLastMessage(e);
		} catch (e) {
			let t = e instanceof Error ? e.message.slice(0, 140) : String(e).slice(0, 140);
			console.error("[idjet] generation error:", e), this.patchLastMessage(`⚠ ${t || "generation failed"}`);
		} finally {
			this.generating = !1, this.finalizeLastMessage(), this.saveHistory(), this.emit("response", { content: this.messages[this.messages.length - 1].content });
			let e = this.shadow.querySelector(".input-bar");
			if (e) {
				this.shadow.getElementById("stop")?.remove();
				let t = this.shadow.getElementById("send");
				t || (t = document.createElement("button"), t.className = "btn-send", t.id = "send", t.addEventListener("click", () => void this.send()), e.appendChild(t)), t.disabled = !1, t.textContent = "↑";
			}
			let t = this.shadow.getElementById("input");
			t && (t.disabled = !1, t.focus());
		}
	}
};
//#endregion
//#region src/index.ts
customElements.get("llm-chat") || customElements.define("llm-chat", A);
function j() {
	let e = document.currentScript ?? document.querySelector("script[src*=\"llm-widget\"]");
	if (e?.dataset.auto === "false" || document.querySelector("llm-chat")) return;
	let t = document.createElement("llm-chat");
	e?.dataset.name && t.setAttribute("name", e.dataset.name), e?.dataset.model && t.setAttribute("model", e.dataset.model), e?.dataset.greeting && t.setAttribute("greeting", e.dataset.greeting), document.body.appendChild(t);
}
document.readyState === "loading" ? document.addEventListener("DOMContentLoaded", j) : j();
//#endregion
