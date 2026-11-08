#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""Render left-tree/right-table page and Action skeletons."""

import argparse
import json
from datetime import date


RULE_ALIAS = "左树右表开发规范"
FILE_KIND = "LeftTreeRightTable"
REQUIRED_FIELDS = [
    "moduleName",
    "pageName",
    "featureName",
    "treeTitle",
    "treeAction",
    "treeNodeIdField",
    "searchField",
    "columns",
    "actionPackageName",
    "actionClassName",
    "entityClassName",
    "serviceInterface",
]


def _read_json(path):
    if not path:
        return {}
    with open(path, "r", encoding="utf-8") as handle:
        return json.load(handle)


def _missing(context):
    missing = [name for name in REQUIRED_FIELDS if not context.get(name)]
    if isinstance(context.get("columns"), list) and context.get("columns"):
        missing = [name for name in missing if name != "columns"]
    return missing


def _render_template(template, values):
    rendered = template
    for key, value in values.items():
        rendered = rendered.replace("{{" + key + "}}", str(value))
    return rendered


def _render_columns(columns):
    lines = []
    for col in columns or []:
        field = str((col or {}).get("field") or "").strip()
        title = str((col or {}).get("title") or field).strip()
        width = str((col or {}).get("width") or "120").strip()
        if field:
            lines.append(f'                    <div field="{field}" headerAlign="center" width="{width}">{title}</div>')
    return "\n".join(lines)


def _render_search_controls(context):
    field = str(context["searchField"]).strip()
    label = str(context.get("searchLabel") or field).strip()
    return (
        f'                        <div role="control" label="{label}">\n'
        f'                            <input bind="{field}" class="mini-textbox" />\n'
        "                        </div>"
    )


def render(context):
    missing = _missing(context)
    if missing:
        return {
            "ok": False,
            "fileKind": FILE_KIND,
            "ruleAlias": RULE_ALIAS,
            "errorCode": "LEFT_TREE_RIGHT_TABLE_CONTEXT_MISSING",
            "missingFields": missing,
        }
    values = {
        "moduleName": str(context["moduleName"]).strip(),
        "pageName": str(context["pageName"]).strip(),
        "featureName": str(context["featureName"]).strip(),
        "treeTitle": str(context["treeTitle"]).strip(),
        "treeAction": str(context["treeAction"]).strip(),
        "treeNodeIdField": str(context["treeNodeIdField"]).strip(),
        "searchField": str(context["searchField"]).strip(),
        "searchControls": _render_search_controls(context),
        "columns": _render_columns(context.get("columns") or []),
        "actionPackageName": str(context["actionPackageName"]).strip(),
        "actionClassName": str(context["actionClassName"]).strip(),
        "entityClassName": str(context["entityClassName"]).strip(),
        "serviceInterface": str(context["serviceInterface"]).strip(),
        "serviceField": str(context.get("serviceField") or "service").strip(),
        "author": str(context.get("author") or "AI自动生成").strip(),
        "date": str(context.get("date") or date.today().isoformat()).strip(),
    }
    html = _render_template(HTML_TEMPLATE, values)
    action = _render_template(ACTION_TEMPLATE, values)
    return {
        "ok": True,
        "fileKind": FILE_KIND,
        "ruleAlias": RULE_ALIAS,
        "files": [
            {
                "fileKind": "HtmlPage",
                "suggestedFileName": values["pageName"] + ".html",
                "content": html,
            },
            {
                "fileKind": "Action",
                "suggestedFileName": values["actionClassName"] + ".java",
                "content": action,
            },
        ],
    }


