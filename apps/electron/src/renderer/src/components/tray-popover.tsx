import "../globals.css";
import "../fonts.css";

import { ErrorBoundary } from "@renderer/components/error-boundary";
import { initI18n } from "@renderer/i18n";
import { initApiBase } from "@renderer/lib/api";
import { createQueryClient } from "@renderer/lib/query";
import {
  installGlobalErrorHandlers,
  reportError,
} from "@renderer/lib/report-error";
import TrayPopoverPage from "@renderer/pages/tray-popover";
import { QueryClientProvider } from "@tanstack/react-query";
import { ThemeProvider } from "next-themes";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

// The entry of the tray popover window (main/windows/tray-popover-window.ts).
// It has the shell of the pill, plus a query client for the model names of
// the history chip (useModelNames). It has no router.
const queryClient = createQueryClient();
installGlobalErrorHandlers();

function mount(): void {
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <ErrorBoundary fallback={null}>
        <ThemeProvider
          attribute="class"
          defaultTheme="system"
          enableSystem
          disableTransitionOnChange
        >
          <QueryClientProvider client={queryClient}>
            <TrayPopoverPage />
          </QueryClientProvider>
        </ThemeProvider>
      </ErrorBoundary>
    </StrictMode>,
  );
}

// Load the active language before the first paint, as the pill does. Resolve
// the server base first too: a query before it goes to the default port.
void Promise.all([
  initI18n().catch((err) => {
    reportError(err, { scope: "initI18n" });
  }),
  initApiBase().catch((err) => {
    reportError(err, { scope: "initApiBase" });
  }),
]).finally(mount);
