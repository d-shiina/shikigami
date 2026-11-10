# Studio の中から AI と話す（設計メモ）

目的：チャット（Claude Code の端末や claude.ai）に戻らずに、Studio の画面から AI に頼み、差し戻しをそのまま AI に直させる。AI の変更はこれまでどおり「確認待ち」に並び、人が中身を確かめる。

「AI が作り、AI なしで動く」は変えない。AI ペインは Studio の任意の機能で、実行（Runtime・CLI・スケジュール実行）は AI を一切必要としない。

## 仕組み

```
Studio（AI ペイン）
  └─ agent_send ─▶ その人の AI エージェント（既定：Claude Code `claude -p`）を 1 メッセージごとに起動
                     └─ MCP ─▶ spellsheet mcp --workspace <Studio と同じワークスペース>
                                 └─ FlowService（編集は journal に actor=MCP クライアントで記録）
Studio ◀─ agent-event（返事・使ったツール・終了）
Studio ◀─ 既存の flow-changed / review_timeline（編集と証跡は確認待ちへ）
```

- Studio はモデルと直接話さない。API キーも持たない。その PC でログイン済みの Claude Code をそのまま使う（料金・ログインはその人の Claude Code のまま）。
- AI が触れるのは spellsheet の MCP ツールだけ。外の MCP クライアントから使うときと同じ権限・同じマスキングになる。
- 返事・ツール呼び出しは `agent-event` で流し、ペインに「フローを読みました」「手順を追加しました：<summary>」のように日本語で並べる。

### Claude Code の起動引数

```
claude -p --output-format stream-json --verbose
  --strict-mcp-config --mcp-config <agent>/mcp.json   # spellsheet だけ（その人の他の MCP は読まない）
  --tools "" --allowedTools mcp__spellsheet            # 組み込みのファイル・シェル操作は無し、spellsheet は確認なしで許可
  --append-system-prompt-file <agent>/system-prompt.md
  [--resume <session_id>]                             # 会話を続ける
```

- メッセージは stdin で渡す（Windows の `claude.cmd` でも改行や記号を安全に渡せる）。
- `<agent>` は `%LOCALAPPDATA%\SpellSheet\agent`。共有ワークスペースの外に置く。作業フォルダもここ（空）にして、AI が repo やワークスペースのファイルを読まないようにする。
- `stream-json` の `system/init` から `session_id` を取り、ペインが覚えて次のメッセージで `--resume` に渡す（Studio を再起動しても続く。「新しい会話」で捨てる）。
- `CLAUDECODE` 環境変数は外す（Claude Code の端末から Studio を起動しても入れ子扱いで断られないように）。Windows ではコンソール窓を出さない。

### 文脈の渡し方

メッセージの先頭に「Studio で開いているフロー：「名前」 id=…、選んでいる手順 stepId=…」を付ける。AI は `get_flow` で中身を読む。フロー本文を Studio からプロンプトに貼ることはしない（MCP 経由に一本化して、マスキングや証跡の扱いを揃える）。

システムプロンプト（`agent.rs` の `SYSTEM_PROMPT`）で決めていること：MCP ツールだけを使う／編集には `summary` を付ける／差し戻しは `get_flow` の `feedback` を読んで直す／パスワードを尋ねずシークレット名で参照する／日本語で短く返す。

## フローごとの会話（並行して進める）

会話はフローに属する。AI がフロー A を直している間に B を開いて別の頼みごとを送れ、二つは別々の Claude Code として同時に動く。

