/**
 * Persistent FIFO of Jira actions waiting to be applied.
 *
 * Every planned action goes through here, so the webhook can answer GitLab as
 * soon as the queue is on disk (GitLab waits ~10s and does not retry failed
 * deliveries on its own). Failed actions stay in place with a later `next_at`.
 *
 * Order is preserved per ticket: an item is only eligible when no earlier item
 * for the same Jira key is still waiting. Without that, a retried
 * "+needs-review" could land after the "+merged" that followed it.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { JiraAction } from '../domain/actions.js';
import type { AuditEntry } from './audit.js';

/** Delivery-level fields copied onto every audit entry for an action. */
export type AuditContext = Pick<AuditEntry, 'delivery' | 'source_ip' | 'event' | 'project' | 'mr_iid' | 'ref'>;

export type QueueItem = {
  action: JiraAction;
  context: AuditContext;
  /** Attempts already made. */
  attempts: number;
  enqueued_at: string;
  next_at: string;
  last_error?: string;
};

export class ActionQueue {
  private readonly path: string;
  private items: QueueItem[];

  constructor(path: string) {
    this.path = resolve(path);
    this.items = this.load();
  }

  private load(): QueueItem[] {
    if (!existsSync(this.path)) return [];
    try {
      const parsed = JSON.parse(readFileSync(this.path, 'utf8')) as unknown;
      return Array.isArray(parsed) ? (parsed as QueueItem[]) : [];
    } catch {
      // Keep the unreadable file for inspection instead of overwriting it on the next save.
      renameSync(this.path, `${this.path}.corrupt-${Date.now()}`);
      return [];
    }
  }

  get size(): number {
    return this.items.length;
  }

  all(): readonly QueueItem[] {
    return this.items;
  }

  has(actionId: string): boolean {
    return this.items.some((i) => i.action.id === actionId);
  }

  push(item: QueueItem): void {
    this.items.push(item);
  }

  /** First item that is due and not blocked by an earlier item for the same ticket. */
  nextEligible(now: Date): QueueItem | undefined {
    const blocked = new Set<string>();
    const at = now.toISOString();
    for (const item of this.items) {
      if (!blocked.has(item.action.key) && item.next_at <= at) return item;
      blocked.add(item.action.key);
    }
    return undefined;
  }

  /**
   * When the next item becomes eligible. Only the first waiting item per ticket
   * counts: a later one for the same key may be "due" but is blocked behind it.
   */
  nextDue(): string | undefined {
    const seen = new Set<string>();
    let min: string | undefined;
    for (const item of this.items) {
      if (seen.has(item.action.key)) continue;
      seen.add(item.action.key);
      if (!min || item.next_at < min) min = item.next_at;
    }
    return min;
  }

  remove(item: QueueItem): void {
    this.items = this.items.filter((i) => i !== item);
  }

  /** Atomic write: temp file then rename. */
  save(): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.items));
    renameSync(tmp, this.path);
  }
}

/** Read-only view for the CLI, which must not race the server's writes. */
export function readQueueFile(path: string): QueueItem[] {
  const file = resolve(path);
  if (!existsSync(file)) return [];
  return JSON.parse(readFileSync(file, 'utf8')) as QueueItem[];
}
