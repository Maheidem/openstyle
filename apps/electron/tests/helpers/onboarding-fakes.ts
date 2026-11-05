import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { ElectronApplication, Page, Route } from "@playwright/test";
import { embeddedServerUrl } from "./e2e-app";

// ---------------------------------------------------------------------------
// Fakes for the onboarding E2E specs. The app and its embedded server run for
// real. The fakes sit on the HTTP calls of the renderer to the server for
// everything that would download a model, start a worker or call a provider:
//   - the status of the voice and text models, and the download calls,
//   - the profile of the Mac,
//   - the list of cloud models, and the test of an API key.
// The saves of the user choices (default models, API keys, settings) go to the
// real server. So a spec can read them back from the real database.
// ---------------------------------------------------------------------------

const GIB = 1024 ** 3;
const QWEN_LANGUAGES = [
  "ar",
  "cs",
  "da",
  "de",
  "el",
  "en",
  "es",
  "fa",
  "fi",
  "fr",
  "hi",
  "hu",
  "id",
  "it",
  "ja",
  "ko",
  "mk",
  "ms",
  "nl",
  "pl",
  "pt",
  "ro",
  "ru",
  "sv",
  "th",
  "tr",
  "vi",
  "zh",
];

type Phase = "idle" | "running" | "ready";
interface Item {
  phase: Phase;
  ticks: number;
}

export interface OnboardingFakes {
  /** The download calls that the renderer made, such as "mlx-asr:qwen3-0.6b-8bit". */
  downloads: string[];
  /** The keys that the test of a key got, as "provider:key". */
  keyTests: string[];
  /** Mark every running download as done. */
  finish: () => void;
  /** The next key test answers "not valid". */
  rejectNextKey: () => void;
  /** Free disk space of the fake Mac, in bytes. */
  setFreeDisk: (bytes: number) => void;
}

function cors(route: Route, json: unknown, status = 200): Promise<void> {
  return route.fulfill({
    status,
    json,
    headers: { "access-control-allow-origin": "*" },
  });
}

/**
 * Install the fakes on the dashboard window and reload it. Call it right after
 * the launch, before the first step.
 */
