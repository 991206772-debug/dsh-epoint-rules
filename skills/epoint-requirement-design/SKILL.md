---
name: epoint-requirement-design
description: 把 epoint-requirement-analyzer 的结构化需求转成设计机器合同。用户要求进入设计、生成设计文档或需求转设计时使用。
---

# Epoint Requirement Design

`contractVersion: epoint-4.0-flow/v3`

## Role

**交付边界红线：**本流水线只设计后台管理系统及外部渠道所需接口，不设计移动端、网站、小程序或 App 页面。外部 UI 与系统调用方向由 Requirement 的 `deliveryBoundary` 锁定；Design 只消费该事实，外部 UI 生成 REST 合同且不得生成 HtmlPage。

你只做四类业务判断，且按以下顺序执行：

1. 先根据Requirement提供的业务对象、长期保存、生命周期和关系事实，以及已确认现有能力的适用范围，判断全局需要哪些新表、确认复用表和表关系；不要为平台已承担的管理功能另建业务对象。
2. 再判断每个Story交付维护、查询、动作、Job还是现有平台配置，主要由哪张表承载。没有本地表时填 `-`；整条Story已确认只需现有平台配置时选`configure`，不生成代码。
3. 再判断新表有哪些业务字段；Requirement已确认对外REST时有哪些业务操作、请求事实和返回事实。
4. 只有存在页面时才判断页面归属、实际表单对象、明细交互和筛选条件；只有页面确实复杂时，才判断普通/手风琴布局及字段分区。不要让布局判断反过来决定表、关系或业务对象。

Builder负责表名、主键、公共字段、关系外键、表的owner Story归属、关系路径、页面外壳、组合块渲染、REST命名、骨架和最终投影；它严格消费设计选择，不根据表名、关键词、表数量或业务块数量替选页面归属或布局。Coder负责跨Service调用、事务、第三方映射、版本算法、统计查询、重试和异常处理。

正常步骤采用 `tool-call-only`：业务分析只在内存完成，随后直接调用工具。禁止在对话中输出候选表方案、字段草稿、自我讨论或提交前复述；只有用户决策卡、blocked错误和最终完成结果可以显示正文。

## First And Resume Action

首次进入、对话压缩、进程重启或用户说“继续”时，都只调用：

```text
design_prepare_context(projectPath, skillName="epoint-requirement-design")
```

该调用直接建立或恢复当前答题卡。工具名和入参已知，不要先读工具描述，不要搜索工具名、 `.active-demand`、阶段目录或旧task文件。返回 `completed` 只表示设计合同完成，按下文 Recovery And Stop 处理返回的后续动作，处理完毕才进入Coder；返回 `currentCardRef` 时读取该路径及其 `storyEvidenceRefs`、`objectProfileRefs`。Story 的 `ruleRefs` 是已确认规则的来源导航，不是正文或“功能现成”的结论；只有现有能力边界影响当前设计且已有事实不足时，按引用读取相关正文，路径无效时用 `rule_expert(action="read", ruleName="<ruleAlias>", outputMode="full")`，不再次 analyze 或全读 API。禁止另读 `stories.json` 或 `rule-pool.json`；恢复证据使用响应的 `recoveryEvidenceRefs`。

## Table And Skeleton Rows

用户明确调整设计时，用同一 `design_prepare_context` 传 `requestMode="revise"`、`feedback`、`revisionPhase` 及可选 `affectedStoryIds`，不同时传 stepId 或答题数组。`revisionPhase` 选最早受影响阶段：承载/关系用 structure_confirmed，字段/显示标签/API 用 details_confirmed，页面/筛选用 page_design_confirmed。读取返回卡片和 `acceptedAnswerRef`，取得新 stepId 后仍按原行协议提交，不用旧步骤改答。结构和字段按稳定行键增量修改；直接页面修订需提交受影响 Story 的完整页面行，省略的旧分区或绑定会被移除，无关 Story 保留。普通继续和评审不触发修订。

修订提交仍经过正式 Builder 的投影预检；可修复输入按当前卡定向处理，生成器缺陷不得通过改业务答案凑合。既有 Plan、facts 和 Coder 导航由 Builder 自动同步，旧计划存在不再要求覆盖确认。同步中断按唯一恢复动作续做；已完成文件及业务代码保留，只生成新增目标。需求含义改变交 Requirement 修订，原需求未变的代码遗漏由 Coder 直接修，不重做整个需求。外部 design-to-sql 保持原合同，不执行 SQL、部署或删除旧代码。

