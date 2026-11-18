import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createCacheStore } from '../../src/server/cache/store.js';
import { createApplication, startServer } from '../../src/server/index.js';

const projectRoot = path.resolve(import.meta.dirname, '../..');

async function createFixture(context, overrides = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'git-stats-api-'));
  const repositories = await Promise.all(['alpha', 'beta'].map(async (id) => {
    const repositoryPath = path.join(root, id);
    await mkdir(repositoryPath);
    return { id, name: id.toUpperCase(), path: repositoryPath, defaultBranch: 'main', branches: [], enabled: true };
  }));
  const config = {
    repositories,
    members: [{
      id: 'alice',
      displayName: 'Alice',
      names: ['Alice'],
      emails: ['alice@example.test'],
      internal: true,
    }],
    pathFilter: { directories: ['dist'], suffixes: ['.min.js'], files: ['package-lock.json'] },
  };
  const cacheDirectory = path.join(root, 'cache');
  const cacheStore = createCacheStore(cacheDirectory);
  await cacheStore.write(repositories[0].path, {
    schemaVersion: 1,
    scannedAt: '2026-10-15T00:00:00.000Z',
    repository: { root: repositories[0].path, shallow: false },
    defaultBranch: 'refs/heads/main',
    branches: [
      { ref: 'refs/heads/main', name: 'main', oid: 'a'.repeat(40) },
      { ref: 'refs/remotes/origin/feature/demo', name: 'origin/feature/demo', oid: 'b'.repeat(40) },
    ],
    commits: [
      {
        oid: 'a'.repeat(40),
        authorName: 'Alice',
        authorEmail: 'alice@example.test',
        authoredAt: '2026-10-14T01:00:00.000Z',
        parents: [],
        inDefault: true,
        files: [],
      },
      {
        oid: 'b'.repeat(40),
        authorName: 'Outside Contributor',
        authorEmail: 'private@example.test',
        authoredAt: '2026-10-14T02:00:00.000Z',
        parents: [],
        inDefault: true,
        files: [],
      },
    ],
  });

  const aggregateCalls = [];
  const aggregateRepositories = overrides.aggregateRepositories ?? ((entries, options) => {
    aggregateCalls.push({ entries, options });
    return { summary: { commits: entries.length }, generatedAt: '2026-10-15T00:00:00.000Z' };
  });
  const scannerCalls = [];
  const syncCalls = [];
  const scanner = overrides.scanner ?? (async (repositoryPath) => {
    scannerCalls.push(repositoryPath);
    return {
      schemaVersion: 1,
      scannedAt: new Date().toISOString(),
      repository: { root: repositoryPath, shallow: false },
      defaultBranch: 'refs/heads/main',
      commits: [],
    };
  });
  const synchronizer = overrides.synchronizer ?? (async (repository) => {
    syncCalls.push(repository.id);
  });

  const application = await startServer({
    host: '127.0.0.1',
    port: 0,
    projectRoot,
    publicDirectory: path.join(projectRoot, 'public'),
    cacheDirectory,
    config,
    cacheStore,
    aggregateRepositories,
    scanner,
    synchronizer,
  });
  context.after(async () => {
    await application.close();
    await rm(root, { recursive: true, force: true });
  });
  const address = application.server.address();
  return {
    root,
    repositories,
    cacheStore,
    aggregateCalls,
    scannerCalls,
    syncCalls,
    application,
    origin: `http://127.0.0.1:${address.port}`,
  };
}

async function json(response) {
  const body = await response.json();
  return { response, body };
}

async function waitForJob(origin, jobId) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const job = await fetch(`${origin}/api/jobs/${jobId}`).then((response) => response.json());
    if (job.status === 'completed' || job.status === 'failed') return job;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('refresh job did not finish');
}

