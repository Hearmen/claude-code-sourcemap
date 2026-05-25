# Claude Code 源码同步方法论

> 从 v2.1.88 → v2.1.143 升级经验的系统化总结  
> 目标：建立一套可复用的流程，使后续版本升级（v2.1.143 → v2.x.x）可预测、可验证、可自动化

---

## 1. 核心原则

### 1.1 真相源优先级
```
官方二进制行为  >  提取的 JS 字符串  >  v2.1.88 sourcemap 源码  >  猜测
```
- **官方二进制行为**（`--help`、`--version`、启动日志）是唯一可信的 ground truth
- **提取的 JS 字符串**用于确认代码是否存在（DCE 验证）
- **v2.1.88 sourcemap 源码**是基础骨架，但不代表新版本行为

### 1.2 不信任任何假设
- ❌ "源码目录里有 `assistant/` → 新版本一定启用了 assistant"
- ❌ "这个功能在 v2.1.143 有 → 下个版本一定还有"
- ❌ `"latest" 依赖总是兼容的`
- ✅ **每一个 feature flag、每一个 CLI 选项、每一个命令都必须通过二进制验证**

### 1.3 Help-First 验证
- `--help` 输出是**完美的回归测试**：它覆盖了所有用户可见的 CLI 表面
- 追求 `diff <(node cli-test.js --help) <(official --help)` 为零
- 在此基础上再验证深层功能（命令 handler、权限模式等）

---

## 2. 标准升级流程（Step-by-Step）

### Phase A：获取与基线建立（~30 min）

#### Step A1：定位并验证新版本二进制
```bash
# npm 全局安装新版本
npm install -g @anthropic-ai/claude-code@latest

# 定位二进制
BINARY=$(node -e "console.log(require.resolve('@anthropic-ai/claude-code/bin/claude.exe'))")
ls -lh "$BINARY"

# 验证版本
"$BINARY" --version
# 预期：2.x.x (Claude Code)
```

**产出**：
- `BINARY_PATH`：绝对路径，后续步骤复用
- `NEW_VERSION`：版本号字符串（如 `2.1.145`）

#### Step A2：提取二进制中的 JS
```bash
python3 extract-js.py "$BINARY" --out extracted-js/v${NEW_VERSION}_extracted.js
```

**产出**：
- `v${NEW_VERSION}_extracted.js`：拼接后的提取 JS
- 提取的 prompt 文件（如有新的 classifier prompt）

#### Step A3：记录官方 CLI 表面
```bash
OFFICIAL_HELP="official_${NEW_VERSION}_help.txt"
"$BINARY" --help > "$OFFICIAL_HELP"
"$BINARY" --version > "official_${NEW_VERSION}_version.txt"
```

**产出**：
- 官方 `--help` 输出（作为最终 diff 的基准）
- 官方 `--version` 输出

---

### Phase B：差异分析（~1-2 hours）

#### Step B1：Help Diff（第一层筛选）
```bash
# 用当前 extract-src 构建测试产物
cd extract-src
bun run build
node ../cli-test.js --help > current_help.txt

# 与官方对比
diff current_help.txt "$OFFICIAL_HELP"
```

**解读 diff**：
- `>` 行：官方有，我们没有 → **新增功能**
- `<` 行：我们有，官方没有 → **已删除/已隐藏功能**
- 描述差异 → **文案更新**
- 默认值差异 → **行为变更**

#### Step B2：Feature Flag 审计（关键！）

对每个在 extract-src 中使用的 feature flag，执行 DCE 验证：

```bash
# 检查官方二进制中是否存在该 feature 的关键符号
strings "$BINARY" | grep -i "isAssistantMode"   # KAIROS
strings "$BINARY" | grep -i "BriefTool"          # KAIROS_BRIEF
strings "$BINARY" | grep -i "bridge"             # BRIDGE_MODE
strings "$BINARY" | grep -i "auto.mode"          # TRANSCRIPT_CLASSIFIER
# ... 等等
```

**判定矩阵**：

| 源码状态 | 二进制中存在符号 | 行动 |
|---------|-----------------|------|
| `feature('X')` 为 `false` | 存在 | 改为 `true` |
| `feature('X')` 为 `true` | 不存在 | 改为 `false`（被 DCE 了） |
| `feature('X')` 为 `true` | 存在 | 保持 `true` |
| `feature('X')` 为 `false` | 不存在 | 保持 `false` |

**产出**：`feature-flag-audit.md` —— 记录每个 flag 的审计结果和决策依据

#### Step B3：命令与 Handler 审计

对 Help Diff 中发现的每一个新增命令：
1. 在 `v${NEW_VERSION}_extracted.js` 中搜索命令名（如 `ultrareview`）
2. 定位其 handler 函数边界（通过相邻字符串常量识别）
3. 检查 handler 是否调用了新工具/新组件
4. 检查 extract-src 中是否已存在对应的 handler 文件

**产出**：`command-audit.md` —— 每个命令的状态（已存在/需新建/需更新）

