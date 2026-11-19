import { mkdtempSync, readFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AuditLog } from './audit.js';

function tempFile(): string {
  return join(mkdtempSync(join(tmpdir(), 'gjb-audit-')), 'nested', 'audit.jsonl');
}

describe('AuditLog', () => {
  it('appends one JSON line per entry with a timestamp', () => {
    const file = tempFile();
    const audit = new AuditLog(file, undefined, () => new Date('2026-11-01T10:00:00Z'));
    audit.record({ kind: 'labels', outcome: 'applied', key: 'ABC-1', add: ['merged'], remove: [] });
    audit.record({ kind: 'webhook', outcome: 'skipped', detail: 'no key' });

    const lines = readFileSync(file, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]!)).toMatchObject({ at: '2026-11-01T10:00:00.000Z', key: 'ABC-1' });
  });

  it('lists newest first and filters by key, MR, outcome prefix and date', () => {
    let t = Date.parse('2026-11-01T00:00:00Z');
    const audit = new AuditLog(tempFile(), undefined, () => new Date((t += 86_400_000)));
    audit.record({ kind: 'labels', outcome: 'applied', key: 'ABC-1', mr_iid: 7 }); // 11-02
    audit.record({ kind: 'comment', outcome: 'failed_transient', key: 'ABC-1', mr_iid: 7 }); // 11-03
    audit.record({ kind: 'labels', outcome: 'failed_permanent', key: 'XYZ-9', mr_iid: 8 }); // 11-04

    expect(audit.list().map((r) => r.key)).toEqual(['XYZ-9', 'ABC-1', 'ABC-1']);
    expect(audit.list({ key: 'ABC-1' })).toHaveLength(2);
    expect(audit.list({ mr_iid: 8 })).toHaveLength(1);
    expect(audit.list({ outcome: 'failed' })).toHaveLength(2);
    expect(audit.list({ since: '2026-11-03', until: '2026-11-03' }).map((r) => r.kind)).toEqual(['comment']);
    expect(audit.list({ limit: 1 })[0]!.key).toBe('XYZ-9');
  });

  it('truncates long comments', () => {
    const audit = new AuditLog(tempFile());
    audit.record({ kind: 'comment', outcome: 'applied', comment: 'x'.repeat(2000) });
    expect(audit.list()[0]!.comment!.length).toBe(500);
  });

  it('skips a torn line instead of failing', () => {
    const file = tempFile();
    const audit = new AuditLog(file);
    audit.record({ kind: 'webhook', outcome: 'skipped' });
    appendFileSync(file, '{"at":"2026-11-0');
    expect(audit.list()).toHaveLength(1);
  });

  it('prunes entries older than the retention window', () => {
    let now = new Date('2026-01-01T00:00:00Z');
    const audit = new AuditLog(tempFile(), undefined, () => now);
    audit.record({ kind: 'webhook', outcome: 'skipped', detail: 'old' });
    now = new Date('2026-03-01T00:00:00Z');
    audit.record({ kind: 'webhook', outcome: 'skipped', detail: 'new' });

    expect(audit.prune(30)).toBe(1);
    expect(audit.list().map((r) => r.detail)).toEqual(['new']);
    expect(audit.prune(30)).toBe(0);
  });

  it('reports a write failure instead of throwing', () => {
    const errors: unknown[] = [];
    const dir = mkdtempSync(join(tmpdir(), 'gjb-audit-'));
    // The path is a directory, so appending to it fails.
    const audit = new AuditLog(join(dir, '.'), (err) => errors.push(err));
    expect(() => audit.record({ kind: 'webhook', outcome: 'skipped' })).not.toThrow();
    expect(errors).toHaveLength(1);
  });
});
