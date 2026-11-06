# PDF

[English](../pdf.md) | 日本語

クレート `shikigami-pdf`。PDF の文字を読み、PDF を結合・分割する組込ノードです。読んだ文字から値を取り出すのは式の関数で書きます（[expressions.md](expressions.md)）。

| ノード | 内容 | 出力 | リスク |
|---|---|---|---|
| `pdf.readText` | PDF の文字を読む | `{ text, pages }` | safe |
| `pdf.merge` | いくつかの PDF を 1 つにつなぐ | `{ path, pageCount }` | interactive |
| `pdf.extractPages` | 一部のページだけで新しい PDF を作る | `{ path, pageCount }` | interactive |
| `pdf.split` | 数ページずつのファイルに分ける | 作ったファイルのパスの配列 | interactive |

## `pdf.readText`

- `text` は全ページの文字、`pages` はページごとの文字の配列（`pages[0]` が 1 ページ目）。
- 文字を読めるのは、文字の情報を持つ PDF（Word・Excel・Web システムなどが作った PDF、印刷ドライバーで作った PDF）です。スキャンした PDF は画像なので `text` が空になります。文字を読み取る（OCR）機能はまだありません。
- パスワードで保護された PDF は `password` に登録済みのシークレット `{ "secret": "請求書PDF", "field": "password" }` を渡します。パスワードがないと `PDF_PASSWORD_REQUIRED`、違うと `PDF_WRONG_PASSWORD`。印刷やコピーだけを制限した PDF（開くパスワードがないもの）は `password` なしで読めます。
- 壊れたファイルや PDF でないファイルは `PDF_UNREADABLE`、ファイルがないと `FILE_NOT_FOUND`。

```json
{ "type": "pdf.readText", "params": { "path": "C:\\work\\請求書.pdf" }, "saveAs": "invoice" }
{ "type": "variable.set", "params": { "name": "amount", "value": "{{ num(regexFind(invoice.text, '請求金額\\\\s*([\\\\d,]+)', 1)) }}" } }
```

- 行ごとに見るなら `lines(invoice.text)`、ページを絞るなら `invoice.pages[0]`。
- PDF の文字は、見た目の並びと読み出しの順番が違うことがあります（表や段組み）。値は「見出しの後ろの数字」のように正規表現で取り出すと崩れにくくなります。

## `pdf.merge`・`pdf.extractPages`・`pdf.split`

インストールの要るものはありません（Acrobat 不要）。どれも新しいファイルを作り、読んだ PDF は変えません。

- `pdf.merge`：`files`（つなぐ順に並べた PDF）を `to` に 1 つにします。
- `pdf.extractPages`：`path` のページ `pages` を `to` に抜き出します。ページは `"1-3,5"` のように書き、`"2-"` は 2 ページ目から最後まで。1 ページ目が 1 で、書いた順に並びます（`"3,1"` なら 3 ページ目が先頭）。ない番号は `PDF_PAGE_OUT_OF_RANGE`（`details.pageCount` に総ページ数）。
- `pdf.split`：`path` を `pagesPerFile` ページ（既定 1）ずつに分けて `folder` に保存します。名前は元の PDF から `請求書_01.pdf`・`請求書_02.pdf`…。出力は作ったパスの配列で、そのまま `control.forEach` に渡せます。
- 書き出し先（分割なら作るファイルのどれか）がもうあると、何も書かずに `FILE_EXISTS`。置き換えるなら `overwrite: true`。
- 新しいファイルに入るのは選んだページと、そのページが描くものだけです。しおり・フォームの入力欄・抜いたページへのリンクは引き継ぎません。まとめてスキャンした請求書を分けても、ほかのお客さまのページがファイルの中に残ることはありません。ページどうしで画像の一覧を共有している PDF（スキャナーがよく作る形）でも、残すのはそのページが描く画像だけです。
- `pdf.extractPages` と `pdf.split` は、パスワード付きの PDF を `password`（`pdf.readText` と同じ）で開けます。作ったファイルにはパスワードは付きません。`pdf.merge` は印刷・コピーだけを制限した PDF は開けますが、開くのにパスワードが要るものは `PDF_PASSWORD_REQUIRED`（先に `pdf.extractPages` でページを取り出す）。

```json
{ "type": "pdf.split", "params": { "path": "input/まとめてスキャン.pdf", "folder": "work/分割" }, "saveAs": "pages" }
{ "type": "pdf.merge", "params": { "files": ["input/表紙.pdf", "{{ invoice.path }}"], "to": "output/請求書一式.pdf" } }
{ "type": "pdf.extractPages", "params": { "path": "input/報告書.pdf", "pages": "2-", "to": "output/本文.pdf" } }
```
