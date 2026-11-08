# 导入导出

用于列表导出和 Excel 导入。附件上传请按场景读取 `attachment-index.md`。

## 列表导出

页面：

```html
<a class="mini-dataexport" id="dataexport" gridId="datagrid"
   fileName="查询列表" action="getExportModel" extraId="fui-form"></a>
```

Action：

```java
public ExportModel getExportModel() {
    if (exportModel == null) {
        exportModel = new ExportModel("name,type,status", "名称,类型,状态");
    }
    return exportModel;
}
```

要点：

- 导出字段顺序和表头必须一一对应。
- `extraId="fui-form"` 用于带查询区条件的导出；按项目样例保留或调整。

## 导入

```html
<div id="dataImport" class="mini-webuploader" pickerText="导入"
     action="xxxlistaction.getDataImportModel"
     dataImport="true" onuploadfinished="searchData"></div>
```

要点：

- 导入涉及模板、错误行回传、事务策略；必须找本项目已有导入样例后再生成。
- `action` 必须闭合到 Java `getDataImportModel()` 或项目已有同名模型方法。
