/** Any object with a Hono-style `request` method, such as the app from `createApp()`. */
interface RequestableApp {
  request(path: string, init?: RequestInit): Response | Promise<Response>;
}

/** Send a request with a JSON body and the JSON content type. */
export function jsonRequest(
  app: RequestableApp,
  method: string,
  path: string,
  body: unknown,
) {
  return app.request(path, {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** Send a POST request with no body and no content type. */
export function postEmpty(app: RequestableApp, path: string) {
  return app.request(path, { method: "POST" });
}
