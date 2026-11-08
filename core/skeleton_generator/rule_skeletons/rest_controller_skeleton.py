#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""Render a REST controller skeleton from confirmed REST contract facts."""

import argparse
import json
from datetime import date


RULE_ALIAS = "REST接口开发规范"
FILE_KIND = "RestController"
REQUIRED_FIELDS = [
    "packageName",
    "className",
    "requestMapping",
    "jsonReturnExpression",
    "methods",
]


def _read_json(path):
    if not path:
        return {}
    with open(path, "r", encoding="utf-8") as handle:
        return json.load(handle)


def _missing(context):
    missing = [name for name in REQUIRED_FIELDS if not context.get(name)]
    if isinstance(context.get("methods"), list) and context.get("methods"):
        missing = [name for name in missing if name != "methods"]
    return missing


def _render_template(template, values):
    rendered = template
    for key, value in values.items():
        rendered = rendered.replace("{{" + key + "}}", str(value))
    return rendered


def _render_imports(context):
    imports = [
        "java.lang.invoke.MethodHandles",
        "javax.servlet.http.HttpServletRequest",
        "org.apache.log4j.Logger",
        "org.springframework.web.bind.annotation.RequestBody",
        "org.springframework.web.bind.annotation.RequestMapping",
        "org.springframework.web.bind.annotation.RequestMethod",
        "org.springframework.web.bind.annotation.RestController",
        "com.alibaba.fastjson.JSONObject",
        "com.epoint.core.utils.string.StringUtil",
    ]
    imports.extend(context.get("additionalImports") or [])
    service_import = str(context.get("serviceImport") or "").strip()
    if service_import:
        imports.append("org.springframework.beans.factory.annotation.Autowired")
        imports.append(service_import)
    return "\n".join("import " + item.rstrip(";") + ";" for item in _dedupe(imports))


def _dedupe(items):
    out = []
    seen = set()
    for item in items:
        value = str(item or "").strip()
        if value and value not in seen:
            seen.add(value)
            out.append(value)
    return out


def _render_required_param_checks(required_params, return_expr):
    lines = []
    for item in required_params or []:
        name = str((item or {}).get("name") or item or "").strip()
        label = str((item or {}).get("label") or name).strip()
        java_type = str((item or {}).get("type") or "String").strip()
        getter = "getString" if java_type == "String" else "get" + java_type
        lines.append(f"        {java_type} {name} = paramsObj.{getter}(\"{name}\");")
        if java_type == "String":
            lines.append(f"        if (StringUtil.isBlank({name})) {{")
            lines.append(f"            return {return_expr}(\"0\", \"{label}参数不能为空\", \"\");")
            lines.append("        }")
    return "\n".join(lines)


def _render_methods(context):
    return_expr = str(context["jsonReturnExpression"]).strip()
    blocks = []
    for method in context.get("methods") or []:
        java_name = str(method.get("javaName") or "").strip()
        path = str(method.get("path") or "").strip()
        http_method = str(method.get("httpMethod") or "POST").strip().upper() or "POST"
        description = str(method.get("description") or java_name).strip()
        success_message = str(method.get("successMessage") or "操作成功").strip()
        service_call = str(method.get("serviceCall") or "").strip()
        if not java_name or not path:
            continue
        result_line = f"Object result = {service_call};" if service_call else (
            "JSONObject result = new JSONObject(); // AI_TODO[RestServiceCall]: 解析 token/paramsObj 后调用已确认 Service/API 并返回项目 REST 封装。\n"
            "            // 按当前 Story 验收、适用规范和真实源码，在授权业务范围内实现。\n"
            "            // 已有 API 核对真实签名；新增业务方法由 Coder 实现并闭合 Service 三层和调用方。\n"
            "            // 禁止：DataSource / CommonDao / ICommonDao / baseDao / String sql / SELECT / LIMIT。"
        )
        blocks.append(_render_template(METHOD_TEMPLATE, {
            "description": description,
            "path": path,
            "httpMethod": http_method,
            "javaName": java_name,
            "returnExpr": return_expr,
            "requiredChecks": _render_required_param_checks(method.get("requiredParams") or [], return_expr),
            "resultLine": result_line,
            "successMessage": success_message,
        }))
    return "\n\n".join(blocks)


