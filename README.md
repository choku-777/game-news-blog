# game-news-blog

国内外のゲームニュースを **毎日自動で収集・日本語リライトし、WordPress に下書き投稿** する自動ブログの仕組み。

- **収集**: 国内（Game*Spark / AUTOMATON / 4Gamer / 電ファミ）＋海外（PC Gamer / GameSpot / Rock Paper Shotgun / Nintendo Life / Gematsu）の RSS
- **生成**: Claude Code がニュースをオリジナルの日本語記事にリライト（外部APIキー不要）
- **公開**: さくらサーバ上の WordPress に REST API 経由で **下書き(draft)** 投稿（人が確認して公開）
- **実行**: Claude Code のスケジュール実行（`/schedule`）で1日1回

## 仕組み

```
毎日1回（/schedule）
  1. node scripts/fetch.mjs   … RSS取得 → 既出を除外 → data/incoming.json
  2. Claude が記事を選定し日本語にリライト
  3. node scripts/post.mjs    … WordPress REST API へ draft 投稿 + state.json 更新
  4. git commit & push        … 重複防止の state を永続化
        ↓ HTTPS / REST API
   さくらサーバ上の WordPress（下書きに溜まる）
```

## クイックスタート

```bash
npm install
cp .env.example .env   # WP_URL / WP_USER / WP_APP_PASSWORD を記入
node scripts/fetch.mjs # 新着収集テスト
```

詳しい導入（さくらへの WordPress 設置、アプリケーションパスワード発行、スケジュール設定）は
**[docs/setup.md](docs/setup.md)** を参照。

## 構成

| パス | 役割 |
|------|------|
| `data/sources.json` | 収集する RSS フィード一覧 |
| `data/state.json` | 投稿済みURL（重複投稿防止） |
| `scripts/fetch.mjs` | RSS 収集 → `data/incoming.json` 出力 |
| `scripts/post.mjs` | 記事JSON を WordPress に下書き投稿 |
| `.claude/skills/update-news/SKILL.md` | 日次ワークフローの手順（Claude が従う） |
| `docs/setup.md` | セットアップ手順 |
