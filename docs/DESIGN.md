# pi-wx-agent v1：实际实现

## 架构与边界

```text
微信 API ← 长轮询 → weixin-agent-sdk@0.5.0
                         ↓ chat / clearSession
                     PiAgent 共享 FIFO
                  ↙ chat  ↓ clear  ↘ dream
               createAgentSession（Pi SDK 1.3.0）
                      ↓ Pi 自管 JSONL
```

微信 SDK 原生全局串行，但定时 dream 与同步 clear 回调不在同一异步生命周期，桥接必须共享一个 FIFO。支持一个 owner 与受邀成员（见「多用户家庭版」）与受限媒体通道（见「媒体收发」），不引 cron 库/数据库/外部模型提取管道。

模块：`main.ts` 管配置/微信登录/停止/定时器，并安装 fetch 兼容垫片（见下）；`config.ts` 校验配置（含可选 `extensions` 扩展清单）；`state.ts` 管可验证的原子持久状态；`memory.ts` 读写两层记忆（索引/topic、行数、原文核对）；`pi-agent.ts` 管认领/串行生命周期/命令/记忆规则/dream；`pi-session.ts` 适配并验证真实 Pi API。没有全局安装依赖。

## 启动与 owner

1. 读配置，dataDir 相对配置文件解析为绝对路径，umask 077。
2. 在动态导入微信 SDK **之前**设置 `OPENCLAW_STATE_DIR=dataDir`。
3. start 校验 Pi 模型配置/可用认证，不执行付费 prompt；首次交互式扫码，后续复用登录。后台无登录直接报错。
4. 没有 owner 且没有旧认领状态时创建随机 128-bit 码。只打印一次；状态仅存 hash、10 分钟到期时间、全局 5 次尝试预算。
5. 认领成功先原子写 owner 哈希/删除认领码，再回复成功，不调用 Pi。重启不刷新预算；本地 `claim` 可显式轮换未认领窗口，不可替换 owner。
6. 未授权 chat 返回「未授权」，clear 同步抛出「未授权」供 SDK 捕获；二者都不创建/恢复/运行 Pi。写入错误禁用当前桥接，损坏状态拒绝启动，不自动重置授权。

一个 dataDir 只允许一个进程；没有跨进程锁。`claim/login` 必须停服务后执行。显式 `login` 清 SDK 账号凭据并重新扫码，不清 owner/会话。SDK 没有导出 adequate pairing API，因此自实现有限认领。

## chat 与 clear

授权后 chat 入 FIFO，读取/新建 `dataDir/conversations/<sha256(conversationId)>`，不以原始 ID 拼路径。首次写项目自有 `AGENTS.md`（已有文件不覆盖；若已有文件内容与当前模板不同，仅记录一条迁移提示，绝不改写）。FIFO 内、会话建立后先做入站媒体准备（见下节），再快照记忆、`run(prompt)`；回复先剥 ATTACH 末尾块再解析 MEMORY_SAVED（见下节）。

**会话自省命令**在桥接层（`chat()` 鉴权之后、入 FIFO 之前）拦截，与 chat/clear 同等鉴权：未授权直接返回「未授权」且不创建/恢复/运行任何 Pi。owner 与成员均可用 `/status`、`/cost`、`/context`、`/compact [说明]`、`/stop`（均只作用于自己的会话）；`/invite`、`/members`、`/kick` 仅 owner（见「多用户家庭版」）。SDK 自带 `/echo`、`/toggle-debug`、`/clear` 仍在桥接之前处理（`/clear` 的鉴权由本桥接执行）。

- `/status`、`/cost`、`/context` 是只读：读 `getSessionStats()`、`getContextUsage()`、`session.model`/`thinkingLevel`，不触发模型调用；无活跃会话时返回明确提示。`/status` 还展示 dream 覆盖计数、上次成功/尝试时间与记忆索引行数。
- `/compact` 入 FIFO 并调用 Pi 原生 `session.compact(customInstructions?)`（其内部先 `abort()`），返回 `tokensBefore`/`estimatedTokensAfter`；上下文太小或已压缩会失败并给出通用提示，不向微信转发原始异常。
- `/stop` 调用 `session.abort()`。因 SDK 串行派发消息，`/stop` 无法在一条 chat 尚未返回时插队中断它，只能中止后台 dream 或（若将来并发派发）正在运行的 turn；文案如实描述。
- `/help` 返回静态的角色感知速查（不建会话、零 Pi 调用）：普通聊天无需指令与自省命令人人可见；owner 额外附管理命令行，成员回复完全省略管理块。

