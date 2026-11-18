import { getIdentities, getJob, getMeta, getStats, refreshStats } from "./api.js";
import { createStore, defaultFilters, filtersFromUrl, normalizeFilters, selectPeriod, setPeriodSelection, shiftPeriod, syncUrl } from "./state.js";
import { clearNotice, renderAnomalies, renderDashboard, renderError, renderLoading, renderMeta, renderPartialFailures, renderQuality, renderRefresh } from "./render.js";
import { escapeHtml } from "./format.js";

const $ = (id) => document.getElementById(id);
const elements = {
  syncDot: $("syncDot"), syncText: $("syncText"), updatedAt: $("updatedAt"), qualityButton: $("qualityButton"), qualityBadge: $("qualityBadge"), refreshButton: $("refreshButton"),
  periodControl: $("periodControl"), periodPrev: $("periodPrev"), periodNext: $("periodNext"), periodDay: $("periodDay"), periodMonth: $("periodMonth"), periodQuarter: $("periodQuarter"), quarterYear: $("quarterYear"), quarterNumber: $("quarterNumber"), periodYear: $("periodYear"),
  repoSelect: $("repoSelect"), branchSelect: $("branchSelect"), branchFilter: $("branchFilter"), branchFilterPanel: $("branchFilterPanel"), branchFilterLabel: $("branchFilterLabel"), branchSearch: $("branchSearch"), branchOptions: $("branchOptions"), memberFilter: $("memberFilter"), memberFilterLabel: $("memberFilterLabel"), memberSearch: $("memberSearch"), clearMembers: $("clearMembers"), memberOptions: $("memberOptions"), resetFilters: $("resetFilters"), sortSelect: $("sortSelect"), sortDirection: $("sortDirection"),
  globalNotice: $("globalNotice"), rangeSummary: $("rangeSummary"), metricGrid: $("metricGrid"), dailyTrendChart: $("dailyTrendChart"), dailyPeakSummary: $("dailyPeakSummary"), rankingTable: $("rankingTable"), memberCount: $("memberCount"),
  drawerBackdrop: $("drawerBackdrop"), qualityDrawer: $("qualityDrawer"), drawerKicker: $("drawerKicker"), drawerTitle: $("drawerTitle"), closeDrawer: $("closeDrawer"), qualityContent: $("qualityContent"),
  refreshPanel: $("refreshPanel"), refreshStatus: $("refreshStatus"), refreshPercent: $("refreshPercent"), refreshBar: $("refreshBar"), refreshRepos: $("refreshRepos"),
};

const store = createStore();
let statsController = null;
let pollController = null;
let filterTimer = 0;
let drawerReturnFocus = null;

function positionBranchPanel() {
  const summary = elements.branchFilter.querySelector("summary");
  if (!summary) return;
  const rect = summary.getBoundingClientRect();
  const width = Math.min(390, window.innerWidth - 24);
  const left = Math.min(Math.max(12, rect.left), window.innerWidth - width - 12);
  elements.branchFilterPanel.style.setProperty("--popover-top", `${rect.bottom + 7}px`);
  elements.branchFilterPanel.style.setProperty("--popover-left", `${left}px`);
  elements.branchFilterPanel.style.setProperty("--popover-width", `${width}px`);
}

function closeBranchPanel({ restoreFocus = false } = {}) {
  if (elements.branchFilterPanel.matches(":popover-open")) elements.branchFilterPanel.hidePopover();
  elements.branchFilter.open = false;
  elements.branchSearch.value = "";
  if (restoreFocus) elements.branchFilter.querySelector("summary")?.focus();
}

function openBranchPanel() {
  elements.memberFilter.open = false;
  renderBranchOptions(store.get());
  positionBranchPanel();
  if (!elements.branchFilterPanel.matches(":popover-open")) elements.branchFilterPanel.showPopover();
  window.requestAnimationFrame(() => elements.branchSearch.focus());
}

function repositoriesFrom(meta) {
  return meta?.repositories || meta?.repos || [];
}

function optionLabel(item) {
  return String(item.displayName ?? item.name ?? item.label ?? item.id ?? item);
}

function fillRepositorySelect(items, values) {
  const selected = values[0] || "";
  const options = [{ id: "", name: "全部仓库" }, ...items];
  const fragment = document.createDocumentFragment();
  for (const item of options) {
    const option = document.createElement("option");
    option.value = String(item.id ?? "");
    option.textContent = optionLabel(item);
    option.selected = option.value === selected;
    fragment.append(option);
  }
  elements.repoSelect.replaceChildren(fragment);
}

