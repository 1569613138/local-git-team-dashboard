import { createHash } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { runGit } from './runner.js';

const LOCAL_PREFIX = 'refs/heads/';
const REMOTE_PREFIX = 'refs/remotes/';

function lines(buffer) {
  return buffer.toString('utf8').split('\n').map((line) => line.trim()).filter(Boolean);
}

function branchShortName(ref) {
  if (ref.startsWith(LOCAL_PREFIX)) return ref.slice(LOCAL_PREFIX.length);
  if (ref.startsWith(REMOTE_PREFIX)) return ref.slice(REMOTE_PREFIX.length);
  return ref;
}

function normaliseConfiguredDefault(value, branches = [], preferRemote = false) {
  if (!value) return null;
  if (value.startsWith('refs/')) return value;
  if (value.startsWith('remotes/')) return `refs/${value}`;
  if (value.startsWith('origin/')) return `refs/remotes/${value}`;
  const local = `refs/heads/${value}`;
  const remote = `refs/remotes/origin/${value}`;
  const candidates = preferRemote ? [remote, local] : [local, remote];
  return candidates.find((candidate) => branches.some(({ ref }) => ref === candidate)) ?? candidates[0];
}

async function queryOptionalRef(cwd, args, git) {
  const result = await git(cwd, args, { allowedExitCodes: [0, 1, 128] });
  return result.exitCode === 0 ? result.stdout.toString('utf8').trim() || null : null;
}

export async function discoverRepository(repositoryPath, options = {}) {
  const git = options.git ?? runGit;
  const rootResult = await git(repositoryPath, ['rev-parse', '--show-toplevel']);
  const root = await realpath(rootResult.stdout.toString('utf8').trim());

  const [gitDirResult, commonDirResult, shallowResult, versionResult] = await Promise.all([
    git(root, ['rev-parse', '--absolute-git-dir']),
    git(root, ['rev-parse', '--git-common-dir']),
    git(root, ['rev-parse', '--is-shallow-repository']),
    git(root, ['version']),
  ]);

  return {
    root,
    gitDir: gitDirResult.stdout.toString('utf8').trim(),
    commonDir: commonDirResult.stdout.toString('utf8').trim(),
    shallow: shallowResult.stdout.toString('utf8').trim() === 'true',
    gitVersion: versionResult.stdout.toString('utf8').trim(),
  };
}

export async function listBranches(root, options = {}) {
  const git = options.git ?? runGit;
  const result = await git(root, [
    'for-each-ref',
    '--format=%(refname)%00%(objectname)%00%(symref)%00',
    'refs/heads',
    'refs/remotes',
  ]);
  const fields = result.stdout.toString('utf8').split('\0');
  const branches = [];

  for (let index = 0; index + 2 < fields.length; index += 3) {
    const ref = fields[index].replace(/^\n+/, '');
    const oid = fields[index + 1];
    const symref = fields[index + 2];
    if (!ref || (!ref.startsWith(LOCAL_PREFIX) && !ref.startsWith(REMOTE_PREFIX))) continue;
    if (symref || ref === 'refs/remotes/origin/HEAD') continue;
    branches.push({ ref, name: branchShortName(ref), oid });
  }

  branches.sort((left, right) => left.ref.localeCompare(right.ref));
  return branches;
}

export async function resolveCurrentBranch(root, options = {}) {
  const git = options.git ?? runGit;
  return queryOptionalRef(root, ['symbolic-ref', '--quiet', 'HEAD'], git);
}

export async function resolveDefaultBranch(root, branches, options = {}) {
  const git = options.git ?? runGit;
  const available = new Set(branches.map((branch) => branch.ref));
  const configured = normaliseConfiguredDefault(
    options.defaultBranch ?? options.config?.defaultBranch ?? options.repository?.defaultBranch,
    branches,
    Boolean(options.repository?.remoteUrl),
  );
  const originHead = await queryOptionalRef(
    root,
    ['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD'],
    git,
  );
  const current = await resolveCurrentBranch(root, { git });

  for (const candidate of [
    configured,
    originHead,
    'refs/heads/main',
    'refs/remotes/origin/main',
    'refs/heads/master',
    'refs/remotes/origin/master',
    current,
  ]) {
    if (candidate && available.has(candidate)) return candidate;
  }
  return null;
}

export function uniqueBranchTips(branches) {
  const seen = new Set();
  return branches.filter(({ oid }) => {
    if (seen.has(oid)) return false;
    seen.add(oid);
    return true;
  });
}

export function refsFingerprint(branches) {
  const canonical = branches
    .map(({ ref, oid }) => `${ref}\0${oid}\0`)
    .sort()
    .join('');
  return createHash('sha256').update(canonical).digest('hex');
}

export async function listDefaultCommitOids(root, defaultBranch, options = {}) {
  if (!defaultBranch) return new Set();
  const git = options.git ?? runGit;
  const result = await git(root, ['rev-list', defaultBranch]);
  return new Set(lines(result.stdout));
}

export { branchShortName, normaliseConfiguredDefault };
