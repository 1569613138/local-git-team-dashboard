import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createIdentityRegistry } from '../domain/identity.js';

const execFileAsync = promisify(execFile);
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/u;
const SCOPES = new Set(['group', 'all']);
const GRANULARITIES = new Set(['day', 'week', 'month']);
const QUERY_KEYS = new Set(['from', 'to', 'repo', 'member', 'branch', 'scope', 'granularity', 'range']);
const BODY_KEYS = new Set(['repositories', 'from', 'to', 'branch', 'scope', 'members', 'granularity']);

class HttpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function setSecurityHeaders(response) {
  response.setHeader('Content-Security-Policy', "default-src 'self'; base-uri 'none'; frame-ancestors 'none'; object-src 'none'");
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('Referrer-Policy', 'no-referrer');
  response.setHeader('X-Frame-Options', 'DENY');
}

function sendJson(response, status, value) {
  const body = `${JSON.stringify(value)}\n`;
  response.statusCode = status;
  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('Content-Length', Buffer.byteLength(body));
  response.end(body);
}

function sendError(response, error) {
  const status = Number.isInteger(error?.status) ? error.status : 500;
  sendJson(response, status, {
    error: {
      code: error?.code || 'INTERNAL_ERROR',
      message: status === 500 ? 'Internal server error' : error.message,
    },
    message: status === 500 ? 'Internal server error' : error.message,
  });
}

function validDate(value, label) {
  if (!DATE_PATTERN.test(value || '')) throw new HttpError(400, 'INVALID_QUERY', `${label} must use YYYY-MM-DD`);
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    throw new HttpError(400, 'INVALID_QUERY', `${label} must be a valid calendar date`);
  }
  return value;
}

function one(searchParams, name, fallback) {
  const values = searchParams.getAll(name);
  if (values.length > 1) throw new HttpError(400, 'INVALID_QUERY', `${name} must be specified once`);
  return values[0] ?? fallback;
}

function list(searchParams, name) {
  const values = searchParams.getAll(name);
  if (values.some((value) => !value || value.includes(','))) {
    throw new HttpError(400, 'INVALID_QUERY', `${name} must be repeated for multiple values`);
  }
  if (new Set(values).size !== values.length) throw new HttpError(400, 'INVALID_QUERY', `${name} contains duplicates`);
  return values;
}

function selectedValues(values, allowed, label) {
  for (const value of values) {
    if (!allowed.has(value)) throw new HttpError(400, 'INVALID_QUERY', `Unknown ${label}: ${value}`);
  }
  return values;
}

function parseStatsOptions(url, repositories, allowedMemberIds, allowedBranches = new Set(['default', 'all'])) {
  for (const key of url.searchParams.keys()) {
    if (!QUERY_KEYS.has(key)) throw new HttpError(400, 'INVALID_QUERY', `Unknown query parameter: ${key}`);
  }
  const from = validDate(one(url.searchParams, 'from'), 'from');
  const to = validDate(one(url.searchParams, 'to'), 'to');
  if (from > to) throw new HttpError(400, 'INVALID_QUERY', 'from must not be after to');
  const branch = one(url.searchParams, 'branch', 'default');
  const scope = one(url.searchParams, 'scope', 'group');
  const granularity = one(url.searchParams, 'granularity', 'day');
  if (!allowedBranches.has(branch)) throw new HttpError(400, 'INVALID_QUERY', `Unknown branch: ${branch}`);
  if (!SCOPES.has(scope)) throw new HttpError(400, 'INVALID_QUERY', 'scope must be group or all');
  if (!GRANULARITIES.has(granularity)) throw new HttpError(400, 'INVALID_QUERY', 'granularity must be day, week, or month');

  const repositoryIds = selectedValues(list(url.searchParams, 'repo'), new Set(repositories.map(({ id }) => id)), 'repository');
  const memberIds = selectedValues(list(url.searchParams, 'member'), allowedMemberIds, 'member');
  return { from, to, repo: repositoryIds, member: memberIds, branch, scope, granularity };
}

