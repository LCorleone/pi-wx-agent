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

微信 SDK 原生全局串行，但定时 dream 与同步 clear 回调不在同一异步生命周期，桥接必须共享一个 FIFO。只支持一个 owner、文本回复，不引 cron 库/数据库/外部模型提取管道。

模块：`main.ts` 管配置/微信登录/停止/定时器；`config.ts` 校验配置；`state.ts` 管可验证的原子持久状态；`memory.ts` 读写两层记忆（索引/topic、行数、原文核对）；`pi-agent.ts` 管认领/串行生命周期/命令/记忆规则/dream；`pi-session.ts` 适配并验证真实 Pi API。没有全局安装依赖。

## 启动与 owner

1. 读配置，dataDir 相对配置文件解析为绝对路径，umask 077。
2. 在动态导入微信 SDK **之前**设置 `OPENCLAW_STATE_DIR=dataDir`。
3. start 校验 Pi 模型配置/可用认证，不执行付费 prompt；首次交互式扫码，后续复用登录。后台无登录直接报错。
4. 没有 owner 且没有旧认领状态时创建随机 128-bit 码。只打印一次；状态仅存 hash、10 分钟到期时间、全局 5 次尝试预算。
5. 认领成功先原子写 owner 哈希/删除认领码，再回复成功，不调用 Pi。重启不刷新预算；本地 `claim` 可显式轮换未认领窗口，不可替换 owner。
6. 未授权 chat 返回「未授权」，clear 同步抛出「未授权」供 SDK 捕获；二者都不创建/恢复/运行 Pi。写入错误禁用当前桥接，损坏状态拒绝启动，不自动重置授权。

一个 dataDir 只允许一个进程；没有跨进程锁。`claim/login` 必须停服务后执行。显式 `login` 清 SDK 账号凭据并重新扫码，不清 owner/会话。SDK 没有导出 adequate pairing API，因此自实现有限认领。

## chat 与 clear

授权后 chat 入 FIFO，读取/新建 `dataDir/conversations/<sha256(conversationId)>`，不以原始 ID 拼路径。首次写项目自有 `AGENTS.md`（已有文件不覆盖；若已有文件内容与当前模板不同，仅记录一条迁移提示，绝不改写）。

**会话自省命令**在桥接层（`chat()` 鉴权之后、入 FIFO 之前）拦截，与 chat/clear 同等鉴权：未授权直接返回「未授权」且不创建/恢复/运行任何 Pi。支持 `/status`、`/cost`、`/context`、`/compact [说明]`、`/stop`。SDK 自带 `/echo`、`/toggle-debug`、`/clear` 仍在桥接之前处理（`/clear` 的鉴权由本桥接执行）。

- `/status`、`/cost`、`/context` 是只读：读 `getSessionStats()`、`getContextUsage()`、`session.model`/`thinkingLevel`，不触发模型调用；无活跃会话时返回明确提示。`/status` 还展示 dream 覆盖计数、上次成功/尝试时间与记忆索引行数。
- `/compact` 入 FIFO 并调用 Pi 原生 `session.compact(customInstructions?)`（其内部先 `abort()`），返回 `tokensBefore`/`estimatedTokensAfter`；上下文太小或已压缩会失败并给出通用提示，不向微信转发原始异常。
- `/stop` 调用 `session.abort()`。因 SDK 串行派发消息，`/stop` 无法在一条 chat 尚未返回时插队中断它，只能中止后台 dream 或（若将来并发派发）正在运行的 turn；文案如实描述。

持久映射使用 UUID intent：在 Pi 首次 prompt 前写 `state.json`；通过 `SessionManager.create(cwd, undefined, {id})` 创建相同 UUID。Pi 首个 user message 即创建 JSONL，不必等 assistant。恢复使用 `SessionManager.findById(cwd,id)` 和 `open(path,undefined,cwd)`，验证 ID；没有文件且未完成首轮时可用同一 ID 重建空 intent；已成功运行后文件缺失必须报错，不能偷偷续最近或开新会话。

