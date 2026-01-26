# game-news-blog

ゲーム業界ニュースを定時（JST 7/12/21）に自動収集して、会話形式でまとめた記事を生成し、GitHub Pagesで公開します。

## 使い方（ローカル）

```bash
npm i
npm run generate
hugo server
```

## 情報源の設定

`data/sources.json` を編集。

## AdSense

審査が通ったら、`layouts/_default/baseof.html` のコメント部分に Auto ads のスニペットを貼ってください。
