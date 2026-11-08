# 公司实践约束索引

本目录提供公司框架实践。先判断当前行为是否满足卡片的 `useWhen`，成立后才落实 `required` 及相关章节，不把同文件类型下所有卡当必读。执行流程统一按主 Skill；本目录只提供技术写法和规范。

## 使用边界

- 这些文档只服务 Coder 写业务代码时的公司框架写法，不服务需求阶段追问实现细节，也不服务设计阶段决定骨架或文件数量。
- Coder 不自由遍历本目录；优先沿适用卡片定向读取。卡片漏列必要规范时，按当前行为和主 Skill 定向补读；主从整体保存读取并落实 GP-05、CM-05，不因漏列省略事务。
- 若参考文档和工作包列出的当前项目样例、规则小抄、reuseCard 指路冲突，以适用于当前项目版本的公司规则和真实接口为准，历史样例不覆盖明确规则；规则优先级和证据不足时的定向检索按主 Skill 执行。
- 持久化字段、配置 key、代码项名称和已有对外 API 合同必须来自需求事实、设计合同、项目样例或用户确认；新增业务方法名由 Coder 根据 Story/AC 自行命名并在三层 Service 与调用方闭合。文档里的 `status/type/isuse/ordernum` 只是示例。
- 示例只允许学习结构和写法，不允许照搬示例字段名、方法名、类名或配置 key；缺证据时停止补事实，不得猜。

## 高频读卡组合

| 场景 | 读取组合 |
|---|---|
| 基础 CRUD / 新增维护 | `company-best-practice-dispatch.md#GP-01` + `backend/crud-recipes.md` + `backend/crud-examples.md` + `frontend/page-guidelines.md` + `frontend/crud-pages.md` |
| 查询分页 / 搜索条件 | `company-best-practice-dispatch.md#GP-02` + `frontend/legacy-miniui-best-practices.md#BP-02` + `frontend/common-js.md` |
| 工具栏按钮 / 批量操作 | `frontend/legacy-miniui-best-practices.md#BP-03` + `frontend/common-js.md` |
| 操作列按钮 | `frontend/legacy-miniui-best-practices.md#BP-04` + `frontend/common-js.md` |
| 弹窗新增编辑 / 保存后刷新父页 | `frontend/legacy-miniui-best-practices.md#BP-05` + `frontend/legacy-miniui-best-practices.md#BP-06` + `frontend/common-js.md#弹窗关闭、父页回调和传参` |
| 选择弹窗 / 回填父页面 | `company-best-practice-dispatch.md#GP-07` + `frontend/legacy-miniui-best-practices.md#BP-05` + `frontend/common-js.md#弹窗关闭、父页回调和传参` + `interaction/dictionary-status-dialog.md` |
| 代码项 / 字典 / 下拉 | `company-best-practice-dispatch.md#GP-06` + `frontend/legacy-miniui-best-practices.md#BP-08` + `interaction/dictionary-status-dialog.md` |
| 状态流转 | `company-best-practice-dispatch.md#GP-04` + `frontend/legacy-miniui-best-practices.md#BP-03` + `frontend/legacy-miniui-best-practices.md#BP-09` |
| 附件 / 预览 / 下载 / 材料 | `company-best-practice-dispatch.md#GP-08` + `integration/attachment-index.md` |
| 导入导出 | `company-best-practice-dispatch.md#GP-09` + `integration/import-export.md` |
| 业务配置 / 规则 / 模板 / 映射维护 | `company-common-mechanisms.md#CM-13` + `company-best-practice-dispatch.md#GP-16` + `config/resource-config-map.md` + `config/resource-config-examples.md#业务配置表维护` |
| 外部凭证 / token / 多接入方认证 | `company-common-mechanisms.md#CM-14` + `company-best-practice-dispatch.md#GP-17` + `config/resource-config-map.md` + `config/resource-config-examples.md#外部凭证和-token` |
| 定时 / 补偿任务 | `company-best-practice-dispatch.md#GP-11` + `integration/job-mq.md` + `config/resource-config-map.md` |
| MQ 消息 | `company-best-practice-dispatch.md#GP-12` + `integration/job-mq.md` + `config/resource-config-map.md` |
| 菜单 / 权限 / 安全 / 配置风险 | `company-best-practice-dispatch.md#GP-10` + `company-best-practice-dispatch.md#GP-14` + `company-best-practice-dispatch.md#GP-15` + `config/resource-config-map.md` |
