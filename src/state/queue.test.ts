import { mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ActionQueue, type QueueItem } from './queue.js';

const item = (id: string, key: string, next_at: string): QueueItem => ({
  action: { kind: 'comment', id, key, text: id },
  context: {},
  attempts: 0,
  enqueued_at: next_at,
  next_at,
});

const T0 = '2026-11-19T10:00:00.000Z';
const T1 = '2026-11-19T10:05:00.000Z';

describe('ActionQueue', () => {
  it('blocks later items for a ticket behind an earlier waiting one', () => {
    const q = new ActionQueue(join(mkdtempSync(join(tmpdir(), 'gjb-q-')), 'q.json'));
    q.push(item('a1', 'A', T1)); // retrying, due later
    q.push(item('a2', 'A', T0)); // due now, but behind a1
    q.push(item('b1', 'B', T0));
    expect(q.nextEligible(new Date(T0))?.action.id).toBe('b1');
  });

  it('nextDue ignores blocked items, so the timer does not spin', () => {
    const q = new ActionQueue(join(mkdtempSync(join(tmpdir(), 'gjb-q-')), 'q.json'));
    q.push(item('a1', 'A', T1));
    q.push(item('a2', 'A', T0));
    expect(q.nextDue()).toBe(T1);
  });

  it('round-trips through save and reload', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'gjb-q-')), 'q.json');
    const q = new ActionQueue(file);
    q.push(item('a', 'A', T0));
    q.save();
    expect(new ActionQueue(file).all().map((i) => i.action.id)).toEqual(['a']);
  });

  it('moves a corrupt file aside instead of overwriting it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gjb-q-'));
    writeFileSync(join(dir, 'q.json'), '{not json');
    expect(new ActionQueue(join(dir, 'q.json')).size).toBe(0);
    expect(readdirSync(dir).some((f) => f.startsWith('q.json.corrupt-'))).toBe(true);
  });
});
