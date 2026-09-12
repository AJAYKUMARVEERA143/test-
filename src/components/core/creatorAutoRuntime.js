// Real dependencies for creatorAutoPipeline.js — the parts that touch the
// network, the GPU, the voice engine and ffmpeg. Kept apart from the pipeline
// so the pipeline's decisions stay unit-testable.
import { generateCreatorScriptWithAI } from "../../services/WayCreatorScriptAdapter.js";
import { generateVideo } from "../../services/WayVideoAdapter.js";
import { generateIllustration } from "../../services/WayIllustrateAdapter.js";
import { generateNarration } from "../../services/WayTtsAdapter.js";
import { applyConsistency } from "./creatorConsistency.js";
import { listAssets } from "../../services/CreatorStudioApiClient.js";
import { isRenderAvailable, renderEpisode } from "../../lib/CreatorFfmpegAdapter.js";

async function audioSeconds(blob) {
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    const ctx = new Ctx();
    const buffer = await ctx.decodeAudioData(await blob.arrayBuffer());
    const seconds = buffer.duration;
    ctx.close?.();
    return seconds;
  } catch {
    return 0;
  }
}

/** A 1080×1920 title card for a scene — the visual that cannot fail. */
async function makeTitleCard(scene) {
  const canvas = document.createElement("canvas");
  canvas.width = 1080;
  canvas.height = 1920;
  const ctx = canvas.getContext("2d");
  const gradient = ctx.createLinearGradient(0, 0, 0, 1920);
  gradient.addColorStop(0, "#111213");
  gradient.addColorStop(1, "#0d0e0f");
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, 1080, 1920);
  ctx.fillStyle = "#4fa6ff";
  ctx.fillRect(120, 700, 120, 8);
  ctx.fillStyle = "#8b8c8f";
  ctx.font = "600 44px 'Nirmala UI', 'Segoe UI', sans-serif";
  ctx.fillText(String(scene.beat || "").toUpperCase(), 120, 790);
  // The caption itself, wrapped to the card — the burned-in captions sit at
  // the bottom, so this is the headline, not a duplicate of them.
  ctx.fillStyle = "#e8e8ea";
  ctx.font = "700 76px 'Nirmala UI', 'Segoe UI', sans-serif";
  const words = String(scene.caption || scene.beat || "").split(/\s+/).filter(Boolean);
  let line = "";
  let y = 900;
  for (const word of words) {
    const next = line ? `${line} ${word}` : word;
    if (ctx.measureText(next).width > 840 && line) {
      ctx.fillText(line, 120, y);
      y += 96;
      line = word;
      if (y > 1500) break;
    } else {
      line = next;
    }
  }
  if (line && y <= 1500) ctx.fillText(line, 120, y);
  return canvas.toDataURL("image/png");
}

/**
 * Build the real dependency set. `manager` is the AccountManager, so every
 * provider call uses the user's own connected accounts first.
 */
export function createCreatorRuntime({ manager, music = null } = {}) {
  // Loaded once per run: the saved looks that keep every scene on-model.
  let assetsPromise = null;
  const savedAssets = () => {
    if (!assetsPromise) assetsPromise = listAssets({ limit: 60 }).catch(() => []);
    return assetsPromise;
  };
  return {
    writeScript: async ({ plan, beats }) => generateCreatorScriptWithAI({
      brief: plan.language === "te"
        ? `${plan.topic}. Write every narration and caption in Telugu script (తెలుగు), natural spoken Telugu.`
        : plan.topic,
      formatLabel: "Reel",
      formatAspect: "9:16",
      durationSeconds: plan.durationSeconds,
      style: "cinematic",
      beats,
      manager,
    }),
    generateVideo: async (prompt) => generateVideo({
      prompt: applyConsistency(prompt, { assets: await savedAssets() }),
      aspectRatio: "9:16", durationSeconds: "6", resourceType: "shot",
    }, manager),
    generateImage: async (prompt) => generateIllustration({
      prompt: applyConsistency(prompt, { assets: await savedAssets(), style: "realistic cinematic" }),
      style: "realistic", aspectRatio: "9:16",
    }, manager),
    makeTitleCard,
    // Same chain as the voice-over button: your own key, this device's engine,
    // then Way AI Cloud — whichever answers first.
    synthesizeVoice: async (text, language) => {
      const { audio, route } = await generateNarration({ text, language }, manager);
      return { audio, seconds: await audioSeconds(audio), route };
    },
    pickMusic: async () => music,
    outputPath: async (fileName) => {
      const { videoDir, join } = await import("@tauri-apps/api/path");
      return join(await videoDir(), "Way AI", fileName);
    },
    render: (job) => {
      if (!isRenderAvailable()) {
        return { success: false, error: "Rendering needs the Way AI Code desktop app with ffmpeg installed." };
      }
      return renderEpisode({ ...job, bgmVolume: 0.3 });
    },
  };
}

export { pickLanguage } from "../../services/WayVoiceEngineClient.js";
