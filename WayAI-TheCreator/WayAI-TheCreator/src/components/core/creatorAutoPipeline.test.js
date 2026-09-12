import { describe, expect, it } from "vitest";
import {
  isAutoReelRequest,
  outputFileName,
  parseCreatorRequest,
  planScenes,
  runCreatorPipeline,
  sceneDuration,
} from "./creatorAutoPipeline.js";

describe("parseCreatorRequest", () => {
  it("reads the spoken Telugu-English request NOVA hears", () => {
    const plan = parseCreatorRequest("NOVA, The Creator lo 30 second technology reel tayaru chey");
    expect(plan).toMatchObject({ durationSeconds: 30, topic: "technology", format: "reel", language: "en" });
  });

  it("detects Telugu script and minutes, and clamps absurd lengths", () => {
    expect(parseCreatorRequest("ఆరోగ్యం గురించి 45 సెకన్ల రీల్").language).toBe("te");
    expect(parseCreatorRequest("make a 2 minute video about solar energy")).toMatchObject({ durationSeconds: 120, topic: "solar energy" });
    expect(parseCreatorRequest("5 second reel on cats").durationSeconds).toBe(10);
    expect(parseCreatorRequest("600 second reel").durationSeconds).toBe(180);
  });

  it("asks for Telugu narration when the request says so in English", () => {
    expect(parseCreatorRequest("30 sec reel about farming in telugu")).toMatchObject({ language: "te", topic: "farming" });
  });
});

describe("isAutoReelRequest", () => {
  it("fires for finished-video requests in English, Telugu-English and Telugu", () => {
    for (const t of [
      "NOVA, The Creator lo 30 second technology reel tayaru chey",
      "make a video about solar energy",
      "45 sec reel on cricket",
      "ఆరోగ్యం గురించి రీల్ తయారు చెయ్",
    ]) expect(isAutoReelRequest(t), t).toBe(true);
  });

  it("stays out of the way for opening the studio or planning", () => {
    for (const t of ["open the creator", "creator lo storyboard chupinchu", "what is a reel", "plan my week"]) {
      expect(isAutoReelRequest(t), t).toBe(false);
    }
  });
});

describe("NOVA voice route", () => {
  it("turns the spoken sentence into a Creator auto-reel command end to end", async () => {
    const { parseVoiceCommand } = await import("../../voice/voiceCommands.js");
    const spoken = "nova, the creator lo 30 second technology reel tayaru chey";
    const parsed = parseVoiceCommand(spoken);
    expect(parsed?.action).toBe("creator_auto_reel");
    expect(parsed.prompt).toMatch(/^\/core creator reel /);
    // What the Creator panel receives:
    expect(isAutoReelRequest(parsed.prompt)).toBe(true);
    expect(parseCreatorRequest(parsed.prompt)).toMatchObject({ topic: "technology", durationSeconds: 30 });
  });

  it("leaves 'open the creator' as a plain open", async () => {
    const { parseVoiceCommand } = await import("../../voice/voiceCommands.js");
    expect(parseVoiceCommand("open the creator")?.action).toBe("open_creator_studio");
  });
});

describe("planScenes / sceneDuration", () => {
  it("plans about six seconds a scene within 3–6 scenes", () => {
    expect(planScenes(30).map((s) => s.beat)).toEqual(["Hook", "Problem", "Insight", "Proof", "Call to action"]);
    expect(planScenes(10)).toHaveLength(3);
    expect(planScenes(180)).toHaveLength(6);
    expect(planScenes(30).reduce((n, s) => n + s.durationSeconds, 0)).toBeCloseTo(30, 0);
  });

  it("lets the voice set the scene length", () => {
    expect(sceneDuration(6, 7.2)).toBe(7.6);
    expect(sceneDuration(6, 1)).toBe(3.6); // never collapses far below the plan
    expect(sceneDuration(6, 0)).toBe(6);
  });

  it("names the file after the topic", () => {
    expect(outputFileName("Solar Energy!", new Date("2026-09-11T10:20:00Z"))).toBe("solar-energy-2026-09-11-10-20.mp4");
  });
});

