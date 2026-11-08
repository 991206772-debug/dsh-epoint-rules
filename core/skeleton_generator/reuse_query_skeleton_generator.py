# -*- coding: utf-8 -*-
"""Query-only reuse table skeleton generator.

This module owns the dedicated Python skeleton for reuse-table read-only list
entries. The legacy strict materializer only dispatches here by sectionKey.
"""

import os
import re


ACTION_SECTION_KEY = "ReuseQueryListAction"
HTML_SECTION_KEY = "ReuseQueryListHtmlPage"


def is_reuse_query_section(file_kind, section_key):
    kind = str(file_kind or "").strip()
    key = str(section_key or "").strip()
    return (kind == "Action" and key == ACTION_SECTION_KEY) or (kind == "HtmlPage" and key == HTML_SECTION_KEY)


def get_template(file_kind, section_key):
    kind = str(file_kind or "").strip()
    key = str(section_key or "").strip()
    if kind == "Action" and key == ACTION_SECTION_KEY:
        return _action_template()
    if kind == "HtmlPage" and key == HTML_SECTION_KEY:
        return _html_template()
    return ""


def post_fill_action(template, facts, target_file, project_path=""):
    data_access_plan = facts.get("dataAccessPlan") or {}
    if not data_access_plan or data_access_plan.get("mode") not in ("generic_service", "existing_service", "generated_service", "carried_service"):
        return template
    service = data_access_plan.get("service") or {}
    entity = data_access_plan.get("entity") or {}
    tables = facts.get("databaseTables") or []
    business_columns = tables[0].get("businessColumns") if tables else []
    if not isinstance(business_columns, list):
        business_columns = []

    action_class = os.path.splitext(os.path.basename(str(target_file or "")))[0]
    entity_class = str(entity.get("className") or (data_access_plan.get("table") or {}).get("entityName") or "").strip()
    service_interface = str(service.get("interfaceName") or "").strip()
    service_field = str(service.get("fieldName") or "").strip() or _lower_first(service_interface)
    paginator_method = str(service.get("methodName") or "paginatorList").strip()
    paginator_call = _render_paginator_call(data_access_plan, service_field, paginator_method, entity_class)

    replacements = {
        "{ActionClassName}": action_class,
        "{ReuseEntityClass}": entity_class,
        "{GenericServiceInterface}": service_interface,
        "{GenericServiceField}": service_field,
        "{GenericPaginatorMethod}": paginator_method,
        "{PaginatorCall}": paginator_call,
        "{ReuseQueryFieldDeclarations}": _render_action_field_declarations(query_inputs(facts)),
        "{ReuseQueryConditions}": _render_action_query_conditions(query_inputs(facts))
    }
    for key, value in replacements.items():
        template = template.replace(key, str(value or ""))

    imports = []
    service_package = str(service.get("packageName") or "").strip()
    entity_package = str(entity.get("packageName") or "").strip()
    service_package = _resolve_import_package(
        project_path=project_path,
        target_file=target_file,
        source_path=service.get("sourcePath"),
        declared_package=service_package,
        class_name=service_interface
    )
    entity_package = _resolve_import_package(
        project_path=project_path,
        target_file=target_file,
        source_path=entity.get("sourcePath") or (data_access_plan.get("table") or {}).get("reuseSourceFile"),
        declared_package=entity_package,
        class_name=entity_class
    )
    if service_package and service_interface:
        imports.append(f"import {service_package}.{service_interface};")
    if entity_package and entity_class:
        imports.append(f"import {entity_package}.{entity_class};")
    template = _ensure_import_lines(template, imports)
    return _post_fill_export_model(template, business_columns, data_access_plan)


