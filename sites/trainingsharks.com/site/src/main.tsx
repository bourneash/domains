import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { Root } from "./Root";
import { initTheme } from "./ui/theme";
import { initAnalytics } from "./lib/analytics";
import "./ui/theme.css";
import "./ui/site.css";

initTheme();
initAnalytics();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Root />
  </StrictMode>
);
