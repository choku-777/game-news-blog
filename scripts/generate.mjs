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

function weightForSource(srcName) {
  const src = (sources.sources || []).find(s => s.name === srcName);
  return src?.weight ?? 1;
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
        weight: src.weight ?? 1,
        title: item.title?.trim() || '(no title)',
        link,
        id,
        date: pub,
        image: image ? normUrl(image) : ''
      });
    }
  }

  all.sort((a, b) => b.date - a.date);
  return all.slice(0, sources.maxItems ?? 60);
}

async function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function fetchHtml(url) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 8000);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: {
        'user-agent': 'game-news-blog-bot/1.0 (+https://gamenews.ny-service.jp/; contact: choku)'
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
  return (s || '')
    .replace(/\s+/g, ' ')
    .replace(/しました/g, 'した')
    .replace(/しています/g, 'している')
    .replace(/となりました/g, 'となった')
    .replace(/という/g, 'との')
    .replace(/発表していました/g, '発表していた')
    .trim();
}

function makeKeyPoints(text, maxLines = 8) {
  const cleaned = (text || '').replace(/\r/g, '').replace(/\n{3,}/g, '\n\n').trim();
  const paras = cleaned.split(/\n\n+/).map(s => s.trim()).filter(Boolean);

  const sents = [];
  for (const p of paras) {
    const chunk = p.replace(/\s+/g, ' ');
    for (const s of chunk.split(/(?<=。|！|？)\s*/)) {
      const t = s.trim();
      if (t) sents.push(t);
      if (sents.length >= 40) break;
    }
    if (sents.length >= 40) break;
  }

  const lines = [];
  for (let i = 0; i < Math.min(maxLines, sents.length); i++) {
    let t = rewriteJa(sents[i]);
    if (t.length > 100) t = t.slice(0, 98) + '…';
    lines.push(t);
  }
  return lines;
}

async function enrichUrl(it) {
  await sleep(200);
  const label = `[enrich] ${it.source} ${it.link}`;
  console.log(label);
  try {
    const html = await fetchHtml(it.link);
    const { text, ogImage } = textFromReadability(html, it.link);

    const keyPoints = text ? makeKeyPoints(text, 10) : [];

    const image = it.image || ogImage || '';

    return {
      ...it,
      image: image ? normUrl(image) : '',
      keyPoints,
      extractedTextChars: text.length
    };
  } catch (e) {
    console.warn(`WARN: failed to fetch/parse article (${it.link}): ${e?.message || e}`);
    return { ...it, keyPoints: [], extractedTextChars: 0 };
  }
}

