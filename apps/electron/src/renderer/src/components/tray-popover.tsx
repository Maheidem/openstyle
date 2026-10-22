import "../globals.css";
import "../fonts.css";

import { ErrorBoundary } from "@renderer/components/error-boundary";
import { initI18n } from "@renderer/i18n";
import { initApiBase } from "@renderer/lib/api";
import {
  installGlobalErrorHandlers,
  reportError,
} from "@renderer/lib/report-error";
import TrayPopoverPage from "@renderer/pages/tray-popover";
import { ThemeProvider } from "next-themes";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

// The entry of the tray popover window (main/windows/tray-popover-window.ts).
// It has the same shell as the pill: no router and no query client.
void initApiBase();
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
          <TrayPopoverPage />
        </ThemeProvider>
      </ErrorBoundary>
    </StrictMode>,
  );
}

// Load the active language before the first paint, as the pill does.
void initI18n()
  .catch((err) => {
    reportError(err, { scope: "initI18n" });
  })
  .finally(mount);
