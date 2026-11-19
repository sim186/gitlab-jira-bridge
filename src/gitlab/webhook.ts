/**
 * GitLab merge-request webhook payloads.
 *
 * Only the fields the bridge consumes are typed; everything else is passed
 * through untouched. Authentication follows GitLab's webhook "Secret token":
 * GitLab sends the configured token verbatim in the X-Gitlab-Token header.
 */
import { createHash, timingSafeEqual } from 'node:crypto';

export type ReviewerUser = { id?: number; username?: string; name?: string };

export type MergeRequestAttributes = {
  id: number;
  iid: number;
  title: string;
  description?: string;
  source_branch: string;
  target_branch: string;
  action?: string;
  state?: string;
  draft?: boolean;
  merge_status?: string;
  url?: string;
  target_project_id?: number;
  sha?: string;
  merge_commit_sha?: string;
  squash_commit_sha?: string;
  author?: { username?: string; name?: string };
  last_commit?: { id?: string; message?: string };
  updated_at?: string;
};

export type ChangeEntry = { previous: unknown; current: unknown };

export type MergeRequestPayload = {
  object_kind: 'merge_request';
  event_type?: string;
  action?: string;
  object_attributes: MergeRequestAttributes;
  changes?: Record<string, ChangeEntry>;
  reviewers?: ReviewerUser[];
  assignee?: ReviewerUser | null;
  user?: { username?: string; name?: string };
  project?: { id?: number; web_url?: string; path_with_namespace?: string };
  approval?: { approved?: boolean; user?: ReviewerUser };
};

/**
 * Constant-time comparison of the X-Gitlab-Token header with the configured
 * secret. Both sides are hashed first so the comparison neither leaks the
 * secret's length nor throws on a length mismatch.
 */
export function verifyToken(header: string | undefined, secret: string): boolean {
  if (!header) return false;
  const digest = (value: string) => createHash('sha256').update(value, 'utf8').digest();
  return timingSafeEqual(digest(header), digest(secret));
}

/** Narrow a webhook body to an MR event we understand; null means "ignore". */
export function parseMergeRequestEvent(body: unknown): MergeRequestPayload | null {
  if (typeof body !== 'object' || body === null) return null;
  const payload = body as MergeRequestPayload;
  if (payload.object_kind !== 'merge_request') return null;
  if (!payload.object_attributes || typeof payload.object_attributes.id !== 'number') {
    return null;
  }
  return payload;
}

export type PipelineAttributes = {
  id: number;
  /** Source branch of the pipeline; used to find the Jira key when no MR context exists. */
  ref: string;
  tag?: string;
  status: string;
  detailed_tag?: { name?: string; url?: string };
  updated_at?: string;
};

export type PipelinePayload = {
  object_kind: 'pipeline';
  object_attributes: PipelineAttributes;
  project?: { web_url?: string; path_with_namespace?: string };
};

/**
 * Pipeline events carry no MR reference, so the bridge keys off the branch name
 * (or the configurable case-insensitive key_regex). Branches without a ticket
 * key are ignored, which is the safe default.
 */
export function parsePipelineEvent(body: unknown): PipelinePayload | null {
  if (typeof body !== 'object' || body === null) return null;
  const payload = body as PipelinePayload;
  if (payload.object_kind !== 'pipeline') return null;
  const attrs = payload.object_attributes;
  if (!attrs || typeof attrs.id !== 'number' || typeof attrs.status !== 'string') return null;
  return payload;
}

/** Reviewer usernames currently on the MR, from `reviewers` or the changes entry. */
export function currentReviewers(payload: MergeRequestPayload): string[] {
  if (Array.isArray(payload.reviewers)) {
    return payload.reviewers.map((r) => r.username).filter((u): u is string => !!u);
  }
  const current = payload.changes?.reviewer?.current;
  if (current && typeof current === 'object' && 'username' in current) {
    const username = (current as { username?: string }).username;
    return username ? [username] : [];
  }
  return [];
}

export function previousReviewers(payload: MergeRequestPayload): string[] {
  const previous = payload.changes?.reviewer?.previous;
  if (!previous) return [];
  const list = Array.isArray(previous) ? previous : [previous];
  return list
    .map((item) => (item && typeof item === 'object' ? (item as ReviewerUser).username : undefined))
    .filter((u): u is string => !!u);
}
