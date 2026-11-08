#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""Render workflow Action and page skeletons."""

import argparse
import json
from datetime import date


RULE_ALIAS = "工作流代码生成规范"
FILE_KIND = "Workflow"
REQUIRED_FIELDS = [
    "moduleName",
    "pageName",
    "tableName",
    "tableDisplayName",
    "entityClassName",
    "serviceInterface",
]


def _read_json(path):
    if not path:
        return {}
    with open(path, "r", encoding="utf-8") as handle:
        return json.load(handle)


def _missing(context):
    return [name for name in REQUIRED_FIELDS if not str(context.get(name) or "").strip()]


def _render_template(template, values):
    rendered = template
    for key, value in values.items():
        rendered = rendered.replace("{{" + key + "}}", str(value))
    return rendered


def render(context):
    missing = _missing(context)
    if missing:
        return {
            "ok": False,
            "fileKind": FILE_KIND,
            "ruleAlias": RULE_ALIAS,
            "errorCode": "WORKFLOW_SKELETON_CONTEXT_MISSING",
            "missingFields": missing,
        }
    workflow_contract = context.get("workflowContract") if isinstance(context.get("workflowContract"), dict) else {}
    values = {
        "moduleName": str(context["moduleName"]).strip(),
        "pageName": str(context["pageName"]).strip(),
        "tableName": str(context["tableName"]).strip(),
        "tableDisplayName": str(context["tableDisplayName"]).strip(),
        "workflowProcessName": str(context.get("workflowProcessName") or workflow_contract.get("processName") or context.get("tableDisplayName") or "").strip(),
        "actionPackageName": str(context.get("actionPackageName") or "").strip(),
        "actionClassName": str(context.get("actionClassName") or "").strip(),
        "controllerBeanName": str(context.get("controllerBeanName") or "").strip(),
        "entityClassName": str(context["entityClassName"]).strip(),
        "serviceInterface": str(context["serviceInterface"]).strip(),
        "entityImportLine": _import_line(context.get("entityImport")),
        "serviceImportLine": _import_line(context.get("serviceImport")),
        "serviceField": str(context.get("serviceField") or "service").strip(),
        "author": str(context.get("author") or "AI自动生成").strip(),
        "date": str(context.get("date") or date.today().isoformat()).strip(),
    }
    section_key = str(context.get("sectionKey") or "").strip()
    file_kind = str(context.get("fileKind") or "").strip()
    if not values["controllerBeanName"]:
        values["controllerBeanName"] = _fallback_controller_bean_name(values, section_key)
    if not file_kind:
        return {
            "ok": True,
            "fileKind": FILE_KIND,
            "ruleAlias": RULE_ALIAS,
            "files": [
                {
                    "fileKind": "Action",
                    "suggestedFileName": values["actionClassName"] + ".java",
                    "content": _render_template(ACTION_TEMPLATE, values),
                },
                {
                    "fileKind": "HtmlPage",
                    "suggestedFileName": values["pageName"] + "workflow.html",
                    "content": _render_template(HTML_TEMPLATE, values),
                },
            ],
        }
    if file_kind == "Action":
        if section_key == "WorkflowMyListAction":
            template = MYLIST_ACTION_TEMPLATE
        else:
            template = ACTION_TEMPLATE
        suggested = str(context.get("targetFileName") or values["actionClassName"] + ".java").strip()
    elif file_kind == "HtmlPage":
        if section_key == "WorkflowMyListHtmlPage":
            template = MYLIST_HTML_TEMPLATE
            suggested = str(context.get("targetFileName") or values["pageName"] + "mylist.html").strip()
        elif section_key == "WorkflowDetailHtmlPage":
            template = WORKFLOW_DETAIL_HTML_TEMPLATE
            suggested = str(context.get("targetFileName") or values["pageName"] + "workflowdetail.html").strip()
        else:
            template = HTML_TEMPLATE
            suggested = str(context.get("targetFileName") or values["pageName"] + "workflow.html").strip()
    else:
        return {
            "ok": False,
            "fileKind": FILE_KIND,
            "ruleAlias": RULE_ALIAS,
            "errorCode": "WORKFLOW_SKELETON_FILE_KIND_UNSUPPORTED",
            "missingFields": ["fileKind"],
        }
    return {
        "ok": True,
        "fileKind": FILE_KIND,
        "ruleAlias": RULE_ALIAS,
        "files": [
            {
                "fileKind": file_kind,
                "suggestedFileName": suggested,
                "content": _render_template(template, values),
            },
        ],
    }


