import { pino } from 'pino';
import { describe, expect, it } from 'vitest';
import type { Config } from '../config/schema.js';
import { GitLabClient, GitLabError } from './client.js';

const config = {
  gitlab: { url: 'https://gitlab.example.com/', token: 'glpat-x' },
  behaviours: { dry_run: false },
} as unknown as Config;
const log = pino({ level: 'silent' });
const MARK = '<!-- m -->';

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}

describe('GitLabClient.addNote', () => {
  it('posts the note with the token when none exists yet', async () => {
    const calls: { url: string; method: string; headers: Record<string, string>; body?: string }[] = [];
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      calls.push({ url, method: init?.method ?? 'GET', headers: init?.headers as Record<string, string>, body: init?.body as string });
      return init?.method === 'POST' ? json(201, { id: 1 }) : json(200, [{ body: 'unrelated' }]);
    }) as unknown as typeof fetch;

    const result = await new GitLabClient(config, log, fetchImpl).addNote(77, 42, `${MARK} hi`, MARK);
    expect(result).toEqual({ created: true, dryRun: false });
    expect(calls[0]!.url).toBe('https://gitlab.example.com/api/v4/projects/77/merge_requests/42/notes?sort=asc&order_by=created_at&per_page=100&page=1');
    expect(calls[1]).toMatchObject({ method: 'POST', url: 'https://gitlab.example.com/api/v4/projects/77/merge_requests/42/notes' });
    expect(calls[1]!.headers['PRIVATE-TOKEN']).toBe('glpat-x');
    expect(JSON.parse(calls[1]!.body!)).toEqual({ body: `${MARK} hi` });
  });

  it('does not post when a note with the marker is on a later page', async () => {
    let posts = 0;
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      if (init?.method === 'POST') posts++;
      return url.endsWith('page=1') ? json(200, [{ body: 'a' }], { 'x-next-page': '2' }) : json(200, [{ body: `x ${MARK}` }]);
    }) as unknown as typeof fetch;
    const result = await new GitLabClient(config, log, fetchImpl).addNote(77, 42, 'hi', MARK);
    expect(result.created).toBe(false);
    expect(posts).toBe(0);
  });

  it('throws GitLabError with the status', async () => {
    const fetchImpl = (async () => json(403, { message: 'forbidden' })) as unknown as typeof fetch;
    await expect(new GitLabClient(config, log, fetchImpl).addNote(1, 1, 'x', MARK)).rejects.toMatchObject({
      name: 'GitLabError',
      status: 403,
    });
    expect(new GitLabError('x', 1)).toBeInstanceOf(Error);
  });

  it('makes no request in dry-run', async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      return json(200, []);
    }) as unknown as typeof fetch;
    const dry = { ...config, behaviours: { dry_run: true } } as Config;
    expect(await new GitLabClient(dry, log, fetchImpl).addNote(1, 1, 'x', MARK)).toEqual({ created: false, dryRun: true });
    expect(calls).toBe(0);
  });
});
