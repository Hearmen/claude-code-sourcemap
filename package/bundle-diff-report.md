
╔══════════════════════════════════════════════════════════════════════════════╗
║  cli-dev.js (官方 v2.1.143)  vs  cli-test.js (重建) 差异报告               ║
╚══════════════════════════════════════════════════════════════════════════════╝

【1. 构建格式与元数据】
  官方 bundle:    14,554,405 bytes (13.88 MB)  19,599 行
  重建 bundle:    12,111,576 bytes (11.55 MB)  9,065 行
  差距:            2,442,829 bytes (-16.8%)

  官方: CJS + Bun bytecode header (#!/usr/bin/env node + //@bun @bytecode)
  重建: ESM (bun build --target node --production)

【2. 已验证完全匹配的输出】
  ✅ --version  →  2.1.143 (Claude Code)
  ✅ --help     →  零差异 (diff 无输出)
  ✅ project purge --help
  ✅ ultrareview --help

【3. 命令实现状态】
  ✅ 完整  project purge      从 minified bundle 逆向工程实现。支持 --all/--dry-run/--interactive/--yes
  ⚠️  简化  ultrareview        检查策略+资格后退出。缺少 teleport → 轮询 → 格式化完整链路
  ✅ 完整  agents             从 v2.1.88 sourcemap 恢复
  ✅ 完整  auto-mode          从 v2.1.88 sourcemap 恢复
  ✅ 完整  doctor             从 v2.1.88 sourcemap 恢复
  ✅ 完整  auth               从 v2.1.88 sourcemap 恢复
  ✅ 完整  mcp                从 v2.1.88 sourcemap 恢复
  ✅ 完整  plugin             从 v2.1.88 sourcemap 恢复
  ✅ 完整  remote-control     从 v2.1.88 sourcemap 恢复 (bridgeMain fast-path)
  ✅ 完整  update/upgrade     从 v2.1.88 sourcemap 恢复

【4. Bun DCE 导致的内部代码缺失 (feature flags → false)】
  功能                          官方    重建   说明
  ──────────────────────────────────────────────────────────────────
  auto mode                     83     25    classifier 规则、YOLO 模式逻辑
  bridge/remote ctrl           1047    707   remote-control 会话管理、bridge 连接
  teleport                     188    125   远程会话 teleport 基础设施
  ultrareview                   85     40   reviewRemote.ts 中的完整远程评审逻辑
  ultraplan                    176    111   远程计划任务逻辑
  growthbook                    52     59   基本保留

【5. 已知运行时行为差异】
  • 官方 build 中 feature('KAIROS') / feature('TRANSCRIPT_CLASSIFIER') 为 true
    → 重建 build 中这些 flag 为 false，导致 DCE 删除了大量内部代码路径
  • 官方 build 包含 Anthropic 内部 API endpoint 的完整调用链
    → 重建 build 缺少部分 API 客户端代码（如 fetchSessionEvents 轮询）
  • 官方 build 的 Ink UI 实例管理使用 CJS 全局实例映射
    → 重建 build 使用 ESM 模块隔离

【6. 因缺少 sourcemap 而无法完整逆向的功能】
  ❌ ultrareview 完整 CLI 链路:
     - If6 (launch handler) → np8 (teleport + task registration) → KKO (poll loop)
     - 需要 fetchSessionEvents / bjH / _T6 / OKO / TKO 等内部 API
  ❌ auto-mode 深度集成:
     - 分类器模型、实时决策树、TRANSCRIPT_CLASSIFIER gated 代码
  ❌ KAIROS 助手模式:
     - 整个助手模式 UI 和逻辑链被 DCE 删除

【7. 文件头尾特征】
  官方头部:    #!/usr/bin/env node // @bun @bytecode @bun-cjs (function(exports...
  重建头部:    import{createRequire as Dd_}from"node:module";var Hd_=Object.create...

  官方尾部:    ..._("cli_after_main_import"),await A(),_("cli_after_main_complete")}h4O();})
  重建尾部:    ...K("cli_after_main_import"),await Y(),K("cli_after_main_complete")}At9();

═══ 总结 ═══
重建 bundle 在 CLI 表层（--help/--version/命令注册）与官方完全一致。
核心差距在于 Bun DCE 删除了大量 feature-gated 内部代码，以及
ultrareview 等命令的完整业务逻辑因缺少 sourcemap 而难以逆向。