def post_fill_html_page(template, facts):
    tables = facts.get("databaseTables") or []
    data_access_plan = facts.get("dataAccessPlan") or {}
    if not tables:
        return template
    primary_table = tables[0]
    table_comment = str(primary_table.get("tableComment") or "").strip()
    business_columns = primary_table.get("businessColumns") or []
    if not isinstance(business_columns, list):
        business_columns = []
    if table_comment:
        template = template.replace("{表中文名}", table_comment)
    template = template.replace("{ReuseQueryControls}", _render_html_query_controls(query_inputs(facts, for_page=True)))
    template = template.replace("{ReuseQueryColumns}", _render_html_columns(business_columns, data_access_plan))
    date_columns = [item["column"] for item in query_inputs(facts, for_page=True) if item.get("dateRange")]
    return _ensure_html_query_date_draw_scripts(template, date_columns)


def _action_template():
    return """package com.epoint.xmgxh.{模块}.action;

import com.epoint.basic.controller.BaseController;
import com.epoint.basic.faces.export.ExportModel;
import com.epoint.core.utils.sql.SqlConditionUtil;
import com.epoint.core.dto.model.DataGridModel;
import com.epoint.core.utils.date.EpointDateUtil;
import com.epoint.core.utils.string.StringUtil;
import com.epoint.database.peisistence.crud.impl.model.PageData;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.context.annotation.Scope;
import org.springframework.web.bind.annotation.RestController;
import java.util.List;

@RestController("gxh{pagename}listaction")
@Scope("request")
public class {ActionClassName} extends BaseController {
    @Autowired
    private {GenericServiceInterface} {GenericServiceField};

    private DataGridModel<{ReuseEntityClass}> model;
    private ExportModel exportModel;
    private String searchKeyword;
{ReuseQueryFieldDeclarations}

    // AI_TODO[ReuseQueryActionLinkage]:
    // 目标：复用查询 Action 只做查询入口，getDataGridData 闭合 list.html 的 datagrid action。
    // 正例：SqlConditionUtil 组装条件后调用已确认 Service 分页方法，再 setRowCount(pd.getRowCount())。
    // 禁止：Action 直接写 DAO/SQL、修改复用实体结构、为查询页新造业务表。

    @Override
    public void pageLoad() {
    }

    public DataGridModel<{ReuseEntityClass}> getDataGridData() {
        if (model == null) {
            model = new DataGridModel<{ReuseEntityClass}>() {
                @Override
                public List<{ReuseEntityClass}> fetchData(int first, int pageSize, String sortField, String sortOrder) {
                    SqlConditionUtil sql = new SqlConditionUtil();
{ReuseQueryConditions}
                    if (StringUtil.isNotBlank(sortField)) {
                        if ("desc".equalsIgnoreCase(sortOrder)) {
                            sql.setOrderDesc(sortField);
                        }
                        else {
                            sql.setOrderAsc(sortField);
                        }
                    }
                    else {
                        sql.setOrderDesc("operatedate");
                    }
                    PageData<{ReuseEntityClass}> pd = {PaginatorCall};
                    this.setRowCount(pd.getRowCount());
                    return pd.getList();
                }
            };
        }
        return model;
    }

    public ExportModel getExportModel() {
        if (exportModel == null) {
            exportModel = new ExportModel("field1,field2", "列名1,列名2");
        }
        return exportModel;
    }
}
"""