- ペインは作業面で開いているフローの会話を出す（開くフローを変えるとペインもその会話に切り替わる。前の会話は裏で続く）。
- ペインの見出しが会話の切り替え：押すと会話の一覧（作業中・終わった・止まったの印、最後の一言）と「「A」で新しい会話」「新しいフローを作る」。見出しの右に「ほかに n 件作業中」「終わった会話 n」。サイドバーの Claude Code の行にも、作業中は点滅、見ていない間に終わった会話があれば点。
- フローを持たない会話（新しいフローを作る）は、AI が `create_flow` した時点でそのフローの会話になる（`agent-event` の `created`。ツールの結果から id を読む）。
- 一つのフローで同時に動く会話は一つだけ（同じフローへの編集がぶつからないように）。別の会話が作業中なら「このフローは別の会話で作業中です」と出して送らない。
- 会話ごとの `session_id`・フロー・見出しと、やりとりの中身（会話ごとに直近 60 件）は localStorage（`spellsheet.studio.agentChats`、新しい順に 30 件）に残し、Writer を開き直すと戻る。閉じたときに書きかけだった返事は「Writer を閉じたため、ここで止まりました」で終える。以前の 1 本の会話は「以前の会話」として引き継ぐ。
- バックエンドはもともと 1 メッセージ 1 プロセス・ターン id ごとに止められる作りなので変えていない。`mcp.json` とシステムプロンプトは中身が変わったときだけ書き直す（Windows で別の AI が読んでいる最中に書いて失敗しないように）。

### 作業中に書いたことを、止めずに AI に伝える

AI が作業中でも入力欄は使え、送るボタンは「送信」のまま（Ctrl+Enter も同じ）。送った文は止めずに AI に届く：

1. Writer はターンごとのフォルダー（`<LOCALAPPDATA>/SpellSheet/agent/turns/<ターン id>/inbox/`）に 1 通 1 ファイルで置く（`agent_note`、core の `ChatInbox`）。パスワードが混ざっていれば送らない（`agent_send` と同じ確認）。
2. AI はその間も SpellSheet の MCP ツールを呼び続ける。MCP サーバーは `--inbox <フォルダー>` で起動され、ツールの結果を返すたびにフォルダーの文を取り出し、結果の `messagesFromThePerson`（`note` と `messages`）に付ける。成功でもエラーでも付く。AI への指示（システムプロンプトと note）は「すぐ読んで、ここから反映。やり直さない。前の依頼と食い違えばこちらが優先。どう反映したかを返事で一言」。
3. Writer は 0.7 秒ごとにフォルダーを見て、取り出された文を `heard` イベントで知らせる。吹き出しの下は「AI の次の操作で伝えます」から「作業中に伝えました」に変わり、AI のそれ以降の返事はその吹き出しの下に続く。
4. ターンが終わると `agent_take_notes` で残りを引き取る（読まれなかった文の id が返る）。AI がツールを呼ばずに書き終えたなど読まれなかった文は、続けて同じ会話に 1 通にまとめて送る（先頭に `AFTER_NOTE`）。

急いで止めたいときは「中止」。読まれていない文があれば、止まったあとすぐ同じ会話に送る（先頭に `INTERRUPT_NOTE`、止めたターンは失敗扱いにせず「作業を止めて、送ったメッセージに切り替えました」）。

AI ごとの渡し方：Claude Code と Copilot はターンのフォルダーに MCP 設定を書いて `--inbox` を渡す。Codex はコマンドラインの `-c mcp_servers.spellsheet.args`。Gemini は設定ファイルが共通なので `"${SPELLSHEET_CHAT_INBOX}"` と書き、ターンごとに環境変数を渡す。`command`（独自の AI）には渡さず、終わってから次のメッセージとして送る。

各 CLI の途中差し込み（stream-json 入力の追加メッセージなど）は AI ごとにあったりなかったりで、いつ読まれるかも版で変わるので使わない。MCP のツール結果ならどの AI でも次の操作で必ず読まれる。

## 導入（ペインの中で完結）

Claude Code が見つからないとき、ペインは「AI を使う準備」の枠を出す：使う AI の選択（今は Claude Code だけ。ほかの AI はこの一覧に足す）と「Claude Code を導入する」。押すと `agent_install` が Claude Code 公式のインストーラー（Windows は `irm https://claude.ai/install.ps1 | iex`、ほかは `install.sh`）を窓なしで走らせ、出力の行を `agent-install` イベントでペインに流す。終わると `find_claude()` で見つかるかを確かめ、未サインインならそのまま下のログインに続く。管理者権限は要らない（ユーザーフォルダーに入る）。`config.json` の `agent.kind` が `command` のときは導入もログインもその AI の手順に任せる。

