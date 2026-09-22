import { AdapterRegistry, type ProviderAdapter } from './types.js';
import { AnthropicApiLane, ANTHROPIC_DEFAULT_MODEL } from './api/anthropic.js';
import { GoogleApiLane, GOOGLE_DEFAULT_MODEL } from './api/google.js';
import { OpenAIChatLane } from './api/openai-chat.js';
import { CliLane } from './cli/lane.js';
import { claudeSpec, codexSpec, geminiSpec, grokSpec } from './cli/specs.js';

export const OPENAI_BASE_URL = 'https://api.openai.com/v1';
export const OPENAI_DEFAULT_MODEL = 'gpt-5';
export const XAI_BASE_URL = 'https://api.x.ai/v1';
export const XAI_DEFAULT_MODEL = 'grok-4';

export function anthropicAdapter(): ProviderAdapter {
  return {
    id: 'anthropic',
    displayName: 'Anthropic (Claude)',
    defaultModel: ANTHROPIC_DEFAULT_MODEL,
    lanes: { 'api-key': new AnthropicApiLane(), cli: new CliLane(claudeSpec) },
  };
}

export function openaiAdapter(): ProviderAdapter {
  return {
    id: 'openai',
    displayName: 'OpenAI (ChatGPT / Codex)',
    defaultModel: OPENAI_DEFAULT_MODEL,
    lanes: {
      'api-key': new OpenAIChatLane({
        provider: 'openai',
        defaultBaseUrl: OPENAI_BASE_URL,
        defaultModel: OPENAI_DEFAULT_MODEL,
      }),
      cli: new CliLane(codexSpec),
    },
  };
}

export function googleAdapter(): ProviderAdapter {
  return {
    id: 'google',
    displayName: 'Google (Gemini)',
    defaultModel: GOOGLE_DEFAULT_MODEL,
    lanes: { 'api-key': new GoogleApiLane(), cli: new CliLane(geminiSpec) },
  };
}

export function xaiAdapter(): ProviderAdapter {
  return {
    id: 'xai',
    displayName: 'xAI (Grok)',
    defaultModel: XAI_DEFAULT_MODEL,
    lanes: {
      'api-key': new OpenAIChatLane({
        provider: 'xai',
        defaultBaseUrl: XAI_BASE_URL,
        defaultModel: XAI_DEFAULT_MODEL,
      }),
      cli: new CliLane(grokSpec),
    },
  };
}

export function openaiCompatibleAdapter(): ProviderAdapter {
  return {
    id: 'openai-compatible',
    displayName: 'OpenAI-compatible endpoint',
    defaultModel: '',
    lanes: {
      'api-key': new OpenAIChatLane({
        provider: 'openai-compatible',
        defaultBaseUrl: 'http://127.0.0.1:11434/v1',
        defaultModel: '',
      }),
    },
  };
}

/** All first-class providers. Add OAuth lanes with `registry.addLane(provider, lane)`. */
export function createDefaultRegistry(): AdapterRegistry {
  return new AdapterRegistry()
    .register(anthropicAdapter())
    .register(openaiAdapter())
    .register(googleAdapter())
    .register(xaiAdapter())
    .register(openaiCompatibleAdapter());
}

export { AdapterRegistry };
