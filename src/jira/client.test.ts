import { describe, expect, it } from 'vitest';
import type { Config } from '../config/schema.js';
import { JiraClient, JiraError } from './client.js';
import { pino } from 'pino';

const config = {
  jira: { base_url: 'https://jira.example.com', email: 'bot@x', api_token: 't' },
  behaviours: { dry_run: false },
} as unknown as Config;

const log = pino({ level: 'silent' });

function jsonResponse(status: number, body: unknown): Response {
  // A Response with a null-body status (204/304) must not carry a body.
  if (status === 204) return new Response(null, { status });
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('JiraClient.applyLabels', () => {
  it('merges add/remove against current labels and PUTs the union', async () => {
    const calls: { url: string; method?: string; body?: string }[] = [];
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      calls.push({ url, method: init?.method, body: init?.body as string });
      if (init?.method === 'PUT') return jsonResponse(204, {});
      return jsonResponse(200, { fields: { labels: ['keep', 'needs-review'], status: { name: 'In Progress' } } });
    }) as unknown as typeof fetch;

    const client = new JiraClient(config, log, fetchImpl);
    await client.applyLabels('ABC-1', ['merged'], ['needs-review']);

    expect(calls).toHaveLength(2);
    expect(calls[1]!.url).toBe('https://jira.example.com/rest/api/3/issue/ABC-1?notifyUsers=false');
    // Add/remove operations, never the whole list: a concurrent hand edit survives.
    const put = JSON.parse(calls[1]!.body!) as { update: { labels: unknown[] } };
    expect(put).toEqual({ update: { labels: [{ remove: 'needs-review' }, { add: 'merged' }] } });
  });

  it('only sends operations that change something, and drops disabled (empty) labels', async () => {
    const bodies: string[] = [];
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      if (init?.method === 'PUT') {
        bodies.push(init.body as string);
        return jsonResponse(204, {});
      }
      return jsonResponse(200, { fields: { labels: ['merged', 'keep'], status: { name: 'Done' } } });
    }) as unknown as typeof fetch;

    const client = new JiraClient(config, log, fetchImpl);
    const result = await client.applyLabels('ABC-1', ['merged', 'approved', ''], ['needs-review', '', 'keep']);
    expect(JSON.parse(bodies[0]!)).toEqual({ update: { labels: [{ remove: 'keep' }, { add: 'approved' }] } });
    expect(result).toEqual({ changed: true, dryRun: false, before: ['merged', 'keep'], after: ['merged', 'approved'] });
  });

  it('skips the write when the labels would not change', async () => {
    let puts = 0;
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      if (init?.method === 'PUT') puts++;
      return init?.method === 'PUT'
        ? jsonResponse(204, {})
        : jsonResponse(200, { fields: { labels: ['merged'], status: { name: 'Done' } } });
    }) as unknown as typeof fetch;

    const client = new JiraClient(config, log, fetchImpl);
    await client.applyLabels('ABC-1', ['merged'], ['needs-review']);
    expect(puts).toBe(0);
  });

  it('throws JiraError with status on failure', async () => {
    const fetchImpl = (async () => jsonResponse(404, { error: 'no such issue' })) as unknown as typeof fetch;
    const client = new JiraClient(config, log, fetchImpl);
    await expect(client.applyLabels('NOPE-1', ['x'], [])).rejects.toBeInstanceOf(JiraError);
  });
});

