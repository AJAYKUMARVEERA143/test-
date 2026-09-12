/**
 * WayCreatorScriptAdapter — real AI-written storyboard content for THE CREATOR.
 *
 * THE CREATOR's default "Build plan" path is deterministic: fixed sentence templates
 * (scriptLine in theCreatorEngine.js) with the brief's keywords swapped in — instant and
 * free, but not original writing. This adapter is the honest, opt-in upgrade: it calls
 * the same managed routeAndCall path Way AI Flow already uses for one-shot AI node
 * execution (server-side model, charged in credits, requires sign-in) to have an actual
 * model write per-scene narration, camera direction, caption, and visual direction
 * grounded in the real brief, instead of reusing one fixed phrase per beat.
 */
import { routeAndCall, buildAccountManagerFallback } from "./ComplexityRouter.js";

function stripCodeFence(text = "") {
  return String(text || "")
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```\s*$/i, "")
    .trim();
}

export async function generateCreatorScriptWithAI({ brief, formatLabel, formatAspect, durationSeconds, style, beats, manager }) {
  const cleanBrief = String(brief || "").trim();
  if (!cleanBrief) throw new Error("A brief is required to generate a script.");
  if (!Array.isArray(beats) || !beats.length) throw new Error("No scenes to write for.");

  const prompt = [
    `Brief: ${cleanBrief}`,
    `Format: ${formatLabel} (${formatAspect}, about ${durationSeconds || 30}s total)`,
    `Visual style: ${style}`,
    `Scenes needed, in order: ${beats.join(", ")}`,
    "",
    `For each of the ${beats.length} beats above, write ONE original scene grounded specifically in the brief above — not a generic template, not reused phrasing across scenes.`,
    'Return ONLY a JSON array (no prose, no markdown fences) of exactly ' + beats.length + ' objects, one per beat in order, each shaped like:',
    '{"beat":"<beat name>","narration":"<1-2 original sentences, specific to the brief>","cameraAngle":"<specific camera move/angle for this scene>","caption":"<short on-screen caption, distinct wording from the narration>","visualDirection":"<what is actually on screen, specific to the brief\'s subject, not generic>"}',
  ].join("\n");

  const response = await routeAndCall(prompt, [
    {
      role: "system",
      content: "You are a creative director writing an original short-form video script. Write vivid, specific, human-sounding narration and camera direction grounded in the given brief. Never reuse the same sentence structure across scenes. Return ONLY valid JSON, no markdown fences, no commentary.",
    },
    { role: "user", content: prompt },
  ], {
    maxTokens: Math.max(1400, beats.length * 350),
    // Without this, one platform-side hiccup (rate limit, misconfigured proxy)
    // fails the whole script generation even with good connected accounts.
    fallbackToAccountManager: buildAccountManagerFallback(manager),
  });

  const text = typeof response === "string" ? response : (response?.text || response?.content || "");
  const cleaned = stripCodeFence(text);
  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    // Models frequently ignore "return ONLY JSON" and wrap the array in a
    // sentence ("Here's the script:\n\n[...]\n\nLet me know if...") despite
    // the system prompt saying not to — pull out the array substring instead
    // of giving up on the first character that isn't itself valid JSON.
    const start = cleaned.indexOf("[");
    const end = cleaned.lastIndexOf("]");
    if (start === -1 || end === -1 || end < start) {
      throw new Error("The model didn't return valid scene data. Try again.");
    }
    try {
      parsed = JSON.parse(cleaned.slice(start, end + 1));
    } catch {
      throw new Error("The model didn't return valid scene data. Try again.");
    }
  }
  if (!Array.isArray(parsed) || !parsed.length) {
    throw new Error("The model didn't return any scenes. Try again.");
  }
  return parsed.map((scene, index) => ({
    beat: String(scene?.beat || beats[index] || `Scene ${index + 1}`),
    narration: String(scene?.narration || "").trim(),
    cameraAngle: String(scene?.cameraAngle || "").trim(),
    caption: String(scene?.caption || "").trim(),
    visualDirection: String(scene?.visualDirection || "").trim(),
  }));
}
