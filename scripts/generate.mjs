import fs from 'node:fs';
import path from 'node:path';
import Parser from 'rss-parser';

const ROOT = path.resolve(process.cwd());
const sourcesPath = path.join(ROOT, 'data', 'sources.json');
const statePath = path.join(ROOT, 'data', 'state.json');
const postsDir = path.join(ROOT, 'content', 'posts');

const sources = JSON.parse(fs.readFileSync(sourcesPath, 'utf8'));
const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
state.seen ||= [];

const parser = new Parser({
  timeout: 15000,
  customFields: {
    item: [
      ['dc:creator', 'creator'],
      ['content:encoded', 'contentEncoded'],
      // media:content のurl属性を拾える場合がある
      ['media:content', 'mediaContent', { keepArray: true }],
      ['media:thumbnail', 'mediaThumbnail', { keepArray: true }]
    ]
  }
});

const now = new Date();
const lookbackMs = (sources.lookbackHours ?? 12) * 60 * 60 * 1000;
const cutoff = new Date(now.getTime() - lookbackMs);

function normUrl(u) {
  try {
    const url = new URL(u);
    url.hash = '';
    for (const k of [...url.searchParams.keys()]) {
      if (/^(utm_|fbclid|gclid)/i.test(k)) url.searchParams.delete(k);
    }
    return url.toString();
  } catch {
    return u;
  }
}

