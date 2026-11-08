# 历史改造 MiniUI/FUI 最佳实践

用于既有管理端页面的小需求改造：加查询条件、加按钮、加操作列、加字段联动、加状态操作、改手风琴、补行编辑、加附件预览等。目标是让 LLM 从需求动作直接匹配公司写法，再拆到 HTML/JS/Action/Service 细责。

字段名提醒：历史改造必须沿用原页面 bind、原 Entity 字段和原 Service 查询条件。示例里的 `status` 只表示“某个状态/是否/类型字段”的写法，不是要求把字段改名或新增为 `status`。

使用顺序：

1. 先读原 HTML 的 `epoint.initPage('xxxaction')`，定位当前 Action bean。
2. 搜同目录相似页面和对应 Action/Service，沿用已有写法。
3. 用下表匹配最佳实践场景，可多选。
4. 按场景细责分别改 HTML、JS、Action、Service。
5. 做 action 闭合红线检查：所有 `action="..."` 和 `epoint.execute('...')` 都必须有 Java Action public 方法。

输出或内部记录细责时用这个格式：

```text
命中最佳实践：BP-03 列表工具栏按钮和批量操作 + BP-09 状态操作
HTML 细责：新增 mini-button，放到 fui-toolbar
JS 细责：getSelecteds 判空，epoint.confirm，epoint.execute('publish')
Action 细责：新增 public void publish()
Service 细责：校验停用状态不能发布，更新状态
红线：execute('publish') 与 Action 方法闭合
```

## 场景索引

| 编号 | 需求信号 | 最佳实践 |
| --- | --- | --- |
| BP-01 | 历史页面、既有功能、加字段/按钮/校验/流程 | 历史改造入口定位 |
| BP-02 | 加查询条件、按状态/日期/名称筛选 | 列表新增查询条件 |
| BP-03 | 加按钮、批量删除、批量发布、批量启停 | 列表工具栏按钮和批量操作 |
| BP-04 | 操作列加查看/编辑/删除/配置 | 操作列按钮 |
| BP-05 | 新增/编辑/详情弹窗、选择页弹窗 | 弹窗新增编辑详情 |
| BP-06 | 保存、提交、校验、关闭弹窗 | 表单保存和校验 |
| BP-07 | 类型切换、字段显隐、必填切换、禁用启用 | 控件联动 |
| BP-08 | 状态下拉、字典展示、代码项列 | 代码项展示和选择 |
| BP-09 | 启用、停用、发布、撤回、作废 | 状态操作 |
| BP-10 | 左侧分类树过滤右侧列表 | 左树右表 |
| BP-11 | 手风琴显隐、改标题、追加电子表单 | 手风琴/动态手风琴 |
| BP-12 | 明细表格内编辑排序/备注/数量 | 行编辑明细表 |
| BP-13 | 外部接口结果列表、临时结果面板/弹窗、预览下载 | 结果列表和预览下载边界 |

## BP-01 历史改造入口定位

需求信号：用户说“现有页面”“历史需求”“给某页面加”“原来功能上改”“别重做”。

细责：

- 入口：必须确认或定位原 HTML/Action；入口不唯一时先问用户，不按命名猜。
- HTML：保留原 `cssboot.js/jsboot`、布局、控件 id、bind、已有 JS 回调。
- JS：沿用原页面的 `searchData/save/delete/openXxx` 命名风格；新增方法只做增量。
- Action：在原 `@RestController("xxxaction")` 中补页面需要的方法，或按原页面跳转关系补 Add/Edit/Detail Action。
- Service：只增加本需求需要的校验、查询、状态变化；保留原业务结果。
- 红线：禁止把历史页面重写成新模板；禁止引入原页面没有的 Vue/React/原生 ajax 风格。

## BP-02 列表新增查询条件

需求信号：列表按名称、状态、日期、区域、分类筛选。

细责：

- HTML：在 `fui-condition` 的 `fui-form` 内新增 `role="control"`；普通文本用 `mini-textbox`，状态/类型用 `mini-combobox` 或 `mini-radiobuttonlist`，日期用 `mini-datepicker/mini-daterangepicker`。
- JS：查询按钮复用或新增 `searchData`，调用 `epoint.refresh(['datagrid','fui-form'], '', true)`。
- Action：确认查询字段能通过 `bind`/DTO 到达 `getDataGridData()`。
- 后端 Java：查询条件承载在 Action/Rest/Job/ServiceInternal 哪一层，就在该层按项目样例使用 `SqlConditionUtil`/参数化 SQL 增加条件；复杂查询和状态、权限、跨字段/跨记录业务约束下沉 Service，普通表单必填、长度、格式留在页面；日期范围要处理起止边界。
- 红线：字典类查询 `action="getXxxModel"` 必须补 Action 方法；不要写原生 `<select>` 或手拼 URL。

