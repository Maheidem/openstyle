import { readFileSync } from "node:fs";
// The context terms of a meeting context text (stdin), with the app function.
import { extractContextTerms } from "../../../../../apps/server/src/lib/meetings/context-terms.ts";

const input = readFileSync(0, "utf8");
process.stdout.write(JSON.stringify(extractContextTerms(input)));
