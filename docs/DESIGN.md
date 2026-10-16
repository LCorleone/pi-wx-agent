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

模块：`main.ts` 管配置/微信登录/停止/定时器；`config.ts` 校验配置；`state.ts` 管可验证的原子持久状态；`pi-agent.ts` 管认领/串行生命周期/记忆规则/dream；`pi-session.ts` 适配并验证真实 Pi API。没有全局安装依赖。

## 启动与 owner

1. 读配置，dataDir 相对配置文件解析为绝对路径，umask 077。
2. 在动态导入微信 SDK **之前**设置 `OPENCLAW_STATE_DIR=dataDir`。
3. start 校验 Pi 模型配置/可用认证，不执行付费 prompt；首次交互式扫码，后续复用登录。后台无登录直接报错。
4. 没有 owner 且没有旧认领状态时创建随机 128-bit 码。只打印一次；状态仅存 hash、10 分钟到期时间、全局 5 次尝试预算。
5. 认领成功先原子写 owner 哈希/删除认领码，再回复成功，不调用 Pi。重启不刷新预算；本地 `claim` 可显式轮换未认领窗口，不可替换 owner。
6. 未授权 chat 返回「未授权」，clear 同步抛出「未授权」供 SDK 捕获；二者都不创建/恢复/运行 Pi。写入错误禁用当前桥接，损坏状态拒绝启动，不自动重置授权。

一个 dataDir 只允许一个进程；没有跨进程锁。`claim/login` 必须停服务后执行。显式 `login` 清 SDK 账号凭据并重新扫码，不清 owner/会话。SDK 没有导出 adequate pairing API，因此自实现有限认领。

## chat 与 clear

授权后 chat 入 FIFO，读取/新建 `dataDir/conversations/<sha256(conversationId)>`，不以原始 ID 拼路径。首次写项目自有 `AGENTS.md`（已有文件不覆盖）。

持久映射使用 UUID intent：在 Pi 首次 prompt 前写 `state.json`；通过 `SessionManager.create(cwd, undefined, {id})` 创建相同 UUID。Pi 首个 user message 即创建 JSONL，不必等 assistant。恢复使用 `SessionManager.findById(cwd,id)` 和 `open(path,undefined,cwd)`，验证 ID；没有文件且未完成首轮时可用同一 ID 重建空 intent；已成功运行后文件缺失必须报错，不能偷偷续最近或开新会话。

每轮记录持久 activity 计数，再等待 idle session 的 `prompt()` 完整执行。不调用 `followUp()` 充当同步执行：它只承诺排队/消费，不承诺对应回复完成。只接受本轮 `message_end` 的新 assistant 最终成功文本（stopReason=stop），不取可能属于之前 dream/失败 run 的 `getLastAssistantText()`。失败返回通用提示，避免向微信泄漏原始异常。

clear 同步鉴权并递增代际编号，使尚未返回的旧 chat 回复/旧排队请求失效，然后在 FIFO 内持久删除映射、dispose。后续 chat 排在 clear 后新建 UUID。工作目录/MEMORY 和旧 JSONL 不删。SDK 的 clear 回调不 await，因此微信自带成功提示可能先于磁盘清理；这不是完整事务确认。持久失败禁用当前 bridge 并记录日志。

关闭时阻止新任务，取消定时器/轮询，abort、等待队列、dispose；10 秒进程退出上限。已发送给微信 SDK 的回复不可撤销；SDK 实际串行派发确保网络发送与下一条收到的 clear 有序。

## 原生压缩与记忆

`SettingsManager.applyOverrides({compaction:{enabled:true}})` **在 createAgentSession 完成后**执行；安装版本的 ResourceLoader.reload 会重载并丢弃提前设置的 overrides。立即检查 `session.autoCompactionEnabled`。不修改操作员全局设置，不另写摘要算法；阈值和摘要的正确性依赖 Pi/model。

Pi 原生加载 cwd/父目录/agentDir 的 AGENTS 类 context 文件。项目的通用模板只要求：每轮先读 MEMORY.md，长期有用的确认事实用 read/write/edit 保存、纠错、去重；不记录秘密，实际检查写入，不凭空承诺保存。

MEMORY 是磁盘文件，不是额外 LLM 提取流程；模型是否正确读写不保证。压缩/clear 不删文件；原始 JSONL/备份可能仍含已要求忘记的内容。分发模板不包含任何部署者私人指令。

## Dream 调度

配置 `{enabled,hour}`；本地时区每日 hour，启动及每分钟检查。每会话持久记录：

- `activity`：聊天活动计数；
- `reflectedActivity`：上次成功反思覆盖的活动计数；
- `pendingSince`：第一条尚未覆盖的活动时间；
- `lastDreamSuccess`：成功运行的完成时间。

有未覆盖活动时，从 `pendingSince` 后的下一次 hour 开始到期；使用本地日历运算（不是 UTC date 字符串或固定“今天”筛选）。因此前一晚活动可以凌晨处理，忙时/离线错过后仍到期，成功后不因重启重复。

若 FIFO 忙，暂不加入 dream，下分钟重试；idle 会话在 FIFO 内真正 `await prompt(DREAM_PROMPT)`。反思读 MEMORY 并只整理当前可见上下文，不能恢复已压缩原文。成功后标记覆盖的 activity，文本永不发微信。失败不更新成功标记，后续重试；run 成功不证明 MEMORY 写入质量。模型完成到状态落盘间崩溃可能重复，非 exactly-once。清理与反思完全串行，dream 不污染回复选择。

## 存储与部署

```text
<resolved dataDir>/
  openclaw-weixin/             # 微信 SDK 的真实子树，不是 openclaw/
  state.json                  # owner、认领、UUID 映射和 dream 状态
  conversations/<hash>/       # cwd / AGENTS.md / MEMORY.md
<service HOME>/.pi/agent/
  sessions/<encoded-cwd>/...jsonl   # 默认外部 Pi 会话位置
  auth.json / models.json / settings.json / ...
```

`PI_CODING_AGENT_DIR` 可改 Pi 根。完整备份还需配置和私有环境变量；只备份 data 不够。恢复默认保持 dataDir 绝对路径，以维持 Pi cwd 编码目录；迁移路径必须人工核对。状态写同目录临时文件、fsync、rename、目录 fsync；文件 600，目录 700。没有承诺横跨 Pi JSONL 与 bridge JSON 的分布式事务。

systemd 仅提供可编辑非 root 示例，不自动安装；先手动认证/扫码/认领。Pi 能执行 shell，cwd 不是沙箱，默认全局资源会被原生发现。SDK 会在桥接授权之前处理 echo/debug 和下载附件；不调用 Pi 但有 I/O/日志风险。v1 不做媒体模型、主动推送、多个 owner、沙箱或持久消息重投队列。

## 验证边界

离线测试覆盖 fake session/clock/temp dir 下的授权、一次性码预算、故障拒绝、路径、精确恢复/clear、并发、午夜/离线/忙/失败 dream、关闭和新鲜回复识别；额外实际安装 SDK 测试只在隔离临时 HOME/agentDir 构建会话/JSONL、不 prompt，验证 AGENTS 注入、UUID 恢复和压缩开关。

人工验收仍必需：微信 QR/真实文字往返、真实长上下文自动压缩、MEMORY 写入/读取质量、真实 dream 后文件变化及无微信反思回复。详见 README。
