# 后端代码必查清单（公司硬铁律）

每个后端批次按当前文件职责、框架版本和实际功能选择以下检查项，用文本断言或测试验证；不为满足模式匹配增加无需求的代码。
违反任意一条就修复当前代码并重跑受影响验证。

清单只列出公司规则正文中明确标注"铁律 / 高危警告 / 严禁"的项；
完整规则正文从 readCatalog 对应规则卡提供的来源读取；读取顺序以主 Skill 为准。

## ⚠️ 第零步：确认版本与真实接口（必看）

**先按 scan 产物 `框架版本档位.json` 的 `versionBucket` 确认适用规则，已确认的版本事实直接复用。** 下表是新骨架的默认模板，不是已有 API 的唯一合法名单。已有查询、分页和编辑回显以当前工程的真实声明、骨架及调用证据为准，不得为了套版本表改方法名、Map 泛型或调用合同。`SqlConditionUtil` import 使用当前统一包路径，不凭印象写。

| 维度 | `950 及以上` | `950 以下` |
|---|---|---|
| ListAction 装搜索条件 | `ListGenerator.getSearchMap(getRequestContext().getComponents(), sortField, sortOrder)` | `new SqlConditionUtil()` 手动 if+`sql.like/eq` 装 |
| `SqlConditionUtil` import | `com.epoint.core.utils.sql.SqlConditionUtil` | `com.epoint.core.utils.sql.SqlConditionUtil` |
| Service 计数方法名 | `count{ClassPrefix}{EntityName}(Map<String, Object>)`（`{ClassPrefix}` 来自 plan §1.1） | `getCount(Map<String, String>)` |
| Service 分页方法名 | `paginatorList(Map<String, Object>, int, int)` | `findListPageList(Map<String, String>, int, int)` |
| Service 列表方法名 | `findList(Map<String, Object>)` | `getAllRecord(Map<String, String>)` |
| Service 主键查询 | `find(Object primaryKey)` | `getBeanByGuid(String guid)` |
| Service 条件查询 | `find(Map<String, Object>)` | （无） |
| Edit/Detail Action 取详情 | `service.find(guid)` | `service.getBeanByGuid(guid)` |
| Service 内部 SQL 装配 | `SqlHelper().getSqlComplete(...)` 参数化 | `SQLManageUtil` `buildSql/buildPatchSql` 字符串拼接 |
| Map 泛型 | `Map<String, Object>` | `Map<String, String>` |
| 实体业务字段 | `super.get/super.set` | `super.get/super.set`（**严禁** `private String xxx;` + `this.xxx`） |

**照搬模板的常见错误**：
1. 看到已有 `ListGenerator.getSearchSql` 就推断 `getSearchMap` 也可用 → 两个方法需分别有签名证据
2. 未核对 Service 声明就改用 `paginatorList` 或 `findListPageList` → 查询条件、分页和计数合同可能不匹配
3. 把已有 `service.find(guid)` 改成模板中的 `getBeanByGuid(guid)` → 真实接口可能没有该方法，原有编辑回显被破坏
4. 写成旧包 `com.epoint.common.util.SqlConditionUtil` → 当前公司框架下找不到或运行时方法不匹配
5. 950 以下实体业务字段写成 `private String title; this.title = ...` → 框架 BaseEntity 拿不到值，存库为 null

**执行约束**：按工程扫描产物和当前需求资料确认 `versionBucket: "950及以上" / "950以下"`；新增代码按适用规则和真实签名实现，已有接口不因桶标签机械改写。例如已核对的 9.3.4 项目使用 `ListGenerator.getSearchSql` 和 `service.find(guid)`，应保留其实际合同，但不能由此推断其它同名工具方法可用。不要修改 `code-state.json`。

## Java import（全部后端 Java 通用）

