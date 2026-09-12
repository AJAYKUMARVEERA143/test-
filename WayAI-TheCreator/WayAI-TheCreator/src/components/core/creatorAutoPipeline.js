// THE CREATOR — one-prompt reel pipeline.
//
//   request ("30 second technology reel")
//     → script (scene-by-scene narration, captions, visual direction)
//     → a visual per scene: AI clip (the user's Google/Veo, Higgsfield or
//       Hugging Face, else Way AI Cloud) → AI still → a plain title card
//     → a voice-over per scene (Way Voice Engine on this machine)
//     → timeline (scene length follows the voice, captions timed to it)
//     → FFmpeg render: clips + voice + ducked music + captions → local .mp4
//
// Every stage but the final render has a fallback, so a missing account or a
// provider outage makes the video plainer, never makes it fail. The report
// says exactly which route each scene used.
//
// All I/O comes in through `deps`, so the planning and fallback logic is
// testable without a network, a GPU, or ffmpeg.

export const SCENE_SECONDS = 6;
const MIN_SECONDS = 10;
const MAX_SECONDS = 180;

const BEATS_BY_COUNT = {
  3: ["Hook", "Core idea", "Call to action"],
  4: ["Hook", "Problem", "Solution", "Call to action"],
  5: ["Hook", "Problem", "Insight", "Proof", "Call to action"],
  6: ["Hook", "Problem", "Insight", "Example", "Proof", "Call to action"],
};

const TELUGU_RE = /[ఀ-౿]/;
const FILLER_RE = /\b(nova|hey|the creator|creator lo|creator|lo|make|create|generate|build|tayaru|tayaaru|chey(yi|yandi)?|cheyyi|oka|a|an|please|video|reel|short|shorts|about|on|for|me)\b/gi;

