# 公司级最佳实践分发图

用于把用户自然语言需求从“能力域 + 公司常用机制”继续落到“最佳实践场景”和“代码细责”。先读 `references/company-capability-map.md` 判断能力域，再读 `references/company-common-mechanisms.md` 判断代码项、系统参数、业务配置、外部凭证、配置文件、前置库、事务等 CM 机制，最后读本文件匹配 GP 最佳实践；涉及页面小改造时继续读 `references/frontend/legacy-miniui-best-practices.md`。

核心链路：

```text
需求描述 -> 能力域 -> CM 公司常用机制 -> GP 最佳实践场景 -> BP 页面动作 -> HTML/JS/Action/Service/Entity/配置细责 -> 红线检查
```

内部拆解时使用这个格式：

```text
需求信号：发布按钮、停用不能发布、列表按状态筛选
能力域：状态流转 + 查询分页 + 既有功能改造
公司机制：CM-01 代码项 + CM-05 事务/状态一致性 + CM-11 日志审计按需
最佳实践：GP-04 状态流转 + BP-02 列表新增查询条件 + BP-03 列表工具栏按钮
细责：
- HTML：新增状态查询控件和发布 mini-button
- JS：epoint.refresh 查询；getSelecteds + confirm + execute('publish')
- Action：getStatusModel/getDataGridData/publish
- 后端 Java：当前承载查询的 Action/Rest/Job/Service 按项目样例用 SqlConditionUtil 构造条件；停用状态校验优先放 Service
红线：action/execute 全闭合，状态规则不能只写前端
```

## 场景索引

| 编号 | 需求信号 | 最佳实践 |
| --- | --- | --- |
| GP-01 | 管理、维护、新增编辑删除详情 | 基础 CRUD 全链路 |
| GP-02 | 按名称/状态/日期/区域查询、高级查询 | 查询分页 |
| GP-03 | 删除、批量删除、被引用不能删 | 删除和引用校验 |
| GP-04 | 启停、发布、撤回、作废、排序 | 状态流转 |
| GP-05 | 主表+明细、配置项+子项、批量保存明细 | 主从表和事务明细 |
| GP-06 | 类型、状态、区域、代码项、字典下拉 | 字典和代码项 |
| GP-07 | 选择人员/部门/事项/材料，弹窗回填 | 弹窗选择 |
| GP-08 | 附件上传、预览、只读查看、材料附件 | 附件和材料 |
| GP-09 | 列表导出、Excel 导入、模板下载 | 导入导出 |
| GP-10 | 菜单、模块入口、按钮权限 | 菜单权限 |
| GP-11 | 定时同步、补偿任务、Quartz、手动补偿 | 定时任务 |
| GP-12 | MQ、RabbitMQ、队列监听、消息补偿 | MQ 消息 |
| GP-13 | 外部接口、第三方接口、平台接口、HTTP/API、REST 同步、回调 | 外部接口调用 |
| GP-14 | SSO、登录、免登录、白名单、安全放行 | SSO/安全 |
| GP-15 | resources 配置、cron、队列、菜单、安全配置 | 配置文件写入边界 |
| GP-16 | 业务规则、模板、映射、推送系统、接入方维护 | 业务配置表维护 |
| GP-17 | token、clientId/clientSecret、appKey、证书、签名 | 外部凭证和认证 |

## GP-01 基础 CRUD 全链路

命中信号：新增一个维护功能、配置管理、列表新增编辑删除详情。

细责：

- Entity：按表设计生成 `@Entity(table = "...", id = "rowguid")`，继承 `BaseEntity`。
- ServiceApi：声明分页查询、保存、删除、详情、状态/字典扩展方法。
- ServiceInternal：处理 SQL、同名/同编号唯一性、引用校验、状态/权限等业务约束、事务、用户信息；不重复页面已有的必填、长度、格式校验。
- ServiceImpl：对外实现接口，委托内部 Service。
- Action：List/Add/Edit/Detail Action 分开，`@RestController("xxxaction")` 与页面闭合。
- HTML/JS：列表、表单、详情按 MiniUI/FUI；页面最佳实践读 `frontend/legacy-miniui-best-practices.md` 的 BP-02/03/05/06。
- 红线：不生成 Lombok/JPA/MyBatis-Plus/普通 Spring Boot Controller。

必须读取：

