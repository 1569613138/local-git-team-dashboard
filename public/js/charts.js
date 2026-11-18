import { date, escapeHtml, number } from "./format.js";

const NS = "http://www.w3.org/2000/svg";

function svg(tag, attrs = {}, text = "") {
  const node = document.createElementNS(NS, tag);
  Object.entries(attrs).forEach(([key, value]) => node.setAttribute(key, value));
  if (text) node.textContent = text;
  return node;
}

function stateMarkup(kind, title, detail) {
  return `<div class="${kind}-state"><strong class="state-title">${escapeHtml(title)}</strong><span class="state-detail">${escapeHtml(detail)}</span></div>`;
}

export const DAILY_PEAK_THRESHOLDS = Object.freeze({
  churn: 5_000,
  commits: 20,
});

export function prepareDailyTrend(raw = [], thresholds = DAILY_PEAK_THRESHOLDS) {
  return raw.map((item) => {
    const commits = Number(item.commits ?? item.count ?? 0);
    const merges = Number(item.merges ?? item.mergeCount ?? 0);
    const additions = Number(item.additions ?? item.added ?? 0);
    const deletions = Number(item.deletions ?? item.deleted ?? 0);
    const churn = Number(item.churn ?? additions + deletions);
    const peakReasons = [];
    if (churn >= thresholds.churn) peakReasons.push(`单日变更量达到 ${number(thresholds.churn)} 行`);
    if (commits >= thresholds.commits) peakReasons.push(`单日有效提交达到 ${number(thresholds.commits)} 次`);
    return {
      label: String(item.label || item.date || item.period || ""),
      commits,
      merges,
      additions,
      deletions,
      churn,
      isPeak: peakReasons.length > 0,
      peakReasons,
    };
  });
}

function linePath(data, x, y, key) {
  return data.map((item, index) => `${index ? "L" : "M"}${x(index).toFixed(1)},${y(item[key]).toFixed(1)}`).join(" ");
}

