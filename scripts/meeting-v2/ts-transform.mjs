// Node module hook for the .mts tools that import server source with
// parameter properties (`constructor(readonly x: T)`), which Node's
// type stripping does not support. It transpiles the .ts files of
// apps/server/src with the TypeScript compiler of the server package.
// Use it after ts-register.mjs:
//
//   node --import ./scripts/meeting-v2/ts-register.mjs \
//        --import ./scripts/meeting-v2/ts-transform.mjs scripts/meeting-v2/eval/memory-recall.mts

import { readFileSync } from "node:fs";
import { createRequire, registerHooks } from "node:module";
import { fileURLToPath } from "node:url";

const ts = createRequire(
  new URL("../../apps/server/package.json", import.meta.url),
)("typescript");

registerHooks({
  load(url, context, next) {
    if (!url.startsWith("file:") || !url.endsWith(".ts")) {
      return next(url, context);
    }
    const file = fileURLToPath(url);
    if (!file.includes("/apps/server/src/")) return next(url, context);
    const out = ts.transpileModule(readFileSync(file, "utf8"), {
      fileName: file,
      compilerOptions: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.ESNext,
      },
    });
    return { format: "module", source: out.outputText, shortCircuit: true };
  },
});