- `references/backend/crud-recipes.md`
- `references/backend/crud-examples.md`
- `references/frontend/page-guidelines.md`
- `references/frontend/crud-pages.md`
- `references/frontend/common-js.md`

## GP-02 查询分页

命中信号：按名称、状态、区域、日期范围、关键字、高级搜索。

细责：

- HTML：查询区用 `fui-condition` + `fui-form` + MiniUI 控件。
- JS：`searchData` 调 `epoint.refresh(['datagrid','fui-form'], '', true)`。
- Action：`getDataGridData()` 获取查询条件并返回 `DataGridModel` 或项目分页模型。
- 后端 Java：查询承载在 Action/Rest/Job/ServiceInternal 哪一层，就在该层按项目样例使用 `SqlConditionUtil`/`Parameter` 拼条件；日期范围处理开始/结束边界，复杂查询和状态、权限、跨字段/跨记录业务约束下沉 Service；普通表单必填、长度、格式留在页面。
- 红线：不拼接未参数化 SQL；不通过 `fetch` 自己请求列表。

页面小片段读取：`frontend/legacy-miniui-best-practices.md` 的 BP-02。

## GP-03 删除和引用校验

命中信号：删除、批量删除、被引用不能删除、逻辑删除。

细责：

- HTML/JS：批量删除用 `mini.get('datagrid').getSelecteds()` + `epoint.confirm` + `epoint.execute('deleteSelect','datagrid')`。
- Action：补 `public void deleteSelect()` 或项目既有删除方法。
- Service：删除前查引用表、状态限制和权限范围；按项目策略物理删除或逻辑删除。
- 返回：用 `addCallbackParam("msg", "...")` 返回明确失败原因。
- 红线：删除校验不能只写前端；没有删除方式时默认不硬删被引用数据。

页面小片段读取：BP-03。

## GP-04 状态流转

命中信号：启用、停用、发布、撤回、上架、下架、作废、排序。

细责：

- HTML：工具栏或操作列用 `mini-button`/`epoint.renderCell`。
- JS：选中记录、确认、调用 `epoint.execute('publish/enable/disable/updateStatus')`。
- Action：补对应 public 方法，传目标状态或动作。
- Service：校验非法流转、引用状态、重复操作；写修改人和修改时间。
- 红线：状态规则必须在 Service 兜底，不能只靠按钮显隐。

页面小片段读取：BP-03、BP-04、BP-09。

## GP-05 主从表和事务明细

命中信号：主配置+明细、表单+明细列表、批量保存子项、行编辑。

细责：

- Entity：主表和明细表分开；明细带主表 guid 和排序字段。
- HTML：主表用 `fui-form`，明细用 `mini-datagrid`；行编辑读 BP-12。
- JS：提交时校验主表和明细，使用 `mini.encode(grid.getChanges())` 或项目样例传参。
- Action：保存方法接收表单和明细变更。
- Service：事务保存主从数据，处理新增/修改/删除明细，校验明细唯一性。
- 红线：不要把明细拼成原生 table；主从保存必须事务闭合。

页面小片段读取：BP-06、BP-12。

## GP-06 字典和代码项

命中信号：状态下拉、类型单选、区域代码、列表显示中文、详情显示中文。

细责：

- HTML：表单用 `mini-combobox/radiobuttonlist action="getXxxModel"`；展示用 `data-options="{code:'xxx'}"`。
- Action：补 `getXxxModel()`，按项目样例用代码项工厂或 Service 查询。
- Service：业务表字典需过滤禁用、按区域/权限过滤。
- 红线：不要在 JS 里手写枚举中文；`action` 必须闭合后台方法。

页面小片段读取：BP-08；业务写法读 `references/interaction/dictionary-status-dialog.md`。

## GP-07 弹窗选择

命中信号：选择人员、选择部门、选择事项、选择材料、弹窗回填、多选。

细责：

- 选择页：通常是独立列表页 + 选择 Action。
- 父页面：`epoint.openDialog/openTopDialog` 打开选择页，第三个参数写 callback；回调后 `mini.get().setValue/setText`。
- 子页面：选中后用 `epoint.closeDialog(grid.getSelected())` 或自定义对象把结果传回父页面；取消可按项目样例 `epoint.closeDialog('close')`，父页面 callback 必须显式忽略空返回或 `'close'`。
- Action/Service：选择列表支持过滤禁用、权限范围、多选回填字段。
- 红线：入口不明时不能猜选择页；不要用原生 window 弹窗替代公司弹窗；不要从子页面直接操作父页面 DOM。