async function readJson(request, maximumBytes = 64 * 1024) {
  const contentType = request.headers['content-type'] || '';
  if (!/^application\/json(?:\s*;|$)/iu.test(contentType)) {
    throw new HttpError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Content-Type must be application/json');
  }
  const declaredLength = request.headers['content-length'] === undefined
    ? null
    : Number(request.headers['content-length']);
  if (declaredLength !== null && (!Number.isInteger(declaredLength) || declaredLength < 0)) {
    throw new HttpError(400, 'INVALID_CONTENT_LENGTH', 'Content-Length is invalid');
  }
  if (declaredLength !== null && declaredLength > maximumBytes) {
    throw new HttpError(413, 'BODY_TOO_LARGE', 'Request body exceeds 64KB');
  }

  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maximumBytes) throw new HttpError(413, 'BODY_TOO_LARGE', 'Request body exceeds 64KB');
    chunks.push(chunk);
  }
  if (size === 0) return {};
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('not an object');
    return value;
  } catch {
    throw new HttpError(400, 'INVALID_JSON', 'Request body must be a JSON object');
  }
}

function assertSameOrigin(request) {
  const host = request.headers.host;
  const origin = request.headers.origin;
  if (!host || !origin) throw new HttpError(403, 'ORIGIN_REQUIRED', 'A same-origin Host and Origin are required');
  let originHost;
  try {
    originHost = new URL(origin).host;
  } catch {
    throw new HttpError(403, 'ORIGIN_DENIED', 'Origin is invalid');
  }
  if (originHost.toLowerCase() !== host.toLowerCase()) {
    throw new HttpError(403, 'ORIGIN_DENIED', 'Cross-origin requests are not allowed');
  }
}

function parseRefreshBody(body, repositoryIds) {
  for (const key of Object.keys(body)) {
    if (!BODY_KEYS.has(key)) throw new HttpError(400, 'INVALID_BODY', `Unknown body property: ${key}`);
  }
  const values = body.repositories ?? [];
  if (!Array.isArray(values) || values.some((value) => typeof value !== 'string' || !value)) {
    throw new HttpError(400, 'INVALID_BODY', 'repositories must be an array of repository ids');
  }
  if (new Set(values).size !== values.length) throw new HttpError(400, 'INVALID_BODY', 'repositories contains duplicates');
  for (const id of values) {
    if (!repositoryIds.has(id)) throw new HttpError(400, 'INVALID_BODY', `Unknown repository: ${id}`);
  }
  return values;
}

function publicMember({ id, displayName, internal }) {
  return { id, displayName, internal };
}

function anonymousName(name, id) {
  const normalized = typeof name === 'string' ? name.trim().replace(/\s+/gu, ' ') : '';
  return normalized || `未归一作者 ${id.slice(-8)}`;
}

async function gitStatus() {
  try {
    const { stdout } = await execFileAsync('git', ['--version'], { encoding: 'utf8', timeout: 3000 });
    return { status: 'ok', version: stdout.trim().replace(/^git version\s+/u, '') };
  } catch (error) {
    return { status: 'unavailable', message: error.code || 'git unavailable' };
  }
}

function methodNotAllowed(response, allowed) {
  response.setHeader('Allow', allowed.join(', '));
  throw new HttpError(405, 'METHOD_NOT_ALLOWED', `Method must be ${allowed.join(' or ')}`);
}

