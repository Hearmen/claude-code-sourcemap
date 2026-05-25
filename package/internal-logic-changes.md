
╔══════════════════════════════════════════════════════════════════════════════╗
║  内部执行逻辑变化分析: cli.js (v2.1.88) → cli-test.js (v2.1.143)           ║
╚══════════════════════════════════════════════════════════════════════════════╝

【一、已验证的内部执行逻辑变化】

1. 非交互式模式检测逻辑扩展
   ──────────────────────────────────────────────────────────────────
   v2.1.88:
     const isNonInteractive = hasPrintFlag || hasInitOnlyFlag || hasSdkUrl;
   
   v2.1.143:
     const isNonInteractive = hasPrintFlag || hasInitOnlyFlag || hasSdkUrl || !process.stdout.isTTY;
     
   变化: 新增 stdout.isTTY 检测。即使不带 -p，只要输出被管道化或重定向，
         就自动进入非交互模式。这会影响信任对话框跳过、设置验证静默忽略等行为。

2. --print 模式信任对话框与设置验证逻辑
   ──────────────────────────────────────────────────────────────────
   v2.1.88:
     "The workspace trust dialog is skipped when Claude is run with the -p mode"
   
   v2.1.143:
     "The workspace trust dialog is skipped when Claude is run in non-interactive 
      mode (via -p, or when stdout is not a TTY, e.g. piped or redirected output). 
      Only use this in directories you trust. Settings files that fail validation 
      are silently ignored in this mode (no error dialog is shown)."
   
   变化: 新增「设置文件验证失败时静默忽略」逻辑。在非交互模式下，
         损坏或无效的 settings.json 不会阻塞启动，而是静默跳过。

3. Permission Mode 处理逻辑
   ──────────────────────────────────────────────────────────────────
   v2.1.88:
     export const INTERNAL_PERMISSION_MODES = [
       ...EXTERNAL_PERMISSION_MODES,
       ...(feature('TRANSCRIPT_CLASSIFIER') ? (['auto'] as const) : ([] as const)),
     ] as const
   
   v2.1.143:
     export const INTERNAL_PERMISSION_MODES = [
       'acceptEdits', 'auto', 'bypassPermissions', 'default', 'dontAsk', 'plan',
     ] as const
   
   变化: 'auto' 从 feature-gated 变为无条件包含。这意味着：
         - CLI choices 列表中 auto 始终出现
         - 设置验证不会拒绝 auto 模式
         - 但实际的 transcript classifier 逻辑仍可能因 DCE 而缺失

4. Feature Flag 解封（条件编译 → 无条件）
   ──────────────────────────────────────────────────────────────────
   以下代码从 feature-gated 变为无条件执行：
   
   a) --brief 选项
      v2.1.88: if (feature('KAIROS') || feature('KAIROS_BRIEF')) { addOption(--brief) }
      v2.1.143: program.addOption(new Option('--brief', ...))  // 无条件
   
   b) --remote-control / --rc 选项
      v2.1.88: if (feature('BRIDGE_MODE')) { addOption(--remote-control) }
      v2.1.143: program.addOption(new Option('--remote-control', ...))  // 无条件
   
   c) remote-control 命令
      v2.1.88: if (feature('BRIDGE_MODE')) { program.command('remote-control') }
      v2.1.143: program.command('remote-control', { hidden: true })  // 无条件
   
   d) auto-mode 命令
      v2.1.88: if (feature('TRANSCRIPT_CLASSIFIER')) { program.command('auto-mode') }
      v2.1.143: if (true) { ... }  // 无条件（但深层分类器逻辑可能仍缺失）

5. Plugin 加载逻辑增强
   ──────────────────────────────────────────────────────────────────
   v2.1.88: --plugin-dir 仅支持目录路径
   v2.1.143: --plugin-dir 支持目录或 .zip 文件
   
   深层实现状态:
     ✅ pluginLoader.ts 中已存在 .zip 处理逻辑：
        if (isPluginZipCacheEnabled() && pluginPath.endsWith('.zip')) { ... }
     ✅ zipCache.ts / officialMarketplaceGcs.ts 中有 unzipFile 实现
     ⚠️  --plugin-url 选项在 CLI 层注册，但在源码中未找到下载处理逻辑

