import { dateTime, escapeHtml, initials, number, percent, rangeText, signed } from "./format.js";
import { renderDailyContributionChart } from "./charts.js";

const ICONS = {
  additions: '<svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>',
  deletions: '<svg viewBox="0 0 24 24"><path d="M5 12h14"/></svg>',
  net: '<svg viewBox="0 0 24 24"><path d="m4 16 5-5 4 3 7-8"/><path d="M16 6h4v4"/></svg>',
  churn: '<svg viewBox="0 0 24 24"><path d="M4 7h16M4 12h11M4 17h16"/></svg>',
  commits: '<svg viewBox="0 0 24 24"><circle cx="6" cy="12" r="2"/><circle cx="18" cy="6" r="2"/><circle cx="18" cy="18" r="2"/><path d="M8 12h3a4 4 0 0 0 4-4V6M8 12h3a4 4 0 0 1 4 4v2"/></svg>',
  members: '<svg viewBox="0 0 24 24"><circle cx="9" cy="8" r="3"/><path d="M3.5 19a5.5 5.5 0 0 1 11 0M16 5.5a3 3 0 0 1 0 5.5M17 14a5 5 0 0 1 3.5 5"/></svg>',
};

const SORT_LABELS = {
  additions: "新增行",
  deletions: "删除行",
  netLines: "净增行",
  churn: "变更总量",
  commits: "有效提交",
  merges: "Merge",
  activeDays: "活跃天数",
  averageChurn: "平均变更/提交",
  name: "成员",
};

function empty(title, detail) {
  return `<div class="empty-state"><strong class="state-title">${escapeHtml(title)}</strong><span class="state-detail">${escapeHtml(detail)}</span></div>`;
}

function getSummary(stats = {}) {
  return stats.summary || stats.metrics || stats.totals || {};
}

function metricCards(stats) {
  const s = getSummary(stats);
  const additions = Number(s.additions || 0);
  const deletions = Number(s.deletions || 0);
  const commits = Number(s.commits || 0);
  const merges = Number(s.merges || 0);
  const churn = Number(s.churn ?? additions + deletions);
  return [
    ["新增代码", `+${number(additions)}`, "Git numstat 新增文本行", "additions", "is-add"],
    ["删除代码", `−${number(deletions)}`, "Git numstat 删除文本行", "deletions", "is-delete"],
    ["净增代码", signed(additions - deletions), "新增行 − 删除行", "net", additions >= deletions ? "is-add" : "is-delete"],
    ["变更总量", number(churn), "新增行 + 删除行", "churn", ""],
    ["有效提交", number(commits), `另有 ${number(merges)} 次 Merge`, "commits", ""],
    ["参与人数", number(s.activeMembers || 0), `${number(s.activeDays || 0)} 个活跃日`, "members", ""],
  ];
}

export function renderLoading(elements) {
  elements.metricGrid.innerHTML = Array.from({ length: 6 }, (_, index) => `<article class="metric-card is-loading"><div class="metric-label">加载指标 ${index + 1}</div><div class="metric-value skeleton">0</div><div class="metric-sub skeleton">加载中</div></article>`).join("");
  elements.dailyTrendChart.innerHTML = '<div class="loading-state trend-state"><span class="state-title">正在生成每日趋势</span><span class="state-detail">正在汇总每日提交次数与代码变更量</span></div>';
  elements.dailyPeakSummary.textContent = "正在识别集中提交峰值";
  elements.rankingTable.innerHTML = '<div class="loading-state"><span class="state-title">正在统计个人贡献</span><span class="state-detail">正在汇总每个人的新增、删除和提交次数</span></div>';
}

function renderMetrics(container, stats) {
  container.innerHTML = metricCards(stats).map(([label, value, sub, icon, className]) => `<article class="metric-card ${className}"><div class="metric-label"><span>${label}</span><span class="metric-icon" aria-hidden="true">${ICONS[icon]}</span></div><div class="metric-value">${value}</div><div class="metric-sub">${sub}</div></article>`).join("");
}

function members(stats) {
  return stats.members || stats.contributors || [];
}

function enrichMember(item) {
  const additions = Number(item.additions || 0);
  const deletions = Number(item.deletions || 0);
  const commits = Number(item.commits || 0);
  return {
    ...item,
    additions,
    deletions,
    commits,
    merges: Number(item.merges || 0),
    activeDays: Number(item.activeDays || 0),
    anomalyCommits: Number(item.anomalyCommits || 0),
    churn: Number(item.churn ?? additions + deletions),
    netLines: additions - deletions,
    averageChurn: commits ? Math.round((additions + deletions) / commits) : 0,
    name: item.displayName || item.name || item.author || "未识别成员",
  };
}

