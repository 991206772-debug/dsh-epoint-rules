#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""Builtin strict renderers for fileKinds that are not markdown-section based.

This module keeps REST/Job best-practice rendering out of run_skeleton_generator.py.
The strict entry still owns validation and passes shared manifest helpers in as
callbacks, so this adapter does not import the strict runner.
"""

import json
import os
import re
from datetime import datetime, timezone

from skeleton_formatter import format_skeleton_content
from rule_skeletons import job_skeleton, rest_controller_skeleton, single_response_rest_skeleton, workflow_skeleton


def materialize_builtin_renderer(
    payload,
    target_file,
    project_path,
    file_kind,
    section_key,
    output_dir,
    substitutions,
    stripped_substitutions=None,
    helpers=None
):
    renderer = None
    if _is_workflow_builtin(file_kind, section_key):
        renderer = workflow_skeleton
    elif file_kind == "Job":
        renderer = job_skeleton
    elif file_kind != "Rest":
        return None

    helpers = helpers or {}
    fallback = helpers.get("fallback")
    context = _build_builtin_context(payload, target_file, project_path, file_kind, substitutions)
    if context.get("ok") is False:
        return fallback(
            "fallback_builtin_context_missing",
            "{}: {}".format(context.get("errorCode") or "BUILTIN_CONTEXT_MISSING", context.get("message") or ""),
            target_file,
            file_kind,
            section_key,
            output_dir,
            {
                "errorCode": context.get("errorCode") or "BUILTIN_CONTEXT_MISSING",
                "message": context.get("message") or "",
                "missingFields": context.get("missingFields") or []
            }
        )
    if file_kind == "Rest":
        renderer = single_response_rest_skeleton if context.get("responseStyle") == "single_response" else rest_controller_skeleton

    rendered = renderer.render(context)
    if not rendered.get("ok"):
        return fallback(
            "fallback_builtin_renderer_failed",
            "{}: {}".format(rendered.get("errorCode") or "BUILTIN_RENDERER_FAILED", ",".join(rendered.get("missingFields") or [])),
            target_file,
            file_kind,
            section_key,
            output_dir
        )
    files = rendered.get("files") or []
    if not files:
        return fallback("fallback_builtin_renderer_empty", "Builtin renderer returned no files",
            target_file, file_kind, section_key, output_dir)

    skeleton = str(files[0].get("content") or "")
    post_fill = helpers.get("post_fill_by_file_kind")
    if callable(post_fill):
        skeleton = post_fill(
            template=skeleton,
            file_kind=file_kind,
            module_id=str(payload.get("moduleId") or "").strip(),
            business_facts_path=str(payload.get("businessFactsPath") or "").strip(),
            target_file=target_file,
            project_path=project_path,
            substitutions=substitutions,
            rule_content="",
            section_key=section_key
        )
    skeleton = format_skeleton_content(skeleton, target_file, file_kind)
    validate_java = helpers.get("validate_java_package_and_imports")
    if str(target_file or "").lower().endswith(".java") and callable(validate_java):
        package_contract = validate_java(
            template=skeleton,
            module_id=str(payload.get("moduleId") or "").strip(),
            business_facts_path=str(payload.get("businessFactsPath") or "").strip(),
            target_file=target_file
        )
        if not package_contract.get("ok"):
            return fallback(
                "blocked_java_package_import_mismatch",
                package_contract.get("message") or "Java package/import 与计划不一致。",
                target_file, file_kind, section_key, output_dir, package_contract
            )
    java_contract = _validate_builtin_java_contract(
        skeleton=skeleton,
        payload=payload,
        target_file=target_file,
        project_path=project_path,
        file_kind=file_kind,
        business_facts_path=str(payload.get("businessFactsPath") or "").strip()
    )
    if not java_contract.get("ok"):
        return fallback(
            "blocked_java_dependency_binding_mismatch",
            java_contract.get("message") or "生成的 Java 未使用 Builder 确认的依赖绑定。",
            target_file,
            file_kind,
            section_key,
            output_dir,
            java_contract
        )
    sha256 = helpers["sha256"]
    protected_lines = helpers["protected_lines"](skeleton, target_file)
    method_signatures = helpers["method_signatures"](skeleton, target_file)
    method_names = sorted({item.get("name") for item in method_signatures if item.get("name")})

    helpers["write_source_atomic"](target_file, skeleton)

    dependency_patches = []
    for dependency in rendered.get("requiredDependencies") or []:
        patch = _ensure_maven_dependency(project_path, target_file, dependency)
        if patch:
            dependency_patches.append(patch)

    entry = {
        "targetFile": target_file,
        "status": "materialized",
        "rulePath": "__builtin__:" + str(rendered.get("ruleAlias") or ""),
        "ruleFilePath": "",
        "sectionKey": section_key,
        "sectionTitle": section_key,
        "fileKind": file_kind,
        "templateFingerprint": sha256(skeleton),
        "outputSha256": sha256(skeleton),
        "protectedLineHashes": protected_lines,
        "editableRanges": helpers["editable_ranges"](skeleton),
        "aiTodoPlaceholders": [],
        "substitutionsApplied": {k: str(v) for k, v in substitutions.items()},
        "unresolvedPlaceholders": [],
        "methodSignatures": method_signatures,
        "methodNames": method_names
    }
    if context.get("responseStyle"):
        entry["responseStyle"] = context.get("responseStyle")
    if dependency_patches:
        entry["dependencyPatches"] = dependency_patches
    if stripped_substitutions:
        entry["substitutionsStripped"] = stripped_substitutions

    manifest = {
        "generator": "python-skeleton-strict-materialize",
        "schemaVersion": 3,
        "mode": "strictMaterialize",
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "versionBucket": payload.get("versionBucket") or "",
        "projectPath": project_path,
        "files": [entry],
        "status": "materialized"
    }
    if stripped_substitutions:
        manifest["substitutionsStripped"] = stripped_substitutions
    if dependency_patches:
        manifest["dependencyPatches"] = dependency_patches

    manifest_path = _write_manifest_when_explicit_output_dir(payload, target_file, manifest)
    return {
        "ok": True,
        "manifestPath": manifest_path,
        "manifest": manifest,
        "materializedFiles": [entry],
        "fallbackFiles": [],
        "targetFile": target_file,
        "status": "materialized"
    }


def _is_workflow_builtin(file_kind, section_key):
    if file_kind not in ("Action", "HtmlPage"):
        return False
    return str(section_key or "").strip() in (
        "WorkflowMyListAction",
        "WorkflowAction",
        "WorkflowMyListHtmlPage",
        "WorkflowHtmlPage",
        "WorkflowDetailHtmlPage"
    )


def _package_from_target(target_file):
    parts = os.path.abspath(target_file).replace("\\", "/").split("/")
    try:
        idx = len(parts) - 1 - parts[::-1].index("java")
    except ValueError:
        return ""
    return ".".join(part for part in parts[idx + 1:-1] if part)


def _html_name_from_target(target_file):
    name = os.path.basename(str(target_file or ""))
    return os.path.splitext(name)[0]


def _class_name_from_target(target_file):
    return os.path.splitext(os.path.basename(target_file))[0]


def _strip_wrapped_prefix_suffix(value, suffixes):
    name = str(value or "").strip()
    if name.startswith("Gxh") and len(name) > 3:
        name = name[3:]
    for suffix in suffixes:
        if name.endswith(suffix) and len(name) > len(suffix):
            return name[:-len(suffix)]
    return name


def _lower_first(value):
    text = str(value or "").strip()
    return text[:1].lower() + text[1:] if text else ""


def _read_rest_return_contract(project_path):
    contract_path = os.path.join(project_path, ".ai-workspace", "project", "rest-interface-style.contract.json")
    if not os.path.isfile(contract_path):
        return {}, contract_path
    try:
        with open(contract_path, "r", encoding="utf-8") as handle:
            payload = json.load(handle)
        primary = str(payload.get("primaryReturnPattern") or "").strip()
        status = str(payload.get("status") or "").strip()
        if primary and (not status or status == "detected"):
            return payload, contract_path
    except Exception:
        return {}, contract_path
    return {}, contract_path


def _is_same_or_child(child_path, parent_path):
    child = os.path.abspath(child_path)
    parent = os.path.abspath(parent_path)
    try:
        return os.path.commonpath([child, parent]) == parent
    except ValueError:
        return False


def _build_builtin_context(payload, target_file, project_path, file_kind, substitutions):
    package_name = _package_from_target(target_file)
    class_name = _class_name_from_target(target_file)
    module_id = str(payload.get("moduleId") or "").strip()
    business_facts_path = str(payload.get("businessFactsPath") or "").strip()
    entity_name = str(substitutions.get("{EntityName}") or substitutions.get("{FeatureName}") or "").strip()
    if not entity_name:
        entity_name = _strip_wrapped_prefix_suffix(class_name, ["RestController", "Job"])
    operation_name = str(substitutions.get("{OperationName}") or substitutions.get("{operationName}") or "").strip()
    if not operation_name:
        operation_name = _strip_wrapped_prefix_suffix(class_name, ["Job", "RestController"])
    module_name = str(substitutions.get("{module}") or substitutions.get("{模块}") or "").strip()
    if not module_name:
        module_name = _lower_first(_strip_wrapped_prefix_suffix(class_name, ["RestController", "Job"]))
    service_ref = _resolve_service_ref_from_plan(
        business_facts_path,
        module_id,
        package_name,
        target_file=target_file,
        file_kind=file_kind
    )
    # Job 是调度入口，必须有 Builder 已确认的 ServiceApi。不能因为依赖图
    # 没给出绑定就按 Job 名称拼一个不存在的 I<Something>JobService。
    if file_kind == "Job" and not service_ref.get("confirmed"):
        return {
            "ok": False,
            "errorCode": service_ref.get("errorCode") or "DESIGN_TDD_JOB_SERVICE_BINDING_MISSING",
            "message": service_ref.get("message")
                or "Job 缺少唯一的 Builder ServiceApi 绑定，禁止按文件名猜测 Service。",
            "missingFields": service_ref.get("missingFields")
                or ["skeletonDependencyGraph.targetBindings.requiredTypeBindings(ServiceApi)"]
        }
    service_interface = service_ref.get("interfaceName") or ""
    service_import = service_ref.get("importName") or ""
    section_key = str(payload.get("sectionKey") or "").strip()

    if _is_workflow_builtin(file_kind, section_key):
        workflow_context = _resolve_workflow_context(
            payload=payload,
            target_file=target_file,
            project_path=project_path,
            package_name=package_name,
            class_name=class_name,
            module_id=module_id,
            business_facts_path=business_facts_path,
            substitutions=substitutions,
            service_interface=service_interface,
            service_import=service_import
        )
        if workflow_context.get("ok") is False:
            return workflow_context
        return workflow_context

    if file_kind == "Rest":
        rest_contract, contract_path = _read_rest_return_contract(project_path)
        return_pattern = str(rest_contract.get("primaryReturnPattern") or "").strip()
        interface_contract = _resolve_rest_interface_contract(substitutions, module_name)
        if interface_contract.get("ok") is False:
            return interface_contract
        if not return_pattern:
            return {
                "packageName": package_name,
                "className": class_name,
                "requestMapping": interface_contract.get("basePath"),
                "serviceInterface": service_interface if service_ref.get("confirmed") else "",
                "serviceImport": service_import if service_ref.get("confirmed") else "",
                "responseStyle": "single_response",
                "restStyleFallback": {
                    "reason": "REST_STYLE_CONTRACT_MISSING",
                    "contractPath": contract_path,
                    "source": "company_default_single_response"
                },
                "featureDescription": entity_name or operation_name or class_name,
                "methods": interface_contract.get("methods")
            }
        return_import = _resolve_rest_return_import(project_path, rest_contract)
        return {
            "packageName": package_name,
            "className": class_name,
            "requestMapping": interface_contract.get("basePath"),
            "serviceInterface": service_interface if service_ref.get("confirmed") else "",
            "serviceImport": service_import if service_ref.get("confirmed") else "",
            "additionalImports": [return_import] if return_import else [],
            "jsonReturnExpression": return_pattern,
            "featureDescription": entity_name or operation_name or class_name,
            "methods": interface_contract.get("methods")
        }
    if file_kind == "Job":
        return {
            "packageName": package_name,
            "className": class_name,
            "operationName": operation_name or entity_name or class_name,
            "taskDescription": operation_name or entity_name or class_name,
            "serviceInterface": service_interface,
            "serviceImport": service_import
        }
    return {}


def _resolve_workflow_context(payload, target_file, project_path, package_name, class_name,
                              module_id, business_facts_path, substitutions, service_interface,
                              service_import=""):
    plan = _read_plan_near_business_facts(business_facts_path)
    module_entry = _find_plan_module(plan, module_id)
    business_context = (module_entry or {}).get("businessContext") or {}
    file_kind = str(payload.get("fileKind") or "").strip()
    section_key = str(payload.get("sectionKey") or "").strip()
    # 文件可归并到查询入口，但流程合同仍属于文件记录的原始模块。
    owner_file = next((item for item in module_entry.get("ownerFiles") or []
                       if _normalize_binding_path(item.get("resolvedPath"))
                       == _normalize_binding_path(target_file)), {})
    source_id = str(owner_file.get("evidenceRef") or module_id).strip()
    source_context = _workflow_module_context(plan, source_id)
    if not source_context:
        return _workflow_context_missing(["workflowContract.sourceModuleId"])
    workflow_contract = _first_workflow_contract(source_context)
    if not workflow_contract:
        contracts = (_read_business_facts(business_facts_path).get("businessFacts") or {}).get("workflowContracts") or []
        matching = [item for item in contracts if isinstance(item, dict)
                    and str(item.get("moduleId") or "").strip() == source_id]
        workflow_contract = matching[0] if len(matching) == 1 else {}
    data_access_plan = _resolve_data_access_plan(business_facts_path, module_id, plan)
    table = _select_module_table(business_facts_path, source_id, source_context, plan, data_access_plan)
    table_name = str(table.get("tableName") or "").strip()
    table_display = str(table.get("tableComment") or source_context.get("businessObject") or "").strip()
    access_entity = data_access_plan.get("entity") if isinstance(data_access_plan.get("entity"), dict) else {}
    access_table = data_access_plan.get("table") if isinstance(data_access_plan.get("table"), dict) else {}
    access_service = data_access_plan.get("service") if isinstance(data_access_plan.get("service"), dict) else {}
    owner_entity_name = _resolve_owner_class_name(module_entry, "Entity")
    entity_name = str(
        owner_entity_name
        or access_entity.get("className")
        or access_table.get("entityName")
        or business_context.get("entityName")
        or substitutions.get("{EntityName}")
        or ""
    ).strip()
    if not entity_name:
        entity_name = _strip_wrapped_prefix_suffix(class_name, ["WorkFlowAction", "WorkflowAction", "MyListAction", "Action"])
    access_service_interface = str(access_service.get("interfaceName") or "").strip()
    if access_service_interface:
        service_interface = access_service_interface
    entity_import = (
        _resolve_owner_import(module_entry, "Entity", entity_name)
        or _resolve_source_import(access_entity.get("sourcePath"), entity_name)
        or _resolve_source_import(access_table.get("sourcePath"), entity_name)
    )
    service_import = (
        _resolve_owner_import(module_entry, "ServiceApi", service_interface)
        or _resolve_source_import(access_service.get("sourcePath"), service_interface)
        or str(service_import or "").strip()
    )
    # 页面只直接依赖 Action；沿配对 Action 读取同一套 Entity/Service 绑定。
    binding_target = target_file
    binding_kind = file_kind
    if file_kind == "HtmlPage":
        paired_class = _resolve_workflow_paired_action_class(module_entry, section_key)
        paired_file = next((item for item in module_entry.get("ownerFiles") or []
                            if item.get("fileKind") == "Action"
                            and _class_name_from_target(item.get("resolvedPath")) == paired_class), {})
        binding_target = paired_file.get("resolvedPath") or ""
        binding_kind = "Action"
    target_binding = _resolve_target_binding(plan, module_id, binding_target, binding_kind)
    if target_binding:
        refs = {}
        for kind in ("Entity", "ServiceApi"):
            required = [item for item in target_binding.get("requiredTypeBindings") or []
                        if isinstance(item, dict) and item.get("providerFileKind") == kind]
            ref = _type_binding_ref(plan, required[0]) if len(required) == 1 else {}
            if not ref.get("valid"):
                return _workflow_context_missing(["requiredTypeBindings(" + kind + ")"])
            refs[kind] = ref
        entity_name, entity_import = refs["Entity"]["expectedType"], refs["Entity"]["importName"]
        service_interface, service_import = refs["ServiceApi"]["expectedType"], refs["ServiceApi"]["importName"]
    page_name = str(business_context.get("pageName") or substitutions.get("{pagename}") or "").strip()
    if not page_name:
        page_name = _derive_page_name_from_target(target_file)
    controller_bean_name = _resolve_workflow_controller_bean_name(
        module_entry=module_entry,
        file_kind=file_kind,
        section_key=section_key,
        class_name=class_name,
        page_name=page_name
    )
    if not table_display:
        table_display = str(workflow_contract.get("processName") or entity_name or page_name).strip()
    missing = []
    if not workflow_contract:
        missing.append("workflowContract")
    if not table_name:
        missing.append("tableName")
    if not entity_name:
        missing.append("entityClassName")
    if not service_interface:
        missing.append("serviceInterface")
    if file_kind_is_java(file_kind) and not package_name:
        missing.append("actionPackageName")
    if file_kind == "Action" and not class_name:
        missing.append("actionClassName")
    if missing:
        return _workflow_context_missing(missing)
    return {
        "moduleName": str(business_context.get("moduleName") or table_display or entity_name).strip(),
        "pageName": page_name,
        "tableName": table_name,
        "tableDisplayName": table_display,
        "actionPackageName": package_name,
        "actionClassName": class_name,
        "controllerBeanName": controller_bean_name,
        "entityClassName": entity_name,
        "serviceInterface": service_interface,
        "entityImport": entity_import,
        "serviceImport": service_import,
        "serviceField": _lower_first(service_interface[1:]) if service_interface.startswith("I") and len(service_interface) > 1 else "service",
        "fileKind": file_kind,
        "sectionKey": section_key,
        "targetFileName": os.path.basename(str(target_file or "")),
        "workflowContract": workflow_contract,
        "workflowArtifactPolicy": {
            "owner": "design-stage-builder",
            "rule": "Workflow XML/MIS XML artifacts are generated by the design-stage Builder before SQL; Coder only reads them and never modifies them."
        }
    }


def _workflow_context_missing(missing):
    return {
        "ok": False,
        "errorCode": "WORKFLOW_BUILTIN_CONTEXT_MISSING",
        "message": "工作流骨架缺少必要上下文：" + ",".join(missing),
        "missingFields": missing
    }


def _workflow_module_context(plan, module_id):
    owner = _find_plan_module(plan, module_id)
    context = owner.get("businessContext") or {}
    if context:
        return context
    return next((item for item in (plan or {}).get("modulePlans") or []
                 if str(item.get("moduleId") or "").strip() == str(module_id).strip()), {})


def file_kind_is_java(file_kind):
    return file_kind in ("Action", "Rest", "Job", "Entity", "ServiceApi", "ServiceInternal", "ServiceImpl")


def _find_plan_module(plan, module_id):
    if not isinstance(plan, dict):
        return {}
    target = str(module_id or "").strip()
    for item in plan.get("modulesOwnerFiles") or []:
        if str((item or {}).get("moduleId") or "").strip() == target:
            return item or {}
    return {}


def _resolve_owner_import(module_entry, file_kind, class_name):
    target_kind = str(file_kind or "").strip()
    target_class = str(class_name or "").strip()
    if not isinstance(module_entry, dict) or not target_kind or not target_class:
        return ""
    for item in module_entry.get("ownerFiles") or []:
        if str((item or {}).get("fileKind") or "").strip() != target_kind:
            continue
        resolved = str((item or {}).get("resolvedPath") or "").strip()
        if _class_name_from_target(resolved) != target_class:
            continue
        package = _package_from_target(resolved)
        return package + "." + target_class if package else ""
    return ""


def _resolve_source_import(source_path, class_name):
    source = str(source_path or "").strip()
    target_class = str(class_name or "").strip()
    if not source or not target_class:
        return ""
    package = _package_from_target(source)
    return package + "." + target_class if package else ""


def _resolve_owner_class_name(module_entry, file_kind):
    target_kind = str(file_kind or "").strip()
    if not isinstance(module_entry, dict) or not target_kind:
        return ""
    for item in module_entry.get("ownerFiles") or []:
        if str((item or {}).get("fileKind") or "").strip() != target_kind:
            continue
        resolved = str((item or {}).get("resolvedPath") or "").strip()
        class_name = _class_name_from_target(resolved)
        if class_name:
            return class_name
    return ""


def _data_access_plan_items(source):
    if not isinstance(source, dict):
        return []
    raw = source.get("dataAccessPlans")
    if isinstance(raw, list):
        return [item for item in raw if isinstance(item, dict)]
    if not isinstance(raw, dict):
        return []
    plans_by_module = raw.get("plansByModuleId")
    if isinstance(plans_by_module, dict):
        return [item for item in plans_by_module.values() if isinstance(item, dict)]
    plans = raw.get("plans")
    if isinstance(plans, list):
        return [item for item in plans if isinstance(item, dict)]
    return [item for item in raw.values() if isinstance(item, dict)]


def _resolve_data_access_plan(business_facts_path, module_id, plan=None):
    target = str(module_id or "").strip()
    if not target:
        return {}
    sources = [_read_business_facts(business_facts_path)]
    sources.append(plan if isinstance(plan, dict) else _read_plan_near_business_facts(business_facts_path) or {})
    for source in sources:
        for item in _data_access_plan_items(source):
            if str(item.get("moduleId") or "").strip() == target:
                return item
    return {}


def _resolve_workflow_controller_bean_name(module_entry, file_kind, section_key, class_name, page_name):
    if str(file_kind or "").strip() == "Action" and str(class_name or "").strip():
        return str(class_name).strip().lower()
    paired_class = _resolve_workflow_paired_action_class(module_entry, section_key)
    if paired_class:
        return paired_class.lower()
    page = str(page_name or "").strip().lower()
    if str(section_key or "").strip() == "WorkflowMyListHtmlPage":
        return page + "mylistaction"
    if str(section_key or "").strip() in ("WorkflowHtmlPage", "WorkflowDetailHtmlPage"):
        return page + "workflowaction"
    return page + "action" if page else ""


def _resolve_workflow_paired_action_class(module_entry, section_key):
    mapping = {
        "WorkflowMyListHtmlPage": ("WorkflowMyListAction", "mylist"),
        "WorkflowHtmlPage": ("WorkflowAction", "workflow"),
        "WorkflowDetailHtmlPage": ("WorkflowAction", "workflow")
    }
    target_section, target_sub_type = mapping.get(str(section_key or "").strip(), ("", ""))
    if not isinstance(module_entry, dict) or not target_section:
        return ""
    owner_files = module_entry.get("ownerFiles") or []
    for item in owner_files:
        if str((item or {}).get("fileKind") or "").strip() != "Action":
            continue
        if str((item or {}).get("sectionKey") or "").strip() != target_section:
            continue
        class_name = _class_name_from_target(str((item or {}).get("resolvedPath") or "").strip())
        if class_name:
            return class_name
    for item in owner_files:
        if str((item or {}).get("fileKind") or "").strip() != "Action":
            continue
        if str((item or {}).get("subType") or "").strip() != target_sub_type:
            continue
        class_name = _class_name_from_target(str((item or {}).get("resolvedPath") or "").strip())
        if class_name:
            return class_name
    return ""


def _read_business_facts(business_facts_path):
    if not business_facts_path or not os.path.isfile(business_facts_path):
        return {}
    try:
        with open(business_facts_path, "r", encoding="utf-8") as handle:
            return json.load(handle)
    except Exception:
        return {}


def _first_workflow_contract(source):
    if not isinstance(source, dict):
        return {}
    contract = source.get("workflowContract")
    if isinstance(contract, dict) and contract:
        return contract
    contracts = source.get("workflowContracts")
    if isinstance(contracts, list):
        for item in contracts:
            if isinstance(item, dict) and item:
                return item
    for item in source.get("workflowContracts") or []:
        if isinstance(item, dict) and item:
            return item
    return {}


def _select_module_table(business_facts_path, module_id, business_context, plan=None, data_access_plan=None):
    facts = _read_business_facts(business_facts_path)
    tables = ((facts.get("businessFacts") or {}).get("databaseTables") or [])
    context = business_context or {}
    access = data_access_plan or {}
    carrier_id = str(context.get("carriedByModuleId") or access.get("carriedByModuleId") or "").strip()
    if carrier_id:
        carrier = _find_plan_module(plan, carrier_id)
        context = _workflow_module_context(plan, carrier_id)
        if not carrier and not context:
            return {}
    object_key = str(context.get("objectKey") or "").strip()
    explicit_table = str((access.get("table") or {}).get("tableName") or context.get("tableName") or "").strip()
    if object_key:
        matching = [table for table in tables if table.get("objectKey") == object_key]
        if explicit_table:
            matching = [table for table in matching if table.get("tableName") == explicit_table]
    elif explicit_table:
        matching = [table for table in tables if table.get("tableName") == explicit_table]
    else:
        target = carrier_id or str(module_id or "").strip()
        matching = [table for table in tables if table.get("moduleId") == target
                    or target in (table.get("relatedModuleIds") or [])]
    return matching[0] if len(matching) == 1 else {}


def _derive_page_name_from_target(target_file):
    stem = _html_name_from_target(target_file)
    lowered = stem.lower()
    for suffix in ("workflowdetail", "workflow", "mylist", "list", "add", "edit", "detail"):
        if lowered.endswith(suffix):
            return stem[:-len(suffix)]
    class_name = _class_name_from_target(target_file)
    if class_name:
        lowered_class = class_name.lower()
        for suffix in ("workflowaction", "mylistaction", "listaction", "action"):
            if lowered_class.endswith(suffix):
                return _lower_first(class_name[:-len(suffix)])
    return stem


def _xml_escape(value):
    text = str(value or "")
    return (text.replace("&", "&amp;")
                .replace('"', "&quot;")
                .replace("<", "&lt;")
                .replace(">", "&gt;"))


def _resolve_rest_interface_contract(substitutions, module_name):
    raw_contract = str((substitutions or {}).get("{RestContractJson}") or "").strip()
    contract = {}
    if raw_contract:
        try:
            parsed = json.loads(raw_contract)
            if isinstance(parsed, dict):
                contract = parsed
        except Exception:
            contract = {}
    base_path = str(contract.get("basePath") or (substitutions or {}).get("{RestBasePath}") or "").strip()
    if not base_path:
        return {
            "ok": False,
            "errorCode": "REST_INTERFACE_CONTRACT_BASE_PATH_MISSING",
            "message": "REST 骨架缺少设计阶段 restContract.basePath。请重跑设计/plan，禁止回退到模块名默认路径。"
        }
    operations = contract.get("operations") if isinstance(contract.get("operations"), list) else []
    methods = []
    method_name_indexes = {}
    route_indexes = {}
    for operation_index, item in enumerate(operations):
        if not isinstance(item, dict):
            continue
        java_name = str(item.get("methodName") or "").strip()
        path = str(item.get("path") or "").strip()
        if not java_name or not path:
            continue
        if java_name in method_name_indexes:
            first_index = method_name_indexes[java_name]
            return {
                "ok": False,
                "errorCode": "REST_INTERFACE_CONTRACT_DUPLICATE_METHOD_NAME",
                "message": (
                    "REST 合同存在重复 Java methodName：{}（operations[{}] 与 operations[{}]）。"
                    "同一 Controller 不能生成重复 Java 方法签名，请修复 Builder 投影后重新物化。"
                ).format(java_name, first_index, operation_index)
            }
        method_name_indexes[java_name] = operation_index
        http_method = str(item.get("httpMethod") or "POST").strip().upper() or "POST"
        route_key = (http_method, path)
        if route_key in route_indexes:
            first_index = route_indexes[route_key]
            return {
                "ok": False,
                "errorCode": "REST_INTERFACE_CONTRACT_DUPLICATE_ROUTE",
                "message": (
                    "REST 合同存在重复 HTTP 路由：{} {}（operations[{}] 与 operations[{}]）。"
                    "同一 Controller 不能生成重复路由，请修复 Builder 投影后重新物化。"
                ).format(http_method, path, first_index, operation_index)
            }
        route_indexes[route_key] = operation_index
        purpose = str(item.get("purpose") or java_name).strip()
        methods.append({
            "javaName": java_name,
            "path": path,
            "httpMethod": http_method,
            "description": purpose,
            "successMessage": str(item.get("successMessage") or "查询成功").strip() or "查询成功"
        })
    if not methods:
        method_name = str((substitutions or {}).get("{RestMethodName}") or "").strip()
        operation_path = str((substitutions or {}).get("{RestOperationPath}") or "").strip()
        if method_name and operation_path:
            methods.append({
                "javaName": method_name,
                "path": operation_path,
                "httpMethod": str((substitutions or {}).get("{RestHttpMethod}") or "POST").strip().upper() or "POST",
                "description": method_name,
                "successMessage": "查询成功"
            })
    if not methods:
        return {
            "ok": False,
            "errorCode": "REST_INTERFACE_CONTRACT_OPERATION_MISSING",
            "message": "REST 骨架缺少设计阶段 restContract.operations。请由设计 LLM 填写业务接口 methodName/path，禁止生成 queryList、/querylist 默认占位。"
        }
    return {
        "basePath": base_path,
        "methods": methods
    }


def _resolve_rest_return_import(project_path, rest_contract):
    pattern = str((rest_contract or {}).get("primaryReturnPattern") or "").strip()
    if "." not in pattern:
        return ""
    helper_class = pattern.split(".", 1)[0].strip()
    if not helper_class:
        return ""
    helper = (rest_contract or {}).get("returnHelper") or {}
    if isinstance(helper, dict):
        import_name = str(helper.get("importName") or "").strip()
        if import_name and import_name.endswith("." + helper_class):
            return import_name
    for rel in (rest_contract or {}).get("evidenceFiles") or []:
        source = _resolve_project_file(project_path, rel)
        imported = _find_import_for_simple_class(source, helper_class)
        if imported:
            return imported
    for item in (rest_contract or {}).get("returnPatterns") or []:
        if str((item or {}).get("pattern") or "").strip() != pattern:
            continue
        helper = (item or {}).get("returnHelper") or {}
        if isinstance(helper, dict):
            import_name = str(helper.get("importName") or "").strip()
            if import_name and import_name.endswith("." + helper_class):
                return import_name
        for rel in (item or {}).get("evidenceFiles") or []:
            source = _resolve_project_file(project_path, rel)
            imported = _find_import_for_simple_class(source, helper_class)
            if imported:
                return imported
    return ""


def _resolve_project_file(project_path, rel_path):
    raw = str(rel_path or "").strip()
    if not raw:
        return ""
    return raw if os.path.isabs(raw) else os.path.join(project_path, raw)


def _find_import_for_simple_class(source_file, simple_class):
    if not source_file or not os.path.isfile(source_file):
        return ""
    try:
        with open(source_file, "r", encoding="utf-8") as handle:
            text = handle.read()
    except Exception:
        return ""
    needle = "import "
    suffix = "." + str(simple_class or "").strip() + ";"
    for line in text.splitlines():
        stripped = line.strip()
        if stripped.startswith(needle) and stripped.endswith(suffix):
            return stripped[len(needle):].rstrip(";").strip()
    return ""


def _normalize_binding_path(value):
    raw = str(value or "").strip().replace("\\", "/")
    if not raw:
        return ""
    try:
        return os.path.abspath(raw).replace("\\", "/").lower()
    except (OSError, ValueError):
        return raw.lower()


def _path_from_file_identity(identity):
    raw = str(identity or "").strip()
    if ":" not in raw:
        return raw
    # providerFileIdentity 格式为 "<fileKind>:<absolute path>"；Windows 盘符
    # 位于第二个冒号之后，因此只拆最左侧的绑定类型分隔符。
    return raw.split(":", 1)[1]


def _resolve_target_binding(plan, module_id, target_file, file_kind):
    if not isinstance(plan, dict):
        return {}
    graph = plan.get("skeletonDependencyGraph") or {}
    bindings = graph.get("targetBindings") if isinstance(graph, dict) else []
    if not isinstance(bindings, list):
        return {}
    target_identity = "{}:{}".format(
        str(file_kind or "").strip(),
        _normalize_binding_path(target_file)
    )
    target_path = _normalize_binding_path(target_file)
    module_key = str(module_id or "").strip()
    kind_key = str(file_kind or "").strip()
    for binding in bindings:
        if not isinstance(binding, dict):
            continue
        identities = {
            str(binding.get("targetId") or "").strip().lower(),
            str(binding.get("providerFileIdentity") or "").strip().lower()
        }
        if target_identity.lower() in identities:
            return binding
        if (
            str(binding.get("moduleId") or "").strip() == module_key
            and str(binding.get("fileKind") or "").strip() == kind_key
            and _normalize_binding_path(binding.get("resolvedPath")) == target_path
        ):
            return binding
    return {}


def _java_imports(source):
    return [
        match.group(1).strip()
        for match in re.finditer(
            r"(?m)^\s*import\s+([A-Za-z_][A-Za-z0-9_.]*)\s*;",
            str(source or "")
        )
    ]


def _type_binding_ref(plan, required):
    """身份用于定位，resolvedPath 用于保留真实路径（含模块根和大小写）。"""
    identity = str(required.get("providerFileIdentity") or "").strip()
    graph = (plan or {}).get("skeletonDependencyGraph") or {}
    providers = graph.get("targetBindings") or []
    provider = next((
        item for item in providers if isinstance(item, dict)
        and str(item.get("providerFileIdentity") or item.get("targetId") or "").lower() == identity.lower()
    ), {})
    source_path = str(provider.get("resolvedPath") or _path_from_file_identity(identity)).strip()
    expected_type = str(required.get("expectedType") or "").strip()
    package = _package_from_target(source_path)
    return {
        "expectedType": expected_type,
        "sourcePath": source_path,
        "importName": package + "." + expected_type if package and expected_type else "",
        "valid": bool(
            expected_type and package
            and _class_name_from_target(source_path).lower() == expected_type.lower()
        )
    }


def _validate_builtin_java_contract(skeleton, payload, target_file, project_path,
                                    file_kind, business_facts_path):
    """内置 Java 骨架统一在写盘前对账 Builder 的最终类型绑定。"""
    if not str(target_file or "").lower().endswith(".java"):
        return {"ok": True}
    plan = _read_plan_near_business_facts(business_facts_path)
    target_binding = _resolve_target_binding(
        plan,
        str(payload.get("moduleId") or "").strip(),
        target_file,
        file_kind
    )
    if not target_binding:
        return {
            "ok": False,
            "errorCode": "DESIGN_TDD_SKELETON_TARGET_BINDING_MISSING",
            "message": "内置 Java 文件不在 Builder 骨架依赖图中，拒绝写盘。",
            "missingFields": ["skeletonDependencyGraph.targetBindings"]
        }
    required_services = [
        item for item in (target_binding.get("requiredTypeBindings") or [])
        if isinstance(item, dict) and str(item.get("providerFileKind") or "").strip() == "ServiceApi"
    ]
    required_types = list(required_services)
    if _is_workflow_builtin(file_kind, str(payload.get("sectionKey") or "").strip()):
        required_types += [item for item in target_binding.get("requiredTypeBindings") or []
                           if isinstance(item, dict) and item.get("providerFileKind") == "Entity"]
    imports = _java_imports(skeleton)
    imported_types = {item.rsplit(".", 1)[-1]: item for item in imports if "." in item}
    problems = []
    if file_kind == "Job" and len(required_services) != 1:
        problems.append(
            "Job 必须有唯一 ServiceApi 绑定，当前为 {}".format(len(required_services))
        )
    for required in required_types:
        ref = _type_binding_ref(plan, required)
        expected = ref["expectedType"]
        kind = required.get("providerFileKind")
        actual_import = imported_types.get(expected, "")
        if not ref["valid"]:
            problems.append(kind + " 的 expectedType 与 providerFileIdentity/resolvedPath 不一致")
            continue
        expected_import = ref["importName"]
        if actual_import != expected_import:
            problems.append(
                "{} {} 应引用 {}，实际为 {}".format(
                    kind, expected, expected_import, actual_import or "<missing>"
                )
            )
        # import 不能只出现而没有实际使用。去掉注释/import 后检查成员和
        # getComponent 的类型，防止正确 import 掩盖错误字段/容器引用。
        code = re.sub(r"/\*.*?\*/|//[^\n]*", "", skeleton, flags=re.S)
        code = re.sub(r"(?m)^\s*import\s+[^;]+;", "", code)
        if not re.search(r"\b" + re.escape(expected) + r"\b", code):
            problems.append("未使用确认的 " + kind + " 类型：" + expected)
        if file_kind == "Job" and not re.search(
                r"\bgetComponent\s*\(\s*" + re.escape(expected) + r"\.class\s*\)", code):
            problems.append("Job 未使用确认的 ServiceApi 容器类型：" + expected)
        local_source = ref["sourcePath"]
        if not os.path.isfile(local_source):
            problems.append("确认的 {} 源码不存在：{}".format(kind, local_source))
    if problems:
        return {
            "ok": False,
            "errorCode": "DESIGN_TDD_SKELETON_TYPE_PROJECTION_MISMATCH",
            "message": "；".join(problems),
            "expectedBindings": required_types,
            "actualImports": imports
        }
    return {"ok": True, "checked": True, "requiredServiceBindings": required_services}


def _resolve_service_ref_from_plan(business_facts_path, module_id, package_name,
                                   target_file="", file_kind=""):
    plan = _read_plan_near_business_facts(business_facts_path)
    if not plan or not module_id:
        return {}

    # 先消费 Builder 已确认的最终依赖图。它能表达 Job/REST 跨模块承载，
    # 不能退回当前模块名称推导。
    target_binding = _resolve_target_binding(plan, module_id, target_file, file_kind)
    if target_binding:
        required = [
            item for item in (target_binding.get("requiredTypeBindings") or [])
            if isinstance(item, dict) and str(item.get("providerFileKind") or "").strip() == "ServiceApi"
        ]
        if len(required) == 1:
            ref = _type_binding_ref(plan, required[0])
            if ref["valid"]:
                return {
                    "confirmed": True,
                    "interfaceName": ref["expectedType"],
                    "importName": ref["importName"],
                    "source": "skeletonDependencyGraph"
                }
            return {
                "confirmed": False,
                "errorCode": "DESIGN_TDD_SKELETON_TYPE_PROJECTION_MISMATCH",
                "message": "ServiceApi 的 expectedType 与 providerFileIdentity/resolvedPath 不一致。",
                "missingFields": ["skeletonDependencyGraph.targetBindings.requiredTypeBindings"]
            }
        if str(file_kind or "").strip() in ("Job", "Rest"):
            return {
                "confirmed": False,
                "errorCode": "DESIGN_TDD_JOB_SERVICE_BINDING_MISSING",
                "message": (
                    "Builder 依赖图未为 {}:{} 提供唯一 ServiceApi 绑定（实际 {} 个），"
                    "禁止按文件名猜测 Service。"
                ).format(module_id, file_kind or "target", len(required)),
                "missingFields": ["skeletonDependencyGraph.targetBindings.requiredTypeBindings(ServiceApi)"]
            }
        # 只有 Job 在缺失唯一 ServiceApi 时必须阻断。页面/工作流等模板
        # 可能没有直接的 type binding，但计划仍可能提供同模块已确认的
        # ServiceApi owner；下面继续按该物理文件读取，不按名称猜测。

    if str(file_kind or "").strip() in ("Job", "Rest"):
        return {"confirmed": False}
    modules = plan.get("modulesOwnerFiles") or []
    module_entry = None
    for item in modules:
        if str((item or {}).get("moduleId") or "").strip() == module_id:
            module_entry = item or {}
            break
    if not module_entry:
        return {}
    service_file = None
    for file_item in module_entry.get("ownerFiles") or []:
        if str((file_item or {}).get("fileKind") or "").strip() == "ServiceApi":
            service_file = file_item or {}
            break
    if not service_file:
        # 查询/统计入口本身可能只有 Action，真正的 Service 由
        # dataAccessPlans.carriedByModuleId 机械承载。不要按当前模块名
        # 猜一个 I<Statistics>Service，直接复用 Builder 已确认的 owner。
        plans = plan.get("dataAccessPlans") or {}
        if isinstance(plans, dict) and any(
                key in plans for key in ("schemaVersion", "plansByModuleId", "plans")):
            plans_by_module = plans.get("plansByModuleId")
            plan_list = plans.get("plans")
            plans = (list(plans_by_module.values()) if isinstance(plans_by_module, dict) and plans_by_module
                     else plan_list if isinstance(plan_list, list) else [])
        elif isinstance(plans, dict):
            plans = list(plans.values())
        for access_plan in plans if isinstance(plans, list) else []:
            if not isinstance(access_plan, dict):
                continue
            if str((access_plan or {}).get("moduleId") or "").strip() != module_id:
                continue
            service = (access_plan or {}).get("service") or {}
            interface_name = str(service.get("interfaceName") or "").strip()
            if interface_name:
                package = _package_from_target(str(service.get("sourcePath") or "").strip())
                return {
                    "confirmed": True,
                    "interfaceName": interface_name,
                    "importName": (package + "." + interface_name) if package else _service_import(package_name, interface_name)
                }
        return {"confirmed": False}
    resolved_path = str(service_file.get("resolvedPath") or "").strip()
    interface_name = _class_name_from_target(resolved_path)
    package = _package_from_target(resolved_path)
    if not interface_name:
        return {"confirmed": False}
    return {
        "confirmed": True,
        "interfaceName": interface_name,
        "importName": (package + "." + interface_name) if package else _service_import(package_name, interface_name)
    }


def _read_plan_near_business_facts(business_facts_path):
    if not business_facts_path:
        return None
    plan_path = os.path.join(os.path.dirname(os.path.abspath(business_facts_path)), "design-tdd-plan.json")
    if not os.path.isfile(plan_path):
        return None
    try:
        with open(plan_path, "r", encoding="utf-8") as handle:
            return json.load(handle)
    except Exception:
        return None


def _service_import(package_name, service_interface):
    if not package_name:
        return ""
    service_pkg = package_name
    if service_pkg.endswith(".rest"):
        service_pkg = service_pkg[:-5] + ".api"
    elif service_pkg.endswith(".job"):
        service_pkg = service_pkg[:-4] + ".api"
    return service_pkg + "." + service_interface


def _ensure_maven_dependency(project_path, target_file, dependency):
    group_id = str((dependency or {}).get("groupId") or "").strip()
    artifact_id = str((dependency or {}).get("artifactId") or "").strip()
    version_property = str((dependency or {}).get("versionProperty") or "").strip()
    version = str((dependency or {}).get("version") or "").strip()
    if not group_id or not artifact_id:
        return None
    nearest_pom = _find_nearest_pom(target_file, project_path)
    if not nearest_pom:
        return {
            "status": "pom_not_found",
            "dependency": dependency,
            "message": "未找到可补齐依赖的 pom.xml。"
        }
    owner_pom = _resolve_dependency_owner_pom(nearest_pom, project_path)
    try:
        with open(owner_pom, "r", encoding="utf-8") as handle:
            original = handle.read()
        updated, actions = _patch_pom_dependency(original, group_id, artifact_id, version_property, version)
        if updated != original:
            with open(owner_pom, "w", encoding="utf-8", newline="\n") as handle:
                handle.write(updated)
        return {
            "status": "patched" if updated != original else "already_present",
            "pomPath": owner_pom,
            "nearestPomPath": nearest_pom,
            "ownerScope": "local_parent" if os.path.abspath(owner_pom) != os.path.abspath(nearest_pom) else "module",
            "dependency": {
                "groupId": group_id,
                "artifactId": artifact_id,
                "versionProperty": version_property,
                "version": version
            },
            "actions": actions
        }
    except Exception as exc:
        return {
            "status": "patch_failed",
            "pomPath": owner_pom,
            "nearestPomPath": nearest_pom,
            "dependency": dependency,
            "message": str(exc)
        }


def _find_nearest_pom(target_file, project_path):
    current = os.path.abspath(os.path.dirname(target_file) or "")
    project = os.path.abspath(project_path or "")
    while current and _is_same_or_child(current, project):
        candidate = os.path.join(current, "pom.xml")
        if os.path.isfile(candidate):
            return candidate
        parent = os.path.dirname(current)
        if parent == current:
            break
        current = parent
    return ""


def _resolve_dependency_owner_pom(nearest_pom, project_path):
    owner = os.path.abspath(nearest_pom)
    current_dir = os.path.dirname(owner)
    project = os.path.abspath(project_path or "")
    while current_dir and _is_same_or_child(current_dir, project):
        parent_dir = os.path.dirname(current_dir)
        if parent_dir == current_dir or not _is_same_or_child(parent_dir, project):
            break
        parent_pom = os.path.join(parent_dir, "pom.xml")
        if not os.path.isfile(parent_pom):
            break
        module_name = os.path.basename(current_dir)
        if _pom_declares_module(parent_pom, module_name):
            owner = parent_pom
            current_dir = parent_dir
            continue
        break
    return owner


def _pom_declares_module(pom_path, module_name):
    try:
        with open(pom_path, "r", encoding="utf-8") as handle:
            text = handle.read()
    except Exception:
        return False
    if not _pom_is_packaging_pom(text):
        return False
    escaped = module_name.replace("\\", "/")
    return ("<module>{}</module>".format(escaped) in text
            or "<module>{}</module>".format(module_name) in text)


def _pom_is_packaging_pom(text):
    return "<packaging>pom</packaging>" in str(text or "")


def _patch_pom_dependency(text, group_id, artifact_id, version_property, version):
    actions = []
    updated = str(text or "")
    if "<artifactId>{}</artifactId>".format(artifact_id) in updated:
        return updated, ["dependency_already_present"]
    if version_property and "<{}>".format(version_property) not in updated:
        property_line = "\n\t\t<{}>{}</{}>".format(version_property, version, version_property)
        if "</properties>" in updated:
            updated = updated.replace("</properties>", property_line + "\n\t</properties>", 1)
            actions.append("property_added")
        else:
            insert_block = "\n\t<properties>{}\n\t</properties>\n".format(property_line)
            updated = _insert_before_first(updated, ["<dependencies>", "<dependencyManagement>", "<build>", "</project>"], insert_block)
            actions.append("properties_created")
    version_expr = "${" + version_property + "}" if version_property else version
    dependency_block = "\n\t\t<dependency>\n\t\t\t<groupId>{}</groupId>\n\t\t\t<artifactId>{}</artifactId>\n\t\t\t<version>{}</version>\n\t\t</dependency>\n".format(
        group_id, artifact_id, version_expr)
    if "</dependencies>" in updated:
        updated = updated.replace("</dependencies>", dependency_block + "\t</dependencies>", 1)
        actions.append("dependency_added")
    else:
        dependencies_block = "\n\t<dependencies>{}\t</dependencies>\n".format(dependency_block)
        updated = _insert_before_first(updated, ["<dependencyManagement>", "<build>", "</project>"], dependencies_block)
        actions.append("dependencies_created")
    return updated, actions


def _insert_before_first(text, markers, block):
    positions = []
    for marker in markers:
        idx = text.find(marker)
        if idx >= 0:
            positions.append(idx)
    if not positions:
        return text + block
    idx = min(positions)
    return text[:idx] + block + text[idx:]


def _write_manifest_when_explicit_output_dir(payload, target_file, manifest):
    raw_output_dir = str(payload.get("outputDir") or "").strip()
    if not raw_output_dir:
        return ""
    output_dir = os.path.abspath(raw_output_dir)
    source_dir = os.path.abspath(os.path.dirname(target_file) or "")
    if output_dir == source_dir:
        return ""
    os.makedirs(output_dir, exist_ok=True)
    manifest_path = os.path.join(output_dir, "skeleton-output-manifest.json")
    with open(manifest_path, "w", encoding="utf-8", newline="\n") as handle:
        json.dump(manifest, handle, ensure_ascii=False, indent=2)
    return manifest_path