def _html_template():
    return """<!DOCTYPE html>
<html>
<head>
    <title>{表中文名}列表</title>
    <meta charset="UTF-8"/>
    <meta http-equiv="X-UA-Compatible" content="IE=edge"/>
    <script src="../../frame/fui/js/cssboot.js"></script>
</head>
<body>
<div class="page-loading"></div>

<div class="fui-toolbar">
    <div class="btn-group mr10">
        <a class="mini-dataexport" id="dataexport" gridId="datagrid" fileName="{表中文名}列表" action="getExportModel" extraId="fui-form"></a>
    </div>
</div>

<div class="fui-condition">
    <div class="fui-form" id="fui-form">
        <div id="cform" role="form">
{ReuseQueryControls}
        </div>
    </div>
    <a role="searcher" callback="searchData"></a>
</div>

<div id="fuiContent" class="fui-content">
    <div id="datagrid" class="mini-datagrid" idField="rowguid" action="getDataGridData"
         sortOrder="desc" showPager="true" style="height:100%;" multiSelect="false">
        <div property="columns">
            <div type="indexcolumn" width="40" headerAlign="center">序</div>
{ReuseQueryColumns}
        </div>
    </div>
</div>

<!-- AI_KEEP[PAGE_BOOT_RESOURCE]: cssboot/jsboot/page-loading 是 FUI/MiniUI/epoint 页面启动资源，业务 patch 禁止移除或挪动；业务 JS 写在 jsboot 后面的 inline script 内。 -->
<script src="../../rest/resource/jsboot"></script>
<script>
    // AI_TODO[ReuseQueryPageLinkage]:
    // 目标：复用查询页只展示查询条件、datagrid 和导出，epoint.initPage 必须闭合到 ListAction。
    // 正例：searchData 只刷新 ['datagrid','fui-form']。
    // 不自动套用通用 CRUD 入口；需求明确的业务操作由 Coder 补齐。禁止 fetch/axios/$.ajax、layer.open/window.open。
    epoint.initPage('gxh{pagename}listaction');
    function searchData() { epoint.refresh(['datagrid', 'fui-form']); }
</script>
</body>
</html>
"""


def query_inputs(facts, for_page=False):
    """页面与后台共用已确认的筛选；未声明合同才沿用基础字段查询。"""
    tables = facts.get("databaseTables") or []
    columns = (tables[0].get("businessColumns") or []) if tables else []
    declared = facts.get("queryFilters") or []
    if declared:
        result = []
        seen = set()
        for item in declared:
            input_key = str(item.get("inputKey") or "").strip()
            field_name = str(item.get("fieldName") or "").strip()
            if not input_key or not field_name or input_key in seen:
                continue
            seen.add(input_key)
            object_key = str(item.get("objectKey") or "").strip()
            source_table = next((table for table in tables if table.get("objectKey") == object_key), {})
            if item.get("implementation") != "coder" and not source_table and tables:
                source_table = tables[0]
            column = next((col for col in source_table.get("businessColumns") or []
                           if col.get("name") == field_name), {})
            result.append(dict(item, column=column))
        return result
    if for_page:
        columns = _safe_display_columns(columns, facts.get("dataAccessPlan"))[:6]
    result = []
    for column in columns:
        name = str(column.get("name") or "").strip()
        if not name:
            continue
        result.append({"inputKey": _java_field_name(name), "fieldName": name, "column": column,
                       "dateRange": _is_date_column(column),
                       "operator": "contains", "normalize": "trim"})
    return result or [{"inputKey": "searchKeyword", "fieldName": "rowguid", "column": {"comment": "关键字"},
                      "operator": "contains", "normalize": "trim"}]


def query_bind_fields(facts):
    fields = []
    for item in query_inputs(facts):
        name = item["inputKey"]
        names = [name + "Start", name + "End"] if item.get("dateRange") else [name]
        fields.extend((field, item["fieldName"] + "查询") for field in names)
    return fields


def _render_action_field_declarations(inputs):
    lines = []
    seen = set()
    for item in inputs:
        name = item["inputKey"]
        if not name:
            continue
        if item.get("dateRange"):
            for suffix in ("Start", "End"):
                item = name + suffix
                if item in seen:
                    continue
                seen.add(item)
                lines.append(f"    private String {item};")
            continue
        if name in seen or name == "searchKeyword":
            continue
        seen.add(name)
        lines.append(f"    private String {name};")
    return "\n".join(lines)


