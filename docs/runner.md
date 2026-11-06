# The run window

English | [日本語](ja/runner.md)

Studio is for the people who make flows. The people who only run them get a small window of their own, **Shikigami Run**: pick a published flow, fill in its inputs, press Run, and see what came out.

- Open it from Studio's sidebar ("Run window"), or start Studio with `--runner` to open only this window (a shortcut for people who never edit)
- Only published flows are listed, and a run always uses the published version. Flows are published in Studio's To review ([policy.md](policy.md))
- A person starts the run and watches it, so the unattended policy (`unattended` in `policy.json`) does not apply, as with Run in Studio. The run is recorded like any other (`origin.trigger` `studio`, `requestedBy` `runner`)
- An unhandled error ends the run. Nothing pauses for debugging here: the window says what happened and what to do, in the same words as Studio

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
| `default` | Fills the field in. Without a default the field must be filled in; with one, an empty field leaves the default |

## While it runs and after

While it runs, the window lists the flow's top-level nodes and ticks them off, with the node it is on now. When it ends it shows the output variables (by their description) and the files the run wrote to `output/`, each with Open, and Open folder. A failed run shows the error's code and what to do.
