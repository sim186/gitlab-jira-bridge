import { describe, expect, it } from 'vitest';
import type { Config } from '../config/schema.js';
import { configSchema } from '../config/schema.js';
import type { MergeRequestPayload } from '../gitlab/webhook.js';
import { MISSING_KEY_MARKER, planActions } from './actions.js';

function makeConfig(overrides: Record<string, unknown> = {}): Config {
  return configSchema.parse({
    gitlab: { url: 'https://gitlab.example.com', webhook_secret: 'secret-value', token: 't' },
    jira: { base_url: 'https://jira.example.com', email: 'bot@x', api_token: 't', project_keys: ['ABC'] },
    behaviours: { comment_on_missing_key: true },
    ...overrides,
  });
}

function mr(attrs: Partial<MergeRequestPayload['object_attributes']>, extra: Partial<MergeRequestPayload> = {}): MergeRequestPayload {
  return {
    object_kind: 'merge_request',
    action: 'open',
    user: { username: 'alice' },
    project: { id: 77, path_with_namespace: 'g/p' },
    reviewers: [{ username: 'bob' }],
    object_attributes: {
      id: 900,
      iid: 42,
      title: 'Fix login',
      source_branch: 'fix-login',
      target_branch: 'main',
      state: 'opened',
      url: 'https://gitlab.example.com/g/p/-/merge_requests/42',
      ...attrs,
    },
    ...extra,
  } as MergeRequestPayload;
}

describe('missing-key MR note', () => {
  it('plans one note on open when no key is found', () => {
    const plan = planActions(mr({}), makeConfig());
    expect(plan.skipped).toBe('no Jira key in title/branch/description');
    expect(plan.actions).toHaveLength(1);
    const note = plan.actions[0]!;
    expect(note).toMatchObject({ kind: 'mr_note', id: '900:missing-key-note', project_id: 77, mr_iid: 42, key: 'gitlab:77!42' });
    const text = (note as { text: string }).text;
    expect(text.startsWith(MISSING_KEY_MARKER)).toBe(true);
    expect(text).toContain('No Jira ticket key was found');
    expect(text).toContain('`ABC-123 Fix login`');
  });

  it('explains an ambiguous title and names the keys', () => {
    const plan = planActions(mr({ title: 'ABC-1 and ABC-2 together' }), makeConfig());
    const text = (plan.actions[0] as { text: string }).text;
    expect(text).toContain('The title mentions several Jira tickets (`ABC-1`, `ABC-2`)');
    expect(plan.skipped).toBe('ambiguous: title names ABC-1, ABC-2');
  });

  it('is off unless comment_on_missing_key is on', () => {
    const config = makeConfig({ behaviours: { comment_on_missing_key: false } });
    expect(planActions(mr({}), config).actions).toEqual([]);
  });

  it('only fires on open, reopen and title/description edits', () => {
    const config = makeConfig();
    expect(planActions(mr({}, { action: 'reopen' }), config).actions).toHaveLength(1);
    expect(planActions(mr({}, { action: 'update', changes: { title: { previous: 'x', current: 'Fix login' } } }), config).actions).toHaveLength(1);
    expect(planActions(mr({}, { action: 'update', changes: { reviewer: { previous: null, current: {} } } }), config).actions).toEqual([]);
    expect(planActions(mr({}, { action: 'approved', event_type: 'approval' }), config).actions).toEqual([]);
    expect(planActions(mr({ state: 'merged' }, { action: 'update', changes: { title: { previous: 'x', current: 'y' } } }), config).actions).toEqual([]);
  });

  it('skips listed authors and branch prefixes', () => {
    const config = makeConfig({ missing_key: { skip_authors: ['renovate-bot'], skip_branches: ['renovate/'] } });
    expect(planActions(mr({}, { user: { username: 'renovate-bot' } }), config).actions).toEqual([]);
    expect(planActions(mr({ source_branch: 'renovate/lodash-4.x' }), config).actions).toEqual([]);
    expect(planActions(mr({}), config).actions).toHaveLength(1);
  });

  it('does not comment when the key is only in a lowercase branch and project_keys is set', () => {
    const plan = planActions(mr({ source_branch: 'feature/abc-12-login' }), makeConfig());
    expect(plan.actions.map((a) => a.kind)).toEqual(['comment', 'labels']);
    expect(plan.actions[0]!.key).toBe('ABC-12');
  });

  it('stays silent, and plans nothing, for a key of an untracked Jira project', () => {
    const config = makeConfig({
      jira: {
        base_url: 'https://jira.example.com',
        email: 'bot@x',
        api_token: 't',
        project_keys: ['ABC'],
        other_project_keys: ['DEF'],
      },
    });
    const plan = planActions(mr({ title: 'Tower merge', source_branch: 'feat/def-156-tower-merge' }), config);
    expect(plan.actions).toEqual([]);
    expect(plan.skipped).toBe('foreign: branch names DEF-156 (not a tracked Jira project)');
  });
});

describe('MR becomes linked', () => {
  const update = (previous: string, current: string) =>
    mr({ title: current }, { action: 'update', changes: { title: { previous, current } } });

  it('replays the open actions when the title edit adds the key', () => {
    const plan = planActions(update('Fix login', 'ABC-5 Fix login'), makeConfig());
    expect(plan.actions).toEqual([
      expect.objectContaining({ kind: 'comment', id: '900:ABC-5:open-comment', key: 'ABC-5' }),
      expect.objectContaining({ kind: 'labels', id: '900:ABC-5:open-labels', add: ['needs-review', 'reviewer-bob'] }),
    ]);
  });

  it('replays when an ambiguous title is narrowed to one key', () => {
    const plan = planActions(update('ABC-1 and ABC-2', 'ABC-1 Fix login'), makeConfig());
    expect(plan.actions.map((a) => a.id)).toEqual(['900:ABC-1:open-comment', '900:ABC-1:open-labels']);
  });

  it('replays for the new ticket when the title moves the MR to a different key', () => {
    const plan = planActions(update('ABC-1 Fix', 'ABC-9 Fix'), makeConfig());
    expect(plan.actions.map((a) => [a.id, a.key])).toEqual([
      ['900:ABC-9:open-comment', 'ABC-9'],
      ['900:ABC-9:open-labels', 'ABC-9'],
    ]);
  });

  it('replays when the title key overrides a key that came from the description', () => {
    const p = mr(
      { title: 'ABC-7 Fix login', description: 'Follow-up of ABC-2' },
      { action: 'update', changes: { title: { previous: 'Fix login', current: 'ABC-7 Fix login' } } },
    );
    expect(planActions(p, makeConfig()).actions.map((a) => a.key)).toEqual(['ABC-7', 'ABC-7']);
  });

  it('does nothing extra when the key was there before the edit', () => {
    expect(planActions(update('ABC-5 Fix', 'ABC-5 Fix login'), makeConfig()).actions).toEqual([]);
  });
});
