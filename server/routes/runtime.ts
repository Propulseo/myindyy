import { Router, type Router as ExpressRouter } from 'express';
import type { RuntimeStatus } from '../runtime/hermes-runtime.js';

export interface RuntimeStatusSource {
  getRuntimeStatus(): Promise<RuntimeStatus>;
}

export function createRuntimeRouter(runtime: RuntimeStatusSource): ExpressRouter {
  const router = Router();
  router.get('/', async (_req, res) => {
    try {
      const status = await runtime.getRuntimeStatus();
      res.json(status);
    } catch {
      res.json({
        provider: 'openai-codex',
        profileId: null,
        authState: 'error',
        checkedAt: new Date().toISOString(),
        models: [],
      } satisfies RuntimeStatus);
    }
  });
  return router;
}
