/**
 * Consistency engine — the reason a character's face and a prop (the tea cup,
 * the chair, that one car) stay the same from scene to scene.
 *
 * Every saved Asset Library entry carries a short "locked look" description.
 * Before an image or clip prompt is sent to any provider, the assets this
 * scene actually mentions are appended to the prompt as fixed wording. Same
 * words every time = the same look every time, whichever provider the
 * rotation happens to land on.
 */

const STOP_WORDS = new Set(["the", "a", "an", "of", "and", "his", "her", "their", "our", "this", "that"]);

/** The locked description for one asset, or "" when it has nothing usable. */
export function lockPhrase(asset) {
  if (!asset?.name) return "";
  const definition = typeof asset.definition === "string" ? safeParse(asset.definition) : asset.definition || {};
  const look = String(definition.lockedLook || definition.description || asset.description || "").trim();
  if (!look) return "";
  const kind = String(asset.assetType || asset.type || "asset").toLowerCase();
  return `${kind === "character" ? "Character" : kind === "prop" ? "Prop" : kind === "scene" ? "Location" : "Product"} "${asset.name}": ${look}`;
}

function safeParse(value) {
  try { return JSON.parse(value) || {}; } catch { return {}; }
}

function mentions(text, name) {
  const needle = String(name || "").trim().toLowerCase();
  if (needle.length < 2) return false;
  const haystack = ` ${String(text || "").toLowerCase()} `;
  if (haystack.includes(` ${needle} `) || haystack.includes(`${needle}'s`)) return true;
  // A two-word name matches on its distinctive word too ("Banana Seller" ->
  // "seller"), so a scene line that only uses part of the name still locks.
  return needle.split(/\s+/).filter((word) => word.length > 3 && !STOP_WORDS.has(word)).some((word) => haystack.includes(` ${word} `));
}

/**
 * Assets that belong in this scene's prompt: the ones it names, plus every
 * character when the scene names none (a scene almost always shows the cast,
 * and drifting faces are the most obvious kind of drift).
 */
export function assetsForScene(sceneText, assets = []) {
  const usable = (assets || []).filter((asset) => lockPhrase(asset));
  const named = usable.filter((asset) => mentions(sceneText, asset.name));
  if (named.length) return named;
  return usable.filter((asset) => String(asset.assetType || asset.type || "").toLowerCase() === "character").slice(0, 2);
}

/**
 * The prompt a provider should actually receive: the scene's own direction,
 * then the locked looks, then the style. Returns the prompt unchanged when
 * there is nothing to lock.
 */
export function applyConsistency(prompt, { sceneText = "", assets = [], style = "" } = {}) {
  const base = String(prompt || "").trim();
  const locks = assetsForScene(sceneText || base, assets).map(lockPhrase).filter(Boolean);
  const styleLine = String(style || "").trim();
  return [
    base,
    locks.length ? `Keep these exactly consistent — ${locks.join(" | ")}` : "",
    styleLine ? `Style: ${styleLine}. Same style in every scene.` : "",
  ].filter(Boolean).join(" ");
}
