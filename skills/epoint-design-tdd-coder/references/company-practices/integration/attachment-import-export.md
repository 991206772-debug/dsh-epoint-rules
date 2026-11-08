# 附件、预览、导入导出兼容索引

本文件只保留兼容入口。不要把所有附件和导入导出规则一次性读入；按业务场景读取下列小文件。

| 场景 | 读取文件 |
| --- | --- |
| 表单内上传普通相关附件、评审资料、附件留痕 | `attachment-form-upload.md` |
| 独立附件列表、批量删除、预览列 | `attachment-list-page.md` |
| 列表导出、Excel 导入 | `import-export.md` |

通用判断：

- `cliengGuid`、`clientguid`、`attachGuid` 等只是“附件标识”的项目命名，不是固定字段名。
- 附件标识必须稳定贯穿上传、保存、详情查看；不能每次刷新页面或调用上传模型时换 GUID。
- 默认按项目高频 `mini-webuploader` 生成；不要引入其他上传控件。
- 表单留痕附件不生成附件 datagrid；只有需求明确独立附件管理时才读 `attachment-list-page.md`。
- 页面控件 `action` 必须和 Java getter 方法一致。
- 涉及上传限制、加密预览等配置时，再读 `references/config/resource-config-map.md`。
