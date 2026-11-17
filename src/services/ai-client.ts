/**
 * Phase 2 客户端：调用 Cloudflare Worker（Workers AI，免费额度）。
 * 仓库里没有任何密钥：端点只是公开 URL，模型由 Worker 侧调用。
 */
const env = (import.meta as unknown as { env: Record<string, string | undefined> }).env ?? {};

/** 线上 Worker 地址；可用 VITE_AI_ENDPOINT 覆盖（例如本地 wrangler dev）。 */
export const DEFAULT_ENDPOINT = 'https://locke-world-battle-ai-api.2310566637.workers.dev';
export const aiEndpoint = (env.VITE_AI_ENDPOINT?.trim() || DEFAULT_ENDPOINT).replace(/\/$/, '');

export interface AiModel {
  id: string;
  label: string;
  note: string;
  recommended: boolean;
  free?: boolean;
}

/** Worker 不可达时用于下拉框的兜底（与 Worker /models 保持一致）。 */
export const FALLBACK_MODELS: AiModel[] = [
  { id: '@cf/openai/gpt-oss-20b', label: 'GPT-OSS 20B', note: '响应快、中文稳，默认', recommended: true, free: true },
  { id: '@cf/zai-org/glm-4.7-flash', label: 'GLM 4.7 Flash', note: '中文表达好，速度快', recommended: true, free: true },
  { id: '@cf/meta/llama-4-scout-17b-16e-instruct', label: 'Llama 4 Scout 17B', note: '综合均衡', recommended: true, free: true },
  { id: '@cf/mistralai/mistral-small-3.1-24b-instruct', label: 'Mistral Small 3.1 24B', note: '结构清晰，稍慢', recommended: false, free: true },
  { id: '@cf/meta/llama-3.2-3b-instruct', label: 'Llama 3.2 3B', note: '极快，适合兜底', recommended: false, free: true },
  { id: '@cf/deepseek-ai/deepseek-r1-distill-qwen-32b', label: 'DeepSeek R1 Distill 32B', note: '慢思考，耗时耗额度', recommended: false, free: true },
];

export const DEFAULT_MODEL = FALLBACK_MODELS[0].id;

export interface AiSection {
  title: string;
  lines: string[];
}

export interface AiVerification {
  grounded: boolean;
  numbersChecked: number;
  unverifiedNumbers: string[];
  typeIssues: string[];
  unknownTerms?: { term: string; kind: string }[];
  outOfTeam?: string[];
  retried?: boolean;
  factsHash?: string;
  note?: string;
}

export interface AiResult {
  ok: true;
  mode: 'spirit' | 'team' | 'battle';
  provider: string;
  model: string;
  modelLabel: string;
  answer: { headline: string; sections: AiSection[]; text: string; chars: number };
  verification: AiVerification;
  elapsedMs: number;
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number; neurons?: number } | null;
}

export class AiRequestError extends Error {
  code: string | number | null;
  status: number;
  constructor(message: string, code: string | number | null = null, status = 0) {
    super(message);
    this.name = 'AiRequestError';
    this.code = code;
    this.status = status;
  }
}

async function request<T>(path: string, init: RequestInit = {}, timeoutMs = 120000): Promise<T> {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${aiEndpoint}${path}`, {
      ...init,
      signal: controller.signal,
      headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
    });
    const text = await res.text();
    let data: unknown = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      /* 非 JSON（例如网关 5xx HTML） */
    }
    if (!res.ok) {
      const err = (data as { error?: { code?: string | number; message?: string } } | null)?.error;
      throw new AiRequestError(err?.message || `AI 接口返回 ${res.status}`, err?.code ?? null, res.status);
    }
    return data as T;
  } catch (e) {
    if (e instanceof AiRequestError) throw e;
    if (e instanceof DOMException && e.name === 'AbortError') {
      throw new AiRequestError('请求超时，模型可能正在排队，请稍后重试', 'timeout');
    }
    throw new AiRequestError(`连不上 AI 接口：${e instanceof Error ? e.message : String(e)}`, 'network');
  } finally {
    window.clearTimeout(timer);
  }
}

let modelsPromise: Promise<{ models: AiModel[]; defaultModel: string; provider: string }> | null = null;

/** 读取 Worker 的可用模型列表；失败时退回内置列表，保证下拉框永远能用。 */
export function loadModels(): Promise<{ models: AiModel[]; defaultModel: string; provider: string }> {
  if (!modelsPromise) {
    modelsPromise = request<{ models: AiModel[]; defaultModel: string; provider: string }>('/models', {}, 8000)
      .then((d) => ({
        models: d.models?.length ? d.models : FALLBACK_MODELS,
        defaultModel: d.defaultModel || DEFAULT_MODEL,
        provider: d.provider || 'workers-ai',
      }))
      .catch(() => ({ models: FALLBACK_MODELS, defaultModel: DEFAULT_MODEL, provider: 'unknown' }));
  }
  return modelsPromise;
}

export interface HealthPayload {
  ok: boolean;
  service: string;
  version: string;
  provider: string;
  defaultModel: string;
  models: AiModel[];
  counts: { spirits: number; types: number; skills: number };
  free: { workersAi: boolean; externalKeyRequired: boolean; paidAddons: boolean };
}

export function checkHealth(): Promise<HealthPayload> {
  return request<HealthPayload>('/health', {}, 8000);
}

export function analyzeSpirit(spiritId: string, model?: string): Promise<AiResult> {
  return request<AiResult>('/analyze', {
    method: 'POST',
    body: JSON.stringify({ mode: 'spirit', spiritId, model: model || undefined }),
  });
}

export function analyzeTeam(myTeam: string[], enemyTeam: string[], model?: string): Promise<AiResult> {
  return request<AiResult>('/analyze', {
    method: 'POST',
    body: JSON.stringify({ mode: 'team', myTeam, enemyTeam, model: model || undefined }),
  });
}

export function analyzeBattle(myTeam: string[], enemyTeam: string[], model?: string): Promise<AiResult> {
  return request<AiResult>('/analyze', {
    method: 'POST',
    body: JSON.stringify({ mode: 'battle', myTeam, enemyTeam, model: model || undefined }),
  });
}