```html
<div role="control" label="状态">
    <input id="status" class="mini-combobox" bind="status"
           action="getStatusModel" textField="text" valueField="id" />
</div>
```

```javascript
function searchData() {
    epoint.refresh(['datagrid', 'fui-form'], '', true);
}
```

## BP-03 列表工具栏按钮和批量操作

需求信号：列表加“删除选定”“发布”“撤回”“启用”“停用”“同步”“补偿”按钮。

细责：

- HTML：按钮放 `fui-toolbar`，使用 `<a class="mini-button">`；主操作可 `state="primary"`，危险操作可 `state="danger"`。
- JS：用 `mini.get('datagrid').getSelecteds()` 判空；危险动作先 `epoint.confirm`；执行用 `epoint.execute('methodName', 'datagrid', callback)`。
- Action：补 `public void methodName()`，从 datagrid 获取选中主键或接收参数。
- Service：做引用校验、状态校验、权限/范围校验，返回明确 `msg`。
- 红线：不要写原生 `<button>`；`epoint.execute('methodName')` 必须和 Action public 方法闭合。

```html
<a class="mini-button" state="primary" onclick="publishData">发布</a>
<a class="mini-button" state="danger" onclick="deleteData">删除选定</a>
```

```javascript
function publishData() {
    var rows = mini.get('datagrid').getSelecteds();
    if (rows.length == 0) {
        epoint.alert('请选择要发布的记录!');
        return;
    }
    epoint.confirm('确认发布选中记录吗?', '', function() {
        epoint.execute('publish', 'datagrid', function(data) {
            epoint.alert(data.msg, '', searchData);
        });
    });
}
```

## BP-04 操作列按钮

需求信号：每行加查看、编辑、删除、配置、关联、日志、复制。

细责：

- HTML：新增操作列 `renderer="onXxxRenderer"`。
- JS：renderer 返回 `epoint.renderCell(e, 'action-icon icon-xxx', 'methodName')`。
- Action：如果操作是后台动作，补 `public void methodName()`；如果只是打开页面，确保目标页面 Action 存在。
- Service：删除、复制、关联等动作必须进 Service 做校验。
- 红线：操作列不要返回原生 `<button>` 或 `<a onclick>`。

```html
<div width="60" align="center" headerAlign="center" renderer="onEditRenderer">编辑</div>
```

```javascript
var onEditRenderer = function(e) {
    return epoint.renderCell(e, 'action-icon icon-edit', 'openEdit');
};
```

## BP-05 弹窗新增编辑详情

需求信号：点击新增/编辑/详情弹窗，选择人员/部门/事项。

细责：

- HTML/JS：使用 `epoint.openDialog` 或项目已有 `openTopDialog`，URL 保持相对路径和原目录风格。
- Add/Edit/Detail Action：分别闭合 `epoint.initPage('xxxaddaction')`、`xxxeditaction`、`xxxdetailaction`。
- 参数：编辑/详情常用 `?guid=`，Action 里按项目样例 `getRequestParameter("guid")`。
- 父页面：新增/编辑弹窗第三个参数通常传 `searchData`，子页 `epoint.closeDialog(data.msg)` 后触发父页刷新；详情页只读弹窗可传空回调。
- 选择弹窗：父页面第三个参数写回填 callback，子页面 `epoint.closeDialog(grid.getSelected())` 或回传自定义对象，父页面用 `mini.get(...).setValue/setText` 回填。
- 红线：不要把弹窗改成 `window.open` 或原生模态；不要从子页直接操作父页 DOM；不要用 `window.close()` 替代 `epoint.closeDialog`。

```javascript
function openEdit(id) {
    epoint.openDialog('修改', './xxxedit?guid=' + id, searchData, {
        width: 800,
        height: 600
    });
}

function chooseItem() {
    epoint.openDialog('事项选择', './taskselect', function(data) {
        if (!data) {
            return;
        }
        mini.get('taskguid').setValue(data.rowguid);
        mini.get('taskname').setValue(data.taskname);
        mini.get('taskname').setText(data.taskname);
    }, {
        width: 900,
        height: 600
    });
}
```

## BP-06 表单保存和校验

需求信号：新增保存、编辑保存、提交、保存并继续新增。

细责：

