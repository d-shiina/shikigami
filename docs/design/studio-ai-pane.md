# Studio の中から AI と話す（設計メモ）

目的：チャット（Claude Code の端末や claude.ai）に戻らずに、Studio の画面から AI に頼み、差し戻しをそのまま AI に直させる。AI の変更はこれまでどおり「確認待ち」に並び、人が確かめてから本番で使う。

「AI が作り、AI なしで動く」は変えない。AI ペインは Studio の任意の機能で、実行（Runtime・CLI・スケジュール実行）は AI を一切必要としない。

## 仕組み

```
Studio（AI ペイン）
  └─ agent_send ─▶ その人の AI エージェント（既定：Claude Code `claude -p`）を 1 メッセージごとに起動
                     └─ MCP ─▶ shikigami mcp --workspace <Studio と同じワークスペース>
                                 └─ ScenarioService（編集は journal に actor=MCP クライアントで記録）
Studio ◀─ agent-event（返事・使ったツール・終了）
Studio ◀─ 既存の scenario-changed / review_timeline（編集と証跡は確認待ちへ）
```

- Studio はモデルと直接話さない。API キーも持たない。その PC でログイン済みの Claude Code をそのまま使う（料金・ログインはその人の Claude Code のまま）。
- AI が触れるのは shikigami の MCP ツールだけ。外の MCP クライアントから使うときと同じ権限・同じマスキングになる。
- 返事・ツール呼び出しは `agent-event` で流し、ペインに「シナリオを読みました」「手順を追加しました：<summary>」のように日本語で並べる。

### Claude Code の起動引数

```
claude -p --output-format stream-json --verbose
  --strict-mcp-config --mcp-config <agent>/mcp.json   # shikigami だけ（その人の他の MCP は読まない）
  --tools "" --allowedTools mcp__shikigami            # 組み込みのファイル・シェル操作は無し、shikigami は確認なしで許可
  --append-system-prompt-file <agent>/system-prompt.md
  [--resume <session_id>]                             # 会話を続ける
```

- メッセージは stdin で渡す（Windows の `claude.cmd` でも改行や記号を安全に渡せる）。
- `<agent>` は `%LOCALAPPDATA%\Shikigami\agent`。共有ワークスペースの外に置く。作業フォルダもここ（空）にして、AI が repo やワークスペースのファイルを読まないようにする。
- `stream-json` の `system/init` から `session_id` を取り、ペインが覚えて次のメッセージで `--resume` に渡す（Studio を再起動しても続く。「新しい会話」で捨てる）。
- `CLAUDECODE` 環境変数は外す（Claude Code の端末から Studio を起動しても入れ子扱いで断られないように）。Windows ではコンソール窓を出さない。

### 文脈の渡し方

メッセージの先頭に「Studio で開いているシナリオ：「名前」 id=…、選んでいる手順 stepId=…」を付ける。AI は `get_scenario` で中身を読む。シナリオ本文を Studio からプロンプトに貼ることはしない（MCP 経由に一本化して、マスキングや証跡の扱いを揃える）。

システムプロンプト（`agent.rs` の `SYSTEM_PROMPT`）で決めていること：MCP ツールだけを使う／編集には `summary` を付ける／差し戻しは `get_scenario` の `feedback` を読んで直す／パスワードを尋ねずシークレット名で参照する／日本語で短く返す。

## ログイン（ペインの中で完結）

Claude Code のログインが切れている・未ログインのとき（`Failed to authenticate` / `Not logged in` など）は、エラー文を出す代わりにペインに「<AI 名> のログインが切れています ［ログイン］」を出す。

1. ［ログイン］で `claude auth login` を窓なしで起動する（`agent_login`）。Claude Code が自分でブラウザのサインイン画面を開く。stdout に出る URL は `agent-login` イベントでペインに渡し、「ブラウザが開かないときはここから開く」に使う（開けるのは claude.com / claude.ai などの Anthropic のページだけ）。
2. サインイン画面がコードを表示する流れのときは、ペインの欄に貼り付けると `claude auth login` の stdin に渡す（`agent_login_code`）。
3. 終わったら `claude auth status --json` の `loggedIn` で確かめ、ログインできていれば止まったメッセージを自動でもう一度送る。