持久映射使用 UUID intent：在 Pi 首次 prompt 前写 `state.json`；通过 `SessionManager.create(cwd, undefined, {id})` 创建相同 UUID。Pi 首个 user message 即创建 JSONL，不必等 assistant。恢复使用 `SessionManager.findById(cwd,id)` 和 `open(path,undefined,cwd)`，验证 ID；没有文件且未完成首轮时可用同一 ID 重建空 intent；已成功运行后文件缺失必须报错，不能偷偷续最近或开新会话。

每轮记录持久 activity 计数，再等待 idle session 的 `prompt()` 完整执行。不调用 `followUp()` 充当同步执行：它只承诺排队/消费，不承诺对应回复完成。只接受本轮 `message_end` 的新 assistant 最终成功文本（stopReason=stop），不取可能属于之前 dream/失败 run 的 `getLastAssistantText()`。失败返回通用提示，避免向微信泄漏原始异常。

clear 同步鉴权并递增代际编号，使尚未返回的旧 chat 回复/旧排队请求失效，然后在 FIFO 内持久删除映射、dispose。后续 chat 排在 clear 后新建 UUID。工作目录/MEMORY 和旧 JSONL 不删。SDK 的 clear 回调不 await，因此微信自带成功提示可能先于磁盘清理；这不是完整事务确认。持久失败禁用当前 bridge 并记录日志。

关闭时阻止新任务，取消定时器/轮询，abort、等待队列、dispose；10 秒进程退出上限。已发送给微信 SDK 的回复不可撤销；SDK 实际串行派发确保网络发送与下一条收到的 clear 有序。

## 原生压缩与记忆

`SettingsManager.applyOverrides({compaction:{enabled:true}})` **在 createAgentSession 完成后**执行；安装版本的 ResourceLoader.reload 会重载并丢弃提前设置的 overrides。立即检查 `session.autoCompactionEnabled`。不修改操作员全局设置，不另写摘要算法；阈值和摘要的正确性依赖 Pi/model。手动压缩（`/compact`）走同一 Pi 原生 `session.compact()`，不自研摘要。

可选扩展（`config.extensions`，默认不配置）：数组内为绝对路径且启动时逐一校验存在，否则拒绝启动。非空时为每个会话构造 `DefaultResourceLoader({ additionalExtensionPaths, noExtensions: true })` 并先 `reload()` 再传入 `createAgentSession`（SDK 只 reload 自己构造的 loader）。安装版 resource-loader（reload()/loadCurrentExtensionSet()）的加载集合是 `noExtensions ? cliEnabledExtensions : mergePaths(cliEnabledExtensions, enabledExtensions)`，其中 cliEnabledExtensions 恰为 additionalExtensionPaths、enabledExtensions 为全局 settings/<agentDir>/extensions 与项目目录的自动发现结果；因此 `noExtensions: true` 把加载精确限制为清单内文件，跳过全部全局/用户/项目扩展发现。未配置时不传 resourceLoader，行为与引入该选项前逐位一致。配套可选 `extensionFlags`（须与非空 `extensions` 同用）双通道生效：一是在 reload 后写入 loader 结果的 `runtime.flagValues`（`getFlag()` 实时读取的同一映射，与 CLI 的 `applyExtensionFlagValues` 同机制；工厂期已随 reload 运行、标志无预置入口，扩展须惰性读标志），并补上 CLI 各模式均执行而 `createAgentSession` 不执行的 `session.bindExtensions()`（触发 `session_start`），使按标志惰性注册的工具真正生效；二是在 `createSessionFactory` 内、首个 loader.reload() 之前把令牌追加到 `process.argv`（布尔真 `--name`、字符串 `--name=value`、布尔假跳过——argv 只能表达存在性；含去重守卫，且晚于 main.ts 自身的参数解析，不影响命令分派），供工厂期扫描 argv 的扩展（文档化回退模式）识别；未注册标志名记一条警告。扩展工具的模型可见性：激活由 SDK 完成（构造期 `includeAllExtensionTools` 与注册刷新），但系统提示的「Available tools」仅列出带 `promptSnippet` 的工具，无 snippet 的扩展工具对模型不可见；桥接用代理 `ResourceLoader` 在 `getAppendSystemPrompt` 追加按需生成的工具描述段（每次系统提示重建时重读活的扩展工具表，覆盖加载期与 session_start 晚注册；已带 snippet 的工具不重复描述，`defaultActive:false`/不可声明工具除外）。上述全部仅对 owner 会话生效（结构性隔离）：`session()` 以 `opts.owner`（`state.owner === key`，缺省即 false）调用会话工厂，非 owner 会话不构造 resourceLoader（createAgentSession 默认 loader，与未配置部署逐位一致，扩展不注册、不激活、不描述）；argv 令牌是进程级的，但对成员会话无效果——成员不加载任何扩展，无代码扫描 argv；AGENTS.md 模板分支（仅 owner 且清单非空时追加通用说明）只是提示层补充，不再是隔离手段。扩展与桥接同权限运行（可注册新工具）。