- 当前包外且非 `java.lang` 的 Java/JAR 类型在文件顶部 `import`，方法体、方法签名和泛型只写简单类名；当前包和 `java.lang` 类型直接写简单类名，不添加多余 import。新增外部类型时先根据已确认规则或真实源码补正确 import，再写业务代码。
- 不得把全限定名当成编译修复或依赖探测手段。`com.epoint.core.utils.string.StringUtil.isBlank(value)` 应写成顶部 `import com.epoint.core.utils.string.StringUtil;`，正文调用 `StringUtil.isBlank(value)`。
- 只有真实同名类冲突，且无法用现有类名消除冲突时，才允许在最小位置使用全限定名；必须在批次进度中记录冲突的两个类，不能仅以“工程没有样例”为理由。
- 批次验证前对本批改动 Java 文件扫描 `package`、`import` 之外的 `java.`、`javax.`、`jakarta.`、`org.`、`com.` 类引用。命中真实代码就改为 import + 简单类名；注释和字符串中的包名只核对，不机械修改。

## 实体层 / Service 层（来自 `代码生成规范-后端实体层.md`）

| 编号 | 必查项 | 文件 | 必须含 | 必须不含 |
|---|---|---|---|---|
| B1 | ServiceImpl 必须 `@Component` | `*ServiceImpl.java` | `@Component\b` | — |
| B2 | ServiceImpl 严禁 `@Service` / `@Autowired ICommonDao` / `AutoType` | `*ServiceImpl.java` | — | `@Service\b` / `AutoType\|ServiceContainer` |
| B3 | Service 内部类**不带** `@Component` 也不带 `@Service` | `<ClassPrefix>*Service.java`（不带 Impl 后缀的那份，用 plan 派生值替换） | — | `@Component\b` / `@Service\b` |
| B4 | Service 内部类必须 `protected ICommonDao baseDao;` + `CommonDao.getInstance()` | 同上 | `protected\s+ICommonDao\s+baseDao` 和 `CommonDao\.getInstance\s*\(` | — |
| B5 | ServiceImpl 必须委托内部类，禁止直接调 baseDao 或自带 ICommonDao | `*ServiceImpl.java` | `new\s+<ClassPrefix>[A-Za-z0-9_]+Service\s*\(\s*\)\.`（用 plan 派生值替换） | `baseDao\.` / `ICommonDao\b` |
| B6 | ICommonDao 严禁臆造方法后缀 / 不存在的方法 | `<ClassPrefix>*Service.java`（用 plan 派生值替换） | — | `baseDao\.findEntity\(` / `baseDao\.insertEntity\(` / `baseDao\.updateEntity\(` / `baseDao\.deleteEntity\(` / `baseDao\.findCount\(` / `baseDao\.findInt\(` / `baseDao\.getCount\(` / `baseDao\.queryPage\(`（注意：1) `baseDao\.queryInt` / `queryIntWithDefault` / `queryBoolean` / `queryString` 是合法的；2) Service 自己定义的 `getCount(Map)` 方法名合法，但**不能**直接调 `baseDao.getCount()`，必须自己拼 SQL 走 `baseDao.queryInt`） |
| B6.0 | DAO / SQL 只能出现在 ServiceInternal，Action / Rest / Job / ServiceImpl 只调 Service | `*Action.java` / `*RestController.java` / `*Job.java` / `*ServiceImpl.java` | — | `CommonDao\b` / `ICommonDao\b` / `baseDao\.` / `commonDao\.` / `String\s+sql\b` |
| B6.2 | ICommonDao 方法必须有规则或源码证据，严禁按通用 DAO 记忆发明方法 | `<ClassPrefix>*Service.java`（用 plan 派生值替换） | 调用方法在 `ICommonDao使用规范.mdc` 或工作包列出的精确源码 methodSignatures 中存在 | `baseDao\.queryMapList\(` / `baseDao\.query\s*\(` / `baseDao\.count\s*\(` |
| B6.1 | 严禁在 `parameter.getValue()` 后画蛇添足加 `.toArray()` 或当 List 处理 | `<ClassPrefix>*Service.java`（用 plan 派生值替换） | — | `parameter\.getValue\(\)\.toArray\(` |
| B7 | Entity 必须 `extends BaseEntity` + `@Entity(table="...", id="rowguid")` | `*api/entity/<ClassPrefix>*.java`（用 plan 派生值替换） | `extends\s+BaseEntity\b` 和 `@Entity\s*\(\s*table\s*=` | — |
| B8 | **严禁自造 DTO 类**（公司用 `dataBean` = 实体直通模式，前端 `bind="dataBean.xxx"` 直接绑实体字段） | `*api/entity/` 下 | — | `class\s+\w+DTO\b` / `class\s+\w+Dto\b` / `class\s+\w+Request\b` / `class\s+\w+Response\b` |

