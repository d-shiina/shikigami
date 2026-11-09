// What the start-up screen (splash.html) says, in the language Writer will
// show: the saved choice (lib/i18n.ts keeps it under the same key), or the OS.
// Its own small table, so the screen does not wait for the whole app.

export type SplashText = { lang: "ja" | "en"; tagline: string; status: string; version: string };

export function splashText(stored: string | null | undefined, osLanguage: string | undefined, version: string | null): SplashText {
  const lang =
    stored === "ja" || stored === "en" ? stored : (osLanguage ?? "ja").toLowerCase().startsWith("ja") ? "ja" : "en";
  const v = version?.trim() ? version.trim() : "";
  return lang === "ja"
    ? { lang, tagline: "AI が作り、AI なしで動く", status: "起動しています", version: v ? `バージョン ${v}` : "" }
    : { lang, tagline: "Built by AI. Runs without it.", status: "Starting", version: v ? `Version ${v}` : "" };
}
