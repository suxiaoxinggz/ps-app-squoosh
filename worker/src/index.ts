import { Hono } from 'hono';
import type { Env } from './types';

export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<Response> {
    const app = new Hono<{ Bindings: Env }>();
    // routes imported dynamically to keep file small
    const { registerRoutes } = await import('./routes');
    registerRoutes(app, env);
    return app.fetch(request, env, ctx);
  },
  async queue(batch: MessageBatch<any>, env: Env): Promise<void> {
    const { handleQueue } = await import('./queue');
    await handleQueue(batch, env);
  },
};