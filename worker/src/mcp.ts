import { Hono } from 'hono';
import type { Env, JobRecord } from './types';

// ... existing code above (keep) ...

// MCP JSON-RPC minimal handler (append before export)
export function handleMcp(c: any, env: Env) {
  // We'll implement in routes via direct handling below.
}