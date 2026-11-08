# Feature Bridges（按需补码契约）

公司规则在控制层 / 实体层定义了若干"按需触发"的能力插槽。
当 `business-facts.json.rulePool.confirmedRules[]` 或当前卡片 `apiUsageCard.ruleRefs[]` 命中下表的规则时，**当前连续实现批次的代码必须额外满足对应 must_have_groups**。

本文件只列触发条件 + 必查项；完整规则正文按 readCatalog 的当前规则卡查阅；只检查本次实际实现的能力，不因规则菜单命中而新增业务功能。

## 1. 代码项 / 下拉枚举（code_item）

**触发条件**：`confirmedRules` / `ruleRefs` 命中以下任一规则别名：

- `ICodeItemsService接口使用规范`
- 设计 JSON 的 `databaseDesign.tables[].columns[]` 中 `comment` 含"代码项 / 字典 / 下拉枚举"语义

**后端必查项（`*Action.java`）**：

| 编号 | 必须含 |
|---|---|
| CI-B1 | `\bCodeModalFactory\b` |
| CI-B2 | `DataUtil\.convertMap2ComboBox` |
| CI-B3 | `\bSelectItem\b` |
| CI-B4 | 至少一个 `public\s+List<SelectItem>\s+get([A-Z]\w+Model)\s*\(` 方法 |
| CI-B5 | 字典名必须**中文代码项名称**（如"场所分类"），严禁英文/拼音 — grep 正则：`CodeModalFactory\.factory\([^,]+,\s*"[\u4e00-\u9fa5]+"` 必须匹配；若命中 `CodeModalFactory\.factory\([^,]+,\s*"[a-zA-Z_]+"` 则违规 |

参考代码模板（来自 `代码生成规范-后端控制层.md` ListAction 模板）：

```java
private List<SelectItem> xxxModel;
public List<SelectItem> getXxxModel() {
    if (xxxModel == null) xxxModel = DataUtil.convertMap2ComboBox(
        (List<Map<String, String>>) CodeModalFactory.factory("下拉列表", "中文代码项名称", null, true));
    return xxxModel;
}
```

**前端必查项（`*.html`）**：

| 编号 | 必须含 |
|---|---|
| CI-F1 | `<input class="mini-combobox"\s+[^>]*action="([a-zA-Z]+Model)"` |
| CI-F2 | 列表搜索条件下拉用 `emptyText="请选择..."` 且后端 `factory()` 最后参数传 `true` |
| CI-F3 | 表单录入下拉无 `emptyText` 或后端 `factory()` 最后参数传 `false`（不允许悬空） |
| CI-F4 | 列表展示用 `data-options="{code:'中文代码项名称'}"` 自动翻译 |

**调用核对**：页面 `action="getXxxModel"` 按完整方法名找到当前或指定 Action 的 public 方法（含已核实的继承方法），再核对控件要求的返回类型；不去掉 `get`，不要求前后端方法集合完全相等。具体文本预检及其限制见 `frontend-rules.md` 的“页面控件 action 与后台方法核对”。

## 2. 导入 / 导出（import_export）

**触发条件**：

- `confirmedRules` / `ruleRefs` 含与导出相关的规则
- 设计 JSON 中 module 描述含"导出 / 导入 / Excel"语义
- design-tdd-plan 的 happyPath 含"列表导出"

**后端必查项（`*ListAction.java`）**：

| 编号 | 必须含 |
|---|---|
| IE-B1 | `\bExportModel\b` 字段声明 |
| IE-B2 | `public\s+ExportModel\s+getExportModel\s*\(` 方法 |
| IE-B3 | ExportModel 构造参数：第一个是字段名（逗号分隔），第二个是中文列名（逗号分隔），**两边数量必须一致** |
| IE-B4 | 字段数量一致性自检：在 `demand-implementation-tasks.md` 的任务记录中明确写出 `导出字段数=N，中文列名数=N`，N 不一致即视为违规 |

参考代码模板：

```java
public ExportModel getExportModel() {
    if (exportModel == null) {
        exportModel = new ExportModel(
                "rowguid,operatedate,operateusername",  // 字段名
                "主键,操作时间,操作人");                // 中文列名（数量必须一致）
    }
    return exportModel;
}
```

