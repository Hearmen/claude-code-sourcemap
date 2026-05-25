# Claude Code (@anthropic-ai/claude-code v2.1.88) 完整架构分析

> 源码来自 npm 包 sourcemap 还原，共 1,906 个 TypeScript/TSX 文件

---

## 一、整体架构概览

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                        Claude Code CLI (main.tsx)                           │
│                    Entry Point · Commander.js · Startup                     │
└──────────────┬──────────────────────────────────────────────────────────────┘
               │
       ┌───────▼────────┐
       │  CLI Layer      │
       │  commands.ts    │◄──── 100+ Commands (prompt/local/local-jsx)
       │  tools.ts       │◄──── 43 Tools (built-in + MCP merged)
       │  tasks.ts       │◄──── Task type registry
       └───────┬─────────┘
               │
    ┌──────────▼──────────────────────────────────────────────────┐
    │                    Core Execution Engine                     │
    │                                                              │
    │  ┌──────────────┐  ┌──────────────┐  ┌──────────────────┐  │
    │  │  query/      │  │  state/      │  │  bootstrap/      │  │
    │  │  Query Engine│  │  AppState    │  │  Global Session  │  │
    │  └──────────────┘  └──────────────┘  └──────────────────┘  │
    └──────────────────────────────┬──────────────────────────────┘
                                   │
    ┌──────────────────────────────▼──────────────────────────────┐
    │                       Services Layer                         │
    │                                                              │
    │  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌───────────┐  │
    │  │  api/    │  │  mcp/    │  │  lsp/    │  │ analytics/│  │
    │  │ Anthropic│  │  MCP     │  │  LSP     │  │ GrowthBook│  │
    │  │   API    │  │ Protocol │  │ Protocol │  │ Telemetry │  │
    │  └──────────┘  └──────────┘  └──────────┘  └───────────┘  │
    │  ┌──────────┐  ┌──────────┐  ┌──────────────────────────┐  │
    │  │  oauth/  │  │SessionMem│  │  remoteManagedSettings/  │  │
    │  │  Auth    │  │  Memory  │  │  policyLimits/           │  │
    │  └──────────┘  └──────────┘  └──────────────────────────┘  │
    └──────────────────────────────┬──────────────────────────────┘
                                   │
    ┌──────────────────────────────▼──────────────────────────────┐
    │                     Advanced Features                        │
    │                                                              │
    │  ┌────────────┐  ┌──────────┐  ┌──────────┐  ┌─────────┐  │
    │  │coordinator/│  │assistant/│  │ skills/  │  │plugins/ │  │
    │  │Multi-Agent │  │  KAIROS  │  │19 Skills │  │ Plugin  │  │
    │  │   Coord    │  │  Mode    │  │  System  │  │ System  │  │
    │  └────────────┘  └──────────┘  └──────────┘  └─────────┘  │
    │  ┌────────────┐  ┌──────────┐  ┌──────────┐               │
    │  │   vim/     │  │  voice/  │  │  remote/ │               │
    │  │  Vim Mode  │  │  Voice   │  │  Remote  │               │
    │  └────────────┘  └──────────┘  └──────────┘               │
    └──────────────────────────────┬──────────────────────────────┘
                                   │
    ┌──────────────────────────────▼──────────────────────────────┐
    │                        UI Layer (Ink.js)                     │
    │                                                              │
    │  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌───────────┐  │
    │  │components│  │ screens/ │  │  hooks/  │  │ context/  │  │
    │  │ 146 comp │  │  REPL    │  │ 87 hooks │  │ Providers │  │
    │  └──────────┘  └──────────┘  └──────────┘  └───────────┘  │
    └─────────────────────────────────────────────────────────────┘
