import { randomUUID } from 'node:crypto';

function publicError(error) {
  return {
    code: error?.code || 'REFRESH_FAILED',
    message: error?.message || 'Repository refresh failed',
  };
}

function cloneJob(job) {
  const repositories = job.repositories.map((repository) => ({
    ...repository,
    ...(repository.error ? { error: { ...repository.error } } : {}),
  }));
  const completed = repositories.filter(({ status }) => status === 'completed' || status === 'failed').length;
  return {
    id: job.id,
    status: job.status,
    createdAt: job.createdAt,
    startedAt: job.startedAt,
    completedAt: job.completedAt,
    total: repositories.length,
    completed,
    progress: repositories.length === 0 ? 100 : Math.round((completed / repositories.length) * 100),
    message: job.message,
    repositories,
    failures: repositories
      .filter(({ status }) => status === 'failed')
      .map(({ id, name, error }) => ({ repository: id, name, ...error })),
  };
}

export function createRefreshJobs({ repositories, cacheStore, scanner, synchronizer = async () => null, scanOptions = {} }) {
  const jobs = new Map();
  const locks = new Map();

  async function withRepositoryLock(repositoryId, operation) {
    const previous = locks.get(repositoryId) ?? Promise.resolve();
    const current = previous.catch(() => {}).then(operation);
    locks.set(repositoryId, current);
    try {
      return await current;
    } finally {
      if (locks.get(repositoryId) === current) locks.delete(repositoryId);
    }
  }

  async function refreshRepository(job, state, repository) {
    await withRepositoryLock(repository.id, async () => {
      state.status = 'running';
      state.startedAt = new Date().toISOString();
      try {
        if (repository.remoteUrl) {
          state.status = 'syncing';
          job.message = `正在同步 ${repository.name}`;
          await synchronizer(repository, scanOptions);
        }
        state.status = 'running';
        job.message = `正在扫描 ${repository.name}`;
        const snapshot = await scanner(repository.path, {
          ...scanOptions,
          defaultBranch: repository.defaultBranch,
          branches: repository.branches,
          repository,
        });
        state.status = 'writing';
        await cacheStore.write(repository.path, snapshot);
        state.status = 'completed';
        state.completedAt = new Date().toISOString();
      } catch (error) {
        state.status = 'failed';
        state.completedAt = new Date().toISOString();
        state.error = publicError(error);
      }
      job.message = `${job.repositories.filter(({ status }) => status === 'completed' || status === 'failed').length}/${job.repositories.length} 个仓库已处理`;
    });
  }

  async function run(job, selected) {
    job.status = 'running';
    job.startedAt = new Date().toISOString();
    try {
      for (let index = 0; index < selected.length; index += 1) {
        await refreshRepository(job, job.repositories[index], selected[index]);
      }
      job.status = 'completed';
      job.message = job.repositories.some(({ status }) => status === 'failed')
        ? '刷新完成，部分仓库失败'
        : '刷新完成';
    } catch (error) {
      job.status = 'failed';
      job.message = error?.message || '刷新任务失败';
    } finally {
      job.completedAt = new Date().toISOString();
    }
  }

  function start(repositoryIds) {
    const selectedIds = repositoryIds?.length
      ? new Set(repositoryIds)
      : new Set(repositories.filter(({ enabled }) => enabled).map(({ id }) => id));
    const selected = repositories.filter(({ id, enabled }) => enabled && selectedIds.has(id));
    const job = {
      id: randomUUID(),
      status: 'pending',
      createdAt: new Date().toISOString(),
      startedAt: null,
      completedAt: null,
      message: '等待刷新',
      repositories: selected.map(({ id, name }) => ({
        id,
        name,
        status: 'pending',
        startedAt: null,
        completedAt: null,
      })),
    };
    jobs.set(job.id, job);
    queueMicrotask(() => run(job, selected));
    return cloneJob(job);
  }

  function get(jobId) {
    const job = jobs.get(jobId);
    return job ? cloneJob(job) : null;
  }

  return Object.freeze({ start, get });
}

export default createRefreshJobs;