export function renderDailyContributionChart(container, raw = []) {
  const data = prepareDailyTrend(raw);
  if (!data.length) {
    container.innerHTML = stateMarkup("empty", "暂无每日趋势数据", "调整日期、仓库、分支或工号后重试");
    return { peakCount: 0, peaks: [] };
  }

  const width = 1240;
  const height = 320;
  const margin = { top: 28, right: 58, bottom: 42, left: 46 };
  const plotW = width - margin.left - margin.right;
  const plotH = height - margin.top - margin.bottom;
  const maxCount = Math.max(1, ...data.flatMap((item) => [item.commits, item.merges]));
  const maxChurn = Math.max(1, ...data.map((item) => item.churn));
  const band = plotW / data.length;
  const barW = Math.max(4, Math.min(22, band * .58));
  const x = (index) => margin.left + index * band + band / 2;
  const countY = (value) => margin.top + plotH - value / maxCount * plotH;
  const churnY = (value) => margin.top + plotH - value / maxChurn * plotH;
  const root = svg("svg", { viewBox: `0 0 ${width} ${height}`, role: "img", "aria-label": "每日有效提交、Merge 与代码变更总量组合趋势图" });

  for (let i = 0; i <= 4; i += 1) {
    const yy = margin.top + i * plotH / 4;
    root.append(svg("line", { x1: margin.left, y1: yy, x2: width - margin.right, y2: yy, class: "chart-grid-line" }));
    root.append(svg("text", { x: margin.left - 8, y: yy + 4, "text-anchor": "end", class: "chart-axis-text" }, number(Math.round(maxCount * (4 - i) / 4))));
    root.append(svg("text", { x: width - margin.right + 8, y: yy + 4, "text-anchor": "start", class: "chart-axis-text" }, number(Math.round(maxChurn * (4 - i) / 4), true)));
  }
  root.append(svg("text", { x: margin.left, y: 13, class: "chart-axis-title" }, "提交次数"));
  root.append(svg("text", { x: width - margin.right, y: 13, "text-anchor": "end", class: "chart-axis-title" }, "变更行数"));

  const labelStep = Math.max(1, Math.ceil(data.length / 10));
  data.forEach((item, index) => {
    const xx = x(index);
    const barHeight = item.churn / maxChurn * plotH;
    const bar = svg("rect", {
      x: xx - barW / 2,
      y: margin.top + plotH - barHeight,
      width: barW,
      height: Math.max(item.churn ? 1 : 0, barHeight),
      rx: 2,
      class: `daily-churn-bar${item.isPeak ? " is-peak" : ""}`,
    });
    bar.append(svg("title", {}, `${item.label} · 变更 ${number(item.churn)} 行`));
    root.append(bar);
    if (index % labelStep === 0 || index === data.length - 1) {
      root.append(svg("text", { x: xx, y: height - 12, "text-anchor": "middle", class: "chart-axis-text" }, date(item.label)));
    }
  });

  root.append(svg("path", { d: linePath(data, x, countY, "commits"), class: "daily-commit-line" }));
  root.append(svg("path", { d: linePath(data, x, countY, "merges"), class: "daily-merge-line" }));

  data.forEach((item, index) => {
    const xx = x(index);
    root.append(svg("circle", { cx: xx, cy: countY(item.commits), r: 3, class: "daily-commit-dot" }));
    root.append(svg("circle", { cx: xx, cy: countY(item.merges), r: 2.7, class: "daily-merge-dot" }));
    if (item.isPeak) {
      const markerY = Math.max(margin.top + 8, churnY(item.churn) - 9);
      const marker = svg("path", { d: `M${xx},${markerY - 5} L${xx + 5},${markerY} L${xx},${markerY + 5} L${xx - 5},${markerY} Z`, class: "daily-peak-marker", tabindex: "0", role: "img", "aria-label": `${item.label}，集中提交峰值，${item.peakReasons.join("，")}` });
      marker.append(svg("title", {}, `${item.label} · ${item.peakReasons.join("；")}`));
      root.append(marker);
    }

    const hitW = Math.max(14, band);
    const hit = svg("rect", { x: xx - hitW / 2, y: margin.top, width: hitW, height: plotH, fill: "transparent", class: "chart-hit", tabindex: "0", role: "img", "aria-label": `${item.label}，有效提交 ${item.commits} 次，Merge ${item.merges} 次，变更 ${item.churn} 行` });
    const focus = svg("g", { class: "chart-focus" });
    const tooltipW = 174;
    const tooltipH = item.isPeak ? 75 : 59;
    const tx = Math.min(width - margin.right - tooltipW, Math.max(margin.left, xx - tooltipW / 2));
    focus.append(svg("line", { x1: xx, y1: margin.top, x2: xx, y2: margin.top + plotH, class: "chart-focus-line" }));
    focus.append(svg("rect", { x: tx, y: margin.top + 5, width: tooltipW, height: tooltipH, rx: 5, class: "chart-tooltip" }));
    focus.append(svg("text", { x: tx + 9, y: margin.top + 21, class: "chart-tooltip-title" }, `${date(item.label)}${item.isPeak ? " · 集中峰值" : ""}`));
    focus.append(svg("text", { x: tx + 9, y: margin.top + 38, class: "chart-tooltip-text" }, `提交 ${number(item.commits)} · Merge ${number(item.merges)}`));
    focus.append(svg("text", { x: tx + 9, y: margin.top + 54, class: "chart-tooltip-text" }, `变更 ${number(item.churn)}（+${number(item.additions)} / −${number(item.deletions)}）`));
    if (item.isPeak) focus.append(svg("text", { x: tx + 9, y: margin.top + 70, class: "chart-tooltip-warning" }, item.peakReasons.join("；")));
    root.append(hit, focus);
  });

  container.replaceChildren(root);
  const peaks = data.filter((item) => item.isPeak);
  return { peakCount: peaks.length, peaks };
}

