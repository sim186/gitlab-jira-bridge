import { describe, expect, it } from 'vitest';
import { parseMergeRequestEvent, verifyToken } from './webhook.js';

const secret = 'test-secret-value';

describe('verifyToken', () => {
  it('accepts the configured token', () => {
    expect(verifyToken(secret, secret)).toBe(true);
  });

  it('rejects a different token of the same length', () => {
    expect(verifyToken('test-secret-valuX', secret)).toBe(false);
  });

  it('rejects a token of a different length without throwing', () => {
    expect(verifyToken('short', secret)).toBe(false);
    expect(verifyToken(secret + 'x', secret)).toBe(false);
  });

  it('rejects a missing or empty header', () => {
    expect(verifyToken(undefined, secret)).toBe(false);
    expect(verifyToken('', secret)).toBe(false);
  });

  it('does not accept the old HMAC header format', () => {
    expect(verifyToken('sha256=0000', secret)).toBe(false);
  });
});

describe('parseMergeRequestEvent', () => {
  it('accepts MR events with an object id', () => {
    const payload = parseMergeRequestEvent({
      object_kind: 'merge_request',
      object_attributes: { id: 1, iid: 1, title: 'x', source_branch: 'a', target_branch: 'b' },
    });
    expect(payload).not.toBeNull();
  });

  it('ignores non-MR kinds', () => {
    expect(parseMergeRequestEvent({ object_kind: 'push' })).toBeNull();
    expect(parseMergeRequestEvent(null)).toBeNull();
  });

  it('ignores MR events without object_attributes.id', () => {
    expect(parseMergeRequestEvent({ object_kind: 'merge_request', object_attributes: {} })).toBeNull();
  });
});
