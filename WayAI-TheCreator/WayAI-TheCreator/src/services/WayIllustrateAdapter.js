/**
 * WayIllustrateAdapter — swappable image-generation backend for Agent/Engineer tools
 * and the Way AI Flow "Image Generation" node.
 *
 * Two paths, tried in order:
 *  1. BYOK — if the user already added their own OpenAI key in AI Providers settings
 *     (WayAuth.getAPIKey, same store ProfilePanel.jsx/imageSourcing.js read), call OpenAI
 *     directly from the browser with it. No platform credits, no server round-trip.
 *  2. Managed — falls through to way-ai-server's `/api/proxy/illustrate` (DALL-E 3, server's
 *     own OPENAI_API_KEY), which charges platform credits via ComplexityRouter.chargeCredits.
 *     Mirrors RunnerService.js's env-flag backend selection (VITE_RUNNER_TRANSPORT) and
 *     ComplexityRouter.js's server-proxy call shape (token from localStorage, browser never
 *     holds the platform's own provider key).
 */
import { CREDIT_COST, chargeCredits } from "./ComplexityRouter.js";
import { wayAuth } from "./WayAuth.js";
import { resolveProviderCapabilities } from "./AIProviderCapabilityResolver.js";

const API_BASE = (() => {
  // VITE_AUTH_API_URL is the way-ai-server base (/api/proxy/illustrate, credits, etc).
  // VITE_API_URL is a separate general-purpose base that local dev overrides (.env.local)
  // repoint at wayaibusiness for Core's own integration — falling back to it here would
  // silently send illustration calls to a server that doesn't have /api/proxy/illustrate.
  if (typeof import.meta !== "undefined" && import.meta.env?.VITE_AUTH_API_URL) {
    return String(import.meta.env.VITE_AUTH_API_URL).replace(/\/+$/, "");
  }
  if (typeof import.meta !== "undefined" && import.meta.env?.VITE_API_URL) {
    return String(import.meta.env.VITE_API_URL).replace(/\/+$/, "");
  }
  if (typeof window !== "undefined") {
    const host = window.location?.hostname || "";
    if (host.includes("wayaicode.com")) return "https://api.wayaicode.com";
    if (host.includes("interioway.com")) return "https://api.interioway.com";
  }
  return "http://localhost:3001";
})();

function getToken() {
  if (typeof localStorage === "undefined") return "";
  const keys = ["way-auth-token", "wayai_auth_token", "way-auth", "way_token", "wayai_session"];
  for (const key of keys) {
    try {
      const value = localStorage.getItem(key);
      if (!value) continue;
      if (value.trim().startsWith("{")) {
        const parsed = JSON.parse(value);
        if (parsed?.token) return parsed.token;
      } else {
        return value;
      }
    } catch {}
  }
  return "";
}

export function getIllustrateBackendMode() {
  const mode = String(import.meta.env?.VITE_ILLUSTRATE_BACKEND || "api").toLowerCase();
  return mode === "selfhosted" ? "selfhosted" : "api";
}

async function callIllustrateProxy(mode, { prompt, style, aspectRatio }) {
  const token = getToken();
  if (!token) throw new Error("Not authenticated");

  // Backend selection (`mode`) is passed through so the server can route to the hosted
  // text-to-image API ("api", DALL-E 3) or a future RunPod L40S SDXL/Flux endpoint
  // ("selfhosted", not deployed yet — the server returns a clear 503 for that mode today).
  const res = await fetch(`${API_BASE}/api/proxy/illustrate`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ backend: mode, prompt, style, aspectRatio }),
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const rawMessage = typeof data?.error === "string" ? data.error : data?.error?.message || data?.message || "Illustration generation failed";
    const message = /sk-change_me|incorrect api key/i.test(rawMessage)
      ? "Managed image provider is not configured. Add a valid image-provider key or use Media Flow Generate Image for a local preview."
      : rawMessage;
    const error = new Error(message);
    error.code = data?.code || "ILLUSTRATE_ERROR";
    throw error;
  }
  const url = data.url || data.imageUrl || data.output?.url;
  if (!url) throw new Error("Illustration provider returned no image URL");
  return { url, raw: data };
}

const STYLE_HINTS = {
  flat: "flat vector illustration style, clean shapes, minimal shading",
  realistic: "photorealistic, detailed, natural lighting",
  "3d": "3D rendered, soft studio lighting, sense of depth",
  sketch: "hand-drawn sketch style, pencil linework",
  icon: "simple flat icon, centered composition, minimal detail",
};

function styledPrompt(prompt, style) {
  const hint = STYLE_HINTS[String(style || "").toLowerCase()];
  return hint ? `${prompt} — ${hint}` : prompt;
}

// gpt-image-1 (BYOK path) has a DIFFERENT valid size set than DALL-E 3 (way-ai-server's
// managed path, which does its own normalizeIllustrateSize mapping server-side) — "1792x1024"/
// "1024x1792" are rejected by this model (400), which would silently look like "the user's
// key failed" and fall through to the charged managed backend for every non-square request.
function gptImageSizeFromAspectRatio(aspectRatio) {
  const VALID_SIZES = new Set(["1024x1024", "1536x1024", "1024x1536"]);
  const raw = String(aspectRatio || "").trim();
  if (VALID_SIZES.has(raw)) return raw;
  if (raw === "16:9" || raw === "1792x1024") return "1536x1024";
  if (raw === "9:16" || raw === "1024x1792") return "1024x1536";
  return "1024x1024";
}

