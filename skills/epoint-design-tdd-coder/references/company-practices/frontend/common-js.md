# 前端高频 JS 方法示例

用于查询刷新、弹窗、删除、保存、代码项展示、按钮渲染、控件联动等页面 JS。生成前先读取 `references/frontend/page-guidelines.md`，本文件只在需要方法片段时加载。

字段名提醒：本文件中的 `status` 只是代码项列展示示例，不是公司固定字段。真实字段必须按需求、表结构、Entity、页面原 bind 和工作包列出的项目同类页面确定。

## 高频方法表

| 场景 | 高频写法 |
| --- | --- |
| 页面初始化 | `epoint.initPage('xxxaction', '', callback)` |
| 查询/刷新 | `epoint.refresh(['datagrid', 'fui-form'], '', true)` |
| 弹窗新增编辑 | `epoint.openDialog('标题', './xxxedit?guid=' + id, searchData, {width: 800, height: 400})`；参数名跟随历史页面/Action |
| 顶层弹窗 | `epoint.openTopDialog('标题', url, searchData, {width: 1200, height: 800})` |
| 弹窗保存后关闭并刷新父页 | 子页保存成功后 `epoint.closeDialog(data.msg)`，父页 `openDialog` 的回调用 `searchData` |
| 选择弹窗传参回填 | 子页 `epoint.closeDialog(grid.getSelected())`，父页回调里 `mini.get(...).setValue/setText` |
| 保存表单 | `epoint.validate()` 后 `epoint.execute('add/save', 'fui-form', callback)` |
| 无表单多参数调用 | `epoint.execute('methodName', '@none', [firstValue, secondValue], callback)` |
| 批量删除 | `mini.get('datagrid').getSelecteds()` 判空，`epoint.confirm` 后 `epoint.execute('deleteSelect', 'datagrid', callback)` |
| 提示后回调 | `epoint.alert(data.msg, '', searchData, 'info')`，第三参是回调、第四参是图标 |
| 代码项列展示 | `<div field="status" data-options="{code:'是否'}">状态</div>` |
| 详情代码项展示 | `<div class="mini-outputtext" bind="dataBean.status" data-options="{code:'是否'}"></div>` |
| 工具栏按钮 | `<a class="mini-button" state="primary" onclick="openAdd">新增</a>` |
| 图标搜索按钮 | `<a class="mini-button" state="primary" iconCls="icon-search" onclick="searchData" tooltip="搜索"></a>` |
| 行按钮 | `epoint.renderCell(e, 'action-icon icon-edit', 'openEdit')` |
| 控件取值赋值 | `mini.get('xxx').getValue()`、`setValue()`、`setText()` |
| 控件显隐启禁 | `mini.get('xxx').setVisible(false)`、`setEnabled(false)` |
| 表格行编辑 | `grid.isValid()`、`grid.getCellErrors()`、`grid.beginEditCell()`、`grid.getChanges()` |
| 加载遮罩 | `epoint.showLoading()`、`epoint.hideLoading()` |

## 查询刷新

```javascript
function searchData() {
    epoint.refresh(['datagrid', 'fui-form'], '', true);
}
```

## 行按钮和弹窗

```javascript
var onEditRenderer = function(e) {
    return epoint.renderCell(e, 'action-icon icon-edit', 'openEdit');
};

var onOperateRenderer = function(e) {
    return epoint.renderCell(e, 'action-icon icon-search', 'openOperate', 'rowguid,parentGuid');
};

function openEdit(id) {
    epoint.openDialog('修改记录', './xxxedit?guid=' + id, searchData, {
        width: 800,
        height: 400
    });
}

function openOperate(param) {
    epoint.openDialog('查看记录', './xxxdetail?parentGuid=' + param.parentGuid, null, {
        width: 900,
        height: 600
    });
}
```

## 弹窗关闭、父页回调和传参

