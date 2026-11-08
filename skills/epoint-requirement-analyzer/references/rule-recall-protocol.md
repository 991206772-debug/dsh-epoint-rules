# Step 6.6 规则池 Builder 协议

## 目标

需求阶段只确认候选池，不做模块绑定、不写设计实现、不决定文件范围。

固定账务全部由 Builder 做：

- 读取 `.active-demand`、`analysis-state.json`、`stories.json`；`需求分析.md` 仅作旧需求兼容兜底，正常流程由 finalize 最后生成。
- 合并已确认的业务补充到 Story 级规则检索上下文；没有确认答案的缺口不伪造成规则输入。
- 按 Story 召回业务规则、基础约束、项目表候选和未解析信号。
- 去重、编号、生成两张确认卡。
- 根据 LLM 传入的结构化决策写正式 `rule-pool.json`、`rule-recall-raw.md` 和 receipt。

LLM 只负责调用工具、展示当前确认卡、把用户对当前卡片的回复解析成结构化字段。Builder 不解析自然语言。

## Step 6.6.1 生成规则草案

调用：

```js
req_rule_pool_build_rule_draft({
  projectPath: "<projectPath>",
  skillName: "epoint-requirement-analyzer"
})
```

如果用户明确要求必须使用某张已有项目表，必须单独传真实的 `tableName` 或 `entityName`，不要把整段原话塞进 `userSupplement`：

```js
req_rule_pool_build_rule_draft({
  projectPath: "<projectPath>",
  skillName: "epoint-requirement-analyzer",
  userSupplementTableNames: ["<用户明确指定的真实表名>"]
})
```

只有“必须使用/固定使用”这类明确要求才填写 `userSupplementTableNames`；普通的补充说明、重查线索仍放 `userSupplement`。Builder 会逐项核对本次 `project_scan` 的 `entity-graph` 候选：扫描不到时立即 blocked，并返回刷新扫描和重试草案的唯一恢复路线；不得自行发明表候选或静默漏掉用户指定表。

返回 `ok=true` 时：

- 原样展示规则 `confirmationCard`。
- 最后一屏必须等待用户只回复规则决策。
- 不展示表候选，不改写卡片编号，不删减业务规则。
- 不手写 `rule-pool.json`。

用户要求补充或重查候选时，重新调用本工具并传：

```js
req_rule_pool_build_rule_draft({
  projectPath: "<projectPath>",
  skillName: "epoint-requirement-analyzer",
  userSupplement: "<用户补充原文>"
})
```

返回 blocked 时，按 `allowedNextActions` 修复上游需求产物后重调。

## Step 6.6.2 提交规则决策

用户只看到了规则确认卡，所以 LLM 只解析规则保留集合。

调用：

```js
req_rule_decision_submit({
  projectPath: "<projectPath>",
  decisionDraftId: "<build_rule_draft 返回的 decisionDraftId>",
  keptRuleAliases: ["<保留规则别名>"],
  userInput: "<用户对规则确认卡的原始回复，审计必填，原样透传>",
  skillName: "epoint-requirement-analyzer"
})
```

规则：

- `keptRuleAliases` 必须来自规则确认卡候选；空数组表示规则候选全部剔除。
- Builder 只校验 `keptRuleAliases ⊆ 候选`，不从 `userInput` 猜保留/剔除。
- 本步只写规则阶段 receipt，不写最终 `rule-pool.json`。

## Step 6.6.3 生成表候选草案

按 `submit_rule_decision` 返回的 nextActionCard 调用：

```js
req_rule_pool_build_table_draft({
  projectPath: "<projectPath>",
  decisionDraftId: "<同一个 decisionDraftId>",
  skillName: "epoint-requirement-analyzer"
})
```

返回 `ok=true` 时：

- 原样展示表候选 `confirmationCard`。
- 最后一屏必须等待用户只回复表候选决策。
- 不回看或重判规则决策；规则阶段已锁定。

如果用户此时反悔规则决策，必须重新从 `req_rule_pool_build_rule_draft` 开始整轮重做。

## Step 6.6.4 提交表候选决策

用户只看到了表候选确认卡，所以 LLM 只解析表候选保留集合或全部剔除。

调用：

```js
req_table_decision_submit({
  projectPath: "<projectPath>",
  decisionDraftId: "<同一个 decisionDraftId>",
  keptTableNames: ["<保留表名>"],
  dropAll: false,
  userInput: "<用户对表候选确认卡的原始回复，审计必填，原样透传>",
  skillName: "epoint-requirement-analyzer"
})
```

全部剔除时：

```js
req_table_decision_submit({
  projectPath: "<projectPath>",
  decisionDraftId: "<同一个 decisionDraftId>",
  keptTableNames: [],
  dropAll: true,
  userInput: "<用户对表候选确认卡的原始回复，审计必填，原样透传>",
  skillName: "epoint-requirement-analyzer"
})
```

Builder 写入：

- `rule-pool.json`
- `rule-recall-raw.md`
- `analysis-state.json.step6_6_ruleRecall`
- `rule-pool-submit-receipt.json`

`submit_table_decision` 返回 `status="ready"` 后进入需求 finalize。若返回中包含 `unresolvedSignals` / `ruleGapAdvisory`，它们只是规则召回提示项：

- 可以在最终接力卡中简要披露，但不要求用户确认。
- 不阻断 `req_finalize_artifacts`、设计或 Coder。
- 禁止手写删除 `rule-pool.json.storyRuleRecalls[].unresolvedSignals`，也禁止把提示项冒名成已确认规则。
- 用户后续补充规则线索/规范名称/已确认实现依据时，可把原文作为 `userSupplement` 重跑 `req_rule_pool_build_rule_draft`。

## rule-pool.json 消费口径

正式 `rule-pool.json` 包含两个已确认候选池：

- 业务规则池：`globalWhitelist[]` / `globalBlocklist[]`
- 表候选池：`globalTableCandidateWhitelist[]` / `globalTableCandidateBlocklist[]`
- 用户审计原文：`userInputForGlobalPool` / `userInputForTableCandidatePool`

设计阶段只能消费这两个确认池。

设计阶段遇到表设计时：

- 只能评估需求阶段保留的表候选。
- 需求阶段保留的候选只是待评估对象，不等于最终复用；Design 根据对象生命周期、字段、关系和Story承载决定新建或复用。
- 复用候选表时必须来自 `globalTableCandidateWhitelist[]`。
- 新建表时必须说明已保留候选表为什么不复用。
- 不得复用 `globalTableCandidateBlocklist[]` 中的表。

## 硬约束

- 禁止调用退役工具 `req_rule_pool_build_draft` / `req_rule_pool_submit_decision`。
- 禁止 LLM 手工设置 `rule-pool.json.confirmed=true`。
- 禁止 LLM 手工汇总 `globalWhitelist/globalBlocklist`。
- 禁止 LLM 手工搬运表候选白名单/黑名单。
- 禁止在设计阶段重新调用 `rule_expert(action="analyze")` 补召回。
- 规则名必须来自规则草案候选；表名必须来自表候选草案；用户明确补充后必须重新入草案。
- 草案若返回 `requiredTableNames`，其中的用户明确指定表必须全部放入 `keptTableNames`，不能用 `dropAll=true` 静默剔除；遗漏时按 Builder 返回的补齐模板重调，不要手改规则池。
- `userInput` 是用户确认卡原始回复的审计必填字段，必须原样透传；它只作审计原文，不能作为 Builder 决策来源。
