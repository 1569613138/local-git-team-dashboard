import { createIdentityRegistry } from './identity.js';
import { compilePathFilter } from './path-filter.js';
import {
  bucketKey,
  enumerateBuckets,
  resolveDateRange,
  toShanghaiDateKey,
} from './time.js';

export const ANOMALY_THRESHOLDS = Object.freeze({
  churn: 2_000,
  additions: 1_500,
  deletions: 1_500,
  filesChanged: 50,
});

export function detectCommitAnomalies({ additions = 0, deletions = 0, filesChanged = 0 } = {}) {
  const churn = additions + deletions;
  const rules = [];
  if (churn >= ANOMALY_THRESHOLDS.churn) {
    rules.push({ code: 'LARGE_CHURN', value: churn, threshold: ANOMALY_THRESHOLDS.churn });
  }
  if (additions >= ANOMALY_THRESHOLDS.additions) {
    rules.push({ code: 'LARGE_ADDITIONS', value: additions, threshold: ANOMALY_THRESHOLDS.additions });
  }
  if (deletions >= ANOMALY_THRESHOLDS.deletions) {
    rules.push({ code: 'LARGE_DELETIONS', value: deletions, threshold: ANOMALY_THRESHOLDS.deletions });
  }
  if (filesChanged >= ANOMALY_THRESHOLDS.filesChanged) {
    rules.push({ code: 'MANY_FILES', value: filesChanged, threshold: ANOMALY_THRESHOLDS.filesChanged });
  }
  return rules;
}

function createMetrics(key) {
  return {
    key,
    commits: 0,
    merges: 0,
    additions: 0,
    deletions: 0,
    activeMembers: new Set(),
    activeDays: new Set(),
  };
}

function addLines(metrics, additions, deletions) {
  metrics.additions += additions;
  metrics.deletions += deletions;
}

