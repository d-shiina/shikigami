# フローの共有とバージョン管理（設計メモ）

方針：Git や GitHub を前提にしない。版の管理は Shikigami の中で完結させ、共有は「フォルダ」と「ファイル」で行う。Studio・MCP・CLI に同じ操作を出す。

## 版（バージョン）

- 版は名前とメモ付きの**不変のスナップショット**。`versions/<flow-id>/<number>.json` に置く（ワークスペースの共有部分なので、同じワークスペースを使う全員に見える）。
- 版は番号（1, 2, …）で指す。名前は表示用で、重複してもよい。各版は `uid`（UUIDv7）を持ち、バンドルの取り込みで同じ版が二重にならないようにする。
- 差分はノード ID 単位：`added` / `removed`（部分木の先頭だけ。`stepCount` に子を含む）、`changed`（変わった欄。params はキーごとに `params.url` のように出す）、`moved`（親・ブロックが変わったもの、または同じ並びの中で順序が入れ替わったもの。共通部分の最長部分列に入らないものだけを出すので、前に 1 つ挿入されただけでは移動扱いにならない）。変数は名前単位、フローの名前・説明・タグ・設定は欄単位。
- 復元は「現在の内容を版に合わせる EditOp 列」を 1 回の編集として適用する。Undo で取り消せ、記録（タイムライン）にも残る。すでに同じ内容なら何もしない（冪等）。
- 実行レポートには、実行した内容と一致する最新の版番号（`version`）を記録する。リビジョンは従来どおり。
- **確定版**：版のうち 1 つを「確定済み」にでき、無人実行（`shikigami run <id>`）は確定版だけを動かす。確定できるのは人だけ（Studio のレビュー台の「確認して確定」・「版」タブ、CLI の `version publish`）。記録は `versions/<id>/publish.jsonl`。詳しくは [policy.md](../ja/policy.md)。

| 操作 | MCP | CLI | Studio |
|---|---|---|---|
| 版を保存 | `create_version` | `shikigami version create <id> <name> [--note]` | 「版」タブ |
| 一覧・中身 | `list_versions` / `get_version` | `version list` / `version show` | 「版」タブ |
| 差分 | `diff_versions`（既定：最新の版 → 現在） | `version diff <id> [from] [to]` | 「現在との差分」 |
| 復元 | `restore_version` | `version restore <id> <n>` | 「この版に戻す」（2 回押し） |
| 確定 | なし（人だけ。`get_flow` の `published` で読む） | `version publish <id> [n]` / `version unpublish <id>` | レビュー台「確認して確定」、「版」タブ |

## 共有

### 共有フォルダー（複数人で同じワークスペース）

