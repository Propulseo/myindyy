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

  it('finishes a run without changing its immutable identity fields', () => {
    const run = repository.createRun({
      missionId: 'mission-1',
      sessionId: 'hermes-session-1',
      attempt: 1,
      provider: 'openai-codex',
      model: 'gpt-5.6-sol',
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
      lastActivityAt: 40,
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
});
