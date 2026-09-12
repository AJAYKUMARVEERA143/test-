"use strict";

// Server-side (managed-proxy) caller for Google's Veo video model — the concrete
// VideoBackend-shaped implementation that proves the task queue's submit-then-poll
// and restart-safe resume machinery end to end. Verified against Google's own
// docs (ai.google.dev/gemini-api/docs/veo): POST .../predictLongRunning returns
// an operation name immediately; polling GET on that name returns {done, response}.
//
// BYOK video generation (the user's own key) happens client-side in
// src/services/WayVideoAdapter.js instead — this module is only reached for the
// managed-proxy fallback, using the server's own GEMINI_API_KEY.

const fetch = require("node-fetch");
const { ResumeExpiredError, ResumeEndpointChangedError, AmbiguousSubmitError } = require("../CreatorTaskErrors.js");

const BASE_URL = "https://generativelanguage.googleapis.com/v1beta";
const MODEL = "veo-3.1-generate-preview";
const PROVIDER_ID = "gemini-veo";

function apiKey() {
  const key = process.env.GEMINI_API_KEY || "";
  if (!key) throw new Error("GEMINI_API_KEY is not configured on the server");
  return key;
}

async function submit({ prompt, aspectRatio = "9:16", durationSeconds = "6" }) {
  const res = await fetch(`${BASE_URL}/models/${MODEL}:predictLongRunning`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey() },
    body: JSON.stringify({
      instances: [{ prompt }],
      parameters: { aspectRatio, durationSeconds, numberOfVideos: 1 },
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data?.error?.message || `Veo submit failed (HTTP ${res.status})`);
    err.status = res.status;
    throw err;
  }
  if (!data?.name) throw new AmbiguousSubmitError("Veo accepted the request but returned no operation name — cannot track this job.");
  return { providerId: PROVIDER_ID, providerJobId: data.name, providerEndpoint: BASE_URL, submittedBaseUrl: BASE_URL };
}

// task carries provider_job_id/provider_endpoint/submitted_base_url persisted by
// CreatorTaskRepository.attachProviderJob() right after the original submit —
// this is what makes resuming after a server restart possible without resubmitting.
async function poll(task) {
  if (task.submitted_base_url && task.submitted_base_url !== BASE_URL) {
    throw new ResumeEndpointChangedError(`Task was submitted against ${task.submitted_base_url}, but this server is now configured for ${BASE_URL}.`);
  }
  const res = await fetch(`${BASE_URL}/${task.provider_job_id}`, {
    headers: { "x-goog-api-key": apiKey() },
  });
  if (res.status === 404) {
    throw new ResumeExpiredError(`Veo operation ${task.provider_job_id} no longer exists — it has expired or was already consumed.`);
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data?.error?.message || `Veo poll failed (HTTP ${res.status})`);
    err.status = res.status;
    throw err;
  }
  if (!data.done) return { done: false };
  const sample = data.response?.generateVideoResponse?.generatedSamples?.[0];
  if (!sample?.video?.uri) {
    throw new Error(data.error?.message || "Veo operation finished but returned no video.");
  }
  return { done: true, videoUri: sample.video.uri };
}

module.exports = { submit, poll, PROVIDER_ID };
