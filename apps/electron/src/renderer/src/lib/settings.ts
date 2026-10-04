import { getClient } from "./api";

/**
 * One settings PUT, resolved to a boolean (never rejected).
 * `true` means the server took the value. A refused or failed write logs a
 * warning and gives `false`. Callers that do not care can ignore the result.
 * `PUT /api/settings/:key` is the ONLY write surface used here: the DELETE
 * route drops the whole key.
 */
export async function putSetting(key: string, value: string): Promise<boolean> {
  try {
    const res = await getClient().api.settings[":key"].$put({
      param: { key },
      json: { value },
    });
    if (!res.ok) {
      console.warn(`Failed to save setting "${key}": HTTP ${res.status}`);
      return false;
    }
    return true;
  } catch (err) {
    console.warn(`Failed to save setting "${key}":`, err);
    return false;
  }
}
