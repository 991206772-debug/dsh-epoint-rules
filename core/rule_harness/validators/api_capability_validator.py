import os
import re
from typing import Any, Dict, Iterable, List, Set


def _as_list(value: Any) -> List[Any]:
    return value if isinstance(value, list) else []


def _compile(pattern: Any):
    source = str(pattern or "").strip()
    if not source:
        return None
    try:
        return re.compile(source)
    except re.error:
        return re.compile(re.escape(source))


def _read_all_text(target_files: Iterable[Any]) -> str:
    chunks: List[str] = []
    for item in target_files or []:
        file_path = str(item if isinstance(item, str) else (item.get("path") or item.get("filePath") or ""))
        if not file_path or not os.path.isfile(file_path):
            continue
        with open(file_path, "r", encoding="utf-8", errors="ignore") as handle:
            chunks.append(handle.read())
    return "\n".join(chunks)


def _matches_any(text: str, patterns: Iterable[Any]) -> bool:
    compiled = [_compile(pattern) for pattern in patterns]
    compiled = [regex for regex in compiled if regex]
    return any(regex.search(text) for regex in compiled)


def _capability_aliases(contract: Dict[str, Any]) -> Set[str]:
    aliases = {
        str(contract.get("capabilityId") or "").strip(),
        str(contract.get("serviceInterface") or "").strip(),
    }
    for action in _as_list(contract.get("actions")):
        if isinstance(action, dict):
            aliases.add(str(action.get("name") or "").strip())
            aliases.add(str(action.get("method") or "").strip())
    return {item for item in aliases if item}


def _is_referenced(aliases: Set[str], referenced: Set[str]) -> bool:
    for alias in aliases:
        for item in referenced:
            if item == alias or alias in item or item in alias:
                return True
    return False


def validate_api_capability(contract: Dict[str, Any], target_files: Iterable[Any], context: Dict[str, Any]) -> List[Dict[str, Any]]:
    referenced = {str(item or "").strip() for item in context.get("referencedCapabilities", []) if str(item or "").strip()}
    aliases = _capability_aliases(contract)
    if not _is_referenced(aliases, referenced):
        return []

    text = _read_all_text(target_files)
    rule_name = context.get("ruleName", "")
    source_path = context.get("sourcePath", "")
    capability_id = str(contract.get("capabilityId") or contract.get("serviceInterface") or rule_name)
    required = contract.get("requiredWhenReferenced") if isinstance(contract.get("requiredWhenReferenced"), dict) else {}
    violations: List[Dict[str, Any]] = []

    imports = _as_list(required.get("importsAnyOf"))
    if imports and not _matches_any(text, imports):
        violations.append({
            "code": "API_CAPABILITY_IMPORT_MISSING",
            "ruleName": rule_name,
            "sourcePath": source_path,
            "problem": f"已引用 API 能力 {capability_id}，但缺少接口导入或声明",
            "location": "targetFiles",
            "message": f"API_CAPABILITY_IMPORT_MISSING: {capability_id}",
            "fix": "按对应后台接口规范补齐 service interface 的 import、注入或获取方式。",
        })

    usages = _as_list(required.get("usageAnyOf"))
    if usages and not _matches_any(text, usages):
        violations.append({
            "code": "API_CAPABILITY_USAGE_MISSING",
            "ruleName": rule_name,
            "sourcePath": source_path,
            "problem": f"已引用 API 能力 {capability_id}，但缺少方法调用证据",
            "location": "targetFiles",
            "message": f"API_CAPABILITY_USAGE_MISSING: {capability_id}",
            "fix": "按设计蓝图中声明的 API 能力补齐对应 method 调用，或回到设计阶段移除该能力引用。",
        })

    for pattern in _as_list(contract.get("forbiddenWhenReferenced")):
        regex = _compile(pattern)
        if regex and regex.search(text):
            violations.append({
                "code": "API_CAPABILITY_FORBIDDEN_PATTERN",
                "ruleName": rule_name,
                "sourcePath": source_path,
                "problem": f"API 能力 {capability_id} 命中禁止写法",
                "location": "targetFiles",
                "message": f"API_CAPABILITY_FORBIDDEN_PATTERN: {capability_id} -> {pattern}",
                "fix": "删除禁止写法，改用后台接口规范声明的 service 方法。",
            })

    return violations
