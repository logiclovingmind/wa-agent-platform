import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import ErrorBoundary from "./ErrorBoundary";
import "./index.css";

// The per-pane boundaries inside App cover the screens. This one is the backstop for
// the shell itself — the nav, the sign-in form and the MFA challenge sit above them.
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ErrorBoundary label="The dashboard">
      <App />
    </ErrorBoundary>
  </StrictMode>,
);

// After paint, and never in dev: `pnpm dev:dashboard` serves unhashed modules, and a
// worker holding onto them is a morning spent debugging a stale file.
if (import.meta.env.PROD && "serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    void navigator.serviceWorker.register("/sw.js");
  });
}
