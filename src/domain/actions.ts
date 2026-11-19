/**
 * Event → action mapping. The only place that knows both GitLab semantics and
 * Jira vocabulary. Everything downstream (dedup, Jira client) is content-agnostic.
 *
 * An action id encodes the event that produced it so re-delivered webhooks and
 * restarts cannot fire it twice. State-transition actions (conflict, draft,
 * CI) additionally carry the event's `updated_at`: the same value can recur on
 * one MR (conflict → resolved → conflict again) and must fire again each time,
 * while a redelivery of one event keeps the identical timestamp and dedupes.
 */
import type { Config } from '../config/schema.js';
import { describeResolution, resolveJiraKey, type KeyOptions, type KeyResolution } from './jiraKey.js';
import {
  currentReviewers,
  previousReviewers,
  type ChangeEntry,
  type MergeRequestPayload,
  type PipelinePayload,
} from '../gitlab/webhook.js';

/**
 * Everything the bridge can do. `key` is the Jira ticket for the first two; for
 * an MR note it is `gitlab:<project>!<iid>`, which keeps the queue's per-key
 * ordering meaningful without pretending to be a ticket.
 */
export type JiraAction =
  | { kind: 'labels'; id: string; key: string; add: string[]; remove: string[] }
  | { kind: 'comment'; id: string; key: string; text: string }
  | { kind: 'mr_note'; id: string; key: string; project_id: number; mr_iid: number; text: string };

/** Hidden in GitLab's rendered markdown; lets the client find its own note again. */
export const MISSING_KEY_MARKER = '<!-- gitlab-jira-bridge:missing-key -->';

export type PlanResult = {
  actions: JiraAction[];
  /** Why nothing was planned, for the access log. */
  skipped?: string;
};

function sanitizeLabel(username: string): string {
  return username.replace(/[^a-zA-Z0-9._-]/g, '-');
}

/**
 * Jira labels are case-sensitive, so `reviewer-Alice` and `reviewer-alice` would
 * be two labels. New labels are always lowercase.
 */
function reviewerLabel(config: Config, username: string): string {
  return `${config.labels.reviewer_prefix}${sanitizeLabel(username).toLowerCase()}`;
}

/**
 * Labels to remove for a reviewer: the lowercase form plus the mixed-case form
 * that versions up to 0.1 wrote, so tickets labelled before the change still
 * get cleaned up.
 */
function reviewerLabelsToRemove(config: Config, usernames: string[]): string[] {
  const labels = usernames.flatMap((u) => [
    reviewerLabel(config, u),
    `${config.labels.reviewer_prefix}${sanitizeLabel(u)}`,
  ]);
  return [...new Set(labels)];
}

export function keyOptions(config: Config): KeyOptions {
  return {
    keyRegex: config.jira.key_regex,
    ignoreRegex: config.jira.key_ignore_regex,
    projectKeys: config.jira.project_keys,
    otherProjectKeys: config.jira.other_project_keys,
  };
}

const MR_FIELDS = ['title', 'branch', 'description'];

function resolveMrKey(payload: MergeRequestPayload, config: Config): KeyResolution {
  const attrs = payload.object_attributes;
  return resolveJiraKey(
    [
      { field: 'title', text: attrs.title },
      { field: 'branch', text: attrs.source_branch },
      { field: 'description', text: attrs.description },
    ],
    keyOptions(config),
  );
}