export function renderTrendChart(container, raw = []) {
  const data = raw.map((item) => ({ label: item.label || item.date || item.period, commits: Number(item.commits ?? item.count ?? 0), merges: Number(item.merges ?? item.mergeCount ?? 0) }));
  if (!data.length) {
    container.innerHTML = stateMarkup("empty", "暂无趋势数据", "调整筛选范围或刷新数据后重试");
    return;
  }
  const width = 760, height = 276, margin = { top: 18, right: 18, bottom: 34, left: 42 };
  const plotW = width - margin.left - margin.right, plotH = height - margin.top - margin.bottom;
  const max = Math.max(1, ...data.flatMap((item) => [item.commits, item.merges]));
  const x = (index) => margin.left + (data.length === 1 ? plotW / 2 : index * plotW / (data.length - 1));
  const y = (value) => margin.top + plotH - value / max * plotH;
  const line = (key) => data.map((item, index) => `${index ? "L" : "M"}${x(index).toFixed(1)},${y(item[key]).toFixed(1)}`).join(" ");
  const root = svg("svg", { viewBox: `0 0 ${width} ${height}`, role: "img", "aria-label": "有效提交与 Merge 趋势折线图" });
  const defs = svg("defs");
  const gradient = svg("linearGradient", { id: "trendArea", x1: "0", x2: "0", y1: "0", y2: "1" });
  gradient.append(svg("stop", { offset: "0", "stop-color": "#176b5b", "stop-opacity": ".18" }), svg("stop", { offset: "1", "stop-color": "#176b5b", "stop-opacity": ".01" }));
  defs.append(gradient); root.append(defs);
  for (let i = 0; i <= 4; i += 1) {
    const yy = margin.top + i * plotH / 4;
    root.append(svg("line", { x1: margin.left, y1: yy, x2: width - margin.right, y2: yy, class: "chart-grid-line" }));
    root.append(svg("text", { x: margin.left - 8, y: yy + 3, "text-anchor": "end", class: "chart-axis-text" }, number(Math.round(max * (4 - i) / 4), true)));
  }
  const areaPath = `${line("commits")} L${x(data.length - 1)},${margin.top + plotH} L${x(0)},${margin.top + plotH} Z`;
  root.append(svg("path", { d: areaPath, class: "chart-area" }));
  root.append(svg("path", { d: line("commits"), class: "chart-line" }));
  root.append(svg("path", { d: line("merges"), class: "chart-merge" }));
  const labelStep = Math.max(1, Math.ceil(data.length / 7));
  data.forEach((item, index) => {
    if (index % labelStep === 0 || index === data.length - 1) root.append(svg("text", { x: x(index), y: height - 10, "text-anchor": "middle", class: "chart-axis-text" }, date(item.label)));
    root.append(svg("circle", { cx: x(index), cy: y(item.commits), r: 2.4, class: "chart-dot" }));
    const hit = svg("rect", { x: x(index) - Math.max(8, plotW / data.length / 2), y: margin.top, width: Math.max(16, plotW / data.length), height: plotH, fill: "transparent", class: "chart-hit", tabindex: "0", role: "img", "aria-label": `${item.label}，有效提交 ${item.commits}，Merge ${item.merges}` });
    const focus = svg("g", { class: "chart-focus" });
    const tx = Math.min(width - 113, Math.max(margin.left, x(index) - 49));
    focus.append(svg("line", { x1: x(index), y1: margin.top, x2: x(index), y2: margin.top + plotH, stroke: "#9eaaa9", "stroke-dasharray": "2 3" }));
    focus.append(svg("rect", { x: tx, y: margin.top + 4, width: 104, height: 39, rx: 4, class: "chart-tooltip" }));
    focus.append(svg("text", { x: tx + 7, y: margin.top + 19, class: "chart-tooltip-text" }, `${date(item.label)}  提交 ${item.commits}`));
    focus.append(svg("text", { x: tx + 7, y: margin.top + 33, class: "chart-tooltip-text" }, `Merge ${item.merges}`));
    root.append(hit, focus);
  });
  container.replaceChildren(root);
}

