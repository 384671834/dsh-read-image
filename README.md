# dsh-read-image

给 **DeepSeek Harness** 的纯文本会话模型加一条「读图旁路」：图片发给一个独立的多模态模型，
只把**文字结论**回灌到当前会话。**会话模型不用切换**，上下文里也不会塞进图像字节。

装上之后：

- 多一个 `vision_read` 工具 —— 你说「看看这张图」，模型直接调用它，而不是回答"我看不到图"；
- 输入框旁多一个「视觉」开关和模型下拉 —— 随手开关、随时换模型；
- 多一个 `/vision` 命令 —— `on` / `off` / `model <provider::id>`。

## 为什么需要它

DSH 的图像是作为 attachment 进入请求的。当会话模型声明 `inputModalities: [text]` 时，
图像会被替换成一段占位文本（`[image omitted because this model accepts text only]`）。
于是纯文本模型对图片只能"看不见"。

本项目不改会话模型，而是**在工具侧直连一个视觉模型**：工具读到图片、发给视觉模型、
把返回的描述当作工具结果回灌。会话模型始终是它自己。

## 安装

```bash
dsh plugin add dsh-read-image
```

或在 Harness 的插件管理页里从 npm 安装。安装后可热生效；**客户端 UI 需要刷新一次页面**。

需要 DSH `>=0.2.2-rc.1 <0.3.0-0`。

## 配置

配置写在插件行里（`cordis.patch.yml` 的 `config`），全部有默认值：

| 键 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 关闭后 `vision_read` 直接返回「已关闭」 |
| `model` | `deepseek-official::deepseek-v4-flash-vision-exp` | 用哪个模型读图，格式 `provider::model` |
| `maxBytes` | `1048576` | 单张图上限，超过直接拒绝（不静默压缩） |
| `maxTokens` | `4000` | 返回文本预算。**推理型视觉模型给小了会返回空正文** |
| `anthropicPath` | `/v1/messages` | `anthropic-messages` 协议的路径 |
| `anthropicVersion` | `2023-06-01` | 同上 |
| `prompt` | 中文描述提示词 | 默认问法，可被工具参数 `prompt` 覆盖 |
| `routes` | 见下 | 覆盖各 provider 的 `baseURL` / `apiKeyEnv` / `api` |

`routes` 用来告诉插件每个 provider 该往哪儿发、用哪个密钥、走什么协议：

```yaml
config:
  model: kuaimitu::claude-opus-4.8
  routes:
    kuaimitu:
      baseURL: https://api.52pay.com/
      apiKeyEnv: KUAIMITU_API_KEY
      api: anthropic-messages
```

内置已知路由（DeepSeek 官方 / xianyu / moonshot / kuaimitu / copilot / copilot-rs / kimi-coding），
未列出的 provider 回落到顶层默认。

## 模型清单是动态的

插件不硬编码模型：它用 `ctx.llm.listProviders()` 拿 provider 列表，
再用 `ctx.llm.listModels(providerId)` 逐个取模型，并把 `inputModalities` 含 `image` 的排在前面。

所以你在 Harness 里新加了 provider 或模型，下拉会自动出现（重新打开开关或发一次 `/vision` 即可刷新）。

> `inputModalities` 只是**声明**。很多模型（如 claude-opus、gpt-4o）实际支持视觉但没有声明——
> 本插件**不据此拦截**，你仍然可以选中尝试；声明过的只是排序靠前。

## 支持的协议

| `api` | 请求 | 用途 |
|---|---|---|
| `openai-completions` | `POST {base}/chat/completions`，`Authorization: Bearer`，`image_url` 内容块 | DeepSeek 官方、xianyu、moonshot、copilot 等 |
| `anthropic-messages` | `POST {base}/v1/messages`，`x-api-key` + `anthropic-version`，`image` 内容块（base64） | kuaimitu 这类 anthropic 风格的转售通道 |

其它协议（如 `openai-responses`）会返回明确错误，不会静默失败。

## 密钥从哪来

1. 进程环境变量（`apiKeyEnv` 指定的那个）；
2. 否则走 Harness 的凭证服务 `ctx.get('credentials').resolve(ref)`——也就是你在设置页里存的那份。

密钥**不会**写进插件配置，也不会出现在日志里。

## 已知限制

- **开关是会话内状态**，不落盘：重启后回落到配置里的默认值。
  （写回 profile 的 `cordis.patch.yml` 是框架禁止的做法，`configEditor` 服务在本 profile 不可用。）
- **单张图 ≤ 1 MiB**。更大请先裁剪——视觉模型自己也有像素预算，超大图细节会被降采样。
- 返回的是**文字**。看远处小字、细纹理不可靠；需要精确读文字时先裁出那一小块。
- `copilot` / `copilot-rs` 指向本机 4141 / 4142 代理，代理没起就会连接失败。

## 开发记录

`DEVLOG.md` 记录了实现过程中实测到的 8 个坑（依赖解析、推理模型 token 预算、
`ctx.credentials` 属性访问抛异常、list slot 注册参数、`listProviders` 不含模型等）。
如果你要改这个插件，先读它。

## License

MIT
