/**
 * Applies one planned action and classifies the result. Retry and dedup policy
 * live in the worker; this only says what happened.
 *
 * 4xx (other than 429) from Jira or GitLab is permanent: wrong key, no access,
 * bad token. Retrying would only hammer the server. 5xx, 429 and network errors
 * are transient.
 */
import { MISSING_KEY_MARKER, type JiraAction } from '../domain/actions.js';
import { GitLabError, type GitLabClient } from '../gitlab/client.js';
import { JiraError, type JiraClient } from './client.js';

export type ExecutionResult =
  | { status: 'applied' | 'unchanged' | 'dry_run'; before?: string[]; after?: string[]; detail?: string }
  | { status: 'failed'; permanent: boolean; error: string };

export type Clients = { jira: JiraClient; gitlab?: GitLabClient };

export async function executeAction(action: JiraAction, clients: Clients): Promise<ExecutionResult> {
  try {
    switch (action.kind) {
      case 'labels': {
        const result = await clients.jira.applyLabels(action.key, action.add, action.remove);
        return {
          status: result.dryRun ? 'dry_run' : result.changed ? 'applied' : 'unchanged',
          before: result.before,
          after: result.after,
        };
      }
      case 'comment': {
        const result = await clients.jira.addComment(action.key, action.text, action.id);
        if (result.dryRun) return { status: 'dry_run' };
        return result.created
          ? { status: 'applied' }
          : { status: 'unchanged', detail: 'comment for this action already on the ticket' };
      }
      case 'mr_note': {
        if (!clients.gitlab) {
          return { status: 'failed', permanent: true, error: 'no GitLab client: gitlab.token not configured' };
        }
        const result = await clients.gitlab.addNote(action.project_id, action.mr_iid, action.text, MISSING_KEY_MARKER);
        if (result.dryRun) return { status: 'dry_run' };
        return result.created ? { status: 'applied' } : { status: 'unchanged', detail: 'note already on the MR' };
      }
    }
  } catch (err) {
    const status = err instanceof JiraError || err instanceof GitLabError ? err.status : undefined;
    const permanent = status !== undefined && status >= 400 && status < 500 && status !== 429;
    return { status: 'failed', permanent, error: String(err) };
  }
}
