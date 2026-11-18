import { spawn } from 'node:child_process';
import { access, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

const MANAGED_MARKER = '.git-stats-managed';
const GIT_ENV = Object.freeze({
  GIT_OPTIONAL_LOCKS: '0',
  GIT_TERMINAL_PROMPT: '0',
  GIT_PAGER: 'cat',
});

export class RemoteSyncError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'RemoteSyncError';
    Object.assign(this, details);
  }
}

function runGit(args, { cwd, timeoutMs = 120_000, maxOutputBytes = 16 * 1024 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, {
      cwd,
      shell: false,
      windowsHide: true,
      env: { ...process.env, ...GIT_ENV },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdout = [];
    const stderr = [];
    let bytes = 0;
    let terminalError = null;

    const stop = (error) => {
      if (terminalError) return;
      terminalError = error;
      child.kill('SIGKILL');
    };
    const collect = (target) => (chunk) => {
      bytes += chunk.length;
      if (bytes > maxOutputBytes) {
        stop(new RemoteSyncError('Remote Git output exceeded the safety limit', { code: 'REMOTE_OUTPUT_LIMIT' }));
      } else {
        target.push(chunk);
      }
    };
    child.stdout.on('data', collect(stdout));
    child.stderr.on('data', collect(stderr));

    const timer = setTimeout(() => {
      stop(new RemoteSyncError(`Remote Git command timed out after ${timeoutMs}ms`, { code: 'REMOTE_TIMEOUT' }));
    }, timeoutMs);
    timer.unref();

    child.once('error', (cause) => {
      clearTimeout(timer);
      reject(new RemoteSyncError(`Unable to start Git: ${cause.message}`, { code: 'REMOTE_SPAWN_ERROR', cause }));
    });
    child.once('close', (exitCode) => {
      clearTimeout(timer);
      if (terminalError) {
        reject(terminalError);
        return;
      }
      const output = Buffer.concat(stdout).toString('utf8');
      const errorOutput = Buffer.concat(stderr).toString('utf8').trim();
      if (exitCode !== 0) {
        reject(new RemoteSyncError(`Remote Git command failed: ${errorOutput || `exit ${exitCode}`}`, {
          code: 'REMOTE_GIT_ERROR',
          exitCode,
        }));
        return;
      }
      resolve(output);
    });
  });
}

function expectedMarker(repository) {
  return JSON.stringify({ id: repository.id, remoteUrl: repository.remoteUrl });
}

async function assertManagedDirectory(repository) {
  const markerPath = path.join(repository.path, MANAGED_MARKER);
  let marker;
  try {
    marker = await readFile(markerPath, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') {
      throw new RemoteSyncError('Refusing to update an unmanaged repository directory', { code: 'UNMANAGED_REMOTE_DIRECTORY' });
    }
    throw error;
  }
  if (marker.trim() !== expectedMarker(repository)) {
    throw new RemoteSyncError('Managed repository marker does not match configuration', { code: 'REMOTE_MARKER_MISMATCH' });
  }
}

async function repositoryExists(repositoryPath) {
  try {
    await access(path.join(repositoryPath, '.git'));
    return true;
  } catch {
    return false;
  }
}

async function cloneManagedRepository(repository, options) {
  const parent = path.dirname(repository.path);
  await mkdir(parent, { recursive: true });
  const temporary = `${repository.path}.clone-${process.pid}-${Date.now()}`;
  await rm(temporary, { recursive: true, force: true });
  try {
    await runGit(['clone', '--no-checkout', '--origin', 'origin', '--', repository.remoteUrl, temporary], options);
    await writeMarker(temporary, expectedMarker(repository));
    await access(repository.path).then(
      () => { throw new RemoteSyncError('Remote mirror destination already exists', { code: 'REMOTE_DESTINATION_EXISTS' }); },
      (error) => { if (error.code !== 'ENOENT') throw error; },
    );
    await rename(temporary, repository.path);
  } catch (error) {
    await rm(temporary, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

async function writeMarker(directory, marker) {
  await writeFile(path.join(directory, MANAGED_MARKER), `${marker}\n`, { encoding: 'utf8', mode: 0o600 });
}

export async function syncRemoteRepository(repository, options = {}) {
  if (!repository?.remoteUrl) return { path: repository.path, synced: false, source: 'local' };
  if (await repositoryExists(repository.path)) {
    await assertManagedDirectory(repository);
    await runGit([
      'fetch',
      '--prune',
      '--no-tags',
      '--force',
      'origin',
      '+refs/heads/*:refs/remotes/origin/*',
    ], { ...options, cwd: repository.path });
  } else {
    await access(repository.path).then(
      async () => {
        await assertManagedDirectory(repository);
        throw new RemoteSyncError('Managed repository directory is incomplete', { code: 'REMOTE_DIRECTORY_INCOMPLETE' });
      },
      async (error) => {
        if (error.code !== 'ENOENT') throw error;
        await cloneManagedRepository(repository, options);
      },
    );
  }
  return { path: repository.path, synced: true, source: 'remote' };
}

export const REMOTE_GIT_ENV = GIT_ENV;
export default syncRemoteRepository;
