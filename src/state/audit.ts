/**
 * Append-only audit trail of everything the bridge did, or decided not to do.
 *
 * One JSON object per line in `audit.file`. Lines are only ever appended; the
 * single exception is retention pruning, which rewrites the file atomically
 * without entries older than `retention_days`. JSONL rather than a database so
 * the trail stays readable with `tail -f`, `grep` and `jq` on any host.
 *
 * The question this answers is "why does (or doesn't) ABC-123 carry this
 * label?" — so webhook deliveries that planned nothing are recorded too, with
 * the reason, not just the Jira writes.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { JiraAction } from '../domain/actions.js';

export type AuditOutcome =
  /** Jira was written. */
  | 'applied'
  /** Jira already had the requested labels; nothing was written. */
  | 'unchanged'
  /** dry_run is on; the write was logged instead. */
  | 'dry_run'
  /** The action id was already processed (webhook redelivery or restart). */
  | 'duplicate'
  /** Jira refused permanently (4xx); marked done, will not retry. */
  | 'failed_permanent'
  /** Jira or network error (5xx/429/timeout); a retry is scheduled. */
  | 'failed_transient'
  /** Still failing after retry.max_attempts; dropped from the queue. Replayable. */
  | 'abandoned'
  /** Put back on the queue by `bridge replay`. */
  | 'replay_queued'
  /** The delivery was refused before planning (bad token, bad JSON). */
  | 'rejected'
  /** The delivery was valid but produced no actions (no key, event not handled…). */
  | 'skipped';

export type AuditEntry = {
  /** GitLab's X-Gitlab-Event-UUID, linking every entry from one delivery. */
  delivery?: string;
  source_ip?: string;
  /** merge_request | approval | pipeline | unknown */
  event?: string;
  /** labels / comment: Jira writes. mr_note: the GitLab missing-key comment. webhook: delivery-level. */
  kind: 'labels' | 'comment' | 'mr_note' | 'webhook';
  outcome: AuditOutcome;
  /** Jira ticket key. */
  key?: string;
  /** Deterministic action id from the planner, also the dedup key. */
  action_id?: string;
  project?: string;
  mr_iid?: number;
  ref?: string;
  add?: string[];
  remove?: string[];
  /** Ticket labels before/after the write, when the client read them. */
  before?: string[];
  after?: string[];
  comment?: string;
  /** Reason for skipped/rejected, or the error message for failures. */
  detail?: string;
  /** 1-based attempt number, on entries from the retry queue. */
  attempt?: number;
  /**
   * The complete action, kept on failed_permanent and abandoned entries so
   * `bridge replay` can re-queue exactly what was planned.
   */
  action?: JiraAction;
};

export type AuditRow = AuditEntry & { at: string };

export type AuditFilter = {
  key?: string;
  mr_iid?: number;
  /** Prefix match, so `failed` covers both failure outcomes. */
  outcome?: string;
  delivery?: string;
  /** ISO date or timestamp; inclusive. */
  since?: string;
  until?: string;
  /** Newest first; default 100. */
  limit?: number;
};

/** Comments can be long; the trail keeps enough to recognise one. */
const MAX_COMMENT = 500;

export interface AuditSink {
  record(entry: AuditEntry): void;
}

/** Used when `audit.enabled` is false, and in tests that do not care. */
export const noopAudit: AuditSink = { record: () => {} };

export class AuditLog implements AuditSink {
  private readonly path: string;

  constructor(
    path: string,
    private readonly onError: (err: unknown) => void = () => {},
    private readonly now: () => Date = () => new Date(),
  ) {
    this.path = resolve(path);
    mkdirSync(dirname(this.path), { recursive: true });
  }

  /**
   * Never throws: a full disk or a permissions problem on the audit file must
   * not turn a successful Jira write into a failed webhook (and a redelivery
   * that would then be deduplicated anyway). The failure is reported instead.
   */
  record(entry: AuditEntry): void {
    const row: AuditRow = { at: this.now().toISOString(), ...entry };
    if (row.comment && row.comment.length > MAX_COMMENT) {
      row.comment = `${row.comment.slice(0, MAX_COMMENT - 1)}…`;
    }
    try {
      appendFileSync(this.path, `${JSON.stringify(row)}\n`);
    } catch (err) {
      this.onError(err);
    }
  }

  private readAll(): AuditRow[] {
    if (!existsSync(this.path)) return [];
    const rows: AuditRow[] = [];
    for (const line of readFileSync(this.path, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        rows.push(JSON.parse(line) as AuditRow);
      } catch {
        // A torn last line (crash mid-append) is skipped, not fatal.
      }
    }
    return rows;
  }

  list(filter: AuditFilter = {}): AuditRow[] {
    const since = filter.since ? normaliseBound(filter.since, 'start') : undefined;
    const until = filter.until ? normaliseBound(filter.until, 'end') : undefined;
    const matches = this.readAll().filter(
      (r) =>
        (!filter.key || r.key === filter.key) &&
        (filter.mr_iid === undefined || r.mr_iid === filter.mr_iid) &&
        (!filter.outcome || r.outcome.startsWith(filter.outcome)) &&
        (!filter.delivery || r.delivery === filter.delivery) &&
        (!since || r.at >= since) &&
        (!until || r.at <= until),
    );
    return matches.reverse().slice(0, filter.limit ?? 100);
  }

  /** Drops entries older than `days`. Returns how many were removed. */
  prune(days: number): number {
    if (days <= 0 || !existsSync(this.path)) return 0;
    const cutoff = new Date(this.now().getTime() - days * 86_400_000).toISOString();
    const rows = this.readAll();
    const kept = rows.filter((r) => r.at >= cutoff);
    const removed = rows.length - kept.length;
    if (removed === 0) return 0;
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, kept.map((r) => `${JSON.stringify(r)}\n`).join(''));
    renameSync(tmp, this.path);
    return removed;
  }
}

/** `2026-11-01` becomes the start or end of that UTC day; timestamps pass through. */
function normaliseBound(value: string, side: 'start' | 'end'): string {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return side === 'start' ? `${value}T00:00:00.000Z` : `${value}T23:59:59.999Z`;
  }
  return new Date(value).toISOString();
}
