"use strict";

const { v4: uuidv4 } = require("uuid");

// Builds a CapCut/Jianying-style draft folder's two core JSON files from an
// episode's storyboard. IMPORTANT caveat, stated here and repeated in the
// export route/UI: CapCut has never published an official spec for this
// format — this targets the structure widely documented by community
// reverse-engineering projects (e.g. pyJianYingDraft), which is the closest
// thing to a "published external format" that exists. It is NOT ArcReel's
// code (a fresh implementation against the same public community knowledge,
// per the plan's AGPL boundary), and it may need adjustment for whichever
// CapCut version actually opens it — hence "best-effort," verified by
// actually importing into CapCut, not guaranteed byte-for-byte.
//
// A real CapCut draft's material `path` is an absolute path on the machine
// that authored it — there is no relative/portable path convention in the
// format itself. This builder writes paths relative to the draft folder
// (`materials/video/...`, `materials/audio/...`) on the assumption the user
// extracts the zip directly into their own CapCut "Drafts" folder; if CapCut
// doesn't auto-relink, the exported README explains how to relink manually.

const MICROSECONDS_PER_SECOND = 1_000_000;

function materialFileName(kind, index, extension) {
  return `scene_${String(index + 1).padStart(4, "0")}.${extension}`;
}

function extensionFromContentType(contentType = "") {
  if (contentType.includes("png")) return "png";
  if (contentType.includes("webp")) return "webp";
  if (contentType.includes("jpeg") || contentType.includes("jpg")) return "jpg";
  if (contentType.includes("wav")) return "wav";
  if (contentType.includes("mpeg") || contentType.includes("mp3")) return "mp3";
  return "bin";
}

/**
 * @param {{title:string, storyboard: Array<{order:number, imageUrl?:string, audioUrl?:string, durationSeconds?:number, caption?:string}>}} episode
 * @param {{width?:number, height?:number, fps?:number}} options
 * @returns {{draftContent:object, draftMetaInfo:object, mediaManifest:Array<{relPath:string, kind:"image"|"audio", scene:object, contentTypeHint:string}>}}
 */
function buildDraft(episode, { width = 1080, height = 1920, fps = 30 } = {}) {
  const scenes = (episode?.storyboard || []).filter((scene) => scene?.imageUrl);
  if (!scenes.length) throw new Error("This episode has no generated scenes to export yet.");

  const draftId = uuidv4();
  const videoMaterials = [];
  const audioMaterials = [];
  const videoSegments = [];
  const audioSegments = [];
  const mediaManifest = [];

  let cursorMicros = 0;
  scenes.forEach((scene, index) => {
    const durationMicros = Math.max(1, Math.round((scene.durationSeconds || 4) * MICROSECONDS_PER_SECOND));

    const imageExt = extensionFromContentType(scene._imageContentType || "");
    const imageRelPath = `materials/video/${materialFileName("image", index, imageExt || "png")}`;
    mediaManifest.push({ relPath: imageRelPath, kind: "image", url: scene.imageUrl, sceneOrder: scene.order });

    const videoMaterialId = uuidv4();
    videoMaterials.push({
      id: videoMaterialId,
      type: "photo",
      path: imageRelPath,
      width,
      height,
      duration: durationMicros,
      has_audio: false,
    });
    videoSegments.push({
      id: uuidv4(),
      material_id: videoMaterialId,
      target_timerange: { start: cursorMicros, duration: durationMicros },
      source_timerange: { start: 0, duration: durationMicros },
      speed: 1.0,
      volume: 1.0,
      visible: true,
      clip: { alpha: 1.0, rotation: 0.0, scale: { x: 1.0, y: 1.0 }, transform: { x: 0.0, y: 0.0 } },
    });

    if (scene.audioUrl) {
      const audioExt = extensionFromContentType(scene._audioContentType || "");
      const audioRelPath = `materials/audio/${materialFileName("audio", index, audioExt || "mp3")}`;
      mediaManifest.push({ relPath: audioRelPath, kind: "audio", url: scene.audioUrl, sceneOrder: scene.order });

      const audioMaterialId = uuidv4();
      audioMaterials.push({ id: audioMaterialId, type: "extract_music", path: audioRelPath, duration: durationMicros });
      audioSegments.push({
        id: uuidv4(),
        material_id: audioMaterialId,
        target_timerange: { start: cursorMicros, duration: durationMicros },
        source_timerange: { start: 0, duration: durationMicros },
        speed: 1.0,
        volume: 1.0,
        visible: true,
      });
    }

    cursorMicros += durationMicros;
  });

  const tracks = [{ id: uuidv4(), type: "video", attribute: 0, flag: 0, is_default_name: true, name: "", segments: videoSegments }];
  if (audioSegments.length) {
    tracks.push({ id: uuidv4(), type: "audio", attribute: 0, flag: 0, is_default_name: true, name: "", segments: audioSegments });
  }

  const now = Date.now();
  const draftContent = {
    id: draftId,
    version: 360000,
    new_version: "110.0.0",
    source: "way-ai-code-creator-studio",
    fps,
    duration: cursorMicros,
    canvas_config: { width, height, ratio: "original" },
    color_space: 0,
    create_time: now,
    update_time: now,
    materials: {
      videos: videoMaterials,
      audios: audioMaterials,
      texts: [],
      canvases: [],
      speeds: [],
      transitions: [],
      effects: [],
      filters: [],
      sound_channel_mappings: [],
      vocal_separations: [],
    },
    tracks,
    relationships: [],
    render_index_track_mode_on: true,
    free_render_index_mode_on: false,
  };

  const draftMetaInfo = {
    draft_id: draftId,
    draft_name: episode?.title || "Way AI Creator export",
    draft_fold_path: "",
    draft_root_path: "",
    draft_cover: "",
    draft_new_version: "",
    tm_draft_create: now,
    tm_draft_modified: now,
    draft_materials: [],
  };

  return { draftContent, draftMetaInfo, mediaManifest };
}

module.exports = { buildDraft };
