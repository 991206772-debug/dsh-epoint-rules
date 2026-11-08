# 前端页面示例索引

用于 Epoint 管理端页面生成。这个文件只放硬约束和导航；需要代码片段时再按页面形态加载对应分类示例，禁止一次性读取全部前端示例。

字段名提醒：文档中的 `status`、`type`、`isuse`、`xxxState` 都只是示例字段名。生成或改造页面时，以当前项目字段、既有页面 bind、Entity 属性和业务语义为准，不要把示例字段名当规范。

## 页面硬约束

管理端页面默认使用公司 FUI + MiniUI + `epoint.*` 写法。除非当前项目同目录页面明确使用其它框架，否则不要写原生页面。

必须使用：

- 资源引入：`frame/fui/js/cssboot.js`、`rest/resource/jsboot`，相对路径按页面深度调整。
- 页面初始化：`epoint.initPage('xxxaction')`，必须和后端 `@RestController("xxxaction")` 闭合。
- 基础布局：`page-loading`、`fui-toolbar`、`fui-condition`、`fui-form`、`fui-content`。
- 表单结构：`role="form"`、`role="row"`、`role="control"`、`label="..."`、必要时 `starred="true"`。
- 常用控件：`mini-button`、`mini-textbox`、`mini-combobox`、`mini-datepicker`、`mini-spinner`、`mini-textarea`、`mini-datagrid`、`mini-tree`、`mini-treegrid`、`mini-treeselect`、`mini-hidden`、`mini-output`、`mini-outputtext`、`mini-dataexport`、`mini-webuploader`。
- 数据绑定：查询字段常用 `bind="keyword/xxxState"` 或 `bind="dataBean.xxx"` 这类写法；表单字段常用 `bind="dataBean.xxx"`，真实字段名按项目确定。
- 后端调用和弹窗闭环：`epoint.execute`、`epoint.refresh`、`epoint.openDialog/openTopDialog`、`epoint.closeDialog`、`epoint.validate`、`epoint.alert`、`epoint.confirm`、`mini.get`。

禁止默认生成：

- 原生 `<form>`、业务数据 `<table>`、`<input type="text">`、`<select>`、`<button>`。
- `fetch`、`axios`、`XMLHttpRequest`、`$.ajax` 做常规保存/删除/查询。
- Bootstrap、ElementUI、Vue/React 页面结构。
- 自己拼 REST URL 保存表单，绕过 `epoint.execute`。

允许例外：

- 当前项目同目录页面已经使用原生或特殊框架。
- 用户明确要求写非管理端页面。
- 第三方控件页面只能按本项目已有样例复用。

## 按需加载

| 需求信号 | 再读取 |
| --- | --- |
| 历史页面改造、给既有页面加按钮/查询/联动/操作列/手风琴显隐 | `references/frontend/legacy-miniui-best-practices.md` |
| 普通列表、新增、编辑、详情 | `references/frontend/crud-pages.md` |
| 查询刷新、弹窗关闭/父页回调、删除、保存、代码项展示、按钮渲染、控件联动、高频 JS 方法 | `references/frontend/common-js.md` |
| 手风琴/动态手风琴组合/分组页、手风琴表单+列表、手风琴附件、左树右表、树形表格、行编辑明细 | `references/frontend/special-pages.md` |
| 附件上传、附件预览 | `references/integration/attachment-index.md` |
| 导入导出 | `references/integration/import-export.md` |
| 字典、状态按钮、弹窗选择和父页面回填 | `references/interaction/dictionary-status-dialog.md` |

## 控件选择小抄

