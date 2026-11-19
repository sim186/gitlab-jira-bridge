import { describe, expect, it } from 'vitest';
import type { Config } from '../config/schema.js';
import { planActions, planPipelineActions } from './actions.js';
import type {
  MergeRequestAttributes,
  MergeRequestPayload,
  PipelinePayload,
} from '../gitlab/webhook.js';

const config = {
  jira: { key_regex: '\\b([A-Z][A-Z0-9]+-\\d+)\\b', key_ignore_regex: '^$' },
  labels: {
    needs_review: 'needs-review',
    reviewer_prefix: 'reviewer-',
    approved: 'approved',
    merged: 'merged',
    closed: '',
    conflict: 'blocked-by-conflict',
    draft: 'draft',
    ci_failing: 'ci-failing',
  },
  behaviours: {
    comment_on_open: true,
    comment_on_merge: true,
    comment_on_reviewer: false,
    reviewer_labels: true,
    conflict_labels: true,
    draft_labels: true,
    ci_fail_labels: true,
    dry_run: false,
  },
} as unknown as Config;

type PayloadOverrides = Partial<Omit<MergeRequestPayload, 'object_attributes'>> & {
  object_attributes?: Partial<MergeRequestAttributes>;
};

function payload(overrides: PayloadOverrides): MergeRequestPayload {
  const { object_attributes: attrsOverride, ...rest } = overrides;
  return {
    object_kind: 'merge_request',
    object_attributes: {
      id: 900,
      iid: 42,
      title: 'ABC-123 Add the thing',
      source_branch: 'feature/abc-123',
      target_branch: 'main',
      url: 'https://gitlab.example.com/g/p/-/merge_requests/42',
      ...attrsOverride,
    },
    ...rest,
  } as MergeRequestPayload;
}

