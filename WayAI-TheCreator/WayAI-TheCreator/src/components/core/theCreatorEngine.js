import {
  CREATOR_LANES,
  THE_CREATOR_VERSION,
  creatorKeywords,
  detectCreatorIntent,
  normalizeCreatorText,
} from "../../ai-core/theCreatorCatalog.js";

export const THE_CREATOR_PROJECT_STORAGE_KEY = "wayai.theCreator.projects.v1";
export const THE_CREATOR_FLOW_HANDOFF_STORAGE_KEY = "wayai.flow.pendingCreatorWorkflow.v1";
export const THE_CREATOR_RENDER_QUEUE_STORAGE_KEY = "wayai.theCreator.renderQueue.v1";

export const CREATOR_FORMATS = {
  reel_9x16: { id: "reel_9x16", label: "Reel / Short", width: 1080, height: 1920, fps: 30, duration: 35, aspect: "9:16" },
  story_9x16: { id: "story_9x16", label: "Story", width: 1080, height: 1920, fps: 30, duration: 20, aspect: "9:16" },
  wide_16x9: { id: "wide_16x9", label: "Wide Video", width: 1920, height: 1080, fps: 30, duration: 70, aspect: "16:9" },
  square_1x1: { id: "square_1x1", label: "Square Post", width: 1080, height: 1080, fps: 30, duration: 30, aspect: "1:1" },
  comic_page: { id: "comic_page", label: "Comic Page", width: 1440, height: 2160, fps: 1, duration: 0, aspect: "2:3" },
  animation_board: { id: "animation_board", label: "Animation Board", width: 1920, height: 1080, fps: 24, duration: 55, aspect: "16:9" },
};

export const CREATOR_PIPELINES = [
  { id: "creator-reel", label: "Reel Sprint", lanes: ["reels", "clips", "footage"], safeMode: "draft_then_approval" },
  { id: "creator-clip", label: "Clip Scout", lanes: ["clips", "reels"], safeMode: "analysis_only" },
  { id: "creator-animation", label: "Animation Board", lanes: ["animation", "illustration", "footage"], safeMode: "draft_only" },
  { id: "creator-comic", label: "Comic Episode", lanes: ["comics", "illustration"], safeMode: "approval_gated_assets" },
  { id: "creator-all", label: "Full Creator Pack", lanes: ["reels", "clips", "animation", "comics", "illustration", "footage"], safeMode: "safe_autopilot_v1" },
];

const STORY_BEATS = [
  { id: "hook", label: "Hook", weight: 0.13, camera: "fast push-in", caption: "Make the promise clear in one line." },
  { id: "problem", label: "Problem", weight: 0.16, camera: "wide context", caption: "Show the pain without overexplaining." },
  { id: "turn", label: "Turn", weight: 0.15, camera: "orbit reveal", caption: "Reveal the better operating path." },
  { id: "proof", label: "Proof", weight: 0.18, camera: "detail close-up", caption: "Use concrete product or business proof." },
  { id: "motion", label: "Motion", weight: 0.15, camera: "tracking move", caption: "Connect the idea visually." },
  { id: "payoff", label: "Payoff", weight: 0.14, camera: "hero frame", caption: "State the useful outcome." },
  { id: "cta", label: "CTA", weight: 0.09, camera: "clean end card", caption: "Ask for one safe next step." },
];

const MOTION_LAYERS = [
  { id: "camera", label: "Camera", instruction: "slow depth push, subtle handheld drift, no dizzy movement" },
  { id: "foreground", label: "Foreground", instruction: "small spark particles and line glints moving at a different depth" },
  { id: "subject", label: "Subject", instruction: "main object scales 1.0 to 1.04 with soft shadow shift" },
  { id: "type", label: "Type", instruction: "caption reveal by word groups, reduced-motion fallback keeps static text" },
  { id: "transition", label: "Transition", instruction: "match-cut or luminance wipe between scenes" },
];

function nowIso(clock) {
  if (clock instanceof Date) return clock.toISOString();
  if (typeof clock === "function") return new Date(clock()).toISOString();
  return new Date().toISOString();
}

function slug(value = "creator") {
  return normalizeCreatorText(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 52) || "creator";
}

