import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DedupeStore } from './dedup.js';

function tempPath(): string {
  return join(mkdtempSync(join(tmpdir(), 'bridge-')), 'state.json');
}

describe('DedupeStore', () => {
  it('round-trips through flush and reload', () => {
    const path = tempPath();
    const a = new DedupeStore(path);
    a.add('x:1');
    a.flush();
    const b = new DedupeStore(path);
    expect(b.has('x:1')).toBe(true);
    expect(b.has('x:2')).toBe(false);
  });

  it('survives a corrupt state file', () => {
    const path = tempPath();
    writeFileSync(path, 'not json {{{');
    const store = new DedupeStore(path);
    expect(store.has('anything')).toBe(false);
  });

  it('trims to maxEntries', () => {
    const path = tempPath();
    const store = new DedupeStore(path, 3);
    for (const id of ['1', '2', '3', '4']) store.add(id);
    store.flush();
    const reloaded = new DedupeStore(path);
    expect(reloaded.has('1')).toBe(false);
    expect(reloaded.has('4')).toBe(true);
  });
});
