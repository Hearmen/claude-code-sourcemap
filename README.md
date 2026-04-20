# claude-code-sourcemap

[![linux.do](https://img.shields.io/badge/linux.do-huo0-blue?logo=linux&logoColor=white)](https://linux.do)

> [!WARNING]
> This repository is **unofficial** and is reconstructed from the public npm package and source map analysis, **for research purposes only**.
> It does **not** represent the original internal development repository structure.
>
> 本仓库为**非官方**整理版，基于公开 npm 发布包与 source map 分析还原，**仅供研究使用**。
> **不代表**官方原始内部开发仓库结构。
> 一切基于 L 站 "飘然与我同" 的情报提供。

## 概述

本仓库通过 npm 发布包（`@anthropic-ai/claude-code`）内附带的 source map（`cli.js.map`）还原的 TypeScript 源码，版本为 **`2.1.88`**。

与早期仅做源码提取不同，当前版本已**可完整构建**出与原始 `cli.js` 行为一致的输出文件。

## 来源

- npm 包：[@anthropic-ai/claude-code](https://www.npmjs.com/package/@anthropic-ai/claude-code)
- 还原版本：`2.1.88`
- 还原文件数：**4756 个**（含 1884 个 `.ts`/`.tsx` 源文件）
- 还原方式：提取 `cli.js.map` 中的 `sourcesContent` 字段

## 目录结构

```
.
├── cli.js                   # 原始官方构建产物（~12 MB）
├── cli.js.map               # 原始 source map（~58 MB）
├── cli-test.js              # 本地重新构建产物（~12 MB，行为一致）
├── extract-src/             # 可构建的源码目录
│   ├── package.json         # Bun 构建配置与锁定的依赖版本
│   ├── tsconfig.json        # TypeScript 配置（含 path alias）
│   ├── fix-deps.cjs         # 修复 source-map 还原后缺失的 node_modules 文件
│   └── src/
│       ├── entrypoints/
│       │   └── cli.tsx      # CLI 构建入口
│       ├── main.tsx         # 原主入口（兼容引用）
│       ├── commands/        # 命令实现（commit、review、config 等 40+ 个）
│       ├── tools/           # 工具实现（Bash、FileEdit、Grep、MCP 等 30+ 个）
│       ├── services/        # API、MCP、分析等服务
│       ├── utils/           # 工具函数（git、model、auth、env 等）
│       ├── context/         # React Context
│       ├── coordinator/     # 多 Agent 协调模式
│       ├── buddy/           # AI 伴侣 UI
│       ├── remote/          # 远程会话
│       ├── plugins/         # 插件系统
│       ├── skills/          # 技能系统
│       ├── voice/           # 语音交互
│       └── vim/             # Vim 模式
└── vendor/                  # 原生二进制依赖（audio-capture、ripgrep）
```

## 构建

环境要求：
- [Bun](https://bun.sh) ≥ 1.3.12
- Node.js ≥ 22.14.0（运行时目标）

进入源码目录并安装依赖（会自动运行 `fix-deps.cjs` 修复缺失文件）：

```bash
cd extract-src
bun install
```

构建输出到仓库根目录的 `cli-test.js`：

```bash
bun run build
```

带 source map 构建：

```bash
bun run build:sm
```

## 关键修复

由于 source map 不包含 `package.json` 等元数据，依赖版本全部通过源码格式（CJS `module.exports` vs ESM `export default`）反向工程并逐一验证。主要兼容性修复：

| 包名 | 锁定版本 | 原因 |
|------|----------|------|
| `commander` | `12.1.0` | v14 拒绝多字符短选项；v2 缺失现代 API |
| `@commander-js/extra-typings` | `12.1.0` | 与 commander 版本对齐 |
| `has-flag` | `4.0.0` | 回退到 CJS，避免 ESM 加载异常 |
| `supports-color` | `8.1.1` | 回退到 CJS，避免 ESM 加载异常 |
| `supports-hyperlinks` | `2.3.0` | 回退到 CJS，避免 ESM 加载异常 |

此外，通过 `--define` 注入 `MACRO.*` 编译期常量，修复了 `MACRO is not defined` 运行时错误。

## 已知限制

- `vendor/audio-capture/*.node` 在 macOS 上可能因代码签名策略无法直接加载（`EACCES`），不影响 JS 构建本身。
- `--help` 输出缺少 `--brief` 选项，因为 `feature('KAIROS_BRIEF')` 在外部构建中被编译期死码消除为 `false`，与官方公开构建行为一致。
- 部分内部功能（如 KAIROS、GrowthBook 实验标志）依赖未公开的编译期宏或私有 npm 包，已根据 source map 中的 `false` 分支正确退化。

## 声明

- 源码版权归 [Anthropic](https://www.anthropic.com) 所有
- 本仓库仅用于技术研究与学习，请勿用于商业用途
- 如有侵权，请联系删除
