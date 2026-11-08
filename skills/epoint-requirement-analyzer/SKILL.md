---
name: epoint-requirement-analyzer
description: 把自然语言业务需求整理成 Actor、User Story、验收标准、不变量和条件专项事实。当用户要求分析需求、拆 Story、写需求文档或进入需求阶段时使用；只分析业务，不输出代码或技术实现。
---

# Epoint Requirement Analyzer

`contractVersion: epoint-4.0-flow/v3`

## 职责

只回答：谁要完成什么业务结果、什么算成功、哪些业务规则始终成立、失败和边界会带来什么业务后果。

- 业务含义和业务取舍由Requirement LLM判断。
- 根结构、Story ID、稳定key、追踪引用、空数组和最终投影由Builder生成。
- Gate只校验已填写字段的类型、引用和阶段闭合，不补业务答案。
- 页面组织、表、类、方法、SQL、接口包装和代码实现交给Design/Coder。

本流水线开发后台管理系统；移动端、网站、小程序和App界面不在交付范围，只交付其调用的接口。

## 第一动作

按顺序调用：

```text
project_scan(projectPath)
req_prepare_context(projectPath, skillName="epoint-requirement-analyzer", demandName?)
```

此前不要搜索工作区、读项目代码、创建`.active-demand`或猜需求目录。`demandName`从用户首句提炼2-8字业务名，Builder添加日期。

## 唯一导航

用户明确修改当前需求时（包括设计或编码已开始），用原入口 `req_prepare_context(projectPath, skillName="epoint-requirement-analyzer", requestMode="revise", feedback="<明确修改内容>", affectedStoryIds?)` 准备修订，不传新 demandName、不另建需求目录。只增量修改受影响 Story，保留稳定 ID 和无关事实，再走原提交、候选确认及 finalize；仍有效的候选确认可复用。完成后恢复 Design，让 Builder 同步后续资料。普通“继续”只恢复；评审或询问不授权修改。

每次工具返回什么`nextActionCard`就执行什么：

- 调用模板原样使用，不增删key。
- `userGate/stopAfter/STOP/blocked`出现后立即停止。
- 恢复或压缩后重新调用只读`req_prepare_context`。
- 当前步骤只以 `nextActionCard`、`analysis-state.json` 的 `currentStep/stepStatus` 和对应提交凭证为准，不维护额外任务看板。
- 过程业务事实只增量修改`fixedPaths.analysisStatePath`。
- `stories.json`、规则池、Markdown和receipt只能由对应MCP生成。
- 除明确的`userGate/stopAfter/STOP/blocked`外，禁止用进度总结结束当前轮；下一步是工具调用时必须在同一轮真实调用。
- “现在调用”“下一步调用”“准备进入”只是文字，不算执行，不得代替MCP工具调用。

## 流程

```text
Step 1-4.5 业务分析
→ Step 5 业务缺口记录（可选，不阻断）
→ Step 5.5 Story业务补全
→ Step 6 决策树素材
→ Step 6.5 三问业务自审
→ req_stories_submit
→ Step 6.6 规则/表候选确认
→ req_finalize_artifacts
```

### Step 1-4.5

1. 识别Actor和目标。
2. 先按“一个可独立验收的业务目标”组织Story。同一目标下的新增、编辑、状态变化、拒绝条件和主动作副作用原则上放在同一Story；只有存在独立业务目标，且有独立责任主体、授权边界、生命周期、交付或查询结果等证据时才拆Story。按钮、字段、流程节点或实现步骤不同，不单独构成拆分理由。
3. 从已有需求识别业务对象及用途、生命周期/状态、是否长期保存和关联对象，区分正式业务记录、临时过程、计算结果和操作日志。对象不等于表，日志也可能有明确留存要求；需求未说明的不猜、不新增必填项或确认环节。
4. 把已知事实写入已有 `userStory`、`acceptanceCriteria` 的GWT或 `invariants`；每条Story至少一条正常GWT，真实存在时补拒绝、异常、边界和跨动作规则。工作流的结果使用现有 `workflowIntent.businessResults`，不创建根级businessResults或对象账本。
5. 再识别副作用、受影响Actor和按需专项事实。公司现成能力已确认时，把能力边界和具体配置要求写入原GWT、不变量或`codingFactHandoff`，区分“整项由现有管理功能配置满足”和“业务仍要开发，只复用平台能力”，保留需要新增的业务行为、拒绝条件及配置范围。确认依据来自用户明确说明或适用当前产品/版本的规则、源码，不把召回关键词或API名称当作现成功能证明；来源不明或版本不适用时不写已确认。已有事实直接复用，不要求每条Story重新检索；不另拆Story，不写表名、类名、Service或页面类型，不把技术方案写进需求真值。

