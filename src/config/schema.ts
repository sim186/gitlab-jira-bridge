import { z } from 'zod';

/**
 * Schema for config.yaml. This file holds infrastructure and secrets and is never
 * written by the application. Behaviour switches (which labels, which comments)
 * live here so a deployment change is a reviewable config diff.
 */

const gitlabSchema = z.object({
  /** Base URL of the GitLab instance, used only to render links in Jira comments. */
  url: z.string().url().describe('GitLab base URL, e.g. https://gitlab.example.com'),
  /** Secret token configured on the GitLab webhook (sent as X-Gitlab-Token). Required. */
  webhook_secret: z.string().min(8).describe('Secret token of the GitLab MR webhook'),
  /**
   * Only needed for behaviours.comment_on_missing_key. GitLab has no scope narrower
   * than `api` that can post comments, so use a dedicated bot user with Reporter.
   */
  token: z.string().default(''),
});

const jiraSchema = z.object({
  base_url: z.string().url().describe('Jira Cloud base URL, e.g. https://your-org.atlassian.net'),
  email: z.string().min(1).describe('Email of the bot account (Basic auth user)'),
  api_token: z.string().min(1).describe('Jira API token for the bot account'),
  /** Regex that finds ticket keys in the MR title, branch, or description. */
  key_regex: z
    .string()
    .default('\\b([A-Z][A-Z0-9]+-\\d+)\\b')
    .describe('Regex with one capture group used to extract the Jira key'),
  /** Keys matching this regex are never treated as ticket keys (e.g. reserved words). */
  key_ignore_regex: z.string().default('^$'),
  /**
   * Your Jira project keys, e.g. [ABC, XYZ]. When set, keys are matched in any case
   * (`feature/abc-123` → ABC-123) and only for these projects; key_regex is not used.
   * Leave empty to match uppercase keys with key_regex.
   */
  project_keys: z
    .array(z.string().regex(/^[A-Za-z][A-Za-z0-9]+$/, 'a Jira project key such as ABC'))
    .default([]),
  /**
   * Real Jira projects this bridge does not act on, e.g. [XYZ, DEF]. Naming one of
   * their keys makes the MR `foreign`: skipped silently, and never told it has no
   * ticket. Empty (the default) makes such keys invisible instead.
   */
  other_project_keys: z
    .array(z.string().regex(/^[A-Za-z][A-Za-z0-9]+$/, 'a Jira project key such as ABC'))
    .default([]),
});

const labelsSchema = z.object({
  needs_review: z.string().default('needs-review'),
  reviewer_prefix: z
    .string()
    .default('reviewer-')
    .describe('Prefix for per-reviewer labels; the GitLab username is appended'),
  approved: z.string().default('approved'),
  merged: z.string().default('merged'),
  closed: z.string().default(''),
  /** When non-empty, merged MRs get this label added. Empty means no closed label. */
  conflict: z.string().default('blocked-by-conflict'),
  draft: z.string().default('draft'),
  /** Added when the head pipeline fails; removed (silently) when it passes again. */
  ci_failing: z.string().default('ci-failing'),
});

const behavioursSchema = z.object({
  /** Comment on the ticket when the MR is opened, with the branch name and MR link. */
  comment_on_open: z.boolean().default(true),
  /** Comment on the ticket when the MR is merged, with merge SHA and branch. */
  comment_on_merge: z.boolean().default(true),
  /** Comment when a reviewer is assigned (not for un-assignment). */
  comment_on_reviewer: z.boolean().default(false),
  /** Add/remove the per-reviewer `reviewer-<username>` labels. */
  reviewer_labels: z.boolean().default(true),
  /** `blocked-by-conflict` on merge_status transitions, cleared when resolved. */
  conflict_labels: z.boolean().default(true),
  /** `draft` label on draft toggles; also gates needs-review while draft. */
  draft_labels: z.boolean().default(true),
  /** `ci-failing` on pipeline failure only; success removes the label, adds nothing. */
  ci_fail_labels: z.boolean().default(true),
  /**
   * Comment on the GitLab MR, once, when no single Jira key can be found in it.
   * Needs gitlab.token. Off by default: it is the bridge's only GitLab write.
   */
  comment_on_missing_key: z.boolean().default(false),
  /** Skip Jira writes, log what would happen instead. */
  dry_run: z.boolean().default(false),
});

export const configSchema = z.object({
  server: z
    .object({
      host: z.string().default('127.0.0.1'),
      port: z.number().int().min(1).max(65_535).default(8090),
      /**
       * Trust X-Forwarded-For so the audit trail records the real caller behind a
       * reverse proxy. Leave false when the port is reachable directly — the header
       * is then caller-controlled.
       */
      trust_proxy: z.boolean().default(false),
    })
    .default({}),
  gitlab: gitlabSchema,
  jira: jiraSchema,
  labels: labelsSchema.default({}),
  behaviours: behavioursSchema.default({}),
  audit: z
    .object({
      /** Append-only record of every delivery and every Jira write it caused. */
      enabled: z.boolean().default(true),
      /** JSON Lines file; one entry per action or per delivery that planned nothing. */
      file: z.string().default('./data/audit.jsonl'),
      /** Entries older than this are pruned at startup and daily. 0 keeps everything. */
      retention_days: z.number().int().min(0).default(90),
      /**
       * Also record deliveries that produced no Jira action (no ticket key, event
       * not mapped). This is what answers "why didn't my ticket get the label?";
       * turn it off only if pipeline chatter makes the file too noisy.
       */
      record_skipped: z.boolean().default(true),
    })
    .default({}),
  retry: z
    .object({
      /** Total tries for a transient Jira failure before the action is abandoned. */
      max_attempts: z.number().int().min(1).default(12),
      /** First retry delay; doubles each attempt. */
      base_delay_seconds: z.number().int().min(1).default(30),
      /** Cap on the delay between attempts. */
      max_delay_seconds: z.number().int().min(1).default(3600),
      /** Pending actions, persisted so a restart loses nothing. */
      queue_file: z.string().default('./data/queue.json'),
      /** Where `bridge replay` drops requests for the running server to pick up. */
      inbox_dir: z.string().default('./data/inbox'),
    })
    .default({}),
  /** MRs that legitimately have no ticket never get the missing-key comment. */
  missing_key: z
    .object({
      /** GitLab usernames, e.g. renovate-bot. */
      skip_authors: z.array(z.string()).default([]),
      /** Source-branch prefixes, e.g. renovate/, release/. */
      skip_branches: z.array(z.string()).default([]),
    })
    .default({}),
  /** JSON file where processed action ids are kept so restarts do not re-fire. */
  state_file: z.string().default('./data/state.json'),
  log_level: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
});

/** Cross-field checks that zod's per-field schemas cannot express. */
export const validatedConfigSchema = configSchema.superRefine((config, ctx) => {
  for (const field of ['key_regex', 'key_ignore_regex'] as const) {
    try {
      new RegExp(config.jira[field]);
    } catch (err) {
      ctx.addIssue({ code: 'custom', path: ['jira', field], message: `not a valid JavaScript regex: ${(err as Error).message}` });
    }
  }
  if (config.behaviours.comment_on_missing_key && !config.gitlab.token) {
    ctx.addIssue({
      code: 'custom',
      path: ['gitlab', 'token'],
      message: 'required when behaviours.comment_on_missing_key is on',
    });
  }
});

export type Config = z.infer<typeof configSchema>;
