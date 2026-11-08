# 独立附件列表

仅用于需求明确需要附件独立列表、批量删除、预览列或附件管理页的场景。普通表单留痕附件请读 `attachment-form-upload.md`。

## Action

```java
import java.util.List;

import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.context.annotation.Scope;
import org.springframework.web.bind.annotation.RestController;

import com.epoint.basic.controller.BaseController;
import com.epoint.basic.faces.fileupload.AttachHandler9;
import com.epoint.basic.faces.fileupload.AttachStorage;
import com.epoint.basic.faces.fileupload.FileUploadModel9;
import com.epoint.basic.faces.tree.DefaultFileUploadHandlerImpl9;
import com.epoint.core.dto.model.DataGridModel;
import com.epoint.frame.service.attach.api.IAttachService;
import com.epoint.frame.service.attach.entity.FrameAttachInfo;

@RestController("xxxattachlistaction")
@Scope("request")
public class XxxAttachListAction extends BaseController {
    @Autowired
    private IAttachService attachService;

    private DataGridModel<FrameAttachInfo> model;
    private FileUploadModel9 attachUploadModel;

    private AttachHandler9 handler = new AttachHandler9() {
        @Override
        public void afterSaveAttachToDB(Object attach) {
            attachUploadModel.getExtraDatas().put("msg", "上传成功");
        }

        @Override
        public boolean beforeSaveAttachToDB(AttachStorage attachStorage) {
            return true;
        }
    };

    public FileUploadModel9 getFileUploadModel() {
        if (attachUploadModel == null) {
            String attachKey = getRequestParameter("attachKey");
            attachUploadModel = new FileUploadModel9(new DefaultFileUploadHandlerImpl9(
                    attachKey, "业务上传", null, handler,
                    userSession.getUserGuid(), userSession.getDisplayName()));
        }
        return attachUploadModel;
    }

    public DataGridModel<FrameAttachInfo> getDataGridData() {
        if (model == null) {
            model = new DataGridModel<FrameAttachInfo>() {
                @Override
                public List<FrameAttachInfo> fetchData(int first, int pageSize, String sortField, String sortOrder) {
                    String attachKey = getRequestParameter("attachKey");
                    List<FrameAttachInfo> list = attachService.getAttachInfoListByGuid(attachKey);
                    this.setRowCount(list == null ? 0 : list.size());
                    return list;
                }
            };
        }
        return model;
    }

    public void delete() {
        List<String> select = getDataGridData().getSelectKeys();
        for (String attachGuid : select) {
            attachService.deleteAttachByAttachGuid(attachGuid);
        }
        addCallbackParam("msg", "成功删除！");
    }
}
```

`attachKey` 只是附件标识概念名，生成时跟项目请求参数和历史命名走。

## 页面

```html
<div id="fileuploader" pickerText="选择文件上传" class="mini-webuploader"
     action="xxxattachlistaction.getFileUploadModel" fileNumLimit="20"
     limitType="doc,docx,txt,rar,zip,jpg,jpeg,pdf,xls,xlsx,gif,bmp,png"
     auto="true" onuploadfinished="searchData" showDefaultUI="false"></div>

<div id="datagrid" class="mini-datagrid" idField="attachguid" action="getDataGridData"
     multiSelect="true" showPager="false">
    <div property="columns">
        <div type="checkcolumn"></div>
        <div field="attachfilename" headerAlign="center">附件名称</div>
        <div field="uploaddatetime" width="140" headerAlign="center"
             data-options="{'format':'yyyy-MM-dd HH:mm:ss'}">添加时间</div>
        <div width="40" align="center" headerAlign="center" renderer="onViewRenderer">查看</div>
    </div>
</div>

<script>
    epoint.initPage('xxxattachlistaction');

    function deleteSelected() {
        epoint.execute('xxxattachlistaction.delete', 'datagrid', '', searchData, true);
    }

    var onViewRenderer = function(e) {
        return epoint.renderCell(e, "action-icon icon-search", "openView");
    };

    function openView(id) {
        var url = _rootPath + "/rest/frame/base/attach/attachAction/getContent?isCommondto=true&attachGuid=" + id;
        window.open(url);
    }

    function searchData() {
        epoint.refresh();
    }
</script>
```

边界：

- `window.open` 只用于后端框架附件内容 URL、后端已确认返回的文件流/预览 URL。
- 不要用 `window.open/window.close` 替代业务弹窗、选择页、详情页或结果页。
- 不要在页面手写第三方文件地址；需要外部接口返回文件地址时，先闭合到 Action/Service 校验后再返回给前端。
