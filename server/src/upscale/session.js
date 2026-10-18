import fs from 'node:fs';
import path from 'node:path';
import ort from 'onnxruntime-node';
import { MODELS, findModel } from './models.js';

const CACHE_DIR = path.resolve('./.model-cache');
const SESSION_TIMEOUT_MS = 60_000;

const sessions = new Map();
const MAX_SESSIONS = 1;

function withTimeout(p, ms, label) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(
      () =>
        reject(new Error(`${label} timed out after ${Math.round(ms / 1000)}s`)),
      ms,
    );
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
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

export function getLoadedModels() {
  return [...sessions.keys()];
}

export async function getSession(modelId) {
  if (sessions.has(modelId)) return sessions.get(modelId);
  const m = findModel(modelId);
  if (!m)
    throw new Error(
      `unknown model ${modelId}. Available: ${MODELS.map((x) => x.id).join(', ')}`,
    );
  if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });
  const cachePath = path.join(CACHE_DIR, `${modelId}.onnx`);
  let bytes;
  if (fs.existsSync(cachePath)) {
    bytes = fs.readFileSync(cachePath);
  } else {
    bytes = await fetchBytes([m.url, ...m.fallbackUrls]);
    fs.writeFileSync(cachePath, bytes);
  }
  // LRU max 1: release any existing session before creating a new one.
  for (const [k, v] of sessions) {
    sessions.delete(k);
    try {
      if (v && typeof v.release === 'function') await v.release();
    } catch {}
  }
  const sess = await withTimeout(
    ort.InferenceSession.create(bytes, {
      graphOptimizationLevel: 'all',
      intraOpNumThreads: 1,
      interOpNumThreads: 1,
      // Disable ORT CPU memory arena + mem pattern: prevents native (off-heap)
      // slab retention across runs on 512MB hosts. Trades speed for survival.
      enableCpuMemArena: false,
      enableMemPattern: false,
    }),
    SESSION_TIMEOUT_MS,
    'session create',
  );
  sessions.set(modelId, sess);
  // keep map size <= MAX_SESSIONS
  while (sessions.size > MAX_SESSIONS) {
    const [k] = sessions.keys();
    const v = sessions.get(k);
    sessions.delete(k);
    try {
      if (v && typeof v.release === 'function') await v.release();
    } catch {}
  }
  return sess;
}
