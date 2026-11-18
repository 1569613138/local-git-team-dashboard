import test from 'node:test';
import assert from 'node:assert/strict';
import {
  bucketKey,
  endOfShanghaiDay,
  enumerateBuckets,
  resolveDateRange,
  startOfShanghaiDay,
  startOfWeek,
  toShanghaiDateKey,
} from '../../src/server/domain/time.js';

test('AuthorDate 按 Asia/Shanghai 转换且日期边界含起止日', () => {
  assert.equal(toShanghaiDateKey('2026-01-01T15:59:59Z'), '2026-01-01');
  assert.equal(toShanghaiDateKey('2026-01-01T16:00:00Z'), '2026-01-02');
  assert.equal(startOfShanghaiDay('2026-01-02').toISOString(), '2026-01-01T16:00:00.000Z');
  assert.equal(endOfShanghaiDay('2026-01-02').toISOString(), '2026-01-02T15:59:59.999Z');
});

test('周桶从周一开始，日周月 bucket 正确', () => {
  assert.equal(startOfWeek('2026-10-18'), '2026-10-12');
  assert.equal(startOfWeek('2026-10-19'), '2026-10-19');
  assert.equal(bucketKey('2026-10-18T18:00:00Z', 'day'), '2026-10-19');
  assert.equal(bucketKey('2026-10-18T18:00:00Z', 'week'), '2026-10-19');
  assert.equal(bucketKey('2026-10-18T18:00:00Z', 'month'), '2026-10');
  assert.throws(() => bucketKey(new Date(), 'year'), /granularity/u);
});

test('7/30/90 天预设都包含当天', () => {
  const now = '2026-10-15T04:00:00Z';
  assert.deepEqual(
    [resolveDateRange('7d', { now }).startDate, resolveDateRange('7d', { now }).endDate],
    ['2026-10-09', '2026-10-15'],
  );
  assert.equal(resolveDateRange('30', { now }).startDate, '2026-09-16');
  assert.equal(resolveDateRange('90d', { now }).startDate, '2026-07-18');
});

test('本月和自定义范围生成含起止日的上海时区时间', () => {
  const month = resolveDateRange('this-month', { now: '2026-10-15T04:00:00Z' });
  assert.equal(month.startDate, '2026-10-01');
  assert.equal(month.endDate, '2026-10-15');

  const custom = resolveDateRange('custom', { start: '2026-09-30', end: '2026-10-02' });
  assert.equal(custom.startInclusive, '2026-09-29T16:00:00.000Z');
  assert.equal(custom.endInclusive, '2026-10-02T15:59:59.999Z');
  assert.equal(custom.endExclusive, '2026-10-02T16:00:00.000Z');
  assert.throws(
    () => resolveDateRange('custom', { start: '2026-10-03', end: '2026-10-02' }),
    /must not be after/u,
  );
});

test('可枚举跨周、跨月范围的 bucket', () => {
  const range = { startDate: '2026-09-30', endDate: '2026-10-06' };
  assert.deepEqual(enumerateBuckets(range, 'day'), [
    '2026-09-30', '2026-10-01', '2026-10-02', '2026-10-03',
    '2026-10-04', '2026-10-05', '2026-10-06',
  ]);
  assert.deepEqual(enumerateBuckets(range, 'week'), ['2026-09-28', '2026-10-05']);
  assert.deepEqual(enumerateBuckets(range, 'month'), ['2026-09', '2026-10']);
});

test('日期严格校验真实日历日期', () => {
  assert.throws(() => startOfShanghaiDay('2026-02-30'), /valid calendar date/u);
  assert.throws(() => resolveDateRange('unknown'), /preset/u);
});
