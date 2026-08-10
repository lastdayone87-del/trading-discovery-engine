import 'dotenv/config';
import { GoogleGenAI } from '@google/genai';

const MODELS = [
  process.env.MULTILINGUAL_CANDIDATE_MODEL || 'gemini-2.5-flash-lite',
  process.env.MULTILINGUAL_ADJUDICATOR_MODEL || 'gemini-2.5-flash'
];

async function probe(model: string) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY is not configured.');
  const ai = new GoogleGenAI({ apiKey });
  try {
    const response = await ai.models.generateContent({
      model,
      contents: 'Return only valid JSON: {"ok":true}',
      config: { responseMimeType: 'application/json', temperature: 0 }
    });
    return {
      model,
      success: true,
      hasText: Boolean(response.text),
      status: null,
      errorName: null
    };
  } catch (error) {
    const value = error as { status?: unknown; code?: unknown; name?: unknown };
    return {
      model,
      success: false,
      hasText: false,
      status: Number(value?.status || value?.code) || null,
      errorName: String(value?.name || 'Error')
    };
  }
}

async function main() {
  const results = [];
  for (const model of MODELS) results.push(await probe(model));
  console.log('[Gemini GenerateContent Probe]', JSON.stringify({ results }));
  if (results.some(result => !result.success)) process.exitCode = 2;
}

main().catch(error => {
  const value = error as { status?: unknown; code?: unknown; name?: unknown };
  console.error('[Gemini GenerateContent Probe Failed]', JSON.stringify({
    name: String(value?.name || 'Error'),
    status: Number(value?.status || value?.code) || null
  }));
  process.exitCode = 1;
});
