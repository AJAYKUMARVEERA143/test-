import { PROVIDERS } from "../lib/AccountManager.js";
import { wayAuth } from "./WayAuth.js";

const PLACEHOLDER_KEY = /change[_-]?me|your[_-]?(?:api[_-]?)?key|placeholder|example/i;

export function isUsableProviderKey(value) {
  const key = String(value || "").trim();
  const masked = key.startsWith("...") || /^[*\u2022]+$/.test(key) || /^\[?redacted\]?$/i.test(key);
  return key.length >= 12 && !masked && !PLACEHOLDER_KEY.test(key);
}

function supportsCapability(provider, capability) {
  return Array.isArray(provider?.capabilities) && provider.capabilities.includes(capability);
}

// Maps a capability string to the account/provider field names that hold its
// model/base-URL — text is the implicit default (account.model/provider.baseUrl),
// every other capability declares its own fields here instead of growing another
// one-off `isXCapability` branch each time a new generation type is added.
const CAPABILITY_FIELD_MAP = {
  "image-generation": { modelField: "imageModel", baseUrlField: "imageBaseUrl", defaultModelField: "defaultImageModel", defaultBaseUrlField: "imageBaseUrl" },
  "video-generation": { modelField: "videoModel", baseUrlField: "videoBaseUrl", defaultModelField: "defaultVideoModel", defaultBaseUrlField: "videoBaseUrl" },
  "tts-generation": { modelField: "ttsModel", baseUrlField: "ttsBaseUrl", defaultModelField: "defaultTtsModel", defaultBaseUrlField: "ttsBaseUrl" },
  // Lip-sync: no provider in PROVIDERS declares it yet, so this resolves to
  // nothing and The Creator routes dialogue shots to motion video instead —
  // connecting an account that declares the capability switches it on.
  "lipsync-generation": { modelField: "lipsyncModel", baseUrlField: "lipsyncBaseUrl", defaultModelField: "defaultLipsyncModel", defaultBaseUrlField: "lipsyncBaseUrl" },
};

/**
 * Every account that can serve this capability, best first (free/cheap
 * providers before paid ones). Callers that rotate — image and video
 * generation — walk this list so one provider's outage, quota or content
 * rejection silently moves to the next connected account instead of failing.
 */
export function resolveProviderCapabilities(accountManager, capability, options = {}) {
  const preferredProvider = String(options.provider || "auto").toLowerCase();
  const preferredModel = String(options.model || "").trim();
  // AccountManager is the primary source. The authenticated cloud cache is also
  // considered so a Flow started during account hydration can still use the
  // credential saved for the same signed-in user.
  const accounts = [
    ...(accountManager?.getAll?.() || []),
    ...(wayAuth.getProviderAccounts?.() || []),
  ];
  const candidates = accounts.filter((account) => {
    const provider = PROVIDERS[account?.provider];
    if (!provider || !supportsCapability(provider, capability)) return false;
    if (preferredProvider !== "auto" && account.provider !== preferredProvider) return false;
    if (account.status === "disabled" || account.disabled === true) return false;
    return isUsableProviderKey(account.apiKey);
  });
  // Free/cheap providers first (stable sort — ties keep their original, i.e.
  // connection-order, relative order). Without this, whichever provider the
  // user happened to connect first absorbs every generation request even when
  // a free option (e.g. NVIDIA NIM) is also connected — a paid account's own
  // billing/quota trouble then blocks the whole capability instead of quietly
  // falling through to the free one, which is the opposite of what a "free
  // tier first" app should do.
  candidates.sort((a, b) => (PROVIDERS[a.provider]?.costPer1k ?? 0) - (PROVIDERS[b.provider]?.costPer1k ?? 0));

  const fields = CAPABILITY_FIELD_MAP[capability] || null;

  const resolvedList = [];
  const seen = new Set();
  for (const account of candidates) {
    const provider = PROVIDERS[account.provider];
    const model = fields
      ? (preferredModel || account[fields.modelField] || provider[fields.defaultModelField])
      : (preferredModel || account.model || provider.defaultModel);
    if (!model) continue;
    const key = `${account.provider}:${account.id || account.apiKey}:${model}`;
    if (seen.has(key)) continue;
    seen.add(key);
    resolvedList.push({
      accountId: account.id,
      providerId: account.provider,
      apiKey: account.apiKey,
      baseUrl: fields
        ? String(account[fields.baseUrlField] || account.baseUrl || provider[fields.defaultBaseUrlField] || provider.baseUrl || "").replace(/\/+$/, "")
        : String(account.baseUrl || provider.baseUrl || "").replace(/\/+$/, ""),
      model,
    });
  }

  // Backward compatibility for keys saved before Accounts cloud sync existed.
  if (capability === "image-generation" && (preferredProvider === "auto" || preferredProvider === "chatgpt" || preferredProvider === "openai")) {
    const apiKey = wayAuth.getAPIKey("openai");
    if (isUsableProviderKey(apiKey) && !resolvedList.some((item) => item.providerId === "chatgpt")) {
      const provider = PROVIDERS.chatgpt;
      resolvedList.push({ providerId: "chatgpt", apiKey, baseUrl: provider.imageBaseUrl, model: preferredModel || provider.defaultImageModel });
    }
  }
  return resolvedList;
}

/** The single best account for a capability, or null. */
export function resolveProviderCapability(accountManager, capability, options = {}) {
  return resolveProviderCapabilities(accountManager, capability, options)[0] || null;
}