页面小片段读取：BP-05；业务写法读 `references/interaction/dictionary-status-dialog.md`。

## GP-08 附件和材料

命中信号：上传、预览、下载、附件查看、材料清单、手风琴附件、失败回到页面不能丢。

细责：

- HTML：按项目高频使用 `mini-webuploader`；手风琴附件读 BP-11。
- Action：补 `getXxxFileUploadModel()`；新增页 `!isPostback()` 生成附件 GUID 并 `addViewData`，postback `getViewData` 恢复。
- Service：保存附件 GUID；详情页只读预览；必要时查 `FrameAttachInfo`。
- 配置：只有上传限制、加密预览等配置明确时才读配置地图。
- 红线：`getXxxFileUploadModel()` 不反复生成新 GUID；不自造上传接口。

必须读取：`references/integration/attachment-index.md`，再按场景读取 `attachment-form-upload.md` 或 `attachment-list-page.md`。

## GP-09 导入导出

命中信号：列表导出、Excel 导入、模板下载、导入结果。

细责：

- 导出 HTML：`mini-dataexport action="getExportModel" gridId="datagrid" extraId="fui-form"`。
- 导出 Action：补 `public ExportModel getExportModel()`，列和标题与列表/需求一致。
- 导入：按项目样例实现模板、解析、错误收集和结果反馈；复杂导入放 Service。
- 红线：导出 action 必须闭合；不手写浏览器下载 URL 绕过公司组件。

必须读取：`references/integration/import-export.md`。

## GP-10 菜单权限

命中信号：挂菜单、后台入口、模块注册、按钮权限、权限组。

细责：

- 先确认：菜单编码、父节点、名称、排序、权限组、是否初始化配置。
- HTML/Action：按钮权限按项目样例处理，不先改安全配置。
- 配置：需要明确确认后才改 `module_data.xml`、`epointsecurity.properties` 等。
- 红线：普通 CRUD 默认不改菜单权限配置；不能凭空编菜单编码。

必须读取：`references/config/resource-config-map.md`、必要时 `references/config/resource-config-examples.md`。

## GP-11 定时任务

命中信号：每天凌晨、每小时、定时同步、补偿任务、Quartz、手动补偿。

细责：

- Job：按项目样例实现 Quartz `Job`，处理幂等、失败隔离和日志。
- Service：同步逻辑放 Service，Job 和手动入口复用同一个业务方法。
- 管理端：需要手动补偿时可生成列表/按钮/Action。
- 配置：只有用户确认 cron 和注册方式后才改 `quartz_data.xml`。
- 红线：Job 内禁止 DAO/SQL/直接查库；不能只有 Job 没有失败记录；不能未经确认写 cron 配置。

必须读取：`references/integration/job-mq.md`、`references/config/resource-config-map.md`。

## GP-12 MQ 消息

命中信号：RabbitMQ、队列监听、消息发送、外部变更消息、消息补偿。

细责：

- Listener/Producer：按项目样例实现，解析消息体、幂等、失败日志。
- Service：消息业务处理放 Service，可被补偿任务复用。
- 配置：队列、exchange、routing key、listener 注册方式明确后才改 Spring/RabbitMQ 配置。
- 红线：不能凭空编队列名；不能只写 listener 不做幂等和异常处理。

必须读取：`references/integration/job-mq.md`、`references/config/resource-config-map.md`。

## GP-13 外部接口调用

命中信号：外部接口、第三方接口、平台接口、HTTP/API、REST 同步、回调；“调阅/检索”只有明确来源是外部平台或第三方接口时才算命中。

细责：

- HTML/JS：只调用本项目 Action，例如 `epoint.execute`；不要让页面直连第三方地址。
- Action：做页面参数校验、用户上下文、调用 Service/Util、`addCallbackParam` 返回。
- Service/Util：优先复用本项目已有 Hutool/HttpUtil 工具类或同类接口样例；封装请求参数、超时、空响应、HTTP 状态、业务状态和异常。
- 配置：接口地址、token、appKey、secret、证书只来自已确认配置、系统参数、接口文档或项目样例。
- 红线：不套普通 Spring Boot 返回风格；不新增硬编码地址/凭证；不凭接口名猜响应字段。

必须读取：`references/integration/external-api-call.md`；涉及地址/凭证时读取 `references/config/resource-config-map.md`。

边界：