| 需求 | MiniUI/FUI 写法 |
| --- | --- |
| 普通文本 | `<input class="mini-textbox" bind="dataBean.name" />` |
| 长文本 | `<input class="mini-textarea" bind="dataBean.remark" />` |
| 必填 | `required="true" requiredErrorText="名称不能为空!"` + 外层 `starred="true"` |
| 下拉字典 | `<input class="mini-combobox" bind="dataBean.type" action="getTypeModel" textField="text" valueField="id" />` |
| 单选代码项 | `<input class="mini-radiobuttonlist" bind="dataBean.status" action="getStatusModel" />` |
| 列表代码项展示 | `<div field="status" data-options="{code:'是否'}">状态</div>` |
| 详情代码项展示 | `<div class="mini-outputtext" bind="dataBean.status" data-options="{code:'是否'}"></div>` |
| 日期 | `<input class="mini-datepicker" bind="dataBean.startdate" format="yyyy-MM-dd" />` |
| 数字/排序 | `<input class="mini-spinner" bind="dataBean.ordernum" minValue="0" />` |
| 只读展示 | `<div class="mini-output" bind="dataBean.name"></div>` 或 `<div class="mini-outputtext" bind="dataBean.name"></div>` |
| 工具栏按钮 | `<a class="mini-button" state="primary" onclick="openAdd">新增</a>` |
| 危险按钮 | `<a class="mini-button" state="danger" onclick="deleteData">删除选定</a>` |
| 搜索图标按钮 | `<a class="mini-button" state="primary" iconCls="icon-search" onclick="searchData" tooltip="搜索"></a>` |
| 操作列按钮 | `renderer="onEditRenderer"` + `epoint.renderCell(e, 'action-icon icon-edit', 'openEdit')` |
| 列表 | `<div class="mini-datagrid" idField="rowguid" action="getDataGridData">...</div>` |
| 左树右表 | `fui-left` + `mini-tree`，`fui-right` + 查询区 + `mini-datagrid/mini-treegrid` |
| 树形表格 | `<div class="mini-treegrid" treeColumn="name" idField="rowguid" action="getDataGridData">...</div>` |
| 树下拉 | `<input class="mini-treeselect" action="getTreeModel" textField="text" valueField="id" />` |
| 行编辑 | `allowCellEdit="true"` + 列内 `<input property="editor" class="mini-textbox" />` |
| 隐藏联动字段 | `<input id="leftTreeNodeGuid" bind="leftTreeNodeGuid" class="mini-hidden" />` |
| 导出 | `<a class="mini-dataexport" gridId="datagrid" action="getExportModel" extraId="fui-form"></a>` |
| 普通附件上传 | `<div class="mini-webuploader" action="xxxaction.getFileUploadModel"></div>` |
| 关闭弹窗并触发父页回调 | `epoint.closeDialog(data.msg)` 或 `epoint.closeDialog(row)` |

## 页面闭合检查

- 公司红线：页面上的 MiniUI/FUI `action="..."` 和 `epoint.execute('...')` 都必须能落到 Java Action 的 public 方法。缺少任意后台方法时，生成结果未完成；必须补齐或阻断，不能写成 TODO、REST URL、`.do` 地址或“后续联调补”。
- `epoint.initPage('xxxlistaction')` 与 Java `@RestController("xxxlistaction")` 一致。
- `mini-datagrid action="getDataGridData"` 与 Java `getDataGridData()` 一致。
- `mini-tree/mini-treegrid action="getTreeData/getTreeModal"` 与 Java 树模型方法一致。
- `mini-combobox/mini-treeselect action="getXxxModel"` 与 Java `getXxxModel()` 一致。
- 代码项列/详情展示用 `data-options="{code:'xxx'}"`，代码项名称必须来自需求或项目代码项。
- 工具栏按钮用 `mini-button`，主操作可用 `state="primary"`，删除等危险操作可用 `state="danger"`。
- 操作列用 `renderer="onXxxRenderer"` + `epoint.renderCell`，回调函数名与 JS 方法一致。
- `mini-dataexport action="getExportModel"` 与 Java `getExportModel()` 一致。
- `mini-webuploader action="xxxaction.getXxxFileUploadModel"` 与 Java 上传模型方法一致。
- `epoint.execute('save', 'fui-form', ...)` 与 Java `save()` 一致。
- `epoint.execute('saveAll', 'datagrid', ...)` 与 Java 批量保存方法一致；保存前必须 `grid.isValid()`。
- 弹窗 URL 参数按项目实战样例可直接拼接，并与编辑 Action 读取的请求参数一致；参数名跟随同目录历史页面，如 `guid`/`rowguid`，若项目已有 `Util.addUrlParams` 写法再沿用。
- 新增/编辑弹窗父页面使用 `epoint.openDialog('标题', url, searchData, options)` 时，子页面保存成功要 `epoint.closeDialog(data.msg)` 触发父页刷新；详情页只读弹窗可传空回调。
- 选择弹窗父页面使用 `epoint.openDialog('选择', url, callback, options)`，子页面用 `epoint.closeDialog(grid.getSelected())` 或自定义对象回传，父页面回调里 `mini.get(...).setValue/setText` 回填。
- 不要从子页面直接操作父页面 DOM；不要用 `window.close()` 替代 `epoint.closeDialog`。
- 动态手风琴用 `Util.accordion.hideItem/showItem/expandItem/collapseItem/setTitle/addItem`；隐藏块必须同步取消必填校验，`addItem` 只追加 iframe 独立页。

## 前端 action 与后台方法对应

MiniUI/FUI 控件上的 `action="..."` 是后台 Action 方法绑定，不是普通 HTML 标记。生成页面时必须先确定当前页面的 Action bean：

```html
<script>
    epoint.initPage('xxxlistaction');
</script>
```

对应后台：

```java
@RestController("xxxlistaction")
@Scope("request")
public class XxxListAction extends BaseController {
}
```

`action` 有两种写法：

| 前端写法 | 含义 | 后台要求 |
| --- | --- | --- |
| `action="getDataGridData"` | 调当前 `epoint.initPage('xxxlistaction')` 对应 Action 的方法 | `xxxlistaction.getDataGridData()` |
| `action="xxxaddaction.getFileUploadModel"` | 显式调指定 Action bean 的方法 | `@RestController("xxxaddaction")` 里有 `getFileUploadModel()` |
| `epoint.execute('save')` | 调当前 `epoint.initPage('xxxaction')` 对应 Action 的方法 | `xxxaction.save()` |
| `epoint.execute('otheraction/methodName')` | 显式调指定 Action bean 的方法 | `@RestController("otheraction")` 里有 `methodName()` |