## ログイン（ペインの中で完結）

Claude Code のログインが切れている・未ログインのとき（`Failed to authenticate` / `Not logged in` など）は、エラー文を出す代わりにペインに「<AI 名> のログインが切れています ［ログイン］」を出す。

1. ［ログイン］で `claude auth login` を窓なしで起動する（`agent_login`）。Claude Code が自分でブラウザのサインイン画面を開く。stdout に出る URL は `agent-login` イベントでペインに渡し、「ブラウザが開かないときはここから開く」に使う（開けるのは claude.com / claude.ai などの Anthropic のページだけ）。
2. サインイン画面がコードを表示する流れのときは、ペインの欄に貼り付けると `claude auth login` の stdin に渡す（`agent_login_code`）。
3. 終わったら `claude auth status --json` の `loggedIn` で確かめ、ログインできていれば止まったメッセージを自動でもう一度送る。

トークンは Claude Code が自分の場所に保存する。Studio はアカウント情報もコードも保存しない。

## 差し戻し → そのまま AI が直す

確認待ちの「差し戻す…」に「<AI 名> がすぐ直す」（既定オン、AI が使えるときだけ表示）を追加。

1. これまでどおり `submit_review(rejected)` で理由と手順への指摘を Core に記録する。
2. 続けて AI ペインに「「<理由>」で差し戻しました。get_flow の feedback を読んで、指摘どおりに直してください。」を送る。理由そのものは Core 経由で AI が読む（ペインのメッセージは起こすだけ）ので、チャットから直す場合と同じ情報になる。
3. AI の修正は MCP の編集として journal に入り、確認待ちに「差し戻し後の修正」として戻ってくる（既存の `FeedbackBox` が「修正済み」を表示）。

## シークレット

- AI に渡るのは MCP が返すものだけ（シークレットは名前のみ、画面証跡やツリーは従来どおりマスク済み）。
- ペインから送るメッセージに **登録済みのパスワード・TOTP 鍵（4 文字以上）がそのまま含まれていたら送らない**（`Vault::mask` で検出し `SECRET_IN_MESSAGE`）。うっかり貼り付けても PC の外に出ない。
- ペインの入力欄にも「パスワードは書かず、シークレットの名前で伝えてください」と常に出す。

## AI を選べるようにする（エージェント非依存）

AI ペインは Claude Code 専用ではない。Studio が裏で動かせる AI は 4 つで、設定の「AI エージェント」→「使う AI」（AI を使う準備の枠にも同じ選択）で選ぶ。選んだものは `config.json`（`%APPDATA%\SpellSheet\config.json`）の `agent.kind` に残る。違いは `apps/studio/src-tauri/src/agent/providers.rs` に閉じている。