export function sortMembers(items, sort = "additions", direction = "desc") {
  const multiplier = direction === "asc" ? 1 : -1;
  return items.map(enrichMember).sort((left, right) => {
    if (sort === "name") return multiplier * left.name.localeCompare(right.name, "zh-CN");
    const delta = Number(left[sort] || 0) - Number(right[sort] || 0);
    return delta ? multiplier * delta : left.name.localeCompare(right.name, "zh-CN");
  });
}

function sortButton(key, label, filters) {
  const active = filters.sort === key;
  const arrow = active ? (filters.direction === "desc" ? "↓" : "↑") : "↕";
  const sortState = active ? (filters.direction === "desc" ? "descending" : "ascending") : "none";
  return `<th scope="col" aria-sort="${sortState}"><button class="table-sort ${active ? "is-active" : ""}" type="button" data-sort="${key}">${label}<span aria-hidden="true">${arrow}</span></button></th>`;
}

function renderRankingTable(container, items, filters) {
  if (!items.length) {
    container.innerHTML = empty("这个周期没有提交数据", "可切换月份、季度、年份、分支或工号查看其他统计结果");
    return;
  }
  const sorted = sortMembers(items, filters.sort, filters.direction);
  container.innerHTML = `<table><thead><tr>
    <th scope="col" class="rank-column">排名</th>
    ${sortButton("name", "成员", filters)}
    ${sortButton("additions", "新增行", filters)}
    ${sortButton("deletions", "删除行", filters)}
    ${sortButton("netLines", "净增行", filters)}
    ${sortButton("churn", "变更总量", filters)}
    ${sortButton("commits", "有效提交", filters)}
    ${sortButton("merges", "Merge", filters)}
    ${sortButton("activeDays", "活跃天数", filters)}
    ${sortButton("averageChurn", "平均变更/提交", filters)}
    <th scope="col">异常提交</th>
    <th scope="col">最近提交</th>
  </tr></thead><tbody>${sorted.map((item, index) => {
    const rank = index + 1;
    const rankClass = rank <= 3 ? ` is-top-${rank}` : "";
    const [displayName, employeeId = ""] = item.name.split(/[（(]/u);
    const cleanEmployeeId = employeeId.replace(/[）)]/gu, "");
    return `<tr>
      <td class="rank-cell${rankClass}"><span>${rank}</span></td>
      <td><span class="name-cell"><span class="avatar" aria-hidden="true">${escapeHtml(initials(displayName))}</span><span><span class="cell-primary" title="${escapeHtml(item.name)}">${escapeHtml(displayName)}</span><span class="cell-secondary">${escapeHtml(cleanEmployeeId || "已配置成员")}</span></span></span></td>
      <td class="number-cell metric-add">+${number(item.additions)}</td>
      <td class="number-cell metric-delete">−${number(item.deletions)}</td>
      <td class="number-cell ${item.netLines >= 0 ? "metric-add" : "metric-delete"}">${signed(item.netLines)}</td>
      <td class="number-cell metric-strong">${number(item.churn)}</td>
      <td class="number-cell metric-strong">${number(item.commits)}</td>
      <td class="number-cell">${number(item.merges)}</td>
      <td class="number-cell">${number(item.activeDays)}</td>
      <td class="number-cell">${number(item.averageChurn)}</td>
      <td class="number-cell">${item.anomalyCommits > 0 ? `<button class="anomaly-badge" type="button" data-anomaly-member="${escapeHtml(item.id)}" aria-label="查看 ${escapeHtml(displayName)} 的 ${number(item.anomalyCommits)} 个异常提交">待复核 ${number(item.anomalyCommits)}</button>` : '<span class="anomaly-normal">正常</span>'}</td>
      <td class="number-cell recent-date">${escapeHtml(item.lastActive || "--")}</td>
    </tr>`;
  }).join("")}</tbody></table>`;
}

