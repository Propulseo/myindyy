import express from 'express';
import type { Express, NextFunction, Request, Response } from 'express';
import { tasksRouter } from './routes/tasks.js';
import { chatRouter, launchChatRun } from './routes/chat.js';
import { createRunsRouter } from './routes/runs.js';
import { createAgentRouter, createTaskAgentSettingsRouter } from './routes/agent.js';
import { createScheduledTasksRouter } from './routes/scheduled-tasks.js';
import { skillsRouter } from './routes/skills.js';
import { filesRouter } from './routes/files.js';
import { createRuntimeRouter } from './routes/runtime.js';
import { HermesOAuthRuntime } from './runtime/hermes-runtime.js';
import { initSSE, addClient, sendEvent } from './events.js';
import { getRunStatuses } from './live-chat.js';
import { getAppVersion } from './version.js';
import { requireEtienne } from './auth/etienne.js';
import db from './db/index.js';
import { createRunRepository } from './runs/repository.js';
import { createHealthRouter, operationalReadiness } from './health/readiness.js';

const app: Express = express();

app.use('/api', requireEtienne);

const adapter = new HermesOAuthRuntime();
const runRepository = createRunRepository(db);

app.use('/api/health', createHealthRouter({
  database: db,
  runtime: adapter,
  controlLoopsReady: operationalReadiness.controlLoopsReady,
  onFailure: (reason) => console.warn(`Readiness unavailable: ${reason}`),
}));

app.get('/api/version', (_req, res) => {
  res.json(getAppVersion());
});

app.get('/api/events', (req, res) => {
  initSSE(res);
  addClient(res);
  sendEvent(res, { type: 'task_runs_snapshot', runs: getRunStatuses() });
});

app.use('/api/files', express.json({ limit: '25mb' }), filesRouter);

app.use(express.json());

app.use('/api/tasks', tasksRouter);
app.use('/api/tasks', createTaskAgentSettingsRouter(adapter));
app.use('/api/tasks', chatRouter);
app.use('/api/missions', createRunsRouter({
  database: db,
  adapter,
  launchCommandRun: launchChatRun,
}));
app.use('/api/agent', createAgentRouter(adapter));
app.use('/api/scheduled-tasks', createScheduledTasksRouter(adapter, { runRepository }));
app.use('/api/skills', skillsRouter);
app.use('/api/runtime', createRuntimeRouter(adapter));

app.use((error: unknown, _req: Request, res: Response, next: NextFunction) => {
  if (!res.headersSent && error && typeof error === 'object' && (error as { type?: string }).type === 'entity.too.large') {
    res.status(413).json({ error: 'Request body is too large', code: 'PAYLOAD_TOO_LARGE' });
    return;
  }
  next(error);
});

export { adapter };
export default app;