```

---

## 二、模块一：核心入口 & CLI 层

### 启动序列

```
main.tsx 启动流程
─────────────────────────────────────────────────────────────────
[进程启动]
    │
    ├─► 并行预取 (side-effects)
    │       ├── profiling checkpoint
    │       ├── MDM raw read
    │       └── keychain prefetch
    │
    ├─► argv 预处理
    │       ├── 剥离特殊命令 (claude open / ssh / assistant)
    │       └── macOS deep link 处理 (__CFBundleIdentifier)
    │
    ├─► eagerLoadSettings()   ← 解析 --settings / --setting-sources
    ├─► initializeEntrypoint() ← 确定模式: cli / sdk-cli / mcp / remote
    ├─► runMigrations()        ← 版本迁移 (当前 v11)
    ├─► logSessionTelemetry()  ← skill/plugin 遥测
    │
    ├─► Commander.js 初始化
    │       ├── pre-action hook → 权限/模型/设置初始化
    │       └── action handler  → REPL 或 headless 执行
    │
    └─► 启动 REPL (交互) 或 structuredIO (headless)
```

### 注册表模式

```
commands.ts                    tools.ts
──────────────────────         ──────────────────────────
getCommands() [memoized]       getAllBaseTools()
    │                              │
    ├── prompt commands            ├── Core: Bash, FileRead/Write/Edit
    │   (skills → model)           ├── Search: Glob, Grep
    ├── local commands             ├── Agent: AgentTool, SkillTool
    │   (TUI output)               ├── Tasks: TaskCreate/Get/Update/List
    └── local-jsx commands         ├── MCP: MCPTool, ListMcpResources
        (Ink components)           ├── Planning: EnterPlanMode
                                   └── Conditional (feature-gated)

getMergedTools(ctx, mcpTools)
    = built-in tools + MCP dynamic tools
```

### Task ID 前缀规则

| 前缀 | Task 类型 |
|------|----------|
| `b`  | local_bash |
| `a`  | local_agent |
| `r`  | remote_agent |
| `t`  | in_process_teammate |
| `w`  | local_workflow |
| `m`  | monitor_mcp |
| `d`  | dream |

---

## 三、模块二：工具系统 (43 Tools)

### 工具基础接口

```typescript
// Tool.ts - 所有工具的基础接口
interface ToolDef<Input, Output> {
  name: string
  description(input, options): Promise<string>
  inputSchema: ZodSchema<Input>
  outputSchema?: ZodSchema<Output>
  call(input, ctx, canUseTool, parentMessage, onProgress): Promise<ToolResult<Output>>
  checkPermissions?(input, ctx): Promise<PermissionResult>
  isConcurrencySafe(input): boolean
  isReadOnly(input): boolean
  isDestructive?(input): boolean
  shouldDefer?: boolean
  renderToolUseMessage?(input): ReactNode
  renderToolResultMessage?(output): ReactNode
}
```

### 工具调用流程

```
工具调用流程
──────────────────────────────────────────────────────────────
Claude API 返回 tool_use block
        │
        ▼
getMergedTools() 查找工具定义
        │
        ▼
checkPermissions() ──► 需要确认? ──► PermissionRequest UI ──► 用户批准/拒绝
        │ (已授权)                                                    │
        ▼                                                             │
tool.call(input, ctx) ◄───────────────────────────────────────────────┘
        │
        ├── BashTool:     parseForSecurity() → spawnShellTask()
        ├── FileReadTool: 类型检测 → 图片压缩/PDF解析/文本读取
        ├── GrepTool:     ripgrep → 结果截断(max 250) → 相对路径
        ├── AgentTool:    fork 子进程 → 独立上下文
        └── MCPTool:      callMCPTool() → MCP server → 结果返回
        │
        ▼
renderToolResultMessage() → UI 渲染
        │
        ▼