- HTML：表单用 `fui-form` + `role="form/row/control"`；必填字段加 `required="true"` 和外层 `starred="true"`。
- JS：保存前 `epoint.validate()`；保存用 `epoint.execute('add/save/submit', 'fui-form', callback)`。
- JS：保存成功后必须明确页面状态：关闭并刷新父页用 `epoint.closeDialog(data.msg)`；保存并新建用 `epoint.clear('fui-form')`；保存后停留则 `epoint.alert(data.msg)`。
- Action：新增页补 `public void add()` 或项目已有 `addNew()`；编辑页补 `public void save()`。
- Service：重复校验、字段合法性、业务状态校验放 Service。
- 红线：不要用原生 form submit、fetch、axios、`$.ajax` 保存；弹窗页保存成功不要遗漏 `closeDialog` 或明确的留页处理。

```javascript
function saveAndClose() {
    if (epoint.validate()) {
        epoint.execute('save', 'fui-form', closeCallback);
    }
}

function closeCallback(data) {
    if (data.msg && data.msg.indexOf('成功') >= 0) {
        epoint.closeDialog(data.msg);
    }
    else {
        epoint.alert(data.msg);
    }
}
```

保存并继续新增：

```javascript
function saveAndNew() {
    if (epoint.validate()) {
        epoint.execute('addNew', 'fui-form', function(data) {
            if (data.msg && data.msg.indexOf('成功') >= 0) {
                epoint.alert(data.msg, '', null, 'info');
                epoint.clear('fui-form');
            }
            else {
                epoint.alert(data.msg);
            }
        });
    }
}
```

## BP-07 控件联动

需求信号：选择类型后显示/隐藏字段，某状态下禁用字段，某条件下字段必填。

细责：

- HTML：控件必须有稳定 id；被联动字段仍放在 FUI 表单结构里。
- JS：用 `mini.get(id).setValue/setText/setEnabled/setVisible/setRequired`。
- Action：初始化回调 `epoint.initPage(..., callback)` 返回默认值、只读状态或业务标记。
- Service：如果联动影响保存规则，后端也要校验，不能只靠前端隐藏。
- 红线：隐藏必填控件时必须同步 `setRequired(false)`；显示回来再恢复。

```javascript
function onTypeChanged() {
    var type = mini.get('type').getValue();
    mini.get('reason').setVisible(type == '02');
    mini.get('reason').setRequired(type == '02');
    mini.get('handlername').setEnabled(type != 'readonly');
}
```

## BP-08 代码项展示和选择

需求信号：状态字典、是否、类型、区域、事项类别、列表显示中文。

细责：

- 列表/详情：优先 `data-options="{code:'代码项名称'}"` 展示中文。
- 表单：优先 `mini-combobox` 或 `mini-radiobuttonlist`，`action="getXxxModel"` 从 Action 获取数据。
- Action：补 `public List<?> getXxxModel()` 或项目样例的 `ComboBoxModel` 返回。
- Service：如果字典来自业务表或接口，Service 负责查询和过滤禁用数据。
- 红线：不要在 JS renderer 里手写 `if status == '1' ? '启用' : '停用'`。

```html
<div field="status" data-options="{code:'是否'}">状态</div>
<input class="mini-radiobuttonlist" bind="dataBean.status" action="getStatusModel" />
```

## BP-09 状态操作

需求信号：启用、停用、发布、撤回、作废、上架、下架。

细责：

- HTML：工具栏或操作列加 `mini-button`/`epoint.renderCell`。
- JS：先选中记录，再确认，再 `epoint.execute('updateStatus/publish/disable')`。
- Action：补对应 public 方法，获取选中 id 和目标状态。
- Service：做非法流转校验、引用校验、重复操作校验，再更新状态和修改人/时间。
- 红线：状态规则必须在 Service 再校验；不能只前端禁用按钮。

## BP-10 左树右表

需求信号：左边区域/部门/分类树，右边列表按树过滤。

细责：

- HTML：左侧 `fui-left` + `mini-tree action="getTreeData"`；右侧 `fui-right` + 查询区 + `mini-datagrid/treegrid`。
- JS：树点击把节点 id 写入 `mini-hidden`，刷新右侧表格。
- Action：补 `getTreeData()` 和右侧 `getDataGridData()`。
- Service：树数据和列表数据分开查；列表查询带树节点过滤。
- 红线：不要用原生树或自己拼 ul/li；树 action 也必须闭合后台方法。

```javascript
mini.get('tree').on('nodeclick', function(e) {
    mini.get('leftTreeNodeGuid').setValue(e.node.id == 'f9root' ? '' : e.node.id);
    epoint.refresh(['datagrid', 'fui-form', 'leftTreeNodeGuid']);
});
```

## BP-11 手风琴/动态手风琴

需求信号：分组页、基本信息/材料/日志、按类型显示分组、改标题、追加电子表单。

细责：

