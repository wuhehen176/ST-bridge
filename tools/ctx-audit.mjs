#!/usr/bin/env node
/**
 * ctx-audit v3 —— 上下文账本（只读）
 *
 * v2 → v3 修正：
 *   1. 固定规则表头与数据行对齐（不再输出正文片段：规则属私有内容，测试锁死）
 *   2. 缓存命中同时读 usage 顶层（别名修好后数据落在这里）与 diagnostics
 *   3. 显示 cacheCoverage，避免 reported/partial 被读成"全部命中"
 *   4. 新增 usage 序列骤降检测；不据此推断上下文被重建
 *
 * 口径纪律：
 *   [实测] 直接来自桥接记录的 usage
 *   [估算] 正则推断分段，只用于排序
 *   [未知] 上游没给，绝不按 0 计
 *
 * 用法：node ctx-audit.mjs [--state path] [--prompt dump.json] [--json out.json]
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const args = process.argv.slice(2);
const flag = (name, def = null) => {
  const i = args.indexOf(`--${name}`);
  if (i < 0) return def;
  const v = args[i + 1];
  return v && !v.startsWith('--') ? v : true;
};
const STATE = flag('state', path.join(os.homedir(), '.dsh', 'st-bridge', 'state.json'));
const PROMPT = flag('prompt', null);
const RATIO = Number(flag('ratio', 1.5)) || 1.5;
const OUT = flag('json', null);

const est = (n) => Math.ceil(n / RATIO);
const pad = (s, n) => String(s ?? '-').padEnd(n);
const lpad = (s, n) => String(s ?? '-').padStart(n);
const num = (v) => (typeof v === 'number' ? v.toLocaleString() : '未知');
const bar = (r, w = 22) => '█'.repeat(Math.max(0, Math.min(w, Math.round(r * w))));
const pct = (v, total) => (total ? Math.round((v / total) * 100) + '%' : '-');

const RULES = [
  ['图片-Layout JSON', /"layout"\s*:|"cells"\s*:|"caption"\s*:/],
  ['纪要 AM 表', /\bAM\d{3,4}\b/],
  ['选项 Opt1-6', /(?:^|\n)\s*(?:Opt|选项)\s*[1-6]/],
  ['记账 patch', /json_patch|update_analysis|tableEdit|"changes"\s*:/],
  ['思考 draft/think', /<\/?(?:think|draft)[\s>]|思考骨架/],
  ['系统规则', /规范|契约|<meta>|^#\s/m],
];
const classify = (t) => (!t ? '空' : RULES.find(([, re]) => re.test(t))?.[0] ?? '正文/对白');

// ---------------------------------------------------------------- 单轮账目
function dig(r) {
  const u = r.usage || {};
  const d = u.diagnostics || r.diagnostics || null;
  // 缓存优先取 usage 顶层：别名表修好（cacheReadTokens）后数据会落在这里
  const topCache = typeof u.prompt_cache_hit_tokens === 'number'
    ? u.prompt_cache_hit_tokens
    : typeof u.prompt_tokens_details?.cached_tokens === 'number'
      ? u.prompt_tokens_details.cached_tokens
      : null;
  const diagCache = typeof d?.cacheHitTokens === 'number' ? d.cacheHitTokens : null;
  const cache = topCache ?? diagCache;
  const prompt = typeof u.prompt_tokens === 'number' ? u.prompt_tokens : null;
  const completion = typeof u.completion_tokens === 'number' ? u.completion_tokens : null;
  const totalTokens = typeof u.total_tokens === 'number' ? u.total_tokens : null;

  // prompt_tokens 到底含不含缓存，不能猜：先用 adapterUsage 直接比对改写前后，
  // 没有就退回账目方程（total = 输入 + 输出）。
  let semantics = 'unknown';
  const ad = d?.usageRecords?.[0]?.adapterUsage;
  if (ad && typeof ad.inputTokens === 'number' && prompt !== null) {
    const inclusive = ad.inputTokens + (ad.cacheReadTokens ?? 0) + (ad.cacheWriteTokens ?? 0);
    if (prompt === inclusive) semantics = 'inclusive';
    else if (prompt === ad.inputTokens) semantics = 'exclusive';
  }
  if (semantics === 'unknown' && prompt !== null && totalTokens !== null && completion !== null) {
    if (totalTokens === prompt + completion) semantics = 'inclusive';
    else if (cache !== null && totalTokens === prompt + cache + completion) semantics = 'exclusive';
  }

  const totalInput = semantics === 'inclusive' ? prompt
    : semantics === 'exclusive' ? prompt + (cache ?? 0)
      : null;
  const uncached = semantics === 'inclusive' && cache !== null ? prompt - cache : prompt;
  return {
    prompt,
    cache,
    cacheKnown: cache !== null,
    semantics,
    totalInput,
    uncached,
    completion,
    totalTokens,
    cacheShare: totalInput && cache !== null ? cache / totalInput : null,
    usageEventCount: d?.usageEventCount ?? null,
    modelCallCount: d?.modelCallCount ?? null,
    maxPromptTokens: d?.maxPromptTokens ?? null,
    maxUsageEventPromptTokens: d?.maxUsageEventPromptTokens ?? null,
    cacheHitTokens: topCache ?? diagCache,
    cacheReporting: topCache !== null ? 'reported' : (d?.cacheReporting ?? 'unavailable'),
    cacheCoverage: d?.cacheCoverage ?? (topCache !== null ? 'unknown' : 'none'),
  };
}

function auditState(file) {
  if (!fs.existsSync(file)) {
    console.error(`找不到 ${file}\n先跑一轮酒馆生成，或 --state 指定路径`);
    process.exit(1);
  }
  const raw = fs.readFileSync(file, 'utf8');
  const state = JSON.parse(raw);
  const report = { file, at: new Date().toISOString(), ratio: RATIO, chats: [] };

  for (const [key, chat] of Object.entries(state.chats || {})) {
    const reqs = Object.entries(chat.requests || {})
      .map(([id, v]) => ({ id, ...v }))
      .filter((r) => r.usage)
      .sort((a, b) => (a.turn ?? 0) - (b.turn ?? 0));
    if (!reqs.length) continue;

    const rows = reqs.map((r) => ({ turn: r.turn, action: r.action, ...dig(r) }));
    // 中位数按记录值（未缓存输入）算，保持与历史序列可比；总输入单列另算
    const prompts = rows.map((r) => r.prompt).filter((v) => typeof v === 'number');
    const sorted = [...prompts].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    const median = sorted.length
      ? (sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2)
      : null;

    console.log(`\n${'═'.repeat(104)}`);
    console.log(`会话 ${key.slice(0, 74)}`);
    console.log(`预设 ${chat.agentPreset || '-'} ｜ 模型 ${chat.model || '-'} ｜ 轮次 ${rows.length}`);
    console.log(`\n[实测] 新记录 prompt_tokens 已含缓存，未缓存 = prompt − 缓存读取；旧记录无缓存字段，一律显示未知。`);
    console.log(`\n${pad('#', 4)}${lpad('未缓存', 10)}${lpad('缓存读取', 10)}${lpad('总输入', 10)}${lpad('命中率', 7)}${lpad('compl', 8)}${lpad('倍数', 7)}` +
      `${lpad('事件数', 8)}${lpad('调用数', 8)}${lpad('单次最大', 9)}${lpad('缓存覆盖', 9)}  备注`);
    console.log('-'.repeat(110));

    for (const r of rows) {
      const x = median > 0 && r.uncached !== null ? (r.uncached / median).toFixed(1) : '-';
      // 只有整段都没命中才报警；命中率随上下文增长而下降是正常现象
      const cacheMiss = r.cache === 0 && r.totalInput !== null && r.totalInput >= 100000;
      const note = r.action === 'regenerate' ? 'regenerate' : cacheMiss ? '⚠ 缓存未命中' : '';
      console.log(
        `${pad(r.turn, 4)}${lpad(num(r.uncached), 10)}${lpad(num(r.cache), 10)}` +
          `${lpad(r.totalInput !== null ? num(r.totalInput) : '未知', 10)}` +
          `${lpad(r.cacheShare === null ? '-' : Math.round(r.cacheShare * 100) + '%', 7)}` +
          `${lpad(num(r.completion), 8)}${lpad(x, 7)}${lpad(num(r.usageEventCount), 8)}${lpad(num(r.modelCallCount), 8)}` +
          `${lpad(num(r.maxPromptTokens), 9)}${lpad(r.cacheReporting === 'unavailable' ? '-' : r.cacheCoverage, 9)}  ${note}`,
      );
    }

    const uncachedSum = rows.reduce((a, r) => a + (r.uncached ?? 0), 0);
    const known = rows.filter((r) => r.totalInput !== null);
    const cacheSum = known.reduce((a, r) => a + (r.cache ?? 0), 0);
    const totalInputSum = known.reduce((a, r) => a + (r.totalInput ?? 0), 0);
    const total = rows.reduce((a, r) => a + (r.prompt ?? 0) + (r.completion ?? 0), 0);
    const misses = known.filter((r) => (r.totalInput ?? 0) >= 100000 && (r.cacheShare ?? 0) < 0.5);
    const hasDiag = rows.some((r) => r.modelCallCount !== null || r.usageEventCount !== null);
    console.log('-'.repeat(110));
    console.log(
      `记录值累计 ${uncachedSum.toLocaleString()}（${prompts.length}/${rows.length} 条有记录）｜ 输入输出小计 ${total.toLocaleString()} ｜ ` +
        `中位 ${num(median)} ｜ 最大 ${num(prompts.length ? Math.max(...prompts) : null)}`,
    );
    if (known.length) {
      console.log(
        `含缓存总输入累计 ${totalInputSum.toLocaleString()}（${known.length}/${rows.length} 条有缓存字段）｜ 其中缓存 ${cacheSum.toLocaleString()}｜ ` +
          `总命中率 ${totalInputSum ? Math.round((cacheSum / totalInputSum) * 100) : '未知'}%` +
          (misses.length
            ? `\n缓存未命中 ${misses.length} 轮（轮次 ${misses.map((m) => m.turn).join('、')}）：这些轮的大输入按未缓存计费`
            : ''),
      );
    } else {
      console.log(`含缓存总输入：未知 —— 这批记录没有缓存字段，未缓存输入不等于总输入，不能与修正后的记录比较趋势。`);
    }

    // ---- 记录值骤降不等于上下文减少：可能只是这一轮缓存命中了
    const drops = [];
    for (let i = 1; i < rows.length; i++) {
      const prev = rows[i - 1].prompt;
      const cur = rows[i].prompt;
      if (typeof prev === 'number' && typeof cur === 'number' && prev >= 100000 && cur <= prev * 0.1) {
        drops.push({ from: rows[i - 1].turn, to: rows[i].turn, prev, cur });
      }
    }
    if (drops.length) {
      console.log(`\n⚠ 记录值骤降 ${drops.length} 处（需核对缓存口径、调用次数和会话事件，不能据此判定上下文重建）：`);
      for (const d of drops) {
        console.log(`   轮 ${d.from} → ${d.to}：${d.prev.toLocaleString()} → ${d.cur.toLocaleString()}（记录值比 ${Math.round((d.cur / d.prev) * 100)}%）`);
      }
    }

    if (!hasDiag) {
      console.log(`\n诊断字段：未知 —— 历史记录无法凭空补出调用边界；诊断补丁生效后再观察新请求。`);
    } else {
      const last = rows.at(-1);
      console.log(`\n缓存口径：${last?.cacheReporting ?? 'unavailable'}／覆盖 ${last?.cacheCoverage ?? 'none'}` +
        (last?.cacheReporting === 'unavailable' ? '（上游未提供，按未知计，不按 0）' : ''));
      console.log(`注意：旧版本可能将不含缓存的 inputTokens 记为 prompt_tokens。旧数据不会自动修正；complete 仅指字段覆盖完整，不代表全部输入都命中缓存。`);
    }

    // ---- 固定系统前缀（只出体积，不出正文）
    const fr = (Array.isArray(chat.fixedRules) && chat.fixedRules.length ? chat.fixedRules : reqs.at(-1)?.fixedRules) ?? [];
    if (fr.length) {
      const sumChars = fr.reduce((a, c) => a + (c.text?.length ?? 0), 0);
      console.log(`\n[实测] 当前保存的固定规则 ${fr.length} 段 / ${sumChars.toLocaleString()} UTF-16 码元；[估算] ≈ ${est(sumChars).toLocaleString()} tokens。不代表历史每轮最终模型输入。`);
      console.log(`${pad('段', 4)}${pad('类型', 11)}${lpad('字符', 8)}${lpad('≈token', 9)}${lpad('占比', 7)}`);
      for (const [i, c] of fr.entries()) {
        const n = c.text?.length ?? 0;
        console.log(
          `${pad(i, 4)}${pad(c.type || c.role, 11)}${lpad(n.toLocaleString(), 8)}${lpad(est(n).toLocaleString(), 9)}` +
            `${lpad(pct(n, sumChars), 7)}`,
        );
      }
    }

    const dupBytes = reqs.reduce((a, r) => a + Buffer.byteLength(JSON.stringify(r.fixedRules ?? []), 'utf8'), 0);
    console.log(`\n[实测] ${reqs.length} 份请求记录的 fixedRules 序列化体积 ≈ ${Math.round(dupBytes / 1024)}KB（未判断内容是否重复）`);

    report.chats.push({
      key, preset: chat.agentPreset, model: chat.model, total, median, rows, drops,
      fixedPrefixChars: fr.reduce((a, c) => a + (c.text?.length ?? 0), 0),
    });
  }
  return report;
}

// ---------------------------------------------------------------- 载荷分项（估算）
function auditPrompt(file) {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  const msgs = Array.isArray(raw) ? raw : raw.messages || raw.chat || [];
  if (!msgs.length) return null;
  const g = new Map();
  for (const m of msgs) {
    const t = typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? '');
    const k = classify(t);
    const e = g.get(k) || { k, n: 0, c: 0 };
    e.n++; e.c += t.length;
    g.set(k, e);
  }
  const totalChars = [...g.values()].reduce((a, e) => a + e.c, 0);
  console.log(`\n${'═'.repeat(104)}\n[估算(启发式)] 载荷 ${path.basename(file)} ｜ ${msgs.length} 条 ｜ ${totalChars.toLocaleString()} 字符`);
  console.log('  分项靠正则推断来源，只用来排序，不要用于归因。\n');
  console.log(`${pad('分段', 18)}${lpad('条数', 6)}${lpad('字符', 9)}${lpad('≈token', 9)}${lpad('占比', 7)}`);
  for (const e of [...g.values()].sort((a, b) => b.c - a.c)) {
    console.log(`${pad(e.k, 18)}${lpad(e.n, 6)}${lpad(e.c.toLocaleString(), 9)}${lpad(est(e.c).toLocaleString(), 9)}${lpad(pct(e.c, totalChars), 7)}  ${bar(e.c / totalChars)}`);
  }
  return { file, totalChars, groups: [...g.values()] };
}

const report = auditState(STATE);
if (PROMPT) report.prompt = auditPrompt(PROMPT);
if (OUT) { fs.writeFileSync(OUT, JSON.stringify(report, null, 2)); console.log(`\n已写出 ${OUT}`); }
console.log('');
