import fs from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { buildSemanticPrompt, parseSemanticModelResult, DEFAULT_MULTILINGUAL_CANDIDATE_MODEL } from '../server/evidenceEngine/providers/GeminiSemanticProvider.js';
import type { RawChannelInput } from '../server/evidenceEngine/types.js';

type GroundTruth = 'TRADING_CONFIRMED' | 'NON_TRADING' | 'UNCERTAIN';

type Case = {
  id: string;
  input: RawChannelInput;
  ground_truth: GroundTruth;
  gemini?: { label?: string; confidence?: number; status?: GroundTruth; model?: string };
};

type Result = {
  id: string;
  provider: 'groq';
  model: string;
  latency_ms: number;
  http_status?: number;
  ok: boolean;
  schema_valid: boolean;
  label?: string;
  confidence?: number;
  status?: GroundTruth;
  error?: string;
};

const MODEL = process.env.GROQ_BENCHMARK_MODEL || 'openai/gpt-oss-120b';
const CASES = process.env.SEMANTIC_BENCHMARK_CASES || 'benchmark/semantic-cases.jsonl';
const OUT = process.env.SEMANTIC_BENCHMARK_OUT || 'benchmark/results/groq-semantic.json';

function toStatus(label: string | undefined, confidence: number | undefined): GroundTruth {
  if (label === 'ACTIVE_TRADING' || label === 'INVESTING_EDUCATION') return 'TRADING_CONFIRMED';
  if (label === 'UNRELATED' || label === 'HYPE' || label === 'FINANCIAL_NEWS' || label === 'PERSONAL_FINANCE') return 'NON_TRADING';
  return 'UNCERTAIN';
}

async function callGroq(prompt: string) {
  const key = process.env.GROQ_API_KEY;
  if (!key) throw new Error('GROQ_API_KEY is not configured.');
  const started = performance.now();
  const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: MODEL,
      messages: [
        { role: 'user', content: `${prompt}\nReturn JSON only. Do not include markdown.` }
      ],
      temperature: 0,
      reasoning_effort: 'medium',
      include_reasoning: false,
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: 'semantic_classification',
          strict: true,
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              label: { type: 'string', enum: ['ACTIVE_TRADING','INVESTING_EDUCATION','FINANCIAL_NEWS','PERSONAL_FINANCE','HYPE','UNRELATED','AMBIGUOUS'] },
              confidence: { type: 'number', minimum: 0, maximum: 100 },
              supportedLanguage: { type: 'boolean' },
              reasonCodes: { type: 'array', items: { type: 'string' } },
              explanation: { type: 'string' },
              concepts: { type: 'array', items: { type: 'string' } },
              languages: { type: 'array', items: { type: 'object', additionalProperties: false, properties: { language:{type:'string'}, script:{type:'string'}, confidence:{type:'number',minimum:0,maximum:100}, field:{type:'string'} }, required:['language','script','confidence','field'] } },
              citations: { type: 'array', items: { type: 'object', additionalProperties: false, properties: { field:{type:'string'}, index:{type:['integer','null']}, sourceId:{type:['string','null']} }, required:['field','index','sourceId'] } }
            },
            required: ['label','confidence','supportedLanguage','reasonCodes','explanation','concepts','languages','citations']
          }
        }
      }
    })
  });
  const latency = Math.round(performance.now() - started);
  const text = await response.text();
  if (!response.ok) throw Object.assign(new Error(`Groq HTTP ${response.status}: ${text.slice(0, 500)}`), { status: response.status, latency });
  const parsed = JSON.parse(text);
  const content = parsed?.choices?.[0]?.message?.content;
  if (typeof content !== 'string') throw Object.assign(new Error('Groq returned no message content.'), { status: response.status, latency });
  const raw = JSON.parse(content);
  const normalized = parseSemanticModelResult(raw);
  return { normalized, latency };
}

async function main() {
  const lines = (await fs.readFile(CASES, 'utf8')).split(/\r?\n/).map(x => x.trim()).filter(Boolean);
  const cases: Case[] = lines.map(line => JSON.parse(line));
  if (!cases.length) throw new Error(`No benchmark cases found in ${CASES}`);

  const results: Result[] = [];
  for (const item of cases) {
    const prompt = buildSemanticPrompt(item.input, 'CANDIDATE');
    try {
      const { normalized, latency } = await callGroq(prompt);
      results.push({ id:item.id, provider:'groq', model:MODEL, latency_ms:latency, ok:true, schema_valid:true, label:normalized.label, confidence:normalized.confidence, status:toStatus(normalized.label, normalized.confidence) });
    } catch (error: any) {
      results.push({ id:item.id, provider:'groq', model:MODEL, latency_ms:Number(error?.latency || 0), http_status:error?.status, ok:false, schema_valid:false, error:String(error?.message || error) });
    }
  }

  const evaluated = results.filter(r => r.ok && r.status);
  const trading = cases.map(c => ({ truth:c.ground_truth, result:results.find(r=>r.id===c.id) })).filter(x=>x.result?.ok);
  const tp = trading.filter(x=>x.truth==='TRADING_CONFIRMED' && x.result?.status==='TRADING_CONFIRMED').length;
  const fp = trading.filter(x=>x.truth!=='TRADING_CONFIRMED' && x.result?.status==='TRADING_CONFIRMED').length;
  const fn = trading.filter(x=>x.truth==='TRADING_CONFIRMED' && x.result?.status!=='TRADING_CONFIRMED').length;
  const tn = trading.filter(x=>x.truth!=='TRADING_CONFIRMED' && x.result?.status!=='TRADING_CONFIRMED').length;
  const precision = tp+fp ? tp/(tp+fp) : 0;
  const recall = tp+fn ? tp/(tp+fn) : 0;
  const f1 = precision+recall ? 2*precision*recall/(precision+recall) : 0;
  const latencies = evaluated.map(r=>r.latency_ms).sort((a,b)=>a-b);
  const percentile = (p:number) => latencies.length ? latencies[Math.min(latencies.length-1, Math.floor((latencies.length-1)*p))] : null;

  const report = { generated_at:new Date().toISOString(), model:MODEL, prompt_version:'priority2-multilingual-structured-1', candidate_model_baseline:DEFAULT_MULTILINGUAL_CANDIDATE_MODEL, cases:cases.length, completed:evaluated.length, failures:results.length-evaluated.length, schema_valid_rate:results.length?evaluated.length/results.length:0, confusion:{tp,tn,fp,fn}, precision, recall, f1, latency_ms:{p50:percentile(.5),p95:percentile(.95),mean:latencies.length?latencies.reduce((a,b)=>a+b,0)/latencies.length:null}, results };
  await fs.mkdir(OUT.split('/').slice(0,-1).join('/') || '.', { recursive:true });
  await fs.writeFile(OUT, JSON.stringify(report,null,2));
  console.log(JSON.stringify(report,null,2));
}

main().catch(error=>{ console.error(error); process.exit(1); });
