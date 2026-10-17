# pi-wx-agent

把 [Pi](https://github.com/earendil-works/pi) 作为个人助理接到微信：扫码登录、一次性认领、家人邀请制、持久对话、原生自动压缩、图片/文件收发、文件记忆和夜间反思。使用 `weixin-agent-sdk@0.5.0` + `@earendil-works/pi-coding-agent@1.3.0`，进程内 SDK，不需要公网入站端口。

**安全前提：Pi 可以直接执行 shell、读写服务账号能访问的文件，不逐次弹权限确认。只认领自己的微信，只邀请信得过的家人，使用专用非 root 账号，不要授予 sudo。cwd 不是沙箱。** 克隆仓库不提供模型额度、API 密钥或微信账号。模型调用（包括压缩、dream）可能收费。

## 环境

- Node.js **>=22.19.0**（依赖的实际最低版本；推荐最新 Node 22 LTS）、npm，Linux 推荐用于 systemd。
- 自己的微信及 SDK 支持的扫码服务；能访问微信和模型服务的网络。
- 可用的 Pi 模型/API 认证。只安装本地 npm 依赖，不依赖主机全局 Pi、不使用全局安装软链接。

## 从 clone 到第一条回复

在克隆后的项目目录，以今后运行服务的同一专用账号执行：

```sh
npm ci
npm run build
npm test
cp config.example.json config.json
```

### 1. 配置模型认证（必需）

运行本仓库安装的 Pi CLI：

```sh
./node_modules/.bin/pi
```

在 Pi 内 `/login` 登录支持的提供商或保存自己的 API key，`/model` 选择可用模型（Ctrl+S 保存默认），然后退出。也可以通过提供商环境变量提供密钥，例如 `ANTHROPIC_API_KEY`；不要把密钥写进本项目配置、Git 或命令历史。systemd 不继承交互 shell 的环境变量，需单独配置受保护的 EnvironmentFile。

默认模型来源：`config.model` 指定值 → Pi 默认 provider/model → 第一个可用模型。可以在 `config.json` 显式固定：

```json
{
  "dataDir": "./data",
  "model": { "provider": "your-provider-id", "id": "your-model-id" },
  "dream": { "enabled": true, "hour": 3 }
}
```

填写 Pi `/model` 显示的真实 provider/id，不要原样使用占位符。自定义兼容端点配置在 Pi `models.json`，详见安装包 `docs/models.md`、`docs/providers.md`。启动会验证模型可用性，但不能保证凭据未过期、余额充足、端点可达；实际运行失败会返回通用错误，不向微信转发原始异常。固定配置模型也用于恢复会话，修改它会改变后续使用的模型，不删除历史。

### 2. 扫码并认领

```sh
node dist/main.js start --config config.json
```

首次在交互终端自动请求扫码。终端显示 `OWNER_CODE=...` 后，在微信向 bot **只发送等号后的完整码**。收到「认领成功」后发送普通文字即可。只有这一个会话能调用 Pi。后续启动复用登录态和 owner，不再次扫码或开放认领。

- 认领码为 128-bit 随机值，**10 分钟有效、全局最多 5 条未授权消息尝试、只能用一次**。认领消息本身不进入 Pi。
- 有效期、尝试次数、码的哈希落盘；重启不刷新预算，不重新打印原码。
- 过期/输错/遗失码：**先停服务**，运行下面命令生成新码，再立即启动并认领：

  ```sh
  node dist/main.js claim --config config.json
  node dist/main.js start --config config.json
  ```

- `claim` 无权更换已认领 owner。需要迁移 owner 时请先停服务、备份，使用新的 dataDir 完整重新初始化，而不是在线改状态文件。任何人拿到有效码都可能抢先认领；终端和 journal 日志应仅管理员可见。
- 一个 dataDir **只允许一个进程**。不要同时启动前台和 systemd，不要运行中执行 claim/login；v1 没有跨进程锁。

### 3. 邀请家人（成员邀请制）

认领完成后，owner（部署者）可以把 bot 开放给家人使用：

- **`/invite`（仅 owner）**：生成 128-bit 邀请码，**24 小时内有效，窗口内多人可用同一码**；再次 `/invite` 立即作废旧码。码本身只出现在微信回复里，状态只落盘哈希。
- **加入**：未授权会话在微信里**原样发送这串码**即成为成员，收到欢迎语（说明这是部署者的助理、用量由部署者承担）。owner 未认领前，任何人无法经邀请码加入。
- **`/members`（仅 owner）**：按加入顺序列出成员序号与加入时间（不显示哈希）；序号供 `/kick` 使用。
- **`/kick <序号>`（仅 owner）**：按 `/members` 序号移除成员，回复含该成员的加入时间（便于核对序号是否因中途有人加入而错位）；被移除者下一条消息回到「未授权」，已排队的消息也不会执行。owner 不在成员列表里，不可能被踢。**踢人同时作废当前邀请码**（被踢者聊天记录里的旧码最多还能用 24h，不轮换即可静默重新加入；未完成加入的家人需要新码，再次 `/invite` 生成）。移除不是擦除：其工作区/记忆保留，重新邀请后原会话恢复。

**信任边界**：成员是你信任的家人——无沙箱，与 owner 同享 Pi 的 shell/文件能力；所有成员的模型用量（含 dream、压缩）都由部署者承担（`/cost` 本就按会话统计）。**硬隔离**：每个会话（含 owner）的对话、工作区、MEMORY 与媒体完全按 conversationId 哈希分目录，互不可见，也不存在任何跨会话记忆读取。踢人/邀请不影响其他人的会话。

### 4. 明确重新登录

扫码过期（SDK errcode `-14`）、想换登录时：停服务后执行

```sh
node dist/main.js login --config config.json
```

此命令先删除该 dataDir 下所有已存微信账号凭据，再扫码保存新登录；**不会更换 owner 或删除 Pi 历史**。扫码失败后需要重试。之后重新 `start`。未登录的非交互服务会清楚报错退出，不在后台无限等扫码。

## 会话、记忆与 dream

- 普通文字等待一次 Pi run 完成后发送一次回复，不流式刷屏。SDK 本身全局串行；本桥接再用同一 FIFO 边界串行化 chat / clear / dream。新消息等待上一个 run，而不是把 `followUp()` 入队误认为已得到回复。
- **进度反馈就是微信输入状态指示器**：SDK 在调用 agent 前即向微信发送 typing 状态，并每 10 秒自动续期（`process-message.ts` 中 `startTyping` / `setInterval(startTyping, 10_000)`），`agent.chat()` 全程有效（包括长任务），回复后在 finally 中取消。因此无需额外 ack 消息，本桥接也**不做主动推送**（不调用 `Bot.sendMessage()`）。若部署环境未取得 typing ticket，则不显示输入状态（SDK 行为）。
- **运行时兼容垫片**：部分安装形态下 Pi 会把自带的新版 undici 装成全局 fetch，它会拒绝微信 SDK 每请求手动设置的 `Content-Length` 头，导致登录后所有消息轮询失败；桥接在 Pi 会话工厂就位后剥掉该头（undici 自行重算）。升级 Pi 后若微信请求报 `invalid content-length`，先检查垫片（`main.ts`）是否仍在工厂创建之后、SDK 启动之前（详见 DESIGN「运行时兼容」）。

## 媒体收发

- **入站媒体统一走 `media/`**：图片与文件/视频完全同路：原文件复制到该会话工作区 `media/` 子目录（文件名只取 basename、重名自动加后缀，不拼接用户提供的路径），提示词中标注工作区相对路径（如 `[文件: media/年报.pdf]`、`[图片: media/xxx.jpg]`），模型按需用自己的文件/图片工具读取。**任何媒体字节都不进入提示词**（不经 `PromptOptions.images`、无 base64、无 MIME 白名单与大小上限——SDK 自身已限制下载大小）。复制失败（含源不可读）降级为文本注记，chat 不会失败，原始路径不进入提示词。
- **图片副本扩展名**：SDK 对所有入站图片统一上报 `mimeType: "image/*"`、临时文件为 `.bin` 后缀，桥接以魔数嗅探（只读文件头 16 字节：PNG/JPEG/GIF/WEBP）决定副本扩展名 `.jpg/.png/.gif/.webp`；原名已有真实扩展名则保留，魔数未知则保持 `.bin`（仍复制并注记路径，嗅探仅用于命名）。注意 SDK **不回填用户原始文件名**（`fileName` 恒为空）：注记与副本名来自其临时文件（文件按 MIME 保留扩展名），不是用户发送时的原名。
- **入站语音**：微信的转写文字已在消息文本里，桥接只加 `[语音] ` 前缀；转写为空时才注记「转写不可用」。音频文件本身不进入 Pi（Pi 无音频输入）。
- **出站附件（ATTACH 约定）**：模型可把文件写进本会话工作区，并在回复**末尾**用一行 `ATTACH: <工作区相对路径>` 结尾。桥接剥离该行、把路径解析到该会话工作区内并校验：必须落在工作区内（按 **realpath** 判定：拒绝 `../`、绝对路径、以及指向工作区外的符号链接），必须是已存在的普通文件（拒绝目录/缺失/断链）；按扩展名映射为微信附件类型（jpg/png/webp/gif/bmp → 图片，mp4/mov/webm 等 → 视频，其余 → 文件），作为该回复唯一的附件随文字一起发送。校验失败则只剥标记、记 `attach-rejected` 诊断、不附文件，回复文字不变。多条 ATTACH 行只取第一条，其余丢弃并记 `attach-dropped`。出站不支持音频；每条回复最多一个附件（SDK 限制）。约定写入工作区 `AGENTS.md` 模板（已有工作区不自动改写，需手动刷新才能让模型知道新约定）。
- **入站去重（不做）**：SDK 长轮询在**派发消息给 agent 之前**就把 get_updates 游标落盘（`monitor.ts`：先 `saveGetUpdatesBuf` 再进入消息循环），崩溃只会丢消息不会重放（at-most-once），因此桥接不做消息去重，也没有重投队列。唯一边缘情况：若游标落盘本身失败（磁盘错误等），同一批消息可能被重新拉取并再次派发——罕见的重复窗口，桥接同样不做去重。
- **会话自省命令**（桥接层拦截，鉴权与 chat/clear 相同，未授权不触发任何 Pi 调用；owner 与成员均可用，均只作用于自己的会话）：`/status`（会话/模型/上下文/dream/记忆索引）、`/cost`（累计 token 与费用，含被压缩历史）、`/context`（上下文占用）、`/compact [说明]`（手动压缩，走 Pi 原生 `compact()`）、`/stop`（请求中止**自己会话**当前任务，受下方 SDK 串行限制）。**管理命令仅 owner**：`/invite`、`/members`、`/kick <序号>`（见上节）；成员使用会被拒绝且不触发任何 Pi 调用。SDK 自带 `/echo`、`/toggle-debug`、`/clear` 仍在桥接之前处理；`/clear` 的鉴权仍由本桥接执行（成员只能清自己的会话）。注意 SDK 串行派发消息，因此 `/stop` 只能中止自己会话的后台 dream 或（若将来并发派发）正在运行的 turn，无法在一条 chat 尚未返回时插队中断它；**任何人都无法用 `/stop` 打断别人的任务**（会话按 conversationId 哈希隔离，中止目标永远是发送者自己的会话）。
- 每个授权 conversationId 的工作目录名为 SHA-256 哈希，不把用户 ID 拼进路径。owner 与成员都仅保存哈希；成员名册只存加入时间，不存任何可读身份。多用户角色见「邀请家人」一节。
- `/clear` 鉴权后重置 session 映射并 dispose；保留工作目录、`MEMORY.md` 和历史 JSONL。下一条消息新建会话，重启后也不会回到旧会话。**这不是隐私擦除。** SDK 的 clear 回调是同步接口，会先回复成功提示，实际清理在 FIFO 中完成；后续聊天一定排在清理之后。磁盘写失败会禁用当前桥接，需管理员处理后重启，不能把 SDK 提示当作磁盘事务成功证明。
- 会话 UUID 在首条 prompt 前作为 intent 落盘，Pi 按这个 UUID 创建 JSONL；重启按精确 ID 恢复，绝不“续最近的会话”。已成功运行的映射找不到 JSONL 会拒绝恢复，需补齐备份或明确 `/clear`。
- **自动压缩显式开启**：使用 Pi 原生 `compaction.enabled=true`，在 SDK 资源加载后施加，不修改全局设置；阈值/重试/摘要/JSONL 由 Pi 管理。压缩会丢失细节且需模型额度。
- 首次工作目录写入项目自有通用 `AGENTS.md`，不覆盖已有文件。Pi 原生加载 cwd、父目录及 Pi 全局 context 指令。
- **记忆两层（索引 + 详情）**：`MEMORY.md` 是索引，每条一行，提示词要求控制在约 150 行内；详情写入 `memory/<topic>.md`，按需读取。**索引超限只是被检测和上报，不会自动裁剪、也不阻止最新事实丢失**：`/status` 会显示行数并在超限时标注，每次实际执行的 dream 后都会记录 `memory-index-over-cap` 诊断；把细节移入 topic 文件、维持索引大小靠提示词约束模型（不做硬上限或自动迁移）。
- **写后验证（不假装成功）**：模型保存事实时须在回复末尾输出 `MEMORY_SAVED: <写入的原文>` 标记行（桥接只剥离末尾连续、以行首锚定的标记行，其它行原样保留）。桥接在运行**前**快照 `MEMORY.md` 与 `memory/*.md`，运行后核对：当标记的原文在运行后存在、且**存储内容在本轮确实发生变化**时才判为已写入；存储未变（模型什么都没写）则未确认，因此重复要求记住已有事实而模型不写任何东西不会被算作写入，而真正改写/合并/迁移已有事实（存储已变）会通过。核对失败则记录 `memory-write-unverified` 诊断并在回复后附加「记忆保存未能确认」提示。dream 同样核对，未通过则**不**标记成功、保留待处理活动下次重试。用户在消息里以命令式明确要求记住（如「记住这件事」）但回复没有任何标记，也按未确认处理。这是提示词驱动的尽力校验，不保证模型确实写对内容。若模型违反约定把 `MEMORY_SAVED:` 标记行放在回复**中间**，该行会原样发给用户（不计为声明，也不被剥离），用户可能看到标记文本。
- **`MEMORY.md` 在模型决定需要保存时创建**；不是代码强制提取，也不自动把文件全文直接塞入每条消息。
- **记忆是提示词驱动、非保证**：模型可能漏记、误记或写入失败；重要事实请检查文件并要求确认。不要发送凭据。清会话后记忆仍可读；要求忘记时检查文件，原始 JSONL/备份仍可能保留该事实。
- dream 默认启用，`hour` 是**服务进程本地时区** 0–23；可设置 `TZ` 或关闭 `dream.enabled`。启动及每分钟检查：从上次成功反思以来第一条未处理活动的下一次该小时开始到期，不按“今天是否聊天”筛选。凌晨能处理前一天活动，离线错过后补做；忙则下次检查，失败保留待处理状态。
- dream 对闲置会话真正 `await prompt()`，只整理当前可见上下文和已有 MEMORY，**不能找回已压缩的原文**，不向微信发送结果。成功标记持久化，无新活动不重复。
- **dream 运行标记（可检测 + 幂等）**：状态持久化 `lastDreamAttempt`（每次尝试开始前写入）与 `lastDreamSuccess`。重复运行幂等：无新活动不再运行；已覆盖的 activity 不重复处理。进程在模型完成但标记写入前崩溃，可能重复一次（非 exactly-once）；文件整理应当幂等。成功标记表示模型 run 成功且标记事实可核对，不保证 MEMORY 内容质量/一定写文件。为避免每分钟重跑模型：**未验证失败**（`lastDreamAttempt > lastDreamSuccess`）会等到该次尝试后的下一个每日边界才重跑，`/status` 会提示「上次 dream 验证未通过」；抛出/提供商错误会重置 attempt 标记并保留每分钟重试（可能瞬时故障），它们**不**触发该 `/status` 提示，而是通过日志和「有待处理活动」行可见。

## 数据与完整备份

`dataDir` 相对 **config 文件所在目录**解析为绝对路径。主入口在动态导入微信 SDK 之前设置 `OPENCLAW_STATE_DIR`，覆盖环境中的旧值。默认：

```text
data/
├── openclaw-weixin/          # SDK 实际子树：账号索引、凭据、同步游标/context 等
├── state.json               # owner/认领哈希、成员名册/邀请哈希、精确 session ID、活动/反思/attempt 标记
└── conversations/<sha256>/  # 每个授权会话（owner 与各成员）各自一个目录，互不可见
    ├── AGENTS.md             # 项目通用记忆+媒体规则（已有文件不覆盖）
    ├── MEMORY.md             # 索引：每条一行（模型按需创建/维护）
    ├── memory/<topic>.md     # 详情：按需读取
    └── media/                # 入站媒体副本（图片/文件/视频统一；出站附件也可写在此）
```

**只备份 data 不完整！** 停服务后一起备份：

1. `config.json`、整个 dataDir；
2. 服务账号的 `~/.pi/agent/`，尤其 **`sessions/<encoded-absolute-cwd>/*.jsonl`**、`auth.json`、`models.json`、`settings.json` 以及需要的 context/扩展/资源；如设置 `PI_CODING_AGENT_DIR` 则备份该目录；
3. 受保护的 provider 环境配置、服务 unit 和运行账号/路径/时区配置。

Pi JSONL 仍在默认外部位置，不移动到 dataDir；文件包含原始聊天和工具输出，敏感程度不低于凭据。恢复保持相同服务账号、Pi agent 目录和 **dataDir 绝对路径**，否则 Pi 的 cwd 编码目录变化、精确 ID 查找可能失败。路径迁移需人工核对/迁移对应的 session 子目录；先做备份，不直接在线移动。更换主机后微信/OAuth 仍可能要求重新登录。备份应加密，不上传到公开仓库。

默认 data/config、node_modules、dist、内部开发记录和 `.pi/subagents` 已忽略；**自定义 dataDir 或其他密钥文件需自己加入忽略规则或放仓库外**。新状态文件 mode 600、目录 700、入口 umask 077；不会修复所有旧文件权限。SDK 可能在系统临时目录 `weixin-agent/media/` 下载附件，需按自己的保留策略清理。

## systemd（示例，不自动安装）

先用专用非 root 用户完成上述模型认证、扫码和认领，Ctrl+C 停前台。编辑 `pi-wx-agent.service`：

- `User/Group` 改成专用用户，工作目录和 `--config` 指向实际位置；
- `ExecStart` 使用 **绝对 Node 路径且版本 >=22.19.0**；nvm 用户安装不一定在 `/usr/bin/node`，同时调整 PATH 给工具子进程；
- HOME / 可选 `PI_CODING_AGENT_DIR` 必须与手动认证一致；确保项目、dataDir、Pi session 目录可写；
- 如需 API key，使用仅管理员/服务账号可读的 EnvironmentFile；不要把密钥放 unit 或 Git；
- 示例 `NoNewPrivileges`、`PrivateTmp`、`ProtectSystem` 不是完整沙箱，可能限制某些工具操作。按实际需求评估，不应为了方便改成 root。

确认后才由管理员手动执行（本项目不会替你执行）：

```sh
sudo install -m 0644 pi-wx-agent.service /etc/systemd/system/pi-wx-agent.service
sudo systemctl daemon-reload
sudo systemctl enable --now pi-wx-agent
sudo journalctl -u pi-wx-agent -f
```

停止：`sudo systemctl stop pi-wx-agent`。SIGINT/SIGTERM 停定时器和微信轮询、abort Pi、dispose 会话；10 秒退出上限，systemd 15 秒停止超时覆盖残留子进程。不要在仍运行时复制状态或重新扫码。

## 限制与安全边界

- **仅支持上述受限的媒体通道**。所有入站媒体以工作区 `media/` 副本 + 路径注记形式供模型自行读取（媒体字节不进提示词；副本名来自 SDK 临时文件，非用户原名；图片扩展名由魔数嗅探补充）；语音只透传转写文字。出站附件仅限该会话工作区内真实路径（realpath 判定，含符号链接）、每回复一个、不支持音频。SDK 可能在鉴权**之前**下载媒体并记录消息/用户信息。
- SDK `/echo`、`/toggle-debug` 在桥接鉴权之前处理，不调用 Pi；不能承诺对陌生人完全静默。`/clear` 在桥接明确鉴权，未授权不会触碰 Pi。
- 成员与 owner 同样信任、同样无沙箱：家人可信是前提（部署者自行拍板），不是安全边界；真正的边界只有会话/工作区/记忆的按会话哈希隔离，以及未授权拒绝。被踢成员的数据不删除（非隐私擦除），只是失去访问权。
- Pi 本地全局指令、扩展、skills、设置按 SDK 原生发现；使用干净专用账号并审查这些内容。不提供远程权限弹窗、沙箱、向量数据库、媒体模型、多进程/多账号管理、主动提醒。
- **记忆校验仍是提示词驱动**：`MEMORY_SAVED` 标记可能被模型遗漏（此时按未确认提示，不假装成功）；校验只断言「标记的原文在运行后存在、且记忆存储在本轮发生变化」，不证明内容正确、无重复或与用户本意一致；没有独立 LLM 提取或数据库。
- **既有工作区不自动迁移**：v1 工作区里已存在的 `AGENTS.md` 不会被覆盖。若要采用两层记忆与写后校验约定，需管理员手动把新模板复制进该工作区（日志会记录一条迁移提示）。
- 文本回复只取本轮新产生的成功 assistant 事件，拒绝错误/中止/截断或无输出的 run，不发送上次回复或 dream 文本。
- SDK 长轮询断线重试；账号过期需人工 login。SDK 在派发给 agent 前就持久化同步游标：崩溃可能丢消息但不会重放（at-most-once），没有自建持久消息队列，也未做去重。
- 未授权输入不能调用 Pi，但 owner 发来的网页、文件、引用仍可有 prompt injection。模型/工具能读取服务用户的凭据并联网，哈希目录不是隔离措施。日记、JSONL、MEMORY、日志均应私有。

## 本地验证与人工验收

```sh
npm ci
npm run build
npm test
node dist/main.js --help
```

测试用 fake sessions、时钟和临时目录验证认领、鉴权、路径、重启、clear、并发、dream 追补/重试/标记、写后验证（成功/失败/无标记/topic 文件命中）、dream 幂等与漏跑检测、自省命令鉴权与行为、记忆索引超限、入站图片统一复制到 media/（魔数定扩展名、无提示词图片字节、未知魔数保 .bin）、复制失败降级、文件/视频复制与路径注记、语音透传、ATTACH 解析（有效图片/视频/文件、越界/缺失/目录拒绝、多行取舍、与 MEMORY_SAVED 组合）；多用户家庭版（邀请码加入/过期/轮换、管理命令仅 owner、/members //kick 序号与重编号、被踢者排队消息不执行且不再 dream、成员工作区/媒体/MEMORY 隔离、/stop 只中止自己的会话、旧 state.json 无感升级、新字段严格校验）；额外用安装的 Pi SDK 验证 JSONL 和原生压缩开关/AGENTS 注入，**不扫码、不读真实凭据、不调用模型**。

需要部署者手动确认：扫码成功、认领后真实文字往返、陌生人 chat/clear 被拒、重启延续、`/clear` 后新上下文与 MEMORY 读取、真实图片往返（微信发送图片能被模型描述）、真实文件收发（ATTACH 约定在真实模型下的可靠性）、真实长上下文自动压缩、到期 dream 更新文件且微信不收到反思文字、`/invite` 后家人发码加入并正常对话、`/members`/`/kick` 生效、两个成员 MEMORY 互不可见、A 运行中 B 发 `/stop` 不影响 A。真实模型记忆质量/微信媒体兼容性无法靠离线测试保证。

设计细节见 [docs/DESIGN.md](docs/DESIGN.md)。MIT License。
