# DEVLOG — dsh-vision-bridge

目标：让**纯文本会话模型**也能看图，而不必把整个会话切到多模态模型。
形态：DSH 插件（bundle），输入框旁一个开关 + 模型下拉。

---

## 01 · 为什么不用 MCP / 为什么不是"换默认模型"

- 会话模型 `deepseek-v4-flash` 的 `inputModalities` 只有 `text`，`read_image` 被能力门挡住：
  `model "deepseek-v4-flash" does not declare image input`。
- 同 provider 有 `deepseek-v4-flash-vision-exp`（`text,image`，1M 上下文），**但用户不想来回切**。
- MCP/工具路线的优势：**不改会话模型**，图片只换回文字结论。

## 02 · Host 侧最小可用版

- 注册工具 `vision_read`：读文件 → base64 → 发 OpenAI 兼容端点 → 回文字。
- 配置放插件自带 `cordis.patch.yml`：`enabled / model / baseURL / apiKeyEnv / maxBytes / maxTokens / prompt`。

**坑 1（致命）· 符号链接安装导致依赖解析失败**
bundle 从 workspace 软链进 profile，Node 按 realpath 解析 → `@deepseek-ai/dsh-tools` 找不到：
`ERR_MODULE_NOT_FOUND ... application=failed`。
→ 改成**零依赖**：按 `defineTool` 的返回结构自建工具对象
`{name, description, parameters(JSON Schema), output:{schema, render}, execute, isConcurrencySafe}`。

**坑 2 · 视觉模型是推理模型，token 预算不够时 content 为空**
实测 `max_tokens=600`：`content=""`，全部花在 `reasoning_content`（像"模型不会看图"）。
`max_tokens=4000`：`finish_reason=stop`，reasoning ≈ 882 token + 正文 233 字。
→ 默认调 4000，并加 `reasoning_content` 兜底。

**坑 3 · 环境变量里没有 key**
`DEEPSEEK_API_KEY` 在宿主进程环境里为空（bash 里 echo 为空）。
官方 `dsh-llm-deepseek` 的做法是 `ctx.get("credentials").resolve(ref)`。

**坑 4 · `ctx.credentials` 属性访问会抛异常，被兜底 catch 吞掉**
第一版写 `ctx.credentials ?? ctx.get?.('credentials')`：属性访问抛错 → 外层 `catch {}` 静默 → 永远走不到 `ctx.get`。
现象：工具报"凭证服务里也没读到该项"，但 LLM 本身工作正常。
→ 把两条路径**分别 try/catch**，并让失败信息带上诊断串（`env=absent | credentials=found | resolve=function | hit=value`）。
修复后立刻正常。

## 03 · 首次真实读图验证

```
vision_read("chart_600519.png")
→ [视觉模型 deepseek-v4-flash-vision-exp] 贵州茅台（600519）分时走势图，
  当前价 1,256.71，+0.33%（+4.14），今开 1,252.15，最高 1,265.88，
  最低 1,248.10，昨收 1,252.57，成交额 17.60 亿
```
（模型读出了图里的小字数字，说明这条链路可用。）

## 04 · 阶段二：输入框旁开关 + 模型下拉

- Host 增：内存态 `{enabled, model}` + 会话命令 `/vision [on|off|model <id>]`；
  命令返回文本里带 `@@VISION {...}` 供 UI 解析。
- Client 增：注册进 `conversation.composer.dock`（`kind:"list"`，需 `id`+`order`+`locale`），
  组件用 `role="switch"` + `<select>`，样式只用 `--dsw-alias-*` 主题 token。
- 通过 `ctx.remote.commands.execute(sessionId, "/vision …", [])` 调用。

**为什么用内存态而不是写回配置**：`configEditor` 服务在全库 grep 不到（文档提到但本 profile 不可用），
而写回 `cordis.patch.yml` 是明令禁止的。所以开关**会话内生效**，重启回落到 patch 里的默认值。

**坑 5 · `composer.dock` 是 list 类 slot，props 为空**
`renderSlot("conversation.composer.dock", {})` 不传数据，注册时必须给 `id` 和 `order`，
数据要靠 `inject: (sessionId) => ({run})` 自己拉。

## 05 · 状态

- Host：已安装，row `include:dsh-vision-bridge` = **active**，工具 `vision_read` 实测可用。
- Client：bundle 已在 `dsh.profile.bundles` 注册，`client.js` 随包可见；
  **需刷新页面**才会加载新的客户端 bundle。
