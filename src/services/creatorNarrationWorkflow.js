/**
 * creatorNarrationWorkflow — Creator Studio Phase F1: narrated short video.
 * Source text -> real persisted segments -> real storyboard -> real
 * per-scene image + TTS voiceover, using the same task/cost/version plumbing
 * Phase D proved for product shots (createTask/completeTask/failTask,
 * recordVersion), plus the new deterministic narration pipeline (Phase F1's
 * NarrationSegmentSplitter/StoryboardBuilder, run server-side).
 *
 * Persistence lives on a `creator_projects`/`creator_episodes` row (Phase A),
 * not theCreatorEngine.js's separate local/localStorage project model used by
 * TheCreatorPanel's existing reels/clips rooms — this is a new, additive
 * "Narration" room rather than a rewrite of that already-working local UI.
 */
import { generateIllustration } from "./WayIllustrateAdapter.js";
import { applyConsistency } from "../components/core/creatorConsistency.js";
import { listAssets } from "./CreatorStudioApiClient.js";
import { generateNarration } from "./WayTtsAdapter.js";
import {
  listProjects,
  createProject,
  listEpisodes,
  createEpisode,
  updateEpisode,
  runNarrationPipeline,
  uploadFiles,
  createTask,
  completeTask,
  failTask,
  recordVersion,
} from "./CreatorStudioApiClient.js";

const NARRATION_PROJECT_NAME = "Narrated Short Videos";

function parseScript(episode) {
  const script = typeof episode?.script_json === "string" ? JSON.parse(episode.script_json) : episode?.script_json;
  return script || { sourceText: "", segments: [], storyboard: [] };
}

export async function ensureNarrationEpisode() {
  const projects = await listProjects({ limit: 200 });
  let project = (projects || []).find((item) => item.content_mode === "narration" && item.name === NARRATION_PROJECT_NAME);
  if (!project) {
    project = await createProject({
      name: NARRATION_PROJECT_NAME,
      contentMode: "narration",
      generationMode: "storyboard",
      style: "cinematic",
      aspectRatio: "9:16",
    });
  }
  const episodes = await listEpisodes(project.id);
  let episode = (episodes || [])[0];
  if (!episode) {
    episode = await createEpisode(project.id, { episodeNumber: 1, title: "Episode 1" });
  }
  return { project, episode };
}

/**
 * Splits sourceText into segments + a storyboard scaffold, persisted onto the
 * episode. Safe to re-run — it replaces the storyboard scaffold, but any
 * previously generated scene image/audio is re-attached by the caller
 * afterward, not silently dropped (see attachExistingMedia below).
 */
export async function buildNarrationStoryboard({ project, episode, sourceText, style = "cinematic" }) {
  const clean = String(sourceText || "").trim();
  if (!clean) throw new Error("Paste some narration text first.");
  const previous = parseScript(episode);
  const result = await runNarrationPipeline({ projectId: project.id, episodeId: episode.id, sourceText: clean, style });
  // The pipeline route already persisted a fresh storyboard scaffold server-
  // side; this second write re-attaches any media generated under the prior
  // storyboard so re-splitting the same source text never discards it.
  const storyboard = attachExistingMedia(result.storyboard, previous.storyboard);
  return updateEpisode(project.id, episode.id, {
    script: { sourceText: clean, segments: result.segments, storyboard, generatedAt: new Date().toISOString() },
  });
}

// If a scene's narration text is unchanged from a prior run, carry its
// already-generated image/audio forward instead of losing it to a re-split.
function attachExistingMedia(freshStoryboard, previousStoryboard = []) {
  return freshStoryboard.map((scene) => {
    const match = previousStoryboard.find((prior) => prior.narration === scene.narration);
    return match ? { ...scene, imageUrl: match.imageUrl || null, audioUrl: match.audioUrl || null } : scene;
  });
}