def _import_line(value):
    text = str(value or "").strip()
    if not text:
        return ""
    if text.startswith("import "):
        return text if text.endswith(";") else text + ";"
    return "import " + text + ";"


def _fallback_controller_bean_name(values, section_key):
    class_name = str((values or {}).get("actionClassName") or "").strip()
    if class_name:
        return class_name.lower()
    page_name = str((values or {}).get("pageName") or "").strip()
    if section_key == "WorkflowMyListAction" or section_key == "WorkflowMyListHtmlPage":
        return page_name + "mylistaction"
    return page_name + "workflowaction"


ACTION_TEMPLATE = """package {{actionPackageName}};

import java.util.Date;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import com.alibaba.fastjson.JSONObject;
import com.epoint.basic.faces.util.DataUtil;
import com.epoint.core.dto.model.SelectItem;
import com.epoint.core.utils.convert.ConvertUtil;
import com.epoint.core.utils.sql.SqlConditionUtil;
import com.epoint.core.utils.string.StringUtil;
import com.epoint.frame.service.metadata.mis.util.CodeModalFactory;
import com.epoint.workflow.controller.execute.WorkflowBaseController;
import com.epoint.workflow.service.common.custom.ProcessVersionInstance;
import com.epoint.workflow.service.common.entity.config.WorkflowActivityOperation;
import com.epoint.workflow.service.common.entity.execute.WorkflowWorkItem;
import com.epoint.workflow.service.common.util.WorkflowKeyNames9;
import com.epoint.workflow.service.core.api.IWFDefineAPI9;
import com.epoint.workflow.service.core.api.IWFEngineAPI9;
import com.epoint.workflow.service.core.api.IWFInitPageAPI9;
import com.epoint.workflow.service.core.api.IWFInstanceAPI9;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.context.annotation.Scope;
import org.springframework.web.bind.annotation.RestController;
{{entityImportLine}}
{{serviceImportLine}}

/**
 * {{tableDisplayName}}工作流页面对应后台
 *
 * @author {{author}}
 * @version 1.0, {{date}}
 */
@RestController("{{controllerBeanName}}")
@Scope("request")
public class {{actionClassName}} extends WorkflowBaseController {

    private static final long serialVersionUID = 1L;

    @Autowired
    private IWFInstanceAPI9 instanceapi;

    @Autowired
    private IWFInitPageAPI9 initapi;

    @Autowired
    private IWFDefineAPI9 defineapi;

    @Autowired
    private IWFEngineAPI9 engineapi;

    @Autowired
    private {{serviceInterface}} {{serviceField}};

    private String workitemGuid;
    private String activityGuid;
    private String processVersionInstanceGuid;
    private ProcessVersionInstance pvi = null;
    private {{entityClassName}} dataBean = null;
    private String SQLTableName = "{{tableName}}";
    private String rowguid;
    private String userGuid;
    private WorkflowWorkItem item;

    @Override
    public void pageLoad() {
        workitemGuid = getRequestParameter("WorkItemGuid");
        processVersionInstanceGuid = getRequestParameter("ProcessVersionInstanceGuid");
        pvi = instanceapi.getProcessVersionInstance(processVersionInstanceGuid);
        if (pvi != null && StringUtil.isNotBlank(workitemGuid)) {
            item = instanceapi.getWorkItem(pvi, workitemGuid);
            if (item != null) {
                activityGuid = item.getActivityGuid();
                processVersionInstanceGuid = item.getProcessVersionInstanceGuid();
                pvi = instanceapi.getProcessVersionInstance(processVersionInstanceGuid);
            }
        }

        rowguid = getRequestParameter("guid");
        if (StringUtil.isBlank(rowguid) && pvi != null) {
            rowguid = instanceapi.getContextItemValue(pvi, SQLTableName);
        }
        if (StringUtil.isNotBlank(rowguid)) {
            dataBean = {{serviceField}}.find(rowguid);
        }
        if (dataBean == null && StringUtil.isNotBlank(processVersionInstanceGuid)) {
            SqlConditionUtil sqlConditionUtil = new SqlConditionUtil();
            sqlConditionUtil.eq("pviguid", processVersionInstanceGuid);
            dataBean = {{serviceField}}.find(sqlConditionUtil.getMap());
            if (dataBean != null) {
                rowguid = dataBean.getRowguid();
            }
        }
        if (dataBean == null) {
            dataBean = new {{entityClassName}}();
        }
        userGuid = userSession.getUserGuid();

        JSONObject jsonobject = new JSONObject();
        jsonobject.put("activityGuid", activityGuid);
        jsonobject.put("issingleform", true);
        jsonobject.put("processversioninstanceguid", processVersionInstanceGuid);
        addCallbackParam("accessRight", initapi.init_getTablePropertyControl(jsonobject.toString()).toString());
    }

    public void submit() {
        if (save()) {
            instanceapi.singlematerialSubmit(pvi, SQLTableName, rowguid, userGuid, true);
        }
    }

    public void saveForm() {
        save();
    }

    private boolean save() {
        if (StringUtil.isBlank(rowguid)) {
            rowguid = UUID.randomUUID().toString();
            dataBean.setRowguid(rowguid);
            dataBean.setOperatedate(new Date());
            dataBean.setOperateusername(userSession.getDisplayName());
            dataBean.setOperateuserguid(userSession.getUserGuid());
            dataBean.setPviguid(processVersionInstanceGuid);
            {{serviceField}}.insert(dataBean);
        }
        else {
            rowguid = dataBean.getRowguid();
            dataBean.setOperatedate(new Date());
            dataBean.setOperateusername(userSession.getDisplayName());
            dataBean.setOperateuserguid(userSession.getUserGuid());
            dataBean.setPviguid(processVersionInstanceGuid);
            {{serviceField}}.update(dataBean);
        }
        if (pvi != null && StringUtil.isNotBlank(rowguid)) {
            instanceapi.createOrUpdateContext(pvi, SQLTableName, rowguid, 2);
        }
        addCallbackParam("msg", "");
        return true;
    }

    public String getPageUrlOfOperate(String data, String transitionGuid) {
        JSONObject jsonobject = JSONObject.parseObject(data);
        jsonobject.put("userguid", StringUtil.isNotBlank(userGuid) ? userGuid : userSession.getUserGuid());
        if (StringUtil.isNotBlank(getRequestParameter("batchHandleGuid"))) {
            jsonobject.put("otherurlparam", "batchHandleGuid=" + getRequestParameter("batchHandleGuid"));
        }
        JSONObject returnobject = JSONObject.parseObject(initapi.init_getPageUrlOfOperate(jsonobject.toString()));
        String operationGuid = jsonobject.getString("operationguid");
        WorkflowActivityOperation operation = StringUtil.isNotBlank(operationGuid)
                ? defineapi.getActOperation(pvi, operationGuid) : new WorkflowActivityOperation();
        String message = "";
        if (returnobject.containsKey("isdefoperation")) {
            boolean isdefault = ConvertUtil.convertStringToBoolean(returnobject.getString("isdefoperation"));
            if (isdefault) {
                return getoperate(jsonobject.toString());
            }
        }
        if (returnobject.containsKey("url")) {
            String url = returnobject.getString("url");
            if (StringUtil.isNotBlank(url)) {
                returnobject.put("operationtype", operation.getOperationType());
                return returnobject.toString();
            }
        }
        if (returnobject.containsKey("message")) {
            message = returnobject.getString("message");
        }
        return finaloperate(message, operation);
    }

    public String getoperate(String data) {
        JSONObject jsonobject = JSONObject.parseObject(data);
        jsonobject.put("userguid", userSession.getUserGuid());
        jsonobject.put("displayname", userSession.getDisplayName());
        String json = jsonobject.toString();
        JSONObject returnjsonobject = new JSONObject();
        returnjsonobject.put("message", "");
        try {
            // 工作流操作后的业务由设计阶段 XML 注册的 ServiceInternal 外部方法执行。
            engineapi.operate(json);
        }
        catch (RuntimeException e) {
            e.printStackTrace();
            String message = e.getMessage();
            if (e.getCause() != null && e.getCause().getCause() != null
                    && StringUtil.isNotBlank(e.getCause().getCause().getMessage())) {
                message = e.getCause().getCause().getMessage();
            }
            returnjsonobject.put("message", message);
        }
        return returnjsonobject.toString();
    }

    private String finaloperate(String message, WorkflowActivityOperation operation) {
        JSONObject returnjsonobject = new JSONObject();
        returnjsonobject.put("operationtype", operation == null ? "" : operation.getOperationType());
        returnjsonobject.put("message", StringUtil.isBlank(message) ? "" : message);
        return returnjsonobject.toString();
    }

    public void workItem_Unlock(String tag) {
        String msg = "";
        if (pvi != null && pvi.getPvi().getLockStatus() == WorkflowKeyNames9.TrueOrFalse_Ture) {
            instanceapi.unlockPvi(pvi);
            msg = "refresh";
        }
        else if (pvi != null && StringUtil.isNotBlank(workitemGuid)) {
            boolean isLock = instanceapi.workItemUnlock(pvi, workitemGuid);
            if (isLock && StringUtil.isNotBlank(tag) && "norm".equals(tag)) {
                msg = "refresh";
            }
        }
        addCallbackParam("msg", msg);
    }

    public void setDataBean({{entityClassName}} dataBean) {
        this.dataBean = dataBean;
    }

    public {{entityClassName}} getDataBean() {
        return dataBean;
    }
}
"""


