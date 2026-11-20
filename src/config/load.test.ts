import { describe, expect, it } from 'vitest';
import { ConfigError, parseConfig } from './load.js';

const yaml = `
gitlab:
  url: https://gitlab.example.com
  webhook_secret: \${GITLAB_WEBHOOK_SECRET}
jira:
  base_url: https://x.atlassian.net
  email: \${JIRA_EMAIL:-bot@example.com}
  api_token: \${JIRA_API_TOKEN}
`;

describe('parseConfig', () => {
  it('interpolates ${VAR} and ${VAR:-default}', () => {
    const config = parseConfig(yaml, 'c.yaml', { GITLAB_WEBHOOK_SECRET: 's3cret-value', JIRA_API_TOKEN: 'tok' });
    expect(config.gitlab.webhook_secret).toBe('s3cret-value');
    expect(config.jira.email).toBe('bot@example.com');
    expect(config.jira.api_token).toBe('tok');
    expect(config.audit).toEqual({
      enabled: true,
      file: './data/audit.jsonl',
      retention_days: 90,
      record_skipped: true,
    });
  });

  it('applies nested defaults for omitted and partially configured sections', () => {
    const env = { GITLAB_WEBHOOK_SECRET: 's3cret-value', JIRA_API_TOKEN: 'tok' };
    const config = parseConfig(`${yaml}\nserver:\n  port: 9000\n`, 'c.yaml', env);
    expect(config.server).toEqual({ host: '127.0.0.1', port: 9000, trust_proxy: false });
    expect(config.labels.needs_review).toBe('needs-review');
    expect(config.behaviours.comment_on_open).toBe(true);
    expect(config.retry.max_attempts).toBe(12);
    expect(config.missing_key).toEqual({ skip_authors: [], skip_branches: [] });
  });

  it('names the missing variable', () => {
    expect(() => parseConfig(yaml, 'c.yaml', { GITLAB_WEBHOOK_SECRET: 's3cret-value' })).toThrow(
      /jira\.api_token: environment variable JIRA_API_TOKEN/,
    );
  });

  it('applies GJB_HOST, GJB_PORT and GJB_DRY_RUN overrides', () => {
    const env = { GITLAB_WEBHOOK_SECRET: 's3cret-value', JIRA_API_TOKEN: 't', GJB_HOST: '0.0.0.0', GJB_PORT: '9000', GJB_DRY_RUN: '1' };
    const config = parseConfig(yaml, 'c.yaml', env);
    expect(config.server).toMatchObject({ host: '0.0.0.0', port: 9000 });
    expect(config.behaviours.dry_run).toBe(true);
  });

  it('rejects an invalid GJB_PORT', () => {
    const env = { GITLAB_WEBHOOK_SECRET: 's3cret-value', JIRA_API_TOKEN: 't', GJB_PORT: 'abc' };
    expect(() => parseConfig(yaml, 'c.yaml', env)).toThrow(ConfigError);
  });

  it('requires gitlab.token when comment_on_missing_key is on', () => {
    const env = { GITLAB_WEBHOOK_SECRET: 's3cret-value', JIRA_API_TOKEN: 't' };
    expect(() => parseConfig(`${yaml}\nbehaviours:\n  comment_on_missing_key: true\n`, 'c.yaml', env)).toThrow(
      /gitlab\.token: required when behaviours\.comment_on_missing_key is on/,
    );
  });

  it('accepts an empty ${GITLAB_TOKEN:-} when the feature is off', () => {
    const env = { GITLAB_WEBHOOK_SECRET: 's3cret-value', JIRA_API_TOKEN: 't' };
    const config = parseConfig(yaml.replace('webhook_secret:', 'token: ${GITLAB_TOKEN:-}\n  webhook_secret:'), 'c.yaml', env);
    expect(config.gitlab.token).toBe('');
  });

  it('rejects a key_regex JavaScript cannot compile, such as an inline (?i)', () => {
    const env = { GITLAB_WEBHOOK_SECRET: 's3cret-value', JIRA_API_TOKEN: 't' };
    const bad = yaml.replace('api_token:', "key_regex: '(?i)\\\\b([a-z]+-\\\\d+)\\\\b'\n  api_token:");
    expect(() => parseConfig(bad, 'c.yaml', env)).toThrow(/jira\.key_regex: not a valid JavaScript regex/);
  });
});
