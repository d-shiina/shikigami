# Studio の言葉づかい

Studio・実行画面の文言（`apps/studio/src/lib/locales/`）を書くときの決まりです。業務アプリとして、押すと何が起きるか、いま何の状態かが一読で分かる言葉にします。

## 決まり

- 話し言葉・くだけた言い方を使わない。「止まりました」「やめる」「頼む」「足す」「飛ばす」「終える」「直してもらう」「〜しましょう」は、下の言葉に置き換える。
- 実在しない区別を言葉にしない。「本番」は使わない（区別は「作業中」と「公開版」）。
- ノードは「ノード」。「手順」「ステップ」と呼ばない（ビュー名「手順書」とデバッグの「ステップ実行」は例外）。
- 「シナリオ」は使わない。「フロー」「サブフロー」。
- 説明の一文は「〜します」「〜できます」で終える。ボタン・見出しは名詞か「〜を依頼」のような短い形。
- 日本語を直したら en.ts も同じ意味に揃える。

## 決まった言い方

| 場面 | 使う言葉 | 使わない言葉 |
|---|---|---|
| 実行の結果 | 完了しました・エラーで中断しました・中止しました | 終わりました・止まりました |
| 実行の状態 | 実行中・一時停止中・成功・失敗・中止 | キャンセル・停止（状態として） |
| 実行をやめる操作 | 中止 | 終了・終える・止める |
| 一時停止の画面 | 一時停止時の画面 | 止まった画面・止まったときの画面 |
| もう一度動かす | 再実行 | もう一度 |
| 実行しないで進む | スキップ | 飛ばす |
| ダイアログを閉じる | キャンセル | やめる |
| AI に何かしてもらう | 〜を依頼・修正を依頼 | 頼む・直してもらう・整えてもらう |
| ノードを足す | 追加 | 足す |
| AI の承認依頼に答える | 許可する・拒否 | 断る |
| 許可の設定の選択肢 | 承認なしで許可・承認が必要・禁止 | そのまま・承認が要る・させない |
| ノード 1 つだけ動かす | ノードの単体実行 | ノードを試す・1 ノードの試し |
| 確認パネルの節 | 変更内容・外への影響・試し実行の結果・確認事項 | 変わること・試しの結果・確かめてほしいこと |
| 確認事項への答え | 問題なし・問題あり | よい・違う |

## 前後の一覧（2026-11-06 の見直し）



