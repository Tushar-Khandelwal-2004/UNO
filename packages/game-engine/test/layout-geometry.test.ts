import { describe, expect, it } from "vitest";
import { checkLayout } from "../src/layoutGeometry.js";

describe("UNO layout geometry checker", () => {
  it("reports a clean non-overlapping viewport", () => {
    const report = checkLayout([
      { name: "top-bar", left: 0, top: 0, right: 1280, bottom: 60 },
      { name: "draw-pile", left: 480, top: 300, right: 576, bottom: 441 },
      { name: "discard-pile", left: 720, top: 300, right: 816, bottom: 441 },
      { name: "hand-zone", left: 16, top: 650, right: 1264, bottom: 780 },
      { name: "action-bar", left: 450, top: 790, right: 830, bottom: 834 },
    ], 1280, 900, 900);
    expect(report).toEqual({ overlaps: [], outside: [], scroll: false });
  });

  it("reports overlap, viewport overflow, and scroll", () => {
    const report = checkLayout([
      { name: "draw-pile", left: 10, top: 10, right: 100, bottom: 150 },
      { name: "discard-pile", left: 80, top: 100, right: 170, bottom: 240 },
    ], 160, 200, 240);
    expect(report.overlaps).toEqual(["draw-pile:discard-pile"]);
    expect(report.outside).toEqual(["discard-pile"]);
    expect(report.scroll).toBe(true);
  });
});