**前端必查项（`*list.html`）**：

| 编号 | 必须含 |
|---|---|
| IE-F1 | `<a class="mini-dataexport"` |
| IE-F2 | 必须有 `gridId="datagrid"` 属性绑定 |
| IE-F3 | 必须有 `action="getExportModel"` 属性 |
| IE-F4 | 必须有 `extraId="fui-form"` 让搜索条件参与导出范围 |
| IE-F5 | 必须有 `fileName="..."` 中文文件名 |

参考模板：

```html
<a class="mini-dataexport" id="dataexport" gridId="datagrid"
   fileName="导出列表" action="getExportModel" extraId="fui-form"></a>
```

## 3. 附件上传 / 下载（file_attach）

**触发条件**：

- `confirmedRules` / `ruleRefs` 命中 `IAttachService接口使用规范` 或 `附件上传开发规范`
- 设计 JSON module 描述含"附件 / 上传 / 下载 / 预览"语义
- 实体表设计含 `attachguid` / `fileguid` 类字段

**后端必查项**：

| 编号 | 必须含 |
|---|---|
| FA-B1 | 调 `IAttachService` 时通过 `@Autowired` 注入（Action 中可直接注入） |
| FA-B2 | 删除附件必须二次确认后调 `IAttachService` 删除方法 |
| FA-B3 | 文件操作不得用原生 `java.io.File` 写本地路径绕过 `IAttachService` |

**前端必查项**：

| 编号 | 必须含 |
|---|---|
| FA-F1 | 上传组件用 `mini-fileupload` 或公司组件，禁止自己写 form upload |
| FA-F2 | 删除附件前必须 `epoint.confirm` 二次确认 |
| FA-F3 | 涉及附件的页面必须读 `附件上传开发规范.mdc` 取具体上传/预览/下载范式 |

具体 API 方法名以 `IAttachService接口使用规范.mdc` 正文为准；本文件不复制方法签名。

## 4. 工作流（workflow）

**触发条件**：

- `confirmedRules` / `ruleRefs` 命中 `Epoint工作流GUID生成规范` 或 `Epoint工作流XML定义规范`
- 设计 JSON 模块描述含"流程 / 审批 / 转办 / 退回 / 工作流"语义
- 实体表设计含 `pviguid` 字段

**后端必查项**：

| 编号 | 必须含 |
|---|---|
| WF-B1 | 实体类必须含 `pviguid` 字段的 get/set |
| WF-B2 | 工作流 Action 按骨架/公司规则接收流程上下文；`Util.getUrlParams` 是前端 JavaScript，不写进 Java |
| WF-B3 | 核对设计实体和既有 DDL 的流程字段；Coder 不修改上游 DDL，不写死数据库方言 |
| WF-B4 | 严禁手写 GUID 生成（必须用 `Epoint工作流GUID生成规范` 规定的 API） |

**前端必查项**：

| 编号 | 必须含 |
|---|---|
| WF-F1 | 流程页面必须读 `Util.getUrlParams('taskGuid')` 复用变量，不得手拼 `?taskGuid=` |
| WF-F2 | 操作按钮（提交/退回/转办）必须按工作流规则正文实现，不得自己拼 service 调用 |

## 5. 统计分析（statistics）

**触发条件**：

- 设计 JSON 或 business-facts.json 含 `statisticsContract`
- 骨架含统计页（ServiceInternal 有 `AI_TODO[StatisticsServiceQuery]` 标记）
- `confirmedRules` / `ruleRefs` 命中统计相关规则

**实现指引**：触碰统计时读 [statistics-implementation.md](statistics-implementation.md)，按 `statisticsContract` 的 filters/dimensions/metrics/dataSources 映射到页面控件、datagrid 列、SQL WHERE/GROUP BY/聚合。

**后端必查项**：

| 编号 | 必须含 |
|---|---|
| ST-B1 | 统计 SQL 参数化查询，禁止拼接用户输入 |
| ST-B2 | list 和 count 使用同一筛选口径；count 用子查询或 COUNT(DISTINCT)，不数明细行 |
| ST-B3 | 只在 ServiceInternal 写 DAO 查询；Action 不接触 DAO |
| ST-B4 | 返回 `Record`，不返回 `HashMap` 或自造 DTO |