分析顺序是：`Actor → 业务结果 → 业务对象 → 生命周期/状态 → 是否长期保存 → 验收、拒绝和边界 → 统计/工作流/外部系统等专项事实`。这是思考顺序，不新增工具步骤；对象事实随现有Story传给Design。

### Step 5 业务缺口记录（可选）

需求阶段不主动拆模糊点卡，也不为了“分析完整”向用户逐条提问。先用已有事实完成 Story、验收、不变量和专项事实；无法确定的实现细节留给 Design/Coder。

只有用户已经明确给出业务取舍时才吸收进 Story。没有答案时不猜业务结论、不伪造异常/边界，也不因缺少普通字段、页面形态、接口包装或技术细节停在需求阶段。后续 Coder 在读取完整需求和骨架后，若某个未决业务答案确实改变实现结果，再提出一个具体问题。

旧需求中已经存在的 `ambiguityPoints` / `ambiguityCards` 仍可被 Builder 读取和渲染，但它们是兼容输入，不是新需求的必经步骤；不要求新需求创建、逐张确认或吸收这类卡片。

### Step 5.5 最小Story

公开身份只写`stories.US1`对象键，不再填写`storyId`。

普通Story只需`actor/userStory/acceptanceCriteria.happyPath`。精确空槽和条件字段只读取当前`nextActionCard.authoringContract`，不要从Skill猜schema。

规则：

- `happyPath`至少一条。
- `exception/boundary/invariants`有真实业务事实才写；没有就省略，禁止为了过门禁编造。
- 不创建当前卡片未提供的承载、形态或来源追踪字段。
- 已明确的业务结论只写入GWT、不变量或专项事实；未决事项保留为后续阶段问题，不伪造审计结论。

### 条件专项

`existingAdjustment`：仅当本Story必须修改用户明确提供或已有业务事实明确的既有HtmlPage/Action入口时填写，同时写必须保持的原业务结果。只是复用数据、被旧入口触发或参考旧功能时不填。

`deliveryBoundary`：仅跨团队、跨系统或明确无UI时填写。外部UI/外部系统调用本系统表示本团队只交付REST；本系统调用第三方不生成本系统对外REST。

`statisticsIntent`：仅统计/报表Story填写业务标题、目的、筛选、维度、指标和明确展示诉求。指标名称和聚合口径归LLM；filter/dimension/metric的稳定key及确认来源账务归Builder。普通Story也必须先判断其业务对象和留存方式，但不因此填写statisticsIntent。

`workflowIntent`：仅审批/流转Story填写流程名、发起人、节点名称与角色、节点业务操作、流转和可验收结果。每个流程引擎操作至少写操作名称；需要区分保存、提交、通过、退回时可写 `semantic`（只允许 `save/submit/approve/reject`），退回需意见时可写 `requiresOpinion=true`。`transitions.from/to` 只连接 `start`、`end` 或本 Story `activities[].name`。非候选词若表达对象状态或业务结果，写进 GWT、不变量或 `businessResults`；若本意是办理节点，先补进 `activities` 再引用。节点key和操作key归Builder；不写XML、GUID、页面、类名或Java方法。

`codingFactHandoff[]`：仅存在Coder必须消费、且规则/scan/reuseCard无法稳定推出的额外已确认事实时填写。每项只写：

```json
{
  "factType": "",
  "description": "",
  "confirmedFacts": []
}
```

`factId`和来源追踪归Builder。没有额外事实时省略整个字段；事实仍未知时回当前业务卡闭合，不使用状态占位掩盖。

### Step 6/6.5

写决策树素材后，把`authoringContract.step6_5SelfCheck`三问结果写入过程状态。它只检查业务语义，不复写机械字段矩阵。发现缺口先修Story；没有缺口时禁止先向用户展示自审总结，必须立即真实调用：

