---
name: spellsheet-work-inventory
description: Use when the user wants to find out which of their work is worth automating, asks where their time goes, or wants a consultant-style interview about their tasks before building SpellSheet flows (業務の棚卸し).
---

# 業務の棚卸し：自動化する業務を一緒に選ぶ

ユーザーの業務を聞き取り、どれを自動化すると一番楽になるかを決める。結果は SpellSheet の「業務の棚卸し」として保存され、人は Writer の「業務の棚卸し」で同じ表と順番を見られる。Excel にも書き出せる。

## 進め方

1. `get_work_inventory`（引数なし）を呼ぶ。続きがあれば `id` を付けて読み直す。返る `guide` が聞き取りの手順なので、それに従う。MCP の prompt `find_what_to_automate` も同じ手順。
2. 一度に聞くのは 1〜2 問。選べる質問は `ask_user_to_choose` で選択肢にする。数字（頻度・1 回の分数・人数・手作業の割合）は目安でよいと伝える。
3. 聞けたことはその都度 `save_work_inventory` で保存する。新しい棚卸しは `id` なし、続きは `id` と `expectedRevision` を付ける。業務は `tasks` に `id` 付きで、変えた項目だけを書く。
4. 返る `assessment` の順番（`first`・`later`・`split`・`unknown`・`notNow`）と数字はそのまま使う。自分で計算し直さない。`missing` に出た項目を次に聞く。
5. 最後に、最初に作る 1 本とその理由（月に減らせる時間、作りやすさ）を短く伝える。作るときは `spellsheet-flows` スキルの手順でフローを作り、できたフローの id をその業務の `flowIds` に足す。

## 気をつけること

- 個人名・顧客名・金額などの業務データは聞かない。業務の名前と手順の粗さで十分。
- 判断が多い業務・毎回違う業務は無理に自動化を勧めない。分ければ自動化できる部分があれば `split` として伝える。
- ユーザーの言葉で業務名を書く。こちらで造語しない。
