// Run errors in words for people: what happened, and what to do about it.
// Built from the error's `code` (fixed by contract) and `details`, plus the
// node's own params; the English `message` stays for the AI. Codes without an
// entry fall back to the message. Keep the same codes in errors.en.ts.
import type { ErrorText } from "../errorText";

export const errorsJa: Record<string, ErrorText> = {
  // Running
  STEP_TIMEOUT: {
    what: (c) => `${c.num("timeoutMs") != null ? `${c.seconds("timeoutMs")} 秒` : "決めた時間"}たっても終わりませんでした`,
    todo: "相手の画面や処理が遅いときは、このノードの「時間切れ」を延ばしてください",
  },
  WAIT_TIMEOUT: {
    what: "待っている間に条件がそろいませんでした",
    todo: "条件の式が正しいか、待つ時間が足りているかを確かめてください",
  },
  LOOP_LIMIT_EXCEEDED: {
    what: (c) => `繰り返しが上限${c.num("maxIterations") != null ? `（${c.num("maxIterations")} 回）` : ""}を超えました`,
    todo: "終わる条件が満たされるか確かめてください。回数が本当に多いときは上限を上げます",
  },
  CANCELLED: { what: "止めました", todo: "続けるには、もう一度実行してください" },
  RUN_CANCELLED: { what: "実行を止めました", todo: "続けるには、もう一度実行してください" },
  MISSING_INPUT: {
    what: (c) => `入力${c.q(c.str("input"))}が渡されていません`,
    todo: "実行するときに値を入れるか、変数に初期値を決めてください",
  },
  INVALID_INPUT: { what: "入力の値の種類が合いません", todo: "変数の種類（文字・数・リストなど）に合う値を渡してください" },
  CALL_TARGET_NOT_FOUND: { what: "呼び出すフローが見つかりません", todo: "フローが消されていないか、呼び出し先の設定を確かめてください" },
  CALL_MISSING_INPUT: { what: "呼び出すフローに必要な入力が渡されていません", todo: "呼び出しノードの入力を埋めてください" },
  CALL_TOO_DEEP: { what: "フローの呼び出しが深くなりすぎました", todo: "フローが自分自身を呼び続けていないか確かめてください" },
  RESUME_INCOMPATIBLE: { what: "直した内容では、止まった場所から続けられません", todo: "最初から実行し直してください" },
  UNSUPPORTED_STEP_TYPE: { what: "このノードの種類はこの環境では動きません", todo: "Shikigami を最新にするか、プラグインが入っているか確かめてください" },
  VALIDATION_FAILED: { what: "フローに直すべきところがあります", todo: "問題の一覧を見て直してください" },
  INVALID_PARAMS: { what: "ノードの設定が足りないか、形が合いません", todo: "ノードの設定を見直すか、AI に直してもらってください" },
  NOT_SUPPORTED: { what: "この操作はこの部品ではできません", todo: "別の方法（マウスでクリック・キー入力など）に変えてください" },
  PLATFORM_UNSUPPORTED: { what: "この操作は Windows でしか動きません", todo: "Windows の PC で実行してください" },
  INTERNAL: { what: "Shikigami の中でエラーが起きました", todo: "もう一度実行してください。続くときは不具合として報告してください" },
  RUNTIME_PANIC: { what: "Shikigami の中でエラーが起きました", todo: "もう一度実行してください。続くときは不具合として報告してください" },
  ADAPTER_UNAVAILABLE: { what: "操作に使う部品（ブラウザ操作など）が見つかりません", todo: "Shikigami を入れ直してください" },
  ADAPTER_CRASHED: { what: "操作に使う部品が止まりました", todo: "もう一度実行してください。次の操作で立ち上がり直します" },

  // Workspace rules
  SITE_NOT_ALLOWED: {
    what: (c) => `${c.q(c.str("site"))}は許可したサイトに入っていません`,
    todo: "正しい行き先なら、設定の「許可と承認」でサイトを追加してください",
  },
  APP_NOT_ALLOWED: {
    what: "このアプリは許可したアプリに入っていません",
    todo: "正しいアプリなら、設定の「許可と承認」でアプリを追加してください",
  },
  UNATTENDED_NOT_ALLOWED: { what: "このフローは無人で動かさない決まりです", todo: "設定の「許可と承認」を確かめてください" },
  POLICY_DENIED: { what: "ワークスペースの決まりで、この操作は AI からはできません", todo: "設定の「許可と承認」を確かめてください" },

  // Expressions
  EXPR_SYNTAX: { what: "式の書き方が正しくありません", todo: "かっこや引用符の閉じ忘れがないか確かめてください" },
  EXPR_UNDEFINED_VARIABLE: {
    what: (c) => `変数${c.q(c.str("variable"))}がまだありません`,
    todo: "名前の打ち間違いか、値を入れるノードより前で使っていないかを確かめてください",
  },
  EXPR_UNKNOWN_FUNCTION: {
    what: (c) => `関数${c.q(c.str("function"))}はありません`,
    todo: "関数の名前を確かめてください（一覧は式の入力欄で出せます）",
  },
  EXPR_TYPE: { what: "式の値の種類が合いません（文字と数など）", todo: "式の中で使う値の種類を確かめてください" },

  // Browser
  ELEMENT_NOT_FOUND: {
    what: (c) => `${c.target ? `${c.target}が` : "対象の部品が"}見つかりません`,
    todo: "画面が切り替わる前に操作していないか、文言が変わっていないかを確かめてください。表示が遅いときは待つノードを前に入れます",
  },
  ELEMENT_AMBIGUOUS: {
    what: (c) => `${c.target ? `${c.target}に` : ""}当てはまる部品が複数あります`,
    todo: "名前を完全に一致させるか、何番目かを指定して 1 つに絞ってください",
  },
  ELEMENT_NOT_VISIBLE: { what: "部品が画面に表示されていません", todo: "部品が隠れていないか、画面を広げる・スクロールする必要がないか確かめてください" },
  ELEMENT_DISABLED: { what: "部品が押せない状態です", todo: "先に必要な入力を済ませてから操作してください" },
  ELEMENT_GONE: { what: "操作の途中で部品が消えました", todo: "画面が落ち着くまで待つノードを前に入れてください" },
  OPTION_NOT_FOUND: {
    what: (c) => `選択肢${c.q(c.str("value") || c.p("value"))}がありません`,
    todo: (c) => (c.list("options").length > 0 ? `選べるのは ${c.list("options").slice(0, 8).join("、")} です` : "選べる選択肢を確かめてください"),
  },
  BROWSER_NOT_OPEN: { what: "ブラウザが開いていません", todo: "このノードより前に「ブラウザを開く」を置いてください" },
  NAVIGATION_FAILED: { what: (c) => `ページ${c.q(c.p("url"))}を開けませんでした`, todo: "アドレスとネットワークの接続を確かめてください" },
  BROWSER_LAUNCH_FAILED: { what: "ブラウザを起動できませんでした", todo: "Microsoft Edge か Google Chrome が入っているか確かめてください" },
  BROWSER_ERROR: { what: "ブラウザの操作に失敗しました", todo: "もう一度実行してください。続くときは英語の原文を確かめてください" },
  HUMAN_REQUIRED: { what: "人の操作が必要ですが、画面のないブラウザで動いています", todo: "画面を出して実行してください" },
  HUMAN_TIMEOUT: { what: "人の操作が時間内に終わりませんでした", todo: "もう一度実行して、時間内に操作を済ませてください" },

  // Desktop
  WINDOW_NOT_FOUND: {
    what: (c) => `ウィンドウ${c.q(c.window)}が開いていません`,
    todo: "アプリが起動しているか、タイトルが変わっていないかを確かめてください",
  },
  WINDOW_AMBIGUOUS: { what: (c) => `ウィンドウ${c.q(c.window)}が複数開いています`, todo: "タイトルを詳しくするか、何番目かを指定してください" },
  NOT_CLICKABLE: { what: "この部品はクリックの操作を受け付けません", todo: "「マウスでクリック」に変えてください" },
  FOCUS_FAILED: { what: "入力欄を選べませんでした（別の場所に打たないよう止めました）", todo: "入力欄そのものを対象にしてください" },
  FOREGROUND_DENIED: { what: "ウィンドウを前に出せませんでした", todo: "画面がロックされていないか、ほかのウィンドウが邪魔していないか確かめてください" },
  INPUT_BLOCKED: { what: "Windows がマウスやキーの操作を受け付けませんでした", todo: "画面がロックされていないか確かめてください" },
  ELEVATION_REQUIRED: { what: "相手のアプリが管理者として動いています", todo: "Shikigami も管理者として起動するか、アプリを普通に起動してください" },
  APP_NOT_RESPONDING: { what: "アプリが応答しません", todo: "アプリが固まっていないか確かめて、もう一度実行してください" },
  IMAGE_NOT_FOUND: { what: "画像が画面に見つかりません", todo: "画面の表示（拡大率・テーマ）が変わっていないか確かめ、必要なら画像を撮り直してください" },
  IMAGE_AMBIGUOUS: { what: "画像が画面に複数見つかりました", todo: "何番目かを指定するか、探す範囲を狭めてください" },
  IMAGE_FILE_NOT_FOUND: { what: (c) => `画像ファイル${c.q(c.path)}がありません`, todo: "画像の置き場所を確かめてください" },
  IMAGE_FLAT: { what: "画像が一色だけで、どこにでも当てはまってしまいます", todo: "目印になる模様や文字を含めて撮り直してください" },
  IMAGE_UNREADABLE: { what: "画像ファイルを読めません", todo: "PNG などの画像か確かめてください" },
  TEXT_NOT_FOUND: { what: (c) => `文字${c.q(c.ocrText)}が画面に見つかりません`, todo: "画面に出ているか、読み取った文字と少し違わないかを確かめてください" },
  TEXT_AMBIGUOUS: { what: (c) => `文字${c.q(c.ocrText)}が画面に複数あります`, todo: "何番目かを指定するか、探す範囲を狭めてください" },
  REGION_OUTSIDE: { what: "探す範囲がウィンドウの外にはみ出しています", todo: "範囲を指定し直してください" },
  OCR_ENGINE_MISSING: { what: "文字の読み取り（PaddleOCR）が使えません", todo: "Shikigami を入れ直してください。高精度でなくてよければ Windows の読み取りに変えられます" },
  OCR_LANGUAGE_MISSING: { what: "Windows に読み取る言語のデータがありません", todo: "Windows の設定で言語（日本語など）を追加してください" },
  OCR_FAILED: { what: "文字の読み取りに失敗しました", todo: "もう一度実行してください" },
  CAPTURE_FAILED: { what: "画面を撮れませんでした", todo: "ウィンドウが最小化されていないか確かめてください" },
  UIA_ERROR: { what: "アプリの部品を読めませんでした", todo: "もう一度実行してください。続くときは画像やマウスの操作に変えてください" },
  UIA_UNAVAILABLE: { what: "アプリの部品を読む仕組みが使えません", todo: "PC を再起動してからもう一度実行してください" },
  READ_ONLY: { what: "この欄は書き換えられません", todo: "書き込める欄を対象にしてください" },
  PASSWORD_FIELD: { what: "パスワードの欄は読めません", todo: "値はシークレットに登録して使ってください" },
  LAUNCH_FAILED: { what: (c) => `${c.q(c.p("path") || c.p("program"))}を起動できませんでした`, todo: "アプリの場所を確かめてください" },

  // Files
  FILE_NOT_FOUND: { what: (c) => `ファイル${c.q(c.path)}がありません`, todo: "ファイルの場所と名前を確かめてください" },
  FOLDER_NOT_FOUND: { what: (c) => `フォルダー${c.q(c.path)}がありません`, todo: "フォルダーの場所を確かめてください" },
  FILE_EXISTS: { what: (c) => `${c.q(c.path)}はもうあります`, todo: "上書きしてよければ、ノードの「上書き」をオンにしてください" },
  FILE_IN_USE: { what: (c) => `${c.q(c.path)}がほかのアプリで開かれています`, todo: "Excel などで開いていたら閉じてから、もう一度実行してください" },
  FILE_ACCESS_DENIED: { what: (c) => `${c.q(c.path)}を読み書きする権限がありません`, todo: "フォルダーの権限や、読み取り専用になっていないかを確かめてください" },
  FILE_ERROR: { what: (c) => `${c.q(c.path)}を扱えませんでした`, todo: "ファイルの場所と権限を確かめてください" },
  FOLDER_NOT_EMPTY: { what: "フォルダーが空ではありません", todo: "中身ごと消してよいか確かめて、ノードの設定を見直してください" },
  NOT_A_FOLDER: { what: (c) => `${c.q(c.path)}はフォルダーではありません`, todo: "フォルダーの場所を指定してください" },
  SAME_PATH: { what: "元と先が同じ場所です", todo: "別の名前か場所を指定してください" },
  PATH_OUTSIDE_PROJECT: { what: "フローのフォルダーの外は指定できません", todo: "フローのフォルダーの中を指定してください" },
  RELATIVE_PATH: { what: "場所はフルパスで書いてください", todo: "C:\\ から始まる場所にしてください" },
  WRITE_FAILED: { what: (c) => `${c.q(c.path)}に書き込めませんでした`, todo: "フォルダーがあるか、ファイルが開かれていないかを確かめてください" },
  ENCODING_MISMATCH: { what: "ファイルの文字コードが指定と違います", todo: "文字コード（UTF-8・Shift_JIS など）の指定を確かめてください" },
  UNENCODABLE_TEXT: {
    what: (c) => `Shift_JIS では書けない文字があります${c.list("characters").length > 0 ? `（${c.list("characters").slice(0, 8).join(" ")}）` : ""}`,
    todo: "UTF-8 で保存するか、その文字を取り除いてください",
  },
  CSV_INVALID: { what: "CSV の形が崩れています", todo: "引用符や区切りの数が行ごとにそろっているか確かめてください" },
  ZIP_INVALID: { what: "ZIP ファイルが壊れているか、ZIP ではありません", todo: "ファイルを確かめてください" },
  ZIP_ERROR: { what: "ZIP の作成・展開に失敗しました", todo: "場所と空き容量を確かめてください" },
  CONFIG_INVALID: { what: "設定ファイルの形が崩れています", todo: "設定ファイルの書き方を確かめてください" },

  // Office and documents
  EXCEL_NOT_INSTALLED: { what: "この PC に Excel が入っていません", todo: "Excel を入れるか、Excel なしで読めるノードに変えてください" },
  WORKBOOK_UNREADABLE: { what: (c) => `ブック${c.q(c.path)}を読めません`, todo: "壊れていないか、パスワード付きでないかを確かめてください" },
  WORKBOOK_UNWRITABLE: { what: (c) => `ブック${c.q(c.path)}に書き込めません`, todo: "Excel で開いていたら閉じてください" },
  SHEET_NOT_FOUND: {
    what: (c) => `シート${c.q(c.p("sheet"))}がありません`,
    todo: (c) => (c.list("sheets").length > 0 ? `あるのは ${c.list("sheets").slice(0, 8).join("、")} です` : "シート名を確かめてください"),
  },
  INVALID_SHEET_NAME: { what: "シート名に使えない文字があります", todo: "シート名を変えてください" },
  INVALID_CELL: { what: "セルの指定が正しくありません", todo: "A1 のように書いてください" },
  INVALID_RANGE: { what: "範囲の指定が正しくありません", todo: "A1:D20 のように書いてください" },
  RANGE_TOO_LARGE: { what: "書く値がシートの端を超えます", todo: "書き始めの位置か、値の数を見直してください" },
  UNKNOWN_COLUMN: { what: "見出しの行にない列名があります", todo: "見出しの名前と合わせてください" },
  INVALID_DATE: { what: "日付として読めません", todo: "2026/11/06 のような形にしてください" },
  MACRO_FAILED: { what: "マクロの実行中にエラーが起きました", todo: "Excel でマクロを動かして原因を確かめてください" },
  MACRO_TIMEOUT: { what: "マクロが時間内に終わりませんでした", todo: "マクロがメッセージを出して止まっていないか確かめてください" },
  APP_UNAVAILABLE: { what: "Office のアプリを起動できませんでした", todo: "アプリが入っているか確かめてください" },
  COM_ERROR: { what: "Office のアプリが思いがけない答えを返しました", todo: "アプリにダイアログが出ていないか確かめて、もう一度実行してください" },
  DOCUMENT_UNREADABLE: { what: (c) => `文書${c.q(c.path)}を読めません`, todo: "壊れていないか確かめてください" },
  TEMPLATE_VALUE_MISSING: { what: "ひな形に入れる値が足りません", todo: "ひな形の差し込み名と、渡す値の名前を合わせてください" },
  UNSUPPORTED_FORMAT: { what: "このファイルの形式は扱えません", todo: "対応する形式（.xlsx・.docx など）か確かめてください" },
  OUTLOOK_NOT_INSTALLED: { what: "この PC に Outlook が入っていません", todo: "Outlook を入れてください" },
  OUTLOOK_NOT_READY: { what: "Outlook の準備ができていません", todo: "Outlook を起動してサインインを済ませてください" },
  OUTLOOK_TIMEOUT: { what: "Outlook が時間内に応答しませんでした", todo: "Outlook にダイアログが出ていないか確かめてください" },
  MESSAGE_NOT_FOUND: { what: "そのメールが見つかりません", todo: "メールが移動・削除されていないか確かめてください" },
  INVALID_ADDRESS: { what: "宛先のメールアドレスがありません", todo: "宛先を確かめてください" },
  PDF_UNREADABLE: { what: (c) => `PDF${c.q(c.path)}を読めません`, todo: "壊れていないか確かめてください。画像だけの PDF は文字の読み取りを使います" },
  PDF_PASSWORD_REQUIRED: { what: "PDF にパスワードがかかっています", todo: "パスワードをシークレットに登録して渡してください" },
  PDF_WRONG_PASSWORD: { what: "PDF のパスワードが違います", todo: "登録したパスワードを確かめてください" },

  // System
  HTTP_CONNECT_FAILED: { what: (c) => `${c.q(c.p("url"))}につながりませんでした`, todo: "アドレスとネットワーク（プロキシ）を確かめてください" },
  HTTP_ERROR: {
    what: (c) => `相手のサーバーがエラーを返しました${c.num("status") != null ? `（${c.num("status")}）` : ""}`,
    todo: (c) => {
      const s = c.num("status") ?? 0;
      if (s === 401 || s === 403) return "サインインの情報や権限を確かめてください";
      if (s === 404) return "アドレスが正しいか確かめてください";
      if (s >= 500 || s === 429) return "相手が混んでいるか止まっています。時間をおいて実行してください";
      return "送る内容が相手の求める形か確かめてください";
    },
  },
  HTTP_UNAVAILABLE: { what: "通信の準備ができませんでした", todo: "もう一度実行してください" },
  PROCESS_FAILED: {
    what: (c) => `プログラムがエラーで終わりました${c.num("exitCode") != null ? `（終了コード ${c.num("exitCode")}）` : ""}`,
    todo: "プログラムの出力（英語の原文と詳しい情報）を確かめてください",
  },
  PROCESS_NOT_FOUND: { what: "プログラムが見つかりません", todo: "プログラムの場所か名前を確かめてください" },
  PROCESS_START_FAILED: { what: "プログラムを起動できませんでした", todo: "プログラムの場所と権限を確かめてください" },
  CLIPBOARD_BUSY: { what: "クリップボードをほかのアプリが使っています", todo: "もう一度実行してください" },
  DIALOG_FAILED: { what: "ダイアログを出せませんでした", todo: "画面のある状態で実行してください" },

  // Secrets and sign-in
  SECRET_NOT_FOUND: { what: (c) => `シークレット${c.q(c.secret)}が登録されていません`, todo: "シークレットの画面で登録してください" },
  SECRET_FIELD_EMPTY: { what: (c) => `シークレット${c.q(c.secret)}の項目が空です`, todo: "シークレットの画面で値を入れてください" },
  SECRET_SITE_NOT_SET: { what: (c) => `シークレット${c.q(c.secret)}に使ってよいサイトが決まっていません`, todo: "シークレットの画面でサイトを追加してください" },
  SECRET_SITE_MISMATCH: {
    what: (c) => `今のページはシークレット${c.q(c.secret)}を使ってよいサイトではありません`,
    todo: "ページのアドレスを確かめ、正しければシークレットにサイトを追加してください",
  },
  SECRET_APP_NOT_SET: { what: (c) => `シークレット${c.q(c.secret)}に使ってよいアプリが決まっていません`, todo: "シークレットの画面でアプリ（app:〇〇.exe）を追加してください" },
  SECRET_APP_MISMATCH: { what: (c) => `このアプリはシークレット${c.q(c.secret)}を使ってよいアプリではありません`, todo: "アプリを確かめ、正しければシークレットに追加してください" },
  SECRET_KEY_MISSING: { what: "シークレットはほかの PC かほかのユーザーで登録されたもので、ここでは読めません", todo: "シークレットの画面でリセットして登録し直してください" },
  SECRET_DECRYPT_FAILED: { what: "シークレットを読み出せませんでした", todo: "シークレットの画面でリセットして登録し直してください" },
  SECRETS_UNAVAILABLE: { what: "この実行ではシークレットが使えません", todo: "Studio か、コマンドから実行してください" },
  SECRET_NOT_ALLOWED: { what: "この項目にはシークレットを入れられません", todo: "入力欄に入れるノードで使ってください" },
  SECRET_PLUGIN_NOT_ALLOWED: { what: "このプラグインはシークレットを使ってよいことになっていません", todo: "シークレットに plugin:〇〇 を追加してください" },
  OAUTH_SIGN_IN_REQUIRED: { what: "サインインがまだです", todo: "このノードより前に「サインイン」を置いてください" },
  OAUTH_DENIED: { what: "サインインが断られました", todo: "許可を押したか、アプリの設定（クライアント ID・戻り先）を確かめてください" },
  OAUTH_STATE_MISMATCH: { what: "サインインの答えが今回の依頼のものではありません", todo: "もう一度実行してください" },
  OAUTH_TOKEN_FAILED: { what: "サインインの最後の手続きが断られました", todo: "クライアント ID・シークレットと、アドレスの設定を確かめてください" },
  OAUTH_FAILED: { what: "サインインに失敗しました", todo: "もう一度実行してください" },
};
