/**
 * WayTtsAdapter — voice-over for The Creator, with silent fallback.
 *
 * The chain, in order, first one that works wins:
 *  1. Your own TTS key (AccountManager "tts-generation" capability, e.g. OpenAI
 *     /audio/speech). No credits, no server hop.
 *  2. The local Way Voice Engine on this device (desktop app). Free, offline,
 *     and the only route that speaks Telugu.
 *  3. Way AI Cloud (way-ai-server /api/proxy/tts). Needs a paid plan and costs
 *     one credit; English voices only.
 *
 * Only if every route fails does the caller see an error, and it then names
 * what each route said instead of demanding one particular provider.
 */
import { resolveProviderCapability } from "./AIProviderCapabilityResolver.js";
import { synthesizeWithVoiceEngine } from "./WayVoiceEngineClient.js";
import { wayAuth } from "./WayAuth.js";
import { isDesktop } from "../lib/tauriCompat.js";

async function generateWithProvider(text, resolved, voice) {
  const response = await fetch(`${resolved.baseUrl}/audio/speech`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${resolved.apiKey}` },
    body: JSON.stringify({ model: resolved.model, input: String(text || "").slice(0, 4096), voice: voice || "alloy" }),
  });
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new Error(data?.error?.message || `TTS generation failed (HTTP ${response.status})`);
  }
  return response.blob();
}

/**
 * Which voice routes to try, in order. Telugu only has one route that can
 * actually speak it (the local engine), so it goes first there; English starts
 * with the user's own key (no credits) before the managed one.
 */
export function voiceRouteOrder({ language = "en", keyRoute = "", hasLocalEngine = false, signedIn = false } = {}) {
  const local = hasLocalEngine ? ["Way Voice Engine (this device)"] : [];
  if (language === "te") return [...local, ...(keyRoute ? [keyRoute] : [])];
  return [
    ...(keyRoute ? [keyRoute] : []),
    ...local,
    ...(signedIn ? ["Way AI Cloud"] : []),
  ];
}

async function generateWithWayCloud(text, voice) {
  const response = await wayAuth.proxyTts({ text, voice });
  return response;
}

/**
 * Generate a narration/voiceover clip.
 * @returns {Promise<{audioUrl:string, audio:Blob, mode:string, route:string, attempts:Array}>}
 */
export async function generateNarration({ text, voice = "alloy", provider = "auto", model = "", language = "" } = {}, accountManager = null) {
  const cleanText = String(text || "").trim();
  if (!cleanText) throw new Error("Narration text is required.");
  // Telugu script in the line means Telugu speech — no one has to pick a
  // language for it, and it decides which routes can serve this line at all.
  const spokenLanguage = language || (/[ఀ-౿]/.test(cleanText) ? "te" : "en");

  await accountManager?.whenReady?.();
  const attempts = [];
  const routes = [];

  const resolved = resolveProviderCapability(accountManager, "tts-generation", { provider, model });
  const keyName = resolved ? `${resolved.providerId} (your key)` : "";
  const runners = {
    [keyName]: () => generateWithProvider(cleanText, resolved, voice),
    "Way Voice Engine (this device)": () => synthesizeWithVoiceEngine(cleanText, spokenLanguage),
    "Way AI Cloud": () => generateWithWayCloud(cleanText, voice),
  };
  for (const name of voiceRouteOrder({
    language: spokenLanguage,
    keyRoute: keyName,
    hasLocalEngine: isDesktop,
    signedIn: Boolean(wayAuth.token && !wayAuth.guest),
  })) {
    routes.push({ name, run: runners[name] });
  }

  for (const route of routes) {
    try {
      const audio = await route.run();
      if (!audio || !audio.size) throw new Error("empty audio");
      return { audioUrl: URL.createObjectURL(audio), audio, mode: route.name === "Way AI Cloud" ? "managed" : "byok", route: route.name, attempts };
    } catch (error) {
      attempts.push({ route: route.name, error: String(error?.message || error).slice(0, 160) });
    }
  }

  const tried = attempts.length ? ` Tried: ${attempts.map((a) => `${a.route} (${a.error})`).join("; ")}.` : "";
  throw new Error(
    `Voice-over could not be generated.${tried} Connect a TTS key in Settings → AI Models & Keys, install the Way Voice Engine in Core → Voice Desk, or upgrade for Way AI Cloud voice.`,
  );
}
