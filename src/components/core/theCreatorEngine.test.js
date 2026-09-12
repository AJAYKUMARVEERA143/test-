import { describe, expect, it } from "vitest";
import {
  applyCreatorAIScript,
  approveCreatorGate,
  createCreatorExportManifest,
  createCreatorFlowHandoff,
  createCreatorPreviewHtml,
  createCreatorProject,
  createCreatorRenderJob,
  loadCreatorRenderQueue,
  reorderCreatorScene,
  saveCreatorRenderJob,
  summarizeCreatorProject,
  updateCreatorAnimationLayer,
  updateCreatorScene,
} from "./theCreatorEngine.js";

describe("theCreatorEngine", () => {
  it("builds one project spanning reels, clips, animation, comics, illustration, and footage", () => {
    const project = createCreatorProject({
      brief: "Create reel, clip, animation, comic, illustration, and footage pack about NOVA sales",
      pipelineId: "creator-all",
      now: new Date("2026-08-13T00:00:00.000Z"),
    });

    expect(project.studio).toBe("THE CREATOR");
    expect(project.ownerAgentId).toBe("wayaiagent");
    expect(project.lanes).toEqual(expect.arrayContaining(["reels", "clips", "animation", "comics", "illustration", "footage"]));
    expect(project.storyboard.length).toBeGreaterThanOrEqual(4);
    expect(project.clipCandidates.length).toBeGreaterThan(0);
    expect(project.comicPanels.length).toBeGreaterThan(0);
    expect(project.animationPlan.layers.length).toBeGreaterThan(0);
    expect(project.illustrationPrompts.length).toBeGreaterThan(0);
    expect(project.footageManifest.assets.length).toBeGreaterThan(0);
    expect(project.approvals.some((gate) => gate.status !== "approved")).toBe(true);
    expect(summarizeCreatorProject(project)).toContain("CREATOR");
  });

  it("creates safe export and Flow handoff manifests with live execution disabled", () => {
    const project = createCreatorProject({ brief: "Nova create short video about sales", now: new Date("2026-08-13T00:00:00.000Z") });
    const manifest = createCreatorExportManifest(project);
    const handoff = createCreatorFlowHandoff(project);

    expect(manifest.safety).toMatchObject({
      mode: "safe_autopilot_v1",
      liveProviderExecutionEnabled: false,
      externalPublishEnabled: false,
    });
    expect(handoff.source).toBe("the-creator");
    expect(handoff.runtime).toMatchObject({
      externalExecutionEnabled: false,
    });
    expect(JSON.stringify(handoff)).not.toMatch(/[\u3400-\u9fff]/);
  });

  it("advances local gates without enabling external publishing", () => {
    const project = createCreatorProject({ brief: "Nova make comic page about onboarding", now: new Date("2026-08-13T00:00:00.000Z") });
    const next = approveCreatorGate(project, project.approvals[0].id);
    expect(next.readiness).toBeGreaterThanOrEqual(project.readiness);
    expect(createCreatorExportManifest(next).safety.externalPublishEnabled).toBe(false);
  });

  it("queues a local draft render job without live provider execution", () => {
    const storage = new Map();
    const adapter = {
      getItem: (key) => storage.get(key) || null,
      setItem: (key, value) => storage.set(key, value),
    };
    const project = createCreatorProject({
      brief: "Nova create reel animation footage about support automation",
      now: new Date("2026-08-13T00:00:00.000Z"),
    });
    const job = createCreatorRenderJob(project, { now: new Date("2026-08-13T01:00:00.000Z") });
    const queue = saveCreatorRenderJob(job, adapter);

    expect(job.status).toBe("queued");
    expect(job.safety).toMatchObject({
      liveProviderExecutionEnabled: false,
      publishEnabled: false,
      approvalRequiredBeforeLiveRender: true,
    });
    expect(job.timeline.length).toBe(project.storyboard.length);
    expect(job.expectedOutputs).toContain("render-job.json");
    expect(job.expectedOutputs).toContain("preview.html");
    expect(queue.activeJobId).toBe(job.id);
    expect(loadCreatorRenderQueue(adapter).jobs).toHaveLength(1);
  });

  it("creates a standalone local HTML render preview", () => {
    const project = createCreatorProject({
      brief: "Nova create preview video about sales follow ups",
      now: new Date("2026-08-13T00:00:00.000Z"),
    });
    const job = createCreatorRenderJob(project, { now: new Date("2026-08-13T01:00:00.000Z") });
    const html = createCreatorPreviewHtml(project, { renderJob: job });

    expect(html).toContain("<!doctype html>");
    expect(html).toContain("creator-preview-standalone");
    expect(html).toContain("Local preview only");
    expect(html).toContain(project.storyboard[0].beat);
    expect(html).not.toMatch(/[\u3400-\u9fff]/);
  });

  it("edits a scene's duration/caption/narration in place without touching other scenes", () => {
    const project = createCreatorProject({ brief: "Nova create reel about onboarding", now: new Date("2026-08-13T00:00:00.000Z") });
    const target = project.storyboard[0];
    const untouched = project.storyboard[1];

    const next = updateCreatorScene(project, target.id, {
      durationSeconds: 12,
      caption: "Updated caption",
      narration: "Updated narration",
    });

    const editedScene = next.storyboard.find((scene) => scene.id === target.id);
    expect(editedScene.durationSeconds).toBe(12);
    expect(editedScene.caption).toBe("Updated caption");
    expect(editedScene.narration).toBe("Updated narration");
    expect(next.storyboard.find((scene) => scene.id === untouched.id)).toEqual(untouched);
    expect(next.storyboard.length).toBe(project.storyboard.length);
  });

  it("clamps edited scene duration to a safe range instead of accepting garbage input", () => {
    const project = createCreatorProject({ brief: "Nova create reel about onboarding", now: new Date("2026-08-13T00:00:00.000Z") });
    const target = project.storyboard[0];

    const tooLow = updateCreatorScene(project, target.id, { durationSeconds: -5 });
    const tooHigh = updateCreatorScene(project, target.id, { durationSeconds: 99999 });
    const notANumber = updateCreatorScene(project, target.id, { durationSeconds: "abc" });

    expect(tooLow.storyboard[0].durationSeconds).toBe(1);
    expect(tooHigh.storyboard[0].durationSeconds).toBe(600);
    expect(notANumber.storyboard[0].durationSeconds).toBe(target.durationSeconds);
  });

  it("reorders scenes and renumbers them, and refuses to move past either end", () => {
    const project = createCreatorProject({
      brief: "Create reel, clip, animation, comic, illustration, and footage pack about NOVA sales",
      pipelineId: "creator-all",
      now: new Date("2026-08-13T00:00:00.000Z"),
    });
    const [first, second] = project.storyboard;

    const swapped = reorderCreatorScene(project, second.id, -1);
    expect(swapped.storyboard[0].id).toBe(second.id);
    expect(swapped.storyboard[1].id).toBe(first.id);
    expect(swapped.storyboard[0].order).toBe(1);
    expect(swapped.storyboard[1].order).toBe(2);

    const noMoveAtStart = reorderCreatorScene(project, first.id, -1);
    expect(noMoveAtStart).toBe(project);

    const lastScene = project.storyboard[project.storyboard.length - 1];
    const noMoveAtEnd = reorderCreatorScene(project, lastScene.id, 1);
    expect(noMoveAtEnd).toBe(project);
  });

  it("varies each scene's visual direction instead of repeating the same keywords on every card", () => {
    const project = createCreatorProject({
      brief: "Create a house tour reel about a bright kitchen, a cozy bedroom, warm interior lighting, and a wide living room",
      pipelineId: "creator-all",
      now: new Date("2026-08-13T00:00:00.000Z"),
    });

    const directions = project.storyboard.map((scene) => scene.visualDirection);
    const uniqueDirections = new Set(directions);
    expect(project.storyboard.length).toBeGreaterThan(2);
    expect(uniqueDirections.size).toBeGreaterThan(1);
  });

  it("merges AI-written scene content by position and marks the project as AI-written, without touching structural fields", () => {
    const project = createCreatorProject({ brief: "Nova create reel about onboarding", now: new Date("2026-08-13T00:00:00.000Z") });
    const originalIds = project.storyboard.map((scene) => scene.id);
    const originalDurations = project.storyboard.map((scene) => scene.durationSeconds);

    const aiScenes = project.storyboard.map((scene, index) => ({
      beat: scene.beat,
      narration: `AI narration for scene ${index + 1}`,
      cameraAngle: `AI camera ${index + 1}`,
      caption: `AI caption ${index + 1}`,
      visualDirection: `AI visual direction ${index + 1}`,
    }));

    const next = applyCreatorAIScript(project, aiScenes);

    expect(next.scriptSource).toBe("ai");
    expect(next.storyboard.map((scene) => scene.id)).toEqual(originalIds);
    expect(next.storyboard.map((scene) => scene.durationSeconds)).toEqual(originalDurations);
    expect(next.storyboard[0].narration).toBe("AI narration for scene 1");
    expect(next.storyboard[0].camera).toBe("AI camera 1");
    expect(next.storyboard[0].caption).toBe("AI caption 1");
    expect(next.storyboard[0].visualDirection).toBe("AI visual direction 1");
  });

  it("leaves the project unchanged when applyCreatorAIScript gets no scenes", () => {
    const project = createCreatorProject({ brief: "Nova create reel about onboarding", now: new Date("2026-08-13T00:00:00.000Z") });
    expect(applyCreatorAIScript(project, [])).toBe(project);
    expect(applyCreatorAIScript(project, null)).toBe(project);
    expect(applyCreatorAIScript(null, [{ narration: "x" }])).toBe(null);
  });

  it("updates a single animation layer's instruction without touching the others", () => {
    const project = createCreatorProject({
      brief: "Create reel, clip, animation, comic, illustration, and footage pack about NOVA sales",
      pipelineId: "creator-all",
      now: new Date("2026-08-13T00:00:00.000Z"),
    });
    const target = project.animationPlan.layers[0];
    const untouched = project.animationPlan.layers[1];

    const next = updateCreatorAnimationLayer(project, target.id, "A brand-new camera move.");

    expect(next.animationPlan.layers[0].instruction).toBe("A brand-new camera move.");
    expect(next.animationPlan.layers[1]).toEqual(untouched);
  });
});