- 只要求“调用接口返回结果”时，不默认生成审计日志或日志列表。
- 需求明确“留痕、调用记录、入参出参、耗时”时，再读取 `references/integration/audit-call-log.md`。
- 需求明确“展示外部接口结果列表、临时结果面板/弹窗、预览、下载”时，再读 `frontend/legacy-miniui-best-practices.md` 的 BP-04/BP-05/BP-13；若涉及附件/文件预览下载，再读 `references/integration/attachment-index.md`。

## GP-14 SSO/安全

命中信号：SSO、登录、统一认证、免登录、接口白名单、XSS、SQL skip。

细责：

- 默认只读定位：先说明影响和风险。
- 必须确认：放行路径、环境、认证方式、风险接受。
- 配置：确认后按项目样例最小追加，不重排、不输出敏感值。
- 红线：安全白名单、SSO、XSS、SQL skip 不能当普通业务代码随手改。

必须读取：`references/config/resource-config-map.md`。

## GP-15 配置文件写入边界

命中信号：resources、配置文件、cron、MQ 配置、菜单、安全放行、数据库连接、License、日志配置。

细责：

- 判断配置类型：菜单/权限、Quartz、MQ、SSO/安全、数据源、日志、附件限制。
- 先读后问：缺关键参数时只定位，不写入。
- 写入方式：按本项目样例追加，避免重排和格式化整个配置文件。
- 汇报：不输出账号、密码、密钥、token、License、内网连接串。
- 红线：高风险配置必须用户明确确认后才改。

必须读取：`references/config/resource-config-map.md`。

## GP-16 业务配置表维护

命中信号：规则维护、模板维护、映射维护、推送系统维护、接入方维护、不同事项/区域/系统配置不同规则、业务人员配置生效。

细责：

- Entity：配置表字段按业务语义命名，示例里的 `status/push_url` 不是固定字段。
- HTML：生成列表、表单、详情，稳定枚举用代码项控件；多条配置不要写进 `properties`。
- Action：CRUD、启停、代码项 `getXxxModel` 与页面控件闭合。
- Service：保存时校验唯一性、生效范围、状态；运行逻辑必须按事项/区域/系统/优先级等条件查询生效配置。
- 配置：通常不改 resources；只有全局开关、地址、外部凭证、调度注册等另按 CM-02/CM-14/GP-15 处理。
- 红线：不能只生成维护页不生成运行查询逻辑；不能把业务人员维护的多条规则塞进 `*.properties`。

必须读取：`references/config/resource-config-map.md`、必要时 `references/config/resource-config-examples.md` 的“业务配置表维护”。

## GP-17 外部凭证和认证

命中信号：token、token 失效重取、clientId/clientSecret、appKey、证书、签名、第三方接口认证、不同接入方账号不同。

细责：

- 来源判断：全局单套按系统参数配置理解，Coder 再按项目样例从配置服务或既有 `*.properties` 读取；多接入方通常随业务配置记录维护。
- Service：负责获取 token、签名、调用第三方、认证失败处理、失败日志/补偿；不要把认证逻辑写在页面或 Action 里。
- 日志：不输出真实 token、secret、密码、证书内容。
- 失败后果：必须明确阻断、跳过、写失败日志或进入补偿，不能静默吞掉。
- 配置：敏感配置默认只读；新增 key 或凭证存放边界不明时阻断。
- 红线：不要让用户在需求里明文贴密钥；不要凭空指定凭证存放文件。

必须读取：`references/config/resource-config-map.md`、必要时 `references/config/resource-config-examples.md` 的“外部凭证和 token”。

## 交付前最佳实践自检

- 已列出需求命中的能力域和最佳实践编号。
- 每个最佳实践都拆到了实际文件层职责：HTML/JS/Action/Service/Entity/配置。
- 页面小动作已读 `frontend/legacy-miniui-best-practices.md` 并命中 BP 编号。
- 每个前端 `action/execute` 都有 Java Action public 方法。
- 涉及配置的场景已按 `resource-config-map.md` 判断只读、询问或写入。
- 业务配置已判断是多条业务记录还是单个系统参数；多条业务配置有维护页和运行查询逻辑。
- 外部凭证已判断全局单套还是多接入方；敏感值不外泄，认证失败后果明确。
- 已确认公司 API 规则时，不因找不到本项目样例而阻断，直接按规则合同实现并用真实编译验证；没有规则且关键参数仍不明时才阻断，不凭空发明公司 API。