def _render_action_query_conditions(inputs):
    lines = []
    for item in inputs:
        raw_name = _escape_java_string(item["fieldName"])
        name = item["inputKey"]
        if item.get("implementation") == "coder":
            lines.append('                    // AI_TODO: 关联筛选 ' + name + ' -> '
                         + str(item.get("objectKey")) + '.' + item["fieldName"]
                         + '；按 business-facts.queryFilters 的 relationPath 实现关联查询，不能作为主表条件。')
        elif item.get("dateRange"):
            start_name = name + "Start"
            end_name = name + "End"
            lines.extend([
                f'                    if (StringUtil.isNotBlank({start_name})) {{',
                f'                        sql.ge("{raw_name}", EpointDateUtil.getBeginOfDateStr({start_name}));',
                '                    }',
                f'                    if (StringUtil.isNotBlank({end_name})) {{',
                f'                        sql.lt("{raw_name}", EpointDateUtil.getEndOfDateStr({end_name}));',
                '                    }'
            ])
        else:
            method = "eq" if item.get("operator") == "exact" else "like"
            value = name + (".trim()" if item.get("normalize") == "trim" else "")
            lines.extend([
                f'                    if (StringUtil.isNotBlank({name})) {{',
                f'                        sql.{method}("{raw_name}", {value});',
                '                    }'
            ])
    if not lines:
        lines.extend([
            '                    if (StringUtil.isNotBlank(searchKeyword)) {',
            '                        sql.like("rowguid", searchKeyword.trim());',
            '                    }'
        ])
    return "\n".join(lines)


def _render_paginator_call(data_access_plan, service_field, paginator_method, entity_class):
    mode = str((data_access_plan or {}).get("mode") or "").strip()
    call_shape_mode = str(((data_access_plan or {}).get("queryMethod") or {}).get("callShapeMode") or "").strip()
    if mode == "carried_service" or call_shape_mode == "service_condition_page":
        return f"{service_field}.{paginator_method}(sql.getMap(), first, pageSize)"
    return f"{service_field}.{paginator_method}({entity_class}.class, sql.getMap(), first, pageSize)"


def _render_html_query_controls(inputs):
    controls = []
    for item in inputs:
        col = item.get("column") or {}
        name = item["inputKey"]
        label = str(col.get("comment") or item["fieldName"]).strip()
        if item.get("dateRange"):
            start_draw_func, end_draw_func = _date_range_draw_function_names(name)
            controls.append([
                '    <div role="control" label="' + _escape_html(label) + '">',
                '        <div>',
                '            <input id="' + _escape_html(name) + 'Start" class="mini-datepicker" width="120" ondrawdate="' + start_draw_func + '"',
                '                   allowInput="false" format="yyyy-MM-dd" showClose="true" autoClear="true" bind="' + _escape_html(name) + 'Start" />',
                '            至',
                '            <input id="' + _escape_html(name) + 'End" class="mini-datepicker" width="120" ondrawdate="' + end_draw_func + '"',
                '                   allowInput="false" format="yyyy-MM-dd" showClose="true" autoClear="true" bind="' + _escape_html(name) + 'End" />',
                '        </div>',
                '    </div>'
            ])
        elif col.get("codeItem"):
            controls.append([
                '    <div role="control" label="' + _escape_html(label) + '">',
                '        <input class="mini-combobox" bind="' + _escape_html(name) + '" action="get' + _to_pascal(item["fieldName"]) + 'Model"',
                '               textField="text" valueField="id" emptyText="请选择..." />',
                '    </div>'
            ])
        else:
            controls.append([
                '    <div role="control" label="' + _escape_html(label) + '">',
                '        <input class="mini-textbox" bind="' + _escape_html(name) + '" emptyText="请输入' + _escape_html(label) + '..." />',
                '    </div>'
            ])
    return _render_query_control_rows(controls)


def _render_query_control_rows(controls):
    rows = []
    safe_controls = [control for control in (controls or []) if control]
    for idx in range(0, len(safe_controls), 2):
        pair = safe_controls[idx:idx + 2]
        rows.append('            <div role="row">')
        for control in pair:
            rows.extend('            ' + line for line in control)
        if len(pair) == 1:
            rows.append('                <div role="control"></div>')
        rows.append('            </div>')
    return "\n".join(rows)