## Action 层（来自 `代码生成规范-后端控制层.md`）

| 编号 | 必查项 | 文件 | 必须含 | 必须不含 |
|---|---|---|---|---|
| A1 | `@RestController("xxx")` value **全小写** | `*Action.java` | `@RestController\("[a-z0-9]+action"\)` | `@RestController\("[a-z0-9]*[A-Z]` |
| A2 | DataGridModel 必须用匿名内部类 | `*ListAction.java` | `new\s+DataGridModel\s*<[^>]*>\s*\(\s*\)\s*\{` | `new\s+DataGridModel\s*<[^>]*>\s*\(\s*\)\s*;` |
| A3 | 严禁 Spring MVC 注解（公司用 `@RestController("name")` 风格） | `*Action.java` | — | `@(?:Post\|Get\|Put\|Delete\|Request)Mapping\b` |
| A4 | Add/Edit/Detail Action 必须 `@RightRelation(*ListAction.class)` | `*AddAction.java` / `*EditAction.java` / `*DetailAction.java` | `@RightRelation\s*\(` | — |
| A5 | AddAction 必须 set 主键和操作人公共字段 | `*AddAction.java` 的 `add()` 方法 | `setRowguid\s*\(` 和 `setOperatedate\s*\(` 和 `setOperateusername\s*\(` | — |
| A6 | Action 必须 `extends BaseController` | `*Action.java` | `extends\s+BaseController\b` | — |
| A7 | 严禁 `model.getConditionMap()` 旧 API | `*ListAction.java` | — | `model\.getConditionMap\s*\(` |
| A8 | 严禁 `@Autowired ICommonDao` 在 Action 中 | `*Action.java` | — | `ICommonDao\b` |
| A9 | `addCallbackParam` 键名必须**全小写** | `*Action.java` | — | `addCallbackParam\("[A-Z]` |
| A10 | 业务返回必须 `addCallbackParam("msg", ...)` | `*AddAction.java` / `*EditAction.java` / 删除方法 | `addCallbackParam\("msg",` | — |
| A11 | Action **严禁** `UserSession.getInstance()`，必须直接用 BaseController 继承的 `userSession` 字段（来源：`UserSession使用规范.mdc` §1.1 选择建议） | `*Action.java` | `userSession\.get\w+\(` | `UserSession\.getInstance\s*\(` |
| A12 | ListAction 搜索条件按适用规则和真实接口实现（来源：`代码生成规范-后端控制层.md`）：新骨架默认 950+ 用 `ListGenerator.getSearchMap(...)`，950- 用 `SqlConditionUtil`；已有且已核实的 `ListGenerator.getSearchSql(...)` 等查询沿用，不为套模板机械改写 | `*ListAction.java` | 搜索字段、参数、排序、分页和计数与实际 Service 合同闭合；所用方法有真实签名证据 | `model\.getConditionMap\s*\(`；仅凭版本桶或其它同类方法推断未核实 API 可用 |
| A13 | `CodeModalFactory.factory("下拉列表", "中文名", null, X)` 第四参数：**列表搜索**场景必须 `true`（追加"请选择"空项），**表单录入**（Add/Edit）场景必须 `false`（不允许悬空）。grep 难直接断言，须在 `demand-implementation-tasks.md` 对应任务说明每个 factory 调用的场景 + 第四参数值 | `*ListAction.java` / `*AddAction.java` / `*EditAction.java` | — | — |
| A14 | Service 方法名以已有真实声明为准，新骨架默认按版本选模板（来源：`代码生成规范-后端实体层.md` 950+/950-） | `I<ClassPrefix>*Service.java` / `<ClassPrefix>*Service.java` / `<ClassPrefix>*ServiceImpl.java` / Edit/Detail Action 调用处（用 plan 派生值替换） | 基础方法来自骨架和真实项目规则；**新增业务方法**可由 Story/AC 的必要行为命名，必须同步闭合 ServiceApi、ServiceInternal、ServiceImpl 和调用方，并在 `demand-implementation-tasks.md` 记录行为依据 | 无证据调用或为套版本表改写**已有** API；不得把“项目里还没有这个业务方法”误判为不能实现 |
| A15 | Edit/Detail Action 取详情：新骨架默认 950+ 用 `service.find(guid)`，950- 用 `service.getBeanByGuid(guid)`；已有且已核实的 `find(guid)` 等接口沿用 | `*EditAction.java` / `*DetailAction.java` 的 `pageLoad()` | 参数、返回类型及 `dataBean` 回显绑定与实际接口闭合 | 未核对真实声明就按桶更名或替换已有详情接口 |

