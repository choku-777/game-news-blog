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
      ['content:encoded', 'contentEncoded']
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
    // 基本は追跡系クエリを落とす（雑に）
    for (const k of [...url.searchParams.keys()]) {
      if (/^(utm_|fbclid|gclid)/i.test(k)) url.searchParams.delete(k);
    }
    return url.toString();
  } catch {
    return u;
  }
}

function safeSlug(s) {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'post';
}

function fmtJst(dt) {
  // JSTの表示用
  const jst = new Date(dt.toLocaleString('en-US', { timeZone: 'Asia/Tokyo' }));
  const y = jst.getFullYear();
  const m = String(jst.getMonth() + 1).padStart(2, '0');
  const d = String(jst.getDate()).padStart(2, '0');
  const hh = String(jst.getHours()).padStart(2, '0');
  const mm = String(jst.getMinutes()).padStart(2, '0');
  return `${y}-${m}-${d} ${hh}:${mm}`;
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
      all.push({
        source: src.name,
        title: item.title?.trim() || '(no title)',
        link,
        id,
        date: pub
      });
    }
  }
  // 新しい順
  all.sort((a, b) => b.date - a.date);
  return all.slice(0, sources.maxItems ?? 10);
}

function buildDialogue(items) {
  // ここは後でLLM整形に置き換え可能。まずはテンプレで走らせる。
  const editor = '編集者';
  const gamer = 'ゲーマー';

  const lines = [];
  lines.push(`${editor}：今日のゲーム業界ニュース、サクッとまとめていくよ。`);
  lines.push(`${gamer}：きた！テンション上がるやつ頼む！`);
  lines.push('');

  items.forEach((it, idx) => {
    lines.push(`${editor}：${idx + 1}本目。『${it.title}』（${it.source}）`);
    lines.push(`${gamer}：これ気になる。要するにどういう話？`);
    lines.push(`${editor}：詳細は出典で確認してね。ここでは「何が起きたか」を短く。`);
    lines.push(`${gamer}：OK、リンク踏む。`);
    lines.push('');
  });

  return lines.join('\n');
}

function buildMarkdown(items) {
  const jstLabel = fmtJst(now);
  const title = `【ゲームニュースまとめ】${jstLabel}（JST）`;
  const frontmatter = [
    '---',
    `title: "${title.replace(/\"/g, '”')}"`,
    `date: ${now.toISOString()}`,
    'tags: ["game-news", "steam", "switch", "ps", "xbox"]',
    '---',
    ''
  ].join('\n');

  const summary = [
    '## 3行サマリー',
    `- 直近${sources.lookbackHours ?? 12}時間の注目ニュースを${items.length}本ピックアップ`,
    '- 詳細は各出典リンクから（本記事は要約ではなく“紹介”）',
    '- 大事な更新はリンク先で一次情報確認',
    ''
  ].join('\n');

  const dialogue = [
    '## 会話で読むニュース',
    '',
    buildDialogue(items),
    ''
  ].join('\n');

  const links = ['## 出典リンク', '', ...items.map(it => `- [${it.source}] ${it.title} — ${it.link}`), '',].join('\n');

  return { title, body: frontmatter + summary + dialogue + links };
}

function writePost(md) {
  fs.mkdirSync(postsDir, { recursive: true });
  const stamp = now.toISOString().replace(/[:]/g, '').slice(0, 15); // YYYY-MM-DDTHHMMSS
  const filename = `${stamp}-${safeSlug(md.title)}.md`;
  const outPath = path.join(postsDir, filename);
  fs.writeFileSync(outPath, md.body, 'utf8');
  return outPath;
}

function saveState(items) {
  for (const it of items) state.seen.push(it.id);
  // seen が肥大化しすぎるので最新1000件に制限
  state.seen = state.seen.slice(-1000);
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2) + '\n', 'utf8');
}

const items = await fetchItems();
if (items.length === 0) {
  console.log('No new items in lookback window.');
  process.exit(0);
}

const md = buildMarkdown(items);
const out = writePost(md);
saveState(items);
console.log('Wrote:', path.relative(ROOT, out));