export function planActions(payload: MergeRequestPayload, config: Config): PlanResult {
  const resolution = resolveMrKey(payload, config);
  // A ticket of a project we do not act on: no labels, no comment, nothing to fix.
  if (resolution.status === 'foreign') {
    return { actions: [], skipped: describeResolution(resolution, MR_FIELDS) };
  }
  if (resolution.status !== 'found') {
    const note = missingKeyNote(payload, config, resolution);
    return {
      actions: note ? [note] : [],
      skipped: describeResolution(resolution, MR_FIELDS),
    };
  }
  const key = resolution.key;
  const attrs = payload.object_attributes;
  const mrId = attrs.id;
  const actions: JiraAction[] = [];

  const isApproval = payload.event_type === 'approval';
  const action = payload.action ?? attrs.action ?? '';
  const changes = payload.changes ?? {};
  const branch = attrs.source_branch;

  if (isApproval) {
    const approved = payload.approval?.approved !== false;
    if (approved) {
      actions.push({
        kind: 'labels',
        id: `${mrId}:approved`,
        key,
        add: [config.labels.approved],
        remove: [config.labels.needs_review],
      });
    }
    return { actions };
  }

  switch (action) {
    case 'open':
      return { actions: openActions(payload, config, key) };

    case 'update': {
      // The edit linked the MR to this ticket: the key was just added, an
      // ambiguous title was narrowed down, or the title now names a different
      // ticket than before. Do what opening the MR would have done for it.
      if (attrs.state !== 'merged' && attrs.state !== 'closed' && becameLinked(payload, config, key)) {
        actions.push(...openActions(payload, config, key));
      }
      if ('reviewer' in changes) {
        const now = currentReviewers(payload);
        const before = previousReviewers(payload);
        const joined = [...now].sort().join(',');
        const add = now.filter((r) => !before.includes(r)).map((r) => reviewerLabel(config, r));
        const remove = reviewerLabelsToRemove(config, before.filter((r) => !now.includes(r)));
        if (now.length > 0) add.push(config.labels.needs_review);
        else remove.push(config.labels.needs_review);
        if (config.behaviours.reviewer_labels && (add.length > 0 || remove.length > 0)) {
          actions.push({
            kind: 'labels',
            id: `${mrId}:reviewer:${joined}:${attrs.updated_at ?? ''}`,
            key,
            add,
            remove,
          });
        }
        if (config.behaviours.comment_on_reviewer && now.length > 0) {
          actions.push({
            kind: 'comment',
            id: `${mrId}:reviewer-comment:${joined}:${attrs.updated_at ?? ''}`,
            key,
            text: `Reviewer assigned: ${now.map((r) => `@${r}`).join(', ')} (branch \`${branch}\`)`,
          });
        }
      }

      if (config.behaviours.conflict_labels) {
        const conflict = conflictTransition(changes);
        if (conflict !== null) {
          actions.push({
            kind: 'labels',
            id: `${mrId}:conflict:${conflict}:${attrs.updated_at ?? ''}`,
            key,
            add: conflict ? [config.labels.conflict] : [],
            remove: conflict ? [] : [config.labels.conflict],
          });
        }
      }

      if (config.behaviours.draft_labels) {
        const draft = draftTransition(payload, changes);
        if (draft !== null) {
          const reviewers = currentReviewers(payload);
          actions.push({
            kind: 'labels',
            id: `${mrId}:draft:${draft}:${attrs.updated_at ?? ''}`,
            key,
            // Going draft: label intent, withdraw the review request. Becoming
            // ready again only re-requests review if reviewers are actually set.
            add: draft
              ? [config.labels.draft]
              : reviewers.length > 0
                ? [config.labels.needs_review]
                : [],
            remove: draft ? [config.labels.needs_review] : [config.labels.draft],
          });
        }
      }

      // Merging can surface as an update before the merge event on some GitLab
      // versions; merged actions have stable ids, so a later merge event dedupes.
      if (attrs.state === 'merged') {
        actions.push(...mergedActions(payload, config, key));
      }
      return { actions };
    }

    case 'merge':
      return { actions: mergedActions(payload, config, key) };

    case 'close': {
      if (!config.labels.closed) return { actions, skipped: 'closed (no closed label configured)' };
      const remove = reviewerLabelsToRemove(config, currentReviewers(payload));
      actions.push({
        kind: 'labels',
        id: `${mrId}:closed`,
        key,
        add: [config.labels.closed],
        remove: [config.labels.needs_review, config.labels.conflict, config.labels.ci_failing, ...remove],
      });
      return { actions };
    }

    default:
      return { actions, skipped: `action "${action}" not mapped` };
  }
}

/** The MR as a link line: `[group/project !42](url)`, or '' when the payload has no URL. */
function mrLink(payload: MergeRequestPayload): string {
  const { iid, url } = payload.object_attributes;
  if (!url) return '';
  const project = payload.project?.path_with_namespace;
  return `[${project ? `${project} ` : ''}!${iid}](${url})`;
}

