// Node module hook for the meeting-v2 .mts tools (compare.mts, PR #34).
//
// The server source uses ESM `.js` specifiers that point at `.ts` files
// (NodeNext style). Under Node type stripping the specifier is not
// rewritten, so this hook retries a failing relative `*.js` import as
// `*.ts`. Run the tools from the repo root:
//
//   node --import ./scripts/meeting-v2/ts-register.mjs scripts/meeting-v2/compare.mts ...

import { registerHooks } from "node:module";

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
});