// Direct BYOK provider call — same shape as src/components/BuildPlan/imageSourcing.js's
// generateOpenAIImage: plain fetch with the user's own key, graceful null on any failure so
// the caller can fall back to the managed (credit-charged) backend instead of dead-ending.
async function generateWithProvider(prompt, resolved, size) {
  try {
    if (resolved.providerId === "nvidia") {
      const [width, height] = String(size || "1024x1024").split("x").map(Number);
      const data = await wayAuth.proxyNvidiaImage({
        apiKey: resolved.apiKey,
        model: resolved.model || "flux.2-klein-4b",
        prompt: String(prompt || "").slice(0, 10000),
        width: width || 1024,
        height: height || 1024,
      });
      const artifact = data?.artifacts?.[0] || data?.data?.[0] || {};
      if (artifact.url) return artifact.url;
      const encoded = artifact.base64 || artifact.b64_json || data?.image;
      return encoded ? `data:image/png;base64,${encoded}` : null;
    }
    const response = await fetch(`${resolved.baseUrl}/images/generations`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${resolved.apiKey}` },
      body: JSON.stringify({ model: resolved.model, prompt: String(prompt || "").slice(0, 4000), size, n: 1 }),
    });
    if (!response.ok) return null;
    const data = await response.json().catch(() => null);
    const item = data?.data?.[0];
    if (!item) return null;
    if (item.url) return item.url;
    if (item.b64_json) return `data:image/png;base64,${item.b64_json}`;
    return null;
  } catch (error) {
    if (resolved.providerId === "nvidia") throw error;
    return null;
  }
}

/**
 * Generate an illustration/image asset.
 * @param {{prompt: string, style?: string, aspectRatio?: string, skipCredits?: boolean}} options
 */
export async function generateIllustration({ prompt, style = "flat", aspectRatio = "1:1", skipCredits = false, provider = "auto", model = "" } = {}, accountManager = null) {
  const cleanPrompt = String(prompt || "").trim();
  if (!cleanPrompt) throw new Error("Illustration prompt is required.");

  // Bring-your-own-key first: if the user already added their own OpenAI key in AI Providers
  // settings, use it directly — no platform credits spent, no server round-trip. Only falls
  // through to the managed/credit-charged backend if there's no key or the call fails.
  // A Flow can be opened immediately after login. Wait for secure local keys and
  // cloud provider accounts to finish hydrating before deciding no account exists.
  await accountManager?.whenReady?.();
  // Every connected image account, best first — a provider that is rate
  // limited, out of credits, or rejects the prompt moves silently to the next
  // one instead of ending the whole request. Only when all of them fail does
  // the managed backend below take over.
  let candidates = resolveProviderCapabilities(accountManager, "image-generation", { provider, model });
  if (!candidates.length && accountManager?.syncFromCloud) {
    // The provider may have been added on another device (or restored server-side)
    // after this tab loaded. Refresh the authenticated provider cache once before
    // reporting that no image account exists.
    await accountManager.syncFromCloud({ force: true }).catch(() => {});
    candidates = resolveProviderCapabilities(accountManager, "image-generation", { provider, model });
  }
  const attempts = [];
  for (const resolved of candidates) {
    try {
      const url = await generateWithProvider(
        styledPrompt(cleanPrompt, style),
        resolved,
        gptImageSizeFromAspectRatio(aspectRatio),
      );
      if (url) return { url, provider: `${resolved.providerId}:byok`, model: resolved.model, prompt: cleanPrompt, style, aspectRatio, attempts };
      attempts.push({ provider: resolved.providerId, error: "no image returned" });
    } catch (error) {
      // generateWithProvider re-throws for NVIDIA specifically (see its own comment)
      // so a bad key is visible rather than silent; here that just means this
      // candidate is recorded and the next one is tried.
      attempts.push({ provider: resolved.providerId, error: String(error?.message || error).slice(0, 160) });
    }
  }
  if (String(provider || "auto").toLowerCase() === "nvidia") {
    // Server-owned account fallback: the signed-in user's saved NVIDIA account is
    // resolved by way-ai-server. This keeps Flow functional in a fresh browser or
    // desktop client even when its local Accounts cache has not hydrated.
    const cloudModel = String(model || "flux.2-klein-4b").trim();
    const url = await generateWithProvider(
      styledPrompt(cleanPrompt, style),
      { providerId: "nvidia", apiKey: "", model: cloudModel },
      gptImageSizeFromAspectRatio(aspectRatio),
    );
    if (url) return { url, provider: "nvidia:account", model: cloudModel, prompt: cleanPrompt, style, aspectRatio };
    throw new Error("NVIDIA returned no image artifact. Try the flow again.");
  }
  if (String(provider || "auto").toLowerCase() !== "auto") {
    const tried = attempts.length ? ` Tried: ${attempts.map((a) => `${a.provider} (${a.error})`).join("; ")}.` : "";
    throw new Error(`${provider} has no usable image-generation account/model.${tried} Open Settings → AI Models & Keys and connect an image-capable provider.`);
  }

  // Charge only after a successful generation — charging first (the pre-existing behavior
  // here) means every provider failure (rate limit, content policy rejection, network error,
  // "selfhosted" not configured) charges the user for an image they never got, with no refund.
  const mode = getIllustrateBackendMode();
  const result = await callIllustrateProxy(mode, { prompt: cleanPrompt, style, aspectRatio });
  if (!skipCredits) {
    await chargeCredits(CREDIT_COST.image_generate, `Illustration (${mode})`, { type: "image_generate", layer: 3 });
  }
  return { url: result.url, provider: mode, prompt: cleanPrompt, style, aspectRatio };
}