- OneDrive や社内ファイルサーバーのフォルダをワークスペースにする。`workspace.json` に `{"shared": true}` を置くと共有ワークスペースになる（`shikigami workspace init <dir> --shared`、または Studio の保存先「変更」で「複数人で使う」にチェック）。
- 共有部分：`flows/`・`versions/`・`trash/`・`.lock`。
- PC ごとの部分：`history/`（Undo と変更ジャーナル）、`runs/`（実行記録）、MCP 監査ログ。`%LOCALAPPDATA%\Shikigami\local\<フォルダ名>-<パスのハッシュ>\` に置く。人ごとの Undo が混ざらず、OneDrive の同期競合も起きない。資格情報の保管庫もこちら側に置く。
- 既定のワークスペースは `SHIKIGAMI_HOME` > `%APPDATA%\Shikigami\config.json` の `workspace` > `%APPDATA%\Shikigami\workspace` の順。`shikigami workspace use <dir>` と Studio の「変更」は `config.json` を書くので、Studio・CLI・MCP サーバーが同じ場所を使う。
- 同時編集の保護は従来どおり：書き込みはワークスペースのロックを取り、リビジョンが変わっていれば `REVISION_CONFLICT`。ファイルサーバー（SMB）ではロックが PC をまたいで効く。OneDrive は同期が遅れるため、同じフローを同時に編集しない運用を前提にする（他の PC で変わった文書は Undo スタックを捨てて読み直す既存の仕組みが働く）。

### ファイルで渡す（`.spx`）

フォルダーごと渡すのは現実的でないので、1 ファイルにまとめて渡す。WinActor の `.ums7`、UiPath の `.nupkg` と同じ考え方。

- `<フロー名> v<版>.spx`：ふつうの zip。中身は `manifest.json`・`flow.json`・`versions/<n>.json`・`subflows/<id>.json`・`files/<flow-id>/<パス>`。
- `manifest.json`：`{ "format": "spellsheet.package", "formatVersion": 1, "appVersion", "exportedAt", "exportedBy", "flow": { id, name, description, published, version }, "subflows", "requires", "contents" }`。`contents` は全エントリーの大きさと SHA-256。読むときに照合し、違えば「壊れているか、書き出したあとに変えられています」で断る（エントリー 5000 件・合計 1 GiB まで）。
- `requires`：相手の PC に必要なもの。拡張機能（`requires` と同じ判定）、ログイン情報の名前、開くサイト（オリジン）、操作するアプリ、実行時に聞く入力。式（`{{ }}`）の値はサイトに数えない。
- 渡す内容の既定は**確定版**（確認済みの内容）。確定していなければ今の内容。「今の内容」も選べる。版の履歴は渡す内容の版だけ（CLI で `--all-versions`／`--no-versions`）。
- 入らないもの：ログイン情報の中身、`secret: true` の変数の初期値、実行ログ、`output/`・`work/`、手順書の画面。`input/` は業務の実データが多いので最初は外す（チェックを入れれば入る）。
- 更新として取り込むとき、受け取る PC の `input/` に同じ名前のファイルがあれば上書きせずに残す（その PC の業務データなので）。受け取り画面の「更新として取り込む」にそのファイル名を出す。無いファイルは入る。「別のフローとして追加」はすべて入る。ファイルに無いものは消さない。
- 受け取り：開くとまず中身と「この PC で動かすのに必要なこと」を見せる（拡張機能が入っているか、ログイン情報が登録済みか、サイト・アプリが `policy.json` で許可されているか）。足りなくても取り込める。足りないものはその場で「入れる」「登録する」「許可する」。
- 同じ ID のフローがあれば、この PC の内容からの差分を見せ、「更新として取り込む」か「別のフローとして追加」を選ぶ。更新は 1 回の編集（Undo 可）。版は送り手の番号を保つ（この PC の番号より大きいとき）。
- **取り込んだフローは確定されない。** この PC の人が確認して確定するまで、自動実行・実行画面・Worker では動かない。
- 旧形式の `*.shikigami.json`（`shikigami.flowBundle`）と素のフロー文書も引き続き読める。CLI の `-o x.json`／`-o -` は旧形式で書く。
- インストーラーが `.spx` をアプリに関連付ける。エクスプローラーでダブルクリックするか窓にドロップすると受け取り画面が開く（起動中なら今の窓で）。
- `spellsheet run <file>` は `.spx` もそのまま実行できる（ファイルの内容をそのまま動かす。確定版の決まりはワークスペースのフローに対するもの）。

| 操作 | MCP | CLI | Writer |
|---|---|---|---|
| 渡す | `export_flow`（`path` で `.spx` を書く。なければ `bundle` を返す） | `flow export <id> [-o dir\|file] [--current] [--all-versions\|--no-versions] [--with-input]` | 一覧の右クリック・タイトル横・「版」タブの「渡す…」 |
| 受け取る | `import_flow`（`path` または `bundle`、`check: true` で確かめるだけ） | `flow import <file> [--check] [--on-conflict update\|copy]` | `.spx` を開く・ドロップ、一覧の「ファイルから読み込む」 |

### 配布フォルダー（新しい版を知らせる）

1 ファイルで渡すだけでは「更新が届かない」「誰が何版か分からない」。課の共有フォルダー（ファイルサーバー・OneDrive）を「配布フォルダー」として登録し合えば、サーバーなしで新しい版が届く。WinActor の WinDirector、UiPath の Orchestrator にあたる役目を、フォルダー 1 つで小さく行う。

- 置く側：「渡す」の「配布フォルダーに置く」（CLI `distribution put`）。置けるのは**確定版だけ**。`<フロー名> v<版>.spx` を書き、前の版のファイルは残す。同じ版がもうあれば何もしない。
- 登録：設定 →「保存先」の「配布フォルダー」に名前（経理課）とフォルダーを足す（「参照…」でも選べる）。一覧は PC ごと（ワークスペースの PC 側の `distribution.json`）。共有ワークスペースでも人ごとに選べる。
- 見る側：フロー一覧を開いたときと窓に戻ったとき（1 分に 1 回まで）に各フォルダーの `.spx` の `manifest.json` だけを読み、フローごとに一番大きい版を、この PC と比べる。
  - `new`：この PC にない。`update`：この PC にあって、もっと新しい版がある。`latest`：その版（`uid`）がもうある。`older`：この PC のほうが新しい。
  - `new`・`update` があれば一覧の上に 1 行で知らせ、「見る」で配布フォルダーの一覧を開く。「差分を見て取り込む」「取り込む」は、ファイルを開いたときと同じ受け取り画面（差分・足りないもの・確定しない）を通る。
  - 開けないフォルダー（ネットワークが切れている、権限がない）はそのフォルダーの欄にそう出し、ほかのフォルダーは見られる。
- 取り込んでも確定はされない。今の確定版が動き続け、この PC の人が確認して確定すると切り替わる。
- 将来、管理サーバー（遠隔実行）がフローを配るときも、同じ `.spx` を配り先の 1 つとして扱う。

| 操作 | CLI | Writer |
|---|---|---|
| 登録・外す | `distribution add <名前> <フォルダー>` / `distribution remove <名前>` / `distribution list` | 設定 →「保存先」→「配布フォルダー」 |
| 置く | `distribution put <id> [--folder 名前]` | 「渡す」→「配布フォルダーに置く」 |
| 見る | `distribution check`（JSON） | フロー一覧の知らせ、▾ →「配布フォルダー…」 |

## やらないこと（今回）

- Git 連携、サーバー（クラウド）での共有。配布はフォルダーで行う（上）。
- 版の削除・改名（版は不変。間違えたら新しい版を作る）。
- 3-way マージ。同時編集はリビジョン競合で止め、読み直してやり直す。
