
╔══════════════════════════════════════════════════════════════════════════════╗
║  官方 v2.1.143 bundle 中被 DCE 删除的内部执行逻辑                            ║
║  （直接从 cli-dev.js 提取，与 cli-test.js 对比）                             ║
╚══════════════════════════════════════════════════════════════════════════════╝

【说明】
cli-dev.js (14.55MB) 是官方 v2.1.143 bundle，feature flags 全部内联为 true。
cli-test.js (12.17MB) 是重建 bundle，feature flags 评估为 false，导致 Bun DCE
在编译时删除了大量代码路径。

以下是从官方 bundle 中直接提取的、在重建版本中缺失的内部执行逻辑。

═══════════════════════════════════════════════════════════════════════════════
一、Auto Mode / TRANSCRIPT_CLASSIFIER（完全删除）
═══════════════════════════════════════════════════════════════════════════════

1. getAutoModeConfig (函数名: hOH) — 565 字符
   ─────────────────────────────────────────────────────────────────────────
   功能: 解析 4 层设置源中的 autoMode 配置
   
   执行逻辑:
     let schema = MC4();  // Zod schema
     let allow = [], soft_deny = [], hard_deny = [], environment = [];
     for (source of ["userSettings", "localSettings", "flagSettings", "policySettings"]) {
       let settings = V6(source);
       if (!settings) continue;
       let parsed = schema.safeParse(settings.autoMode);
       if (parsed.success) {
         if (parsed.data.allow) allow.push(...parsed.data.allow);
         if (parsed.data.soft_deny) soft_deny.push(...parsed.data.soft_deny);
         if (parsed.data.hard_deny) hard_deny.push(...parsed.data.hard_deny);
         if (parsed.data.environment) environment.push(...parsed.data.environment);
       }
     }
     return { allow, soft_deny, hard_deny, environment };
   
   重建状态: ❌ 完全删除（函数不存在，autoMode 规则无法加载）

2. hasAutoModeOptIn (函数名: GC) — 501 字符
   ─────────────────────────────────────────────────────────────────────────
   功能: 判断是否启用 auto mode（实时权限自动决策）
   
   执行逻辑:
     if (policySettings.permissions.defaultMode === "auto")
       return true;  // 策略强制启用
     
     let skipUser = userSettings?.skipAutoPermissionPrompt;
     let skipLocal = localSettings?.skipAutoPermissionPrompt;
     let skipFlag = flagSettings?.skipAutoPermissionPrompt;
     let skipPolicy = policySettings?.skipAutoPermissionPrompt;
     let optedIn = !!(skipUser || skipLocal || skipFlag || skipPolicy);
     
     log(`[auto-mode] hasAutoModeOptIn=${optedIn}`);
     return optedIn;
   
   重建状态: ❌ 完全删除

3. autoMode 配置 Schema (Zod)
   ─────────────────────────────────────────────────────────────────────────
   官方 bundle 中定义:
     autoMode: {
       buildGate: () => !0,  // feature flag 已内联为 true
       shape: () => ({
         skipAutoPermissionPrompt: y.boolean().optional()
           .describe("Whether the user has accepted the auto mode opt-in dialog"),
         useAutoModeDuringPlan: y.boolean().optional()
           .describe("Whether plan mode uses auto mode semantics..."),
         autoMode: y.object({
           allow: y.array(y.string()).optional()
             .describe("Rules for the auto mode classifier"),
           soft_deny: y.array(y.string()).optional(),
           hard_deny: y.array(y.string()).optional(),
           environment: y.array(y.string()).optional()
         })
       })
     }
   
   重建状态: ⚠️ 部分保留（基础 schema 存在，但 autoMode 规则对象可能缺失）

═══════════════════════════════════════════════════════════════════════════════
二、Bridge / Remote Control / BRIDGE_MODE（大幅删除）
═══════════════════════════════════════════════════════════════════════════════

4. bridgeMain (函数名: xI3) — 8619 字符
   ─────────────────────────────────────────────────────────────────────────
   功能: Remote Control / Bridge 模式的主入口
   
   执行流程:
     Step 1: mVK(H)          解析命令行参数
     Step 2: SI3()           显示帮助（--help 分支）
     Step 3: wkH()           初始化日志 sinks
     Step 4: zdH(zLH)        设置调试级别
     Step 5: 验证权限模式    PERMISSION_MODES 校验
     Step 6: fMH.resolve(".") 解析工作目录
     Step 7: enableConfigs() 启用配置系统
     Step 8: checkHasTrustDialogAccepted() 检查信任对话框
     Step 9: initSinks()     初始化输出 sinks
     Step 10: createSession  创建远程 CCR 会话
     Step 11: WebSocket/轮询 连接管理
     Step 12: 能力协商       capability negotiation
   
   重建状态: ⚠️ 只保留引用 (~100 字符)，主体 8419 字符被删除
             remote-control 命令存在但无法创建实际会话

═══════════════════════════════════════════════════════════════════════════════
三、KAIROS 助手模式（部分删除）
═══════════════════════════════════════════════════════════════════════════════