公司弹窗不是普通 `window.open`。`epoint.openDialog` 第三个参数是父页面回调；子页面调用 `epoint.closeDialog(rtnValue)` 时，`rtnValue` 会传回父页面回调。

父页面新增/编辑后刷新当前列表：

```javascript
function openAdd() {
    epoint.openDialog('新增记录', './xxxinfoadd', searchData, {
        width: 800,
        height: 600
    });
}

function openEdit(id) {
    epoint.openDialog('修改记录', './xxxinfoedit?guid=' + id, searchData, {
        width: 800,
        height: 600
    });
}

function searchData() {
    epoint.refresh(['datagrid', 'fui-form'], '', true);
}
```

子页面保存成功后关闭弹窗并触发父页面回调：

```javascript
function saveAndClose() {
    if (epoint.validate()) {
        epoint.execute('save', 'fui-form', closeCallback);
    }
}

function closeCallback(data) {
    if (data.msg && data.msg.indexOf('成功') != -1) {
        epoint.closeDialog(data.msg);
    }
    else {
        epoint.alert(data.msg, '', null, 'info');
    }
}
```

选择弹窗把选中行传回父页面：

```javascript
function selectAndClose() {
    var row = mini.get('datagrid').getSelected();
    if (!row) {
        epoint.alert('请选择记录!');
        return;
    }
    epoint.closeDialog(row);
}
```

父页面接收选择结果并回填：

```javascript
function chooseItem() {
    epoint.openDialog('选择记录', './selectitem', function(data) {
        if (!data || data === 'close') {
            return;
        }
        mini.get('targetkey').setValue(data.rowguid);
        mini.get('targetname').setValue(data.name);
        mini.get('targetname').setText(data.name);
    }, {
        width: 900,
        height: 600
    });
}
```

如果父页面打开弹窗时传入 `params`，子页按项目样例可用 `epoint.getParams()` 读取；多数管理页仍优先使用 URL 参数，例如 `?guid=` 或 `?rowguid=`，并通过 `Util.getUrlParams(...)` 或 Action 的请求参数读取。

红线：

- 新增/编辑弹窗保存成功后必须明确是关闭刷新父页、保存并继续新增，还是停留当前页提示；不能只保存不处理页面状态。
- 父页面需要刷新时，`openDialog` 第三个参数传 `searchData` 或等价刷新函数；详情页这类只读弹窗可传 `null`/空回调。
- 选择弹窗要用 `epoint.closeDialog(row/object)` 回传结果；父页面回调先忽略空返回或 `'close'`，再用 `setValue/setText` 回填，不要从子页直接操作父页 DOM。
- 弹窗 URL 参数按项目实战样例可直接拼接；参数名跟随同目录历史页面和 Action 读取参数，如 `guid`/`rowguid`，若项目已有 `Util.addUrlParams` 写法再沿用。
- 子页关闭按钮用 `onclick="epoint.closeDialog"` 或项目样例写法，不写 `window.close()`。

## 代码项展示

列表列和详情页展示代码项时优先用 `data-options`，代码项名称必须来自项目代码项或用户确认；不要在 JS 里手写 `if/else` 拼中文。

```html
<div field="status" width="80" headerAlign="center" data-options="{code:'是否'}">状态</div>

<div class="mini-outputtext" bind="dataBean.status" data-options="{code:'是否'}"></div>
```

表单选择代码项时优先让 Action 提供 `getXxxModel`：

```html
<input id="status" class="mini-radiobuttonlist" action="getStatusModel"
       bind="dataBean.status" required="true" />
```

## 工具栏按钮

```html
<a class="mini-button" state="primary" onclick="openAdd" id="btnAddRecord">新增</a>
<a class="mini-button" state="danger" onclick="deleteData" id="btnDel">删除选定</a>
<a class="mini-button" state="primary" iconCls="icon-search"
   onclick="searchData" tooltip="搜索"></a>
```

要点：