export function createRouter({ config, cacheStore, aggregateRepositories, refreshJobs, serveStatic }) {
  const repositories = config.repositories.filter(({ enabled }) => enabled);
  const repositoryIds = new Set(repositories.map(({ id }) => id));
  const identityRegistry = createIdentityRegistry(config.members);
  const lastRefreshFailures = new Map();

  async function meta() {
    const values = await Promise.all(repositories.map(async (repository) => {
      try {
        const cached = await cacheStore.read(repository.path);
        const branches = (cached?.branches ?? [])
          .filter(({ ref }) => repository.remoteUrl
            ? ref.startsWith('refs/remotes/origin/')
            : ref.startsWith('refs/heads/') || ref.startsWith('refs/remotes/'))
          .map(({ ref, name }) => ({ ref, name }))
          .sort((left, right) => left.name.localeCompare(right.name));
        return {
          id: repository.id,
          name: repository.name,
          source: repository.remoteUrl ? 'gitea' : 'local',
          remoteHost: repository.remoteUrl ? new URL(repository.remoteUrl).host : null,
          defaultBranch: cached?.defaultBranch ?? repository.defaultBranch,
          branches,
          cache: cached ? { status: 'ready', scannedAt: cached.scannedAt ?? null } : { status: 'missing', scannedAt: null },
        };
      } catch {
        return {
          id: repository.id,
          name: repository.name,
          source: repository.remoteUrl ? 'gitea' : 'local',
          remoteHost: repository.remoteUrl ? new URL(repository.remoteUrl).host : null,
          defaultBranch: repository.defaultBranch,
          branches: repository.branches,
          cache: { status: 'error', scannedAt: null },
        };
      }
    }));
    const dates = values.map(({ cache }) => cache.scannedAt).filter(Boolean).sort();
    return {
      repositories: values,
      cache: { directory: '.cache/git-stats', ready: values.filter(({ cache }) => cache.status === 'ready').length, total: values.length },
      statistics: { timeZone: 'Asia/Shanghai', branch: 'default', scope: 'group', granularity: 'day' },
      pathExclusions: config.pathFilter,
      updatedAt: dates.at(-1) ?? null,
    };
  }

  async function stats(url) {
    const selectedRepositoryIds = list(url.searchParams, 'repo');
    const selectedRepositories = selectedRepositoryIds.length
      ? repositories.filter(({ id }) => selectedRepositoryIds.includes(id))
      : repositories;
    const allowedBranches = new Set(['default', 'all']);
    const allowedMemberIds = new Set(config.members.map(({ id }) => id));
    for (const repository of selectedRepositories) {
      try {
        const cached = await cacheStore.read(repository.path);
        for (const branch of cached?.branches ?? []) {
          allowedBranches.add(branch.ref);
          allowedBranches.add(branch.name);
        }
        for (const commit of cached?.commits ?? []) {
          allowedMemberIds.add(identityRegistry.resolve({ name: commit.authorName, email: commit.authorEmail }).id);
        }
      } catch {
        // Cache read failures are reported below; branch/member validation stays fail-closed.
      }
    }
    const options = parseStatsOptions(url, repositories, allowedMemberIds, allowedBranches);
    const selected = options.repo.length ? repositories.filter(({ id }) => options.repo.includes(id)) : repositories;
    const entries = [];
    const failures = [];
    for (const repository of selected) {
      const refreshFailure = lastRefreshFailures.get(repository.id);
      if (refreshFailure) failures.push(refreshFailure);
      try {
        const cache = await cacheStore.read(repository.path);
        if (!cache) {
          failures.push({ repository: repository.id, name: repository.name, code: 'CACHE_MISS', message: 'Repository cache is missing' });
        } else {
          entries.push({ repo: repository, cache });
        }
      } catch (error) {
        failures.push({ repository: repository.id, name: repository.name, code: 'CACHE_READ_FAILED', message: error.message });
      }
    }
    const result = await aggregateRepositories(entries, {
      ...options,
      repositories: options.repo,
      members: options.member,
      membersConfig: config.members,
      pathFilter: config.pathFilter,
      failures,
    });
    return {
      ...(result ?? {}),
      failures: result && Array.isArray(result.failures) ? result.failures : failures,
    };
  }

  async function identities() {
    const unmatched = new Map();
    const failures = [];
    for (const repository of repositories) {
      try {
        const cache = await cacheStore.read(repository.path);
        if (!cache) continue;
        for (const commit of cache.commits ?? []) {
          const resolved = identityRegistry.resolve({ name: commit.authorName, email: commit.authorEmail });
          if (resolved.matched) continue;
          const current = unmatched.get(resolved.id) ?? {
            id: resolved.id,
            name: anonymousName(commit.authorName, resolved.id),
            commits: 0,
          };
          current.commits += 1;
          unmatched.set(resolved.id, current);
        }
      } catch (error) {
        failures.push({ repository: repository.id, code: 'CACHE_READ_FAILED', message: error.message });
      }
    }
    return { members: config.members.map(publicMember), unmatched: [...unmatched.values()].sort((a, b) => b.commits - a.commits), failures };
  }

  return async function route(request, response) {
    setSecurityHeaders(response);
    const base = `http://${request.headers.host || '127.0.0.1'}`;
    let url;
    try {
      url = new URL(request.url, base);
      if (url.pathname.startsWith('/api/')) {
        if (url.pathname === '/api/health') {
          if (request.method !== 'GET') methodNotAllowed(response, ['GET']);
          const git = await gitStatus();
          sendJson(response, 200, {
            status: git.status === 'ok' ? 'ok' : 'degraded',
            service: { status: 'ok' },
            node: { status: 'ok', version: process.version },
            git,
          });
          return;
        }
        if (url.pathname === '/api/meta') {
          if (request.method !== 'GET') methodNotAllowed(response, ['GET']);
          sendJson(response, 200, await meta());
          return;
        }
        if (url.pathname === '/api/stats') {
          if (request.method !== 'GET') methodNotAllowed(response, ['GET']);
          sendJson(response, 200, await stats(url));
          return;
        }
        if (url.pathname === '/api/identities') {
          if (request.method !== 'GET') methodNotAllowed(response, ['GET']);
          sendJson(response, 200, await identities());
          return;
        }
        if (url.pathname === '/api/refresh') {
          if (request.method !== 'POST') methodNotAllowed(response, ['POST']);
          assertSameOrigin(request);
          const body = await readJson(request);
          const selected = parseRefreshBody(body, repositoryIds);
          const job = refreshJobs.start(selected);
          sendJson(response, 202, { jobId: job.id, ...job });
          return;
        }
        const jobMatch = /^\/api\/jobs\/([^/]+)$/u.exec(url.pathname);
        if (jobMatch) {
          if (request.method !== 'GET') methodNotAllowed(response, ['GET']);
          const job = refreshJobs.get(decodeURIComponent(jobMatch[1]));
          if (!job) throw new HttpError(404, 'JOB_NOT_FOUND', 'Refresh job was not found');
          if (job.status === 'completed' || job.status === 'failed') {
            for (const repository of job.repositories ?? []) {
              if (repository.status === 'completed') lastRefreshFailures.delete(repository.id);
              if (repository.status === 'failed') {
                lastRefreshFailures.set(repository.id, {
                  repository: repository.id,
                  name: repository.name,
                  code: repository.error?.code || 'REFRESH_FAILED',
                  message: repository.error?.message || 'Repository refresh failed; serving the previous cache',
                  stale: true,
                });
              }
            }
          }
          sendJson(response, 200, job);
          return;
        }
        throw new HttpError(404, 'NOT_FOUND', 'API endpoint was not found');
      }

      if (await serveStatic(request, response, url)) return;
      if (request.method !== 'GET' && request.method !== 'HEAD') methodNotAllowed(response, ['GET', 'HEAD']);
      response.statusCode = 404;
      response.setHeader('Content-Type', 'text/plain; charset=utf-8');
      response.setHeader('Content-Length', 10);
      if (request.method === 'HEAD') response.end();
      else response.end('Not found\n');
    } catch (error) {
      if (!response.headersSent) sendError(response, error);
      else response.destroy(error);
    }
  };
}

export { HttpError };
export default createRouter;
