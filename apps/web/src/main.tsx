import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";

import { App } from "./App.js";
import { ErrorBoundary } from "./components/ErrorBoundary.js";
import "./styles.css";
import "./reference-shell.css";

const shellKey = "rai.shell";
const params = new URLSearchParams(window.location.search);
if (params.get("raiShell") === "ios") {
  sessionStorage.setItem(shellKey, "ios");
}
if (sessionStorage.getItem(shellKey) === "ios") {
  document.documentElement.dataset.shell = "ios";
}

const root = document.getElementById("root");
if (!root) throw new Error("Missing application root");

createRoot(root).render(
  <StrictMode>
    <BrowserRouter>
      <ErrorBoundary>
        <App />
      </ErrorBoundary>
    </BrowserRouter>
  </StrictMode>
);
