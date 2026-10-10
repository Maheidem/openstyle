// Custom "app" protocol. It serves the built renderer files.
// index.ts registers the scheme as privileged at module load.
// Call this after app.setName, inside whenReady.

import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { net, protocol } from "electron";

export function registerAppProtocol(): void {
  protocol.handle("app", (request) => {
    const url = new URL(request.url);
    let filePath = join(
      __dirname,
      "../renderer",
      decodeURIComponent(url.pathname),
    );

    // If the path has no file extension, serve the dashboard SPA fallback.
    // pill.html is loaded directly by its full path and doesn't need a fallback.
    if (!filePath.match(/\.\w+$/)) {
      filePath = join(__dirname, "../renderer/index.html");
    }

    return net.fetch(pathToFileURL(filePath).toString());
  });
}
