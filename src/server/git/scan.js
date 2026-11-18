import { parseLog } from './parse-log.js';
import { parseNumstat } from './parse-numstat.js';
import {
  discoverRepository,
  listBranches,
  listDefaultCommitOids,
  refsFingerprint,
  resolveCurrentBranch,
  resolveDefaultBranch,
  uniqueBranchTips,
} from './repository.js';
import { runGit } from './runner.js';

const LOG_FORMAT = '%x1e%H%x00%an%x00%ae%x00%aI%x00%P';
const NUMSTAT_FORMAT = '%x1e%H%x00';

function mapNumstat(commits, parsed) {
  const byOid = new Map(parsed.map(({ oid, files }) => [oid, files]));
  for (const commit of commits) commit.files = byOid.get(commit.oid) ?? [];
}

async function collectSnapshot(repositoryPath, options) {
  const git = options.git ?? runGit;
  const repository = await discoverRepository(repositoryPath, { git });
  const branches = await listBranches(repository.root, { git });
  const fingerprint = refsFingerprint(branches);
  const defaultBranch = await resolveDefaultBranch(repository.root, branches, { ...options, git });
  const currentBranch = await resolveCurrentBranch(repository.root, { git });
  const defaultOids = await listDefaultCommitOids(repository.root, defaultBranch, { git });
  const selectedBranches = Array.isArray(options.branches) && options.branches.length > 0
    ? branches.filter(({ ref, name }) => options.branches.includes(ref) || options.branches.includes(name))
    : branches;
  const tips = uniqueBranchTips(selectedBranches);

  let commits = [];
  if (tips.length > 0) {
    const tipRefs = tips.map(({ ref }) => ref);
    const logResult = await git(repository.root, [
      'log',
      '-z',
      `--format=${LOG_FORMAT}`,
      '--topo-order',
      ...tipRefs,
      '--',
    ]);
    commits = parseLog(logResult.stdout, defaultOids);

    const nonMergeOids = commits
      .filter(({ parents }) => parents.length <= 1)
      .map(({ oid }) => oid);
    if (nonMergeOids.length > 0) {
      const input = `${nonMergeOids.join('\n')}\n`;
      const numstatResult = await git(repository.root, [
        'diff-tree',
        '--stdin',
        '--root',
        '-r',
        '-M',
        '--numstat',
        '-z',
        `--format=${NUMSTAT_FORMAT}`,
      ], { input });
      mapNumstat(commits, parseNumstat(numstatResult.stdout));
    } else {
      mapNumstat(commits, []);
    }
  }

  const afterBranches = await listBranches(repository.root, { git });
  return {
    stable: fingerprint === refsFingerprint(afterBranches),
    data: {
      schemaVersion: 1,
      scannedAt: new Date().toISOString(),
      repository,
      defaultBranch,
      currentBranch,
      refsFingerprint: fingerprint,
      branches,
      commits,
      diagnostics: repository.shallow
        ? [{ code: 'SHALLOW_CLONE', message: 'Repository is shallow; history and statistics may be incomplete.' }]
        : [],
    },
  };
}

export class RepositoryChangedError extends Error {
  constructor(message = 'Repository refs changed during scan') {
    super(message);
    this.name = 'RepositoryChangedError';
    this.code = 'GIT_REFS_CHANGED';
  }
}

export async function scanRepository(repositoryPath, options = {}) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const snapshot = await collectSnapshot(repositoryPath, options);
    if (snapshot.stable) return snapshot.data;
  }
  throw new RepositoryChangedError();
}

export const scan = scanRepository;
export default scanRepository;