async function persistSceneField(project, episode, order, field, value) {
  const script = parseScript(episode);
  const storyboard = script.storyboard.map((scene) => (scene.order === order ? { ...scene, [field]: value } : scene));
  return updateEpisode(project.id, episode.id, { script: { ...script, storyboard } });
}

export async function generateSceneImage({ project, episode, scene, style = "cinematic", aspectRatio = "9:16" }, accountManager = null) {
  const task = await createTask({
    projectId: project.id,
    taskType: "narration_scene_image",
    mediaType: "image",
    resourceId: `${episode.id}:${scene.order}`,
    resourceType: "narration_scene",
    payload: { prompt: scene.assetPrompt, style, aspectRatio },
  });
  try {
    // Locked looks from the Asset Library go into the prompt, so the same
    // character/prop comes back the same in every scene.
    const assets = await listAssets({ limit: 60 }).catch(() => []);
    const prompt = applyConsistency(scene.assetPrompt, { sceneText: `${scene.narration || ""} ${scene.assetPrompt || ""}`, assets, style });
    const generated = await generateIllustration({ prompt, style, aspectRatio }, accountManager);
    const submittedPayload = typeof task.payload_json === "string" ? JSON.parse(task.payload_json) : task.payload_json;
    await completeTask(task.id, {
      result: { url: generated.url },
      cost: { callType: "image", provider: generated.provider, model: generated.model || "unknown", costAmount: submittedPayload?.estimatedCostAmount || 0, currency: submittedPayload?.estimatedCostCurrency || "USD", isEstimate: false },
    });
    await recordVersion({ resourceType: "shot", resourceId: `${episode.id}:${scene.order}`, filePath: generated.url, metadata: { prompt: scene.assetPrompt, taskId: task.id } });
    const updated = await persistSceneField(project, episode, scene.order, "imageUrl", generated.url);
    return { episode: updated, url: generated.url };
  } catch (err) {
    await failTask(task.id, { errorCode: "generation_failed", errorMessage: String(err?.message || err) }).catch(() => {});
    throw err;
  }
}

export async function generateSceneVoiceover({ project, episode, scene, voice = "alloy" }, accountManager = null) {
  const task = await createTask({
    projectId: project.id,
    taskType: "narration_scene_audio",
    mediaType: "audio",
    resourceId: `${episode.id}:${scene.order}`,
    resourceType: "narration_scene",
    payload: { text: scene.narration, voice },
  });
  try {
    const generated = await generateNarration({ text: scene.narration, voice }, accountManager);
    // generateNarration returns a session-local blob: URL — persist it as a
    // real file via the upload route so the voiceover survives a page reload.
    // What's stored is the RELATIVE storage path, not a fetchable URL — the
    // media route is authenticated, so playback always goes through
    // fetchMediaBlobUrl(path) at render time (see CreatorNarrationRoom.jsx),
    // never a bare <audio src>.
    const blob = await fetch(generated.audioUrl).then((response) => response.blob());
    const file = new File([blob], `scene-${scene.order}.mp3`, { type: blob.type || "audio/mpeg" });
    const [uploaded] = await uploadFiles([file]);

    const submittedPayload = typeof task.payload_json === "string" ? JSON.parse(task.payload_json) : task.payload_json;
    await completeTask(task.id, {
      result: { path: uploaded.path },
      cost: { callType: "audio", provider: `openai:${generated.mode}`, model: "tts-1", costAmount: submittedPayload?.estimatedCostAmount || 0, currency: submittedPayload?.estimatedCostCurrency || "USD", isEstimate: false },
    });
    await recordVersion({ resourceType: "shot", resourceId: `${episode.id}:${scene.order}-audio`, filePath: uploaded.path, metadata: { voice, taskId: task.id } });
    const updated = await persistSceneField(project, episode, scene.order, "audioUrl", uploaded.path);
    return { episode: updated, path: uploaded.path };
  } catch (err) {
    await failTask(task.id, { errorCode: "generation_failed", errorMessage: String(err?.message || err) }).catch(() => {});
    throw err;
  }
}
