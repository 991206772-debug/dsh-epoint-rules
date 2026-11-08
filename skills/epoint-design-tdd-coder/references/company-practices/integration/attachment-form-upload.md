# 表单留痕附件上传

用于“表单里上传普通相关附件/评审资料/附件留痕”的高频场景。公司项目附件默认使用 `mini-webuploader`。核心闭环是：上传使用稳定附件标识，保存业务数据时写回同一个标识，详情页再用同一个标识只读展示。

## 判断

- 新增未保存记录：首次 `!isPostback()` 生成一次附件标识并 `addViewData`。
- 编辑已有记录：优先使用数据库已有附件标识；为空时只生成一次并保存。
- 详情/查看页：使用业务记录已有主键或附件字段，不生成新附件标识。
- 字段名跟项目走，`clientguid` 只是示例；项目已有 `cliengGuid`、`attachguid`、`fileguid` 时沿用。
- 控件类型用 `mini-webuploader`；不要主动引入其他上传控件。

## 新增页和详情页差异

| 场景 | HTML 写法 | JS 行为 | 后台附件标识 |
| --- | --- | --- | --- |
| 新增/编辑页上传 | `starred="true"`、`required="true"`、`limitType="..."`，可按业务需要写红色提示 | 保存前走 `epoint.validate()`，保存回调处理 `fail/msg` | 新记录首次生成附件标识并 `addViewData`；保存业务数据时把同一个标识写入业务主键或附件字段 |
| 详情/查看页展示 | 不写 `required`，用 `showDefaultUI="true"`、`enabled="true"` 先加载已有附件 | `epoint.initPage(..., callback)` 完成回填后先 `mini.get(id).setEnabled(false)`，再隐藏当前控件的 `.mini-uploader-btns` 和 `.mini-uploader-remove` | 只读取业务记录已有标识；不要重新生成 UUID，也不要把详情页当新增上传页 |

详情页的 `action` 可以和新增页不同，例如新增页 `getRequireattachModel`、详情页 `getSonarlintattachModel`；关键是 HTML 的 `action` 必须匹配当前 Action 里的 getter 方法。

## 常用属性和事件

| 属性/事件 | 用法 |
| --- | --- |
| `action` | 指向当前 Action 的 `FileUploadModel9` getter，例如 `getRequireattachModel`；页面写法必须和 Java 方法名一致 |
| `fileNumLimit` | 限制文件数量，例如 `5`；按业务要求设置，不要随意放大 |
| `fileSingleSizeLimit` | 单文件大小限制，项目常见 `20480` |
| `limitType` | 限制扩展名，例如 `doc,docx,txt,rar,zip,jpg,jpeg,pdf,xls,xlsx,gif,bmp,png` |
| `mimeTypes` | 公司实战常见写 `*` 或空字符串，和项目原页面保持一致 |
| `auto` | 常见 `true`，选择文件后自动上传 |
| `required` | 只在新增/编辑页需要强制上传时写；详情页不要写 |
| `showDefaultUI` | 详情/查看页常见 `true`，独立附件列表按页面需求可设 `false` |
| `enabled` | 详情页可写 `true` 以加载已有附件，但必须在 `epoint.initPage` 回调中 `mini.get(id).setEnabled(false)`，并隐藏当前控件的上传/删除按钮；不要用它代替业务权限判断 |
| `onuploadsuccess` | 上传成功后需要联动页面状态时才写，例如更新 datagrid 当前行字段 |
| `onfileremovesuccess` | 删除附件后需要联动页面状态时才写，例如附件为空时清空 datagrid 当前行状态 |
| `onuploadfinished` | 上传批次完成后刷新列表或查询时写，例如 `onuploadfinished="searchData"` |

普通“上传并随表单保存”的场景不需要事件回调；只有业务明确要求“上传/删除后立即改变页面字段、按钮状态、列表状态”时才补事件函数。

## 上传后联动行状态

当附件控件绑定的是“当前行/当前事项”的材料，且业务要求上传后把该行标记为已上传、删除后恢复为空，可以在控件上挂事件：

```html
<div id="rowattach" class="mini-webuploader"
     action="getRowAttachModel" fileNumLimit="1"
     auto="true" mimeTypes="*"
     onuploadsuccess="uploadSuccess"
     onfileremovesuccess="fileRemoveSuccess"></div>
```

```javascript
function uploadSuccess(e) {
    var row = datagrid.getSelected();
    if (row) {
        datagrid.updateRow(row, 'attachstatus', '已上传');
    }
}

function fileRemoveSuccess(e) {
    var uploader = mini.get('rowattach');
    var row = datagrid.getSelected();
    if (row && uploader && !uploader.getFileList().hasChildNodes()) {
        datagrid.updateRow(row, 'attachstatus', '');
    }
}
```