トークンは Claude Code が自分の場所に保存する。Studio はアカウント情報もコードも保存しない。

## 差し戻し → そのまま AI が直す

確認待ちの「差し戻す…」に「<AI 名> がすぐ直す」（既定オン、AI が使えるときだけ表示）を追加。

1. これまでどおり `submit_review(rejected)` で理由と手順への指摘を Core に記録する。
2. 続けて AI ペインに「「<理由>」で差し戻しました。get_scenario の feedback を読んで、指摘どおりに直してください。」を送る。理由そのものは Core 経由で AI が読む（ペインのメッセージは起こすだけ）ので、チャットから直す場合と同じ情報になる。
3. AI の修正は MCP の編集として journal に入り、確認待ちに「差し戻し後の修正」として戻ってくる（既存の `FeedbackBox` が「修正済み」を表示）。

## シークレット

- AI に渡るのは MCP が返すものだけ（シークレットは名前のみ、画面証跡やツリーは従来どおりマスク済み）。
- ペインから送るメッセージに **登録済みのパスワード・TOTP 鍵（4 文字以上）がそのまま含まれていたら送らない**（`Vault::mask` で検出し `SECRET_IN_MESSAGE`）。うっかり貼り付けても PC の外に出ない。
- ペインの入力欄にも「パスワードは書かず、シークレットの名前で伝えてください」と常に出す。

## AI を選べるようにする（エージェント非依存）

MCP は Claude Code 以外（GitHub Copilot、Gemini CLI、Codex など）でも使えるので、使う AI は `config.json`（`%APPDATA%\Shikigami\config.json`）の `agent` で差し替えられる：

```json
{ "agent": { "kind": "claudeCode" } }                        // 既定。claude を PATH と ~/.local/bin から探す
{ "agent": { "kind": "claudeCode", "command": "C:\\tools\\claude.exe" } }
{ "agent": { "kind": "command", "name": "Gemini CLI", "command": "gemini",
             "args": ["-p", "--mcp-config", "{mcpConfig}"] } }
```

- `command` 種別：メッセージを stdin に書き、stdout の各行を返事として表示する。`{mcpConfig}`（Shikigami 用 MCP 設定ファイルのパス）と `{workspace}` を引数に埋め込める。MCP を自前で登録済みの AI ならそのままでもよい。会話の継続・ツール表示は無し（必要になったら種別を足す）。
- 使えないとき（AI が見つからない、`shikigami` CLI が無い）は、ペインに理由を表示して入力を止める。

## 今回やったこと（最初の一歩）

- Tauri コマンド `agent_info` / `agent_send` / `agent_stop`、イベント `agent-event`（`apps/studio/src-tauri/src/agent.rs`）。
- ヘッダーの AI 名ボタン（例「Claude Code」、Ctrl+J）と右側の AI ペイン（`AgentPane.tsx`、会話は `agent.ts`）。開いているシナリオと選んだ手順を文脈として付ける。
- 差し戻しフォームの「<AI 名> がすぐ直す」。

## まだやらないこと

- 返事の逐次表示（文字単位のストリーミング）。今はメッセージ単位。
- 複数の会話・会話履歴の保存（Studio を閉じるとペインの表示は消える。会話そのものは `--resume` で続く）。
- AI の作業中の「確認待ち」への自動切り替えやフロー図上での強調（既存の監視で編集は反映される）。
- 承認ダイアログ（AI に実行やブラウザ操作を許すかを毎回聞く）。今は shikigami の全ツールを許可しており、どの編集も確認待ちを通る前提。
- Agent SDK への置き換え。`claude -p` で足りなくなったら検討する。

## 文言

「AIと話す」「〜してもらう」のような説明調のラベルは使わない。ボタンやペインの見出しは使っている AI の名前（「Claude Code」）だけにし、ツールの表示も「手順を追加」「試し実行」のように短い名詞にする。
