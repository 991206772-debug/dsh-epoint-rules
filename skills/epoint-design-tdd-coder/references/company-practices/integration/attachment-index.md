# 附件、预览、导入导出索引

先按业务场景选择文件，不要一次性读取所有附件规则。

| 场景 | 读取文件 | 生成边界 |
| --- | --- | --- |
| 表单内上传评审资料、普通相关附件、附件留痕 | `attachment-form-upload.md` | 公司项目高频默认用 `mini-webuploader`；不额外造附件 datagrid |
| 附件独立管理页、附件列表、批量删除、预览列 | `attachment-list-page.md` | `mini-webuploader` + `mini-datagrid` + `IAttachService` |
| 列表导出、Excel 导入 | `import-export.md` | `mini-dataexport` / `dataImport=true` |

通用红线：

- `cliengGuid`、`clientguid`、`attachGuid` 等只是“附件标识”的项目命名，不是固定字段名。
- 附件标识必须稳定贯穿上传、保存、详情查看；不要在每次刷新页面或每次调用上传模型时换 GUID。
- 页面 `action="getXxxModel"` 或 `action="xxxaction.getXxxModel"` 必须和 Java getter 方法一致。
- 默认按项目高频 `mini-webuploader` 生成；不要引入其他上传控件。
- 表单留痕附件不要额外造附件列表；只有需求明确独立附件管理时才读 `attachment-list-page.md`。
- 涉及上传限制、加密预览等配置时，再读 `references/config/resource-config-map.md`。
