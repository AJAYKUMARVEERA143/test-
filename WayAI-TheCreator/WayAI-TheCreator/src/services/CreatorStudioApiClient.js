/**
 * CreatorStudioApiClient — thin fetch wrapper around way-ai-server's
 * /api/creator/projects and /api/creator/assets routes (Phase A of the
 * Creator Studio reconstruction). Same auth-token resolution and API_BASE
 * logic as WayIllustrateAdapter.js so authentication "just works" identically
 * to every other way-ai-server call this app already makes.
 */

const API_BASE = (() => {
  if (typeof import.meta !== "undefined" && import.meta.env?.VITE_AUTH_API_URL) {
    return String(import.meta.env.VITE_AUTH_API_URL).replace(/\/+$/, "");
  }
  if (typeof import.meta !== "undefined" && import.meta.env?.VITE_API_URL) {
    return String(import.meta.env.VITE_API_URL).replace(/\/+$/, "");
  }
  if (typeof window !== "undefined") {
    const host = window.location?.hostname || "";
    if (host.includes("wayaicode.com")) return "https://api.wayaicode.com";
    if (host.includes("interioway.com")) return "https://api.interioway.com";
  }
  return "http://localhost:3001";
})();

function getToken() {
  if (typeof localStorage === "undefined") return "";
  const keys = ["way-auth-token", "wayai_auth_token", "way-auth", "way_token", "wayai_session"];
  for (const key of keys) {
    try {
      const value = localStorage.getItem(key);
      if (!value) continue;
      if (value.trim().startsWith("{")) {
        const parsed = JSON.parse(value);
        if (parsed?.token) return parsed.token;
      } else {
        return value;
      }
    } catch {}
  }
  return "";
}

