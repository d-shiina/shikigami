# 見本の拡張機能 `azureocr`（Azure AI-OCR）

クラウド型 AI-OCR の Azure AI Document Intelligence で、画像・PDF の文字・表・請求書や領収書の項目を読み取るノード「AI-OCR の読み取り」を追加します。Node.js、依存なし。

使い方と作り方は [docs/ja/extensions.md](../../../docs/ja/extensions.md) にあります。

```powershell
shikigami plugin check examples\plugins\azure-ocr
shikigami plugin install examples\plugins\azure-ocr --yes
node --test examples\plugins\azure-ocr\test.mjs   # Azure の代わりのサーバーで動作を確認
```

- `shikigami-plugin.json`：ノードの宣言（設定欄の名前・選択肢、外部送信 `external`、API キー `credentials`、ファイル `pathParams`、送り先の検査 `targets`）
- `main.mjs`：Azure の REST API（2024-11-30）への送信と、結果の整形（`text`・`pages`・`tables`・`fields`）
- `test.mjs`：Azure の代わりのサーバーを立てて動作を確認するテスト