export async function installOnboardingFakes(
  page: Page,
  options: { cloud?: boolean } = {},
): Promise<OnboardingFakes> {
  const items: Record<string, Item> = {
    "mlx-asr:qwen3-0.6b-8bit": { phase: "idle", ticks: 0 },
    "mlx-asr:qwen3-1.7b-8bit": { phase: "idle", ticks: 0 },
    "whisper:small-q5_1": { phase: "idle", ticks: 0 },
    "whisper:large": { phase: "idle", ticks: 0 },
    "mlx-llm:gemma-4-e2b-qat-4bit": { phase: "idle", ticks: 0 },
    "mlx-llm:gemma-4-e4b-qat-4bit": { phase: "idle", ticks: 0 },
  };
  let rejectKey = false;
  let freeDisk = 200 * GIB;
  const fakes: OnboardingFakes = {
    downloads: [],
    keyTests: [],
    finish: () => {
      for (const item of Object.values(items)) {
        if (item.phase === "running") item.phase = "ready";
      }
    },
    rejectNextKey: () => {
      rejectKey = true;
    },
    setFreeDisk: (bytes) => {
      freeDisk = bytes;
    },
  };

  const state = (key: string, size: number) => {
    const item = items[key];
    if (item.phase === "running") item.ticks += 1;
    const status =
      item.phase === "idle"
        ? "not_downloaded"
        : item.phase === "ready"
          ? "ready"
          : "downloading";
    const weights = Math.min(60, item.ticks * 10);
    return {
      status,
      // The first two polls show the MLX worker, then the weights.
      phase:
        status === "downloading"
          ? key.startsWith("whisper") || item.ticks > 2
            ? "downloading_model"
            : "building_binary"
          : undefined,
      downloadProgress:
        status === "downloading"
          ? {
              bytesDownloaded: Math.round((size * weights) / 100),
              bytesTotal: size,
              percent: weights,
              speedBps: 5_000_000,
            }
          : undefined,
    };
  };

  const mlxDef = (
    id: string,
    name: string,
    size: number,
    ram: string,
    speed: string,
    quality: string,
  ) => ({
    id,
    hfId: `fake/${id}`,
    family: "qwen3-asr",
    displayName: name,
    sizeBytes: size,
    ramRequired: ram,
    speed,
    quality,
    quantized: true,
    languages: QWEN_LANGUAGES,
  });

  await page.route(/\/api\/system\/profile/, (route) =>
    cors(route, {
      appleSilicon: true,
      chip: "Apple M3 Pro",
      ramBytes: 16 * GIB,
      freeDiskBytes: freeDisk,
      mlxWorkerBytes: 174_000_000,
      voiceFit: {
        "local-mlx/qwen3-0.6b-8bit": "runs_well",
        "local-mlx/qwen3-1.7b-8bit": "runs_well",
        "local-whisper/small-q5_1": "runs_well",
        "local-whisper/large": "tight",
      },
    }),
  );

  await page.route(/\/api\/mlx-asr\/status/, (route) => {
    const models = [
      ["qwen3-0.6b-8bit", 1_010_773_761],
      ["qwen3-1.7b-8bit", 2_467_859_030],
    ] as const;
    return cors(route, {
      platformSupported: true,
      canRun: false,
      blockedReason: "The MLX worker is not installed.",
      keepAliveMinutes: 5,
      runtime: {
        available: false,
        downloading: false,
        url: "https://example.invalid/mlx_asr_worker.tar.gz",
        updatePending: false,
      },
      models: models.map(([id, size]) => ({
        model: id,
        sizeBytes: size,
        displayName: id,
        ...state(`mlx-asr:${id}`, size),
      })),
      modelDefinitions: [
        mlxDef(
          "qwen3-0.6b-8bit",
          "Qwen3 Fast",
          1_010_773_761,
          "~1.5 GB",
          "Fast",
          "Better",
        ),
        mlxDef(
          "qwen3-1.7b-8bit",
          "Qwen3 Pro",
          2_467_859_030,
          "~3 GB",
          "Medium",
          "High",
        ),
      ],
      setupHint: null,
      aligner: null,
    });
  });

  await page.route(/\/api\/whisper\/status/, (route) => {
    const defs = [
      [
        "small-q5_1",
        "Whisper Balanced",
        181_000_000,
        "~2 GB",
        "Fast",
        "Better",
      ],
      ["large", "Whisper Pro", 1_600_000_000, "~6 GB", "Medium", "Best"],
    ] as const;
    return cors(route, {
      binaryDownloading: false,
      models: defs.map(([id, , size]) => ({
        model: id,
        sizeBytes: size,
        ...state(`whisper:${id}`, size),
      })),
      modelDefinitions: defs.map(([id, name, size, ram, speed, quality]) => ({
        id,
        displayName: name,
        sizeBytes: size,
        ramRequired: ram,
        speed,
        quality,
        quantized: true,
      })),
    });
  });

  await page.route(/\/api\/mlx-llm\/status/, (route) => {
    const defs = [
      ["gemma-4-e2b-qat-4bit", "Gemma 4 E2B", 4_361_680_121, true],
      ["gemma-4-e4b-qat-4bit", "Gemma 4 E4B", 6_830_817_013, false],
    ] as const;
    return cors(route, {
      platformSupported: true,
      blockedReason: null,
      runtime: {
        available: false,
        downloading: false,
        url: "https://example.invalid/w",
        updatePending: false,
      },
      keepAliveMinutes: 5,
      keepReady: {},
      models: defs.map(([id, name, size, recommended]) => ({
        model: id,
        hfId: `fake/${id}`,
        displayName: name,
        family: "gemma4",
        sizeBytes: size,
        contextTokens: 32768,
        maxOutputTokens: 8192,
        recommended,
        fit: { label: recommended ? "runs_well" : "tight" },
        ...state(`mlx-llm:${id}`, size),
      })),
      worker: null,
      workers: [],
      memory: null,
    });
  });

  const downloadRoute =
    (engine: string) =>
    (route: Route): Promise<void> => {
      const match = /\/models\/([^/]+)\/download/.exec(route.request().url());
      const key = `${engine}:${match?.[1]}`;
      if (items[key] && route.request().method() === "POST") {
        fakes.downloads.push(key);
        if (items[key].phase !== "ready") {
          items[key] = { phase: "running", ticks: 0 };
        }
      }
      return cors(route, { ok: true, message: "Download started" });
    };
  await page.route(
    /\/api\/mlx-asr\/models\/[^/]+\/download/,
    downloadRoute("mlx-asr"),
  );
  await page.route(
    /\/api\/whisper\/models\/[^/]+\/download/,
    downloadRoute("whisper"),
  );
  await page.route(
    /\/api\/mlx-llm\/models\/[^/]+\/download/,
    downloadRoute("mlx-llm"),
  );
  // No worker starts in a spec.
  await page.route(/\/api\/(mlx-asr|whisper|mlx-llm)\/server\/start/, (route) =>
    cors(route, { ok: true }),
  );

  if (options.cloud !== false) {
    await page.route(/\/api\/models\/available/, (route) =>
      cors(route, [
        {
          provider_id: "groq",
          provider_name: "Groq",
          model_id: "groq/whisper-large-v3-turbo",
          model_name: "Whisper Large v3 Turbo",
          family: "whisper",
          type: "voice",
        },
        {
          provider_id: "openai",
          provider_name: "OpenAI",
          model_id: "openai/gpt-transcribe",
          model_name: "GPT Transcribe",
          family: "gpt",
          type: "voice",
        },
        {
          provider_id: "anthropic",
          provider_name: "Anthropic",
          model_id: "claude-haiku-4-5",
          model_name: "Claude Haiku 4.5",
          family: "claude",
          type: "llm",
        },
        {
          provider_id: "openai",
          provider_name: "OpenAI",
          model_id: "gpt-5-mini",
          model_name: "GPT-5 mini",
          family: "gpt",
          type: "llm",
        },
      ]),
    );
  }
  await page.route(/\/api\/keys\/validate/, async (route) => {
    const body = route.request().postDataJSON() as {
      provider: string;
      key: string;
    };
    fakes.keyTests.push(`${body.provider}:${body.key}`);
    if (rejectKey) {
      rejectKey = false;
      return cors(route, {
        valid: false,
        error: "Invalid API key. Please check and try again.",
      });
    }
    return cors(route, { valid: true });
  });

  await page.reload();
  return fakes;
}

/** A JSON GET against the real embedded server of the app. */
export async function serverGet<T>(
  app: ElectronApplication,
  path: string,
): Promise<{ status: number; body: T }> {
  return app.evaluate(
    async (_electron, url) => {
      const res = await fetch(url);
      const text = await res.text();
      return { status: res.status, body: text ? JSON.parse(text) : null };
    },
    `${embeddedServerUrl(app)}${path}`,
  ) as Promise<{ status: number; body: T }>;
}

/**
 * Take one screenshot in the light and in the dark scheme. The files go to
 * `OPENSTYLE_EVIDENCE_DIR`. Without it, nothing is written.
 */
export async function shoot(page: Page, name: string): Promise<void> {
  const dir = process.env.OPENSTYLE_EVIDENCE_DIR;
  if (!dir) return;
  mkdirSync(dir, { recursive: true });
  for (const scheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    // The theme class changes in the next frame.
    await page.waitForTimeout(250);
    await page.screenshot({ path: join(dir, `${name}-${scheme}.png`) });
  }
  await page.emulateMedia({ colorScheme: "light" });
}
