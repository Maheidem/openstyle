import type { ElectronApplication, Page } from "@playwright/test";

/** Env vars the main process reads as the file picker result when
 * OPENSTYLE_E2E is set. */
type PickerEnv =
  | "OPENSTYLE_E2E_IMPORT_FILE"
  | "OPENSTYLE_E2E_MEETING_IMPORT_FILE";

/** Counters the main process keeps on globalThis.__openstyleE2E. */
type E2eCounterName =
  | "importCalls"
  | "importNotifications"
  | "meetingImportCalls";

/** Reads one counter from the main process. Returns 0 if it is not set yet. */
export async function e2eCounter(
  app: ElectronApplication,
  name: E2eCounterName,
): Promise<number> {
  return app.evaluate((_electron, counter) => {
    const g = globalThis as {
      __openstyleE2E?: Partial<Record<string, number>>;
    };
    return g.__openstyleE2E?.[counter] ?? 0;
  }, name);
}

/** Sets the picker env var to `path`, runs `fn`, then always deletes the
 * variable. A failed assertion in `fn` does not leave the variable set. */
export async function withPickerFile<T>(
  app: ElectronApplication,
  env: PickerEnv,
  path: string,
  fn: () => Promise<T>,
): Promise<T> {
  await app.evaluate(
    (_electron, seam) => {
      process.env[seam.env] = seam.path;
    },
    { env, path },
  );
  try {
    return await fn();
  } finally {
    await app.evaluate((_electron, name) => {
      delete process.env[name];
    }, env);
  }
}

/** Drops a small synthetic file on the element with `testId`. The file has
 * the text "hi". */
export async function dropFile(
  page: Page,
  testId: string,
  fileName: string,
  mimeType: string,
): Promise<void> {
  await page.evaluate(
    ({ id, name, type }) => {
      const dropzone = document.querySelector(
        `[data-testid="${id}"]`,
      ) as HTMLElement;
      const file = new File(["hi"], name, { type });
      const dataTransfer = new DataTransfer();
      dataTransfer.items.add(file);
      const dropEvent = new DragEvent("drop", {
        bubbles: true,
        cancelable: true,
        dataTransfer,
      });
      dropzone.dispatchEvent(dropEvent);
    },
    { id: testId, name: fileName, type: mimeType },
  );
}