function safeSlug(s) {
  return (s || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'post';
}

function fmtJst(dt) {
  const jst = new Date(dt.toLocaleString('en-US', { timeZone: 'Asia/Tokyo' }));
  const y = jst.getFullYear();
  const m = String(jst.getMonth() + 1).padStart(2, '0');
  const d = String(jst.getDate()).padStart(2, '0');
  const hh = String(jst.getHours()).padStart(2, '0');
  const mm = String(jst.getMinutes()).padStart(2, '0');
  return `${y}-${m}-${d} ${hh}:${mm}`;
}

function pickImageFromParsedItem(item) {
  // enclosure
  if (item?.enclosure?.url) return item.enclosure.url;

  // media:thumbnail / media:content
  const pickUrlAttr = (arr) => {
    if (!Array.isArray(arr) || arr.length === 0) return '';
    const v = arr[0];
    if (typeof v === 'string') return v;
    if (v?.$?.url) return v.$.url;
    if (v?.url) return v.url;
    return '';
  };

  const t = pickUrlAttr(item.mediaThumbnail);
  if (t) return t;
  const c = pickUrlAttr(item.mediaContent);
  if (c) return c;

  return '';
}

async function fetchItems() {
  const all = [];

  for (const src of sources.sources) {
    if (src.type !== 'rss') continue;

    let feed;
    try {
      feed = await parser.parseURL(src.url);
    } catch (e) {
      console.warn(`WARN: failed to fetch ${src.name} (${src.url}): ${e?.message || e}`);
      continue;
    }

    for (const item of feed.items ?? []) {
      const link = normUrl(item.link || '');
      const id = link || item.guid || `${src.name}:${item.title}`;
      const pub = item.isoDate ? new Date(item.isoDate) : (item.pubDate ? new Date(item.pubDate) : null);
      if (!pub || Number.isNaN(pub.getTime())) continue;
      if (pub < cutoff) continue;
      if (state.seen.includes(id)) continue;

      const image = pickImageFromParsedItem(item);

      all.push({
        source: src.name,
        title: item.title?.trim() || '(no title)',
        link,
        id,
        date: pub,
        image: image ? normUrl(image) : ''
      });
    }
  }

  all.sort((a, b) => b.date - a.date);
  return all.slice(0, sources.maxItems ?? 10);
}

function buildDialogueForItem(it) {
  // 会話形式（LINEっぽく表示するのは Hugo shortcode + CSS）
  const editor = { name: '編集者', avatar: '/game-news-blog/avatars/editor.svg' };
  const gamer = { name: 'ゲーマー', avatar: '/game-news-blog/avatars/gamer.svg' };

  // “中”レベル（800〜1200字くらいを狙う）：
  // ここでは「背景/影響/チェック項目/次アクション」を厚めにして、コピペなしで掘り下げ感を作る。
  const jst = fmtJst(now);

  const p1 = `今日は${jst}時点のニュースから1本。タイトルは「${it.title}」。まず押さえるべきは“何が更新された（発表された）か”だね。`;
  const p2 = `この手のニュースは、第一報だけだと情報が断片的なことが多い。だから「対象プラットフォーム」「時期（発売日/配信日）」「価格や提供形態」「ユーザーに直接影響する変更点（仕様/規約/対応言語/地域）」の4点を最優先で確認する。`;
  const p3 = `もしアップデートやパッチの話なら、次に見るべきは「変更の範囲（新要素/調整/バグ修正）」「既存セーブへの影響」「不具合の既知情報」。発表/発売の話なら「対応機種」「予約/販売ページ」「PV」「開発元の追加コメント」が揃うかが重要。`;
  const p4 = `あと個人的に大事なのは“誰が得するニュースか”を言語化すること。既存プレイヤー向け？新規向け？開発者向け？投資/業界向け？このラベルが付くと、読む側が迷わない。`;
  const p5 = `一次情報が出ているかは、出典リンク先から公式ページやストア、プレスリリースへ辿れるかで判断できる。出典→公式の経路が見つかるなら、信頼度も上がるし、詳細も早い。`;

  return [
    '{{< chat >}}',
    `{{< msg side="left" name="${editor.name}" avatar="${editor.avatar}" >}}${p1}{{< /msg >}}`,
    `{{< msg side="right" name="${gamer.name}" avatar="${gamer.avatar}" >}}タイトルだけだとピンと来ない時ある。どこ見ればいい？{{< /msg >}}`,
    `{{< msg side="left" name="${editor.name}" avatar="${editor.avatar}" >}}${p2}\n\n${p3}{{< /msg >}}`,
    `{{< msg side="right" name="${gamer.name}" avatar="${gamer.avatar}" >}}なるほど。読むポイントが分かった。{{< /msg >}}`,
    `{{< msg side="left" name="${editor.name}" avatar="${editor.avatar}" >}}${p4}\n\n${p5}\n\n出典リンクから公式へ辿れたら、そこが一番強い。{{< /msg >}}`,
    `{{< msg side="right" name="${gamer.name}" avatar="${gamer.avatar}" >}}OK、リンク踏んで確認してくる！{{< /msg >}}`,
    '{{< /chat >}}',
    ''
  ].join('\n');
}

function buildMarkdownForItem(it) {
  const title = it.title;

  const frontmatter = [
    '---',
    `title: "${title.replace(/\"/g, '”')}"`,
    `date: ${it.date.toISOString()}`,
    'tags: ["game-news"]',
    it.image ? `image: "${it.image}"` : '',
    '---',
    ''
  ].filter(Boolean).join('\n');

  const meta = [
    `出典：**${it.source}**`,
    '',
    `- 元記事：${it.link}`,
    ''
  ].join('\n');

  const summary = [
    '## 3行サマリー',
    '- まずは「何が起きたか」を掴む（詳細は出典へ）',
    '- プラットフォーム/時期/価格/影響範囲をチェック',
    '- 公式続報やストア情報が出ていれば一次情報を優先',
    ''
  ].join('\n');

  const body = buildDialogueForItem(it);

  const footer = [
    '---',
    '※本記事は自動生成の紹介記事です。詳細・正確な情報は必ず出典（リンク先）をご確認ください。',
    ''
  ].join('\n');

  return { title, body: frontmatter + meta + summary + body + footer };
}

function writePost(md, it) {
  fs.mkdirSync(postsDir, { recursive: true });
  const stamp = it.date.toISOString().replace(/[:]/g, '').slice(0, 15);
  const filename = `${stamp}-${safeSlug(it.source)}-${safeSlug(md.title)}.md`;
  const outPath = path.join(postsDir, filename);
  fs.writeFileSync(outPath, md.body, 'utf8');
  return outPath;
}

function saveState(items) {
  for (const it of items) state.seen.push(it.id);
  state.seen = state.seen.slice(-2000);
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2) + '\n', 'utf8');
}

const items = await fetchItems();
if (items.length === 0) {
  console.log('No new items in lookback window.');
  process.exit(0);
}

const written = [];
for (const it of items) {
  const md = buildMarkdownForItem(it);
  const out = writePost(md, it);
  written.push(out);
}

saveState(items);
for (const out of written) console.log('Wrote:', path.relative(ROOT, out));
