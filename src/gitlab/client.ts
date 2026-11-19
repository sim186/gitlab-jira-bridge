/**
 * GitLab REST client for the bridge's single GitLab write: a note on an MR that
 * cannot be linked to Jira. Only constructed when behaviours.comment_on_missing_key
 * is on, so a deployment without a GitLab token never talks to the GitLab API.
 */
import type { Logger } from 'pino';
import type { Config } from '../config/schema.js';

export type NoteResult = { created: boolean; dryRun: boolean };

/** Notes scanned for an earlier copy: 5 pages of 100, oldest first. */
const MAX_PAGES = 5;

export class GitLabClient {
  constructor(
    private readonly config: Config,
    private readonly log: Logger,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private notesUrl(projectId: number, iid: number): string {
    const base = this.config.gitlab.url.replace(/\/$/, '');
    return `${base}/api/v4/projects/${projectId}/merge_requests/${iid}/notes`;
  }

  private get headers(): Record<string, string> {
    return { 'PRIVATE-TOKEN': this.config.gitlab.token, 'Content-Type': 'application/json', Accept: 'application/json' };
  }

  /** True when a note containing `marker` is already on the MR. */
  async hasNote(projectId: number, iid: number, marker: string): Promise<boolean> {
    for (let page = 1; page <= MAX_PAGES; page++) {
      const url = `${this.notesUrl(projectId, iid)}?sort=asc&order_by=created_at&per_page=100&page=${page}`;
      const res = await this.fetchImpl(url, { headers: this.headers });
      if (!res.ok) throw new GitLabError(`GET notes ${projectId}!${iid}: ${res.status} ${await safeText(res)}`, res.status);
      const notes = (await res.json()) as { body?: string }[];
      if (notes.some((n) => n.body?.includes(marker))) return true;
      if (!res.headers.get('x-next-page')) return false;
    }
    return false;
  }

  async addNote(projectId: number, iid: number, body: string, marker: string): Promise<NoteResult> {
    if (this.config.behaviours.dry_run) {
      this.log.info({ project_id: projectId, mr_iid: iid, body }, 'dry-run: would comment on the MR');
      return { created: false, dryRun: true };
    }
    if (await this.hasNote(projectId, iid, marker)) return { created: false, dryRun: false };
    const res = await this.fetchImpl(this.notesUrl(projectId, iid), {
      method: 'POST',
      headers: this.headers,
      body: JSON.stringify({ body }),
    });
    if (!res.ok) throw new GitLabError(`POST note ${projectId}!${iid}: ${res.status} ${await safeText(res)}`, res.status);
    return { created: true, dryRun: false };
  }
}

export class GitLabError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'GitLabError';
  }
}

async function safeText(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 300);
  } catch {
    return '<unreadable body>';
  }
}
