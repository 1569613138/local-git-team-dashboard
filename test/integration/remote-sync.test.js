import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { syncRemoteRepository } from '../../src/server/git/remote.js';
import { scanRepository } from '../../src/server/git/scan.js';
import { git } from '../helpers/git-fixture.js';

const fixtures = [];
test.after(async () => Promise.all(fixtures.map((root) => rm(root, { recursive: true, force: true }))));

async function createRemoteFixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'git-remote-sync-'));
  fixtures.push(root);
  const source = path.join(root, 'source');
  const remote = path.join(root, 'remote.git');
  const managed = path.join(root, 'managed');
  await git(root, 'init', '--bare', remote);
  await git(root, 'init', '-b', 'main', source);
  await writeFile(path.join(source, 'file.txt'), 'first\n', 'utf8');
  await git(source, 'add', '--', 'file.txt');
  await git(source, 'commit', '-m', 'first');
  await git(source, 'remote', 'add', 'origin', remote);
  await git(source, 'push', '-u', 'origin', 'main');
  return { root, source, remote, managed };
}

test('远程仓库同步使用独立托管目录并可更新引用', async () => {
  const fixture = await createRemoteFixture();
  const repository = { id: 'demo', path: fixture.managed, remoteUrl: fixture.remote };

  await syncRemoteRepository(repository);
  const first = (await git(fixture.managed, 'rev-parse', 'refs/remotes/origin/main')).stdout.trim();
  const firstSnapshot = await scanRepository(fixture.managed, { defaultBranch: 'main', repository });
  assert.equal(firstSnapshot.defaultBranch, 'refs/remotes/origin/main');
  assert.match(await readFile(path.join(fixture.managed, '.git-stats-managed'), 'utf8'), /"id":"demo"/u);

  await writeFile(path.join(fixture.source, 'file.txt'), 'second\n', 'utf8');
  await git(fixture.source, 'commit', '-am', 'second');
  await git(fixture.source, 'push', 'origin', 'main');
  await syncRemoteRepository(repository);
  const second = (await git(fixture.managed, 'rev-parse', 'refs/remotes/origin/main')).stdout.trim();
  assert.notEqual(second, first);
});

test('远程同步拒绝覆盖非托管目录', async () => {
  const fixture = await createRemoteFixture();
  await git(fixture.root, 'clone', fixture.remote, fixture.managed);
  await assert.rejects(
    syncRemoteRepository({ id: 'demo', path: fixture.managed, remoteUrl: fixture.remote }),
    (error) => error.code === 'UNMANAGED_REMOTE_DIRECTORY',
  );
});