function tokenizeTitle(s) {
  // 超軽量：英数字・日本語をざっくりトークン化
  return (s || '')
    .toLowerCase()
    .replace(/[“”"'’]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .filter(t => t.length >= 2)
    .slice(0, 40);
}

function jaccard(a, b) {
  const A = new Set(a);
  const B = new Set(b);
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  const union = A.size + B.size - inter;
  return union === 0 ? 0 : inter / union;
}

function clusterItems(items) {
  const clusters = [];
  for (const it of items) {
    const tokens = tokenizeTitle(it.title);
    let placed = false;
    for (const c of clusters) {
      const sim = jaccard(tokens, c.tokens);
      if (sim >= 0.35) {
        c.items.push(it);
        // tokens更新（ざっくり合成）
        c.tokens = Array.from(new Set([...c.tokens, ...tokens])).slice(0, 80);
        placed = true;
        break;
      }
    }
    if (!placed) clusters.push({ tokens, items: [it] });
  }
  return clusters;
}

function scoreCluster(cluster) {
  const uniqSources = new Set(cluster.items.map(i => i.source));
  const sourceCount = uniqSources.size;
  const weightSum = Array.from(uniqSources).reduce((sum, s) => sum + weightForSource(s), 0);
  const recency = Math.max(...cluster.items.map(i => i.date.getTime()));
  // 被り数を最重視 + 公式加点 + 新しさ
  return (sourceCount * 10) + (weightSum * 3) + (recency / 1e13);
}

function pickRepresentativeTitle(cluster) {
  // 一番重いソース（公式優先）→新しい順
  const sorted = [...cluster.items].sort((a, b) => {
    const dw = (weightForSource(b.source) - weightForSource(a.source));
    if (dw !== 0) return dw;
    return b.date - a.date;
  });
  return sorted[0]?.title || 'ゲームニュース';
}

function uniqBy(items, keyFn) {
  const seen = new Set();
  const out = [];
  for (const it of items) {
    const k = keyFn(it);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(it);
  }
  return out;
}

function pickFace(name, text) {
  const t = (text || '').toLowerCase();
  // super simple heuristics
  let mood = 'normal';
  if (/(悲報|延期|中止|終了|下方|改悪|損|泣|つら|残念)/.test(text)) mood = 'sad';
  if (/(炎上|怒|許|最悪|やばい|詐欺)/.test(text)) mood = 'angry';
  if (/(！|\!|うお|きた|最高|神|うれ|勝ち|爆アツ|熱い)/.test(text)) mood = 'happy';
  if (/(え|まて|待って|！？|\?\!|\!\?|\?)/.test(text)) mood = 'surprised';

  const base = name === 'ルカ' ? 'ruka' : 'tsugumi';
  return `/avatars/${base}_${mood}.png`;
}

function buildChat(cluster, enrichedById) {
  const tsugumi = { name: 'ツグミ', avatar: '/avatars/tsugumi_normal.png' };
  const ruka = { name: 'ルカ', avatar: '/avatars/ruka_normal.png' };

  const uniqSources = uniqBy(cluster.items, x => x.source).map(x => x.source);
  const representative = pickRepresentativeTitle(cluster);

  // 各ソースのポイントを合成
  const mergedPoints = [];
  const picked = cluster.items
    .sort((a, b) => (weightForSource(b.source) - weightForSource(a.source)) || (b.date - a.date))
    .slice(0, sources.maxSourcesPerCluster ?? 4);

  for (const it of picked) {
    const e = enrichedById.get(it.id);
    const pts = (e?.keyPoints || []).slice(0, 3);
    if (pts.length) {
      mergedPoints.push(`【${it.source}】${pts[0]}`);
      for (const p of pts.slice(1)) mergedPoints.push(`・${p}`);
    }
  }

  const head = `今日の重要トピック：\n「${representative}」\n\n複数サイト（${uniqSources.length}）で扱われてるから、重要度高め。`;
  const points = mergedPoints.length
    ? mergedPoints.slice(0, 10).map(s => `- ${s}`).join('\n')
    : '- （本文抽出に失敗したソースが多い。出典リンクで確認してね）';

  const t1 = `${head}\n\n一次情報寄りのポイントを拾って、ボクが整えるね。\n${points}`;
  const r1 = 'うおっ、これ熱い。結局「買い？炎上？財布HPは？」どれ！？';
  const t2 = '落ち着け。確定してるのはどこまでか、条件（機種/地域/日時/価格）をまず分けよう。';
  const r2 = 'はい、これは【推測】です！でもさ、雰囲気的にヤバそうじゃない？（ソース：俺の雰囲気）';

  // pick avatars by message content
  const t1a = pickFace('ツグミ', t1);
  const r1a = pickFace('ルカ', r1);
  const t2a = pickFace('ツグミ', t2);
  const r2a = pickFace('ルカ', r2);

  return [
    '{{< chat >}}',
    `{{< msg side="left" name="${tsugumi.name}" avatar="${t1a}" >}}${t1}{{< /msg >}}`,
    `{{< msg side="right" name="${ruka.name}" avatar="${r1a}" >}}${r1}{{< /msg >}}`,
    `{{< msg side="left" name="${tsugumi.name}" avatar="${t2a}" >}}${t2}\n\n結論：一次ソースを確認してから動こう。{{< /msg >}}`,
    `{{< msg side="right" name="${ruka.name}" avatar="${r2a}" >}}${r2}\n\n財布HP：■■□□□（減）{{< /msg >}}`,
    '{{< /chat >}}',
    ''
  ].join('\n');
}

function buildMarkdown(cluster, enrichedById) {
  const title = pickRepresentativeTitle(cluster);
  const newest = new Date(Math.max(...cluster.items.map(i => i.date.getTime())));
  const image = cluster.items.find(i => enrichedById.get(i.id)?.image)?.image || '';

  const frontmatter = [
    '---',
    `title: "${title.replace(/\"/g, '”')}"`,
    `date: ${newest.toISOString()}`,
    'tags: ["game-news"]',
    image ? `image: "${image}"` : '',
    '---',
    '',
    ''
  ].filter(v => v !== '').join('\n') + "\n";

  const chat = buildChat(cluster, enrichedById);

  // 出典まとめ（最後）
  const sourcesList = uniqBy(cluster.items, x => x.link)
    .sort((a, b) => (weightForSource(b.source) - weightForSource(a.source)) || (b.date - a.date))
    .map(it => `- **${it.source}**: ${it.link}`)
    .join('\n');

  const footer = [
    '---',
    '出典/関連リンク：',
    sourcesList,
    '',
    '※本記事は自動生成の紹介記事です。引用は最小限にとどめ、詳細・正確な情報は必ず出典（リンク先）をご確認ください。',
    ''
  ].join('\n');

  return { title, body: frontmatter + chat + footer, date: newest };
}

function writePost(md) {
  fs.mkdirSync(postsDir, { recursive: true });
  const stamp = md.date.toISOString().replace(/[:]/g, '').slice(0, 15);
  const filename = `${stamp}-${safeSlug(md.title)}.md`;
  const outPath = path.join(postsDir, filename);
  fs.writeFileSync(outPath, md.body, 'utf8');
  return outPath;
}

function saveState(items) {
  for (const it of items) state.seen.push(it.id);
  state.seen = state.seen.slice(-8000);
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2) + '\n', 'utf8');
}

const items = await fetchItems();
if (items.length === 0) {
  console.log('No new items in lookback window.');
  process.exit(0);
}

// 1) cluster
const clusters = clusterItems(items);

// 2) score & select top clusters
clusters.sort((a, b) => scoreCluster(b) - scoreCluster(a));
const selected = clusters.slice(0, sources.maxPostsPerRun ?? 5);

// 3) enrich only top N sources per cluster (avoid long runs)
const toFetch = [];
for (const c of selected) {
  const picked = [...c.items]
    .sort((a, b) => (weightForSource(b.source) - weightForSource(a.source)) || (b.date - a.date))
    .slice(0, sources.maxSourcesPerCluster ?? 4);
  toFetch.push(...picked);
}
const neededItems = uniqBy(toFetch, it => it.id)
  .slice(0, (sources.maxPostsPerRun ?? 5) * (sources.maxSourcesPerCluster ?? 4));

const enrichedById = new Map();
for (const it of neededItems) {
  const enriched = await enrichUrl(it);
  enrichedById.set(it.id, enriched);
}

// 4) write posts (one cluster = one post)
const written = [];
for (const c of selected) {
  const md = buildMarkdown(c, enrichedById);
  const out = writePost(md);
  written.push(out);
}

// state: mark *all* items in selected clusters as seen (so we don't repost)
const seenAll = uniqBy(selected.flatMap(c => c.items), it => it.id);
saveState(seenAll);
for (const out of written) console.log('Wrote:', path.relative(ROOT, out));
