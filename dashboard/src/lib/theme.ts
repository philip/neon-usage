// Theme is an explicit light/dark choice. On first visit it is seeded from the
// OS preference ("auto picks one"); after that the moon/sun toggle stores an
// explicit value. tokens.css themes on a `.dark` class on <html>.

export type Theme = "light" | "dark";

const KEY = "neon-usage-theme";

/** The stored choice, or the OS preference on first visit. */
export function storedTheme(): Theme {
  // Preferences are nonessential: a storage-denied browser (private window,
  // blocked site data) must still render, so reads and writes never throw.
  try {
    const value = localStorage.getItem(KEY);
    if (value === "light" || value === "dark") return value;
  } catch {
    // Fall through to the OS preference.
  }
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

export function applyTheme(theme: Theme): void {
  document.documentElement.classList.toggle("dark", theme === "dark");
}

export function setTheme(theme: Theme): void {
  try {
    localStorage.setItem(KEY, theme);
  } catch {
    // Storage denied: the choice lasts for this page's lifetime only.
  }
  applyTheme(theme);
}