test('导出可测试的 application，health/meta/identities 不泄漏敏感路径或邮箱', async (context) => {
  const fixture = await createFixture(context);
  assert.equal(typeof createApplication, 'function');
  assert.equal(fixture.application.server.listening, true);

  const health = await json(await fetch(`${fixture.origin}/api/health`));
  assert.equal(health.response.status, 200);
  assert.equal(health.body.service.status, 'ok');
  assert.match(health.body.node.version, /^v22\./u);
  assert.equal(health.body.git.status, 'ok');
  assert.equal(health.response.headers.get('cache-control'), 'no-store');
  assert.match(health.response.headers.get('content-security-policy'), /default-src 'self'/u);
  assert.equal(health.response.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(health.response.headers.get('referrer-policy'), 'no-referrer');
  assert.equal(health.response.headers.get('x-frame-options'), 'DENY');
  assert.equal(health.response.headers.has('access-control-allow-origin'), false);

  const meta = await fetch(`${fixture.origin}/api/meta`).then((response) => response.json());
  assert.equal(meta.repositories.length, 2);
  assert.equal(meta.repositories[0].cache.status, 'ready');
  assert.equal(meta.repositories[0].source, 'local');
  assert.equal(meta.repositories[0].remoteHost, null);
  assert.equal(meta.repositories[0].defaultBranch, 'refs/heads/main');
  assert.deepEqual(meta.repositories[0].branches, [
    { ref: 'refs/heads/main', name: 'main' },
    { ref: 'refs/remotes/origin/feature/demo', name: 'origin/feature/demo' },
  ]);
  assert.equal(meta.repositories[1].cache.status, 'missing');
  assert.equal(meta.cache.directory, '.cache/git-stats');
  assert.equal(JSON.stringify(meta).includes(fixture.root), false);
  assert.deepEqual(meta.pathExclusions.directories, ['dist']);
  assert.equal(meta.statistics.timeZone, 'Asia/Shanghai');

  const identities = await fetch(`${fixture.origin}/api/identities`).then((response) => response.json());
  assert.deepEqual(identities.members, [{ id: 'alice', displayName: 'Alice', internal: true }]);
  assert.equal(identities.unmatched.length, 1);
  assert.equal(identities.unmatched[0].name, 'Outside Contributor');
  assert.equal(identities.unmatched[0].commits, 1);
  assert.match(identities.unmatched[0].id, /^unmapped:[a-f0-9]{16}$/u);
  assert.equal(JSON.stringify(identities).includes('private@example.test'), false);
});

test('stats 严格解析查询，读取可用缓存、记录缺失并只调用聚合导出', async (context) => {
  const fixture = await createFixture(context);
  const response = await fetch(`${fixture.origin}/api/stats?from=2026-10-01&to=2026-10-15&repo=alpha&repo=beta&member=alice&branch=default&scope=group&granularity=week`);
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.summary.commits, 1);
  assert.deepEqual(body.failures, [{ repository: 'beta', name: 'BETA', code: 'CACHE_MISS', message: 'Repository cache is missing' }]);
  assert.equal(fixture.aggregateCalls.length, 1);
  assert.equal(fixture.aggregateCalls[0].entries[0].repo.id, 'alpha');
  assert.equal(fixture.aggregateCalls[0].entries[0].cache.schemaVersion, 1);
  assert.deepEqual(fixture.aggregateCalls[0].options.members, ['alice']);
  assert.deepEqual(fixture.aggregateCalls[0].options.repositories, ['alpha', 'beta']);
  assert.equal(fixture.aggregateCalls[0].options.granularity, 'week');

  const branchResponse = await fetch(`${fixture.origin}/api/stats?from=2026-10-01&to=2026-10-15&repo=alpha&branch=refs%2Fremotes%2Forigin%2Ffeature%2Fdemo&scope=group&granularity=day`);
  assert.equal(branchResponse.status, 200);
  assert.equal(fixture.aggregateCalls.at(-1).options.branch, 'refs/remotes/origin/feature/demo');

  for (const query of [
    'from=2026-02-30&to=2026-10-15',
    'from=2026-10-15&to=2026-10-01',
    'from=2026-10-01&to=2026-10-15&repo=unknown',
    'from=2026-10-01&to=2026-10-15&member=unknown',
    'from=2026-10-01&to=2026-10-15&branch=unknown',
    'from=2026-10-01&to=2026-10-15&scope=other',
    'from=2026-10-01&to=2026-10-15&granularity=hour',
    'from=2026-10-01&to=2026-10-15&unexpected=true',
  ]) {
    const invalid = await json(await fetch(`${fixture.origin}/api/stats?${query}`));
    assert.equal(invalid.response.status, 400, query);
    assert.equal(invalid.body.error.code, 'INVALID_QUERY');
  }
});

