const DAY = 86_400_000;
const PERIODS = new Set(["day", "month", "quarter", "year"]);
const SORT_KEYS = new Set(["additions", "deletions", "netLines", "churn", "commits", "merges", "activeDays", "averageChurn", "name"]);

function localDate(date) {
  const copy = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return copy.toISOString().slice(0, 10);
}

function daysInMonth(year, month) {
  return new Date(year, month, 0).getDate();
}

function clampDay(date, year, month) {
  return Math.min(date.getDate(), daysInMonth(year, month));
}

function parseDate(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(value || "");
  if (!match) return new Date();
  return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
}

function safeInteger(value, fallback) {
  const numeric = Number(value);
  return Number.isInteger(numeric) ? numeric : fallback;
}

export function currentPeriod(now = new Date()) {
  return {
    period: "month",
    periodDate: localDate(now),
    periodYear: now.getFullYear(),
    periodQuarter: Math.floor(now.getMonth() / 3) + 1,
  };
}

export function periodRange(period, selection = {}, now = new Date()) {
  const fallbackDate = localDate(now);
  if (period === "day") {
    const date = /^\d{4}-\d{2}-\d{2}$/u.test(selection.periodDate || "") ? selection.periodDate : fallbackDate;
    return { from: date, to: date, granularity: "day" };
  }
  if (period === "month") {
    const month = /^\d{4}-\d{2}$/u.test(selection.periodMonth || "")
      ? selection.periodMonth
      : (selection.periodDate || fallbackDate).slice(0, 7);
    const [year, monthNumber] = month.split("-").map(Number);
    return {
      from: `${month}-01`,
      to: `${month}-${String(daysInMonth(year, monthNumber)).padStart(2, "0")}`,
      granularity: "day",
    };
  }
  if (period === "quarter") {
    const year = Math.min(2100, Math.max(2000, safeInteger(selection.periodYear, now.getFullYear())));
    const quarter = Math.min(4, Math.max(1, safeInteger(selection.periodQuarter, Math.floor(now.getMonth() / 3) + 1)));
    const startMonth = (quarter - 1) * 3 + 1;
    const endMonth = startMonth + 2;
    return {
      from: `${year}-${String(startMonth).padStart(2, "0")}-01`,
      to: `${year}-${String(endMonth).padStart(2, "0")}-${String(daysInMonth(year, endMonth)).padStart(2, "0")}`,
      granularity: "month",
    };
  }
  const year = Math.min(2100, Math.max(2000, safeInteger(selection.periodYear, now.getFullYear())));
  return { from: `${year}-01-01`, to: `${year}-12-31`, granularity: "month" };
}

function deriveSelection(period, from, now = new Date()) {
  const date = /^\d{4}-\d{2}-\d{2}$/u.test(from || "") ? from : localDate(now);
  const year = Number(date.slice(0, 4));
  const month = Number(date.slice(5, 7));
  return {
    period,
    periodDate: date,
    periodMonth: date.slice(0, 7),
    periodYear: year,
    periodQuarter: Math.floor((month - 1) / 3) + 1,
  };
}

export function defaultFilters(now = new Date()) {
  const selection = currentPeriod(now);
  const range = periodRange(selection.period, selection, now);
  return {
    ...selection,
    periodMonth: selection.periodDate.slice(0, 7),
    ...range,
    repositories: [],
    branch: "default",
    scope: "group",
    members: [],
    sort: "additions",
    direction: "desc",
  };
}

export function filtersFromUrl(search = typeof window === "undefined" ? "" : window.location.search, now = new Date()) {
  const params = new URLSearchParams(search);
  const fallback = defaultFilters(now);
  const requestedPeriod = params.get("period");
  const legacyRange = params.get("range");
  const period = PERIODS.has(requestedPeriod)
    ? requestedPeriod
    : legacyRange === "year" ? "year" : legacyRange === "month" ? "month" : fallback.period;
  const from = params.get("from");
  const selection = deriveSelection(period, from || fallback.from, now);
  if (period === "day" && /^\d{4}-\d{2}-\d{2}$/u.test(params.get("date") || "")) selection.periodDate = params.get("date");
  if (period === "month" && /^\d{4}-\d{2}$/u.test(params.get("month") || "")) {
    selection.periodMonth = params.get("month");
    selection.periodDate = `${params.get("month")}-01`;
  }
  if (["quarter", "year"].includes(period)) {
    selection.periodYear = Math.min(2100, Math.max(2000, safeInteger(params.get("year"), selection.periodYear)));
  }
  if (period === "quarter") selection.periodQuarter = Math.min(4, Math.max(1, safeInteger(params.get("quarter"), selection.periodQuarter)));
  const range = periodRange(period, selection, now);
  const sort = SORT_KEYS.has(params.get("sort")) ? params.get("sort") : fallback.sort;
  const direction = params.get("direction") === "asc" ? "asc" : "desc";
  return {
    ...fallback,
    ...selection,
    ...range,
    repositories: params.getAll("repo"),
    branch: params.get("branch") || fallback.branch,
    scope: ["group", "all"].includes(params.get("scope")) ? params.get("scope") : fallback.scope,
    members: params.getAll("member"),
    sort,
    direction,
  };
}