先按完整需求的对象、生命周期和留存事实判断数据承载，再判断Story是否复用已有业务入口，不先按Story新建模块、Action或页面。候选表不等于最终复用结论；从已确认候选中评估是否满足业务，用户明确固定使用的表仍须遵守。同一业务对象的普通 query 默认复用承载模块的列表入口；只有独立导航、权限或交互事实已经成立时，才提交 `QUERY_SURFACE|<story_id>|independent|<page_key>`。没有显式独立声明时，不得按 Story 名称、模块名或类名派生第二套入口。

工作流先判断“流程记录是否就是主业务记录的生命周期”。如果只是对主业务记录做提交、审核、退回、办结或查询，结构卡中该 Story 的 `STORY` 行填写主业务 `tableKey`；多个 Story 可以绑定同一张新建或确认复用的表，Builder 自动生成内部承载关系。只有需求存在需要独立保存的流程业务对象时，才用 `TABLE` 声明该对象并通过 `STORY` 绑定，不为满足生成器而新建流程表。

第一张卡读取一次Story evidence后，在 `structure_confirmed` 用一个扁平 `decisionRows[]` 提交：

```text
TABLE|<table_key>|new|<中文业务表名>
TABLE|<table_key>|reuse|<卡片中的确认候选表名>|<中文业务表名>
RELATION|<parent_table_key>|<child_table_key>|<one_to_one/one_to_many/many_to_one/reference>|<业务关系含义>
STORY|<story_id>|<maintain/query/action/job/configure>|<table_key_or_dash>
```

- `TABLE` 只表达本需求真正需要持久化的新表或Requirement已确认的复用表。临时操作过程、中间结果和未要求留存的日志不要默认建表。
- 需求明确存在主从、版本或业务引用时才写 `RELATION`，没有事实就不补造。
- 每个Requirement Story恰好一条 `STORY`。一个Story涉及多表时只填写其骨架主要挂靠的表；完整Story和全部表事实会交给Coder。
- `Story`是业务目标，不等于表、模块或页面；多个Story可以共用一张表，一个Story也可以读取多张表。`table_key_or_dash`表示主要业务承载，不表示必须新建表。
- 本阶段不填写 `COMPOSE`、不猜页面布局、不选择明细编辑方式。页面设计必须等字段/API批次全部闭合后，按独立页面设计卡完成。
- `maintain/query/action/job/configure` 只表达交付能力。`configure`必须填写`-`，整条Story通过现有平台配置满足，不提交表、字段、REST、工作流或页面行；保留配置和验收要求。存在定制业务实现仍选原能力，不能因出现权限、菜单或代码项关键词就免除开发。调用已有API不等于整条Story只配置：业务表单、保存、权限拒绝或联动仍须设计并交给Coder；平台代码项/角色/菜单管理本身不重建，定制业务映射、生效规则等不能被普通配置代替。适用版本或能力范围未经确认时不声称现成功能已满足要求；仅对影响当前判断的缺口定向取证，不要求每条Story遍历规则。跨Story页面共享与独立入口由Design在页面卡用`PAGE_BIND`明确；Builder只机械校验和投影。
- `maintain` 表示主要结果是新增、修改、删除或改变业务状态；`query` 表示主要结果是独立浏览、检索或查看；`action` 表示依附业务上下文的一次性命令，如发布、同步或导出；`job` 表示没有人工触发的后台任务。先按业务结果判断，再用是否需要表单作为页面和骨架的辅助依据：有表单通常选`maintain`，但不能仅凭“有无表单”决定类型；批量发布、导入、重算等仍按实际业务结果判断。工作流Story如果有申请表单，选`maintain`而非`action`。
- 普通 `query` 不写 `QUERY_SURFACE`；Builder 会把它合并到同一业务对象的默认列表入口。显式 `independent` 查询仍必须复用真实承载 Entity/Service，只允许独立 Action/Page 表面。
- `TABLE_STORY` 只需为无法从 `STORY` 或 `RELATION` 推出归属的孤立辅助表填写；多填但与推导归属一致时由Builder忽略，冲突时修正当前行。缺少必要归属时按 `DESIGN_MODEL_CARRIER_STORY_BINDING_MISSING` 补齐，不使用首个 Story 兜底。
- Workflow、Statistics、对外REST边界和既有入口证据由Requirement锁定，不重复填写；本系统调用外部系统不是对外REST。