function selectedRepositoryMeta(state) {
  const repositories = repositoriesFrom(state.meta);
  return state.filters.repositories.length === 1
    ? repositories.find(({ id }) => id === state.filters.repositories[0])
    : null;
}

function branchOptions(state) {
  const repositories = repositoriesFrom(state.meta);
  const selected = selectedRepositoryMeta(state);
  const sources = selected ? [selected] : repositories;
  const seen = new Set();
  const branches = [];
  for (const repository of sources) {
    for (const branch of repository.branches || []) {
      if (!branch?.ref || seen.has(branch.ref)) continue;
      seen.add(branch.ref);
      branches.push(branch);
    }
  }
  return branches.sort((left, right) => optionLabel(left).localeCompare(optionLabel(right)));
}

function branchLabel(branch) {
  if (branch === "default") return "默认分支";
  if (branch === "all") return "全部分支";
  return String(branch || "").replace(/^refs\/(?:heads|remotes\/origin)\//u, "").replace(/^origin\//u, "");
}

function renderBranchOptions(state, search = elements.branchSearch?.value || "") {
  const query = search.trim().toLocaleLowerCase("zh-CN");
  const options = [
    { value: "default", label: "默认分支", hint: "仓库主分支" },
    { value: "all", label: "全部分支", hint: "统计所有远程分支" },
    ...branchOptions(state).map((branch) => ({
      value: branch.ref,
      label: branchLabel(optionLabel(branch)),
      hint: branch.ref,
    })),
  ].filter((item) => !query || `${item.label} ${item.hint}`.toLocaleLowerCase("zh-CN").includes(query));
  elements.branchOptions.innerHTML = options.map((item) => `<button class="branch-option ${state.filters.branch === item.value ? "is-selected" : ""}" type="button" role="option" aria-selected="${state.filters.branch === item.value}" data-branch="${escapeHtml(item.value)}" title="${escapeHtml(item.hint)}"><span>${escapeHtml(item.label)}</span><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12 4 4L19 6"/></svg></button>`).join("") || '<p class="member-options-empty">没有匹配的分支</p>';
  elements.branchFilterLabel.textContent = branchLabel(state.filters.branch);
  elements.branchFilterLabel.title = branchLabel(state.filters.branch);
}

function fillBranchSelect(state) {
  const fragment = document.createDocumentFragment();
  const defaults = [
    { value: "default", label: "默认分支" },
    { value: "all", label: "全部分支" },
  ];
  for (const item of defaults) {
    const option = document.createElement("option");
    option.value = item.value;
    option.textContent = item.label;
    fragment.append(option);
  }
  for (const branch of branchOptions(state)) {
    const option = document.createElement("option");
    option.value = branch.ref;
    option.textContent = branchLabel(optionLabel(branch));
    option.title = branch.ref;
    fragment.append(option);
  }
  elements.branchSelect.replaceChildren(fragment);
  const available = [...elements.branchSelect.options].some(({ value }) => value === state.filters.branch);
  elements.branchSelect.value = available ? state.filters.branch : "default";
  renderBranchOptions(state);
}

function identityOptions(identities) {
  const configured = identities?.members || [];
  return configured
    .map((item) => ({ ...item, name: item.displayName, configured: true }))
    .filter((item, index, values) => values.findIndex(({ id }) => id === item.id) === index)
    .sort((left, right) => String(left.name || left.displayName).localeCompare(String(right.name || right.displayName), "zh-CN"));
}

function renderMemberOptions(state, search = elements.memberSearch?.value || "") {
  const query = search.trim().toLocaleLowerCase("zh-CN");
  const selected = new Set(state.filters.members);
  const options = identityOptions(state.identities).filter((item) => {
    const text = `${item.name || item.displayName || ""} ${item.id || ""}`.toLocaleLowerCase("zh-CN");
    return !query || text.includes(query);
  });
  elements.memberOptions.innerHTML = options.map((item) => {
    const fullName = optionLabel(item);
    const match = /^(.*?)\s*[（(](\d+)[）)]$/u.exec(fullName);
    const name = match?.[1] || fullName;
    const employeeId = match?.[2] || item.id.replace(/^member-/u, "");
    return `<label class="member-option"><input type="checkbox" value="${escapeHtml(item.id)}" ${selected.has(item.id) ? "checked" : ""}><span class="member-option-text"><strong>${escapeHtml(name)}</strong><small>${escapeHtml(employeeId)}</small></span></label>`;
  }).join("") || '<p class="member-options-empty">没有匹配的工号或姓名</p>';
  const selectedNames = identityOptions(state.identities).filter(({ id }) => selected.has(id)).map(optionLabel);
  elements.memberFilterLabel.textContent = selectedNames.length === 0
    ? "全部工号"
    : selectedNames.length <= 2 ? selectedNames.join("、") : `已选 ${selectedNames.length} 人`;
}

function syncControls(state) {
  const { filters, meta } = state;
  elements.periodControl.querySelectorAll("button[data-period]").forEach((button) => {
    const active = button.dataset.period === filters.period;
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-pressed", String(active));
  });
  elements.periodDay.hidden = filters.period !== "day";
  elements.periodMonth.hidden = filters.period !== "month";
  elements.periodQuarter.hidden = filters.period !== "quarter";
  elements.periodYear.hidden = filters.period !== "year";
  elements.periodDay.value = filters.periodDate;
  elements.periodMonth.value = filters.periodMonth;
  elements.quarterYear.value = String(filters.periodYear);
  elements.quarterNumber.value = String(filters.periodQuarter);
  elements.periodYear.value = String(filters.periodYear);
  elements.sortSelect.value = filters.sort;
  if (meta) {
    fillRepositorySelect(repositoriesFrom(meta), filters.repositories);
    fillBranchSelect(state);
  }
  if (state.identities) renderMemberOptions(state);
  elements.sortDirection.querySelector("span").textContent = filters.direction === "desc" ? "从高到低" : "从低到高";
  elements.sortDirection.classList.toggle("is-ascending", filters.direction === "asc");
}

function currentFilters() {
  return normalizeFilters({
    ...store.get().filters,
    repositories: elements.repoSelect.value ? [elements.repoSelect.value] : [],
    branch: elements.branchSelect.value,
    scope: "group",
    sort: elements.sortSelect.value,
  });
}

function selectedRepositories() {
  const selected = currentFilters().repositories;
  return selected.length ? selected : repositoriesFrom(store.get().meta).map((repository) => repository.id);
}

async function loadStats({ push = false, silent = false } = {}) {
  const filters = currentFilters();
  syncUrl(filters, push ? "push" : "replace");
  statsController?.abort();
  statsController = new AbortController();
  const previous = store.get().stats;
  store.set({ filters, loading: true, error: null });
  clearNotice(elements);
  if (!previous && !silent) renderLoading(elements);
  try {
    const stats = await getStats(filters, { signal: statsController.signal });
    const failures = stats?.failures || stats?.partialFailures || [];
    store.set({ stats, loading: false, partialFailures: failures, error: null });
    renderDashboard(elements, store.get());
    renderQuality(elements, store.get());
    renderPartialFailures(elements, failures);
  } catch (error) {
    if (error.name === "AbortError") return;
    store.set({ loading: false, error });
    renderError(elements, error, Boolean(previous));
  } finally {
    renderMeta(elements, store.get());
  }
}

function scheduleLoad(push = true) {
  window.clearTimeout(filterTimer);
  filterTimer = window.setTimeout(() => loadStats({ push }), 120);
}

function applyFilters(filters, { reload = true, push = true } = {}) {
  store.set({ filters: normalizeFilters(filters) });
  syncControls(store.get());
  if (reload) scheduleLoad(push);
  else {
    syncUrl(store.get().filters, push ? "push" : "replace");
    renderDashboard(elements, store.get());
  }
}

async function initialize() {
  renderLoading(elements);
  syncControls(store.get());
  const controller = new AbortController();
  const [metaResult, identityResult] = await Promise.allSettled([getMeta({ signal: controller.signal }), getIdentities({ signal: controller.signal })]);
  const meta = metaResult.status === "fulfilled" ? metaResult.value : { repositories: [] };
  const identities = identityResult.status === "fulfilled" ? identityResult.value : [];
  const bootErrors = [metaResult, identityResult].filter((result) => result.status === "rejected");
  store.set({ meta, identities });
  syncControls(store.get());
  if (bootErrors.length) {
    elements.globalNotice.hidden = false;
    elements.globalNotice.className = "notice";
    elements.globalNotice.textContent = "部分元数据加载失败，统计数据仍可继续使用。";
  }
  const cacheMissing = repositoriesFrom(meta).length > 0 && Number(meta?.cache?.ready || 0) === 0;
  if (cacheMissing && sessionStorage.getItem("git-dashboard-auto-refresh") !== "1") {
    sessionStorage.setItem("git-dashboard-auto-refresh", "1");
    await beginRefresh();
    return;
  }
  await loadStats();
}

function statusTerminal(status) {
  return ["completed", "complete", "done", "failed", "error", "cancelled"].includes(String(status).toLowerCase());
}

async function pollJob(jobId) {
  pollController?.abort();
  pollController = new AbortController();
  try {
    while (true) {
      const job = await getJob(jobId, { signal: pollController.signal });
      store.set({ job });
      renderRefresh(elements, job);
      if (statusTerminal(job.status)) {
        const failures = job.failures || job.repositories?.filter((repo) => ["failed", "error"].includes(repo.status)) || [];
        store.set({ refreshing: false, partialFailures: failures });
        elements.refreshButton.disabled = false;
        renderMeta(elements, store.get());
        await loadStats({ silent: true });
        window.setTimeout(() => { if (!store.get().refreshing) renderRefresh(elements, null); }, 3200);
        return;
      }
      await new Promise((resolve) => window.setTimeout(resolve, 850));
    }
  } catch (error) {
    if (error.name === "AbortError") return;
    store.set({ refreshing: false, error });
    elements.refreshButton.disabled = false;
    renderMeta(elements, store.get());
    renderError(elements, error, true);
  }
}

async function beginRefresh() {
  if (store.get().refreshing) return;
  elements.refreshButton.disabled = true;
  store.set({ refreshing: true, error: null });
  renderMeta(elements, store.get());
  renderRefresh(elements, { progress: 0, message: "正在创建同步任务", repositories: repositoriesFrom(store.get().meta).map((repo) => ({ id: repo.id, name: optionLabel(repo), status: "pending" })) });
  try {
    const response = await refreshStats({ ...currentFilters(), repositories: selectedRepositories() });
    const jobId = response.jobId || response.id;
    if (!jobId) {
      store.set({ refreshing: false });
      elements.refreshButton.disabled = false;
      await loadStats({ silent: true });
      renderRefresh(elements, null);
      return;
    }
    await pollJob(jobId);
  } catch (error) {
    store.set({ refreshing: false, error });
    elements.refreshButton.disabled = false;
    renderMeta(elements, store.get());
    renderError(elements, error, true);
    renderRefresh(elements, null);
  }
}

function openDrawer() {
  drawerReturnFocus = document.activeElement;
  elements.drawerBackdrop.hidden = false;
  elements.qualityDrawer.classList.add("is-open");
  elements.qualityDrawer.setAttribute("aria-hidden", "false");
  document.body.style.overflow = "hidden";
  elements.closeDrawer.focus();
}

function closeDrawer() {
  elements.qualityDrawer.classList.remove("is-open");
  elements.qualityDrawer.setAttribute("aria-hidden", "true");
  elements.drawerBackdrop.hidden = true;
  document.body.style.overflow = "";
  drawerReturnFocus?.focus();
}

elements.periodControl.addEventListener("click", (event) => {
  const button = event.target.closest("button[data-period]");
  if (!button) return;
  applyFilters(selectPeriod(currentFilters(), button.dataset.period));
});

elements.periodPrev.addEventListener("click", () => applyFilters(shiftPeriod(currentFilters(), -1)));
elements.periodNext.addEventListener("click", () => applyFilters(shiftPeriod(currentFilters(), 1)));

elements.periodDay.addEventListener("change", () => applyFilters(setPeriodSelection(currentFilters(), { periodDate: elements.periodDay.value })));
elements.periodMonth.addEventListener("change", () => applyFilters(setPeriodSelection(currentFilters(), { periodMonth: elements.periodMonth.value })));
[elements.quarterYear, elements.quarterNumber].forEach((control) => control.addEventListener("change", () => applyFilters(setPeriodSelection(currentFilters(), { periodYear: Number(elements.quarterYear.value), periodQuarter: Number(elements.quarterNumber.value) }))));
elements.periodYear.addEventListener("change", () => applyFilters(setPeriodSelection(currentFilters(), { periodYear: Number(elements.periodYear.value) })));

elements.repoSelect.addEventListener("change", () => {
  const filters = currentFilters();
  const next = { ...filters, branch: "default" };
  applyFilters(next);
});
elements.branchSelect.addEventListener("change", () => applyFilters(currentFilters()));
elements.branchSearch.addEventListener("input", () => renderBranchOptions(store.get()));
elements.branchOptions.addEventListener("click", (event) => {
  const option = event.target.closest("button[data-branch]");
  if (!option) return;
  elements.branchSelect.value = option.dataset.branch;
  closeBranchPanel();
  applyFilters({ ...currentFilters(), branch: option.dataset.branch });
});
elements.branchFilter.addEventListener("toggle", () => {
  if (elements.branchFilter.open) openBranchPanel();
  else closeBranchPanel();
});
elements.branchFilterPanel.addEventListener("toggle", (event) => {
  if (event.newState === "closed") {
    elements.branchFilter.open = false;
    elements.branchSearch.value = "";
  }
});
window.addEventListener("resize", () => {
  if (elements.branchFilterPanel.matches(":popover-open")) positionBranchPanel();
});
window.addEventListener("scroll", () => {
  if (elements.branchFilterPanel.matches(":popover-open")) positionBranchPanel();
}, { passive: true });
elements.memberOptions.addEventListener("change", (event) => {
  if (!event.target.matches('input[type="checkbox"]')) return;
  const members = new Set(currentFilters().members);
  if (event.target.checked) members.add(event.target.value);
  else members.delete(event.target.value);
  applyFilters({ ...currentFilters(), members: [...members] });
});
elements.memberSearch.addEventListener("input", () => renderMemberOptions(store.get()));
elements.clearMembers.addEventListener("click", () => {
  elements.memberSearch.value = "";
  applyFilters({ ...currentFilters(), members: [] });
});
elements.memberFilter.addEventListener("toggle", () => {
  if (elements.memberFilter.open) {
    closeBranchPanel();
    window.requestAnimationFrame(() => elements.memberSearch.focus());
  }
});
elements.sortSelect.addEventListener("change", () => applyFilters({ ...currentFilters(), sort: elements.sortSelect.value }, { reload: false }));
elements.sortDirection.addEventListener("click", () => applyFilters({ ...currentFilters(), direction: currentFilters().direction === "desc" ? "asc" : "desc" }, { reload: false }));
elements.rankingTable.addEventListener("click", (event) => {
  const anomalyButton = event.target.closest("button[data-anomaly-member]");
  if (anomalyButton) {
    renderAnomalies(elements, store.get(), anomalyButton.dataset.anomalyMember);
    openDrawer();
    return;
  }
  const button = event.target.closest("button[data-sort]");
  if (!button) return;
  const current = currentFilters();
  const direction = current.sort === button.dataset.sort ? (current.direction === "desc" ? "asc" : "desc") : "desc";
  applyFilters({ ...current, sort: button.dataset.sort, direction }, { reload: false });
});

elements.resetFilters.addEventListener("click", () => applyFilters(defaultFilters()));
elements.refreshButton.addEventListener("click", beginRefresh);
elements.qualityButton.addEventListener("click", () => {
  renderQuality(elements, store.get());
  openDrawer();
});
elements.closeDrawer.addEventListener("click", closeDrawer);
elements.drawerBackdrop.addEventListener("click", closeDrawer);
document.addEventListener("pointerdown", (event) => {
  if (elements.memberFilter.open && !elements.memberFilter.contains(event.target)) elements.memberFilter.open = false;
});
window.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && elements.branchFilterPanel.matches(":popover-open")) closeBranchPanel({ restoreFocus: true });
  if (event.key === "Escape" && elements.memberFilter.open) {
    elements.memberFilter.open = false;
    elements.memberFilter.querySelector("summary")?.focus();
  }
  if (event.key === "Escape" && elements.qualityDrawer.classList.contains("is-open")) closeDrawer();
  if (event.key === "Tab" && elements.qualityDrawer.classList.contains("is-open")) {
    const focusable = [...elements.qualityDrawer.querySelectorAll('button, [href], input, select, [tabindex]:not([tabindex="-1"])')].filter((node) => !node.disabled);
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable.at(-1);
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  }
});
window.addEventListener("popstate", () => {
  store.set({ filters: filtersFromUrl() });
  syncControls(store.get());
  loadStats();
});
store.subscribe((state) => renderMeta(elements, state));

initialize();