HTML_TEMPLATE = """<!DOCTYPE html>
<html>
<head>
    <title>{{tableDisplayName}}工作流</title>
    <meta charset="UTF-8"/>
    <meta http-equiv="X-UA-Compatible" content="IE=edge"/>
    <script src="../../frame/fui/js/cssboot.js"></script>
</head>
<body>
<div class="page-loading"></div>

<div class="fui-toolbar">
    <div class="uc-handlecontrols" id="handlecontrols" action="handlecontrolsaction.handleCtrl" style="width: 100%"></div>
</div>

<div class="fui-content">
    <div class="fui-accordions">
        <div role="accordion" opened="true">
            <div role="head" title="表单填写"></div>
            <div role="body">
                <!-- AI_KEEP[WORKFLOW_OPERATE_HOOK]: 隐藏的 btnSaveFrom/btnSubmit 是流程引擎回调锚点，
                uc-handlecontrols 动态渲染的流程按钮按 id 触发它们；禁止删除、改 id 或改成可见按钮。
            页面自己不得再加保存、提交、审批、退回按钮；操作后的业务由设计阶段 XML 注册的 ServiceInternal 外部方法执行。 -->
                <div class="hidden">
                    <a class="mini-button" id="btnSaveFrom" onclick="saveFrom();">保存</a>
                    <a class="mini-button" id="btnSubmit" onclick="submit();">提交</a>
                </div>
                <div id="fui-form" class="fui-form">
                    <div role="form"><div role="row">
                        <!-- AI_TODO[WorkflowFields]: 按业务字段补齐表单控件。
                        正例：input bind="dataBean.xxx"，代码项用 mini-combobox action="getXxxModel"。
                        禁止：ajax/fetch 提交、直接写隐藏 JSON、脱离 workflow action。 -->
                        <div role="control" label="业务字段">
                            <input class="mini-textbox" bind="dataBean.businessField" />
                        </div>
                    </div></div>
                </div>
            </div>
        </div>
        <div role="accordion">
            <div role="head" title="流程信息"></div>
            <div role="body">
                <div class="uc-workflowhistory" id="workflowhistory" action="workflowhistoryaction.historyCtrl" style="width: 100%;"></div>
            </div>
        </div>
    </div>
</div>

<!-- AI_KEEP[PAGE_BOOT_RESOURCE]: cssboot/jsboot/page-loading 是 FUI/MiniUI/epoint 页面启动资源，业务 patch 禁止移除或挪动；业务 JS 写在 jsboot 后面的 inline script 内。 -->
<script src="../../rest/resource/jsboot"></script>
<script src="../../frame/pages/epointworkflow/js/workflowjsboot.js"></script>
<script src="../../frame/pages/epointworkflow/js/tableproperty.js"></script>
<script>
    epoint.initPage('{{controllerBeanName}}', '', function(data) {
        setControlsAccessRight(data);
    });

    function saveFrom() {
        if (epoint.validate()) {
            epoint.execute('saveForm', 'fui-form', newCallback);
        }
        else {
            ShowTdOperate(true);
        }
    }

    function submit() {
        if (epoint.validate()) {
            epoint.execute('saveForm', 'fui-form', newCallback);
        }
        else {
            ShowTdOperate(true);
        }
    }

    function newCallback(data) {
        if (data && data.msg) {
            epoint.alert(data.msg, '', null, 'info');
            ShowTdOperate(true);
        }
        else {
            HeaderSubmit();
        }
    }
</script>
</body>
</html>
"""


