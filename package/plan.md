# 方案：使 extract-src 编译出的 cli-dev.js 与 cli.js 执行效果一致

## 1. 现状对比结论

| 维度 | `cli.js` (原始) | `cli-dev.js` (当前构建) | 结论 |
|------|----------------|------------------------|------|
| 运行 `--version` | ✅ `2.1.88 (Claude Code)` | ❌ `TypeError: hasFlag4 is not a function` | **运行时崩溃** |
| 体积 | ~12 MB (混淆压缩) | ~24 MB (未压缩) | **体积差异显著** |
| 构建工具 | Bun build (确认) | Bun build | 构建器一致 |
| 代码行数 | ~16,667 行 | ~683,826 行 | 缺少代码压缩 |

**核心问题**：构建产物能生成，但启动即崩溃；体积和代码组织也与原始产物不一致。

---

## 2. 根因分析

### 2.1 构建器确认：原始产物即 Bun build 生成

虽然 `cli.js` 的 helper 函数（`__toESM`、`__toCommonJS`、`y=(q,K)=>()=>(q&&(K=q(q=0)),K)` 等）与 esbuild 风格相似，但以下证据确认其原始构建器就是 **Bun build**：

1. **`bun:bundle` 死代码消除 (DCE)**：源码中 20+ 处使用 `import { feature } from 'bun:bundle'`，如 `feature('KAIROS') ? require('./assistant/index.js') : null`。Bun build 在编译期求值 `feature()` 并直接消除不可达分支。原始 `cli.js` 中完全不存在 `assistant/index` 字符串，证明 DCE 生效——这是 Bun 特有行为。
2. **source map 中的注释**：`extract-src/src/cli.js.map` 中明确包含 `"When bun builds browser-sdk.js with --target browser..."` 等注释，说明原始工程使用 Bun 构建。

### 2.2 体积差异根因：缺少 `--production` 参数

当前 `extract-src/package.json` 的构建命令为：
```bash
bun build src/main.tsx --outfile ../cli-dev.js --target node --loader .md:text --loader .txt:text
```

缺少 `--production` 导致：
- 未启用代码压缩和混淆
- 保留全部原始变量名、注释、换行
- 产物体积 24 MB（原始仅 12 MB）

**验证**：添加 `--production` 后体积立即降至 12.11 MB，与 `cli.js` 基本一致。

### 2.3 运行时差异根因：依赖版本严重漂移（ESM-only 新版本替代了原始 CJS 版本）

`extract-src/package.json` 中 **89 个依赖全部使用 `"latest"`** 标签安装。这导致大量关键包被升级为了与原始构建不兼容的 **ESM-only** 新版本，而原始构建时使用的是 **CommonJS** 版本。

通过对比 `cli.js.map` 中的原始源码与当前 `node_modules` 中的源码，确认以下关键漂移：

| 包名 | 原始构建时 | 当前 `latest` 安装 | 差异影响 |
|------|-----------|-------------------|---------|
| `has-flag` | CJS (`module.exports = ...`) | v5.0.1 ESM (`export default`) | `require('has-flag')` 返回模块对象而非函数，直接导致 `TypeError: hasFlag4 is not a function` |
| `supports-color` | CJS (`require('has-flag')`) | v10.2.2 ESM | 同上，CJS require ESM 失败 |
| `chalk` | v4 CJS (嵌套 `ansi-styles` 结构) | v5.6.2 ESM-only | API 和模块格式均不兼容 |
| `supports-hyperlinks` | CJS (`require('has-flag')`) | v4.4.0 ESM | 间接触发 `has-flag` 问题 |

**Bun build 的模块 interop 在处理 `CJS require ESM` 时与原始 `CJS require CJS` 场景存在语义差异**。原始构建中这些模块均为 CJS，Bun 能正确解析为函数/对象；当前为 ESM 版本后，Bun 生成的 `__toCommonJS` 包装返回的是 `{ default: fn, __esModule: true }` 对象，被当作函数调用时立即崩溃。

**这是 `cli-dev.js` 无法运行的最直接、最根本原因。**

---

## 3. extract-src 架构分析

### 3.1 源码规模
- **总文件数**：~1,944 个
- **`.tsx` 组件/页面**：552 个
- **`.ts` 工具/服务/逻辑**：1,334 个
- **`.js` 辅助文件**：48 个

### 3.2 核心模块分层

```
src/main.tsx           # 入口：启动优化（并行 MDM/Keychain 预取）、CLI 参数解析、主循环
├── commands.ts        # 命令注册与路由
├── commands/          # 各子命令具体实现（~60+ 命令）
├── ink.ts             # Ink 渲染器封装
├── components/        # React + Ink UI 组件（~50+ 组件）
├── tools.ts           # AI 工具注册
├── tools/             # 各工具实现（AgentTool、BashTool、MCP Tool 等 ~40+ 工具）
├── utils/             # 通用工具库（~100+ 子模块）
├── vendor/            # Native 模块 TS 封装层
│   ├── audio-capture-src/
│   ├── image-processor-src/
│   ├── modifiers-napi-src/
│   └── url-handler-src/
└── entrypoints/       # 初始化入口（init.ts、cli.tsx 等）
```

### 3.3 关键机制

1. **`bun:bundle` 特性开关**：20+ 文件通过 `feature('XXX')` 在**编译期**控制代码分支。Bun build 会对 `false` 分支做死代码消除，因此某些源码路径（如 `./assistant/index.js`）无需真实存在即可构建通过。
2. **Native 模块动态加载**：`vendor/*-src/index.ts` 使用动态 `require()` 加载外层 `vendor/` 目录下的 `.node` 文件。构建产物 `cli-dev.js` 输出到项目根目录时，相对路径 `./vendor/audio-capture/...` 仍可正确指向原文件。
3. **路径别名**：`tsconfig.json` 已配置 `src/*` 和 `react/compiler-runtime` 映射，当前 Bun 构建时能正确解析。

