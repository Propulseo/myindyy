import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { getScheduledTaskRunContent, listScheduledTaskRuns } from '../server/scheduled-tasks/runs.js';

const originalHermesHome = process.env.HERMES_HOME;
afterEach(() => {
  if (originalHermesHome === undefined) delete process.env.HERMES_HOME;
  else process.env.HERMES_HOME = originalHermesHome;
});

describe('scheduled run HTTP projection redaction', () => {
  it('redacts previews and full manifest output before returning them', async () => {
    const home = mkdtempSync(join(tmpdir(), 'indy-run-redaction-'));
    process.env.HERMES_HOME = home;
    const dir = join(home, 'cron', 'indy-manifests', 'cron-1');
    mkdirSync(dir, { recursive: true });
    const outputRef = join(dir, 'run-1.output.json');
    writeFileSync(outputRef, JSON.stringify({
      body: 'Bearer output-secret Authorization: Basic dXNlcjpwYXNz password=hunter2 credential=fixture-secret {"access_token":"json-token","credential":"json-credential","authorization":"Digest json-auth-secret"}',
    }));
    writeFileSync(join(dir, 'run-1.json'), JSON.stringify({
      schemaVersion: 1, hermesRunId: 'run-1', scheduledTaskId: 'cron-1', scheduledTaskName: 'Cron',
      startedAt: '2026-09-02T08:00:00Z', finishedAt: '2026-09-02T08:00:01Z', status: 'failed',
      error: 'Bearer preview-secret token=preview-token', outputRef,
      provider: 'openai-codex', model: 'gpt-5.6-sol', reasoningEffort: 'high', workdir: 'C:/work', dispatchToken: 'dispatch-1',
    }));

    const runs = await listScheduledTaskRuns('cron-1');
    const content = await getScheduledTaskRunContent('cron-1', 'run-1');
    const serialized = JSON.stringify({ runs, content });
    expect(serialized).not.toContain('preview-secret');
    expect(serialized).not.toContain('preview-token');
    expect(serialized).not.toContain('output-secret');
    expect(serialized).not.toContain('hunter2');
    expect(serialized).not.toContain('fixture-secret');
    expect(serialized).not.toContain('json-token');
    expect(serialized).not.toContain('json-credential');
    expect(serialized).not.toContain('dXNlcjpwYXNz');
    expect(serialized).not.toContain('json-auth-secret');
    expect(serialized).toContain('[REDACTED]');
  });
});