`epoint.execute` 传额外参数时，第三参只用标量或数组。单参数直接传变量；多参数传数组，顺序对齐 Java Action 形参；不要传对象字面量。

```javascript
// 正例：无表单多参数
epoint.execute('doSomething', '@none', [firstValue, secondValue], callback);

// 反例：不要这样传对象
epoint.execute('doSomething', '@none', { firstValue: firstValue, secondValue: secondValue }, callback);
```

常见闭合表：

| 页面控件/方法 | 前端示例 | Java Action 方法 |
| --- | --- | --- |
| 列表数据 | `<div class="mini-datagrid" action="getDataGridData">` | `public DataGridModel<Xxx> getDataGridData()` |
| 树形表格 | `<div class="mini-treegrid" action="getDataGridData">` | `public DataGridModel<Xxx> getDataGridData()` 或项目样例返回树数据模型 |
| 左侧树 | `<ul class="mini-tree" action="getTreeData">` | `public List<?> getTreeData()` 或项目样例树模型 |
| 下拉/单选字典 | `<input class="mini-combobox" action="getStatusModel">` | `public List<?> getStatusModel()` 或项目样例 `ComboBoxModel` |
| 树下拉 | `<input class="mini-treeselect" action="getTreeModel">` | `public List<?> getTreeModel()` |
| 导出 | `<a class="mini-dataexport" action="getExportModel">` | `public ExportModel getExportModel()` |
| 普通附件上传 | `<div class="mini-webuploader" action="xxxaction.getAttachUploadModel">` | `public FileUploadModel9 getAttachUploadModel()` |
| 保存/删除/状态操作 | `epoint.execute('save', 'fui-form', callback)` | `public void save()` |
| 批量保存行编辑 | `epoint.execute('saveAll', 'datagrid', callback)` | `public void saveAll()` |

最小示例：

```html
<div id="datagrid" class="mini-datagrid" idField="rowguid"
     action="getDataGridData" showPager="true"></div>

<input id="status" class="mini-combobox" bind="status"
       action="getStatusModel" textField="text" valueField="id" />

<a class="mini-dataexport" gridId="datagrid"
   action="getExportModel" extraId="fui-form"></a>
```

```java
@RestController("xxxlistaction")
@Scope("request")
public class XxxListAction extends BaseController {
    public DataGridModel<XxxInfo> getDataGridData() {
        // 按项目样例返回 DataGridModel/PageData
    }

    public List<?> getStatusModel() {
        // 按项目代码项样例返回 combobox/radio 数据
    }

    public ExportModel getExportModel() {
        return new ExportModel("name,status", "名称,状态");
    }
}
```

真实项目闭合证据：

```text
qhzwfw/zwbgcheckresult/zwbgcheckresultlist.html
  epoint.initPage('zwbgcheckresultlistaction')
  mini-datagrid action="getDataGridData"

ZwbgCheckresultListAction.java
  @RestController("zwbgcheckresultlistaction")
  public DataGridModel<ZwbgCheckresult> getDataGridData()
  public void deleteSelect()
  public ExportModel getExportModel()
```

规则：

- `action` 方法名大小写必须和 Java public 方法完全一致，HTML 里不写括号。
- 普通页面控件优先写短方法名，例如 `action="getDataGridData"`，默认走当前 `epoint.initPage` 的 Action。
- 上传控件、跨页面复用控件可按项目样例写全名，例如 `action="xxxaction.getFileUploadModel"`；全名里的 `xxxaction` 必须等于 `@RestController("xxxaction")`。
- 一个页面有多个 datagrid/tree/uploader 时，每个控件的 `id/action` 和后台方法要一一对应，例如 `materialGrid -> getMaterialData`、`logGrid -> getLogData`。
- `epoint.execute('xxx')` 也是后台方法绑定；`save/deleteSelect/enable/disable` 等方法必须在当前 Action 中存在，或按项目样例写 `xxxaction.method`。
- 不要把 `action` 写成 REST URL、`.do` 地址或随意路径；不要用 `fetch/$.ajax` 绕过公司页面绑定。
- 若页面已写控件/JS 但 Java 方法不存在，先补 Action 方法；无法判断方法归属时停下来问入口 Action，不要猜。

## 反例红线

不要生成这种管理端原生写法：

```html
<form id="form">
    <input type="text" name="name">
    <button onclick="save()">保存</button>
</form>
<script>
function save() {
    fetch('/api/xxx/save', {method: 'POST'});
}
</script>
```

应改成 FUI/MiniUI + `epoint.execute`，具体参考 `references/frontend/crud-pages.md` 和 `references/frontend/common-js.md`。
