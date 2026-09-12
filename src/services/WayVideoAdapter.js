/**
 * WayVideoAdapter — swappable video-generation backend for Creator Studio.
 * Same two-path shape as WayIllustrateAdapter.js:
 *
 *  1. BYOK — if the user has their own Gemini key (AccountManager, "video-generation"
 *     capability), submit and poll Veo directly from the browser. No platform
 *     credits, no server round-trip, and no way-ai-server involvement at all.
 *  2. Managed — falls through to way-ai-server's Creator Studio task queue
 *     (POST /api/creator/tasks, task_type "video_clip"), which submits+polls
 *     Veo server-side using the platform's own GEMINI_API_KEY and records real
 *     cost. The frontend just polls the task's own status until it's done.
 *
 * Submission and polling are deliberately two separate exported functions
 * (not one blocking call) — this is what makes restart-safe "resume, don't
 * resubmit" possible on both the BYOK and managed paths.
 */
import { CREDIT_COST, chargeCredits } from "./ComplexityRouter.js";
import { resolveProviderCapabilities } from "./AIProviderCapabilityResolver.js";
import * as CreatorStudioApiClient from "./CreatorStudioApiClient.js";
import { wayAuth } from "./WayAuth.js";

const VEO_MODEL = "veo-3.1-generate-preview";

// --- BYOK path: direct calls to Veo with the user's own key ---

async function submitByok(resolved, { prompt, aspectRatio = "9:16", durationSeconds = "6" }) {
  const res = await fetch(`${resolved.baseUrl}/models/${resolved.model || VEO_MODEL}:predictLongRunning`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": resolved.apiKey },
    body: JSON.stringify({ instances: [{ prompt }], parameters: { aspectRatio, durationSeconds, numberOfVideos: 1 } }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data?.name) throw new Error(data?.error?.message || `Veo submit failed (HTTP ${res.status})`);
  return { mode: "byok", providerJobId: data.name, apiKey: resolved.apiKey, baseUrl: resolved.baseUrl };
}

async function pollByok(job) {
  const res = await fetch(`${job.baseUrl}/${job.providerJobId}`, { headers: { "x-goog-api-key": job.apiKey } });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error?.message || `Veo poll failed (HTTP ${res.status})`);
  if (!data.done) return { done: false };
  const sample = data.response?.generateVideoResponse?.generatedSamples?.[0];
  if (!sample?.video?.uri) throw new Error(data.error?.message || "Veo operation finished but returned no video.");
  return { done: true, videoUri: sample.video.uri };
}

// --- BYOK path: Higgsfield (docs.higgsfield.ai) — a separate submit/poll shape
// from Veo: model-specific endpoints under one base URL, "Key ID:Secret" auth,
// async job submitted then polled at a fixed /requests/{id}/status route. ---

async function submitHiggsfield(resolved, { prompt, aspectRatio = "9:16", durationSeconds = "6" }) {
  const model = resolved.model || "veo3.1/fast";
  const res = await fetch(`${resolved.baseUrl}/${model}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Key ${resolved.apiKey}` },
    body: JSON.stringify({ prompt, aspect_ratio: aspectRatio, duration: durationSeconds }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data?.request_id) throw new Error(data?.error || data?.message || `Higgsfield submit failed (HTTP ${res.status})`);
  return { mode: "byok", providerId: "higgsfield", providerJobId: data.request_id, apiKey: resolved.apiKey, baseUrl: resolved.baseUrl };
}

