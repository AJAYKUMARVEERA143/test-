"use strict";

// Deterministic, provider-free: splits a pasted narration/story text into
// speech-paced segments. No LLM call — this only decides *where* the reel
// cuts happen; StoryboardBuilder.js turns each segment into a scene.
const WORDS_PER_SECOND = 2.5; // ~150 wpm average narration pace

function splitIntoSentences(text) {
  return String(text || "")
    .replace(/\s+/g, " ")
    .trim()
    .split(/(?<=[.!?])\s+/)
    .map((sentence) => sentence.trim())
    .filter(Boolean);
}

function estimateSeconds(text) {
  const words = String(text || "").trim().split(/\s+/).filter(Boolean).length;
  return Math.max(2, Math.round(words / WORDS_PER_SECOND));
}

/**
 * @param {string} sourceText
 * @param {{targetSecondsPerSegment?: number}} options
 * @returns {{order:number, text:string, estimatedSeconds:number}[]}
 */
function splitNarration(sourceText, { targetSecondsPerSegment = 8 } = {}) {
  const sentences = splitIntoSentences(sourceText);
  if (!sentences.length) return [];

  const segments = [];
  let current = [];
  let currentSeconds = 0;

  for (const sentence of sentences) {
    const sentenceSeconds = estimateSeconds(sentence);
    if (current.length && currentSeconds + sentenceSeconds > targetSecondsPerSegment) {
      segments.push({ text: current.join(" "), estimatedSeconds: currentSeconds });
      current = [];
      currentSeconds = 0;
    }
    current.push(sentence);
    currentSeconds += sentenceSeconds;
  }
  if (current.length) segments.push({ text: current.join(" "), estimatedSeconds: currentSeconds });

  return segments.map((segment, index) => ({ order: index + 1, ...segment }));
}

module.exports = { splitNarration, estimateSeconds };