describe('JiraClient.addComment', () => {
  it('posts ADF with inline code marks', async () => {
    let body = '';
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      body = init?.body as string;
      return jsonResponse(201, { id: '1' });
    }) as unknown as typeof fetch;

    const client = new JiraClient(config, log, fetchImpl);
    await client.addComment('ABC-1', 'Merged into `main` as `deadbeef`');

    const doc = JSON.parse(body) as {
      body: { content: { content: { text: string; marks?: { type: string }[] }[] }[] };
    };
    const texts = doc.body.content[0]!.content.map((c) => c.text);
    expect(texts).toEqual(['Merged into ', 'main', ' as ', 'deadbeef']);
    const marks = doc.body.content[0]!.content.map((c) => c.marks?.[0]?.type ?? null);
    expect(marks).toEqual([null, 'code', null, 'code']);
  });

  it('turns URLs into links and every line into its own paragraph', async () => {
    let body = '';
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      body = init?.body as string;
      return jsonResponse(201, { id: '1' });
    }) as unknown as typeof fetch;

    const client = new JiraClient(config, log, fetchImpl);
    await client.addComment(
      'ABC-1',
      '🔀 Merge request opened: `abc-1-x` → `main`\n[group/project !42](https://gitlab.example.com/g/p/-/merge_requests/42)',
    );

    const doc = JSON.parse(body) as {
      body: { type: string; version: number; content: { content: Record<string, unknown>[] }[] };
    };
    expect(doc.body).toMatchObject({ type: 'doc', version: 1 });
    expect(doc.body.content).toHaveLength(2);
    expect(doc.body.content[0]!.content).toEqual([
      { type: 'text', text: '🔀 Merge request opened: ' },
      { type: 'text', text: 'abc-1-x', marks: [{ type: 'code' }] },
      { type: 'text', text: ' → ' },
      { type: 'text', text: 'main', marks: [{ type: 'code' }] },
    ]);
    expect(doc.body.content[1]!.content).toEqual([
      {
        type: 'text',
        text: 'group/project !42',
        marks: [{ type: 'link', attrs: { href: 'https://gitlab.example.com/g/p/-/merge_requests/42' } }],
      },
    ]);
  });

  it('links bare URLs too, because Jira does not auto-link API text', async () => {
    let body = '';
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      body = init?.body as string;
      return jsonResponse(201, { id: '1' });
    }) as unknown as typeof fetch;

    const client = new JiraClient(config, log, fetchImpl);
    await client.addComment('ABC-1', 'see https://gitlab.example.com/g/p/-/merge_requests/42 for details');

    const doc = JSON.parse(body) as { body: { content: { content: Record<string, unknown>[] }[] } };
    expect(doc.body.content[0]!.content).toEqual([
      { type: 'text', text: 'see ' },
      {
        type: 'text',
        text: 'https://gitlab.example.com/g/p/-/merge_requests/42',
        marks: [{ type: 'link', attrs: { href: 'https://gitlab.example.com/g/p/-/merge_requests/42' } }],
      },
      { type: 'text', text: ' for details' },
    ]);
  });

  it('tags the comment with the action id', async () => {
    const posts: string[] = [];
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      if (init?.method === 'POST') {
        posts.push(init.body as string);
        return jsonResponse(201, { id: '1' });
      }
      return jsonResponse(200, { comments: [] });
    }) as unknown as typeof fetch;

    const client = new JiraClient(config, log, fetchImpl);
    expect(await client.addComment('ABC-1', 'hello', '900:open-comment')).toEqual({ created: true, dryRun: false });
    expect(JSON.parse(posts[0]!).properties).toEqual([
      { key: 'gitlab-jira-bridge', value: { action_id: '900:open-comment' } },
    ]);
  });

  it('does not post again when a comment for the action id is already there', async () => {
    const urls: string[] = [];
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      urls.push(`${init?.method ?? 'GET'} ${url}`);
      return jsonResponse(200, {
        comments: [
          { properties: [] },
          { properties: [{ key: 'gitlab-jira-bridge', value: { action_id: '900:open-comment' } }] },
        ],
      });
    }) as unknown as typeof fetch;

    const client = new JiraClient(config, log, fetchImpl);
    expect(await client.addComment('ABC-1', 'hello', '900:open-comment')).toEqual({ created: false, dryRun: false });
    expect(urls).toEqual(['GET https://jira.example.com/rest/api/3/issue/ABC-1/comment?orderBy=-created&maxResults=50&expand=properties']);
  });

  it('makes no request in dry-run', async () => {
    let calls = 0;
    const dry = { ...config, behaviours: { dry_run: true } } as Config;
    const fetchImpl = (async () => {
      calls++;
      return jsonResponse(200, {});
    }) as unknown as typeof fetch;
    const client = new JiraClient(dry, log, fetchImpl);
    await client.addComment('ABC-1', 'hello');
    await client.applyLabels('ABC-1', ['x'], []);
    expect(calls).toBe(0);
  });
});
