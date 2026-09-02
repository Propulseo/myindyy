import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';

const original = { MINIONS_HOME: process.env.MINIONS_HOME, DB_PATH: process.env.DB_PATH };
afterEach(() => {
  for (const [key, value] of Object.entries(original)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  vi.resetModules();
});

describe.sequential('cron task public route isolation', () => {
  it('rejects get, patch, move, viewed and delete without cascading the cron projection', async () => {
    const home = mkdtempSync(join(tmpdir(), 'indy-cron-route-'));
    process.env.MINIONS_HOME = home;
    process.env.DB_PATH = join(home, 'data', 'route.db');
    vi.resetModules();
    const [{ tasksRouter }, { default: database }] = await Promise.all([
      import('../server/routes/tasks.js'),
      import('../server/db/index.js'),
    ]);
    database.prepare(`
      INSERT INTO tasks (id, title, status, mission_kind, created_at, updated_at)
      VALUES ('cron:route-1', 'Cron projection', 'done', 'cron', 1, 1)
    `).run();
    database.prepare(`
      INSERT INTO mission_runs (id, mission_id, session_id, attempt, provider, model, status, last_activity_at, occurrence_key)
      VALUES ('cron-run-route', 'cron:route-1', 'session', 1, 'openai-codex', 'gpt-5.6-sol', 'completed', 1, 'cron:route-1:run')
    `).run();
    const app = express();
    app.use(express.json());
    app.use('/api/tasks', tasksRouter);
    try {
      const responses = await Promise.all([
        request(app).get('/api/tasks/cron:route-1'),
        request(app).patch('/api/tasks/cron:route-1').send({ title: 'mutated' }),
        request(app).post('/api/tasks/cron:route-1/move').send({ status: 'in_progress' }),
        request(app).post('/api/tasks/cron:route-1/viewed'),
        request(app).delete('/api/tasks/cron:route-1'),
      ]);
      expect(responses.map((response) => response.status)).toEqual([404, 404, 404, 404, 404]);
      expect(database.prepare("SELECT title, status, mission_kind FROM tasks WHERE id = 'cron:route-1'").get()).toEqual({
        title: 'Cron projection', status: 'done', mission_kind: 'cron',
      });
      expect(database.prepare("SELECT COUNT(*) AS count FROM mission_runs WHERE mission_id = 'cron:route-1'").get()).toEqual({ count: 1 });
    } finally { database.close(); }
  });
});