def _date_range_draw_function_names(field_name):
    safe_name = _java_field_name(field_name)
    pascal = _to_pascal(safe_name) or "Date"
    return "on" + pascal + "StartDate", "on" + pascal + "EndDate"


def _ensure_html_query_date_draw_scripts(template, date_columns):
    safe_columns = []
    seen = set()
    for col in date_columns or []:
        field_name = str((col or {}).get("name") or "").strip()
        if not field_name or field_name in seen:
            continue
        seen.add(field_name)
        safe_columns.append(col)
    if not safe_columns:
        return template

    script_lines = []
    for col in safe_columns:
        field_name = str((col or {}).get("name") or "").strip()
        label = str((col or {}).get("comment") or field_name).strip()
        start_func, end_func = _date_range_draw_function_names(field_name)
        if "function " + start_func in template and "function " + end_func in template:
            continue
        start_id = _escape_js_string(field_name + "Start")
        end_id = _escape_js_string(field_name + "End")
        script_lines.extend([
            "",
            "    // 设置" + label + "开始日期不可大于结束日期",
            "    function " + start_func + "(e) {",
            "        var date = e.date;",
            "        var d = mini.get('" + end_id + "').getValue();",
            "        if (d && date.getTime() > d) {",
            "            e.allowSelect = false;",
            "        }",
            "    }",
            "",
            "    // 设置" + label + "结束日期不可小于开始日期",
            "    function " + end_func + "(e) {",
            "        var date = e.date;",
            "        var d = mini.get('" + start_id + "').getValue();",
            "        if (d && date.getTime() < d) {",
            "            e.allowSelect = false;",
            "        }",
            "    }"
        ])
    if not script_lines:
        return template

    lines = template.splitlines()
    for idx in range(len(lines) - 1, -1, -1):
        if lines[idx].strip() == "</script>":
            lines[idx:idx] = script_lines
            return "\n".join(lines)
    return template + "\n<script>\n" + "\n".join(script_lines).strip() + "\n</script>"


def _render_html_columns(business_columns, data_access_plan=None):
    columns = _safe_display_columns(business_columns, data_access_plan)
    if not columns:
        return "\n".join([
            '            <div field="rowguid" width="160" headerAlign="center">记录标识</div>',
            '            <!-- AI_TODO: 复用实体缺少可直接使用的中文字段注释；Coder 必须先按 requirementWorkDraft.reuseFieldMappingCards 读取 reuseSourceFile，再补充业务列头、查询条件和导出表头。 -->'
        ])
    out = []
    for col in columns:
        name = str((col or {}).get("name") or "").strip()
        label = str((col or {}).get("comment") or name).strip()
        db_type = str((col or {}).get("type") or "").upper()
        if not name:
            continue
        date_attr = ' dateFormat="yyyy-MM-dd HH:mm:ss"' if db_type in ("DATE", "DATETIME", "TIMESTAMP") else ""
        code_item = str(col.get("codeItem") or "").strip()
        code_attr = ' data-options="{code:\'' + _escape_html(_escape_js_string(code_item)) + '\'}"' if code_item else ''
        out.append('            <div field="' + _escape_html(name) + '" width="120" headerAlign="center" allowSort="true"' + date_attr + code_attr + '>' + _escape_html(label) + '</div>')
    return "\n".join(out)


def _display_columns(business_columns):
    skip_comments = {"========== 业务字段 ==========", "========== 基础主键 =========="}
    out = []
    for col in business_columns or []:
        name = str((col or {}).get("name") or "").strip()
        comment = str((col or {}).get("comment") or "").strip()
        if not name or comment in skip_comments:
            continue
        out.append(col)
    return out


def _is_date_column(col):
    db_type = str((col or {}).get("type") or "").strip().upper()
    return db_type in ("DATE", "DATETIME", "TIMESTAMP")


def _safe_display_columns(business_columns, data_access_plan=None):
    columns = _display_columns(business_columns)
    if not _requires_coder_field_mapping(data_access_plan):
        return columns
    safe = []
    for col in columns:
        name = str((col or {}).get("name") or "").strip()
        comment = str((col or {}).get("comment") or "").strip()
        if not name:
            continue
        if _is_user_visible_label(comment, name):
            safe.append(col)
    return safe


