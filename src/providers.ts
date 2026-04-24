import type { Env } from './types';
import { anthropicProvider } from './providers/anthropic';
import { geminiProvider } from './providers/gemini';
import type { LLMProvider, ProviderId, Tier, VariantConfig } from './providers/base';

export type { LLMProvider, ProviderId, Tier, VariantConfig, ParsedEvent } from './providers/base';
export { streamWithRetry } from './providers/base';

// Baseline config is 'claude' — used by the main pipeline and referenced by KV
// metadata writes. Add a new entry here to introduce a new A/B variant; no
// other code change is required for same-provider-end-to-end configs, and a
// mixed config (e.g. Gemini classify + Claude compose) works the same way.
export const VARIANT_CONFIGS: Record<string, VariantConfig> = {
  claude: {
    id: 'claude',
    label: 'Claude Sonnet 4.6',
    classify: 'anthropic',
    compose: 'anthropic',
  },
  gemini: {
    id: 'gemini',
    label: 'Gemini 2.5 Pro',
    classify: 'gemini',
    compose: 'gemini',
  },
};

export const BASELINE_CONFIG: VariantConfig = VARIANT_CONFIGS.claude;

const PROVIDERS: Partial<Record<ProviderId, LLMProvider>> = {
  anthropic: anthropicProvider,
  gemini: geminiProvider,
};

export function getProvider(id: ProviderId): LLMProvider {
  const provider = PROVIDERS[id];
  if (!provider) {
    throw new Error(`[Providers] No provider registered for id "${id}"`);
  }
  return provider;
}

export function resolveProvider(config: VariantConfig, tier: Tier): LLMProvider {
  const id = tier === 'cheap' ? config.classify : config.compose;
  return getProvider(id);
}

// Enabled variant configs = configs listed in env.AB_VARIANT_CONFIGS whose
// required provider API keys are set. Baseline 'claude' is never returned —
// variants are additions to the baseline, not replacements.
export function listEnabledVariantConfigs(env: Env): VariantConfig[] {
  if (env.ENABLE_AB_VARIANTS !== 'true') return [];
  const allowlist = (env.AB_VARIANT_CONFIGS ?? '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
  const configs: VariantConfig[] = [];
  for (const id of allowlist) {
    if (id === 'claude') continue;
    const config = VARIANT_CONFIGS[id];
    if (!config) {
      console.log(`[Variants] Unknown config id "${id}" in AB_VARIANT_CONFIGS — skipping`);
      continue;
    }
    if (!providerKeysPresent(env, config)) {
      console.log(`[Variants] Skipping "${id}" — required API key(s) not set`);
      continue;
    }
    configs.push(config);
  }
  return configs;
}

function providerKeysPresent(env: Env, config: VariantConfig): boolean {
  const providerIds = new Set<ProviderId>([config.classify, config.compose]);
  for (const id of providerIds) {
    if (id === 'anthropic' && !env.CLAUDE_PLATFORM_API) return false;
    if (id === 'gemini' && !env.GEMINI_API_KEY) return false;
  }
  return true;
}
