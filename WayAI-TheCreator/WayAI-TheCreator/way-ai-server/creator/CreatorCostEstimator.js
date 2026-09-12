"use strict";

// Pre-generation cost estimates, shown to the user before they commit to a
// paid generation and recorded as an is_estimate=1 ledger row at task-submit
// time. These are nominal placeholder rates, not authoritative provider
// billing — WayIllustrateAdapter/WayVideoAdapter never receive a real
// per-call dollar figure back from either the BYOK or managed paths, so
// "estimate" is the only cost figure this system can ever show; the
// completion-time "actual" row reuses the same number rather than inventing
// a second, equally-fake "actual" that would just duplicate it.
const BASE_RATES = {
  image: { costAmount: 0.04, currency: "USD" },
  video: { costAmount: 0.35, currency: "USD" }, // per second
  audio: { costAmount: 0.015, currency: "USD" }, // per ~200 characters
  text: { costAmount: 0.01, currency: "USD" },
};

function estimateCost({ mediaType, payload = {} } = {}) {
  const base = BASE_RATES[mediaType] || BASE_RATES.text;
  if (mediaType === "video") {
    const seconds = Math.max(1, Number(payload?.durationSeconds) || 5);
    return { costAmount: Number((base.costAmount * seconds).toFixed(6)), currency: base.currency };
  }
  if (mediaType === "audio") {
    const chars = Math.max(1, Number(payload?.text?.length) || 200);
    return { costAmount: Number((base.costAmount * (chars / 200)).toFixed(6)), currency: base.currency };
  }
  return { ...base };
}

module.exports = { estimateCost };
