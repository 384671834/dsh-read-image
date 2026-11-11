/**
 * @local/dsh-vision-bridge — Host half.
 *
 * 让**纯文本会话模型**也能"看图"：图像发给指定的多模态模型，只把文字结论回灌。
 *
 * 枚举模型用 `ctx.llm.listModels(providerId)`（异步，带 inputModalities）。
 * ⚠️ 不要用 `listProviders()` 里的 `models` 字段——实测它只返回 `{id, name}`，
 * 没有任何模型信息（第一版就是这么写错的，下拉空掉）。
 *
 * provider 的 endpoint/key/协议不在运行时暴露，因此用配置里的 `routes` 表；
 * 未配置的 provider 回落到顶层 baseURL/apiKeyEnv。
 */
import { readFile } from 'node:fs/promises'
import { existsSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const DIAG = '/tmp/dsh-vision-bridge-diag.json'

const DEFAULTS = {
  enabled: true,
  model: 'deepseek-official::deepseek-v4-flash-vision-exp',
  baseURL: 'https://api.deepseek.com/v1',
  apiKeyEnv: 'DEEPSEEK_API_KEY',
  maxBytes: 1048576,
  // 该视觉模型是推理模型：max_tokens 太小会全部花在 reasoning_content，content 为空。
  maxTokens: 4000,
  anthropicPath: '/v1/messages',
  anthropicVersion: '2023-06-01',
  prompt:
    '请用中文如实描述这张图：先给一句话总览，再分点列出可见的关键对象、文字内容、数值与异常之处。' +
    '只描述你确实看到的内容，不要推测；如果需要读具体文字，逐字抄录。',
}

/** 已知 provider 的路由（来自本机 profile 的实际配置）。可用配置里的 routes 覆盖。 */
const ROUTE_DEFAULTS = {
  'deepseek-official': { baseURL: 'https://api.deepseek.com/v1', apiKeyEnv: 'DEEPSEEK_API_KEY', api: 'openai-completions' },
  xianyu: { baseURL: 'https://laneai.dev/v1', apiKeyEnv: 'XIANYU_API_KEY', api: 'openai-completions' },
  moonshot: { baseURL: 'https://api.moonshot.cn/v1', apiKeyEnv: 'KIMI_CODING_API_KEY', api: 'openai-completions' },
  kuaimitu: { baseURL: 'https://api.52pay.com/', apiKeyEnv: 'KUAIMITU_API_KEY', api: 'anthropic-messages' },
  copilot: { baseURL: 'http://127.0.0.1:4141/v1', api: 'openai-completions' },
  'copilot-rs': { baseURL: 'http://127.0.0.1:4142/v1', api: 'openai-responses' },
  'kimi-coding': { apiKeyEnv: 'KIMI_CODING_API_KEY', api: 'openai-completions' },
}

const MIME = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.gif': 'image/gif',
}

const pick = (value, fallback) =>
  (value === undefined || value === null || value === '' ? fallback : value)

const mimeOf = (file) => MIME[path.extname(file).toLowerCase()] ?? 'image/png'

/** 零依赖：不 import defineTool，直接给注册表它要的形状。 */
const makeTool = (definition) => definition

function writeDiag(payload) {
  try {
    writeFileSync(DIAG, JSON.stringify(payload, null, 1))
  } catch {
    /* 诊断写不出去不影响主流程 */
  }
}