export function selectPeriod(filters, period, now = new Date()) {
  if (!PERIODS.has(period)) throw new TypeError(`Unknown period: ${period}`);
  const current = parseDate(filters.periodDate || filters.from);
  const selectedYear = Number(filters.periodYear) || current.getFullYear();
  const selectedQuarter = Number(filters.periodQuarter) || Math.floor(current.getMonth() / 3) + 1;
  const periodDate = period === "quarter"
    ? `${selectedYear}-${String((selectedQuarter - 1) * 3 + 1).padStart(2, "0")}-01`
    : period === "year"
      ? `${selectedYear}-01-01`
      : localDate(current);
  const selection = {
    ...filters,
    period,
    periodDate,
    periodMonth: periodDate.slice(0, 7),
    periodYear: Number(periodDate.slice(0, 4)),
    periodQuarter: Math.floor((Number(periodDate.slice(5, 7)) - 1) / 3) + 1,
  };
  return { ...selection, ...periodRange(period, selection, now) };
}

export function setPeriodSelection(filters, values = {}, now = new Date()) {
  const selection = { ...filters, ...values };
  if (values.periodDate) {
    selection.periodMonth = values.periodDate.slice(0, 7);
    selection.periodYear = Number(values.periodDate.slice(0, 4));
    selection.periodQuarter = Math.floor((Number(values.periodDate.slice(5, 7)) - 1) / 3) + 1;
  }
  if (values.periodMonth) {
    selection.periodDate = `${values.periodMonth}-01`;
    selection.periodYear = Number(values.periodMonth.slice(0, 4));
    selection.periodQuarter = Math.floor((Number(values.periodMonth.slice(5, 7)) - 1) / 3) + 1;
  }
  if (selection.period === "quarter" && (values.periodYear !== undefined || values.periodQuarter !== undefined)) {
    const startMonth = (Math.min(4, Math.max(1, Number(selection.periodQuarter) || 1)) - 1) * 3 + 1;
    selection.periodDate = `${selection.periodYear}-${String(startMonth).padStart(2, "0")}-01`;
    selection.periodMonth = selection.periodDate.slice(0, 7);
  }
  if (selection.period === "year" && values.periodYear !== undefined) {
    selection.periodDate = `${selection.periodYear}-01-01`;
    selection.periodMonth = `${selection.periodYear}-01`;
    selection.periodQuarter = 1;
  }
  return { ...selection, ...periodRange(selection.period, selection, now) };
}

export function shiftPeriod(filters, amount) {
  const step = Math.sign(Number(amount));
  if (!step) return filters;
  let next;
  if (filters.period === "quarter") {
    const startMonth = (Number(filters.periodQuarter) - 1) * 3;
    next = new Date(Number(filters.periodYear), startMonth + step * 3, 1);
  } else if (filters.period === "year") {
    next = new Date(Number(filters.periodYear) + step, 0, 1);
  } else {
    const base = parseDate(filters.periodDate || filters.from);
    if (filters.period === "day") {
      next = new Date(base.getFullYear(), base.getMonth(), base.getDate() + step);
    } else {
      const targetMonth = base.getMonth() + step;
      const targetYear = base.getFullYear() + Math.floor(targetMonth / 12);
      const normalizedMonth = ((targetMonth % 12) + 12) % 12;
      next = new Date(targetYear, normalizedMonth, clampDay(base, targetYear, normalizedMonth + 1));
    }
  }
  const nextDate = localDate(next);
  return selectPeriod({
    ...filters,
    periodDate: nextDate,
    periodMonth: nextDate.slice(0, 7),
    periodYear: next.getFullYear(),
    periodQuarter: Math.floor(next.getMonth() / 3) + 1,
    from: nextDate,
  }, filters.period, next);
}

export function normalizeFilters(filters) {
  const period = PERIODS.has(filters.period) ? filters.period : "month";
  const normalized = { ...filters, period };
  const range = periodRange(period, normalized);
  return {
    ...normalized,
    ...range,
    repositories: [...new Set(filters.repositories || [])].filter(Boolean),
    members: [...new Set(filters.members || [])].filter(Boolean),
    sort: SORT_KEYS.has(filters.sort) ? filters.sort : "additions",
    direction: filters.direction === "asc" ? "asc" : "desc",
  };
}

export function syncUrl(filters, mode = "replace") {
  if (typeof window === "undefined") return;
  const params = new URLSearchParams();
  params.set("period", filters.period);
  if (filters.period === "day") params.set("date", filters.periodDate);
  if (filters.period === "month") params.set("month", filters.periodMonth);
  if (["quarter", "year"].includes(filters.period)) params.set("year", String(filters.periodYear));
  if (filters.period === "quarter") params.set("quarter", String(filters.periodQuarter));
  filters.repositories.forEach((value) => params.append("repo", value));
  if (filters.branch !== "default") params.set("branch", filters.branch);
  if (filters.scope !== "all") params.set("scope", filters.scope);
  filters.members.forEach((value) => params.append("member", value));
  if (filters.sort !== "additions") params.set("sort", filters.sort);
  if (filters.direction !== "desc") params.set("direction", filters.direction);
  const query = params.toString();
  const url = `${window.location.pathname}${query ? `?${query}` : ""}${window.location.hash}`;
  window.history[mode === "push" ? "pushState" : "replaceState"](null, "", url);
}

export function createStore(initial = {}) {
  let state = {
    filters: filtersFromUrl(),
    meta: null,
    identities: null,
    stats: null,
    loading: true,
    error: null,
    partialFailures: [],
    refreshing: false,
    job: null,
    ...initial,
  };
  const listeners = new Set();
  return {
    get: () => state,
    set(patch) {
      state = { ...state, ...(typeof patch === "function" ? patch(state) : patch) };
      listeners.forEach((listener) => listener(state));
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

export { DAY };
