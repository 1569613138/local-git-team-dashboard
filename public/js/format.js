const localeNumber = new Intl.NumberFormat("zh-CN");
const compactNumber = new Intl.NumberFormat("zh-CN", { notation: "compact", maximumFractionDigits: 1 });
const percentNumber = new Intl.NumberFormat("zh-CN", { style: "percent", maximumFractionDigits: 1 });
const dateFormatter = new Intl.DateTimeFormat("zh-CN", { month: "short", day: "numeric" });
const dateTimeFormatter = new Intl.DateTimeFormat("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });

export function number(value, compact = false) {
  const numeric = Number(value) || 0;
  return (compact && Math.abs(numeric) >= 10_000 ? compactNumber : localeNumber).format(numeric);
}

export function signed(value, compact = false) {
  const numeric = Number(value) || 0;
  return `${numeric > 0 ? "+" : numeric < 0 ? "−" : ""}${number(Math.abs(numeric), compact)}`;
}

export function percent(value) {
  const numeric = Number(value) || 0;
  return percentNumber.format(Math.abs(numeric) > 1 ? numeric / 100 : numeric);
}

export function date(value) {
  if (!value) return "--";
  const parsed = new Date(`${String(value).slice(0, 10)}T00:00:00`);
  return Number.isNaN(parsed.getTime()) ? String(value) : dateFormatter.format(parsed);
}

export function dateTime(value) {
  if (!value) return "--";
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? String(value) : dateTimeFormatter.format(parsed);
}

export function duration(ms) {
  const seconds = Math.max(0, Math.round((Number(ms) || 0) / 1000));
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes} 分 ${seconds % 60} 秒`;
}

export function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

export function initials(name) {
  const text = String(name || "?").trim();
  const words = text.split(/[\s._-]+/).filter(Boolean);
  return (words.length > 1 ? words.slice(0, 2).map((word) => word[0]).join("") : text.slice(0, 2)).toUpperCase();
}

export function rangeText(filters) {
  const from = String(filters.from || "");
  if (filters.period === "day") return `${date(from)} · 单日`;
  if (filters.period === "month") return `${from.slice(0, 4)} 年 ${Number(from.slice(5, 7))} 月`;
  if (filters.period === "quarter") return `${filters.periodYear} 年第 ${filters.periodQuarter} 季度`;
  if (filters.period === "year") return `${filters.periodYear} 年`;
  return `${date(filters.from)}—${date(filters.to)}`;
}
