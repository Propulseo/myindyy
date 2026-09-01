import type {
  MissionRun,
  MissionRunStatus,
  ReasoningEffort,
  RunEvent,
  RunEventType,
} from '../../shared/types.js';

export type { MissionRun, MissionRunStatus, RunEvent, RunEventType } from '../../shared/types.js';

export interface CreateRunInput {
  readonly id?: string;
  readonly missionId: string;
  readonly sessionId: string;
  readonly attempt: number;
  readonly provider: string;
  readonly model: string;
  readonly reasoningEffort?: ReasoningEffort | null;
  readonly startedAt?: number | null;
  readonly previousRunId?: string | null;
  readonly createdAt?: number;
}

export interface AppendRunEventInput {
  readonly id: string;
  readonly runId: string;
  readonly type: RunEventType;
  readonly occurredAt: number;
  readonly payload: Readonly<Record<string, unknown>>;
}

export type TerminalMissionRunStatus = Extract<
  MissionRunStatus,
  'completed' | 'failed' | 'cancelled'
>;

export type ReconciledMissionRunStatus = Extract<MissionRunStatus, 'running' | 'unknown'>;

export interface FinishRunRecordInput {
  readonly runId: string;
  readonly status: TerminalMissionRunStatus;
  readonly finishedAt?: number;
  readonly finishReason?: string | null;
}

export interface ClaimCommandInput {
  readonly idempotencyKey: string;
  readonly actorId: string;
  readonly missionId: string;
  readonly runId?: string | null;
  readonly commandType: string;
  readonly payloadHash: string;
  readonly createdAt?: number;
}

export interface OperatorCommand {
  readonly idempotencyKey: string;
  readonly actorId: string;
  readonly missionId: string;
  readonly runId: string | null;
  readonly commandType: string;
  readonly payloadHash: string;
  readonly status: string;
  readonly result: unknown | null;
  readonly createdAt: number;
  readonly completedAt: number | null;
}

export interface CommandClaimResult {
  readonly status: 'claimed' | 'duplicate' | 'conflict';
  readonly command: OperatorCommand;
}

export interface CompleteCommandInput {
  readonly idempotencyKey: string;
  readonly result: unknown;
  readonly completedAt?: number;
}

export interface RunRepository {
  createRun(input: CreateRunInput): MissionRun;
  appendRunEvent(input: AppendRunEventInput): boolean;
  finishRunRecord(input: FinishRunRecordInput): MissionRun;
  updateRunStatus(runId: string, status: ReconciledMissionRunStatus): MissionRun;
  updateRunSession(runId: string, sessionId: string, confirmedAt?: number): MissionRun;
  getRunRecord(runId: string): MissionRun | undefined;
  listMissionRuns(missionId: string): MissionRun[];
  listRunEvents(runId: string): RunEvent[];
  hasInactiveBlockEvent(runId: string): boolean;
  findActiveRuns(missionId?: string): MissionRun[];
  claimCommand(input: ClaimCommandInput): CommandClaimResult;
  completeCommand(input: CompleteCommandInput): OperatorCommand;
}

export interface RunRepositoryOptions {
  readonly generateId?: () => string;
  readonly now?: () => number;
}