Pi 原生加载 cwd/父目录/agentDir 的 AGENTS 类 context 文件。项目的通用模板要求：

- **两层记忆**：`MEMORY.md` 是索引（每条一行，软上限约 150 行），详情放 `memory/<topic>.md` 按需读取；索引超限时把细节移入 topic 文件。`src/memory.ts` 的 `readMemoryStore`/`indexLineCount` 供桥接读取索引与 topic 文件、统计行数。**超限不自动裁剪、也不阻止丢失**，只在 `/status` 展示并在每次实际执行的 dream 后记录 `memory-index-over-cap` 诊断；维持索引大小靠提示词约束模型。`readMemoryStore` 对不可读/非目录的 `memory` 路径按「无 topic」处理，永不抛出。
- **写后校验（不假装成功）**：模型保存事实时须输出 `MEMORY_SAVED: <原文>` 标记行。`parseSavedClaims` 只剥离**末尾连续、行首锚定**的标记行（`/^\s*[-*]?\s*MEMORY_SAVED:\s*(\S.*)$/`）得到用户可见文本并收集声明；正文中提到标记、或标记不在行首的行一律原样保留（中间出现的标记行会原样发给用户）。桥接在运行**前**对工作区取快照（`readMemoryStore`），运行后用 `sameMemoryStore` 比较前后存储：存储**未变**（模型什么都没写）时全部声明判为未确认；存储**已变**时，只要原文在运行后存在即判为已写入（`factInStore`）。因此改写/合并/迁移已有事实（存储已变）会通过，重复要求记住已有事实而模型不写任何东西则未确认。核对失败记录 `memory-write-unverified` 并在回复后追加提示；dream 核对失败则不标记成功、保留待处理活动重试（避免每分钟重跑模型）。用户以命令式明确「记住」但无任何标记也按未确认处理（`REMEMBER_INTENT` 要求行首命令式，如「记住这件事」「帮我记住明天开会」）。dream 每次实际执行后都检查索引是否超限并记录 `memory-index-over-cap`（不只成功路径）。
- 不记录秘密；实际检查写入，不凭空承诺保存。

MEMORY 是磁盘文件，不是额外 LLM 提取流程；模型是否正确读写不保证。校验是提示词驱动、尽力而为：标记可能被遗漏或与实际写入不符。压缩/clear 不删文件；原始 JSONL/备份可能仍含已要求忘记的内容。分发模板不包含任何部署者私人指令。既有工作区不会被自动改写，需手动迁移才能采用新约定。

## 媒体收发（v2 Phase B）

**入站**在 `chat()` 鉴权之后、FIFO 内部、工作区已创建后处理（`prepareInboundMedia`，永不抛错，失败一律降级为文本注记，原始路径不进提示词）。入站媒体的嗅探/复制在 FIFO 内同步执行（大文件会短暂阻塞事件循环；单 owner 规模下接受此取舍）。图片与文件/视频**完全统一**：原文件 `copyFileSync` 到 `<workspace>/media/`（basename 防穿越、重名 `-N` 后缀），提示词标注工作区相对路径，模型用自己的文件/图片工具按需读取；**媒体字节一律不进提示词**（不经 `PromptOptions.images`、无 base64、无 MIME 白名单/大小上限——SDK 自身限制下载大小）：

