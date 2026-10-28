# Compatibility policy

English | [日本語](ja/compatibility.md)

The promises Shikigami makes to the outside, and the rules for changing them. Scenarios are used for a long time, and AI clients and scripts are built on the MCP tools and the CLI. Breaking what is listed here makes scenarios silently stop working on users' machines.

## 1. Scope

| Promise | Where it is defined | Main users |
|---|---|---|
| The scenario file format (`schemaVersion`) | `crates/shikigami-core/src/model.rs` → `schemas/scenario.schema.json` | Saved scenarios, shared workspaces |
| Named versions and bundles (`*.shikigami.json`, `formatVersion`) | `version.rs` → `schemas/api.schema.json` | Handing over to other PCs and workspaces |
| Built-in step types (type names, params, blocks, whether `saveAs` applies, `risk`) | Each adapter → `schemas/contract/step-types.json` | Scenarios, what the AI has learned to write |
| MCP tools (names, arguments, results, permission classes, annotations) | `crates/shikigami-mcp` → `schemas/contract/mcp-tools.json` | AI clients, skills |
| Error codes (`code` and `retryable`) | `CoreError::code`, each step's errors | AI fixes, `onError` and retry decisions |
| The CLI (commands, arguments, exit codes, `--json` output) | `crates/shikigami-cli` → `schemas/contract/cli.json`, `schemas/run-api.schema.json` | Task Scheduler, batch jobs, CI |
| Plugin manifests and JSON-RPC (`manifestVersion`) | [design/plugins.md](design/plugins.md) (Japanese) | Plugin authors |

Not promises: Studio's screens, the internal Rust API (the crates are not published), the wording of logs and errors (`message` and `hint` are reworded), descriptions such as those of `list_step_types`, and local areas of the workspace (where undo history and run records are kept).

## 2. What may and may not change

**Any time (additions)**

- Adding step types, MCP tools, CLI subcommands or flags
- Adding optional params and arguments (behaving as before when omitted)
- Adding fields to results and `--json` output (readers must ignore fields they do not know)
- Adding error codes, improving wording and hints

**Needs a migration or a deprecation period (breaking changes)**

- Renaming or removing (step types, params, tools, arguments, flags, error codes)
- Adding required params or arguments, narrowing accepted values, changing meaning
- Changing what exit codes mean

Even during 0.x, breaking changes are made in one of two ways.

1. **The scenario format and built-in step params**: raise `schemaVersion` and write a migration (§3). Old files take the new shape automatically when loaded
2. **MCP and the CLI**: add the new name while keeping the old one, and deprecate the old one (§5). Both work at least until the next minor version

Either way it goes under "Breaking changes" in [CHANGELOG.md](../CHANGELOG.md). From 1.0 on, breaking changes happen only in major versions.

## 3. The scenario file format

- `schemaVersion` is the version of the file's shape. **It goes up by 1 every time the shape changes.** Scenarios reject unknown fields (to catch typos), so it goes up even when only an optional field is added. An older Shikigami then stops with a clear "saved by a newer version, please update" (`UNSUPPORTED_SCHEMA_VERSION`)
- When it goes up, add a "previous version → current version" function to `MIGRATIONS` in `crates/shikigami-core/src/migrate.rs`. Loading converts from old versions one step at a time, so each function only needs to know the version just before it. A gap makes the tests fail
- Breaking changes to built-in step params are migrated here too (rewriting every step with `for_each_step`). Built-in steps ship with Shikigami itself, so steps carry no versions of their own. Having scenarios write versions would add to what AI has to write and where it can go wrong ([design/ai-authoring.md](design/ai-authoring.md), Japanese)
- Files, named versions, scenarios inside bundles and subscenarios all go through the same migration (`migrate::from_value` / `migrate::deserialize`)
- A migrated scenario is written in the new version the next time it is saved. Reading alone never rewrites the file
- Future versions are not loaded (silently dropping fields would lose them on save)
- Unknown keys inside `metadata` are kept (for notes from Studio and outside tools)

Tests: add a test to `migrate.rs` for every migration, showing a file of the previous version loads in the current one.