- HTML：使用 `fui-accordions` + `role="accordion/head/body"`；每块可放 `fui-form`、`mini-datagrid`、上传控件。
- JS：预置块动态组合用 `Util.accordion.hideItem/showItem/expandItem/collapseItem/setTitle`；追加独立页面用 `addItem`。
- Action：初始化回调返回显隐条件、标题、iframe URL；每个块里的 datagrid/uploader action 单独闭合。
- Service：提供分组所需数据和业务判断。
- 红线：不要把手风琴写死成固定三块；隐藏块必须同步取消必填；`addItem` 只追加 iframe 独立页。

```javascript
var ACC = { material: 1, log: 2 };

epoint.initPage('xxxeditaction', '', function(data) {
    data.showMaterial == '1' ? Util.accordion.showItem(ACC.material) : Util.accordion.hideItem(ACC.material);
    mini.get('materialname').setRequired(data.showMaterial == '1');
    if (data.phasename) {
        Util.accordion.setTitle(data.phasename + '信息', ACC.material);
    }
    if (data.eformurl) {
        Util.accordion.addItem('电子表单', data.eformurl, true, '600px');
    }
});
```

## BP-12 行编辑明细表

需求信号：明细行内编辑排序、备注、数量、材料清单维护。

细责：

- HTML：`mini-datagrid allowCellEdit="true" allowCellSelect="true" allowCellValid="true"`；列内用 `<input property="editor" class="mini-xxx">`。
- JS：保存前 `grid.isValid()`；失败 `grid.getCellErrors()[0]` + `grid.beginEditCell(...)`；提交 `grid.getChanges()` 或直接 `epoint.execute('saveAll','datagrid')`。
- Action：补 `public void saveAll()` 或表单组合提交方法。
- Service：批量校验明细唯一性、排序、删除同步，事务保存；普通表单必填、长度、格式由页面校验。
- 红线：不要用原生 `<table><input>` 做行编辑；保存方法必须和 `epoint.execute` 闭合。

```javascript
function saveAll() {
    var grid = mini.get('datagrid');
    if (!grid.isValid()) {
        var error = grid.getCellErrors()[0];
        grid.beginEditCell(error.record, error.column);
        return;
    }
    epoint.execute('saveAll', 'datagrid', function(data) {
        epoint.alert(data.msg, '', searchData);
    });
}
```

## BP-13 结果列表和预览下载边界

需求信号：外部接口返回多条结果、临时结果面板/弹窗、结果列表里预览/下载。普通 CRUD 列表查询不因“展示查询结果”自动命中本节。

细责：

- HTML：复杂结果列表优先落在已有 DOM 容器或独立结果页；需要弹窗时打开已有页面或结果页，不用 JS 字符串拼完整 `mini-datagrid`。
- JS：操作列仍用 `renderer` + `epoint.renderCell`；每个动作先闭合到 Action，再由 Action 返回业务结果或后端确认的 URL。
- Action：补结果查询、预览、下载等 public 方法；校验当前行关键参数，调用 Service/Util。
- Service：负责外部接口调用、文件权限、返回字段解析和失败兜底。
- 红线：不要拼 `<a onclick>` 操作列；不要在页面手写第三方预览/下载 URL；不要把业务结果弹窗写成原生 window 弹窗。

推荐结构：

```html
<div id="certResultGrid" class="mini-datagrid" idField="rowguid"
     showPager="false" allowResize="true">
    <div property="columns">
        <div field="certname" headerAlign="center">证照名称</div>
        <div width="80" align="center" renderer="onCertOperate">操作</div>
    </div>
</div>
```

```javascript
var onCertOperate = function(e) {
    return epoint.renderCell(e, "action-icon icon-search", "previewCert", "rowguid");
};

function previewCert(rowguid) {
    epoint.execute('getPreviewUrl', '@none', [rowguid], function(data) {
        if (data.url) {
            window.open(data.url, '_blank');
        }
        else {
            epoint.alert(data.msg || '未获取到预览地址');
        }
    });
}
```

说明：`window.open` 只用于后端已经确认并返回的文件流/预览 URL；业务页面、选择页、详情页、结果页仍使用 `epoint.openDialog/openTopDialog`。

## 最终红线清单

- 需求动作必须先匹配最佳实践场景，再拆 HTML/JS/Action/Service 细责。
- 历史改造必须保留原入口和原页面风格；入口不明时先问。
- 所有 MiniUI/FUI `action`、`epoint.execute` 都必须闭合 Java Action public 方法。
- 查询、保存、删除、状态操作、行编辑、上传不使用原生 ajax 或自造 URL。
- 前端显隐/禁用只是体验；核心校验必须在 Service 再做。
- 复杂 MiniUI 结构不要用 JS 字符串拼装；操作列不要返回原生 `<a onclick>`。