字段名、状态值、取行方式按当前页面业务替换；不要把示例里的 `attachstatus` 当固定字段。若页面按某一列筛选行再更新，先用当前 datagrid API 找到目标行，再 `updateRow`。

## 新增页 HTML

```html
<div role="control" label="附件" starred="true">
    <div id="requireattach" class="mini-webuploader"
         action="getRequireattachModel" fileNumLimit="5"
         fileSingleSizeLimit="20480"
         limitType="doc,docx,txt,rar,zip,jpg,jpeg,pdf,xls,xlsx,gif,bmp,png"
         mimeTypes="*" auto="true" required="true"></div>
</div>
```

`action` 可以按当前页面 Action 方法名写裸方法名，也可以按项目样例写 `xxxaction.getXxxModel`；关键是页面 action 与 Java getter 方法一致。

## 新增页 Action

```java
@Autowired
private IAttachService attachService;

private FileUploadModel9 requireUploadModel;
private String clientguid;

public void pageLoad() {
    if (!isPostback()) {
        if (StringUtil.isBlank(clientguid)) {
            clientguid = UUID.randomUUID().toString();
        }
        addViewData("clientguid", clientguid);
    }
}

public FileUploadModel9 getRequireattachModel() {
    if (requireUploadModel == null) {
        AttachHandler9 handler = new AttachHandler9() {
            private static final long serialVersionUID = 1L;

            @Override
            public void afterSaveAttachToDB(Object attach) {
            }

            @Override
            public boolean beforeSaveAttachToDB(AttachStorage attachStorage) {
                return true;
            }
        };

        requireUploadModel = new FileUploadModel9(new DefaultFileUploadHandlerImpl9(
                getViewData("clientguid"), null, null, handler,
                userSession.getUserGuid(), userSession.getDisplayName()));
    }
    return requireUploadModel;
}

public void add() {
    int count = attachService.getAttachCountByClientGuid(getViewData("clientguid"));
    if (count == 0) {
        addCallbackParam("fail", "请上传附件！");
        return;
    }

    dataBean.setRowguid(getViewData("clientguid"));
    service.insert(dataBean);
    addCallbackParam("msg", "保存成功！");
}
```

如果附件标识不是业务主键，而是业务实体里的附件字段，就把同一个 `getViewData(...)` 写入该附件字段。不能另起一个 UUID。

## 保存回调

```javascript
function closeCallback(data) {
    if (data.fail) {
        epoint.alert(data.fail);
        return;
    }
    if (data.msg) {
        epoint.alertAndClose(data.msg, '', null, null, 'info');
    }
}
```

## 详情页 HTML

```html
<div role="control" label="附件">
    <div id="requireattach" class="mini-webuploader"
         action="getRequireattachModel" fileNumLimit="5"
         showDefaultUI="true" fileSingleSizeLimit="20480"
         mimeTypes="*" auto="true" enabled="true"></div>
</div>
```

## 详情页 JS

```javascript
epoint.initPage('xxxdetailaction', '', function(data) {
    var uploader = mini.get('requireattach');
    if (uploader) {
        uploader.setEnabled(false);
    }
    $('#requireattach').find('.mini-uploader-btns, .mini-uploader-remove').hide();
});
```

## 详情页 Action

```java
private FileUploadModel9 requireUploadModel;
private String clientguid;

public void pageLoad() {
    String guid = getRequestParameter("guid");
    dataBean = service.get(guid);
    if (dataBean != null) {
        clientguid = dataBean.getRowguid();
    }
}

public FileUploadModel9 getRequireattachModel() {
    if (requireUploadModel == null) {
        AttachHandler9 handler = new AttachHandler9() {
            private static final long serialVersionUID = 1L;

            @Override
            public void afterSaveAttachToDB(Object attach) {
            }

            @Override
            public boolean beforeSaveAttachToDB(AttachStorage attachStorage) {
                return true;
            }
        };

        requireUploadModel = new FileUploadModel9(new DefaultFileUploadHandlerImpl9(
                clientguid, null, null, handler,
                userSession.getUserGuid(), userSession.getDisplayName()));
    }
    return requireUploadModel;
}
```

## 自检

- 上传模型、附件数量校验、业务保存、详情加载使用同一个附件标识。
- 详情页不生成新附件标识。
- 详情页在 `initPage` 回调中关闭 uploader，并隐藏当前控件的上传和删除入口。
- `action="getRequireattachModel"` 与 Java `getRequireattachModel()` 一致。
- 普通表单留痕附件不生成附件 datagrid。