/** Parse a spoken or typed request into a plan. */
export function parseCreatorRequest(text) {
  const raw = String(text || "").trim();
  const lower = raw.toLowerCase();

  let seconds = 30;
  const secMatch = lower.match(/(\d{1,3})\s*(?:-|\s)?\s*(s\b|sec\b|secs\b|second|seconds|సెకన్ల|సెకన్లు|sekan)/);
  const minMatch = lower.match(/(\d{1,2})\s*(?:-|\s)?\s*(min\b|mins\b|minute|minutes|నిమిష)/);
  if (secMatch) seconds = Number(secMatch[1]);
  else if (minMatch) seconds = Number(minMatch[1]) * 60;
  seconds = Math.min(MAX_SECONDS, Math.max(MIN_SECONDS, seconds));

  const language = TELUGU_RE.test(raw) || /\btelugu\b/i.test(raw) ? "te" : "en";

  const topic = raw
    .replace(/^\/core\s+creator\s+reel\s+/i, "") // prefix added by the NOVA voice route
    .replace(/\d{1,3}\s*(?:-|\s)?\s*(s\b|sec\b|secs\b|seconds?|min\b|mins\b|minutes?|సెకన్ల|సెకన్లు|నిమిష\S*)/gi, " ")
    .replace(/\b(in|lo)\s+telugu\b|\btelugu\s*(lo)?\b/gi, " ")
    .replace(FILLER_RE, " ")
    .replace(/[,.!?]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  return { topic: topic || "Way AI", durationSeconds: seconds, language, format: "reel" };
}

/**
 * Is this a "make me a finished video" request (run the whole pipeline), as
 * opposed to "open the Creator" or planning chatter? Needs a video word and
 * either a length or a make-verb.
 */
export function isAutoReelRequest(text) {
  const t = String(text || "").toLowerCase();
  const videoWord = /\b(reel|reels|short|shorts|video)\b|రీల్|వీడియో/.test(t);
  const length = /\d{1,3}\s*(?:-|\s)?\s*(s\b|sec|second|min|సెకన్|నిమిష)/.test(t);
  const make = /\b(make|create|generate|build|tayaru|tayaaru|chey|cheyyi|render|export)\b|తయారు|చెయ్/.test(t);
  return videoWord && (length || make);
}

/** Scene count and beats for a duration (≈6 s a scene, 3–6 scenes). */
export function planScenes(durationSeconds) {
  const count = Math.min(6, Math.max(3, Math.round(durationSeconds / SCENE_SECONDS)));
  const beats = BEATS_BY_COUNT[count];
  const each = Math.round((durationSeconds / count) * 10) / 10;
  return beats.map((beat, index) => ({ index, beat, durationSeconds: each }));
}

/**
 * Scene length follows the voice-over (plus a short breath), never shorter
 * than the planned slot minus a little, so the pacing stays close to the ask.
 */
export function sceneDuration(plannedSeconds, voiceSeconds) {
  if (!Number.isFinite(voiceSeconds) || voiceSeconds <= 0) return plannedSeconds;
  return Math.round(Math.max(voiceSeconds + 0.4, plannedSeconds * 0.6) * 10) / 10;
}

function slugify(text) {
  return String(text || "reel").toLowerCase().replace(/[^a-z0-9ఀ-౿]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "reel";
}

export function outputFileName(topic, now = new Date()) {
  const stamp = now.toISOString().replace(/[:T]/g, "-").slice(0, 16);
  return `${slugify(topic)}-${stamp}.mp4`;
}

async function tryVisual(scene, prompt, deps) {
  const attempts = [];
  if (deps.generateVideo) {
    try {
      const video = await deps.generateVideo(prompt);
      if (video?.videoUri) return { visual: { videoUrl: video.videoUri }, route: `video:${video.route || video.mode || "ai"}`, attempts };
      attempts.push("video: no clip returned");
    } catch (error) {
      attempts.push(`video: ${error?.message || error}`);
    }
  }
  if (deps.generateImage) {
    try {
      const image = await deps.generateImage(prompt);
      if (image?.url) return { visual: { imageUrl: image.url }, route: `image:${image.provider || "ai"}`, attempts };
      attempts.push("image: no image returned");
    } catch (error) {
      attempts.push(`image: ${error?.message || error}`);
    }
  }
  // Last resort that cannot fail: a title card with the scene's caption.
  return { visual: { imageUrl: await deps.makeTitleCard(scene) }, route: "card", attempts };
}

/**
 * Run the whole pipeline. `onStep({stage, message, sceneIndex?})` reports
 * progress. Resolves to { outputPath, scenes, report }.
 */
export async function runCreatorPipeline(request, deps, onStep = () => {}, { signal } = {}) {
  const stopIfCancelled = () => {
    if (signal?.aborted) {
      const error = new Error("Cancelled.");
      error.cancelled = true;
      throw error;
    }
  };
  const plan = typeof request === "string" ? parseCreatorRequest(request) : { ...parseCreatorRequest(""), ...request };
  const slots = planScenes(plan.durationSeconds);
  const report = { plan, script: "", scenes: [], voice: "", music: "", render: "" };

  onStep({ stage: "script", message: `Writing a ${plan.durationSeconds}s script about "${plan.topic}"…` });
  let script;
  try {
    script = await deps.writeScript({ plan, beats: slots.map((s) => s.beat) });
    report.script = "ai";
  } catch (error) {
    script = slots.map((slot) => ({
      beat: slot.beat,
      narration: `${slot.beat}: ${plan.topic}.`,
      caption: `${plan.topic} — ${slot.beat}`,
      visualDirection: `${plan.topic}, ${slot.beat.toLowerCase()}, cinematic vertical shot`,
    }));
    report.script = `template (AI script failed: ${error?.message || error})`;
  }

  const scenes = [];
  for (const slot of slots) {
    stopIfCancelled();
    const beat = script[slot.index] || script[script.length - 1] || {};
    const scene = {
      index: slot.index,
      beat: slot.beat,
      narration: String(beat.narration || "").trim(),
      caption: String(beat.caption || beat.narration || "").trim(),
      visualPrompt: String(beat.visualDirection || `${plan.topic}, ${slot.beat}`).trim(),
      durationSeconds: slot.durationSeconds,
    };

    onStep({ stage: "visual", sceneIndex: slot.index, message: `Scene ${slot.index + 1}: getting a visual…` });
    const { visual, route, attempts } = await tryVisual(scene, `${scene.visualPrompt}. Vertical 9:16, no text on screen.`, deps);
    Object.assign(scene, visual);

    onStep({ stage: "voice", sceneIndex: slot.index, message: `Scene ${slot.index + 1}: voice-over…` });
    let voiceSeconds = 0;
    let voiceRoute = "none";
    if (scene.narration && deps.synthesizeVoice) {
      try {
        const voice = await deps.synthesizeVoice(scene.narration, plan.language);
        if (voice?.audio) {
          scene.audio = voice.audio;
          voiceSeconds = Number(voice.seconds) || 0;
          voiceRoute = voice.route || "voice";
        }
      } catch (error) {
        voiceRoute = `none (${error?.message || error})`;
      }
    }
    scene.durationSeconds = sceneDuration(slot.durationSeconds, voiceSeconds);
    report.scenes.push({ index: slot.index, beat: slot.beat, visual: route, voice: voiceRoute, fallbacks: attempts, seconds: scene.durationSeconds });
    scenes.push(scene);
  }
  report.voice = scenes.some((s) => s.audio) ? "Way Voice Engine" : "none — captions only";

  let bgm = null;
  if (deps.pickMusic) {
    try {
      bgm = await deps.pickMusic(plan);
      report.music = bgm ? "ducked under the voice-over" : "none";
    } catch {
      report.music = "none";
    }
  }

  stopIfCancelled();
  onStep({ stage: "render", message: "Editing: clips, voice, music and captions…" });
  const outputPath = await deps.outputPath(outputFileName(plan.topic));
  const outcome = await deps.render({ scenes, outputPath, bgm, signal, onProgress: (p) => onStep({ stage: "render", message: `Rendering scene ${p.sceneIndex}/${p.totalScenes}…` }) });
  if (!outcome?.success) {
    report.render = outcome?.cancelled ? "cancelled" : `failed: ${outcome?.error || "unknown error"}`;
    const error = new Error(outcome?.cancelled ? "Render cancelled." : `Render failed: ${outcome?.error || "unknown error"}`);
    error.report = report;
    throw error;
  }
  report.render = "done";
  onStep({ stage: "done", message: `Saved ${outputPath}` });
  return { outputPath, scenes, report };
}