function deps(overrides = {}) {
  const calls = { render: null, steps: [] };
  const base = {
    writeScript: async ({ beats }) => beats.map((beat) => ({ beat, narration: `About ${beat}`, caption: `${beat}!`, visualDirection: `${beat} shot` })),
    generateVideo: async () => ({ videoUri: "https://clips/x.mp4", route: "gemini" }),
    generateImage: async () => ({ url: "https://img/x.png", provider: "nvidia" }),
    makeTitleCard: async (scene) => `data:image/png;base64,card-${scene.index}`,
    synthesizeVoice: async () => ({ audio: new Uint8Array([1, 2]), seconds: 5, route: "way-voice" }),
    pickMusic: async () => null,
    outputPath: async (name) => `C:/Videos/Way AI/${name}`,
    render: async (job) => { calls.render = job; return { success: true, outputPath: job.outputPath }; },
    ...overrides,
  };
  return { deps: base, calls };
}

describe("runCreatorPipeline", () => {
  it("builds a full reel: script, AI clips, voice, timeline, render", async () => {
    const { deps: d, calls } = deps();
    const steps = [];
    const out = await runCreatorPipeline("30 second technology reel", d, (s) => steps.push(s.stage));
    expect(out.outputPath).toMatch(/^C:\/Videos\/Way AI\/technology-.*\.mp4$/);
    expect(calls.render.scenes).toHaveLength(5);
    expect(calls.render.scenes[0]).toMatchObject({ videoUrl: "https://clips/x.mp4", caption: "Hook!", durationSeconds: 5.4 });
    expect(out.report.scenes.every((s) => s.visual === "video:gemini" && s.voice === "way-voice")).toBe(true);
    expect(steps[0]).toBe("script");
    expect(steps.at(-1)).toBe("done");
  });

  it("never stops for a missing account: video → image → title card", async () => {
    let n = 0;
    const { deps: d, calls } = deps({
      generateVideo: async () => { throw new Error("No video route worked"); },
      generateImage: async () => { n += 1; if (n % 2) throw new Error("image quota"); return { url: "https://img/ok.png", provider: "nvidia" }; },
    });
    const out = await runCreatorPipeline("10 second reel about bees", d);
    const routes = out.report.scenes.map((s) => s.visual);
    expect(routes).toEqual(["card", "image:nvidia", "card"]);
    expect(calls.render.scenes[0].imageUrl).toBe("data:image/png;base64,card-0");
    expect(out.report.scenes[0].fallbacks).toEqual(["video: No video route worked", "image: image quota"]);
  });

  it("keeps going with a template script and captions-only when AI and voice are down", async () => {
    const { deps: d, calls } = deps({
      writeScript: async () => { throw new Error("no AI account"); },
      synthesizeVoice: async () => { throw new Error("voice engine offline"); },
    });
    const out = await runCreatorPipeline("20 sec reel about rain", d);
    expect(out.report.script).toMatch(/^template/);
    expect(out.report.voice).toBe("none — captions only");
    expect(calls.render.scenes.every((s) => !s.audio && s.caption)).toBe(true);
  });

  it("stops between scenes when cancelled and never reaches the render", async () => {
    const controller = new AbortController();
    let visuals = 0;
    const { deps: d, calls } = deps({
      generateVideo: async () => { visuals += 1; if (visuals === 2) controller.abort(); return { videoUri: "v", route: "gemini" }; },
    });
    await expect(runCreatorPipeline("30 second reel", d, () => {}, { signal: controller.signal })).rejects.toMatchObject({ cancelled: true });
    expect(visuals).toBe(2);
    expect(calls.render).toBeNull();
  });

  it("reports a render failure with the plan so the UI can explain it", async () => {
    const { deps: d } = deps({ render: async () => ({ success: false, error: "ffmpeg not found" }) });
    await expect(runCreatorPipeline("30 second reel", d)).rejects.toMatchObject({
      message: "Render failed: ffmpeg not found",
      report: expect.objectContaining({ render: "failed: ffmpeg not found" }),
    });
  });
});
