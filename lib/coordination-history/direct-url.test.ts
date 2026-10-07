/**
 * `direct-url.ts` 的反例集：纯 Node，不连库、不读 .env。
 *
 * 运行：`pnpm.cmd exec tsx lib/coordination-history/direct-url.test.ts`
 *
 * 这里证明的只有「字符串推导对不对」。**地址推出来之后到底连不连得上，
 * 这里证明不了**——那要真去连一次（见 `change-feed.ts`）。
 */

import assert from "node:assert/strict";

import { resolveDirectUrl, toDirectUrl } from "./direct-url";

const POOLED =
  "postgres://willing:secret@ep-cool-1234-pooler.us-east-2.aws.neon.tech/neondb?sslmode=require";
const DIRECT =
  "postgres://willing:secret@ep-cool-1234.us-east-2.aws.neon.tech/neondb?sslmode=require";

function main() {
  let passed = 0;
  const check = (name: string, fn: () => void) => {
    fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  };

  // ── ① 池化 → 直连：只动主机名 ───────────────────────────────────────────
  check("Neon 池化主机去掉 -pooler，用户名/密码/库名/参数原样", () => {
    const out = toDirectUrl(POOLED);
    assert.equal(out, DIRECT);
    assert.ok(out?.includes("willing:secret@"), "凭据要原样带走：池化和直连共用");
    assert.ok(out?.includes("?sslmode=require"), "查询参数丢了这个地址就用不了");
  });

  // ── ② 本来就是直连的：原样返回 ──────────────────────────────────────────
  check("已经是直连的 Neon 主机不动它", () => {
    assert.equal(toDirectUrl(DIRECT), DIRECT);
  });

  // ── ③ 只认 Neon：别的主机名里出现 -pooler 是巧合 ────────────────────────
  check("非 Neon 主机即使带 -pooler 也不改（不猜主机名）", () => {
    const other = "postgres://u:p@db-pooler.internal:5432/app";
    assert.equal(toDirectUrl(other), other);
  });

  check("Neon 的新式主机名（-pooler 后面还有一段）也对", () => {
    assert.equal(
      toDirectUrl(
        "postgres://u@ep-x-pooler.c-3.us-east-2.aws.neon.tech/db"
      ),
      "postgres://u@ep-x.c-3.us-east-2.aws.neon.tech/db"
    );
  });

  // ── ④ 别把 mysql / http 当成数据库地址 ─────────────────────────────────
  check("不是 postgres 协议的一律 null", () => {
    assert.equal(
      toDirectUrl("mysql://u@ep-x-pooler.us-east-2.aws.neon.tech/db"),
      null
    );
    assert.equal(
      toDirectUrl("http://ep-x-pooler.us-east-2.aws.neon.tech"),
      null
    );
    assert.equal(toDirectUrl(""), null);
    assert.equal(toDirectUrl("这不是个地址"), null);
  });

  // ── ⑤ 优先级 ────────────────────────────────────────────────────────────
  check("显式给了非池化键就用它，不再推导", () => {
    assert.equal(
      resolveDirectUrl({
        POSTGRES_URL_NON_POOLING: DIRECT,
        DATABASE_URL_UNPOOLED: "postgres://u@other.neon.tech/db",
        POSTGRES_URL: POOLED,
      }),
      DIRECT
    );
    assert.equal(
      resolveDirectUrl({
        DATABASE_URL_UNPOOLED: "postgres://u@other.neon.tech/db",
        POSTGRES_URL: POOLED,
      }),
      "postgres://u@other.neon.tech/db"
    );
  });

  check("两个显式键都没有时，从 POSTGRES_URL 推", () => {
    assert.equal(resolveDirectUrl({ POSTGRES_URL: POOLED }), DIRECT);
  });

  // ── ⑥ 显式的那个键本身是垃圾：别拿它去连 ────────────────────────────────
  check("显式键不是 postgres 地址 → 跳过它，落到推导", () => {
    assert.equal(
      resolveDirectUrl({
        POSTGRES_URL_NON_POOLING: "http://打错了",
        POSTGRES_URL: POOLED,
      }),
      DIRECT
    );
  });

  check("一个地址都没有 → null（页面退回静态，不是崩掉）", () => {
    assert.equal(resolveDirectUrl({}), null);
    assert.equal(resolveDirectUrl({ POSTGRES_URL: "乱写的" }), null);
  });

  console.log(
    `\n直连地址推导：${passed} 项全过（零模型、零短信、零数据库、零 schema 改动）`
  );
}

main();