MYLIST_ACTION_TEMPLATE = """package {{actionPackageName}};

import java.util.List;
import java.util.Map;
import org.apache.logging.log4j.LogManager;
import org.apache.logging.log4j.Logger;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.context.annotation.Scope;
import org.springframework.web.bind.annotation.RestController;
import com.epoint.basic.controller.BaseController;
import com.epoint.basic.faces.util.DataUtil;
import com.epoint.core.utils.collection.EpointCollectionUtils;
import com.epoint.core.dto.model.DataGridModel;
import com.epoint.core.dto.model.SelectItem;
import com.epoint.core.utils.date.EpointDateUtil;
import com.epoint.core.utils.sql.SqlConditionUtil;
import com.epoint.core.utils.string.StringUtil;
import com.epoint.database.peisistence.crud.impl.model.PageData;
import com.epoint.frame.service.metadata.mis.util.CodeModalFactory;
import com.epoint.frame.service.metadata.mis.util.ListGenerator;
import com.epoint.workflow.service.common.entity.config.WorkflowProcess;
import com.epoint.workflow.service.config.api.IWorkflowProcessService;
{{entityImportLine}}
{{serviceImportLine}}

/**
 * {{tableDisplayName}}我的流程列表后台
 *
 * @author {{author}}
 * @version 1.0, {{date}}
 */
@RestController("{{controllerBeanName}}")
@Scope("request")
public class {{actionClassName}} extends BaseController {

    private static Logger logger = LogManager.getLogger({{actionClassName}}.class);

    @Autowired
    private {{serviceInterface}} {{serviceField}};

    @Autowired
    private IWorkflowProcessService workflowProcessService;

    private {{entityClassName}} dataBean;
    private DataGridModel<{{entityClassName}}> model;
    private String {codeItem};

    public void pageLoad() {
        dataBean = new {{entityClassName}}();
        addCallbackParam("processGuid", getProcessGuidByProcessName("{{workflowProcessName}}"));
    }

    private String getProcessGuidByProcessName(String processName) {
        String processGuid = "";
        List<WorkflowProcess> workflowProcessList = this.workflowProcessService.selectByProcessName(processName);
        if (EpointCollectionUtils.isNotEmpty(workflowProcessList)) {
            processGuid = workflowProcessList.get(0).getProcessGuid();
        }
        return processGuid;
    }

    public DataGridModel<{{entityClassName}}> getMyDataGridData() {
        if (model == null) {
            model = new DataGridModel<{{entityClassName}}>() {
                @Override
                public List<{{entityClassName}}> fetchData(int first, int pageSize, String sortField, String sortOrder) {
                    Map<String, Object> conditionMap = ListGenerator.getSearchMap(getRequestContext().getComponents(), sortField, sortOrder);
                    SqlConditionUtil sqlConditionUtil = new SqlConditionUtil();
                    sqlConditionUtil.eq("operateuserguid", userSession.getUserGuid());
                    // 代码项精确查询
                    if (StringUtil.isNotBlank({codeItem})) {
                        sqlConditionUtil.eq("{codeItemField}", {codeItem});
                    }
                    // 示例：时间区间查询绑定 query_start_dateStart/query_start_dateEnd，由 Builder 按日期字段展开。
                    conditionMap.putAll(sqlConditionUtil.getMap());
                    PageData<{{entityClassName}}> pageData = {{serviceField}}.paginatorList(conditionMap, first, pageSize);
                    setRowCount(pageData.getRowCount());
                    return pageData.getList();
                }
            };
        }
        return model;
    }

    // 代码项搜索列表数据源示例（注意：列表作为条件查询时，最后一个参数必然传 true 以追加"请选择"空项）：
    // private List<SelectItem> xxxModel;
    // public List<SelectItem> getXxxModel() {
    //     if (xxxModel == null) xxxModel = DataUtil.convertMap2ComboBox(
    //         (List<Map<String, String>>) CodeModalFactory.factory("下拉列表", "{CodeItemCode}", null, true));
    //     return xxxModel;
    // }

    public {{entityClassName}} getDataBean() {
        if (dataBean == null) {
            dataBean = new {{entityClassName}}();
        }
        return dataBean;
    }

    public void setDataBean({{entityClassName}} dataBean) {
        this.dataBean = dataBean;
    }
}
"""


