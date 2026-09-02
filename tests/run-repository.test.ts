import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createRunRepository, type RunRepository } from '../server/runs/repository.js';

const schema = readFileSync(new URL('../server/db/schema.sql', import.meta.url), 'utf8');

describe('run repository', () => {
  let database: Database.Database;
  let repository: RunRepository;

  beforeEach(() => {
    database = new Database(':memory:');
    database.pragma('foreign_keys = ON');
    database.exec(schema);
    database.prepare(`
      INSERT INTO tasks (id, title, status, created_at, updated_at)
      VALUES (?, ?, 'in_progress', 1, 1)
    `).run('mission-1', 'First mission');
    repository = createRunRepository(database, {
      generateId: () => 'run-1',
      now: () => 10,
    });
  });

  afterEach(() => database.close());

  it('keeps mission, immutable run attempt, and native session as separate identities', () => {
    const run = repository.createRun({
      missionId: 'mission-1',
      sessionId: 'hermes-session-1',
      attempt: 1,
      provider: 'openai-codex',
      model: 'gpt-5.6-sol',
      reasoningEffort: 'high',
    });

    expect(run).toEqual({
      id: 'run-1',
      missionId: 'mission-1',
      sessionId: 'hermes-session-1',
      sessionConfirmedAt: null,
      attempt: 1,
      provider: 'openai-codex',
      model: 'gpt-5.6-sol',
      reasoningEffort: 'high',
      status: 'queued',
      startedAt: null,
      lastActivityAt: 10,
      finishedAt: null,
      finishReason: null,
      previousRunId: null,
    });
    expect(run.id).not.toBe(run.missionId);
    expect(run.sessionId).not.toBe(run.missionId);
  });

  it('allows a later immutable attempt to reuse the same native Hermes session', () => {
    repository.createRun({
      id: 'run-1',
      missionId: 'mission-1',
      sessionId: 'hermes-session-1',
      attempt: 1,
      provider: 'openai-codex',
      model: 'gpt-5.6-sol',
    });

    const retry = repository.createRun({
      id: 'run-2',
      missionId: 'mission-1',
      sessionId: 'hermes-session-1',
      attempt: 2,
      provider: 'openai-codex',
      model: 'gpt-5.6-sol',
      previousRunId: 'run-1',
    });

    expect(retry.sessionId).toBe('hermes-session-1');
    expect(retry.previousRunId).toBe('run-1');
  });

  it('rejects duplicate attempt numbers for one mission', () => {
    repository.createRun({
      id: 'run-1',
      missionId: 'mission-1',
      sessionId: 'hermes-session-1',
      attempt: 1,
      provider: 'openai-codex',
      model: 'gpt-5.6-sol',
    });

    expect(() => repository.createRun({
      id: 'run-2',
      missionId: 'mission-1',
      sessionId: 'hermes-session-2',
      attempt: 1,
      provider: 'openai-codex',
      model: 'gpt-5.6-sol',
    })).toThrow();
  });

  it('rejects a non-positive attempt number', () => {
    expect(() => repository.createRun({
      missionId: 'mission-1',
      sessionId: 'hermes-session-1',
      attempt: 0,
      provider: 'openai-codex',
      model: 'gpt-5.6-sol',
    })).toThrow();
  });

  it('inserts each event once and touches activity only for a new event', () => {
    repository.createRun({
      missionId: 'mission-1',
      sessionId: 'hermes-session-1',
      attempt: 1,
      provider: 'openai-codex',
      model: 'gpt-5.6-sol',
    });

    expect(repository.appendRunEvent({
      id: 'event-1',
      runId: 'run-1',
      type: 'run.started',
      occurredAt: 20,
      payload: { phase: 'initial' },
    })).toBe(true);
    expect(repository.appendRunEvent({
      id: 'event-1',
      runId: 'run-1',
      type: 'run.failed',
      occurredAt: 30,
      payload: { phase: 'duplicate' },
    })).toBe(false);

    expect(repository.listRunEvents('run-1')).toEqual([{
      id: 'event-1',
      runId: 'run-1',
      type: 'run.started',
      occurredAt: 20,
      payload: { phase: 'initial' },
    }]);
    expect(repository.getRunRecord('run-1')?.lastActivityAt).toBe(20);
  });

  it('projects lifecycle events onto the mutable run status', () => {
    repository.createRun({
      missionId: 'mission-1',
      sessionId: 'hermes-session-1',
      attempt: 1,
      provider: 'openai-codex',
      model: 'gpt-5.6-sol',
    });

    repository.appendRunEvent({
      id: 'event-started', runId: 'run-1', type: 'run.started', occurredAt: 20, payload: {},
    });
    expect(repository.getRunRecord('run-1')).toMatchObject({ status: 'running', startedAt: 20 });

    repository.appendRunEvent({
      id: 'event-waiting', runId: 'run-1', type: 'run.waiting_approval', occurredAt: 30, payload: {},
    });
    expect(repository.getRunRecord('run-1')?.status).toBe('waiting_approval');

    repository.appendRunEvent({
      id: 'event-blocked', runId: 'run-1', type: 'run.blocked', occurredAt: 40, payload: {},
    });
    expect(repository.getRunRecord('run-1')?.status).toBe('blocked');
  });

  it('redacts nested sensitive payload fields without mutating the input', () => {
    repository.createRun({
      missionId: 'mission-1',
      sessionId: 'hermes-session-1',
      attempt: 1,
      provider: 'openai-codex',
      model: 'gpt-5.6-sol',
    });
    const payload = {
      safe: 'visible',
      Token: 'sentinel-token',
      apiKEY: 'sentinel-key',
      nested: {
        clientSecretValue: 'sentinel-secret',
        CREDENTIAL: 'sentinel-credential',
        requestAuthorizationHeader: 'sentinel-authorization',
        CookieJar: 'sentinel-cookie',
        entries: [{ refreshTOKEN: 'sentinel-array-token', label: 'kept' }],
      },
    };

    repository.appendRunEvent({
      id: 'event-sensitive',
      runId: 'run-1',
      type: 'tool.completed',
      occurredAt: 20,
      payload,
    });

    const rawPayload = database.prepare(
      'SELECT payload_json FROM run_events WHERE id = ?',
    ).pluck().get('event-sensitive') as string;
    expect(rawPayload).not.toContain('sentinel-');
    expect(JSON.parse(rawPayload)).toEqual({
      safe: 'visible',
      Token: '[REDACTED]',
      apiKEY: '[REDACTED]',
      nested: {
        clientSecretValue: '[REDACTED]',
        CREDENTIAL: '[REDACTED]',
        requestAuthorizationHeader: '[REDACTED]',
        CookieJar: '[REDACTED]',
        entries: [{ refreshTOKEN: '[REDACTED]', label: 'kept' }],
      },
    });
    expect(repository.listRunEvents('run-1')[0]?.payload).toEqual(JSON.parse(rawPayload));
    expect(payload.nested.entries[0]?.refreshTOKEN).toBe('sentinel-array-token');
  });

  it('finishes a run without advancing activity beyond the last new event', () => {
    const run = repository.createRun({
      missionId: 'mission-1',
      sessionId: 'hermes-session-1',
      attempt: 1,
      provider: 'openai-codex',
      model: 'gpt-5.6-sol',
    });
    repository.appendRunEvent({
      id: 'event-before-finish',
      runId: run.id,
      type: 'run.started',
      occurredAt: 20,
      payload: {},
    });

    const finished = repository.finishRunRecord({
      runId: run.id,
      status: 'completed',
      finishedAt: 40,
      finishReason: 'success',
    });

    expect(finished).toMatchObject({
      id: 'run-1',
      missionId: 'mission-1',
      sessionId: 'hermes-session-1',
      attempt: 1,
      status: 'completed',
      finishedAt: 40,
      finishReason: 'success',
      lastActivityAt: 20,
    });
  });

  it('finds non-terminal runs in latest-activity order', () => {
    repository.createRun({
      id: 'run-1', missionId: 'mission-1', sessionId: 'session-1', attempt: 1,
      provider: 'openai-codex', model: 'gpt-5.6-sol',
    });
    repository.createRun({
      id: 'run-2', missionId: 'mission-1', sessionId: 'session-2', attempt: 2,
      provider: 'openai-codex', model: 'gpt-5.6-sol', previousRunId: 'run-1',
      createdAt: 20,
    });
    repository.createRun({
      id: 'run-3', missionId: 'mission-1', sessionId: 'session-3', attempt: 3,
      provider: 'openai-codex', model: 'gpt-5.6-sol', previousRunId: 'run-2',
      createdAt: 30,
    });
    repository.finishRunRecord({ runId: 'run-3', status: 'failed', finishedAt: 40 });

    expect(repository.findActiveRuns().map((run) => run.id)).toEqual(['run-2', 'run-1']);
  });

  it('claims a command once and distinguishes duplicate payloads from conflicts', () => {
    const command = {
      idempotencyKey: 'command-1',
      actorId: 'operator-1',
      missionId: 'mission-1',
      runId: null,
      commandType: 'mission.start',
      payloadHash: 'hash-a',
      createdAt: 50,
    };

    expect(repository.claimCommand(command).status).toBe('claimed');
    expect(repository.claimCommand({ ...command, createdAt: 60 }).status).toBe('duplicate');
    expect(repository.claimCommand({ ...command, payloadHash: 'hash-b' }).status).toBe('conflict');
  });

  it('redacts terminal reasons and command results at their final SQLite writes', () => {
    const run = repository.createRun({
      missionId: 'mission-1',
      sessionId: 'hermes-session-1',
      attempt: 1,
      provider: 'openai-codex',
      model: 'gpt-5.6-sol',
    });
    repository.finishRunRecord({
      runId: run.id,
      status: 'failed',
      finishReason: 'Authorization: Basic dXNlcjpwYXNzd29yZA==',
    });
    repository.claimCommand({
      idempotencyKey: 'secret-command',
      actorId: 'etienne',
      missionId: 'mission-1',
      runId: run.id,
      commandType: 'retry',
      payloadHash: 'hash-secret-command',
    });
    repository.completeCommand({
      idempotencyKey: 'secret-command',
      result: {
        httpStatus: 503,
        body: {
          error: '{"authorization":"Digest username=\\"Mufasa\\", nonce=\\"nonce-secret\\", response=\\"response-secret\\"","token":"token-secret","credential":"credential-secret","password":"password-secret"}',
        },
      },
    });

    const persisted = JSON.stringify({
      run: database.prepare('SELECT finish_reason FROM mission_runs WHERE id = ?').get(run.id),
      command: database.prepare('SELECT result_json FROM operator_commands WHERE idempotency_key = ?').get('secret-command'),
    });
    for (const secret of [
      'dXNlcjpwYXNzd29yZA==', 'Mufasa', 'nonce-secret', 'response-secret',
      'token-secret', 'credential-secret', 'password-secret',
    ]) {
      expect(persisted).not.toContain(secret);
    }
    expect(repository.getRunRecord(run.id)?.finishReason).toContain('[REDACTED]');
    expect(JSON.stringify(repository.getCommand('secret-command')?.result)).toContain('[REDACTED]');
  });
});
