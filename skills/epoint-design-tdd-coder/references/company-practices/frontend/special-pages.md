# 前端专项页面形态示例

用于手风琴/分组页、动态手风琴组合、左树右表、树形表格、行编辑明细。生成前先读取 `references/frontend/page-guidelines.md`，本文件只在需求命中这些专项形态时加载。

## 手风琴页面

用于详情、办理、分组表单、材料/流程/日志等分块页面。使用 `fui-accordions` + 多个 `role="accordion"`，不要用原生折叠面板或 Bootstrap collapse。手风琴是可组合容器，不是固定三块模板。

```html
<div class="fui-content">
    <div class="fui-accordions">
        <div role="accordion" opened="true" id="baseInfoBlock">
            <div role="head" title="基本信息"></div>
            <div role="body">
                <div id="fui-form" class="fui-form">
                    <div role="row">
                        <div role="control" label="名称" starred="true">
                            <input class="mini-textbox" bind="dataBean.name"
                                   required="true" requiredErrorText="名称不能为空!" />
                        </div>
                    </div>
                </div>
            </div>
        </div>
        <div role="accordion" opened="true" id="materialBlock">
            <div role="head" title="材料信息"></div>
            <div role="body">
                <div id="datagrid" class="mini-datagrid" idField="rowguid"
                     action="getMaterialData" showPager="false" style="height: 240px;">
                    <div property="columns">
                        <div type="indexcolumn" width="40">序</div>
                        <div field="materialname" headerAlign="center">材料名称</div>
                    </div>
                </div>
            </div>
        </div>
    </div>
</div>
```

动态显隐手风琴块时按项目样例使用 `Util.accordion.hideItem(index)` / `Util.accordion.showItem(index)`，或对有业务 id 的块做 `$('#xxxBlock').hide()`。序号显隐必须和页面块顺序一致。

```javascript
epoint.initPage('xxxdetailaction', '', function(data) {
    if (data.showMaterial != '1') {
        Util.accordion.hideItem(1);
    }
    if (data.readonly == '1') {
        mini.get('name').setEnabled(false);
    }
});
```

## 手风琴动态组合

公司 FUI 手风琴支持预置块动态组合，也支持运行时追加 iframe 块。生成页面时优先用“预置块 + 业务显隐”，块内继续放 `fui-form`、`mini-datagrid`、`mini-webuploader` 等公司组件；只有需要把独立页面嵌进来时才用 `Util.accordion.addItem(title, url, opened, contentHeight)`。

常用 API：

```javascript
Util.accordion.showItem(1);      // 显示第 2 个块，并重排可见序号
Util.accordion.hideItem(2);      // 隐藏第 3 个块，并同步右侧导航
Util.accordion.expandItem(0);    // 展开已存在且未隐藏的块
Util.accordion.collapseItem(0);  // 收起已存在且未隐藏的块
Util.accordion.setTitle('阶段信息', 1);
Util.accordion.addItem('电子表单', url, true, '600px');
```

按业务类型组合块时，显隐和必填校验要一起处理。隐藏块里的必填控件必须 `setRequired(false)`，重新显示后再恢复必填；否则用户看不见字段但保存校验会失败。

```javascript
var ACC = {
    manager: 1,
    technician: 2,
    subcontract: 4
};

$(function() {
    Util.accordion.hideItem(ACC.manager);
    Util.accordion.hideItem(ACC.technician);
    Util.accordion.hideItem(ACC.subcontract);
});

function onTypeChanged() {
    var type = mini.get('contracttype').getValue();
    if (type == '01') {
        Util.accordion.showItem(ACC.manager);
        Util.accordion.showItem(ACC.technician);
        Util.accordion.hideItem(ACC.subcontract);
        mini.get('managername').setRequired(true);
        mini.get('subcontractname').setRequired(false);
    }
    else if (type == '02') {
        Util.accordion.hideItem(ACC.manager);
        Util.accordion.hideItem(ACC.technician);
        Util.accordion.showItem(ACC.subcontract);
        mini.get('managername').setRequired(false);
        mini.get('subcontractname').setRequired(true);
    }
}
```

按数据有无组合块时，列表加载后判断行数；没有数据的块隐藏，有数据再显示。全空时可显示提示文案。

```javascript
function afterGridLoad() {
    var relationGrid = mini.get('relationGrid');
    var recommendGrid = mini.get('recommendGrid');

    relationGrid.data.length == 0 ? Util.accordion.hideItem(0) : Util.accordion.showItem(0);
    recommendGrid.data.length == 0 ? Util.accordion.hideItem(1) : Util.accordion.showItem(1);

    if (relationGrid.data.length == 0 && recommendGrid.data.length == 0) {
        $('#tips').removeClass('hidden');
    }
}
```

按后端返回动态改标题或追加 iframe 块：

