// Node module hook for lab/live-arm.mts. Like ../../ts-register.mjs (a failing
// relative `*.js` import is retried as `*.ts`), and it also runs TypeScript
// that Node type stripping refuses, for example the parameter properties in
// apps/server/src/lib/mlx-asr/hf-http.ts (Node 26 has no transform flag, so
// the hook compiles the file with the TypeScript package of the repo).

import { createRequire, registerHooks } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
const ts = createRequire(join(repoRoot, "apps", "server", "package.json"))("typescript");

registerHooks({
  resolve(specifier, context, next) {
    try {
      return next(specifier, context);
    } catch (err) {
      if (
        specifier.endsWith(".js") &&
        (specifier.startsWith("./") || specifier.startsWith("../"))
      ) {
        return next(`${specifier.slice(0, -3)}.ts`, context);
      }
      throw err;
    }
  },
  load(url, context, next) {
    if (!url.endsWith(".ts") || url.includes("/node_modules/"))
      return next(url, context);
    const loaded = next(url, { ...context, format: "module" });
    const source = loaded.source?.toString();
    if (source === undefined) return loaded;
    return {
      format: "module",
      shortCircuit: true,
      source: ts.transpileModule(source, {
        fileName: fileURLToPath(url),
        compilerOptions: {
          module: ts.ModuleKind.ESNext,
          target: ts.ScriptTarget.ES2023,
          sourceMap: false,
          inlineSourceMap: true,
        },
      }).outputText,
    };
  },
});
