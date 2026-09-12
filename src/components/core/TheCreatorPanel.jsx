import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  Check,
  CheckCircle2,
  Clapperboard,
  Download,
  Film,
  HelpCircle,
  Image as ImageIcon,
  Layers3,
  LibraryBig,
  Drama,
  Loader2,
  Mic,
  Pause,
  Palette,
  Play,
  Save,
  Scissors,
  ShieldCheck,
  Sparkles,
  SkipBack,
  SkipForward,
  Volume2,
  VolumeX,
  Wand2,
} from "lucide-react";
import { generateIllustration } from "../../services/WayIllustrateAdapter.js";
import { applyConsistency } from "./creatorConsistency.js";
import { routeForShot } from "./creatorShotRouting.js";
import { generateVideo } from "../../services/WayVideoAdapter.js";
import { resolveProviderCapabilities } from "../../services/AIProviderCapabilityResolver.js";
import { listAssets } from "../../services/CreatorStudioApiClient.js";
import { isRenderAvailable, renderEpisode } from "../../lib/CreatorFfmpegAdapter.js";
import {
  applyCreatorAIScript,
  approveCreatorGate,
  CREATOR_FORMATS,
  createCreatorProject,
  createCreatorPreviewHtml,
  createCreatorRenderJob,
  getActiveCreatorProject,
  loadCreatorProjectLibrary,
  loadCreatorRenderQueue,
  reorderCreatorScene,
  saveCreatorProject,
  saveCreatorRenderJob,
  summarizeCreatorProject,
  updateCreatorAnimationLayer,
  updateCreatorScene,
} from "./theCreatorEngine.js";
import { generateCreatorScriptWithAI } from "../../services/WayCreatorScriptAdapter.js";
import { CreatorAssetLibrary } from "./CreatorAssetLibrary.jsx";
import CreatorNarrationRoom from "./CreatorNarrationRoom.jsx";
import CreatorDramaRoom from "./CreatorDramaRoom.jsx";
import CreatorExportPanel from "./CreatorExportPanel.jsx";
import CreatorAutoReel from "./CreatorAutoReel.jsx";
import { isAutoReelRequest } from "./creatorAutoPipeline.js";
import TutorialCoach, { useTutorialCoach } from "./TutorialCoach.jsx";
import "./TheCreatorPanel.css";

const CREATOR_TOUR_STEPS = [
  {
    target: '[data-tour="creator-brief"]',
    title: "Start with one brief",
    body: "Tell NOVA what to create in plain language. One brief becomes a storyboard, clips, animation, comics, illustration prompts, and a footage manifest together.",
  },
  {
    target: '[data-tour="creator-build"]',
    title: "Build the plan",
    body: "This turns your brief into a full local plan across every room — nothing is sent anywhere, it all runs on-device.",
  },
  {
    target: '[data-tour="creator-rooms"]',
    title: "Each room is dedicated",
    body: "Storyboard, Clips, Animation, Comics, Illustration, Footage, Asset Library, Narration, Drama, Export, and more each get their own full screen instead of being crammed into one grid.",
  },
  {
    target: '[data-tour="creator-preview"]',
    title: "Preview plays it back",
    body: "Preview plays your storyboard in real time. Pick a scene from the timeline to edit its duration, caption, and narration, or reorder scenes with the up/down arrows.",
  },
  {
    target: '[data-tour="creator-gates"]',
    title: "Readiness gates",
    body: "These are the safety gates. Nothing renders or publishes live until you approve each one here.",
  },
  {
    target: '[data-tour="creator-vault"]',
    title: "Output vault",
    body: "Download the full Creator Pack, a single room's output, a draft render job, or a standalone HTML preview you can open outside the app.",
  },
];

const DEFAULT_BRIEF = "Create a 35-second reel, clip pack, animation board, and comic page about NOVA running a company operating system.";

function greetingForHour(hour) {
  if (hour < 5) return "Working late";
  if (hour < 12) return "Good morning";
  if (hour < 18) return "Good afternoon";
  return "Good evening";
}

function roomStatus(count) {
  if (!count) return { key: "empty", label: "Not started" };
  if (count < 3) return { key: "started", label: "In progress" };
  return { key: "ready", label: "Ready" };
}

const ROOM_PROGRESS_DOTS = 5;

const ILLUSTRATION_STYLE_OPTIONS = [
  { value: "flat", label: "Flat vector" },
  { value: "realistic", label: "Realistic" },
  { value: "3d", label: "3D render" },
  { value: "sketch", label: "Sketch" },
  { value: "icon", label: "Icon" },
];

const ILLUSTRATION_ASPECT_OPTIONS = [
  { value: "1:1", label: "Square (1:1)" },
  { value: "16:9", label: "Wide (16:9)" },
  { value: "9:16", label: "Tall (9:16)" },
];

const ILLUSTRATION_FALLBACK_ASPECT = "1:1";

// Non-square sizes are the most common source of a provider-side generation failure
// (unsupported dimensions for the active model/account). Retrying once at a safe square
// size turns that into a usable draft instead of a dead end, and the caller is told so
// the user knows why the result doesn't match the size they picked.
async function generateIllustrationWithFallback({ prompt, style, aspectRatio }, manager) {
  try {
    const result = await generateIllustration({ prompt, style, aspectRatio }, manager);
    return { ...result, requestedAspectRatio: aspectRatio, usedFallbackSize: false };
  } catch (originalError) {
    if (aspectRatio === ILLUSTRATION_FALLBACK_ASPECT) throw originalError;
    try {
      const retryResult = await generateIllustration({ prompt, style, aspectRatio: ILLUSTRATION_FALLBACK_ASPECT }, manager);
      return { ...retryResult, requestedAspectRatio: aspectRatio, usedFallbackSize: true };
    } catch {
      throw originalError;
    }
  }
}

// stage groups the room nav into the production pipeline order (Concept &
// Input -> Pre-production & Assets -> Generation & Media -> Export) — purely
// a nav-grouping label, rendered as small section headers in
// .creator-room-rail (see STAGE_LABELS below). Overview and Preview stay
// their own separate always-visible buttons above this list (unrelated to
// CREATOR_ROOMS/roomStats), so they aren't part of any stage here.
const CREATOR_ROOMS = [
  { id: "narration", label: "Narration", icon: Mic, note: "Paste source text, split into a real storyboard, generate per-scene image + voiceover — persisted, real cost/version tracking.", unit: "scenes", stage: "input" },
  { id: "drama", label: "Drama", icon: Drama, note: "Paste a story/screenplay excerpt, extract a real character/scene/prop Lorebook, plan real episodes.", unit: "episodes", stage: "input" },
  { id: "assets", label: "Asset Library", icon: LibraryBig, note: "Reusable character, scene, prop, and product references — persisted, not just local drafts.", unit: "assets", stage: "assets" },
  { id: "storyboard", label: "Storyboard", icon: Layers3, note: "Scene-by-scene script, timing, camera, captions.", unit: "scenes", stage: "assets" },
  { id: "clips", label: "Clips", icon: Scissors, note: "Short-form cut windows with hook scores.", unit: "clips", stage: "generation" },
  { id: "animation", label: "Animation", icon: Sparkles, note: "Motion layers, camera moves, transitions.", unit: "layers", stage: "generation" },
  { id: "comics", label: "Comics", icon: Palette, note: "Panel layout, dialogue, character continuity.", unit: "panels", stage: "generation" },
  { id: "illustration", label: "Illustration", icon: ImageIcon, note: "Prompt queue with live draft preview.", unit: "prompts", stage: "generation" },
  { id: "footage", label: "Footage", icon: Film, note: "Asset manifest, source policy, rights checks.", unit: "assets", stage: "generation" },
  { id: "export", label: "Export", icon: Download, note: "CapCut draft export, or render locally to MP4 on desktop.", unit: "episodes", stage: "output" },
];

// Step 1 of the pipeline: pick what you are making, and the rest of the
// project (aspect, lanes, default look) follows from it.
const PROJECT_TYPES = [
  { id: "reel",    label: "Reel / Short",   hint: "9:16, hook-first, dynamic captions", formatId: "reel_9x16",       lanes: ["reels", "clips", "footage"],          style: "cinematic, high contrast" },
  { id: "film",    label: "Film / Story",   hint: "16:9, cinematic screenplay",         formatId: "wide_16x9",       lanes: ["animation", "footage", "illustration"], style: "cinematic, filmic lighting" },
  { id: "comic",   label: "Comic / Novel",  hint: "Panel pages with dialogue",          formatId: "comic_page",      lanes: ["comics", "illustration"],              style: "inked comic, bold linework" },
  { id: "product", label: "Product ad",     hint: "Product shots, multi-aspect",        formatId: "square_1x1",      lanes: ["reels", "illustration", "footage"],    style: "clean studio product lighting" },
];

const STAGE_LABELS = {
  input: "Concept & Input",
  assets: "Pre-production & Assets",
  generation: "Generation & Media",
  output: "Export & Output",
};

// Column order for the Overview page's pipeline view (creator-pipeline) —
// same 4 stages as the nav rail's group headers, just also driving the
// horizontal Step 1/2/3/4 column layout there.
const PIPELINE_STAGE_ORDER = ["input", "assets", "generation", "output"];