| 場所 | 前 | 後 |
|---|---|---|
| 許可の設定 | "許可と承認" | "実行の許可" |
| 許可の設定 | "このワークスペースのフローが開いてよいサイト・起動してよいアプリと、AI が人の承認なしにしてよいことを決めます。Studio・CLI・AI のどこから動かしても同じ規則で調べます。" | "このワークスペースのフローがアクセスできるサイト・起動できるアプリと、AI の操作に人の承認が必要かどうかを設定します。Studio・CLI・AI のどこから実行しても同じ設定が適用されます。" |
| 許可の設定 | "開いてよいサイト（1 行に 1 つ。空ならどこでも）" | "アクセスを許可するサイト（1 行に 1 つ。空欄の場合はすべて許可）" |
| 許可の設定 | "起動してよいアプリ（1 行に 1 つ。空ならどれでも）" | "起動を許可するアプリ（1 行に 1 つ。空欄の場合はすべて許可）" |
| 許可の設定 | どのフォルダでもよければ notepad.exe。 | フォルダーを問わない場合は notepad.exe。 |
| 許可の設定 | "AI がしてよいこと" | "AI の操作の承認" |
| 許可の設定 | "フローを実行" | "フローの実行" |
| 許可の設定 | "ノードを試す" | "ノードの単体実行" |
| 許可の設定 | "フローを削除" | "フローの削除" |
| 許可の設定 | { allow: "そのまま", ask: "承認が要る", deny: "させない" } | { allow: "承認なしで許可", ask: "承認が必要", deny: "禁止" } |
| 許可の設定 | "AI の実行" | "AI による実行" |
| 許可の設定 | "全体の設定どおり" | "ワークスペースの設定に従う" |
| 許可の設定 | "無人実行（shikigami run・スケジュール）を許す" | "無人実行（shikigami run・スケジュール）を許可する" |
| 許可の設定 | "許可と承認の設定を保存しました" | "実行の許可を保存しました" |
| 許可の設定 | { safe: "影響なし", interactive: "画面を操作", dangerous: "危険な操作" } | { safe: "影響なし", interactive: "画面操作", dangerous: "外部に影響する操作" } |
| AI の承認依頼 | "ノードを 1 つ試す" | "ノードの単体実行" |
| AI の承認依頼 | "フローを実行" | "フローの実行" |
| AI の承認依頼 | "フローを削除" | "フローの削除" |
| AI の承認依頼 | "断る" | "拒否" |
| AI の承認依頼 | "あとで" | "後で" |
| AI の承認依頼 | "許可すると、この内容を 1 回だけ実行できます。内容が少しでも違えば実行されません。" | "許可すると、この内容に限り 1 回だけ実行できます。内容が異なる場合は実行されません。" |
| AI の承認依頼 | "許可しました。AI が同じ操作をもう一度呼ぶと実行されます。" | "許可しました。AI が同じ操作を再度要求すると実行されます。" |
| AI の承認依頼 | "断りました。AI にはそう伝わります。" | "拒否しました。AI に通知されます。" |
| AI の承認依頼 | "AI がブラウザの画面で指してほしいと言っています" | "AI がブラウザ上の部品の指定を求めています" |
| AI の承認依頼 | `ブラウザのウィンドウに切り替えて、その部品をクリックしてください。クリックはページには伝わらないので、ボタンが押されることはありません。${candidates > 1 ? `迷っている候補には 1〜${candidates} の番号が付いています。` : ""}わからなければ、ブラウザの「わからない」かここで断れます。` | `ブラウザのウィンドウに切り替えて、対象の部品をクリックしてください。クリックはページに送られないため、ボタンが押されることはありません。${candidates > 1 ? `候補には 1〜${candidates} の番号が付いています。` : ""}判断できない場合は、ブラウザの「わからない」またはここで拒否できます。` |
| AI の承認依頼 | "指さずに断る" | "指定せずに拒否" |
| 共通 | "やめる" | "キャンセル" |
| 共通 | "あとで" | "後で" |
| シークレット | `止まったページ：${site}（正しいサイトなら「入力してよいサイト」に追加）` | `中断したページ：${site}（正しいサイトであれば「入力してよいサイト」に追加してください）` |
| 実行の状態 | "キャンセル" | "中止" |
| 実行の状態 | "実行：停止" | "実行：中止" |
| 履歴・版 | "記録" | "変更履歴" |
| 履歴・版 | "記録と版を開く" | "変更履歴と版を開く" |
| 公開 | `承認して v${v} を公開しました。無人実行はこの版を動かします。` | `確認して v${v} を公開しました。無人実行ではこの版が実行されます。` |
| 公開 | "無人実行（shikigami run・スケジュール）は公開した版だけを動かします。作業中の内容は Studio と AI の試し実行でだけ動きます。" | "無人実行（shikigami run・スケジュール）では公開版だけが実行されます。作業中の内容を実行できるのは Studio と AI の試し実行だけです。" |
| 公開 | "公開後に変更があります。本番に使うには公開し直してください。" | "公開後に変更があります。無人実行に反映するには、もう一度公開してください。" |
| 公開 | "公開をやめる" | "公開を停止" |
| 公開 | "やめる（もう一度押す）" | "停止する（もう一度押して確定）" |
| 公開 | "公開をやめました。無人実行はこのフローを動かしません。" | "公開を停止しました。無人実行ではこのフローは実行されません。" |
| 履歴・版 | "版の名前（例: v1、本番リリース）" | "版の名前（例: v1、4 月改定対応）" |
| 履歴・版 | "まだ版はありません。動作を確認できたら名前を付けて保存しましょう。" | "まだ版はありません。動作を確認したら、名前を付けて保存してください。" |
| 履歴・版 | "戻す（もう一度押す）" | "戻す（もう一度押して確定）" |
| エラー画面 | "フローはCoreに保存されているため失われていません。「再表示」で画面を戻せます。" | "フローは保存済みのため失われていません。「再表示」で画面を復元できます。" |
| AI ペイン | "前回の会話の続きから話せます" | "前回の会話の続きです" |
| AI ペイン | `終わった会話 ${n}` | `完了した会話 ${n}` |
| AI ペイン | "送ると今の作業を止めて割り込みます" | "送信すると現在の作業を中断して割り込みます" |
| AI ペイン | "止まりしだい送ります" | "作業の中断後に送信します" |
| AI ペイン | "ここで止めて、次のメッセージに切り替えました" | "作業を中断し、次のメッセージに切り替えました" |
| AI ペイン | "受け取りました。起動しています" | "起動中" |
| AI ペイン | "考えています" | "処理中" |
| AI ペイン | `「${tool}」を書いています` | `「${tool}」を作成中` |
| AI ペイン | "失敗しました" | "エラーが発生しました" |
| AI ペイン | "コードが表示されたら貼り付け" | "表示されたコードを貼り付けてください" |
| AI ペイン | "ノードを試行" | "ノードを単体実行" |
| デバッグ実行 | "止まっている場所が変更で無くなったため、ここからは再開できません。止めて最初から実行してください。" | "一時停止中のノードが変更で削除されたため、ここからは再開できません。実行を中止して最初から実行してください。" |
| デバッグ実行 | "飛ばして続行" | "スキップして続行" |
| デバッグ実行 | "終了" | "中止" |
| 上部バー | "AI ペインで頼んだことの進み具合" | "AI ペインで依頼した作業の進捗" |
| 上部バー | "AIがログイン情報の登録を頼んでいます" | "AI がログイン情報の登録を求めています" |
| 確認パネル | "1ノードの試し" | "ノードの単体実行" |
| 確認パネル | "止まった画面" | "一時停止時の画面" |
| 確認パネル | "実行が止まったときの画面" | "一時停止時の画面" |
| 確認パネル | `「${step}」に指摘を書く` | `「${step}」への指摘を追加` |
| 確認パネル | "フロー図でノードを選ぶと、そのノードに指摘を書けます" | "フロー図でノードを選択すると、そのノードへの指摘を追加できます" |
| 確認パネル | `${agent} がすぐ直す` | `${agent} に今すぐ修正を依頼` |
| 確認パネル | "AIの変更は作業中の内容に入っています。中身を確かめて判断します" | "AI の変更は作業中の内容に反映済みです。内容を確認してください" |
| 確認パネル | "理由を書いてAIに直してもらいます（変更はそのまま残ります）" | "理由を添えて AI に修正を依頼します（変更は残したままです）" |
| 確認パネル | "変わること" | "変更内容" |
| 確認パネル | `${total}件中 ${seen}件を見た` | `${total} 件中 ${seen} 件を確認済み` |
| 確認パネル | "読み方は同じです。項目の値が変わりました。" | "説明文は同じです。項目の値が変わりました。" |
| 確認パネル | { added: "新しく", changed: "変わった", removed: "なくなる", same: "変わらず" } as Record<string, string> | { added: "追加", changed: "変更", removed: "削除", same: "変更なし" } as Record<string, string> |
| 確認パネル | `変わらないもの ${n} 件` | `変更なし ${n} 件` |
| 確認パネル | "試しの結果" | "試し実行の結果" |
| 確認パネル | `${ran}/${total} 個を通った` | `${total} 個中 ${ran} 個を実行済み` |
| 確認パネル | `変えたノードのうち ${n} 個は試しで通っていません（条件で飛ばされたなど）。` | `変えたノードのうち ${n} 個は試し実行で実行されていません（条件分岐で実行されなかった場合など）。` |
| 確認パネル | "このあと変更があり、今の内容はまだ試していません。" | "試し実行の後に変更があり、現在の内容はまだ試していません。" |
| 確認パネル | "確かめてほしいこと" | "確認事項" |
| 確認パネル | "よい" | "問題なし" |
| 確認パネル | "違う…" | "問題あり…" |
| 確認パネル | `「${q}」→ 違う：` | `「${q}」→ 問題あり：` |
| 確認パネル | "理由をAIに送ります。直るまで変更は残ります。" | "理由を AI に送り、修正を依頼します。修正されるまで変更は残ります。" |
| 確認パネル | "AIが変える前の内容に戻します。" | "AI が変更する前の内容に戻します。" |
| 確認パネル | "確認したことを記録し、この内容を公開版にします。無人実行（スケジュールなど）は次からこの内容で動きます。" | "確認済みとして記録し、この内容を公開版にします。次回以降の無人実行（スケジュールなど）はこの内容で実行されます。" |
| 確認パネル | "この内容を確認して公開します。無人実行（shikigami run・スケジュール）はこの版を動かします" | "この内容を確認済みにして公開します。無人実行（shikigami run・スケジュール）ではこの版が実行されます" |
| 確認パネル | `無人実行で動くのは v${v}「${name}」です` | `無人実行で実行されるのは v${v}「${name}」です` |
| 確認パネル | "まだ公開していません。公開するまで無人実行では動きません" | "まだ公開していません。公開するまで無人実行では実行されません" |
| フロー図 | "ここで止まっています" | "ここでエラーが発生しました" |
| フロー図 | "同時に実行" | "並列実行" |
| フロー図 | "ここで一時停止する（ブレークポイント, F9）" | "ブレークポイントを置く (F9)" |
| プロジェクト | "実行のたびに空に" | "実行のたびに空にします" |
| プロジェクト | "実行しても残す設定" | "実行後も中身を残す設定です" |
| プロジェクト | "設定ファイルを作る" | "設定ファイルを作成" |
| プロジェクト | "保存済み・変えた値は次の実行から使われます" | "保存済み。変更した値は次回の実行から使われます" |
| 部品 | "作る" | "作成" |
| 記録 | "Studio をしまい、デスクトップアプリでの操作（クリック・入力・キー）を記録します。画面上の帯をクリックすると止まります" | "Studio を最小化し、デスクトップアプリでの操作（クリック・入力・キー）を記録します。画面上部の帯をクリックすると終了します" |
| 記録 | "● 記録中（{n} 件）　ここをクリックで止める" | "● 記録中（{n} 件）　ここをクリックして終了" |
| 記録 | "クリック・入力欄の文字・キーを書き留めています（ブラウザはまだ記録しません）" | "クリック・入力欄の文字・キー操作を記録しています（ブラウザの操作は記録の対象外です）" |
| 記録 | "ドラッグは記録できないので飛ばします" | "ドラッグは記録できないため省略します" |
| 記録 | "この場所の部品を読み取れなかったので飛ばします" | "この位置の部品を読み取れなかったため省略します" |
| 記録 | "このまま足すか、AI に整えてもらうかを選んでください。" | "記録した操作をそのままノードとして追加するか、AI に整理を依頼するかを選択してください。" |
| 記録 | "そのままノードにする" | "ノードとして追加" |
| 記録 | "AI に整えてもらう" | "AI に整理を依頼" |
| 記録 | "やめる" | "破棄" |
| 記録 | `${n} 個のノードを足しました` | `${n} 個のノードを追加しました` |
| 記録 | `${agent} に整えてもらうよう頼みました` | `${agent} に整理を依頼しました` |
| 記録 | `足す場所：「${label}」のあと` | `追加する場所：「${label}」の後` |
| 記録 | "足す場所：フローの最後" | "追加する場所：フローの最後" |
| 画面から選ぶ | "Studio をしまい、選びたい部品を画面でクリックします（Esc か右クリックでやめる）" | "Studio を最小化し、選択する部品を画面上でクリックします（Esc または右クリックでキャンセル）" |
| 画面から選ぶ | "選びたい部品をクリック（Esc か右クリックでやめる）" | "選択する部品をクリック（Esc または右クリックでキャンセル）" |
| 画面から選ぶ | "Studio をしまい、実行中のブラウザで選びたい部品をクリックします（Esc でやめる）" | "Studio を最小化し、実行中のブラウザで選択する部品をクリックします（Esc でキャンセル）" |
| 画面から選ぶ | "ブラウザの部品は、フローを実行しているあいだ（止めているときも）に、そのブラウザで選べます" | "ブラウザの部品は、フローの実行中（一時停止中を含む）に、そのブラウザで選択できます" |
| 画面から選ぶ | "選ぶのをやめました" | "選択をキャンセルしました" |
| 画面から選ぶ | `うまくいきませんでした：${message}` | `選択できませんでした：${message}` |
| 部品の種類 | "進み具合" | "プログレスバー" |
| プロパティ | "秘密の値：secret 変数から {{ 名前 }} で渡す" | "機密の値：secret 変数から {{ 名前 }} で渡す" |
| 一時停止 | "止まったときの画面（クリックで拡大）" | "一時停止時の画面（クリックで拡大）" |
| 一時停止 | `${agent} に修正を頼みました。直した内容を確認して承認すると、ここから再開できます。` | `${agent} に修正を依頼しました。修正内容を確認すると、ここから再開できます。` |
| 一時停止 | `${agent} がほかの依頼に取り組んでいます` | `${agent} は別の作業を実行中です` |
| 一時停止 | `エラーと止まった画面・変数を添えて ${agent} に修正を頼みます` | `エラー・一時停止時の画面・変数を添えて ${agent} に修正を依頼します` |
| 一時停止 | "エラーと止まった画面・変数を添えた依頼文をコピーします（AI のパネルが使えないため）" | "エラー・一時停止時の画面・変数を添えた依頼文をコピーします（AI ペインが使えないため）" |
| 一時停止 | `${agent}に直してもらう` | `${agent} に修正を依頼` |
| 一時停止 | "このノードをもう一度実行して続けます（変数はそのまま）" | "このノードを再実行して続行します（変数は現在の値のまま）" |
| 一時停止 | "直した内容で再開" | "修正した内容で再開" |
| 一時停止 | "もう一度" | "再実行" |
| 一時停止 | "このノードを飛ばして次へ進みます" | "このノードをスキップして次へ進みます" |
| 一時停止 | "飛ばして次へ" | "スキップして次へ" |
| 一時停止 | "失敗として実行を終えます" | "実行を中止します（失敗として記録します）" |
| 一時停止 | "終える" | "中止" |
| 一時停止 | "このノードを（中も含めて）実行して次で止まる" | "このノードを（中も含めて）実行し、次のノードで一時停止します" |
| 一時停止 | "ブロックの中の最初のノードで止まる" | "ブロックの中の最初のノードで一時停止します" |
| 一時停止 | "今いるブロックを最後まで実行して止まる" | "現在のブロックを最後まで実行して一時停止します" |
| 一時停止 | "このノードを実行せずに次へ" | "このノードを実行せずに次へ進みます" |
| 一時停止 | "飛ばす" | "スキップ" |
| 一時停止 | "もう一度実行" | "再実行" |
| 一時停止 | `AIの修正が届きました（未確認 ${n} 件）。確認して承認すると、止まったところから再開できます。` | `AI の修正が届きました（未確認 ${n} 件）。確認すると、一時停止した箇所から再開できます。` |
| 一時停止 | "止まったときの画面を取得しています…" | "一時停止時の画面を取得しています…" |
| 見本 | "業務を 1 本、AI に頼んで作るところから毎月動かすまで。完成形を開いて中身を見ることもできます" | "AI に依頼してフローを作成し、定期的に実行するまでの流れを学べます。完成版を開いて中身を確認することもできます" |
| 見本 | "完成形を開く" | "完成版を開く" |
| 一覧 | "作る" | "作成" |
| 一覧 | "＋追加 から作るか、AIに頼んでください" | "「＋追加」から作成するか、AI に作成を依頼してください" |
| 一覧 | "最近さわったもの" | "最近使ったもの" |
| ツールバー | "追う" | "追従" |
| ツールバー | "動いているノードを画面で追っています（画面を動かすと止まります）" | "実行中のノードに表示を追従しています（画面を動かすと解除されます）" |
| ツールバー | "動いているノードを画面で追う" | "実行中のノードに表示を追従" |
| ツールバー | "最初のノードの前で止めて、1ノードずつ実行する (F10)" | "最初のノードの前で一時停止し、1 ノードずつ実行します (F10)" |
| ツールバー | "次のノードの前で一時停止する" | "次のノードの前で一時停止します" |
| AI への依頼文 | "AI への依頼文をコピーしました。Claude Code などの AI に貼り付けてください。直した内容を確認したら、ここから再開できます。" | "AI への依頼文をコピーしました。Claude Code などの AI に貼り付けてください。修正内容を確認すると、ここから再開できます。" |
| AI への依頼文 | `止まったときの画面（${title}）` | `一時停止時の画面（${title}）` |
| デバッグ実行 | "もう一度" | "再実行" |
| エラーの説明 | { what: "直した内容では、止まった場所から続けられません", todo: "最初から実行し直してください" } | { what: "修正後の内容では、一時停止した箇所から再開できません", todo: "最初から実行し直してください" } |
| エラーの説明 | { what: "操作に使う部品が止まりました", todo: "もう一度実行してください。次の操作で立ち上がり直します" } | { what: "操作を担当するプログラムが異常終了しました", todo: "もう一度実行してください。次の操作で自動的に再起動します" } |
| エラーの説明 | "マクロがメッセージを出して止まっていないか確かめてください" | "マクロがメッセージを表示して待機していないか確認してください" |
| エラーの説明 | "相手が混んでいるか止まっています。時間をおいて実行してください" | "接続先が混雑しているか停止しています。時間をおいて実行してください" |