每轮记录持久 activity 计数，再等待 idle session 的 `prompt()` 完整执行。不调用 `followUp()` 充当同步执行：它只承诺排队/消费，不承诺对应回复完成。只接受本轮 `message_end` 的新 assistant 最终成功文本（stopReason=stop），不取可能属于之前 dream/失败 run 的 `getLastAssistantText()`。失败返回通用提示，避免向微信泄漏原始异常。

clear 同步鉴权并递增代际编号，使尚未返回的旧 chat 回复/旧排队请求失效，然后在 FIFO 内持久删除映射、dispose。后续 chat 排在 clear 后新建 UUID。工作目录/MEMORY 和旧 JSONL 不删。SDK 的 clear 回调不 await，因此微信自带成功提示可能先于磁盘清理；这不是完整事务确认。持久失败禁用当前 bridge 并记录日志。

关闭时阻止新任务，取消定时器/轮询，abort、等待队列、dispose；10 秒进程退出上限。已发送给微信 SDK 的回复不可撤销；SDK 实际串行派发确保网络发送与下一条收到的 clear 有序。

## 原生压缩与记忆

`SettingsManager.applyOverrides({compaction:{enabled:true}})` **在 createAgentSession 完成后**执行；安装版本的 ResourceLoader.reload 会重载并丢弃提前设置的 overrides。立即检查 `session.autoCompactionEnabled`。不修改操作员全局设置，不另写摘要算法；阈值和摘要的正确性依赖 Pi/model。手动压缩（`/compact`）走同一 Pi 原生 `session.compact()`，不自研摘要。

Pi 原生加载 cwd/父目录/agentDir 的 AGENTS 类 context 文件。项目的通用模板要求：

- **两层记忆**：`MEMORY.md` 是索引（每条一行，软上限约 150 行），详情放 `memory/<topic>.md` 按需读取；索引超限时把细节移入 topic 文件。`src/memory.ts` 的 `readMemoryStore`/`indexLineCount` 供桥接读取索引与 topic 文件、统计行数。**超限不自动裁剪、也不阻止丢失**，只在 `/status` 展示并在 dream 成功后记录 `memory-index-over-cap` 诊断；维持索引大小靠提示词约束模型。`readMemoryStore` 对不可读/非目录的 `memory` 路径按「无 topic」处理，永不抛出。
- **写后校验（不假装成功）**：模型保存事实时须输出 `MEMORY_SAVED: <原文>` 标记行。`parseSavedClaims` 只剥离**末尾连续、行首锚定**的标记行（`/^\s*[-*]?\s*MEMORY_SAVED:\s*(\S.*)$/`）得到用户可见文本并收集声明；正文中提到标记、或标记不在行首的行一律原样保留。桥接在运行**前**对工作区取快照（`readMemoryStore`），运行后用 `factInStore` 在 `MEMORY.md` 与 `memory/*.md` 中核对：仅当原文在运行后存在**且运行前不存在**时判为已写入，因此重复要求记住已有事实不算本轮写入。核对失败记录 `memory-write-unverified` 并在回复后追加提示；dream 核对失败则不标记成功、保留待处理活动重试。用户以命令式明确「记住」但无任何标记也按未确认处理（`REMEMBER_INTENT` 要求命令式+宾语，如「记住这件事」）。
- 不记录秘密；实际检查写入，不凭空承诺保存。

MEMORY 是磁盘文件，不是额外 LLM 提取流程；模型是否正确读写不保证。校验是提示词驱动、尽力而为：标记可能被遗漏或与实际写入不符。压缩/clear 不删文件；原始 JSONL/备份可能仍含已要求忘记的内容。分发模板不包含任何部署者私人指令。既有工作区不会被自动改写，需手动迁移才能采用新约定。

## Dream 调度

配置 `{enabled,hour}`；本地时区每日 hour，启动及每分钟检查。每会话持久记录：