```text
req_stories_submit({ projectPath, skillName:"epoint-requirement-analyzer" })
```

工具一次返回全部结构问题。修完全部问题后再重调，禁止逐条试错。

### Step 6.6与完成

按卡片依次执行规则候选和表候选Builder调用。表候选只是产品中可能复用的待评估对象，不是复用结论：Requirement 只确认候选，Design 才决定是否真正复用、由哪些Story承载以及字段和关系如何闭合，Coder 负责事务、统计计算、跨Service联动、重试和异常处理。若用户明确说“必须使用/固定使用”某张已有项目表，调用`req_rule_pool_build_rule_draft`时必须把扫描中的真实`tableName`或`entityName`单独放入`userSupplementTableNames`字符串数组；普通补充说明仍放`userSupplement`，不要把整段原话塞进表名数组。若Builder返回`REQUIREMENT_RULE_POOL_EXPLICIT_TABLE_NOT_IN_SCAN`，立即按`nextActionCard`先重跑`project_scan`，再用同一数组重调规则草案，禁止猜表、手写规则池或跳过扫描。表候选卡若返回`requiredTableNames`，提交表决策时必须全部放入`keptTableNames`，不能用`dropAll=true`静默剔除。`unresolvedSignals`只是提示，不阻断。

### 产品源码结论和 Nexbot（可选）

如果需求材料已经有产品源码分析结论，只把受影响 Story 必须交给 Coder 的短事实写入该 Story 的`codingFactHandoff[]`；不要复制整份源码分析，也不要把它写成表决答案。若在调用表候选 Builder 前已经知道真实候选表名，先查 Nexbot，再在`req_rule_pool_build_table_draft`中传入可选的`nexbotSourceEvidence`。若必须先得到 Builder 卡片才能看到候选表名，可以在把卡片展示给用户前再用同一个`decisionDraftId`重调一次并传入来源说明；查不到或工具不可用就直接展示第一次卡片，仍走原确认流程：

```json
{
  "nexbotSourceEvidence": [
    {
      "tableName": "<当前候选的真实表名>",
      "entityName": "<可选：当前候选的真实实体名>",
      "product": "<可选：产品名>",
      "version": "<可选：版本>",
      "queryType": "search_symbol",
      "query": "<实际查询的类名或方法名>",
      "result": "<Nexbot 返回的短源码事实>"
    }
  ]
}
```

已知类名/方法名优先调用 Nexbot 的`search_symbol`；只有没有精确符号身份时才用`search_code`。只传真实查询结果，不把`source.path`或`download_url`当当前项目路径。Builder 只会把精确匹配的结果附加到已有候选的“产品源码查询结果”说明中，不新增候选、不自动判定复用，用户仍必须按原流程确认`keptTableNames`。Nexbot 未安装、未注册、不可用、超时、空结果或查不到候选时，直接省略`nexbotSourceEvidence`，继续原表候选确认流程，绝不能阻断或要求重跑设计。
Nexbot 调用参数按其公开工具合同传递：精确符号使用`search_symbol({ class_name, method_name?, product?, version? })`；只有业务描述时使用`search_code({ query, product?, version? })`。不要自行增加参数，也不要把查询返回的知识库路径写入需求产物。

最终调用`req_finalize_artifacts`。只有返回`ok=true`后才能宣称需求完成，并给出下一阶段`/epoint-requirement-design`接力提示。

## 红线

- 不检索项目源码、HTML、SQL或配置；既有入口只能来自用户或已确认答案。
- 不手写受管根文件、最终Markdown、stories、规则池或receipt。
- 不全量覆盖`analysis-state.json`；只对Builder骨架做受控增量修改。
- 不把实现偏好写进Story；实现表达只留在`implementationPreferenceAuditOnly`。
- 不用关键词或文件名替用户决定业务语义。
- 不把空异常、空边界、空交接字段补成“无”或通用答案。
- `repair_required` 表示当前 Story 输入可机械修复：按 repair 卡修改 analysis-state 后在同一轮重调；它不是用户确认、Runtime STOP 或恢复记录前置条件。

## 按需参考

- 增量写入：`references/file-write-protocol.md`
- Step 2.5/4.5/6.5补充：`references/step-guide.md`
- 规则池确认：`references/rule-recall-protocol.md`
