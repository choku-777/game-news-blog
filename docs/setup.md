# セットアップ手順

ゲームニュース自動投稿ブログを動かすための初期設定をまとめる。
WordPress 側の準備 → 認証情報の設定 → 動作確認 → 毎日の自動実行、の順に進める。

---

## 1. さくらサーバに WordPress を導入

> ⚠️ WordPress の動作には PHP/MySQL が必要です。**スタンダードプラン以上**を推奨
> （ライトプランは構成によって不可）。

1. さくらインターネットの**コントロールパネル**にログイン。
2. 「Webサイト/データ」→「クイックインストール」→ **WordPress** を選択。
3. インストール先ドメイン／ディレクトリを指定してインストール。
   - 無料で使える **初期ドメイン**（`<アカウント名>.sakura.ne.jp`）でも可。
   - 初期ドメインの公開フォルダは `www` 固定。
4. データベースを作成（指示に従う）。
5. インストール完了後、`https://<ドメイン>/wp-admin/` にアクセスし WordPress の初期設定を完了。

### SSL（https）を有効化
アプリケーションパスワードは **HTTPS が必須**。

- コントロールパネルの「ドメイン/SSL」から SSL を有効化（独自ドメインは無料SSL、初期ドメインは共有SSL）。
- WordPress 管理画面「設定」→「一般」の**サイトアドレス/WordPressアドレスを `https://` に**しておく。

---

## 2. アプリケーションパスワードを発行

1. WordPress 管理画面にログイン。
2. 「ユーザー」→「プロフィール」を開く。
3. ページ下部の **「アプリケーションパスワード」** に任意の名前（例: `game-news-bot`）を入力して発行。
4. 表示された値（`xxxx xxxx xxxx xxxx xxxx xxxx` 形式）を控える。**この画面を離れると再表示できない**ので注意。

> アプリケーションパスワードの項目が表示されない場合は、サイトが https になっているか、
> WordPress が 5.6 以上かを確認。

---

## 3. 認証情報を設定

必要な値:

| 変数 | 例 | 説明 |
|------|----|------|
| `WP_URL` | `https://example.sakura.ne.jp` | サイトURL（末尾スラッシュなし・https） |
| `WP_USER` | `admin` | WordPress のログインID |
| `WP_APP_PASSWORD` | `xxxx xxxx xxxx ...` | 手順2で発行した値（スペース込みで可） |

### ローカル / 手動テスト用
`.env.example` をコピーして `.env` を作り、実値を記入（`.env` は Git 管理外）。
```bash
cp .env.example .env
# .env を編集
```

### 本番（クラウドの自動実行）用
Claude Code on the web の**環境変数**に同じ3つを登録する。

---

## 4. 依存パッケージのインストールと動作確認

```bash
npm install

# 新着ニュースの収集テスト（data/incoming.json が生成される）
node scripts/fetch.mjs

# 投稿テスト（WP導入後）: 下書きが1件作られることを確認
cat > /tmp/sample.json <<'JSON'
{
  "title": "テスト投稿",
  "content": "<p>これはテストです。</p>",
  "status": "draft",
  "sourceUrl": "https://example.com/test",
  "source": "テスト"
}
JSON
node scripts/post.mjs /tmp/sample.json
```
WordPress 管理画面の「投稿」→「下書き」に表示されれば成功。

---

## 5. 毎日の自動実行（スケジュール）

Claude Code の **スケジュール実行（Routine）** を使う。常時起動しているPCは不要で、クラウドで実行される。

- セッション内で次を実行してスケジュールを作成:
  ```
  /schedule daily ゲームニュースを収集して WordPress に下書き投稿する（update-news スキルを使う）
  ```
- 実行時刻はローカルタイムゾーンで指定（例: 毎朝7時）。
- 実行されると `update-news` スキルの手順に沿って、収集→リライト→下書き投稿→state更新が走る。

> `/loop` はセッションを開いている間だけ短い間隔で繰り返す機能なので、テスト用途向け。
> 1日1回の常用は `/schedule` を推奨。

---

## 運用メモ
- 投稿は **下書き**。WordPress 管理画面で内容を確認してから公開する。
- 重複投稿は `data/state.json`（投稿済みURL）で防止。state は実行のたびにコミット&プッシュして永続化する。
- 情報源の追加・削除は `data/sources.json` を編集する。
- フィードの到達可否は実行環境のネットワーク次第。一部の海外サイト（IGN/Polygon/Eurogamer等）は
  bot対策で 403 になることがあるが、`fetch.mjs` はそのフィードをスキップして処理を継続する。
