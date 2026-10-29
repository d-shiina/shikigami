# PDF

English | [日本語](ja/pdf.md)

Crate `shikigami-pdf`. A built-in node that reads the text of PDFs. Pulling values out of the text is done with expression functions ([expressions.md](expressions.md)).

| Node | What it does | Output | Risk |
|---|---|---|---|
| `pdf.readText` | Reads the text of a PDF | `{ text, pages }` | safe |

## `pdf.readText`

- `text` is the text of every page; `pages` is a list of each page's text (`pages[0]` is page 1).
- Text can be read from PDFs that carry text (PDFs made by Word, Excel, web systems, or a print driver). Scanned PDFs are images, so `text` is empty. Reading text from images (OCR) is not available yet.
- For a password-protected PDF, pass a registered secret in `password`: `{ "secret": "Invoice PDF", "field": "password" }`. Without the password it gives `PDF_PASSWORD_REQUIRED`, with a wrong one `PDF_WRONG_PASSWORD`. PDFs that only restrict printing or copying (no password to open) are read without `password`.
- Broken files and files that are not PDFs give `PDF_UNREADABLE`; a missing file gives `FILE_NOT_FOUND`.

```json
{ "type": "pdf.readText", "params": { "path": "C:\\work\\invoice.pdf" }, "saveAs": "invoice" }
{ "type": "variable.set", "params": { "name": "amount", "value": "{{ num(regexFind(invoice.text, 'Amount due\\\\s*([\\\\d,]+)', 1)) }}" } }
```

- Use `lines(invoice.text)` to look line by line, or `invoice.pages[0]` for one page.
- The order text is read out of a PDF can differ from how it looks (tables, columns). Values are more robust when pulled out with a regular expression, such as "the number after the heading".
