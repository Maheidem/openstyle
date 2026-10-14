import "../globals.css";
import "../fonts.css";

import { ErrorBoundary } from "@renderer/components/error-boundary";
import { initI18n } from "@renderer/i18n";
import { initApiBase } from "@renderer/lib/api";
import {
  installGlobalErrorHandlers,
  reportError,
} from "@renderer/lib/report-error";
import AppPage from "@renderer/pages/app";
import { ThemeProvider } from "next-themes";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

initApiBase();
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
          <AppPage />
        </ThemeProvider>
      </ErrorBoundary>
    </StrictMode>,
  );
}

// Same as the dashboard: load the active language before the first paint. If
// loading fails the pill still mounts (labels fall back to English keys).
void initI18n()
  .catch((err) => {
    reportError(err, { scope: "initI18n" });
  })
  .finally(mount);