tool_result block → 下一轮 API 调用
```

### 代表性工具对比

| 工具名 | 输入关键字段 | 核心能力 | 权限级别 |
|--------|------------|---------|---------|
| BashTool | command, timeout | Shell执行+安全分析 | 需确认(写) |
| FileReadTool | file_path, limit, pages | 多格式读取(图片/PDF/NB) | 自动允许 |
| FileEditTool | file_path, old/new_str | 精确字符串替换+diff追踪 | 需确认 |
| GrepTool | pattern, path, glob | ripgrep搜索+多输出模式 | 自动允许 |
| AgentTool | prompt, subagent_type | 子Agent派生+独立上下文 | 需确认 |
| MCPTool | server, tool, args | MCP协议代理调用 | 继承MCP权限 |
| TaskCreateTool | subject, description | 任务生命周期管理 | 自动允许 |

---

## 四、模块三：服务层

### API 服务 — 请求流

```
queryModelWithStreaming() 调用链
──────────────────────────────────────────────────────────────────
调用方 (query.ts)
    │
    ▼
buildQueryConfig()  ← 快照 feature flags, streaming gates
    │
    ▼
withRetry()  ← 指数退避, 529错误处理
    │           前台: 最多3次重试
    │           后台: 立即放弃
    ▼
SDK client.messages.create()
    │
    ├── 1P Anthropic API  (api.anthropic.com)
    ├── AWS Bedrock        (bedrock-runtime)
    ├── Azure Foundry      (azure endpoint)
    └── Google Vertex AI   (vertex endpoint)
    │
    ▼
SSE 流式响应 / 完整响应
    │
    ├── logAPISuccessAndDuration()  ← 延迟/token/缓存指标
    └── logAPIError()               ← 错误分类+网关检测
```

### MCP 服务 — 服务发现与工具代理

```
MCP 架构
──────────────────────────────────────────────────────────────────
配置来源:
  ~/.claude/mcp.json (global)
  .claude/mcp.json   (project)
  enterprise policy  (managed)
        │
        ▼
getAllMcpConfigs() → 去重 → 策略过滤
        │
        ▼
ensureConnectedClient()
    │
    ├── stdio transport   (本地进程)
    ├── SSE transport     (HTTP流)
    ├── HTTP transport    (REST)
    └── WebSocket transport
        │
        ▼
fetchToolsForClient()  ← LRU缓存(max 20 servers)
    │  工具名格式: mcp__<server>__<tool>
    │  描述截断: max 2048 chars
    ▼
getMergedTools() 合并到工具列表
        │
        ▼
callMCPTool()  ← 超时处理 (~27.8h default)
    │
    └── OAuth 认证 (PKCE flow) ← performMCPOAuthFlow()
```

### Analytics 遥测

- **双轨路由**：Datadog（通用后端，剥离 `_PROTO_*` PII 字段）+ 1P 内部日志（完整 payload）
- **约 60 种事件类型**：`tengu_api_success/error`、`tengu_tool_use_*`、`tengu_init/exit`、`chrome_bridge_*` 等
- **类型安全保护**：`AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS` 标记防止意外记录代码/路径
- **采样**：基于 `tengu_event_sampling_config` 动态配置

### 服务层关系图

```
┌─────────────────────────────────────────────────────────┐
│                     Services Layer                       │
│                                                          │
│  api/client.ts ──► Anthropic SDK ──► 4 providers        │
│       │                                                  │
│       ▼                                                  │
│  api/claude.ts (queryModelWithStreaming)                 │
│       │                                                  │
│       ├──► api/withRetry.ts    (弹性重试)                │
│       ├──► api/logging.ts      (遥测日志)                │
│       └──► api/errors.ts       (错误分类)                │
│                                                          │
│  mcp/client.ts ──► MCP servers ──► 动态工具              │
│       │                                                  │
│       ├──► mcp/auth.ts         (OAuth PKCE)              │
│       └──► mcp/config.ts       (多源配置)                │
│                                                          │
│  lsp/ ──► Language Server ──► 代码诊断/补全              │
│  oauth/ ──► Claude.ai OAuth ──► 用户认证                 │
│  SessionMemory/ ──► 会话记忆提取 (后台fork)              │
│  analytics/ ──► GrowthBook ──► 功能门控+遥测             │
└─────────────────────────────────────────────────────────┘
```

---

## 五、模块四：基础设施 & 状态管理

### AppState 数据流

```
AppState 数据流
──────────────────────────────────────────────────────────────────
用户操作 / 工具执行
        │
        ▼