- `image`：SDK 统一上报 `mimeType: "image/*"` 且临时文件为 `.bin`，故以魔数嗅探（只读 16 字节头：PNG `\x89PNG\r\n\x1a\n`、JPEG `\xFF\xD8\xFF`、GIF `GIF87a/89a`、WEBP `RIFF`@0+`WEBP`@8）决定副本扩展名 `.jpg/.png/.gif/.webp`（原名已有真实扩展名则保留；魔数未知保持 `.bin`，仍复制并注记）。嗅探仅用于命名，不过滤内容。
- `file` / `video`：同一路径（视频同样处理，Pi 无视频输入）。SDK 不回填 `fileName`，副本名取自其临时文件 basename（文件按 MIME 保留扩展名），非用户原名。
- `audio`：微信转写已在 `request.text`；仅加 `[语音] ` 前缀；转写为空时注记「转写不可用」。音频文件不进 Pi。

**出站（ATTACH 约定）**镜像 `MEMORY_SAVED` 协议：模型把文件写进会话工作区，回复末尾一行 `ATTACH: <工作区相对路径>`。解析顺序：先 `parseAttachLines`（只剥末尾连续、行首锚定的 ATTACH 行，与 `parseSavedClaims` 同构），再对剩余文本做 MEMORY_SAVED 解析——因此模型按「MEMORY_SAVED 行在前、ATTACH 行最后」的约定可同时剥离；顺序颠倒时 ATTACH 行不是末尾块、按普通文本发给用户（与中部 MEMORY_SAVED 同一已文档化取舍）。校验：`resolve(workspace, path)` 后对**两侧 `realpathSync`**（跟随符号链接）再做 `relative()` 越界检查（拒绝 `..`/绝对路径/指向工作区外的符号链接，断链落入 unreadable 拒绝），`statSync().isFile()`（拒绝目录与缺失）；按扩展名映射 `ChatResponse.media.type`（图片/视频扩展名→对应类型，其余→file）；`url` 传**绝对路径**（SDK 会把相对 url 相对自己 cwd 的 `path.resolve`）。失败：只剥标记、记 `category=attach-rejected reason=outside-workspace|unreadable|not-a-file`（固定词表，不回显路径），无附件。多条 ATTACH 只取第一条，多余记 `category=attach-dropped`。出站无音频、每回复最多一个附件（SDK 单对象限制）；SDK 上传时按文件真实 MIME 路由，类型映射仅为字段正确性。约定写入 `AGENTS.md` 模板；已有工作区不自动改写（日志提示手动刷新）。

**进度反馈**：SDK 自带 typing 指示器覆盖 `agent.chat()` 全程（`process-message.ts:186-205` 先 `startTyping()` 再调 agent，每 10 秒 `setInterval` 续期，finally 取消），长任务无缺口。不引入 ack 消息、不调用 `Bot.sendMessage()`（维持不做主动推送决策）。

**入站去重（决策：不做）**：SDK 在派发消息前就持久化 get_updates 游标（`monitor.ts:113-117` 先 `saveGetUpdatesBuf` 落盘、`monitor.ts:120-131` 才进入消息循环调 `agent.chat()`），因此是 at-most-once：崩溃丢消息、不重放。无重放窗口 → 无需去重环，也未新增任何状态。边缘：若游标落盘本身失败（磁盘错误），同一批消息可能被重新拉取并再次派发——罕见重复窗口，桥接不做去重。

## 多用户家庭版（成员邀请制，v3 增量）

**角色**：owner（部署者，一次性认领）+ members（受邀家人）。`authorized(id) = isOwner(id) || members[hash(id)] 存在`；鉴权仍在一切 Pi 调用之前，未授权消息照旧拒绝且不触 Pi。家人可信、无沙箱（部署决策）；硬约束是隔离：会话/工作区/MEMORY 本就按 `workspace(hash(conversationId))` 分目录，本设计未引入任何跨会话记忆读取，也不做按用户计费（/cost 本就按会话）。

**状态（全部增量，旧 state.json 缺省为空，不放松任何既有字段校验）**：`members: { <hash>: { joinedAt } }`（缺省 `{}`）、`invite: { hash, expiresAt } | null`（缺省 `null` = 无活跃邀请）。沿用同一原子写与严格校验风格：成员键必须是 64 位十六进制且不得等于 owner（owner 永远不在名册里，故不可被 /kick），`joinedAt`/`expiresAt` 必须是非负安全整数，`invite.hash` 必须是哈希；**owner 为 null 时名册必须为空**（加入只可能发生在认领之后）；非法即拒绝启动，绝不自动重置。唯一调整的既有关系约束：v1 要求 conversations 键必须等于 owner 哈希（单 owner 不变量），多用户下改为只验哈希格式——成员资格是动态的（被踢者的会话记录为重邀请保留），会话归属改在访问时校验（`authorized()`/`keyAuthorized()`）。