def _requires_coder_field_mapping(data_access_plan=None):
    field_intent = (data_access_plan or {}).get("fieldIntent") or {}
    return field_intent.get("requiresSourceFieldMapping") is True


def _is_user_visible_label(comment, name):
    text = str(comment or "").strip()
    raw = str(name or "").strip()
    if not text:
        return False
    if text == raw:
        return False
    if re.match(r"^[A-Za-z0-9_]+$", text):
        return False
    if text in {"========== 业务字段 ==========", "========== 基础主键 =========="}:
        return False
    return True


def _post_fill_export_model(template, business_columns, data_access_plan=None):
    if not business_columns or "ExportModel" not in template:
        return template
    columns = _safe_display_columns(business_columns, data_access_plan)
    fields = ",".join(str(col.get("name") or "").strip() for col in columns if col.get("name"))
    headers = ",".join(str(col.get("comment") or col.get("name") or "").strip() for col in columns if col.get("name"))
    if not fields:
        fields = "rowguid"
        headers = "记录标识"
    pattern = r'new\s+ExportModel\s*\(\s*"[^"]*"\s*,\s*"[^"]*"\s*\)'
    return re.sub(pattern, 'new ExportModel(\n                "' + fields + '",\n                "' + headers + '"\n            )', template)


def _ensure_import_lines(template, imports):
    wanted = [line for line in (imports or []) if line and line not in template]
    if not wanted:
        return template
    lines = template.splitlines()
    insert_pos = -1
    for idx, line in enumerate(lines):
        if line.strip().startswith("import "):
            insert_pos = idx
    if insert_pos >= 0:
        lines[insert_pos + 1:insert_pos + 1] = wanted
    else:
        for idx, line in enumerate(lines):
            if line.strip().startswith("package "):
                insert_pos = idx
                break
        lines[insert_pos + 1:insert_pos + 1] = [""] + wanted if insert_pos >= 0 else wanted
    return "\n".join(lines)


def _statistics_count_method_name(method_name):
    name = str(method_name or "queryStatisticsData").strip()
    if name.startswith("query"):
        return "count" + name[len("query"):]
    return name + "Count"


def _resolve_import_package(project_path="", target_file="", source_path="", declared_package="", class_name=""):
    class_name = str(class_name or "").strip()
    declared_package = str(declared_package or "").strip()
    source_path = str(source_path or "").strip()

    source_file = _resolve_existing_source_file(project_path, target_file, source_path)
    package_name = _read_java_package(source_file)
    if package_name:
        return package_name

    if declared_package and class_name and _declared_import_exists(project_path, target_file, declared_package, class_name):
        return declared_package

    found = _find_unique_java_class(project_path, target_file, class_name)
    package_name = _read_java_package(found)
    if package_name:
        return package_name
    return declared_package


def _resolve_existing_source_file(project_path="", target_file="", source_path=""):
    raw = str(source_path or "").strip()
    if not raw:
        return ""
    candidates = []
    if os.path.isabs(raw):
        candidates.append(raw)
    else:
        if project_path:
            candidates.append(os.path.join(str(project_path), raw))
        root = _project_root_from_target(target_file)
        if root:
            candidates.append(os.path.join(root, raw))
    for candidate in candidates:
        normalized = os.path.abspath(candidate)
        if os.path.isfile(normalized):
            return normalized
    return ""


def _declared_import_exists(project_path="", target_file="", package_name="", class_name=""):
    package_path = str(package_name or "").strip().replace(".", os.sep)
    class_name = str(class_name or "").strip()
    if not package_path or not class_name:
        return False
    rel = os.path.join(package_path, class_name + ".java")
    for root in _java_source_roots(project_path, target_file):
        if os.path.isfile(os.path.join(root, rel)):
            return True
    return False


