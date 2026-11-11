# SpellSheet Runner

English | [日本語](ja/runner.md)

Writer is for the people who make flows. The people who only run them get a small window of their own, **SpellSheet Runner**: pick a published flow, fill in its inputs, press Run, and see what came out.

- "SpellSheet Runner" in the Start menu opens only this window (for people who never edit; it is the same app as Writer, started with `--runner`). "Runner" in Writer's "SpellSheet Writer" menu and the tray icon open it too. Runner has a taskbar button of its own, apart from Writer's; pinning it starts Runner. When SpellSheet is already running, it opens there instead of starting again
- Only published flows are listed, and a run always uses the published version. Flows are published in Writer's To review ([policy.md](policy.md))
- A person starts the run and watches it, so the unattended policy (`unattended` in `policy.json`) does not apply, as with Run in Writer. The run is recorded like any other (`origin.trigger` `studio`, `requestedBy` `runner`)
- An unhandled error ends the run. Nothing pauses for debugging here: the window says what happened and what to do, in the same words as Writer

## The form

The form is made from the flow's input variables (`direction` `input` or `inOut`), so neither the author nor the AI writes anything for it.

| Variable | Field |
|---|---|
| `description` | The label (its first line); without one, the name |
| `type: "string"` | A text box |
| `type: "number"` | A number box (commas are fine: `120,000`) |
| `type: "boolean"` | A checkbox |
| `type: "array"` | One item per line (or a JSON array) |
| `type: "object"` | JSON |
| `secret: true` | A password box |
| `format: "file"` / `"folder"` | A path box with Browse… (the file or folder dialog) |
| `format: "date"` / `"month"` | A calendar. The value is `2026-11-06` / `2026-11` |
| `choices: [...]` | A list to pick from (`type` `string` or `number`) |
| `default` | Fills the field in. Without a default the field must be filled in; with one, an empty field leaves the default |

`format` and `choices` are optional marks for the run window (flow format 6). Runs and `spellsheet run` do not check them, and validation keeps them sensible: `format` only on `string` variables, a `date` / `month` default in that shape, each choice once and of the variable's type, and a `default` among the choices.

```json
{ "name": "book", "type": "string", "direction": "input", "format": "file", "description": "Sales workbook" },
{ "name": "month", "type": "string", "direction": "input", "format": "month", "description": "Month" },
{ "name": "branch", "type": "string", "direction": "input", "choices": ["東京", "大阪", "名古屋"], "description": "Branch" }
```

## While it runs and after

While it runs, the window lists the flow's top-level nodes and ticks them off, with the node it is on now. When it ends it shows the output variables (by their description) and the files the run wrote to `output/`, each with Open, and Open folder. A failed run shows the error's code and what to do.

## The tray icon

While SpellSheet runs, its icon sits in the task tray (the notification area). Click it to open Runner; right-click for Open Runner, Open Writer and Quit.

Started with `--runner`, closing Runner leaves SpellSheet in the tray, so it stays at hand all day; Quit in the tray menu ends it. `--tray` starts with the tray icon only, for a shortcut in the Startup folder (`shell:startup`). Started without either, SpellSheet ends when its last window closes, as before.

SpellSheet runs once per Windows sign-in. Starting it again while it runs (Writer or Runner in the Start menu, a shortcut) opens no second copy: the running one comes to the front, showing Writer, or Runner when started with `--runner` ("SpellSheet Runner" in the Start menu; `--tray` shows nothing new). The development build (`pnpm studio:dev`) is not limited, so it runs beside an installed SpellSheet.
