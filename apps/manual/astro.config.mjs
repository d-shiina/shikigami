// The product manual for the people who use SpellSheet at work. Built with
// Starlight and published under the product site as manual/: the Deploy
// workflow of spellsheet/spellsheet.github.io builds it with MANUAL_SITE and
// MANUAL_BASE and serves it at https://spellsheet.github.io/manual/.
import starlight from "@astrojs/starlight";
import { defineConfig } from "astro/config";

const site = process.env.MANUAL_SITE ?? "https://spellsheet.github.io";
const base = process.env.MANUAL_BASE ?? "/manual";

export default defineConfig({
  site,
  base,
  trailingSlash: "always",
  integrations: [
    starlight({
      title: "SpellSheet マニュアル",
      defaultLocale: "root",
      locales: { root: { label: "日本語", lang: "ja" } },
      logo: { src: "./src/assets/mark.png", alt: "SpellSheet" },
      favicon: "/favicon.png",
      head: [
        { tag: "link", attrs: { rel: "preconnect", href: "https://fonts.googleapis.com" } },
        { tag: "link", attrs: { rel: "preconnect", href: "https://fonts.gstatic.com", crossorigin: true } },
        {
          tag: "link",
          attrs: {
            rel: "stylesheet",
            href: "https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700&family=Noto+Sans+JP:wght@400;600;700&display=swap",
          },
        },
      ],
      social: [{ icon: "github", label: "GitHub", href: "https://github.com/spellsheet/spellsheet" }],
      customCss: ["./src/styles/manual.css"],
      lastUpdated: false,
      pagination: true,
      sidebar: [
        { label: "はじめに", items: [{ label: "SpellSheet でできること", link: "/" }, "install"] },
        { label: "フローを作る", items: ["writer", "make-flow", "review"] },
        { label: "動かす", items: ["run", "tests", "publish-and-schedule"] },
        { label: "安全に使う", items: ["secrets"] },
        { label: "広げる", items: ["share", "ai-and-mcp", "custom-nodes"] },
        { label: "資料", items: ["folders", "troubleshooting", "glossary"] },
      ],
    }),
  ],
});