const PREVIEW_ROOM = {
  id: "preview",
  // Matches the nav pill's own hardcoded "Preview" text (this object's
  // .label also feeds the room header and the output-vault artifact list —
  // those used to read "Render Preview" while the nav pill next to them
  // said "Preview", a small naming inconsistency).
  label: "Preview",
  icon: Play,
  note: "Playable local scene preview from storyboard and render queue.",
  unit: "scenes",
};

const CREATOR_NODE = {
  id: "creator_studio",
  label: "THE CREATOR",
  departmentId: "creator_studio",
  capabilityId: "creator_project_plan",
  type: "workspace",
  risk: "approval_required",
};

function isCreatorCommand(text = "") {
  return /\b(creator|reel|short|clip|clipping|comic|panel|animation|animate|storyboard|footage|montage|video|illustration|image|visual asset)\b/i.test(String(text || ""));
}

function isOpenOnly(text = "") {
  const clean = String(text || "").toLowerCase();
  return /\b(open|show|launch)\b/.test(clean) && !/\b(create|make|plan|generate|build|about|for|clip|animate)\b/.test(clean);
}

function outputCount(project, id) {
  if (id === "preview") return project?.storyboard?.length || 0;
  if (id === "storyboard") return project?.storyboard?.length || 0;
  if (id === "clips") return project?.clipCandidates?.length || 0;
  if (id === "animation") return project?.animationPlan?.layers?.length || 0;
  if (id === "comics") return project?.comicPanels?.length || 0;
  if (id === "illustration") return project?.illustrationPrompts?.length || 0;
  if (id === "footage") return project?.footageManifest?.assets?.length || 0;
  return 0;
}

function statusIcon(status) {
  return status === "ready" || status === "approved" ? <CheckCircle2 size={13} /> : <AlertTriangle size={13} />;
}

function safeJson(value) {
  return JSON.stringify(value, null, 2);
}

function slugText(value = "creator-output") {
  return String(value || "creator-output")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 54) || "creator-output";
}

