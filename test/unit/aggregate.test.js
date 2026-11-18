import test from 'node:test';
import assert from 'node:assert/strict';
import { aggregateRepositories } from '../../src/server/domain/aggregate.js';

const membersConfig = [
  {
    id: 'alice',
    displayName: 'Alice Chen',
    names: ['Alice'],
    emails: ['alice@example.com'],
    internal: true,
  },
  {
    id: 'zoe',
    displayName: 'Zoe Wang',
    names: ['Zoe'],
    emails: ['zoe@example.com'],
    internal: true,
  },
  {
    id: 'vendor',
    displayName: 'Vendor Bob',
    names: ['Bob'],
    emails: ['bob@vendor.example'],
    internal: false,
  },
];

function commit(oid, overrides = {}) {
  return {
    oid,
    authorName: 'Alice',
    authorEmail: 'alice@example.com',
    authoredAt: '2026-10-15T04:00:00.000Z',
    parents: ['parent'],
    inDefault: true,
    files: [],
    ...overrides,
  };
}

function cache(commits, overrides = {}) {
  return {
    scannedAt: '2026-10-15T05:00:00.000Z',
    repository: { root: '/repo', shallow: false, gitVersion: 'git version 2' },
    defaultBranch: 'main',
    currentBranch: 'main',
    refsFingerprint: 'fingerprint',
    branches: [],
    commits,
    diagnostics: [],
    ...overrides,
  };
}

function aggregate(commits, options = {}, cacheOverrides = {}) {
  return aggregateRepositories(
    [{ repo: { id: 'app', name: 'App' }, cache: cache(commits, cacheOverrides) }],
    {
      from: '2026-10-14',
      to: '2026-10-16',
      branch: 'default',
      scope: 'group',
      members: [],
      granularity: 'day',
      membersConfig,
      pathFilter: {},
      ...options,
    },
  );
}

test('默认分支只统计 inDefault，全部分支统计所有提交', () => {
  const commits = [
    commit('default'),
    commit('feature', { inDefault: false }),
  ];

  assert.equal(aggregate(commits).summary.commits, 1);
  assert.equal(aggregate(commits, { branch: 'all' }).summary.commits, 2);
});

test('具体分支只统计该分支可达的提交', () => {
  const commits = [
    commit('base', { parents: [] }),
    commit('feature-1', { parents: ['base'], inDefault: false }),
    commit('feature-2', { parents: ['feature-1'], inDefault: false }),
    commit('other', { parents: ['base'], inDefault: false }),
  ];
  const branches = [
    { ref: 'refs/remotes/origin/feature/demo', name: 'origin/feature/demo', oid: 'feature-2' },
    { ref: 'refs/remotes/origin/other', name: 'origin/other', oid: 'other' },
  ];

  const result = aggregate(commits, { branch: 'refs/remotes/origin/feature/demo' }, { branches });
  assert.equal(result.summary.commits, 3);
  assert.equal(result.members[0].commits, 3);
});

test('merge 与有效提交分开统计且 merge 不计增删行', () => {
  const result = aggregate([
    commit('normal', { files: [{ path: 'src/app.js', added: 7, deleted: 2, binary: false }] }),
    commit('merge', {
      parents: ['left', 'right'],
      files: [{ path: 'src/ignored.js', added: 100, deleted: 100, binary: false }],
    }),
  ]);

  assert.deepEqual(
    {
      commits: result.summary.commits,
      merges: result.summary.merges,
      mergeRatio: result.summary.mergeRatio,
      additions: result.summary.additions,
      deletions: result.summary.deletions,
      churn: result.summary.churn,
    },
    { commits: 1, merges: 1, mergeRatio: 0.5, additions: 7, deletions: 2, churn: 9 },
  );
  assert.equal(result.members[0].commits, 1);
  assert.equal(result.members[0].merges, 1);
});

test('身份映射、组内范围和成员 id 筛选正确', () => {
  const commits = [
    commit('alice-email', { authorName: 'Alias', authorEmail: 'ALICE@example.com' }),
    commit('zoe', { authorName: 'Zoe', authorEmail: 'zoe@example.com' }),
    commit('external', { authorName: 'Bob', authorEmail: 'bob@vendor.example' }),
    commit('unknown', { authorName: 'Mystery', authorEmail: 'secret@example.com' }),
  ];

  const group = aggregate(commits);
  assert.equal(group.summary.commits, 2);
  assert.deepEqual(group.members.map(({ id, displayName }) => [id, displayName]), [
    ['alice', 'Alice Chen'],
    ['zoe', 'Zoe Wang'],
  ]);

  const selected = aggregate(commits, { scope: 'all', members: ['zoe'] });
  assert.equal(selected.summary.commits, 1);
  assert.deepEqual(selected.members.map(({ id }) => id), ['zoe']);

  const all = aggregate(commits, { scope: 'all' });
  assert.equal(all.summary.commits, 4);
  assert.deepEqual(all.quality.unmatchedIdentities.map(({ authorName, commits: count }) => [authorName, count]), [
    ['Mystery', 1],
  ]);
  assert.ok(!JSON.stringify(all.quality.unmatchedIdentities).includes('secret@example.com'));
});

