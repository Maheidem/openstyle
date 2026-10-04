import { afterEach, describe, expect, it, vi } from "vitest";
import { validateApiKey } from "../src/lib/validate-key.js";

const INVALID = "Invalid API key. Please check and try again.";

function mockFetch(status: number) {
  const fn = vi.fn(async () => new Response(null, { status }));
  vi.stubGlobal("fetch", fn);
  return fn;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

// provider, a key that passes the format pre-check, label, status rules
const CASES: [string, string, string, Record<number, string>][] = [
  [
    "openai",
    "sk-test",
    "OpenAI",
    {
      401: INVALID,
      403: "API key lacks permission. Check your OpenAI project settings.",
    },
  ],
  ["groq", "gsk_test", "Groq", { 401: INVALID }],
  ["deepgram", "k", "Deepgram", { 401: INVALID }],
  ["elevenlabs", "k", "ElevenLabs", { 401: INVALID }],
  [
    "anthropic",
    "k",
    "Anthropic",
    { 401: INVALID, 403: "API key lacks permission." },
  ],
  ["google", "k", "Google", { 400: INVALID, 403: INVALID }],
  ["mistral", "k", "Mistral", { 401: INVALID }],
  ["openrouter", "sk-or-test", "OpenRouter", { 401: INVALID }],
  ["vercel", "k", "Vercel", { 401: INVALID, 403: INVALID }],
];

describe("validateApiKey status rules", () => {
  for (const [provider, key, label, rejected] of CASES) {
    describe(provider, () => {
      it("accepts a 200 response", async () => {
        mockFetch(200);
        expect(await validateApiKey(provider, key)).toEqual({ valid: true });
      });

      for (const [status, error] of Object.entries(rejected)) {
        it(`maps HTTP ${status} to its message`, async () => {
          mockFetch(Number(status));
          expect(await validateApiKey(provider, key)).toEqual({
            valid: false,
            error,
          });
        });
      }

      it("gives a generic message for HTTP 500", async () => {
        mockFetch(500);
        expect(await validateApiKey(provider, key)).toEqual({
          valid: false,
          error: `${label} returned HTTP 500.`,
        });
      });
    });
  }
});

describe("validateApiKey request shape", () => {
  it("sends the key in the provider header", async () => {
    const fn = mockFetch(200);
    await validateApiKey("deepgram", "abc");
    expect(fn.mock.calls[0]).toMatchObject([
      "https://api.deepgram.com/v1/projects",
      { headers: { Authorization: "Token abc" } },
    ]);
  });

  it("sends the key in the Google URL and no headers", async () => {
    const fn = mockFetch(200);
    await validateApiKey("google", "a b");
    const [url, init] = fn.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain("key=a%20b");
    expect(init.headers).toBeUndefined();
  });
});

describe("validateApiKey other paths", () => {
  it("rejects a bad key format without a request", async () => {
    const fn = mockFetch(200);
    const res = await validateApiKey("openai", "bad");
    expect(res.valid).toBe(false);
    expect(fn).not.toHaveBeenCalled();
  });

  it("accepts an unknown provider without a request", async () => {
    const fn = mockFetch(500);
    expect(await validateApiKey("other", "k")).toEqual({ valid: true });
    expect(fn).not.toHaveBeenCalled();
  });

  it("reports a network failure", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("down");
      }),
    );
    expect(await validateApiKey("groq", "gsk_x")).toEqual({
      valid: false,
      error: "Could not reach groq API. Check your network and try again.",
    });
  });
});