async function pollHiggsfield(job) {
  const res = await fetch(`${job.baseUrl}/requests/${job.providerJobId}/status`, {
    headers: { Authorization: `Key ${job.apiKey}` },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error || data?.message || `Higgsfield poll failed (HTTP ${res.status})`);
  const status = String(data?.status || "").toLowerCase();
  if (status === "failed" || status === "error" || status === "cancelled") {
    throw new Error(data?.error || data?.message || `Higgsfield generation ${status}.`);
  }
  if (status !== "completed" && status !== "succeeded" && status !== "success") return { done: false };
  // Higgsfield's completed-job response shape isn't fully pinned down from public
  // docs at the time this was written — checking the plausible field names rather
  // than assuming one, so a shape mismatch fails with the raw payload attached
  // instead of silently returning an empty video.
  const videoUri =
    data?.output?.video_url || data?.output?.url || data?.result?.video_url ||
    data?.video_url || data?.url || data?.outputs?.[0]?.url || data?.outputs?.[0]?.video_url;
  if (!videoUri) {
    throw new Error(`Higgsfield job completed but no video URL was found in the response: ${JSON.stringify(data).slice(0, 500)}`);
  }
  return { done: true, videoUri };
}

// --- BYOK path: Hugging Face Inference Providers (open-source video models) ---
// Protocol taken from huggingface.js (packages/inference/src/providers/fal-ai.ts):
// submit to the fal-ai queue through the HF router with the user's hf_ token,
// poll `${base}${new URL(response_url).pathname}/status`, then read the result
// at `${base}${pathname}` and download `video.url`.

const HF_ROUTER_FAL = "https://router.huggingface.co/fal-ai";
export const HF_VIDEO_MODEL = "fal-ai/wan/v2.2-5b/text-to-video"; // Wan-AI/Wan2.2-TI2V-5B

export function findHuggingFaceKey(accountManager, extraAccounts = []) {
  const accounts = [...(accountManager?.getAll?.() || []), ...extraAccounts];
  const account = accounts.find((a) => a?.provider === "huggingface" && a.status !== "disabled" && /^hf_[A-Za-z0-9]{10,}/.test(String(a.apiKey || "")));
  return account ? String(account.apiKey) : "";
}

export async function submitHuggingFace(apiKey, { prompt }, fetchImpl = fetch) {
  const res = await fetchImpl(`${HF_ROUTER_FAL}/${HF_VIDEO_MODEL}?_subdomain=queue`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ prompt }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data?.request_id || !data?.response_url) {
    throw new Error(data?.error || data?.detail || `Hugging Face submit failed (HTTP ${res.status})`);
  }
  return { apiKey, path: new URL(data.response_url).pathname };
}

export async function pollHuggingFace(job, fetchImpl = fetch) {
  const headers = { Authorization: `Bearer ${job.apiKey}` };
  const statusRes = await fetchImpl(`${HF_ROUTER_FAL}${job.path}/status?_subdomain=queue`, { headers });
  const status = await statusRes.json().catch(() => ({}));
  if (!statusRes.ok) throw new Error(status?.error || `Hugging Face poll failed (HTTP ${statusRes.status})`);
  if (status?.status === "FAILED" || status?.status === "ERROR") throw new Error(`Hugging Face generation ${String(status.status).toLowerCase()}.`);
  if (status?.status !== "COMPLETED") return { done: false };
  const resultRes = await fetchImpl(`${HF_ROUTER_FAL}${job.path}?_subdomain=queue`, { headers });
  const result = await resultRes.json().catch(() => ({}));
  const videoUri = result?.video?.url;
  if (!videoUri) throw new Error("Hugging Face finished but returned no video URL.");
  return { done: true, videoUri };
}

async function waitFor(submitFn, pollFn, label, { attempts = 120 } = {}) {
  const job = await submitFn();
  let backoffMs = 1500;
  for (let i = 0; i < attempts; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, backoffMs));
    backoffMs = Math.min(10000, backoffMs * 1.5);
    const outcome = await pollFn(job);
    if (outcome.done) return outcome.videoUri;
  }
  throw new Error(`Video generation timed out waiting for ${label}.`);
}

/**
 * Generate a video clip, trying every route the user has, in order:
 * their own Google (Veo) / Higgsfield key → their Hugging Face token →
 * Way AI Cloud. A route that fails falls through to the next one instead of
 * failing the whole video; the error lists what was tried.
 * Returns { videoUri, mode, route, attempts }.
 * @param {{prompt:string, aspectRatio?:string, durationSeconds?:string, projectId?:string, resourceId?:string, resourceType?:string, segmentId?:string, skipCredits?:boolean, provider?:string, model?:string}} options
 */
