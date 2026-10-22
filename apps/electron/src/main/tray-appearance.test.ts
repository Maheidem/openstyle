import { describe, expect, it } from "vitest";
import { trayAppearance } from "./tray-appearance";

const idle = { recording: false, job: false, updateReady: false };

describe("trayAppearance", () => {
  it("uses the red icon, not a template image, while a meeting records", () => {
    expect(trayAppearance({ ...idle, recording: true })).toEqual({
      icon: "recording",
      template: false,
      tooltip: "Openstyle — recording meeting",
    });
  });

  it("uses the normal template icon at other times", () => {
    expect(trayAppearance(idle)).toEqual({
      icon: "default",
      template: true,
      tooltip: "Openstyle",
    });
  });

  it("uses the template ring while a job runs", () => {
    expect(trayAppearance({ ...idle, job: true })).toEqual({
      icon: "job",
      template: true,
      tooltip: "Openstyle — working",
    });
  });

  it("uses the template badge dot when an update is ready", () => {
    expect(trayAppearance({ ...idle, updateReady: true })).toEqual({
      icon: "update",
      template: true,
      tooltip: "Openstyle — update ready",
    });
  });

  it("lets recording win over a job, and a job win over an update", () => {
    const all = { recording: true, job: true, updateReady: true };
    expect(trayAppearance(all).icon).toBe("recording");
    expect(trayAppearance({ ...all, recording: false }).icon).toBe("job");
  });
});
