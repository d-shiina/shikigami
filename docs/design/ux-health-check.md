# Studio UI/UX walkthrough (2026-11-07, v0.1.8 + #133)

Japanese: [docs/ja/design/ux-health-check.md](../ja/design/ux-health-check.md).

More than 40 PRs landed separately over two days, and nobody had walked Studio from start to finish since. This review launched the real Studio (the Tauri app, driven over WebDriver on Linux) on an empty workspace and walked what a person does, in order. The premise: building with AI and building by hand from scratch are both first-class ways in.

Checked against [ui-principles.md](ui-principles.md), [wording.md](wording.md), the contrast rules (darker greys, slate dark theme) and Japanese glyphs. Fixing is out of scope, except one crash fixed in the same PR (U1 below).

Screenshots: the project files folder `spellsheet/ux-health-check/` (`[12]` below is `12-palette.png`, and so on).

## What was walked

| # | Flow | What was done | Result |
|---|---|---|---|
| 1 | First launch, AI setup | Fresh home folder → language → AI pane | Works. The first screen assumes AI [01][02] |
| 2 | Build one with AI | Paste an AI answer (the guide's example) → open → review | Taking it in works. **It never reaches review** [25][46] |
| 3 | Build one by hand | New flow → read Excel rows → repeat → log → insert a value | Possible. Many snags in the first ten minutes [10]–[22] |
| 4 | Try and check | Run one node, run, a missing-file error, validation, procedure, variables | Works. Wording and layout drift [17][23][30]–[33] |
| 5 | Fix | The to-do list, open a part | "Open part" from review opens nothing [27] |
| 6 | Publish and hand out | Publish, the run window, schedules | **Run in the run window crashes Studio** (fixed) [40][41][50][51][70] |
| 7 | Settings, secrets | Every settings section, the secret form, dark theme | Works. Small drift [61][62][63][80] |

Not walked: a real AI conversation in the pane (no signed-in AI here), "pick on screen" (needs a real browser or desktop app), Windows-only parts (file dialogs, tray, the time field).

## What works well

- The palette: opens on frequent nodes, kana search ("くりかえし"), the "where it goes" line [12][18].
- Adding a repeat fills its list with the previous node's result (rows) [19].
- The node screen's "values you can use": the columns of the row being repeated, inserted with a click [21][22].
- Running one node shows its result as a table [17]. The project shelf says how files are used ("no node uses this").
- Japanese glyphs (Noto Sans JP); the slate dark theme reads well [80].

## Findings by screen

Kinds: **Broken** (does not work, or a path dead-ends) / **Missing** / **Noise** (not needed) / **Unclear** / **Twice** (same thing in two places) / **Wording** (terms drift).

### Flow library, first launch [01][02][10]
- Missing: the only way in on the first screen is AI. The empty list says "you can also ask the AI to make a flow", the samples say "learn to have the AI build…". Nothing for someone building by hand (a first node to start with, open a sample and copy it).
- Missing: there is no splash screen and none is needed. What is missing is a first-run empty state.
- Twice: "Paste an AI answer" on the library header and in the AI pane [02].
- Unclear: opening the AI pane pushes "New flow" onto a second row [02].
- Noise: two filled buttons on one surface, "New flow" and "Create" [10].
- Wording: the AI pane says 導入 / 未導入 / 入れて; wording.md says インストール.

### The chart, building by hand [11][13][19][23]
- Unclear: a node just added turns the title bar red ("1 error") and disables Run [13]. A node just added should read "not set up yet". Meanwhile a log node with its required message empty shows "valid" [21]: the same state, shown two ways.
- Unclear: after adding, setting it up takes another click on "Open settings". Open the node screen right away, or show the required fields in place.
- Noise: result variables get program names automatically (`rows`, and `forEach` for the repeat's result). `forEach` is read by nothing and the variables table warns about it [32].
- Wording: program names on screen. `path` in the node's sentence, the `forEach` tag in the header, the line label "forEach: one of rows at a time", `excel.readRows` and `control.forEach` under the inspector's variable links, `excel.readRows` in the status bar [16][19][30].
- Wording: repeats are called 繰り返し（リスト）, 回数ループ and 条件ループ. Searching "くりかえし" ranks "next iteration" first, and English tags (continue, forEach, repeat, while) show [18].
- Unclear: the selected node's tools (↑ ↓ group…) are cut off under the inspector. The chart is not centred in the work area, and after a run it jumps so the dock covers a node [19][23].
- Noise: the "React Flow" attribution in the corner.

### The node screen [14][16][17][21][22]
- Twice: two exits, "Back to the chart" and "Close", and the filled (primary) button is "Close".
- Wording: a "設定" section inside the "設定" column. "JSON で編集（上級）" is developer language.
- Wording: "値を入れたい欄" (入れる). The path help speaks of relative and absolute paths.
- Noise: the node's own result (rows) is offered among "other variables" [14].
- Unclear: templates show raw in the field as `{{ item.取引先 }}`; the sentence above shows chips, the field shows syntax [22].
- Missing: a node inside a repeat cannot be run alone until the whole flow has run once. The previous node's single-run result could serve [22].
- Noise: an internal `_row` column in the single-run table [17].

### Palette [12][18][20]
- Wording: banned words in descriptions (入れる, 飛ばして).
- Unclear: opened from inside a repeat, the palette covers the inspector and runs off the right edge [20].

### Runs and errors [23][30][31][33]
- Wording: the run log shows `run_01a1…`, node IDs `stp_5993f49d` and "(rev 7)" [23].
- Wording: the pause panel shows the code `FILE_NOT_FOUND`, an "English original", and an unrelated English line "画面を取得できませんでした：'path' is required" [30].
- Wording: the title bar says 停止, the panel says 中止. After 中止 the log ends with "失敗 (22386 ms)" [31].
- Noise: two filled buttons in the panel (re-run, ask AI to fix). The panel covers half the work area and the paused node hides under the dock [30].
- Wording: one mechanism, four names: 検証OK / エラー n 件, 手直し n 件, 要手直し, 検証結果 [30][33].
- Unclear: the to-do text "the AI cannot see screens or logins…" also shows on a hand-built flow. For a missing file it does not suggest the `受注一覧.xlsx` already in the folder [33].

### Review and AI changes [24][25][45][46][27]
- **Broken**: a new flow made by an AI never reaches review. The paste dialog says "the AI has 1 question; answer it in 確認待ち", but review says "nothing waiting" and "this flow is reviewed" [25][46]. Cause: review counts only revertible changes (`isRevertible`), and `create` is excluded. MCP `create_flow` also takes steps, so the same must happen there. The AI's checks have nowhere to be answered.
- **Broken**: "Open part" on review's to-do list opens nothing (the right side is the review panel, so there is nowhere to show the part) [27]. It works from the flow place [28].
- Unclear: a hand-built flow no AI touched says "this flow is reviewed" [45].
- Wording: "AIからの変更" (missing space).

### Parts [28]
- Unclear: parts are edited in the inspector, which is read-only by rule. Field names (種類・名前・ラベル・表示の文字) are UI Automation terms, and "キー searchBox" shows. The main action, "pick on screen", is a small text link.

### Publish [40][41]
- Missing: publishing gives no warning with to-dos left or after a failed last run.
- Unclear: publishing and named versions share one dialog with two filled buttons. "v1「v1」を確定済み" repeats itself. The version row says "rev 7 · 3 steps" (English, developer terms).
- Noise: the "v1 を確定しました" banner stays on every place afterwards [50][60][61].

### Run window [70]
- **Broken**: pressing Run crashes Studio. `runner_run` was a sync command; it started the run outside the Tokio runtime, panicked and aborted. Windows too (Tauri runs sync commands on the main thread). **Fixed in this PR** (now `async fn`).
- Unclear: the list's "just now · failed" is a Studio test run, mixed with published runs.

### Schedules [50][51]
- Unclear: a red "the agent is stopped" with no schedules at all. "Agent" is developer language.
- Missing: no page name in the title bar (`PAGE_TITLE` in `TitleBar` has no `runs`). The run history (planned in ui-principles) does not exist yet.
- Unclear: unpublished flows are offered. The input field is labelled with the variable name `orderNo`. The full path of `schedules.json` is shown.
- Wording: the form stacks labels above fields, unlike settings' one row per setting. Buttons read "Cancel | Save" here and "Save | Cancel" on secrets [63].

### Settings [61][62]
- **Broken**: the table of contents marks the wrong section (always "Version and updates").
- **Broken**: the AI section says "press 導入する below", and there is no button below (installing is only in the AI pane).
- Wording: the AI is "Claude Code" in the sidebar, "AI エージェント" and "使う AI" in settings.
- Unclear: "このフロー（受注を検索する）" sits inside the workspace-wide permissions; flow settings belong in the inspector's flow view. What "Save" covers is not visible.
- Wording: permission help lists `browser.open・oauth.signIn・http.request`.

### Secrets [60][63]
- Small drift only ("MFA の設定キー", "otpauth://"), plus the button order above.

### Everywhere
- Noise: several filled buttons per surface (Run in the title bar, Add node in the dock, "Add variable" in the inspector) [11].
- Unclear: flow run settings say "timeout (ms)" and "on error (default: 停止する)" [11].

## Fix candidates (by priority)

| # | What | Size | Kind |
|---|---|---|---|
| U1 | Run in the run window crashes Studio | 1 line | Broken (**fixed in this PR**) |
| U2 | Put new AI-made flows in review (count a create as an all-new change, so its checks can be answered) | Medium | Broken |
| U3 | "Open part" from review, the settings table of contents, the "press 導入する below" text | Small | Broken |
| U4 | The first ten minutes by hand: a first-run empty state (build with AI / build it myself / open a sample), open the node screen (or its required fields) right after adding, show a fresh node as "not set up" rather than an error, let a single run feed the next node | Medium | Missing, Unclear (fixed in #142) |
| U5 | Remove program names from the screen: setting keys in sentences, the `forEach` tag and line label, node types under variable links, automatic result names (no `forEach` variable), IDs and rev in the run log, the status bar, the version row, permission help, schedule inputs | Medium | Wording (fixed in #142) |
| U6 | Align terms: one name for to-dos / validation / errors, 停止 → 中止, 繰り返し vs ループ, インストール, one name for the AI, banned words in the palette, the error code and English original in the pause panel | Small–medium | Wording (fixed in #142) |
| U7 | Warn before publishing with to-dos or a failed run, split publishing from named versions, clear the publish banner, show only published runs in the run window | Medium | Missing, Unclear (fixed in #142) |
| U8 | Back to the layout rules: one filled button per surface, one exit from the node screen, move part editing out of the inspector, one form layout and button order, the library header with the AI pane open | Medium | Noise, Twice (fixed in #142) |
| U9 | Chart placement: centred at first, no jump after a run, node tools never cut off, the palette inside the window, no attribution | Small–medium | Unclear (fixed in #142) |
| U10 | Schedules: no warning without schedules, a page title, no unpublished flows, a plainer word for "agent" | Small | Unclear, Wording (fixed in #142) |

U1–U3 are bugs and can be fixed without asking. U4 matters most for selling "build it from scratch by hand". U5 and U6 are mechanical but wide; ship them with a test that no program name reaches on-screen text (like `paramNames.test.ts`).