test('排除路径不计增删并统计排除文件', () => {
  const result = aggregate([
    commit('paths', {
      files: [
        { path: 'dist/app.js', added: 20, deleted: 3, binary: false },
        { path: 'src/app.js', added: 5, deleted: 1, binary: false },
        { path: 'src/generated.js', oldPath: 'dist/generated.js', added: 9, deleted: 9, binary: false },
      ],
    }),
  ], { pathFilter: { directories: ['dist'] } });

  assert.equal(result.summary.additions, 5);
  assert.equal(result.summary.deletions, 1);
  assert.equal(result.quality.excludedFiles, 2);
});

test('上海时区日期含首尾边界并填充每日活动', () => {
  const result = aggregate([
    commit('before', { authoredAt: '2026-10-13T15:59:59.999Z' }),
    commit('start', { authoredAt: '2026-10-13T16:00:00.000Z' }),
    commit('end', { authoredAt: '2026-10-16T15:59:59.999Z' }),
    commit('after', { authoredAt: '2026-10-16T16:00:00.000Z' }),
  ]);

  assert.equal(result.summary.commits, 2);
  assert.equal(result.summary.activeDays, 2);
  assert.equal(result.summary.totalDays, 3);
  assert.deepEqual(result.activity.map(({ date, count }) => [date, count]), [
    ['2026-10-14', 1],
    ['2026-10-15', 0],
    ['2026-10-16', 1],
  ]);
});

test('异常提交只做标记且不改变原有统计口径', () => {
  const result = aggregate([
    commit('large', {
      files: [
        { path: 'src/large.js', added: 1_600, deleted: 500, binary: false },
        { path: 'dist/generated.js', added: 8_000, deleted: 0, binary: false },
        { path: 'asset/logo.png', added: 0, deleted: 0, binary: true },
      ],
    }),
    commit('normal', { files: [{ path: 'src/app.js', added: 10, deleted: 2, binary: false }] }),
    commit('merge', {
      parents: ['left', 'right'],
      files: [{ path: 'src/merge.js', added: 5_000, deleted: 5_000, binary: false }],
    }),
  ], { pathFilter: { directories: ['dist'] } });

  assert.deepEqual(
    {
      commits: result.summary.commits,
      merges: result.summary.merges,
      additions: result.summary.additions,
      deletions: result.summary.deletions,
      churn: result.summary.churn,
    },
    { commits: 2, merges: 1, additions: 1_610, deletions: 502, churn: 2_112 },
  );
  assert.equal(result.summary.anomalyCommits, 1);
  assert.equal(result.members[0].anomalyCommits, 1);
  assert.equal(result.anomalies.length, 1);
  assert.deepEqual(result.anomalies[0].rules.map(({ code }) => code), ['LARGE_CHURN', 'LARGE_ADDITIONS']);
  assert.equal(result.anomalies[0].churn, 2_100);
  assert.equal(result.anomalies[0].filesChanged, 1);
  assert.equal(result.anomalyPolicy.mode, 'flag-only');
});

test('大量有效文本文件会标记异常且同一提交只计一次', () => {
  const files = Array.from({ length: 50 }, (_, index) => ({
    path: `src/file-${index}.js`,
    added: 40,
    deleted: 0,
    binary: false,
  }));
  const result = aggregate([commit('many-files', { files })]);

  assert.equal(result.summary.commits, 1);
  assert.equal(result.summary.additions, 2_000);
  assert.equal(result.summary.anomalyCommits, 1);
  assert.equal(result.members[0].anomalyCommits, 1);
  assert.deepEqual(result.anomalies[0].rules.map(({ code }) => code), ['LARGE_CHURN', 'LARGE_ADDITIONS', 'MANY_FILES']);
});

test('binary 只计文件数，不计增删行', () => {
  const failures = [{ id: 'broken', name: 'Broken', message: 'scan failed' }];
  const result = aggregate([
    commit('binary', {
      files: [
        { path: 'asset/logo.png', added: 0, deleted: 0, binary: true },
        { path: 'src/app.js', added: 3, deleted: 4, binary: false },
      ],
    }),
  ], { failures }, { repository: { root: '/repo', shallow: true, gitVersion: 'git version 2' } });

  assert.equal(result.quality.binaryFiles, 1);
  assert.equal(result.summary.additions, 3);
  assert.equal(result.summary.deletions, 4);
  assert.equal(result.repositories[0].shallow, true);
  assert.deepEqual(result.quality.shallowRepositories, [{ id: 'app', name: 'App' }]);
  assert.deepEqual(result.failures, failures);
});
