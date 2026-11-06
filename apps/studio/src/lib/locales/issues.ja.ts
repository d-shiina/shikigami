// The flow's checks (validation issues) in words for people. Core words them
// in English for the AI; Studio says what to fix from `code`, the issue's
// path and the node. `field` is the setting's name as the panel shows it.
// Codes without an entry fall back to Core's message. Keep the same codes in
// issues.en.ts.
import type { IssueText } from "../issueText";

export const issuesJa: Record<string, IssueText> = {
  INVALID_PARAMS: (c) =>
    c.missing ? `「${c.label(c.missing)}」を入力してください` : c.field ? `「${c.label(c.field)}」の値の形式が正しくありません` : "ノードの設定に誤りがあります",
  UNDEFINED_VARIABLE: (c) => (c.name ? `変数「${c.name}」がありません。変数を追加するか、名前を確認してください` : "存在しない変数を使っています"),
  EXPR_SYNTAX: (c) => (c.field ? `「${c.label(c.field)}」の式の書き方が正しくありません` : "式の書き方が正しくありません"),
  EXPR_UNKNOWN_FUNCTION: "式で使っている関数がありません。関数名を確認してください",
  VARIABLE_TYPE_MISMATCH: (c) => (c.name ? `変数「${c.name}」の初期値が種類と一致しません` : "変数の初期値が種類と一致しません"),
  INVALID_VARIABLE_NAME: (c) => `変数名${c.name ? `「${c.name}」` : ""}には、半角の英字・数字・_ だけを使えます（先頭は英字）`,
  DUPLICATE_VARIABLE: (c) => `変数${c.name ? `「${c.name}」` : ""}が 2 回追加されています`,
  NO_OUTPUT: "このノードは結果を返さないため、「結果を保存する変数」は使えません",
  EMPTY_NAME: "フローの名前を入力してください",
  NOT_IN_LOOP: "このノードは繰り返しの中に置いてください",
  UNKNOWN_PART: "使っている部品がこのフローにありません",
  PART_NOT_PICKED: "部品がまだ画面から選ばれていません",
  PATH_OUTSIDE_PROJECT: (c) => (c.field ? `「${c.label(c.field)}」にフローのフォルダーの外は指定できません` : "フローのフォルダーの外は指定できません"),
  FOREACH_COLLECT_WITHOUT_SAVE_AS: "「結果を集める変数」を使うには、「結果を保存する変数」も入力してください",
  INVALID_SECRET_REF: "シークレットの指定が正しくありません。シークレットを選び直してください",
  SECRET_DEFAULT: "機密の変数には初期値を入力できません。シークレットに登録して使ってください",
  UNKNOWN_STEP_TYPE: "この種類のノードはこの Studio では使えません",
  DEPRECATED_STEP_TYPE: "このノードは古い種類です。新しいノードに置き換えてください",
  PLUGIN_NOT_INSTALLED: "このノードに必要なプラグインがインストールされていません",
  INVALID_RETRY: "リトライ回数は 1 以上にしてください",
  NOT_A_CASE: "値で分岐の中には「ケース」だけを置けます",
  CASE_OUTSIDE_SWITCH: "「ケース」は値で分岐の中に置いてください",
};
