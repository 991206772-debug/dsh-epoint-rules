# Skeleton Reuse

骨架生成器承担机械结构，Coder 承担业务判断。两者之间的接口是本地已经落盘的 Design/Plan/Story/规则/实践资料，而不是逐文件工具调用。

## 骨架负责什么

- 从工程导航和 Design 合同派生包路径、文件名、类名、注解、继承关系和基础签名；
- 按已确认交付能力物化 Entity、Service 三层、Action/Rest/Job、HtmlPage 和工作流页面底座；`configuration_only`不产生文件，配置要求仍按主Skill交付，不作为缺骨架补代码；
- 为业务代码提供可运行的结构、已有字段、基础方法、页面绑定和流程回调锚点；
- 在骨架阶段处理物理路径去重、依赖顺序和中断恢复。

## 骨架不负责什么

- 不判断业务字段如何归类、查询条件、状态口径、页面布局、异常策略或统计公式；
- 不决定一个 Story 是否与其它 Story 连续实现；
- 不替 Coder 选择所有 DTO/VO、辅助类、页面脚本、外部调用或事务方案；
- 不把示例代码直接当当前需求实现。

## 承载模块（CARRIED）复用规则

`design-tdd-plan.md` 的模块进度看板里，骨架列为 `-`、状态列为 `CARRIED` 的模块，表示该模块**不物化独立骨架文件**，其业务由承载方实现，不能据此认定其页面与业务已完整。

识别与定位：

1. `targetIndex` 中某 Story 的 `moduleId` 对应模块在 plan 看板标记为 `CARRIED` 时，读取该 Story 的 `storyBindings[]`。
2. `storyBindings[]` 中携带 `carriedByModuleId` / `carriedByEntityKey` 的条目，指向承载方的 `moduleId` 和业务对象 key。
3. 用承载方 `moduleId` 在 `targetIndex` 定位物理 owner 文件（Entity / Service 三层 / Action / HtmlPage）。
   如果压缩恢复或新批次尚未有“变更文件”，仍必须从 `targetIndex` 按 Story 过滤 `resolvedPath`；不得重新做通配搜索。`storyIds` 是物理闭包，`storyBindings` 是逻辑归属，`accessByStoryId` 只说明该 Story 的读/写上下文。

约束：

- 承载模块不得重造业务模块、表或 Entity；优先复用承载方文件，页面不能承载原验收时允许在承载模块中补必要 HTML、Action、辅助源码和测试，不借新增文件扩大范围或修改 Builder 真值。
- 一个承载方文件可能同时承载多个被承载模块的 Story（如 MOD-01 的 `ListAction` 同时服务 MOD-01 的工作流 Story 和 MOD-03 的查询 Story）；Coder 按 `storyBindings[]` 区分各 Story 的验收归属，在同一个文件内补全对应逻辑。
- 漏页、错误控件或普通实现缺口按主 Skill 自主补齐，不退回 Design。已确认业务事实或外部路由合同确实冲突时记录具体差异，不自行更改上游合同；其余可执行任务继续。

## 进入 Coder 后

1. 启动、分批读取和恢复统一按主 Skill；只读当前批次关联骨架，不全量预读。
2. 骨架的字段、方法、路由和页面回调是实现入口，不是验收结论；业务差距和完成证据统一按主 Skill 的“任务清单与可见进度”记录，不在本页另设执行清单。
3. 优先在原文件和既有调用链上复用；确认承载不了当前验收后，才最小新增文件或方法。
4. 对新增或修改的技术写法，从 `practiceCards` 和规则菜单选择适用条目的 `contentRef`，完整读取正文，再核对项目真实样例和 `reuseCards` 的精确路径。资料不足时，用当前类名/对象键/API 名作搜索锚点取得事实，不用无关搜索结果猜业务。
5. 所有写入必须在当前需求的业务源码范围内；文件是否是骨架 target 不限制 Coder 为完成业务新增必要的同模块源码，但每个新增文件都要能在计划中解释职责。

## 保护骨架底座

- 保护有效的 Epoint 注解、继承、Service 三层职责、框架资源及既有业务行为；按真实需求及前后台调用证据修正错误的控件、绑定、按钮和对应 Action 方法，不删掉需求要求的功能。骨架中的 id/bind/action 不是不可修正的业务结论。
- 工作流页面必须保留隐藏的 `btnSaveFrom`/`btnSubmit` 锚点、`uc-handlecontrols` 和 `workflowjsboot.js`；按钮由流程配置动态渲染，页面不另加可见流程按钮。
- 不修改 Design 生成的 XML、规则库、上游事实和机器真值文件。

骨架完成后无需再次申请目标投影、重新物化文件或等待外部状态。Coder 直接在计划选定的连续批次中补全业务逻辑。