| `kind` | AI | 起動（1 メッセージ 1 プロセス、メッセージは stdin） | SpellSheet だけに絞る方法 | 会話の続き | 指示の渡し方 |
|---|---|---|---|---|---|
| `claudeCode` | Claude Code | `claude -p --output-format stream-json …` | `--strict-mcp-config`・`--tools ""`・`--allowedTools mcp__spellsheet` | `--resume <session_id>` | `--append-system-prompt-file` |
| `codex` | OpenAI Codex CLI | `codex exec --json --skip-git-repo-check --sandbox read-only …  -` | `-c features.shell_tool=false`・`-c web_search='disabled'`、MCP は `-c mcp_servers.spellsheet.*`（`default_tools_approval_mode='approve'`） | `codex exec … resume <thread_id> -` | 作業フォルダーの `AGENTS.md` |
| `gemini` | Gemini CLI | `gemini --output-format stream-json --allowed-mcp-server-names spellsheet` | 作業フォルダーの `.gemini/settings.json`（`mcpServers.spellsheet.trust: true`、組み込みツールは `tools.exclude`）。`GEMINI_CLI_TRUST_WORKSPACE=true` でこの設定を読ませる | `--resume <session_id>` | 作業フォルダーの `GEMINI.md` |
| `copilot` | GitHub Copilot CLI | `copilot --output-format json --additional-mcp-config @copilot-mcp.json` | `--disable-builtin-mcps`・`--available-tools spellsheet`・`--allow-tool spellsheet` | `--resume <sessionId>` | 作業フォルダーの `AGENTS.md` |
| `cursor` | Cursor CLI（`cursor-agent`） | `cursor-agent -p --output-format stream-json --workspace <作業フォルダー> --trust --approve-mcps --force … <メッセージ>`（メッセージは stdin でなく最後の引数） | 作業フォルダーの `.cursor/mcp.json`（spellsheet だけ）と `.cursor/cli.json`（`Mcp(spellsheet:*)` だけ許し、`Shell`・`Read`・`Write`・`WebFetch` は禁止。禁止は `--force` より強い） | `--resume <session_id>` | 作業フォルダーの `AGENTS.md` |
| `antigravity` | Antigravity CLI（`agy`） | `agy --input-format stream-json --output-format stream-json --disable-slash-commands`（メッセージは stdin に `{"event":"user","message":{"content":…}}` の 1 行。返事の `result` が来るまで stdin を開けておく。閉じると会話が終わるため） | 作業フォルダーの `.agents/mcp_config.json`（spellsheet だけ）。許可はフォルダーごとの設定が無いので、利用者の `~/.gemini/antigravity-cli/settings.json` の `permissions.allow` に `mcp(spellsheet/*)` だけを足す（ほかは触らない。読めない内容のときは書かない）。ヘッドレスでは許可の無いツールは断られるので、コマンドやファイルの書き込みは利用者が許可していない限り動かない | `--conversation <conversation_id>` | 作業フォルダーの `AGENTS.md` と `GEMINI.md` |
| `command` | そのほか | `config.json` の `command`・`args` | AI 任せ | 無し | 無し |