/** 枚举 provider → 模型。返回 [{key, provider, id, label, hasImage}] */
async function listModelCandidates(ctx) {
  const diag = { at: new Date().toISOString(), steps: [], models: [] }
  const out = []

  if (ctx.llm === undefined || typeof ctx.llm?.listProviders !== 'function') {
    diag.steps.push(`ctx.llm=${ctx.llm === undefined ? 'undefined' : typeof ctx.llm}`
      + ` listProviders=${typeof ctx.llm?.listProviders}`)
    writeDiag(diag)
    return out
  }

  let providers = []
  try {
    providers = ctx.llm.listProviders() ?? []
  } catch (error) {
    diag.steps.push(`listProviders threw ${error?.name}: ${String(error?.message).slice(0, 160)}`)
    writeDiag(diag)
    return out
  }
  diag.steps.push(`listProviders() -> ${Array.isArray(providers) ? providers.length : typeof providers}`)

  for (const p of Array.isArray(providers) ? providers : []) {
    const provider = String(p?.id ?? p?.provider ?? p?.name ?? '')
    if (provider === '') continue
    let models = []
    try {
      models = await ctx.llm.listModels(provider)
    } catch (error) {
      diag.steps.push(`  ${provider}: listModels threw ${error?.name}: ${String(error?.message).slice(0, 120)}`)
      continue
    }
    if (!Array.isArray(models)) models = []
    diag.steps.push(`  ${provider}: ${models.length} 个模型`)
    for (const m of models) {
      const id = String(m?.id ?? '')
      if (id === '') continue
      const mods = m?.inputModalities
      out.push({
        key: `${provider}::${id}`,
        provider,
        id,
        label: `${String(m?.name ?? id)} · ${provider}`,
        hasImage: Array.isArray(mods) && mods.includes('image'),
      })
    }
  }

  out.sort((a, b) => (Number(b.hasImage) - Number(a.hasImage))
    || a.provider.localeCompare(b.provider) || a.id.localeCompare(b.id))
  diag.steps.push(`=> ${out.length} 个模型（image: ${out.filter((c) => c.hasImage).length}）`)
  diag.models = out.map((c) => c.key)
  writeDiag(diag)
  return out
}

/** provider 路由：配置 routes > 内置已知表 > 插件顶层默认。 */
function routeFor(provider, cfg) {
  const override = cfg.routes?.[provider] ?? {}
  const known = ROUTE_DEFAULTS[provider] ?? {}
  return {
    provider,
    baseURL: pick(override.baseURL, pick(known.baseURL, cfg.baseURL)),
    apiKeyEnv: pick(override.apiKeyEnv, pick(known.apiKeyEnv, '')),
    api: pick(override.api, pick(known.api, 'openai-completions')),
  }
}

/**
 * 取 API key：环境变量 → 凭证服务。
 * ⚠️ `ctx.credentials` 属性访问会抛异常（实测），必须单独 try，
 * 否则外层 catch 会吞掉异常、永远走不到 `ctx.get('credentials')`。
 */
async function resolveApiKey(ctx, envName) {
  const diag = []
  if (!envName) return { key: undefined, diag: ['no apiKeyEnv configured'] }
  const fromEnv = process.env?.[envName]
  diag.push(`env ${envName}=${fromEnv ? 'present' : 'absent'}`)
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return { key: fromEnv.trim(), diag }

  let credentials
  try {
    credentials = ctx.credentials
  } catch (error) {
    diag.push(`ctx.credentials threw ${error?.name}`)
  }
  if (!credentials) {
    try {
      credentials = ctx.get?.('credentials')
    } catch (error) {
      diag.push(`ctx.get threw ${error?.name}`)
    }
  }
  diag.push(`credentials=${credentials ? 'found' : 'undefined'}`)
  if (!credentials) return { key: undefined, diag }

  if (typeof credentials.resolve === 'function') {
    try {
      const hit = await credentials.resolve(envName)
      diag.push(`hit=${hit === undefined ? 'undefined' : 'value'}`)
      if (hit && typeof hit.value === 'string' && hit.value.trim() !== '') {
        return { key: hit.value.trim(), diag }
      }
    } catch (error) {
      diag.push(`resolve threw ${error?.name}: ${String(error?.message).slice(0, 120)}`)
    }
  }
  return { key: undefined, diag }
}

const joinUrl = (base, suffix) => `${String(base ?? '').replace(/\/+$/u, '')}${suffix}`