同一阶段不重复无目的读取证据，形成自洽答案后直接调用工具；发现对象、Story、字段或关系矛盾时，结构卡可定向重读storyEvidenceRefs，后续卡或上下文丢失时先无phase调用prepare取得recoveryEvidenceRefs，再只重读相关分片。保留当前stepId和已确认步骤，不手改受管事实；若矛盾涉及已确认输入，按工具的恢复合同处理，不能默默绕过。禁止全量反复读取无关资料。

## Field And API Rows

结构通过后，Builder返回字段/API卡。在 `details_confirmed` 用一个扁平 `detailRows[]` 提交：

```text
FIELD|<table_key>|<column_name>|<type>|<length_or_dash>|<true_or_false>|<业务含义>
CODE_ITEM|<table_key>|<column_name>|new|<代码项中文名>|<codeValue>=<显示名>,...
CODE_ITEM|<table_key>|<column_name>|reuse|<代码项中文名>|<Requirement已确认事实ref>
ATTACHMENT|<table_key>|<column_name>|<true_or_false>|<附件业务名称>
REST|<story_id>|<operation_key>|<业务目的>|<请求事实>|<返回事实>
WORKFLOW_EVENT|<story_id>|<operationKey>|none|-|-|- 或 WORKFLOW_EVENT|<story_id>|<operationKey>|service_method|<methodName>|<操作后业务效果>|pviguid=$PVI_GUID:流程实例标识,<name>=<常量>:<参数含义>
```

- 只给 `new` TABLE填写业务字段；复用表已有字段由Builder从扫描结果带入字段画像，不用FIELD重复声明，禁止新增字段。
- 主键、公共字段、关系外键、物理表名、表注释和模块命名由Builder生成。
- LLM一次性决定普通业务字段的拆分以及每个字段的 `type/length/required`；这里的 `required` 表达页面和业务必填，不代表数据库 `NOT NULL`。数据库只把 `rowguid` 设为必填，其余字段默认允许空。
- `CODE_ITEM`只能标记本卡已声明的普通`FIELD`。新增代码项填`new`并给出ASCII稳定值与显示名；复用平台已有代码项填`reuse`和已确认事实ref，不重抄已有值。不得把布尔控件或普通文本字段为了表单完整强行改成代码项。
- `ATTACHMENT`本身就是附件字段的唯一声明，第四段表达页面和业务必填；不要再为同一列提交`FIELD`。Builder固定把它投影为长度50的附件稳定标识字段，并保留附件业务名称。
- 字段卡会给出 `codingFactCandidateRows`（`factId|storyId|factType|description`）或 `codingFactCandidateRowsRef`。内嵌数组与同名Ref互斥；存在Ref时，沿分片的 `nextRef` 完整读取至末尾，再判断候选是否为空。`workflowOperationCandidatesRef`、`relatedStoryIdsRef` 和 `relationsRef` 同样处理。引用分片只拆读取资料，不改变本卡的字段/API提交范围；不重复无目的读取已读证据。`reuse` 的sourceRef只能复制完整候选行首段factId；候选为空时禁止reuse，不得编造“Requirement已确认”等说明文字代替factId。
- 动态联动、远程搜索或运行时加载选项保留为FIELD，不写静态CODE_ITEM；只有Requirement明确确认静态值列表或可复用代码项事实时才写CODE_ITEM。
- `REST` 只在卡片明确列出 `restStoryIds` 时填写；方法名、basePath、path和POST包装由项目REST style contract机械生成。
- REST `operation_key` 必须是小写snake_case（`^[a-z][a-z0-9_]*$`），例如`place_detail`，禁止`placeDetail`。
- 工作流Story的字段卡会列出每个节点操作和稳定`operationKey`；每个操作必须恰好提交一条`WORKFLOW_EVENT`。没有操作后业务填`none`；需要操作后业务时填`service_method`，写明确方法名、业务效果和参数，并且必须包含`pviguid=$PVI_GUID:流程实例标识`。`methodName`必须是合法lowerCamelCase Java方法名：以小写字母开头，只允许字母和数字，禁止下划线和连字符（如`submitApplication`，禁止`submit-application`或`submit_application`）。这里仅表达业务决策，不填写XML、GUID、类名、路径或Java代码。
- 普通查询、同步和导出没有新增表字段或对外REST义务时不增加空行。
- Requirement统计 `sourceField` 是业务引用；Builder能唯一映射时规范化为 `object.field`，否则原样交给Coder，不得伪造同名FIELD。