**加入**：未授权消息在认领分支之后尝试 `tryJoin`：要求 owner 已认领（未认领部署不认任何邀请码）、邀请未过期、文本 trim 后与邀请码**哈希 timingSafe 比较**精确相等。命中即写入名册并**先落盘再回欢迎语**（说明这是部署者的助理、用量由部署者承担、命令清单）；落盘失败禁用桥接（与认领同风格）。不设尝试预算（认领才有 5 次全局预算）；邀请码不消耗，24h 窗口内多人可用同一码。过期/无码/不匹配照旧「未授权」。

**管理命令（仅 owner；成员使用直接拒绝、不触 Pi）**：`/invite` 生成 128-bit 码、只存哈希、TTL 24h、再次生成即作废旧码；`/members` 按 joinedAt（哈希做稳定 tie-break）列出序号+加入时间，不显示哈希；`/kick <序号>` 按同一序号删除名册项（回复含该成员加入时间，便于核对序号错位），无效序号只提示不变更。被踢者下一条消息回到未授权；**已在 FIFO 排队的消息也不会执行**（入队闭包会重跑 authorized），其待 dream 活动也不再被调度（dream 循环按 `keyAuthorized` 过滤，避免 owner 为已移除者付模型费）；**踢人同时把 `invite` 置空作废当前码**——被踢者聊天记录里的旧码最多还有 24h 有效，不轮换即可原码静默重新加入；未完成加入的家人需重新 `/invite`。其工作区/会话映射保留，重新邀请后原会话精确恢复（踢人不是擦除）。

**/stop 归属（多用户必须）**：会话表按 `hash(conversationId)` 键控，`/stop` 的中止目标永远是**发送者自己的会话**——结构上不可能中止别人的 chat 或 dream；发送者自己没有会话时回复说明而非动作。SDK 串行派发不变，故 /stop 只能中止自己会话的后台 dream（或将来并发派发时自己正在跑的 turn）。已有 `/stop` 对 dream 的中止语义保留，仅限自己的会话。

## Dream 调度

配置 `{enabled,hour}`；本地时区每日 hour，启动及每分钟检查。每会话持久记录：

- `activity`：聊天活动计数；
- `reflectedActivity`：上次成功反思覆盖的活动计数；
- `pendingSince`：第一条尚未覆盖的活动时间；
- `lastDreamSuccess`：成功运行的完成时间；
- `lastDreamAttempt`：上次尝试开始时间（成功或失败前均写入，v2 新增；旧 state.json 缺省为 0）。

有未覆盖活动时，从 `pendingSince` 后的下一次 hour 开始到期；使用本地日历运算（不是 UTC date 字符串或固定“今天”筛选）。因此前一晚活动可以凌晨处理，忙时/离线错过后仍到期，成功后不因重启重复。

若 FIFO 忙，暂不加入 dream，下分钟重试；idle 会话在 FIFO 内真正 `await prompt(DREAM_PROMPT)`。反思读 MEMORY 并只整理当前可见上下文，不能恢复已压缩原文。

**运行标记使漏跑可检测、重复跑幂等**：尝试开始前先写 `lastDreamAttempt` 落盘。成功后写 `reflectedActivity = activity`、清 `pendingSince`、写 `lastDreamSuccess`，因此无新活动不重复、已覆盖 activity 不重复处理。核对 `MEMORY_SAVED` 失败时**不**推进成功标记；为避免每 60s 重跑模型（账单风险），未验证失败（`lastDreamAttempt > lastDreamSuccess`）会将该会话的到期时间推后到该次尝试后的下一个每日边界（`now >= dreamDueAt(lastDreamAttempt, hour)`）才重跑，`/status` 会提示「上次 dream 验证未通过」。而抛出/提供商错误会重置 attempt 标记（`lastDreamAttempt = lastDreamSuccess`），保留每分钟重试（可能瞬时故障）；这类错误**不**触发 `/status` 的验证未通过提示，而是通过日志与「有待处理活动」行（`pendingSince` 保留）可见。不新增状态字段。文本永不发微信。run 成功且标记可核对才视为成功。模型完成到状态落盘间崩溃可能重复，非 exactly-once。清理与反思完全串行，dream 不污染回复选择。

不新增调度器：复用 `main.ts` 已有的每分钟 `setInterval` 与启动时一次调用。

## 存储与部署

### 运行时兼容：fetch 垫片（main.ts）

