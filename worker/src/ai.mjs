/**
 * Workers AI 调用：不写入任何密钥，运行时用 env.AI 绑定（免费额度）。
 * 也支持以后配置 OPENAI_BASE_URL / OPENAI_API_KEY / OPENAI_MODEL 的兼容网关。
 */
export const MODELS = [
  {
    id: '@cf/zai-org/glm-4.7-flash',
    label: 'GLM 4.7 Flash',
    note: '中文严谨、最贴数据，默认',
    recommended: true,
    params: { chat_template_kwargs: { enable_thinking: false } },
    maxTokens: 900,
  },
  {
    id: '@cf/openai/gpt-oss-20b',
    label: 'GPT-OSS 20B',
    note: '响应快、更活泼，备选',
    recommended: true,
    params: { reasoning_effort: 'low' },
    maxTokens: 900,
  },
  {
    id: '@cf/meta/llama-4-scout-17b-16e-instruct',
    label: 'Llama 4 Scout 17B',
    note: '综合均衡，输出稳定',
    recommended: true,
    params: {},
    maxTokens: 900,
  },
  {
    id: '@cf/mistralai/mistral-small-3.1-24b-instruct',
    label: 'Mistral Small 3.1 24B',
    note: '结构清晰，稍慢',
    recommended: false,
    params: {},
    maxTokens: 900,
  },
  {
    id: '@cf/meta/llama-3.2-3b-instruct',
    label: 'Llama 3.2 3B',
    note: '极快，适合兜底',
    recommended: false,
    params: {},
    maxTokens: 800,
  },
  {
    id: '@cf/deepseek-ai/deepseek-r1-distill-qwen-32b',
    label: 'DeepSeek R1 Distill 32B',
    note: '慢思考，最细但耗时耗额度',
    recommended: false,
    params: {},
    maxTokens: 1800,
  },
];

export const DEFAULT_MODEL = MODELS[0].id;
const MODEL_IDS = new Set(MODELS.map((m) => m.id));

export function resolveModel(requested, fallback) {
  const want = String(requested ?? '').trim();
  if (want && MODEL_IDS.has(want)) return want;
  const def = String(fallback ?? '').trim();
  if (def && MODEL_IDS.has(def)) return def;
  return DEFAULT_MODEL;
}

export function modelLabel(id) {
  return MODELS.find((m) => m.id === id)?.label ?? id;
}

export function llmProvider(env) {
  if (env.OPENAI_BASE_URL && env.OPENAI_API_KEY) return 'openai-compatible';
  return 'workers-ai';
}

/** 把 Workers AI 的数字错误码翻译成用户能懂的话。 */
export function friendlyAiError(err) {
  const raw = String((err && err.message) || err || 'unknown error');
  const code = (raw.match(/\b(30\d\d|50\d\d)\b/) || [])[1];
  const map = {
    3040: '模型暂时繁忙，请稍后重试',
    3036: '今日免费额度（neurons）可能已用完，明天恢复',
    5035: '该模型需要付费计划，已自动留在免费模型列表之外',
    5018: '当前账号无权使用该模型',
    5019: '当前账号无权使用该模型',
    5028: '该模型未对当前账号开放',
    5007: '模型不存在或已下线',
    5027: '输入超出该模型上下文长度',
  };
  return {
    code: code ? Number(code) : null,
    message: (code && map[Number(code)]) || raw,
    raw,
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function runWithRetry(fn, attempts = 2) {
  let last;
  for (let i = 0; i < attempts; i += 1) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      const { code } = friendlyAiError(e);
      // 忙/限流才重试；权限、额度、模型不存在直接抛
      if (![3040, 3041, 3036].includes(code)) break;
      await sleep(800 * (i + 1));
    }
  }
  throw last;
}

function extractText(out) {
  if (!out) return { text: '', reasoning: '' };
  if (typeof out === 'string') return { text: out, reasoning: '' };
  if (typeof out.response === 'string') return { text: out.response, reasoning: out.reasoning ?? '' };
  const msg = out.choices?.[0]?.message;
  if (msg) {
    const text = msg.content || msg.reasoning_content || msg.reasoning || '';
    return { text, reasoning: msg.reasoning_content ?? msg.reasoning ?? '' };
  }
  if (typeof out.result?.response === 'string') return { text: out.result.response, reasoning: '' };
  return { text: '', reasoning: '' };
}

/**
 * 运行一次对话。返回 { text, reasoning, usage, provider, model }。
 * max_tokens 保持克制以节省免费 neurons。
 */
export async function chat(env, modelId, messages, { maxTokens, temperature = 0.3 } = {}) {
  const provider = llmProvider(env);
  const entry = MODELS.find((m) => m.id === modelId);
  const modelParams = entry?.params ?? {};
  const maxOut = maxTokens ?? entry?.maxTokens ?? 900;

  if (provider === 'openai-compatible') {
    const base = String(env.OPENAI_BASE_URL).replace(/\/$/, '');
    const model = String(env.OPENAI_MODEL || modelId);
    const res = await runWithRetry(() =>
      fetch(`${base}/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${env.OPENAI_API_KEY}`,
        },
        body: JSON.stringify({ model, messages, max_tokens: maxOut, temperature }),
        signal: AbortSignal.timeout(90000),
      }),
    );
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`upstream ${res.status}: ${body.slice(0, 300)}`);
    }
    const data = await res.json();
    const msg = data.choices?.[0]?.message ?? {};
    return {
      text: msg.content ?? '',
      reasoning: msg.reasoning ?? '',
      usage: data.usage ?? null,
      provider,
      model,
    };
  }

  if (!env.AI) throw new Error('Workers AI binding 未配置');
  const out = await runWithRetry(() =>
    env.AI.run(modelId, {
      messages,
      max_tokens: maxOut,
      temperature,
      stream: false,
      ...modelParams,
    }),
  );
  const { text, reasoning } = extractText(out);
  const visible = String(text).replace(/<think[\s\S]*?<\/think>/gi, '').trim() || String(text).trim();
  return {
    text: visible,
    reasoning,
    usage: out?.usage ?? null,
    provider,
    model: modelId,
  };
}

/** 把【标题】分段文本拆成结构化 sections，方便前端排版。 */
export function parseSections(text) {
  const clean = String(text ?? '').trim();
  if (!clean) return { headline: '（模型没有返回内容）', sections: [] };

  const lines = clean.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const sections = [];
  let current = null;
  const pushLine = (raw) => {
    const line = raw.replace(/^[-*•·]\s*/, '').replace(/^\d+[.、)]\s*/, '').trim();
    if (!line) return;
    if (current) current.lines.push(line);
  };

  for (const line of lines) {
    const m = line.match(/^[【\[]([^】\]]{1,12})[】\]]\s*(.*)$/);
    if (m) {
      current = { title: m[1].trim(), lines: [] };
      sections.push(current);
      if (m[2].trim()) pushLine(m[2]);
    } else if (current) {
      pushLine(line);
    } else {
      current = { title: '分析', lines: [] };
      sections.push(current);
      pushLine(line);
    }
  }

  const first = sections[0];
  const headline = (first?.lines[0] ?? clean.split(/[。\n]/)[0] ?? '').slice(0, 120);
  return { headline, sections: sections.filter((s) => s.lines.length > 0) };
}