def render(context):
    missing = _missing(context)
    if missing:
        return {
            "ok": False,
            "fileKind": FILE_KIND,
            "ruleAlias": RULE_ALIAS,
            "errorCode": "REST_SKELETON_CONTEXT_MISSING",
            "missingFields": missing,
        }
    service_field = str(context.get("serviceField") or "service").strip()
    values = {
        "packageName": str(context["packageName"]).strip(),
        "imports": _render_imports(context),
        "className": str(context["className"]).strip(),
        "requestMapping": str(context["requestMapping"]).strip(),
        "serviceInterface": str(context["serviceInterface"]).strip(),
        "serviceField": service_field,
        "serviceBlock": _render_service_block(context, service_field),
        "featureDescription": str(context.get("featureDescription") or "").strip(),
        "author": str(context.get("author") or "AI自动生成").strip(),
        "date": str(context.get("date") or date.today().isoformat()).strip(),
        "methods": _render_methods(context),
    }
    content = _render_template(CONTROLLER_TEMPLATE, values)
    return {
        "ok": True,
        "fileKind": FILE_KIND,
        "ruleAlias": RULE_ALIAS,
        "files": [{
            "fileKind": FILE_KIND,
            "suggestedFileName": values["className"] + ".java",
            "content": content,
        }],
    }


def _render_service_block(context, service_field):
    service_interface = str(context.get("serviceInterface") or "").strip()
    if not service_interface:
        return "\n".join([
            "    // AI_TODO[RestDataAccess]: REST 只做适配层，必须调用已确认的 @Autowired Service/API。",
            "    // 新增 Service/Util/DTO accessor 调用必须有源码或规则签名证据；无证据不得猜方法。",
            "    // 缺 Service/API：停止并返回 blocker，不允许在 Rest 里补 DAO 查询或新造同名 Service。"
        ])
    return "\n".join([
        "    @Autowired",
        f"    private {service_interface} {service_field};"
    ])


CONTROLLER_TEMPLATE = """package {{packageName}};

{{imports}}

/**
 * {{featureDescription}}REST接口控制器
 *
 * @author {{author}}
 * @version 1.0, {{date}}
 */
@RestController
@RequestMapping("{{requestMapping}}")
public class {{className}} {

    private Logger log = Logger.getLogger(MethodHandles.lookup().lookupClass());

{{serviceBlock}}

{{methods}}
}
"""


METHOD_TEMPLATE = """    /**
     * {{description}}
     *
     * @param params JSON格式的参数字符串
     * @param request HTTP请求对象
     * @return 处理结果
     */
    @RequestMapping(value = "{{path}}", method = RequestMethod.{{httpMethod}})
    public String {{javaName}}(@RequestBody String params, HttpServletRequest request) {
        try {
            log.info("=======开始调用{{description}}接口=======");

            if (StringUtil.isBlank(params)) {
                return {{returnExpr}}("0", "参数不能为空", "");
            }

            JSONObject jsonObject = JSONObject.parseObject(params);
            String token = jsonObject.getString("token");
            if (StringUtil.isBlank(token)) {
                return {{returnExpr}}("0", "token参数不能为空", "");
            }

            JSONObject paramsObj = (JSONObject) jsonObject.get("params");
            if (paramsObj == null) {
                return {{returnExpr}}("0", "params参数不能为空", "");
            }

{{requiredChecks}}
            {{resultLine}}
            return {{returnExpr}}("1", "{{successMessage}}", result);
        }
        catch (Exception e) {
            log.error("======={{description}}接口异常=======", e);
            return {{returnExpr}}("0", "服务器异常：" + e.getMessage(), "");
        }
    }"""


def _self_test():
    result = render({
        "packageName": "demo.rest",
        "className": "DemoRestController",
        "requestMapping": "/demo",
        "serviceInterface": "IDemoService",
        "jsonReturnExpression": "JsonUtils.zwdtRestReturn",
        "methods": [{
            "javaName": "getDetail",
            "path": "/getdetail",
            "description": "获取详情",
            "requiredParams": [{"name": "rowGuid", "label": "rowGuid"}],
            "serviceCall": "service.find(rowGuid)",
        }],
    })
    assert result["ok"] is True
    content = result["files"][0]["content"]
    assert "@RestController" in content
    assert "@RequestMapping(value = \"/getdetail\", method = RequestMethod.POST)" in content
    assert "String token = jsonObject.getString(\"token\");" in content
    assert "JSONObject paramsObj = (JSONObject) jsonObject.get(\"params\");" in content
    assert "StringUtil.isBlank(rowGuid)" in content


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
