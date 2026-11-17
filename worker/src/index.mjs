/**
 * locke-world-battle-ai-api
 * 洛克王国：世界 对战分析 Worker（Cloudflare Workers AI，免费额度，无外部 Key）
 *
 *   GET  /health          健康检查与模型列表
 *   GET  /models          可用模型（本账号实测可用的免费模型）
 *   GET  /spirit/:key     图鉴数据 + 确定性强度指标（服务器端核验）
 *   POST /analyze         { mode: "spirit" | "team" | "battle", ... } AI 分析
 */
import meta from '../../src/data/meta.json';
import { findSpirit, matchup, multiplierText, TYPE_ORDER } from './data.mjs';
import { bestHit, duelMetrics, spiritLine, spiritMetrics, teamMetrics } from './analysis.mjs';
import { buildMessages, checkGrounding } from './prompts.mjs';
import { teamThreats } from './damage.mjs';
import { DEFAULT_MODEL, MODELS, chat, friendlyAiError, llmProvider, modelLabel, parseSections, resolveModel } from './ai.mjs';

const VERSION = '2.1.0';
const PROD_ORIGIN = 'https://locke-world-battle-ai.pages.dev';
const MAX_BODY_BYTES = 16 * 1024;

/* ------------------------------------------------------------ CORS */

function allowedOrigin(origin, env) {
  if (!origin) return '*';
  if (origin === PROD_ORIGIN) return origin;
  if (/^https:\/\/[a-z0-9-]+\.locke-world-battle-ai\.pages\.dev$/.test(origin)) return origin;
  if (/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) return origin;
  const extra = String(env.ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return extra.includes(origin) ? origin : null;
}

function corsHeaders(origin) {
  const h = {
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'access-control-allow-headers': 'content-type',
    'access-control-max-age': '86400',
    vary: 'origin',
  };
  if (origin) h['access-control-allow-origin'] = origin;
  return h;
}

function json(data, { status = 200, origin = '*', extra = {} } = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      ...corsHeaders(origin),
      ...extra,
    },
  });
}

/* ------------------------------------------------------------ 轻量限流（单 isolate 内） */

const hits = new Map();
const WINDOW_MS = 60 * 60 * 1000;
const LIMIT = 120;

function rateLimit(ip) {
  const now = Date.now();
  const rec = hits.get(ip);
  if (!rec || now > rec.reset) {
    hits.set(ip, { count: 1, reset: now + WINDOW_MS });
    return { ok: true, remaining: LIMIT - 1 };
  }
  rec.count += 1;
  if (rec.count > LIMIT) return { ok: false, remaining: 0, reset: rec.reset };
  return { ok: true, remaining: LIMIT - rec.count };
}

/* ------------------------------------------------------------ 数据整理 */

function modelList() {
  return MODELS.map((m) => ({ ...m, free: true }));
}

function healthPayload(env) {
  return {
    ok: true,
    service: 'locke-world-battle-ai-api',
    version: VERSION,
    provider: llmProvider(env),
    defaultModel: resolveModel(null, env.DEFAULT_MODEL),
    models: modelList(),
    modelCount: MODELS.length,
    counts: {
      spirits: meta.spiritCount,
      types: TYPE_ORDER.length,
      skills: meta.coverage.uniqueLearnableSkills,
    },
    data: { source: 'BWIKI', fetchedAt: meta.fetchedAt },
    free: { workersAi: true, externalKeyRequired: false, paidAddons: false },
  };
}

function resolveTeam(ids, fieldName) {
  const arr = Array.isArray(ids) ? ids : [];
  if (arr.length === 0) {
    return { error: { code: 'empty_team', message: `${fieldName} 至少选择 1 只精灵` } };
  }
  if (arr.length > 6) {
    return { error: { code: 'team_too_large', message: `${fieldName} 最多 6 只精灵` } };
  }
  const out = [];
  for (const raw of arr) {
    const s = typeof raw === 'string' ? raw : raw?.id ?? raw?.name;
    const found = resolveOne(s);
    if (!found) return { error: { code: 'unknown_spirit', message: `${fieldName} 中找不到精灵：${String(raw)}` } };
    if (!out.some((x) => x.id === found.id)) out.push(found);
  }
  return { list: out };
}

function resolveOne(key) {
  return findSpirit(key);
}

/* ------------------------------------------------------------ 分析主流程 */

