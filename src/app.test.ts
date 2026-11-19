import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pino } from 'pino';
import { describe, expect, it } from 'vitest';
import { buildApp } from './app.js';
import { configSchema } from './config/schema.js';
import { JiraClient } from './jira/client.js';
import { AuditLog } from './state/audit.js';
import { DedupeStore } from './state/dedup.js';
import { ActionQueue } from './state/queue.js';
import { Worker } from './worker.js';

const secret = 'test-secret-value';
const log = pino({ level: 'silent' });

function setup(overrides: { dry_run?: boolean; record_skipped?: boolean; jiraStatus?: number; max_attempts?: number } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'gjb-app-'));
  const config = configSchema.parse({
    gitlab: { url: 'https://gitlab.example.com', webhook_secret: secret },
    jira: { base_url: 'https://jira.example.com', email: 'bot@x', api_token: 't' },
    behaviours: { dry_run: overrides.dry_run ?? false },
    audit: { file: join(dir, 'audit.jsonl'), record_skipped: overrides.record_skipped ?? true },
    state_file: join(dir, 'state.json'),
    retry: { queue_file: join(dir, 'queue.json'), inbox_dir: join(dir, 'inbox'), max_attempts: overrides.max_attempts ?? 1 },
  });
  const fetchImpl = (async (_url: string, init?: RequestInit) => {
    const status = overrides.jiraStatus ?? 200;
    if (status >= 400) return new Response('nope', { status });
    if (init?.method === 'PUT') return new Response(null, { status: 204 });
    if (init?.method === 'POST') return new Response('{}', { status: 201 });
    return new Response(JSON.stringify({ fields: { labels: ['keep'], status: { name: 'Open' } } }), { status: 200 });
  }) as unknown as typeof fetch;
  const audit = new AuditLog(config.audit.file);
  const queue = new ActionQueue(config.retry.queue_file);
  const worker = new Worker(config, {
    queue,
    state: new DedupeStore(config.state_file),
    jira: new JiraClient(config, log, fetchImpl),
    audit,
    log,
  });
  const app = buildApp(config, { worker, queue, log, audit });
  return { app, audit, worker };
}

function deliver(app: ReturnType<typeof setup>['app'], body: unknown, opts: { token?: string | null; uuid?: string } = {}) {
  const payload = JSON.stringify(body);
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  const token = opts.token === undefined ? secret : opts.token;
  if (token !== null) headers['x-gitlab-token'] = token;
  if (opts.uuid) headers['x-gitlab-event-uuid'] = opts.uuid;
  return app.inject({ method: 'POST', url: '/webhook', payload, headers });
}

/** Deliver, then wait for the worker to apply what was queued. */
async function deliverAndDrain(ctx: ReturnType<typeof setup>, body: unknown, opts: Parameters<typeof deliver>[2] = {}) {
  const res = await deliver(ctx.app, body, opts);
  await ctx.worker.drain();
  return res;
}

const merged = {
  object_kind: 'merge_request',
  project: { path_with_namespace: 'g/p' },
  object_attributes: {
    id: 900,
    iid: 42,
    action: 'merge',
    title: 'ABC-123 Add the thing',
    source_branch: 'feature/abc-123',
    target_branch: 'main',
    merge_commit_sha: 'deadbeefcafe',
    url: 'https://gitlab.example.com/g/p/-/merge_requests/42',
  },
};

