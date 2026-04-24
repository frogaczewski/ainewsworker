import type { Env } from './types';
import { anthropicProvider } from './providers/anthropic';

export const ECONOMIST_STYLE_PREFIX = `Editorial illustration in the visual language of The Economist magazine: flat areas of desaturated color, bold silhouettes, conceptual montage, clean graphic composition, slightly satirical undertone, restrained palette (muted reds, deep blues, warm cream background), no text, no lettering, no logos, no brand marks, no faces of identifiable real people, no photographic realism. Square 1:1 composition.`;

interface VisualBrief {
  subjects: string[];
  composition: string;
  mood: string;
}

function buildBriefPrompt(emailBriefing: string): string {
  return `You are preparing a visual brief for a single editorial illustration that will appear at the top of today's daily news digest email.

Read the digest below and identify the 2 to 3 most visually striking stories. Return ONLY a JSON object with this exact shape (no prose, no code fences, no explanation):

{"subjects":["concrete visual subject for story 1","subject 2","subject 3 (optional)"],"composition":"one short sentence describing how the subjects should be arranged","mood":"one short phrase for the overall tone"}

Rules for "subjects":
- Concrete visual nouns, not abstract ideas. Instead of "tension in markets" write "a cracked stock ticker". Instead of "AI progress" write "a glowing circuit-board brain".
- 2 or 3 subjects only.
- No names of real people, no identifiable faces, no national flags, no logos, no text.
- Each subject under 12 words.

---BEGIN DIGEST---
${emailBriefing}
---END DIGEST---`;
}

function stripCodeFence(raw: string): string {
  return raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
}

async function getVisualBrief(env: Env, emailBriefing: string): Promise<VisualBrief> {
  const raw = await anthropicProvider.call(env, 'cheap', buildBriefPrompt(emailBriefing), 400);
  const parsed = JSON.parse(stripCodeFence(raw)) as Partial<VisualBrief>;
  if (!Array.isArray(parsed.subjects) || parsed.subjects.length === 0) {
    throw new Error('Visual brief missing subjects array');
  }
  return {
    subjects: parsed.subjects.filter(s => typeof s === 'string' && s.trim().length > 0).slice(0, 3),
    composition: parsed.composition?.trim() || 'balanced montage',
    mood: parsed.mood?.trim() || 'measured',
  };
}

function fallbackBriefFromHeadlines(emailBriefing: string): VisualBrief {
  const headlines = emailBriefing
    .split('\n')
    .map(l => l.trim())
    .filter(l => /^#{2,3}\s+/.test(l))
    .map(l => l.replace(/^#+\s*/, '').replace(/[*_`]/g, '').trim())
    .filter(l => l.length > 0 && l.length < 120)
    .slice(0, 3);

  return {
    subjects: headlines.length > 0 ? headlines : ['a folded newspaper at dawn', 'a globe with subtle arrows'],
    composition: 'balanced montage of three elements',
    mood: 'measured',
  };
}

function buildImagePrompt(brief: VisualBrief): string {
  const subjectLines = brief.subjects.map((s, i) => `${i + 1}. ${s}`).join('\n');
  return `${ECONOMIST_STYLE_PREFIX}

Subjects to combine in the montage:
${subjectLines}

Composition: ${brief.composition}
Mood: ${brief.mood}`;
}

export async function generateDigestImage(
  env: Env,
  emailBriefing: string,
): Promise<{ base64: string; contentType: 'image/png' } | null> {
  if (!env.OPENAI_API_KEY) {
    console.log('[Image] OPENAI_API_KEY not set — skipping');
    return null;
  }

  let brief: VisualBrief;
  try {
    brief = await getVisualBrief(env, emailBriefing);
    console.log(`[Image] Visual brief: ${JSON.stringify(brief)}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log(`[Image] Visual brief failed (${msg}) — falling back to headline scrape`);
    brief = fallbackBriefFromHeadlines(emailBriefing);
    console.log(`[Image] Fallback brief: ${JSON.stringify(brief)}`);
  }

  try {
    const response = await fetch('https://api.openai.com/v1/images/generations', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${env.OPENAI_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'gpt-image-1',
        prompt: buildImagePrompt(brief),
        size: '1024x1024',
        quality: 'medium',
        n: 1,
      }),
      signal: AbortSignal.timeout(60_000),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`OpenAI images API ${response.status}: ${body.slice(0, 500)}`);
    }

    const data = await response.json() as { data?: Array<{ b64_json?: string }> };
    const b64 = data.data?.[0]?.b64_json;
    if (!b64) {
      throw new Error(`OpenAI response missing b64_json field`);
    }
    console.log(`[Image] Generated PNG (${b64.length} base64 chars)`);
    return { base64: b64, contentType: 'image/png' };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log(`[Image] Generation failed: ${msg}`);
    return null;
  }
}