## 骨架二次破坏防护（D1-D4）

保留骨架核心注解与既有签名；新增业务方法不属于破坏骨架。确需变更既有合同先核对需求、规则与调用方，不凭个人偏好删除。

| 编号 | 必查项 | 文件 | 必须含（删除即违规） |
|---|---|---|---|
| D1 | `@RestController("xxx")` 严禁删除 | `*Action.java` | 物化时已有 → 必须保留 |
| D2 | `@RightRelation(*ListAction.class)` 严禁删除 | `*AddAction.java` / `*EditAction.java` / `*DetailAction.java` | 物化时已有 → 必须保留 |
| D3 | `@Component` 严禁删除 | `*ServiceImpl.java` | 物化时已有 → 必须保留 |
| D4 | `@Entity(table=..., id="rowguid")` 严禁删除 | `*api/entity/<ClassPrefix>*.java`（用 plan 派生值替换） | 物化时已有 → 必须保留 |

验证本批 diff 是否意外删除骨架核心注解，不另设 Refactor 阶段。

## 公共字段（实体层）

公共字段以当前版本规则和骨架为准；以下列举常用字段，不按固定数量补字段。工作流场景按合同检查 `pviguid`。

```text
operatedate / operateusername / operateuserguid / operateuserouguid
operateuserbaseouguid / yearflag / belongxiaqucode
+ pviguid（仅工作流场景）
```

grep 断言每个字段：

```text
get<Capitalized>\s*\(  # 例：getOperatedate (
set<Capitalized>\s*\(  # 例：setOperatedate (
```

## 包路径与命名（来自 `项目结构与命名规范.mdc`）