async function request(path, { method = "GET", body } = {}) {
  const token = getToken();
  // The hosting firewall drops PATCH/PUT/DELETE before they reach the app, so
  // the browser only ever saw "Failed to fetch" (deleting a Creator asset never
  // worked online). The server exposes POST aliases for both.
  let url = path;
  let verb = method;
  if (method === "DELETE") { verb = "POST"; url = `${path}/delete`; }
  if (method === "PATCH" || method === "PUT") { verb = "POST"; url = `${path}/update`; }

  let res;
  try {
    res = await fetch(`${API_BASE}/api/creator${url}`, {
      method: verb,
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch (networkError) {
    throw new Error(`Cannot reach the Creator Studio service. ${String(networkError?.message || networkError)}`);
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error || `Creator Studio request failed (HTTP ${res.status})`);
  return data;
}

// Projects
export const listProjects = (params = {}) => {
  const qs = params.limit ? `?limit=${encodeURIComponent(params.limit)}` : "";
  return request(`/projects${qs}`).then((d) => d.projects);
};
export const createProject = (payload) => request("/projects", { method: "POST", body: payload }).then((d) => d.project);
export const getProject = (id) => request(`/projects/${id}`);
export const updateProject = (id, payload) => request(`/projects/${id}`, { method: "PATCH", body: payload }).then((d) => d.project);
export const deleteProject = (id) => request(`/projects/${id}`, { method: "DELETE" });

// Episodes
export const listEpisodes = (projectId) => request(`/projects/${projectId}/episodes`).then((d) => d.episodes);
export const createEpisode = (projectId, payload) => request(`/projects/${projectId}/episodes`, { method: "POST", body: payload }).then((d) => d.episode);
export const updateEpisode = (projectId, episodeId, payload) =>
  request(`/projects/${projectId}/episodes/${episodeId}`, { method: "PATCH", body: payload }).then((d) => d.episode);

// Assets — omit projectId for the global cross-project library
export const listAssets = (params = {}) => {
  const query = new URLSearchParams();
  if (params.projectId) query.set("projectId", params.projectId);
  if (params.assetType) query.set("assetType", params.assetType);
  if (params.limit) query.set("limit", params.limit);
  const qs = query.toString();
  return request(`/assets${qs ? `?${qs}` : ""}`).then((d) => d.assets);
};
export const createAsset = (payload) => request("/assets", { method: "POST", body: payload }).then((d) => d.asset);
export const getAsset = (id) => request(`/assets/${id}`).then((d) => d.asset);
export const updateAsset = (id, payload) => request(`/assets/${id}`, { method: "PATCH", body: payload }).then((d) => d.asset);
export const deleteAsset = (id) => request(`/assets/${id}`, { method: "DELETE" });

// Generation tasks
export const createTask = (payload) => request("/tasks", { method: "POST", body: payload }).then((d) => d.task);
export const getTask = (id) => request(`/tasks/${id}`).then((d) => d.task);
export const listTasks = (projectId, params = {}) => {
  const query = new URLSearchParams({ projectId });
  if (params.sinceId) query.set("sinceId", params.sinceId);
  if (params.status) query.set("status", params.status);
  return request(`/tasks?${query.toString()}`).then((d) => d.tasks);
};
export const cancelTask = (id) => request(`/tasks/${id}/cancel`, { method: "POST" });
export const completeTask = (id, payload) => request(`/tasks/${id}/complete`, { method: "POST", body: payload }).then((d) => d.task);
export const failTask = (id, payload) => request(`/tasks/${id}/fail`, { method: "POST", body: payload }).then((d) => d.task);

// Uploads — multipart, so this bypasses the JSON request() helper entirely.
export async function uploadFiles(files) {
  const token = getToken();
  const form = new FormData();
  for (const file of files) form.append("files", file);
  const res = await fetch(`${API_BASE}/api/creator/uploads`, {
    method: "POST",
    headers: token ? { Authorization: `Bearer ${token}` } : undefined,
    body: form,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error || `Upload failed (HTTP ${res.status})`);
  return data.files;
}

// Resolves a relative storage path (as returned by uploadFiles) into a
// fetchable, authenticated media URL for use in <img>/<video> tags — callers
// must append the auth token themselves if the tag can't send headers; for
// <img> this app fetches-and-blobs rather than setting src directly.
export function mediaUrl(relPath) {
  return `${API_BASE}/api/creator/media/${encodeURI(relPath)}`;
}

// Version history
export const recordVersion = (payload) => request("/versions", { method: "POST", body: payload }).then((d) => d.version);
export const listVersions = (resourceType, resourceId) =>
  request(`/versions?${new URLSearchParams({ resourceType, resourceId }).toString()}`).then((d) => d.versions);

// Cost estimate/rollup
export const estimateCost = (params) => request(`/costs/estimate?${new URLSearchParams(params).toString()}`);
export const getCostRollup = (params = {}) => {
  const query = new URLSearchParams();
  if (params.projectId) query.set("projectId", params.projectId);
  if (params.isEstimate !== undefined) query.set("isEstimate", String(params.isEstimate));
  const qs = query.toString();
  return request(`/costs/rollup${qs ? `?${qs}` : ""}`).then((d) => d.rollup);
};

// Narration pipeline (Phase F1) — splits sourceText into segments and a
// storyboard scaffold, persisted onto the episode's script_json server-side.
export const runNarrationPipeline = (payload) => request("/pipeline/narration", { method: "POST", body: payload });

// CapCut draft export — fetches the zip with the auth header (a plain <a href>
// download can't attach one) and triggers a browser download directly.
export async function downloadCapCutDraft(projectId, episodeId, filename = "capcut-draft.zip") {
  const token = getToken();
  const res = await fetch(`${API_BASE}/api/creator/export/capcut/${projectId}/${episodeId}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : undefined,
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data?.error || `Export failed (HTTP ${res.status})`);
  }
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

export async function fetchMediaBlobUrl(relPath) {
  const token = getToken();
  const res = await fetch(mediaUrl(relPath), {
    headers: token ? { Authorization: `Bearer ${token}` } : undefined,
  });
  if (!res.ok) throw new Error(`Failed to load media (HTTP ${res.status})`);
  const blob = await res.blob();
  return URL.createObjectURL(blob);
}