- 指示（`SYSTEM_PROMPT`）は引数でなくファイルで渡す。Windows で npm から入れた AI は `.cmd` なので、引数に改行を入れられない。Codex の `-c` の値は TOML のリテラル文字列（`'C:\…'`）にして、パスの `\` をそのまま渡す。
- Cursor の Windows 版は `%LOCALAPPDATA%\cursor-agent\` に入り、起動用の `agent.cmd`（中で PowerShell）は引数の `"`・`!`・改行を崩す。そのため `versions\<いちばん新しい版>\node.exe` で同じフォルダーの `index.js` を直接起動する（Cursor の案内どおり、`CURSOR_INVOKED_AS=agent` を付ける）。メッセージを引数で渡せるのはこのため。
- 各 AI の出力（JSON の行）は `ClaudeStream` / `CodexStream` / `GeminiStream` / `CopilotStream` / `CursorStream` / `AntigravityStream` が同じ `agent-event`（返事・ツール・書いている途中・失敗・作ったフロー・終わり）に読み替える。ツール名の前置き（`mcp__spellsheet__`・`mcp_spellsheet_`・`spellsheet-`）は外す。
- 会話は AI ごと。会話に AI の種類（`agent`）を残し、別の AI に切り替えたあとは前の会話の続きにせず新しく始める（元の AI に戻せば続く）。
- 導入（`agent_install`）：Claude Code は公式インストーラー、ほかは `npm install --global <パッケージ>`（`@openai/codex`・`@google/gemini-cli`・`@github/copilot`）。Cursor は公式インストーラー（Windows は `irm 'https://cursor.com/install?win32=true' | iex`）、Antigravity も公式インストーラー（Windows は `irm https://antigravity.google/cli/install.ps1 | iex`、`%LOCALAPPDATA%\agy\bin` に入る）。npm が無い Windows では先に `winget install OpenJS.NodeJS.LTS`。入れ終わるとその AI に切り替える。進み具合：スクリプトは各段階の始めに `::spellsheet-step::node|package|installer` を出し、終わると Rust が `check` を出す（`agent-install` の `step`）。ペインは段階を言葉で示し、経過時間と、標準出力・標準エラーの最後の数行（`\r` でも区切る、npm は `--loglevel http` でダウンロードを 1 行ずつ出す）を見せる。npm は展開中に数分何も出さない（ウイルス対策ソフトが全ファイルを読む。Gemini CLI で約 3 分半）ので、1 分黙ったら「止まっていない」旨を添える。失敗したら `npm error` の行を優先して理由に出す。Windows PowerShell の出力は UTF-8 にそろえる。起動したあとの Studio の PATH には新しく入ったものが載らないので、探す場所（`%APPDATA%\npm`・`~/.local/bin`）と子プロセスの PATH（`Program Files\nodejs` など）を足す。
- サインイン（`agent_login`）：Claude Code は `claude auth login`、Codex は `codex login`（確認は `codex login status`）、Copilot は `copilot login --web-flow`、Cursor は `cursor-agent login`（cursor.com を開く）。ペインが開いてよいページは AI ごと（claude.com・auth.openai.com・github.com/login など）。Antigravity はサインインの命令が無いので、`agy` の画面を別ウィンドウで開き、そこから開くブラウザーで Google にサインインしてもらう（入れた直後もこの画面を開く）。Gemini CLI は 2026-06 から個人の Google アカウントのサインインを受けないので、Google AI Studio の API キーで動かす。キーは AI チャットか設定 → AI の欄に貼り、Windows 資格情報マネージャー（`SpellSheet` / `ai gemini`）に保存して、起動するときだけ環境変数 `GEMINI_API_KEY` で渡す。作業フォルダーの `.gemini/settings.json` に `security.auth.selectedType: gemini-api-key` を書き、利用者の設定に古いサインインが残っていてもキーを使わせる。キーが無い・断られたときは、サインインの代わりにキーの欄を出す。
- 確かめ方：4 つとも CLI を入れ、偽のモデルサーバー（OpenAI 互換・Responses API・Gemini API）を立てて、Studio と同じ引数で「SpellSheet のツールを呼ぶ → 返事 → 次のメッセージで会話が続く」まで動くことを確認した（SpellSheet の MCP サーバーは本物）。テストにある各 AI の出力の行はこのとき出たもの。実際のアカウントでの確認と Windows 実機は未。Cursor と Antigravity は CLI を入れられなかったので、出力の行は公式の説明（Antigravity は https://antigravity.google/docs/cli/headless/ ）の形から作った（実機で確かめて直す）。
- `command` 種別：メッセージを stdin に書き、stdout の各行を返事として表示する。`{mcpConfig}`（SpellSheet 用 MCP 設定ファイルのパス）と `{workspace}` を引数に埋め込める。
- 使えないとき（AI が見つからない、`spellsheet` CLI が無い）は、ペインに理由を表示して入力を止める。
- Cursor は裏で 1 回ずつ動かす CLI の作りが違うので、ペインからは動かさない。Cursor からは MCP サーバーとして登録して使う（docs/mcp.md）。設定の「MCP サーバーの登録」は、選んでいる AI の登録コマンドを出す。

## 今回やったこと（最初の一歩）

- Tauri コマンド `agent_info` / `agent_send` / `agent_stop`、イベント `agent-event`（`apps/studio/src-tauri/src/agent/mod.rs`）。
- ヘッダーの AI 名ボタン（例「Claude Code」、Ctrl+J）と右側の AI ペイン（`AgentPane.tsx`、会話は `agent.ts`）。開いているフローと選んだ手順を文脈として付ける。
- 差し戻しフォームの「<AI 名> がすぐ直す」。

## 作っている途中を見せる