- 待验证：刷新后输入框旁是否出现「视觉」开关与模型下拉（这一步需要浏览器，我没法代跑）。

## 06 · 配置速查

改 `/Users/mac/Desktop/Deepseek_harness/dsh-vision-bridge/cordis.patch.yml` 后重装生效；
或直接用命令 `/vision on|off|model <id>`（会话内生效，不落盘）。

---

## 07 · 用户反馈：下拉只有一个模型

现象：开关出现了，但模型下拉只有 `deepseek-v4-flash-vision-exp` 一项（我当时硬编码了一个数组）。

**改法：模型清单改成运行时读取**，不再硬编码。
- Host 用 `ctx.llm.listProviders()` 枚举全部 provider 与模型，
  字段名做防御（`provider|id`、`models|list`、`inputModalities|input`），
  标出哪些声明了 `image`，声明过的排在前面。
- 模型键改成 `provider::model`，这样能按 provider 找到正确的 `baseURL / apiKeyEnv / api`。
- `/vision` 的状态载荷里带完整清单，**UI 只负责渲染**——
  这样我不需要先知道字段名，也能让它自动列出所有模型。

**顺带补上第二种协议**：`kuaimitu` 这类转售通道是 `api: anthropic-messages`，
和 OpenAI 的 `chat/completions` 不同。已实现两条分支：
- `openai-completions` → `POST {base}/chat/completions`，`Bearer` 头，`image_url` 内容块；
- `anthropic-messages` → `POST {base}/v1/messages`，`x-api-key` + `anthropic-version` 头，
  `image` 内容块（`source: {type: base64, media_type, data}`）。

实测（用假 provider 表模拟）：
```
候选: [图]deepseek-official::deepseek-v4-flash-vision-exp
      [文]deepseek-official::deepseek-v4-flash
      [文]kuaimitu::claude-opus-4.8
kuaimitu::claude-opus-4.8 → HTTP 400 （https://api.52pay.com/v1/messages）密钥无效
deepseek-official::deepseek-v4-flash-vision-exp → ✅ 贵州茅台 1,256.71
```
其中 400 是**我测试时提取的 KUAIMITU key 不对**，但返回的是「密钥无效」而不是 404，
说明 `/v1/messages` 路径与请求体结构是对的。

**限制**：`ctx.llm.listProviders()` 只有**运行时登记**的 provider 才会出现；
`anthropic-messages` 分支的路径/版本号可在配置里覆盖
（`anthropicPath`、`anthropicVersion`）。

---

## 08 · 用户反馈：UI 里没有可选项

**根因（靠落盘诊断定位，没有 inspect 工具也能查）**：
第一版用 `ctx.llm.listProviders()` 并取它的 `models` 字段——
实测该方法的返回**只有 `{id, name}`**，根本没有模型信息：

```
listProviders() -> 8 个 provider
  - deepseek-official: keys=[id,name] models=0
  ... 全部 models=0
=> 0 个模型
```

下拉因此为空。

**正确 API**：`ctx.llm.listModels(providerId)`（**异步**），返回
`[{provider, id, name, description?, inputModalities?}]`。

**修法**
1. 枚举改成：`listProviders()` 拿 provider 列表 → 逐个 `await listModels(id)`。
2. provider 的 endpoint/key/协议**不在运行时暴露**，改为配置里的 `routes` 表
   + 内置已知路由（本机实际值）：
   `deepseek-official` / `xianyu` / `moonshot` / `kuaimitu` / `copilot` / `copilot-rs` / `kimi-coding`。
3. 兜底：枚举为空时，至少把"当前模型"塞进选项，保证下拉永远有东西可选。
4. 诊断落盘到 `/tmp/dsh-vision-bridge-diag.json`（激活时 + 每次 `/vision` 都写）。

**真实环境实测结果**
```
listProviders() -> 8
  deepseek-official 4 | deepseek-account 2 | xianyu 3 | copilot 6
  copilot-rs 8 | kimi-coding 4 | moonshot 3 | kuaimitu 13
=> 43 个模型（其中 6 个声明了 image）
```

**注意**：`inputModalities` 只是**声明**，不等于后端不支持。
`claude-opus-*` / `gpt-4o` / `gpt-6-*` 这些实际是多模态，但适配器没声明 image——
本工具**不据此拦截**，仍可选中尝试；只是排序时声明过的排前面。