MYLIST_HTML_TEMPLATE = """<!DOCTYPE html>
<html>
<head>
    <title>{{tableDisplayName}}我的流程</title>
    <meta charset="UTF-8"/>
    <meta http-equiv="X-UA-Compatible" content="IE=edge"/>
    <script src="../../frame/fui/js/cssboot.js"></script>
</head>
<body>
<div class="page-loading"></div>
<div class="fui-toolbar">
    <a class="mini-button" iconCls="icon-add" onclick="openAdd();" id="btnAddRecord">我要申请</a>
</div>
<div class="fui-condition">
    <div class="fui-form" id="fui-form">
        <div role="form">
            <div role="row">
                <div role="control" label="关键字">
                    <input class="mini-textbox" bind="searchKeyword" emptyText="请输入查询内容..." />
                </div>
            </div>
        </div>
    </div>
    <a role="searcher" callback="search" opend="true"></a>
</div>
<div class="fui-content">
    <div id="datagrid" class="mini-datagrid" action="getMyDataGridData" idField="rowguid" showPager="true" style="height:100%;" multiSelect="true">
        <div property="columns">
            <div type="checkcolumn"></div>
            <div type="indexcolumn" width="40" headerAlign="center" align="center">序号</div>
            <!-- AI_TODO[{主要字段}]: 由 Builder 按 businessColumns 展开列表列。 -->
        </div>
    </div>
</div>
<script src="../../rest/resource/jsboot"></script>
<script>
    var processGuid = "";

    epoint.initPage('{{controllerBeanName}}', '', function(data) {
        if (data && data.processGuid) {
            processGuid = data.processGuid;
        }
    });

    function search() {
        epoint.refresh(['datagrid', 'fui-form'], '', true);
    }

    function openAdd() {
        if (!processGuid) {
            epoint.alert('未查询到相关的工作流！', '', '', 'warning');
            return;
        }
        var url = 'processcreateinstance?ProcessGuid=' + processGuid;
        epoint.openTopDialog('申请',
                'frame/pages/epointworkflow/client/' + url,
                search);
    }
</script>
</body>
</html>
"""


