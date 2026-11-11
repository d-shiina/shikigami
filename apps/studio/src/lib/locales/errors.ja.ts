// Run errors in words for people: what happened, and what to do about it.
// Built from the error's `code` (fixed by contract) and `details`, plus the
// node's own params; the English `message` stays for the AI. Codes without an
// entry fall back to the message. Keep the same codes in errors.en.ts.
import type { ErrorText } from "../errorText";

export const errorsJa: Record<string, ErrorText> = {
  // Running
  STEP_TIMEOUT: {
    what: (c) => `${c.num("timeoutMs") != null ? `${c.seconds("timeoutMs")} 秒` : "設定した時間"}以内に完了しませんでした`,
    todo: "相手の画面や処理が遅いときは、このノードのタイムアウトを延長してください",
  },
  WAIT_TIMEOUT: {
    what: "待機中に条件が満たされませんでした",
    todo: "条件の式と待機時間を確認してください",
  },
  LOOP_LIMIT_EXCEEDED: {
    what: (c) => `繰り返しが上限${c.num("maxIterations") != null ? `（${c.num("maxIterations")} 回）` : ""}を超えました`,
    todo: "繰り返しを終える条件が満たされるか確認してください。回数が実際に多い場合は上限を上げてください",
  },
  CANCELLED: { what: "中止しました", todo: "続行するには再実行してください" },
  RUN_CANCELLED: { what: "実行を中止しました", todo: "続行するには再実行してください" },
  MISSING_INPUT: {
    what: (c) => `入力${c.q(c.str("input"))}が渡されていません`,
    todo: "実行時に値を入力するか、変数に初期値を設定してください",
  },
  INVALID_INPUT: { what: "入力の値の種類が一致しません", todo: "変数の種類（文字・数値・リストなど）に合う値を渡してください" },
  CALL_TARGET_NOT_FOUND: { what: "呼び出すフローが見つかりません", todo: "フローが削除されていないか、呼び出し先の設定を確認してください" },
  CALL_MISSING_INPUT: { what: "呼び出すフローに必要な入力が渡されていません", todo: "呼び出しノードの入力を設定してください" },
  CALL_TOO_DEEP: { what: "フローの呼び出しの階層が深すぎます", todo: "フローが自分自身を繰り返し呼び出していないか確認してください" },
  RESUME_INCOMPATIBLE: { what: "修正後の内容では、一時停止した箇所から再開できません", todo: "最初から再実行してください" },
  UNSUPPORTED_STEP_TYPE: { what: "このノードの種類はこの環境では使えません", todo: "SpellSheet を最新版に更新するか、プラグインがインストールされているか確認してください" },
  VALIDATION_FAILED: { what: "フローに修正が必要な箇所があります", todo: "問題の一覧を確認して修正してください" },
  INVALID_PARAMS: { what: "ノードの設定が不足しているか、形式が正しくありません", todo: "ノードの設定を見直すか、AI に修正を依頼してください" },
  NOT_SUPPORTED: { what: "この部品ではこの操作を実行できません", todo: "別の方法（マウスでクリック・キー入力など）に変更してください" },
  PLATFORM_UNSUPPORTED: { what: "この操作は Windows でのみ実行できます", todo: "Windows の PC で実行してください" },
  INTERNAL: { what: "SpellSheet の内部でエラーが発生しました", todo: "再実行してください。繰り返し発生する場合は不具合として報告してください" },
  RUNTIME_PANIC: { what: "SpellSheet の内部でエラーが発生しました", todo: "再実行してください。繰り返し発生する場合は不具合として報告してください" },
  ADAPTER_UNAVAILABLE: { what: "操作に必要な機能（ブラウザ操作など）が見つかりません", todo: "SpellSheet を再インストールしてください" },
  ADAPTER_CRASHED: { what: "操作を担当するプログラムが異常終了しました", todo: "再実行してください。次の操作で自動的に再起動します" },

  // Workspace rules
  SITE_NOT_ALLOWED: {
    what: (c) => `${c.q(c.str("site"))}はアクセスを許可したサイトに含まれていません`,
    todo: "正しいサイトであれば、設定の「実行の許可」でサイトを追加してください",
  },
  APP_NOT_ALLOWED: {
    what: "このアプリは起動を許可したアプリに含まれていません",
    todo: "正しいアプリであれば、設定の「実行の許可」でアプリを追加してください",
  },
  UNATTENDED_NOT_ALLOWED: { what: "このフローは無人実行が許可されていません", todo: "設定の「実行の許可」を確認してください" },
  NOT_PUBLISHED: { what: "このフローには確定版がありません", todo: "スケジュールなどの無人実行では確定版が実行されます。「確認待ち」または「版」タブで確定してください" },
  DESKTOP_UNAVAILABLE: { what: "画面がロックされているか、サインイン画面のため、マウスとキーボードを使えませんでした", todo: "画面を操作するフローは、PC にサインインし、画面をロックしない状態で実行してください" },
  RUN_INTERRUPTED: { what: "PC の再起動などにより、実行が途中で中断されました", todo: "実行の記録でどこまで進んだかを確認してから、再実行してください" },
  POLICY_DENIED: { what: "設定により、この操作は AI から実行できません", todo: "設定の「実行の許可」を確認してください" },

  // Expressions
  EXPR_SYNTAX: { what: "式の書き方が正しくありません", todo: "かっこや引用符の閉じ忘れがないか確認してください" },
  EXPR_UNDEFINED_VARIABLE: {
    what: (c) => `変数${c.q(c.str("variable"))}がありません`,
    todo: "変数名の入力ミスがないか、値を設定するノードより前で使っていないかを確認してください",
  },
  EXPR_UNKNOWN_FUNCTION: {
    what: (c) => `関数${c.q(c.str("function"))}はありません`,
    todo: "関数名を確認してください（一覧は式の入力欄で表示できます）",
  },
  EXPR_TYPE: { what: "式の値の種類が一致しません（文字と数値など）", todo: "式で使う値の種類を確認してください" },

  // Browser
  ELEMENT_NOT_FOUND: {
    what: (c) => `${c.target ? `${c.target}が` : "対象の部品が"}見つかりません`,
    todo: "画面が切り替わる前に操作していないか、表示の文言が変わっていないかを確認してください。表示が遅い場合は、前に待機のノードを追加してください",
  },
  ELEMENT_AMBIGUOUS: {
    what: (c) => `${c.target ? `${c.target}に` : ""}当てはまる部品が複数あります`,
    todo: "名前を完全一致にするか、何番目かを指定して 1 つに絞り込んでください",
  },
  ELEMENT_NOT_VISIBLE: { what: "部品が画面に表示されていません", todo: "部品が隠れていないか、画面の拡大やスクロールが必要でないかを確認してください" },
  ELEMENT_DISABLED: { what: "部品が操作できない状態です", todo: "必要な入力を先に済ませてから操作してください" },
  ELEMENT_GONE: { what: "操作の途中で部品が画面から消えました", todo: "前に、画面の表示が完了するまで待機するノードを追加してください" },
  OPTION_NOT_FOUND: {
    what: (c) => `選択肢${c.q(c.str("value") || c.p("value"))}がありません`,
    todo: (c) => (c.list("options").length > 0 ? `選択できるのは ${c.list("options").slice(0, 8).join("、")} です` : "選択できる項目を確認してください"),
  },
  BROWSER_NOT_OPEN: { what: "ブラウザが開いていません", todo: "このノードより前に「ブラウザを開く」を追加してください" },
  TAB_NOT_FOUND: {
    what: (c) => `切り替え先のタブ${c.q(c.p("title") || c.p("url"))}が見つかりません`,
    todo: "前のクリックで新しいタブが開くか、タイトルやアドレスの一部が一致しているかを確認してください",
  },
  LAST_TAB: { what: "タブが 1 つしかないため閉じられません", todo: "ブラウザごと閉じる場合は「ブラウザ終了」を使ってください" },
  DOWNLOAD_NOT_STARTED: { what: "クリックしてもダウンロードが開始されませんでした", todo: "ダウンロードのリンクやボタンを対象にしているか確認してください。ファイルが別のタブで開く場合は「タブ切り替え」を使ってください" },
  DOWNLOAD_FAILED: { what: "ダウンロードが途中で中断されました", todo: "再実行してください。繰り返し発生する場合はサイトやネットワークを確認してください" },
  FILE_CHOOSER_NOT_SHOWN: { what: "ファイルの選択画面が表示されませんでした", todo: "ファイルの入力欄か、ファイルの選択画面を開くボタンを対象にしてください" },
  BROWSER_NOT_RUNNING: {
    what: "接続するブラウザが開いていません",
    todo: "「SSO 用の Edge の起動」をオンにするか、Edge を SpellSheet 用のショートカットから起動してから実行してください（手順はドキュメントの「社内のアカウントでサインインするサイト」）",
  },
  CONTEXT_IN_USE: { what: "このブラウザの区分では、すでに別のブラウザを開いています", todo: "「既存ブラウザへの接続」には、別の「ブラウザの区分」の名前を設定してください" },
  DIALOG_NOT_SHOWN: { what: "確認のダイアログ（OK・キャンセル）が表示されませんでした", todo: "このノードでダイアログが表示されない場合は「表示されるダイアログへの応答」の設定を解除してください" },
  NAVIGATION_FAILED: { what: (c) => `ページ${c.q(c.p("url"))}を開けませんでした`, todo: "アドレスとネットワークの接続を確認してください" },
  BROWSER_LAUNCH_FAILED: { what: "ブラウザを起動できませんでした", todo: "Microsoft Edge または Google Chrome がインストールされているか確認してください" },
  BROWSER_ERROR: { what: "ブラウザの操作に失敗しました", todo: "再実行してください。繰り返し発生する場合は詳細を確認してください" },
  HUMAN_REQUIRED: { what: "人の操作が必要ですが、ブラウザを画面なしで実行しています", todo: "「画面なし」をオフにして実行してください" },
  HUMAN_TIMEOUT: { what: "人の操作が時間内に完了しませんでした", todo: "再実行して、時間内に操作を完了してください" },

  // Desktop
  WINDOW_NOT_FOUND: {
    what: (c) => `ウィンドウ${c.q(c.window)}が開いていません`,
    todo: "アプリが起動しているか、タイトルが変わっていないかを確認してください",
  },
  WINDOW_AMBIGUOUS: { what: (c) => `ウィンドウ${c.q(c.window)}が複数開いています`, todo: "タイトルをより詳しく指定するか、何番目かを指定してください" },
  NOT_CLICKABLE: { what: "この部品はクリックの操作を受け付けません", todo: "「マウスクリック」に変更してください" },
  FOCUS_FAILED: { what: "入力欄を選択できませんでした（別の場所に入力しないよう中断しました）", todo: "入力欄そのものを対象にしてください" },
  FOREGROUND_DENIED: { what: "ウィンドウを最前面に表示できませんでした", todo: "画面がロックされていないか、ほかのウィンドウが妨げていないかを確認してください" },
  INPUT_BLOCKED: { what: "Windows がマウスやキーの操作を受け付けませんでした", todo: "画面がロックされていないか確認してください" },
  ELEVATION_REQUIRED: { what: "操作するアプリが管理者として実行されています", todo: "SpellSheet も管理者として起動するか、アプリを通常の方法で起動してください" },
  APP_NOT_RESPONDING: { what: "アプリが応答しません", todo: "アプリが応答なしになっていないか確認して、再実行してください" },
  IMAGE_NOT_FOUND: { what: "画像が画面に見つかりません", todo: "画面の表示（拡大率・テーマ）が変わっていないか確認し、必要であれば画像を撮り直してください" },
  IMAGE_AMBIGUOUS: { what: "画像が画面に複数見つかりました", todo: "何番目かを指定するか、検索する範囲を狭めてください" },
  IMAGE_FILE_NOT_FOUND: { what: (c) => `画像ファイル${c.q(c.path)}がありません`, todo: "画像の保存場所を確認してください" },
  IMAGE_FLAT: { what: "画像が単色のため、画面のどこにでも一致してしまいます", todo: "目印になる模様や文字を含めて撮り直してください" },
  IMAGE_UNREADABLE: { what: "画像ファイルを読めません", todo: "PNG などの画像ファイルか確認してください" },
  TEXT_NOT_FOUND: { what: (c) => `文字${c.q(c.ocrText)}が画面に見つかりません`, todo: "画面に表示されているか、読み取った文字と異なっていないかを確認してください" },
  TEXT_AMBIGUOUS: { what: (c) => `文字${c.q(c.ocrText)}が画面に複数あります`, todo: "何番目かを指定するか、検索する範囲を狭めてください" },
  REGION_OUTSIDE: { what: "検索する範囲がウィンドウの外にはみ出しています", todo: "範囲を指定し直してください" },
  OCR_ENGINE_MISSING: { what: "文字の読み取り（PaddleOCR）が使えません", todo: "SpellSheet を再インストールしてください。高い精度が不要であれば、OCR エンジンを Windows OCR に変更できます" },
  OCR_LANGUAGE_MISSING: { what: "Windows に読み取る言語のデータがありません", todo: "Windows の設定で言語（日本語など）を追加してください" },
  OCR_FAILED: { what: "文字の読み取りに失敗しました", todo: "再実行してください" },
  CAPTURE_FAILED: { what: "画面を撮影できませんでした", todo: "ウィンドウが最小化されていないか確認してください" },
  UIA_ERROR: { what: "アプリの部品を読み取れませんでした", todo: "再実行してください。繰り返し発生する場合は、画像やマウスでの操作に変更してください" },
  UIA_UNAVAILABLE: { what: "アプリの部品を読み取る機能が使えません", todo: "PC を再起動してから再実行してください" },
  READ_ONLY: { what: "この欄は書き換えられません", todo: "書き込める欄を対象にしてください" },
  PASSWORD_FIELD: { what: "パスワードの欄は読み取れません", todo: "値はシークレットに登録して使ってください" },
  LAUNCH_FAILED: { what: (c) => `${c.q(c.p("path") || c.p("program"))}を起動できませんでした`, todo: "アプリの場所を確認してください" },

  // Files
  FILE_NOT_FOUND: { what: (c) => `ファイル${c.q(c.path)}がありません`, todo: "ファイルの場所と名前を確認してください" },
  FOLDER_NOT_FOUND: { what: (c) => `フォルダー${c.q(c.path)}がありません`, todo: "フォルダーの場所を確認してください" },
  FILE_EXISTS: { what: (c) => `${c.q(c.path)}はすでに存在します`, todo: "上書きする場合は、ノードの「上書きする」をオンにしてください" },
  FILE_IN_USE: { what: (c) => `${c.q(c.path)}がほかのアプリで開かれています`, todo: "Excel などで開いている場合は閉じてから、再実行してください" },
  FILE_ACCESS_DENIED: { what: (c) => `${c.q(c.path)}を読み書きする権限がありません`, todo: "フォルダーの権限と、読み取り専用になっていないかを確認してください" },
  FILE_ERROR: { what: (c) => `${c.q(c.path)}を処理できませんでした`, todo: "ファイルの場所と権限を確認してください" },
  FOLDER_NOT_EMPTY: { what: "フォルダーが空ではありません", todo: "中身ごと削除してよいかを確認し、ノードの設定を見直してください" },
  NOT_A_FOLDER: { what: (c) => `${c.q(c.path)}はフォルダーではありません`, todo: "フォルダーの場所を指定してください" },
  SAME_PATH: { what: "元の場所と先の場所が同じです", todo: "別の名前か場所を指定してください" },
  PATH_OUTSIDE_PROJECT: { what: "フローのフォルダーの外は指定できません", todo: "フローのフォルダーの中を指定してください" },
  RELATIVE_PATH: { what: "場所はフルパスで指定してください", todo: "C:\\ から始まる場所を指定してください" },
  WRITE_FAILED: { what: (c) => `${c.q(c.path)}に書き込めませんでした`, todo: "フォルダーが存在するか、ファイルが開かれていないかを確認してください" },
  ENCODING_MISMATCH: { what: "ファイルの文字コードが指定と異なります", todo: "文字コード（UTF-8・Shift_JIS など）の指定を確認してください" },
  UNENCODABLE_TEXT: {
    what: (c) => `Shift_JIS では保存できない文字があります${c.list("characters").length > 0 ? `（${c.list("characters").slice(0, 8).join(" ")}）` : ""}`,
    todo: "UTF-8 で保存するか、その文字を取り除いてください",
  },
  CSV_INVALID: { what: "CSV の形式が正しくありません", todo: "引用符や区切り文字の数が行ごとにそろっているか確認してください" },
  ZIP_INVALID: { what: "ZIP ファイルが壊れているか、ZIP ではありません", todo: "ファイルを確認してください" },
  ZIP_ERROR: { what: "ZIP の作成・展開に失敗しました", todo: "保存場所と空き容量を確認してください" },
  CONFIG_INVALID: { what: "設定ファイルの形式が正しくありません", todo: "設定ファイルの内容を確認してください" },

  // Office and documents
  EXCEL_NOT_INSTALLED: { what: "この PC に Excel がインストールされていません", todo: "Excel をインストールするか、Excel を使わないノードに変更してください" },
  WORKBOOK_UNREADABLE: { what: (c) => `ブック${c.q(c.path)}を読めません`, todo: "ファイルが壊れていないか、パスワードが設定されていないかを確認してください" },
  WORKBOOK_UNWRITABLE: { what: (c) => `ブック${c.q(c.path)}に書き込めません`, todo: "Excel で開いている場合は閉じてください" },
  SHEET_NOT_FOUND: {
    what: (c) => `シート${c.q(c.p("sheet"))}がありません`,
    todo: (c) => (c.list("sheets").length > 0 ? `存在するシートは ${c.list("sheets").slice(0, 8).join("、")} です` : "シート名を確認してください"),
  },
  INVALID_SHEET_NAME: { what: "シート名に使えない文字があります", todo: "シート名を変更してください" },
  INVALID_CELL: { what: "セルの指定が正しくありません", todo: "A1 の形式で指定してください" },
  INVALID_RANGE: { what: "範囲の指定が正しくありません", todo: "A1:D20 の形式で指定してください" },
  RANGE_TOO_LARGE: { what: "書き込む値がシートの範囲を超えます", todo: "書き込みの開始位置か、値の数を見直してください" },
  UNKNOWN_COLUMN: { what: "見出しの行にない列名があります", todo: "見出しの名前と一致させてください" },
  INVALID_DATE: { what: "日付として認識できません", todo: "2026/11/06 の形式で指定してください" },
  MACRO_FAILED: { what: "マクロの実行中にエラーが発生しました", todo: "Excel でマクロを実行して原因を確認してください" },
  MACRO_TIMEOUT: { what: "マクロが時間内に完了しませんでした", todo: "マクロがメッセージを表示して待機していないか確認してください" },
  APP_UNAVAILABLE: { what: "Office のアプリを起動できませんでした", todo: "アプリがインストールされているか確認してください" },
  COM_ERROR: { what: "Office のアプリから予期しない応答がありました", todo: "アプリにダイアログが表示されていないか確認して、再実行してください" },
  DOCUMENT_UNREADABLE: { what: (c) => `文書${c.q(c.path)}を読めません`, todo: "ファイルが壊れていないか確認してください" },
  TEMPLATE_VALUE_MISSING: { what: "テンプレートに差し込む値が不足しています", todo: "テンプレートの差し込み名と、渡す値の名前を一致させてください" },
  UNSUPPORTED_FORMAT: { what: "このファイルの形式は扱えません", todo: "対応している形式（.xlsx・.docx など）か確認してください" },
  OUTLOOK_NOT_INSTALLED: { what: "この PC に Outlook がインストールされていません", todo: "Outlook をインストールしてください" },
  OUTLOOK_NOT_READY: { what: "Outlook の準備ができていません", todo: "Outlook を起動してサインインしてください" },
  OUTLOOK_TIMEOUT: { what: "Outlook が時間内に応答しませんでした", todo: "Outlook にダイアログが表示されていないか確認してください" },
  MESSAGE_NOT_FOUND: { what: "そのメールが見つかりません", todo: "メールが移動または削除されていないか確認してください" },
  INVALID_ADDRESS: { what: "宛先がないか、メールアドレスの形になっていないものがあります", todo: "宛先・CC・BCC のアドレスを 1 件ずつ確認してください" },
  PDF_UNREADABLE: { what: (c) => `PDF${c.q(c.path)}を読めません`, todo: "ファイルが壊れていないか確認してください。画像だけの PDF は、画面の文字の読み取り（OCR）を使ってください" },
  PDF_PASSWORD_REQUIRED: { what: "PDF にパスワードがかかっています", todo: "パスワードをシークレットに登録して渡してください" },
  PDF_WRONG_PASSWORD: { what: "PDF のパスワードが違います", todo: "登録したパスワードを確認してください" },

  // System
  HTTP_CONNECT_FAILED: { what: (c) => `${c.q(c.p("url"))}に接続できませんでした`, todo: "アドレスとネットワーク（プロキシ）の設定を確認してください" },
  HTTP_ERROR: {
    what: (c) => `接続先のサーバーからエラーが返されました${c.num("status") != null ? `（${c.num("status")}）` : ""}`,
    todo: (c) => {
      const s = c.num("status") ?? 0;
      if (s === 401 || s === 403) return "サインインの情報と権限を確認してください";
      if (s === 404) return "アドレスが正しいか確認してください";
      if (s >= 500 || s === 429) return "接続先が混雑しているか停止しています。時間をおいて再実行してください";
      return "送信する内容が接続先の求める形式になっているか確認してください";
    },
  },
  HTTP_UNAVAILABLE: { what: "通信の準備ができませんでした", todo: "再実行してください" },
  PROCESS_FAILED: {
    what: (c) => `プログラムがエラーで終了しました${c.num("exitCode") != null ? `（終了コード ${c.num("exitCode")}）` : ""}`,
    todo: "プログラムの出力（詳細）を確認してください",
  },
  PROCESS_NOT_FOUND: { what: "プログラムが見つかりません", todo: "プログラムの場所と名前を確認してください" },
  PROCESS_START_FAILED: { what: "プログラムを起動できませんでした", todo: "プログラムの場所と権限を確認してください" },
  CLIPBOARD_BUSY: { what: "クリップボードをほかのアプリが使っています", todo: "再実行してください" },
  DIALOG_FAILED: { what: "ダイアログを表示できませんでした", todo: "画面を表示できる状態で実行してください" },

  // Secrets and sign-in
  SECRET_NOT_FOUND: { what: (c) => `シークレット${c.q(c.secret)}が登録されていません`, todo: "シークレットの画面で登録してください" },
  SECRET_FIELD_EMPTY: { what: (c) => `シークレット${c.q(c.secret)}の項目が空です`, todo: "シークレットの画面で値を入力してください" },
  SECRET_SITE_NOT_SET: { what: (c) => `シークレット${c.q(c.secret)}を入力してよいサイトが設定されていません`, todo: "シークレットの画面でサイトを追加してください" },
  SECRET_SITE_MISMATCH: {
    what: (c) => `現在のページはシークレット${c.q(c.secret)}を入力してよいサイトではありません`,
    todo: "ページのアドレスを確認し、正しければシークレットにサイトを追加してください",
  },
  SECRET_APP_NOT_SET: { what: (c) => `シークレット${c.q(c.secret)}を入力してよいアプリが設定されていません`, todo: "シークレットの画面でアプリ（app:〇〇.exe）を追加してください" },
  SECRET_APP_MISMATCH: { what: (c) => `このアプリはシークレット${c.q(c.secret)}を入力してよいアプリではありません`, todo: "アプリを確認し、正しければシークレットに追加してください" },
  SECRET_KEY_MISSING: { what: "シークレットは別の PC または別のユーザーで登録されたため、この環境では読み取れません", todo: "シークレットの画面でリセットしてから、登録し直してください" },
  SECRET_DECRYPT_FAILED: { what: (c) => `シークレット${c.q(c.secret)}を読み取れませんでした`, todo: "シークレットの画面で、このシークレットを登録し直してください" },
  SECRETS_UNAVAILABLE: { what: "この実行ではシークレットが使えません", todo: "Writer または「SpellSheet Runner」から実行してください" },
  SECRET_NOT_ALLOWED: { what: "この項目にはシークレットを使えません", todo: "入力欄に文字を入力するノードで使ってください" },
  SECRET_PLUGIN_NOT_ALLOWED: { what: "このプラグインにはシークレットの使用が許可されていません", todo: "シークレットに plugin:〇〇 を追加してください" },
  OAUTH_SIGN_IN_REQUIRED: { what: "サインインしていません", todo: "このノードより前に「サインイン」を追加してください" },
  OAUTH_DENIED: { what: "サインインが拒否されました", todo: "許可を押したか、アプリの設定（クライアント ID・リダイレクト URL）を確認してください" },
  OAUTH_STATE_MISMATCH: { what: "サインインの応答が今回の要求と一致しません", todo: "再実行してください" },
  OAUTH_TOKEN_FAILED: { what: "サインインの最後の手続きが拒否されました", todo: "クライアント ID・シークレットと、アドレスの設定を確認してください" },
  OAUTH_FAILED: { what: "サインインに失敗しました", todo: "再実行してください" },
};