/** Branch comment plus draft or review-request labels, as planned when an MR opens. */
function openActions(payload: MergeRequestPayload, config: Config, key: string): JiraAction[] {
  const attrs = payload.object_attributes;
  // Ids include the key: an MR re-pointed from ABC-1 to ABC-2 must still do this for ABC-2.
  const mrId = `${attrs.id}:${key}`;
  const actions: JiraAction[] = [];
  if (config.behaviours.comment_on_open) {
    actions.push({
      kind: 'comment',
      id: `${mrId}:open-comment`,
      key,
      text: [`🔀 Merge request opened: \`${attrs.source_branch}\` → \`${attrs.target_branch}\``, mrLink(payload)]
        .filter(Boolean)
        .join('\n'),
    });
  }
  const reviewers = currentReviewers(payload);
  if (attrs.draft && config.behaviours.draft_labels) {
    // A draft MR is not asking for review; label intent, skip needs-review.
    actions.push({ kind: 'labels', id: `${mrId}:open-draft`, key, add: [config.labels.draft], remove: [] });
  } else if (config.behaviours.reviewer_labels && reviewers.length > 0) {
    actions.push({
      kind: 'labels',
      id: `${mrId}:open-labels`,
      key,
      add: [config.labels.needs_review, ...reviewers.map((r) => reviewerLabel(config, r))],
      remove: [],
    });
  }
  return actions;
}

/** True when this update's title/description change is what linked the MR to `key`. */
function becameLinked(payload: MergeRequestPayload, config: Config, key: string): boolean {
  const changes = payload.changes ?? {};
  if (!('title' in changes) && !('description' in changes)) return false;
  const attrs = payload.object_attributes;
  const previous = (field: 'title' | 'description', current: string | undefined) =>
    field in changes ? String(changes[field]!.previous ?? '') : current;
  const before = resolveJiraKey(
    [
      { field: 'title', text: previous('title', attrs.title) },
      { field: 'branch', text: attrs.source_branch },
      { field: 'description', text: previous('description', attrs.description) },
    ],
    keyOptions(config),
  );
  return before.status !== 'found' || before.key !== key;
}

