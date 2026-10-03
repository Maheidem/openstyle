/**
 * Read the model ids from an OpenAI-compatible `/v1/models` endpoint.
 *
 * The caller passes the full models URL, so each caller keeps its own URL
 * normalizer. The Bearer header is set only when `apiKey` is set. A non-ok
 * reply throws `Server returned <status>: <statusText>`. A network error or
 * a timeout also throws. A reply with no `data` array gives an empty list.
 */
export async function fetchModelIds(
  modelsUrl: string,
  apiKey?: string,
  timeoutMs = 5000,
): Promise<string[]> {
  const res = await fetch(modelsUrl, {
    headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) {
    throw new Error(`Server returned ${res.status}: ${res.statusText}`);
  }
  const data = (await res.json()) as { data?: { id: string }[] };
  return Array.isArray(data.data) ? data.data.map((m) => m.id) : [];
}