async function callVision({ file, prompt, route, cfg, apiKey, signal }) {
  const bytes = await readFile(file)
  if (bytes.byteLength > cfg.maxBytes) {
    return {
      ok: false,
      error: `图片 ${bytes.byteLength} 字节，超过上限 ${cfg.maxBytes} 字节。`
        + '请先裁剪或降分辨率（视觉模型本身也有像素预算，超大图细节会被降采样）。',
    }
  }
  const mediaType = mimeOf(file)
  const base64 = bytes.toString('base64')
  const api = String(route.api ?? 'openai-completions')
  const auth = apiKey === undefined ? {} : (
    api === 'anthropic-messages' ? { 'x-api-key': apiKey } : { authorization: `Bearer ${apiKey}` })

  let url
  let headers = { 'content-type': 'application/json', ...auth }
  let body
  if (api === 'anthropic-messages') {
    url = joinUrl(route.baseURL, cfg.anthropicPath)
    headers = { ...headers, 'anthropic-version': cfg.anthropicVersion }
    body = {
      model: route.id,
      max_tokens: cfg.maxTokens,
      temperature: 0.2,
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: prompt },
          { type: 'image', source: { type: 'base64', media_type: mediaType, data: base64 } },
        ],
      }],
    }
  } else if (api === 'openai-completions') {
    url = joinUrl(route.baseURL, '/chat/completions')
    body = {
      model: route.id,
      max_tokens: cfg.maxTokens,
      temperature: 0.2,
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: prompt },
          { type: 'image_url', image_url: { url: `data:${mediaType};base64,${base64}` } },
        ],
      }],
    }
  } else {
    return {
      ok: false,
      error: `该 provider 走 "${api}" 协议，本工具未实现（支持 openai-completions 与 anthropic-messages）。`
        + '可在插件配置的 routes 里改成 openai-completions 后重试。',
    }
  }

  const response = await fetch(url, {
    method: 'POST', headers, body: JSON.stringify(body),
    ...(signal === undefined ? {} : { signal }),
  })
  if (!response.ok) {
    const text = await response.text().catch(() => '')
    return { ok: false, error: `模型返回 HTTP ${response.status}（${url}）：${text.slice(0, 360)}` }
  }
  const json = await response.json()
  const collect = (value) => (typeof value === 'string'
    ? value
    : Array.isArray(value)
      ? value.map((part) => (typeof part === 'string' ? part : part?.text ?? '')).join('\n')
      : '')
  let flat = ''
  let reasoning = ''
  if (api === 'anthropic-messages') {
    flat = collect((json?.content ?? []).map((part) => part?.text ?? '')).trim()
  } else {
    const message = json?.choices?.[0]?.message ?? {}
    flat = collect(message.content).trim()
    reasoning = collect(message.reasoning_content).trim()
  }
  if (flat === '' && reasoning !== '') {
    flat = `${reasoning}（模型思考过程，content 为空；建议调大 maxTokens）`
  }
  if (flat === '') return { ok: false, error: '模型返回了空内容。' }
  return { ok: true, text: flat, model: `${route.provider}/${route.id}`, bytes: bytes.byteLength }
}

export const inject = ['tools', 'commands', 'llm']

