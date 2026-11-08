#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""Render a Job skeleton from confirmed project facts.

This module is intentionally standalone. It does not import or modify the
existing CRUD skeleton generator.
"""

import argparse
import json
from datetime import date


RULE_ALIAS = "定时任务Job开发规范"
FILE_KIND = "Job"
REQUIRED_FIELDS = [
    "packageName",
    "className",
    "operationName",
    "taskDescription",
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
            "errorCode": "JOB_SKELETON_CONTEXT_MISSING",
            "missingFields": missing,
        }

    class_name = str(context["className"]).strip()
    service_interface = str(context["serviceInterface"]).strip()
    service_field = str(context.get("serviceField") or "service").strip()
    service_call = str(context.get("serviceMethodCall") or "").strip()
    execute_body = service_call if service_call else (
        "// AI_TODO[JobBusinessCall]: Job 只做调度入口、日志和异常包装，调用 Service/API 完成业务。\n"
        "            // 正例：service.syncData(); 或 service.repairPendingLogs();\n"
        "            // 新增 Service/Util/DTO accessor 调用必须有源码或规则签名证据；无证据不得猜方法。\n"
        "            // 允许：Job 用 ContainerFactory 获取 Service；禁止：CommonDao/ICommonDao/baseDao/String sql/SELECT/queryForList。"
    )
    if execute_body and not execute_body.endswith(";") and not execute_body.startswith("//"):
        execute_body += ";"

    values = {
        "packageName": str(context["packageName"]).strip(),
        "serviceImport": _render_service_import(context),
        "className": class_name,
        "operationName": str(context["operationName"]).strip(),
        "taskDescription": str(context["taskDescription"]).strip(),
        "serviceInterface": service_interface,
        "serviceField": service_field,
        "executeBody": execute_body,
        "author": str(context.get("author") or "AI自动生成").strip(),
        "date": str(context.get("date") or date.today().isoformat()).strip(),
    }
    content = _render_template(JOB_TEMPLATE, values)
    return {
        "ok": True,
        "fileKind": FILE_KIND,
        "ruleAlias": RULE_ALIAS,
        "files": [{
            "fileKind": FILE_KIND,
            "suggestedFileName": class_name + ".java",
            "content": content,
        }],
    }


JOB_TEMPLATE = """package {{packageName}};

import com.epoint.core.utils.container.ContainerFactory;
import com.epoint.core.utils.log.LogUtil;
import org.quartz.Job;
import org.quartz.JobExecutionContext;
import org.quartz.JobExecutionException;
import org.slf4j.Logger;
{{serviceImport}}

/**
 * {{taskDescription}}定时任务
 *
 * @author {{author}}
 * @version 1.0, {{date}}
 */
public class {{className}} implements Job {

    private final Logger log = LogUtil.getSLF4JLog({{className}}.class);

    private {{serviceInterface}} {{serviceField}};

    public {{className}}() {
        this.{{serviceField}} = ContainerFactory.getContainInfo().getComponent({{serviceInterface}}.class);
    }

    @Override
    public void execute(JobExecutionContext context) throws JobExecutionException {
        log.info("【{{operationName}}定时任务】开始执行...");

        try {
            {{executeBody}}
        }
        catch (Exception e) {
            log.error("【{{operationName}}定时任务】执行异常", e);
            throw new JobExecutionException(e);
        }

        log.info("【{{operationName}}定时任务】执行结束。");
    }
}
"""


def _render_service_import(context):
    service_import = str(context.get("serviceImport") or "").strip()
    if not service_import:
        return ""
    return "import " + service_import.rstrip(";") + ";"


def _self_test():
    result = render({
        "packageName": "demo.job",
        "className": "DemoSyncJob",
        "operationName": "DemoSync",
        "taskDescription": "示例同步",
        "serviceInterface": "IDemoService",
        "serviceMethodCall": "service.sync()",
    })
    assert result["ok"] is True
    content = result["files"][0]["content"]
    assert "implements Job" in content
    assert "ContainerFactory.getContainInfo().getComponent(IDemoService.class)" in content
    assert "throw new JobExecutionException(e);" in content


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
