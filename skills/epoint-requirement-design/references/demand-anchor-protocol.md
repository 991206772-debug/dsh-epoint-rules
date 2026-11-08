# Design恢复协议

Design只使用`design_prepare_context`恢复和推进。

- 无phase调用是只读恢复入口，可传工程根、当前需求目录、`design/.runtime/`或当前卡片路径。
- 服务端机械归一到当前工程根和`.active-demand`指向的需求目录；解析失败零写盘。
- 当前步骤、stepId、accepted model和pending batch由`design/.runtime/design-workflow-state.json`记录。
- 正常T2复用T1已披露的共享Story证据；仅在压缩或重启后，prepare通过`recoveryEvidenceRefs`返回同一组精确路径供恢复读取。
- LLM不读取旧task、receipt或聊天摘要重建状态，也不搜索阶段目录。
- 写提交必须携带当前stepId；相同stepId和相同payload幂等，不同payload返回stale。
- 有效`design-finalize-receipt.json`优先于未完成状态，直接返回completed。

字段、行协议和repair真相只在`DesignDecisionStepDefinition`与当次`currentCardRef`中维护；本文件不镜像字段表。