#### Step B4：依赖版本审计
```bash
# 对比 package.json 中的关键依赖版本
cd extract-src
grep -E "commander|chalk|zod|react|ink" package.json

# 在提取的 JS 中搜索依赖特征（如 commander 版本特有的 API）
grep -o "\.implies(" v${NEW_VERSION}_extracted.js | wc -l
```

**产出**：`dependency-audit.md` —— 需要升级/锁定的依赖列表

---

### Phase C：实施（按优先级排序）

#### Step C1：元数据同步（最先做，最快验证）
```bash
# 更新 package.json 版本号
# 更新构建脚本中的 MACRO 定义
# 重新构建并验证 --version
```

#### Step C2：Feature Flag 开关（影响构建体积和可达代码）
```bash
# 批量替换（基于 B2 审计结果）
sed -i '' "s/feature('TRANSCRIPT_CLASSIFIER')/true \/\* TRANSCRIPT_CLASSIFIER \*\//g" src/**/*.ts src/**/*.tsx
sed -i '' "s/feature('KAIROS')/false \/\* KAIROS \*\//g" src/**/*.ts src/**/*.tsx
# ... 等等
```

**注意**：替换后必须立即构建，确认没有引入未解析的模块引用（例如 flag 打开后 import 了一个不存在的文件）。

#### Step C3：CLI 选项更新（直接影响 --help diff）

按变更类型处理：

| 变更类型 | 处理方法 | 示例 |
|---------|---------|------|
| 描述文案更新 | 直接修改 `.option()` / `.addOption()` 的字符串 | `--effort` 增加 `xhigh` |
| 新增选项 | 在 `main.tsx` 的 option chain 中插入 | `--plugin-url` |
| 选项默认值变更 | 修改 `.default()` 参数 | `--remote-control-session-name-prefix` |
| 选项可见性变更 | 添加/移除 `.hideHelp()` | `--remote-control` |
| 参数解析器变更 | 修改 `.argParser()` 或 `.choices()` | `--permission-mode` 增加 `auto` |

#### Step C4：命令注册更新

```bash
# 在 main.tsx 中找到合适的插入位置（通常按字母顺序或功能分组）
# 添加 program.command() 注册
# 如果 handler 已存在 → 更新描述和选项
# 如果 handler 不存在 → 进入 C5
```

#### Step C5：Handler 反向工程（最耗时，按需做）

**仅当** extract-src 中不存在对应 handler 时才需要。

**反向工程 SOP**：
1. 在 `v${NEW_VERSION}_extracted.js` 中搜索命令名字符串（如 `"ultrareview"`）
2. 向上回溯找到函数定义边界（`function ultrareviewHandler` 或匿名函数）
3. 向下阅读到函数结束，记录所有字符串常量和关键逻辑分支
4. 识别依赖：
   - 使用了哪些 import？（通过 `require('...')` 或变量名推断）
   - 是否使用了 Ink 组件？（寻找 `React.createElement`、`jsx` 等模式）
   - 是否涉及文件系统操作？（寻找 `fs`、`path` 相关字符串）
5. 在 `extract-src/src/cli/handlers/` 下新建 handler 文件
6. **最小实现原则**：先实现核心逻辑，让命令能跑通；复杂 UI 可后续迭代

#### Step C6：Prompt 文件同步

如果提取的 JS 中发现了新的 `.txt` prompt 模板：
1. 保存到 `extract-src/src/utils/permissions/yolo-classifier-prompts/`
2. 检查 loader 配置是否覆盖 `.txt`（`--loader .txt:text`）
3. 检查 import 路径是否需要更新

---

### Phase D：验证（循环直至通过）

#### D1：Help Diff 验证
```bash
cd extract-src && bun run build
diff <(node ../cli-test.js --help) <("$BINARY" --help)
# 预期：无输出（零 diff）
```

#### D2：Version 验证
```bash
node ../cli-test.js --version
# 预期：与 "$BINARY" --version 完全一致
```

#### D3：子命令 Help 验证
```bash
# 对每一个新增/修改的命令
node ../cli-test.js <command> --help
# 预期：格式正确，无崩溃
```

#### D4：构建体积监控
```bash
ls -lh ../cli-test.js
# 记录体积，与上一版本对比
# 显著增大 → 可能多启用了不该开的 flag
# 显著减小 → 可能误关了需要的 flag
```

#### D5：冒烟测试（可选但推荐）
```bash
# 非交互式基础功能
node ../cli-test.js --print --version

# 如果可能，测试一个简单命令
node ../cli-test.js doctor
```

---

## 3. 自动化工具集

### 3.1 `extract-js.py`（已有）
- 输入：官方二进制路径
- 输出：`vX.X.X_extracted.js` + prompt 文件 + raw regions

### 3.2 `audit-features.sh`（建议新建）
```bash
#!/bin/bash
# 用法：./audit-features.sh /path/to/claude.exe
BINARY="$1"
FLAGS=("KAIROS" "PROACTIVE" "KAIROS_BRIEF" "BRIDGE_MODE" "TEAMMEM" "TRANSCRIPT_CLASSIFIER")
for flag in "${FLAGS[@]}"; do
  # 定义每个 flag 的关键探测字符串
  case $flag in
    KAIROS)      probe="isAssistantMode" ;;
    KAIROS_BRIEF) probe="isBriefEnabled" ;;
    BRIDGE_MODE)  probe="remoteControl" ;;
    # ...
  esac
  if strings "$BINARY" | grep -qi "$probe"; then
    echo "✅ $flag: PRESENT in binary"
  else
    echo "❌ $flag: ABSENT from binary (likely DCE'd)"
  fi
done
```