async function handleAnalyze(request, env, origin) {
  let body;
  try {
    const raw = await request.text();
    if (raw.length > MAX_BODY_BYTES) {
      return json({ ok: false, error: { code: 'body_too_large', message: '请求体过大' } }, { status: 413, origin });
    }
    body = raw ? JSON.parse(raw) : {};
  } catch {
    return json({ ok: false, error: { code: 'bad_json', message: '请求体不是合法 JSON' } }, { status: 400, origin });
  }

  const mode = body.mode === 'spirit' || body.mode === 'battle' ? body.mode : 'team';
  const requestedModel = typeof body.model === 'string' ? body.model.trim() : '';
  const model = resolveModel(body.model, env.DEFAULT_MODEL);
  const modelFallback = Boolean(requestedModel && requestedModel !== model);
  const started = Date.now();

  let ctx;
  let deterministic;
  let ctxNames = {};

  if (mode === 'spirit') {
    const spirit = resolveOne(body.spiritId ?? body.spirit ?? body.name);
    if (!spirit) {
      return json(
        { ok: false, error: { code: 'unknown_spirit', message: `找不到精灵：${body.spiritId ?? body.spirit ?? ''}` } },
        { status: 400, origin },
      );
    }
    ctx = { spirit };
    ctxNames = { focus: spirit.name, mine: [] };
    const metrics = spiritMetrics(spirit);
    const enemy = body.enemyId ? resolveOne(body.enemyId) : null;
    deterministic = {
      spirit: spiritLine(spirit),
      metrics,
      ...(enemy ? { duel: duelMetrics(spirit, enemy) } : {}),
    };
  } else {
    const mine = resolveTeam(body.myTeam, 'myTeam');
    if (mine.error) return json({ ok: false, error: mine.error }, { status: 400, origin });
    const theirs = resolveTeam(body.enemyTeam, 'enemyTeam');
    if (theirs.error) return json({ ok: false, error: theirs.error }, { status: 400, origin });
    ctx = { myTeam: mine.list, enemyTeam: theirs.list };
    const teamM = teamMetrics(mine.list, theirs.list);
    ctxNames = {
      mine: mine.list.map((s) => s.name),
      enemy: theirs.list.map((s) => s.name),
      matrix: teamM.matrix,
    };
    deterministic = {
      mine: mine.list.map(spiritLine),
      enemy: theirs.list.map(spiritLine),
      team: teamM,
      threats: teamThreats(mine.list, theirs.list),
      ...(mine.list.length === 1 && theirs.list.length === 1 ? { duel: duelMetrics(mine.list[0], theirs.list[0]) } : {}),
    };
  }

  const { messages, facts } = buildMessages(mode === 'battle' ? 'team' : mode, ctx);
  const factsHash = await shortHash(facts);

  let first;
  try {
    first = await chat(env, model, messages, { temperature: 0.3 });
  } catch (e) {
    const friendly = friendlyAiError(e);
    return json(
      {
        ok: false,
        mode,
        provider: llmProvider(env),
        model,
        modelLabel: modelLabel(model),
        requestedModel: requestedModel || null,
        modelFallback,
        error: friendly,
        deterministic,
        hint: friendly.code === 5035 ? '请选择免费模型（/models 列表内）' : undefined,
        elapsedMs: Date.now() - started,
      },
      { status: 502, origin },
    );
  }

  let used = first;
  let check = checkGrounding(first.text, facts, ctxNames);
  let retried = false;

  if (!check.grounded) {
    retried = true;
    const issues = [
      check.unverifiedNumbers.length ? `事实中没有的数字：${check.unverifiedNumbers.join('、')}` : '',
      check.typeIssues.length ? `不存在的属性：${check.typeIssues.join('、')}` : '',
      check.unknownTerms?.length ? `事实中没有的${check.unknownTerms.map((t) => `${t.kind}「${t.term}」`).join('、')}` : '',
      check.outOfTeam?.length ? `不在我方阵容里的精灵：${check.outOfTeam.join('、')}` : '',
      check.switchIssues?.length
        ? `与对位表矛盾的换人：${check.switchIssues
            .slice(0, 4)
            .map((x) => `对${x.enemy}换上${x.member}（进攻${x.attack}倍、受威胁${x.threat}倍）`)
            .join('；')}`
        : '',
    ]
      .filter(Boolean)
      .join('；');
    const correction = `你上一次回答用到了${issues}。请严格只使用【已核验事实】中出现的数字和属性，重新输出同样格式的完整回答，不要解释这次修改。`;
    try {
      const second = await chat(
        env,
        model,
        [...messages, { role: 'assistant', content: first.text }, { role: 'user', content: correction }],
        { temperature: 0.2 },
      );
      const secondCheck = checkGrounding(second.text, facts, ctxNames);
      const issueCount = (c) => c.unverifiedNumbers.length + c.typeIssues.length;
      if (second.text.trim() && issueCount(secondCheck) <= issueCount(check)) {
        used = second;
        check = secondCheck;
      }
    } catch {
      /* 重试失败就保留第一次的回答与校验结果 */
    }
  }

  const parsed = parseSections(used.text);
  return json(
    {
      ok: true,
      mode,
      provider: used.provider,
      model: used.model,
      modelLabel: modelLabel(used.model),
      requestedModel: requestedModel || null,
      modelFallback,
      answer: {
        headline: parsed.headline,
        sections: parsed.sections,
        text: used.text,
        chars: used.text.length,
      },
      deterministic,
      verification: {
        ...check,
        retried,
        factsHash,
        note: check.grounded ? '回答中的数字、属性与名称均可在图鉴事实中溯源' : '部分数字、属性或名称未能在图鉴事实中溯源，已标注',
      },
      usage: used.usage,
      elapsedMs: Date.now() - started,
      free: true,
      paidFeatures: false,
    },
    { origin },
  );
}

