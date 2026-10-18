import fs from 'node:fs';
import path from 'node:path';
import ort from 'onnxruntime-node';
import { MODELS, findModel } from './models.js';

const CACHE_DIR = path.resolve('./.model-cache');
const SESSION_TIMEOUT_MS = 60_000;

const sessions = new Map();

function withTimeout(p, ms, label) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${label} timed out after ${Math.round(ms / 1000)}s`)), ms);
    p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}

async function fetchBytes(urls) {
  let lastErr;
  for (const u of urls) {
    try {
      const res = await fetch(u);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const ab = await res.arrayBuffer();
      return Buffer.from(ab);
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error('fetch failed');
}

export async function getSession(modelId) {
  if (sessions.has(modelId)) return sessions.get(modelId);
  const m = findModel(modelId);
  if (!m) throw new Error(`unknown model ${modelId}. Available: ${MODELS.map((x) => x.id).join(', ')}`);
  if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });
  const cachePath = path.join(CACHE_DIR, `${modelId}.onnx`);
  let bytes;
  if (fs.existsSync(cachePath)) {
    bytes = fs.readFileSync(cachePath);
  } else {
    bytes = await fetchBytes([m.url, ...m.fallbackUrls]);
    fs.writeFileSync(cachePath, bytes);
  }
  const sess = await withTimeout(
    ort.InferenceSession.create(bytes, { graphOptimizationLevel: 'all' }),
    SESSION_TIMEOUT_MS,
    'session create',
  );
  sessions.set(modelId, sess);
  return sess;
}
