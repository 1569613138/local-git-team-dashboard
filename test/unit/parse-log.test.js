import assert from 'node:assert/strict';
import test from 'node:test';
import { parseLog } from '../../src/server/git/parse-log.js';

const OID1 = '1'.repeat(40);
const OID2 = '2'.repeat(40);

test('解析 NUL 分隔日志并标记默认分支提交', () => {
  const input = Buffer.from([
    OID1, 'Alice\nAdmin', 'alice@example.test', '2026-01-02T03:04:05+08:00', '',
    OID2, 'Bob', 'bob@example.test', '2026-01-03T03:04:05Z', OID1,
    '',
  ].join('\0'));

  assert.deepEqual(parseLog(input, new Set([OID1])), [
    {
      oid: OID1,
      authorName: 'Alice\nAdmin',
      authorEmail: 'alice@example.test',
      authoredAt: '2026-01-02T03:04:05+08:00',
      parents: [],
      inDefault: true,
    },
    {
      oid: OID2,
      authorName: 'Bob',
      authorEmail: 'bob@example.test',
      authoredAt: '2026-01-03T03:04:05Z',
      parents: [OID1],
      inDefault: false,
    },
  ]);
});

test('拒绝字段不完整的日志', () => {
  assert.throws(() => parseLog(`${OID1}\0Alice\0alice@example.test\0`), /groups of 5/);
});