**前端必查项**：

| 编号 | 必须含 |
|---|---|
| ST-F1 | datagrid 列来自 dimensions + metrics |
| ST-F2 | ECharts 必须本地静态资源，禁止 CDN |

## 6. REST 接口（rest_interface）

**触发条件**：

- `confirmedRules` / `ruleRefs` 命中 `REST接口开发规范`
- 设计 JSON 模块描述含"对外接口 / 外部系统调用 / REST 暴露"语义
- 落点是 `com.epoint.{packageDomain}.{业务域}.rest` 包（`{packageDomain}` 来自 plan §1.1；与管理端 Action 落 `action` 包对立）

适用规范见 `backend-rules-checklist.md` "REST 接口"（R1-R7）；检查及业务验证按主 Skill 执行，结果归现有任务进度，不新增计划或完成标记。

## 7. 定时任务（scheduled_job）

**触发条件**：

- `confirmedRules` / `ruleRefs` 命中 `定时任务Job开发规范`
- 设计 JSON 含"定时 / 周期执行 / 每日 / 每小时 / cron / quartz"语义
- 类名后缀 `Job`，落点 `com.epoint.{packageDomain}.{业务域}.{模块}.job`（`{packageDomain}` 来自 plan §1.1）

触发后必查项已在 `backend-rules-checklist.md` "定时任务 Job" 小节定义（J1-J6）。**最大坑点**：Job 不在 Spring 容器，必须 `ContainerFactory.getContainInfo().getComponent()` 注入；LLM 凭 Spring 习惯写 `@Autowired` 必拿 null。第二坑点：Job 只做调度入口，统计、查询、写库必须下沉 Service；Job 内禁止 `CommonDao` / `ICommonDao` / `baseDao` / `String sql`。

Job 业务逻辑测试复用当前工程真实测试工具和注入方式；分别验证入口委托、Service 处理结果及调度注册，不凭示例假定支持静态 mock。

## 框架服务获取方式（通用）

调用公司框架服务时，先按主 Skill 的查证顺序读取当前版本的规则正文和真实源码，确认实例获取方式。下表用于定位对应规范，不能代替实际接口查证。

| fileKind | 默认获取方式 | 示例 |
|---|---|---|
| Action / Rest / ServiceImpl | `@Autowired` 注入 | `@Autowired private IMessagesCenterService messagesCenterService;` |
| ServiceInternal（非 Spring bean） | 由同包 `ServiceImpl` 持有并转发；或 `ContainerFactory.getContainInfo().getComponent(IMessagesCenterService.class)` | 不写 `@Autowired`，通过 ServiceImpl 转发调用 |
| Job（不在 Spring 容器） | `ContainerFactory.getContainInfo().getComponent()`；禁止 `@Autowired`（必拿 null） | `IMessagesCenterService svc = ContainerFactory.getContainInfo().getComponent(IMessagesCenterService.class);` |

具体获取方式以当前版本规范和真实已有代码为准，不得盲搜 `ServiceFactory` / `BeanFactory` / `ApplicationContext` 等关键词。

## 参考职责

本页按当前 Story、规则卡和实际修改选择适用能力，提供规范检查项，不重新拆模块或修改上游设计。执行时机和记录格式统一按主 Skill；检查证据及未解决项归现有任务进度，不新增列或完成标记。grep 只证明静态结构，不能替代对应业务结果验证。

### 与 backend / frontend checklist 的关系

| 维度 | backend-rules-checklist | frontend-rules | feature-bridges |
|---|---|---|---|
| 触发 | 所有后端 module | 涉及前端文件的 module | 命中需求规则池 / ruleRefs 的特定能力 |
| 性质 | 通用硬铁律 | 通用硬铁律 | 按需补码 |
| 优先级 | 必跑 | 必跑（涉及前端时） | 必跑（命中时） |

三者**互不重复**：

- 公司"严禁 / 必须含"的通用项 → checklist
- 公司"按需触发的能力"→ bridges
