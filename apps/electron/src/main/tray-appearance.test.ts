import { describe, expect, it } from "vitest";
import { trayAppearance } from "./tray-appearance";

describe("trayAppearance", () => {
  it("uses the red icon, not a template image, while a meeting records", () => {
    expect(trayAppearance(true)).toEqual({
      icon: "recording",
      template: false,
      tooltip: "Openstyle — recording meeting",
    });
  });

  it("uses the normal template icon at other times", () => {
    expect(trayAppearance(false)).toEqual({
      icon: "default",
      template: true,
      tooltip: "Openstyle",
    });
  });
});
