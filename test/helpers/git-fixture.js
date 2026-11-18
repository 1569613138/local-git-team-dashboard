import { execFile } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export async function git(cwd, ...args) {
  return execFileAsync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Fixture Author',
      GIT_AUTHOR_EMAIL: 'fixture@example.test',
      GIT_COMMITTER_NAME: 'Fixture Author',
      GIT_COMMITTER_EMAIL: 'fixture@example.test',
      GIT_TERMINAL_PROMPT: '0',
    },
  });
}

export async function createGitFixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'git-scan-'));
  await git(root, 'init', '-b', 'main');
  await writeFile(path.join(root, 'normal.txt'), 'one\n', 'utf8');
  await git(root, 'add', '--', 'normal.txt');
  await git(root, 'commit', '-m', 'initial');

  await git(root, 'checkout', '-b', 'feature');
  await writeFile(path.join(root, 'tab\tname.txt'), 'special\n', 'utf8');
  await writeFile(path.join(root, 'binary.bin'), Buffer.from([0, 1, 2, 0, 3]));
  await git(root, 'add', '--', 'tab\tname.txt', 'binary.bin');
  await git(root, 'commit', '-m', 'feature files');
  await git(root, 'checkout', 'main');

  return { root };
}