字段卡及其证据分片按实际序列化后的12KB字节预算生成，不按表数量机械分批。Builder先拆证据读取资料，剩余提交范围仍超预算时才拆字段提交；每次只提交当前卡范围，未超预算的需求仍一次提交全部新表字段。

## Page Design Rows

字段/API全部闭合后，Builder返回 `page_design_confirmed` 页面设计卡。此时字段画像、关系图和Story入口已经稳定，使用一个扁平 `compositionRows[]` 提交。先确定用户在哪个页面完成哪个业务目标，再判断页面归属、表单对象和筛选；只有存在多个业务对象同页编辑或复杂信息分组时，才判断普通/手风琴布局和字段分区。布局、页面归属和筛选分别判断：不需要复合布局时不写COMPOSE，但仍提交适用的PAGE_BIND和QUERY_FILTER；所有行类型均无设计义务时才提交空数组 `[]`：

```text
COMPOSE|<story_id>|<plain/accordion>|form:<table_key>,child_edit:<table_key>或child_readonly:<table_key>
SECTION|<story_id>|<section_key>|<中文分区标题>|<table_key.field_name>,...
PAGE_BIND|<story_id>|shared|<target_compose_story_id>
PAGE_BIND|<story_id>|independent|self
QUERY_FILTER|<story_id>|<input_key>|<table_key.field_name>|<contains/exact>|<trim/none>
```

`compositionRows` 传参形态示例：

```text
// 无布局、页面归属或筛选设计义务
[]

// 普通列表有名称筛选，不需要COMPOSE
["QUERY_FILTER|US1|searchKeyword|place.placename|contains|trim"]

// 普通复合布局不写SECTION
["COMPOSE|US1|plain|form:place,child_edit:window",
 "PAGE_BIND|US2|shared|US1"]
```

- `compositionRows` 必须是 JS 数组（`[]` 或 `["行字符串","行字符串"]`），不要传字符串、null 或对象；不要把 `nextCall.arguments` 里的占位符 `"<按currentCardRef填写>"` 原样回传。