WORKFLOW_DETAIL_HTML_TEMPLATE = """<!DOCTYPE html>
<html>
<head>
    <title>{{tableDisplayName}}查看</title>
    <meta charset="UTF-8"/>
    <meta http-equiv="X-UA-Compatible" content="IE=edge"/>
    <script src="../../frame/fui/js/cssboot.js"></script>
</head>
<body>
<div class="page-loading"></div>

<div class="fui-toolbar">
    <div class="uc-handlecontrols" id="handlecontrols" action="handlecontrolsaction.handleCtrl" style="width: 100%"></div>
</div>

<div class="fui-content">
    <div class="fui-accordions">
        <div role="accordion" opened="true">
            <div role="head" title="表单信息"></div>
            <div role="body">
                <!-- AI_KEEP[WORKFLOW_OPERATE_HOOK]: 保留流程引擎回调锚点；详情页业务字段只读，不新增业务审批按钮。 -->
                <div class="hidden">
                    <a class="mini-button" id="btnSaveFrom" onclick="saveFrom();">保存</a>
                    <a class="mini-button" id="btnSubmit" onclick="submit();">提交</a>
                </div>
                <div id="fui-form" class="fui-form">
                    <div role="form">
                        <div role="row">
                            <!-- AI_TODO[WorkflowDetailFields]: 按业务字段替换只读展示控件。 -->
                            <div role="control" label="业务字段">
                                <div class="mini-outputtext" bind="dataBean.businessField"></div>
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        </div>
        <div role="accordion">
            <div role="head" title="流程信息"></div>
            <div role="body">
                <div class="uc-workflowhistory" id="workflowhistory" action="workflowhistoryaction.historyCtrl" style="width: 100%;"></div>
            </div>
        </div>
    </div>
</div>

<!-- AI_KEEP[PAGE_BOOT_RESOURCE]: 工作流详情页必须保留页面启动资源、流程历史和权限初始化。 -->
<script src="../../rest/resource/jsboot"></script>
<script src="../../frame/pages/epointworkflow/js/workflowjsboot.js"></script>
<script src="../../frame/pages/epointworkflow/js/tableproperty.js"></script>
<script>
    epoint.initPage('{{controllerBeanName}}', '', function(data) {
        setControlsAccessRight(data);
    });

    function saveFrom() {
        if (epoint.validate()) {
            epoint.execute('saveForm', 'fui-form', newCallback);
        } else {
            ShowTdOperate(true);
        }
    }

    function submit() {
        if (epoint.validate()) {
            epoint.execute('saveForm', 'fui-form', newCallback);
        } else {
            ShowTdOperate(true);
        }
    }

    function newCallback(data) {
        if (data && data.msg) {
            epoint.alert(data.msg, '', null, 'info');
            ShowTdOperate(true);
        } else {
            HeaderSubmit();
        }
    }
</script>
</body>
</html>
"""