export function renderChurnChart(container, raw = []) {
  const data = raw.map((item) => ({ label: item.label || item.date || item.period, additions: Number(item.additions ?? item.added ?? 0), deletions: Number(item.deletions ?? item.deleted ?? 0) }));
  if (!data.length) {
    container.innerHTML = stateMarkup("empty", "暂无增删行数据", "当前范围内没有可展示的代码变更");
    return;
  }
  const width = 470, height = 276, margin = { top: 18, right: 14, bottom: 34, left: 46 };
  const plotW = width - margin.left - margin.right, plotH = height - margin.top - margin.bottom, center = margin.top + plotH / 2;
  const max = Math.max(1, ...data.flatMap((item) => [item.additions, item.deletions]));
  const band = plotW / data.length, barW = Math.max(3, Math.min(14, band * .62));
  const scale = (value) => value / max * (plotH / 2 - 8);
  const root = svg("svg", { viewBox: `0 0 ${width} ${height}`, role: "img", "aria-label": "新增与删除行双向柱状图" });
  [0, .5, 1].forEach((ratio) => {
    const offset = ratio * (plotH / 2 - 8);
    if (ratio) {
      root.append(svg("line", { x1: margin.left, y1: center - offset, x2: width - margin.right, y2: center - offset, class: "chart-grid-line" }));
      root.append(svg("line", { x1: margin.left, y1: center + offset, x2: width - margin.right, y2: center + offset, class: "chart-grid-line" }));
      root.append(svg("text", { x: margin.left - 7, y: center - offset + 3, "text-anchor": "end", class: "chart-axis-text" }, number(Math.round(max * ratio), true)));
      root.append(svg("text", { x: margin.left - 7, y: center + offset + 3, "text-anchor": "end", class: "chart-axis-text" }, `−${number(Math.round(max * ratio), true)}`));
    }
  });
  root.append(svg("line", { x1: margin.left, y1: center, x2: width - margin.right, y2: center, class: "zero-line" }));
  const labelStep = Math.max(1, Math.ceil(data.length / 6));
  data.forEach((item, index) => {
    const xx = margin.left + index * band + (band - barW) / 2;
    const addH = scale(item.additions), delH = scale(item.deletions);
    const add = svg("rect", { x: xx, y: center - addH, width: barW, height: addH, rx: 1.5, class: "bar-add", tabindex: "0" });
    const del = svg("rect", { x: xx, y: center, width: barW, height: delH, rx: 1.5, class: "bar-delete", tabindex: "0" });
    add.append(svg("title", {}, `${item.label} 新增 ${number(item.additions)} 行`));
    del.append(svg("title", {}, `${item.label} 删除 ${number(item.deletions)} 行`));
    root.append(add, del);
    if (index % labelStep === 0 || index === data.length - 1) root.append(svg("text", { x: xx + barW / 2, y: height - 10, "text-anchor": "middle", class: "chart-axis-text" }, date(item.label)));
  });
  container.replaceChildren(root);
}

export function renderHeatmap(container, raw = [], from, to) {
  const countByDate = new Map(raw.map((item) => [String(item.date).slice(0, 10), Number(item.count ?? item.commits ?? 0)]));
  const start = new Date(`${from}T00:00:00`), end = new Date(`${to}T00:00:00`);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
    container.innerHTML = stateMarkup("empty", "暂无活跃数据", "日期范围无效"); return;
  }
  const aligned = new Date(start); aligned.setDate(aligned.getDate() - ((aligned.getDay() + 6) % 7));
  const days = [];
  for (const cursor = new Date(aligned); cursor <= end; cursor.setDate(cursor.getDate() + 1)) {
    const key = `${cursor.getFullYear()}-${String(cursor.getMonth() + 1).padStart(2, "0")}-${String(cursor.getDate()).padStart(2, "0")}`;
    days.push({ date: key, count: countByDate.get(key) || 0, inRange: cursor >= start });
  }
  const max = Math.max(1, ...days.map((item) => item.count));
  const weeks = Math.ceil(days.length / 7), cell = 13, gap = 3, left = 34, top = 22;
  const width = left + weeks * (cell + gap) + 8, height = top + 7 * (cell + gap) + 5;
  const root = svg("svg", { width, height, viewBox: `0 0 ${width} ${height}`, role: "img", "aria-label": "按日统计的提交活跃热力图" });
  [[0, "一"], [2, "三"], [4, "五"], [6, "日"]].forEach(([row, label]) => root.append(svg("text", { x: 20, y: top + row * (cell + gap) + 10, "text-anchor": "end", class: "chart-axis-text" }, label)));
  let previousMonth = "";
  days.forEach((item, index) => {
    const week = Math.floor(index / 7), row = index % 7;
    const ratio = item.count / max;
    const level = !item.count ? 0 : ratio <= .25 ? 1 : ratio <= .5 ? 2 : ratio <= .75 ? 3 : 4;
    const rect = svg("rect", { x: left + week * (cell + gap), y: top + row * (cell + gap), width: cell, height: cell, rx: 2, class: `heat-cell heat-level-${level}`, opacity: item.inRange ? "1" : ".35", tabindex: item.inRange ? "0" : "-1", role: "img", "aria-label": `${item.date}，${item.count} 次提交` });
    rect.append(svg("title", {}, `${item.date} · ${number(item.count)} 次提交`)); root.append(rect);
    if (row === 0) {
      const month = item.date.slice(0, 7);
      if (month !== previousMonth) { root.append(svg("text", { x: left + week * (cell + gap), y: 10, class: "chart-axis-text" }, `${Number(month.slice(5))} 月`)); previousMonth = month; }
    }
  });
  container.replaceChildren(root);
}
