# 需求阶段增量写入协议

## Owner

- Builder创建`analysis-state.json`根结构、Story对象键和受管产物。
- LLM只在已有`stories.USx`和步骤结果中写业务事实；旧 ambiguity 字段仅作兼容读取。
- Runtime Guard在写盘前模拟替换并校验完整JSON；非法JSON不得落盘。

## 允许操作

1. 精确读取`req_prepare_context.fixedPaths.analysisStatePath`。
2. 使用`str_replace`修改一个明确存在的完整JSON片段。
3. 修改后重新读取目标片段确认业务内容。

禁止搜索需求目录、全量覆盖、追加JSON文本或直接修改`stories.json`。

## 已知业务缺口

需求阶段不要求为每个缺口创建确认卡或等待用户回答。已有业务结论直接写入 Story；没有答案的事项不写成猜测，也不新增未经合同允许的字段。后续 Coder 读取完整需求后，只有确认该事项会改变实现结果时才提出问题。

旧需求若已经存在 `ambiguityPoints` / `ambiguityCards`，可以按原结构增量维护；这只是兼容数据，不是新需求的必经写入步骤。

## 最小Story写入

- 必填：`actor/userStory/acceptanceCriteria.happyPath[]`。
- 可选：真实存在的`exception/boundary/invariants`。
- 条件：`existingAdjustment/deliveryBoundary/statisticsIntent/workflowIntent/codingFactHandoff`。
- 禁止：在当前卡片之外自创身份、承载、形态或来源追踪字段。

一次修改尽量围绕一个Story或一个明确业务事实片段，避免跨大段字符串替换。Runtime Guard拒绝后重新读取当前片段再修，不得盲目重复替换。