| 编号 | 必查项 | 必须含 | 必须不含 |
|---|---|---|---|
| N1 | 后端包必须 `com.epoint.{packageDomain}.` 开头（`{packageDomain}` 来自 plan §1.1 scan 派生） | `^package\s+com\.epoint\.<packageDomain>\.`（用 plan 派生值替换） | `^package\s+com\.epoint\.(?!<packageDomain>\.)`（其它域全错） |
| N2 | 个性化类名必须 `{ClassPrefix}` 前缀（`{ClassPrefix}` 来自 plan §1.1 scan 派生） | `class\s+<ClassPrefix>[A-Z]` 或 `interface\s+I<ClassPrefix>[A-Z]`（用 plan 派生值替换） | 不带 ClassPrefix 的个性化 class/interface 即违规 |
| N3 | 表名必须使用 `{tablePrefix}` 前缀（`{tablePrefix}` 来自 plan §1.1 scan 派生） | `CREATE\s+TABLE\s+<tablePrefix>`（用 plan 派生值替换） | `CREATE\s+TABLE\s+(?!<tablePrefix>)`（其它前缀全错） |
| N4 | Action 注解派生公式 | 以 targetIndex 对应骨架注解与页面 initPage 闭合为准 | — |
| N5 | 公司框架包路径 `com.epoint.database.peisistence.crud.impl.model.PageData` 是**错拼但合法**，**严禁**自动"纠正"为 `persistence`（LLM 常踩坑） | `import\s+com\.epoint\.database\.peisistence\.` | `import\s+com\.epoint\.database\.persistence\.` |
| N6 | `SqlConditionUtil` import 统一使用当前公司框架包：`com.epoint.core.utils.sql.SqlConditionUtil` | `import\s+com\.epoint\.core\.utils\.sql\.SqlConditionUtil` | `import\s+com\.epoint\.common\.util\.SqlConditionUtil` |
| N7 | 950 以下实体业务字段**严禁**写成 `private String xxx;` + `this.xxx`，必须 `super.get/super.set` 访问 BaseEntity 动态字段（来源：`代码生成规范-后端实体层.md` 950 以下 "950 以下实体 Jar 包路径基准" 小节） | 仅 950- 桶的 `*api/entity/<ClassPrefix>*.java`（用 plan 派生值替换） | `super\.get\s*\(\s*"` 和 `super\.set\s*\(\s*"` | `private\s+(?:String\|Date\|Integer\|Long\|Double\|Boolean)\s+\w+\s*;` 在业务字段段（公共字段除外） |

> **N5 处理**：grep 命中 `com\.epoint\.database\.persistence\.` → 立即改回 `peisistence`。这是公司框架真实包路径，不是错别字（已查 `projectrules/核心开发与架构规范/950及以上/代码生成规范-后端实体层.md`、`代码生成规范-后端控制层.md` 多处一致使用）。

## REST 接口（来自 `REST接口开发规范.mdc`）— 命中 `*RestController.java` 时必查

只有当 design 文档明确要求"对外 REST 接口 / 外部系统调用"且文件落点是 `com.epoint.{packageDomain}.{业务域}.rest` 包时才触发（`{packageDomain}` 来自 plan §1.1）。普通管理端 Action 不走本节。

| 编号 | 必查项 | 文件 | 必须含 | 必须不含 |
|---|---|---|---|---|
| R1 | 类名必须 `{ClassPrefix}{功能名}RestController` | `*RestController.java` | `class\s+<ClassPrefix>[A-Z]\w*RestController\b`（用 plan 派生值替换） | — |
| R2 | 包路径必须落 `com.epoint.{packageDomain}.{业务域}.rest` | 同上 | `^package\s+com\.epoint\.<packageDomain>\.[a-z][\w\.]*\.rest\s*;`（用 plan 派生值替换） | — |
| R3 | 类必须 `@RestController` + `@RequestMapping`，basePath 由设计/scan 契约给出 | 同上 | `@RestController\b` 和 `@RequestMapping\s*\(` | 不得凭空改写 basePath 或补 `govsite/` 前缀 |
| R4 | 接口方法必须 `method = RequestMethod.POST`，**严禁** GET | 同上 | `RequestMethod\.POST\b` | `RequestMethod\.GET\b` |
| R5 | 接口方法入参必须从 `@RequestBody String params` 解析；`HttpServletRequest` 只在业务需要 IP/用户上下文/附件时保留 | 同上 | `@RequestBody\s+String\s+params` | 认证和业务字段绕开 JSON 入参合同 |
| R6 | 返回必须 `JsonUtils.zwdtRestReturn("0/1", msg, data)`，**严禁**自拼 JSON 或 ResponseEntity | 同上 | `JsonUtils\.zwdtRestReturn\s*\(` | `ResponseEntity\b` / `return\s+"\{` |
| R7 | **严禁**继承 `BaseAction` / `BaseController`（REST 是独立风格，不复用管理端基类） | 同上 | — | `extends\s+BaseAction\b` / `extends\s+BaseController\b` |
| R8 | 请求体固定根 JSON：`token` 在根对象，业务参数在 `params` 子对象 | 同上 | `jsonObject.getString("token")` 和 `jsonObject.get("params")` / `getJSONObject("params")` | 认证和业务字段绕开 `jsonObject` / `paramsObj` 固定取值槽 |
| R9 | token 校验沿用项目已有轻量样式；工作包无可确认样例时 blocker | 同上 | `ZwdtConstant.SysValidateData.equals(token)` / `JsonUtils.checkUserAuth(...)` / 工作包列出的项目同类校验方法 | 硬编码 `"valid_token_for_thirdparty"` / 新增 TokenService、CredentialManager、OAuth 模型 / `request.getHeader("Authorization"|"X-Token")` |