export function renderDashboard(elements, state) {
  const { stats, filters } = state;
  const branchName = filters.branch === "default"
    ? "默认分支"
    : filters.branch === "all" ? "全部分支" : filters.branch.replace(/^refs\/(?:heads|remotes\/origin)\//u, "");
  elements.rangeSummary.textContent = `${rangeText(filters)} · ${branchName}${filters.members.length ? ` · ${filters.members.length} 个工号` : ""}`;
  if (!stats) return;
  renderMetrics(elements.metricGrid, stats);
  const dailyTrend = renderDailyContributionChart(elements.dailyTrendChart, stats.activity || []);
  elements.dailyPeakSummary.textContent = dailyTrend.peakCount > 0
    ? `发现 ${number(dailyTrend.peakCount)} 个集中提交峰值，悬停或聚焦标记查看原因`
    : "当前筛选范围未发现集中提交峰值";
  const memberItems = members(stats);
  renderRankingTable(elements.rankingTable, memberItems, filters);
  elements.memberCount.textContent = `共 ${number(memberItems.length)} 位作者 · 当前按${SORT_LABELS[filters.sort] || "新增行"}${filters.direction === "desc" ? "从高到低" : "从低到高"}排列`;
  elements.sortSelect.value = filters.sort;
  elements.sortDirection.querySelector("span").textContent = filters.direction === "desc" ? "从高到低" : "从低到高";
  elements.sortDirection.classList.toggle("is-ascending", filters.direction === "asc");
}

export function renderError(elements, error, hasOldData) {
  elements.globalNotice.hidden = false;
  elements.globalNotice.className = "notice is-error";
  elements.globalNotice.textContent = hasOldData ? `新数据加载失败，已保留上次结果：${error.message}` : `数据加载失败：${error.message}`;
  if (!hasOldData) {
    elements.dailyTrendChart.innerHTML = `<div class="error-state trend-state"><strong class="state-title">无法加载趋势数据</strong><span class="state-detail">${escapeHtml(error.message)}</span></div>`;
    elements.dailyPeakSummary.textContent = "趋势数据加载失败";
    elements.rankingTable.innerHTML = `<div class="error-state"><strong class="state-title">无法加载数据</strong><span class="state-detail">${escapeHtml(error.message)}</span></div>`;
  }
}

export function clearNotice(elements) {
  elements.globalNotice.hidden = true;
  elements.globalNotice.textContent = "";
}

export function renderPartialFailures(elements, failures = []) {
  if (!failures.length) return;
  elements.globalNotice.hidden = false;
  elements.globalNotice.className = "notice";
  elements.globalNotice.textContent = `${failures.length} 个仓库更新失败，当前结果为部分数据：${failures.map((item) => item.name || item.repository || item.message).join("、")}`;
}

export function renderAnomalies(elements, state, memberId) {
  const anomalies = (state.stats?.anomalies || []).filter((item) => !memberId || item.memberId === memberId);
  const member = members(state.stats).find((item) => item.id === memberId);
  elements.drawerKicker.textContent = "ANOMALY REVIEW";
  elements.drawerTitle.textContent = member ? `${member.displayName || member.name} · 异常提交` : "异常提交";
  const ruleLabels = {
    LARGE_CHURN: "变更总量过大",
    LARGE_ADDITIONS: "新增行数过大",
    LARGE_DELETIONS: "删除行数过大",
    MANY_FILES: "修改文件过多",
  };
  elements.qualityContent.innerHTML = `<div class="anomaly-intro"><strong>${number(anomalies.length)} 个提交待复核</strong><p>仅增加标记，不扣除行数，不改变原排行榜、统计口径和排序结果。</p></div>
    <section class="quality-section"><h3>触发规则</h3><ul class="quality-list">
      <li class="quality-item"><i></i><p>单次变更总量 ≥ 2,000 行</p><strong>变更量</strong></li>
      <li class="quality-item"><i></i><p>单次新增或删除 ≥ 1,500 行</p><strong>行数</strong></li>
      <li class="quality-item"><i></i><p>单次有效文本文件 ≥ 50 个</p><strong>文件数</strong></li>
    </ul></section>
    <section class="quality-section"><h3>提交明细</h3><div class="anomaly-list">${anomalies.map((item) => `<article class="anomaly-item">
      <div class="anomaly-item-head"><strong>${escapeHtml(item.repositoryName)}</strong><code>${escapeHtml(item.shortOid || String(item.oid).slice(0, 8))}</code></div>
      <div class="anomaly-meta"><span>${escapeHtml(item.date)}</span><span>+${number(item.additions)}</span><span>−${number(item.deletions)}</span><span>${number(item.filesChanged)} 个文件</span></div>
      <div class="anomaly-reasons">${(item.rules || []).map((rule) => `<span title="阈值 ${number(rule.threshold)}">${escapeHtml(ruleLabels[rule.code] || rule.code)} · ${number(rule.value)}</span>`).join("")}</div>
    </article>`).join("") || '<div class="empty-anomaly">当前筛选范围没有异常提交</div>'}</div></section>`;
}

export function renderQuality(elements, state) {
  elements.drawerKicker.textContent = "DATA GOVERNANCE";
  elements.drawerTitle.textContent = "数据质量";
  const quality = state.stats?.quality || state.meta?.quality || {};
  const failures = state.partialFailures || [];
  const issues = quality.issues || [];
  const unmatched = quality.unmatchedIdentities || quality.unmatched || [];
  const score = Math.max(0, Math.min(100, Number(quality.score ?? (failures.length ? 86 : issues.length ? 92 : 100))));
  elements.qualityBadge.textContent = number(issues.length + unmatched.length + failures.length);
  elements.qualityContent.innerHTML = `<div class="quality-score"><div class="score-ring" style="--score:${score}"><strong>${score}</strong></div><div><strong>质量评分</strong><p>依据身份映射、仓库采集状态与提交完整性综合计算。</p></div></div>
    <section class="quality-section"><h3>采集概况</h3><ul class="quality-list">
      <li class="quality-item is-good"><i></i><p>最近一次成功聚合</p><strong>${dateTime(state.stats?.generatedAt || state.meta?.updatedAt)}</strong></li>
      <li class="quality-item ${failures.length ? "is-bad" : "is-good"}"><i></i><p>仓库采集失败</p><strong>${failures.length}</strong></li>
      <li class="quality-item ${unmatched.length ? "" : "is-good"}"><i></i><p>未配置作者</p><strong>${unmatched.length}</strong></li>
    </ul></section>
    <section class="quality-section"><h3>统计口径</h3><ul class="quality-list">
      <li class="quality-item is-good"><i></i><p>新增/删除行来自 Git numstat；Merge 不重复计算代码行。</p><strong>正常</strong></li>
      <li class="quality-item is-good"><i></i><p>二进制、构建产物和 lockfile 不计入行数。</p><strong>${number(quality.excludedFiles || 0)} 个排除</strong></li>
    </ul></section>
    <section class="quality-section"><h3>待处理项</h3><ul class="quality-list">${[...issues, ...unmatched.map((item) => ({ message: `未配置作者：${item.authorName || item.name || item.id}` })), ...failures.map((item) => ({ message: `${item.name || item.repository || "仓库"}：${item.message || "采集失败"}`, level: "bad" }))].map((item) => `<li class="quality-item ${item.level === "bad" ? "is-bad" : ""}"><i></i><p>${escapeHtml(item.message || item.description || item)}</p><strong>${escapeHtml(item.code || "待处理")}</strong></li>`).join("") || '<li class="quality-item is-good"><i></i><p>未发现需要处理的数据问题</p><strong>正常</strong></li>'}</ul></section>`;
}

export function renderMeta(elements, state) {
  const updated = state.stats?.generatedAt || state.meta?.updatedAt || state.meta?.generatedAt;
  const repositories = state.meta?.repositories || [];
  const remote = repositories.find((repository) => repository.source === "gitea");
  const sourceLabel = remote ? `Gitea · ${remote.remoteHost}` : "本地 Git";
  elements.updatedAt.textContent = updated ? `更新于 ${dateTime(updated)}` : "";
  elements.syncText.textContent = state.refreshing ? `正在同步 ${sourceLabel}` : state.error ? `${sourceLabel} 连接异常` : `${sourceLabel} 已同步`;
  elements.syncDot.className = `status-dot ${state.error ? "is-error" : !state.loading ? "is-ok" : ""}`;
}

export function renderRefresh(elements, job) {
  if (!job) { elements.refreshPanel.hidden = true; return; }
  elements.refreshPanel.hidden = false;
  const repos = job.repositories || job.repos || [];
  const total = Number(job.total ?? repos.length ?? 0);
  const completed = Number(job.completed ?? repos.filter((item) => ["completed", "failed", "done", "error"].includes(item.status)).length);
  const progress = Math.max(0, Math.min(100, Number(job.progress ?? (total ? completed / total * 100 : 0))));
  elements.refreshPercent.textContent = `${Math.round(progress)}%`;
  elements.refreshBar.style.transform = `scaleX(${progress / 100})`;
  elements.refreshStatus.textContent = job.message || `${completed}/${total || "--"} 个仓库`;
  elements.refreshRepos.innerHTML = repos.map((repo) => {
    const status = repo.status || "pending";
    const label = ["completed", "done"].includes(status) ? "已完成" : ["failed", "error"].includes(status) ? "失败" : ["running", "syncing", "scanning", "writing"].includes(status) ? "同步中" : "等待中";
    return `<div class="refresh-repo ${["completed", "done"].includes(status) ? "is-done" : ["failed", "error"].includes(status) ? "is-error" : ""}"><span>${escapeHtml(repo.name || repo.repository)}</span><span>${label}</span></div>`;
  }).join("");
}
