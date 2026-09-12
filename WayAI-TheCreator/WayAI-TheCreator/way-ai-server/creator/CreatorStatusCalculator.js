"use strict";

// Project/episode completion state is never stored — it's always derived here
// from what actually exists, so it can never drift out of sync with reality.
// Pure functions only: no DB access, no side effects.

function computeEpisodeStatus(episode) {
  if (!episode) return "missing";
  if (!episode.script_json && !episode.script) return "unscripted";
  return "scripted";
}

function computeProjectStatus(project, episodes = []) {
  if (!project) return "missing";
  const episodeStatuses = episodes.map(computeEpisodeStatus);
  const total = episodeStatuses.length;
  const scripted = episodeStatuses.filter((status) => status === "scripted").length;
  if (total === 0) return "empty";
  if (scripted === 0) return "planning";
  if (scripted < total) return "in_progress";
  return "scripted_complete";
}

function computeProjectProgress(project, episodes = []) {
  const total = episodes.length;
  if (total === 0) return { total, scripted: 0, percent: 0 };
  const scripted = episodes.filter((episode) => computeEpisodeStatus(episode) === "scripted").length;
  return { total, scripted, percent: Math.round((scripted / total) * 100) };
}

module.exports = { computeEpisodeStatus, computeProjectStatus, computeProjectProgress };
