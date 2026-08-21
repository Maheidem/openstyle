import type { Plugin } from "@openstyle/sdk";

/**
 * A starter Openstyle plugin with a UI page.
 *
 * The factory function is called once at load time. Hooks run many times across
 * the dictation pipeline. Use `setup` to capture context (logger, settings,
 * storage) in a closure.
 *
 * See the SDK README for the full hook reference:
 * https://github.com/Maheidem/openstyle/tree/main/packages/sdk#readme
 */
export default function myPlugin(): Plugin {
  return {
    name: "openstyle-plugin-starter",

    setup({ logger, mode }) {
      logger.info(`plugin ready on ${mode}`);
    },

    /**
     * Runs on the final text after cleanup (or raw transcript if cleanup is
     * off). This is the most common hook — use it to rewrite, filter, or
     * transform dictated text.
     */
    afterCleanup(_input, output) {
      // Example: trim trailing whitespace from every dictation.
      output.text = output.text.trimEnd();
    },
  };
}