### 3.3 `diff-help.sh`（建议新建）
```bash
#!/bin/bash
# 一键对比当前构建与官方帮助输出
set -e
cd extract-src
bun run build
node ../cli-test.js --help > /tmp/test_help.txt
"$BINARY" --help > /tmp/official_help.txt
diff /tmp/test_help.txt /tmp/official_help.txt && echo "✅ Help output identical" || echo "❌ Diff detected"
```

### 3.4 `sync-version.sh`（建议新建）
```bash
#!/bin/bash
# 用法：./sync-version.sh 2.1.145
NEW_VERSION="$1"
sed -i '' "s/\"version\": \"[^\"]*\"/\"version\": \"$NEW_VERSION\"/" extract-src/package.json
# 更新构建脚本中的 MACRO.VERSION...
```

---

## 4. 常见问题与决策树

### 4.1 构建失败：`Could not resolve "src/..."`
- **原因**：新增文件 import 了一个 sourcemap 中不存在的模块
- **解决**：检查提取的 JS 中该 import 对应的真实路径，创建 stub 或完整实现

### 4.2 构建失败：`Could not resolve "bun:bundle"`
- **原因**：直接 `bun run` 调试时触发，但 `bun build` 应该支持
- **解决**：始终用 `bun build` 构建，不要直接用 `bun run src/entrypoints/cli.tsx`

### 4.3 Help diff 中选项顺序不一致
- **原因**：Commander.js 按注册顺序输出，或 `.choices()` 数组顺序不同
- **解决**：调整 `main.tsx` 中的 `.option()` 调用顺序，或调整 choices 数组

### 4.4 体积异常（比官方小 2MB+）
- **可能原因 1**：格式差异（ESM vs CJS+Bun bytecode）→ **可接受**
- **可能原因 2**：缺少 ant-only 模块 → **可接受**
- **可能原因 3**：feature flag 设置错误 → **必须修复**
- **排查**：对比模块数（`Bundled X modules`），逐批启用 flag 观察体积变化

### 4.5 体积异常（比上一版本大很多）
- **原因**：某个 flag 被错误开启，引入了大量不应存在的代码
- **排查**：`strings cli-test.js | grep <可疑模块名>`

### 4.6 官方有某个功能但 extract-src 完全没这个目录
- **原因**：该功能是全新添加的，v2.1.88 sourcemap 中不存在
- **解决**：从 `v${NEW_VERSION}_extracted.js` 完整反向工程，新建目录和文件

---

## 5. 版本升级检查清单（Checklist）

在每个新版本升级时，逐项勾选：

- [ ] **Phase A**
  - [ ] 已定位新版本二进制并确认版本号
  - [ ] 已提取 JS 到 `extracted-js/`
  - [ ] 已保存官方 `--help` 和 `--version` 输出
- [ ] **Phase B**
  - [ ] 已生成当前 vs 官方的 Help Diff
  - [ ] 已完成 Feature Flag 审计（每个 flag 都有决策依据）
  - [ ] 已完成命令审计（新增/删除/变更）
  - [ ] 已完成依赖版本审计
- [ ] **Phase C**
  - [ ] 元数据已同步（版本号、MACRO 定义）
  - [ ] Feature flags 已按审计结果设置
  - [ ] CLI 选项已同步（新增、删除、描述更新）
  - [ ] 命令已注册（新增、描述更新）
  - [ ] Handler 已实现或更新（如有新增命令）
  - [ ] Prompt 文件已同步（如有新的 classifier prompt）
- [ ] **Phase D**
  - [ ] `diff <(node cli-test.js --help) <(official --help)` 为零
  - [ ] `--version` 输出一致
  - [ ] 所有新增/修改命令的 `--help` 无崩溃
  - [ ] 构建体积合理（无明显异常波动）
  - [ ] （可选）冒烟测试通过

---

## 6. 扩展：从二进制直接生成 patch

**远期目标**：将 Phase B/C 中的人力分析部分自动化。

**技术路线**：
1. 改进 `extract-js.js` 的代码块重组能力（从 721 个 chunks 重构为有意义的模块）
2. 使用 AST diff 工具对比 `v${OLD}_extracted.js` 和 `v${NEW}_extracted.js`
3. 将 AST diff 映射回 extract-src 的文件结构
4. 自动生成 `git apply` 可用的 patch

**当前限制**：
- 提取的 JS 变量名已混淆，无法直接映射到 sourcemap 的原始变量名
- React/Ink 组件的 JSX 已被编译，需要反向编译
- 新功能的 handler 通常需要人工理解业务逻辑后才能正确实现

**建议**：保持半自动——机器做 diff 和提示，人做决策和实现。
