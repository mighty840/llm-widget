import { LLMChatWidget } from './widget';

if (!customElements.get('llm-chat')) {
  customElements.define('llm-chat', LLMChatWidget);
}

// Auto-inject if the script tag has data-auto="true" (default)
// or if no <llm-chat> element exists yet
function autoInject() {
  const script = document.currentScript as HTMLScriptElement | null
    ?? document.querySelector('script[src*="llm-widget"]') as HTMLScriptElement | null;

  if (script?.dataset.auto === 'false') return;
  if (document.querySelector('llm-chat')) return;

  const el = document.createElement('llm-chat') as LLMChatWidget;

  if (script?.dataset.name)     el.setAttribute('name', script.dataset.name);
  if (script?.dataset.model)    el.setAttribute('model', script.dataset.model);
  if (script?.dataset.greeting) el.setAttribute('greeting', script.dataset.greeting);

  document.body.appendChild(el);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', autoInject);
} else {
  autoInject();
}
