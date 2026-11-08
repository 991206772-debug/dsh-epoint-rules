#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""Render relation-config popup skeletons."""

import argparse
import json
from datetime import date


RULE_ALIAS = "关联配置弹窗开发规范"
FILE_KIND = "RelationConfigPopup"
REQUIRED_FIELDS = [
    "moduleName",
    "pageName",
    "mainName",
    "relatedName",
    "mainEntity",
    "relatedEntity",
    "relationEntity",
    "mainGuidField",
    "relatedGuidField",
    "treeRootName",
    "actionPackageName",
    "actionClassName",
    "mainServiceInterface",
    "relatedServiceInterface",
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
            "errorCode": "RELATION_CONFIG_POPUP_CONTEXT_MISSING",
            "missingFields": missing,
        }
    values = {
        "moduleName": str(context["moduleName"]).strip(),
        "pageName": str(context["pageName"]).strip(),
        "mainName": str(context["mainName"]).strip(),
        "relatedName": str(context["relatedName"]).strip(),
        "mainEntity": str(context["mainEntity"]).strip(),
        "relatedEntity": str(context["relatedEntity"]).strip(),
        "relationEntity": str(context["relationEntity"]).strip(),
        "mainGuidField": str(context["mainGuidField"]).strip(),
        "relatedGuidField": str(context["relatedGuidField"]).strip(),
        "treeRootName": str(context["treeRootName"]).strip(),
        "actionPackageName": str(context["actionPackageName"]).strip(),
        "actionClassName": str(context["actionClassName"]).strip(),
        "mainServiceInterface": str(context["mainServiceInterface"]).strip(),
        "relatedServiceInterface": str(context["relatedServiceInterface"]).strip(),
        "relationServiceInterface": str(context.get("relationServiceInterface") or "").strip(),
        "author": str(context.get("author") or "AI自动生成").strip(),
        "date": str(context.get("date") or date.today().isoformat()).strip(),
    }
    return {
        "ok": True,
        "fileKind": FILE_KIND,
        "ruleAlias": RULE_ALIAS,
        "files": [
            {
                "fileKind": "HtmlPage",
                "suggestedFileName": values["pageName"] + ".html",
                "content": _render_template(POPUP_HTML_TEMPLATE, values),
            },
            {
                "fileKind": "Action",
                "suggestedFileName": values["actionClassName"] + ".java",
                "content": _render_template(ACTION_TEMPLATE, values),
            },
            {
                "fileKind": "HtmlPatch",
                "suggestedFileName": values["pageName"] + "-parent-list-patch.html",
                "content": _render_template(PARENT_PATCH_TEMPLATE, values),
            },
        ],
    }


PARENT_PATCH_TEMPLATE = """<!-- datagrid 列定义中添加 -->
<div width="70" headerAlign="center" renderer="onConfigRenderer" align="center">
    关联{{relatedName}}
</div>

<script>
var onConfigRenderer = function(e) {
    return epoint.renderCell(e, "action-icon icon-gear", "openConfig");
};

// AI_TODO[RelationParentLinkage]:
// 目标：父列表只新增 renderer 和 openConfig，保存回调复用 searchData 刷新列表。
// 正例：epoint.renderCell + epoint.openTopDialog(..., searchData, ...)。
// 禁止：裸拼 <a onclick>、window.open、直接改父页面 datagrid 数据。
function openConfig(id) {
    epoint.openTopDialog('关联{{relatedName}}配置',
        "xmgxh/{{moduleName}}/{{pageName}}?guid=" + id,
        searchData,
        { 'width': 650, 'height': 600 });
}
</script>
"""