function titleCase(value = "") {
  const clean = normalizeCreatorText(value)
    .replace(/^\/core\s*/i, "")
    .replace(/\b(the creator|creator|create|make|plan|generate|build|clip|comic|animation|animate|reel|short|video|footage|illustration|image|about|for)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  const title = (clean || "WayAI creator project")
    .split(/[^a-z0-9]+/i)
    .filter(Boolean)
    .slice(0, 8)
    .map((word) => `${word.slice(0, 1).toUpperCase()}${word.slice(1)}`)
    .join(" ");
  return title || "WayAI Creator Project";
}

function clamp(number, min, max) {
  return Math.max(min, Math.min(max, number));
}

function pickPipeline(lanes) {
  if (lanes.includes("comics")) return "creator-comic";
  if (lanes.includes("animation")) return "creator-animation";
  if (lanes.includes("clips") && !lanes.includes("footage")) return "creator-clip";
  if (lanes.length >= 4) return "creator-all";
  return "creator-reel";
}

function sceneCount(format, lanes) {
  if (format.id === "comic_page") return 6;
  if (format.id === "story_9x16") return 4;
  if (lanes.includes("animation")) return 7;
  return clamp(Math.round((format.duration || 35) / 7), 4, 8);
}

function splitDurations(duration, count) {
  if (!duration) return Array.from({ length: count }, () => 0);
  const beats = STORY_BEATS.slice(0, count);
  const total = beats.reduce((sum, beat) => sum + beat.weight, 0) || 1;
  const rough = beats.map((beat) => Math.max(3, Math.round((duration * beat.weight) / total)));
  rough[rough.length - 1] += duration - rough.reduce((sum, item) => sum + item, 0);
  return rough;
}

function scriptLine(beat, title, keywords) {
  const topic = keywords[0] || title;
  const lines = {
    hook: `${title}: here is the useful thing in one sharp sentence.`,
    problem: `People lose momentum when ${topic} work is split across disconnected tools.`,
    turn: `NOVA turns the work into one visible plan with safe next actions.`,
    proof: `Show the task, approval, asset, and result moving through the same operating system.`,
    motion: `Use motion to make the handoff feel alive, not decorative.`,
    payoff: `End on clarity: fewer misses, faster decisions, safer execution.`,
    cta: `Cheppandi boss — ask NOVA for the next approved step.`,
  };
  return lines[beat.id] || `${beat.label}: explain ${topic} simply.`;
}

// Every scene used to get the exact same first-4 keywords verbatim (identical visual
// direction on every card, regardless of beat). Rotating the starting point per scene
// keeps each scene grounded in the brief's real vocabulary while actually varying —
// scene 2 doesn't repeat scene 1's word-for-word direction.
function sceneKeywordWindow(keywords, index) {
  if (!keywords.length) return [];
  const offset = index % keywords.length;
  const rotated = [...keywords.slice(offset), ...keywords.slice(0, offset)];
  return rotated.slice(0, 4);
}

function buildStoryboard({ title, brief, format, style, lanes }) {
  const keywords = creatorKeywords(brief);
  const count = sceneCount(format, lanes);
  const durations = splitDurations(format.duration, count);
  return STORY_BEATS.slice(0, count).map((beat, index) => ({
    id: `scene_${String(index + 1).padStart(2, "0")}`,
    order: index + 1,
    beat: beat.label,
    lane: lanes[index % lanes.length] || "reels",
    durationSeconds: durations[index],
    camera: beat.camera,
    narration: scriptLine(beat, title, keywords),
    caption: beat.caption,
    visualDirection: `${style}; original WayAI composition; ${beat.camera}; ${sceneKeywordWindow(keywords, index).join(", ") || "company operating system"}`,
    assetPrompt: `${title}. ${beat.label} scene. ${style}. Aspect ${format.aspect}. Original grayscale/black composition, clean lighting, no copied source material.`,
    status: "planned",
    approvalRequired: ["Hook", "Proof", "CTA"].includes(beat.label),
  }));
}

function buildClipCandidates(storyboard, format) {
  return storyboard.slice(0, 5).map((scene, index) => {
    const start = storyboard.slice(0, index).reduce((sum, item) => sum + (item.durationSeconds || 0), 0);
    const end = start + Math.max(5, scene.durationSeconds || 8);
    return {
      id: `clip_${String(index + 1).padStart(2, "0")}`,
      title: `${scene.beat} cut`,
      sourceSceneId: scene.id,
      startSecond: start,
      endSecond: end,
      score: clamp(92 - index * 6 + (scene.approvalRequired ? 2 : 0), 62, 96),
      hookReason: scene.caption,
      captionHook: scene.narration.split(".")[0],
      exportFit: format.aspect === "9:16" ? "native vertical" : "needs crop-safe framing",
      status: "draft_cut",
    };
  });
}

function buildComicPanels(storyboard, title, style) {
  return storyboard.slice(0, 6).map((scene, index) => ({
    id: `panel_${String(index + 1).padStart(2, "0")}`,
    order: index + 1,
    title: scene.beat,
    frame: index % 3 === 0 ? "wide establishing panel" : index % 3 === 1 ? "medium character/action panel" : "close expression/detail panel",
    characterContinuity: `Keep the same company-operator persona silhouette, grayscale outfit, and calm executive expression across ${title}.`,
    dialogue: scene.narration,
    visualPrompt: `${style}; ${scene.visualDirection}; comic panel ${index + 1}; crisp monochrome ink and soft gray depth.`,
    qualityGate: "Check face/brand consistency, readable text, clean gutters, and no copied reference layout.",
  }));
}

function buildAnimationPlan(storyboard) {
  return {
    fps: 24,
    rhythm: "calm executive motion with visible depth",
    layers: MOTION_LAYERS.map((layer, index) => ({
      ...layer,
      sceneIds: storyboard.filter((_, sceneIndex) => sceneIndex % MOTION_LAYERS.length === index).map((scene) => scene.id),
    })),
    reducedMotionFallback: "Render static frames with fade-only transitions and persistent captions.",
  };
}

function buildIllustrationPrompts(storyboard, format, style) {
  return storyboard.slice(0, 6).map((scene) => ({
    id: `${scene.id}_illustration`,
    sceneId: scene.id,
    prompt: scene.assetPrompt,
    style,
    aspectRatio: format.aspect,
    providerStatus: "ready_if_configured",
    usagePolicy: "Draft asset only; review before publish or customer-facing use.",
  }));
}

function buildFootageManifest(storyboard, lanes) {
  const needsSourceReview = lanes.includes("clips") || lanes.includes("footage");
  return {
    sourcePolicy: needsSourceReview ? "User-provided/source footage must be rights-checked before render or publish." : "Original/generated placeholders until approval.",
    assets: storyboard.flatMap((scene, index) => [
      {
        id: `${scene.id}_visual`,
        sceneId: scene.id,
        kind: scene.lane === "comics" ? "panel_art" : "visual_clip_or_image",
        status: "needed",
        licenseRequired: true,
        note: scene.visualDirection,
      },
      {
        id: `${scene.id}_caption`,
        sceneId: scene.id,
        kind: "caption_copy",
        status: "drafted",
        licenseRequired: false,
        note: scene.caption,
      },
      ...(index === 0 ? [{
        id: `${scene.id}_audio`,
        sceneId: scene.id,
        kind: "voice_or_music_timing",
        status: "planned",
        licenseRequired: true,
        note: "Use owned, licensed, or generated audio only after review.",
      }] : []),
    ]),
  };
}

function buildQualityGates(lanes) {
  return [
    { id: "brief_lock", label: "Brief locked", status: "ready", risk: "low", reason: "Internal planning can run safely." },
    { id: "rights_check", label: "Rights / source check", status: "pending", risk: "approval_required", reason: "Any user/source footage, music, likeness, or brand material needs review." },
    { id: "script_review", label: "Script and claims review", status: "pending", risk: "approval_required", reason: "Customer-facing copy and claims need owner review." },
    { id: "asset_review", label: "Asset consistency review", status: "pending", risk: "approval_required", reason: lanes.includes("comics") ? "Character/page consistency and visual quality need review." : "Visual assets need review before use." },
    { id: "render_publish", label: "Render / publish approval", status: "blocked", risk: "approval_required", reason: "Paid render, external upload, or social publish stays disabled until explicit approval." },
  ];
}

function readinessScore(gates) {
  const ready = gates.filter((gate) => gate.status === "ready" || gate.status === "approved").length;
  return Math.round((ready / Math.max(1, gates.length)) * 100);
}

function normalizeProjectInput(input = {}, options = {}) {
  if (typeof input === "string") return { brief: input, ...options };
  return { ...input, ...options };
}

export function createCreatorProject(input = {}, options = {}) {
  const payload = normalizeProjectInput(input, options);
  const brief = normalizeCreatorText(payload.brief || payload.input || "Create a WayAI creator pack for NOVA company operating system.");
  const intent = detectCreatorIntent(`${brief} ${payload.mode || ""}`);
  const lanes = Array.isArray(payload.lanes) && payload.lanes.length ? payload.lanes : intent.lanes;
  const format = CREATOR_FORMATS[payload.format || intent.format] || CREATOR_FORMATS.reel_9x16;
  const style = payload.style || intent.style;
  const pipelineId = payload.pipelineId || pickPipeline(lanes);
  const pipeline = CREATOR_PIPELINES.find((item) => item.id === pipelineId) || CREATOR_PIPELINES[0];
  const title = payload.title || titleCase(brief);
  const createdAt = nowIso(payload.now || options.now);
  const storyboard = buildStoryboard({ title, brief, format, style, lanes });
  const qualityGates = buildQualityGates(lanes);
  const clipCandidates = buildClipCandidates(storyboard, format);
  const comicPanels = buildComicPanels(storyboard, title, style);
  const animationPlan = buildAnimationPlan(storyboard);
  const illustrationPrompts = buildIllustrationPrompts(storyboard, format, style);
  const footageManifest = buildFootageManifest(storyboard, lanes);
  const readiness = readinessScore(qualityGates);

  return {
    id: payload.id || `creator_${slug(title)}_${Date.parse(createdAt) || Date.now()}`,
    version: THE_CREATOR_VERSION,
    title,
    brief,
    createdAt,
    updatedAt: createdAt,
    ownerAgentId: "wayaiagent",
    studio: "THE CREATOR",
    originPolicy: "WayAI original project plan; references may inform structure only, never copied output.",
    lanes,
    laneDetails: CREATOR_LANES.filter((lane) => lanes.includes(lane.id)),
    format,
    style,
    pipeline,
    readiness,
    storyboard,
    clipCandidates,
    comicPanels,
    animationPlan,
    illustrationPrompts,
    footageManifest,
    qualityGates,
    approvals: qualityGates.filter((gate) => gate.risk === "approval_required").map((gate) => ({
      id: gate.id,
      label: gate.label,
      status: gate.status,
      reason: gate.reason,
    })),
    exportTargets: [
      { id: "creator_manifest", label: "Creator manifest JSON", enabled: true, approvalRequired: false },
      { id: "flow_handoff", label: "Way AI Flow handoff", enabled: true, approvalRequired: false },
      { id: "draft_render", label: "Draft render/provider run", enabled: false, approvalRequired: true },
      { id: "external_publish", label: "External publish", enabled: false, approvalRequired: true },
    ],
  };
}

export function summarizeCreatorProject(project = {}) {
  const lanes = (project.laneDetails || [])
    .map((lane) => lane.label)
    .join(", ") || (project.lanes || []).join(", ");
  return `THE CREATOR · ${project.title || "Creator project"}: ${lanes || "creative"} pack with ${(project.storyboard || []).length} scenes, ${(project.clipCandidates || []).length} clips, ${(project.comicPanels || []).length} panels, and ${project.readiness || 0}% readiness.`;
}

export function approveCreatorGate(project, gateId) {
  const now = nowIso();
  const qualityGates = (project.qualityGates || []).map((gate) => gate.id === gateId ? { ...gate, status: "approved" } : gate);
  const approvals = (project.approvals || []).map((gate) => gate.id === gateId ? { ...gate, status: "approved" } : gate);
  return {
    ...project,
    updatedAt: now,
    qualityGates,
    approvals,
    readiness: readinessScore(qualityGates),
  };
}

export function updateCreatorScene(project, sceneId, patch = {}) {
  if (!project || !sceneId) return project;
  const storyboard = (project.storyboard || []).map((scene) => {
    if (scene.id !== sceneId) return scene;
    const next = { ...scene };
    if (patch.durationSeconds !== undefined) {
      const seconds = Math.round(Number(patch.durationSeconds));
      next.durationSeconds = Number.isFinite(seconds) ? Math.max(1, Math.min(600, seconds)) : scene.durationSeconds;
    }
    if (patch.caption !== undefined) next.caption = String(patch.caption);
    if (patch.narration !== undefined) next.narration = String(patch.narration);
    if (patch.imageUrl !== undefined) next.imageUrl = patch.imageUrl;
    if (patch.imageProvider !== undefined) next.imageProvider = patch.imageProvider;
    return next;
  });
  return { ...project, updatedAt: nowIso(), storyboard };
}

// Merges real AI-written scene content (narration/camera/caption/visual direction) into
// the existing storyboard by position, in place of the fixed sentence templates. Keeps
// every structural field (id, order, durationSeconds, lane, status) untouched so
// duration edits, reordering, and the render preview all keep working unchanged.
export function applyCreatorAIScript(project, aiScenes) {
  if (!project || !Array.isArray(aiScenes) || !aiScenes.length) return project;
  const storyboard = (project.storyboard || []).map((scene, index) => {
    const aiScene = aiScenes[index];
    if (!aiScene) return scene;
    return {
      ...scene,
      narration: aiScene.narration || scene.narration,
      camera: aiScene.cameraAngle || scene.camera,
      caption: aiScene.caption || scene.caption,
      visualDirection: aiScene.visualDirection || scene.visualDirection,
    };
  });
  return { ...project, updatedAt: nowIso(), storyboard, scriptSource: "ai" };
}

export function updateCreatorAnimationLayer(project, layerId, instruction) {
  if (!project || !layerId) return project;
  const layers = (project.animationPlan?.layers || []).map((layer) =>
    layer.id === layerId ? { ...layer, instruction: String(instruction ?? layer.instruction) } : layer);
  return { ...project, updatedAt: nowIso(), animationPlan: { ...project.animationPlan, layers } };
}

export function reorderCreatorScene(project, sceneId, direction) {
  if (!project || !sceneId) return project;
  const storyboard = [...(project.storyboard || [])];
  const index = storyboard.findIndex((scene) => scene.id === sceneId);
  const targetIndex = index + (direction < 0 ? -1 : 1);
  if (index < 0 || targetIndex < 0 || targetIndex >= storyboard.length) return project;
  [storyboard[index], storyboard[targetIndex]] = [storyboard[targetIndex], storyboard[index]];
  const renumbered = storyboard.map((scene, position) => ({ ...scene, order: position + 1 }));
  return { ...project, updatedAt: nowIso(), storyboard: renumbered };
}

export function createCreatorExportManifest(project = {}) {
  return {
    manifestVersion: THE_CREATOR_VERSION,
    projectId: project.id,
    title: project.title,
    studio: "THE CREATOR",
    ownerAgentId: "wayaiagent",
    createdAt: new Date().toISOString(),
    safety: {
      mode: "safe_autopilot_v1",
      liveProviderExecutionEnabled: false,
      externalPublishEnabled: false,
      approvalsRequired: (project.approvals || []).filter((gate) => gate.status !== "approved").map((gate) => gate.id),
    },
    format: project.format,
    lanes: project.lanes,
    storyboard: project.storyboard,
    clips: project.clipCandidates,
    panels: project.comicPanels,
    animation: project.animationPlan,
    illustrationPrompts: project.illustrationPrompts,
    assets: project.footageManifest,
  };
}

function storageOf(storage) {
  if (storage) return storage;
  if (typeof localStorage !== "undefined") return localStorage;
  return null;
}

function parseJson(raw, fallback) {
  try {
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function escapeHtml(value = "") {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function scriptJson(value) {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026");
}

export function loadCreatorProjectLibrary(storage) {
  const db = storageOf(storage);
  if (!db) return { activeProjectId: "", projects: [] };
  const parsed = parseJson(db.getItem(THE_CREATOR_PROJECT_STORAGE_KEY), { activeProjectId: "", projects: [] });
  return {
    activeProjectId: parsed.activeProjectId || "",
    projects: Array.isArray(parsed.projects) ? parsed.projects : [],
  };
}

export function saveCreatorProject(project, storage) {
  const db = storageOf(storage);
  const current = loadCreatorProjectLibrary(db);
  const projects = [project, ...current.projects.filter((item) => item.id !== project.id)].slice(0, 24);
  const next = { activeProjectId: project.id, projects };
  if (db) db.setItem(THE_CREATOR_PROJECT_STORAGE_KEY, JSON.stringify(next));
  return next;
}

export function getActiveCreatorProject(storage) {
  const library = loadCreatorProjectLibrary(storage);
  return library.projects.find((item) => item.id === library.activeProjectId) || library.projects[0] || null;
}

export function createCreatorRenderJob(project = {}, options = {}) {
  const createdAt = nowIso(options.now);
  const manifest = createCreatorExportManifest(project);
  const pendingApprovals = (project.approvals || [])
    .filter((gate) => gate.status !== "approved")
    .map((gate) => gate.id);
  return {
    id: options.id || `creator_render_${slug(project.id || project.title || "project")}_${Date.parse(createdAt) || Date.now()}`,
    type: "creator_draft_render_job",
    status: "queued",
    createdAt,
    updatedAt: createdAt,
    studio: "THE CREATOR",
    ownerAgentId: "wayaiagent",
    projectId: project.id,
    title: project.title || "Creator render job",
    renderTarget: options.renderTarget || "local_review_package",
    format: project.format,
    safety: {
      mode: "safe_autopilot_v1",
      liveProviderExecutionEnabled: false,
      publishEnabled: false,
      approvalRequiredBeforeLiveRender: true,
      pendingApprovals,
    },
    inputs: {
      storyboardScenes: (project.storyboard || []).length,
      clips: (project.clipCandidates || []).length,
      animationLayers: project.animationPlan?.layers?.length || 0,
      comicPanels: (project.comicPanels || []).length,
      illustrationPrompts: (project.illustrationPrompts || []).length,
      footageAssets: project.footageManifest?.assets?.length || 0,
    },
    timeline: (project.storyboard || []).map((scene) => ({
      sceneId: scene.id,
      order: scene.order,
      beat: scene.beat,
      durationSeconds: scene.durationSeconds,
      camera: scene.camera,
      narration: scene.narration,
      caption: scene.caption,
      assetPrompt: scene.assetPrompt,
    })),
    renderChecklist: [
      { id: "storyboard_ready", label: "Storyboard ready", status: (project.storyboard || []).length ? "ready" : "missing" },
      { id: "asset_manifest_ready", label: "Asset manifest ready", status: project.footageManifest?.assets?.length ? "ready" : "missing" },
      { id: "rights_review", label: "Rights/source review", status: pendingApprovals.includes("rights_check") ? "approval_required" : "ready" },
      { id: "script_review", label: "Script/claims review", status: pendingApprovals.includes("script_review") ? "approval_required" : "ready" },
      { id: "render_publish", label: "Live render/publish", status: "blocked_until_owner_approval" },
    ],
    expectedOutputs: [
      "creator-pack.json",
      "storyboard.md",
      "clip-cut-list.md",
      "animation-board.md",
      "comic-board.md",
      "illustration-prompts.md",
      "footage-manifest.md",
      "render-job.json",
      "preview.html",
    ],
    manifest,
  };
}

export function createCreatorPreviewHtml(project = {}, options = {}) {
  const scenes = (project.storyboard || []).map((scene) => ({
    order: scene.order,
    beat: scene.beat,
    durationSeconds: scene.durationSeconds || 0,
    camera: scene.camera,
    narration: scene.narration,
    caption: scene.caption,
    visualDirection: scene.visualDirection,
    assetPrompt: scene.assetPrompt,
  }));
  const totalSeconds = scenes.reduce((sum, scene) => sum + (scene.durationSeconds || 0), 0);
  const renderJob = options.renderJob || null;
  const payload = {
    project: {
      title: project.title || "Creator Preview",
      brief: project.brief || "",
      style: project.style || "monochrome cinematic",
      format: project.format?.label || "Draft",
      aspect: project.format?.aspect || "draft",
      readiness: project.readiness || 0,
      totalSeconds,
    },
    safety: {
      liveRenderEnabled: false,
      publishEnabled: false,
      note: "Local preview only. Live render and external publish require owner approval.",
    },
    renderJob: renderJob ? {
      id: renderJob.id,
      status: renderJob.status,
      renderTarget: renderJob.renderTarget,
      createdAt: renderJob.createdAt,
    } : null,
    scenes,
  };
  const title = escapeHtml(payload.project.title);
  const safePayload = scriptJson(payload);
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${title} - THE CREATOR Preview</title>
  <style>
    :root { color-scheme: dark; --bg:#050505; --panel:#101010; --card:#171717; --line:#3f3f46; --text:#f5f5f5; --muted:#a3a3a3; --faint:#737373; }
    * { box-sizing: border-box; }
    body { margin:0; min-height:100vh; color:var(--text); font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: radial-gradient(circle at 20% 0%, rgba(255,255,255,.11), transparent 30%), linear-gradient(135deg,#101010,#050505 52%,#111); }
    .creator-preview-standalone { min-height:100vh; display:grid; grid-template-columns:minmax(240px,320px) minmax(0,1fr); gap:14px; padding:14px; }
    aside, main, .scene, .timeline button { border:1px solid rgba(115,115,115,.28); border-radius:14px; background:linear-gradient(180deg,rgba(255,255,255,.06),rgba(255,255,255,.02)),rgba(10,10,10,.9); box-shadow:0 18px 52px rgba(0,0,0,.28); }
    aside { padding:16px; overflow:auto; }
    .kicker, .label { color:var(--faint); font-size:10px; font-weight:900; letter-spacing:.14em; text-transform:uppercase; }
    h1 { margin:8px 0 8px; font-size:31px; line-height:.95; letter-spacing:-.06em; }
    p { color:var(--muted); line-height:1.5; }
    .meta { display:grid; grid-template-columns:1fr 1fr; gap:8px; margin-top:14px; }
    .meta div { padding:10px; border-radius:10px; background:rgba(255,255,255,.05); }
    .meta b { display:block; margin-top:4px; }
    main { display:grid; grid-template-rows:minmax(0,1fr) auto auto; gap:12px; padding:14px; min-height:calc(100vh - 28px); }
    .scene { min-height:420px; display:grid; grid-template-columns:minmax(0,1.2fr) minmax(240px,.8fr); gap:12px; padding:18px; }
    .frame { display:flex; flex-direction:column; justify-content:center; min-width:0; }
    .frame h2 { margin:10px 0; font-size:clamp(42px,7vw,88px); line-height:.88; letter-spacing:-.08em; }
    .frame p { max-width:760px; font-size:clamp(16px,1.8vw,24px); }
    .frame em { margin-top:18px; color:var(--muted); font-style:normal; }
    .visual { display:grid; align-content:center; gap:10px; padding:16px; border-radius:12px; background:radial-gradient(circle at 50% 22%,rgba(255,255,255,.12),transparent 32%),#050505; }
    .progress { height:8px; overflow:hidden; border-radius:999px; background:rgba(255,255,255,.09); }
    .progress i { display:block; height:100%; width:0; border-radius:999px; background:linear-gradient(90deg,#f5f5f5,rgba(245,245,245,.2)); transition:width .25s ease; }
    .controls { display:flex; flex-wrap:wrap; align-items:center; gap:8px; }
    button { border:1px solid rgba(212,212,212,.2); border-radius:10px; color:#f5f5f5; background:linear-gradient(180deg,rgba(255,255,255,.1),rgba(255,255,255,.04)),#171717; padding:9px 12px; cursor:pointer; font-weight:800; }
    button:hover { border-color:rgba(245,245,245,.52); }
    .counter { margin-left:auto; color:var(--muted); font-weight:800; }
    .timeline { display:grid; gap:7px; margin-top:14px; }
    .timeline button { display:grid; grid-template-columns:auto minmax(0,1fr); align-items:center; gap:8px; padding:8px; text-align:left; }
    .timeline button.active { border-color:rgba(245,245,245,.68); background:rgba(255,255,255,.1); }
    .timeline b { width:24px; height:24px; display:grid; place-items:center; border-radius:999px; color:#111; background:#e5e5e5; font-size:11px; }
    .timeline span { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    @media (max-width: 860px) { .creator-preview-standalone, .scene { grid-template-columns:1fr; } main { min-height:auto; } }
  </style>
</head>
<body>
  <div class="creator-preview-standalone">
    <aside>
      <div class="kicker">THE CREATOR - Local Preview</div>
      <h1 id="title"></h1>
      <p id="brief"></p>
      <div class="meta">
        <div><span class="label">Format</span><b id="format"></b></div>
        <div><span class="label">Readiness</span><b id="readiness"></b></div>
        <div><span class="label">Duration</span><b id="duration"></b></div>
        <div><span class="label">Render</span><b id="render"></b></div>
      </div>
      <p class="label" style="margin-top:16px;">Timeline</p>
      <div class="timeline" id="timeline"></div>
    </aside>
    <main>
      <section class="scene">
        <div class="frame">
          <span class="label" id="sceneLabel"></span>
          <h2 id="beat"></h2>
          <p id="narration"></p>
          <em id="caption"></em>
        </div>
        <div class="visual">
          <span class="label">Visual direction</span>
          <p id="visual"></p>
          <small id="asset"></small>
        </div>
      </section>
      <div class="progress"><i id="progress"></i></div>
      <div class="controls">
        <button type="button" id="prev">Prev</button>
        <button type="button" id="play">Play</button>
        <button type="button" id="next">Next</button>
        <span class="counter" id="counter"></span>
      </div>
    </main>
  </div>
  <script type="application/json" id="creator-data">${safePayload}</script>
  <script>
    const payload = JSON.parse(document.getElementById("creator-data").textContent);
    const scenes = payload.scenes || [];
    let index = 0;
    let playing = false;
    let timer = null;
    const byId = (id) => document.getElementById(id);
    function setText(id, value) { byId(id).textContent = value || ""; }
    function progress() {
      const total = payload.project.totalSeconds || scenes.length || 1;
      const done = scenes.slice(0, index + 1).reduce((sum, scene) => sum + (scene.durationSeconds || 1), 0);
      return Math.min(100, Math.round((done / total) * 100));
    }
    function renderTimeline() {
      byId("timeline").innerHTML = "";
      scenes.forEach((scene, sceneIndex) => {
        const button = document.createElement("button");
        button.type = "button";
        button.className = sceneIndex === index ? "active" : "";
        button.innerHTML = "<b>" + scene.order + "</b><span>" + scene.beat + "</span>";
        button.addEventListener("click", () => { index = sceneIndex; stop(); render(); });
        byId("timeline").appendChild(button);
      });
    }
    function render() {
      const scene = scenes[index] || {};
      setText("title", payload.project.title);
      setText("brief", payload.project.brief);
      setText("format", payload.project.format + " / " + payload.project.aspect);
      setText("readiness", payload.project.readiness + "%");
      setText("duration", (payload.project.totalSeconds || scenes.length) + "s");
      setText("render", payload.renderJob ? payload.renderJob.status : "local preview");
      setText("sceneLabel", "Scene " + (scene.order || 1) + " - " + (scene.camera || "draft"));
      setText("beat", scene.beat || "Preview ready");
      setText("narration", scene.narration || "No scene yet.");
      setText("caption", scene.caption || payload.safety.note);
      setText("visual", scene.visualDirection || payload.project.style);
      setText("asset", scene.assetPrompt || "");
      setText("counter", scenes.length ? (index + 1) + "/" + scenes.length : "0/0");
      byId("progress").style.width = progress() + "%";
      byId("play").textContent = playing ? "Pause" : "Play";
      renderTimeline();
    }
    function stop() { playing = false; clearTimeout(timer); timer = null; }
    function next() { if (!scenes.length) return; index = Math.min(index + 1, scenes.length - 1); if (index === scenes.length - 1) stop(); render(); }
    function prev() { if (!scenes.length) return; index = Math.max(index - 1, 0); stop(); render(); }
    function scheduleNext() {
      // Real-time playback: hold each scene for its own edited duration instead of a
      // flat interval, so a 42s scene actually plays for 42s and a 7s scene advances fast.
      const scene = scenes[index] || {};
      const waitMs = Math.max(300, (scene.durationSeconds || 1.4) * 1000);
      timer = setTimeout(() => {
        if (!playing) return;
        next();
        if (playing) scheduleNext();
      }, waitMs);
    }
    function toggle() {
      if (playing) { stop(); render(); return; }
      playing = true;
      render();
      scheduleNext();
    }
    byId("prev").addEventListener("click", prev);
    byId("next").addEventListener("click", next);
    byId("play").addEventListener("click", toggle);
    render();
  </script>
</body>
</html>`;
}

export function loadCreatorRenderQueue(storage) {
  const db = storageOf(storage);
  if (!db) return { activeJobId: "", jobs: [] };
  const parsed = parseJson(db.getItem(THE_CREATOR_RENDER_QUEUE_STORAGE_KEY), { activeJobId: "", jobs: [] });
  return {
    activeJobId: parsed.activeJobId || "",
    jobs: Array.isArray(parsed.jobs) ? parsed.jobs : [],
  };
}

export function saveCreatorRenderJob(job, storage) {
  const db = storageOf(storage);
  const current = loadCreatorRenderQueue(db);
  const jobs = [job, ...current.jobs.filter((item) => item.id !== job.id)].slice(0, 20);
  const next = { activeJobId: job.id, jobs };
  if (db) db.setItem(THE_CREATOR_RENDER_QUEUE_STORAGE_KEY, JSON.stringify(next));
  return next;
}

export function getActiveCreatorRenderJob(storage) {
  const queue = loadCreatorRenderQueue(storage);
  return queue.jobs.find((item) => item.id === queue.activeJobId) || queue.jobs[0] || null;
}

function flowNode(id, typeId, x, y, label, desc, config = {}) {
  return { id, typeId, x, y, label, desc, status: "idle", feedback: "", config };
}

function flowEdge(id, from, to, branch) {
  return { id, from, to, ...(branch ? { branch } : {}) };
}

function stringify(value) {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return "{}";
  }
}

export function createCreatorFlowHandoff(project = {}) {
  const manifest = createCreatorExportManifest(project);
  const pending = (project.approvals || []).filter((gate) => gate.status !== "approved").map((gate) => gate.id);
  const manifestJson = stringify(manifest);
  const nodes = [
    flowNode("n1", "trigger-manual", 80, 180, "Start Creator run", "Manual Safe Autopilot trigger from THE CREATOR.", {
      source: "the-creator",
      projectId: project.id,
    }),
    flowNode("n2", "ai-write-content", 340, 100, "Script + caption finalizer", "Refine narration, hooks, captions, page dialogue, and CTA.", {
      topic: project.title,
      prompt: `${project.brief}\n\nReturn clean script, captions, dialogue, and review notes.`,
      approvalRequired: true,
    }),
    flowNode("n3", "media-prompt", 610, 100, "Scene prompt pack", "Prepare original prompts for video, illustration, animation, and comic panels.", {
      prompts: (project.illustrationPrompts || []).map((item) => item.prompt).join("\n\n"),
      style: project.style,
      referencePolicy: "Structure-only inspiration; do not copy protected source material.",
    }),
    flowNode("n4", "media-video", 880, 100, "Draft visual assembly", "Local/paper draft instructions; live render disabled until approval.", {
      liveProviderExecutionEnabled: false,
      manifestJson,
      approvalRequired: true,
    }),
    flowNode("n5", "logic-if-else", 1150, 100, "Approvals cleared?", "Hold render/publish if source, script, asset, or publish approvals are missing.", {
      condition: pending.length ? `pending approvals: ${pending.join(", ")}` : "approved",
    }),
    flowNode("n6", "dev-code-run", 1420, 40, "Write manifest", "Persist the deterministic Creator manifest.", {
      language: "JavaScript",
      code: `return ${manifestJson};`,
      approvalRequired: false,
    }),
    flowNode("n7", "ai-agent", 1420, 210, "Create owner review note", "List approvals needed before paid render, source use, or publishing.", {
      prompt: `Project ${project.title || "Creator project"} needs review. Pending approvals: ${pending.join(", ") || "none"}.`,
    }),
  ];
  return {
    id: `creator-handoff-${project.id || Date.now()}`,
    workflowId: `creator-${slug(project.id || project.title || "project")}`,
    name: `THE CREATOR: ${project.title || "Creative project"}`,
    source: "the-creator",
    createdAt: new Date().toISOString(),
    projectId: project.id,
    nodes,
    edges: [
      flowEdge("e1", "n1", "n2"),
      flowEdge("e2", "n2", "n3"),
      flowEdge("e3", "n3", "n4"),
      flowEdge("e4", "n4", "n5"),
      flowEdge("e5", "n5", "n6", "approved"),
      flowEdge("e6", "n5", "n7", "needs-review"),
    ],
    lifecycle: "draft",
    runtime: {
      target: "way-ai-flow",
      externalExecutionEnabled: false,
      approvalRequiredActions: ["paid render", "external publish", "source asset use"],
    },
    manifest,
  };
}

export function saveCreatorFlowHandoff(handoff, storage) {
  const db = storageOf(storage);
  if (db) db.setItem(THE_CREATOR_FLOW_HANDOFF_STORAGE_KEY, JSON.stringify(handoff));
  return handoff;
}