export async function generateVideo({
  prompt, aspectRatio = "9:16", durationSeconds = "6", projectId = null,
  resourceId = "adhoc", resourceType = "shot", segmentId, skipCredits = false, provider = "auto", model = "",
} = {}, accountManager = null) {
  const cleanPrompt = String(prompt || "").trim();
  if (!cleanPrompt) throw new Error("Video prompt is required.");

  await accountManager?.whenReady?.();
  const attempts = [];
  // Every connected video account in turn (Veo, Higgsfield, ...), then Hugging
  // Face, then Way AI Cloud. One provider being out of credits or busy moves to
  // the next silently rather than ending the request.
  for (const resolved of resolveProviderCapabilities(accountManager, "video-generation", { provider, model })) {
    const isHiggsfield = resolved.providerId === "higgsfield";
    const label = isHiggsfield ? "Higgsfield" : "Google Veo";
    try {
      const submit = isHiggsfield ? submitHiggsfield : submitByok;
      const poll = isHiggsfield ? pollHiggsfield : pollByok;
      const videoUri = await waitFor(() => submit(resolved, { prompt: cleanPrompt, aspectRatio, durationSeconds }), poll, label);
      return { videoUri, mode: "byok", route: resolved.providerId, attempts };
    } catch (error) {
      attempts.push({ route: resolved.providerId, error: error?.message || String(error) });
    }
  }

  const hfKey = (provider === "auto" || provider === "huggingface") ? findHuggingFaceKey(accountManager, wayAuth.getProviderAccounts?.() || []) : "";
  if (hfKey) {
    try {
      const videoUri = await waitFor(() => submitHuggingFace(hfKey, { prompt: cleanPrompt }), pollHuggingFace, "Hugging Face");
      return { videoUri, mode: "byok", route: "huggingface", attempts };
    } catch (error) {
      attempts.push({ route: "huggingface", error: error?.message || String(error) });
    }
  }

  // Way AI Cloud — charges platform credits, same pattern as WayIllustrateAdapter.
  try {
    if (!skipCredits) await chargeCredits(CREDIT_COST?.video ?? 5, "Video generation (Creator Studio)");
    const { taskId } = await createManagedTask({ projectId, resourceId, resourceType, prompt: cleanPrompt, aspectRatio, durationSeconds, segmentId });
    const finalTask = await pollManagedTask(taskId);
    if (finalTask.status !== "completed") {
      throw new Error(finalTask.error_message || "Way AI Cloud video generation failed.");
    }
    const result = typeof finalTask.result_json === "string" ? JSON.parse(finalTask.result_json) : finalTask.result_json;
    return { videoUri: result?.videoUri, mode: "managed", route: "waycloud", taskId, attempts };
  } catch (error) {
    attempts.push({ route: "waycloud", error: error?.message || String(error) });
  }

  const summary = attempts.map((a) => `${a.route}: ${a.error}`).join(" | ");
  const err = new Error(`No video route worked (${summary}).`);
  err.attempts = attempts;
  throw err;
}

async function createManagedTask({ projectId, resourceId, resourceType, prompt, aspectRatio, durationSeconds, segmentId }) {
  const task = await CreatorStudioApiClient.createTask({
    projectId, taskType: "video_clip", mediaType: "video", resourceId, resourceType,
    payload: { prompt, aspectRatio, durationSeconds, segmentId },
  });
  if (!task?.id) throw new Error("Failed to enqueue managed video generation task");
  return { taskId: task.id };
}

async function pollManagedTask(taskId) {
  let backoffMs = 2000;
  for (let attempts = 0; attempts < 90; attempts += 1) {
    const task = await CreatorStudioApiClient.getTask(taskId);
    if (task && ["completed", "failed", "cancelled"].includes(task.status)) return task;
    await new Promise((resolve) => setTimeout(resolve, backoffMs));
    backoffMs = Math.min(8000, backoffMs * 1.3);
  }
  throw new Error("Timed out waiting for managed video generation task");
}

// Restart-safe resume for the managed path: if the caller already has a
// taskId from a previous session (e.g. the page was closed mid-generation),
// resume polling it instead of submitting a new one.
export async function resumeManagedTask(taskId) {
  return pollManagedTask(taskId);
}
