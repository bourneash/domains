import { useState } from "react";
import { getTheme, toggleTheme, type Theme } from "../theme";

export function ThemeToggle() {
  const [theme, setThemeState] = useState<Theme>(getTheme);

  return (
    <button
      type="button"
      className="theme-toggle"
      onClick={() => setThemeState(toggleTheme())}
      aria-label={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
      title={theme === "dark" ? "Lights on" : "Lights off"}
    >
      {theme === "dark" ? "☼" : "☾"}
    </button>
  );
}
