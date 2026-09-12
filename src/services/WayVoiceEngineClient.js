// The local Way Voice Engine (desktop only, http://localhost:8010). Shared by
// The Creator's voice-over button and the Auto reel pipeline so both start it
// the same way and speak the same languages.
const VOICE_ENGINE_URL = "http://localhost:8010";

async function tauriInvoke(cmd, args = {}) {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke(cmd, args);
}

/** Start the engine if it is installed but not running. */
export async function ensureVoiceEngine() {
  const status = await tauriInvoke("voice_engine_status").catch(() => null);
  if (status?.running) return;
  if (!status?.installed) throw new Error("Way Voice Engine is not downloaded yet (Core → Voice Desk).");
  await tauriInvoke("voice_engine_start");
}

export function pickLanguage(languages, language) {
  const list = Array.isArray(languages) ? languages : [];
  const want = language === "te" ? /telugu/i : /english/i;
  return list.find((name) => want.test(String(name))) || "Auto";
}

/** Speak `text` locally. Returns the audio blob — no network, no credits. */
export async function synthesizeWithVoiceEngine(text, language = "en") {
  await ensureVoiceEngine();
  const meta = await fetch(`${VOICE_ENGINE_URL}/api/meta`).then((r) => r.json()).catch(() => ({}));
  const res = await fetch(`${VOICE_ENGINE_URL}/api/generate/design`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text, language: pickLanguage(meta?.languages, language), attributes: {}, settings: {} }),
  });
  if (!res.ok) throw new Error((await res.text().catch(() => "")) || `Voice engine error (HTTP ${res.status})`);
  return res.blob();
}

export { VOICE_ENGINE_URL };
