/**
 * Persistent set of action ids already executed, so webhook redeliveries and
 * process restarts do not duplicate comments or churn labels.
 *
 * Deliberately simple: a JSON array on disk, trimmed to the most recent
 * `maxEntries` ids. Older ids are assumed to refer to long-closed MRs.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const DEFAULT_MAX = 50_000;

export class DedupeStore {
  private readonly path: string;
  private readonly max: number;
  private seen: Set<string>;

  constructor(path: string, max = DEFAULT_MAX) {
    this.path = resolve(path);
    this.max = max;
    this.seen = this.load();
  }

  private load(): Set<string> {
    if (!existsSync(this.path)) return new Set();
    try {
      const ids = JSON.parse(readFileSync(this.path, 'utf8')) as string[];
      return new Set(ids.slice(-this.max));
    } catch {
      // A corrupt state file must not take the bridge down; start fresh.
      return new Set();
    }
  }

  has(id: string): boolean {
    return this.seen.has(id);
  }

  add(id: string): void {
    if (this.seen.has(id)) return;
    this.seen.add(id);
    if (this.seen.size > this.max) {
      this.seen = new Set([...this.seen].slice(-this.max));
    }
  }

  /** Forget an id so the action can run again (used by replay). */
  delete(id: string): void {
    this.seen.delete(id);
  }

  /** Atomic write: temp file then rename, so a crash cannot truncate state. */
  flush(): void {
    const dir = dirname(this.path);
    mkdirSync(dir, { recursive: true });
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify([...this.seen], null, 0));
    renameSync(tmp, this.path);
  }
}
