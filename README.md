# llm-widget

Drop-in browser AI chat widget — runs a local LLM entirely in the visitor's browser via WebGPU, no server required.

## CDN

```html
<script src="https://cdn.jsdelivr.net/gh/mighty840/llm-widget@latest/dist/llm-widget.iife.js"></script>
```

## Quick start

Add one script tag to any page:

```html
<script
  src="https://cdn.jsdelivr.net/gh/mighty840/llm-widget@latest/dist/llm-widget.iife.js"
  data-name="My Assistant"
  data-model="qwen-1.5b"
  data-greeting="Hi! Ask me anything about this page."
></script>
```

The widget auto-injects itself. No framework, no bundler, no API key.

## Attributes

| Attribute      | Default                                        | Description                                   |
|----------------|------------------------------------------------|-----------------------------------------------|
| `name`         | `AI Assistant`                                 | Display name shown in the panel header        |
| `model`        | `qwen-1.5b`                                    | Model key (see table below)                   |
| `greeting`     | _"Hi! I'm an AI assistant..."_                 | First message shown when the model is ready   |
| `data-auto`    | `true`                                         | Set to `false` to disable auto-injection      |

## Models

| Key             | Size    | Quantisation | Notes                              |
|-----------------|---------|--------------|------------------------------------|
| `qwen-1.5b`     | ~1 GB   | q4f32        | Default. AMD/Linux compatible.     |
| `qwen-1.5b-f16` | ~1 GB   | q4f16        | Faster on Nvidia/Apple Silicon.    |
| `qwen-0.5b`     | ~400 MB | q4f32        | Smallest; lower quality.           |
| `smollm-1.7b`   | ~1 GB   | q4f32        | SmolLM2, good instruction-follow.  |

Model weights are downloaded once and cached in the browser's Cache Storage.

## Browser requirements

- Chrome 113+ (or any Chromium-based browser with WebGPU enabled)
- A discrete or integrated GPU with Vulkan/Metal/D3D12 support

### Linux note

WebGPU may be disabled by default. Enable it at:

```
chrome://flags/#enable-unsafe-webgpu
```

Set to **Enabled**, relaunch Chrome.

## Local development

```bash
npm install
npm run dev
```

Opens a dev server at `http://localhost:5173` with the demo page.

## Build

```bash
npm run build
```

Outputs:
- `dist/llm-widget.iife.js` — self-contained IIFE for CDN/script-tag use
- `dist/llm-widget.js` — ES module for bundlers

## Release

Tag a semver version and push. CI builds the dist and attaches it to a GitHub Release automatically:

```bash
git tag v0.x.x
git push --tags
```

jsDelivr serves the latest release automatically via the `@latest` CDN URL.