```javascript
epoint.initPage('xxxhandleaction', '', function(data) {
    Util.accordion.setTitle(data.phasename ? data.phasename + '信息' : '阶段信息', 1);

    if (data.eformurl) {
        Util.accordion.addItem('电子表单', data.eformurl, true, '600px');
    }
});
```

注意：

- `hideItem/showItem/setTitle` 都按手风琴初始 DOM 顺序的 index 操作；生成代码时用 `ACC` 常量保存 index，避免后续改块顺序导致错位。
- 对业务块加稳定 id，例如 `id="materialBlock"`、`id="logBlock"`；如果项目样例有 `ZwUtil.hideAccordion("xxx")` 这类按 id 封装，优先跟随本项目。
- `addItem` 生成的是 iframe 块，适合嵌独立页面；不要用它把一堆表单 HTML 字符串拼进去。
- 动态组合后仍要保证每个 `mini-datagrid action`、上传控件 `action`、表单 `bind` 和 Java Action 方法闭合。

## 手风琴 + 表单 + 列表

用于“基本信息 + 明细列表/日志列表/材料列表”的分组页面。表单仍放 `fui-form`，列表仍放 `mini-datagrid`，不要用原生 `<table>` 拼明细。

```html
<div class="fui-content">
    <div class="fui-accordions">
        <div role="accordion" opened="true" id="baseBlock">
            <div role="head" title="基本信息"></div>
            <div role="body">
                <div id="fui-form" class="fui-form">
                    <div role="form">
                        <div role="row">
                            <div role="control" label="配置名称" starred="true">
                                <input class="mini-textbox" bind="dataBean.configname"
                                       required="true" requiredErrorText="配置名称不能为空!" />
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        </div>
        <div role="accordion" opened="true" id="detailBlock">
            <div role="head" title="明细信息"></div>
            <div role="body">
                <div id="datagrid" class="mini-datagrid" idField="rowguid"
                     action="getDetailData" showPager="false" style="height:260px;">
                    <div property="columns">
                        <div type="indexcolumn" width="40">序</div>
                        <div field="detailname" headerAlign="center">明细名称</div>
                        <div field="ordernum" width="80" headerAlign="center">排序</div>
                    </div>
                </div>
            </div>
        </div>
    </div>
</div>
```

表单和明细一起提交时，表单走 `fui-form`，表格变更用 `mini.encode(grid.getChanges())` 作为附加参数。

```javascript
function submitData() {
    var grid = mini.get('datagrid');
    if (epoint.validate() && grid.isValid()) {
        epoint.execute('saveData', 'fui-form', [mini.encode(grid.getChanges())], callback);
    }
}
```

## 手风琴 + 附件上传

用于“基本信息 + 模板附件/证照附件/材料附件”的页面。附件细节先读取 `references/integration/attachment-index.md`，再读取 `attachment-form-upload.md`；后端必须保证附件 GUID 在 `isPostback()` 前后稳定。

```html
<div role="accordion" opened="true" id="attachBlock">
    <div role="head" title="附件信息"></div>
    <div role="body">
        <div id="fui-form" class="fui-form">
            <div role="form">
                <div role="row">
                    <div role="control" label="模板附件">
                        <div id="templateattach" pickerText="上传模板" class="mini-webuploader"
                             action="xxxaddaction.getTemplateFileUploadModel"
                             limitType="doc,docx,txt,rar,zip,jpg,jpeg,pdf,xls,xlsx,gif,bmp,png"
                             mimeTypes="" fileNumLimit="1" auto="true"></div>
                    </div>
                </div>
            </div>
        </div>
    </div>
</div>
```

普通附件按项目样例使用 `mini-webuploader`：

```html
<div role="control" label="空白模板">
    <div id="templateattach" pickerText="空白模板" class="mini-webuploader"
         action="xxxeditaction.getTemplateAttachUploadModel"
         limitType="doc,docx,txt,rar,zip,jpg,jpeg,pdf,xls,xlsx,gif,bmp,png"
         mimeTypes="" fileNumLimit="1" auto="true"
         onfileremove="ontemplateattachremove"></div>
</div>
```

## 手风琴 + 附件查看/只读预览

详情页继续放 `mini-webuploader`。先用 `enabled="true"` 让控件加载已有附件，初始化回调中再关闭 uploader，并隐藏当前控件的删除/上传按钮；只隐藏 CSS 按钮而不关闭控件，附件刷新后可能重新生成删除链接。

```javascript
epoint.initPage('xxxdetailaction', '', function(data) {
    var uploader = mini.get('requireattach');
    if (uploader) {
        uploader.setEnabled(false);
    }
    $('#requireattach').find('.mini-uploader-btns, .mini-uploader-remove').hide();
});
```

只读页不要生成保存按钮；附件控件的 `action` 仍要和详情 Action 的 `getXxxFileUploadModel` 方法闭合。