def _self_test():
    result = render({
        "moduleName": "demo",
        "pageName": "gxhdemo",
        "tableName": "xm_demo",
        "tableDisplayName": "示例",
        "actionPackageName": "demo.action",
        "actionClassName": "DemoWorkFlowAction",
        "entityClassName": "Demo",
        "serviceInterface": "IDemoService",
        "fileKind": "Action",
        "sectionKey": "WorkflowAction",
    })
    assert result["ok"] is True
    action = result["files"][0]["content"]
    assert "import com.epoint.workflow.controller.execute.WorkflowBaseController;" in action
    assert "import com.epoint.basic.controller.BaseController;" not in action
    assert "extends WorkflowBaseController" in action
    assert "IWFEngineAPI9" in action
    assert "WorkflowResult9" not in action
    assert "engineapi.operate" in action
    assert "try {" in action
    assert "catch (RuntimeException e)" in action
    assert "switch" not in action
    assert "singlematerialSubmit" in action
    assert "private WorkflowWorkItem item;" in action
    assert "item = instanceapi.getWorkItem(pvi, workitemGuid);" in action
    assert "processVersionInstanceGuid = item.getProcessVersionInstanceGuid();" in action
    assert "pvi = instanceapi.getProcessVersionInstance(processVersionInstanceGuid);" in action
    assert "SqlConditionUtil sqlConditionUtil = new SqlConditionUtil();" in action
    assert "sqlConditionUtil.eq(\"pviguid\", processVersionInstanceGuid);" in action
    assert "dataBean = service.find(sqlConditionUtil.getMap());" in action
    assert action.count("dataBean.setOperateuserguid(userSession.getUserGuid());") == 2
    assert action.count("dataBean.setPviguid(processVersionInstanceGuid);") == 2
    assert 'RestController("demoworkflowaction")' in action
    result = render({
        "moduleName": "demo",
        "pageName": "gxhdemo",
        "tableName": "xm_demo",
        "tableDisplayName": "示例",
        "entityClassName": "Demo",
        "serviceInterface": "IDemoService",
        "fileKind": "HtmlPage",
        "sectionKey": "WorkflowHtmlPage",
    })
    html = result["files"][0]["content"]
    assert "uc-handlecontrols" in html
    assert "handlecontrolsaction.handleCtrl" in html
    assert "workflowhistoryaction.historyCtrl" in html
    assert "epoint.execute('saveForm', 'fui-form', newCallback)" in html
    assert "AI_KEEP[WORKFLOW_OPERATE_HOOK]" in html
    assert 'id="btnSaveFrom"' in html
    assert 'id="btnSubmit"' in html
    result = render({
        "moduleName": "demo",
        "pageName": "gxhdemo",
        "tableName": "xm_demo",
        "tableDisplayName": "示例",
        "entityClassName": "Demo",
        "serviceInterface": "IDemoService",
        "fileKind": "HtmlPage",
        "sectionKey": "WorkflowMyListHtmlPage",
    })
    mylist_html = result["files"][0]["content"]
    assert 'style="height:100%;"' in mylist_html
    result = render({
        "moduleName": "demo",
        "pageName": "gxhdemo",
        "tableName": "xm_demo",
        "tableDisplayName": "示例",
        "entityClassName": "Demo",
        "serviceInterface": "IDemoService",
        "fileKind": "HtmlPage",
        "sectionKey": "WorkflowDetailHtmlPage",
    })
    assert result["ok"] is True
    workflow_detail_html = result["files"][0]["content"]
    assert result["files"][0]["suggestedFileName"] == "gxhdemoworkflowdetail.html"
    assert "mini-outputtext" in workflow_detail_html
    assert "mini-textbox" not in workflow_detail_html
    assert "uc-handlecontrols" in workflow_detail_html
    assert "workflowhistoryaction.historyCtrl" in workflow_detail_html
    assert "epoint.initPage('gxhdemoworkflowaction'" in workflow_detail_html
    assert "AI_KEEP[WORKFLOW_OPERATE_HOOK]" in workflow_detail_html


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", default="")
    parser.add_argument("--self-test", action="store_true")
    args = parser.parse_args()
    if args.self_test:
        _self_test()
        print(json.dumps({"ok": True, "selfTest": FILE_KIND}, ensure_ascii=False))
        return
    print(json.dumps(render(_read_json(args.input)), ensure_ascii=False))


if __name__ == "__main__":
    main()
