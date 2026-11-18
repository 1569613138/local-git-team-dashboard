import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import test from 'node:test';
import { scanRepository } from '../../src/server/git/scan.js';
import { createGitFixture } from '../helpers/git-fixture.js';

const fixtures = [];
test.after(async () => Promise.all(fixtures.map((root) => rm(root, { recursive: true, force: true }))));

test('只读扫描所有分支、去重提交并标记默认分支', async () => {
  const fixture = await createGitFixture();
  fixtures.push(fixture.root);

  const result = await scanRepository(fixture.root);

  assert.equal(result.defaultBranch, 'refs/heads/main');
  assert.equal(result.currentBranch, 'refs/heads/main');
  assert.equal(result.repository.shallow, false);
  assert.deepEqual(result.diagnostics, []);
  assert.deepEqual(result.branches.map(({ ref }) => ref), [
    'refs/heads/feature',
    'refs/heads/main',
  ]);
  assert.equal(result.commits.length, 2);
  assert.equal(result.commits.filter(({ inDefault }) => inDefault).length, 1);
  assert.ok(result.commits.some(({ files }) => files.some(({ path }) => path === 'tab\tname.txt')));
  assert.ok(result.commits.some(({ files }) => files.some(({ path, binary }) => path === 'binary.bin' && binary)));
});

test('配置的默认分支优先于 main', async () => {
  const fixture = await createGitFixture();
  fixtures.push(fixture.root);

  const result = await scanRepository(fixture.root, { defaultBranch: 'feature' });
  assert.equal(result.defaultBranch, 'refs/heads/feature');
  assert.equal(result.commits.filter(({ inDefault }) => inDefault).length, 2);
});
