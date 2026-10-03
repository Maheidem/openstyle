/** Any object with a Hono-style `request` method, such as the app from `createApp()`. */
interface RequestableApp {
  request(path: string, init?: RequestInit): Response | Promise<Response>;
}

/** Send a request with a JSON body and the JSON content type. */
export async function jsonRequest(
  app: RequestableApp,
  method: string,
  path: string,
  body: unknown,
): Promise<Response> {
  return app.request(path, {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** Send a POST request with no body and no content type. */
export async function postEmpty(
  app: RequestableApp,
  path: string,
): Promise<Response> {
  return app.request(path, { method: "POST" });
}