store.setState(updater)   ← 不可变更新 + Object.is() 变更检测
        │
        ▼
onChange 触发
        │
        ▼
onChangeAppState()
    │
    ├── 权限模式变更 ──► notifySessionMetadataChanged() ──► CCR bridge
    ├── 模型选择变更 ──► updateSettingsForSource() ──► 磁盘持久化
    ├── 设置变更     ──► clearApiKeyHelperCache() ──► 下次重新获取
    └── 环境变量更新 ──► 应用到运行时
        │
        ▼
React useSyncExternalStore() ──► UI 重渲染
```

### 查询引擎流水线

```
query() 执行流水线
──────────────────────────────────────────────────────────────────
query(params, deps)
    │
    ├─► buildQueryConfig()     ← 快照 feature flags
    ├─► processUserInput()     ← 消息规范化
    ├─► queryModelWithStreaming() ← API调用 (via deps.callModel)
    ├─► runTools()             ← 工具执行循环
    ├─► handleStopHooks()      ← 后采样钩子
    │       ├── bash hooks
    │       ├── prompt hooks (LLM评估)
    │       ├── HTTP hooks
    │       └── agent hooks
    ├─► executePostSamplingHooks()
    └─► recordTranscript()     ← 会话记录

deps 依赖注入 (可测试):
    callModel / microcompact / autocompact / uuid
```

### Bootstrap 全局状态

```
bootstrap/state.ts — 全局单例
──────────────────────────────────────────────────────────────────
Session:    sessionId, projectRoot, workingDir
Model:      mainLoopModelOverride, modelUsage, costAccumulation
Auth:       oauthToken, apiKey, sessionIngressToken
Telemetry:  meters, counters, loggers, tracers
Features:   featureGates, settingsSources
Tasks:      cronTasks, scheduledTasks, teamContext
Trust:      trustFlags, mdmState, pluginConfig
```

### Bridge 通信状态机

```
replBridgeEnabled    → 期望状态
replBridgeConnected  → env已注册 + session已创建
replBridgeSessionActive → ingress WS已打开
replBridgeReconnecting  → 错误退避中
replBridgeConnectUrl    → Ready状态URL
replBridgeSessionUrl    → claude.ai会话URL
```

---

## 六、模块五：高级特性

### 多 Agent 协调 (Coordinator Mode)

```
Coordinator 架构
──────────────────────────────────────────────────────────────────
用户请求
    │
    ▼
Coordinator Agent (主)
    │  系统提示: 分解任务 → 指派 → 综合结果
    │
    ├──► AgentTool.spawn() ──► Worker Agent 1
    │                              ├── Bash/File/Grep tools
    │                              ├── MCP tools
    │                              └── Skill tools
    │
    ├──► AgentTool.spawn() ──► Worker Agent 2
    │                              └── (独立上下文)
    │
    └──► SendMessageTool ──► 跨Worker通信
         TeamCreateTool  ──► 团队管理
         SyntheticOutput ──► 内部消息(不暴露给用户)

