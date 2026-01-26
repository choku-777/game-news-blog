import fs from 'node:fs';
import path from 'node:path';
import Parser from 'rss-parser';
import { JSDOM } from 'jsdom';
import { Readability } from '@mozilla/readability';

const ROOT = path.resolve(process.cwd());
const sourcesPath = path.join(ROOT, 'data', 'sources.json');
const statePath = path.join(ROOT, 'data', 'state.json');
const postsDir = path.join(ROOT, 'content', 'posts');

const sources = JSON.parse(fs.readFileSync(sourcesPath, 'utf8'));
const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
state.seen ||= [];

const parser = new Parser({
  timeout: 20000,
  customFields: {
    item: [
      ['dc:creator', 'creator'],
      ['content:encoded', 'contentEncoded'],
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

function pickUrlAttr(arr) {
  if (!Array.isArray(arr) || arr.length === 0) return '';
  const v = arr[0];
  if (typeof v === 'string') return v;
  if (v?.$?.url) return v.$.url;
  if (v?.url) return v.url;
  return '';
}

function pickImageFromParsedItem(item) {
  if (item?.enclosure?.url) return item.enclosure.url;
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

async function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function fetchHtml(url) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 20000);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: {
        'user-agent': 'game-news-blog-bot/1.0 (+https://choku-777.github.io/game-news-blog/; contact: choku)'
      }
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(t);
  }
}

function extractOgImage(doc) {
  const candidates = [
    'meta[property="og:image"]',
    'meta[name="og:image"]',
    'meta[property="twitter:image"]',
    'meta[name="twitter:image"]'
  ];
  for (const sel of candidates) {
    const el = doc.querySelector(sel);
    const c = el?.getAttribute('content');
    if (c) return c;
  }
  return '';
}

function textFromReadability(html, url) {
  const dom = new JSDOM(html, { url });
  const doc = dom.window.document;
  const ogImage = extractOgImage(doc);

  const reader = new Readability(doc);
  const article = reader.parse();
  const text = (article?.textContent || '').trim();
  return { text, ogImage: ogImage ? normUrl(ogImage) : '' };
}

function rewriteJa(s) {
  // 露骨なコピペ感を下げるための超簡易リライト（LLMではない）
  return (s || '')
    .replace(/\s+/g, ' ')
    .replace(/しました/g, 'した')
    .replace(/しています/g, 'している')
    .replace(/となりました/g, 'となった')
    .replace(/という/g, 'との')
    .replace(/発表していました/g, '発表していた')
    .trim();
}

function make10LineSummary(text) {
  // 「本文を読んだ上での要点」：長い引用を避け、短い自前フレーズに寄せる
  const cleaned = (text || '')
    .replace(/\r/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  const paras = cleaned.split(/\n\n+/).map(s => s.trim()).filter(Boolean);

  // 文を集める
  const sents = [];
  for (const p of paras) {
    const chunk = p.replace(/\s+/g, ' ');
    for (const s of chunk.split(/(?<=。|！|？)\s*/)) {
      const t = s.trim();
      if (t) sents.push(t);
      if (sents.length >= 30) break;
    }
    if (sents.length >= 30) break;
  }

  const lines = [];
  const templates = [
    '概要：',
    '背景：',
    '状況：',
    'ポイント：',
    '注目：',
    '補足：',
    '影響：',
    '今後：',
    '関連：',
    'まとめ：'
  ];

  for (let i = 0; i < Math.min(10, sents.length); i++) {
    let t = rewriteJa(sents[i]);
    // 長すぎる場合はカット（引用抑制）
    if (t.length > 90) t = t.slice(0, 88) + '…';
    lines.push(`${templates[i]}${t}`);
  }

  // 文が少ないときは段落から補完
  while (lines.length < 10 && paras.length) {
    let t = rewriteJa(paras[lines.length % paras.length]);
    if (t.length > 90) t = t.slice(0, 88) + '…';
    lines.push(`${templates[lines.length]}${t}`);
  }

  return lines.slice(0, 10);
}

async function enrichItem(it) {
  // polite crawl
  await sleep(1200);

  try {
    const html = await fetchHtml(it.link);
    const { text, ogImage } = textFromReadability(html, it.link);

    const summaryLines = text ? make10LineSummary(text) : [];

    // サムネ：RSS > OG:image > none
    const image = it.image || ogImage || '';

    return { ...it, image: image ? normUrl(image) : '', summaryLines, extractedTextChars: text.length };
  } catch (e) {
    console.warn(`WARN: failed to fetch/parse article for summary (${it.link}): ${e?.message || e}`);
    return { ...it, summaryLines: [], extractedTextChars: 0 };
  }
}

function buildChatFeelings(it) {
  const editor = { name: '編集者', avatar: '/game-news-blog/avatars/editor.svg' };
  const gamer = { name: 'ゲーマー', avatar: '/game-news-blog/avatars/gamer.svg' };

  const take = (it.summaryLines || []).slice(0, 3).join('\n');
  const editorMsg = take
    ? `要約読む限り、ポイントはこの辺だね：\n${take}\n\n個人的には「どの層に効くニュースか」と「次の公式発表が何か」が気になる。`
    : '今回は本文要約が取れなかった。出典リンクを見た上で、重要ポイントだけ拾っていこう。';

  const gamerMsg = '自分の感想としては、実際にユーザー側の体験がどう変わるかが一番気になる。良いニュースなら期待値上げたいし、懸念点があるなら早めに知っておきたい。';

  return [
    '{{< chat >}}',
    `{{< msg side="left" name="${editor.name}" avatar="${editor.avatar}" >}}${editorMsg}{{< /msg >}}`,
    `{{< msg side="right" name="${gamer.name}" avatar="${gamer.avatar}" >}}${gamerMsg}{{< /msg >}}`,
    `{{< msg side="left" name="${editor.name}" avatar="${editor.avatar}" >}}じゃあ、気になる人は出典リンクで全文チェックして、公式に飛べるならそこも追いかけよう。{{< /msg >}}`,
    `{{< msg side="right" name="${gamer.name}" avatar="${gamer.avatar}" >}}了解。続報待ち案件ならウォッチ入れとく。{{< /msg >}}`,
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
    '',
    ''
  ].filter(v => v !== '').join('\n') + "\n";

  const meta = [
    `出典：**${it.source}**`,
    '',
    `- 元記事：${it.link}`,
    ''
  ].join('\n');

  const summary = (it.summaryLines && it.summaryLines.length)
    ? ['## 要約（本文を読んだ上での抜粋/要点）', '', ...it.summaryLines.map(l => `- ${l}`), ''].join('\n')
    : ['## 要約', '', '（本文要約の取得に失敗。出典リンクをご確認ください）', ''].join('\n');

  const chat = ['## 感想チャット', '', buildChatFeelings(it)].join('\n');

  const footer = [
    '---',
    '※本記事は自動生成の紹介記事です。引用は最小限にとどめ、詳細・正確な情報は必ず出典（リンク先）をご確認ください。',
    ''
  ].join('\n');

  return { title, body: frontmatter + meta + summary + chat + footer };
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
  state.seen = state.seen.slice(-4000);
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2) + '\n', 'utf8');
}

const items = await fetchItems();
if (items.length === 0) {
  console.log('No new items in lookback window.');
  process.exit(0);
}

const written = [];
for (const it of items) {
  const enriched = await enrichItem(it);
  const md = buildMarkdownForItem(enriched);
  const out = writePost(md, enriched);
  written.push(out);
}

saveState(items);
for (const out of written) console.log('Wrote:', path.relative(ROOT, out));