6. Project Purge 全新执行流程
   ──────────────────────────────────────────────────────────────────
   这是一个 v2.1.143 全新的功能模块，执行流程如下：
   
   Phase 1: 路径解析
     - 用户指定路径 → resolve(path)
     - 未指定 → 交互式选择（当前目录 + ~/.claude.json 中的历史项目）
   
   Phase 2: 扫描计划构建 (buildProjectPurgePlan)
     - 解析 git root
     - 查找相关会话目录（sessionPrefix 映射）
     - 扫描 ~/.claude/ 下的 projects/、tasks/、debug/、file-history/
     - 读取 ~/.claude.json 中的项目配置键
     - 统计 history.jsonl 中的相关行数
     - 生成 PurgeItem[] 列表（含 kind: file/dir/config-key/history-lines）
   
   Phase 3: 确认交互
     - --dry-run: 打印计划，不执行删除
     - --interactive: Ink UI Select 组件逐个确认（Delete/Skip/Delete All/Abort）
     - --yes: 跳过确认
     - 默认: readline [y/N] 确认
   
   Phase 4: 执行删除 (deletePurgeItem)
     - dir/file → fs.rm(path, { recursive, force })
     - config-key → saveGlobalConfig() 删除 projects[key]
     - history-lines → 读取 history.jsonl，过滤掉匹配行，写回文件
   
   Phase 5: 遥测
     - logEvent('cli_purge_project')

7. Ultrareview 新执行流程
   ──────────────────────────────────────────────────────────────────
   这是一个简化实现，执行流程：
   
   Step 1: SIGINT 保护（Ctrl+C → exit 130）
   Step 2: 策略检查 → isPolicyAllowed('allow_remote_sessions')
   Step 3: 资格检查 → checkRemoteAgentEligibility()
            （检查 git repo、OAuth token、GitHub app 等）
   Step 4: 退出并提示用户使用 /ultrareview 交互式命令
   
   缺失的完整链路:
     - 解析目标（PR 号 vs 分支）
     - teleportToRemote() 启动远程 CCR 会话
     - 轮询远程会话事件（fetchSessionEvents）
     - 格式化输出（JSON 或文本）
     - 超时处理（--timeout）

【二、CLI 层注册但深层处理逻辑缺失】

以下选项在 CLI 层已注册，但在 extract-src 源码中未找到对应的业务逻辑处理：

  1. --exclude-dynamic-system-prompt-sections
     状态: CLI 选项已注册，default: false
     缺失: 在 system prompt 构建逻辑中未找到该 flag 的消费点
     影响: 该选项在重建版本中可能无实际效果

  2. --plugin-url <url>
     状态: CLI 选项已注册，支持多值累积
     缺失: 在 plugin 加载管道中未找到 URL 下载处理逻辑
     影响: 该选项在重建版本中可能无实际效果

【三、由于 Bun DCE 导致的代码路径差异】

官方 bundle 中 feature flags 评估为 true，保留了以下代码路径：
重建 bundle 中这些 flags 为 false，代码被编译时删除：

  1. KAIROS 助手模式
     - 助手模式 UI 组件
     - 助手-用户通信协议
     - KAIROS_BRIEF 相关的 brief tool
   
  2. TRANSCRIPT_CLASSIFIER / auto-mode 深度集成
     - 实时分类器模型推理
     - YOLO 模式决策树
     - 自动权限决策逻辑
   
  3. BRIDGE_MODE 深层代码
     - bridge 会话发现协议
     - 远程控制状态机
     - CCR 双向通信通道
   
  4. TEAMMEM / 团队记忆
     - 团队级记忆目录同步
     - 共享上下文管理

【四、入口流程与运行时差异】

  1. 模块加载图变化
     v2.1.88: main import chunk ID = CA7()
     v2.1.143: main import chunk ID = H8K()
     说明: 模块依赖图因新增 project/ultrareview 处理器而改变

  2. 构建格式差异
     v2.1.88: CJS + Bun bytecode（有 shebang，可直接 ./cli.js 执行）
     v2.1.143: ESM（需 node/bun 显式执行，无 shebang）
     影响: 运行时模块解析策略不同（CJS require vs ESM import）

  3. process.exit 策略
     v2.1.88: 各命令 handler 返回后由 commander 自然结束
     v2.1.143: project purge / ultrareview 等命令显式调用 process.exit(0)
              原因: Ink UI 组件创建的全局 stdin 监听器阻止进程自然退出

【五、总结】

重建版本的内部执行逻辑变化可分为三类：

  A. 已完整实现的新逻辑:
     - project purge 的扫描-确认-删除全链路
     - 非交互模式扩展（isTTY 检测）
     - 权限模式 unconditional auto
     - Feature flag 解封（brief/remote-control/auto-mode）

  B. 部分实现的新逻辑:
     - ultrareview: CLI 入口存在，但 teleport→轮询→格式化链路缺失
     - plugin .zip 支持: 深层 unzip 逻辑存在，但 --plugin-url 下载逻辑缺失

  C. 因 DCE 完全缺失的逻辑:
     - KAIROS 助手模式完整链路
     - TRANSCRIPT_CLASSIFIER 实时分类器
     - BRIDGE_MODE 远程控制状态机
     - TEAMMEM 团队记忆同步
