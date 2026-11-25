import { describe, expect, it } from "vitest";
import { choosePlacement } from "../src/core/placement.js";

describe("floating button placement", () => {
  const viewport = { width: 800, height: 600 };
  const size = { width: 100, height: 36 };
  it("prefers center right, away from the composer", () => {
    expect(choosePlacement(viewport, size, [
      { left: 500, right: 800, top: 500, bottom: 600 }
    ])).toEqual({ top: 282, right: 16 });
  });
  it("moves when a native control occupies the preferred spot", () => {
    expect(choosePlacement(viewport, size, [
      { left: 680, right: 800, top: 280, bottom: 318 }
    ])).toEqual({ top: 226, right: 16 });
  });
  it("hides rather than obstructing a crowded gutter", () => {
    expect(choosePlacement(viewport, size, [
      { left: 680, right: 800, top: 0, bottom: 600 }
    ])).toBeNull();
  });
  it("hides if the viewport cannot fit the button", () => {
    expect(choosePlacement({ width: 100, height: 600 }, size, [])).toBeNull();
  });
});