describe('planActions', () => {
  it('comments the branch on open', () => {
    const plan = planActions(payload({ action: 'open' }), config);
    expect(plan.actions).toHaveLength(1);
    const [comment] = plan.actions;
    expect(comment!.kind).toBe('comment');
    expect((comment! as { text: string }).text).toContain('feature/abc-123');
  });

  it('writes an open comment with an emoji, arrows and a link to the MR', () => {
    const plan = planActions(
      payload({ action: 'open', project: { id: 2, path_with_namespace: 'group/project' } }),
      config,
    );
    const comment = plan.actions.find((a) => a.kind === 'comment')! as { text: string };
    expect(comment.text).toBe(
      '🔀 Merge request opened: `feature/abc-123` → `main`\n' +
        '[group/project !42](https://gitlab.example.com/g/p/-/merge_requests/42)',
    );
  });

  it('adds needs-review and reviewer label when reviewer set on update', () => {
    const plan = planActions(
      payload({
        action: 'update',
        changes: { reviewer: { previous: null, current: { username: 'simone' } } },
        reviewers: [{ username: 'simone' }],
      }),
      config,
    );
    expect(plan.actions).toHaveLength(1);
    const action = plan.actions[0]!;
    expect(action.kind).toBe('labels');
    expect((action as { add: string[] }).add).toEqual(['reviewer-simone', 'needs-review']);
    expect((action as { remove: string[] }).remove).toEqual([]);
  });

  it('swaps reviewer labels when the reviewer changes', () => {
    const plan = planActions(
      payload({
        action: 'update',
        changes: { reviewer: { previous: { username: 'old' }, current: { username: 'new' } } },
        reviewers: [{ username: 'new' }],
      }),
      config,
    );
    const action = plan.actions[0]! as { add: string[]; remove: string[] };
    expect(action.add).toEqual(['reviewer-new', 'needs-review']);
    expect(action.remove).toEqual(['reviewer-old']);
  });

  it('lowercases reviewer labels and removes the old mixed-case form', () => {
    const plan = planActions(
      payload({
        action: 'update',
        changes: { reviewer: { previous: { username: 'Old.Name' }, current: { username: 'New_Name' } } },
        reviewers: [{ username: 'New_Name' }],
      }),
      config,
    );
    const action = plan.actions[0]! as { add: string[]; remove: string[] };
    expect(action.add).toEqual(['reviewer-new_name', 'needs-review']);
    expect(action.remove).toEqual(['reviewer-old.name', 'reviewer-Old.Name']);
  });

  it('merging adds merged and cleans up review labels', () => {
    const plan = planActions(
      payload({
        action: 'merge',
        reviewers: [{ username: 'simone' }],
        object_attributes: {
          merge_commit_sha: 'deadbeefcafebabe1234567890',
        },
      }),
      config,
    );
    const labels = plan.actions.find((a) => a.kind === 'labels')! as { add: string[]; remove: string[] };
    expect(labels.add).toEqual(['merged']);
    expect(labels.remove).toEqual([
      'needs-review',
      'approved',
      'blocked-by-conflict',
      'ci-failing',
      'reviewer-simone',
    ]);
    const comment = plan.actions.find((a) => a.kind === 'comment')! as { text: string };
    expect(comment.text).toContain('deadbeefcafe');
    expect(comment.text).toContain('feature/abc-123');
    expect(comment.text).toMatch(/^✅ Merged: `feature\/abc-123` → `main` as `deadbeefcafe`/);
  });

  it('approval adds approved and removes needs-review', () => {
    const plan = planActions(
      payload({ event_type: 'approval', approval: { approved: true } }),
      config,
    );
    const action = plan.actions[0]! as { add: string[]; remove: string[] };
    expect(action.add).toEqual(['approved']);
    expect(action.remove).toEqual(['needs-review']);
  });

  it('skips when no key can be extracted', () => {
    const plan = planActions(payload({ object_attributes: { title: 'no ticket', iid: 1 } }), config);
    expect(plan.actions).toHaveLength(0);
    expect(plan.skipped).toContain('no Jira key');
  });

  it('is silent for unmapped actions', () => {
    const plan = planActions(payload({ action: 'update', changes: { title: { previous: 'ABC-123 Old name', current: 'ABC-123 Add the thing' } } }), config);
    expect(plan.actions).toHaveLength(0);
  });

  it('action ids are stable for redelivery dedup', () => {
    const p = payload({
      action: 'update',
      changes: { reviewer: { previous: null, current: { username: 'simone' } } },
      reviewers: [{ username: 'simone' }],
    });
    const a = planActions(p, config).actions[0]!;
    const b = planActions(p, config).actions[0]!;
    expect(a.id).toBe(b.id);
  });

  describe('conflict transitions', () => {
    it('labels when the MR becomes conflicted', () => {
      const plan = planActions(
        payload({
          action: 'update',
          object_attributes: { updated_at: '2026-01-02T10:00:00Z' },
          changes: { merge_status: { previous: 'can_be_merged', current: 'cannot_be_merged' } },
        }),
        config,
      );
      const action = plan.actions[0]! as { add: string[]; remove: string[] };
      expect(action.add).toEqual(['blocked-by-conflict']);
      expect(action.remove).toEqual([]);
    });

    it('clears when the conflict is resolved', () => {
      const plan = planActions(
        payload({
          action: 'update',
          changes: { merge_status: { previous: 'cannot_be_merged', current: 'can_be_merged' } },
        }),
        config,
      );
      const action = plan.actions[0]! as { add: string[]; remove: string[] };
      expect(action.add).toEqual([]);
      expect(action.remove).toEqual(['blocked-by-conflict']);
    });

    it('ignores uninformative checking transitions', () => {
      const plan = planActions(
        payload({
          action: 'update',
          changes: { merge_status: { previous: 'unchecked', current: 'checking' } },
        }),
        config,
      );
      expect(plan.actions).toHaveLength(0);
    });

    it('refires the same conflict twice when timestamps differ', () => {
      const first = planActions(
        payload({
          action: 'update',
          object_attributes: { updated_at: '2026-01-02T10:00:00Z' },
          changes: { merge_status: { previous: 'can_be_merged', current: 'cannot_be_merged' } },
        }),
        config,
      ).actions[0]!;
      const second = planActions(
        payload({
          action: 'update',
          object_attributes: { updated_at: '2026-01-05T09:00:00Z' },
          changes: { merge_status: { previous: 'can_be_merged', current: 'cannot_be_merged' } },
        }),
        config,
      ).actions[0]!;
      expect(first.id).not.toBe(second.id);
    });
  });

  describe('draft toggles', () => {
    it('labels draft and withdraws needs-review', () => {
      const plan = planActions(
        payload({
          action: 'update',
          reviewers: [{ username: 'simone' }],
          changes: { draft: { previous: false, current: true } },
        }),
        config,
      );
      const action = plan.actions[0]! as { add: string[]; remove: string[] };
      expect(action.add).toEqual(['draft']);
      expect(action.remove).toEqual(['needs-review']);
    });

    it('resumes needs-review when marked ready with reviewers set', () => {
      const plan = planActions(
        payload({
          action: 'update',
          reviewers: [{ username: 'simone' }],
          changes: { draft: { previous: true, current: false } },
        }),
        config,
      );
      const action = plan.actions[0]! as { add: string[]; remove: string[] };
      expect(action.add).toEqual(['needs-review']);
      expect(action.remove).toEqual(['draft']);
    });

    it('detects WIP toggles made through the title', () => {
      const plan = planActions(
        payload({
          action: 'update',
          changes: {
            title: { previous: 'ABC-123 Add the thing', current: 'WIP: ABC-123 Add the thing' },
          },
        }),
        config,
      );
      const action = plan.actions[0]! as { add: string[] };
      expect(action.add).toEqual(['draft']);
    });

    it('open with draft true labels draft, not needs-review', () => {
      const plan = planActions(
        payload({
          action: 'open',
          reviewers: [{ username: 'simone' }],
          object_attributes: { draft: true },
        }),
        config,
      );
      const labels = plan.actions.find((a) => a.kind === 'labels')! as { add: string[] };
      expect(labels.add).toEqual(['draft']);
    });
  });

  describe('pipeline events', () => {
    function pipeline(
      overrides: Partial<PipelinePayload['object_attributes']>,
    ): PipelinePayload {
      return {
        object_kind: 'pipeline',
        object_attributes: {
          id: 700,
          ref: 'ABC-123-feature',
          status: 'failed',
          updated_at: '2026-01-02T10:00:00Z',
          ...overrides,
        },
      } as PipelinePayload;
    }

    it('labels failures', () => {
      const plan = planPipelineActions(pipeline({}), config);
      const action = plan.actions[0]! as { add: string[]; key: string };
      expect(action.key).toBe('ABC-123');
      expect(action.add).toEqual(['ci-failing']);
    });

    it('success only removes the label', () => {
      const plan = planPipelineActions(pipeline({ status: 'success' }), config);
      const action = plan.actions[0]! as { add: string[]; remove: string[] };
      expect(action.add).toEqual([]);
      expect(action.remove).toEqual(['ci-failing']);
    });

    it('running is ignored', () => {
      expect(planPipelineActions(pipeline({ status: 'running' }), config).actions).toHaveLength(0);
    });

    it('skips refs with no ticket key', () => {
      const plan = planPipelineActions(pipeline({ ref: 'main' }), config);
      expect(plan.actions).toHaveLength(0);
      expect(plan.skipped).toContain('no Jira key');
    });
  });
});
