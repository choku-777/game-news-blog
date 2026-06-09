#!/usr/bin/env node
// 記事JSONを WordPress REST API に下書き(draft)投稿し、成功したら state.json に記録する。
//
// 使い方:
//   node scripts/post.mjs <article.json>
//
// article.json の形式:
//   {
//     "title":     "記事タイトル",
//     "content":   "<p>本文HTML</p> ...（末尾に出典リンク）",
//     "status":    "draft",          // 省略可。既定 draft
//     "sourceUrl": "https://...",    // dedupe用。state.json に記録される
//     "source":    "媒体名"          // 任意（ログ用）
//   }
//
// 必要な環境変数: WP_URL / WP_USER / WP_APP_PASSWORD
//   （リポジトリ直下に .env があれば自動で読み込む）

import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const STATE_PATH = join(ROOT, "data", "state.json");
const ENV_PATH = join(ROOT, ".env");

// --- .env を簡易ロード（dotenv 不使用、既存の環境変数は上書きしない） ---
async function loadEnv() {
  let text;
  try {
    text = await readFile(ENV_PATH, "utf8");
  } catch {
    return;
  }
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let val = trimmed.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = val;
  }
}

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

async function recordPosted(sourceUrl) {
  if (!sourceUrl) return;
  let state;
  try {
    state = JSON.parse(await readFile(STATE_PATH, "utf8"));
  } catch {
    state = { postedUrls: [], lastRun: null };
  }
  if (!Array.isArray(state.postedUrls)) state.postedUrls = [];
  const norm = normalizeUrl(sourceUrl);
  if (!state.postedUrls.includes(norm)) state.postedUrls.push(norm);
  state.lastRun = new Date().toISOString();
  await writeFile(STATE_PATH, JSON.stringify(state, null, 2) + "\n", "utf8");
}

async function main() {
  await loadEnv();

  const argPath = process.argv[2];
  if (!argPath) {
    console.error("使い方: node scripts/post.mjs <article.json>");
    process.exit(1);
  }

  const { WP_URL, WP_USER, WP_APP_PASSWORD } = process.env;
  if (!WP_URL || !WP_USER || !WP_APP_PASSWORD) {
    console.error(
      "環境変数が不足しています。WP_URL / WP_USER / WP_APP_PASSWORD を設定してください（.env または環境変数）。"
    );
    process.exit(1);
  }

  const article = JSON.parse(await readFile(resolve(argPath), "utf8"));
  if (!article.title || !article.content) {
    console.error("article.json には title と content が必要です。");
    process.exit(1);
  }

  // アプリケーションパスワードはスペース込みで発行されるが、Basic認証では除去して使う
  const appPassword = WP_APP_PASSWORD.replace(/\s+/g, "");
  const auth = Buffer.from(`${WP_USER}:${appPassword}`).toString("base64");
  const endpoint = `${WP_URL.replace(/\/$/, "")}/wp-json/wp/v2/posts`;

  const res = await fetch(endpoint, {
    method: "POST",
    headers: {
      Authorization: `Basic ${auth}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      title: article.title,
      content: article.content,
      status: article.status || "draft",
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    console.error(`投稿失敗 (HTTP ${res.status}): ${body}`);
    process.exit(1);
  }

  const created = await res.json();
  await recordPosted(article.sourceUrl);

  console.log(
    `投稿成功 [${article.status || "draft"}] id=${created.id} "${article.title}"`
  );
  if (created.link) console.log(`  -> ${created.link}`);
}

main().catch((err) => {
  console.error("post failed:", err);
  process.exit(1);
});