function downloadText(filename, content, type = "text/plain") {
  if (typeof document === "undefined" || typeof URL === "undefined" || typeof Blob === "undefined") return;
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

function storyboardMarkdown(project = {}) {
  return [
    `# ${project.title || "Creator Project"} - Storyboard`,
    "",
    ...(project.storyboard || []).map((scene) => [
      `## ${scene.order}. ${scene.beat}`,
      `- Duration: ${scene.durationSeconds || "page"}s`,
      `- Camera: ${scene.camera}`,
      `- Narration: ${scene.narration}`,
      `- Caption: ${scene.caption}`,
      `- Visual: ${scene.visualDirection}`,
    ].join("\n")),
  ].join("\n\n");
}

function clipsMarkdown(project = {}) {
  return [
    `# ${project.title || "Creator Project"} - Clip Cut List`,
    "",
    ...(project.clipCandidates || []).map((clip) => [
      `## ${clip.title}`,
      `- Window: ${clip.startSecond}s-${clip.endSecond}s`,
      `- Score: ${clip.score}`,
      `- Hook: ${clip.captionHook}`,
      `- Reason: ${clip.hookReason}`,
      `- Export fit: ${clip.exportFit}`,
    ].join("\n")),
  ].join("\n\n");
}

function animationMarkdown(project = {}) {
  return [
    `# ${project.title || "Creator Project"} - Animation Board`,
    "",
    `Rhythm: ${project.animationPlan?.rhythm || "planned"}`,
    "",
    ...(project.animationPlan?.layers || []).map((layer, index) => [
      `## ${index + 1}. ${layer.label}`,
      `- Instruction: ${layer.instruction}`,
      `- Linked scenes: ${(layer.sceneIds || []).join(", ") || "none"}`,
    ].join("\n")),
    "",
    `Reduced motion fallback: ${project.animationPlan?.reducedMotionFallback || "Static frame fallback."}`,
  ].join("\n\n");
}

function comicsMarkdown(project = {}) {
  return [
    `# ${project.title || "Creator Project"} - Comic Board`,
    "",
    ...(project.comicPanels || []).map((panel) => [
      `## Panel ${panel.order}: ${panel.title}`,
      `- Frame: ${panel.frame}`,
      `- Dialogue: ${panel.dialogue}`,
      `- Continuity: ${panel.characterContinuity}`,
      `- Visual prompt: ${panel.visualPrompt}`,
      `- Quality gate: ${panel.qualityGate}`,
    ].join("\n")),
  ].join("\n\n");
}

function illustrationMarkdown(project = {}, generatedImage) {
  return [
    `# ${project.title || "Creator Project"} - Illustration Prompts`,
    "",
    ...(project.illustrationPrompts || []).map((item, index) => [
      `## Prompt ${index + 1}`,
      `- Aspect: ${item.aspectRatio}`,
      `- Style: ${item.style}`,
      `- Usage: ${item.usagePolicy}`,
      "",
      item.prompt,
    ].join("\n")),
    generatedImage ? [
      "",
      "## Latest generated draft",
      `- Provider: ${generatedImage.provider}`,
      `- URL: ${generatedImage.url}`,
      `- Prompt: ${generatedImage.prompt}`,
    ].join("\n") : "",
  ].join("\n\n");
}

function footageMarkdown(project = {}) {
  return [
    `# ${project.title || "Creator Project"} - Footage Manifest`,
    "",
    `Source policy: ${project.footageManifest?.sourcePolicy || "Review before publish."}`,
    "",
    ...(project.footageManifest?.assets || []).map((asset) => [
      `## ${asset.id}`,
      `- Kind: ${asset.kind}`,
      `- Status: ${asset.status}`,
      `- Rights: ${asset.licenseRequired ? "rights check required" : "internal draft"}`,
      `- Note: ${asset.note}`,
    ].join("\n")),
  ].join("\n\n");
}

function previewMarkdown(project = {}) {
  const totalSeconds = (project.storyboard || []).reduce((sum, scene) => sum + (scene.durationSeconds || 0), 0);
  return [
    `# ${project.title || "Creator Project"} - Local Render Preview Script`,
    "",
    `Preview duration: ${totalSeconds || "page"}s`,
    `Format: ${project.format?.label || "draft"}`,
    `Style: ${project.style || "monochrome cinematic"}`,
    "",
    ...(project.storyboard || []).map((scene) => [
      `## Scene ${scene.order}: ${scene.beat}`,
      `- Duration: ${scene.durationSeconds || "page"}s`,
      `- Camera: ${scene.camera}`,
      `- Narration: ${scene.narration}`,
      `- Caption: ${scene.caption}`,
      `- Visual direction: ${scene.visualDirection}`,
      `- Asset prompt: ${scene.assetPrompt}`,
    ].join("\n")),
  ].join("\n\n");
}

function creatorOutputPack(project = {}, generatedImage = null) {
  return {
    generatedAt: new Date().toISOString(),
    studio: "THE CREATOR",
    ownerAgentId: "wayaiagent",
    safety: {
      mode: "safe_autopilot_v1",
      localOutputsReady: true,
      liveRenderEnabled: false,
      externalPublishEnabled: false,
    },
    project: {
      id: project.id,
      title: project.title,
      brief: project.brief,
      format: project.format,
      style: project.style,
      readiness: project.readiness,
      originPolicy: project.originPolicy,
    },
    outputs: {
      storyboard: project.storyboard || [],
      clips: project.clipCandidates || [],
      animation: project.animationPlan || {},
      comics: project.comicPanels || [],
      illustration: {
        prompts: project.illustrationPrompts || [],
        latestGeneratedDraft: generatedImage,
      },
      footage: project.footageManifest || {},
      qualityGates: project.qualityGates || [],
    },
  };
}

function roomOutput(project, roomId, generatedImage) {
  const base = slugText(project.title || "creator");
  if (roomId === "preview") return { filename: `${base}-render-preview.md`, content: previewMarkdown(project), type: "text/markdown" };
  if (roomId === "storyboard") return { filename: `${base}-storyboard.md`, content: storyboardMarkdown(project), type: "text/markdown" };
  if (roomId === "clips") return { filename: `${base}-clips.md`, content: clipsMarkdown(project), type: "text/markdown" };
  if (roomId === "animation") return { filename: `${base}-animation.md`, content: animationMarkdown(project), type: "text/markdown" };
  if (roomId === "comics") return { filename: `${base}-comics.md`, content: comicsMarkdown(project), type: "text/markdown" };
  if (roomId === "illustration") return { filename: `${base}-illustration.md`, content: illustrationMarkdown(project, generatedImage), type: "text/markdown" };
  if (roomId === "footage") return { filename: `${base}-footage.md`, content: footageMarkdown(project), type: "text/markdown" };
  return { filename: `${base}-creator-pack.json`, content: safeJson(creatorOutputPack(project, generatedImage)), type: "application/json" };
}

export default function TheCreatorPanel({
  selectedNode = CREATOR_NODE,
  voiceCommandSignal,
  onRun,
  runBusy,
  manager,
  leftOpen = true,
  rightOpen = true,
}) {
  const firstProject = getActiveCreatorProject() || createCreatorProject({ brief: DEFAULT_BRIEF, pipelineId: "creator-all" });
  const [brief, setBrief] = useState(() => firstProject.brief || DEFAULT_BRIEF);
  const [style, setStyle] = useState(() => firstProject.style || "monochrome cinematic");
  const [formatId, setFormatId] = useState(() => firstProject.format?.id || "reel_9x16");
  const [projectType, setProjectType] = useState("reel");
  const [aiScriptBusy, setAiScriptBusy] = useState(false);
  const [aiScriptError, setAiScriptError] = useState("");
  const [project, setProject] = useState(() => firstProject);
  const [library, setLibrary] = useState(() => loadCreatorProjectLibrary());
  const [renderQueue, setRenderQueue] = useState(() => loadCreatorRenderQueue());
  const [activeRoomId, setActiveRoomId] = useState("overview");
  const [autoReelSignal, setAutoReelSignal] = useState(null);
  const tutorial = useTutorialCoach("wayai.theCreator.tutorialSeen.v1");
  const [imageBusyId, setImageBusyId] = useState("");
  const [imageError, setImageError] = useState("");
  const [generatedImage, setGeneratedImage] = useState(null);
  const [customPrompt, setCustomPrompt] = useState("");
  const [customStyle, setCustomStyle] = useState("realistic");
  const [customAspect, setCustomAspect] = useState("1:1");
  const [editingPromptId, setEditingPromptId] = useState(null);
  const [promptSaved, setPromptSaved] = useState(false);
  const [outputReadyAt, setOutputReadyAt] = useState(() => firstProject.updatedAt || firstProject.createdAt || new Date().toISOString());
  const [previewIndex, setPreviewIndex] = useState(0);
  const [previewPlaying, setPreviewPlaying] = useState(false);
  const [voiceEnabled, setVoiceEnabled] = useState(false);
  const [sceneDraft, setSceneDraft] = useState(null);
  const [sceneSaved, setSceneSaved] = useState(false);
  const [bulkImageBusy, setBulkImageBusy] = useState(false);
  const [sceneImageBusy, setSceneImageBusy] = useState("");
  const [sceneMotionBusy, setSceneMotionBusy] = useState("");
  const [motionError, setMotionError] = useState("");
  // True only when an account that can actually lip-sync is connected.
  const hasLipSyncAccount = useMemo(
    () => resolveProviderCapabilities(manager, "lipsync-generation").length > 0,
    [manager],
  );
  const savedAssetsRef = useRef(null);
  const [bulkImageProgress, setBulkImageProgress] = useState(null);
  const [renderBusy, setRenderBusy] = useState(false);
  const [renderError, setRenderError] = useState("");
  const [renderResult, setRenderResult] = useState("");
  const [renderProgress, setRenderProgress] = useState(null);

  const activeRoom = [PREVIEW_ROOM, ...CREATOR_ROOMS].find((room) => room.id === activeRoomId);
  const ActiveRoomIcon = activeRoom?.icon || Film;
  const savedCount = library.projects?.length || 1;
  const readyGateCount = (project.qualityGates || []).filter((gate) => gate.status === "ready" || gate.status === "approved").length;
  const pendingQualityGates = (project.qualityGates || []).filter((gate) => gate.status !== "ready" && gate.status !== "approved");
  const outputPack = useMemo(() => creatorOutputPack(project, generatedImage), [generatedImage, project]);
  const latestRenderJob = renderQueue.jobs.find((job) => job.id === renderQueue.activeJobId) || renderQueue.jobs[0] || null;
  const previewScenes = project.storyboard || [];
  const activePreviewScene = previewScenes[previewIndex] || previewScenes[0] || null;
  const totalPreviewDuration = previewScenes.reduce((sum, scene) => sum + (scene.durationSeconds || 0), 0);
  const elapsedPreviewDuration = previewScenes.slice(0, previewIndex).reduce((sum, scene) => sum + (scene.durationSeconds || 0), 0);
  const previewProgress = totalPreviewDuration
    ? Math.min(100, Math.round(((elapsedPreviewDuration + (activePreviewScene?.durationSeconds || 0)) / totalPreviewDuration) * 100))
    : 0;

  const hydrate = useCallback((next) => {
    if (!next) return;
    setProject(next);
    setBrief(next.brief || DEFAULT_BRIEF);
    setStyle(next.style || "monochrome cinematic");
    setFormatId(next.format?.id || "reel_9x16");
    setImageError("");
    setOutputReadyAt(new Date().toISOString());
  }, []);

  useEffect(() => {
    setLibrary(saveCreatorProject(project));
  }, [project]);

  useEffect(() => {
    const text = voiceCommandSignal?.text || "";
    // "30 second technology reel tayaru chey" means make the finished video,
    // not plan a storyboard — hand it to the Auto reel room, which runs the
    // whole pipeline.
    if (text && isAutoReelRequest(text)) {
      setActiveRoomId("autoreel");
      setAutoReelSignal({ id: voiceCommandSignal?.id || Date.now(), text });
      return;
    }
    if (!text || !isCreatorCommand(text) || isOpenOnly(text)) return;
    const next = createCreatorProject({ brief: text, pipelineId: "creator-all", style, format: formatId });
    hydrate(next);
    setActiveRoomId("overview");
  }, [formatId, hydrate, style, voiceCommandSignal?.id, voiceCommandSignal?.text]);

  useEffect(() => {
    setPreviewIndex(0);
    setPreviewPlaying(false);
  }, [project.id]);

  useEffect(() => {
    if (!previewPlaying || previewScenes.length <= 1) return undefined;
    // Real-time playback: each scene holds for its own edited duration instead of a flat
    // interval, so a 42s scene actually plays for 42s and a 7s scene advances quickly.
    const waitMs = Math.max(300, (activePreviewScene?.durationSeconds || 1.4) * 1000);
    const timer = window.setTimeout(() => {
      setPreviewIndex((current) => {
        if (current >= previewScenes.length - 1) {
          setPreviewPlaying(false);
          return current;
        }
        return current + 1;
      });
    }, waitMs);
    return () => window.clearTimeout(timer);
  }, [previewPlaying, previewScenes.length, activePreviewScene?.id, activePreviewScene?.durationSeconds]);

  useEffect(() => {
    if (!activePreviewScene) {
      setSceneDraft(null);
      return;
    }
    setSceneDraft({
      id: activePreviewScene.id,
      durationSeconds: activePreviewScene.durationSeconds,
      caption: activePreviewScene.caption || "",
      narration: activePreviewScene.narration || "",
    });
    setSceneSaved(false);
  }, [activePreviewScene?.id]);

  // VoiceDesk narration: reads each scene's narration aloud in sync with real-time
  // playback using the browser's own speech synthesis — a genuinely working local voice,
  // not a placeholder. No account, no API key, no network call.
  useEffect(() => {
    if (typeof window === "undefined" || !window.speechSynthesis) return undefined;
    if (!voiceEnabled || !previewPlaying || !activePreviewScene?.narration) {
      window.speechSynthesis.cancel();
      return undefined;
    }
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(activePreviewScene.narration);
    window.speechSynthesis.speak(utterance);
    return () => window.speechSynthesis.cancel();
  }, [voiceEnabled, previewPlaying, activePreviewScene?.id, activePreviewScene?.narration]);

  useEffect(() => () => {
    if (typeof window !== "undefined" && window.speechSynthesis) window.speechSynthesis.cancel();
  }, []);

  const roomStats = useMemo(() => CREATOR_ROOMS.map((room) => ({
    ...room,
    count: outputCount(project, room.id),
  })), [project]);
  // Real preview thumbnails for the Overview room tiles, best-effort per
  // room — falls back to the tile's own designed placeholder (icon + glow,
  // see .creator-tile in CSS) when nothing's been generated yet. Only wired
  // for rooms whose data model can actually carry an image today; the rest
  // intentionally show the placeholder rather than a broken/empty <img>.
  const firstSceneImage = useMemo(
    () => (project.storyboard || []).find((scene) => scene.imageUrl)?.imageUrl || null,
    [project.storyboard],
  );
  const roomPreviewImage = useMemo(() => ({
    illustration: generatedImage?.url || null,
    narration: firstSceneImage,
    drama: firstSceneImage,
    storyboard: firstSceneImage,
  }), [generatedImage, firstSceneImage]);
  const outputArtifacts = useMemo(() => [PREVIEW_ROOM, ...CREATOR_ROOMS].map((room) => {
    const output = roomOutput(project, room.id, generatedImage);
    return {
      ...room,
      count: outputCount(project, room.id),
      filename: room.id === "preview" ? `${slugText(project.title)}-preview.html` : output.filename,
    };
  }), [generatedImage, project]);

  const metrics = [
    { label: "Readiness", value: `${project.readiness || 0}%` },
    { label: "Scenes", value: project.storyboard?.length || 0 },
    { label: "Clips", value: project.clipCandidates?.length || 0 },
    { label: "Panels", value: project.comicPanels?.length || 0 },
  ];

  function buildProject() {
    // The chosen project type decides which rooms this project is about
    // (a comic has no clip lane, a reel has no comic panels).
    const type = PROJECT_TYPES.find((item) => item.id === projectType) || PROJECT_TYPES[0];
    const next = createCreatorProject({ brief, pipelineId: "creator-all", style, format: formatId, lanes: type.lanes });
    hydrate(next);
    setActiveRoomId("overview");
    onRun?.("draft", selectedNode, `THE CREATOR plan: ${next.title}`);
  }

  // "Build plan" is the instant, free, template-filled structure (durations, lanes,
  // approval gates). This is the honest opt-in upgrade: it asks a real model to write
  // original narration/camera/caption/visual-direction for the CURRENT storyboard,
  // grounded in the actual brief, instead of the fixed per-beat sentence templates.
  // Requires sign-in and costs credits (same managed path Way AI Flow's AI nodes use) —
  // surfaced honestly if it fails rather than silently falling back to the templates.
  async function generateScriptWithAI() {
    if (aiScriptBusy || !project.storyboard?.length) return;
    setAiScriptBusy(true);
    setAiScriptError("");
    try {
      const aiScenes = await generateCreatorScriptWithAI({
        brief: project.brief,
        formatLabel: project.format?.label,
        formatAspect: project.format?.aspect,
        durationSeconds: project.format?.duration,
        style: project.style,
        beats: project.storyboard.map((scene) => scene.beat),
        manager,
      });
      setProject((current) => applyCreatorAIScript(current, aiScenes));
    } catch (error) {
      const rawMessage = String(error?.message || "").trim();
      const isUninformative = !rawMessage || rawMessage === "{}" || rawMessage === "[object Object]";
      const friendlyMessage = rawMessage === "CREDITS_EXHAUSTED"
        ? "Out of credits — top up to keep using AI script generation."
        : rawMessage === "Not authenticated"
          ? "Sign in to use AI script generation (Build plan works without sign-in; this needs an account)."
          : isUninformative
            ? "AI script generation failed. Check sign-in and credits, then try again."
            : rawMessage;
      setAiScriptError(friendlyMessage);
    } finally {
      setAiScriptBusy(false);
    }
  }

  function downloadCreatorPack() {
    const filename = `${slugText(project.title)}-creator-pack.json`;
    downloadText(filename, safeJson(outputPack), "application/json");
  }

  function downloadActiveRoomOutput() {
    const output = roomOutput(project, activeRoomId, generatedImage);
    downloadText(output.filename, output.content, output.type);
  }

  function downloadRoomOutput(roomId) {
    const output = roomOutput(project, roomId, generatedImage);
    downloadText(output.filename, output.content, output.type);
  }

  function createDraftRenderJob() {
    const job = createCreatorRenderJob(project);
    setRenderQueue(saveCreatorRenderJob(job));
    onRun?.("approval_required", selectedNode, `THE CREATOR draft render queued: ${job.title}`);
  }

  function openPreview() {
    setActiveRoomId("preview");
  }

  function movePreview(delta) {
    setPreviewPlaying(false);
    setPreviewIndex((current) => {
      const next = current + delta;
      return Math.max(0, Math.min(Math.max(0, previewScenes.length - 1), next));
    });
  }

  function moveScene(sceneId, direction) {
    const index = previewScenes.findIndex((scene) => scene.id === sceneId);
    const targetIndex = index + (direction < 0 ? -1 : 1);
    if (index < 0 || targetIndex < 0 || targetIndex >= previewScenes.length) return;
    setPreviewPlaying(false);
    setProject((current) => reorderCreatorScene(current, sceneId, direction));
    setPreviewIndex(targetIndex);
  }

  function updateSceneDraft(field, value) {
    setSceneDraft((current) => (current ? { ...current, [field]: value } : current));
    setSceneSaved(false);
  }

  function saveSceneEdit() {
    if (!sceneDraft) return;
    setProject((current) => updateCreatorScene(current, sceneDraft.id, {
      durationSeconds: sceneDraft.durationSeconds,
      caption: sceneDraft.caption,
      captionPosition: sceneDraft.captionPosition || "bottom",
      narration: sceneDraft.narration,
    }));
    setSceneSaved(true);
    setTimeout(() => setSceneSaved(false), 1800);
  }

  const isSceneDraftDirty = !!sceneDraft && !!activePreviewScene && (
    Number(sceneDraft.durationSeconds) !== Number(activePreviewScene.durationSeconds)
    || sceneDraft.caption !== (activePreviewScene.caption || "")
    || sceneDraft.narration !== (activePreviewScene.narration || "")
  );

  function updateAnimationLayerText(layerId, instruction) {
    setProject((current) => updateCreatorAnimationLayer(current, layerId, instruction));
  }

  function approveNextQualityGate() {
    const nextGate = pendingQualityGates[0];
    if (!nextGate) return;
    setProject((current) => approveCreatorGate(current, nextGate.id));
  }

  function downloadRenderJob(job = latestRenderJob) {
    if (!job) return;
    downloadText(`${slugText(job.title)}-render-job.json`, safeJson(job), "application/json");
  }

  function downloadPreviewHtml() {
    const html = createCreatorPreviewHtml(project, { renderJob: latestRenderJob });
    downloadText(`${slugText(project.title)}-preview.html`, html, "text/html");
  }

  async function generatePromptAsset(promptItem) {
    if (!promptItem?.prompt || imageBusyId) return;
    setImageBusyId(promptItem.id);
    setImageError("");
    try {
      const result = await generateIllustrationWithFallback({
        prompt: promptItem.prompt,
        style: promptItem.style || "realistic",
        aspectRatio: promptItem.aspectRatio || "1:1",
      }, manager);
      setGeneratedImage({
        id: `${promptItem.id}_${Date.now()}`,
        url: result.url,
        prompt: promptItem.prompt,
        provider: result.provider,
        usedFallbackSize: result.usedFallbackSize,
        requestedAspectRatio: result.requestedAspectRatio,
      });
      // Attach the image to the scene it was generated for — this is what
      // actually makes the scene renderable; without it the storyboard has
      // captions/prompts but no picture to build a video from.
      if (promptItem.sceneId) {
        setProject((current) => updateCreatorScene(current, promptItem.sceneId, {
          imageUrl: result.url,
          imageProvider: result.provider,
        }));
      }
    } catch (error) {
      setImageError(error?.message || "Illustration generation failed. Check provider/account setup.");
    } finally {
      setImageBusyId("");
    }
  }

  // Generates (or re-generates) an image for every storyboard scene that
  // doesn't have one yet, one at a time so a single provider failure doesn't
  // abort the rest — this is the step that turns a planned storyboard into
  // something actually renderable to a real video file.
  // The saved Asset Library looks, fetched once and reused for every prompt
  // in this room so characters and props stay identical across scenes.
  async function savedAssets() {
    if (savedAssetsRef.current) return savedAssetsRef.current;
    savedAssetsRef.current = await listAssets({ limit: 60 }).catch(() => []);
    return savedAssetsRef.current;
  }

  // One scene, on demand — the button next to each storyboard card.
  async function generateSceneImage(scene) {
    if (sceneImageBusy) return;
    setSceneImageBusy(scene.id);
    setImageError("");
    try {
      const promptItem = (project.illustrationPrompts || []).find((item) => item.sceneId === scene.id);
      const basePrompt = promptItem?.prompt || `${project.title}. ${scene.beat}. ${scene.narration || scene.caption || ""}`;
      const result = await generateIllustrationWithFallback({
        prompt: applyConsistency(basePrompt, {
          sceneText: `${scene.beat} ${scene.narration || ""} ${scene.caption || ""}`,
          assets: await savedAssets(),
          style: project.style,
        }),
        style: promptItem?.style || "realistic",
        aspectRatio: promptItem?.aspectRatio || project.format?.aspectRatio || "9:16",
      }, manager);
      setProject((current) => updateCreatorScene(current, scene.id, { imageUrl: result.url, imageProvider: result.provider }));
    } catch (error) {
      setImageError(String(error?.message || error));
    } finally {
      setSceneImageBusy("");
    }
  }

  // Step 4: turn a scene into a real motion clip. Dialogue shots would go to
  // a lip-sync engine when one is connected; today they fall back to motion
  // video and say so, instead of claiming synced lips.
  async function generateSceneMotion(scene) {
    if (sceneMotionBusy) return;
    setSceneMotionBusy(scene.id);
    setMotionError("");
    try {
      const route = routeForShot(scene, { hasLipSync: hasLipSyncAccount });
      const prompt = applyConsistency(
        `${scene.visualDirection || scene.assetPrompt || scene.beat}. ${scene.camera || ""}`.trim(),
        { sceneText: `${scene.beat} ${scene.narration || ""}`, assets: await savedAssets(), style: project.style },
      );
      const result = await generateVideo({
        prompt,
        aspectRatio: project.format?.aspect || "9:16",
        durationSeconds: String(Math.max(4, Math.round(scene.durationSeconds || 6))),
        resourceType: "shot",
      }, manager);
      setProject((current) => updateCreatorScene(current, scene.id, {
        videoUrl: result.videoUri,
        videoRoute: result.route,
        shotRoute: route.engine,
        shotNote: route.note,
      }));
    } catch (error) {
      setMotionError(String(error?.message || error));
    } finally {
      setSceneMotionBusy("");
    }
  }

  async function generateAllSceneImages() {
    if (bulkImageBusy) return;
    const prompts = project.illustrationPrompts || [];
    if (!prompts.length) return;
    setBulkImageBusy(true);
    setImageError("");
    let failures = 0;
    for (let i = 0; i < prompts.length; i++) {
      const promptItem = prompts[i];
      const scene = (project.storyboard || []).find((s) => s.id === promptItem.sceneId);
      if (scene?.imageUrl) continue;
      setBulkImageProgress({ index: i + 1, total: prompts.length });
      try {
        const result = await generateIllustrationWithFallback({
          prompt: applyConsistency(promptItem.prompt, {
            sceneText: `${scene?.beat || ""} ${scene?.narration || ""} ${scene?.caption || ""}`,
            assets: await savedAssets(),
            style: project.style,
          }),
          style: promptItem.style || "realistic",
          aspectRatio: promptItem.aspectRatio || "1:1",
        }, manager);
        setProject((current) => updateCreatorScene(current, promptItem.sceneId, {
          imageUrl: result.url,
          imageProvider: result.provider,
        }));
      } catch {
        failures += 1;
      }
    }
    setBulkImageProgress(null);
    setBulkImageBusy(false);
    if (failures) setImageError(`${failures} of ${prompts.length} scene image(s) failed to generate — check provider/account setup and retry.`);
  }

  // Renders the active local project's storyboard into a real MP4 using the
  // desktop ffmpeg pipeline (CreatorFfmpegAdapter → creator_ffmpeg.rs) — the
  // same render path the Export room's remote-episode flow uses, wired here
  // so a locally-built "Build plan" project doesn't need a separate
  // server-persisted episode to become an actual video.
  async function renderLocalVideo() {
    if (renderBusy) return;
    const scenesWithImages = (project.storyboard || []).filter((scene) => scene.imageUrl || scene.videoUrl);
    if (!scenesWithImages.length) {
      setRenderError("Generate at least one scene image first.");
      return;
    }
    setRenderError("");
    setRenderResult("");
    setRenderProgress(null);

    let outputPath;
    try {
      const { save } = await import("@tauri-apps/plugin-dialog");
      outputPath = await save({
        defaultPath: `${slugText(project.title || "creator-project")}.mp4`,
        filters: [{ name: "MP4 video", extensions: ["mp4"] }],
      });
    } catch (error) {
      setRenderError(String(error?.message || error));
      return;
    }
    if (!outputPath) return;

    setRenderBusy(true);
    try {
      const outcome = await renderEpisode({
        scenes: scenesWithImages.map((scene) => ({
          // A generated motion clip wins over the still for that scene.
          imageUrl: scene.imageUrl,
          videoUrl: scene.videoUrl || undefined,
          durationSeconds: scene.durationSeconds,
          caption: scene.caption,
          captionPosition: scene.captionPosition || "bottom",
        })),
        outputPath,
        onProgress: (payload) => setRenderProgress(payload),
      });
      if (outcome.cancelled) {
        setRenderError("Render cancelled.");
      } else if (!outcome.success) {
        setRenderError(outcome.error || "Render failed.");
      } else {
        setRenderResult(outcome.outputPath);
      }
    } catch (error) {
      setRenderError(String(error?.message || error));
    } finally {
      setRenderBusy(false);
    }
  }

  // Loads an auto-generated storyboard prompt into the editable custom prompt box so it
  // can be tweaked before generating, instead of only running the fixed auto-prompt as-is.
  function editPromptInCustomEditor(promptItem) {
    setCustomPrompt(promptItem?.prompt || "");
    setCustomStyle(promptItem?.style || "realistic");
    setCustomAspect(promptItem?.aspectRatio || "1:1");
    setEditingPromptId(promptItem?.id || null);
    setPromptSaved(false);
  }

  // Writes the (possibly edited) custom prompt back into the project's prompt queue —
  // updates the source scene prompt in place if this came from "Edit", otherwise adds it
  // as a new standalone prompt, so an edit isn't lost the next time the queue is viewed.
  function saveCustomPrompt() {
    const trimmed = customPrompt.trim();
    if (!trimmed) return;
    setProject((current) => {
      const prompts = current.illustrationPrompts || [];
      const editingExisting = editingPromptId && prompts.some((item) => item.id === editingPromptId);
      const illustrationPrompts = editingExisting
        ? prompts.map((item) => item.id === editingPromptId
          ? { ...item, prompt: trimmed, style: customStyle, aspectRatio: customAspect }
          : item)
        : [
          ...prompts,
          {
            id: `illustration_custom_${Date.now()}`,
            prompt: trimmed,
            style: customStyle,
            aspectRatio: customAspect,
            usagePolicy: "Draft asset only; review before publish or customer-facing use.",
          },
        ];
      return { ...current, illustrationPrompts };
    });
    setPromptSaved(true);
    setTimeout(() => setPromptSaved(false), 1800);
  }

  async function generateCustomIllustration() {
    const trimmed = customPrompt.trim();
    if (!trimmed || imageBusyId) return;
    setImageBusyId("custom");
    setImageError("");
    try {
      const result = await generateIllustrationWithFallback({ prompt: trimmed, style: customStyle, aspectRatio: customAspect }, manager);
      setGeneratedImage({
        id: `custom_${Date.now()}`,
        url: result.url,
        prompt: trimmed,
        provider: result.provider,
        usedFallbackSize: result.usedFallbackSize,
        requestedAspectRatio: result.requestedAspectRatio,
      });
    } catch (error) {
      setImageError(error?.message || "Illustration generation failed. Check provider/account setup.");
    } finally {
      setImageBusyId("");
    }
  }

  return (
    <section className={`creator-panel creator-cockpit${leftOpen ? "" : " creator-left-collapsed"}${rightOpen ? "" : " creator-right-collapsed"}`} aria-label="THE CREATOR studio">
      <aside className="creator-left-rail">
        <div className="creator-brand-card">
          <div className="creator-kicker"><Sparkles size={14} /> WAYAI ORIGINAL</div>
          <h2>THE CREATOR</h2>
          <p>One working production OS for reels, clips, animation, comics, illustration, and footage.</p>
          <div className="creator-brand-row">
            <span className="creator-safe"><ShieldCheck size={13} /> local draft only</span>
            <button type="button" className="creator-tour-btn" onClick={tutorial.replay}>
              <HelpCircle size={13} /> Show tutorial
            </button>
          </div>
        </div>

        <section className="creator-command-card" aria-label="Creator prompt">
          <label data-tour="creator-brief">
            <span>NOVA creator prompt</span>
            <textarea
              value={brief}
              onChange={(event) => setBrief(event.target.value)}
              rows={5}
              placeholder="Tell NOVA what to create..."
            />
          </label>
          <div className="creator-type-picker" role="group" aria-label="Project type">
            <span className="creator-type-label">What are you making?</span>
            <div className="creator-type-row">
              {PROJECT_TYPES.map((type) => (
                <button
                  key={type.id}
                  type="button"
                  className={projectType === type.id ? "is-on" : ""}
                  aria-pressed={projectType === type.id}
                  onClick={() => {
                    setProjectType(type.id);
                    setFormatId(type.formatId);
                    if (!style.trim() || PROJECT_TYPES.some((item) => item.style === style)) setStyle(type.style);
                  }}
                >
                  <b>{type.label}</b>
                  <em>{type.hint}</em>
                </button>
              ))}
            </div>
          </div>
          <label data-tour="creator-format">
            <span>Format / size</span>
            <select value={formatId} onChange={(event) => setFormatId(event.target.value)}>
              {Object.values(CREATOR_FORMATS).map((item) => (
                <option key={item.id} value={item.id}>
                  {item.label} — {item.width}×{item.height}{item.fps > 1 ? ` @ ${item.fps}fps` : ""}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span>Visual direction</span>
            <input
              value={style}
              onChange={(event) => setStyle(event.target.value)}
              placeholder="monochrome cinematic"
            />
          </label>
          <button type="button" data-tour="creator-build" onClick={buildProject} disabled={runBusy}>
            <Sparkles size={15} /> Build plan
          </button>
          <button type="button" className="creator-ai-script-btn" onClick={generateScriptWithAI} disabled={aiScriptBusy || !project.storyboard?.length}>
            {aiScriptBusy ? <Loader2 size={14} className="creator-spin" /> : <Wand2 size={14} />}
            {aiScriptBusy ? "Writing…" : "Generate script with AI"}
          </button>
          <small className="creator-ai-script-hint">
            Build plan is instant and free (templates). This asks a real model to write the scenes — needs sign-in, costs credits.
          </small>
          {aiScriptError ? <div className="creator-error">{aiScriptError}</div> : null}
        </section>

        <nav className="creator-room-rail" aria-label="Creator separate interfaces" data-tour="creator-rooms">
          <button
            type="button"
            className={activeRoomId === "overview" ? "is-active" : ""}
            onClick={() => setActiveRoomId("overview")}
          >
            <Film size={15} />
            <span>Overview</span>
            <b>{project.readiness || 0}%</b>
          </button>
          <button
            type="button"
            className={activeRoomId === "autoreel" ? "is-active" : ""}
            onClick={() => setActiveRoomId("autoreel")}
          >
            <Clapperboard size={15} />
            <span>Auto reel</span>
            <b>1-click</b>
          </button>
          <button
            type="button"
            data-tour="creator-preview"
            className={activeRoomId === "preview" ? "is-active" : ""}
            onClick={openPreview}
          >
            <Play size={15} />
            <span>Preview</span>
            <b>{previewScenes.length}</b>
          </button>
          {roomStats.map((room, index) => {
            const Icon = room.icon;
            const isNewStage = room.stage && room.stage !== roomStats[index - 1]?.stage;
            return (
              <div className="creator-room-rail-item" key={room.id}>
                {isNewStage ? (
                  <div className="creator-room-rail-stage">{STAGE_LABELS[room.stage] || room.stage}</div>
                ) : null}
                <button
                  type="button"
                  className={activeRoomId === room.id ? "is-active" : ""}
                  onClick={() => setActiveRoomId(room.id)}
                >
                  <Icon size={15} />
                  <span>{room.label}</span>
                  <b>{room.count}</b>
                </button>
              </div>
            );
          })}
        </nav>
      </aside>

      <main className="creator-main-stage">
        {activeRoomId === "autoreel" ? (
          <CreatorAutoReel manager={manager} startSignal={autoReelSignal} />
        ) : activeRoomId === "overview" ? (
          <section className="creator-overview" aria-label="Creator overview">
            <div className="creator-overview-hero">
              <span>{greetingForHour(new Date().getHours())}, creator.</span>
              <h3>
                {project.readiness >= 100
                  ? "Ready to export"
                  : project.readiness > 0
                    ? `${project.title || "Untitled project"}`
                    : "Choose one production room"}
              </h3>
              <p>{summarizeCreatorProject(project)}</p>
            </div>

            <div className="creator-metric-grid">
              {metrics.map((metric) => (
                <article key={metric.label}>
                  <span>{metric.label}</span>
                  <b>{metric.value}</b>
                </article>
              ))}
            </div>

            <section className="creator-output-banner" aria-label="Creator output vault">
              <div>
                <span>Output vault</span>
                <h4>Production outputs are ready</h4>
                <p>Download the full local Creator Pack, or open any room and download only that room output.</p>
              </div>
              <div className="creator-output-banner-actions">
                <button type="button" onClick={downloadCreatorPack}>
                  <Download size={14} /> Download Creator Pack
                </button>
                <button type="button" onClick={createDraftRenderJob}>
                  <Film size={14} /> Create Draft Render Job
                </button>
                <button type="button" onClick={openPreview}>
                  <Play size={14} /> Open Preview
                </button>
                <button type="button" onClick={downloadPreviewHtml}>
                  <Download size={14} /> Download HTML Preview
                </button>
              </div>
            </section>

            <section className="creator-output-list" aria-label="Generated output files">
              {outputArtifacts.map((artifact) => {
                const Icon = artifact.icon;
                return (
                  <article key={artifact.id}>
                    <Icon size={16} />
                    <div>
                      <b>{artifact.label}</b>
                      <span>{artifact.filename}</span>
                      <small>{artifact.count} {artifact.unit} ready</small>
                    </div>
                    <div className="creator-output-card-actions">
                      <button type="button" onClick={() => setActiveRoomId(artifact.id)}>Open</button>
                      <button type="button" onClick={() => (artifact.id === "preview" ? downloadPreviewHtml() : downloadRoomOutput(artifact.id))}>
                        <Download size={12} /> Download
                      </button>
                    </div>
                  </article>
                );
              })}
            </section>

            <section className="creator-render-queue" aria-label="Draft render queue">
              <div className="creator-section-title"><Film size={14} /> Draft render queue</div>
              {latestRenderJob ? (
                <article>
                  <div>
                    <span>{latestRenderJob.status}</span>
                    <h4>{latestRenderJob.title}</h4>
                    <p>{latestRenderJob.inputs.storyboardScenes} scenes, {latestRenderJob.inputs.clips} clips, {latestRenderJob.inputs.footageAssets} assets queued for local review package.</p>
                    <small>Live provider render: disabled until approval</small>
                  </div>
                  <button type="button" onClick={() => downloadRenderJob(latestRenderJob)}>
                    <Download size={13} /> Download render manifest
                  </button>
                </article>
              ) : (
                <article>
                  <div>
                    <span>empty</span>
                    <h4>No render job yet</h4>
                    <p>Create a draft render job after reviewing the output files.</p>
                    <small>Render jobs are local queue manifests, not live provider execution.</small>
                  </div>
                  <button type="button" onClick={createDraftRenderJob}>
                    <Film size={13} /> Create Draft Render Job
                  </button>
                </article>
              )}
            </section>

            <div className="creator-pipeline">
              {PIPELINE_STAGE_ORDER.map((stageKey, stageIndex) => (
                <div className="creator-pipeline-stage" key={stageKey}>
                  <div className="creator-pipeline-stage-head">
                    <b>{stageIndex + 1}</b>
                    <span>{STAGE_LABELS[stageKey]}</span>
                  </div>
                  <div className="creator-room-grid">
                    {roomStats.filter((room) => room.stage === stageKey).map((room) => {
                      const Icon = room.icon;
                      const status = roomStatus(room.count);
                      const litDots = Math.min(ROOM_PROGRESS_DOTS, room.count);
                      const previewSrc = roomPreviewImage[room.id];
                      return (
                        <button
                          type="button"
                          key={room.id}
                          className="creator-room-card"
                          onClick={() => setActiveRoomId(room.id)}
                          title={room.note}
                        >
                          <div className="creator-tile">
                            {previewSrc ? (
                              <img src={previewSrc} alt="" />
                            ) : (
                              <Icon size={26} className="creator-tile-icon" />
                            )}
                            <span className="creator-tile-scan" aria-hidden="true" />
                            <span className={`creator-tile-status creator-room-status--${status.key}`}>{status.label}</span>
                          </div>
                          <div className="creator-room-card-caption">
                            <strong>{room.label}</strong>
                            <em>{room.count} {room.unit}</em>
                          </div>
                          <div className="creator-room-progress" aria-hidden="true">
                            {Array.from({ length: ROOM_PROGRESS_DOTS }, (_, index) => (
                              <i key={index} className={index < litDots ? "is-lit" : ""} />
                            ))}
                          </div>
                        </button>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>

            <section className="creator-flow-preview">
              <div className="creator-section-title"><Layers3 size={14} /> Current scene flow</div>
              <div className="creator-scene-strip">
                {(project.storyboard || []).slice(0, 7).map((scene) => (
                  <article key={scene.id}>
                    <b>{scene.order}</b>
                    <span>{scene.beat}</span>
                    <small>{scene.durationSeconds || "page"}s</small>
                  </article>
                ))}
              </div>
            </section>
          </section>
        ) : (
          <section className="creator-room-screen" aria-label={`${activeRoom.label} interface`}>
            <header className="creator-room-head">
              <div>
                <span>Dedicated production room</span>
                <h3><ActiveRoomIcon size={18} /> {activeRoom.label}</h3>
                <p>{activeRoom.note}</p>
              </div>
              <div className="creator-room-output-actions">
                <b>{activeRoomId === "preview" ? previewScenes.length : outputCount(project, activeRoom.id)} {activeRoom.unit}</b>
                <button type="button" onClick={downloadActiveRoomOutput}>
                  <Download size={13} /> Download output
                </button>
              </div>
            </header>

            {activeRoomId === "preview" ? (
              <section className="creator-preview-room" aria-label="Local render preview">
                <div className="creator-preview-player">
                  <div className="creator-preview-stage">
                    <div className="creator-preview-frame">
                      <span>Scene {activePreviewScene?.order || 1}</span>
                      <h4>{activePreviewScene?.beat || "Preview ready"}</h4>
                      <p>{activePreviewScene?.narration || "Build a Creator plan to preview scenes."}</p>
                      <em>{activePreviewScene?.caption || "Local playback only. Live render stays approval-required."}</em>
                    </div>
                    <div className="creator-preview-visual">
                      <b>Visual direction</b>
                      <p>{activePreviewScene?.visualDirection || project.style}</p>
                      <small>{activePreviewScene?.assetPrompt || "Scene asset prompt appears here."}</small>
                    </div>
                  </div>

                  <div className="creator-preview-progress">
                    <i style={{ width: `${previewProgress}%` }} />
                  </div>

                  <div className="creator-preview-controls">
                    <button type="button" onClick={() => movePreview(-1)} disabled={!previewIndex}>
                      <SkipBack size={14} /> Prev
                    </button>
                    <button type="button" onClick={() => setPreviewPlaying((value) => !value)} disabled={!previewScenes.length}>
                      {previewPlaying ? <Pause size={14} /> : <Play size={14} />}
                      {previewPlaying ? "Pause" : "Play"}
                    </button>
                    <button type="button" onClick={() => movePreview(1)} disabled={previewIndex >= previewScenes.length - 1}>
                      Next <SkipForward size={14} />
                    </button>
                    <button
                      type="button"
                      className={voiceEnabled ? "is-active" : ""}
                      onClick={() => setVoiceEnabled((value) => !value)}
                      title="Read scene narration aloud with the browser's local voice — no account, no API key"
                    >
                      {voiceEnabled ? <Volume2 size={14} /> : <VolumeX size={14} />}
                      Voice
                    </button>
                    <span>{previewScenes.length ? `${previewIndex + 1}/${previewScenes.length}` : "0/0"}</span>
                  </div>
                </div>

                <aside className="creator-preview-inspector">
                  <section>
                    <span>Render queue state</span>
                    <h4>{latestRenderJob ? latestRenderJob.status : "No job yet"}</h4>
                    <p>{latestRenderJob ? `${latestRenderJob.inputs.storyboardScenes} scenes queued for local review package.` : "Create a draft render job to lock this preview into the render queue."}</p>
                    {latestRenderJob ? (
                      <button type="button" onClick={() => downloadRenderJob(latestRenderJob)}>
                        <Download size={13} /> Download render manifest
                      </button>
                    ) : (
                      <button type="button" onClick={createDraftRenderJob}>
                        <Film size={13} /> Create Draft Render Job
                      </button>
                    )}
                    <button type="button" onClick={downloadPreviewHtml}>
                      <Download size={13} /> Download HTML Preview
                    </button>
                  </section>

                  {isRenderAvailable() ? (
                    <section>
                      <span>Local MP4 render</span>
                      <h4>{previewScenes.filter((s) => s.imageUrl).length} of {previewScenes.length} scenes have an image</h4>
                      <p>
                        {previewScenes.some((s) => s.imageUrl)
                          ? "Composes each scene's image + caption into one real MP4 on this device using your own ffmpeg."
                          : "Generate scene images in the Illustration room first, then render."}
                      </p>
                      {renderBusy ? (
                        <p className="creator-render-progress-text">
                          {renderProgress ? `Rendering scene ${renderProgress.sceneIndex} of ${renderProgress.totalScenes}…` : "Starting render…"}
                        </p>
                      ) : (
                        <button type="button" onClick={renderLocalVideo} disabled={!previewScenes.some((s) => s.imageUrl)}>
                          <Play size={13} /> Render locally to MP4
                        </button>
                      )}
                      {renderError ? <div className="creator-error">{renderError}</div> : null}
                      {renderResult ? <div className="creator-render-success">Rendered to {renderResult}</div> : null}
                    </section>
                  ) : null}

                  <section>
                    <span>Preview timeline</span>
                    <div className="creator-preview-timeline">
                      {previewScenes.map((scene, index) => (
                        <div className={`creator-timeline-row${index === previewIndex ? " is-active" : ""}`} key={scene.id}>
                          <button
                            type="button"
                            className="creator-timeline-select"
                            onClick={() => {
                              setPreviewPlaying(false);
                              setPreviewIndex(index);
                            }}
                          >
                            <b>{scene.order}</b>
                            <span>{scene.beat}</span>
                            <em>{scene.durationSeconds || 0}s</em>
                          </button>
                          <div className="creator-timeline-reorder">
                            <button
                              type="button"
                              onClick={() => moveScene(scene.id, -1)}
                              disabled={index === 0}
                              title="Move scene earlier"
                            >
                              <ArrowUp size={12} />
                            </button>
                            <button
                              type="button"
                              onClick={() => moveScene(scene.id, 1)}
                              disabled={index === previewScenes.length - 1}
                              title="Move scene later"
                            >
                              <ArrowDown size={12} />
                            </button>
                          </div>
                        </div>
                      ))}
                    </div>
                  </section>

                  <section className="creator-scene-editor">
                    <span>Edit selected scene</span>
                    {sceneDraft ? (
                      <>
                        <label>
                          <span>Duration (seconds)</span>
                          <input
                            type="number"
                            min={1}
                            max={600}
                            value={sceneDraft.durationSeconds}
                            onChange={(event) => updateSceneDraft("durationSeconds", event.target.value)}
                          />
                        </label>
                        <label>
                          <span>Caption position</span>
                          <select
                            value={sceneDraft.captionPosition || "bottom"}
                            onChange={(event) => updateSceneDraft("captionPosition", event.target.value)}
                          >
                            <option value="top">Top</option>
                            <option value="center">Center</option>
                            <option value="bottom">Bottom</option>
                          </select>
                        </label>
                        <label>
                          <span>Caption</span>
                          <input
                            type="text"
                            value={sceneDraft.caption}
                            onChange={(event) => updateSceneDraft("caption", event.target.value)}
                          />
                        </label>
                        <label>
                          <span>Narration</span>
                          <textarea
                            rows={3}
                            value={sceneDraft.narration}
                            onChange={(event) => updateSceneDraft("narration", event.target.value)}
                          />
                        </label>
                        <button type="button" onClick={saveSceneEdit} disabled={!isSceneDraftDirty}>
                          {sceneSaved ? <Check size={13} /> : <Save size={13} />}
                          {sceneSaved ? "Saved" : "Save scene changes"}
                        </button>
                      </>
                    ) : (
                      <p>Select a scene from the timeline to edit it.</p>
                    )}
                  </section>
                </aside>
              </section>
            ) : null}

            {activeRoomId === "storyboard" ? (
              <section className="creator-storyboard-room">
                <div className={`creator-script-source-badge ${project.scriptSource === "ai" ? "is-ai" : ""}`}>
                  {project.scriptSource === "ai" ? <Wand2 size={12} /> : <Layers3 size={12} />}
                  {project.scriptSource === "ai" ? "AI-written scenes" : "Template scenes — not yet AI-generated"}
                </div>
                <div className="creator-storyboard-actions">
                  <button type="button" onClick={generateAllSceneImages} disabled={bulkImageBusy}>
                    {bulkImageBusy
                      ? `Generating ${bulkImageProgress?.index || 0}/${bulkImageProgress?.total || 0}…`
                      : "Generate images for every scene"}
                  </button>
                  <span>Saved Asset Library looks are added to each prompt, so characters and props stay the same.</span>
                </div>
                {imageError ? <div className="creator-error">{imageError}</div> : null}
                {(project.storyboard || []).map((scene) => (
                  <article key={scene.id} className="creator-scene-card">
                    <div className="creator-scene-number">
                      {scene.imageUrl ? <img src={scene.imageUrl} alt="" /> : null}
                      <span>{scene.order}</span>
                    </div>
                    <div>
                      <span>{scene.durationSeconds || "page"}s - {scene.camera}</span>
                      <h4>{scene.beat}</h4>
                      <p>{scene.narration}</p>
                      <small>{scene.caption}</small>
                      <div className="creator-scene-actions">
                        <button type="button" onClick={() => generateSceneImage(scene)} disabled={!!sceneImageBusy || bulkImageBusy}>
                          {sceneImageBusy === scene.id ? "Generating…" : scene.imageUrl ? "Regenerate image" : "Generate image"}
                        </button>
                        {scene.imageProvider ? <em>{scene.imageProvider}</em> : null}
                      </div>
                    </div>
                  </article>
                ))}
              </section>
            ) : null}

            {activeRoomId === "clips" ? (
              <section className="creator-clips-room">
                {(project.clipCandidates || []).map((clip) => (
                  <article key={clip.id} className="creator-clip-card">
                    <div>
                      <span>{clip.startSecond}s-{clip.endSecond}s</span>
                      <h4>{clip.title}</h4>
                      <p>{clip.hookReason}</p>
                    </div>
                    <b>{clip.score}</b>
                    <div className="creator-clip-meter"><i style={{ width: `${Math.min(100, clip.score || 72)}%` }} /></div>
                  </article>
                ))}
              </section>
            ) : null}

            {activeRoomId === "animation" ? (
              <section className="creator-animation-room">
                <div className="creator-storyboard-actions">
                  <span>
                    Each scene goes to the engine that fits it: action shots become motion video through your
                    connected video accounts. {hasLipSyncAccount
                      ? "Dialogue shots are lip-synced."
                      : "Dialogue shots have no lip-sync account connected yet, so they become motion video with the voice-over over them."}
                  </span>
                </div>
                {motionError ? <div className="creator-error">{motionError}</div> : null}
                {(project.storyboard || []).map((scene) => {
                  const route = routeForShot(scene, { hasLipSync: hasLipSyncAccount });
                  return (
                    <article key={scene.id} className="creator-motion-card is-wide">
                      <span>{String(scene.order).padStart(2, "0")}</span>
                      <h4>{scene.beat}</h4>
                      <p>{route.note}</p>
                      <div className="creator-scene-actions">
                        <em>{route.shot === "dialogue" ? "Dialogue shot" : "Action shot"}</em>
                        <button
                          type="button"
                          onClick={() => generateSceneMotion(scene)}
                          disabled={!!sceneMotionBusy}
                        >
                          {sceneMotionBusy === scene.id ? "Generating…" : scene.videoUrl ? "Regenerate clip" : "Generate motion clip"}
                        </button>
                        {scene.videoUrl ? <em>clip ready · {scene.videoRoute}</em> : null}
                      </div>
                    </article>
                  );
                })}
                {project.animationPlan?.reducedMotionFallback ? (
                  <article className="creator-motion-card is-wide">
                    <span>RM</span>
                    <h4>Reduced motion fallback</h4>
                    <p>{project.animationPlan.reducedMotionFallback}</p>
                  </article>
                ) : null}
              </section>
            ) : null}

            {activeRoomId === "comics" ? (
              <section className="creator-comics-room">
                {(project.comicPanels || []).map((panel) => (
                  <article key={panel.id} className="creator-comic-card">
                    <div className="creator-tile creator-tile--sm">
                      <Palette size={20} className="creator-tile-icon" />
                      <span className="creator-tile-scan" aria-hidden="true" />
                    </div>
                    <span>{panel.order}</span>
                    <h4>{panel.title}</h4>
                    <small>{panel.frame}</small>
                    <p>{panel.dialogue}</p>
                    <em>{panel.qualityGate}</em>
                  </article>
                ))}
              </section>
            ) : null}

            {activeRoomId === "illustration" ? (
              <section className="creator-illustration-room">
                <div className="creator-illustration-prompts">
                  <div className="creator-section-title"><ImageIcon size={14} /> Your own prompt</div>
                  <article className="creator-custom-prompt-card">
                    <textarea
                      value={customPrompt}
                      onChange={(event) => setCustomPrompt(event.target.value)}
                      rows={4}
                      placeholder="Write or edit an illustration prompt..."
                    />
                    <div className="creator-custom-prompt-row">
                      <label>
                        <span>Style</span>
                        <select value={customStyle} onChange={(event) => setCustomStyle(event.target.value)}>
                          {ILLUSTRATION_STYLE_OPTIONS.map((opt) => (
                            <option key={opt.value} value={opt.value}>{opt.label}</option>
                          ))}
                        </select>
                      </label>
                      <label>
                        <span>Size</span>
                        <select value={customAspect} onChange={(event) => setCustomAspect(event.target.value)}>
                          {ILLUSTRATION_ASPECT_OPTIONS.map((opt) => (
                            <option key={opt.value} value={opt.value}>{opt.label}</option>
                          ))}
                        </select>
                      </label>
                    </div>
                    <div className="creator-custom-prompt-actions">
                      <button type="button" onClick={generateCustomIllustration} disabled={!!imageBusyId || !customPrompt.trim()}>
                        {imageBusyId === "custom" ? <Loader2 size={13} className="creator-spin" /> : <ImageIcon size={13} />}
                        Generate illustration
                      </button>
                      <button type="button" className="creator-save-prompt-btn" onClick={saveCustomPrompt} disabled={!customPrompt.trim()}>
                        {promptSaved ? <Check size={13} /> : <Save size={13} />}
                        {promptSaved ? "Saved" : editingPromptId ? "Save to prompt" : "Save as new prompt"}
                      </button>
                    </div>
                  </article>

                  <div className="creator-section-title-row">
                    <div className="creator-section-title"><ImageIcon size={14} /> Prompt queue (from storyboard)</div>
                    <button type="button" className="creator-bulk-generate-btn" onClick={generateAllSceneImages} disabled={bulkImageBusy || !!imageBusyId}>
                      {bulkImageBusy ? <Loader2 size={13} className="creator-spin" /> : <Wand2 size={13} />}
                      {bulkImageBusy && bulkImageProgress ? `Generating ${bulkImageProgress.index}/${bulkImageProgress.total}…` : "Generate all scene images"}
                    </button>
                  </div>
                  {(project.illustrationPrompts || []).map((promptItem) => {
                    const linkedScene = (project.storyboard || []).find((s) => s.id === promptItem.sceneId);
                    return (
                      <article key={promptItem.id} className="creator-prompt-card">
                        <p>{promptItem.prompt}</p>
                        <small>{promptItem.aspectRatio} - {promptItem.usagePolicy}</small>
                        <div className="creator-prompt-card-actions">
                          <button type="button" onClick={() => editPromptInCustomEditor(promptItem)}>
                            Edit
                          </button>
                          <button type="button" onClick={() => generatePromptAsset(promptItem)} disabled={!!imageBusyId || bulkImageBusy}>
                            {imageBusyId === promptItem.id ? <Loader2 size={13} className="creator-spin" /> : <ImageIcon size={13} />}
                            {linkedScene?.imageUrl ? "Regenerate" : "Generate draft"}
                          </button>
                          {linkedScene?.imageUrl ? <span className="creator-scene-attached"><Check size={12} /> Attached to scene</span> : null}
                        </div>
                      </article>
                    );
                  })}
                  {imageError ? <div className="creator-error">{imageError}</div> : null}
                </div>
                <div className="creator-illustration-preview">
                  {generatedImage ? (
                    <>
                      <img src={generatedImage.url} alt={generatedImage.prompt} />
                      <div className="creator-illustration-preview-meta">
                        <span>{generatedImage.prompt}</span>
                        <div>
                          <b>{generatedImage.provider}</b>
                          <a href={generatedImage.url} download target="_blank" rel="noreferrer">
                            <Download size={13} /> Download
                          </a>
                        </div>
                      </div>
                    </>
                  ) : (
                    <div className="creator-illustration-empty">
                      <ImageIcon size={34} />
                      <span>Generated illustration preview appears here.</span>
                    </div>
                  )}
                </div>
              </section>
            ) : null}

            {activeRoomId === "footage" ? (
              <section className="creator-footage-room">
                <div className="creator-source-policy">{project.footageManifest?.sourcePolicy}</div>
                <div className="creator-asset-grid">
                  {(project.footageManifest?.assets || []).slice(0, 16).map((asset) => (
                    <article key={asset.id} className="creator-asset-card">
                      <span>{asset.status}</span>
                      <h4>{asset.kind}</h4>
                      <p>{asset.note}</p>
                      <small>{asset.licenseRequired ? "rights check required" : "internal draft"}</small>
                    </article>
                  ))}
                </div>
              </section>
            ) : null}

            {activeRoomId === "assets" ? <CreatorAssetLibrary /> : null}
            {activeRoomId === "narration" ? <CreatorNarrationRoom accountManager={manager} /> : null}
            {activeRoomId === "drama" ? <CreatorDramaRoom accountManager={manager} /> : null}
            {activeRoomId === "export" ? <CreatorExportPanel manager={manager} /> : null}
          </section>
        )}
      </main>

      <aside className="creator-inspector">
        <section>
          <span>Project inspector</span>
          <h3>{project.title}</h3>
          <p>{project.brief}</p>
        </section>

        <section className="creator-inspector-grid">
          <article>
            <span>Format</span>
            <b>{project.format?.label}</b>
          </article>
          <article>
            <span>Saved</span>
            <b>{savedCount}</b>
          </article>
          <article>
            <span>Ready gates</span>
            <b>{readyGateCount}/{project.qualityGates?.length || 0}</b>
          </article>
          <article>
            <span>Safety</span>
            <b>Draft</b>
          </article>
        </section>

        <section className="creator-output-vault" aria-label="Creator output vault" data-tour="creator-vault">
          <span>Output vault</span>
          <h3>Output ready</h3>
          <p>Last generated: {new Date(outputReadyAt).toLocaleString()}</p>
          <button type="button" onClick={downloadCreatorPack}>
            <Download size={13} /> Download Creator Pack
          </button>
          <button type="button" onClick={downloadActiveRoomOutput}>
            <Download size={13} /> Download Current Room
          </button>
          <button type="button" onClick={createDraftRenderJob}>
            <Film size={13} /> Create Draft Render Job
          </button>
          <button type="button" onClick={openPreview}>
            <Play size={13} /> Open Preview
          </button>
          <button type="button" onClick={downloadPreviewHtml}>
            <Download size={13} /> Download HTML Preview
          </button>
          {latestRenderJob ? (
            <button type="button" onClick={() => downloadRenderJob(latestRenderJob)}>
              <Download size={13} /> Download Render Manifest
            </button>
          ) : null}
          <small>Local outputs are ready. Live render and external publish stay approval-required.</small>
        </section>

        <section className="creator-gate-list" data-tour="creator-gates">
          <span>Readiness gates</span>
          {(project.qualityGates || []).map((gate) => (
            <article key={gate.id} className={gate.status === "ready" || gate.status === "approved" ? "is-ready" : ""}>
              {statusIcon(gate.status)}
              <div>
                <b>{gate.label}</b>
                <small>{gate.status}</small>
              </div>
            </article>
          ))}
          <button type="button" className="creator-approve-btn" onClick={approveNextQualityGate} disabled={!pendingQualityGates.length}>
            <CheckCircle2 size={13} /> Approve next gate
          </button>
        </section>
      </aside>

      <TutorialCoach steps={CREATOR_TOUR_STEPS} open={tutorial.open} onClose={tutorial.finish} title="THE CREATOR tour" />
    </section>
  );
}
