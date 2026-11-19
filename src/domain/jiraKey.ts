/**
 * Jira ticket keys extracted from GitLab text.
 *
 * The key must appear explicitly; we never guess a project. Sources are tried
 * in priority order (for an MR: title, then source branch, then description)
 * and the first source that names exactly one key wins. A later source is not
 * consulted, so "Follow-up of ABC-2" in the description cannot override the
 * ABC-1 in the title. A source naming two or more keys is ambiguous and stops
 * the search: guessing which one was meant is worse than doing nothing.
 *
 * Matching is case-sensitive (uppercase keys only) unless `project_keys` is
 * set. Case-insensitive matching against arbitrary text finds "utf-8" or
 * "node-22" as tickets, so it is only safe when the projects are known.
 *
 * `other_project_keys` are real Jira projects this bridge does not act on. A key
 * of one of them makes the MR `foreign`: linked to Jira, but not to a project we
 * write to. That is deliberately not the same as `none` — an MR whose ticket is
 * DEF-156 must not be told it has no ticket.
 */

const KEY_SHAPE = /^[A-Z][A-Z0-9]+-\d+$/;

export type KeySource = { field: string; text: string | undefined };

export type KeyOptions = {
  /** Regex with one capture group; used when project_keys is empty. */
  keyRegex: string;
  ignoreRegex?: string;
  /** Known Jira project keys. When set, matching is case-insensitive and limited to these. */
  projectKeys?: string[];
  /** Real projects we do not act on: their keys are reported as `foreign`, never as `found`. */
  otherProjectKeys?: string[];
};

export type KeyResolution =
  | { status: 'found'; key: string; field: string }
  /** Linked to a Jira project we do not act on: skip, but never call it unlinked. */
  | { status: 'foreign'; field: string; keys: string[] }
  | { status: 'none' }
  | { status: 'ambiguous'; field: string; keys: string[] };

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Scanner for an explicit list of project keys: case-insensitive, word-bounded. */
function buildProjectScanner(projects: string[]): RegExp {
  const alternatives = projects.map((p) => escapeRegex(p.toUpperCase())).join('|');
  // (?<![A-Za-z0-9]) instead of \b so "feature/abc-123-x" and "abc-123_fix" both match.
  return new RegExp(`(?<![A-Za-z0-9])((?:${alternatives})-\\d+)(?![A-Za-z0-9])`, 'gi');
}

/** The scanner for one text: either the project-key allowlist (case-insensitive) or key_regex. */
export function buildKeyScanner(options: KeyOptions): RegExp {
  const projects = (options.projectKeys ?? []).filter(Boolean);
  return projects.length > 0 ? buildProjectScanner(projects) : new RegExp(options.keyRegex, 'g');
}

const projectOf = (key: string): string => key.slice(0, key.lastIndexOf('-'));

/** One text → the keys we act on, and the keys of projects we do not act on. */
export function scanJiraKeys(text: string | undefined, options: KeyOptions): { tracked: string[]; other: string[] } {
  const tracked = new Set<string>();
  const other = new Set<string>();
  if (!text) return { tracked: [], other: [] };

  const ignore = new RegExp(options.ignoreRegex ?? '^$');
  const otherProjects = (options.otherProjectKeys ?? []).filter(Boolean);
  const otherSet = new Set(otherProjects.map((p) => p.toUpperCase()));
  const keys = (scanner: RegExp): string[] => {
    const found: string[] = [];
    for (const match of text.matchAll(scanner)) {
      const candidate = (match[1] ?? match[0]).toUpperCase();
      if (KEY_SHAPE.test(candidate) && !ignore.test(candidate)) found.push(candidate);
    }
    return found;
  };

  // key_regex also matches foreign keys, so they are subtracted here; the second
  // scanner then finds them for both modes.
  for (const key of keys(buildKeyScanner(options))) if (!otherSet.has(projectOf(key))) tracked.add(key);
  if (otherProjects.length > 0) for (const key of keys(buildProjectScanner(otherProjects))) other.add(key);

  return { tracked: [...tracked], other: [...other] };
}

export function extractJiraKeys(text: string | undefined, options: KeyOptions): string[] {
  return scanJiraKeys(text, options).tracked;
}

export function resolveJiraKey(sources: KeySource[], options: KeyOptions): KeyResolution {
  for (const { field, text } of sources) {
    const { tracked, other } = scanJiraKeys(text, options);
    if (tracked.length === 1) return { status: 'found', key: tracked[0]!, field };
    if (tracked.length > 1) return { status: 'ambiguous', field, keys: tracked };
    if (other.length > 0) return { status: 'foreign', field, keys: other };
  }
  return { status: 'none' };
}

/** Human-readable reason for the audit trail when no key was resolved. */
export function describeResolution(resolution: KeyResolution, fields: string[]): string {
  switch (resolution.status) {
    case 'found':
      return `key ${resolution.key} from ${resolution.field}`;
    case 'ambiguous':
      return `ambiguous: ${resolution.field} names ${resolution.keys.join(', ')}`;
    case 'foreign':
      return `foreign: ${resolution.field} names ${resolution.keys.join(', ')} (not a tracked Jira project)`;
    case 'none':
      return `no Jira key in ${fields.join('/')}`;
  }
}