export function apply(ctx, rawConfig) {
  const config = rawConfig ?? {}
  const cfg = {
    enabled: pick(config.enabled, DEFAULTS.enabled),
    model: pick(config.model, DEFAULTS.model),
    baseURL: pick(config.baseURL, DEFAULTS.baseURL),
    apiKeyEnv: pick(config.apiKeyEnv, DEFAULTS.apiKeyEnv),
    maxBytes: Number(pick(config.maxBytes, DEFAULTS.maxBytes)),
    maxTokens: Number(pick(config.maxTokens, DEFAULTS.maxTokens)),
    anthropicPath: pick(config.anthropicPath, DEFAULTS.anthropicPath),
    anthropicVersion: pick(config.anthropicVersion, DEFAULTS.anthropicVersion),
    prompt: pick(config.prompt, DEFAULTS.prompt),
    routes: config.routes ?? {},
  }

  // 运行期状态：UI 开关只改这里，不落盘（configEditor 在本 profile 不可用，
  // 写回 cordis.patch.yml 是禁止的）。重启后回落到 patch 默认值。
  const state = { enabled: cfg.enabled !== false, model: cfg.model }

  const modelsPayload = async () => {
    const list = (await listModelCandidates(ctx)).map((c) => ({
      key: c.key, label: c.label, hasImage: c.hasImage,
    }))
    const cur = String(state.model)
    // 兜底：枚举为空时也必须至少有一项，否则下拉是空的
    if (!list.some((m) => m.key === cur)) {
      list.unshift({ key: cur, label: `${cur}（配置默认）`, hasImage: true })
    }
    return list
  }

  const statusText = async () => {
    const list = await modelsPayload()
    const cur = String(state.model)
    const chosen = list.find((m) => m.key === cur)
    return `视觉桥接：${state.enabled ? '已启用' : '已关闭'} · 模型 ${chosen?.label ?? cur}`
      + `\n@@VISION ${JSON.stringify({ enabled: state.enabled, model: cur, models: list })}`
  }

  // ---- 诊断工具 ----
  ctx.effect(() => ctx.tools.register(makeTool({
    name: 'vision_providers',
    description: 'List LLM providers, their models, and which declare image input. '
      + 'Diagnostic helper for the vision bridge.',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: { ok: { type: 'boolean' }, json: { type: 'string' }, error: { type: 'string' } },
        required: ['ok'],
      },
      render: (_a, v) => [{ type: 'text', text: v.ok ? (v.json ?? '') : `失败：${v.error ?? ''}` }],
    },
    isConcurrencySafe: () => true,
    async execute() {
      try {
        return { ok: true, json: JSON.stringify(await listModelCandidates(ctx), null, 1) }
      } catch (error) {
        return { ok: false, error: `${error?.name}: ${error?.message}` }
      }
    },
  })))

  // ---- 会话命令 ----
  ctx.effect(() => ctx.commands.register({
    name: 'vision',
    description: 'Toggle the vision bridge and choose its model (the composer chip uses this).',
    async handler(invocation) {
      const arg = String(invocation?.rawInput ?? '').trim()
      const parts = arg.split(/\s+/u).filter(Boolean)
      const verb = parts[0]
      if (verb === undefined) return { kind: 'success', text: await statusText() }
      if (verb === 'on') state.enabled = true
      else if (verb === 'off') state.enabled = false
      else if (verb === 'model' && parts.length > 1) state.model = parts.slice(1).join(' ')
      else return { kind: 'error', text: '用法：/vision [on|off|model <provider::id>]' }
      return { kind: 'success', text: await statusText() }
    },
  }))

  // ---- 读图工具 ----
  ctx.effect(() => ctx.tools.register(makeTool({
    name: 'vision_read',
    description:
      'Read an image file through a separate multimodal model and return its text description. '
      + 'Use this whenever the session model cannot accept images but the user gives a picture '
      + 'to look at. The image itself never enters this conversation; only the description does.',
    parameters: {
      type: 'object', additionalProperties: false,
      properties: {
        image_path: {
          type: 'string',
          description: 'Absolute path, or a path relative to the current working directory.',
        },
        prompt: {
          type: 'string',
          description:
            'What to ask about the image. Defaults to a general faithful description. '
            + 'Narrow it for OCR (读文字), counting, reading a chart axis, or comparing regions.',
        },
      },
      required: ['image_path'],
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          ok: { type: 'boolean' }, text: { type: 'string' }, error: { type: 'string' },
          model: { type: 'string' }, bytes: { type: 'number' },
        },
        required: ['ok'],
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.ok === false
          ? `vision_read 失败：${value.error ?? '未知原因'}`
          : `[视觉模型 ${value.model ?? state.model}] ${value.text ?? ''}`,
      }],
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      if (!state.enabled) {
        return { ok: false, error: '视觉桥接已关闭。发送 /vision on，或用输入框旁的「视觉」开关启用。' }
      }
      const file = path.resolve(String(args.image_path ?? ''))
      if (!args.image_path || !existsSync(file)) {
        return { ok: false, error: `找不到图片：${file}` }
      }
      const key = String(state.model)
      const at = key.indexOf('::')
      const provider = at < 0 ? 'deepseek-official' : key.slice(0, at)
      const id = at < 0 ? key : key.slice(at + 2)
      const route = { ...routeFor(provider, cfg), id }

      let apiKey
      if (route.apiKeyEnv) {
        const resolved = await resolveApiKey(ctx, route.apiKeyEnv)
        if (resolved.key === undefined) {
          return {
            ok: false,
            error: `未取到 API key（${route.apiKeyEnv}）。诊断：${resolved.diag.join(' | ')}。`
              + '请在 DSH 设置里配置该密钥，或选一个 key 已配置的 provider。',
          }
        }
        apiKey = resolved.key
      }

      try {
        return await callVision({
          file, prompt: pick(args.prompt, cfg.prompt), route, cfg, apiKey,
          signal: exec?.signal,
        })
      } catch (error) {
        return { ok: false, error: `${error?.name ?? 'Error'}: ${error?.message ?? String(error)}` }
      }
    },
  })))

  // 激活时跑一次枚举并落盘诊断（便于定位"下拉为空"）
  listModelCandidates(ctx).catch(() => {})

  // ---- 提示词 ----
  try {
    ctx.effect(() => ctx.systemPrompt.section({
      name: 'tool:vision_read',
      text:
        'When the user refers to an image file (a path or a screenshot on disk), call the '
        + 'vision_read tool instead of claiming you cannot see images. It sends the file to a '
        + 'separate multimodal model and returns a text description. '
        + 'Narrow the prompt parameter for OCR, counting, or chart reading.',
    }))
  } catch {
    /* 增强项，失败不阻塞工具 */
  }
}
