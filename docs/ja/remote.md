# 管理サーバー

[English](../remote.md) | 日本語

管理サーバーは、たくさんの PC の Worker に仕事（ジョブ）を渡します。「このフローを、空いている PC で動かして」と頼み、結果を見られます。PC からは**外向き**（HTTPS）にしかつながず、PC にポートを開けないので、プロキシやファイアウォールの内側でも動きます。設計メモは [design/remote-runs.md](../design/remote-runs.md)。

SpellSheet には下のプロトコルを話す小さな**参考実装のサーバー**（`spellsheet manager serve`）が付いています。状態は JSON ファイル 1 つで、管理用の API はありますが画面はありません。試す・テストする・社内 LAN の小さなチームで使うためのものです。本格的な管理ツールも同じプロトコルの上に作れます。

## しくみ

1. サーバーで**一度だけ使える登録コード**を作る。
2. PC で `spellsheet worker enroll <サーバーの URL> <コード>`。Worker が自分で Ed25519 の鍵の組を作り、公開鍵だけを送ります。秘密鍵は Windows の資格情報マネージャーに置きます。以後の要求はすべて署名つきです。
3. ワークスペースの `policy.json` で、サーバーに許すことを PC 側が決めます。

   ```json
   "remote": {
     "enabled": true,
     "manager": "https://manager.example.co.jp",
     "flows": ["scn_01a1…"]
   }
   ```

4. Worker（`spellsheet worker install`、または Writer の「自動実行」の「自動実行を開始」）は、**何も実行していないときだけ**サーバーに仕事を取りに行きます。そのとき `remote.flows` で許していて、この PC で公開版があるフローを伝え、サーバーは合うジョブがあれば渡します。
5. ジョブはほかの無人実行と同じく動きます。**公開版**を、`policy.json` のサイト・アプリ・`unattended` の決まりのもとで、この PC の金庫の秘密を使って。記録の `origin` は `trigger: "remote"`、`requestedBy`（サーバーで頼んだ人）、`jobId`。イベントは 2 秒ごと、レポートは最後にサーバーへ送ります。サーバーに届かないあいだも実行は最後まで続き、つながったら送ります。
6. サーバーで取り消したジョブは、PC の次の連絡で取り消します（`finally` は動きます）。

最後に決めるのは PC です。サーバーが何を頼んでも、`policy.json` で許していないフロー（`REMOTE_NOT_ALLOWED`）、公開していないもの（`NOT_PUBLISHED`）、ジョブが指定した版と違う公開版（`VERSION_MISMATCH`）は動かさず、**断った**ことをサーバーに返します。秘密は PC から出ません。ジョブが運ぶのは入力の値で、パスワードではありません。

```powershell
spellsheet worker enroll https://manager.example.co.jp 3f9a1c0d2b7e4a55
spellsheet worker status        # サーバー・ワーカー ID・問題があればその内容
spellsheet worker unenroll
```

## 参考実装のサーバー

```powershell
spellsheet manager serve --listen 127.0.0.1:8740 --data C:\spellsheet-manager
```

`--data` に `state.json`（ワーカー・ジョブ・ログ）と、最初の起動で作る `admin-token` を置きます。待ち受けは HTTP なので、その PC の外から使うときは HTTPS のリバースプロキシを前に置いてください（Worker は `localhost` 以外の `http://` を断ります）。

管理用 API（`Authorization: Bearer <admin-token>`）：

| 要求 | すること |
|---|---|
| `POST /admin/enrollment-codes` | 1 時間有効の登録コード：`{ "code", "expiresAt" }` |
| `GET /admin/workers` | 登録した PC：PC 名・ユーザー・ワークスペース・最後の連絡 |
| `DELETE /admin/workers/{id}` | PC を外す。以後その PC の要求は断る |
| `POST /admin/jobs` | ジョブを積む：`{ "flowId", "inputs"?, "versionUid"?, "worker"?, "requestedBy"? }`。`worker` でその PC だけに。なければ動かせる PC のうち最初に空いたものが取る |
| `GET /admin/jobs` | ジョブの一覧（新しい順、ログなし） |
| `GET /admin/jobs/{id}` | 1 つのジョブとイベント・レポート |
| `POST /admin/jobs/{id}/cancel` | 取り消し：待ちのものはすぐ、実行中のものは PC の次の連絡で |

```powershell
$h = @{ Authorization = "Bearer $(Get-Content C:\spellsheet-manager\admin-token)" }
Invoke-RestMethod -Method Post -Headers $h http://127.0.0.1:8740/admin/enrollment-codes
Invoke-RestMethod -Method Post -Headers $h -ContentType application/json `
  -Body '{"flowId":"scn_01a1…","inputs":{"month":"2026-11"},"requestedBy":"dana"}' `
  http://127.0.0.1:8740/admin/jobs
```

ジョブの状態：`queued`（待ち）→ `leased`（PC に渡した）→ `running` → `succeeded` / `failed` / `cancelled`、または `rejected`（PC が断った）、`lost`（実行中に PC から連絡が途絶えた。途中まで動いたかもしれないので、もう一度は始めません）。渡したのに 60 秒以内に始まらなかったジョブは待ちに戻ります。その間に開始をサーバーへ伝えられなかった PC は実行を中止するので、同じジョブが 2 台で同時に動くことはありません。渡したあとのジョブを取り消すと、持っている PC に次の連絡のときに中止を伝えます。

## プロトコル v1

要求はすべて `/v1` の下への `POST`、本文は JSON です。登録の後は 3 つのヘッダーを付けます。

| ヘッダー | 値 |
|---|---|
| `X-SpellSheet-Worker` | 登録でもらったワーカー ID |
| `X-SpellSheet-Time` | Unix 時刻（秒）。サーバーの時計と 5 分以上ずれたら断る |
| `X-SpellSheet-Signature` | `spellsheet-v1\n{METHOD}\n{パス}\n{時刻}\n{本文の SHA-256 の16進}` の Ed25519 署名（Base64） |

| パス | 本文 → 答え |
|---|---|
| `/v1/enroll`（署名なし） | `{ code, publicKey, machine, user, workspace }` → `{ workerId }` |
| `/v1/jobs/claim` | `{ flows: [{ flowId, name, versionUid }], desktop?, waitSecs }` → ジョブ `{ id, flowId, versionUid?, inputs, requestedBy?, leaseSecs }`。`waitSecs` のあいだ何もなければ `204`（ロングポーリング） |
| `/v1/jobs/{id}/started` | `{ runId }` → `204` |
| `/v1/jobs/{id}/rejected` | `{ error: { code, message } }` → `204` |
| `/v1/jobs/{id}/events` | `{ events: [RunEventEnvelope…] }`（サーバーが持っている続きの `seq` から。重複は無視） → `{ cancel }` |
| `/v1/jobs/{id}/heartbeat` | `{}` → `{ cancel }`。イベントとハートビートで実行中のジョブの期限が延びる |
| `/v1/jobs/{id}/finished` | `{ report: RunReport }` → `204` |

エラーは HTTP のステータスと `{ code, message }`。イベントとレポートは `runs/<run-id>/` と同じもの（秘密は伏せ字）で、スクリーンショットは送りません。

## 制約

- バンドルを送ること（`remote.acceptBundles`）はまだできません。ジョブは PC のワークスペースの公開版を動かします。
- 1 台の PC で一度に 1 つ、ほかに何も動いていないときだけ。
- 参考実装のサーバーは、メモリとファイル 1 つで動き、管理用トークンのほかにアカウントはありません。
