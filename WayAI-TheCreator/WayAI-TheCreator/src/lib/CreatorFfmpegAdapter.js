/**
 * CreatorFfmpegAdapter — thin wrapper around the Rust `creator_ffmpeg_*` Tauri
 * commands (src-tauri/src/creator_ffmpeg.rs). Desktop-only, same reasoning as
 * CodexCliProvider.js: local video composition needs a real `ffmpeg` process,
 * so every method here rejects clearly on the web build instead of silently
 * failing — the web build's real path is CapCut draft export (CreatorExportPanel.jsx),
 * not this adapter.
 *
 * Image/audio bytes are resolved to local temp files entirely on the JS side
 * (this module) before the Rust render command ever runs — ffmpeg's native
 * process can't send an Authorization header or decode a data: URI itself,
 * but CreatorStudioApiClient.js's fetchMediaBlobUrl() already knows how to
 * fetch an authenticated scene audio file, and a plain fetch handles both a
 * data: URI and a provider's hosted image URL.
 */
import { isDesktop } from "./tauriCompat.js";
import { fetchMediaBlobUrl } from "../services/CreatorStudioApiClient.js";

function requireDesktop() {
  if (!isDesktop) {
    throw new Error("Local video rendering requires the desktop app. Use CapCut draft export instead on web.");
  }
}

export function isRenderAvailable() {
  return isDesktop;
}

async function invoke(cmd, args = {}) {
  requireDesktop();
  const { invoke: ti } = await import("@tauri-apps/api/core");
  return ti(cmd, args);
}

export async function detectFfmpeg() {
  return invoke("creator_ffmpeg_detect");
}

function extensionFromMime(mime = "") {
  if (mime.includes("mp4")) return "mp4";
  if (mime.includes("webm")) return "webm";
  if (mime.includes("quicktime")) return "mov";
  if (mime.includes("png")) return "png";
  if (mime.includes("jpeg") || mime.includes("jpg")) return "jpg";
  if (mime.includes("webp")) return "webp";
  if (mime.includes("wav")) return "wav";
  if (mime.includes("mpeg") || mime.includes("mp3")) return "mp3";
  return "bin";
}

async function bytesFromBlob(blob) {
  return { bytes: new Uint8Array(await blob.arrayBuffer()), mime: blob.type || "" };
}

async function resolveImageBytes(imageUrl) {
  if (imageUrl.startsWith("data:")) {
    const res = await fetch(imageUrl);
    return bytesFromBlob(await res.blob());
  }
  const res = await fetch(imageUrl);
  if (!res.ok) throw new Error(`Failed to download scene image (HTTP ${res.status})`);
  return bytesFromBlob(await res.blob());
}

// A scene's media can be a direct URL (http(s), blob:, data:) — AI video
// clips and Way Voice Engine audio arrive that way — or a Creator Studio
// media path that needs the authenticated fetch.
function isDirectUrl(value) {
  return /^(https?:|blob:|data:)/i.test(String(value || ""));
}

async function resolveMediaBytes(source, label) {
  if (source instanceof Uint8Array) return { bytes: source, mime: "" };
  if (source instanceof Blob) return bytesFromBlob(source);
  if (isDirectUrl(source)) {
    const res = await fetch(source);
    if (!res.ok) throw new Error(`Failed to download ${label} (HTTP ${res.status})`);
    return bytesFromBlob(await res.blob());
  }
  return resolveAudioBytes(source);
}

async function writeTemp(callId, index, kind, media, fallbackExt) {
  return invoke("creator_ffmpeg_write_temp", {
    callId, index, kind, extension: extensionFromMime(media.mime) === "bin" ? fallbackExt : extensionFromMime(media.mime), bytes: Array.from(media.bytes),
  });
}

async function resolveAudioBytes(relPath) {
  const blobUrl = await fetchMediaBlobUrl(relPath);
  try {
    const res = await fetch(blobUrl);
    return await bytesFromBlob(await res.blob());
  } finally {
    URL.revokeObjectURL(blobUrl);
  }
}

