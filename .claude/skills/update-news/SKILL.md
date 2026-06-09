---
name: update-news
description: ゲームニュースを収集し、日本語記事にリライトして WordPress へ下書き投稿する日次ワークフロー。「ニュース更新」「記事を生成」「ブログを更新」などの指示で使う。
---

# ゲームニュース日次更新ワークフロー

このスキルは、国内外のゲームメディアの新着ニュースを収集し、オリジナルの日本語記事に
リライトして WordPress に **下書き(draft)** として投稿する一連の流れを実行する。

## 前提
- 環境変数 `WP_URL` / `WP_USER` / `WP_APP_PASSWORD` が設定済み（未設定ならユーザーに知らせて中断）。
- リポジトリ直下で実行する。

## 手順

### 1. 新着ニュースを収集
```bash
node scripts/fetch.mjs
```
- 結果は `data/incoming.json` に書き出される（`items` 配列）。
- `items` が空なら「本日の新着なし」と報告して終了（投稿しない）。

### 2. 記事を選定
- `data/incoming.json` を読む。
- 重要・話題性・読者の関心が高いものを **最大8件** 選ぶ。
- 同じ話題の重複、低品質な内容、リンク切れが疑われるものは除外。
- 国内・海外がバランスよく入るよう配慮（必須ではない）。

### 3. 各ニュースを日本語記事にリライト
選んだニュースごとに、`data/incoming.json` の `title` / `snippet` / `source` / `link` を元に
**オリジナルの日本語記事** を作成する。

編集方針（厳守）:
- **要約・解説する。元記事の本文や画像をコピーしない**（著作権配慮）。
- 事実関係はスニペットの範囲で書き、不確かな点は断定しない。憶測を事実のように書かない。
- タイトルは内容が分かる自然な日本語に。煽り・誇張は避ける。
- 本文は HTML（`<p>` 段落、必要なら `<h2>` 小見出し、`<ul>` 箇条書き）。本文の目安は 300〜600 字程度。
- **本文末尾に必ず出典を入れる**:
  `<p>出典: <a href="（元記事URL）" rel="nofollow noopener" target="_blank">（媒体名）</a></p>`

### 4. WordPress へ下書き投稿
記事ごとに一時 JSON を作って投稿する。例:
```bash
cat > /tmp/article.json <<'JSON'
{
  "title": "記事タイトル",
  "content": "<p>本文…</p><p>出典: <a href=\"https://example.com/news\" rel=\"nofollow noopener\" target=\"_blank\">媒体名</a></p>",
  "status": "draft",
  "sourceUrl": "https://example.com/news",
  "source": "媒体名"
}
JSON
node scripts/post.mjs /tmp/article.json
```
- `post.mjs` が成功すると、その `sourceUrl` が `data/state.json` に記録され、次回以降は重複投稿されない。
- 投稿に失敗したニュースは state に記録されないため、次回再挑戦される。

### 5. 状態を保存（コミット&プッシュ）
全件投稿後、dedupe 状態を永続化する:
```bash
git add data/state.json
git commit -m "chore: update posted-news state"
git push -u origin <作業ブランチ>
```
（`data/incoming.json` は .gitignore 済みなのでコミットしない。）

### 6. 報告
- 投稿した件数・タイトル・WordPress の投稿リンクを一覧で報告する。
- 下書きなので、ユーザーが管理画面で確認して公開する旨を添える。
