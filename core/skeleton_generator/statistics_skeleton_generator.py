# -*- coding: utf-8 -*-
"""Statistics post-fill adapters.

Statistics pages reuse the resolved company ListAction/ListPage rule sections.
The Builder may bind them either to a confirmed carrier Entity/Service or to a
service-only statistics plan backed by read-only source tables.
"""

import os
import re


ACTION_SECTION_KEY = "StatisticsAction"
HTML_SECTION_KEY = "StatisticsHtmlPage"


def is_statistics_section(file_kind, section_key):
    kind = str(file_kind or "").strip()
    key = str(section_key or "").strip()
    return (kind == "Action" and key == ACTION_SECTION_KEY) or (kind == "HtmlPage" and key == HTML_SECTION_KEY)


def post_fill_action(template, facts, target_file, project_path=""):
    data_access_plan = facts.get("dataAccessPlan") or {}
    service = data_access_plan.get("service") or {}
    service_only = _is_service_only_statistics(data_access_plan)
    entity = {} if service_only else (data_access_plan.get("entity") or {})
    seed = _statistics_seed(facts)
    service_interface = str(service.get("interfaceName") or "").strip()
    entity_class = str(entity.get("className") or (data_access_plan.get("table") or {}).get("entityName") or "").strip()
    method_name = str(seed.get("methodName") or "").strip()
    count_method_name = _count_method_name(method_name)
    if not service_interface or (not service_only and not entity_class) or not method_name:
        raise ValueError(
            ("DESIGN_TDD_STATISTICS_SERVICE_ONLY_PROJECTION_MISSING: "
             "统计 Action 缺少已确认的本模块 Service 或统计方法绑定。")
            if service_only else
            ("DESIGN_TDD_STATISTICS_CARRIER_PROJECTION_MISSING: "
             "统计 Action 缺少已确认的承载 Entity、Service 或统计方法绑定。")
        )

    statistics_entity_name = str(facts.get("entityName") or "").strip()
    statistics_entity_class = "Gxh" + statistics_entity_name if statistics_entity_name else ""
    service_import = _resolved_import(service, service_interface, project_path)
    entity_import = _resolved_import(entity, entity_class, project_path)

    if service_only:
        template = _remove_entity_state(template, [statistics_entity_class, entity_class])
    elif statistics_entity_class and statistics_entity_class != entity_class:
        template = _remove_import_for_class(template, statistics_entity_class)
        template = _replace_java_identifier(template, statistics_entity_class, entity_class)
    template = _remove_imports_matching(template, r"IGxh[A-Za-z0-9_]+Service")
    template = _replace_java_type(template, r"IGxh[A-Za-z0-9_]+Service", service_interface)
    if service_only:
        template = re.sub(r"DataGridModel<[^>]+>\s+model", "DataGridModel<Map<String, Object>> model", template)
    else:
        template = re.sub(
            r"DataGridModel<" + re.escape(entity_class) + r">\s+model",
            "DataGridModel<Map<String, Object>> model",
            template
        )
    template = _ensure_imports(template, [service_import, entity_import] if not service_only else [service_import])
    template = re.sub(
        r"(?m)(private\s+" + re.escape(service_interface) + r"\s+)\w+\s*;",
        r"\1service;",
        template
    )
    template = _replace_java_method(template, "getDataGridData", _statistics_data_grid_method(method_name, count_method_name))
    template = _remove_java_method(template, "deleteSelect")
    template = _remove_java_method(template, "getExportModel")
    template = template.replace("import com.epoint.basic.faces.export.ExportModel;\n", "")
    template = template.replace("    private ExportModel exportModel;\n", "")
    return template


def post_fill_html_page(template, facts, target_file=""):
    contract = facts.get("statisticsContract") or {}
    title = str(contract.get("title") or "统计分析").strip()
    columns = _render_columns(contract.get("dimensions") or [], contract.get("metrics") or [])
    template = template.replace("{表中文名}", title)
    return _replace_html_columns(template, columns)


def _statistics_data_grid_method(method_name, count_method_name):
    return """    public DataGridModel<Map<String, Object>> getDataGridData() {
        if (model == null) {
            model = new DataGridModel<Map<String, Object>>() {
                @Override
                public List<Map<String, Object>> fetchData(int first, int pageSize, String sortField, String sortOrder) {
                    Map<String, Object> params = ListGenerator.getSearchMap(getRequestContext().getComponents(), sortField, sortOrder);
                    List<Map<String, Object>> rows = service.%s(params, first, pageSize);
                    setRowCount(service.%s(params));
                    return rows;
                }
            };
        }
        return model;
    }""" % (method_name, count_method_name)


def _replace_java_identifier(template, old, new):
    return re.sub(r"\b" + re.escape(old) + r"\b", new, template)


def _replace_java_type(template, pattern, replacement):
    return re.sub(r"\b" + pattern + r"\b", replacement, template)


def _remove_import_for_class(template, class_name):
    return re.sub(
        r"(?m)^\s*import\s+[^;]+\." + re.escape(class_name) + r";\s*\r?\n",
        "",
        template
    )


def _remove_imports_matching(template, class_pattern):
    return re.sub(
        r"(?m)^\s*import\s+[^;]+\." + class_pattern + r";\s*\r?\n",
        "",
        template
    )


