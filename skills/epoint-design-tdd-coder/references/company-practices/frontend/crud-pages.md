# 前端 CRUD 页面示例

用于普通管理端列表页、表单页、详情页。生成前先读取 `references/frontend/page-guidelines.md`，本文件只在需要 CRUD 页面代码片段时加载。

字段名提醒：示例里的 `status`、`type`、`ordernum` 等只表示一种常见写法，不是固定命名。生成真实代码时必须先看工作包列出的同类页面、表字段和业务语义；没有精确页面引用时，用页面路由、Action 名或对象键检索相近页面，命中后停止。

## List HTML

```html
<!DOCTYPE html>
<html>
<head>
    <title>XXX维护</title>
    <meta charset="UTF-8"/>
    <meta http-equiv="X-UA-Compatible" content="IE=edge"/>
    <script src="../../frame/fui/js/cssboot.js"></script>
</head>
<body>
<div class="page-loading"></div>

<div class="fui-toolbar">
    <div class="btn-group mr10">
        <a class="mini-button" state="primary" onclick="openAdd">新增</a>
        <a class="mini-button" state="danger" onclick="deleteSelect">删除选定</a>
        <a class="mini-dataexport" id="dataexport" gridId="datagrid"
           fileName="XXX维护" action="getExportModel" extraId="fui-form"></a>
    </div>
</div>

<div class="fui-condition">
    <div class="fui-form" id="fui-form">
        <div role="form">
            <div role="row">
                <div role="control" label="名称">
                    <input class="mini-textbox" bind="keyword"/>
                </div>
                <div role="control" label="状态">
                    <input class="mini-combobox" bind="status" action="getStatusModel"
                           textField="text" valueField="id" emptyText="请选择..."/>
                </div>
            </div>
        </div>
    </div>
    <a role="searcher" callback="searchData"></a>
</div>

<div id="fuiContent" class="fui-content">
    <div id="datagrid" class="mini-datagrid" idField="rowguid" action="getDataGridData"
         showPager="true" style="height:100%;" multiSelect="true">
        <div property="columns">
            <div type="checkcolumn" width="40"></div>
            <div type="indexcolumn" width="40" headerAlign="center">序</div>
            <div field="name" width="160" headerAlign="center" allowSort="true">名称</div>
            <div field="status" width="80" headerAlign="center" data-options="{code:'是否'}">状态</div>
            <div field="operatedate" width="140" headerAlign="center"
                 dateFormat="yyyy-MM-dd HH:mm:ss">操作时间</div>
            <div width="60" align="center" headerAlign="center" renderer="onDetailRenderer">查看</div>
            <div width="60" align="center" headerAlign="center" renderer="onEditRenderer">编辑</div>
        </div>
    </div>
</div>

<script src="../../rest/resource/jsboot"></script>
<script>
    epoint.initPage('xxxinfolistaction');

    var onEditRenderer = function(e) {
        return epoint.renderCell(e, "action-icon icon-edit", "openEdit");
    };
    var onDetailRenderer = function(e) {
        return epoint.renderCell(e, "action-icon icon-search", "openDetail");
    };

    function openAdd() {
        epoint.openDialog('新增', './xxxinfoadd', searchData, {width: 800, height: 600});
    }

    function openEdit(id) {
        epoint.openDialog('修改', './xxxinfoedit?guid=' + id, searchData, {width: 800, height: 600});
    }

    function openDetail(id) {
        epoint.openDialog('详情', './xxxinfodetail?guid=' + id, null, {width: 800, height: 600});
    }

    function deleteSelect() {
        if (mini.get('datagrid').getSelecteds().length == 0) {
            epoint.alert('请选择要删除的记录!');
            return;
        }
        epoint.confirm('确认要删除吗?', '', function() {
            epoint.execute('deleteSelect', 'datagrid', function(d) {
                if (d.msg) {
                    epoint.alert(d.msg, '', searchData);
                }
            });
        });
    }

    function searchData() {
        epoint.refresh(['datagrid', 'fui-form'], '', true);
    }
</script>
</body>
</html>
```

要点：

- `cssboot.js` 和 `rest/resource/jsboot` 的相对路径必须按页面深度调整。
- 红线：本页所有 `action` 和 `epoint.execute` 必须在 ListAction 里有 public 方法；缺 `getDataGridData/getExportModel/getStatusModel/deleteSelect` 任一项都不能交付。
- `mini-datagrid action="getDataGridData"` 对应 ListAction 的 `getDataGridData()`。
- `mini-dataexport action="getExportModel"` 对应 ListAction 的 `getExportModel()`。
- `mini-combobox action="getStatusModel"` 对应当前 `epoint.initPage('xxxinfolistaction')` 的 `getStatusModel()`。
- `epoint.execute('deleteSelect', 'datagrid', ...)` 对应当前 ListAction 的 `deleteSelect()`。
- 查询区不要写原生 `<form>`；用 `fui-condition` + `fui-form` + `role="control"`。
- 删除、启停、发布等操作不要用 `fetch`；用 `epoint.confirm` + `epoint.execute`。
- 主操作按钮可用 `state="primary"`，删除等危险操作可用 `state="danger"`；不要生成原生 `<button>`。
- 代码项列用 `data-options="{code:'代码项名称'}"`，不要手写中文枚举映射。

