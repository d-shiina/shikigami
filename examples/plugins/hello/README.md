# サンプルプラグイン `hello`

プラグインの書き方を示す最小の例です（Node.js、依存なし）。仕組みは [docs/design/plugins.md](../../../docs/design/plugins.md)。

- `shikigami-plugin.json`：ステップ型の宣言（params の JSON Schema、記述例、排他する資源）
- `main.mjs`：標準入出力で JSON-RPC を受けて処理する本体

試すには、このフォルダを `%LOCALAPPDATA%\Shikigami\plugins\hello` にコピーするか、環境変数 `SHIKIGAMI_PLUGINS` にこのフォルダを指定します。

```powershell
shikigami plugin check examples\plugins\hello
$env:SHIKIGAMI_PLUGINS = "$PWD\examples\plugins"
shikigami plugin list
shikigami step-types   # hello.greet と hello.appendLine が出る
```
