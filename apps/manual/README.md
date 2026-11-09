# SpellSheet マニュアル

業務で SpellSheet を使う人向けの製品マニュアルです。[Starlight](https://starlight.astro.build/) で HTML にし、製品サイトの `manual/` に載せます（`.github/workflows/pages.yml`）。

- 原稿：`src/content/docs/`（1 ページ 1 ファイル、Markdown。アイコンや画面写真を入れるページは `.mdx`）
- 並び順：`astro.config.mjs` の `sidebar`
- 画面写真：`src/assets/screens/`。`src/components/Screen.astro` でライトとダークを出し分けます
- 見た目：`src/styles/manual.css`（製品サイトと同じ色・フォント）

```powershell
pnpm --filter @spellsheet/manual dev     # http://localhost:4321/spellsheet/manual/ で見ながら書く
pnpm --filter @spellsheet/manual check   # ビルドして、リンク切れがないか確かめる（CI でも実行）
```

書き方の決まり：画面の言葉は Writer の表示どおりに書く（`apps/studio/src/lib/locales/ja.ts`）。造語を作らず、業務アプリで通じる言葉にする。絵文字や記号のアイコンは使わず、アイコンは lucide（`@lucide/astro`）。ページの中のリンクは `../tests/` のような相対パスで書く。