「新規作成」や AI ペインから「〜するフローを作って」と頼むと、以前は出来上がるまで画面に何も出なかった。AI が全部のノードを 1 回の `create_flow` で書き、Studio はそのフローを開かず、書いている間（大きな編集は 1 分ほど）はペインに「作業中」としか出なかったため。いまは次のようにする。

- AI は少しずつ組む：Studio から頼むとき、開いているフローが空なら「no steps yet」を添え、AI はそこに組む。新しく作るときは名前と変数だけで作り、ノードは流れの順に数個ずつ `update_flow` で足す（`agent.rs` のシステムプロンプトと MCP の instructions）。
- Studio は AI が作ったフローを開く：AI ペインの作業中に新しいフローが現れ、何も開いていないか開いているのが空のフローなら、それを開く（`lib/followAi.ts`）。設定やシークレットにいるとき、中身のあるフローを開いているときは動かさない。
- フロー図は AI が足したノードへ視点を移す（外からの変更だけを見て、最後に足されたノードを `reveal` に渡す。`App.tsx` の `followChange`）。人が自分で足したノードや、別のフローを開いたときは動かさない。
- 書いている最中も見せる：`--include-partial-messages` でツール呼び出しの書き始めを受け取り、ペインに「『ノードを追加』を書いています n秒」と出す。ステータスバーの左（AI の動き）にも「Claude Code が作業中・フローを変更」を出すので、ペインを閉じていても分かる。
- 作業中は編集のたびの「外部での変更を反映しました」を出さない（ペインとステータスバーが言っている）。

## まだやらないこと

- 返事の逐次表示（文字単位のストリーミング）。今はメッセージ単位。
- AI の作業中の「確認待ち」への自動切り替え。
- 承認ダイアログ（AI に実行やブラウザ操作を許すかを毎回聞く）。今は spellsheet の全ツールを許可しており、どの編集も確認待ちを通る前提。
- Agent SDK への置き換え。`claude -p` で足りなくなったら検討する。

## 文言

「AIと話す」「〜してもらう」のような説明調のラベルは使わない。ボタンやペインの見出しは使っている AI の名前（「Claude Code」）だけにし、ツールの表示も「手順を追加」「試し実行」のように短い名詞にする。

## AI の案をカードで選ぶ

AI が、使う人にしか決められないこと（在庫切れの注文をどう扱うか、どちらの作り方にするか）で 2〜4 個の案を出すときは、文章で並べずにカードで聞く。

- MCP ツール `ask_user_to_choose`（質問・案 2〜4 個（名前と一行の説明）・おすすめの番号・おすすめの理由）。ツールはすぐ `shown` を返し、AI はそこでターンを終える。答えは次のメッセージとして届く。人を待つ間に AI のプロセスを止めておく必要はない（1 メッセージ 1 プロセスのまま）。
- このツールは Writer の AI チャットにだけ出す（`spellsheet mcp --writer-chat`）。外の Claude Code などでは見せる場所がないので一覧に出さない。`config.json` の `agent.kind: command` も文字しか出せないので付けない。
- Writer はツールの呼び出しの引数からカードを描く（`agent-event` の `choice`）。4 つの AI はどれもストリームにツールの引数を出すので、同じ形で動く（Codex・Copilot は引数が JSON の文字列のこともあるので読み直す）。サーバーが断る形（案が 1 個や 5 個、同じ名前、空の質問）はカードにしない。
- カード：質問、番号付きの案（押せる）、おすすめの印と理由、「ほかの考えがあれば、下の欄に書いて送ってください。」。押すとその案の名前を送る。書いて送っても答えになる。答えたカードは「質問：答え」の 1 行に縮む。押せるのは最後の返事のカードだけで、AI が作業中は押せない。
- 比べた案：ツールの中でクリックを待つ（AI ごとのツールの時間切れ・割り込みの扱いが重い）、返事の番号付きリストをボタンにする（ただの手順説明もボタンになる）、MCP の elicitation（各 AI CLI の自動実行では対応がまちまち）。
