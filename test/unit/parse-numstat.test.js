import assert from 'node:assert/strict';
import test from 'node:test';
import { parseNumstat } from '../../src/server/git/parse-numstat.js';

const OID = 'a'.repeat(40);

test('解析普通、重命名、二进制及特殊字符路径', () => {
  const input = Buffer.from([
    `commit\t${OID}`,
    '12\t3\tplain file.txt',
    '0\t0\t', 'old\tname.txt', 'new\nname.txt',
    '-\t-\timage.bin',
    '',
  ].join('\0'));

  assert.deepEqual(parseNumstat(input), [{
    oid: OID,
    files: [
      { path: 'plain file.txt', added: 12, deleted: 3, binary: false },
      { path: 'new\nname.txt', oldPath: 'old\tname.txt', added: 0, deleted: 0, binary: false },
      { path: 'image.bin', added: null, deleted: null, binary: true },
    ],
  }]);
});

test('拒绝损坏的 numstat', () => {
  assert.throws(() => parseNumstat(`commit\t${OID}\0bad\0`), /Malformed numstat/);
});
