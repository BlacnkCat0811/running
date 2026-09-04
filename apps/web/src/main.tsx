import { StrictMode, type ComponentType } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";

import { ErrorBoundary } from "./components/ErrorBoundary.js";

const shellKey = "rai.shell";
const params = new URLSearchParams(window.location.search);
if (params.get("raiShell") === "ios") {
  sessionStorage.setItem(shellKey, "ios");
}
const isIosShell =
  params.get("raiShell") === "ios" ||
  sessionStorage.getItem(shellKey) === "ios" ||
  document.documentElement.dataset.shell === "ios";
if (isIosShell) {
  sessionStorage.setItem(shellKey, "ios");
  document.documentElement.dataset.shell = "ios";
}

const root = document.getElementById("root");
if (!root) throw new Error("Missing application root");

const App: ComponentType = isIosShell
  ? (await Promise.all([import("./IosMobileApp.js"), import("./ios-pixel.css")]))[0].IosMobileApp
  : (await Promise.all([
      import("./App.js"),
      import("./styles.css"),
      import("./reference-shell.css"),
    ]))[0].App;

createRoot(root).render(
  <StrictMode>
    <BrowserRouter>
      <ErrorBoundary>
        <App />
      </ErrorBoundary>
    </BrowserRouter>
  </StrictMode>
);
