# Design Input Contract

需求分析和 Design 阶段已经完成业务事实、对象关系、字段、Story 验收、规则确认和代码落点。骨架阶段由 Builder 机械生成结构；骨架完成后 Coder 直接读取本地文件，不通过 MCP 重新申请上下文。

## 输入导航

启动和恢复步骤以 [SKILL.md](../SKILL.md) 为准。入口使用 `requirement-work-draft-index/v3`：`storyCatalogRef` 是功能目录，当前 Story 的 `detailRef` 给完整验收和资料直接引用；`readCatalogRef` 中的 `readCatalog.resources` 将资源 ID 映射为绝对路径。`targetIndexRef` 按承载模块引用完整目标，物理文件只保存一次。超预算资料通过 `contentRef/contentRefs/nextRef` 续读，不截断原文。规则切片给菜单，复用切片给源码入口，不是全部正文。

## 版本桶感知

骨架和规则按框架版本桶区分（`<projectPath>/.ai-workspace/project/框架版本档位.json` 的 `versionBucket`）。读取规则正文或框架示例时，先确认版本桶，只套用当前版本桶适用的要求：

- `950及以上`：Entity 不需要 `Cloneable`；规则中出现的 `Cloneable` 是 `950以下` 的要求，不补。
- `950以下`：Entity 必须 `implements Cloneable`。

骨架按版本桶提供起始结构，正确性仍须核对当前规则和源码；不按与当前版本桶矛盾的旧要求改写。

## 读取原则

- 先读取全部功能目录，保留全部 Story/AC 的覆盖关系；当前任务完整读取验收正文、不变量及相关目标，不预读全部 AC 正文和代码目录。目录只用于了解范围，不能替代当前验收或最终原始需求核验。
- `candidateFiles`、`ownerFiles`、`targetSummary` 是导航和骨架参考；最终需要修改/新增的文件由 Coder 根据完整验收和当前调用链决定，并写入任务记录。
- `targetRefs` / `targetIndexRef` 中的物理文件提供原有 `moduleId`、`fileKind`、`resolvedPath`、`storyIds`、场景及承载信息；`storyIds` 与 `storyBindings[].storyId` 必须闭合。`accessByStoryId`（若存在）只是读/写导航信息，不是新增源码的白名单。
- `targetIndex` 中 `storyBindings` 携带 `carriedByModuleId` / `carriedByEntityKey` 的条目，表示该 Story 由承载模块提供；优先复用其 owner 文件，原页面不能承载时可在该模块补必要页面及源码，不重造业务模块、表或 Entity。判断和恢复统一按主 Skill。
- intake 的 `current` 只是首个编辑入口提示，不是硬性施工顺序；Coder 以当前任务完整验收和业务连续性决定真实编辑目标。
- `businessFactRefs` 提供当前 Story 的直接事实，`relatedFactRefs` 保留关联参考，按当前验收涉及的行为展开；`globalFactRefs` 仍是归属未明确的事实，不默认省略。
- `ruleMenuCards`、`practiceCards` 是短菜单，保留标识和适用条件，以 `contentRef` 指向共享完整卡片。同标识不同内容不可互换；选中正文后完整续读，再按卡中引用核对规范。`reuseCards` 提供已有实现的证据入口，不把菜单候选当全部必读。
- 技术事实查证、定向搜索和可选 Nexbot 使用统一按主 Skill 执行，不用搜索结果补业务事实。

## 不可修改输入

Coder 不手工写入或修改：

- `design-tdd-plan.json`、`business-facts.json`、`relevant-rules.json`、`code-state.json`；
- Design 完成凭证、骨架清单、编译凭证、最终凭证和其它 Builder-owned JSON；
- 规则库、团队小抄、平台目录和 Design 阶段配置。

Coder 只维护 `demand-implementation-tasks.md`，在同一任务记录中保存要求、实际结果、验证和缺口，用于恢复、协作和最终汇报，不是机器状态真值。可见 TodoList 是该清单的展示，不另维护一套结果；具体格式和更新时机按主 Skill。
