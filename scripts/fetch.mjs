#!/usr/bin/env node
// RSS を取得し、既出を除外して data/incoming.json に新着候補を書き出す。
// state.json はここでは更新しない（投稿成功時に post.mjs が更新する）。

import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import Parser from "rss-parser";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const SOURCES_PATH = join(ROOT, "data", "sources.json");
const STATE_PATH = join(ROOT, "data", "state.json");
const INCOMING_PATH = join(ROOT, "data", "incoming.json");

// 直近この時間内に公開されたものを新着とみなす
const FRESH_WINDOW_HOURS = 36;
// incoming.json に書き出す候補の上限
const MAX_CANDIDATES = 20;
// フィード取得のタイムアウト(ms)
const FETCH_TIMEOUT_MS = 15000;

// URL を正規化（クエリ・フラグメント・末尾スラッシュを除去）して dedupe キーに使う
function normalizeUrl(raw) {
  if (!raw) return "";
  try {
    const u = new URL(raw.trim());
    u.hash = "";
    u.search = "";
    let s = u.toString();
    if (s.endsWith("/")) s = s.slice(0, -1);
    return s;
  } catch {
    return raw.trim();
  }
}

async function readJson(path, fallback) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return fallback;
  }
}

async function main() {
  const sources = await readJson(SOURCES_PATH, []);
  const state = await readJson(STATE_PATH, { postedUrls: [], lastRun: null });
  const seen = new Set((state.postedUrls || []).map(normalizeUrl));

  // 一部サイトは既定のUAを 403 で弾くため、ブラウザ風のヘッダを付与する
  const parser = new Parser({
    timeout: FETCH_TIMEOUT_MS,
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
      Accept: "application/rss+xml, application/xml, text/xml, */*",
    },
  });
  const cutoff = Date.now() - FRESH_WINDOW_HOURS * 60 * 60 * 1000;

  const candidates = [];
  for (const src of sources) {
    try {
      const feed = await parser.parseURL(src.url);
      const items = feed.items || [];
      let added = 0;
      for (const item of items) {
        const link = normalizeUrl(item.link);
        if (!link || seen.has(link)) continue;

        const dateStr = item.isoDate || item.pubDate || null;
        const ts = dateStr ? Date.parse(dateStr) : NaN;
        // 日付が取れない場合は新着扱いで残す（後段で人/AIが判断）
        if (!Number.isNaN(ts) && ts < cutoff) continue;

        const snippet = (item.contentSnippet || item.content || "")
          .replace(/\s+/g, " ")
          .trim()
          .slice(0, 500);

        candidates.push({
          title: (item.title || "").trim(),
          link,
          snippet,
          isoDate: dateStr,
          source: src.name,
          lang: src.lang || "ja",
          category: src.category || "",
        });
        added++;
      }
      console.log(`[ok]   ${src.name}: ${added} new (of ${items.length})`);
    } catch (err) {
      console.warn(`[skip] ${src.name}: ${err.message}`);
    }
  }

  // 日付降順（日付不明は末尾）に並べて上限でカット
  candidates.sort((a, b) => {
    const ta = a.isoDate ? Date.parse(a.isoDate) : 0;
    const tb = b.isoDate ? Date.parse(b.isoDate) : 0;
    return tb - ta;
  });
  const selected = candidates.slice(0, MAX_CANDIDATES);

  await writeFile(
    INCOMING_PATH,
    JSON.stringify(
      { generatedAt: new Date().toISOString(), count: selected.length, items: selected },
      null,
      2
    ) + "\n",
    "utf8"
  );

  console.log(`\n${selected.length} candidate(s) written to data/incoming.json`);
  if (selected.length === 0) {
    console.log("新着なし。投稿する記事はありません。");
  }
}

main().catch((err) => {
  console.error("fetch failed:", err);
  process.exit(1);
});
