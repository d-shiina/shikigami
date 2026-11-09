# PDF

English | [日本語](ja/pdf.md)

Crate `spellsheet-pdf`. Built-in nodes that read the text of PDFs and join or split PDFs. Pulling values out of the text is done with expression functions ([expressions.md](expressions.md)).

| Node | What it does | Output | Risk |
|---|---|---|---|
| `pdf.readText` | Reads the text of a PDF | `{ text, pages }` | safe |
| `pdf.merge` | Joins PDFs into one PDF | `{ path, pageCount }` | interactive |
| `pdf.extractPages` | Makes a new PDF from some pages of a PDF | `{ path, pageCount }` | interactive |
| `pdf.split` | Splits a PDF into files of a few pages each | the new files' paths | interactive |

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

## `pdf.merge`, `pdf.extractPages`, `pdf.split`

Nothing needs to be installed (no Acrobat). Each writes new files and never changes the PDFs it reads.

- `pdf.merge`: `files` (the PDFs, in the order they go in) into `to`.
- `pdf.extractPages`: the pages `pages` of `path` into `to`. Pages are written like `"1-3,5"`, and `"2-"` means page 2 to the last. Page 1 is the first page; pages go out in the order written (`"3,1"` puts page 3 first). A page past the end gives `PDF_PAGE_OUT_OF_RANGE` (its `details.pageCount` says how many there are).
- `pdf.split`: `path` into files of `pagesPerFile` pages (default 1) in `folder`, named after the PDF: `invoice_01.pdf`, `invoice_02.pdf`, …. The output is the list of new paths, ready for `control.forEach`.
- An existing `to` (or any of the split files) gives `FILE_EXISTS` before anything is written, unless `overwrite: true`.
- The new file holds only the chosen pages and what they draw. Bookmarks, form fields and links to pages left out are not carried over, so a page split out of a batch of invoices never carries the other customers' pages inside the file. Images the pages share a resource list for (as scanners write them) are kept only for the pages that draw them.
- `pdf.extractPages` and `pdf.split` open a password-protected PDF with `password` (as in `pdf.readText`); the new files have no password. `pdf.merge` opens PDFs that only restrict printing or copying; one that needs a password to open gives `PDF_PASSWORD_REQUIRED` (take its pages out with `pdf.extractPages` first).

```json
{ "type": "pdf.split", "params": { "path": "input/scanned.pdf", "folder": "work/pages" }, "saveAs": "pages" }
{ "type": "pdf.merge", "params": { "files": ["input/cover.pdf", "{{ invoice.path }}"], "to": "output/invoice-set.pdf" } }
{ "type": "pdf.extractPages", "params": { "path": "input/report.pdf", "pages": "2-", "to": "output/body.pdf" } }
```