## 管理端 Action / Service 可运行闭合（C1-C8）

本节适用于普通管理端 `*Action.java`、`*Service*.java`。目标是挡住“文件写了但公司框架跑不起来”的情况。

| 编号 | 必查项 | 文件 | 必须含 | 必须不含 |
|---|---|---|---|---|
| C1 | Action bean name 必须与前端 `epoint.initPage('xxxaction')` 闭合 | `*Action.java` + 对应 HtmlPage | `@RestController\s*\(\s*"[a-z0-9_]+action"\s*\)`；value 应等于前端 initPage 参数 | Action value 与 HtmlPage initPage 参数不一致 |
| C2 | Action 只做入口、参数、Service 调用、回调 | `*Action.java` | `addCallbackParam\s*\(`（保存/状态/删除类动作） | 复杂 SQL 拼接、直接 `CommonDao.getInstance()` 持久化 |
| C3 | 持久化和业务约束落 ServiceInternal | `*Service*.java` | 查询/保存/删除/状态流转、权限、跨字段/跨记录业务约束在 Service 层可追溯 | Action 内直接做唯一性、引用校验、状态流转；把页面已有的 `required/maxLength/vtype` 再翻译成 Service 普通字段校验 |
| C4 | 删除/批量删除有引用或状态保护 | 涉及 delete/remove 的 Service | 删除前存在引用校验、状态校验或明确业务拒绝逻辑 | 无校验直接删除可被引用业务对象 |
| C5 | 状态操作有流转保护 | 涉及 enable/disable/publish/revoke/status 的 Service | 判断当前状态是否允许目标状态 | 直接覆盖状态字段 |
| C6 | 唯一性场景有重复校验 | 新增/编辑/导入涉及名称/编号类字段 | 保存前有同名/同编号查询或明确规则证据说明无需校验 | 无校验保存明显唯一字段 |
| C7 | ServiceImpl 只委托内部 Service | `*ServiceImpl.java` | 调用内部 Service 方法 | 大段 SQL / DAO / 页面回调 |
| C8 | 禁止框架漂移 | 所有后端文件 | Epoint 框架注解和 DAO 用法 | `@Service\b` 滥用、Lombok、Mapper/MyBatis-Plus、JPA Repository、Spring Boot `@GetMapping/@PostMapping` 管理端动作 |

历史功能调整时，C1-C5 必须结合 `existingAdjustment.preserveBehaviors[]` 检查：新增按钮、字段、校验、查询条件或状态动作后，原列表查询、保存、回显、分页和原状态操作仍应可追溯。

## 定时任务 Job（来自 `定时任务Job开发规范.mdc`）— 命中 `*Job.java` 时必查

