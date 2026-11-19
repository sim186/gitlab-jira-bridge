/**
 * Drains the action queue into Jira, one action at a time.
 *
 *   webhook → enqueue (on disk) → 200 to GitLab
 *                 ↓
 *   worker → Jira → audit; transient failure → back off and retry
 *
 * Transient failures are retried with exponential backoff up to
 * `retry.max_attempts`, then recorded as `abandoned` (replayable). Permanent
 * failures are recorded once and not retried. Every outcome is audited.
 *
 * The worker also picks up replay requests that `bridge replay` drops into the
 * inbox directory, so the CLI never writes the queue or state files the server
 * owns.
 */
import { mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { Logger } from 'pino';
import type { Config } from './config/schema.js';
import type { JiraAction } from './domain/actions.js';
import type { JiraClient } from './jira/client.js';
import type { GitLabClient } from './gitlab/client.js';
import { executeAction } from './jira/execute.js';
import type { AuditEntry, AuditOutcome, AuditSink } from './state/audit.js';
import type { DedupeStore } from './state/dedup.js';
import type { ActionQueue, AuditContext, QueueItem } from './state/queue.js';

export type EnqueueResult = { queued: string[]; duplicates: string[] };

export type ReplayRequest = { items: { action: JiraAction; context: AuditContext }[] };

export type WorkerDeps = {
  queue: ActionQueue;
  state: DedupeStore;
  jira: JiraClient;
  /** Only present when comment_on_missing_key is on. */
  gitlab?: GitLabClient;
  audit: AuditSink;
  log: Logger;
  now?: () => Date;
};

export class Worker {
  private readonly now: () => Date;
  private running: Promise<void> | null = null;
  private rerun = false;
  private stopped = false;
  private timer: NodeJS.Timeout | null = null;
  private interval: NodeJS.Timeout | null = null;

  constructor(
    private readonly config: Config,
    private readonly deps: WorkerDeps,
  ) {
    this.now = deps.now ?? (() => new Date());
  }

  /** Queue a delivery's actions. Already-applied or already-queued ids are skipped. */
  enqueue(actions: JiraAction[], context: AuditContext): EnqueueResult {
    const { queue, state } = this.deps;
    const result: EnqueueResult = { queued: [], duplicates: [] };
    const at = this.now().toISOString();
    for (const action of actions) {
      if (state.has(action.id) || queue.has(action.id)) {
        result.duplicates.push(action.id);
        this.record(action, context, 'duplicate');
        continue;
      }
      queue.push({ action, context, attempts: 0, enqueued_at: at, next_at: at });
      result.queued.push(action.id);
    }
    if (result.queued.length > 0) queue.save();
    this.kick();
    return result;
  }

  /** Start background processing: an immediate pass, then a periodic tick for inbox and retries. */
  start(tickMs = 5_000): void {
    this.stopped = false;
    this.ingestInbox();
    this.kick();
    this.interval = setInterval(() => {
      this.ingestInbox();
      this.kick();
    }, tickMs);
    this.interval.unref();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.interval) clearInterval(this.interval);
    if (this.timer) clearTimeout(this.timer);
    await this.running;
  }

  /** Process everything currently due; resolves when nothing eligible remains. For tests and shutdown. */
  async drain(): Promise<void> {
    this.kick();
    while (this.running) await this.running;
  }

  /** Ask for a processing pass; coalesces with one already in flight. */
  kick(): void {
    if (this.stopped) return;
    if (this.running) {
      this.rerun = true;
      return;
    }
    this.running = this.process().finally(() => {
      this.running = null;
      if (this.rerun) {
        this.rerun = false;
        this.kick();
      } else {
        this.scheduleNext();
      }
    });
  }

  private scheduleNext(): void {
    if (this.timer) clearTimeout(this.timer);
    const due = this.deps.queue.nextDue();
    if (!due || this.stopped) return;
    const delay = Math.max(0, Date.parse(due) - this.now().getTime());
    this.timer = setTimeout(() => this.kick(), delay);
    this.timer.unref();
  }

  private async process(): Promise<void> {
    const { queue, state, jira, gitlab, log } = this.deps;
    for (;;) {
      if (this.stopped) return;
      const item = queue.nextEligible(this.now());
      if (!item) return;

      if (state.has(item.action.id)) {
        queue.remove(item);
        queue.save();
        this.record(item.action, item.context, 'duplicate');
        continue;
      }

      const attempt = item.attempts + 1;
      const result = await executeAction(item.action, { jira, gitlab });

      if (result.status !== 'failed') {
        // A dry run must not consume the id: once dry_run is off, the same
        // delivery (or its redelivery) has to apply for real.
        if (!this.config.behaviours.dry_run) state.add(item.action.id);
        this.finish(item);
        this.record(item.action, item.context, result.status, {
          before: result.before,
          after: result.after,
          ...(result.detail ? { detail: result.detail } : {}),
          ...(attempt > 1 ? { attempt } : {}),
        });
        continue;
      }

      if (result.permanent) {
        state.add(item.action.id);
        this.finish(item);
        log.warn({ action: item.action.id, key: item.action.key, err: result.error }, 'permanent Jira failure, not retrying');
        this.record(item.action, item.context, 'failed_permanent', { detail: result.error, attempt, action: item.action });
        continue;
      }

      const { max_attempts } = this.config.retry;
      if (attempt >= max_attempts) {
        queue.remove(item);
        queue.save();
        log.error({ action: item.action.id, key: item.action.key, err: result.error, attempt }, 'Jira still failing, giving up');
        this.record(item.action, item.context, 'abandoned', {
          detail: `gave up after ${attempt} attempts: ${result.error}`,
          attempt,
          action: item.action,
        });
        continue;
      }

      item.attempts = attempt;
      item.last_error = result.error;
      item.next_at = new Date(this.now().getTime() + this.backoffMs(attempt)).toISOString();
      queue.save();
      log.warn({ action: item.action.id, key: item.action.key, err: result.error, attempt, next_at: item.next_at }, 'transient Jira failure, retry scheduled');
      this.record(item.action, item.context, 'failed_transient', {
        detail: `${result.error}; retry ${attempt + 1}/${max_attempts} at ${item.next_at}`,
        attempt,
      });
    }
  }

  /** Delay before the retry that follows `attempt` failures. */
  backoffMs(attempt: number): number {
    const { base_delay_seconds, max_delay_seconds } = this.config.retry;
    return Math.min(base_delay_seconds * 2 ** (attempt - 1), max_delay_seconds) * 1000;
  }

  /** Done with an item: state first, then queue, so a crash in between re-runs nothing applied twice. */
  private finish(item: QueueItem): void {
    if (!this.config.behaviours.dry_run) this.deps.state.flush();
    this.deps.queue.remove(item);
    this.deps.queue.save();
  }

  /** Move replay requests from the inbox onto the queue, forgetting their dedup ids. */
  ingestInbox(): void {
    const dir = resolve(this.config.retry.inbox_dir);
    let files: string[];
    try {
      files = readdirSync(dir).filter((f) => f.endsWith('.json')).sort();
    } catch {
      return; // no inbox yet
    }
    const { queue, state, log } = this.deps;
    for (const file of files) {
      const path = join(dir, file);
      try {
        const request = JSON.parse(readFileSync(path, 'utf8')) as ReplayRequest;
        const at = this.now().toISOString();
        for (const { action, context } of request.items ?? []) {
          if (queue.has(action.id)) continue;
          state.delete(action.id);
          queue.push({ action, context: context ?? {}, attempts: 0, enqueued_at: at, next_at: at });
          this.record(action, context ?? {}, 'replay_queued');
        }
        state.flush();
        queue.save();
        unlinkSync(path);
      } catch (err) {
        log.error({ file: path, err: String(err) }, 'unreadable replay request, moved aside');
        try {
          renameSync(path, `${path}.bad`);
        } catch {
          /* already gone */
        }
      }
    }
  }

  private record(action: JiraAction, context: AuditContext, outcome: AuditOutcome, extra: Partial<AuditEntry> = {}): void {
    this.deps.audit.record({
      ...context,
      kind: action.kind,
      outcome,
      // An MR note's key is a queue-ordering key, not a Jira ticket.
      ...(action.kind === 'mr_note' ? { mr_iid: action.mr_iid } : { key: action.key }),
      action_id: action.id,
      ...(action.kind === 'labels' ? { add: action.add, remove: action.remove } : { comment: action.text }),
      ...extra,
    });
  }
}

/** Written by the CLI: atomic, so the worker never reads half a file. */
export function writeReplayRequest(inboxDir: string, request: ReplayRequest): string {
  const dir = resolve(inboxDir);
  mkdirSync(dir, { recursive: true });
  const name = `${Date.now()}-${randomBytes(4).toString('hex')}.json`;
  const tmp = join(dir, `${name}.tmp`);
  writeFileSync(tmp, JSON.stringify(request));
  renameSync(tmp, join(dir, name));
  return join(dir, name);
}