test('静态文件限制 public 边界，支持 MIME、HEAD 和前端模块兼容映射', async (context) => {
  const fixture = await createFixture(context);
  const index = await fetch(`${fixture.origin}/`);
  assert.equal(index.status, 200);
  assert.match(index.headers.get('content-type'), /^text\/html/u);
  assert.match(await index.text(), /代码贡献排行榜/u);

  const head = await fetch(`${fixture.origin}/styles.css`, { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.match(head.headers.get('content-type'), /^text\/css/u);
  assert.equal(head.headers.get('cache-control'), 'no-cache');
  assert.equal(await head.text(), '');

  const mapped = await fetch(`${fixture.origin}/js/api.js`);
  assert.equal(mapped.status, 200);
  assert.match(mapped.headers.get('content-type'), /^text\/javascript/u);
  assert.match(await mapped.text(), /getMeta/u);

  const rootModule = await fetch(`${fixture.origin}/api.js`);
  assert.equal(rootModule.status, 404);

  for (const target of ['/%2e%2e%2fapi.js', '/.cache/git-stats/private.json', '/src/server/config.js']) {
    const response = await fetch(`${fixture.origin}${target}`);
    assert.equal(response.status, 404, target);
  }

  const missingApi = await json(await fetch(`${fixture.origin}/api/unknown`));
  assert.equal(missingApi.response.status, 404);
  assert.equal(missingApi.body.error.code, 'NOT_FOUND');
});

test('refresh 强制同源、限制请求体和仓库白名单，异步任务可查询', async (context) => {
  const fixture = await createFixture(context);
  const denied = await json(await fetch(`${fixture.origin}/api/refresh`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'http://example.test' },
    body: '{}',
  }));
  assert.equal(denied.response.status, 403);
  assert.equal(denied.body.error.code, 'ORIGIN_DENIED');

  const unknown = await json(await fetch(`${fixture.origin}/api/refresh`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: fixture.origin },
    body: JSON.stringify({ repositories: ['unknown'] }),
  }));
  assert.equal(unknown.response.status, 400);
  assert.equal(unknown.body.error.code, 'INVALID_BODY');

  const oversized = await json(await fetch(`${fixture.origin}/api/refresh`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: fixture.origin },
    body: JSON.stringify({ padding: 'x'.repeat(65 * 1024) }),
  }));
  assert.equal(oversized.response.status, 413);
  assert.equal(oversized.body.error.code, 'BODY_TOO_LARGE');

  const accepted = await json(await fetch(`${fixture.origin}/api/refresh`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: fixture.origin },
    body: JSON.stringify({ repositories: ['beta'] }),
  }));
  assert.equal(accepted.response.status, 202);
  assert.match(accepted.body.jobId, /^[0-9a-f-]{36}$/u);
  const job = await waitForJob(fixture.origin, accepted.body.jobId);
  assert.equal(job.status, 'completed');
  assert.deepEqual(job.repositories.map(({ id, status }) => ({ id, status })), [{ id: 'beta', status: 'completed' }]);
  assert.deepEqual(fixture.scannerCalls, [fixture.repositories[1].path]);
  assert.deepEqual(fixture.syncCalls, []);
  assert.ok(await fixture.cacheStore.read(fixture.repositories[1].path));

  const notFound = await json(await fetch(`${fixture.origin}/api/jobs/not-found`));
  assert.equal(notFound.response.status, 404);
  assert.equal(notFound.body.error.code, 'JOB_NOT_FOUND');
});

test('refresh 先同步远程托管仓库再扫描', async (context) => {
  const events = [];
  const fixture = await createFixture(context, {
    synchronizer: async (repository) => events.push(`sync:${repository.id}`),
    scanner: async (repositoryPath) => {
      events.push(`scan:${path.basename(repositoryPath)}`);
      return { schemaVersion: 1, scannedAt: '2026-10-15T01:00:00.000Z', commits: [] };
    },
  });
  fixture.repositories[1].remoteUrl = 'https://gitea.example.test/team/beta.git';
  const accepted = await fetch(`${fixture.origin}/api/refresh`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: fixture.origin },
    body: JSON.stringify({ repositories: ['beta'] }),
  }).then((response) => response.json());
  const job = await waitForJob(fixture.origin, accepted.jobId);
  assert.equal(job.repositories[0].status, 'completed');
  assert.deepEqual(events, ['sync:beta', 'scan:beta']);
});

test('refresh 单仓失败保留旧缓存，任务内按仓库串行', async (context) => {
  let active = 0;
  let maximumActive = 0;
  const scanner = async (repositoryPath) => {
    active += 1;
    maximumActive = Math.max(maximumActive, active);
    await new Promise((resolve) => setTimeout(resolve, 20));
    active -= 1;
    if (repositoryPath.endsWith('alpha')) throw new Error('scan failed');
    return { schemaVersion: 1, scannedAt: '2026-10-15T01:00:00.000Z', commits: [] };
  };
  const fixture = await createFixture(context, { scanner });
  const oldCache = await readFile(fixture.cacheStore.fileFor(fixture.repositories[0].path), 'utf8');
  const accepted = await fetch(`${fixture.origin}/api/refresh`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: fixture.origin },
    body: '{}',
  }).then((response) => response.json());
  const job = await waitForJob(fixture.origin, accepted.jobId);
  assert.equal(job.status, 'completed');
  assert.deepEqual(job.repositories.map(({ status }) => status), ['failed', 'completed']);
  assert.equal(job.failures[0].message, 'scan failed');
  assert.equal(maximumActive, 1);
  assert.equal(await readFile(fixture.cacheStore.fileFor(fixture.repositories[0].path), 'utf8'), oldCache);
});

test('createApplication 可在未监听时安全关闭', async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), 'git-stats-app-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const application = await createApplication({
    projectRoot,
    config: { repositories: [], members: [], pathFilter: { directories: [], suffixes: [], files: [] } },
    cacheDirectory: path.join(root, 'cache'),
    aggregateRepositories: () => ({}),
  });
  await application.close();
  assert.equal(application.server.listening, false);
});
