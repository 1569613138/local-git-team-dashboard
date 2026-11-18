export const TIME_ZONE = 'Asia/Shanghai';
export const SHANGHAI_OFFSET_MINUTES = 8 * 60;
const OFFSET_MS = SHANGHAI_OFFSET_MINUTES * 60_000;
const DAY_MS = 86_400_000;
const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/u;

function pad(value) {
  return String(value).padStart(2, '0');
}

function formatParts(year, month, day) {
  return `${year}-${pad(month)}-${pad(day)}`;
}

function dateParts(dateKey, label = 'date') {
  if (typeof dateKey !== 'string') {
    throw new TypeError(`${label} must use YYYY-MM-DD`);
  }
  const match = DATE_PATTERN.exec(dateKey);
  if (!match) throw new TypeError(`${label} must use YYYY-MM-DD`);

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (probe.getUTCFullYear() !== year || probe.getUTCMonth() !== month - 1 || probe.getUTCDate() !== day) {
    throw new TypeError(`${label} is not a valid calendar date`);
  }
  return { year, month, day };
}

function localDayNumber(dateKey) {
  const { year, month, day } = dateParts(dateKey);
  return Date.UTC(year, month - 1, day) / DAY_MS;
}

function dayNumberToKey(dayNumber) {
  const date = new Date(dayNumber * DAY_MS);
  return formatParts(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate());
}

function instant(value, label = 'date') {
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new TypeError(`${label} must be a valid Date or ISO date-time`);
  }
  return date;
}

export function toShanghaiDateKey(authorDate) {
  const shifted = new Date(instant(authorDate, 'authorDate').getTime() + OFFSET_MS);
  return formatParts(shifted.getUTCFullYear(), shifted.getUTCMonth() + 1, shifted.getUTCDate());
}

export function startOfShanghaiDay(dateKey) {
  const { year, month, day } = dateParts(dateKey);
  return new Date(Date.UTC(year, month - 1, day) - OFFSET_MS);
}

export function endOfShanghaiDay(dateKey) {
  return new Date(startOfShanghaiDay(dateKey).getTime() + DAY_MS - 1);
}

export function startOfWeek(dateOrKey) {
  const key = DATE_PATTERN.test(String(dateOrKey)) ? String(dateOrKey) : toShanghaiDateKey(dateOrKey);
  const number = localDayNumber(key);
  const weekday = new Date(number * DAY_MS).getUTCDay();
  return dayNumberToKey(number - ((weekday + 6) % 7));
}

export function bucketKey(authorDate, granularity = 'day') {
  const day = toShanghaiDateKey(authorDate);
  if (granularity === 'day') return day;
  if (granularity === 'week') return startOfWeek(day);
  if (granularity === 'month') return day.slice(0, 7);
  throw new TypeError('granularity must be day, week, or month');
}

function normalizePreset(preset) {
  const normalized = String(preset).trim().toLocaleLowerCase('en-US');
  const aliases = new Map([
    ['7', '7d'], ['7d', '7d'], ['last7days', '7d'],
    ['30', '30d'], ['30d', '30d'], ['last30days', '30d'],
    ['90', '90d'], ['90d', '90d'], ['last90days', '90d'],
    ['month', 'month'], ['this-month', 'month'], ['thismonth', 'month'],
    ['custom', 'custom'],
  ]);
  const result = aliases.get(normalized);
  if (!result) throw new TypeError('preset must be 7d, 30d, 90d, month, or custom');
  return result;
}

export function resolveDateRange(preset = '30d', options = {}) {
  if (options instanceof Date || typeof options === 'string' || typeof options === 'number') {
    options = { now: options };
  }
  if (options === null || typeof options !== 'object' || Array.isArray(options)) {
    throw new TypeError('date range options must be an object');
  }

  const normalizedPreset = normalizePreset(preset);
  let startDate;
  let endDate;

  if (normalizedPreset === 'custom') {
    startDate = options.startDate ?? options.start;
    endDate = options.endDate ?? options.end;
    dateParts(startDate, 'startDate');
    dateParts(endDate, 'endDate');
  } else {
    endDate = toShanghaiDateKey(options.now ?? new Date());
    if (normalizedPreset === 'month') {
      startDate = `${endDate.slice(0, 7)}-01`;
    } else {
      const days = Number.parseInt(normalizedPreset, 10);
      startDate = dayNumberToKey(localDayNumber(endDate) - days + 1);
    }
  }

  if (localDayNumber(startDate) > localDayNumber(endDate)) {
    throw new RangeError('startDate must not be after endDate');
  }

  const start = startOfShanghaiDay(startDate);
  const end = endOfShanghaiDay(endDate);
  return Object.freeze({
    preset: normalizedPreset,
    startDate,
    endDate,
    start,
    end,
    startInclusive: start.toISOString(),
    endInclusive: end.toISOString(),
    endExclusive: new Date(end.getTime() + 1).toISOString(),
  });
}

export function enumerateBuckets(range, granularity = 'day') {
  if (!range || typeof range !== 'object') throw new TypeError('range must be an object');
  const first = range.startDate ?? range.start;
  const last = range.endDate ?? range.end;
  dateParts(first, 'range.startDate');
  dateParts(last, 'range.endDate');
  if (localDayNumber(first) > localDayNumber(last)) return [];

  const buckets = [];
  const seen = new Set();
  for (let day = localDayNumber(first); day <= localDayNumber(last); day += 1) {
    const dateKey = dayNumberToKey(day);
    const key = granularity === 'day'
      ? dateKey
      : granularity === 'week'
        ? startOfWeek(dateKey)
        : granularity === 'month'
          ? dateKey.slice(0, 7)
          : null;
    if (key === null) throw new TypeError('granularity must be day, week, or month');
    if (!seen.has(key)) {
      seen.add(key);
      buckets.push(key);
    }
  }
  return buckets;
}

export const getBucketKey = bucketKey;
export const getDateRange = resolveDateRange;
