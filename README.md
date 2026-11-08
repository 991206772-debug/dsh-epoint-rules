# Epoint 项目规范流水线助手 (DSH 原生插件版)

本插件是政务BG项目个性化开发规范与“需求分析 → 架构设计 → TDD编码”全流程自动化施工流水线的 **DeepSeek Harness (DSH) 原生适配插件**。

---

## 架构演进与核心价值

以往在 VSCode 环境中，流水线通过独立的 MCP 进程（`mcp_tools`）和 VSCode 扩展来驱动，存在子进程管理繁琐、工具名带命名空间前缀、状态割裂等问题。

迁移为 **DSH 原生 Host 插件** 后：
1. **原生工具集成**：所有的流水线工具（如 `req_prepare_context`、`design_prepare_context`、`design_tdd_skeleton_materialize` 等）直接由 DSH Host 注入，工具无前缀，零调用损耗。
2. **Skill 自带下发**：插件通过 Cordis Loader 将自带的 `skills/` 目录注册为 DSH 原生 filesystem 技能来源，用户安装插件即获得完整的需求分析、设计和编码技能。
3. **严格的状态闭环与质量门禁**：通过底层 Builder/Gate 确保业务事实与机器 JSON 契约的物理隔离，保护工程代码资产。

---

## 包含的核心 Skill

| 技能名称 | 阶段 | 核心职责 | 第一动作入口 |
| :--- | :--- | :--- | :--- |
| `epoint-requirement-analyzer` | **需求分析** | 梳理 Actor、User Story、验收标准(AC)、业务不变量与专项事实，生成 `stories.json` 与 `rule-pool.json` | `req_prepare_context` |
| `epoint-requirement-design` | **架构设计** | 根据需求判断新表/复用表、字段/代码项/REST、页面布局与表单对象绑定，生成骨架输入 | `design_prepare_context` |
| `epoint-design-tdd-coder` | **TDD 编码** | 基于物化后的骨架，以 TodoList 模式读取真实源码与公司规则，测试先行连续完成业务编码 | `design_tdd_build_plan` |

---

## 目录结构说明

```text
dsh-epoint-rules/
├── package.json               # DSH Bundle 插件清单
├── cordis.patch.yml           # Cordis 装配定义（Host 插件 + Skill 来源）
├── index.js                   # DSH 原生 Host 插件入口，注册所有流水线工具
├── icon.svg                   # 插件图标
├── locale/                    # 国际化语言包 (zh.json, en.json)
├── skills/                    # 随插件打包的三大核心 Skill 资产
│   ├── epoint-requirement-analyzer/   # 需求分析技能及参考规约
│   ├── epoint-requirement-design/     # 架构设计技能及设计模板
│   └── epoint-design-tdd-coder/       # TDD 编码技能、实践规约及图表资源
└── core/                      # 核心业务引擎与门禁逻辑
    ├── epoint-engine.js       # 核心调度服务类 (原 MCP 服务逻辑的原生化改造)
    ├── modules/               # 流水线支持、上下文管理、扫描器、规则服务
    ├── contracts/             # 门禁规则定义与防泄露策略
    ├── skeleton_generator/    # 代码骨架生成器 (Python)
    ├── rule_harness/          # 规则校验 Harness (Python)
    ├── formatters/            # 代码格式化器
    └── scripts/               # 快速审计、基线生成与工作流生成脚本
```

---

## 在 DSH 中的日常使用习惯

1. **直接呼叫 Skill**：
   在 DSH 对话框中，您可以直接输入：
   > “分析这个需求：新增一个场所预约审核流程，需要支持按日期和场所类型筛选”
   
   Agent 会自动激活 `epoint-requirement-analyzer` 技能，并直接调用原生的 `req_prepare_context` 工具。

2. **顺畅推进无缝切换**：
   - 需求阶段 finalize（生成 `需求分析.md` 和凭证）后，直接输入“进入设计阶段”，Agent 接力执行 `epoint-requirement-design`。
   - 设计阶段完成后物化骨架，直接启动 `epoint-design-tdd-coder` 进行连续 Vibe Coding。

3. **零外部依赖管理**：
   不再需要手动重启 MCP 端口，不再担心 VSCode 侧边栏卡死。所有的流水线状态均在 DSH 进程内高效流转。

---

## 安装与验证

在 DSH 的插件管理器或会话中：

```javascript
// 安装当前本地插件 Bundle
plugin_manager({
  action: "install_bundle",
  target: "D:\\tools\\test\\dsh-epoint-rules"
});
```

安装后，刷新或新建会话即可使用所有工具与 Skill。


## GitHub 安装与验证

仓库：https://github.com/991206772-debug/dsh-epoint-rules

桌面版可在插件管理中使用仓库地址安装；命令行版在自己的 Profile 中安装：

~~~powershell
dsh plugin --profile web add github:991206772-debug/dsh-epoint-rules
~~~

公开源码不包含用户配置、笔记、真实会话、凭据或 node_modules。验证使用隔离目录，不主动重载正在运行的 DSH。

## 许可证

自有源码采用 [MIT](LICENSE)，署名 991206772-debug。随附第三方文件保留各自许可证，见 [第三方说明](THIRD_PARTY_NOTICES.md)。

## 团队知识库配置

公开版不带公司内网知识库地址。需要在线读取规则时设置 KNOWLEDGE_GIT_URL，可配合 KNOWLEDGE_GIT_BRANCH 和 KNOWLEDGE_GIT_TOKEN；凭据保存在本机环境中。未配置远端地址时，规则读取保留已有的本地文件与索引回退方式。KNOWLEDGE_REPO_PATH 用于选择本地团队规则索引。