- `activity`：聊天活动计数；
- `reflectedActivity`：上次成功反思覆盖的活动计数；
- `pendingSince`：第一条尚未覆盖的活动时间；
- `lastDreamSuccess`：成功运行的完成时间；
- `lastDreamAttempt`：上次尝试开始时间（成功或失败前均写入，v2 新增；旧 state.json 缺省为 0）。

有未覆盖活动时，从 `pendingSince` 后的下一次 hour 开始到期；使用本地日历运算（不是 UTC date 字符串或固定“今天”筛选）。因此前一晚活动可以凌晨处理，忙时/离线错过后仍到期，成功后不因重启重复。

若 FIFO 忙，暂不加入 dream，下分钟重试；idle 会话在 FIFO 内真正 `await prompt(DREAM_PROMPT)`。反思读 MEMORY 并只整理当前可见上下文，不能恢复已压缩原文。

**运行标记使漏跑可检测、重复跑幂等**：尝试开始前先写 `lastDreamAttempt` 落盘；`lastDreamAttempt > lastDreamSuccess` 即表示上次尝试未成功，`/status` 会提示。成功后写 `reflectedActivity = activity`、清 `pendingSince`、写 `lastDreamSuccess`，因此无新活动不重复、已覆盖 activity 不重复处理。核对 `MEMORY_SAVED` 失败时**不**推进成功标记，活动保留到期重试。文本永不发微信。失败不更新成功标记，后续重试；run 成功且标记可核对才视为成功。模型完成到状态落盘间崩溃可能重复，非 exactly-once。清理与反思完全串行，dream 不污染回复选择。

不新增调度器：复用 `main.ts` 已有的每分钟 `setInterval` 与启动时一次调用。

## 存储与部署

```text
<resolved dataDir>/
  openclaw-weixin/             # 微信 SDK 的真实子树，不是 openclaw/
  state.json                  # owner、认领、UUID 映射、活动/反思/attempt 标记
  conversations/<hash>/       # cwd / AGENTS.md / MEMORY.md / memory/<topic>.md
<service HOME>/.pi/agent/
  sessions/<encoded-cwd>/...jsonl   # 默认外部 Pi 会话位置
  auth.json / models.json / settings.json / ...
```

`PI_CODING_AGENT_DIR` 可改 Pi 根。完整备份还需配置和私有环境变量；只备份 data 不够。恢复默认保持 dataDir 绝对路径，以维持 Pi cwd 编码目录；迁移路径必须人工核对。状态写同目录临时文件、fsync、rename、目录 fsync；文件 600，目录 700。没有承诺横跨 Pi JSONL 与 bridge JSON 的分布式事务。

systemd 仅提供可编辑非 root 示例，不自动安装；先手动认证/扫码/认领。Pi 能执行 shell，cwd 不是沙箱，默认全局资源会被原生发现。SDK 会在桥接授权之前处理 echo/debug 和下载附件；不调用 Pi 但有 I/O/日志风险。v1 不做媒体模型、主动推送、多个 owner、沙箱或持久消息重投队列。

## 验证边界

离线测试覆盖 fake session/clock/temp dir 下的授权、一次性码预算、故障拒绝、路径、精确恢复/clear、并发、午夜/离线/忙/失败 dream、关闭和新鲜回复识别；写后校验（成功/失败/仅提及标记/带尾注/列表项/topic 命中/重复要求已有事实/无标记）、命令式记住匹配、dream 幂等与漏跑检测、自省命令鉴权与行为（含 /stop 确实调用 abort）、记忆索引超限、非目录 memory 路径；额外实际安装 SDK 测试只在隔离临时 HOME/agentDir 构建会话/JSONL、不 prompt，验证 AGENTS 注入、UUID 恢复和压缩开关。

人工验收仍必需：微信 QR/真实文字往返、真实长上下文自动压缩、MEMORY 写入/读取质量、`MEMORY_SAVED` 标记在真实模型下的可靠性、真实 dream 后文件变化及无微信反思回复、真实 `/status` `/cost` `/context` `/compact` `/stop` 往返。详见 README。
