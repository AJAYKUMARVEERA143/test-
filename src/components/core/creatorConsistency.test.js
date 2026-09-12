import { describe, expect, it } from "vitest";
import { applyConsistency, assetsForScene, lockPhrase } from "./creatorConsistency.js";

const cast = [
  { name: "Ravi", assetType: "character", definition: { description: "38, thin moustache, blue checked shirt" } },
  { name: "Meena", assetType: "character", definition: JSON.stringify({ lockedLook: "grey saree, silver bangles" }) },
  { name: "Tea cup", assetType: "prop", definition: { description: "white cup, chipped handle, red rim" } },
  { name: "Nameless", assetType: "prop", definition: {} },
];

describe("consistency engine", () => {
  it("builds a locked phrase per asset kind and skips ones with no look", () => {
    expect(lockPhrase(cast[0])).toBe('Character "Ravi": 38, thin moustache, blue checked shirt');
    expect(lockPhrase(cast[2])).toBe('Prop "Tea cup": white cup, chipped handle, red rim');
    expect(lockPhrase(cast[3])).toBe("");
  });

  it("picks the assets a scene actually mentions", () => {
    const picked = assetsForScene("Ravi lifts the tea cup and smiles", cast).map((a) => a.name);
    expect(picked).toEqual(["Ravi", "Tea cup"]);
  });

  it("falls back to the cast when a scene names nobody", () => {
    expect(assetsForScene("Wide shot of the market at dawn", cast).map((a) => a.name)).toEqual(["Ravi", "Meena"]);
  });

  it("appends locks and style to the prompt", () => {
    const out = applyConsistency("Ravi pours tea", { sceneText: "Ravi pours tea", assets: cast, style: "inked comic" });
    expect(out).toContain("Ravi pours tea");
    expect(out).toContain('Character "Ravi": 38, thin moustache');
    expect(out).toContain("Style: inked comic. Same style in every scene.");
  });

  it("leaves the prompt alone when nothing is saved", () => {
    expect(applyConsistency("a city at dawn", { assets: [] })).toBe("a city at dawn");
  });
});