- 页面布局是Design LLM判断，不是Requirement答案，也不是Builder规则。综合“是否需要同时可见、是否统一保存/校验、字段和控件密度、区块独立性、操作频率、版本对象与表单对象是否不同”后选择。
- 需要同时查看、频繁联动、统一保存或跨区块校验时通常选择 `plain`。多个独立长区块适合渐进展示，或者单一表单字段很多且能按业务语义分类时选择 `accordion`。
- `accordion`不要求多个业务对象。只有一个`form`时可用多个`SECTION`把字段分成手风琴分区；SECTION标题和字段归属由LLM判断。`SECTION`只在`accordion`布局下有效；选择`plain`布局时不写`SECTION`行，字段按业务块顺序直接展示。附件也是表单业务字段，可以归入对应SECTION；使用SECTION时覆盖form对象全部业务字段，同一字段不得重复分配。未归入SECTION的附件由Builder单独投影。
- 页面卡字段画像统一由 `objectProfileRefs` 提供；已有卡内的 `objectProfiles` 仍可直接使用。候选和关系使用卡内 `pageCandidates/relations`，移出时读取 `pageCandidatesRef/relationsRef`；恢复范围移出时读取 `targetStoryIdsRef`。这些分片沿 `nextRef` 精确读取至末尾，读齐后仍用当前stepId一次提交，不漏读、不按字段名猜测、不把资料分片当作业务分批。`storyEvidenceIndexRef` 只提供原始证据路径清单，正常衔接不重读原始Story；上下文恢复或发现矛盾时，再沿清单的nextRef定位相关证据定向重读。
- `form`选择页面实际承载字段和校验的对象，可以是Story根对象沿已声明关系可达的版本对象。不要为了让明细成为Story根对象直接子表而补造关系。
- `child_edit`表示同页批量新增、修改或删除并与form共同保存；`child_readonly`表示历史快照、引用信息或当前权限下只读。child必须是所选form对象的直接明细，Builder自动计算relationPath和外键。
- `PAGE_BIND`只允许当前团队实际交付页面候选中的`maintain` Story；`action`、`job`、`configure`以及`requirementSceneLock=rest_interface`的外部Story不写`PAGE_BIND`。`query` Story在结构阶段（decisionRows）用`QUERY_SURFACE`声明独立入口；在页面设计阶段（compositionRows）只写自己的`COMPOSE`，不写`PAGE_BIND`也不写`QUERY_SURFACE`——`QUERY_SURFACE`不是`compositionRows`合法行类型，`compositionRows`只接受`COMPOSE`、`SECTION`、`PAGE_BIND`、`QUERY_FILTER`。如果某个当前团队maintain Story的对象被其它Story的`COMPOSE`作为`child_edit`承载，必须用`PAGE_BIND`明确页面归属，Builder不得从child块、表名或Story文案反推答案。
- `shared`目标必须是本次已有`COMPOSE`的Story，且目标页面必须以`child_edit`承载源Story对象。相同表单对象的Story由稳定页面身份机械归并，不使用`PAGE_BIND`；`child_readonly`也不能承载maintain Story。只提交`shared`时，源Story进入目标页面施工范围，保留Entity/Service，不生成自己的Action/Page。
- `independent|self`表示保留源Story自己的独立入口。它可以单独使用，也可以和一条或多条`shared`同时提交；后者表示同一Story既进入明确的父页面，也保留自己的独立页面。
- 同一Story可用多条`shared`绑定多个确有业务依据的页面。不要为了消除Builder冲突而删掉真实页面，也不要把一个业务判断拆成隐式默认值。
- 需求出现列表筛选时，逐项写`QUERY_FILTER`，明确“页面输入名 → 字段画像中的真实字段 → 查询方式 → 是否去首尾空格”。可以引用复用表或关联对象的字段；关联对象须有唯一已声明关系路径，Builder保留映射交给Coder实现关联查询，不当作主表SQL条件。共用页面的不同筛选使用不同inputKey，不能把姓名和编号都叫searchKeyword。缺少扫描字段不能补造FIELD，也不能删除真实筛选需求过关。
- `contains`只用于文本字段，且字段`type`必须是`VARCHAR`、`CHAR`或`TEXT`之一；`STRING`不被`contains`接受，用`STRING`类型字段做包含匹配会触发门禁。代码项、状态等精确筛选用`exact`。没有筛选义务不写`QUERY_FILTER`；不要因为字段是文本就默认生成搜索框。
- COMPOSE可选的审计标签可省略，也可在末尾加 `|atomic_save` 这类ASCII snake_case标签；留空或填 `-` 也有效。它不影响页面投影，不必另写设计理由或思维过程。
- LLM不填写relationKey、relationPath、实践编号、文件、类或方法；这些全部由Builder机械投影。

## Recovery And Stop