def _find_unique_java_class(project_path="", target_file="", class_name=""):
    class_name = str(class_name or "").strip()
    if not class_name:
        return ""
    file_name = class_name + ".java"
    matches = []
    target_abs = os.path.abspath(str(target_file or "")) if target_file else ""
    for root in _java_source_roots(project_path, target_file):
        for dirpath, dirnames, filenames in os.walk(root):
            dirnames[:] = [name for name in dirnames if name not in {".git", ".svn", ".ai-workspace", "target", "node_modules"}]
            if file_name not in filenames:
                continue
            candidate = os.path.abspath(os.path.join(dirpath, file_name))
            if target_abs and candidate == target_abs:
                continue
            matches.append(candidate)
            if len(matches) > 20:
                return ""
    unique = []
    seen = set()
    for item in matches:
        key = os.path.normcase(item)
        if key in seen:
            continue
        seen.add(key)
        unique.append(item)
    if len(unique) == 1:
        return unique[0]
    preferred = [item for item in unique if re.search(r"[\\/]+api[\\/]+entity[\\/]+|[\\/]+api[\\/]+", item)]
    return preferred[0] if len(preferred) == 1 else ""


def _java_source_roots(project_path="", target_file=""):
    roots = []

    def add(value):
        if not value:
            return
        normalized = os.path.abspath(str(value))
        if os.path.isdir(normalized) and normalized not in roots:
            roots.append(normalized)

    target_root = _java_source_root_from_path(target_file)
    add(target_root)
    project_root = os.path.abspath(str(project_path or "").strip()) if project_path else ""
    if project_root:
        direct = os.path.join(project_root, "src", "main", "java")
        add(direct)
        try:
            for dirpath, dirnames, _ in os.walk(project_root):
                dirnames[:] = [name for name in dirnames if name not in {".git", ".svn", ".ai-workspace", "target", "node_modules"}]
                if os.path.basename(dirpath) != "java":
                    continue
                parent = os.path.basename(os.path.dirname(dirpath))
                grand = os.path.basename(os.path.dirname(os.path.dirname(dirpath)))
                if parent == "main" and grand == "src":
                    add(dirpath)
                if len(roots) >= 20:
                    break
        except Exception:
            pass
    return roots


def _java_source_root_from_path(file_path=""):
    norm = str(file_path or "").replace("\\", "/")
    marker = "/src/main/java/"
    idx = norm.find(marker)
    if idx < 0:
        return ""
    return norm[:idx + len(marker)]


def _project_root_from_target(target_file=""):
    root = _java_source_root_from_path(target_file)
    if not root:
        return ""
    marker = "/src/main/java/"
    idx = root.replace("\\", "/").find(marker)
    if idx < 0:
        return ""
    return root[:idx]


def _read_java_package(file_path=""):
    if not file_path or not os.path.isfile(file_path):
        return ""
    try:
        with open(file_path, "r", encoding="utf-8") as f:
            text = f.read(4096)
    except Exception:
        return ""
    match = re.search(r"\bpackage\s+([A-Za-z0-9_.]+)\s*;", text)
    return match.group(1) if match else ""


def _java_field_name(name):
    value = re.sub(r"[^A-Za-z0-9_]", "_", str(name or "").strip())
    if not value:
        return ""
    if re.match(r"^[0-9]", value):
        value = "_" + value
    return value


def _to_pascal(value):
    parts = [part for part in re.split(r"[_\s]+", str(value or "").strip()) if part]
    return "".join(part[:1].upper() + part[1:] for part in parts)


def _lower_first(value):
    text = str(value or "").strip()
    if not text:
        return "service"
    return text[:1].lower() + text[1:]


def _escape_html(value):
    return str(value or "").replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace('"', "&quot;")


def _escape_java_string(value):
    return str(value or "").replace("\\", "\\\\").replace('"', '\\"')


def _escape_js_string(value):
    return str(value or "").replace("\\", "\\\\").replace("'", "\\'")