---

## 4. 修复计划

### Phase 1：依赖版本考古与锁定（最关键）

**目标**：将 `latest` 替换为与原始构建兼容的版本，优先恢复 CJS 版本以避免 interop 崩溃。

**步骤**：

1. **识别关键漂移包**
   - 已确认：`has-flag`、`supports-color`、`chalk`、`supports-hyperlinks`
   - 待排查：构建/运行报错时暴露出的下一个不兼容包

2. **锁定 CJS 兼容版本**
   基于源码内容推断和 npm 历史版本对照，建议优先尝试以下版本组合：
   - `has-flag`: `^4.0.0` (CJS)
   - `supports-color`: `^9.0.0` (CJS)
   - `chalk`: `^4.1.2` (CJS)
   - `supports-hyperlinks`: `^3.0.0` (CJS)

3. **生成精确 `package.json`**
   - 移除所有 `"latest"`
   - 对已知漂移包写入固定版本
   - 对其他包优先写入 `cli.js.map` 中可推断出的版本；无法推断的先保留当前版本，后续迭代调整

4. **清理并重新安装**
   ```bash
   cd extract-src
   rm -rf node_modules package-lock.json bun.lock
   bun install
   node fix-deps.cjs    # 补充 source map 中缺失的零散文件
   ```

### Phase 2：构建参数优化

**目标**：使产物体积和代码压缩程度与 `cli.js` 一致。

**修改 `extract-src/package.json` 的 `build` 脚本**：
```json
{
  "scripts": {
    "build": "bun build src/main.tsx --outfile ../cli-dev.js --target node --production --loader .md:text --loader .txt:text",
    "build:sm": "bun build src/main.tsx --outfile ../cli-dev.js --target node --production --sourcemap --loader .md:text --loader .txt:text",
    "dev": "bun run src/main.tsx"
  }
}
```

- `--production`：启用代码压缩、混淆、`NODE_ENV=production`，体积降至 ~12 MB
- 保留 `--loader .md:text --loader .txt:text`：处理源码中直接 import 的文本资源

### Phase 3：运行时修复与验证

**步骤**：

1. **首次构建**
   ```bash
   cd extract-src
   bun run build
   ```

2. **排错迭代**
   - 运行 `node ../cli-dev.js --version`
   - 若报 `xxx is not a function` 等 interop 错误，定位到具体包
   - 检查该包当前版本是否为 ESM-only，若是则降级到 CJS 版本
   - 重复构建→运行→降级，直到 `--version` 正常输出

3. **功能验证**
   - `node cli-dev.js --version` 输出应与 `cli.js` 完全一致
   - `node cli-dev.js --help` 应正常显示帮助
   - 启动基本对话流程（如 `node cli-dev.js` 进入交互模式）应无崩溃
   - Native 模块加载测试：在 macOS 上验证 `vendor/audio-capture/arm64-darwin/audio-capture.node` 可被正确 require（不报错即可）

4. **语义一致性检查**
   - 使用 `diff <(node cli.js --help) <(node cli-dev.js --help)` 对比输出
   - 对关键命令（如 `--version`、空参数启动）做 diff 验证

### Phase 4：建立可持续开发工作流

1. **版本锁定文档化**
   - 在 `extract-src/package.json` 中不再使用 `latest`
   - 记录所有经验证的依赖版本，避免后续 `bun install` 再次漂移

2. **集成 `fix-deps.cjs`**
   - 将 `node fix-deps.cjs` 加入 `postinstall` 脚本，确保每次 `bun install` 后自动补齐 source map 中的零散文件

3. **构建-验证流水线**
   ```bash
   cd extract-src
   bun install
   bun run build
   node ../cli-dev.js --version
   node ../cli-dev.js --help
   ```

---

## 5. 风险与备选方案

| 风险 | 说明 | 缓解措施 |
|------|------|---------|
| **版本考古不完整** | `cli.js.map` 中无 `package.json`，部分依赖版本需试错法推断 | 优先修复启动崩溃路径上的包；使用 `npm view <pkg> versions` + 源码特征匹配 |
| **Bun 版本差异** | 原始构建可能使用不同 Bun 版本，对特定语法处理有细微差异 | 保持当前 Bun 版本；若遇 Bun 特有 bug，考虑用 `bun upgrade` 或降级 |
| **深层 ESM 嵌套** | 某些新版依赖可能深度依赖 ESM-only 子包，降级困难 | 使用 `patch-package` 局部修改 `node_modules` 中的 CJS require 为 `.default` 调用 |
| **Native 模块 ABI 变化** | 若降级 Node 相关包导致 `.node` 模块 ABI 不匹配 | 保持 Node.js v22+；`.node` 文件本身不随源码构建变化 |

### 备选方案（若版本锁定过于困难）

- **Post-build 补丁脚本**：继续使用 `latest`，但在 `bun run build` 之后，运行一个 Node 脚本对 `cli-dev.js` 做正则替换，修正已知的 `__toCommonJS` interop 问题。此方案脆弱，仅作为最后手段。
- **esbuild 迁移**：理论上可用 esbuild 复刻原始构建，但 `bun:bundle` 的 DCE 和某些 Bun 特有 API 需要大量 shim，成本高于修复依赖版本。

---

## 6. 预期交付物

1. 更新后的 `extract-src/package.json`（版本锁定 + `--production` 构建脚本）
2. 稳定可复现的 `extract-src/node_modules`（CJS 兼容版本）
3. 运行时无崩溃、执行效果与 `cli.js` 一致的 `cli-dev.js`
4. 可持续的构建-验证工作流文档