5. KAIROS 状态管理
   ─────────────────────────────────────────────────────────────────────────
   官方 bundle 中保留:
     FN()    { return F_.kairosActive }     // getter
     T14(H)  { F_.kairosActive = H }        // setter
   
   kairosActive 作为 AppState 字段:
     { kairosActive: !1, rendererMode: void 0, ... }
   
   Analytics 维度包含 "kairosActive":
     ["change", "http_status", "kairosActive", "model", "op", ...]
   
   重建状态: ✅ 状态字段和 getter/setter 保留
             ❌ 消息路由、助手守护进程逻辑缺失

6. --assistant 选项
   ─────────────────────────────────────────────────────────────────────────
   官方 bundle:
     if (feature('KAIROS')) {
       program.addOption(new Option('--assistant', 'Force assistant mode'));
     }
   
   由于 feature('KAIROS') 内联为 true，--assistant 选项注册并生效。
   重建版本中 feature('KAIROS') 为 false，该选项及后续逻辑被 DCE。

═══════════════════════════════════════════════════════════════════════════════
四、TeamMemory / TEAMMEM（完全删除）
═══════════════════════════════════════════════════════════════════════════════

7. TeamMemory 状态管理
   ─────────────────────────────────────────────────────────────────────────
   官方 bundle 中保留:
     zEH(H) { F_.teamMemoryServerStatus = H }  // setter (44 字符)
   
   AppState 字段:
     teamMemoryServerStatus: void 0
   
   extract-src 源码中的 feature gate:
     const teamMemPaths = feature('TEAMMEM')
       ? require('../memdir/teamMemPaths.js')
       : null
   
   重建状态: ❌ teamMemPaths 模块及所有同步逻辑被 DCE 删除
             ✅ teamMemoryServerStatus 状态字段可能保留（作为 AppState 一部分）

═══════════════════════════════════════════════════════════════════════════════
五、权限决策 / 实时分类（部分删除）
═══════════════════════════════════════════════════════════════════════════════

8. Permission Decision Hook
   ─────────────────────────────────────────────────────────────────────────
   官方 bundle 中存在:
     y.object({
       hookEventName: y.literal("PreToolUse"),
       permissionDecision: hz5().optional(),
       permissionDecisionReason: y.string().optional(),
       updatedInput: y.record(y.string(), y.unknown()).optional(),
       additional...: ...
     })
   
   这是 auto-mode 在工具调用前进行实时权限分类的 hook schema。
   重建状态: ⚠️ schema 可能保留，但分类器推理逻辑缺失

═══════════════════════════════════════════════════════════════════════════════
六、重建版本中"看起来存在但实际不完整"的功能
═══════════════════════════════════════════════════════════════════════════════

以下功能在 CLI 层注册了选项/命令，但深层执行逻辑不完整:

  A. --exclude-dynamic-system-prompt-sections
     CLI: 已注册，default: false
     深层: 在 system prompt 构建管道中未找到消费点
     状态: 选项可解析但无实际效果

  B. --plugin-url <url>
     CLI: 已注册，支持多值累积
     深层: plugin 加载管道中无 URL 下载逻辑
     状态: 选项可解析但无实际效果

  C. ultrareview [target]
     CLI: 命令存在，handler 导入
     深层: 只有策略检查+资格检查，缺少 teleport→轮询→格式化链路
     状态: 命令可调用但总是退出

═══════════════════════════════════════════════════════════════════════════════
七、Feature Flag 内联导致的 DCE 删除统计
═══════════════════════════════════════════════════════════════════════════════

  Feature Flag        官方内联值    重建评估值    删除代码量(估算)
  ──────────────────────────────────────────────────────────────────
  KAIROS              true          false         ~5-10KB (助手模式UI)
  TRANSCRIPT_CLASSIFIER true        false         ~2-3KB (分类器+auto-mode配置)
  BRIDGE_MODE         true          false         ~8KB (bridgeMain)
  TEAMMEM             true          false         ~1-2KB (团队记忆)
  KAIROS_BRIEF        true          false         ~1KB (brief tool)
  
  总计删除: ~17-24KB 纯逻辑代码
  （注: 由于 minification 和模块打包方式不同，实际体积差异为 2.4MB，
   其中大部分来自不同的打包策略和换行符分布，而非仅 DCE）

═══════════════════════════════════════════════════════════════════════════════
八、结论
═══════════════════════════════════════════════════════════════════════════════

官方 v2.1.143 bundle 通过将 feature flags 内联为 true，保留了以下完整的
内部执行逻辑链，而这些在重建版本中因 DCE 被彻底删除:

  1. Auto-mode 完整链路:
     配置解析 (hOH) → 启用判断 (GC) → 实时分类器 → 权限自动决策
  
  2. Bridge/Remote Control 完整链路:
     参数解析 → 配置初始化 → 信任检查 → 远程会话创建 → WebSocket/轮询
  
  3. KAIROS 助手模式:
     状态管理 → 消息路由 → 助手守护进程
  
  4. TeamMemory:
     团队记忆路径解析 → 同步逻辑

重建版本在 CLI 表层（--help/--version/命令注册）与官方完全一致，但
深层执行逻辑存在显著差距，特别是涉及 Anthropic 内部 feature flag 的
功能模块。