async function shortHash(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf).slice(0, 8)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/* ------------------------------------------------------------ 路由 */

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = allowedOrigin(request.headers.get('origin'), env);

    if (request.method === 'OPTIONS') {
      if (!origin) return new Response('origin not allowed', { status: 403 });
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    if (!origin) {
      return json({ ok: false, error: { code: 'origin_not_allowed', message: '该来源不在允许列表内' } }, { status: 403, origin: null });
    }

    const path = url.pathname.replace(/\/+$/, '') || '/';

    try {
      if (request.method === 'GET' && (path === '/' || path === '')) {
        return json(
          {
            ok: true,
            service: 'locke-world-battle-ai-api',
            version: VERSION,
            endpoints: ['GET /health', 'GET /models', 'GET /spirit/:key', 'POST /analyze'],
            docs: 'https://github.com/Viopnmk/-locke-world-battle-ai#phase-2',
          },
          { origin },
        );
      }

      if (request.method === 'GET' && path === '/health') {
        return json(healthPayload(env), { origin });
      }

      if (request.method === 'GET' && path === '/models') {
        return json(
          {
            ok: true,
            provider: llmProvider(env),
            defaultModel: resolveModel(null, env.DEFAULT_MODEL),
            count: MODELS.length,
            models: modelList(),
            note: '以下模型已在本账号免费额度内实测可用；付费模型未启用。',
            verifiedAt: '2026-11-18',
          },
          { origin },
        );
      }

      if (request.method === 'GET' && path.startsWith('/spirit/')) {
        const key = decodeURIComponent(path.slice('/spirit/'.length));
        const spirit = resolveOne(key);
        if (!spirit) {
          return json({ ok: false, error: { code: 'unknown_spirit', message: `找不到精灵：${key}` } }, { status: 404, origin });
        }
        const metrics = spiritMetrics(spirit);
        const opponent = url.searchParams.get('vs') ? resolveOne(url.searchParams.get('vs')) : null;
        return json(
          {
            ok: true,
            spirit: spiritLine(spirit),
            metrics,
            ...(opponent
              ? {
                  vs: opponent.name,
                  matchup: {
                    attack: bestHit(spirit, opponent.type),
                    threat: bestHit(opponent, spirit.type),
                    speedEdge: (spirit.stats.spe ?? 0) - (opponent.stats.spe ?? 0),
                    multipliers: TYPE_ORDER.filter((t) => matchup(t, opponent.type) !== 1).map((t) => ({
                      type: t,
                      multiplier: matchup(t, opponent.type),
                      text: multiplierText(matchup(t, opponent.type)),
                    })),
                  },
                }
              : {}),
          },
          { origin },
        );
      }

      if (request.method === 'POST' && path === '/analyze') {
        const ip = request.headers.get('cf-connecting-ip') ?? 'unknown';
        const rl = rateLimit(ip);
        if (!rl.ok) {
          return json(
            { ok: false, error: { code: 'rate_limited', message: '请求太频繁，请稍后再试' } },
            { status: 429, origin, extra: { 'retry-after': '600' } },
          );
        }
        return await handleAnalyze(request, env, origin);
      }

      return json({ ok: false, error: { code: 'not_found', message: `没有这个接口：${request.method} ${path}` } }, { status: 404, origin });
    } catch (e) {
      return json(
        { ok: false, error: { code: 'internal_error', message: String((e && e.message) || e) } },
        { status: 500, origin },
      );
    }
  },
};