HTML_TEMPLATE = """<!DOCTYPE html>
<html>
<head>
    <title>{{featureName}}列表</title>
    <meta charset="UTF-8" />
    <meta http-equiv="X-UA-Compatible" content="IE=edge" />
    <script src="../../frame/fui/js/cssboot.js"></script>
</head>
<body>
    <div class="page-loading"></div>

    <div class="fui-left">
        <div role="head" title="{{treeTitle}}"></div>
        <div role="body">
            <ul id="tree" class="mini-filtertree" style="height: 100%"
                textField="text" idField="id" parentField="pid"
                action="{{treeAction}}.getTreeModel"
                enableSearch="true"
                resultAsTree="false">
            </ul>
        </div>
    </div>

    <div class="fui-right">
        <div id="toolbar" class="fui-toolbar">
            <div class="btn-group mr10">
                <a class="mini-button" onclick="openAdd();">新增</a>
                <a class="mini-button" onclick="deleteSelect();">删除选定</a>
            </div>
        </div>

        <div class="fui-condition">
            <div class="fui-form" id="fui-form">
                <div role="form">
                    <div role="row">
{{searchControls}}
                    </div>
                    <input bind="{{treeNodeIdField}}" id="{{treeNodeIdField}}" class="mini-hidden" />
                </div>
            </div>
            <a role="searcher" callback="searchData"></a>
        </div>

        <div id="fuiContent" class="fui-content">
            <div id="datagrid" class="mini-datagrid" idField="rowguid"
                 action="getDataGridData" style="height: 100%;"
                 allowResize="true" multiSelect="true"
                 sortOrder="desc" showPager="true">
                <div property="columns">
                    <div type="checkcolumn" width="50"></div>
                    <div type="indexcolumn" width="50" headerAlign="center">序</div>
{{columns}}
                    <div align="center" headerAlign="center" renderer="onEditRenderer" width="50">修改</div>
                </div>
            </div>
        </div>
    </div>

    <!-- AI_KEEP[PAGE_BOOT_RESOURCE]: cssboot/jsboot/page-loading 是 FUI/MiniUI/epoint 页面启动资源，业务 patch 禁止移除或挪动；业务 JS 写在 jsboot 后面的 inline script 内。 -->
    <script src="../../rest/resource/jsboot"></script>
    <script>
        // AI_TODO[LeftTreeRightTablePageLinkage]:
        // 目标：树选择写入 {{treeNodeIdField}} 后刷新 datagrid；新增/编辑弹窗关闭回调只调用 searchData。
        // 正例：renderer 用 epoint.renderCell，列表刷新用 epoint.refresh(['datagrid','fui-form'])。
        // 禁止：fetch/axios/$.ajax、layer.open、window.open、子页直接操作父页面 DOM。
        epoint.initPage('{{pageName}}listaction');

        var tree = mini.get("tree");
        tree.on("nodeselect", function(e) {
            if (e.node) {
                var id = e.node.id;
                mini.get('{{treeNodeIdField}}').setValue(id == 'f9root' ? "" : id);
            }
            searchData();
        });

        var onEditRenderer = function(e) {
            return epoint.renderCell(e, "action-icon icon-edit", "openEdit");
        };

        function openAdd() {
            var treeNodeGuid = mini.get('{{treeNodeIdField}}').getValue();
            epoint.openTopDialog('新增{{featureName}}',
                "xmgxh/{{moduleName}}/{{pageName}}add?{{treeNodeIdField}}=" + treeNodeGuid,
                searchData, { 'width': 800, 'height': 600 });
        }

        function openEdit(id) {
            epoint.openTopDialog('编辑{{featureName}}',
                "xmgxh/{{moduleName}}/{{pageName}}edit?guid=" + id,
                searchData, { 'width': 800, 'height': 600 });
        }

        function deleteSelect() {
            if (mini.get('datagrid').getSelecteds().length == 0) {
                epoint.alert('请选择要删除的记录!');
            }
            else {
                epoint.confirm('确认要删除吗?', '', function() {
                    epoint.execute("deleteSelect", '', function(data) {
                        if (data.msg) {
                            epoint.alert(data.msg, '', searchData);
                        }
                    });
                });
            }
        }

        function searchData(data) {
            if (data != "close") {
                epoint.refresh(['datagrid', 'fui-form']);
            }
        }
    </script>
</body>
</html>
"""


ACTION_TEMPLATE = """package {{actionPackageName}};

import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.context.annotation.Scope;
import org.springframework.web.bind.annotation.RestController;

import com.epoint.basic.controller.BaseController;
import com.epoint.core.dto.model.DataGridModel;
import java.util.ArrayList;
import java.util.List;

/**
 * {{featureName}}左树右表列表后台
 *
 * @author {{author}}
 * @version 1.0, {{date}}
 */
@RestController("{{pageName}}listaction")
@Scope("request")
public class {{actionClassName}} extends BaseController {

    private static final long serialVersionUID = 1L;

    private String {{treeNodeIdField}};

    private String {{searchField}};

    private DataGridModel<{{entityClassName}}> model;

    @Autowired
    private {{serviceInterface}} {{serviceField}};

    @Override
    public void pageLoad() {
    }

    public DataGridModel<{{entityClassName}}> getDataGridData() {
        if (model == null) {
            model = new DataGridModel<{{entityClassName}}>() {
                private static final long serialVersionUID = 1L;

                @Override
                public List<{{entityClassName}}> fetchData(int first, int pageSize, String sortField, String sortOrder) {
                    // AI_TODO[LeftTreeRightTableQuery]: 按 {{treeNodeIdField}} 和 {{searchField}} 调用 Service 分页查询。
                    // 正例：SqlConditionUtil 组装树节点和搜索条件，PageData pd = service.xxx(sql.getMap(), first, pageSize)，再 setRowCount(pd.getRowCount())。
                    // 禁止：Action 持有 DAO/baseDao、直接写 SQL、跳过 Service。
                    setRowCount(0);
                    return new ArrayList<>();
                }
            };
        }
        return model;
    }

    public void deleteSelect() {
        // AI_TODO[LeftTreeRightTableDelete]: 按当前列表选择项调用 Service 删除并返回 msg。
        // 正例：遍历 getDataGridData().getSelectKeys()，service.deleteByGuid(sel)，最后 addCallbackParam("msg", "成功删除！")。
        // 禁止：直接拼 SQL 删除、删除后不返回 msg。
    }
}
"""


def _self_test():
    result = render({
        "moduleName": "demo",
        "pageName": "gxhdemo",
        "featureName": "示例",
        "treeTitle": "选择分类",
        "treeAction": "gxhtreeaction",
        "treeNodeIdField": "categoryguid",
        "searchField": "keyword",
        "columns": [{"field": "name", "title": "名称"}],
        "actionPackageName": "demo.action",
        "actionClassName": "DemoListAction",
        "entityClassName": "Demo",
        "serviceInterface": "IDemoService",
    })
    assert result["ok"] is True
    html = result["files"][0]["content"]
    action = result["files"][1]["content"]
    assert "mini-filtertree" in html
    assert "categoryguid" in html
    assert "DataGridModel<Demo>" in action


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
