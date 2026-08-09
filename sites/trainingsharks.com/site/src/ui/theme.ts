// Theme controller — light/dark for the site shell + content pages.
//
// The roulette table itself stays dark regardless (felt is felt); the game
// wrapper hard-pins data-theme="dark" on its own subtree. This controller only
// drives the <html> attribute, which the marketing/business surfaces read.
//
// Dark is the default (the "shoulder-surfer / dim pit" register). A manual
// choice is remembered in localStorage; we never auto-flip after that.

export type Theme = "dark" | "light";

const STORAGE_KEY = "ts_theme";

export function getStoredTheme(): Theme | null {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    return v === "light" || v === "dark" ? v : null;
  } catch {
    return null;
  }
}

/** Resolved theme: stored choice wins, else dark default. */
export function getTheme(): Theme {
  return getStoredTheme() ?? "dark";
}

export function setTheme(theme: Theme): void {
  try {
    localStorage.setItem(STORAGE_KEY, theme);
  } catch {
    /* private mode — fall through, attribute still applies for this session */
  }
  applyTheme(theme);
}

export function applyTheme(theme: Theme): void {
  document.documentElement.setAttribute("data-theme", theme);
}

export function toggleTheme(): Theme {
  const next: Theme = getTheme() === "dark" ? "light" : "dark";
  setTheme(next);
  return next;
}

/** Call once on boot, before first paint where possible. */
export function initTheme(): void {
  applyTheme(getTheme());
}
