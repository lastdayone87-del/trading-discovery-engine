import 'dotenv/config';
import { GoogleGenAI } from '@google/genai';

const TARGET_MODELS = [
  process.env.MULTILINGUAL_CANDIDATE_MODEL || 'gemini-2.5-flash-lite',
  process.env.MULTILINGUAL_ADJUDICATOR_MODEL || 'gemini-2.5-flash'
];

async function main() {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY is not configured.');

  const ai = new GoogleGenAI({ apiKey });
  const discovered: Array<{ name: string; supportedActions: string[] }> = [];
  const pager = await ai.models.list();

  for await (const model of pager) {
    const name = String(model.name || '');
    if (!name) continue;
    discovered.push({
      name,
      supportedActions: Array.isArray(model.supportedActions)
        ? model.supportedActions.map(String).sort()
        : []
    });
  }

  const normalized = (name: string) => name.replace(/^models\//, '');
  const targets = TARGET_MODELS.map(target => {
    const match = discovered.find(model => normalized(model.name) === normalized(target));
    return {
      model: target,
      visible: Boolean(match),
      supportsGenerateContent: Boolean(match?.supportedActions.includes('generateContent')),
      supportedActions: match?.supportedActions || []
    };
  });

  console.log('[Gemini Model Availability Diagnostic]', JSON.stringify({
    targetModels: targets,
    visibleModelCount: discovered.length,
    generateContentModels: discovered
      .filter(model => model.supportedActions.includes('generateContent'))
      .map(model => model.name)
      .sort()
  }));
}

main().catch(error => {
  const value = error as { status?: unknown; code?: unknown; name?: unknown };
  console.error('[Gemini Model Availability Diagnostic Failed]', JSON.stringify({
    name: String(value?.name || 'Error'),
    status: Number(value?.status || value?.code) || null
  }));
  process.exitCode = 1;
});
