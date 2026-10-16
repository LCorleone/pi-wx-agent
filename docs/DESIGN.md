# pi-wx-agent 设计（v1）

一套最小可用的个人 AI 助理：把 pi coding agent 桥接到微信，扫码即用。原则：最简实现，能用官方/SDK 原生能力就不写代码。

## 1. 架构

```
微信 ←(官方API/长轮询)→ weixin-agent-sdk
                            ↓ Agent.chat()
                       PiAgent（本项目唯一核心类）
                            ↓
              pi SDK createAgentSession（每 conversationId 一个）
```

## 2. 文件结构

```
pi-wx-agent/
├── package.json          # deps: weixin-agent-sdk + pi SDK
├── tsconfig.json
├── config.example.json   # 用户复制为 config.json 后填配置
├── .gitignore            # 忽略 node_modules/ dist/ data/ config.json
├── LICENSE               # MIT
├── src/main.ts           # login() → start(piAgent)
├── src/pi-agent.ts       # 白名单 + 会话映射 + prompt 封装（核心 ~100 行）
├── pi-wx-agent.service   # systemd（示例，README 指引安装）
└── README.md             # 快速开始：从 clone 到微信收到回复
```

两个源文件，一个核心类，没有抽象层。

## 3. 核心流程

**启动**：读 config → `login()`（首次扫码）→ `start(piAgent)`。

**收到消息 chat(request)**：

1. 白名单检查：conversationId 不在 allowlist → 回「未授权」，结束。
2. 取会话：Map 里没有就恢复/新建 `createAgentSession({ cwd: data/<conversationId>/ })`。
3. `session.isStreaming ? followUp(text) : prompt(text)`（pi 原生队列；流式时不带 streamingBehavior 调 prompt 会 throw）。
4. 回 `{ text: getLastAssistantText() }`。
5. 整个 chat() 包 try/catch：出错回一句错误提示，绝不向上抛（SDK 侧也有兜底，双保险）。

**/clear（clearSession）**：dispose 会话 + 从 Map 和映射文件删 id。cwd 不删 → 记忆保留，下一条消息开新会话。

**唯一必要胶水**：conversationId → pi sessionId 映射文件（`data/sessions.json`）。pi 会话文件懒创建，首条 prompt 完成后落盘 sessionId；重启后 `SessionManager.findById(cwd, id)` + `open(path)` 恢复。

## 4. 自动压缩（零代码）

pi 内置 auto-compact 默认开启（`compaction.enabled` 默认 true，reserve 16384 / keepRecent 20000）。本项目不写任何压缩逻辑。

## 5. 自动记忆（零管道）

pi 默认把 cwd 下的 AGENTS.md 注入上下文，记忆规则直接写在 AGENTS.md 里，不需要任何额外 API。

1. 每会话独立 cwd：`data/<conversationId>/`，首次创建时写入预置 AGENTS.md。
2. AGENTS.md 预置内容：助理人设 + 两条规则——「跨会话有用的事实（偏好、约定、日程）追加写入本目录 MEMORY.md」「需要回忆用户信息时先读 MEMORY.md」。
3. pi 用自带 edit 工具自己维护 MEMORY.md。
4. 效果：压缩/清会话/重启后，事实仍在（MEMORY.md 在磁盘上）。

不建：LLM 提取管道、向量库、记忆中间件。

### Dream：夜间反思（~20 行）

1. config：`"dream": { "enabled": true, "hour": 3 }`。
2. 进程内 setInterval 每小时检查（不引 cron 库）。
3. 到点对**当天活跃过**的每个会话：非 streaming 时 `followUp("【例行反思】回顾今天的对话，把值得长期记住的事实更新进 MEMORY.md：新增、修正、删过时条目，然后一句话确认。")`。
4. agent 在主会话上下文内反思（当天对话已在上下文，无需搬数据），用 edit 工具改 MEMORY.md；回复文本丢弃。
5. streaming 中则跳过，明晚再来。

白天 agent「自觉」记，晚上 dream 兜底整理——把碎片事实合并、删过时的，MEMORY.md 不会越长越烂。

## 6. 白名单引导（owner 认领，开箱即用的关键）

随机 OWNER_CODE 方案（~25 行）：

1. 首次启动生成 6 位随机码，打进控制台日志。
2. 部署者在微信里给 bot 发送这个码。
3. bot 校验后把该 conversationId 写入 `data/allowlist.json`，回复「认领成功」。
4. 之后其他陌生人发消息 → 回「未授权」。

无需改配置重启。allowlist 运行时可变，config.json 只放静态配置。

## 7. 配置与数据

```json
{
  "dataDir": "./data",
  "model": null,
  "dream": { "enabled": true, "hour": 3 }
}
```

全部运行态收在一个 `data/` 目录（进程启动时设 `OPENCLAW_STATE_DIR` 指向它）：

```
data/
├── openclaw/…      # 微信登录态（token，gitignore 保护）
├── allowlist.json  # 白名单
├── sessions.json   # conversationId→sessionId 映射
└── <wxid>/         # 每个用户的专属 cwd：AGENTS.md + MEMORY.md
```

仓库外只有：`~/.pi/`（pi 本体配置与模型认证，前置条件）和 `~/.pi/agent/sessions/`（pi 会话文件，pi 自管）。备份/搬家整个 bot = 拷贝本目录（含 data/）。

## 8. 部署

1. `npm run build`
2. 手动 `node dist/main.js` 跑一次 → 扫码 → 登录态落盘
3. `systemctl enable --now pi-wx-agent`（Restart=always；SDK 自带断线重连）

## 9. 不做（v1 明确出界）

媒体收发、流式分片、多用户管理界面、RAG、记忆提取管道、Docker/compose（pi 配置在 ~/.pi，容器化徒增复杂度；README 说明 Node 22 裸跑 + systemd）。

## 10. 关键技术事实（已对源码验证）

| # | 结论 | 出处 |
|---|------|------|
| 1 | pi SDK auto-compact 默认开启 | pi docs `compaction.md`（`compaction.enabled` 默认 true） |
| 2 | AGENTS.md 默认自动注入 cwd 及父目录 | pi docs `configuration.md`；SDK `DefaultResourceLoader` |
| 3 | 会话可按 id 恢复 | `SessionManager.findById(cwd, id)` + `SessionManager.open(path)` |
| 4 | 流式中 prompt 不带 streamingBehavior 会 throw | `AgentSession.prompt()` docstring；用 `session.isStreaming` 预检 |
| 5 | weixin-agent-sdk@0.5.0：npm 包，node>=22，消息循环全局串行、chat() 抛错 SDK 兜底、`/clear` 内置触发 clearSession、断线自动重试 | github.com/wong2/weixin-agent-sdk 源码 |
| 6 | 微信账号过期（errcode -14）需重新扫码 | SDK `session-guard.ts` |

## 11. 开箱即用验收

1. 陌生人视角：`git clone` → `npm install && npm run build` → 复制 config.example.json → `node dist/main.js` 扫码 → 发 OWNER_CODE → 微信收到 pi 回复。全程只看 README。
2. 仓库里无任何个人数据硬编码；登录态/会话/白名单全部在 .gitignore 的 data/ 与 config.json 内。
3. README 含：快速开始、白名单与安全警告（pi 能执行 shell，只认领自己）、systemd 部署、已知限制（全局串行、errcode -14）、常见问题。