describe('webhook audit trail', () => {
  it('records each applied action with delivery, MR and label before/after', async () => {
    const ctx = setup();
    const { audit } = ctx;
    const res = await deliverAndDrain(ctx, merged, { uuid: 'uuid-1' });
    expect(res.statusCode).toBe(200);

    const rows = audit.list({ key: 'ABC-123' });
    expect(rows.length).toBeGreaterThan(0);
    const labels = rows.find((r) => r.kind === 'labels')!;
    expect(labels).toMatchObject({
      outcome: 'applied',
      delivery: 'uuid-1',
      event: 'merge_request',
      project: 'g/p',
      mr_iid: 42,
      before: ['keep'],
    });
    expect(labels.after).toContain('merged');
    expect(labels.after).toContain('keep');
  });

  it('records a redelivery as duplicate', async () => {
    const ctx = setup();
    const { audit } = ctx;
    await deliverAndDrain(ctx, merged);
    await deliverAndDrain(ctx, merged);
    const outcomes = audit.list().map((r) => r.outcome);
    expect(outcomes).toContain('duplicate');
  });

  it('records dry-run actions as dry_run', async () => {
    const ctx = setup({ dry_run: true });
    const { audit } = ctx;
    await deliverAndDrain(ctx, merged);
    expect(new Set(audit.list().map((r) => r.outcome))).toEqual(new Set(['dry_run']));
  });

  it('does not mark dry-run actions as done, so they apply once dry_run is off', async () => {
    const ctx = setup({ dry_run: true });
    const { audit } = ctx;
    await deliverAndDrain(ctx, merged);
    await deliverAndDrain(ctx, merged);
    expect(audit.list().map((r) => r.outcome)).not.toContain('duplicate');
  });

  it('records Jira failures with the error', async () => {
    const ctx = setup({ jiraStatus: 404 });
    const { audit } = ctx;
    await deliverAndDrain(ctx, merged);
    const [row] = audit.list({ outcome: 'failed' });
    expect(row).toMatchObject({ outcome: 'failed_permanent' });
    expect(row!.detail).toContain('404');
  });

  it('records a missing token with the caller IP', async () => {
    const ctx = setup();
    const { audit } = ctx;
    const res = await deliverAndDrain(ctx, merged, { token: null });
    expect(res.statusCode).toBe(401);
    expect(audit.list()[0]).toMatchObject({
      kind: 'webhook',
      outcome: 'rejected',
      detail: 'missing X-Gitlab-Token header',
      source_ip: '127.0.0.1',
    });
  });

  it('rejects a wrong token as a mismatch', async () => {
    const ctx = setup();
    const { audit } = ctx;
    const res = await deliverAndDrain(ctx, merged, { token: 'wrong-token-value' });
    expect(res.statusCode).toBe(401);
    expect(audit.list()[0]).toMatchObject({ outcome: 'rejected', detail: 'token mismatch' });
  });

  it('records why nothing was planned', async () => {
    const ctx = setup();
    const { audit } = ctx;
    await deliverAndDrain(ctx, { ...merged, object_attributes: { ...merged.object_attributes, title: 'no key', source_branch: 'x' } });
    expect(audit.list()[0]).toMatchObject({ outcome: 'skipped', mr_iid: 42 });
    expect(audit.list()[0]!.detail).toMatch(/Jira key/);
  });

  it('omits skipped deliveries when record_skipped is off, but keeps rejections', async () => {
    const ctx = setup({ record_skipped: false });
    const { audit } = ctx;
    await deliverAndDrain(ctx, { object_kind: 'push' });
    await deliverAndDrain(ctx, merged, { token: null });
    expect(audit.list().map((r) => r.outcome)).toEqual(['rejected']);
  });

  it('answers 200 while Jira is down and keeps the action queued', async () => {
    const ctx = setup({ jiraStatus: 503, max_attempts: 5 });
    const res = await deliverAndDrain(ctx, merged);
    expect(res.statusCode).toBe(200);
    expect(res.json().queued.length).toBeGreaterThan(0);
    expect(ctx.audit.list({ outcome: 'failed_transient' }).length).toBeGreaterThan(0);
    const health = await ctx.app.inject({ method: 'GET', url: '/healthz' });
    expect(health.json().queue.retrying).toBeGreaterThan(0);
    await ctx.worker.stop();
  });

  it('reports the version on /healthz', async () => {
    const { app } = setup();
    const health = (await app.inject({ method: 'GET', url: '/healthz' })).json();
    expect(health).toMatchObject({ ok: true, dry_run: false, queue: { pending: 0, retrying: 0 } });
    expect(health.version).toMatch(/^\d+\.\d+\.\d+/);
  });
});