function numericLines(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

function publicMetrics(metrics) {
  return {
    commits: metrics.commits,
    merges: metrics.merges,
    activeMembers: metrics.activeMembers.size,
    activeDays: metrics.activeDays.size,
    additions: metrics.additions,
    deletions: metrics.deletions,
    churn: metrics.additions + metrics.deletions,
  };
}

function memberMetrics(identity, authorName) {
  const name = identity.matched
    ? identity.displayName
    : String(authorName ?? '').trim() || identity.displayName;
  return {
    id: identity.id,
    name,
    displayName: name,
    internal: identity.internal,
    commits: 0,
    merges: 0,
    activeDays: new Set(),
    repositories: new Set(),
    additions: 0,
    deletions: 0,
    anomalyCommits: 0,
    firstActive: null,
    lastActive: null,
    matched: identity.matched,
  };
}

function touchMember(member, day, repositoryId, merge) {
  if (merge) member.merges += 1;
  else member.commits += 1;
  member.activeDays.add(day);
  member.repositories.add(repositoryId);
  if (member.firstActive === null || day < member.firstActive) member.firstActive = day;
  if (member.lastActive === null || day > member.lastActive) member.lastActive = day;
}

function serializeMember(member) {
  return {
    id: member.id,
    name: member.name,
    displayName: member.displayName,
    internal: member.internal,
    commits: member.commits,
    merges: member.merges,
    activeDays: member.activeDays.size,
    repositories: member.repositories.size,
    additions: member.additions,
    deletions: member.deletions,
    churn: member.additions + member.deletions,
    anomalyCommits: member.anomalyCommits,
    firstActive: member.firstActive,
    lastActive: member.lastActive,
  };
}

function compareMembers(left, right) {
  return left.displayName.localeCompare(right.displayName) || left.id.localeCompare(right.id);
}

function repositoryIdentity(entry, index) {
  const repo = entry?.repo ?? {};
  const id = String(repo.id ?? `repository-${index + 1}`);
  return { id, name: String(repo.name ?? id) };
}

function normalizeFailures(failures) {
  return Array.isArray(failures) ? [...failures] : [];
}

function reachableCommitOids(cache, branch) {
  if (branch === 'all') return null;
  if (branch === 'default') return undefined;

  const selected = (cache?.branches ?? []).find(({ ref, name }) => ref === branch || name === branch);
  if (!selected) return new Set();

  const commitsByOid = new Map((cache?.commits ?? []).map((commit) => [commit.oid, commit]));
  const reachable = new Set();
  const pending = [selected.oid];
  while (pending.length > 0) {
    const oid = pending.pop();
    if (!oid || reachable.has(oid)) continue;
    reachable.add(oid);
    const commit = commitsByOid.get(oid);
    if (commit) pending.push(...(commit.parents ?? []));
  }
  return reachable;
}

function commitMatchesBranch(commit, branch, reachable) {
  if (branch === 'all') return true;
  if (branch === 'default') return Boolean(commit.inDefault);
  return reachable.has(commit.oid);
}

export function aggregateRepositories(entries, options = {}, failureEntries = []) {
  if (!Array.isArray(entries)) throw new TypeError('entries must be an array');

  const {
    from,
    to,
    branch = 'default',
    scope = 'group',
    members: selectedMembers = [],
    granularity = 'day',
    membersConfig = [],
    pathFilter = {},
    failures: optionFailures,
  } = options;
  if (typeof branch !== 'string' || !branch) throw new TypeError('branch must be a non-empty string');
  if (!['group', 'all'].includes(scope)) throw new TypeError('scope must be group or all');
  if (!Array.isArray(selectedMembers)) throw new TypeError('members must be an array');

  const range = resolveDateRange('custom', { start: from, end: to });
  const buckets = enumerateBuckets(range, granularity);
  const identityRegistry = createIdentityRegistry(membersConfig);
  const excludes = compilePathFilter(pathFilter).excludes;
  const selectedIds = new Set(selectedMembers);
  const failures = normalizeFailures(optionFailures ?? failureEntries);

  const total = createMetrics('total');
  const byBucket = new Map(buckets.map((key) => [key, createMetrics(key)]));
  const byDay = new Map(enumerateBuckets(range, 'day').map((key) => [key, createMetrics(key)]));
  const byMember = new Map();
  let excludedFiles = 0;
  let binaryFiles = 0;
  const issues = [];
  const shallowRepositories = [];
  const cacheStatus = [];
  const repositories = [];
  const anomalies = [];

  entries.forEach((entry, index) => {
    const repository = repositoryIdentity(entry, index);
    const cache = entry?.cache;
    const repositoryMetrics = createMetrics(repository.id);
    const shallow = Boolean(cache?.repository?.shallow);
    const reachable = reachableCommitOids(cache, branch);

    if (!cache) {
      issues.push({
        code: 'CACHE_MISSING',
        message: `No scan cache is available for ${repository.name}.`,
        repositoryId: repository.id,
        repositoryName: repository.name,
      });
    }
    if (shallow) shallowRepositories.push(repository);
    for (const diagnostic of cache?.diagnostics ?? []) {
      issues.push({
        ...diagnostic,
        repositoryId: repository.id,
        repositoryName: repository.name,
      });
    }

    for (const commit of cache?.commits ?? []) {
      if (!commitMatchesBranch(commit, branch, reachable)) continue;
      const day = toShanghaiDateKey(commit.authoredAt);
      if (day < range.startDate || day > range.endDate) continue;

      const identity = identityRegistry.resolve({ name: commit.authorName, email: commit.authorEmail });
      if (scope === 'group' && !identity.internal) continue;
      if (selectedIds.size > 0 && !selectedIds.has(identity.id)) continue;

      const merge = Array.isArray(commit.parents) && commit.parents.length >= 2;
      const period = bucketKey(commit.authoredAt, granularity);
      const periodMetrics = byBucket.get(period);
      const dayMetrics = byDay.get(day);
      if (!periodMetrics || !dayMetrics) continue;

      let member = byMember.get(identity.id);
      if (!member) {
        member = memberMetrics(identity, commit.authorName);
        byMember.set(identity.id, member);
      }
      touchMember(member, day, repository.id, merge);

      for (const metrics of [total, repositoryMetrics, periodMetrics, dayMetrics]) {
        if (merge) metrics.merges += 1;
        else metrics.commits += 1;
        metrics.activeMembers.add(identity.id);
        metrics.activeDays.add(day);
      }

      if (merge) continue;
      let commitAdditions = 0;
      let commitDeletions = 0;
      let filesChanged = 0;
      for (const file of commit.files ?? []) {
        if (excludes(file.path) || (file.oldPath && excludes(file.oldPath))) {
          excludedFiles += 1;
          continue;
        }
        if (file.binary) {
          binaryFiles += 1;
          continue;
        }
        const additions = numericLines(file.added);
        const deletions = numericLines(file.deleted);
        commitAdditions += additions;
        commitDeletions += deletions;
        filesChanged += 1;
        addLines(total, additions, deletions);
        addLines(repositoryMetrics, additions, deletions);
        addLines(periodMetrics, additions, deletions);
        addLines(dayMetrics, additions, deletions);
        member.additions += additions;
        member.deletions += deletions;
      }

      const rules = detectCommitAnomalies({ additions: commitAdditions, deletions: commitDeletions, filesChanged });
      if (rules.length > 0) {
        member.anomalyCommits += 1;
        anomalies.push({
          repositoryId: repository.id,
          repositoryName: repository.name,
          oid: commit.oid,
          shortOid: String(commit.oid).slice(0, 8),
          authoredAt: commit.authoredAt,
          date: day,
          memberId: identity.id,
          memberName: member.displayName,
          additions: commitAdditions,
          deletions: commitDeletions,
          churn: commitAdditions + commitDeletions,
          filesChanged,
          rules,
        });
      }
    }

    repositories.push({
      id: repository.id,
      name: repository.name,
      defaultBranch: cache?.defaultBranch ?? entry?.repo?.defaultBranch ?? null,
      ...publicMetrics(repositoryMetrics),
      scannedAt: cache?.scannedAt ?? null,
      shallow,
    });
    const cacheFailure = failures.find((failure) =>
      failure?.id === repository.id
      || failure?.repositoryId === repository.id
      || failure?.repository === repository.id);
    cacheStatus.push({
      id: repository.id,
      name: repository.name,
      status: cacheFailure ? 'failed' : cache ? 'ready' : 'missing',
      stale: Boolean(cacheFailure && cache),
      scannedAt: cache?.scannedAt ?? null,
    });
  });

  const repositoryById = new Map(repositories.map((repository) => [repository.id, repository]));
  for (const failure of failures) {
    const repositoryId = failure?.id ?? failure?.repositoryId ?? failure?.repository;
    if (!repositoryId || repositoryById.has(repositoryId)) continue;
    const repositoryName = String(failure?.name ?? repositoryId);
    repositories.push({
      id: repositoryId,
      name: repositoryName,
      defaultBranch: null,
      ...publicMetrics(createMetrics(repositoryId)),
      scannedAt: null,
      shallow: false,
    });
    cacheStatus.push({
      id: repositoryId,
      name: repositoryName,
      status: 'failed',
      stale: Boolean(failure?.stale),
      scannedAt: null,
    });
  }

  const metrics = publicMetrics(total);
  const trend = buckets.map((key) => {
    const item = publicMetrics(byBucket.get(key));
    return { label: key, date: key, ...item };
  });
  const activity = [...byDay.entries()].map(([date, item]) => ({
    date,
    count: item.commits + item.merges,
    ...publicMetrics(item),
  }));
  const members = [...byMember.values()].map(serializeMember).sort(compareMembers);
  const unmatchedIdentities = [...byMember.values()]
    .filter((member) => !member.matched)
    .map((member) => ({ authorName: member.name, id: member.id, commits: member.commits }))
    .sort((left, right) => left.authorName.localeCompare(right.authorName) || left.id.localeCompare(right.id));

  return {
    generatedAt: new Date().toISOString(),
    range: { from: range.startDate, to: range.endDate },
    summary: {
      ...metrics,
      mergeRatio: metrics.commits + metrics.merges === 0
        ? 0
        : metrics.merges / (metrics.commits + metrics.merges),
      totalDays: byDay.size,
      anomalyCommits: anomalies.length,
    },
    trend,
    churnTrend: trend.map(({ label, date, additions, deletions, churn }) => ({
      label,
      date,
      additions,
      deletions,
      churn,
    })),
    activity,
    repositories,
    members,
    anomalies: anomalies.sort((left, right) => right.authoredAt.localeCompare(left.authoredAt) || left.oid.localeCompare(right.oid)),
    anomalyPolicy: {
      mode: 'flag-only',
      thresholds: ANOMALY_THRESHOLDS,
    },
    quality: {
      unmatchedIdentities,
      issues,
      excludedFiles,
      binaryFiles,
      shallowRepositories,
      cacheStatus,
    },
    failures,
  };
}

export default aggregateRepositories;