- 工具栏、表单页按钮使用 `mini-button`；不要写原生 `<button>`。
- 新增、保存、搜索可按项目样例使用 `state="primary"`。
- 删除、作废等危险操作可按项目样例使用 `state="danger"`，并配合 `epoint.confirm`。

## 操作列按钮

```html
<div width="50" align="left" headerAlign="left" renderer="onEditRenderer">编辑</div>
<div width="50" align="left" headerAlign="left" renderer="onDetailRenderer">查看</div>
```

```javascript
var onEditRenderer = function(e) {
    return epoint.renderCell(e, 'action-icon icon-edit', 'openEdit');
};

var onDetailRenderer = function(e) {
    return epoint.renderCell(e, 'action-icon icon-search', 'openDetail');
};
```

要点：

- 操作列用 `renderer` + `epoint.renderCell`，不要返回 `<button>` 或 `<a onclick="...">`。
- 常见图标：编辑 `action-icon icon-edit`，查看 `action-icon icon-search`，删除 `action-icon icon-remove`，配置 `action-icon icon-gear`。
- `openEdit/openDetail` 的入参默认是行主键，方法内再拼公司页面 URL。

## 批量删除

```javascript
function deleteData() {
    if (mini.get('datagrid').getSelecteds().length == 0) {
        epoint.alert('请选择要删除的记录!', '', null, 'warning');
        return;
    }
    epoint.confirm('确认要删除吗?', '', function() {
        epoint.execute('deleteSelect', 'datagrid', function(data) {
            if (data.msg) {
                epoint.alert(data.msg, '', searchData, 'info');
            }
        });
    });
}
```

## 无表单参数调用

`epoint.execute` 第三个参数按公司 API 只传标量或数组。单参数直接传变量，多参数传数组并对齐 Java Action 形参顺序；不要传对象字面量。

```javascript
function doSomething(firstValue, secondValue) {
    epoint.execute('doSomething', '@none', [firstValue, secondValue], function(data) {
        if (data.msg) {
            epoint.alert(data.msg, '', searchData, 'info');
        }
    });
}
```

对应后端：

```java
public void doSomething(String firstValue, String secondValue) {
}
```

反例：

```javascript
epoint.execute('doSomething', '@none', { firstValue: firstValue, secondValue: secondValue }, callback);
```

## 保存并关闭

```javascript
function saveAndClose() {
    if (epoint.validate()) {
        epoint.execute('save', 'fui-form', function(data) {
            if (data.msg && data.msg.indexOf('成功') >= 0) {
                epoint.closeDialog(data.msg);
            }
            else {
                epoint.alert(data.msg, '', null, 'info');
            }
        });
    }
}
```

## 提示与回调

```javascript
function saveCallback(data) {
    epoint.alert(data.msg, '', searchData, 'info');
}

function closeCallback(data) {
    epoint.alertAndClose(data.msg, '', null, null, 'info');
}

```

要点：

- `epoint.alert(message, title, callback, icon)` 第三参是回调，第四参才是图标。
- `epoint.alertAndClose(message, title, callback, options, iconCls)` 的第四参可按项目高频写法传 `null`；只有需要自定义 `backParam/chkMsg` 等回传配置时才传配置对象。
- `epoint.alertAndRefresh(message, title, iconCls)` 只刷新父页面，不传 `ids/callback`；项目已有同类写法或确需父页提示刷新时再用。

## 控件联动

```javascript
function initCallback(data) {
    mini.get('status').setValue(data.status || '1');
    mini.get('ouguid').setText(data.ouname || '');
    mini.get('ouguid').setValue(data.ouguid || '');
    mini.get('ouguid').setEnabled(false);
    mini.get('remark').setVisible(data.needRemark == '1');
}
```

## 弹窗回填

```javascript
function chooseUser() {
    epoint.openDialog('选择人员', './userselect', function(data) {
        if (data) {
            mini.get('userguid').setValue(data.userguid);
            mini.get('username').setText(data.username);
            mini.get('username').setValue(data.username);
        }
    }, {
        width: 900,
        height: 600
    });
}
```
