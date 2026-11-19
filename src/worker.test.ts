import { mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pino } from 'pino';
import { afterEach, describe, expect, it } from 'vitest';
import { configSchema, type Config } from './config/schema.js';
import type { JiraAction } from './domain/actions.js';
import { JiraClient } from './jira/client.js';
import { GitLabClient } from './gitlab/client.js';
import { AuditLog } from './state/audit.js';
import { DedupeStore } from './state/dedup.js';
import { ActionQueue } from './state/queue.js';
import { Worker, writeReplayRequest } from './worker.js';

const log = pino({ level: 'silent' });

/** Jira stub: `responses` is consumed per request, then `fallback` answers. */
function jiraStub(script: { status: number }[], fallback = 200) {
  const calls: { method: string; url: string; body?: string }[] = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    calls.push({ method, url, body: init?.body as string | undefined });
    const status = script.shift()?.status ?? fallback;
    if (status >= 400) return new Response('err', { status });
    if (method === 'PUT') return new Response(null, { status: 204 });
    if (method === 'POST') return new Response('{}', { status: 201 });
    return new Response(JSON.stringify({ fields: { labels: [], status: { name: 'Open' } } }), { status: 200 });
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

const workers: Worker[] = [];
afterEach(async () => {
  await Promise.all(workers.splice(0).map((w) => w.stop()));
});

function setup(fetchImpl: typeof fetch, retry: Partial<Config['retry']> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'gjb-worker-'));
  const config = configSchema.parse({
    gitlab: { url: 'https://gitlab.example.com', webhook_secret: 'secret-value' },
    jira: { base_url: 'https://jira.example.com', email: 'bot@x', api_token: 't' },
    audit: { file: join(dir, 'audit.jsonl') },
    state_file: join(dir, 'state.json'),
    retry: { queue_file: join(dir, 'queue.json'), inbox_dir: join(dir, 'inbox'), max_attempts: 3, ...retry },
  });
  let now = new Date('2026-11-19T10:00:00Z');
  const clock = {
    now: () => now,
    advance: (seconds: number) => {
      now = new Date(now.getTime() + seconds * 1000);
    },
  };
  const make = () => {
    const queue = new ActionQueue(config.retry.queue_file);
    const state = new DedupeStore(config.state_file);
    const audit = new AuditLog(config.audit.file, undefined, clock.now);
    const worker = new Worker(config, { queue, state, jira: new JiraClient(config, log, fetchImpl), audit, log, now: clock.now });
    workers.push(worker);
    return { queue, state, audit, worker };
  };
  return { config, clock, make, dir };
}

const comment = (id: string, key = 'ABC-1'): JiraAction => ({ kind: 'comment', id, key, text: `c ${id}` });
const labels = (id: string, add: string[], key = 'ABC-1'): JiraAction => ({ kind: 'labels', id, key, add, remove: [] });