## 左树右表页面

用于按区域、部门、分类、目录过滤右侧列表。结构是 `fui-left` 放 `mini-tree`，`fui-right` 放查询区和表格；树节点 id 写入隐藏字段，右侧 `datagrid/treegrid` 刷新时自动带上查询条件。

```html
<div class="fui-left" title="分类">
    <div role="head" title="分类树"></div>
    <div role="body">
        <ul id="tree" class="mini-tree" action="getTreeData"
            style="width:100%; padding:5px; box-sizing:border-box;"
            showTreeIcon="true" textField="text" idField="id"
            parentField="pid" resultAsTree="false"></ul>
    </div>
</div>

<div class="fui-right">
    <div class="fui-condition">
        <div class="fui-form" id="fui-form">
            <div role="form">
                <div role="row">
                    <div role="control" label="名称">
                        <input class="mini-textbox" bind="dataBean.name" />
                    </div>
                </div>
                <input id="leftTreeNodeGuid" bind="leftTreeNodeGuid" class="mini-hidden" />
            </div>
        </div>
        <a role="searcher" callback="searchData"></a>
    </div>
    <div class="fui-content">
        <div id="datagrid" class="mini-datagrid" idField="rowguid"
             action="getDataGridData" showPager="true" style="height:100%;">
            <div property="columns">...</div>
        </div>
    </div>
</div>
```

```javascript
epoint.initPage('xxxlistaction');

var tree = mini.get('tree');
tree.on('nodeclick', function(e) {
    mini.get('leftTreeNodeGuid').setValue(e.node.id == 'f9root' ? '' : e.node.id);
    epoint.refresh(['datagrid', 'fui-form', 'leftTreeNodeGuid']);
});

function searchData() {
    epoint.refresh(['datagrid', 'fui-form', 'leftTreeNodeGuid']);
}
```

## 树形表格

如果右侧本身是层级数据，用 `mini-treegrid`：

```html
<div id="datagrid" class="mini-treegrid" idField="rowguid"
     action="getDataGridData" dataField="data" treeColumn="name"
     allowResize="true" showPager="true" style="height:100%;">
    <div property="columns">
        <div type="indexcolumn" width="40">序</div>
        <div field="name" name="name" headerAlign="center">名称</div>
    </div>
</div>
```

## 行编辑表格

用于明细表、排序、代码项、材料清单等“表格内直接改”的页面。必须使用 MiniUI `property="editor"`，不要把行编辑写成原生 `<table><input>`。

```html
<div id="datagrid" class="mini-datagrid" idField="rowguid"
     action="getDataGridData" showPager="true" allowCellEdit="true"
     allowCellSelect="true" allowCellValid="true"
     editNextOnEnterKey="true" editNextRowCell="true" style="height:100%;">
    <div property="columns">
        <div type="checkcolumn" width="40"></div>
        <div field="name" width="180" headerAlign="center">
            名称 <input property="editor" class="mini-textbox"
                      required="true" requiredErrorText="名称不能为空!" />
        </div>
        <div field="ordernum" width="100" headerAlign="center">
            排序 <input property="editor" class="mini-spinner" minValue="0" maxValue="9999" />
        </div>
        <div field="remark" width="220" headerAlign="center">
            备注 <input property="editor" class="mini-textbox" maxLength="200" />
        </div>
    </div>
</div>
```

常用行编辑 JS：

```javascript
var grid = mini.get('datagrid');

grid.on('load', function(e) {
    var rows = e.sender.findRows();
    for (var i = 0; i < rows.length; i++) {
        grid.beginEditRow(rows[i]);
    }
});

function addRow() {
    var newRow = {
        rowguid: '',
        ordernum: 0
    };
    grid.addRow(newRow, 0);
    grid.beginEditRow(newRow);
}

function saveAll() {
    if (grid.isValid() == false) {
        var error = grid.getCellErrors()[0];
        grid.beginEditCell(error.record, error.column);
        return;
    }
    epoint.execute('saveAll', 'datagrid', function(data) {
        if (data.msg) {
            epoint.alert(data.msg, '', searchData, 'info');
        }
    });
}

function searchData() {
    epoint.refresh(['datagrid', 'fui-form'], '', true);
}
```

表单 + 行编辑明细一起提交时，先取表格变更，再随 `epoint.execute` 的参数传给后端；后端方法名必须和 execute 第一个参数闭合。

```javascript
function submitData() {
    var grid = mini.get('datagrid');
    if (epoint.validate() && grid.isValid()) {
        var changes = mini.encode(grid.getChanges());
        epoint.execute('submit', 'fui-form', [changes], callback);
    }
    else if (grid.isValid() == false) {
        var error = grid.getCellErrors()[0];
        grid.beginEditCell(error.record, error.column);
    }
}
```