## Form HTML

```html
<div class="fui-toolbar">
    <a class="mini-button" state="primary" onclick="saveAndClose">保存</a>
    <a class="mini-button" onclick="epoint.closeDialog">关闭</a>
</div>
<div class="fui-content">
    <div id="fui-form" class="fui-form">
        <div role="form">
            <div role="row">
                <div role="control" label="名称" starred="true">
                    <input class="mini-textbox" bind="dataBean.name"
                           required="true" requiredErrorText="名称不能为空!"/>
                </div>
                <div role="control" label="状态">
                    <input class="mini-combobox" bind="dataBean.status" action="getStatusModel"
                           textField="text" valueField="id" emptyText="请选择..."/>
                </div>
            </div>
        </div>
    </div>
</div>
<script src="../../rest/resource/jsboot"></script>
<script>
    epoint.initPage('xxxinfoaddaction');

    function saveAndClose() {
        if (epoint.validate()) {
            epoint.execute('add', 'fui-form', function(d) {
                if (d.msg && d.msg.indexOf('成功') >= 0) {
                    epoint.closeDialog(d.msg);
                }
                else {
                    epoint.alert(d.msg);
                }
            });
        }
    }
</script>
```

编辑页常见差异：

```javascript
epoint.initPage('xxxinfoeditaction');
epoint.execute('save', 'fui-form', callback);
```

要点：

- 表单绑定字段通常是 `bind="dataBean.xxx"`。
- 保存前调用 `epoint.validate()`。
- 保存成功弹窗页通常 `epoint.closeDialog(d.msg)`。
- 红线：新增页 `epoint.execute('add')` 必须有 AddAction `public void add()`；编辑页 `epoint.execute('save')` 必须有 EditAction `public void save()`；表单内每个字典 `action="getXxxModel"` 都必须有对应 public 方法。
- 不要写原生 `<form onsubmit>` 或 `<input type="submit">`。
- 不要用 `fetch('/xxx/save')` 保存；用 `epoint.execute('add/save', 'fui-form', callback)`。
- `epoint.execute('add', 'fui-form', ...)` 对应 AddAction 的 `add()`；编辑页 `epoint.execute('save', 'fui-form', ...)` 对应 EditAction 的 `save()`。
- 表单里的 `mini-combobox/radiobuttonlist action="getXxxModel"` 对应当前 Add/Edit Action 的 `getXxxModel()`。

## 页面 action 到后台方法清单

生成 CRUD 页面后，至少核对这张清单。它是公司红线，不是可选联调项；缺少任一后台方法时必须补齐或阻断：

| 页面 | 前端绑定 | Java Action |
| --- | --- | --- |
| 列表页初始化 | `epoint.initPage('xxxinfolistaction')` | `@RestController("xxxinfolistaction")` |
| 列表数据 | `mini-datagrid action="getDataGridData"` | `public DataGridModel<Xxx> getDataGridData()` |
| 查询字典 | `mini-combobox action="getStatusModel"` | `public List<?> getStatusModel()` 或项目样例模型 |
| 导出 | `mini-dataexport action="getExportModel"` | `public ExportModel getExportModel()` |
| 删除 | `epoint.execute('deleteSelect', 'datagrid', ...)` | `public void deleteSelect()` |
| 新增页初始化 | `epoint.initPage('xxxinfoaddaction')` | `@RestController("xxxinfoaddaction")` |
| 新增保存 | `epoint.execute('add', 'fui-form', ...)` | `public void add()` |
| 编辑页初始化 | `epoint.initPage('xxxinfoeditaction')` | `@RestController("xxxinfoeditaction")` |
| 编辑保存 | `epoint.execute('save', 'fui-form', ...)` | `public void save()` |
| 详情页初始化 | `epoint.initPage('xxxinfodetailaction')` | `@RestController("xxxinfodetailaction")` |

## Detail HTML

```html
<div id="fui-form" class="fui-form">
    <div role="form">
        <div role="row">
            <div role="control" label="名称">
                <div class="mini-output" bind="dataBean.name"></div>
            </div>
            <div role="control" label="状态">
                <div class="mini-output" bind="dataBean.status" data-options="{code:'是否'}"></div>
            </div>
        </div>
    </div>
</div>
<script src="../../rest/resource/jsboot"></script>
<script>
    epoint.initPage('xxxinfodetailaction');
</script>
```

要点：

- 详情页用 `mini-output` 或项目样例里的 `mini-outputtext`，不要生成保存按钮。
- 字典展示按项目样例用 `data-options="{code:'xxx'}"`。