describe('Worker', () => {
  it('applies queued actions and marks them done', async () => {
    const { fetchImpl, calls } = jiraStub([]);
    const { make } = setup(fetchImpl);
    const { worker, queue, state, audit } = make();

    expect(worker.enqueue([comment('a')], { delivery: 'd1' })).toEqual({ queued: ['a'], duplicates: [] });
    await worker.drain();

    expect(calls.map((c) => c.method)).toEqual(['GET', 'POST']); // duplicate check, then post
    expect(queue.size).toBe(0);
    expect(state.has('a')).toBe(true);
    expect(audit.list()[0]).toMatchObject({ outcome: 'applied', delivery: 'd1', action_id: 'a' });
  });

  it('skips ids that are already done or already queued', async () => {
    const { fetchImpl } = jiraStub([{ status: 503 }]);
    const { make } = setup(fetchImpl);
    const { worker } = make();
    worker.enqueue([comment('a')], {});
    await worker.drain(); // fails transiently, stays queued
    expect(worker.enqueue([comment('a')], {}).duplicates).toEqual(['a']);
  });

  it('retries transient failures with exponential backoff, then succeeds', async () => {
    const { fetchImpl, calls } = jiraStub([{ status: 503 }, { status: 502 }]);
    const { make, clock } = setup(fetchImpl, { base_delay_seconds: 30, max_attempts: 5 });
    const { worker, queue, audit } = make();

    worker.enqueue([comment('a')], {});
    await worker.drain();
    expect(queue.all()[0]).toMatchObject({ attempts: 1, next_at: '2026-11-19T10:00:30.000Z' });

    clock.advance(29);
    await worker.drain();
    expect(calls).toHaveLength(1); // not due yet

    clock.advance(1);
    await worker.drain();
    expect(queue.all()[0]).toMatchObject({ attempts: 2, next_at: '2026-11-19T10:01:30.000Z' }); // +60s

    clock.advance(60);
    await worker.drain();
    expect(queue.size).toBe(0);
    expect(audit.list().map((r) => r.outcome)).toEqual(['applied', 'failed_transient', 'failed_transient']);
    expect(audit.list()[0]!.attempt).toBe(3);
  });

  it('caps the backoff delay', () => {
    const { make } = setup(jiraStub([]).fetchImpl, { base_delay_seconds: 30, max_delay_seconds: 100 });
    const { worker } = make();
    expect([1, 2, 3, 4, 10].map((a) => worker.backoffMs(a) / 1000)).toEqual([30, 60, 100, 100, 100]);
  });

  it('abandons after max_attempts and keeps the full action for replay', async () => {
    const { fetchImpl } = jiraStub([], 503);
    const { make, clock } = setup(fetchImpl, { max_attempts: 2, base_delay_seconds: 1 });
    const { worker, queue, state, audit } = make();

    worker.enqueue([comment('a')], {});
    await worker.drain();
    clock.advance(1);
    await worker.drain();

    expect(queue.size).toBe(0);
    expect(state.has('a')).toBe(false);
    const [row] = audit.list();
    expect(row).toMatchObject({ outcome: 'abandoned', attempt: 2, action: comment('a') });
    expect(row!.detail).toMatch(/gave up after 2 attempts/);
  });

  it('does not retry permanent failures', async () => {
    const { fetchImpl, calls } = jiraStub([{ status: 404 }]);
    const { make } = setup(fetchImpl);
    const { worker, queue, audit } = make();
    worker.enqueue([comment('a')], {});
    await worker.drain();
    expect(calls).toHaveLength(1);
    expect(queue.size).toBe(0);
    expect(audit.list()[0]).toMatchObject({ outcome: 'failed_permanent', action: comment('a') });
  });

  it('keeps per-ticket order: a later action waits behind a retrying one, other tickets do not', async () => {
    // The first request (ABC-1's comment duplicate check) fails; everything after succeeds.
    const { fetchImpl, calls } = jiraStub([{ status: 503 }]);
    const { make, clock } = setup(fetchImpl, { base_delay_seconds: 30 });
    const { worker, audit } = make();

    worker.enqueue([comment('first', 'ABC-1'), labels('second', ['merged'], 'ABC-1'), comment('other', 'XYZ-9')], {});
    await worker.drain();

    // ABC-1 failed before writing, its follow-up waited, the other ticket went ahead.
    expect(calls.filter((c) => c.method !== 'GET').map((c) => c.url.split('/issue/')[1])).toEqual(['XYZ-9/comment']);

    clock.advance(30);
    await worker.drain();
    const applied = audit.list({ outcome: 'applied' }).map((r) => r.action_id).reverse();
    expect(applied).toEqual(['other', 'first', 'second']);
  });

  it('resumes the queue after a restart', async () => {
    const { fetchImpl } = jiraStub([{ status: 503 }]);
    const { make, clock } = setup(fetchImpl, { base_delay_seconds: 1 });
    const first = make();
    first.worker.enqueue([comment('a')], {});
    await first.worker.drain();
    await first.worker.stop();

    clock.advance(1);
    const second = make();
    expect(second.queue.size).toBe(1);
    await second.worker.drain();
    expect(second.queue.size).toBe(0);
    expect(second.state.has('a')).toBe(true);
  });

  it('dry-run applies nothing and consumes no ids', async () => {
    const { fetchImpl, calls } = jiraStub([]);
    const { config, make } = setup(fetchImpl);
    config.behaviours.dry_run = true;
    const { worker, state, audit } = make();
    worker.enqueue([comment('a'), labels('b', ['x'])], {});
    await worker.drain();
    expect(calls).toHaveLength(0);
    expect(state.has('a') || state.has('b')).toBe(false);
    expect(audit.list().map((r) => r.outcome)).toEqual(['dry_run', 'dry_run']);
  });

  it('ingests replay requests from the inbox, forgetting the dedup id', async () => {
    const { fetchImpl, calls } = jiraStub([{ status: 404 }]);
    const { config, make } = setup(fetchImpl);
    const { worker, state, audit } = make();

    worker.enqueue([comment('a')], {});
    await worker.drain();
    expect(state.has('a')).toBe(true); // permanent failure marks it done

    writeReplayRequest(config.retry.inbox_dir, { items: [{ action: comment('a'), context: { delivery: 'd1' } }] });
    worker.ingestInbox();
    await worker.drain();

    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(1);
    expect(audit.list().map((r) => r.outcome)).toEqual(['applied', 'replay_queued', 'failed_permanent']);
    expect(readdirSync(config.retry.inbox_dir)).toEqual([]);
  });

  it('posts an MR note through the GitLab client and audits it without a Jira key', async () => {
    const gitlabCalls: string[] = [];
    const gitlabFetch = (async (url: string, init?: RequestInit) => {
      gitlabCalls.push(`${init?.method ?? 'GET'} ${url.replace(/\?.*/, '')}`);
      return new Response(init?.method === 'POST' ? '{}' : '[]', { status: init?.method === 'POST' ? 201 : 200 });
    }) as unknown as typeof fetch;
    const { config, make } = setup(jiraStub([]).fetchImpl);
    const { queue, state, audit } = make();
    const worker = new Worker(config, {
      queue,
      state,
      jira: new JiraClient(config, log, jiraStub([]).fetchImpl),
      gitlab: new GitLabClient(config, log, gitlabFetch),
      audit,
      log,
    });
    workers.push(worker);

    const note: JiraAction = { kind: 'mr_note', id: '900:missing-key-note', key: 'gitlab:77!42', project_id: 77, mr_iid: 42, text: 'hi' };
    worker.enqueue([note], { project: 'g/p' });
    await worker.drain();

    expect(gitlabCalls).toEqual([
      'GET https://gitlab.example.com/api/v4/projects/77/merge_requests/42/notes',
      'POST https://gitlab.example.com/api/v4/projects/77/merge_requests/42/notes',
    ]);
    const [row] = audit.list();
    expect(row).toMatchObject({ kind: 'mr_note', outcome: 'applied', mr_iid: 42, project: 'g/p' });
    expect(row!.key).toBeUndefined();
  });

  it('fails an MR note permanently when no GitLab client is configured', async () => {
    const { make } = setup(jiraStub([]).fetchImpl);
    const { worker, audit } = make();
    worker.enqueue([{ kind: 'mr_note', id: 'n', key: 'gitlab:1!1', project_id: 1, mr_iid: 1, text: 'x' }], {});
    await worker.drain();
    expect(audit.list()[0]).toMatchObject({ outcome: 'failed_permanent', detail: 'no GitLab client: gitlab.token not configured' });
  });
});