def _remove_entity_state(template, class_names):
    """Remove Entity-only imports and accessors from a service-only Action."""
    names = [str(name or "").strip() for name in class_names or [] if str(name or "").strip()]
    for class_name in names:
        template = _remove_import_for_class(template, class_name)
        template = re.sub(
            r"(?m)^\s*private\s+" + re.escape(class_name) + r"\s+dataBean(?:\s*=\s*[^;]+)?\s*;\s*\r?\n",
            "",
            template
        )
    template = re.sub(
        r"(?m)^\s*import\s+[^;]+\.api\.entity\.[A-Za-z0-9_]+;\s*\r?\n",
        "",
        template
    )
    template = _remove_java_method(template, "getDataBean")
    template = _remove_java_method(template, "setDataBean")
    return template


def _is_service_only_statistics(data_access_plan):
    plan = data_access_plan if isinstance(data_access_plan, dict) else {}
    return bool(
        plan.get("serviceOnly") is True
        or plan.get("noEntity") is True
        or str(plan.get("accessType") or "").strip() == "statistics_sources"
        or str(plan.get("mode") or "").strip() == "statistics_source"
    )


def _ensure_imports(template, imports):
    lines = []
    for value in imports:
        if not value:
            continue
        line = str(value).strip()
        if not line.startswith("import "):
            line = "import " + line
        if not line.endswith(";"):
            line += ";"
        if line not in template:
            lines.append(line)
    if not lines:
        return template
    package_match = re.search(r"(?m)^package[^\n]*\n", template)
    insert_at = package_match.end() if package_match else 0
    return template[:insert_at] + "\n".join(lines) + "\n" + template[insert_at:]


def _find_matching_brace(source, opening_index):
    depth = 0
    for index in range(opening_index, len(source)):
        if source[index] == "{":
            depth += 1
        elif source[index] == "}":
            depth -= 1
            if depth == 0:
                return index
    return -1


def _java_method_match(template, method_name):
    return re.search(
        r"(?m)^[ \t]*(?:@Override\s*\n[ \t]*)?(?:public|protected|private)\s+[^\n{]+\b"
        + re.escape(method_name) + r"\s*\([^\n]*\)\s*\{",
        template
    )


def _replace_java_method(template, method_name, replacement):
    match = _java_method_match(template, method_name)
    if not match:
        return template
    opening = template.find("{", match.start(), match.end())
    closing = _find_matching_brace(template, opening)
    if closing < 0:
        return template
    return template[:match.start()] + replacement + template[closing + 1:]


def _remove_java_method(template, method_name):
    match = _java_method_match(template, method_name)
    if not match:
        return template
    opening = template.find("{", match.start(), match.end())
    closing = _find_matching_brace(template, opening)
    if closing < 0:
        return template
    end = closing + 1
    if end < len(template) and template[end] == "\n":
        end += 1
    return template[:match.start()] + template[end:]


def _replace_html_columns(template, columns):
    marker = '<div property="columns">'
    start = template.find(marker)
    if start < 0:
        return template
    depth = 1
    cursor = start + len(marker)
    while depth > 0:
        next_open = template.find("<div", cursor)
        next_close = template.find("</div>", cursor)
        if next_close < 0:
            return template
        if next_open >= 0 and next_open < next_close:
            depth += 1
            cursor = next_open + 4
        else:
            depth -= 1
            cursor = next_close + len("</div>")
    replacement = marker + ("\n" + columns if columns else "") + "\n            </div>"
    return template[:start] + replacement + template[cursor:]


def _statistics_seed(facts):
    candidates = []
    candidates.extend(facts.get("serviceContractSeeds") or [])
    candidates.extend(facts.get("actionContractSeeds") or [])
    for item in candidates:
        if not isinstance(item, dict):
            continue
        method_name = str(item.get("methodName") or "").strip()
        if method_name and str(item.get("sourceType") or "").strip() == "statisticsContract":
            return item
    return {}


def _count_method_name(method_name):
    name = str(method_name or "").strip()
    if name.startswith("query"):
        return "count" + name[len("query"):]
    return name + "Count" if name else ""


def _java_package_from_path(source_path):
    normalized = str(source_path or "").replace("\\", "/")
    marker = "/src/main/java/"
    if marker not in normalized:
        return ""
    package_path = normalized.split(marker, 1)[1].rsplit("/", 1)[0]
    return package_path.replace("/", ".")


def _resolved_import(service, service_interface, project_path):
    if not service_interface:
        return ""
    package_name = str(service.get("packageName") or "").strip()
    if not package_name:
        source_path = service.get("sourcePath") or ""
        if project_path and source_path and not os.path.isabs(source_path):
            source_path = os.path.join(project_path, source_path)
        package_name = _java_package_from_path(source_path)
    return package_name + "." + service_interface if package_name else ""


def _render_columns(dimensions, metrics):
    columns = []
    for item in list(dimensions or []) + list(metrics or []):
        if not isinstance(item, dict):
            continue
        key = str(item.get("key") or item.get("sourceField") or "").strip()
        label = str(item.get("label") or key).strip()
        if key:
            columns.append('                <div field="' + key + '" header="' + label + '" width="120"></div>')
    return "\n".join(columns)