### Bundles

Bundles carry `formatVersion`, and the scenarios inside follow the same `schemaVersion` rules as above. Raise `BUNDLE_FORMAT_VERSION` when the outer shape of a bundle changes.

## 4. Plugins and `requires`

A scenario keeps the plugins it uses and their version ranges in `requires`.

```json
"requires": { "plugin:kintone": "^0.3.1" }
```

- **Core manages it automatically.** Adding a plugin step adds `^<version>` for the version installed at the time, and it is removed when no longer used. Neither people nor AI need to write it
- Only to widen or narrow a range, rewrite it with `patch.requires` in `update_scenario` (kept while in use)
- Ranges are semver (`^0.3.1`, `>=1.2, <3`…). A plugin's `version` must be semver
- **On a PC without the plugin**: the scenario loads and its steps stay as they are. Validation gives `PLUGIN_NOT_INSTALLED` (which version of which plugin is needed and where to install it) and it stops before running
- **On a PC with a version outside the range**: it stops before running with `PLUGIN_VERSION_MISMATCH`

For plugin authors: raise the major version when params change incompatibly (the minor version during 0.x). Old scenarios stop with `PLUGIN_VERSION_MISMATCH`, so nothing breaks silently. If the old way can still be accepted, keeping the version compatible and adding new params is best.

## 5. Deprecation

- **Step types**: write the reason and the replacement type in `StepTypeDef.deprecated` (for plugins, `steps[].deprecated` in the manifest). They keep working, but validation warns with `DEPRECATED_STEP_TYPE` and names the replacement. AI rewrites them on seeing the warning
- **MCP tools and arguments**: keep the old name and start its description with `Deprecated: use <new name>.` A `deprecated` note may also go in the result
- **CLI**: keep the old command or flag and print a warning to standard error when it is used
- Record the deprecation and the version it is planned to be removed in the CHANGELOG. Removal happens in the next minor version or later (from 1.0, the next major version)

## 6. MCP

- Tool names are `snake_case`. Change them with the steps of §5
- Arguments are only added. To make one required, give it a default or make a new tool
- Results are JSON objects. Adding fields is free; removing them or changing their type is breaking
- Errors are `code`, `message`, `details`. `code` is fixed; `message` and `details.hint` may be improved
- Widening a permission class (making a `read` tool `write`) hides it from users running with `--allow read`, so it is treated as breaking
- The version of the MCP specification itself follows `rmcp`, which handles compatibility with older clients

## 7. CLI

Exit codes:

| Code | Meaning |
|---|---|
| 0 | Success |
| 1 | The run failed, validation found errors, or `plugin check` found problems |
| 2 | Could not start: wrong command usage, the workspace could not be opened, etc. |
| 130 | The run was cancelled (Ctrl+C) |

- Output with `--json` is a promise. `run --json` is one event per line (`RunEvent` in `schemas/run-api.schema.json`); everything else is one JSON value. Output without `--json` is for people and changes at any time
- From scripts, use `--json` and the exit code

## 8. Snapshots and CI

`pnpm schema:generate` (`shikigami schema export`) writes these "contract snapshots" to `schemas/contract/` along with the JSON Schema. They hold shapes only, no descriptions.

| File | Contents |
|---|---|
| `mcp-tools.json` | Tool names, permission classes, annotations, and the JSON Schema of arguments and results |
| `step-types.json` | Built-in step type names, the JSON Schema of params, blocks, whether `saveAs` applies, `risk`, etc. |
| `cli.json` | Subcommands, arguments, flags |

- Tests fail when the committed files and the Rust definitions drift apart (the same mechanism as `schemas/*.schema.json`)
- A pull request that changes `schemas/` must also change `CHANGELOG.md` (CI's "Contract changes are in the changelog"). Look at the diff and record which side of §2 it falls on
- The generated TypeScript types (`packages/schema`) are checked for drift in CI too

## 9. When releasing

1. Turn "Unreleased" in `CHANGELOG.md` into the version number and date
2. If there are breaking changes or deprecations, write them prominently under that version's heading
3. Then follow the steps in [release.md](release.md)
