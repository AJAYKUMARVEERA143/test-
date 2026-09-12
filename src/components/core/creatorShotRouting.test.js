import { describe, expect, it } from "vitest";
import { classifyShot, routeForShot, routeSummary } from "./creatorShotRouting.js";

describe("shot routing", () => {
  it("calls a spoken close-up a dialogue shot", () => {
    expect(classifyShot({ beat: "Hook", narration: "Nenu ee product gurinchi cheptanu", camera: "close-up on the seller" })).toBe("dialogue");
    expect(classifyShot({ beat: "Turn", narration: "He says the price is fair", camera: "medium" })).toBe("dialogue");
  });

  it("calls an establishing or product shot an action shot", () => {
    expect(classifyShot({ beat: "Proof", narration: "Morning market, baskets stacked high", camera: "wide drone" })).toBe("action");
    expect(classifyShot({ beat: "Hook", narration: "", camera: "close-up" })).toBe("action");
  });

  it("only promises lip-sync when a provider is connected", () => {
    const scene = { narration: "He explains the offer", camera: "close-up" };
    expect(routeForShot(scene, { hasLipSync: true })).toMatchObject({ engine: "lipsync" });
    const without = routeForShot(scene, { hasLipSync: false });
    expect(without.engine).toBe("motion");
    expect(without.note).toMatch(/lips are not synced/);
  });

  it("summarises a board", () => {
    const summary = routeSummary([
      { narration: "She says hello", camera: "close-up" },
      { narration: "Wide shot of the street", camera: "wide" },
    ]);
    expect(summary).toMatchObject({ dialogue: 1, action: 1, lipSynced: 0 });
  });
});