function mergedActions(
  payload: MergeRequestPayload,
  config: Config,
  key: string,
): JiraAction[] {
  const attrs = payload.object_attributes;
  const mrId = attrs.id;
  const actions: JiraAction[] = [];
  const remove = reviewerLabelsToRemove(config, currentReviewers(payload));
  actions.push({
    kind: 'labels',
    id: `${mrId}:merged-labels`,
    key,
    add: [config.labels.merged],
    remove: [
      config.labels.needs_review,
      config.labels.approved,
      config.labels.conflict,
      config.labels.ci_failing,
      ...remove,
    ],
  });
  if (config.behaviours.comment_on_merge) {
    const sha = attrs.merge_commit_sha ?? attrs.squash_commit_sha ?? attrs.last_commit?.id ?? '';
    actions.push({
      kind: 'comment',
      id: `${mrId}:merged-comment`,
      key,
      text: [
        `✅ Merged: \`${attrs.source_branch}\` → \`${attrs.target_branch}\`${sha ? ` as \`${sha.slice(0, 12)}\`` : ''}`,
        mrLink(payload),
      ]
        .filter(Boolean)
        .join('\n'),
    });
  }
  return actions;
}

/**
 * True when the MR became conflicted in this event, false when the conflict
 * was resolved, null when neither merge_status field changed meaningfully
 * (e.g. unchecked → checking transitions carry no information).
 */
function conflictTransition(changes: Record<string, ChangeEntry>): boolean | null {
  const entry = changes['merge_status'] ?? changes['detailed_merge_status'];
  if (!entry) return null;
  const to = conflictState(entry.current);
  return to === null ? null : to;
}

function conflictState(value: unknown): boolean | null {
  switch (String(value ?? '')) {
    case 'cannot_be_merged':
    case 'conflict':
      return true;
    case 'can_be_merged':
    case 'mergeable':
      return false;
    default:
      return null; // unchecked, checking, blocked, broken_status, ...
  }
}

const DRAFT_TITLE = /^(Draft|WIP):/i;

/**
 * Draft state change: prefer the explicit `draft` field; older GitLab and
 * title-based WIP toggles surface as a title change with a Draft:/WIP: prefix.
 * Null when the event does not tell us anything about draft intent.
 */
function draftTransition(
  payload: MergeRequestPayload,
  changes: Record<string, ChangeEntry>,
): boolean | null {
  const draft = changes['draft'];
  if (draft) return draft.current === true;
  const title = changes['title'];
  if (title) {
    const now = DRAFT_TITLE.test(String(title.current ?? ''));
    const before = DRAFT_TITLE.test(String(title.previous ?? ''));
    return now === before ? null : now;
  }
  return null;
}

/**
 * Pipeline event → CI label actions. Failure labels the ticket; success does
 * not add anything, it only removes a stale `ci-failing`. Running/pending is
 * deliberately ignored — a label for work in progress is just noise.
 */
export function planPipelineActions(payload: PipelinePayload, config: Config): PlanResult {
  const attrs = payload.object_attributes;
  const resolution = resolveJiraKey([{ field: 'branch', text: attrs.ref }], keyOptions(config));
  if (resolution.status !== 'found') {
    return { actions: [], skipped: `pipeline ref "${attrs.ref}": ${describeResolution(resolution, ['branch'])}` };
  }
  const key = resolution.key;
  if (!config.behaviours.ci_fail_labels) {
    return { actions: [], skipped: 'ci_fail_labels disabled' };
  }
  const stamp = attrs.updated_at ?? '';
  if (attrs.status === 'failed' || attrs.status === 'canceled') {
    return {
      actions: [
        {
          kind: 'labels',
          id: `pipeline:${attrs.id}:${attrs.status}:${stamp}`,
          key,
          add: [config.labels.ci_failing],
          remove: [],
        },
      ],
    };
  }
  if (attrs.status === 'success') {
    return {
      actions: [
        {
          kind: 'labels',
          id: `pipeline:${attrs.id}:success:${stamp}`,
          key,
          add: [],
          remove: [config.labels.ci_failing],
        },
      ],
    };
  }
  return { actions: [], skipped: `pipeline status "${attrs.status}" not mapped` };
}

/**
 * The one GitLab write: a note on an MR that cannot be linked to Jira, telling
 * the author how to fix it. Planned at most once per MR (fixed action id, and the
 * client also checks for an existing note), and only on the events where the
 * author just wrote the text that is missing the key: open, reopen, and edits of
 * the title or description.
 */
function missingKeyNote(
  payload: MergeRequestPayload,
  config: Config,
  resolution: Exclude<KeyResolution, { status: 'found' } | { status: 'foreign' }>,
): JiraAction | null {
  if (!config.behaviours.comment_on_missing_key) return null;
  if (payload.event_type === 'approval') return null;

  const attrs = payload.object_attributes;
  const action = payload.action ?? attrs.action ?? '';
  const changes = payload.changes ?? {};
  const relevant =
    action === 'open' || action === 'reopen' || (action === 'update' && ('title' in changes || 'description' in changes));
  if (!relevant) return null;
  if (attrs.state === 'merged' || attrs.state === 'closed') return null;

  const actor = payload.user?.username ?? '';
  if (actor && config.missing_key.skip_authors.includes(actor)) return null;
  if (config.missing_key.skip_branches.some((prefix) => attrs.source_branch.startsWith(prefix))) return null;

  const projectId = payload.project?.id ?? attrs.target_project_id;
  if (typeof projectId !== 'number') return null;

  return {
    kind: 'mr_note',
    id: `${attrs.id}:missing-key-note`,
    key: `gitlab:${projectId}!${attrs.iid}`,
    project_id: projectId,
    mr_iid: attrs.iid,
    text: missingKeyText(config, resolution),
  };
}

function missingKeyText(config: Config, resolution: Exclude<KeyResolution, { status: 'found' } | { status: 'foreign' }>): string {
  const example = `${config.jira.project_keys[0]?.toUpperCase() ?? 'ABC'}-123`;
  const where =
    resolution.status === 'ambiguous'
      ? `The ${resolution.field} mentions several Jira tickets (${resolution.keys.map((k) => `\`${k}\``).join(', ')}), ` +
        `so the bridge cannot tell which one this MR belongs to.`
      : 'No Jira ticket key was found in the title, the source branch or the description.';
  const fix =
    resolution.status === 'ambiguous'
      ? `Keep only the ticket this MR belongs to in the ${resolution.field}, or put it at the start of the title ` +
        `(e.g. \`${example} Fix login\`); the title is checked first.`
      : `Add the key to the title, e.g. \`${example} Fix login\`.`;
  return [
    MISSING_KEY_MARKER,
    `⚠️ **This merge request is not linked to Jira.** ${where}`,
    '',
    `Until it is, the ticket gets no review, approval or merge labels and no branch comment. ${fix} ` +
      'The bridge picks up the edit straight away.',
    '',
    '<sub>Posted once by gitlab-jira-bridge.</sub>',
  ].join('\n');
}