POPUP_HTML_TEMPLATE = """<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8" />
    <meta http-equiv="X-UA-Compatible" content="IE=edge" />
    <title>{{mainName}}{{relatedName}}配置</title>
    <script src="../../frame/fui/js/cssboot.js"></script>
</head>
<body>
<div class="page-loading"></div>

<div class="fui-toolbar">
    <div class="btn-group mr10">
        <a class="mini-button" id="addClose" onclick="saveAndClose">保存并关闭</a>
        <a class="mini-button" onclick="epoint.closeDialog('close')">取消选择</a>
    </div>
</div>

<div class="fui-content">
    <div id="tree" class="mini-tabstreeselect"
         action="getTreeModel"
         loadWhenChecked="false"
         filterMode="server"
         selectedPanelTitle="已选择{{relatedName}}"
         canCheckParent="false"
         style="width: 99%; height: 95%"
         showSelectedCount="false">
        <div tabText="{{treeRootName}}" tabKey=""></div>
    </div>
</div>

<!-- AI_KEEP[PAGE_BOOT_RESOURCE]: cssboot/jsboot/page-loading 是 FUI/MiniUI/epoint 页面启动资源，业务 patch 禁止移除或挪动；业务 JS 写在 jsboot 后面的 inline script 内。 -->
<script src="../../rest/resource/jsboot"></script>
<script>
    var mainguid = '';

    // AI_TODO[RelationPopupLinkage]:
    // 目标：弹窗 initPage('{{pageName}}action')，保存只调用 saveRelation，关闭交给 epoint.closeDialog。
    // 正例：epoint.execute('saveRelation', '@none', [guidList, mainguid], callback)。
    // 禁止：ajax/fetch、手动刷新父页、把已选节点直接写父页面 DOM。
    epoint.initPage('{{pageName}}action', '', function(data) {
        mainguid = Util.getUrlParams('guid');
    });

    function saveAndClose() {
        var selectNodes = mini.get('tree').getSelectedNodes();
        var guidList = "";
        for (var i = 0; i < selectNodes.length; i++) {
            guidList += selectNodes[i].value;
            guidList += ";";
        }
        epoint.execute('saveRelation', '@none', [guidList, mainguid], function() {
            epoint.closeDialog();
        });
    }
</script>
</body>
</html>
"""


ACTION_TEMPLATE = """package {{actionPackageName}};

import java.util.ArrayList;
import java.util.List;

import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.context.annotation.Scope;
import org.springframework.web.bind.annotation.RestController;

import com.epoint.basic.controller.BaseController;
import com.epoint.core.dto.base.TreeNode;
import com.epoint.core.dto.model.TreeModel;
import com.epoint.core.utils.string.StringUtil;

/**
 * {{mainName}}{{relatedName}}配置页面对应后台
 *
 * @author {{author}}
 * @version 1.0, {{date}}
 */
@RestController("{{pageName}}action")
@Scope("request")
public class {{actionClassName}} extends BaseController {

    private static final long serialVersionUID = 1L;

    @Autowired
    private {{mainServiceInterface}} mainService;

    @Autowired
    private {{relatedServiceInterface}} relatedService;

    private String mainguid;

    private TreeModel treeModel;

    @Override
    public void pageLoad() {
        mainguid = getRequestParameter("guid");
    }

    public TreeModel getTreeModel() {
        if (treeModel == null) {
            treeModel = new TreeModel() {
                private static final long serialVersionUID = 1L;

                @Override
                public List<TreeNode> fetch(TreeNode treeNode) {
                    List<TreeNode> list = new ArrayList<>();
                    // AI_TODO[RelationTreeFetch]: 按 {{relatedName}} 来源调用 relatedService 构造可选树节点，节点 value 必须是 {{relatedGuidField}}。
                    // 正例：只在 fetch 中组装 TreeNode 列表；已选/禁用状态从 Service 查询后映射。
                    // 禁止：Action 直接写 SQL/DAO，禁止节点 value 使用名称或非稳定主键。
                    return list;
                }
            };
        }
        return treeModel;
    }

    public void saveRelation(String guidList, String mainguid) {
        if (StringUtil.isBlank(mainguid)) {
            addCallbackParam("msg", "{{mainName}}标识不能为空");
            return;
        }
        // AI_TODO[RelationSave]: 调用 Service 清理 {{mainGuidField}}=mainguid 的旧关系，再按 guidList 写入 {{relationEntity}}。
        // 正例：解析 guidList 后由 relationService/mainService 保存关系，最后 addCallbackParam("msg", "保存成功！")。
        // 禁止：Action 直接写 DAO/SQL，禁止保存后不返回 msg。
    }
}
"""


def _self_test():
    result = render({
        "moduleName": "demo",
        "pageName": "demouserconfig",
        "mainName": "窗口",
        "relatedName": "人员",
        "mainEntity": "Window",
        "relatedEntity": "User",
        "relationEntity": "WindowUser",
        "mainGuidField": "windowguid",
        "relatedGuidField": "userguid",
        "treeRootName": "所有部门",
        "actionPackageName": "demo.action",
        "actionClassName": "DemoUserConfigAction",
        "mainServiceInterface": "IWindowService",
        "relatedServiceInterface": "IUserService",
    })
    assert result["ok"] is True
    html = result["files"][0]["content"]
    action = result["files"][1]["content"]
    assert "mini-tabstreeselect" in html
    assert "saveRelation" in action
    assert "userguid" in action


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
