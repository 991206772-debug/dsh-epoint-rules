# 公司代码示例加载索引

本文件供 `epoint-design-tdd-coder` 的 company-practices 读卡使用。它只做示例导航，不承载大段代码；施工时按需求信号加载对应分类文件，避免一次性塞入全部示例。

使用原则：

- 先读当前项目工程导航契约和本项目同模块样例，再读本索引。
- 先用 `company-common-mechanisms.md` 判断需求应使用哪些公司常用机制 CM，尤其是代码项、系统参数、业务配置、外部凭证、配置文件、前置库、事务、附件、幂等日志和高风险配置。
- 先用 `company-best-practice-dispatch.md` 把需求拆成 GP 最佳实践和文件层细责；历史页面小动作再用 `frontend/legacy-miniui-best-practices.md` 拆 BP 细责。
- 只加载与本次需求相关的分类文件；不要一次性读取全部示例。
- 如果分类示例和工作包列出的当前项目样例冲突，以工作包精确引用优先；没有精确引用时，用当前 Story、骨架类名、对象键或页面/Service 绑定检索相近实例，命中后停止；仍无法确认再报告缺证据。
- 包名、路径、字段、字典名、Action bean 名、cron、队列名、配置 key 必须来自当前项目或用户确认。
- 不生成 Lombok、MyBatis-Plus、JPA Repository、普通 Spring Boot CRUD、通用 Vue/React 页面。

## 分类文件

| 需求信号 | 加载文件 | 内容 |
| --- | --- | --- |
| 代码项、系统参数、业务配置、外部凭证、配置文件、前置库、事务、附件、用户会话、菜单权限、定时/MQ、幂等日志、高风险配置 | `references/company-common-mechanisms.md` | CM-01..CM-14：何时使用、何时不用、必须确认、示例代码、机制到 GP/BP 映射 |
| 公司级最佳实践分发、跨前后端/集成/配置细责拆解 | `references/company-best-practice-dispatch.md` | GP-01..GP-17：CRUD、查询、删除校验、状态、主从、字典、弹窗、附件、导入导出、菜单权限、Job、MQ、REST、安全、配置边界、业务配置、外部凭证 |
| 基础 CRUD、列表查询、新增编辑详情、删除校验 | `references/backend/crud-examples.md` | Entity、ServiceApi、内部 Service、ServiceImpl、List/Add/Edit/Detail Action |
| 管理端页面硬约束 | `references/frontend/page-guidelines.md` | FUI/MiniUI 页面红线、按需加载导航、控件选择、闭合检查 |
| 历史改造、页面小动作、MiniUI/FUI 方法最佳实践 | `references/frontend/legacy-miniui-best-practices.md` | BP-01..BP-12：入口定位、查询、按钮、操作列、弹窗、保存、联动、代码项、状态、左树右表、手风琴、行编辑 |
| 普通列表页、表单页、详情页 | `references/frontend/crud-pages.md` | CRUD 页面 HTML、工具栏、查询区、表单、详情只读展示 |
| 查询刷新、弹窗关闭/父页回调/传参回填、删除、保存、代码项展示、按钮渲染 | `references/frontend/common-js.md` | `epoint.refresh/openDialog/closeDialog/execute`、`data-options`、`epoint.renderCell`、`mini-button state/iconCls` |
| 手风琴、动态手风琴组合、手风琴表单+列表、手风琴附件、左树右表、树形表格、行编辑 | `references/frontend/special-pages.md` | `fui-accordions`、`Util.accordion`、表单+`mini-datagrid`、附件块、`mini-tree`、`mini-treegrid`、`property="editor"`、`grid.isValid()` |
| 字典、状态操作、弹窗选择 | `references/interaction/dictionary-status-dialog.md` | `CodeModalFactory`、状态流转、弹窗选择页和父页面回填 |
| 附件上传、附件预览、`isPostback` 附件 GUID | `references/integration/attachment-index.md`，再按场景读 `attachment-form-upload.md` / `attachment-list-page.md` | `FileUploadModel9`、`FrameAttachInfo`、`mini-webuploader`、`addViewData/getViewData` |
| 导入导出 | `references/integration/import-export.md` | `mini-dataexport`、`ExportModel`、`dataImport=true` |
| 定时任务、Quartz、MQ Listener、RabbitMQ XML | `references/integration/job-mq.md` | Quartz `Job`、`@DisallowConcurrentExecution`、`ChannelAwareMessageListener`、listener 配置 |
| 菜单、权限、安全放行、资源配置 | `references/config/resource-config-examples.md` | `epointsecurity.properties`、`module_data.xml`、`EpointSecurityConfig.properties`、`epointframe.properties` |

