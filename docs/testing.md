# Testing flows

English | [日本語](ja/testing.md)

So that you do not have to check by hand that a flow still gives the same result after each change, keep **test cases** and run them all at once. A test case is a small JSON file: "run with these inputs, and it should end like this, with these outputs".

## Where and how

One file per case in the flow folder's `tests/`. The file name without `.json` is the case's name.

```text
flows/<flow id>/
  flow.json
  input/
  tests/
    3支店の合計.json
    フォルダーが無い.json
```

```json
{
  "description": "Add up the 3 branch CSVs in input",
  "inputs": { "folder": "input" },
  "expect": { "status": "succeeded", "outputs": { "branchCount": 3, "grandTotal": 73050 } }
}
```

| Field | Meaning |
|---|---|
| `$schema` | For editor completion (optional; the schema is [schemas/test-case.schema.json](../schemas/test-case.schema.json)) |
| `description` | What the case is about (optional) |
| `inputs` | Values of input variables. Inputs left out keep their default (as with `shikigami run -i`) |
| `expect.status` | How the run ends: `succeeded` (default), `failed`, `cancelled` |
| `expect.outputs` | Output variables to check, with their values |
| `expect.errorCode` | With `failed`: the error's code (e.g. `ELEMENT_NOT_FOUND`, `FILE_NOT_FOUND`) |
| `expect.errorStep` | With `failed`: the ID of the node it should stop at |

`expect.outputs` compares **only what it names**:

- Outputs it does not name are not looked at, so adding an output does not break a case
- For an object, only the keys written are compared (`{ "summary": { "count": 2 } }` checks `summary.count` only)
- A list must have the same length; each item is compared the same way
- Numbers compare by value (`3` equals `3.0`)

A case can also check that the run stops with an error:

```json
{
  "inputs": { "folder": "無いフォルダー" },
  "expect": { "status": "failed", "errorCode": "FILE_NOT_FOUND" }
}
```

`tests/` goes into bundles (export to a file) with the flow.

## Running them

```bash
shikigami test <flow id>                   # all cases, published version
shikigami test <flow id> --draft           # the working content
shikigami test <flow id> --case 3支店の合計  # one case (repeatable)
shikigami test examples/tutorials/sales-csv/flow.json   # a flow file too
```

```text
✓ 3支店の合計 — input の 3 支店の CSV を合計する (57 ms)
✗ わざと違う (44 ms)
    outputs.grandTotal: expected 1, got 73050
    run run_01a1b7346ab87610b9e2a18b7b85b106
✓ フォルダーが無い (0 ms)
2 passed, 1 failed
```

- Each case is one ordinary run, recorded like any other (`origin.requestedBy` is `test:<case name>`). Open a failed case's run in Studio's run history by the run ID shown
- A flow that drives other apps or web sites really drives them in a test too. Pass test inputs (a test folder, a test system's URL) in `inputs`
- The exit code is 1 when any case differs, for batch files and CI
- `--json` prints one JSON object (`passed`, `failed`, `cases[]`; each case has `passed`, `runId`, `status`, `error`, `mismatches[]`). A mismatch has `at` (e.g. `outputs.total`), `expected` and `actual`

Example: `examples/tutorials/sales-csv/tests/`, from the [sales CSV tutorial](tutorials/sales-csv.md).