</details>



| 場所 | 前 | 後 |
|---|---|---|
| 許可の設定 | "Permissions and approval" | "Run permissions" |
| 許可の設定 | "Decide which sites this workspace's flows may open, which apps they may start, and what the AI may do without a person's approval. The same rules apply whether a run starts from Studio, the CLI or the AI." | "Set which sites this workspace's flows can access, which apps they can start, and which AI operations need a person's approval. The same settings apply whether a run starts from Studio, the CLI or the AI." |
| 許可の設定 | "Sites they may open (one per line; empty = anywhere)" | "Allowed sites (one per line; leave empty to allow all)" |
| 許可の設定 | "Apps they may start (one per line; empty = any)" | "Allowed apps (one per line; leave empty to allow all)" |
| 許可の設定 | "What the AI may do" | "Approval for AI operations" |
| 許可の設定 | "Run flows" | "Run a flow" |
| 許可の設定 | "Try nodes" | "Run a single node" |
| 許可の設定 | "Delete flows" | "Delete a flow" |
| 許可の設定 | { allow: "Allow", ask: "Ask first", deny: "Never" } | { allow: "Allow without approval", ask: "Require approval", deny: "Block" } |
| 許可の設定 | "AI runs" | "Runs by the AI" |
| 許可の設定 | "As set for all" | "Use the workspace setting" |
| 許可の設定 | "Saved the permission and approval settings" | "Saved the run permissions" |
| 許可の設定 | { safe: "No effect", interactive: "Operates screens", dangerous: "Dangerous" } | { safe: "No effect", interactive: "Screen operations", dangerous: "External effects" } |
| AI の承認依頼 | "Try one node" | "Run a single node" |
| AI の承認依頼 | "Approved. It runs when the AI calls the same operation again." | "Approved. It runs when the AI requests the same operation again." |
| AI の承認依頼 | "Denied. The AI will be told." | "Denied. The AI has been notified." |
| AI の承認依頼 | "The AI asks you to point at something in the browser" | "The AI asks you to select an element in the browser" |
| シークレット | `Stopped on: ${site} (add it to the allowed sites if it is the right one)` | `Interrupted on: ${site} (if this is the right site, add it to the allowed sites)` |
| 実行の状態 | "Run: stopped" | "Run: cancelled" |
| 公開 | "Changed since it was published. Publish again to use it in production." | "Changed since it was published. Publish again to use it in unattended runs." |
| 公開 | "Unpublish (click again)" | "Unpublish (click again to confirm)" |
| 履歴・版 | "Version name (e.g. v1, production)" | "Version name (e.g. v1, April revision)" |
| 履歴・版 | "Open the record and versions" | "Open history and versions" |
| エラー画面 | "Your flows are saved in Core and nothing is lost. Retry brings the screen back." | "Your flows are saved and nothing is lost. Retry restores the screen." |
| AI ペイン | "Test node" | "Run a single node" |
| AI ペイン | "You can pick up where this chat left off" | "Continued from the previous chat" |
| AI ペイン | "Sending stops the current work and cuts in" | "Sending interrupts the current work" |
| AI ペイン | "Sends as soon as it stops" | "Sends once the current work is interrupted" |
| AI ペイン | "Stopped here to take the next message" | "Interrupted to handle the next message" |
| AI ペイン | "Got it. Starting" | "Starting" |
| AI ペイン | "Thinking" | "Working" |
| AI ペイン | `Writing: ${tool}` | `Preparing: ${tool}` |
| AI ペイン | "Failed" | "An error occurred" |
| デバッグ実行 | "End" | "Cancel run" |
| 確認パネル | "Stopped" | "Cancelled" |
| 確認パネル | "node test" | "single-node run" |
| 確認パネル | `${agent} fixes it now` | `Ask ${agent} to fix it now` |
| 確認パネル | "Reads the same; its values changed." | "The description is unchanged; its values changed." |
| 確認パネル | { added: "New", changed: "Changed", removed: "Removed", same: "Same" } as Record<string, string> | { added: "Added", changed: "Changed", removed: "Removed", same: "Unchanged" } as Record<string, string> |
| 確認パネル | "Test result" | "Test run result" |
| 確認パネル | `${ran} of ${total} ran` | `${ran} of ${total} run` |
| 確認パネル | "Please confirm" | "Items to check" |
| 確認パネル | "OK" | "No issue" |
| 確認パネル | "No…" | "Issue…" |
| 確認パネル | `"${q}" → No: ` | `"${q}" → Issue: ` |
| フロー図 | "Stopped here" | "An error occurred here" |
| プロジェクト | "Last run stopped" | "Last run cancelled" |
| 記録 | "Hide Studio and record what you do in desktop apps (clicks, typing, keys). Click the banner at the top of the screen to stop" | "Minimize Studio and record what you do in desktop apps (clicks, typing, keys). Click the banner at the top of the screen to finish" |
| 記録 | "● Recording ({n})  Click here to stop" | "● Recording ({n})  Click here to finish" |
| 記録 | "Clicks, text typed into fields and keys are written down (browsers are not recorded yet)" | "Recording clicks, text typed into fields and keys (browser actions are not recorded)" |
| 記録 | "Drags cannot be recorded: skipped" | "Drags cannot be recorded and are omitted" |
| 記録 | "The part here could not be read: skipped" | "The element here could not be read and is omitted" |
| 記録 | "Add them as they are, or have the AI tidy them up." | "Add the recorded actions as nodes as they are, or ask the AI to clean them up." |
| 記録 | "Have the AI tidy up" | "Ask the AI to clean up" |
| 記録 | "Cancel" | "Discard" |
| 画面から選ぶ | "Browser parts are picked in the browser of a run: run the flow (or pause it at a node) first" | "Browser elements can be selected in the browser of a running flow (including while paused)" |
| 一時停止 | `${agent} is working on another request` | `${agent} is busy with another task` |
| 一時停止 | `Fix with ${agent}` | `Ask ${agent} to fix` |
| 一時停止 | "End the run as failed" | "Cancel the run (recorded as failed)" |
| 一時停止 | "End" | "Cancel run" |
| 見本 | "One piece of office work, from asking the AI to running it every month. You can also open the finished flow to look inside" | "Learn how to have the AI build a flow and run it on a schedule. You can also open the finished flow to see how it works" |
| 一覧 | "Create one with ＋ New, or ask the AI" | "Create one with “＋ New”, or ask the AI to create one" |
| ツールバー | "Following the running node (moving the view stops it)" | "Following the running node (moving the view turns this off)" |

</details>

