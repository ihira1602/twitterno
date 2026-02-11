# twitterno
Twitter/Xアカウントを入力すると、`/media` ページを自動スクロールして画像を収集し、Chromeのダウンロード機能で一括保存する拡張機能です。

## Features
- サーバー不要（Chrome拡張のみ）
- `@username` または `https://x.com/<username>` を入力して実行
- 自動スクロールで画像URLを収集
- 収集結果を `Downloads/twitterno/<username>/` に連番保存
- 実行ステータス・ログをPopup上で表示

## Install (Developer mode)
1. このリポジトリをローカルに配置
2. Chromeで `chrome://extensions` を開く
3. 右上の `デベロッパーモード` をON
4. `パッケージ化されていない拡張機能を読み込む` からこのフォルダを選択

## Usage
1. 拡張アイコン `twitterno` を開く
2. アカウント名 or URLを入力
3. 必要に応じて設定を変更
- `最大スクロール回数`: 多いほど過去投稿まで取りやすい
- `スクロール待機(ms)`: 大きいほど安定しやすい
4. `収集してダウンロード` を押す

## Notes
- 収集対象は `https://x.com/<username>/media` の画像です。
- ログインが必要な投稿は、Chromeでログイン済み状態で実行してください。
- 保存先はChrome標準のダウンロード先です。
- 利用規約・著作権・プライバシーに従って利用してください。