Pi 在部分安装形态下会把自己携带的新版 undici 装成全局 fetch（`http-dispatcher.js` 的 `configureHttpDispatcher`：`setGlobalDispatcher` + `undici.install()`），而新版 undici 严格执行 fetch 规范，拒绝带 body 请求中手动设置的 `Content-Length` 头；微信 SDK 恰好每个请求都手动设这个头（`api.ts buildHeaders`）。两者叠加时，一旦 Pi 会话工厂就位，微信 SDK 的所有请求都会死于 `invalid content-length header`（登录流程不建 Pi 会话，因此不受影响）。垫片在 Pi 会话工厂创建之后、微信 SDK 启动之前包一层 fetch，剥掉带 body 请求的手动 `Content-Length`（undici 会自行重算）；Pi 的 `shouldInstallGlobals` 保护会保留被替换的 fetch，不会被覆盖。该问题与 Pi/undici 版本耦合（锁定的 pi 1.3.0 库路径上未必触发，线上已实际触发）；升级 Pi 后若微信请求报同类错误，先检查垫片位置是否仍在工厂之后、启动之前。

```text
<resolved dataDir>/
  openclaw-weixin/             # 微信 SDK 的真实子树，不是 openclaw/
  state.json                  # owner、认领、成员名册/邀请、UUID 映射、活动/反思/attempt 标记
  conversations/<hash>/       # cwd / AGENTS.md / MEMORY.md / memory/<topic>.md / media/
<service HOME>/.pi/agent/
  sessions/<encoded-cwd>/...jsonl   # 默认外部 Pi 会话位置
  auth.json / models.json / settings.json / ...
```

`PI_CODING_AGENT_DIR` 可改 Pi 根。完整备份还需配置和私有环境变量；只备份 data 不够。恢复默认保持 dataDir 绝对路径，以维持 Pi cwd 编码目录；迁移路径必须人工核对。状态写同目录临时文件、fsync、rename、目录 fsync；文件 600，目录 700。没有承诺横跨 Pi JSONL 与 bridge JSON 的分布式事务。

systemd 仅提供可编辑非 root 示例，不自动安装；先手动认证/扫码/认领。Pi 能执行 shell，cwd 不是沙箱，默认全局资源会被原生发现。SDK 会在桥接授权之前处理 echo/debug 和下载附件；不调用 Pi 但有 I/O/日志风险。不做主动推送、多个 owner、沙箱或持久消息重投队列；媒体仅限上文受限通道（无音频出站、无视频入模、无 OCR/转写自研）。

## 验证边界

离线测试覆盖 fake session/clock/temp dir 下的授权、一次性码预算、故障拒绝、路径、精确恢复/clear、并发、午夜/离线/忙/失败 dream、关闭和新鲜回复识别；写后校验（成功/失败/仅提及标记/带尾注/列表项/topic 命中/重复要求已有事实/无标记）、命令式记住匹配、dream 幂等与漏跑检测、自省命令鉴权与行为（含 /stop 确实调用 abort）、记忆索引超限、非目录 memory 路径；入站图片与文件/视频统一复制到 media/ 并以路径注记（媒体字节不进提示词；图片扩展名由魔数嗅探补充、未知保持 .bin）、复制失败降级（chat 不中断、无路径泄漏）、文件/视频复制与路径注记（含重名后缀、恶意文件名、源缺失降级）、语音透传（有字/无字）、ATTACH 解析单测与集成（有效 image/video/file、越界/绝对路径/目录/缺失/符号链接逃逸拒绝、多条取舍、与 MEMORY_SAVED 组合及顺序颠倒取舍）；多用户家庭版（邀请加入/过期/轮换/未认领不收人、管理命令仅 owner、/members //kick 序号与重编号、被踢者排队消息不执行且不再 dream、成员工作区/媒体/MEMORY 隔离、/stop 只中止自己的会话含 dream、旧 state.json 无感升级、新字段严格校验）；额外实际安装 SDK 测试只在隔离临时 HOME/agentDir 构建会话/JSONL、不 prompt，验证 AGENTS 注入、UUID 恢复和压缩开关。

人工验收仍必需：微信 QR/真实文字往返、真实图片往返（发送→模型描述）、真实 ATTACH 文件往返、真实长上下文自动压缩、MEMORY 写入/读取质量、`MEMORY_SAVED` 标记在真实模型下的可靠性、真实 dream 后文件变化及无微信反思回复、真实 `/status` `/cost` `/context` `/compact` `/stop` 往返。详见 README。
