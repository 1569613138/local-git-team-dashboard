const JSON_HEADERS = { Accept: "application/json" };

async function request(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { ...JSON_HEADERS, ...(options.headers || {}) },
  });
  const text = await response.text();
  let payload = null;
  if (text) {
    try { payload = JSON.parse(text); }
    catch { payload = { message: text }; }
  }
  if (!response.ok) {
    const error = new Error(payload?.message || payload?.error || `请求失败（${response.status}）`);
    error.status = response.status;
    error.payload = payload;
    throw error;
  }
  return payload;
}

export const getMeta = ({ signal } = {}) => request("/api/meta", { signal });

export const getIdentities = ({ signal } = {}) => request("/api/identities", { signal });

export const getStats = (filters, { signal } = {}) => {
  const params = new URLSearchParams();
  params.set("from", filters.from);
  params.set("to", filters.to);
  params.set("branch", filters.branch);
  params.set("scope", filters.scope);
  params.set("granularity", filters.granularity);
  filters.repositories.forEach((value) => params.append("repo", value));
  filters.members.forEach((value) => params.append("member", value));
  return request(`/api/stats?${params.toString()}`, { signal });
};

export const refreshStats = (filters, { signal } = {}) => request("/api/refresh", {
  method: "POST",
  signal,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    from: filters.from,
    to: filters.to,
    repositories: filters.repositories,
    branch: filters.branch,
    scope: filters.scope,
    members: filters.members,
    granularity: filters.granularity,
  }),
});

export const getJob = (jobId, { signal } = {}) => request(`/api/jobs/${encodeURIComponent(jobId)}`, { signal });