| 编号 | 必查项 | 文件 | 必须含 | 必须不含 |
|---|---|---|---|---|
| J1 | 类名 `{ClassPrefix}{OperationName}Job`，落点 `com.epoint.{packageDomain}.{业务域}.{模块}.job` | `*Job.java` | `class\s+<ClassPrefix>[A-Z]\w*Job\b` 和 `^package\s+com\.epoint\.<packageDomain>\.[\w\.]+\.job\s*;`（用 plan 派生值替换） | — |
| J2 | Job 类必须 `implements Job`（Quartz 接口） | 同上 | `implements\s+Job\b` | — |
| J3 | 依赖注入**只能**用 `ContainerFactory.getContainInfo().getComponent(I*Service.class)`，**严禁** `@Autowired` / `@Resource`（Quartz Job 不在 Spring 容器里，注入会拿到 null） | 同上 | `ContainerFactory\.getContainInfo\(\)\.getComponent\s*\(` | `@Autowired\b` / `@Resource\b` |
| J4 | 日志必须 `LogUtil.getSLF4JLog(类名.class)`，严禁手 new `LoggerFactory.getLogger` | 同上 | `LogUtil\.getSLF4JLog\s*\(` | — |
| J5 | `execute(JobExecutionContext)` 必须 try/catch + 异常抛 `JobExecutionException` | 同上 | `throw\s+new\s+JobExecutionException\(` | — |
| J6 | Job 只做调度入口，统计/查询/写库必须下沉 Service；Job 严禁 DAO / SQL | 同上 | `service\.[A-Za-z]\w*\s*\(` | `CommonDao\b` / `ICommonDao\b` / `baseDao\.` / `commonDao\.` / `String\s+sql\b` / `queryMapList\s*\(` |

### DAO / SQL 分层短例子（Job + 统计查询）

正确做法是“Job 调 Service，Service 查库/统计/入库”：

```java
// Job：只调度，不写 SQL
public void execute(JobExecutionContext context) throws JobExecutionException {
    log.info("【接口调用统计定时任务】开始执行...");
    try {
        service.statDailyApiCall();
    } catch (Exception e) {
        log.error("【接口调用统计定时任务】执行异常", e);
        throw new JobExecutionException(e);
    }
}
```

```java
// ServiceInternal：允许持有 DAO，DAO 方法必须来自 ICommonDao 规范或工作包列出的精确源码
public class GxhApiCallStatService {
    protected ICommonDao baseDao;

    public GxhApiCallStatService() {
        baseDao = CommonDao.getInstance();
    }

    public List<GxhApiCallStat> findDailyStats(String day) {
        String sql = "select api_name, count(1) call_count from xm_apilog_call_record where call_day = ? group by api_name";
        return baseDao.findList(sql, GxhApiCallStat.class, day);
    }
}
```

错误做法：在 `*Job.java` / `*Action.java` / `*RestController.java` 里出现 `CommonDao`、`ICommonDao`、`String sql`、`baseDao.queryMapList(...)`。

## 执行约束

每个连续实现批次完成后：

1. 用 PowerShell `Select-String` 或 `grep -E` 核对上述模式
2. 任一项不通过，直接修复当前代码并重跑受影响验证；在实施进度记录真实问题和结果
3. 不允许"看着像就过"，必须有 grep/测试/编译等真实验证证据

不通过的项常见处理：

- B1/B2/B3 错误：通常是 LLM 把 `@Service` 当成等效注解 → 改回 `@Component` 即可
- B8 错误：LLM 看到测试入参多想造 DTO → 公司**不用 DTO**，多入参就是用 `dataBean`（实体直通）+ URL 参数 + `userSession`，前端 `bind="dataBean.xxx"` 直接绑实体字段。删掉 DTO 类，改用现成范式。
- A1 错误：通常是 LLM 把驼峰原样写进 RestController value → 全小写后重生成
- A2 错误：触发了"严禁直接 `new DataGridModel<>()`"红线 → 改成匿名内部类
- A5 错误：AddAction 漏 set 公共字段 → 直接补
- A9 错误：`addCallbackParam` 键名大写 → 全部改小写

## 与设计文档的对账

适用项的实际验证命令、结果及缺口统一写入主 Skill 定义的进度记录，不新增完成标记。grep 确认结构及规范，编译确认类型与调用；业务行为、保存及回滚仍需对应验证。
