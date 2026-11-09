# Tutorials

English | [日本語](../ja/tutorials/README.md)

Each tutorial takes one piece of office work from start to finish: ask the AI for a flow, check it, and set it up to run every month. Each takes about 15 minutes and comes with sample files. The samples are Japanese business data, as SpellSheet's first users are in Japan.

| Tutorial | Work | Uses |
|---|---|---|
| [Combine branch sales CSVs into one Excel workbook](sales-csv.md) | Accounting, sales admin | CSV, Excel |
| [Make an invoice per customer from an order list](invoices.md) | Accounting | Excel, a Word template |
| [Ship pending orders in a web order system](web-orders.md) | Orders, shipping | Browser, secrets (sign-in) |

## Before you start

- Install and start SpellSheet Writer ([Getting started in the README](../../README.md#getting-started))
- Open the AI pane with "Claude Code" at the top left of Writer (Ctrl+J) and sign in
- The sample files are in `examples/tutorials/`. The finished flows (`*.spellsheet.json`) are there too. To look at one without the AI, press "Open finished" under "Samples" on Writer's Flows page (the sample files come with it), or open the bundle with "Import from file"

## The steps every tutorial shares

1. **Make a flow and add the files**: "New flow" on the Flows page. Drop the sample files on the project shelf on the left; they are sorted into `input/`, `templates/` and so on by name
2. **Ask the AI**: paste the tutorial's request into the AI pane. The AI adds a few nodes at a time and the flow chart follows it
3. **Check it**: under "To review" in the sidebar, read what changes, what it touches outside, and the AI's test runs, then press "Review and publish"
4. **Try it**: "Run" in the title bar (F5). When a run pauses on an error, Writer says what happened and what to do. "Ask Claude Code to fix" fixes it on the spot and the run carries on
5. **Run it every month**: the published version runs without the AI. Add a schedule under "Automation" in the sidebar to run it at a set time. Other people can run it from the "SpellSheet Runner" window
