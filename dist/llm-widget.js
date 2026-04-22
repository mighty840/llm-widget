//#region src/engine.ts
var e = {
	"qwen-1.5b": "Qwen2.5-1.5B-Instruct-q4f32_1-MLC",
	"qwen-1.5b-f16": "Qwen2.5-1.5B-Instruct-q4f16_1-MLC",
	"qwen-0.5b": "Qwen2.5-0.5B-Instruct-q4f32_1-MLC",
	"smollm-1.7b": "SmolLM2-1.7B-Instruct-q4f32_1-MLC"
}, t = class {
	constructor() {
		this.engine = null, this.busy = !1;
	}
	async load(t, n) {
		if (this.busy) throw Error("Engine already loading");
		this.busy = !0;
		try {
			let r = e[t] ?? e["qwen-1.5b"], { CreateMLCEngine: i } = await import("./lib-CDS2ucrV.js");
			this.engine = await i(r, { initProgressCallback: (e) => {
				n(Math.round(e.progress * 100), e.text);
			} }), await this.engine.chat.completions.create({
				messages: [{
					role: "user",
					content: "hi"
				}],
				max_tokens: 1,
				stream: !1
			});
		} catch (e) {
			this.engine = null;
			let t = e instanceof Error ? e.message : String(e);
			throw Error(t.split("\n")[0].slice(0, 200));
		} finally {
			this.busy = !1;
		}
	}
	async *generate(e, t, n) {
		if (!this.engine) throw Error("Engine not loaded");
		let r = await this.engine.chat.completions.create({
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
			let t = e.choices[0]?.delta?.content;
			t && (yield t);
		}
	}
	interrupt() {
		this.engine?.interruptGenerate();
	}
	destroy() {
		this.engine?.unload(), this.engine = null;
	}
}, n = 3500, r = {
	explicit: 800,
	jsonld: 1e3,
	meta: 200,
	microdata: 400,
	semantic: 1200,
	fallback: 300
}, i = [
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
].join(","), a = [
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
], o = new Set(/* @__PURE__ */ "name.description.headline.articleBody.text.abstract.price.priceCurrency.lowPrice.highPrice.availability.sku.brand.question.acceptedAnswer.answer.openingHours.telephone.streetAddress.addressLocality.addressCountry.author.datePublished.dateModified.keywords.articleSection.hasMenuItem.itemOffered.servesCuisine.ratingValue.reviewCount.bestRating.softwareVersion.operatingSystem.featureList".split("."));
function s() {
	let e = [];
	return document.querySelectorAll("[data-llm-context]").forEach((t) => {
		let n = t.innerText.replace(/\s+/g, " ").trim();
		n && e.push(n);
	}), e.join("\n\n").slice(0, r.explicit);
}
function c(e, t = 0) {
	if (t > 4 || typeof e != "object" || !e) return typeof e == "string" || typeof e == "number" ? String(e) : "";
	if (Array.isArray(e)) return e.map((e) => c(e, t)).filter(Boolean).join(", ");
	let n = e;
	return n["@graph"] ? c(n["@graph"], t) : Object.entries(n).filter(([e]) => o.has(e)).map(([e, n]) => {
		let r = c(n, t + 1);
		return r ? `${e}: ${r}` : "";
	}).filter(Boolean).join("\n");
}
function l() {
	let e = [];
	return document.querySelectorAll("script[type=\"application/ld+json\"]").forEach((t) => {
		try {
			let n = c(JSON.parse(t.textContent ?? ""));
			n.length > 20 && e.push(n);
		} catch {}
	}), e.join("\n\n").slice(0, r.jsonld);
}
function u() {
	let e = [], t = document.title.trim();
	t && e.push(`Page: ${t}`);
	let n = document.querySelector("meta[name=\"description\"]")?.content?.trim();
	n && e.push(`Description: ${n}`);
	let i = document.querySelector("meta[property=\"og:title\"]")?.content?.trim(), a = document.querySelector("meta[property=\"og:description\"]")?.content?.trim(), o = document.querySelector("meta[property=\"og:type\"]")?.content?.trim(), s = document.querySelector("meta[property=\"og:site_name\"]")?.content?.trim();
	s && e.push(`Site: ${s}`), o && e.push(`Type: ${o}`), i && i !== t && e.push(`OG title: ${i}`), a && a !== n && e.push(`OG description: ${a}`);
	let c = document.querySelector("meta[property=\"article:published_time\"]")?.content?.trim();
	return c && e.push(`Published: ${c.slice(0, 10)}`), e.join("\n").slice(0, r.meta);
}
function d() {
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
	}), t.join("\n").slice(0, r.microdata);
}
function f(e) {
	let t = [];
	function n(e) {
		if (e.nodeType === Node.TEXT_NODE) {
			let n = (e.textContent ?? "").replace(/\s+/g, " ");
			n.trim() && t.push(n);
			return;
		}
		if (e.nodeType !== Node.ELEMENT_NODE) return;
		let r = e;
		if (!r.matches?.(i) && r.getAttribute("aria-hidden") !== "true") for (let e of r.childNodes) n(e);
	}
	return n(e), t.join("").replace(/\s+/g, " ").trim();
}
function p() {
	let e = /* @__PURE__ */ new Set(), t = [], n = 0;
	for (let i of a) {
		if (n >= r.semantic) break;
		document.querySelectorAll(i).forEach((i) => {
			if (e.has(i) || n >= r.semantic || [...e].some((e) => e.contains(i))) return;
			e.add(i);
			let a = f(i).slice(0, 600);
			a.length > 40 && (t.push(a), n += a.length);
		});
	}
	return t.join("\n\n").slice(0, r.semantic);
}
function m() {
	return f(document.body).slice(0, r.fallback);
}
function h() {
	return g().context;
}
function g() {
	let e = [
		{
			name: "explicit",
			text: s()
		},
		{
			name: "jsonld",
			text: l()
		},
		{
			name: "meta",
			text: u()
		},
		{
			name: "microdata",
			text: d()
		},
		{
			name: "semantic",
			text: p()
		}
	].filter((e) => e.text.length > 0);
	if (e.every((e) => e.name !== "semantic" && e.name !== "explicit")) {
		let t = m();
		t && e.push({
			name: "fallback",
			text: t
		});
	}
	let t = e.map((e) => e.text).join("\n\n").slice(0, n);
	return {
		context: t,
		sources: e.map((e) => e.name),
		chars: t.length
	};
}
//#endregion
//#region src/widget.ts
function _(e) {
	return e.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#x27;");
}
var v = /renoir|vega\s*\d|radeon\s*graphics|uhd\s*graphics|iris|xe\s*graphics|mali|adreno|apple\s*m\d|integrated/i, y = /rtx\s*[234]\d{3}|rx\s*[67][89]\d{2}|rx\s*7\d{3}|a[456789]\d{3}|m[12]\s*(ultra|max|pro)/i;
async function b() {
	let e = navigator;
	if (!e.gpu) return {
		ok: !1,
		reason: "WebGPU API not available. Use Chrome 113+.",
		gpuName: "Unknown",
		vramMB: 0,
		tier: "low",
		recommendedModel: "qwen-0.5b",
		tierLabel: "",
		tierColor: ""
	};
	let t = await e.gpu.requestAdapter();
	if (!t) return {
		ok: !1,
		reason: "No GPU adapter found. Try enabling chrome://flags/#enable-unsafe-webgpu or updating GPU drivers.",
		gpuName: "Unknown",
		vramMB: 0,
		tier: "low",
		recommendedModel: "qwen-0.5b",
		tierLabel: "",
		tierColor: ""
	};
	let n = "Unknown GPU";
	try {
		let e = await t.requestAdapterInfo?.();
		n = e?.description || e?.device || n;
	} catch {}
	let r = t.limits.maxBufferSize ?? 0, i = Math.round(r / (1024 * 1024)), a = e.deviceMemory ?? 4, o = v.test(n), s = y.test(n), c;
	c = o ? Math.min(i || 1024, Math.round(a * 256)) : i || (s ? 6144 : 2048);
	let l, u, d, f, p;
	return /iP(hone|ad|od)/.test(navigator.userAgent) ? {
		ok: !0,
		gpuName: n || "Apple GPU",
		vramMB: c,
		tier: "mid",
		recommendedModel: "qwen-0.5b",
		tierLabel: "Apple Silicon",
		tierColor: "#00e5ff",
		warning: "iOS WebGPU has a ~256 MB buffer limit. Using the 0.5B model to stay within it — larger models crash the tab."
	} : (o || c < 1500 ? (l = "low", u = "qwen-0.5b", d = "Integrated / Low VRAM", f = "#f59e0b", p = o ? "Integrated GPU detected. Running the lightweight 0.5B model to stay within your shared VRAM budget." : "Low VRAM detected. Using the 0.5B model for reliability.") : !s && c < 4096 ? (l = "mid", u = "qwen-1.5b", d = "Mid-range GPU", f = "#8b5cf6") : (l = "high", u = "qwen-1.5b", d = "Capable GPU", f = "#00e5ff"), {
		ok: !0,
		gpuName: n,
		vramMB: c,
		tier: l,
		recommendedModel: u,
		tierLabel: d,
		tierColor: f,
		warning: p
	});
}
var x = "\n  :host { all: initial; font-family: ui-monospace, 'Cascadia Code', monospace; }\n\n  .btn-trigger {\n    position: fixed; bottom: 24px; left: 24px; z-index: 2147483647;\n    width: 52px; height: 52px; border-radius: 50%;\n    background: linear-gradient(135deg, #00e5ff1a, #8b5cf61a);\n    border: 1px solid #00e5ff66;\n    backdrop-filter: blur(12px);\n    cursor: pointer; font-size: 20px;\n    display: flex; align-items: center; justify-content: center;\n    transition: transform 0.2s ease;\n    box-shadow: 0 0 20px rgba(0,229,255,0.15);\n    color: #e2e8f0;\n  }\n  .btn-trigger:hover { transform: scale(1.1); }\n\n  .panel {\n    position: fixed; bottom: 90px; left: 24px; z-index: 2147483646;\n    width: 360px; max-width: calc(100vw - 32px);\n    height: min(480px, calc(100dvh - 110px));\n    background: #0a0e1a;\n    border: 1px solid #1e2d4a;\n    border-radius: 16px;\n    display: flex; flex-direction: column;\n    overflow: hidden;\n    box-shadow: 0 0 50px rgba(139,92,246,0.12);\n    animation: slideUp 0.2s ease;\n  }\n  @keyframes slideUp {\n    from { opacity: 0; transform: translateY(12px); }\n    to   { opacity: 1; transform: translateY(0); }\n  }\n\n  /* Mobile responsive */\n  @media (max-width: 420px) {\n    .panel { width: calc(100vw - 16px); left: 8px; bottom: 80px; }\n    .btn-trigger { left: 12px; }\n  }\n\n  .header {\n    display: flex; align-items: center; gap: 10px;\n    padding: 12px 16px;\n    background: linear-gradient(90deg, #00e5ff0d, #8b5cf60d);\n    border-bottom: 1px solid #1e2d4a;\n    flex-shrink: 0;\n  }\n  .dot {\n    width: 7px; height: 7px; border-radius: 50%;\n    background: #475569; flex-shrink: 0;\n    transition: background 0.3s, box-shadow 0.3s;\n  }\n  .dot.live { background: #00e5ff; box-shadow: 0 0 8px #00e5ff; }\n  .title { font-size: 12px; font-weight: 900; color: #e2e8f0; letter-spacing: 0.1em; }\n  .subtitle { font-size: 11px; color: #475569; margin-left: auto; }\n\n  .body {\n    flex: 1; overflow-y: auto; padding: 14px;\n    display: flex; flex-direction: column; gap: 10px;\n    scrollbar-width: thin; scrollbar-color: #8b5cf6 #0f1629;\n  }\n\n  .center {\n    display: flex; flex-direction: column;\n    align-items: center; justify-content: center;\n    height: 100%; gap: 16px; text-align: center; padding: 0 20px;\n  }\n  .emoji { font-size: 40px; line-height: 1; }\n  .desc { font-size: 12px; color: #64748b; line-height: 1.6; }\n  .hint { font-size: 11px; color: #334155; }\n\n  .btn-load {\n    padding: 9px 28px; border-radius: 8px;\n    background: #00e5ff; color: #050810;\n    font-size: 13px; font-weight: 700; font-family: inherit;\n    border: none; cursor: pointer;\n    transition: opacity 0.2s;\n  }\n  .btn-load:hover { opacity: 0.88; }\n\n  .progress-bar-track {\n    width: 100%; height: 5px; background: #1e2d4a;\n    border-radius: 99px; overflow: hidden;\n  }\n  .progress-bar-fill {\n    height: 100%; width: 0%;\n    background: linear-gradient(90deg, #00e5ff, #8b5cf6);\n    border-radius: 99px; transition: width 0.4s ease;\n  }\n  .progress-label {\n    display: flex; justify-content: space-between;\n    margin-top: 6px; font-size: 11px;\n  }\n  .progress-text { color: #475569; }\n  .progress-pct  { color: #00e5ff; font-weight: 700; }\n\n  .msg { display: flex; }\n  .msg.user { justify-content: flex-end; }\n  .bubble {\n    max-width: 86%; font-size: 13px; line-height: 1.5;\n    border-radius: 12px; padding: 8px 12px;\n  }\n  .bubble.user {\n    background: #00e5ff15; border: 1px solid #00e5ff33; color: #e2e8f0;\n  }\n  .bubble.assistant {\n    background: #0f1629; border: 1px solid #1e2d4a; color: #94a3b8;\n  }\n\n  /* Typing dots animation */\n  @keyframes blink { 0%,80%,100%{opacity:0} 40%{opacity:1} }\n  .typing span { display:inline-block; width:5px; height:5px; border-radius:50%; background:#64748b; animation: blink 1.4s infinite both; }\n  .typing span:nth-child(2) { animation-delay:.2s }\n  .typing span:nth-child(3) { animation-delay:.4s }\n\n  .input-bar {\n    display: flex; gap: 8px; flex-shrink: 0;\n    padding: 10px 12px; border-top: 1px solid #1e2d4a;\n  }\n  .input {\n    flex: 1; background: #0f1629; border: 1px solid #1e2d4a;\n    border-radius: 8px; color: #e2e8f0; font-size: 13px;\n    font-family: inherit; padding: 8px 12px; outline: none;\n    transition: border-color 0.2s;\n  }\n  .input:focus { border-color: #8b5cf666; }\n  .input::placeholder { color: #334155; }\n  .btn-send {\n    padding: 8px 14px; border-radius: 8px; border: none;\n    font-size: 14px; font-family: inherit; font-weight: 700;\n    cursor: pointer; transition: background 0.2s, color 0.2s;\n    background: #00e5ff; color: #050810;\n  }\n  .btn-send:disabled { background: #1e2d4a; color: #475569; cursor: default; }\n\n  /* Stop button */\n  .btn-stop { padding:8px 12px; border-radius:8px; border:1px solid #ef444455; background:#ef444411; color:#f87171; font-size:12px; font-family:inherit; cursor:pointer; }\n  .btn-stop:hover { background:#ef444422; }\n", S = class extends HTMLElement {
	get aiName() {
		return this.getAttribute("name") ?? "AI Assistant";
	}
	get modelKey() {
		return this.getAttribute("model") ?? "qwen-1.5b";
	}
	get greeting() {
		return this.getAttribute("greeting") ?? "Hi! I'm an AI assistant running entirely in your browser. Ask me anything about this page.";
	}
	constructor() {
		super(), this.engine = new t(), this.status = "idle", this.errorMsg = "", this.messages = [], this.generating = !1, this.loading = !1, this.panelVisible = !1, this.rendered = !1, this.lastProgressAt = 0, this.hangTimer = null, this.gpuProbe = null, this.context = "", this.lastIndexedUrl = "", this.onUrlChange = () => {
			location.href !== this.lastIndexedUrl && this.reindex();
		}, this.shadow = this.attachShadow({ mode: "open" });
	}
	connectedCallback() {
		this.rendered || (this.rendered = !0, this.render(), this.watchUrlChanges());
	}
	disconnectedCallback() {
		this.stopGeneration(), this.engine.destroy(), window.removeEventListener("popstate", this.onUrlChange);
	}
	watchUrlChanges() {
		window.addEventListener("popstate", this.onUrlChange);
		let e = document.querySelector("title");
		e && new MutationObserver(this.onUrlChange).observe(e, { childList: !0 });
	}
	reindex() {
		this.context = h(), this.lastIndexedUrl = location.href;
	}
	render() {
		this.shadow.innerHTML = `
      <style>${x}</style>
      <button class="btn-trigger" id="trigger" aria-label="Open AI chat">◈</button>
    `, this.shadow.getElementById("trigger").addEventListener("click", () => this.togglePanel());
	}
	renderPanel() {
		return `
      <div class="panel" id="panel" role="dialog" aria-label="AI Chat" aria-modal="true">
        <div class="header">
          <span class="dot ${this.status === "ready" ? "live" : ""}"></span>
          <span class="title">${_(this.aiName.toUpperCase())}</span>
          <span class="subtitle">${_(this.statusLabel())}</span>
        </div>
        <div class="body" id="body" aria-live="polite">${this.renderBody()}</div>
        ${this.status === "ready" ? `
        <div class="input-bar">
          <input class="input" id="input" placeholder="Ask something..." autocomplete="off" ${this.generating ? "disabled" : ""} />
          ${this.generating ? "<button class=\"btn-stop\" id=\"stop\">&#9632; Stop</button>" : "<button class=\"btn-send\" id=\"send\">&#8593;</button>"}
        </div>` : ""}
      </div>
    `;
	}
	renderBody() {
		switch (this.status) {
			case "idle": {
				let e = this.gpuProbe;
				return `
        <div class="center">
          <span class="emoji">&#129504;</span>
          <p class="desc" style="margin-bottom:4px">${e?.ok ? `<span style="color:${_(e.tierColor)};font-weight:700">${_(e.tierLabel)}</span>
             &nbsp;·&nbsp; <span style="color:#64748b">${_(e.gpuName)}</span>` : "<span style=\"color:#475569\">Detecting GPU…</span>"}</p>
          <p class="desc" style="color:#475569;font-size:11px;margin-bottom:8px">${e?.ok ? `Model: <strong style="color:#e2e8f0">${_(e.recommendedModel)}</strong>` : "Model: auto-selected based on your GPU"} &middot; ${e?.recommendedModel === "qwen-0.5b" ? "~400 MB · fast on integrated GPUs" : e?.recommendedModel === "qwen-1.5b" ? "~1.5 GB · best quality for mid-range+" : "~400 MB · cached after first load"}</p>
          ${e?.warning ? `<p class="hint" style="color:#f59e0b;margin-top:-4px">${_(e.warning)}</p>` : ""}
          <button class="btn-load" id="load">Load AI &rarr;</button>
          <p class="hint">Runs entirely in your browser &middot; no server &middot; cached after first load</p>
        </div>`;
			}
			case "loading": return "\n        <div class=\"center\">\n          <p id=\"phase-title\" style=\"font-size:13px;font-weight:700;color:#00e5ff\">Downloading model weights</p>\n          <div style=\"width:100%\">\n            <div class=\"progress-bar-track\">\n              <div class=\"progress-bar-fill\" id=\"bar\"></div>\n            </div>\n            <div class=\"progress-label\">\n              <span class=\"progress-text\" id=\"prog-text\"></span>\n              <span class=\"progress-pct\" id=\"prog-pct\">0%</span>\n            </div>\n          </div>\n          <p id=\"phase-hint\" class=\"hint\">Cached to your browser after this</p>\n        </div>";
			case "unsupported": return "\n        <div class=\"center\">\n          <span class=\"emoji\">&#9888;</span>\n          <p class=\"desc\">WebGPU is not available in this browser.</p>\n          <p class=\"hint\">Try Chrome 113+ on a desktop machine.</p>\n        </div>";
			case "error": return `
        <div class="center">
          <span class="emoji">&#10005;</span>
          <p class="desc" style="color:#f87171;margin-bottom:4px">Failed to load model.</p>
          <p class="hint" style="color:#64748b;font-size:11px;line-height:1.5;margin-bottom:8px">${_(this.errorMsg)}</p>
          ${this.errorMsg.includes("adapter") || this.errorMsg.includes("GPU") || this.errorMsg.includes("shader") ? "\n          <p class=\"hint\" style=\"margin-bottom:8px\">On Chrome/Linux: chrome://flags/#enable-unsafe-webgpu &rarr; Enable</p>" : ""}
          <button class="btn-load" id="retry">Try again</button>
        </div>`;
			case "ready": return "";
		}
	}
	statusLabel() {
		return this.status === "ready" ? `${_(this.gpuProbe?.recommendedModel ?? this.modelKey)} · WebGPU` : this.status === "loading" ? "loading..." : "offline";
	}
	appendMessageToDOM(e, t) {
		let n = this.shadow.getElementById("body");
		if (!n) return;
		let r = document.createElement("div");
		r.className = `msg ${e.role}`;
		let i = document.createElement("div");
		i.className = `bubble ${e.role}`, i.id = `msg-${t}`, i.setAttribute("role", e.role === "assistant" ? "status" : "none"), e.content ? i.textContent = e.content : i.innerHTML = "<div class=\"typing\"><span></span><span></span><span></span></div>", r.appendChild(i), n.appendChild(r), n.scrollTop = n.scrollHeight;
	}
	patchLastMessage(e) {
		this.messages[this.messages.length - 1].content += e;
		let t = this.messages.length - 1, n = this.shadow.getElementById(`msg-${t}`);
		if (n) {
			n.textContent = this.messages[t].content;
			let e = this.shadow.getElementById("body");
			e && (e.scrollTop = e.scrollHeight);
		}
	}
	bindPanelEvents() {
		this.shadow.getElementById("load")?.addEventListener("click", () => this.loadModel()), this.shadow.getElementById("retry")?.addEventListener("click", () => {
			this.status = "idle", this.errorMsg = "", this.rebuildPanel();
		}), this.shadow.getElementById("input")?.addEventListener("keydown", (e) => {
			e.key === "Enter" && !e.shiftKey && (e.preventDefault(), this.send());
		}), this.shadow.getElementById("send")?.addEventListener("click", () => void this.send()), this.shadow.getElementById("stop")?.addEventListener("click", () => this.stopGeneration()), this.shadow.getElementById("panel")?.addEventListener("keydown", (e) => {
			e.key === "Escape" && this.togglePanel();
		});
	}
	togglePanel() {
		this.panelVisible = !this.panelVisible;
		let e = this.shadow.getElementById("trigger");
		e.textContent = this.panelVisible ? "✕" : "◈";
		let t = this.shadow.getElementById("panel");
		if (this.panelVisible) {
			if (!t) {
				let e = document.createElement("div");
				e.innerHTML = this.renderPanel();
				let t = e.firstElementChild;
				this.shadow.appendChild(t), this.status === "ready" && this.messages.forEach((e, t) => this.appendMessageToDOM(e, t)), this.bindPanelEvents(), setTimeout(() => this.shadow.getElementById("input")?.focus(), 50), !this.gpuProbe && this.status === "idle" && b().then((e) => {
					this.gpuProbe = e, this.status === "idle" && this.repaintBody();
				});
			}
		} else this.generating && this.stopGeneration(), t?.remove();
	}
	updateProgress(e, t) {
		this.lastProgressAt = Date.now(), this.hangTimer && clearTimeout(this.hangTimer), this.hangTimer = setTimeout(() => this.showHangWarning(), 45e3);
		let n = this.shadow.getElementById("bar"), r = this.shadow.getElementById("prog-pct"), i = this.shadow.getElementById("prog-text"), a = this.shadow.getElementById("phase-title"), o = this.shadow.getElementById("phase-hint");
		if (n && (n.style.width = `${e}%`), r && (r.textContent = `${e}%`), i && (i.textContent = t.slice(0, 48)), t.includes("shader") || t.includes("Loading GPU")) {
			let e = t.match(/\[(\d+)\/(\d+)\]/), n = e ? ` (${e[1]}/${e[2]})` : "";
			a && (a.textContent = `Compiling GPU shaders${n}`), o && (o.textContent = "First load only — cached after this. AMD GPUs may take 3–5 min here.");
		} else t.includes("Fetch") || t.includes("fetch") || t.includes("param") ? (a && (a.textContent = "Downloading model weights"), o && (o.textContent = "Cached to your browser after this")) : (t.includes("Init") || t.includes("init") || t.includes("Loading")) && (a && (a.textContent = "Initializing model"), o && (o.textContent = "Almost ready..."));
	}
	showHangWarning() {
		let e = this.shadow.getElementById("phase-hint"), t = this.shadow.getElementById("phase-title");
		e && (e.innerHTML = "\n        <span style=\"color:#f59e0b\">⚠ This is taking a while — not a bug.</span><br>\n        Your GPU is compiling WebGPU shaders for the first time. On integrated or low-end GPUs this can take 15–40 minutes.<br><br>\n        <strong style=\"color:#00e5ff\">Good news:</strong> Chrome caches the compiled shaders. Every load after this will be instant. You only pay this cost once.\n      ", e.style.fontSize = "11px", e.style.lineHeight = "1.6", e.style.color = "#64748b"), t && (t.style.color = "#f59e0b");
	}
	async loadModel() {
		if (!this.loading) {
			this.loading = !0;
			try {
				let e = this.gpuProbe ?? await b();
				if (this.gpuProbe = e, !e.ok) {
					this.errorMsg = _(e.reason ?? "WebGPU not available."), this.status = "error", this.repaintBody();
					return;
				}
				let t = this.getAttribute("model"), n = e.tier === "high" && t ? t : e.recommendedModel;
				this.status = "loading", this.repaintBody();
				let [,] = await Promise.all([this.engine.load(n, (e, t) => this.updateProgress(e, t)), Promise.resolve().then(() => this.reindex())]);
				this.status = "ready", this.messages = [{
					role: "assistant",
					content: this.greeting
				}], this.rebuildPanel();
			} catch (e) {
				console.error("[llm-widget]", e);
				let t = e instanceof Error ? e.message.slice(0, 160) : String(e).slice(0, 160);
				this.errorMsg = _(t), this.status = "error", this.repaintBody();
			} finally {
				this.loading = !1, this.hangTimer && (clearTimeout(this.hangTimer), this.hangTimer = null);
			}
		}
	}
	repaintBody() {
		let e = this.shadow.getElementById("body");
		e && (e.innerHTML = this.renderBody(), this.status === "ready" && (this.messages.forEach((e, t) => this.appendMessageToDOM(e, t)), e.scrollTop = e.scrollHeight), this.bindPanelEvents());
	}
	rebuildPanel() {
		let e = this.shadow.getElementById("panel");
		e && (e.innerHTML = `
      <div class="header">
        <span class="dot ${this.status === "ready" ? "live" : ""}"></span>
        <span class="title">${_(this.aiName.toUpperCase())}</span>
        <span class="subtitle">${_(this.statusLabel())}</span>
      </div>
      <div class="body" id="body" aria-live="polite">${this.renderBody()}</div>
      ${this.status === "ready" ? "\n      <div class=\"input-bar\">\n        <input class=\"input\" id=\"input\" placeholder=\"Ask something...\" autocomplete=\"off\" />\n        <button class=\"btn-send\" id=\"send\">&#8593;</button>\n      </div>" : ""}
    `, this.status === "ready" && this.messages.forEach((e, t) => this.appendMessageToDOM(e, t)), this.bindPanelEvents());
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
		let n = this.context || h();
		e && (e.value = ""), this.generating = !0;
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
		let o = `You are a helpful assistant on a website.
Answer questions concisely based on the page context below.
If something is not covered, say so honestly.

Page context:
${n}`;
		try {
			for await (let e of this.engine.generate(o, a, t)) this.patchLastMessage(e);
		} catch (e) {
			let t = e instanceof Error ? e.message.slice(0, 140) : String(e).slice(0, 140);
			console.error("[llm-widget] generation error:", e), this.patchLastMessage(`⚠ ${t || "generation failed"}`);
		} finally {
			this.generating = !1;
			let e = this.shadow.querySelector(".input-bar");
			if (e) {
				let t = this.shadow.getElementById("stop");
				t && t.remove();
				let n = this.shadow.getElementById("send");
				n || (n = document.createElement("button"), n.className = "btn-send", n.id = "send", n.textContent = "↑", n.addEventListener("click", () => void this.send()), e.appendChild(n)), n.disabled = !1, n.textContent = "↑";
			}
			let t = this.shadow.getElementById("input");
			t && (t.disabled = !1, t.focus());
		}
	}
};
//#endregion
//#region src/index.ts
customElements.get("llm-chat") || customElements.define("llm-chat", S);
function C() {
	let e = document.currentScript ?? document.querySelector("script[src*=\"llm-widget\"]");
	if (e?.dataset.auto === "false" || document.querySelector("llm-chat")) return;
	let t = document.createElement("llm-chat");
	e?.dataset.name && t.setAttribute("name", e.dataset.name), e?.dataset.model && t.setAttribute("model", e.dataset.model), e?.dataset.greeting && t.setAttribute("greeting", e.dataset.greeting), document.body.appendChild(t);
}
document.readyState === "loading" ? document.addEventListener("DOMContentLoaded", C) : C();
//#endregion
