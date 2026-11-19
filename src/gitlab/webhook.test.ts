import { describe, expect, it } from 'vitest';
import { currentReviewers, parseMergeRequestEvent, previousReviewers, verifyToken } from './webhook.js';
import type { MergeRequestPayload } from './webhook.js';

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

describe('reviewer changes', () => {
  const mr = (changes: Record<string, unknown>, reviewers: { username: string }[]) =>
    ({ object_attributes: {}, reviewers, changes }) as unknown as MergeRequestPayload;

  it('reads the current GitLab shape: changes.reviewers with a list', () => {
    // This is what GitLab 19 actually sends; the singular `reviewer` key is not used any more.
    const payload = mr({ reviewers: { previous: [], current: [{ username: 'simone' }] } }, [{ username: 'simone' }]);
    expect(currentReviewers(payload)).toEqual(['simone']);
    expect(previousReviewers(payload)).toEqual([]);
  });

  it('reads the older shape: changes.reviewer with a single user', () => {
    const payload = { object_attributes: {}, changes: { reviewer: { previous: { username: 'bob' }, current: { username: 'alice' } } } } as unknown as MergeRequestPayload;
    expect(currentReviewers(payload)).toEqual(['alice']);
    expect(previousReviewers(payload)).toEqual(['bob']);
  });

  it('reports removals from the list shape', () => {
    const payload = { object_attributes: {}, changes: { reviewers: { previous: [{ username: 'bob' }], current: [] } } } as unknown as MergeRequestPayload;
    expect(currentReviewers(payload)).toEqual([]);
    expect(previousReviewers(payload)).toEqual(['bob']);
  });
});
