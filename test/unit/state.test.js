import test from 'node:test';
import assert from 'node:assert/strict';
import {
  defaultFilters,
  filtersFromUrl,
  periodRange,
  selectPeriod,
  setPeriodSelection,
  shiftPeriod,
} from '../../public/js/state.js';

const NOW = new Date(2026, 9, 15, 12, 0, 0);

test('默认打开本月并只展示配置成员', () => {
  const filters = defaultFilters(NOW);
  assert.equal(filters.period, 'month');
  assert.equal(filters.from, '2026-10-01');
  assert.equal(filters.to, '2026-10-31');
  assert.equal(filters.scope, 'group');
  assert.equal(filters.sort, 'additions');
  assert.equal(filters.direction, 'desc');
});

test('日、月、季度和年生成完整自然周期', () => {
  assert.deepEqual(periodRange('day', { periodDate: '2026-02-18' }, NOW), {
    from: '2026-02-18', to: '2026-02-18', granularity: 'day',
  });
  assert.deepEqual(periodRange('month', { periodMonth: '2024-02' }, NOW), {
    from: '2024-02-01', to: '2024-02-29', granularity: 'day',
  });
  assert.deepEqual(periodRange('quarter', { periodYear: 2026, periodQuarter: 4 }, NOW), {
    from: '2026-10-01', to: '2026-12-31', granularity: 'month',
  });
  assert.deepEqual(periodRange('year', { periodYear: 2025 }, NOW), {
    from: '2025-01-01', to: '2025-12-31', granularity: 'month',
  });
});

test('选择季度和年份会同步真实日期范围', () => {
  const base = defaultFilters(NOW);
  const quarter = setPeriodSelection(selectPeriod(base, 'quarter', NOW), {
    periodYear: 2025,
    periodQuarter: 2,
  }, NOW);
  assert.equal(quarter.periodDate, '2025-04-01');
  assert.equal(quarter.from, '2025-04-01');
  assert.equal(quarter.to, '2025-06-30');

  const year = setPeriodSelection(selectPeriod(quarter, 'year', NOW), { periodYear: 2024 }, NOW);
  assert.equal(year.periodDate, '2024-01-01');
  assert.equal(year.from, '2024-01-01');
  assert.equal(year.to, '2024-12-31');
});

test('前后周期切换覆盖跨年和季度边界', () => {
  const december = setPeriodSelection(defaultFilters(NOW), { periodMonth: '2025-12' }, NOW);
  const january = shiftPeriod(december, 1);
  assert.equal(january.periodMonth, '2026-01');
  assert.equal(january.from, '2026-01-01');

  const q4 = setPeriodSelection(selectPeriod(defaultFilters(NOW), 'quarter', NOW), {
    periodYear: 2025,
    periodQuarter: 4,
  }, NOW);
  const q1 = shiftPeriod(q4, 1);
  assert.equal(q1.periodYear, 2026);
  assert.equal(q1.periodQuarter, 1);
  assert.equal(q1.from, '2026-01-01');
});

test('URL 可恢复周期、具体分支、工号筛选与排序', () => {
  const filters = filtersFromUrl('?period=quarter&year=2025&quarter=3&repo=app&branch=refs%2Fremotes%2Forigin%2Ffeature%2Fdemo&scope=group&member=alice&member=zoe&sort=commits&direction=asc', NOW);
  assert.equal(filters.period, 'quarter');
  assert.equal(filters.from, '2025-07-01');
  assert.equal(filters.to, '2025-09-30');
  assert.deepEqual(filters.repositories, ['app']);
  assert.equal(filters.branch, 'refs/remotes/origin/feature/demo');
  assert.equal(filters.scope, 'group');
  assert.deepEqual(filters.members, ['alice', 'zoe']);
  assert.equal(filters.sort, 'commits');
  assert.equal(filters.direction, 'asc');
});
