import test from 'node:test';
import assert from 'node:assert/strict';
import { sortMembers } from '../../public/js/render.js';
import { DAILY_PEAK_THRESHOLDS, prepareDailyTrend } from '../../public/js/charts.js';

const members = [
  { id: 'alice', displayName: 'Alice', additions: 100, deletions: 30, commits: 5, merges: 1, activeDays: 3 },
  { id: 'bob', displayName: 'Bob', additions: 80, deletions: 90, commits: 8, merges: 2, activeDays: 6 },
  { id: 'zoe', displayName: 'Zoe', additions: 40, deletions: 10, commits: 2, merges: 0, activeDays: 2 },
];

test('成员派生净增、变更量和平均变更行数', () => {
  const [alice] = sortMembers(members, 'name', 'asc');
  assert.equal(alice.netLines, 70);
  assert.equal(alice.churn, 130);
  assert.equal(alice.averageChurn, 26);
});

test('可按新增、删除、净增、变更量和提交次数排序', () => {
  assert.deepEqual(sortMembers(members, 'additions', 'desc').map(({ name }) => name), ['Alice', 'Bob', 'Zoe']);
  assert.deepEqual(sortMembers(members, 'deletions', 'desc').map(({ name }) => name), ['Bob', 'Alice', 'Zoe']);
  assert.deepEqual(sortMembers(members, 'netLines', 'desc').map(({ name }) => name), ['Alice', 'Zoe', 'Bob']);
  assert.deepEqual(sortMembers(members, 'churn', 'desc').map(({ name }) => name), ['Bob', 'Alice', 'Zoe']);
  assert.deepEqual(sortMembers(members, 'commits', 'desc').map(({ name }) => name), ['Bob', 'Alice', 'Zoe']);
});

test('异常提交字段缺失时归零且不影响原排序', () => {
  const enriched = sortMembers([
    { displayName: 'Alice', additions: 10, anomalyCommits: 2 },
    { displayName: 'Bob', additions: 20 },
  ], 'additions', 'desc');
  assert.deepEqual(enriched.map(({ name, anomalyCommits }) => [name, anomalyCommits]), [
    ['Bob', 0],
    ['Alice', 2],
  ]);
});

test('排序方向可反转，数值相同时按姓名稳定排序', () => {
  assert.deepEqual(sortMembers(members, 'commits', 'asc').map(({ name }) => name), ['Zoe', 'Alice', 'Bob']);
  const tied = [
    { displayName: 'Zoe', additions: 10 },
    { displayName: 'Alice', additions: 10 },
  ];
  assert.deepEqual(sortMembers(tied, 'additions', 'desc').map(({ name }) => name), ['Alice', 'Zoe']);
});

test('每日趋势按单日变更量或有效提交次数标记集中峰值', () => {
  const trend = prepareDailyTrend([
    { date: '2026-10-01', commits: 19, merges: 100, additions: 2_500, deletions: 2_499 },
    { date: '2026-10-02', commits: 0, merges: 0, additions: 3_000, deletions: 2_000 },
    { date: '2026-10-03', commits: 20, merges: 0, additions: 10, deletions: 5 },
    { date: '2026-10-04', commits: 20, merges: 2, additions: 4_000, deletions: 1_000 },
  ]);

  assert.deepEqual(trend.map(({ label, churn, isPeak, peakReasons }) => ({ label, churn, isPeak, peakReasons })), [
    { label: '2026-10-01', churn: 4_999, isPeak: false, peakReasons: [] },
    { label: '2026-10-02', churn: 5_000, isPeak: true, peakReasons: [`单日变更量达到 ${DAILY_PEAK_THRESHOLDS.churn.toLocaleString('zh-CN')} 行`] },
    { label: '2026-10-03', churn: 15, isPeak: true, peakReasons: [`单日有效提交达到 ${DAILY_PEAK_THRESHOLDS.commits} 次`] },
    { label: '2026-10-04', churn: 5_000, isPeak: true, peakReasons: [`单日变更量达到 ${DAILY_PEAK_THRESHOLDS.churn.toLocaleString('zh-CN')} 行`, `单日有效提交达到 ${DAILY_PEAK_THRESHOLDS.commits} 次`] },
  ]);
});

test('每日趋势的 Merge 次数不会误触发有效提交峰值', () => {
  const [day] = prepareDailyTrend([{ date: '2026-10-01', commits: 1, merges: 30, churn: 100 }]);
  assert.equal(day.isPeak, false);
  assert.equal(day.commits, 1);
  assert.equal(day.merges, 30);
});