## 推荐加载组合

| 场景 | 读取组合 |
| --- | --- |
| 普通 CRUD | `company-capability-map.md` + `company-common-mechanisms.md` + `company-best-practice-dispatch.md` GP-01/02/03 + `backend/crud-recipes.md` + `backend/crud-examples.md` + `frontend/page-guidelines.md` + `frontend/crud-pages.md` + `frontend/common-js.md` |
| 历史页面小改造 | `company-common-mechanisms.md` + `company-best-practice-dispatch.md` + `frontend/legacy-miniui-best-practices.md`，先命中 CM/GP，再命中 BP，并保留原入口 |
| CRUD + 字典/启停/弹窗 | 普通 CRUD 组合 + `interaction/dictionary-status-dialog.md` + GP-04/06/07 + BP-03/05/08/09 |
| 代码项查询/列表展示/详情展示 | `frontend/page-guidelines.md` + `frontend/legacy-miniui-best-practices.md` BP-08 + `frontend/common-js.md` + `interaction/dictionary-status-dialog.md`，使用 `getXxxModel` + `data-options="{code:'xxx'}"` |
| 工具栏按钮/操作列按钮 | `frontend/page-guidelines.md` + `frontend/legacy-miniui-best-practices.md` BP-03/BP-04 + `frontend/common-js.md`，使用 `mini-button state/iconCls` + `renderer` + `epoint.renderCell` |
| 手风琴/分组表单/详情分块 | 普通 CRUD 组合 + `frontend/legacy-miniui-best-practices.md` BP-11 + `frontend/special-pages.md`，使用 `fui-accordions` + `role="accordion"` |
| 动态手风琴组合 | 普通 CRUD 组合 + BP-11 + `frontend/special-pages.md`，使用 `Util.accordion.hideItem/showItem/expandItem/collapseItem/setTitle/addItem`，显隐时同步必填校验 |
| 手风琴 + 表单 + list 列表 | 普通 CRUD 组合 + BP-11/BP-12 + `frontend/special-pages.md`，使用 `fui-form` + `mini-datagrid`，表单和明细保存闭合 |
| 手风琴 + 附件上传/附件查看 | 普通 CRUD 组合 + GP-08 + BP-11 + `frontend/special-pages.md` + `integration/attachment-index.md` + `attachment-form-upload.md`，校验 `isPostback` GUID 生命周期 |
| 左树右表/分类树过滤列表 | 普通 CRUD 组合 + BP-10 + `frontend/special-pages.md`，使用 `fui-left/fui-right` + `mini-tree` + 隐藏联动字段 |
| 行编辑明细/表格内维护 | 普通 CRUD 组合 + GP-05 + BP-12 + `frontend/special-pages.md`，使用 `allowCellEdit` + `property="editor"` + `grid.isValid()` |
| CRUD + 附件/导入导出 | 普通 CRUD 组合 + GP-08/09；附件读 `integration/attachment-index.md`，导入导出读 `integration/import-export.md`，必要时读 `config/resource-config-map.md` |
| 业务配置/规则/模板/映射维护 | 普通 CRUD 组合 + `company-common-mechanisms.md` CM-13 + `company-best-practice-dispatch.md` GP-16 + `config/resource-config-map.md` + `config/resource-config-examples.md`，同时生成运行 Service 查询生效配置 |
| 第三方 token/凭证/多接入方推送 | `company-common-mechanisms.md` CM-14 + CM-13/CM-11 + `company-best-practice-dispatch.md` GP-17/13/15 + `config/resource-config-map.md` + `config/resource-config-examples.md` |
| 定时同步/补偿 | `company-capability-map.md` + `company-best-practice-dispatch.md` GP-11 + `integration/job-mq.md` + `config/resource-config-map.md` |
| MQ 监听/发送 | `company-capability-map.md` + `company-best-practice-dispatch.md` GP-12 + `integration/job-mq.md` + `config/resource-config-map.md` |
| 挂菜单/按钮权限/安全放行 | `company-capability-map.md` + `company-best-practice-dispatch.md` GP-10/14/15 + `config/resource-config-map.md` + `config/resource-config-examples.md` |