- 每次写提交携带当前卡的 `stepId`；相同 `stepId+payload` 可安全重试。只有已经接受的答案禁止用原stepId覆盖；失败提交可用同一stepId修正重交。
- `status=ready` 且 `submissionApplied=false` 表示本次请求未写入，工具已返回当前步骤；不是停工或用户确认，也不能当作答案已接受。按返回的 `currentCardRef/nextCall` 同轮继续，只在当前卡范围内提交答案；已完成步骤只有显式修订取得新卡后才能修改，不让用户处理步骤标识。
- `repair_required / repair_current_design_step` 表示当前输入可修复，不是停工或用户确认：一次修完当前卡的格式、枚举、引用及筛选冲突后，同轮重交。`page_design_confirmed`失败只修当前compositionRows，不重答已完成步骤。真正的blocked或STOP按返回的恢复/停止合同处理。
- 缺少值域、稳定身份等业务事实时，只接受Builder返回的 `return_to_requirement_step5 / storyId / missingFactKind / missingFactRef / allowedNextActions=req_prepare_context`。Design、Builder和Gate都不得生成业务问题、A/B/C选项、推荐答案或带业务内容的ambiguity card；具体提问和答案消化仍由Requirement LLM按Step 5单卡协议完成。
- `DESIGN_PUBLIC_INPUT_PROJECTION_DEFECT` 或Coder预检失败表示系统投影缺陷，停止修改业务答案。
- 12KB 是卡片和证据的分片目标，不是停工条件。Builder 自动拆分普通资料；单条超长资料或不可再拆的卡片通过文件引用完整保留，继续读取和提交，不删字段、不精简业务事实。宿主读取结果若被截断，使用该宿主支持的范围、偏移或分段读取方式读到末尾，再沿 `nextRef` 继续；未读齐不得当作完整候选或答案，也不要把容量当成权限错误重试。
- 丢失 `stepId`、上下文压缩或不确定当前卡时，重新无phase调用 `design_prepare_context`。
- 禁止LLM创建 `.active-demand`、嵌套 `.ai-workspace`、Design runtime、设计JSON或receipt。

`designFinalized=true` 且有效finalize receipt已落盘，表示Design正式产物已经完成；只要完成态仍返回后续动作卡，就还不能输出最终回复或进入Coder。严格按返回卡片串行处理：

1. Design finalize 后，插件 Builder 先根据最终设计合同生成或复用 MIS XML、Workflow XML 和 `workflow-artifacts-receipt.json`；LLM 不调用 Workflow Skill、不手写 XML。无工作流时自动跳过。
2. XML 完成后，若 `postDesignNextAction.required=true` 且 `skillName=design-to-sql`，本次不会同时返回 `documentationTaskCard`。Builder 已从最终设计JSON预生成 `dsl.json`；立即静默调用 `$design-to-sql` 使用该DSL生成SQL，不得询问用户、重新读取设计Markdown、复述表字段、手写DSL/SQL或先输出阶段总结。
3. **design-to-sql 成功后，必须立即无 `phase` 重调一次 `design_prepare_context`**。这次调用 Builder 会返回 `documentationTaskCard`（交付说明卡片）；不重调则永远拿不到交付说明卡片，交付说明.md 无法生成。**禁止在 design-to-sql 成功后直接输出"设计阶段已完成"或停止。**
4. `documentationTaskCard(documentStage=design)` 返回时，卡片必须是 `requiredInNormalFlow=true` 且 `blocksStageCompletion=false`。这表示正常流程必须先尝试生成设计稿，并非 `optional`；若生成失败，只报告卡片指定的warning后继续Coder，不回滚已经成功的Design finalize。
5. 工作流 XML、SQL、交付说明三步不得并行执行或自行换序；只有设计阶段 XML 已生成或确认不需要、当前完成态不再要求SQL生成，且设计稿已按卡片成功生成或已按失败合同报告warning，才进入Coder。

生成 `交付说明.md` 设计稿时：

- 先精确读取 `documentationTaskCardRef`，再只读取 `deliveryFactsRef`、卡片 `inputRefs` 和模板。若 `deliveryFactsRef` 含 `partRefs`，按 `section/index` 顺序读取卡片 `inputRefs` 中列出的全部事实分段；不得漏读或只看摘要。禁止直接读取设计JSON、SQL、需求Story、规则池或设计Markdown原文。
- `deliveryFacts.json` 是Builder生成的只读投影；如果上下文压缩后丢失卡片，只重新无phase调用 `design_prepare_context`，不得从对话摘要重建卡片或写业务草稿。
- 收到 `responseMode=silent_continuation` 时不输出阶段复述，直接执行返回的下一动作；卡片缺失、hash失效或读取失败只按卡片warning处理。
- 文档顶部必须写“文档状态：设计稿”。未施工的页面和接口只能写设计义务或“计划生成”；卡片提供实际SQL路径时必须写精确路径及“已生成、未执行”，工作流存在时必须写流程摘要、MIS/Workflow XML精确路径及“已生成、未导入”。
- 没有工作流或对外REST义务时完全省略对应内容；Design阶段不生成依赖实际Rest源码的接口详细说明。
- 不得主动跳过；实际生成失败只报告 warning，不改变 Design finalize 成功状态，也不得阻断后续Coder。