特性门控: CLAUDE_CODE_COORDINATOR_MODE env + tengu_scratch feature gate
Scratchpad: 跨Worker持久化知识目录 (tengu_scratch gate)
```

### KAIROS 助手模式

| 维度 | Normal Mode | KAIROS Mode |
|------|------------|-------------|
| 会话长度 | 单轮/短会话 | 长期运行 |
| 状态存储 | 内存 | CCR backend 持久化 |
| 触发方式 | 手动 | 自主任务调度 |
| Skills | bundled skills | disk-based skills (dream.ts) |
| 通知 | 无 | Channels/Harbor 系统 |
| 门控 | — | `feature('KAIROS')` |

### 19 内置技能 (Bundled Skills)

| 技能名 | 用途 | 门控 |
|--------|------|------|
| updateConfig | 修改 Claude Code 配置 | 无 |
| keybindings | 查看/管理快捷键 | 无 |
| simplify | 简化代码或解释 | 无 |
| debug | 调试会话问题 | 无 |
| loremIpsum | 生成占位文本 | 无 |
| skillify | 将 markdown 转为 skill | 无 |
| batch | 批量操作 | 无 |
| stuck | 解决卡住问题 | 无 |
| claudeInChrome | Chrome 集成 | 自动启用 |
| verify | 验证代码变更 | ant-only |
| remember | 整理自动记忆 | ant-only |
| dream | 自动整合对话 | KAIROS_DREAM |
| hunter | 审查 artifacts | REVIEW_ARTIFACT |
| loop | 定期 agent 任务 | AGENT_TRIGGERS |
| scheduleRemoteAgents | 调度远程 agent | AGENT_TRIGGERS_REMOTE |
| claudeApi | 构建 Claude 应用 | BUILDING_CLAUDE_APPS |
| runSkillGenerator | 生成新技能 | RUN_SKILL_GENERATOR |
| verifyContent | 验证技能内容 | (bundled with verify) |
| claudeApiContent | Claude API 内容 | (bundled with claudeApi) |

### Vim 模式状态机

```
VimState
├── INSERT  → 记录 insertedText (用于 dot-repeat)
└── NORMAL  → CommandState 状态机
    │
    ├── idle
    ├── operator (d/c/y)
    ├── count (1-9, max 10000)
    ├── find (f/F/t/T + char)
    ├── g (gg/gj/gk)
    ├── replace (r)
    └── indent (>/< )

持久状态:
  lastChange  → dot-repeat (.)
  lastFind    → f/F/t/T repeat (;/,)
  register    → 无名寄存器 (yank/paste)
```

---

## 七、模块六：UI 层 (Ink.js)

### 组件层次结构

```
终端 UI 组件树
──────────────────────────────────────────────────────────────────
Ink (Terminal Renderer)
└── App.tsx
    ├── FpsMetricsProvider
    ├── StatsProvider (p50/p95/p99 直方图)
    └── AppStateProvider
        ├── MailboxProvider (组件间消息传递)
        ├── VoiceProvider (feature-gated)
        └── REPL.tsx (主交互屏幕, 895KB)
            ├── FullscreenLayout.tsx
            │   ├── ScrollBox
            │   │   └── VirtualMessageList.tsx (虚拟滚动)
            │   │       ├── Message.tsx (每轮对话)
            │   │       │   ├── AssistantMessage
            │   │       │   ├── UserToolResultMessage
            │   │       │   └── UserPlanMessage
            │   │       ├── Divider (未读标记)
            │   │       └── StickyPrompt (固定头部)
            │   ├── PromptInput/ (底部输入)
            │   │   ├── CompanionSprite (buddy)
            │   │   └── TextInput (vim/normal modes)
            │   ├── Modal (slash-command 对话框)
            │   └── Pill (跳转到新消息)
            └── Dialogs
                ├── PermissionRequest.tsx
                ├── CostThresholdDialog.tsx
                ├── MCPServerApprovalDialog.tsx
                └── GlobalSearchDialog.tsx