## 最小闭合检查

- Entity 的 `@Entity(table,id)` 与数据库设计一致。
- 已命中 CM 常用机制编号；字段、系统参数、业务配置、外部凭证、配置文件、事务、前置库、附件、幂等日志等手段选择有依据。
- 已命中 GP 最佳实践编号；历史页面小动作已命中 BP 最佳实践编号。
- ServiceApi、内部 Service、ServiceImpl 方法闭合。
- Action bean 名与 HTML `epoint.initPage` 完全一致。
- 红线：所有页面控件 `action="..."` 和所有 `epoint.execute('...')` 必须映射到 Java Action public 方法；缺一个方法就先补齐或阻断，不能写成 TODO、REST URL 或后续联调项。
- `getDataGridData` 与 `mini-datagrid action` 一致。
- `getExportModel` 与 `mini-dataexport action` 一致。
- 字典 Action 方法与页面 `action="getXxxModel"` 一致。
- 所有 MiniUI/FUI 控件 `action="..."` 都有对应 Java Action public 方法；短 action 绑定当前 `epoint.initPage` 的 Action，全名 `xxxaction.method` 绑定指定 `@RestController("xxxaction")`。
- 所有 `epoint.execute('save/deleteSelect/saveAll/xxx')` 都有对应 Java Action public 方法，不把方法名当普通前端字符串。
- 代码项列表/详情展示用 `data-options="{code:'xxx'}"`，不要手写中文枚举映射。
- 工具栏按钮使用 `mini-button`，主操作可用 `state="primary"`，危险操作可用 `state="danger"`。
- 操作列按钮使用 `renderer="onXxxRenderer"` + `epoint.renderCell`，不要返回原生 `<button>`。
- 新增/编辑/详情页面路径和 `openDialog` URL 一致。
- 新增/编辑弹窗父页 `openDialog` 回调与子页 `closeDialog` 闭合；选择弹窗用 `closeDialog(row/object)` 传参，父页 callback 回填。
- 手风琴用 `fui-accordions` + `role="accordion/head/body"`，显隐逻辑与块顺序一致。
- 动态手风琴用 `Util.accordion` 系列 API，块 index 使用常量映射，隐藏块同步取消必填校验。
- `Util.accordion.addItem` 只用于追加 iframe 独立页，不用于拼接大段表单 HTML。
- 手风琴内表单和列表仍分别使用 `fui-form`、`mini-datagrid`，不要退回原生表格。
- 手风琴附件块必须同时闭合页面控件、Java 上传模型方法和附件 GUID 生命周期。
- 左树右表用 `mini-tree action` + `mini-hidden` 联动字段 + 右侧 `epoint.refresh` 闭合。
- 行编辑用 `property="editor"`，保存前 `grid.isValid()`，保存参数与 Action 批量保存方法一致。
- 附件 Action 的 `getFileUploadModel/delete/getDataGridData` 与页面控件一致；上传 GUID 不在 `getXxxFileUploadModel()` 中反复生成。
- 附件详情页隐藏删除/上传按钮；普通表单附件使用 `mini-webuploader`。
- Job 类名、包名、Quartz `job-class` 一致。
- MQ bean id、listener ref、队列名一致。
- 配置文件只在用户确认参数后追加，不重排、不泄密。
