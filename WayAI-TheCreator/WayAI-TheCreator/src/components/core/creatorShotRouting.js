/**
 * Which engine a scene should go to.
 *
 *   dialogue — a character is speaking on camera. The right tool is lip-sync
 *              (character image + the voice-over track). Way AI routes there
 *              only when a lip-sync provider is actually connected; otherwise
 *              the scene is made as motion video with the voice-over on top,
 *              and the UI says so rather than implying synced lips.
 *   action   — everything else: establishing shots, product moves, b-roll.
 *              Image-to-video through the connected video providers.
 */
const SPEECH_MARKERS = [
  /\bsays?\b/i, /\bspeaks?\b/i, /\btalking\b/i, /\bexplains?\b/i, /\btells?\b/i,
  /\basks?\b/i, /\breplies\b/i, /\bnarrat(es|ing)\b/i, /\bto camera\b/i, /\bpiece to camera\b/i,
  /\bమాట్లాడ/, /\bచెబుతు/, /\bచెప్పు/,
];

const CLOSE_SHOT = [/\bclose[- ]?up\b/i, /\btalking head\b/i, /\bportrait\b/i, /\bface\b/i, /\bselfie\b/i];

/** @returns {"dialogue"|"action"} */
export function classifyShot(scene = {}) {
  const camera = String(scene.camera || "");
  const text = `${scene.beat || ""} ${scene.narration || ""} ${scene.visualDirection || scene.assetPrompt || ""} ${camera}`;
  const spoken = String(scene.dialogue || scene.narration || "").trim();
  const hasQuotedLine = /["“”].{3,}["“”]/.test(text);
  const speaks = SPEECH_MARKERS.some((pattern) => pattern.test(text)) || hasQuotedLine;
  const close = CLOSE_SHOT.some((pattern) => pattern.test(text));
  return spoken && (speaks || close) ? "dialogue" : "action";
}

/**
 * The route to run for a scene, given what is connected.
 * `hasLipSync` is true only when an account that can lip-sync is connected.
 */
export function routeForShot(scene, { hasLipSync = false } = {}) {
  const shot = classifyShot(scene);
  if (shot === "dialogue" && hasLipSync) {
    return { shot, engine: "lipsync", note: "Character image + voice-over, lips synced." };
  }
  if (shot === "dialogue") {
    return {
      shot,
      engine: "motion",
      note: "Dialogue shot — no lip-sync account connected, so this is motion video with the voice-over over it (lips are not synced).",
    };
  }
  return { shot, engine: "motion", note: "Action shot — image-to-video." };
}

export function routeSummary(scenes = [], options = {}) {
  const routes = scenes.map((scene) => routeForShot(scene, options));
  return {
    dialogue: routes.filter((route) => route.shot === "dialogue").length,
    action: routes.filter((route) => route.shot === "action").length,
    lipSynced: routes.filter((route) => route.engine === "lipsync").length,
    routes,
  };
}
