// Usage: node catalog-size.mjs <hf-repo-id> [<hf-repo-id> ...]
// Prints the sizeBytes value for a catalog entry and the license data of the repo.
// sizeBytes = sum of the repo files that match MLX_LLM_ALLOW_PATTERNS (read from constants.ts).
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const constants = readFileSync(
  join(here, "../../../../apps/server/src/lib/mlx-llm/constants.ts"),
  "utf8",
);
const block = constants.match(/MLX_LLM_ALLOW_PATTERNS[^=]*=\s*\[([\s\S]*?)\]/);
if (!block) throw new Error("MLX_LLM_ALLOW_PATTERNS not found in constants.ts");
const patterns = [...block[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
const regexes = patterns.map(
  (p) =>
    new RegExp(
      `^${p.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".")}$`,
    ),
);

async function getJson(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
  return res.json();
}

for (const repo of process.argv.slice(2)) {
  const info = await getJson(`https://huggingface.co/api/models/${repo}`);
  const tree = await getJson(
    `https://huggingface.co/api/models/${repo}/tree/main?recursive=true`,
  );
  const files = tree.filter(
    (e) => e.type === "file" && regexes.some((r) => r.test(e.path)),
  );
  const sizeBytes = files.reduce((sum, f) => sum + (f.size ?? 0), 0);
  const card = info.cardData ?? {};
  console.log(
    JSON.stringify(
      {
        repo,
        sizeBytes,
        sizeBytesUnderscored: String(sizeBytes).replace(/\B(?=(\d{3})+$)/g, "_"),
        filesMatched: files.length,
        filesInRepo: tree.filter((e) => e.type === "file").length,
        license: card.license ?? null,
        licenseName: card.license_name ?? null,
        licenseLink: card.license_link ?? null,
        baseModel: card.base_model ?? null,
        libraryName: info.library_name ?? card.library_name ?? null,
        gated: info.gated ?? false,
        modelType: info.config?.model_type ?? null,
        sha: info.sha,
      },
      null,
      2,
    ),
  );
}
