// way-ai-server/routes/creatorTasks.js
// Creator Studio: generation task enqueue/poll/cancel.
// Status reaches the frontend via polling (GET /?sinceId=), not SSE/WebSocket —
// see the Creator Studio plan's judgment call on why polling was chosen.

const express = require("express");
const { CreatorTaskRepository } = require("../creator/CreatorTaskRepository.js");
const { CreatorApiCallRepository } = require("../creator/CreatorApiCallRepository.js");
const { estimateCost } = require("../creator/CreatorCostEstimator.js");

// video_clip is worker-claimed (async submit-then-poll, see CreatorJobWorker.js).
// product_shot/narration_scene_image/narration_scene_audio are synchronous —
// the browser calls the relevant adapter directly (WayIllustrateAdapter /
// WayTtsAdapter) and then reports completion itself via POST /:id/complete
// below, since a single image or TTS call has no long-running job to poll.
const TASK_TYPES = new Set(["video_clip", "product_shot", "narration_scene_image", "narration_scene_audio"]);
const MEDIA_TYPES = new Set(["text", "image", "video", "audio"]);

module.exports = (db) => {
  const router = express.Router();
  const tasks = new CreatorTaskRepository(db);
  const apiCalls = new CreatorApiCallRepository(db);

  router.post("/", async (req, res) => {
    try {
      const { projectId, taskType, mediaType, resourceId, resourceType, payload } = req.body || {};
      if (!TASK_TYPES.has(taskType)) return res.status(400).json({ error: `taskType must be one of: ${[...TASK_TYPES].join(", ")}` });
      if (!MEDIA_TYPES.has(mediaType)) return res.status(400).json({ error: `mediaType must be one of: ${[...MEDIA_TYPES].join(", ")}` });
      if (!resourceId || !resourceType) return res.status(400).json({ error: "resourceId and resourceType are required" });

      // Estimate-first: the cost ledger gets an is_estimate=1 row the moment a
      // task is submitted, before any provider spend happens, so a cost panel
      // can show "money about to be spent" rather than only spend already made.
      // The same estimate rides along in the task's own payload so a later
      // completion (worker-driven or client-reported) has a real number to
      // record as its "actual" row instead of defaulting to 0 — see
      // CreatorJobWorker.js's payload.estimatedCostAmount usage.
      const estimate = estimateCost({ mediaType, payload });
      const enrichedPayload = { ...(payload || {}), estimatedCostAmount: estimate.costAmount, estimatedCostCurrency: estimate.currency };
      const task = await tasks.create(req.user.id, { projectId: projectId || null, taskType, mediaType, resourceId, resourceType, payload: enrichedPayload });
      await apiCalls.recordCall(req.user.id, {
        projectId: projectId || null,
        taskId: task.id,
        callType: mediaType,
        provider: "estimate",
        model: taskType,
        costAmount: estimate.costAmount,
        currency: estimate.currency,
        isEstimate: true,
      });
      res.status(201).json({ task });
    } catch (err) {
      if (err?.code === "ER_DUP_ENTRY") return res.status(409).json({ error: err.message || "A task is already active for this resource" });
      res.status(500).json({ error: err.message });
    }
  });

  // Poll endpoint: pass sinceId (a previously-seen task id) to get only tasks
  // created after it, so the frontend can poll cheaply while any task for the
  // project is non-terminal.
  router.get("/", async (req, res) => {
    try {
      const { projectId, sinceId, status } = req.query;
      if (!projectId) return res.status(400).json({ error: "projectId is required" });
      const rows = sinceId
        ? await tasks.listSince(req.user.id, projectId, sinceId)
        : await tasks.listByProject(req.user.id, projectId, { status });
      res.json({ tasks: rows });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.get("/:id", async (req, res) => {
    try {
      const task = await tasks.getById(req.user.id, req.params.id);
      if (!task) return res.status(404).json({ error: "Task not found" });
      res.json({ task });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Client-reported completion for synchronous task types (product_shot today).
  // Ownership is verified via getById(userId, id) before mutating — markCompleted/
  // markFailed themselves are unscoped (they're also used by the internal worker,
  // which processes tasks across all users), so this route is the boundary that
  // enforces a user can only complete/fail their own task.
  router.post("/:id/complete", async (req, res) => {
    try {
      const existing = await tasks.getById(req.user.id, req.params.id);
      if (!existing) return res.status(404).json({ error: "Task not found" });
      const { result, cost } = req.body || {};
      const task = await tasks.markCompleted(req.params.id, result);
      if (cost) {
        await apiCalls.recordCall(req.user.id, {
          projectId: existing.project_id,
          taskId: existing.id,
          callType: cost.callType || "image",
          provider: cost.provider || "unknown",
          model: cost.model || "unknown",
          costAmount: cost.costAmount || 0,
          currency: cost.currency || "USD",
          isEstimate: !!cost.isEstimate,
        });
      }
      res.json({ task });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.post("/:id/fail", async (req, res) => {
    try {
      const existing = await tasks.getById(req.user.id, req.params.id);
      if (!existing) return res.status(404).json({ error: "Task not found" });
      const { errorCode, errorMessage } = req.body || {};
      const task = await tasks.markFailed(req.params.id, { errorCode, errorMessage });
      res.json({ task });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.post("/:id/cancel", async (req, res) => {
    try {
      const ok = await tasks.cancel(req.user.id, req.params.id);
      if (!ok) return res.status(404).json({ error: "Task not found or already finished" });
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  return router;
};
