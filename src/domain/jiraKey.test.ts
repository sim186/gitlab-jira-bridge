import { describe, expect, it } from 'vitest';
import { extractJiraKeys, resolveJiraKey } from './jiraKey.js';

const keyRegex = '\\b([A-Z][A-Z0-9]+-\\d+)\\b';
const strict = { keyRegex };
const projects = { keyRegex, projectKeys: ['ABC', 'XYZ'] };
const withOther = { keyRegex, projectKeys: ['ABC', 'XYZ'], otherProjectKeys: ['DEF'] };

const mr = (title: string, branch: string, description = '') => [
  { field: 'title', text: title },
  { field: 'branch', text: branch },
  { field: 'description', text: description },
];

describe('extractJiraKeys', () => {
  it('finds a key and dedupes', () => {
    expect(extractJiraKeys('ABC-1 Fix, see ABC-1', strict)).toEqual(['ABC-1']);
  });

  it('ignores configured non-keys', () => {
    expect(extractJiraKeys('TODO-1 maybe', { ...strict, ignoreRegex: '^TODO-\\d+$' })).toEqual([]);
  });

  it('without project_keys, lowercase is not a key', () => {
    expect(extractJiraKeys('feature/abc-1-fix', strict)).toEqual([]);
  });

  it('with project_keys, matches any case and normalises to uppercase', () => {
    expect(extractJiraKeys('feature/abc-12-fix', projects)).toEqual(['ABC-12']);
    expect(extractJiraKeys('xyz-3_hotfix', projects)).toEqual(['XYZ-3']);
  });

  it('with project_keys, unknown projects and look-alikes are ignored', () => {
    expect(extractJiraKeys('bump node-22, utf-8, DEF-4', projects)).toEqual([]);
    expect(extractJiraKeys('ABC-1 and ABCD-2 and abc-30x', projects)).toEqual(['ABC-1']);
  });

  it('never returns keys of untracked projects as keys', () => {
    expect(extractJiraKeys('ABC-1 and DEF-2', withOther)).toEqual(['ABC-1']);
    expect(extractJiraKeys('def-2 only', withOther)).toEqual([]);
  });
});

describe('resolveJiraKey', () => {
  it('takes the title over a different key in the description', () => {
    expect(resolveJiraKey(mr('ABC-1 Fix login', 'fix', 'Follow-up of ABC-2'), strict)).toEqual({
      status: 'found',
      key: 'ABC-1',
      field: 'title',
    });
  });

  it('falls back to the branch, then the description', () => {
    expect(resolveJiraKey(mr('Fix login', 'ABC-7-fix'), strict)).toMatchObject({ key: 'ABC-7', field: 'branch' });
    expect(resolveJiraKey(mr('Fix login', 'fix', 'Closes ABC-9'), strict)).toMatchObject({ key: 'ABC-9', field: 'description' });
  });

  it('finds a lowercase branch key when project_keys is set', () => {
    expect(resolveJiraKey(mr('Fix login', 'feature/abc-1-fix'), projects)).toMatchObject({ key: 'ABC-1', field: 'branch' });
  });

  it('is ambiguous when the first source naming keys names two, and does not look further', () => {
    expect(resolveJiraKey(mr('ABC-1 / ABC-2 combined', 'ABC-3'), strict)).toEqual({
      status: 'ambiguous',
      field: 'title',
      keys: ['ABC-1', 'ABC-2'],
    });
  });

  it('reports none when nothing matches', () => {
    expect(resolveJiraKey(mr('Fix login', 'fix'), strict)).toEqual({ status: 'none' });
  });
});

describe('resolveJiraKey with other_project_keys', () => {
  it('reports a key of an untracked project as foreign, not as missing', () => {
    expect(resolveJiraKey(mr('DEF-156 tower merge', 'feat/def-156-tower-merge'), withOther)).toEqual({
      status: 'foreign',
      field: 'title',
      keys: ['DEF-156'],
    });
  });

  it('a tracked key still wins over a foreign one in the same source', () => {
    expect(resolveJiraKey(mr('ABC-1 follow-up of DEF-2', 'x'), withOther)).toMatchObject({
      status: 'found',
      key: 'ABC-1',
    });
  });

  it('a foreign key stops the search like any other named key', () => {
    expect(resolveJiraKey(mr('DEF-2 x', 'abc-9-fix'), withOther)).toEqual({
      status: 'foreign',
      field: 'title',
      keys: ['DEF-2'],
    });
  });

  it('without other_project_keys the same key is simply not a key', () => {
    expect(resolveJiraKey(mr('DEF-156 tower merge', 'feat/def-156-tower-merge'), projects)).toEqual({ status: 'none' });
  });

  it('subtracts other projects in key_regex mode too', () => {
    expect(resolveJiraKey(mr('DEF-1 x', 'fix'), { keyRegex, otherProjectKeys: ['DEF'] })).toEqual({
      status: 'foreign',
      field: 'title',
      keys: ['DEF-1'],
    });
  });
});
