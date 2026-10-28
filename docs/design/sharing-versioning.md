# シナリオの共有とバージョン管理（設計メモ）

方針：Git や GitHub を前提にしない。版の管理は Shikigami の中で完結させ、共有は「フォルダ」と「ファイル」で行う。Studio・MCP・CLI に同じ操作を出す。

## 版（バージョン）

- 版は名前とメモ付きの**不変のスナップショット**。`versions/<scenario-id>/<number>.json` に置く（ワークスペースの共有部分なので、同じワークスペースを使う全員に見える）。
- 版は番号（1, 2, …）で指す。名前は表示用で、重複してもよい。各版は `uid`（UUIDv7）を持ち、バンドルの取り込みで同じ版が二重にならないようにする。
- 差分はステップ ID 単位：`added` / `removed`（部分木の先頭だけ。`stepCount` に子を含む）、`changed`（変わった欄。params はキーごとに `params.url` のように出す）、`moved`（親・ブロックが変わったもの、または同じ並びの中で順序が入れ替わったもの。共通部分の最長部分列に入らないものだけを出すので、前に 1 つ挿入されただけでは移動扱いにならない）。変数は名前単位、シナリオの名前・説明・タグ・設定は欄単位。
- 復元は「現在の内容を版に合わせる EditOp 列」を 1 回の編集として適用する。Undo で取り消せ、記録（タイムライン）にも残る。すでに同じ内容なら何もしない（冪等）。
- 実行レポートには、実行した内容と一致する最新の版番号（`version`）を記録する。リビジョンは従来どおり。

| 操作 | MCP | CLI | Studio |
|---|---|---|---|
| 版を保存 | `create_version` | `shikigami version create <id> <name> [--note]` | 「版」タブ |
| 一覧・中身 | `list_versions` / `get_version` | `version list` / `version show` | 「版」タブ |
| 差分 | `diff_versions`（既定：最新の版 → 現在） | `version diff <id> [from] [to]` | 「現在との差分」 |
| 復元 | `restore_version` | `version restore <id> <n>` | 「この版に戻す」（2 回押し） |

## 共有

### 共有フォルダ（複数人で同じワークスペース）

- OneDrive や社内ファイルサーバーのフォルダをワークスペースにする。`workspace.json` に `{"shared": true}` を置くと共有ワークスペースになる（`shikigami workspace init <dir> --shared`、または Studio の保存先「変更」で「複数人で使う」にチェック）。
- 共有部分：`scenarios/`・`versions/`・`trash/`・`.lock`。
- PC ごとの部分：`history/`（Undo と変更ジャーナル）、`runs/`（実行記録）、MCP 監査ログ。`%LOCALAPPDATA%\Shikigami\local\<フォルダ名>-<パスのハッシュ>\` に置く。人ごとの Undo が混ざらず、OneDrive の同期競合も起きない。資格情報の保管庫もこちら側に置く。
- 既定のワークスペースは `SHIKIGAMI_HOME` > `%APPDATA%\Shikigami\config.json` の `workspace` > `%APPDATA%\Shikigami\workspace` の順。`shikigami workspace use <dir>` と Studio の「変更」は `config.json` を書くので、Studio・CLI・MCP サーバーが同じ場所を使う。
- 同時編集の保護は従来どおり：書き込みはワークスペースのロックを取り、リビジョンが変わっていれば `REVISION_CONFLICT`。ファイルサーバー（SMB）ではロックが PC をまたいで効く。OneDrive は同期が遅れるため、同じシナリオを同時に編集しない運用を前提にする（他の PC で変わった文書は Undo スタックを捨てて読み直す既存の仕組みが働く）。

### ファイルでの受け渡し（バンドル）

- `*.shikigami.json`：`{ "format": "shikigami.scenarioBundle", "formatVersion": 1, "exportedAt", "scenario", "versions": [...] }`。
- 書き出し時に `secret: true` の変数の初期値を消す。資格情報はもともと名前でしか参照しないので、中身は入らない。
- 取り込み：
  - ID がなければそのまま作成（ID を保つので、同じシナリオを何度でも受け渡せる）。
  - 同じ ID があれば `IMPORT_CONFLICT`。`onConflict: "update"` で既存を更新（1 回の編集・Undo 可）し、まだない版（`uid` で判定）を後ろに番号を振って追加。`"copy"` で新しい ID の別シナリオとして追加。
  - バンドルでない素のシナリオ文書も受け付ける。
- `shikigami run <file>` はバンドルもそのまま実行できる。

| 操作 | MCP | CLI | Studio |
|---|---|---|---|
| 書き出し | `export_scenario`（`bundle` を返す） | `scenario export <id> [-o file] [--no-versions]` | 「版」タブ →「ファイルに書き出す」（ダウンロードフォルダ） |
| 取り込み | `import_scenario` | `scenario import <file> [--on-conflict update\|copy]` | 一覧の「ファイルから読み込む」 |

## やらないこと（今回）

- Git 連携、サーバー（クラウド）での共有。
- 版の削除・改名（版は不変。間違えたら新しい版を作る）。
- 3-way マージ。同時編集はリビジョン競合で止め、読み直してやり直す。
