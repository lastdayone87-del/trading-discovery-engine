import 'dotenv/config';

const apiKey = process.env.GEMINI_API_KEY;
if (!apiKey) throw new Error('GEMINI_API_KEY is not configured.');

const tests = [
  { apiVersion: 'v1beta', model: 'gemini-2.5-flash' },
  { apiVersion: 'v1', model: 'gemini-2.5-flash' },
  { apiVersion: 'v1beta', model: 'gemini-3.6-flash' },
  { apiVersion: 'v1', model: 'gemini-3.6-flash' }
];

const body = JSON.stringify({
  contents: [{ role: 'user', parts: [{ text: 'Return exactly this JSON object: {"ok":true}' }] }],
  generationConfig: { responseMimeType: 'application/json', temperature: 0 }
});

async function run() {
  const results: Array<Record<string, unknown>> = [];
  for (const test of tests) {
    const url = `https://generativelanguage.googleapis.com/${test.apiVersion}/models/${test.model}:generateContent`;
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'x-goog-api-key': apiKey!,
          'content-type': 'application/json'
        },
        body
      });
      let errorStatus: string | null = null;
      let errorCode: number | null = null;
      if (!response.ok) {
        try {
          const parsed = await response.json() as any;
          errorStatus = typeof parsed?.error?.status === 'string' ? parsed.error.status : null;
          errorCode = Number(parsed?.error?.code) || null;
        } catch {}
      }
      results.push({ apiVersion: test.apiVersion, model: test.model, success: response.ok, status: response.status, errorStatus, errorCode });
    } catch (error) {
      results.push({ apiVersion: test.apiVersion, model: test.model, success: false, status: null, errorName: error instanceof Error ? error.name : 'Error' });
    }
  }
  console.log('[Gemini REST Version Probe]', JSON.stringify({ results }));
  if (!results.some(result => result.success === true)) process.exitCode = 2;
}

run();