**另**：`copilot` / `copilot-rs` 指向本机 4141 / 4142 代理，代理没开就会连接失败。

---

## 09 · 发布准备（2026-11-11）

**分发渠道确认**：DSH 插件就是 **npm 包**。`dsh-cost-meter@1.9.60`、`dsh-mnemon@0.5.43`、
`@anysearch/anysearch-dsh@0.1.8`、`@goodandready/dsh-image-gen@0.12.26` 全部是这条路径；
市场按 `pkg@version` 发现，并用 `engines.dsh` 做兼容判断。

**命名冲突**：`dsh-vision-bridge` 在 npm 上**已被占用**——
`motong` 于 2026-08-14 发布（0.1.0，做的是"本地 OpenAI 兼容代理"式的类似能力）。
`dsh-vision-tool`、`dsh-vision` 也已被占。
可用名：**`dsh-read-image`** / `dsh-vision-read` / `dsh-image-describer`。

**做法**：不改动正在使用的 `@local/dsh-vision-bridge`（改名会让已安装的 bundle 断掉），
另建发布目录 `publish/dsh-read-image/`，元数据对齐已发布插件：

- `license: MIT`、`engines: { node: ">=20", dsh: ">=0.2.2-rc.1 <0.3.0-0" }`
  （本机 DSH 为 `0.2.2-rc.1`）；
- `keywords` 含 `dsh-plugin` / `deepseek-harness` / `client-plugin`；
- `files` 覆盖 `index.js`、`client.js`、`cordis.patch.yml`、`locale`、`icon.svg`、`README.md`、`DEVLOG.md`、`LICENSE`；
- `exports` 保留 `.` / `./client` / `./locale/*.json` / `./icon`；
- 新增 `README.md`（安装、配置表、协议表、密钥来源、已知限制）与 `LICENSE`。

**打包校验**
```
pnpm pack → dsh-read-image-0.1.0.tgz  (20K)
  package/LICENSE        package/client.js   package/index.js
  package/locale/en.json package/package.json package/locale/zh.json
  package/DEVLOG.md      package/README.md   package/icon.svg
  package/cordis.patch.yml
```

**未完成的一步**：`npm publish` 需要 npm 账号与 scope，本机既无 npm CLI、
也无 `~/.npmrc`/token。这一步必须由账号持有者执行。

---

## 10 · 发布（2026-11-11）

### 账号澄清
用户报的是 `hanjr (384671834)`，实际是**两个账号**：
`HanJr`（id 39350982，2018 年建，test/forumAndCrm/DungeonExplorer）与
`384671834`（id 55585649，2019 年建，yolov5-5.0-Polygon/PaddleOCR-torchversion/C-Execise）。
SSH key 与 token 都属于**后者**，故 owner 定为 `384671834`。

### Git
SSH 认证通过（`Hi 384671834!`）。仓库
**https://github.com/384671834/dsh-read-image** 已建（public），5 个提交，
topics 已设：`dsh-plugin`(关键) / `deepseek-harness` / `dsh` / `vision` / `multimodal` / `image`。

### 插件广场
广场是**目录驱动**，不是提交流程：读 catalog JSON，安装以 npm `latest` 为准。
两条收录路径：带 `dsh-plugin` topic 的仓库被定时扫描自动收录；或向
`imsai-sh/awesome-deepseek-harness-plugins` 提 PR 新增**一个** `catalog/plugins/*.json`。

已 fork 并提交 PR **#907**（open, mergeable, +12/−0, 仅 1 个文件）：
`catalog/plugins/384671834--dsh-read-image.json`，category=`tools`。

### 两个实测卡点
1. **fine-grained token 不能建仓库**：`POST /user/repos` → 403
   `"Resource not accessible by personal access token"`。
   建库必须用**经典 token**（`ghp_…`，`repo` 或 `public_repo`）或网页。换成经典 token（scope `repo`）后一次成功。
2. **npm 未发布**：广场只提供 npm 安装，未发 npm 的插件只会以**浏览态**收录
   （有仓库链接、无安装命令）。故 PR 说明里已注明"未发布 npm"。

### 待办
- `pnpm login` + `pnpm publish --access public`（广场安装命令此时才会出现）
- 撤销已泄露的 fine-grained token；经典 token 用完即删
