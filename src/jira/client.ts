/**
 * Jira Cloud REST client. Uses fetch with Basic auth (email + API token).
 * Only two write operations exist: a label update and add-comment.
 *
 * Labels are changed with Jira's `update.labels` add/remove operations, never by
 * sending the whole list. Jira applies those against the ticket as it is at that
 * moment, so a label someone edits by hand between our read and our write is
 * kept. The read beforehand only decides whether a write is needed and records
 * before/after for the audit trail.
 *
 * Comments carry an entity property naming the bridge's action id. Before
 * posting, the recent comments are checked for it, so a crash between a
 * successful post and saving the dedup state cannot post the comment twice.
 */
import type { Config } from '../config/schema.js';
import type { Logger } from 'pino';

export type IssueSummary = { fields: { labels: string[]; status: { name: string } } };

/** What a label update did. `before`/`after` are absent in dry-run (nothing was read). */
export type LabelResult = { changed: boolean; dryRun: boolean; before?: string[]; after?: string[] };

/** `created: false` means a comment for this action id was already on the ticket. */
export type CommentResult = { created: boolean; dryRun: boolean };

/** Entity property key on comments the bridge posts. */
export const COMMENT_PROPERTY = 'gitlab-jira-bridge';

/** How many recent comments to scan for an earlier post of the same action. */
const COMMENT_LOOKBACK = 50;

type CommentPage = { comments?: { properties?: { key: string; value?: { action_id?: string } }[] }[] };

export class JiraClient {
  constructor(
    private readonly config: Config,
    private readonly log: Logger,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private get api(): string {
    return `${this.config.jira.base_url.replace(/\/$/, '')}/rest/api/3`;
  }

  private get headers(): Record<string, string> {
    const basic = Buffer.from(
      `${this.config.jira.email}:${this.config.jira.api_token}`,
    ).toString('base64');
    return {
      Authorization: `Basic ${basic}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    };
  }

  async getIssue(key: string): Promise<IssueSummary> {
    const res = await this.fetchImpl(`${this.api}/issue/${key}?fields=labels,status`, {
      headers: this.headers,
    });
    if (!res.ok) {
      throw new JiraError(`GET issue ${key}: ${res.status} ${await safeText(res)}`, res.status);
    }
    return (await res.json()) as IssueSummary;
  }

  async applyLabels(key: string, add: string[], remove: string[]): Promise<LabelResult> {
    // An empty name means "label disabled in config"; Jira rejects it outright.
    const adds = add.filter(Boolean);
    const removes = remove.filter((l) => l && !adds.includes(l));
    if (this.config.behaviours.dry_run) {
      this.log.info({ key, add: adds, remove: removes }, 'dry-run: would apply labels');
      return { changed: false, dryRun: true };
    }
    const current = (await this.getIssue(key)).fields.labels;
    const toRemove = removes.filter((l) => current.includes(l));
    const toAdd = [...new Set(adds)].filter((l) => !current.includes(l));
    if (toRemove.length === 0 && toAdd.length === 0) {
      return { changed: false, dryRun: false, before: current, after: current };
    }
    const operations = [...toRemove.map((l) => ({ remove: l })), ...toAdd.map((l) => ({ add: l }))];
    const res = await this.fetchImpl(`${this.api}/issue/${key}?notifyUsers=false`, {
      method: 'PUT',
      headers: this.headers,
      body: JSON.stringify({ update: { labels: operations } }),
    });
    if (!res.ok) {
      throw new JiraError(`PUT labels ${key}: ${res.status} ${await safeText(res)}`, res.status);
    }
    const after = [...current.filter((l) => !toRemove.includes(l)), ...toAdd];
    return { changed: true, dryRun: false, before: current, after };
  }

  /** True when one of the ticket's recent comments was posted for `actionId`. */
  async hasComment(key: string, actionId: string): Promise<boolean> {
    const query = `orderBy=-created&maxResults=${COMMENT_LOOKBACK}&expand=properties`;
    const res = await this.fetchImpl(`${this.api}/issue/${key}/comment?${query}`, { headers: this.headers });
    if (!res.ok) {
      throw new JiraError(`GET comments ${key}: ${res.status} ${await safeText(res)}`, res.status);
    }
    const page = (await res.json()) as CommentPage;
    return (page.comments ?? []).some((c) =>
      (c.properties ?? []).some((p) => p.key === COMMENT_PROPERTY && p.value?.action_id === actionId),
    );
  }

  async addComment(key: string, text: string, actionId?: string): Promise<CommentResult> {
    if (this.config.behaviours.dry_run) {
      this.log.info({ key, text }, 'dry-run: would add comment');
      return { created: false, dryRun: true };
    }
    if (actionId && (await this.hasComment(key, actionId))) {
      return { created: false, dryRun: false };
    }
    const body: Record<string, unknown> = { body: doc(text) };
    if (actionId) body.properties = [{ key: COMMENT_PROPERTY, value: { action_id: actionId } }];
    const res = await this.fetchImpl(`${this.api}/issue/${key}/comment`, {
      method: 'POST',
      headers: this.headers,
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      throw new JiraError(`POST comment ${key}: ${res.status} ${await safeText(res)}`, res.status);
    }
    return { created: true, dryRun: false };
  }
}

export class JiraError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'JiraError';
  }
}

/**
 * Comment text → Atlassian Document Format. Inline support is deliberately small:
 * `code`, [label](url) and bare http(s) URLs become marks, and every line becomes
 * its own paragraph. Bare URLs are what the comment templates emit, and Jira does
 * not auto-link plain text sent through the API, so they must be marked here.
 */
function doc(text: string): Record<string, unknown> {
  const lines = text.split('\n').filter((line) => line.trim() !== '');
  return { type: 'doc', version: 1, content: (lines.length > 0 ? lines : [' ']).map(paragraph) };
}

function paragraph(line: string): Record<string, unknown> {
  return { type: 'paragraph', content: inline(line) };
}

const INLINE = /`([^`]+)`|\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)|(https?:\/\/[^\s]+)/g;

function inline(line: string): Record<string, unknown>[] {
  const content: Record<string, unknown>[] = [];
  let last = 0;
  for (const match of line.matchAll(INLINE)) {
    const index = match.index ?? 0;
    if (index > last) content.push({ type: 'text', text: line.slice(last, index) });
    if (match[1] !== undefined) content.push({ type: 'text', text: match[1], marks: [{ type: 'code' }] });
    else if (match[2] !== undefined) content.push({ type: 'text', text: match[2], marks: [{ type: 'link', attrs: { href: match[3] } }] });
    else content.push({ type: 'text', text: match[4], marks: [{ type: 'link', attrs: { href: match[4] } }] });
    last = index + match[0].length;
  }
  if (last < line.length) content.push({ type: 'text', text: line.slice(last) });
  return content;
}

async function safeText(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 300);
  } catch {
    return '<unreadable body>';
  }
}