/**
 * Composes an episode's scenes (each needs at least imageUrl; audioUrl is
 * optional — a silent matching-format track is substituted so concat still
 * works) into one local MP4, with each scene's `caption` burned in as a
 * bottom-third overlay for that scene's duration (skipped, not failed, if no
 * system font can be found — see creator_ffmpeg.rs's find_system_font()).
 * Progress arrives via onProgress({sceneIndex,
 * totalScenes}) after each scene's clip finishes rendering. Pass an
 * AbortSignal to make the render cancelable — same pattern as
 * CodexCliProvider.js's runTurn(), so the caller never needs to know the
 * adapter's internal call id.
 * A scene may use `videoUrl` (an AI clip) instead of `imageUrl`; audio may be
 * `audioUrl` or raw `audio` bytes/Blob (Way Voice Engine output). `bgm`
 * (URL, Blob or bytes) is ducked under the voice-over for the whole video.
 * @param {{scenes: Array<{imageUrl?:string, videoUrl?:string, audioUrl?:string, audio?:Blob|Uint8Array, durationSeconds?:number, caption?:string, captionPosition?:"top"|"center"|"bottom", captionCues?:Array<{start:number,end:number,text:string}>}>, outputPath: string, bgm?: string|Blob|Uint8Array, bgmVolume?: number, onProgress?: Function, signal?: AbortSignal}} options
 */
export async function renderEpisode({ scenes, outputPath, bgm = null, bgmVolume = 0.35, onProgress, signal } = {}) {
  requireDesktop();
  if (!scenes?.length) throw new Error("No scenes to render.");
  if (!outputPath) throw new Error("An output path is required.");

  const callId = crypto.randomUUID();
  const { listen } = await import("@tauri-apps/api/event");
  const unlistenProgress = await listen("creator-ffmpeg-progress", (event) => {
    if (event.payload?.callId === callId) onProgress?.(event.payload);
  });

  const onAbort = () => cancelRender(callId);
  signal?.addEventListener("abort", onAbort);

  try {
    const resolvedScenes = [];
    for (let i = 0; i < scenes.length; i++) {
      const scene = scenes[i];
      if (!scene.imageUrl && !scene.videoUrl) throw new Error(`Scene ${i + 1} has no image or video yet.`);

      let imagePath = "";
      let videoPath = null;
      if (scene.videoUrl) {
        videoPath = await writeTemp(callId, i, "video", await resolveMediaBytes(scene.videoUrl, "scene clip"), "mp4");
      } else {
        const image = await resolveImageBytes(scene.imageUrl);
        imagePath = await writeTemp(callId, i, "image", image, "png");
      }

      let audioPath = null;
      const audioSource = scene.audio || scene.audioUrl;
      if (audioSource) {
        audioPath = await writeTemp(callId, i, "audio", await resolveMediaBytes(audioSource, "voice-over"), "wav");
      }

      resolvedScenes.push({
        imagePath,
        videoPath,
        audioPath,
        durationSeconds: scene.durationSeconds || 4,
        caption: String(scene.caption || "").trim() || null,
        captionCues: Array.isArray(scene.captionCues) && scene.captionCues.length ? scene.captionCues : null,
        // Where the caption sits on the frame: "top" | "center" | "bottom".
        captionPosition: ["top", "center", "bottom"].includes(scene.captionPosition) ? scene.captionPosition : "bottom",
      });
    }

    const bgmPath = bgm ? await writeTemp(callId, 0, "bgm", await resolveMediaBytes(bgm, "background music"), "mp3") : null;
    return await invoke("creator_ffmpeg_render", { callId, scenes: resolvedScenes, outputPath, bgmPath, bgmVolume });
  } finally {
    unlistenProgress();
    signal?.removeEventListener("abort", onAbort);
  }
}

export async function cancelRender(callId) {
  try {
    await invoke("creator_ffmpeg_cancel", { callId });
  } catch {
    // best-effort — the render may have already finished
  }
}