```

### Buddy 伴侣系统

- **18 种物种**：duck, goose, blob, cat, dragon, octopus, owl, penguin, turtle, snail, ghost, axolotl, capybara, cactus, robot, rabbit, mushroom, chonk
- **生成方式**：基于 userId hash 的 Mulberry32 PRNG 确定性生成
- **5 级稀有度**：common / uncommon / rare / epic / legendary（加权分布）
- **5 项属性**：DEBUGGING / PATIENCE / CHAOS / WISDOM / SNARK

### Ink 渲染优化

| 优化手段 | 实现 |
|---------|------|
| 差异化屏幕更新 | ANSI code diff，只更新变化的 cell |
| Yoga 布局引擎 | Flexbox 布局，避免全量重排 |
| 虚拟滚动 | VirtualMessageList，大消息列表按需渲染 |
| FPS 追踪 | FpsMetricsProvider，监控渲染性能 |
| Cell 池化 | screen.js cell pooling，减少 GC 压力 |

---

## 八、模块间关系总图

```
┌─────────────────────────────────────────────────────────────────────────┐
│                              用户 (Terminal)                             │
└──────────────────────────────────┬──────────────────────────────────────┘
                                   │ 键盘输入
                                   ▼
┌─────────────────────────────────────────────────────────────────────────┐
│  UI Layer: Ink.js + React                                                │
│  REPL.tsx ◄──► PromptInput ◄──► VirtualMessageList ◄──► PermissionReq  │
└──────────────────────────────────┬──────────────────────────────────────┘
                                   │ 用户消息 / 工具确认
                                   ▼
┌─────────────────────────────────────────────────────────────────────────┐
│  Core Engine                                                             │
│  query() ──► buildQueryConfig ──► processInput ──► runTools             │
│      │                                                    │              │
│      ▼                                                    ▼              │
│  AppState (store) ◄──────────────────────── onChangeAppState            │
└──────┬───────────────────────────────────────────────────────────────────┘
       │                                       │
       ▼                                       ▼
┌──────────────────┐              ┌────────────────────────┐
│  Services Layer  │              │  Tool System           │
│                  │              │                        │
│  api/claude.ts   │◄─────────────│  BashTool              │
│  (streaming)     │              │  FileRead/Write/Edit   │
│       │          │              │  AgentTool ──► fork    │
│  withRetry()     │              │  MCPTool ──────────────┼──► MCP Server
│       │          │              │  SkillTool ────────────┼──► Skills
│  Anthropic API   │              └────────────────────────┘
│  Bedrock/Vertex  │
│       │          │              ┌────────────────────────┐
│  mcp/client.ts   │              │  Advanced Features     │
│  lsp/            │              │                        │
│  oauth/          │              │  Coordinator ──► Workers
│  SessionMemory/  │              │  KAIROS ──► CCR backend
│  analytics/      │              │  Skills (19 bundled)   │
└──────────────────┘              │  Plugins               │
                                  │  Vim Mode              │
                                  │  Voice / Remote        │
                                  └────────────────────────┘
```

---

## 九、关键设计模式总结

| 模式 | 应用位置 | 目的 |
|------|---------|------|
| Feature Gate (`feature()`) | tools.ts, commands.ts | 编译时死代码消除 |
| 依赖注入 | query/deps.ts | 测试可替换 callModel |
| Memoization | commands.ts, mcp/client.ts | 避免重复计算 |
| 不可变状态 + Object.is() | store.ts | 精确变更检测 |
| 异步生成器 | api/claude.ts | SSE 流式响应 |
| 指数退避 | api/withRetry.ts | API 弹性 |
| PKCE OAuth | mcp/auth.ts, oauth/ | CLI 安全授权 |
| 虚拟滚动 | VirtualMessageList | 大消息列表性能 |
| 工具名命名空间 | mcp/client.ts | `mcp__server__tool` 防冲突 |
| 多 Provider 抽象 | api/client.ts | 1P/Bedrock/Vertex 统一接口 |
| 后台 fork | SessionMemory/ | 不阻塞主线程的记忆提取 |
| 双轨遥测 | analytics/ | PII 分级保护 |

---

> 核心本质：**工具驱动的 Agent 循环** — Claude API 返回 `tool_use` → 工具执行 → `tool_result` 回传 → 继续推理。
> 整个系统通过 Feature Gate 实现渐进式功能发布，通过依赖注入保证可测试性，通过 Ink.js 在终端实现完整 React 组件化 UI，通过 MCP 协议实现工具生态扩展。
