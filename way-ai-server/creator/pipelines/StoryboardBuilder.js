"use strict";

// Turns narration segments into scene-shaped storyboard entries. Deterministic
// (no LLM) — the "visual direction" and "asset prompt" are template-derived
// from the segment text and a chosen style, not generated content; actual
// image/voiceover generation happens per-scene afterward, driven by the UI.
function buildStoryboard(segments, { style = "cinematic" } = {}) {
  return (segments || []).map((segment) => ({
    order: segment.order,
    narration: segment.text,
    caption: segment.text.length > 90 ? `${segment.text.slice(0, 87)}...` : segment.text,
    durationSeconds: segment.estimatedSeconds,
    visualDirection: `${style} shot illustrating: ${segment.text}`,
    assetPrompt: `${segment.text}, ${style} style, no text or captions in the image`,
    imageUrl: null,
    audioUrl: null,
    status: "draft",
  }));
}

module.exports = { buildStoryboard };
