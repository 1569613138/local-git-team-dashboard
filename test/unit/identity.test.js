import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, parseConfigJson, validateConfig } from '../../src/server/config.js';
import {
  createIdentityRegistry,
  createIdentityResolver,
  normalizeEmail,
  normalizeName,
} from '../../src/server/domain/identity.js';

const members = [
  {
    id: 'alice',
    displayName: 'Alice Chen',
    names: ['Alice', '陈 爱丽丝'],
    emails: ['Alice@Example.COM'],
    internal: true,
  },
  {
    id: 'bob',
    displayName: 'Bob Li',
    names: ['Bob'],
    emails: ['bob@example.com'],
    internal: false,
  },
];

test('身份别名会去空白、统一大小写并优先按邮箱匹配', () => {
  assert.equal(normalizeEmail(' Alice@Example.COM '), 'alice@example.com');
  assert.equal(normalizeName('  陈   爱丽丝 '), '陈 爱丽丝');

  const resolve = createIdentityResolver(members);
  assert.deepEqual(resolve({ name: 'Bob', email: ' alice@example.com ' }), {
    id: 'alice',
    displayName: 'Alice Chen',
    internal: true,
    matched: true,
    matchedBy: 'email',
  });
  assert.equal(resolve({ name: ' ALICE ', email: 'other@example.com' }).matchedBy, 'name');
});

test('成员 id、邮箱或姓名冲突会在注册表加载时失败', () => {
  assert.throws(
    () => createIdentityRegistry([...members, { ...members[1], id: 'alice' }]),
    /member id.*duplicated/u,
  );
  assert.throws(
    () => createIdentityRegistry([...members, {
      id: 'carol', displayName: 'Carol', names: ['Carol'], emails: ['ALICE@example.com'], internal: true,
    }]),
    /email alias.*shared/u,
  );
  assert.throws(
    () => createIdentityRegistry([...members, {
      id: 'carol', displayName: 'Carol', names: [' alice '], emails: ['carol@example.com'], internal: true,
    }]),
    /name alias.*shared/u,
  );
});

test('未归一身份返回不暴露原邮箱的稳定信息', () => {
  const resolve = createIdentityResolver(members);
  const first = resolve({ name: ' Unknown User ', email: 'UNKNOWN@example.com' });
  const second = resolve({ name: 'Other Spelling', email: 'unknown@EXAMPLE.COM ' });

  assert.deepEqual(first, second);
  assert.match(first.id, /^unmapped:[a-f0-9]{16}$/u);
  assert.match(first.displayName, /^Unmapped [a-f0-9]{8}$/u);
  assert.equal(first.internal, false);
  assert.equal(first.matched, false);
  assert.equal(first.matchedBy, null);
  assert.ok(!first.id.includes('unknown@example.com'));
});

test('成员结构执行严格校验', () => {
  assert.throws(() => createIdentityRegistry([{ ...members[0], extra: true }]), /extra is not allowed/u);
  assert.throws(() => createIdentityRegistry([{ ...members[0], internal: 'yes' }]), /internal must be a boolean/u);
  assert.throws(() => createIdentityRegistry([{ ...members[0], names: [], emails: [] }]), /at least one/u);
});

test('配置 JSON 加载、默认值及未知字段执行严格校验', async (context) => {
  const directory = await mkdtemp(join(tmpdir(), 'git-stats-config-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'config.json');
  const raw = {
    repositories: [{ id: 'main', path: directory, remoteUrl: 'https://gitea.example.test/team/main.git', defaultBranch: 'main' }],
    members,
    pathFilter: { directories: ['dist'], suffixes: ['.min.js'], files: ['package-lock.json'] },
  };
  await writeFile(path, JSON.stringify(raw), 'utf8');

  const config = await loadConfig(path);
  assert.equal(config.repositories[0].enabled, true);
  assert.equal(config.repositories[0].defaultBranch, 'main');
  assert.equal(config.repositories[0].remoteUrl, 'https://gitea.example.test/team/main.git');
  assert.deepEqual(config.pathFilter.files, ['package-lock.json']);
  assert.throws(
    () => validateConfig({ ...raw, repositories: [{ ...raw.repositories[0], remoteUrl: 'https://user:secret@gitea.example.test/team/main.git' }] }),
    /must not contain credentials/u,
  );
  assert.throws(() => parseConfigJson('{', path), /Invalid JSON/u);
  assert.throws(() => validateConfig({ ...raw, unexpected: true }), /unexpected is not allowed/u);
  assert.throws(
    () => validateConfig({ ...raw, repositories: [...raw.repositories, raw.repositories[0]] }),
    /repository id.*duplicated/u,
  );
});
