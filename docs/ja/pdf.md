# PDF

[English](../pdf.md) | 日本語

クレート `shikigami-pdf`。PDF の文字を読む組込ステップです。読んだ文字から値を取り出すのは式の関数で書きます（[expressions.md](expressions.md)）。

| ステップ | 内容 | 出力 | リスク |
|---|---|---|---|
| `pdf.readText` | PDF の文字を読む | `{ text, pages }` | safe |

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
