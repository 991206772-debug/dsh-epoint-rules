# 字典、状态、弹窗写法示例

用于代码项下拉、状态启停/发布、弹窗选择和父页面回填。

字段名提醒：本文件的 `type`、`status`、`updateStatus` 都是示例命名。真实字段名和方法名要表达业务语义，并沿用工作包列出的项目同类代码，例如 `isuse`、`publishstate`、`auditstatus` 或已确认命名；没有精确引用时，用当前字段/对象键检索相近实现，命中后停止。

## 字典/代码项

Action：

```java
@SuppressWarnings("unchecked")
public List<SelectItem> getTypeModel() {
    if (typeModel == null) {
        typeModel = DataUtil.convertMap2ComboBox(
                (List<Map<String, String>>) CodeModalFactory.factory("下拉列表", "业务类型", null, false));
    }
    return typeModel;
}
```

查询页通常追加“全部/请选择”：

```java
CodeModalFactory.factory("下拉列表", "业务类型", null, true)
```

页面：

```html
<input class="mini-combobox" bind="dataBean.type" action="getTypeModel"
       textField="text" valueField="id" emptyText="请选择..." />

<div field="type" data-options="{code:'业务类型'}">业务类型</div>
```

要点：

- 字典名必须来自需求或项目代码项，不要自己编。
- 单选按钮组可参考项目样例 `CodeModalFactory.factory("单选按钮组", "...")`。

## 状态操作

Action：

```java
public void publish() {
    String guid = getRequestParameter("guid");
    service.publish(guid);
    addCallbackParam("msg", "发布成功！");
}
```

Service：

```java
public void publish(String guid) {
    XxxInfo entity = baseDao.find(XxxInfo.class, guid);
    if (entity == null) {
        throw new RuntimeException("记录不存在");
    }
    if (!"0".equals(entity.getStatus())) {
        throw new RuntimeException("只有草稿状态可以发布");
    }
    entity.setStatus("1");
    baseDao.update(entity);
}
```

页面：

```javascript
function publish(id) {
    epoint.confirm('确认发布吗?', '', function() {
        epoint.execute('publish?guid=' + id, '', function(d) {
            epoint.alert(d.msg, '', searchData);
        });
    });
}
```

要点：

- 状态枚举必须和表字段/代码项一致。
- “被引用不能删”“停用不能发布”等规则必须写在 Service。

## 弹窗选择

父页面打开并回填：

```javascript
function selectTask() {
    epoint.openDialog('选择事项', './taskselect', function(data) {
        if (!data || data == 'close') {
            return;
        }
        mini.get('taskguid').setValue(data.rowguid);
        mini.get('taskname').setValue(data.taskname);
    }, {width: 900, height: 650});
}
```

选择页：

```html
<div class="fui-toolbar">
    <a class="mini-button" onclick="selectData">确定选择</a>
    <a class="mini-button" onclick="epoint.closeDialog('close')">取消选择</a>
</div>
<div id="datagrid" class="mini-datagrid" idField="rowguid" action="getDataGridData"
     showPager="true" multiSelect="false">
    <div property="columns">
        <div type="checkcolumn" width="40"></div>
        <div field="taskname" width="200">事项名称</div>
    </div>
</div>
<script src="../../rest/resource/jsboot"></script>
<script>
    epoint.initPage('taskselectaction');

    function selectData() {
        var row = mini.get('datagrid').getSelected();
        if (!row) {
            epoint.alert('请选择记录!');
            return;
        }
        epoint.closeDialog(row);
    }
</script>
```

要点：

- 单选/多选要确认。
- 回填必须同时保留 guid 和显示名。
- 选择页 Action 仍按 `DataGridModel` 查询分页。
