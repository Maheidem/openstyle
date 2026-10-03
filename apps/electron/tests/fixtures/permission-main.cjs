const { appendFileSync } = require("node:fs");
const electron = require("electron");

const eventsPath = process.env.OPENSTYLE_E2E_PERMISSION_EVENTS;

function record(event) {
  if (!eventsPath) return;
  appendFileSync(eventsPath, `${JSON.stringify(event)}\n`);
}

Object.defineProperty(
  electron.systemPreferences,
  "isTrustedAccessibilityClient",
  {
    configurable: true,
    value: (prompt) => {
      record({ type: "accessibility-check", prompt });
      return process.env.OPENSTYLE_E2E_ACCESSIBILITY === "granted";
    },
  },
);

Object.defineProperty(electron.systemPreferences, "getMediaAccessStatus", {
  configurable: true,
  value: (mediaType) => {
    record({ type: "media-check", mediaType });
    return process.env.OPENSTYLE_E2E_MICROPHONE ?? "granted";
  },
});

Object.defineProperty(electron.dialog, "showMessageBox", {
  configurable: true,
  value: async (options) => {
    record({ type: "dialog", options });
    return {
      response: Number(process.env.OPENSTYLE_E2E_DIALOG_RESPONSE ?? 1),
      checkboxChecked: false,
    };
  },
});

Object.defineProperty(electron.shell, "openExternal", {
  configurable: true,
  value: async (url) => {
    record({ type: "open-external", url });
  },
});

electron.ipcMain.on("e2e:mic-requested", () => {
  record({ type: "mic-requested" });
});

const originalFetch = global.fetch;
global.fetch = async (input, init) => {
  const url =
    typeof input === "string"
      ? input
      : input instanceof URL
        ? input.toString()
        : input.url;
  if (
    process.env.OPENSTYLE_E2E_ONBOARDING_COMPLETE === "false" &&
    url.endsWith("/api/models/configured")
  ) {
    return new Response("[]", {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }
  return originalFetch(input, init);
};

require("../../out/main/index.js");
