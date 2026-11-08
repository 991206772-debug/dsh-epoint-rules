import os
import re
from typing import Any, Dict, Iterable, List


def _compile(pattern: Any):
    source = str(pattern or "").strip()
    if not source:
        return None
    literal = re.match(r"^/(.*)/([a-zA-Z]*)$", source)
    try:
        if literal:
            flags = 0
            if "i" in literal.group(2):
                flags |= re.IGNORECASE
            if "m" in literal.group(2):
                flags |= re.MULTILINE
            return re.compile(literal.group(1), flags)
        return re.compile(source)
    except re.error:
        return None


def _as_list(value: Any) -> List[Any]:
    return value if isinstance(value, list) else []


def _normalize_path(path: str) -> str:
    return str(path or "").replace("\\", "/")


def _read_target_files(target_files: Iterable[Any]) -> List[Dict[str, str]]:
    result: List[Dict[str, str]] = []
    for item in target_files or []:
        if isinstance(item, str):
            file_path = item
            file_kind = ""
        elif isinstance(item, dict):
            file_path = str(item.get("path") or item.get("filePath") or "")
            file_kind = str(item.get("fileKind") or item.get("type") or "")
        else:
            continue
        if not file_path or not os.path.isfile(file_path):
            continue
        with open(file_path, "r", encoding="utf-8", errors="ignore") as handle:
            result.append({
                "path": _normalize_path(file_path),
                "fileKind": file_kind,
                "content": handle.read(),
            })
    return result


def _fingerprint_payload(contract: Dict[str, Any]) -> Dict[str, Any]:
    fingerprint = contract.get("fingerprint") if isinstance(contract, dict) else {}
    return fingerprint if isinstance(fingerprint, dict) else contract


def _validate_bucket(bucket: Dict[str, Any], files: List[Dict[str, str]], context: Dict[str, Any]) -> List[Dict[str, Any]]:
    violations: List[Dict[str, Any]] = []
    rule_name = context.get("ruleName", "")
    source_path = context.get("sourcePath", "")
    scope = context.get("scope", "ALL")
    all_text = "\n".join(item.get("content", "") for item in files)

    min_files = bucket.get("min_files", bucket.get("minFiles"))
    if isinstance(min_files, int) and len(files) < min_files:
        violations.append({
            "code": "FILE_KIND_COUNT_BELOW_MIN",
            "ruleName": rule_name,
            "sourcePath": source_path,
            "problem": f"{scope} 文件数量不足",
            "location": scope,
            "message": f"FILE_KIND_COUNT_BELOW_MIN: {scope} need>={min_files}, actual={len(files)}",
            "fix": "按 resolved file list 补齐该 fileKind 的生成文件。",
        })

    for pattern in _as_list(bucket.get("required_path_patterns", bucket.get("requiredPathPatterns"))):
        regex = _compile(pattern)
        if regex and not any(regex.search(item.get("path", "")) for item in files):
            violations.append({
                "code": "MISSING_REQUIRED_FILE_KIND_PATH",
                "ruleName": rule_name,
                "sourcePath": source_path,
                "problem": "缺少规则要求的文件路径",
                "location": scope,
                "message": f"MISSING_REQUIRED_FILE_KIND_PATH: {scope} -> {pattern}",
                "fix": "确认设计 resolved 清单和实际生成文件路径是否符合规则合同。",
            })

    for group in _as_list(bucket.get("must_have_groups", bucket.get("mustHaveGroups"))):
        patterns = group if isinstance(group, list) else [group]
        compiled = [_compile(pattern) for pattern in patterns]
        compiled = [regex for regex in compiled if regex]
        if compiled and not any(regex.search(all_text) for regex in compiled):
            violations.append({
                "code": "MISSING_FINGERPRINT_GROUP",
                "ruleName": rule_name,
                "sourcePath": source_path,
                "problem": "缺少规则要求的代码指纹",
                "location": scope,
                "message": f"MISSING_FINGERPRINT_GROUP: {scope} -> {' OR '.join(map(str, patterns))}",
                "fix": "按命中的代码生成规范补齐对应模板片段或 API 调用。",
            })

    for pattern in _as_list(bucket.get("forbidden_patterns", bucket.get("forbiddenPatterns"))):
        regex = _compile(pattern)
        if not regex:
            continue
        hit_file = next((item for item in files if regex.search(item.get("content", ""))), None)
        if hit_file:
            violations.append({
                "code": "FORBIDDEN_PATTERN",
                "ruleName": rule_name,
                "sourcePath": source_path,
                "problem": "命中规则禁止写法",
                "location": hit_file.get("path", scope),
                "message": f"FORBIDDEN_PATTERN: {scope} -> {pattern} in {hit_file.get('path', '')}",
                "fix": "删除禁止写法，改用当前版本桶或 profile 规则声明的模板。",
            })

    return violations


def validate_code_fingerprint(contract: Dict[str, Any], target_files: Iterable[Any], context: Dict[str, Any]) -> List[Dict[str, Any]]:
    files = _read_target_files(target_files)
    fingerprint = _fingerprint_payload(contract)
    violations = _validate_bucket(fingerprint, files, { **context, "scope": "ALL" })
    by_file_kind = fingerprint.get("by_file_kind", fingerprint.get("byFileKind"))
    if isinstance(by_file_kind, dict):
        for file_kind, bucket in by_file_kind.items():
            scoped = [item for item in files if item.get("fileKind") == file_kind]
            if isinstance(bucket, dict):
                violations.extend(_validate_bucket(bucket, scoped, { **context, "scope": str(file_kind) }))
    return violations
