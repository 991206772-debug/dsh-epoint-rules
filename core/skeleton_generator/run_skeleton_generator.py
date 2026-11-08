#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""Generate strict rule-based skeleton files for backend/admin shells.

规则驱动原则：
- 骨架模板全部来自规则库中的 .md 规则文件，不写死在 Python 代码中
- 通过 frontmatter 的 version_bucket + rule_alias 定位精确规则文件
- 模板片段从规则文件中的 ```java 代码块提取
- 占位符（{模块}/{EntityName} 等）从规则文件的占位符说明表格提取并替换
- AI_TODO 由 Python 生成，插入到骨架中引导后续 AI 精修
"""

import argparse
import hashlib
import json
import os
import re
import sys
from datetime import datetime, timezone

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
if SCRIPT_DIR and SCRIPT_DIR not in sys.path:
    sys.path.insert(0, SCRIPT_DIR)

from reuse_query_skeleton_generator import (
    get_template as get_reuse_query_template,
    is_reuse_query_section,
    post_fill_action as post_fill_reuse_query_action,
    post_fill_html_page as post_fill_reuse_query_html_page,
    query_bind_fields as reuse_query_bind_fields,
)
from statistics_skeleton_generator import (
    is_statistics_section,
    post_fill_action as post_fill_statistics_action,
    post_fill_html_page as post_fill_statistics_html_page,
)
from skeleton_formatter import format_skeleton_content
from strict_builtin_renderer import (
    materialize_builtin_renderer,
    _normalize_binding_path,
    _resolve_target_binding,
    _type_binding_ref,
)

STRICT_PLACEHOLDER_PATTERN = re.compile(r'\{[A-Za-z0-9_\u4e00-\u9fff]+\}')


# ============================================================
# 规则文件解析
# ============================================================

def parse_frontmatter(content):
    """从 .md 文件中解析 frontmatter，返回 {key: value} 字典"""
    if not content.startswith('---'):
        return {}
    end = content.find('\n---\n', 3)
    if end == -1:
        return {}
    yaml_text = content[3:end]
    result = {}
    for line in yaml_text.splitlines():
        line = line.strip()
        if ':' in line:
            key, _, value = line.partition(':')
            result[key.strip()] = value.strip()
    return result


def extract_java_blocks(content):
    """从 markdown 内容中提取所有 ```java ... ``` 代码块，按出现顺序返回"""
    blocks = []
    pattern = re.compile(r'```java\s*\n(.*?)\n```', re.DOTALL)
    for match in pattern.finditer(content):
        blocks.append(match.group(1).rstrip())
    return blocks


def extract_section_blocks(content):
    """将 markdown 内容按 ## 标题分段，返回 {标题: 内容} 字典"""
    sections = {}
    pattern = re.compile(r'^## (.+)$', re.MULTILINE)
    prev_pos = None
    for match in pattern.finditer(content):
        if prev_pos is not None:
            section_content = content[prev_pos:match.start()].strip()
            sections[prev_title] = section_content
        prev_title = match.group(1).strip()
        prev_pos = match.end()
    if prev_pos is not None:
        sections[prev_title] = content[prev_pos:].strip()
    return sections


def extract_placeholder_table(section_content):
    """从 ## 占位符说明 表格中提取占位符映射 {占位符: 说明}"""
    placeholders = {}
    table_pattern = re.compile(r'\|\s*\{([^}]+)\}\s*\|', re.MULTILINE)
    for match in table_pattern.finditer(section_content):
        placeholder = match.group(1).strip()
        placeholders['{' + placeholder + '}'] = True
    return placeholders


# ============================================================
# 规则库查找
# ============================================================

def find_rule_file(version_bucket, rule_alias, rules_base_dir):
    """
    在 rules_base_dir 下递归查找匹配 version_bucket 和 rule_alias 的 .md 文件。
    返回文件绝对路径，找不到返回 None。
    """
    if not os.path.isdir(rules_base_dir):
        return None
    for root, dirs, files in os.walk(rules_base_dir):
        for filename in files:
            if not (filename.endswith('.md') or filename.endswith('.mdc')):
                continue
            filepath = os.path.join(root, filename)
            try:
                with open(filepath, 'r', encoding='utf-8') as f:
                    content = f.read()
            except (OSError, UnicodeDecodeError):
                continue
            fm = parse_frontmatter(content)
            if (fm.get('version_bucket', '').strip() == version_bucket.strip()
                    and fm.get('rule_alias', '').strip() == rule_alias.strip()):
                return filepath
    return None


def extract_file_kind_template(rule_content, file_kind_label, section_blocks):
    """
    从规则内容中提取指定 fileKind 的代码模板。
    1. 在 section_blocks 中找 "## Entity" / "## Service接口" 等标题
    2. 提取标题下的 ```java 代码块
    3. 返回代码块内容
    """
    # 标题映射
    title_map = {
        'Entity': ['Entity', '实体', 'Entity ('],
        'ServiceApi': ['Service接口', 'Service 接口', 'ServiceApi'],
        'ServiceInternal': ['Service内部类', 'ServiceImpl', 'ServiceImpl ('],  # 内部逻辑类
        'ServiceImpl': ['Service实现类', 'ServiceImpl'],  # 可能与 ServiceInternal 合并
        'Action': ['ListAction', 'Action'],
        'Rest': ['REST', 'Rest', 'RestController'],
        'Job': ['定时任务', 'Job'],
    }
    target_titles = title_map.get(file_kind_label, [file_kind_label])

    # 遍历 section_blocks，找匹配标题
    for section_title, section_content in section_blocks.items():
        for target in target_titles:
            if target.lower() in section_title.lower():
                blocks = extract_java_blocks(section_content)
                if blocks:
                    # 取第一个 java 块作为模板
                    return blocks[0]
                # 如果标题下没有代码块，可能是正文描述，继续在正文找
                inner_blocks = extract_java_blocks(section_content)
                if inner_blocks:
                    return inner_blocks[0]

    # 回退：全文扫描 java 块
    blocks = extract_java_blocks(rule_content)
    if blocks:
        return blocks[0]
    return None


# ============================================================
# 骨架生成核心
# ============================================================

def requirement_id(batch):
    for group_name in ("todoList", "coverageMap", "testCases", "tddPlan"):
        group = batch.get(group_name)
        if isinstance(group, list) and group:
            value = str(group[0].get("requirementPointId") or "").strip()
            if value:
                return value
    return "REQ-001"


def test_case_id(batch):
    group = batch.get("testCases")
    if isinstance(group, list) and group:
        value = str(group[0].get("testCaseId") or group[0].get("id") or "").strip()
        if value:
            return value
    return "TC-001"


def ai_todo_marker(batch, purpose):
    """生成 AI_TODO 占位符，嵌入骨架引导后续 AI 精修"""
    rid = requirement_id(batch)
    tcid = test_case_id(batch)
    return f"AI_TODO[{rid}][{tcid}]: {purpose}"


def safe_join(project_path, relative_path):
    normalized = str(relative_path or "").replace("\\", "/").lstrip("/")
    if not normalized or ".." in normalized.split("/"):
        raise ValueError("unsafe relative path: %s" % relative_path)
    root = os.path.abspath(project_path)
    # 手动检查 target 是否在 project_path 下
    if os.name == 'nt':
        # Windows: 忽略大小写
        root_lower = root.lower()
        target_lower = os.path.abspath(os.path.join(root, normalized)).lower()
        if not target_lower.startswith(root_lower + "\\") and target_lower != root_lower:
            raise ValueError("path escapes project: %s" % relative_path)
        return os.path.abspath(os.path.join(root, normalized))
    else:
        # POSIX: 严格路径检查
        target = os.path.abspath(os.path.join(root, normalized))
        if not target.startswith(root + "/"):
            raise ValueError("path escapes project: %s" % relative_path)
        return target


def class_name_of(file_info):
    return logical_entity_name_of(file_info)


def strip_java_shell_name(name):
    """从最终 Java 文件名还原规则模板需要的逻辑实体名。"""
    value = str(name or "").strip()
    if not value:
        return ""
    value = re.sub(r'\.java$', '', value, flags=re.IGNORECASE)
    if value.startswith("IGxh") and value.endswith("Service"):
        return value[4:-7] or value
    if value.startswith("Gxh") and value.endswith("ServiceImpl"):
        return value[3:-11] or value
    if value.startswith("Gxh") and value.endswith("Service"):
        return value[3:-7] or value
    if value.startswith("Gxh"):
        return value[3:] or value
    if value.endswith("ServiceImpl"):
        return value[:-11] or value
    if value.endswith("Service"):
        return value[:-7] or value
    return value


def logical_entity_name_of(file_info):
    explicit = str(file_info.get("entityName") or file_info.get("featureName") or "").strip()
    if explicit:
        return strip_java_shell_name(explicit)
    base = os.path.basename(str(file_info.get("path") or "Generated.java"))
    return strip_java_shell_name(os.path.splitext(base)[0]) or "Generated"


def package_of(relative_path):
    """从 resolved Java 物理路径推导 package。"""
    normalized = str(relative_path or "").replace("\\", "/")
    marker = "/src/main/java/"
    marker_index = normalized.find(marker)
    if marker_index >= 0:
        package_part = normalized[marker_index + len(marker):]
    elif normalized.startswith("src/main/java/"):
        package_part = normalized[len("src/main/java/"):]
    else:
        return ""
    dirs = package_part.split("/")[:-1]
    package = ".".join(part for part in dirs if part)
    return package if re.match(r'^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*$', package) else ""


def apply_package_from_path(skeleton, relative_path):
    package = package_of(relative_path)
    if not package:
        return skeleton
    package_line = f"package {package};"
    if re.search(r'^\s*package\s+[\w.]+\s*;', skeleton, flags=re.MULTILINE):
        return re.sub(r'^\s*package\s+[\w.]+\s*;', package_line, skeleton, count=1, flags=re.MULTILINE)
    return f"{package_line}\n\n{skeleton}"


def infer_module(relative_path):
    """从文件路径推断业务模块名（优先取 api/entity/action 同级目录）"""
    normalized = str(relative_path or "").replace("\\", "/")
    parts = normalized.split("/")
    keywords = {"api", "action", "rest", "impl", "entity", "service"}
    for i, part in enumerate(parts):
        if part.lower() in keywords and i > 0:
            return parts[i - 1]
    # fallback：找最后一个不含 . 的非保留词
    for part in reversed(parts):
        if part and part not in {"src", "main", "java"} and "." not in part:
            return part
    return "module"


def infer_pagename(relative_path):
    """从文件路径推断 pagename（如 gxhnoticelistaction -> gxhnotice）"""
    base = os.path.basename(str(relative_path or ""))
    stem = re.sub(r'\.[^.]+$', '', base)
    m = re.match(r'([a-zA-Z]+?)(List|Add|Edit|Detail|Submit|Rest|Api|Action)?$', stem, re.IGNORECASE)
    if m:
        return m.group(1).lower()
    return ""


def infer_table_name(file_info, module):
    """推断数据库表名"""
    database_contract = file_info.get("databaseNamingContract") if isinstance(file_info.get("databaseNamingContract"), dict) else {}
    explicit = str(
        file_info.get("expectedTableName")
        or file_info.get("tableName")
        or database_contract.get("expectedTableName")
        or database_contract.get("tableName")
        or database_contract.get("physicalTableName")
        or ""
    ).strip()
    if explicit:
        return explicit
    return ""


def build_sql_skeleton(file_info, batch):
    relative_path = str(file_info.get("path") or "")
    module = infer_module(relative_path)
    table_name = infer_table_name(file_info, module)
    logical_name = logical_entity_name_of(file_info)
    if table_name:
        return "\n".join([
            f"-- AI_TODO[{requirement_id(batch)}][{test_case_id(batch)}]: 按 designCompact / 2_设计蓝图 / code-authoring-contract 精修表 {table_name} 的 DDL 字段、索引和注释。",
            f"-- 表名: {table_name}",
            f"-- 逻辑实体: {logical_name}",
            ""
        ])
    return "\n".join([
        f"-- {ai_todo_marker(batch, '上游合同缺少 expectedTableName/tableName/databaseNamingContract.tableName，禁止生成 *_table 假表名；请按 resolved/design 合同补齐真实表名后精修 SQL。')}",
        f"-- 逻辑实体: {logical_name}",
        ""
    ])


def build_skeleton_context(file_info, batch, version_bucket):
    """
    从规则文件中提取骨架模板并渲染占位符。
    返回渲染后的骨架代码字符串。
    """
    class_name = class_name_of(file_info)
    relative_path = str(file_info.get("path") or "")
    file_kind = str(file_info.get("fileKind") or "")
    module = infer_module(relative_path)
    table_name = infer_table_name(file_info, module)
    pagename = infer_pagename(relative_path)
    if file_kind == "Sql":
        return build_sql_skeleton(file_info, batch)
    rule_alias_map = {
        'Entity': '代码生成规范-后端实体层',
        'ServiceApi': '代码生成规范-后端实体层',
        'ServiceInternal': '代码生成规范-后端实体层',
        'ServiceImpl': '代码生成规范-后端实体层',
        'Action': '代码生成规范-后端控制层',
        'Rest': '代码生成规范-后端控制层',
        'Job': '定时任务Job开发规范',
    }
    rule_alias = rule_alias_map.get(file_kind, '代码生成规范-后端实体层')

    # 查找规则文件
    rules_base = os.path.join(os.path.dirname(__file__), '..', '..', '..', 'rules', 'project', 'projectrules')
    rule_path = find_rule_file(version_bucket, rule_alias, rules_base)
    if not rule_path:
        # 回退：在 rules 目录父级查找
        rules_base = os.path.join(os.path.dirname(__file__), '..', '..', '..', '..', 'rules', 'project', 'projectrules')
        rule_path = find_rule_file(version_bucket, rule_alias, rules_base)

    if not rule_path:
        # 最终回退：通用空壳
        ai_todo = ai_todo_marker(batch, "按规则库 [未找到规则文件] 补齐代码")
        fallback = f"public class {class_name} {{\n    // {ai_todo}\n}}\n"
        return apply_package_from_path(fallback, relative_path)

    with open(rule_path, 'r', encoding='utf-8') as f:
        rule_content = f.read()

    section_blocks = extract_section_blocks(rule_content)
    template_code = extract_file_kind_template(rule_content, file_kind, section_blocks)

    if not template_code:
        ai_todo = ai_todo_marker(batch, f"按规则 [{rule_alias}]({os.path.basename(rule_path)}) 补齐代码")
        fallback = f"// 模板提取失败，规则文件: {os.path.basename(rule_path)}\npublic class {class_name} {{\n    // {ai_todo}\n}}\n"
        return apply_package_from_path(fallback, relative_path)

    # 占位符替换
    substitutions = {
        '{模块}': module,
        '{module}': module,
        '{EntityName}': class_name,
        '{表名}': table_name,
        '{table_name}': table_name,
        '{pagename}': pagename,
        '{project}': module,
    }
    skeleton = template_code
    for placeholder, value in substitutions.items():
        skeleton = skeleton.replace(placeholder, value)

    # 清理未替换的占位符行（注释掉或删除），避免骨架含无效代码
    # 保留已正确替换的行，只清理 {xxx} 未被替换的行
    lines = skeleton.splitlines()
    cleaned_lines = []
    for line in lines:
        # 如果行中有未替换的 {xxx} 占位符
        if re.search(r'\{[^}]+\}', line):
            # rowguid 主键行特殊处理：替换 {长度} → 50
            if 'rowguid' in line.lower():
                line = re.sub(r'\{长度\}', '50', line)
                line = re.sub(r'\{[^}]+\}', '', line).rstrip()
                if line.strip():
                    cleaned_lines.append(line)
            else:
                # 其他未替换占位符行：注释掉，保留作为 AI 补全提示
                stripped = re.sub(r'\{[^}]+\}', '???', line).rstrip()
                if stripped and not stripped.startswith('// ???'):
                    cleaned_lines.append(f"// TODO骨架占位符未填: {stripped}")
        else:
            cleaned_lines.append(line)
    skeleton = "\n".join(cleaned_lines)

    # 追加 AI_TODO（如果模板中没有）
    if 'AI_TODO[' not in skeleton:
        ai_todo = ai_todo_marker(batch, f"按规则 [{rule_alias}]({os.path.basename(rule_path)}) 补齐业务字段和方法签名")
        skeleton += f"\n// {ai_todo}\n"

    return apply_package_from_path(skeleton, relative_path)


def read_json(file_path):
    if not file_path or not os.path.exists(file_path):
        return {}
    with open(file_path, "r", encoding="utf-8") as handle:
        return json.load(handle)


def write_text(file_path, content):
    os.makedirs(os.path.dirname(file_path), exist_ok=True)
    if os.path.exists(file_path):
        with open(file_path, "r", encoding="utf-8", errors="ignore") as handle:
            existing = handle.read()
        if "AI_TODO[" not in existing:
            return "skipped_existing", existing.count("AI_TODO[")
    content = format_skeleton_content(content, file_path, "")
    with open(file_path, "w", encoding="utf-8", newline="\n") as handle:
        handle.write(content)
    return "generated", content.count("AI_TODO[")


def _strict_write_manifest_when_explicit_output_dir(payload, target_file, manifest):
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


def run_strict_materialize(input_path):
    """
    Strict materialize entry point used by the design_tdd skeleton Builder.

    Constraints:
    - No calls to build_skeleton_context / infer_module / infer_pagename / infer_table_name / extract_file_kind_template
    - Section matching is exact prefix match only (fail-closed)
    - Fallback writes to manifest only, no empty stubs
    """
    payload = read_json(input_path)
    rule_file_path = str(payload.get("ruleFilePath") or "").strip()
    section_key = str(payload.get("sectionKey") or "").strip()
    section_key_candidates = []
    for candidate in payload.get("sectionKeyCandidates") or []:
        candidate = str(candidate or "").strip()
        if candidate and candidate not in section_key_candidates:
            section_key_candidates.append(candidate)
    if section_key and section_key not in section_key_candidates:
        section_key_candidates.insert(0, section_key)
    target_file = os.path.abspath(str(payload.get("targetFile") or "").strip())
    project_path = os.path.abspath(str(payload.get("projectPath") or "").strip())
    substitutions = payload.get("substitutions") or {}
    file_kind = str(payload.get("fileKind") or "").strip()
    module_id = str(payload.get("moduleId") or "").strip()
    business_facts_path = str(payload.get("businessFactsPath") or "").strip()
    action = str(payload.get("action") or "create").strip().lower()
    output_dir = str(payload.get("outputDir") or os.path.dirname(target_file) or "").strip()
    eligible_kinds = set(str(item) for item in (payload.get("skeletonEligibleFileKinds") or []))
    placeholder_sources = set(str(item) for item in (payload.get("placeholderSources") or []))

    if action != "create":
        return _strict_materialize_fallback("skipped_by_action",
            f"Strict materialize only supports action=create, actual={action}", target_file, file_kind, section_key, output_dir)
    if eligible_kinds and file_kind not in eligible_kinds:
        return _strict_materialize_fallback("fallback_unsupported_kind",
            f"Unsupported fileKind for strict materialize: {file_kind}", target_file, file_kind, section_key, output_dir)
    if not _strict_is_same_or_child(target_file, project_path):
        return _strict_materialize_fallback("blocked_target_out_of_project",
            f"targetFile is outside projectPath: {target_file}", target_file, file_kind, section_key, output_dir)
    # 故事线：LLM 在多次 fileKind 调用之间复制 substitutions 入参时，常带过来上一次的
    # 多余 key（不同 fileKind 占位符不同），过去会以 blocked_illegal_substitution_key
    # 直接 fail-close，把 LLM 推进 "改 → blocked → 再改" 死循环。
    # 修复：illegal key 自动剔除而不是 blocked，剔除清单写进 manifest 供审计；
    # 真正能让物化失败的事情在后面的 section/code-block 校验里拦得到，不会让错代码混过。
    #
    # P3.2 关键修复（2026-05）：LLM 经常按 Python/JSON 习惯传不带花括号的 key
    # （`"EntityName": "Place"` 而不是 `"{EntityName}": "Place"`），过去全部被
    # 当 illegal key 剔除→substitutionsApplied 全空→骨架文件里残留 {EntityName}
    # {模块} 字面占位符→LLM 看到产物是占位符堆只好整文件 Write 重写凭印象的版本→
    # 整个骨架机制失效。
    # 修复：先做"裸 key→花括号 key"自动归一化，归一后再走 placeholder_sources 白名单。
    # 占位符形式是确定事实（规则模板硬约定），不是 LLM 决策；Builder 必须兼容化。
    normalized_substitutions = {}
    substitution_key_normalized_log = []
    for raw_key, value in (substitutions or {}).items():
        key_str = str(raw_key or "").strip()
        if not key_str:
            continue
        # 已经带花括号 → 原样保留
        if key_str.startswith("{") and key_str.endswith("}"):
            normalized_substitutions[key_str] = value
            continue
        # 裸 key → 加花括号；与 placeholder_sources 白名单匹配上才采用
        wrapped = "{" + key_str + "}"
        if (not placeholder_sources) or (wrapped in placeholder_sources):
            normalized_substitutions[wrapped] = value
            substitution_key_normalized_log.append({"from": key_str, "to": wrapped})
        else:
            # 既不带花括号、加花括号也不在白名单 → 留给后面 illegal key 剔除逻辑统一处理
            normalized_substitutions[key_str] = value
    substitutions = normalized_substitutions

    stripped_substitutions = {}
    if placeholder_sources:
        illegal_substitution_keys = sorted([key for key in substitutions.keys() if key not in placeholder_sources])
        if illegal_substitution_keys:
            substitutions = {key: value for key, value in substitutions.items() if key in placeholder_sources}
            stripped_substitutions = {
                "stripped_keys": illegal_substitution_keys,
                "reason": "not_in_placeholder_sources",
                "kept_keys": sorted(list(substitutions.keys())),
                "note": "Builder 自动剔除非白名单 substitution key，避免 LLM 在多次 fileKind 调用之间复制入参时撞死循环；保留剔除审计供事后追溯。"
            }
    if substitution_key_normalized_log:
        # 归一化日志合并到 stripped_substitutions（同一审计入口），供事后排查 LLM 入参形式问题
        if not stripped_substitutions:
            stripped_substitutions = {"stripped_keys": [], "reason": "none", "kept_keys": sorted(list(substitutions.keys())), "note": ""}
        stripped_substitutions["normalized_keys"] = substitution_key_normalized_log
        stripped_substitutions["normalization_note"] = (
            "Builder 把 LLM 传的裸 key（如 EntityName）自动加花括号变成白名单 key（{EntityName}），"
            "占位符形式是规则模板硬约定，不是 LLM 决策，Builder 强制兼容。"
        )

    builtin_result = materialize_builtin_renderer(
        payload=payload,
        target_file=target_file,
        project_path=project_path,
        file_kind=file_kind,
        section_key=section_key,
        output_dir=output_dir,
        substitutions=substitutions,
        stripped_substitutions=stripped_substitutions,
        helpers={
            "fallback": _strict_materialize_fallback,
            "sha256": _strict_sha256,
            "protected_lines": _strict_compute_protected_lines,
            "editable_ranges": _strict_compute_editable_ranges,
            "method_signatures": _strict_extract_method_signatures,
            "post_fill_by_file_kind": _post_fill_by_file_kind,
            "validate_java_package_and_imports": _validate_java_package_and_imports,
            "write_source_atomic": _strict_write_source_atomic
        }
    )
    if builtin_result is not None:
        return builtin_result

    statistics_section = is_statistics_section(file_kind, section_key)
    if not rule_file_path or not os.path.isfile(rule_file_path):
        return _strict_materialize_fallback("fallback_rule_file_missing",
            f"Rule file not found: {rule_file_path}", target_file, file_kind, section_key, output_dir)
    if not section_key_candidates:
        return _strict_materialize_fallback("blocked_section_key_missing",
            "sectionKey is required", target_file, file_kind, section_key, output_dir)

    with open(rule_file_path, "r", encoding="utf-8") as f:
        rule_content = f.read()
    # Parse sections by ## title (exact prefix match)
    sections = _strict_parse_sections(rule_content)
    matched_title = None
    matched_content = None
    for candidate in section_key_candidates:
        for title, content in sections.items():
            if _strict_section_title_matches(title, candidate):
                matched_title = title
                matched_content = content
                if not statistics_section:
                    section_key = candidate
                break
        if matched_content is not None:
            break

    if matched_content is None:
        builtin_template = get_reuse_query_template(file_kind, section_key)
        if statistics_section:
            builtin_template = ""
        if not builtin_template:
            return _strict_materialize_fallback("fallback_section_missing",
                f"Section '{' | '.join(section_key_candidates)}' not found in rule file: {os.path.basename(rule_file_path)}",
                target_file, file_kind, section_key, output_dir)
        matched_title = section_key
        template = builtin_template
    else:
        # Extract code block from the section
        code_blocks = _strict_extract_code_blocks(matched_content, target_file)
        if not code_blocks:
            return _strict_materialize_fallback("fallback_no_code_block",
                f"No code block found in section '{section_key}'",
                target_file, file_kind, section_key, output_dir)
        template = code_blocks[0]

    # Apply substitutions
    for placeholder, value in substitutions.items():
        template = template.replace(placeholder, str(value))

    service_projection = _resolve_entityless_service_projection(
        business_facts_path, module_id, target_file, file_kind
    )
    if service_projection.get("ok") is False:
        return _strict_materialize_fallback(
            "blocked_java_dependency_binding_mismatch",
            service_projection["message"], target_file, file_kind, section_key,
            output_dir, service_projection
        )

    # P4 阶段：fileKind 后处理 hook —— Builder 把"机械映射代码"自动展开，
    # 让 LLM 物化产物直接成"半成品到成品"，不再凭印象填业务字段。
    # 故事线：Entity 13 个字段的 getter/setter / ServiceImpl 7 个 @Override 转发
    # 都是确定性映射（databaseColumns → getter/setter / ServiceApi 签名 → 转发实现），
    # LLM 不应该看到 AI_TODO，应该看到完整代码。
    # 失败容忍：缺 business-facts.json / 缺 moduleId / 缺字段都 silent skip，
    # 走原 AI_TODO 路径，物化主链路不断。
    template = _post_fill_by_file_kind(
        template=template,
        file_kind=file_kind,
        module_id=module_id,
        business_facts_path=business_facts_path,
        target_file=target_file,
        project_path=project_path,
        substitutions=substitutions,
        rule_content=rule_content,
        section_key=section_key,
        service_projection=service_projection
    )

    # 所有后处理（复合表单、子表查询、代码项、附件）都可能追加 Java import。
    # 这里必须再用 ownerFiles 的 resolvedPath 做一次最终投影；只在后处理前修正
    # 会让后追加的 import 重新退化成缺 domain 的包名。
    if str(target_file or '').lower().endswith('.java'):
        template = _normalize_java_package_and_imports(
            template=template,
            module_id=module_id,
            business_facts_path=business_facts_path,
            target_file=target_file
        )
        java_contract = _validate_java_package_and_imports(
            template=template,
            module_id=module_id,
            business_facts_path=business_facts_path,
            target_file=target_file
        )
        if not java_contract['ok']:
            return _strict_materialize_fallback(
                'blocked_java_package_import_mismatch',
                java_contract['message'],
                target_file,
                file_kind,
                section_key,
                output_dir,
                detail=java_contract
            )

    # Detect unresolved placeholders {xxx}
    unresolved = sorted(set(STRICT_PLACEHOLDER_PATTERN.findall(template)))

    # Generate AI_TODO for unresolved placeholders
    lines = template.splitlines()
    cleaned_lines = []
    ai_todo_placeholders = []
    editable_ranges = []
    for line in lines:
        line_placeholders = sorted(set(STRICT_PLACEHOLDER_PATTERN.findall(line)))
        if line_placeholders:
            original_line_no = len(cleaned_lines) + 1
            ai_todo_placeholders.extend(line_placeholders)
            source_line = STRICT_PLACEHOLDER_PATTERN.sub('<业务值>', line).rstrip()
            ai_todo_marker_text = f"AI_TODO[{','.join(line_placeholders)}]: 按业务替换原模板行: {source_line}"
            # Use appropriate comment style based on file extension
            ext = os.path.splitext(target_file)[1].lower()
            if ext in ('.html', '.htm', '.xhtml'):
                cleaned_lines.append(f"<!-- {ai_todo_marker_text} -->")
            elif ext in ('.sql', '.ddl'):
                cleaned_lines.append(f"-- {ai_todo_marker_text}")
            else:
                cleaned_lines.append(f"// {ai_todo_marker_text}")
            editable_ranges.append({
                "startLine": original_line_no,
                "endLine": original_line_no,
                "placeholders": line_placeholders
            })
        else:
            cleaned_lines.append(line)

    skeleton = "\n".join(cleaned_lines)
    skeleton = format_skeleton_content(skeleton, target_file, file_kind)

    # Compute hashes
    sha256_hash = _strict_sha256(skeleton)
    protected_lines = _strict_compute_protected_lines(skeleton, target_file)
    method_signatures = _strict_extract_method_signatures(skeleton, target_file)
    method_names = sorted({item.get("name") for item in method_signatures if item.get("name")})

    # Write file
    _strict_write_source_atomic(target_file, skeleton)

    # Build in-memory manifest. Design TDD persists materialize facts into
    # skeleton-manifests-ledger.json; no sidecar JSON is written beside source.
    entry = {
        "targetFile": target_file,
        "status": "materialized",
        "rulePath": rule_file_path,
        "ruleFilePath": rule_file_path,
        "sectionKey": section_key,
        "sectionTitle": matched_title,
        "fileKind": file_kind,
        "templateFingerprint": _strict_compute_template_fingerprint(template, substitutions),
        "outputSha256": sha256_hash,
        "protectedLineHashes": protected_lines,
        "editableRanges": editable_ranges,
        "aiTodoPlaceholders": sorted(set(ai_todo_placeholders)),
        "substitutionsApplied": {k: str(v) for k, v in substitutions.items()},
        "unresolvedPlaceholders": unresolved,
        "methodSignatures": method_signatures,
        "methodNames": method_names
    }
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
    manifest_path = _strict_write_manifest_when_explicit_output_dir(payload, target_file, manifest)

    return {
        "ok": True,
        "manifestPath": manifest_path,
        "manifest": manifest,
        "materializedFiles": [entry],
        "fallbackFiles": [],
        "targetFile": target_file,
        "status": "materialized"
    }


def _strict_write_source_atomic(target_file, content):
    """超时中断只会留下临时文件，不会让下次把半份目标源码当成 existing。"""
    import tempfile
    os.makedirs(os.path.dirname(target_file), exist_ok=True)
    # 临时文件放在已有的受管输入目录，不污染源码/页面目录。
    staging_dir = os.path.join(os.path.dirname(target_file), ".skeleton-input")
    os.makedirs(staging_dir, exist_ok=True)
    staged_path = ""
    try:
        with tempfile.NamedTemporaryFile(
                mode="w", encoding="utf-8", newline="\n",
                dir=staging_dir, prefix="source-", suffix=".tmp", delete=False) as handle:
            staged_path = handle.name
            handle.write(content)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(staged_path, target_file)
    finally:
        if staged_path and os.path.exists(staged_path):
            os.remove(staged_path)


def _strict_materialize_fallback(fallback_reason, message, target_file, file_kind, section_key, output_dir=None, detail=None):
    """Fallback handler: returns manifest facts only, no empty stubs or sidecar files."""
    output_dir = output_dir or (os.path.dirname(target_file) if target_file else "")
    detail = detail if isinstance(detail, dict) else {}
    entry = {
        "targetFile": target_file,
        "fileKind": file_kind,
        "sectionKey": section_key,
        "status": fallback_reason,
        "fallbackReason": fallback_reason,
        "fallbackMessage": message,
        **({"fallbackDetail": detail} if detail else {})
    }
    manifest = {
        "generator": "python-skeleton-strict-materialize",
        "schemaVersion": 3,
        "mode": "strictMaterialize",
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "files": [entry],
        "status": fallback_reason,
        "fallbackReason": fallback_reason,
        "fallbackMessage": message,
        **({"fallbackDetail": detail} if detail else {})
    }
    return {
        "ok": False,
        "manifestPath": "",
        "manifest": manifest,
        "materializedFiles": [],
        "fallbackFiles": [entry],
        "targetFile": target_file or "",
        "status": fallback_reason,
        "fallbackReason": fallback_reason,
        "fallbackMessage": message,
        **({"fallbackDetail": detail} if detail else {})
    }


def _strict_parse_sections(content):
    """Split markdown content by ## title, return {title: content} dict."""
    sections = {}
    pattern = re.compile(r'^## (.+)$', re.MULTILINE)
    prev_pos = None
    prev_title = None
    for match in pattern.finditer(content):
        if prev_pos is not None:
            sections[prev_title] = content[prev_pos:match.start()].strip()
        prev_title = match.group(1).strip()
        prev_pos = match.end()
    if prev_pos is not None:
        sections[prev_title] = content[prev_pos:].strip()
    return sections


def _strict_extract_java_blocks(content):
    """Extract ```java ... ``` blocks, matching backtick count."""
    blocks = []
    # Support 3+ backtick fences
    for match in re.finditer(r'(```+)java\s*\n(.*?)\n\1', content, re.DOTALL):
        blocks.append(match.group(2).rstrip())
    return blocks


def _strict_extract_code_blocks(content, target_file):
    """Extract language-specific fenced code blocks for strict materialize."""
    ext = os.path.splitext(target_file)[1].lower()
    if ext in ('.html', '.htm', '.xhtml'):
        languages = ['html']
    elif ext in ('.sql', '.ddl'):
        languages = ['sql']
    else:
        languages = ['java']
    blocks = []
    for language in languages:
        pattern = r'(```+)' + re.escape(language) + r'\s*\n(.*?)\n\1'
        for match in re.finditer(pattern, content, re.DOTALL | re.IGNORECASE):
            blocks.append(match.group(2).rstrip())
    return blocks


def _strict_section_title_matches(title, section_key):
    """Match sectionKey only when the key ends at title end, whitespace, half/full-width parens, or brackets."""
    title = str(title or '').strip()
    section_key = str(section_key or '').strip()
    if not title.startswith(section_key):
        return False
    if len(title) == len(section_key):
        return True
    # Accept ASCII '(', full-width '（', whitespace and brackets as title boundary.
    # 兼容前端规范 .md 标题里的全角括号（如 "## 列表页（管理端默认样例：...）"）
    return title[len(section_key)] in (' ', '(', '（', '[', '【')


def _strict_is_same_or_child(child, parent):
    if not child or not parent:
        return False
    child_abs = os.path.abspath(child)
    parent_abs = os.path.abspath(parent)
    if os.name == 'nt':
        child_abs = child_abs.lower()
        parent_abs = parent_abs.lower()
    return child_abs == parent_abs or child_abs.startswith(parent_abs.rstrip(os.sep) + os.sep)


def _strict_sha256(content):
    return "sha256:" + hashlib.sha256(str(content).encode('utf-8')).hexdigest()


def _strict_ai_todo_comment(file_path, purpose):
    """Generate AI_TODO comment in appropriate comment style for the file type."""
    ext = os.path.splitext(file_path)[1].lower()
    if ext in ('.html', '.htm', '.xhtml'):
        return f"<!-- AI_TODO: {purpose} -->"
    elif ext in ('.sql', '.ddl'):
        return f"-- AI_TODO: {purpose}"
    else:
        return f"// AI_TODO: {purpose}"


def _strict_compute_protected_lines(content, file_path):
    """
    Compute sha256 hash for each protected (non-AI_TODO) line.
    Protected lines = all template lines that are not AI_TODO placeholders.
    """
    hashes = []
    lines = content.splitlines()
    for i, line in enumerate(lines):
        stripped = line.strip()
        # Skip AI_TODO lines
        if 'AI_TODO' in stripped:
            continue
        # Skip blank lines
        if not stripped:
            continue
        line_hash = _strict_sha256(line)
        hashes.append({"lineNo": i + 1, "sha256": line_hash})
    return hashes


def _strict_compute_editable_ranges(content):
    """
    Compute editable ranges based on AI_TODO markers.
    Returns list of {startLine, endLine} - 1-indexed, inclusive.
    """
    ranges = []
    lines = content.splitlines()
    in_range = False
    range_start = None
    for i, line in enumerate(lines):
        if 'AI_TODO' in line:
            if not in_range:
                range_start = i + 1
                in_range = True
        else:
            if in_range:
                ranges.append({"startLine": range_start, "endLine": i})
                in_range = False
    if in_range:
        ranges.append({"startLine": range_start, "endLine": len(lines)})
    return ranges


def _strict_compute_template_fingerprint(template, substitutions):
    """Compute SHA-256 of template after substitution."""
    content = template
    for placeholder, value in substitutions.items():
        content = content.replace(placeholder, str(value))
    return _strict_sha256(content)


def _strict_extract_method_signatures(content, target_file):
    ext = os.path.splitext(target_file)[1].lower()
    if ext != ".java":
        return []
    signatures = []
    method_pattern = re.compile(
        r"(?m)^\s*(?:(?:public|protected|private)\s+)?"
        r"(?:static\s+|final\s+|synchronized\s+|abstract\s+|native\s+|default\s+)*"
        r"(?:<[^>\n]+>\s+)?"
        r"(?P<returnType>[\w<>\[\].?,\s]+?)\s+"
        r"(?P<name>[A-Za-z_][A-Za-z0-9_]*)\s*"
        r"\((?P<params>[^;{}()]*)\)\s*(?:throws\s+[^{;]+)?(?:[;{])"
    )
    control_keywords = {"if", "for", "while", "switch", "catch", "return", "new"}
    for match in method_pattern.finditer(content):
        name = match.group("name")
        if name in control_keywords:
            continue
        signatures.append({
            "name": name,
            "returnType": " ".join((match.group("returnType") or "").split()),
            "parameters": " ".join((match.group("params") or "").split()),
            "signature": " ".join(match.group(0).strip().rstrip("{;").split())
        })
    return signatures


# ============================================================================
# P4 阶段：fileKind 后处理（Builder 自动展开机械映射代码）
# ----------------------------------------------------------------------------
# 故事线：物化产物里 Entity 业务字段 / ServiceImpl 转发方法这种"看着规则模板
# 改个变量名"的代码本来就是机械映射，LLM 不该看到 AI_TODO 占位符。Builder
# 直接展开成完整代码，LLM 物化后看到的是"成品"，只在 ServiceInternal/Action
# 业务方法体 + HtmlPage 代码项/F9 控件这些真有歧义的地方写代码。
# ============================================================================

def _post_fill_by_file_kind(template, file_kind, module_id, business_facts_path,
                             target_file, project_path="", substitutions=None, rule_content="", section_key="",
                             service_projection=None):
    """按 fileKind 分发到不同的 strategy。失败时返回原 template，不阻断主链路。"""
    if not file_kind or not module_id:
        return template

    # 通用：所有 Java 文件先按 targetFile 反推 package（规则模板里 package 段可能漏 domain）
    # 这类事实来自 targetFile / design-tdd-plan.json，不依赖 business-facts 的业务字段。
    # Storys 模式下 business-facts 不再写 modules；若这里先读旧 modules 再短路，会导致
    # package/import 修正整段跳过，生成 com.epoint.xmgxh.place.* 这类少 domain 的残次品。
    if str(target_file or "").lower().endswith(".java"):
        template = _post_fill_package_from_target(template, target_file)
        template = _post_fill_imports_from_owner_files(
            template=template,
            module_id=module_id,
            business_facts_path=business_facts_path,
            target_file=target_file
        )

    # 无表 REST 的服务职责由最终文件合同决定，不依赖匹配数据库表或统计事实。
    projection = service_projection if service_projection is not None else _resolve_entityless_service_projection(
        business_facts_path, module_id, target_file, file_kind
    )
    if projection.get("entityless") and not projection.get("specialized"):
        return _render_entityless_service(template, projection, file_kind, target_file)

    facts = _load_module_business_facts(business_facts_path, module_id, target_file)
    if not facts:
        if is_statistics_section("Action", section_key):
            raise ValueError(
                "DESIGN_TDD_STATISTICS_CARRIER_PROJECTION_MISSING: "
                "统计 Action 缺少 business-facts 承载绑定。"
            )
        return template
    if is_statistics_section("Action", section_key):
        return post_fill_statistics_action(template, facts, target_file, project_path)
    if is_statistics_section("HtmlPage", section_key):
        return post_fill_statistics_html_page(template, facts, target_file)

    if file_kind == "Entity":
        return _post_fill_entity(template, facts, substitutions, business_facts_path)
    if file_kind == "ServiceApi":
        return _post_fill_service_api(template, facts, substitutions, target_file, project_path)
    if file_kind == "ServiceInternal":
        return _post_fill_service_internal(template, facts, substitutions, target_file, project_path)
    if file_kind == "ServiceImpl":
        return _post_fill_service_impl(template, facts, substitutions, target_file, project_path)
    if file_kind == "Action":
        return _post_fill_action(template, facts, substitutions, target_file, rule_content, section_key, project_path)
    if file_kind == "HtmlPage":
        return _post_fill_html_page(template, facts, substitutions, target_file, section_key)
    return template


def _resolve_entityless_service_projection(business_facts_path, module_id, target_file, file_kind):
    if file_kind not in ("ServiceApi", "ServiceInternal", "ServiceImpl"):
        return {}
    plan = _read_plan_near_business_facts(business_facts_path)
    binding = _resolve_target_binding(plan, module_id, target_file, file_kind)
    module = next((item for item in plan.get("modulesOwnerFiles") or []
                   if str(item.get("moduleId") or "") == str(module_id)), {})
    owner = next((item for item in module.get("ownerFiles") or []
                  if item.get("fileKind") == file_kind
                  and _normalize_binding_path(item.get("resolvedPath")) == _normalize_binding_path(target_file)), {})
    is_entityless = lambda item: item.get("serviceOnly") is True or item.get("noEntity") is True
    if not is_entityless(binding) and not is_entityless(owner):
        return {}
    required = binding.get("requiredTypeBindings") or []
    valid = bool(binding and owner and is_entityless(binding) == is_entityless(owner)
                 and not any(item.get("providerFileKind") == "Entity" for item in required))
    refs = [_type_binding_ref(plan, item) for item in required]
    if not valid or any(not ref["valid"] for ref in refs):
        return {
            "ok": False,
            "errorCode": "DESIGN_TDD_SKELETON_TYPE_PROJECTION_MISMATCH",
            "message": "Builder 无实体 Service 的目标绑定与 ownerFiles 不一致；请修复生成投影后重试，不要补表或改业务设计。"
        }
    service_refs = [ref for item, ref in zip(required, refs) if item.get("providerFileKind") == "ServiceApi"]
    if file_kind == "ServiceImpl" and len(service_refs) != 1:
        return {
            "ok": False,
            "errorCode": "DESIGN_TDD_SKELETON_TYPE_PROJECTION_MISMATCH",
            "message": "Builder 无实体 ServiceImpl 缺少唯一 ServiceApi 绑定；请修复生成投影后重试，不要补表或改业务设计。"
        }
    access = _select_data_access_plan_for_module(plan, module_id) or {}
    # 保留已有统计来源与复用表只读服务的专用投影，不能清空它们的业务合同。
    specialized = (module.get("businessContext") or {}).get("constructionSceneKey") == "statistics_analysis" or (
        access.get("mode") in ("statistics_source", "generated_service")
        or access.get("accessType") == "statistics_sources"
    )
    return {"ok": True, "entityless": True, "specialized": specialized,
            "serviceRef": service_refs[0] if service_refs else {}}


def _render_entityless_service(template, projection, file_kind, target_file):
    """保留规则中的框架声明，删除只适用于本地实体的 CRUD；不猜业务方法。"""
    class_name = _class_name_from_target_file(target_file)
    declared = re.search(r"\b(?:class|interface)\s+([A-Za-z_$][A-Za-z0-9_$]*)", template)
    if declared and declared.group(1) != class_name:
        template = re.sub(r"\b" + re.escape(declared.group(1)) + r"\b", class_name, template)
    body = "    // AI_TODO[ServiceBusiness]: 按当前 Story/AC 和 REST 合同实现业务，不要求本地实体或 CRUD。"
    if file_kind == "ServiceInternal":
        body = ("    protected ICommonDao baseDao;\n\n"
                "    public " + class_name + "() {\n"
                "        baseDao = CommonDao.getInstance();\n"
                "    }\n\n" + body)
    elif file_kind == "ServiceImpl":
        ref = projection["serviceRef"]
        template = re.sub(r"\bimplements\s+[A-Za-z_$][A-Za-z0-9_$]*", "implements " + ref["expectedType"], template)
        template = _ensure_java_imports(template, ["import " + ref["importName"] + ";"])
    template = _replace_java_type_body(template, body)
    # 空业务骨架只保留仍被声明、注解或 DAO 构造使用的 import。
    code = re.sub(r"(?m)^\s*import\s+[^;]+;", "", template)
    return re.sub(
        r"(?m)^\s*import\s+([A-Za-z_][A-Za-z0-9_.]*)\s*;\s*\n",
        lambda match: match.group(0) if re.search(r"\b" + re.escape(match.group(1).rsplit(".", 1)[-1]) + r"\b", code) else "",
        template
    )


def _load_module_business_facts(business_facts_path, module_id, target_file=""):
    """读 business-facts.json 取当前 moduleId 的业务表事实。失败返回 None。"""
    try:
        if not business_facts_path or not os.path.isfile(business_facts_path):
            return None
        with open(business_facts_path, "r", encoding="utf-8") as f:
            data = json.load(f)
        modules = (data or {}).get("modules") or {}
        legacy_facts = modules.get(module_id)
        if legacy_facts:
            return legacy_facts
        return _load_storys_business_facts_for_module(data, business_facts_path, module_id, target_file)
    except Exception:
        return None


def _load_storys_business_facts_for_module(data, business_facts_path, module_id, target_file=""):
    """
    Storys 模式不再写顶层 modules；业务字段在 businessFacts.databaseTables。
    后处理仍需要当前 module 的表字段，优先用设计文档 relatedModuleIds 精确关联，
    再用 plan ownerFiles / businessContext.entityName 回退匹配。
    """
    business_facts = (data or {}).get("businessFacts") or {}
    module_context = _load_module_plan_context(business_facts_path, module_id)
    statistics_contract = _select_statistics_contract_for_module(data, module_id, module_context)
    data_access_plan = _select_data_access_plan_for_module(data, module_id)
    # 当前模块的实体标识，用于匹配被承载模块的工作流合同
    carrier_entity_key = str(module_context.get("entityKey") or module_context.get("objectKey") or "").strip().lower()
    demand_tables = business_facts.get("databaseTables") or []
    if not isinstance(demand_tables, list) or not demand_tables:
        demand_tables = _load_design_database_tables(business_facts_path)
    if not isinstance(demand_tables, list) or not demand_tables:
        if statistics_contract:
            statistics_facts = {
                "databaseTables": [],
                "statisticsContract": statistics_contract,
                "entityName": str(module_context.get("entityName") or "").strip(),
                "serviceInterface": "I" + str(module_context.get("entityName") or "").strip() + "Service" if str(module_context.get("entityName") or "").strip() else ""
            }
            if data_access_plan:
                statistics_facts["dataAccessPlan"] = data_access_plan
            page_name = str(module_context.get("pageName") or module_context.get("pagename") or "").strip()
            if page_name:
                statistics_facts["pageName"] = page_name
            statistics_facts["serviceContractSeeds"] = _select_statistics_service_contract_seeds_for_module(
                data, module_id, statistics_contract, module_context
            )
            statistics_facts["actionContractSeeds"] = _select_action_contract_seeds_for_module(data, module_id)
            return statistics_facts
        return None

    matched_tables = _select_storys_tables_for_module(
        demand_tables=demand_tables,
        business_facts_path=business_facts_path,
        module_id=module_id,
        data_access_plan=data_access_plan,
        target_file=target_file
    )
    if not matched_tables:
        if not statistics_contract:
            return None
        matched_tables = []
    facts = {"databaseTables": matched_tables}
    workflow_contracts = _select_workflow_contracts_for_module(data, module_id, carrier_entity_key)
    if workflow_contracts:
        facts["workflowContracts"] = workflow_contracts
        seeds = []
        seen_seed_keys = set()
        for contract in workflow_contracts:
            for seed in contract.get("workflowExternalMethodSeeds") or []:
                if not isinstance(seed, dict):
                    continue
                key = (str(seed.get("methodName") or "").strip(), tuple(
                    str(parameter.get("name") or "").strip()
                    for parameter in seed.get("parameters") or []
                    if isinstance(parameter, dict)
                ))
                if not key[0] or key in seen_seed_keys:
                    continue
                seen_seed_keys.add(key)
                seeds.append(seed)
        if seeds:
            facts["workflowExternalMethodSeeds"] = seeds
    page_name = str(module_context.get("pageName") or module_context.get("pagename") or "").strip()
    if page_name:
        facts["pageName"] = page_name
    page_composition = module_context.get("pageComposition")
    if isinstance(page_composition, dict) and page_composition:
        referenced_keys = {
            str((block or {}).get("objectKey") or "").strip()
            for block in page_composition.get("blocks") or []
            if isinstance(block, dict)
        }
        known_keys = {str((table or {}).get("objectKey") or "").strip() for table in matched_tables}
        for table in demand_tables:
            object_key = str((table or {}).get("objectKey") or "").strip()
            if object_key and object_key in referenced_keys and object_key not in known_keys:
                matched_tables.append(table)
                known_keys.add(object_key)
        facts["pageComposition"] = page_composition
    if data_access_plan:
        facts["dataAccessPlan"] = data_access_plan
    query_filters = [
        item for item in business_facts.get("queryFilters") or []
        if isinstance(item, dict)
        and str(item.get("moduleId") or "").strip() == str(module_id or "").strip()
    ]
    if query_filters:
        facts["queryFilters"] = query_filters
    composition_child_queries = [
        item for item in business_facts.get("compositionChildQueries") or []
        if isinstance(item, dict)
        and str(item.get("moduleId") or "").strip() == str(module_id or "").strip()
    ]
    if composition_child_queries:
        facts["compositionChildQueries"] = composition_child_queries
    composition_form_bindings = [
        item for item in business_facts.get("compositionFormBindings") or []
        if isinstance(item, dict)
        and str(item.get("moduleId") or "").strip() == str(module_id or "").strip()
    ]
    if composition_form_bindings:
        facts["compositionFormBindings"] = composition_form_bindings
    facts["serviceContractSeeds"] = _select_service_contract_seeds_for_module(data, module_id)
    if statistics_contract and not facts["serviceContractSeeds"]:
        facts["serviceContractSeeds"] = _select_statistics_service_contract_seeds_for_module(
            data, module_id, statistics_contract, module_context
        )
    facts["actionContractSeeds"] = _select_action_contract_seeds_for_module(data, module_id)
    if statistics_contract:
        facts["statisticsContract"] = statistics_contract
        carried_service = data_access_plan.get("service") if isinstance(data_access_plan, dict) else {}
        if isinstance(carried_service, dict):
            service_interface = str(carried_service.get("interfaceName") or "").strip()
            if service_interface:
                facts["serviceInterface"] = service_interface
    entity_name = str(module_context.get("entityName") or "").strip()
    if entity_name:
        facts["entityName"] = entity_name
        if not facts.get("serviceInterface"):
            facts["serviceInterface"] = "I" + entity_name + "Service"
    return facts


def _select_service_contract_seeds_for_module(data, module_id):
    target = str(module_id or "").strip()
    out = []
    for seed in (data or {}).get("serviceContractSeeds") or []:
        if not isinstance(seed, dict):
            continue
        if str(seed.get("moduleId") or "").strip() == target:
            out.append(seed)
    return out


def _select_statistics_service_contract_seeds_for_module(
    data, module_id, statistics_contract=None, module_context=None
):
    """Select statistics methods for the page module from the carrier-owned seed.

    A statistics method is physically owned by the carrier Service, so its
    ``moduleId`` is the carrier module and its ``sourceModuleId`` is the
    statistics page module.  The page module's plan row may intentionally have
    no single ``storyId``; use the stable source-module binding first and only
    use the source story as a legacy fallback.
    """
    target_module_id = str(module_id or "").strip()
    context = module_context if isinstance(module_context, dict) else {}
    contract = statistics_contract if isinstance(statistics_contract, dict) else {}
    story_ids = {
        str(value or "").strip().upper()
        for value in (
            context.get("storyId"),
            contract.get("sourceStoryId"),
            contract.get("storyId")
        )
        if str(value or "").strip()
    }
    out = []
    for seed in (data or {}).get("serviceContractSeeds") or []:
        if not isinstance(seed, dict):
            continue
        if str(seed.get("sourceType") or "").strip() != "statisticsContract":
            continue
        if not str(seed.get("methodName") or "").strip():
            continue
        source_module_id = str(seed.get("sourceModuleId") or "").strip()
        if source_module_id and source_module_id == target_module_id:
            out.append(seed)
            continue
        if source_module_id:
            continue
        source_story_id = str(seed.get("sourceStoryId") or seed.get("storyId") or "").strip().upper()
        if source_story_id and source_story_id in story_ids:
            out.append(seed)
    return out


def _select_action_contract_seeds_for_module(data, module_id):
    target = str(module_id or "").strip()
    out = []
    for seed in (data or {}).get("actionContractSeeds") or []:
        if not isinstance(seed, dict):
            continue
        if str(seed.get("moduleId") or "").strip() == target:
            out.append(seed)
    return out


def _select_statistics_contract_for_module(data, module_id, module_context=None):
    target = str(module_id or "").strip()
    module_context = module_context if isinstance(module_context, dict) else {}
    context_contract = module_context.get("statisticsContract")
    if isinstance(context_contract, dict) and context_contract:
        return context_contract
    business_facts = (data or {}).get("businessFacts") or {}
    for item in business_facts.get("statisticsContracts") or []:
        if not isinstance(item, dict):
            continue
        if str(item.get("moduleId") or "").strip() == target:
            return item
    for item in business_facts.get("businessObjects") or []:
        if not isinstance(item, dict):
            continue
        contract = item.get("statisticsContract")
        if isinstance(contract, dict) and contract:
            return contract
    return None


def _select_workflow_contracts_for_module(data, module_id, carrier_entity_key=""):
    """选取投影到当前模块 ServiceInternal 的工作流合同。

    工作流合同可能在被承载模块上（如 MOD-03 authorization_workflow 声明了
    carriedByEntityKey=authorization，但方法要投影到 MOD-01 authorization
    的 ServiceInternal）。匹配策略：
    1. moduleId 精确匹配
    2. 当前模块是承载方时，匹配所有 carriedByEntityKey 指向它的被承载模块的工作流合同
    """
    target = str(module_id or "").strip()
    business_facts = (data or {}).get("businessFacts") or {}
    all_contracts = business_facts.get("workflowContracts") or []
    carrier = str(carrier_entity_key or "").strip().lower()

    # 构建 objectKey → carriedByEntityKey 映射
    carried_by_map = {}
    for obj in business_facts.get("businessObjects") or []:
        obj_key = str((obj or {}).get("objectKey") or "").strip().lower()
        carried = str((obj or {}).get("carriedByEntityKey") or "").strip().lower()
        if obj_key and carried:
            carried_by_map[obj_key] = carried

    out = []
    seen = set()
    for item in all_contracts:
        if not isinstance(item, dict):
            continue
        item_id = str(item.get("moduleId") or "").strip()
        item_obj = str(item.get("objectKey") or "").strip().lower()
        item_carried = carried_by_map.get(item_obj, "")
        # 精确匹配 moduleId，或当前模块是承载方且合同所属对象 carriedBy 到当前模块
        matched = (
            item_id == target
            or (carrier and item_carried == carrier)
        )
        if matched and id(item) not in seen:
            seen.add(id(item))
            out.append(item)
    return out



def _select_data_access_plan_for_module(data, module_id):
    plans = (data or {}).get("dataAccessPlans") or []
    target = str(module_id or "").strip()
    if isinstance(plans, dict):
        # 正式 plan 使用索引，business-facts 使用列表；二者来自同一 Builder 投影。
        return (plans.get("plansByModuleId") or {}).get(target)
    if not isinstance(plans, list):
        return None
    for plan in plans:
        if str((plan or {}).get("moduleId") or "").strip() == target:
            return plan
    return None


def _select_storys_tables_for_module(demand_tables, business_facts_path, module_id, data_access_plan=None, target_file=""):
    design_tables = _load_design_database_tables(business_facts_path)
    by_table_name = {
        str((table or {}).get("tableName") or "").strip().lower(): table
        for table in demand_tables
        if str((table or {}).get("tableName") or "").strip()
    }

    matched = []
    for table in design_tables:
        related = table.get("relatedModuleIds") or []
        if str(module_id or "").strip() not in [str(item or "").strip() for item in related]:
            continue
        table_name = str(table.get("tableName") or "").strip().lower()
        if table_name in by_table_name:
            matched.append(by_table_name[table_name])
    if matched:
        return _dedupe_tables(matched)

    plan_table_name = str(((data_access_plan or {}).get("table") or {}).get("tableName") or "").strip().lower()
    if plan_table_name and plan_table_name in by_table_name:
        return _dedupe_tables([by_table_name[plan_table_name]])

    context = _load_module_plan_context(business_facts_path, module_id)
    entity_name = str(context.get("entityName") or "").strip()
    target_name = os.path.splitext(os.path.basename(str(target_file or "")))[0]
    candidates = [entity_name, _strip_gxh_and_suffix(target_name)]
    for candidate in candidates:
        if not candidate:
            continue
        matched = [
            table for table in demand_tables
            if _table_matches_entity_name(table, candidate)
        ]
        if matched:
            return _dedupe_tables(matched)

    return demand_tables if len(demand_tables) == 1 else []


def _load_design_database_tables(business_facts_path):
    try:
        if not business_facts_path:
            return []
        code_dir = os.path.dirname(os.path.abspath(business_facts_path))
        demand_dir = os.path.dirname(code_dir)
        design_path = os.path.join(demand_dir, "design", "设计文档.json")
        if not os.path.isfile(design_path):
            return []
        with open(design_path, "r", encoding="utf-8") as f:
            design = json.load(f)
        database_design = (design or {}).get("databaseDesign") or {}
        tables = database_design.get("tables") or []
        return tables if isinstance(tables, list) else []
    except Exception:
        return []


def _load_module_plan_context(business_facts_path, module_id):
    try:
        plan_path = _resolve_design_tdd_plan_path(business_facts_path)
        if not plan_path or not os.path.isfile(plan_path):
            return {}
        with open(plan_path, "r", encoding="utf-8") as f:
            plan = json.load(f)
        for item in plan.get("modulesOwnerFiles") or []:
            if str(item.get("moduleId") or "").strip() == str(module_id or "").strip():
                context = item.get("businessContext") or {}
                if not isinstance(context, dict):
                    context = {}
                return {
                    **context,
                    "moduleId": str(item.get("moduleId") or "").strip(),
                    "storyId": str(item.get("storyId") or "").strip().upper()
                }
        return {}
    except Exception:
        return {}


def _strip_gxh_and_suffix(class_name):
    name = str(class_name or "").strip()
    if name.startswith("Gxh"):
        name = name[3:]
    for suffix in ("ListAction", "AddAction", "EditAction", "DetailAction", "ServiceImpl", "Service"):
        if name.endswith(suffix):
            return name[:-len(suffix)]
    return name


def _table_matches_entity_name(table, entity_name):
    normalized_entity = _normalize_identifier(entity_name)
    if not normalized_entity:
        return False
    table_name = _normalize_identifier((table or {}).get("tableName"))
    table_comment = _normalize_identifier((table or {}).get("tableComment"))
    return normalized_entity in table_name or normalized_entity in table_comment


def _normalize_identifier(value):
    return re.sub(r"[^a-z0-9]+", "", str(value or "").lower())


def _dedupe_tables(tables):
    out = []
    seen = set()
    for table in tables or []:
        key = str((table or {}).get("tableName") or "").strip().lower()
        if not key or key in seen:
            continue
        seen.add(key)
        out.append(table)
    return out


# ---- Entity 字段自动展开 ----

COMMON_ENTITY_FIELD_NAMES = set([
    "row_id",
    "operatedate",
    "operateusername",
    "operateuserguid",
    "operateuserouguid",
    "operateuserbaseouguid",
    "yearflag",
    "belongxiaqucode",
    "pviguid"
])

def _post_fill_entity(template, facts, substitutions, business_facts_path=None):
    """
    Entity 模板里有两类 AI_TODO 占位行：
      - {表名}：用 databaseTables[0].tableName 替换 @Entity(table=...) 这一行
      - {Field_name}/{field_name}：getter + setter 模板两行 → 按 businessColumns 展开 N×2 行

    注意：businessColumns 是 LLM-facing 的业务字段，公共字段被过滤掉；Entity 骨架
    仍必须按设计表 columns 生成 row_id/operate*/yearflag 等公共 getter/setter。
    """
    tables = facts.get("databaseTables") or []
    if not tables:
        return template
    primary_table = tables[0]
    table_name = str(primary_table.get("tableName") or "").strip()
    table_comment = str(primary_table.get("tableComment") or "").strip()
    business_columns = primary_table.get("businessColumns") or []

    if table_name:
        template = template.replace("{表名}", table_name)
        template = _ensure_entity_table_javadoc(template, table_name, table_comment)

    if business_columns:
        template = _expand_entity_business_columns(template, business_columns)

    entity_columns = _load_entity_columns_from_design(business_facts_path, table_name)
    if entity_columns:
        template = _expand_entity_common_columns(template, entity_columns, _entity_template_uses_entity_length(template))
    return template


def _ensure_entity_table_javadoc(template, table_name, table_comment=""):
    """在 Entity 类注释中写明中文业务表和物理表；已有类注释时只追加缺失映射。"""
    physical_name = _sanitize_javadoc_text(table_name)
    display_name = _sanitize_javadoc_text(table_comment)
    if not physical_name:
        return template

    class_match = re.search(r"(?m)^public\s+class\b", str(template or ""))
    if not class_match:
        return template
    prefix = template[:class_match.start()]
    existing_match = re.search(r"(?s)(/\*\*.*?\*/)(?:\s*@[^\n]+)*\s*$", prefix)
    table_line = " * <p>对应数据库表：{@code " + physical_name + "}</p>"
    if existing_match:
        existing = existing_match.group(1)
        if physical_name in existing:
            return template
        updated = existing[:-2].rstrip() + "\n *\n" + table_line + "\n */"
        return template[:existing_match.start(1)] + updated + template[existing_match.end(1):]

    annotation_match = re.search(r"(?m)^@Entity\b", prefix)
    insert_at = annotation_match.start() if annotation_match else class_match.start()
    lines = ["/**"]
    if display_name:
        lines.extend([" * " + display_name, " *"])
    lines.extend([table_line, " */"])
    return template[:insert_at] + "\n".join(lines) + "\n" + template[insert_at:]


def _sanitize_javadoc_text(value):
    return re.sub(r"\s+", " ", str(value or "").replace("*/", "* /")).strip()


def _load_entity_columns_from_design(business_facts_path, table_name):
    """从 <demandDir>/design/设计文档.json 读取指定表的完整 columns。失败返回 []。"""
    try:
        if not business_facts_path or not table_name:
            return []
        code_dir = os.path.dirname(os.path.abspath(business_facts_path))
        demand_dir = os.path.dirname(code_dir)
        design_path = os.path.join(demand_dir, "design", "设计文档.json")
        if not os.path.isfile(design_path):
            return []
        with open(design_path, "r", encoding="utf-8") as f:
            design = json.load(f)
        database_design = (design or {}).get("databaseDesign") or {}
        for table in database_design.get("tables") or []:
            if str(table.get("tableName") or "").strip().lower() == str(table_name).strip().lower():
                columns = table.get("columns") or []
                return columns if isinstance(columns, list) else []
        return []
    except Exception:
        return []


def _post_fill_package_from_target(template, target_file):
    """
    从 targetFile 的物理路径反推 Java package，重写 template 的 package 行。
    规则模板里的 `package com.epoint.{项目}.{模块}.api.entity;` 形式可能漏 {domain}
    等中间层（规则历史 bug），用 targetFile 真实路径反推最稳。
    """
    if not target_file:
        return template
    norm = str(target_file or "").replace("\\", "/")
    # 匹配 .../src/main/java/<package>/<ClassName>.java
    m = re.search(r"/src/main/java/(.+)/[^/]+\.java$", norm)
    if not m:
        return template
    pkg = m.group(1).replace("/", ".")
    # 找 template 里第一行 "package xxx;" 替换
    lines = template.splitlines()
    for i, line in enumerate(lines):
        stripped = line.strip()
        if stripped.startswith("package ") and stripped.endswith(";"):
            lines[i] = "package " + pkg + ";"
            break
    return "\n".join(lines)


def _java_package_from_target_file(target_file):
    """从 .../src/main/java/<package>/<ClassName>.java 推导 Java package。"""
    if not target_file:
        return ""
    norm = str(target_file or "").replace("\\", "/")
    m = re.search(r"/src/main/java/(.+)/[^/]+\.java$", norm)
    if not m:
        return ""
    return m.group(1).replace("/", ".")


def _resolve_design_tdd_plan_path(business_facts_path):
    """business-facts.json 与 design-tdd-plan.json 同目录，由 build_plan 同步落盘。"""
    if not business_facts_path:
        return ""
    return os.path.join(os.path.dirname(os.path.abspath(business_facts_path)), "design-tdd-plan.json")


def _read_plan_near_business_facts(business_facts_path):
    plan_path = _resolve_design_tdd_plan_path(business_facts_path)
    if not plan_path or not os.path.isfile(plan_path):
        return {}
    try:
        with open(plan_path, "r", encoding="utf-8") as handle:
            value = json.load(handle)
        return value if isinstance(value, dict) else {}
    except (OSError, ValueError):
        return {}


def _load_owner_file_package_map(business_facts_path, module_id):
    """
    从 design-tdd-plan.json.modulesOwnerFiles 读取同模块 ownerFiles 的真实 resolvedPath，
    建立 simpleClassName -> package 映射。

    规则模板里的 import 可能只按 {模块} 拼出 com.epoint.xmgxh.place.api，漏掉
    targetFile 中真实存在的 domain 层（如 hall）。跨文件依赖必须以 plan 中同模块
    Entity/ServiceApi/ServiceInternal 的 resolvedPath 为准，不能再用模板路径猜。
    """
    try:
        plan_path = _resolve_design_tdd_plan_path(business_facts_path)
        if not plan_path or not os.path.isfile(plan_path):
            return {}
        with open(plan_path, "r", encoding="utf-8") as f:
            plan = json.load(f)
        module_entry = None
        for item in plan.get("modulesOwnerFiles") or []:
            if str(item.get("moduleId") or "").strip() == str(module_id or "").strip():
                module_entry = item
                break
        if not module_entry:
            return {}

        package_map = {}
        for file_info in module_entry.get("ownerFiles") or []:
            resolved = str(file_info.get("resolvedPath") or "").strip()
            if not resolved.lower().endswith(".java"):
                continue
            pkg = _java_package_from_target_file(resolved)
            if not pkg:
                continue
            class_name = os.path.splitext(os.path.basename(resolved))[0]
            if class_name:
                package_map[class_name] = pkg
        # carried query/statistics module 没有自己的 ServiceApi，补入承载模块的
        # ServiceApi 包路径，供 Action import 修正复用同一 Builder 事实。
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
            if str((access_plan or {}).get("moduleId") or "").strip() != str(module_id or "").strip():
                continue
            service = (access_plan or {}).get("service") or {}
            interface_name = str(service.get("interfaceName") or "").strip()
            carrier_id = str((access_plan or {}).get("carriedByModuleId") or "").strip()
            if not interface_name or not carrier_id:
                continue
            for carrier_entry in plan.get("modulesOwnerFiles") or []:
                if str((carrier_entry or {}).get("moduleId") or "").strip() != carrier_id:
                    continue
                for carrier_file in carrier_entry.get("ownerFiles") or []:
                    if str((carrier_file or {}).get("fileKind") or "").strip() != "ServiceApi":
                        continue
                    carrier_path = str(carrier_file.get("resolvedPath") or "").strip()
                    package = _java_package_from_target_file(carrier_path)
                    if package:
                        package_map[interface_name] = package
                    break
                break
        return package_map
    except Exception:
        return {}


def _post_fill_imports_from_owner_files(template, module_id, business_facts_path, target_file):
    """
    用同模块 ownerFiles 的真实 Java 包修正 import 行。

    只替换已存在的 import，不新增 import、不改业务代码；因此不会扩大文件职责。
    典型修复：
      import com.epoint.xmgxh.place.api.IGxhPlaceService;
    ->
      import com.epoint.xmgxh.hall.place.api.IGxhPlaceService;
    """
    package_map = _load_owner_file_package_map(business_facts_path, module_id)
    if not package_map:
        return template
    current_package = _java_package_from_target_file(target_file)
    lines = []
    for line in template.splitlines():
        stripped = line.strip()
        if not stripped.startswith("import ") or not stripped.endswith(";"):
            lines.append(line)
            continue
        imported = stripped[len("import "): -1].strip()
        separator = imported.rfind(".")
        if separator <= 0 or separator >= len(imported) - 1:
            lines.append(line)
            continue
        imported_pkg = imported[:separator]
        class_name = imported[separator + 1:]
        expected_pkg = package_map.get(class_name)
        if not expected_pkg or imported_pkg == expected_pkg:
            lines.append(line)
            continue
        if current_package and class_name == os.path.splitext(os.path.basename(str(target_file or "")))[0]:
            lines.append(line)
            continue
        prefix = line[:len(line) - len(line.lstrip())]
        suffix = line[line.rfind(";") + 1:]
        lines.append(prefix + "import " + expected_pkg + "." + class_name + ";" + suffix)
    return "\n".join(lines)


def _expand_entity_business_columns(template, business_columns):
    """
    扫 template，找到包含 {Field_name} 占位符的字段模板。
    950+ 规则的字段模板是 EntityLength + getter + setter 三行；旧测试规则
    可能只有 getter + setter 两行。展开时必须保留规则中的长度注解。
    """
    lines = template.splitlines()
    out_lines = []
    i = 0
    expanded = False
    while i < len(lines):
        line = lines[i]
        if "{Field_name}" in line and "{field_name}" in line:
            getter_template = line
            setter_template = lines[i + 1] if (i + 1 < len(lines) and "{Field_name}" in lines[i + 1]) else None
            if setter_template is None:
                out_lines.append(line)
                i += 1
                continue

            annotation_template = out_lines[-1] if out_lines and "{长度}" in out_lines[-1] else ""
            if annotation_template:
                out_lines.pop()
            for col in business_columns:
                col_name = str(col.get("name") or "").strip()
                if not col_name:
                    continue
                col_type = _java_type_for_column(col)
                pascal_name = _to_pascal(col_name)
                getter = (getter_template
                          .replace("{Field_name}", pascal_name)
                          .replace("{field_name}", col_name)
                          .replace("public String get", "public " + col_type + " get"))
                setter = (setter_template
                          .replace("{Field_name}", pascal_name)
                          .replace("{field_name}", col_name)
                          .replace("(String ", "(" + col_type + " "))
                if col_type != "String":
                    getter = getter.replace(
                        'super.get("' + col_name + '")',
                        _entity_getter_read_expr(col_name, col_type)
                    )
                if annotation_template:
                    annotation = _render_entity_length_annotation(annotation_template, col)
                    if annotation:
                        out_lines.append(annotation)
                out_lines.append(getter)
                out_lines.append(setter)
            i += 2
            expanded = True
        else:
            out_lines.append(line)
            i += 1
    return "\n".join(out_lines) if expanded else template


def _expand_entity_common_columns(template, entity_columns, include_entity_length=False):
    """把规则模板公共字段块补齐为设计表中真实存在的公共字段 getter/setter。"""
    common_columns = []
    seen = set()
    for col in entity_columns or []:
        col_name = str((col or {}).get("name") or "").strip()
        lower = col_name.lower()
        if not col_name or lower not in COMMON_ENTITY_FIELD_NAMES or lower in seen:
            continue
        seen.add(lower)
        common_columns.append(col)
    if not common_columns:
        return template

    lines = template.splitlines()
    marker_index = -1
    for idx, line in enumerate(lines):
        if "公共字段" in line:
            marker_index = idx
            break
    if marker_index < 0:
        return template

    end_index = marker_index + 1
    while end_index < len(lines):
        line = lines[end_index]
        stripped = line.strip()
        if stripped == "}":
            break
        if stripped.startswith("// ==========") and "公共字段" not in stripped:
            break
        end_index += 1

    indent = _detect_common_field_indent(lines, marker_index, end_index)
    rendered = [lines[marker_index]]
    for col in common_columns:
        rendered.extend(_render_entity_column_accessors(col, indent, include_entity_length))
    return "\n".join(lines[:marker_index] + rendered + lines[end_index:])


def _detect_common_field_indent(lines, start, end):
    for idx in range(start + 1, end):
        stripped = lines[idx].lstrip()
        if stripped.startswith("public "):
            return lines[idx][:len(lines[idx]) - len(stripped)]
    marker = lines[start] if start < len(lines) else ""
    leading = marker[:len(marker) - len(marker.lstrip())]
    return leading or "    "


def _render_entity_column_accessors(col, indent, include_entity_length=False):
    col_name = str((col or {}).get("name") or "").strip()
    col_type = _java_type_for_column(col)
    pascal_name = _to_entity_accessor_name(col_name)
    getter_read = _entity_getter_read_expr(col_name, col_type)
    lines = []
    if include_entity_length:
        annotation = _render_entity_length_annotation(f'{indent}@EntityLength(length = {{长度}})', col)
        if annotation:
            lines.append(annotation)
    lines.extend([
        f'{indent}public {col_type} get{pascal_name}() {{ return {getter_read}; }}',
        f'{indent}public void set{pascal_name}({col_type} {col_name}) {{ super.set("{col_name}", {col_name}); }}'
    ])
    return lines


def _entity_template_uses_entity_length(template):
    return "EntityLength" in str(template or "")


def _render_entity_length_annotation(template, col):
    if _java_type_for_column(col) != "String":
        return ""
    length = _entity_column_length(col)
    if not length:
        return ""
    return str(template or "").replace("{长度}", str(length)).rstrip()


def _entity_column_length(col):
    for key in ("length", "fieldlength", "fieldLength", "columnLength"):
        value = (col or {}).get(key)
        if value is None:
            continue
        text = str(value).strip()
        if re.match(r"^[1-9][0-9]*$", text):
            return text
    return ""


def _entity_getter_read_expr(col_name, col_type):
    if col_type == "Integer":
        return f'super.getInt("{col_name}")'
    if col_type == "Date":
        return f'super.getDate("{col_name}")'
    if col_type == "Long":
        return f'(Long) super.get("{col_name}")'
    if col_type == "java.math.BigDecimal":
        return f'(java.math.BigDecimal) super.get("{col_name}")'
    return f'super.get("{col_name}")'


def _to_entity_accessor_name(field_name):
    """实体 getter/setter 名按项目既有风格保留下划线：row_id -> Row_id。"""
    s = str(field_name or "")
    return s[:1].upper() + s[1:] if s else ""


def _java_type_for_column(col):
    """DB 类型 → Java 类型映射（保守：未知类型走 String）。"""
    db_type = str(col.get("type") or "").strip().upper()
    if db_type in ("INT", "INTEGER", "TINYINT", "SMALLINT"):
        return "Integer"
    if db_type in ("BIGINT",):
        return "Long"
    if db_type in ("DECIMAL", "NUMERIC", "DOUBLE", "FLOAT"):
        return "java.math.BigDecimal"
    if db_type in ("DATE", "DATETIME", "TIMESTAMP", "TIME"):
        return "Date"
    return "String"


def _is_date_column(col):
    db_type = str((col or {}).get("type") or "").strip().upper()
    return db_type in ("DATE", "DATETIME", "TIMESTAMP")


def _date_range_columns(business_columns):
    out = []
    for col in business_columns or []:
        if not isinstance(col, dict):
            continue
        name = str(col.get("name") or "").strip()
        if name and _is_date_column(col) and not _is_attachment_column(col):
            out.append(col)
    return out


def _is_text_search_column(col):
    if not isinstance(col, dict):
        return False
    if _get_code_item_name(col) or _is_attachment_column(col) or _is_date_column(col):
        return False
    db_type = str(col.get("type") or "").strip().upper()
    if not db_type:
        return True
    return db_type in ("VARCHAR", "CHAR", "NVARCHAR", "NCHAR", "TEXT", "CLOB", "NCLOB", "LONGTEXT", "MEDIUMTEXT")


def _safe_java_identifier(value):
    text = re.sub(r"[^A-Za-z0-9_]", "_", str(value or "").strip())
    if not text:
        return ""
    if re.match(r"^[0-9]", text):
        text = "_" + text
    return text


def _to_pascal(snake_or_lower):
    """field_name → FieldName / placename → Placename"""
    parts = str(snake_or_lower or "").split("_")
    if len(parts) == 1:
        s = parts[0]
        return s[:1].upper() + s[1:] if s else ""
    return "".join(p[:1].upper() + p[1:] for p in parts if p)


# ---- 复用表无 API 时的只读 Service 生成 ----

def _is_generated_reuse_service(facts):
    plan = (facts or {}).get("dataAccessPlan") or {}
    if not isinstance(plan, dict):
        return False
    return str(plan.get("mode") or "").strip() == "generated_service"


def _generated_reuse_service_context(facts, target_file, project_path=""):
    plan = (facts or {}).get("dataAccessPlan") or {}
    service = plan.get("service") if isinstance(plan.get("service"), dict) else {}
    service_internal = plan.get("serviceInternal") if isinstance(plan.get("serviceInternal"), dict) else {}
    service_impl = plan.get("serviceImpl") if isinstance(plan.get("serviceImpl"), dict) else {}
    entity = plan.get("entity") if isinstance(plan.get("entity"), dict) else {}
    entity_class = str(entity.get("className") or (plan.get("table") or {}).get("entityName") or "").strip()
    service_interface = str(service.get("interfaceName") or "").strip()
    internal_class = str(service_internal.get("className") or "").strip()
    impl_class = str(service_impl.get("className") or "").strip()
    if not service_interface:
        service_interface = _class_name_from_target_file(target_file) if str(target_file).lower().endswith("service.java") else ""
    if not internal_class:
        internal_class = _class_name_from_target_file(target_file)
    if not impl_class:
        impl_class = _class_name_from_target_file(target_file)
    method = str((plan.get("queryMethod") or {}).get("methodName") or "paginatorList").strip() or "paginatorList"
    entity_package = str(entity.get("packageName") or "").strip()
    if not entity_package:
        entity_package = _read_java_package_for_source(project_path, entity.get("sourcePath"))
    service_package = str(service.get("packageName") or "").strip()
    if not service_package:
        service_package = _java_package_from_target_file(target_file)
    entity_import = (entity_package + "." + entity_class) if entity_package and entity_class else ""
    service_import = (service_package + "." + service_interface) if service_package and service_interface else ""
    return {
        "plan": plan,
        "entityClass": entity_class,
        "entityImport": entity_import,
        "serviceInterface": service_interface,
        "serviceImport": service_import,
        "internalClass": internal_class,
        "implClass": impl_class,
        "methodName": method,
        "entitySourcePath": str(entity.get("sourcePath") or "").strip()
    }


def _class_name_from_target_file(target_file):
    return os.path.splitext(os.path.basename(str(target_file or "")))[0]


def _read_java_package_for_source(project_path="", source_path=""):
    raw = str(source_path or "").strip()
    if not raw:
        return ""
    candidates = [raw] if os.path.isabs(raw) else [os.path.join(str(project_path or ""), raw)]
    for candidate in candidates:
        try:
            if not os.path.isfile(candidate):
                continue
            with open(candidate, "r", encoding="utf-8") as handle:
                match = re.search(r"\bpackage\s+([A-Za-z0-9_.]+)\s*;", handle.read(8192))
            if match:
                return match.group(1)
        except Exception:
            continue
    return _java_package_from_target_file(raw)


def _strip_service_entity_imports(template):
    return re.sub(
        r"(?m)^\s*import\s+[^;]+\.api\.entity\.[A-Za-z0-9_]+;\s*\r?\n",
        "",
        str(template or "")
    )


def _render_generated_reuse_service_api(template, facts, target_file, project_path=""):
    context = _generated_reuse_service_context(facts, target_file, project_path)
    entity = context["entityClass"]
    service_interface = context["serviceInterface"] or _class_name_from_target_file(target_file)
    if not entity or not service_interface:
        return template
    template = _strip_service_entity_imports(template)
    template = re.sub(r"(?m)^\s*import\s+[^;]+\.PageData;\s*\r?\n", "", template)
    body = (
        "    PageData<" + entity + "> " + context["methodName"]
        + "(Map<String, Object> conditionMap, int pageNumber, int pageSize);"
    )
    template = _replace_java_type_body(template, body)
    imports = [
        "import java.util.Map;",
        "import com.epoint.database.peisistence.crud.impl.model.PageData;",
        ("import " + context["entityImport"] + ";") if context["entityImport"] else ""
    ]
    return _ensure_java_imports(template, imports)


def _render_generated_reuse_service_internal(template, facts, target_file, project_path=""):
    context = _generated_reuse_service_context(facts, target_file, project_path)
    entity = context["entityClass"]
    class_name = _java_declared_class_name(template) or context["internalClass"] or _class_name_from_target_file(target_file)
    if not entity or not class_name:
        return template
    template = _strip_service_entity_imports(template)
    body = "\n".join([
        "    protected ICommonDao baseDao;",
        "",
        "    public " + class_name + "() {",
        "        baseDao = CommonDao.getInstance();",
        "    }",
        "",
        "    public PageData<" + entity + "> " + context["methodName"] + "(Map<String, Object> conditionMap, int pageNumber, int pageSize) {",
        "        Parameter parameter = getSql(conditionMap);",
        "        List<" + entity + "> list = baseDao.findList(parameter.getSql(), pageNumber, pageSize, " + entity + ".class, parameter.getValue());",
        "        SqlConditionUtil countUtil = new SqlConditionUtil(conditionMap);",
        "        countUtil.setSelectFields(\"count(*)\");",
        "        Parameter countParameter = getSql(countUtil.getMap());",
        "        int count = baseDao.queryInt(countParameter.getSql(), countParameter.getValue());",
        "        return new PageData<>(list, count);",
        "    }",
        "",
        "    private Parameter getSql(Map<String, Object> conditionMap) {",
        "        List<Object> params = new ArrayList<>();",
        "        for (Map.Entry<String, Object> entry : conditionMap.entrySet()) {",
        "            if (entry.getKey().contains(\"like\")) {",
        "                conditionMap.put(entry.getKey(), EnumClazz.SpecialParam.getPlaceholderParam((String) entry.getValue()));",
        "            }",
        "        }",
        "        String sql = new SqlHelper().getSqlComplete(" + entity + ".class, conditionMap, params);",
        "        Parameter parameter = new Parameter();",
        "        parameter.setSql(sql);",
        "        parameter.setParamValue(params);",
        "        return parameter;",
        "    }"
    ])
    template = _replace_java_type_body(template, body)
    imports = [
        "import com.epoint.core.dao.CommonDao;",
        "import com.epoint.core.dao.ICommonDao;",
        "import com.epoint.core.utils.EnumClazz;",
        "import com.epoint.core.utils.sql.SqlConditionUtil;",
        "import com.epoint.core.utils.sql.SqlHelper;",
        "import com.epoint.database.jdbc.Parameter;",
        "import com.epoint.database.peisistence.crud.impl.model.PageData;",
        "import java.util.ArrayList;",
        "import java.util.List;",
        "import java.util.Map;",
        ("import " + context["entityImport"] + ";") if context["entityImport"] else ""
    ]
    return _ensure_java_imports(template, imports)


def _render_generated_reuse_service_impl(template, facts, target_file, project_path=""):
    context = _generated_reuse_service_context(facts, target_file, project_path)
    entity = context["entityClass"]
    service_interface = context["serviceInterface"]
    internal_class = context["internalClass"]
    if not entity or not service_interface or not internal_class:
        return template
    template = _strip_service_entity_imports(template)
    body = "    @Override\n    public PageData<" + entity + "> " + context["methodName"] + "(Map<String, Object> conditionMap, int pageNumber, int pageSize) {\n        return new " + internal_class + "()." + context["methodName"] + "(conditionMap, pageNumber, pageSize);\n    }"
    template = _replace_java_type_body(template, body)
    imports = [
        ("import " + context["serviceImport"] + ";") if context["serviceImport"] else "",
        "import com.epoint.database.peisistence.crud.impl.model.PageData;",
        "import java.util.Map;",
        ("import " + context["entityImport"] + ";") if context["entityImport"] else ""
    ]
    return _ensure_java_imports(template, imports)


# ---- ServiceImpl 兜底（substitutions 已在主路径替换 EntityName，这里只做防御） ----

def _statistics_service_seeds(facts):
    seeds = []
    for seed in (facts or {}).get("serviceContractSeeds") or []:
        if not isinstance(seed, dict):
            continue
        method_name = str(seed.get("methodName") or "").strip()
        source_type = str(seed.get("sourceType") or "").strip()
        if method_name.startswith("queryStatisticsData") or source_type == "statisticsContract":
            seeds.append(seed)
    return seeds


def _post_fill_service_api(template, facts, substitutions, target_file, project_path=""):
    if _is_generated_reuse_service(facts):
        return _render_generated_reuse_service_api(template, facts, target_file, project_path)
    seeds = _statistics_service_seeds(facts)
    if not seeds:
        return template
    if _is_statistics_service_only(facts):
        template = _strip_statistics_entity_contract(template)
        template = _replace_java_type_body(template, "")
    lines = []
    for seed in seeds:
        method_name = str(seed.get("methodName") or "queryStatisticsData").strip()
        title = str(seed.get("statisticsTitle") or seed.get("purpose") or "统计分析").strip()
        lines.extend([
            "",
            "    /**",
            "     * " + title,
            "     */",
            "    java.util.List<java.util.Map<String, Object>> " + method_name + "(java.util.Map<String, Object> params, int first, int pageSize);",
            "    int " + _statistics_count_method_name(method_name) + "(java.util.Map<String, Object> params);"
        ])
    return _insert_before_last_brace(template, lines)


def _post_fill_service_internal(template, facts, substitutions, target_file, project_path=""):
    if _is_generated_reuse_service(facts):
        return _render_generated_reuse_service_internal(template, facts, target_file, project_path)
    seeds = _statistics_service_seeds(facts)
    workflow_seeds = _workflow_external_method_seeds(facts)
    if not seeds and not workflow_seeds:
        return template
    service_only = _is_statistics_service_only(facts)
    if service_only:
        class_name = _java_declared_class_name(template) or os.path.splitext(os.path.basename(str(target_file or "")))[0]
        template = _strip_statistics_entity_contract(template)
        template = _replace_java_type_body(
            template,
            "    protected ICommonDao baseDao;\n\n"
            "    public " + class_name + "() {\n"
            "        baseDao = CommonDao.getInstance();\n"
            "    }"
        )
        template = _ensure_java_imports(template, [
            "import com.epoint.core.dao.CommonDao;",
            "import com.epoint.core.dao.ICommonDao;"
        ])
    if workflow_seeds:
        template = _ensure_java_imports(template, [
            "import com.epoint.core.annotation.scan.OutJarMethod;"
        ])
    source_tables = _statistics_source_table_names(facts)
    table_name = source_tables[0] if source_tables else ""
    source_text = ", ".join(source_tables) if source_tables else "<统计来源表>"
    lines = []
    for seed in seeds:
        method_name = str(seed.get("methodName") or "queryStatisticsData").strip()
        count_name = _statistics_count_method_name(method_name)
        title = str(seed.get("statisticsTitle") or seed.get("purpose") or "统计分析").strip()
        lines.extend([
            "",
            "    /**",
            "     * " + title,
            "     * AI_TODO[StatisticsServiceQuery]: 按 statisticsContract.filters/dimensions/metrics 编写参数化统计 SQL；已确认只读来源表：" + source_text + "。",
            "     */",
            "    public java.util.List<java.util.Map<String, Object>> " + method_name + "(java.util.Map<String, Object> params, int first, int pageSize) {",
            "        java.util.List<Object> sqlParams = new java.util.ArrayList<>();",
            "        StringBuilder sql = new StringBuilder();",
            "        // 已确认只读来源表（多来源时由业务实现补齐 JOIN/聚合）：" + source_text,
            "        sql.append(\"SELECT * FROM " + _escape_java_string(table_name or "<统计来源表>") + " WHERE 1=1 \");",
            "        // AI_TODO[StatisticsFilters]: 按统计筛选条件追加 WHERE，占位符参数写入 sqlParams。",
            "        // AI_TODO[StatisticsGroupBy]: 按统计维度和指标替换 SELECT/GROUP BY。",
            "        @SuppressWarnings(\"unchecked\")",
            "        java.util.List<java.util.Map<String, Object>> list = (java.util.List<java.util.Map<String, Object>>) (java.util.List<?>) baseDao.findList(sql.toString(), first, pageSize, com.epoint.core.grammar.Record.class, sqlParams.toArray());",
            "        return list;",
            "    }",
            "",
            "    public int " + count_name + "(java.util.Map<String, Object> params) {",
            "        java.util.List<Object> sqlParams = new java.util.ArrayList<>();",
            "        StringBuilder sql = new StringBuilder();",
            "        // 已确认只读来源表（多来源时由业务实现补齐 JOIN/聚合）：" + source_text,
            "        sql.append(\"SELECT COUNT(1) FROM " + _escape_java_string(table_name or "<统计来源表>") + " WHERE 1=1 \");",
            "        // AI_TODO[StatisticsCount]: 与统计列表查询保持同一筛选口径。",
            "        return baseDao.queryInt(sql.toString(), sqlParams.toArray());",
            "    }"
        ])
    seen_signatures = set()
    for seed in workflow_seeds:
        method_name = str(seed.get("methodName") or "").strip()
        parameters = [item for item in seed.get("parameters") or [] if isinstance(item, dict)]
        parameter_names = [str(item.get("name") or "").strip() for item in parameters]
        signature = (method_name, tuple(parameter_names))
        if not method_name or signature in seen_signatures:
            continue
        seen_signatures.add(signature)
        operation_key = str(seed.get("operationKey") or "").strip()
        activity_name = str(seed.get("activityName") or "").strip()
        operation_name = str(seed.get("operationName") or "").strip()
        business_effect = str(seed.get("businessEffect") or "").strip()
        lines.extend([
            "",
            "    /**",
            "     * 工作流操作后事件：" + (operation_name or method_name),
            "     * 触发位置：" + (activity_name or "未明确节点"),
            "     * 业务效果：" + (business_effect or "待按Story验收实现"),
            "     * operationKey：" + (operation_key or "未明确"),
        ])
        for parameter in parameters:
            lines.append("     * @param " + str(parameter.get("name") or "") + " " + str(parameter.get("description") or "参数"))
        lines.extend([
            "     */",
            "    @OutJarMethod(methodName = \"" + method_name + "\", parameters = {" + ", ".join('"' + name + '"' for name in parameter_names) + "}, parameterNames = {" + ", ".join('"' + str(item.get("description") or "参数") + '"' for item in parameters) + "})",
            "    public void " + method_name + "(" + ", ".join("String " + name for name in parameter_names) + ") {",
            "        // AI_TODO[WorkflowEvent:" + (operation_key or method_name) + "]",
            "        // " + (business_effect or "根据当前Story验收实现操作后的业务逻辑。"),
            "    }"
        ])
    return _insert_before_last_brace(template, lines)


def _workflow_external_method_seeds(facts):
    direct = (facts or {}).get("workflowExternalMethodSeeds")
    if isinstance(direct, list):
        return [item for item in direct if isinstance(item, dict)]
    out = []
    seen = set()
    for contract in (facts or {}).get("workflowContracts") or []:
        if not isinstance(contract, dict):
            continue
        for item in contract.get("workflowExternalMethodSeeds") or []:
            if not isinstance(item, dict):
                continue
            key = (str(item.get("methodName") or "").strip(), tuple(
                str(parameter.get("name") or "").strip()
                for parameter in item.get("parameters") or []
                if isinstance(parameter, dict)
            ))
            if key[0] and key not in seen:
                seen.add(key)
                out.append(item)
    return out


def _post_fill_service_impl(template, facts, substitutions, target_file, project_path=""):
    """ServiceImpl 模板的 {EntityName} 在主 substitutions 阶段已被替换；这里补统计扩展方法转发。"""
    if _is_generated_reuse_service(facts):
        return _render_generated_reuse_service_impl(template, facts, target_file, project_path)
    seeds = _statistics_service_seeds(facts)
    if not seeds:
        return template
    if _is_statistics_service_only(facts):
        template = _strip_statistics_entity_contract(template)
        template = _replace_java_type_body(template, "")
    internal_class = _service_internal_class_name_from_impl(target_file)
    lines = []
    for seed in seeds:
        method_name = str(seed.get("methodName") or "queryStatisticsData").strip()
        count_name = _statistics_count_method_name(method_name)
        lines.extend([
            "",
            "    @Override",
            "    public java.util.List<java.util.Map<String, Object>> " + method_name + "(java.util.Map<String, Object> params, int first, int pageSize) {",
            "        return new " + internal_class + "()." + method_name + "(params, first, pageSize);",
            "    }",
            "",
            "    @Override",
            "    public int " + count_name + "(java.util.Map<String, Object> params) {",
            "        return new " + internal_class + "()." + count_name + "(params);",
            "    }"
        ])
    return _insert_before_last_brace(template, lines)


def _statistics_count_method_name(method_name):
    name = str(method_name or "queryStatisticsData").strip()
    if name.startswith("query"):
        return "count" + name[len("query"):]
    return name + "Count"


def _is_statistics_service_only(facts):
    plan = (facts or {}).get("dataAccessPlan") or {}
    if not isinstance(plan, dict):
        return False
    return bool(
        plan.get("serviceOnly") is True
        or plan.get("noEntity") is True
        or str(plan.get("accessType") or "").strip() == "statistics_sources"
        or str(plan.get("mode") or "").strip() == "statistics_source"
    )


def _strip_statistics_entity_contract(template):
    """Remove generic CRUD Entity imports before rebuilding a service-only type."""
    template = re.sub(
        r"(?m)^\s*import\s+[^;]+\.api\.entity\.[A-Za-z0-9_]+;\s*\r?\n",
        "",
        template
    )
    template = re.sub(
        r"(?m)^\s*import\s+[^;]+\.PageData;\s*\r?\n",
        "",
        template
    )
    return template


def _java_declared_class_name(template):
    match = re.search(r"\b(?:public\s+)?class\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*\{", str(template or ""))
    return match.group(1) if match else ""


def _replace_java_type_body(template, body):
    """Replace the outer class/interface body while retaining package/annotations/imports."""
    match = re.search(
        r"\b(?:public\s+)?(?:interface|class)\s+[A-Za-z_$][A-Za-z0-9_$]*(?:[^\{]*)\{",
        str(template or "")
    )
    if not match:
        return template
    opening = template.find("{", match.start(), match.end())
    closing = template.rfind("}")
    if opening < 0 or closing <= opening:
        return template
    content = str(body or "").strip()
    return template[:opening + 1] + ("\n" + content + "\n" if content else "\n") + template[closing:]


def _statistics_source_table_names(facts):
    data_access_plan = (facts or {}).get("dataAccessPlan") or {}
    if not isinstance(data_access_plan, dict):
        data_access_plan = {}
    sources = data_access_plan.get("sources")
    if isinstance(sources, list):
        names = []
        seen = set()
        for source in sources:
            if not isinstance(source, dict):
                continue
            name = str(source.get("tableName") or "").strip()
            key = name.lower()
            if name and key not in seen:
                seen.add(key)
                names.append(name)
        return names
    if _is_statistics_service_only(facts):
        return []
    table = data_access_plan.get("table") if isinstance(data_access_plan, dict) else {}
    if isinstance(table, dict) and str(table.get("tableName") or "").strip():
        return [str(table.get("tableName") or "").strip()]
    tables = (facts or {}).get("databaseTables") or []
    if tables and isinstance(tables[0], dict):
        name = str(tables[0].get("tableName") or "").strip()
        return [name] if name else []
    return []


def _statistics_source_table_name(facts):
    names = _statistics_source_table_names(facts)
    return names[0] if names else ""


def _service_internal_class_name_from_impl(target_file):
    class_name = os.path.splitext(os.path.basename(str(target_file or "")))[0]
    if class_name.endswith("ServiceImpl"):
        return class_name[:-len("Impl")]
    return class_name.replace("Impl", "")


def _insert_before_last_brace(template, lines):
    addition = "\n".join(lines)
    if not addition.strip():
        return template
    idx = template.rfind("}")
    if idx < 0:
        return template + "\n" + addition + "\n"
    return template[:idx].rstrip() + "\n" + addition + "\n" + template[idx:]


def _escape_java_string(value):
    return str(value or "").replace("\\", "\\\\").replace('"', '\\"')


# ---- Action 代码项块自动展开/删除 ----

def _post_fill_action(template, facts, substitutions, target_file, rule_content="", section_key="", project_path=""):
    """
    Action 模板里的代码项块只能由字段级 codeItem 真值驱动：
      - 有 codeItem：替换 {codeItemField}/{CodeItem}/{代码项名称} 并生成 getXxxModel 可用方法；
      - 无 codeItem：删除代码项查询字段、查询条件和 getXxxModel 示例/方法块，不留 AI_TODO。
    附件块只能由字段级 attachmentKey 真值驱动：
      - 有 attachmentKey：生成 FileUploadModel9、稳定附件标识初始化、保存写回；
      - 无 attachmentKey：不渲染任何附件上传骨架。
    ExportModel：从 businessColumns 自动填充 field 和列名。
    """
    reuse_query = is_reuse_query_section("Action", section_key)
    if reuse_query:
        template = post_fill_reuse_query_action(template, facts, target_file, project_path)

    tables = facts.get("databaseTables") or []
    if reuse_query and (not tables or not tables[0].get("businessColumns")):
        binds = reuse_query_bind_fields(facts)
        return _ensure_action_bind_accessors(_ensure_action_bind_field_declarations(template, binds), binds)
    if not tables:
        return template
    business_columns = tables[0].get("businessColumns") or []
    if not business_columns:
        return template

    # ExportModel 自动填充：从 businessColumns 提取 field,comment 拼入
    if not reuse_query:
        template = _post_fill_export_model(template, business_columns)

    primary_field = _first_text_search_field_name(business_columns)
    if primary_field:
        template = template.replace("{主要字段名}", primary_field)
    else:
        template = _remove_action_primary_search_blocks(template)

    # 收集所有 codeItem 字段
    code_columns = [col for col in business_columns if _get_code_item_name(col)]
    if not code_columns:
        template = _remove_action_codeitem_blocks(template)
        template = _remove_codeitem_imports(template)
        template = template.replace(", codeItemField", "").replace("codeItemField, ", "").replace("codeItemField", "")
    else:
        template = _ensure_feature_bridge_imports(template, rule_content, "code_item")

        # 第一个 codeItem：替换模板里的占位符
        first_col = code_columns[0]
        field_name = str(first_col.get("name") or "").strip()
        code_name = _get_code_item_name(first_col)
        pascal = _to_pascal(field_name)
        camel = pascal[:1].lower() + pascal[1:] if pascal else field_name
        replacements = {
            "{codeItemField}": field_name,
            "{CodeItem}": pascal,
            "{codeItem}": camel,
            "{代码项名称}": code_name,
            "{CodeItemCode}": code_name
        }
        for key, value in replacements.items():
            template = template.replace(key, value)
        template = _materialize_commented_codeitem_model(template, pascal, camel, code_name, section_key)

        # 950以下 Add/Edit/Detail 这类模板可能没有代码项占位块；既然 Builder 基于
        # businessFacts 生成了 codeItem 数据源，就统一从当前版本桶规则补 imports，
        # 并把所有 codeItem 模型追加到类体末尾。ListAction/950+ 若已有占位块，则只追加第 2 个及之后。
        if not _has_real_codeitem_model_method(template, pascal):
            template = _append_additional_codeitem_models(template, code_columns, section_key)
        elif len(code_columns) > 1:
            template = _append_additional_codeitem_models(template, code_columns[1:], section_key)

    if reuse_query:
        binds = reuse_query_bind_fields(facts)
        return _ensure_action_bind_accessors(_ensure_action_bind_field_declarations(template, binds), binds)

    template = _post_fill_action_attachments(template, business_columns, target_file, section_key)
    template = _post_fill_action_date_ranges(template, business_columns)
    template = _post_fill_action_query_filters(template, facts)
    template = _post_fill_action_page_bind_properties(template, business_columns, section_key)
    if _has_page_composition(facts):
        template = _post_fill_composition_action(template, facts, rule_content, section_key)

    return template


def _post_fill_composition_action(template, facts, rule_content, section_key):
    composition = facts.get("pageComposition") or {}
    tables = facts.get("databaseTables") or []
    table_by_object = {
        str((table or {}).get("objectKey") or "").strip(): table
        for table in tables
        if str((table or {}).get("objectKey") or "").strip()
    }
    sub_type = _detect_action_subtype("", section_key)
    if sub_type not in ("add", "edit", "detail", "workflow"):
        return template

    form_bindings = [
        item for item in facts.get("compositionFormBindings") or []
        if isinstance(item, dict)
        and str(item.get("formObjectKey") or "").strip() == str(composition.get("formObjectKey") or "").strip()
    ]
    primary_object_key = str(composition.get("primaryObjectKey") or "").strip()
    form_object_key = str(composition.get("formObjectKey") or "").strip()
    if form_object_key and primary_object_key != form_object_key and not form_bindings:
        raise ValueError("COMPOSITION_FORM_BINDING_MISSING: formObjectKey=" + form_object_key)
    if form_bindings:
        template = _ensure_composition_form_binding(template, form_bindings[0])

    child_blocks = [
        block for block in composition.get("blocks") or []
        if isinstance(block, dict) and str(block.get("kind") or "").strip() in ("child_edit", "child_readonly")
    ]
    if not child_blocks:
        return template

    query_contracts = facts.get("compositionChildQueries") or []
    contract_by_relation = {
        (
            str((item or {}).get("childObjectKey") or "").strip(),
            tuple(str(ref or "").strip() for ref in (item or {}).get("relationPath") or [] if str(ref or "").strip())
        ): item
        for item in query_contracts
        if isinstance(item, dict)
    }
    missing_contracts = [
        {
            "childObjectKey": str(block.get("objectKey") or "").strip(),
            "relationPath": [str(ref or "").strip() for ref in block.get("relationPath") or [] if str(ref or "").strip()]
        }
        for block in child_blocks
        if (
            str(block.get("objectKey") or "").strip(),
            tuple(str(ref or "").strip() for ref in block.get("relationPath") or [] if str(ref or "").strip())
        ) not in contract_by_relation
    ]
    if missing_contracts:
        raise ValueError(
            "COMPOSITION_CHILD_QUERY_CONTRACT_MISSING: "
            + json.dumps(missing_contracts, ensure_ascii=False)
        )

    selected_contracts = [
        contract_by_relation[(
            str(block.get("objectKey") or "").strip(),
            tuple(str(ref or "").strip() for ref in block.get("relationPath") or [] if str(ref or "").strip())
        )]
        for block in child_blocks
    ]
    template = _ensure_composition_query_imports(template, selected_contracts, sub_type)
    template = _ensure_composition_service_fields(template, selected_contracts)
    editable_contracts = [
        contract_by_relation[(
            str(block.get("objectKey") or "").strip(),
            tuple(str(ref or "").strip() for ref in block.get("relationPath") or [] if str(ref or "").strip())
        )]
        for block in child_blocks
        if str(block.get("kind") or "").strip() == "child_edit"
    ]
    if sub_type == "add" and editable_contracts:
        template = _ensure_composition_add_parent_key_lifecycle(template, editable_contracts)
    if sub_type in ("add", "edit") and editable_contracts:
        template = _ensure_composition_child_action_stubs(template, editable_contracts)

    child_code_columns = []
    additions = []
    for block in child_blocks:
        object_key = str(block.get("objectKey") or "").strip()
        table = table_by_object.get(object_key) or {}
        columns = table.get("businessColumns") or []
        child_code_columns.extend(col for col in columns if _get_code_item_name(col))
        method_name = "get" + _to_pascal(object_key) + "Data"
        if not object_key or re.search(r"\b" + re.escape(method_name) + r"\s*\(", template):
            continue
        relation_path = tuple(str(ref or "").strip() for ref in block.get("relationPath") or [] if str(ref or "").strip())
        contract = contract_by_relation[(object_key, relation_path)]
        child_entity_type = str(contract.get("childEntityType") or "").strip()
        child_service_field = str(contract.get("childServiceField") or "").strip()
        relation_field = str(contract.get("foreignKeyField") or "").strip()
        parent_key_field = str(contract.get("parentKeyField") or "").strip()
        query_method = str(contract.get("queryMethod") or "paginatorList").strip()
        required = {
            "childEntityType": child_entity_type,
            "childServiceField": child_service_field,
            "foreignKeyField": relation_field,
            "parentKeyField": parent_key_field,
            "queryMethod": query_method
        }
        missing_fields = [name for name, value in required.items() if not value]
        if missing_fields:
            raise ValueError(
                "COMPOSITION_CHILD_QUERY_CONTRACT_INVALID: "
                + object_key + " missing=" + ",".join(missing_fields)
            )
        model_name = _html_safe_id(object_key) + "CompositionModel"
        parent_var = "parent" + _to_pascal(parent_key_field)
        parent_getter = "get" + _to_pascal(parent_key_field)
        parent_source = (
            'getViewData("' + _escape_java_string(parent_key_field) + '")'
            if sub_type == "add"
            else "dataBean == null ? null : dataBean." + parent_getter + "()"
        )
        additions.extend([
            "",
            "    private DataGridModel<" + child_entity_type + "> " + model_name + ";",
            "",
            "    public DataGridModel<" + child_entity_type + "> " + method_name + "() {",
            "        if (" + model_name + " == null) {",
            "            " + model_name + " = new DataGridModel<" + child_entity_type + ">() {",
            "                @Override",
            "                public List<" + child_entity_type + "> fetchData(int first, int pageSize, String sortField, String sortOrder) {",
            "                    String " + parent_var + " = " + parent_source + ";",
            "                    if (StringUtil.isBlank(" + parent_var + ")) {",
            "                        setRowCount(0);",
            "                        return Collections.emptyList();",
            "                    }",
            "                    // 1. 合并前端组件中的查询和排序条件。",
            "                    Map<String, Object> conditionMap = ListGenerator.getSearchMap(",
            "                        getRequestContext().getComponents(), sortField, sortOrder",
            "                    );",
            "                    // 2. 追加已确认的主从关联条件；复杂拼接见《SqlConditionUtil使用规范.mdc》。",
            "                    SqlConditionUtil sqlConditionUtil = new SqlConditionUtil();",
            "                    sqlConditionUtil.eq(\"" + _escape_java_string(relation_field) + "\", " + parent_var + ");",
            "                    // 3. 合并条件后通过子 Service 执行分页查询。",
            "                    conditionMap.putAll(sqlConditionUtil.getMap());",
            "                    PageData<" + child_entity_type + "> pd = " + child_service_field + "." + query_method + "(",
            "                        conditionMap, first, pageSize",
            "                    );",
            "                    setRowCount(pd.getRowCount());",
            "                    return pd.getList();",
            "                }",
            "            };",
            "        }",
            "        return " + model_name + ";",
            "    }"
        ])
    if additions:
        template = _insert_before_last_brace(template, additions)

    missing_code_columns = []
    for col in child_code_columns:
        pascal = _to_pascal(str((col or {}).get("name") or "").strip())
        if pascal and not _has_real_codeitem_model_method(template, pascal):
            missing_code_columns.append(col)
    if missing_code_columns:
        template = _ensure_feature_bridge_imports(template, rule_content, "code_item")
        template = _append_additional_codeitem_models(template, missing_code_columns, section_key)
    return template


def _ensure_composition_form_binding(template, binding):
    form_entity_type = str((binding or {}).get("formEntityType") or "").strip()
    form_entity_import = str((binding or {}).get("formEntityImport") or "").strip()
    form_service_type = str((binding or {}).get("formServiceType") or "").strip()
    form_service_import = str((binding or {}).get("formServiceImport") or "").strip()
    form_service_field = str((binding or {}).get("formServiceField") or "").strip()
    required = {
        "formEntityType": form_entity_type,
        "formEntityImport": form_entity_import,
        "formServiceType": form_service_type,
        "formServiceImport": form_service_import,
        "formServiceField": form_service_field
    }
    missing = [name for name, value in required.items() if not value]
    if missing:
        raise ValueError("COMPOSITION_FORM_BINDING_INVALID: missing=" + ",".join(missing))

    data_bean_match = re.search(
        r"\bprivate\s+([A-Za-z_$][A-Za-z0-9_$]*)\s+dataBean(?:\s*=\s*[^;]+)?\s*;",
        template
    )
    if not data_bean_match:
        raise ValueError("COMPOSITION_FORM_DATABEAN_MISSING")
    owner_entity_type = data_bean_match.group(1)
    if owner_entity_type == form_entity_type:
        return template
    owner_service_match = re.search(
        r"\bprivate\s+[A-Za-z_$][A-Za-z0-9_$]*Service\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*;",
        template
    )
    owner_service_field = owner_service_match.group(1) if owner_service_match else "service"

    template = _ensure_java_imports(template, [
        "import " + form_entity_import + ";",
        "import " + form_service_import + ";"
    ])
    template = re.sub(
        r"(?m)^import\s+[A-Za-z0-9_.$]+\." + re.escape(owner_entity_type) + r";\s*\n?",
        "",
        template
    )
    template = re.sub(r"\b" + re.escape(owner_entity_type) + r"\b", form_entity_type, template)

    service_declaration = re.search(
        r"(?m)^(\s*)private\s+" + re.escape(form_service_type) + r"\s+" + re.escape(form_service_field) + r"\s*;",
        template
    )
    if not service_declaration:
        lines = template.splitlines()
        insert_pos = next((
            idx for idx, line in enumerate(lines)
            if re.search(
                r"\bprivate\s+" + re.escape(form_entity_type)
                + r"\s+dataBean(?:\s*=\s*[^;]+)?\s*;",
                line
            )
        ), -1)
        if insert_pos < 0:
            raise ValueError("COMPOSITION_FORM_DATABEAN_MISSING_AFTER_REBIND")
        lines[insert_pos:insert_pos] = [
            "    @Autowired",
            "    private " + form_service_type + " " + form_service_field + ";",
            ""
        ]
        template = "\n".join(lines)

    template = re.sub(
        r"\b" + re.escape(owner_service_field) + r"\.(find|insert|update)\s*\(",
        form_service_field + r".\1(",
        template
    )
    return template


def _ensure_composition_query_imports(template, contracts, sub_type):
    imports = [
        "import java.util.Collections;",
        "import java.util.List;",
        "import java.util.Map;",
        "import org.springframework.beans.factory.annotation.Autowired;",
        "import com.epoint.core.dto.model.DataGridModel;",
        "import com.epoint.core.utils.sql.SqlConditionUtil;",
        "import com.epoint.core.utils.string.StringUtil;",
        "import com.epoint.database.peisistence.crud.impl.model.PageData;",
        "import com.epoint.frame.service.metadata.mis.util.ListGenerator;"
    ]
    if sub_type == "add":
        imports.append("import java.util.UUID;")
    for contract in contracts:
        entity_import = str((contract or {}).get("childEntityImport") or "").strip()
        service_import = str((contract or {}).get("childServiceImport") or "").strip()
        if entity_import:
            imports.append("import " + entity_import + ";")
        if service_import:
            imports.append("import " + service_import + ";")
    return _ensure_java_imports(template, imports)


def _ensure_composition_service_fields(template, contracts):
    lines = template.splitlines()
    existing = "\n".join(lines)
    additions = []
    for contract in contracts:
        service_type = str((contract or {}).get("childServiceType") or "").strip()
        service_field = str((contract or {}).get("childServiceField") or "").strip()
        if not service_type or not service_field:
            continue
        if re.search(r"\bprivate\s+" + re.escape(service_type) + r"\s+" + re.escape(service_field) + r"\s*;", existing):
            continue
        additions.extend([
            "    @Autowired",
            "    private " + service_type + " " + service_field + ";",
            ""
        ])
    if not additions:
        return template

    insert_pos = next((
        idx for idx, line in enumerate(lines)
        if re.search(r"\bprivate\b[^;]*\bdataBean\b", line)
    ), -1)
    if insert_pos < 0:
        insert_pos = next((
            idx + 1 for idx, line in enumerate(lines)
            if re.search(r"\bpublic\s+class\b", line) and "{" in line
        ), len(lines))
    lines[insert_pos:insert_pos] = additions
    return "\n".join(lines)


def _normalize_java_package_and_imports(template, module_id, business_facts_path, target_file):
    """用 Java 目标文件和 ownerFiles 的真实路径收口 package/import。"""
    normalized = _post_fill_package_from_target(template, target_file)
    return _post_fill_imports_from_owner_files(
        template=normalized,
        module_id=module_id,
        business_facts_path=business_facts_path,
        target_file=target_file
    )


def _validate_java_package_and_imports(template, module_id, business_facts_path, target_file):
    """写盘前校验 Java package 与项目内 import，防止编译期才暴露路径投影错误。"""
    expected_package = _java_package_from_target_file(target_file)
    if not expected_package:
        return {
            'ok': False,
            'message': '无法从 Java targetFile 推导 package：' + str(target_file or '')
        }

    package_match = re.search(r'(?m)^\s*package\s+([A-Za-z_][A-Za-z0-9_.]*)\s*;', str(template or ''))
    actual_package = package_match.group(1).strip() if package_match else ''
    if actual_package != expected_package:
        return {
            'ok': False,
            'message': 'Java package 与 targetFile 不一致：expected=' + expected_package + ', actual=' + (actual_package or '<missing>'),
            'expectedPackage': expected_package,
            'actualPackage': actual_package
        }

    package_map = _load_owner_file_package_map(business_facts_path, module_id)
    plan = _read_plan_near_business_facts(business_facts_path) or {}
    owner_paths = [
        str(item.get("resolvedPath") or "")
        for module in plan.get("modulesOwnerFiles") or []
        for item in (module or {}).get("ownerFiles") or []
        if str(item.get("resolvedPath") or "").lower().endswith(".java")
    ]
    # 只校验计划所属的本地包，框架/JAR 的包不在这里做依赖扫描。
    local_namespaces = {
        ".".join(_java_package_from_target_file(source).split(".")[:3])
        for source in owner_paths if _java_package_from_target_file(source).count(".") >= 2
    }
    java_roots = {
        source.replace("\\", "/").rsplit("/src/main/java/", 1)[0] + "/src/main/java"
        for source in owner_paths if "/src/main/java/" in source.replace("\\", "/")
    }
    mismatches = []
    for match in re.finditer(r'(?m)^\s*import\s+([A-Za-z_][A-Za-z0-9_.]*)\.([A-Za-z_][A-Za-z0-9_]*)\s*;', str(template or '')):
        imported_package = match.group(1)
        class_name = match.group(2)
        expected_import_package = package_map.get(class_name)
        if expected_import_package and imported_package != expected_import_package:
            mismatches.append({
                'className': class_name,
                'actualPackage': imported_package,
                'expectedPackage': expected_import_package
            })
        if any(imported_package == namespace or imported_package.startswith(namespace + ".")
               for namespace in local_namespaces):
            relative_source = (imported_package + "." + class_name).replace(".", "/") + ".java"
            if not any(os.path.isfile(os.path.join(root, relative_source)) for root in java_roots):
                mismatches.append({
                    'className': class_name,
                    'actualPackage': imported_package,
                    'reason': 'local_source_missing'
                })

    # ownerFiles 缺失时仍拦截本次已知的 domain 丢失形态；单段旧项目包路径不受影响。
    expected_parts = expected_package.split('.')
    marker_index = -1
    for index, part in enumerate(expected_parts):
        if part == 'xmgxh':
            marker_index = index
            break
    if marker_index >= 0 and len(expected_parts) - marker_index >= 4:
        domain = expected_parts[marker_index + 1]
        biz_module = expected_parts[marker_index + 2]
        missing_domain_prefix = '.'.join(expected_parts[:marker_index + 1] + [biz_module]) + '.'
        expected_domain_prefix = '.'.join(expected_parts[:marker_index + 1] + [domain, biz_module]) + '.'
        for match in re.finditer(r'(?m)^\s*import\s+([A-Za-z_][A-Za-z0-9_.]*)\.([A-Za-z_][A-Za-z0-9_]*)\s*;', str(template or '')):
            imported_package = match.group(1)
            if imported_package.startswith(missing_domain_prefix) and not imported_package.startswith(expected_domain_prefix):
                mismatches.append({
                    'className': match.group(2),
                    'actualPackage': imported_package,
                    'expectedPackage': expected_domain_prefix.rstrip('.'),
                    'reason': 'domain_segment_missing'
                })

    if mismatches:
        unique = []
        seen = set()
        for item in mismatches:
            key = json.dumps(item, ensure_ascii=False, sort_keys=True)
            if key in seen:
                continue
            seen.add(key)
            unique.append(item)
        return {
            'ok': False,
            'message': 'Java import 与 ownerFiles/targetFile 不一致，拒绝写盘：' + json.dumps(unique, ensure_ascii=False),
            'expectedPackage': expected_package,
            'mismatches': unique
        }

    return {
        'ok': True,
        'expectedPackage': expected_package,
        'checkedOwnerImportCount': len(package_map)
    }


def _ensure_composition_add_parent_key_lifecycle(template, contracts):
    parent_keys = []
    for contract in contracts:
        parent_key = str((contract or {}).get("parentKeyField") or "").strip()
        if parent_key and parent_key not in parent_keys:
            parent_keys.append(parent_key)
    for parent_key in parent_keys:
        template = _ensure_composition_parent_key_property(template, parent_key)
        template = _ensure_composition_add_page_key(template, parent_key)
        template = _ensure_composition_add_save_key(template, parent_key)
    return template


def _ensure_composition_child_action_stubs(template, contracts):
    additions = []
    method_owners = {}
    for contract in contracts:
        child_object_key = str((contract or {}).get("childObjectKey") or "").strip()
        pascal = _to_pascal(child_object_key)
        if not child_object_key or not pascal:
            continue
        parent_key = str((contract or {}).get("parentKeyField") or "").strip()
        foreign_key = str((contract or {}).get("foreignKeyField") or "").strip()
        service_field = str((contract or {}).get("childServiceField") or "").strip()
        method_specs = [
            (
                "add" + pascal + "Row",
                "CompositionChildAddRow",
                "补全新增行的参数、返回值和前端 epoint.execute 联动"
            ),
            (
                "remove" + pascal + "Rows",
                "CompositionChildRemoveRows",
                "补全选择键、未保存行/已持久化行分流、删除确认和刷新回调"
            )
        ]
        for method_name, todo_tag, duty in method_specs:
            previous_owner = method_owners.get(method_name)
            if previous_owner and previous_owner != child_object_key:
                raise ValueError(
                    "COMPOSITION_CHILD_ACTION_METHOD_CONFLICT: method=" + method_name
                    + ", childObjectKeys=" + previous_owner + "," + child_object_key
                )
            method_owners[method_name] = child_object_key
            if re.search(r"\bpublic\s+void\s+" + re.escape(method_name) + r"\s*\(", template):
                continue
            additions.extend([
                "",
                "    public void " + method_name + "() {",
                "        // AI_TODO[" + todo_tag + "]: 结合当前 Story 验收、适用规范和真实源码" + duty + "；可在授权范围内新增业务方法。",
                "        // 机械关系合同：childObjectKey=" + child_object_key
                + "，parentKeyField=" + parent_key + "，foreignKeyField=" + foreign_key
                + "，childServiceField=" + service_field + "。",
                "        // 由 LLM 判断客户端暂存或立即持久化；持久化必须下沉 Service，禁止在 Action 直接写 DAO/SQL。",
                "    }"
            ])
    return _insert_before_last_brace(template, additions) if additions else template


def _ensure_composition_parent_key_property(template, parent_key):
    field_name = _safe_java_identifier(parent_key)
    pascal = _to_pascal(parent_key)
    if not field_name or not pascal:
        return template
    lines = template.splitlines()
    existing = "\n".join(lines)
    if not re.search(r"\bprivate\s+String\s+" + re.escape(field_name) + r"\s*;", existing):
        insert_pos = next((
            idx + 1 for idx, line in enumerate(lines)
            if re.search(r"\bprivate\b[^;]*\bdataBean\b", line)
        ), -1)
        if insert_pos < 0:
            insert_pos = next((
                idx + 1 for idx, line in enumerate(lines)
                if re.search(r"\bpublic\s+class\b", line) and "{" in line
            ), len(lines))
        lines[insert_pos:insert_pos] = ["    private String " + field_name + ";"]
        template = "\n".join(lines)
    if not re.search(r"\bpublic\s+String\s+get" + re.escape(pascal) + r"\s*\(", template):
        template = _insert_before_last_brace(template, [
            "",
            "    public String get" + pascal + "() {",
            "        return " + field_name + ";",
            "    }",
            "",
            "    public void set" + pascal + "(String " + field_name + ") {",
            "        this." + field_name + " = " + field_name + ";",
            "    }"
        ])
    return template


def _ensure_composition_add_page_key(template, parent_key):
    marker = 'addViewData("' + _escape_java_string(parent_key) + '"'
    if marker in template:
        return template
    lines = template.splitlines()
    method_pos = next((
        idx for idx, line in enumerate(lines)
        if re.search(r"\bpublic\s+void\s+pageLoad\s*\(", line)
    ), -1)
    if method_pos < 0:
        return template
    end_pos = _find_method_end(lines, method_pos)
    if end_pos < method_pos:
        return template
    base_indent = lines[method_pos][:len(lines[method_pos]) - len(lines[method_pos].lstrip())]
    indent = base_indent + "    "
    lifecycle = [
        indent + "if (!isPostback()) {",
        indent + "    addViewData(\"" + _escape_java_string(parent_key) + "\", UUID.randomUUID().toString());",
        indent + "}"
    ]
    if end_pos == method_pos:
        method_line = lines[method_pos]
        open_pos = method_line.find("{")
        close_pos = method_line.rfind("}")
        if open_pos < 0 or close_pos <= open_pos:
            return template
        original_body = method_line[open_pos + 1:close_pos].strip()
        trailing = method_line[close_pos + 1:]
        expanded = [method_line[:open_pos + 1].rstrip()]
        if original_body:
            expanded.append(indent + original_body)
        expanded.extend(lifecycle)
        expanded.append(base_indent + "}" + trailing)
        lines[method_pos:method_pos + 1] = expanded
        return "\n".join(lines)
    lines[end_pos:end_pos] = lifecycle
    return "\n".join(lines)


def _ensure_composition_add_save_key(template, parent_key):
    pascal = _to_pascal(parent_key)
    parent_var = _safe_java_identifier(parent_key)
    if not parent_var:
        return template
    if re.search(r"\b" + re.escape(parent_var) + r"\s*=\s*getViewData", template):
        return template
    lines = template.splitlines()
    method_pos = next((
        idx for idx, line in enumerate(lines)
        if re.search(r"\bpublic\s+void\s+add\s*\(", line)
    ), -1)
    if method_pos < 0:
        return template
    end_pos = _find_method_end(lines, method_pos)
    if end_pos <= method_pos:
        return template
    setter_pattern = re.compile(r"\bdataBean\.set" + re.escape(pascal) + r"\s*\(")
    replace_pos = next((
        idx for idx in range(method_pos + 1, end_pos)
        if setter_pattern.search(lines[idx])
    ), -1)
    insert_pos = replace_pos if replace_pos >= 0 else _find_service_call_line(lines, method_pos)
    if insert_pos < 0:
        insert_pos = end_pos
    indent = lines[insert_pos][:len(lines[insert_pos]) - len(lines[insert_pos].lstrip())]
    lifecycle = [
        indent + parent_var + " = getViewData(\"" + _escape_java_string(parent_key) + "\");",
        indent + "if (StringUtil.isBlank(" + parent_var + ")) {",
        indent + "    " + parent_var + " = UUID.randomUUID().toString();",
        indent + "    addViewData(\"" + _escape_java_string(parent_key) + "\", " + parent_var + ");",
        indent + "}",
        indent + "dataBean.set" + pascal + "(" + parent_var + ");"
    ]
    if replace_pos >= 0:
        lines[replace_pos:replace_pos + 1] = lifecycle
    else:
        lines[insert_pos:insert_pos] = lifecycle
    return "\n".join(lines)


def _post_fill_export_model(template, business_columns):
    """
    从 businessColumns 自动填充 ExportModel 的 fields 和 headers。
    匹配模板中 new ExportModel("...","...") 并替换为真实字段列表。
    如果模板里没有 ExportModel 占位符则不做任何操作。
    """
    if not business_columns:
        return template
    if "ExportModel" not in template:
        return template
    fields = ",".join(str(col.get("name") or "").strip() for col in business_columns if col.get("name"))
    headers = ",".join(str(col.get("comment") or col.get("name") or "").strip() for col in business_columns if col.get("name"))
    if not fields:
        return template
    # 替换 new ExportModel("任意内容","任意内容") 为真实字段
    import re
    pattern = r'new\s+ExportModel\s*\(\s*"[^"]*"\s*,\s*"[^"]*"\s*\)'
    replacement = 'new ExportModel("' + fields + '", "' + headers + '")'
    result = re.sub(pattern, replacement, template)
    return result


def _remove_action_codeitem_blocks(template):
    lines = template.splitlines()
    out = []
    i = 0
    while i < len(lines):
        line = lines[i]
        stripped = line.strip()
        marker_line = any(token in line for token in (
            "{codeItemField}", "{CodeItem}", "{codeItem}", "{代码项名称}", "{CodeItemCode}"
        ))

        if "代码项" in line and ("数据源示例" in line or "数据源" in line or "搜索列表数据源示例" in line or "表单录入数据源示例" in line):
            i += 1
            while i < len(lines) and (lines[i].strip().startswith("//") or lines[i].strip() == ""):
                i += 1
            continue

        if marker_line and ("get{CodeItem}Model" in line or "getXxxModel" in line or "public List<SelectItem>" in line):
            i = _skip_braced_block(lines, i)
            continue

        if marker_line and "StringUtil.isNotBlank" in line:
            i = _skip_braced_block(lines, i)
            continue

        if marker_line:
            i += 1
            continue

        out.append(line)
        i += 1
    return "\n".join(out)


def _remove_codeitem_imports(template):
    lines = template.splitlines()
    out = []
    for line in lines:
        stripped = line.strip()
        if stripped.startswith("import "):
            import_target = stripped[len("import "):].rstrip(";").strip()
            simple_name = import_target.split(".")[-1]
            body_without_line = template.replace(line, "")
            if simple_name and not re.search(r"\b" + re.escape(simple_name) + r"\b", body_without_line):
                continue
        out.append(line)
    return "\n".join(out)


def _post_fill_action_date_ranges(template, business_columns):
    date_columns = _date_range_columns(business_columns)
    if "ListGenerator.getSearchMap" in template:
        return _ensure_date_range_imports(_post_fill_listgenerator_date_ranges(template, date_columns), date_columns)
    template = _replace_action_date_field_declarations(template, date_columns)
    return _ensure_date_range_imports(_replace_action_date_conditions(template, date_columns), date_columns)


def _ensure_date_range_imports(template, date_columns):
    if not date_columns:
        return template
    if "StringUtil.isNotBlank" not in template and "EpointDateUtil." not in template:
        return template
    return _ensure_java_imports(template, [
        "import com.epoint.core.utils.date.EpointDateUtil;",
        "import com.epoint.core.utils.string.StringUtil;"
    ])


def _replace_action_date_field_declarations(template, date_columns):
    lines = template.splitlines()
    out = []
    inserted = False
    i = 0
    while i < len(lines):
        line = lines[i]
        if "private String startDate" in line:
            indent = line[:len(line) - len(line.lstrip())]
            if not inserted:
                out.extend(_render_action_date_field_declarations(date_columns, indent))
                inserted = True
            i += 1
            continue
        if "private String endDate" in line:
            i += 1
            continue
        out.append(line)
        i += 1
    return "\n".join(out)


def _render_action_date_field_declarations(date_columns, indent):
    lines = []
    for col in date_columns or []:
        field = _safe_java_identifier(str((col or {}).get("name") or "").strip())
        label = str((col or {}).get("comment") or field).strip()
        if not field:
            continue
        lines.append(f"{indent}private String {field}Start; // {label}查询-开始")
        lines.append(f"{indent}private String {field}End;   // {label}查询-结束")
    return lines


def _replace_action_date_conditions(template, date_columns):
    generated = _render_action_date_conditions(date_columns, "                    ")
    lines = template.splitlines()
    out = []
    i = 0
    while i < len(lines):
        line = lines[i]
        if "时间区间查询" in line:
            if generated:
                out.append(line)
                out.extend(generated)
            i += 1
            while i < len(lines):
                current = lines[i]
                if "排序处理" in current or "PageData<" in current or "conditionMap.putAll" in current:
                    break
                i += 1
            continue
        out.append(line)
        i += 1
    return "\n".join(out)


def _render_action_date_conditions(date_columns, indent):
    lines = []
    for col in date_columns or []:
        raw_name = str((col or {}).get("name") or "").strip()
        field = _safe_java_identifier(raw_name)
        if not raw_name or not field:
            continue
        lines.extend([
            f"{indent}if (StringUtil.isNotBlank({field}Start)) {{",
            f"{indent}    sql.ge(\"{raw_name}\", EpointDateUtil.getBeginOfDateStr({field}Start));",
            f"{indent}}}",
            f"{indent}if (StringUtil.isNotBlank({field}End)) {{",
            f"{indent}    sql.lt(\"{raw_name}\", EpointDateUtil.getEndOfDateStr({field}End));",
            f"{indent}}}"
        ])
    return lines


def _post_fill_listgenerator_date_ranges(template, date_columns):
    generated = _render_listgenerator_date_conditions(date_columns, "                    ")
    lines = template.splitlines()
    out = []
    inserted = False
    i = 0
    while i < len(lines):
        line = lines[i]
        stripped = line.strip()
        if "示例：时间区间查询绑定" in line:
            if generated and not inserted:
                out.extend(generated)
                inserted = True
            i += 1
            while i < len(lines) and lines[i].strip().startswith("//"):
                i += 1
            continue
        if (not inserted) and "conditionMap.putAll(sqlConditionUtil.getMap())" in line:
            if generated:
                out.extend(generated)
                inserted = True
            out.append(line)
            i += 1
            continue
        if stripped.startswith("private String startDate") or stripped.startswith("private String endDate"):
            i += 1
            continue
        out.append(line)
        i += 1
    return "\n".join(out)


def _post_fill_action_query_filters(template, facts):
    """将 Design 已确认的列表查询合同写成可执行条件，禁止由 Coder 猜 bind 到字段的映射。"""
    if "ListGenerator.getSearchMap" not in template:
        return template
    filters = []
    seen_inputs = set()
    for item in (facts or {}).get("queryFilters") or []:
        if not isinstance(item, dict):
            continue
        input_key = str(item.get("inputKey") or "").strip()
        field_name = str(item.get("fieldName") or "").strip()
        operator = str(item.get("operator") or "").strip().lower()
        normalize = str(item.get("normalize") or "none").strip().lower()
        if not input_key or not field_name or input_key in seen_inputs or operator not in ("contains", "exact"):
            continue
        seen_inputs.add(input_key)
        filters.append({
            "inputKey": input_key,
            "fieldName": field_name,
            "operator": operator,
            "normalize": normalize,
            "implementation": item.get("implementation"),
            "objectKey": item.get("objectKey"),
            "relationPath": item.get("relationPath") or []
        })
    if not filters:
        return template

    generated = ["                    // QUERY_FILTER_BEGIN: Builder-owned mapping; do not infer from bind name."]
    action_bind_fields = []
    for item in filters:
        input_key = item["inputKey"]
        field_name = item["fieldName"]
        property_name = _safe_java_identifier(input_key)
        action_bind_fields.append((property_name, field_name + "查询"))
        if item["implementation"] == "coder":
            generated.append('                    // AI_TODO: 关联筛选 ' + input_key + ' -> '
                             + str(item["objectKey"]) + '.' + field_name
                             + '；按 business-facts.queryFilters 的 relationPath 实现关联查询，不能作为主表条件。')
            continue
        if item["operator"] == "contains":
            value_expr = property_name + ('.trim()' if item["normalize"] == "trim" else '')
            generated.append('                    if (StringUtil.isNotBlank(' + property_name + ')) {')
            generated.append('                        sqlConditionUtil.like("' + _escape_java_string(field_name) + '", ' + value_expr + ');')
            generated.append('                    }')
    generated.append("                    // QUERY_FILTER_END")

    lines = template.splitlines()
    out = []
    inserted = False
    index = 0
    while index < len(lines):
        line = lines[index]
        if "QUERY_FILTER_BEGIN:" in line:
            index += 1
            while index < len(lines) and "QUERY_FILTER_END" not in lines[index]:
                index += 1
            index += 1
            continue
        if not inserted and "conditionMap.putAll(sqlConditionUtil.getMap())" in line:
            out.extend(generated)
            inserted = True
        out.append(line)
        index += 1
    result = "\n".join(out)
    if action_bind_fields:
        result = _ensure_action_bind_field_declarations(result, action_bind_fields)
        result = _ensure_action_bind_accessors(result, action_bind_fields)
    return result


def _render_listgenerator_date_conditions(date_columns, indent):
    lines = []
    for col in date_columns or []:
        raw_name = str((col or {}).get("name") or "").strip()
        if not raw_name:
            continue
        start_key = raw_name + "Start"
        end_key = raw_name + "End"
        lines.extend([
            f"{indent}if (StringUtil.isNotBlank({start_key})) {{",
            f"{indent}    sqlConditionUtil.ge(\"{raw_name}\", EpointDateUtil.getBeginOfDateStr({start_key}));",
            f"{indent}}}",
            f"{indent}if (StringUtil.isNotBlank({end_key})) {{",
            f"{indent}    sqlConditionUtil.lt(\"{raw_name}\", EpointDateUtil.getEndOfDateStr({end_key}));",
            f"{indent}}}"
        ])
    return lines


def _remove_action_primary_search_blocks(template):
    lines = template.splitlines()
    out = []
    i = 0
    while i < len(lines):
        line = lines[i]
        stripped = line.strip()
        if stripped == "private String searchKeyword;":
            i += 1
            continue
        if "文本模糊查询" in line:
            i += 1
            while i < len(lines):
                current = lines[i]
                if "代码项精确查询" in current or "时间区间查询" in current or "排序处理" in current:
                    break
                i += 1
            continue
        if "StringUtil.isNotBlank(searchKeyword)" in line:
            i = _skip_braced_block(lines, i)
            continue
        out.append(line)
        i += 1
    return "\n".join(out)


def _post_fill_action_page_bind_properties(template, business_columns, section_key=""):
    if "ListAction" not in str(section_key or "") and "getDataGridData" not in template:
        return template
    bind_fields = _list_page_action_bind_fields(template, business_columns)
    if not bind_fields:
        return template
    template = _ensure_action_bind_field_declarations(template, bind_fields)
    return _ensure_action_bind_accessors(template, bind_fields)


def _list_page_action_bind_fields(template, business_columns):
    fields = []
    # list/search 页面裸 bind 会触发 EL 读取 Action 属性；不能只在前端写一个字符串。
    is_listgenerator = "ListGenerator.getSearchMap" in template
    primary_name = _first_text_search_field_name(business_columns)
    code_col = _first_code_item_column(business_columns)
    date_columns = _date_range_columns(business_columns)
    has_filter_controls = bool(primary_name or code_col or date_columns)
    if (primary_name and not is_listgenerator) or not has_filter_controls:
        fields.append(("searchKeyword", "关键字查询"))

    if not is_listgenerator:
        if code_col:
            field_name = _safe_java_identifier(str(code_col.get("name") or "").strip())
            label = str(code_col.get("comment") or field_name).strip()
            if field_name:
                fields.append((field_name, label + "查询"))

    for col in date_columns:
        field_name = _safe_java_identifier(str((col or {}).get("name") or "").strip())
        label = str((col or {}).get("comment") or field_name).strip()
        if not field_name:
            continue
        fields.append((field_name + "Start", label + "查询-开始"))
        fields.append((field_name + "End", label + "查询-结束"))

    out = []
    seen = set()
    for name, comment in fields:
        if not name or name in seen:
            continue
        seen.add(name)
        out.append((name, comment))
    return out


def _ensure_action_bind_field_declarations(template, bind_fields):
    existing = set(re.findall(r"\bprivate\s+String\s+([A-Za-z_][A-Za-z0-9_]*)\s*;", template))
    missing = [(name, comment) for name, comment in bind_fields if name not in existing]
    if not missing:
        return template
    lines = template.splitlines()
    insert_at = -1
    for idx, line in enumerate(lines):
        if re.search(r"\bprivate\s+DataGridModel\s*<", line):
            insert_at = idx + 1
            break
    if insert_at < 0:
        for idx, line in enumerate(lines):
            if re.search(r"\bprivate\s+[A-Za-z0-9_<>, ?]+\s+\w+\s*(?:=|;)", line):
                insert_at = idx + 1
        if insert_at < 0:
            return template
    indent_match = re.match(r"(\s*)", lines[insert_at - 1] if insert_at > 0 else "")
    indent = indent_match.group(1) if indent_match else "    "
    declarations = []
    for name, comment in missing:
        declarations.append(indent + f"private String {name}; // {comment}")
    lines[insert_at:insert_at] = declarations
    return "\n".join(lines)


def _ensure_action_bind_accessors(template, bind_fields):
    existing_getters = set(re.findall(r"\bpublic\s+String\s+get([A-Za-z_][A-Za-z0-9_]*)\s*\(", template))
    existing_setters = set(re.findall(r"\bpublic\s+void\s+set([A-Za-z_][A-Za-z0-9_]*)\s*\(", template))
    blocks = []
    for name, _comment in bind_fields:
        pascal = _to_pascal(name)
        if not pascal:
            continue
        if pascal not in existing_getters:
            blocks.extend([
                "",
                f"    public String get{pascal}() {{",
                f"        return {name};",
                "    }"
            ])
        if pascal not in existing_setters:
            blocks.extend([
                "",
                f"    public void set{pascal}(String {name}) {{",
                f"        this.{name} = {name};",
                "    }"
            ])
    if not blocks:
        return template
    insert_at = template.rfind("\n}")
    if insert_at < 0:
        return template
    return template[:insert_at] + "\n" + "\n".join(blocks) + template[insert_at:]


def _materialize_commented_codeitem_model(template, pascal, camel, code_name, section_key=""):
    """
    950+ 规则把代码项数据源作为注释模板给出。只在字段级 codeItem 存在时，把注释模板转成真实方法。
    950- 已经是非注释模板，前面的 placeholder replace 已足够。
    """
    if "getXxxModel" not in template or "CodeModalFactory.factory" not in template:
        return template

    lines = template.splitlines()
    out = []
    i = 0
    inserted = False
    while i < len(lines):
        line = lines[i]
        if (not inserted) and "private List<SelectItem> xxxModel" in line:
            indent = line[:len(line) - len(line.lstrip())]
            out.append(indent + f"private List<SelectItem> {camel}Model;")
            i += 1
            while i < len(lines):
                current = lines[i]
                if "return xxxModel;" in current:
                    i += 1
                    if i < len(lines) and lines[i].strip() in ("// }", "//}", "* }"):
                        i += 1
                    break
                i += 1
            factory_append_flag = _codeitem_factory_append_flag(section_key)
            out.extend([
                indent + f"public List<SelectItem> get{pascal}Model() {{",
                indent + f"    if ({camel}Model == null) {camel}Model = DataUtil.convertMap2ComboBox(",
                indent + f"        (List<Map<String, String>>) CodeModalFactory.factory(\"下拉列表\", \"{code_name}\", null, {factory_append_flag}));",
                indent + f"    return {camel}Model;",
                indent + "}"
            ])
            inserted = True
            continue
        out.append(line)
        i += 1
    return "\n".join(out)


def _append_additional_codeitem_models(template, additional_code_columns, section_key=""):
    """
    在类体的末尾（最后一个 } 之前）追加额外 codeItem 字段声明 + getXxxModel 方法。
    第一个 codeItem 已经通过模板占位符替换完成，这里处理第 2 个及之后的。
    """
    if not additional_code_columns:
        return template
    lines = template.splitlines()
    # 找类体最后的 } 位置（从末尾往前找第一个只有 } 的行）
    insert_pos = len(lines) - 1
    for i in range(len(lines) - 1, -1, -1):
        if lines[i].strip() == "}":
            insert_pos = i
            break
    # 检测缩进（用第一个 private 字段行的缩进作为参考）
    indent = "    "
    for line in lines:
        if "private " in line and "Model" in line:
            indent = line[:len(line) - len(line.lstrip())]
            break
    # 为每个额外 codeItem 生成 field + method
    factory_append_flag = _codeitem_factory_append_flag(section_key)
    extra_lines = []
    for col in additional_code_columns:
        field_name = str(col.get("name") or "").strip()
        code_name = _get_code_item_name(col)
        if not field_name or not code_name:
            continue
        pascal = _to_pascal(field_name)
        camel = pascal[:1].lower() + pascal[1:] if pascal else field_name
        extra_lines.append("")
        extra_lines.append(f"{indent}private List<SelectItem> {camel}Model;")
        extra_lines.append("")
        extra_lines.append(f"{indent}public List<SelectItem> get{pascal}Model() {{")
        extra_lines.append(f"{indent}    if ({camel}Model == null) {camel}Model = DataUtil.convertMap2ComboBox(")
        extra_lines.append(f'{indent}        (List<Map<String, String>>) CodeModalFactory.factory("下拉列表", "{code_name}", null, {factory_append_flag}));')
        extra_lines.append(f"{indent}    return {camel}Model;")
        extra_lines.append(f"{indent}}}")
    if extra_lines:
        lines[insert_pos:insert_pos] = extra_lines
    return "\n".join(lines)


def _has_real_codeitem_model_method(template, pascal):
    pattern = re.compile(r"^\s*public\s+List\s*<\s*SelectItem\s*>\s+get" + re.escape(str(pascal or "")) + r"Model\s*\(",
                         re.MULTILINE)
    return bool(pattern.search(str(template or "")))


def _post_fill_action_attachments(template, business_columns, target_file, section_key=""):
    attachment_columns = [col for col in business_columns or [] if _is_attachment_column(col)]
    if not attachment_columns:
        return template
    sub_type = _detect_action_subtype(target_file, section_key)
    if sub_type not in ("add", "edit", "detail", "workflow"):
        # list/mylist 等页面不需要附件初始化代码；从模板中剥离规则骨架自带的附件块。
        return _strip_attachment_blocks(template)

    imports = [
        "import com.epoint.basic.faces.fileupload.AttachHandler9;",
        "import com.epoint.basic.faces.fileupload.AttachStorage;",
        "import com.epoint.basic.faces.fileupload.FileUploadModel9;",
        "import com.epoint.basic.faces.tree.DefaultFileUploadHandlerImpl9;"
    ]
    if sub_type in ("add", "edit", "workflow"):
        imports.extend([
            "import com.epoint.core.utils.string.StringUtil;",
            "import java.util.UUID;"
        ])
    template = _ensure_java_imports(template, imports)
    template = _ensure_attachment_fields(template, attachment_columns)
    template = _ensure_attachment_page_load(template, attachment_columns, sub_type)
    if sub_type in ("add", "edit", "workflow"):
        template = _ensure_attachment_save_assignments(template, attachment_columns, sub_type)
    template = _append_attachment_upload_models(template, attachment_columns)
    return template


def _detect_action_subtype(target_file, section_key=""):
    text = (str(section_key or "") + " " + os.path.basename(str(target_file or ""))).lower()
    # mylist 必须在 workflow 之前检查：section_key "WorkflowMyListAction" 含 "workflow"
    # 但它是我的流程列表页，不是工作流表单页，不应生成附件初始化代码。
    if "mylist" in text:
        return "list"
    if "workflow" in text:
        return "workflow"
    if "add" in text:
        return "add"
    if "edit" in text:
        return "edit"
    if "detail" in text:
        return "detail"
    if "list" in text:
        return "list"
    return ""


def _ensure_attachment_fields(template, attachment_columns):
    lines = template.splitlines()
    insert_pos = -1
    indent = "    "
    for idx, line in enumerate(lines):
        if re.search(r"\bprivate\b[\s\S]*\bdataBean\b", line):
            insert_pos = idx + 1
            indent = line[:len(line) - len(line.lstrip())]
            break
    if insert_pos < 0:
        for idx, line in enumerate(lines):
            if "public class " in line and "{" in line:
                insert_pos = idx + 1
                break
    if insert_pos < 0:
        return template

    existing = "\n".join(lines)
    extra = []
    for col in attachment_columns:
        info = _attachment_info(col)
        if not info["field"] or not info["pascal"]:
            continue
        if not re.search(r"\bFileUploadModel9\s+" + re.escape(info["model_field"]) + r"\b", existing):
            extra.append(f"{indent}private FileUploadModel9 {info['model_field']};")
    if extra:
        lines[insert_pos:insert_pos] = extra
    return "\n".join(lines)


def _ensure_attachment_page_load(template, attachment_columns, sub_type):
    lines = template.splitlines()
    page_load_pos = -1
    for idx, line in enumerate(lines):
        if re.search(r"\bpublic\s+void\s+pageLoad\s*\(", line):
            page_load_pos = idx
            break
    if page_load_pos < 0:
        return template

    open_line = lines[page_load_pos]
    if "{" in open_line and "}" in open_line:
        indent = open_line[:len(open_line) - len(open_line.lstrip())] + "    "
        prefix = open_line[:open_line.rfind("}")].rstrip()
        suffix = open_line[open_line.rfind("}"):]
        body = _attachment_page_load_lines(attachment_columns, sub_type, indent)
        lines[page_load_pos:page_load_pos + 1] = [prefix, *body, open_line[:len(open_line) - len(open_line.lstrip())] + suffix]
        return "\n".join(lines)

    end_pos = _find_method_end(lines, page_load_pos)
    if end_pos <= page_load_pos:
        return template
    base_indent = lines[page_load_pos][:len(lines[page_load_pos]) - len(lines[page_load_pos].lstrip())]
    body_indent = base_indent + "    "
    insertion = _attachment_page_load_lines(attachment_columns, sub_type, body_indent)
    lines[end_pos:end_pos] = insertion
    return "\n".join(lines)


def _attachment_page_load_lines(attachment_columns, sub_type, indent):
    lines = []
    for col in attachment_columns:
        info = _attachment_info(col)
        if not info["field"]:
            continue
        getter = f"dataBean.get{info['pascal']}()"
        setter = f"dataBean.set{info['pascal']}({info['field']})"
        lines.append(f"{indent}// 附件生命周期：{info['label']} 使用字段 {info['field']} 保存稳定附件标识。")
        if sub_type == "add":
            lines.extend([
                f"{indent}if (!isPostback()) {{",
                f"{indent}    String {info['field']} = UUID.randomUUID().toString();",
                f"{indent}    addViewData(\"{info['field']}\", {info['field']});",
                f"{indent}    dataBean.set{info['pascal']}({info['field']});",
                f"{indent}}} else {{",
                f"{indent}    dataBean.set{info['pascal']}(getViewData(\"{info['field']}\"));",
                f"{indent}}}"
            ])
        elif sub_type in ("edit", "workflow"):
            lines.extend([
                f"{indent}if (!isPostback()) {{",
                f"{indent}    if (dataBean != null && StringUtil.isNotBlank({getter})) {{",
                f"{indent}        addViewData(\"{info['field']}\", {getter});",
                f"{indent}    }} else {{",
                f"{indent}        String {info['field']} = UUID.randomUUID().toString();",
                f"{indent}        addViewData(\"{info['field']}\", {info['field']});",
                f"{indent}        if (dataBean != null) {setter};",
                f"{indent}    }}",
                f"{indent}}} else if (dataBean != null) {{",
                f"{indent}    dataBean.set{info['pascal']}(getViewData(\"{info['field']}\"));",
                f"{indent}}}"
            ])
        elif sub_type == "detail":
            lines.extend([
                f"{indent}if (dataBean != null) {{",
                f"{indent}    addViewData(\"{info['field']}\", {getter});",
                f"{indent}}}"
            ])
    return lines


def _ensure_attachment_save_assignments(template, attachment_columns, sub_type):
    method_name = "add" if sub_type == "add" else "save"
    lines = template.splitlines()
    method_pos = -1
    for idx, line in enumerate(lines):
        if re.search(r"\b(?:public|private|protected)\s+(?:void|boolean|String)\s+" + method_name + r"\s*\(", line):
            method_pos = idx
            break
    if method_pos < 0:
        return template
    insertion_pos = _find_service_call_line(lines, method_pos)
    if insertion_pos < 0:
        insertion_pos = _find_method_end(lines, method_pos)
    if insertion_pos <= method_pos:
        return template
    indent = lines[insertion_pos][:len(lines[insertion_pos]) - len(lines[insertion_pos].lstrip())]
    assign_lines = []
    for col in attachment_columns:
        info = _attachment_info(col)
        if not info["field"]:
            continue
        assign_lines.append(f"{indent}dataBean.set{info['pascal']}(getViewData(\"{info['field']}\"));")
    lines[insertion_pos:insertion_pos] = assign_lines
    return "\n".join(lines)


def _find_service_call_line(lines, method_pos):
    end_pos = _find_method_end(lines, method_pos)
    for idx in range(method_pos + 1, end_pos):
        if re.search(r"\b[A-Za-z_][A-Za-z0-9_]*\.(insert|update|save)\s*\(", lines[idx]):
            return idx
    return -1


def _append_attachment_upload_models(template, attachment_columns):
    lines = template.splitlines()
    insert_pos = _find_class_end(lines)
    if insert_pos < 0:
        return template
    existing = "\n".join(lines)
    indent = "    "
    extra = []
    for col in attachment_columns:
        info = _attachment_info(col)
        if not info["field"] or not info["pascal"]:
            continue
        if re.search(r"\bFileUploadModel9\s+get" + re.escape(info["pascal"]) + r"UploadModel\s*\(", existing):
            continue
        extra.extend(_attachment_upload_model_lines(info, indent))
    if extra:
        lines[insert_pos:insert_pos] = extra
    return "\n".join(lines)


def _attachment_upload_model_lines(info, indent):
    return [
        "",
        f"{indent}public FileUploadModel9 get{info['pascal']}UploadModel() {{",
        f"{indent}    if ({info['model_field']} == null) {{",
        f"{indent}        AttachHandler9 handler = new AttachHandler9() {{",
        f"{indent}            private static final long serialVersionUID = 1L;",
        "",
        f"{indent}            @Override",
        f"{indent}            public void afterSaveAttachToDB(Object attach) {{",
        f"{indent}            }}",
        "",
        f"{indent}            @Override",
        f"{indent}            public boolean beforeSaveAttachToDB(AttachStorage attachStorage) {{",
        f"{indent}                return true;",
        f"{indent}            }}",
        f"{indent}        }};",
        f"{indent}        {info['model_field']} = new FileUploadModel9(new DefaultFileUploadHandlerImpl9(",
        f"{indent}                getViewData(\"{info['field']}\"), null, null, handler,",
        f"{indent}                userSession.getUserGuid(), userSession.getDisplayName()));",
        f"{indent}    }}",
        f"{indent}    return {info['model_field']};",
        f"{indent}}}"
    ]


def _strip_attachment_blocks(template):
    """从 Action 模板中剥离附件相关代码：imports、字段声明、pageLoad 附件块和上传模型方法。"""
    lines = template.splitlines()
    result = []
    skip_block = 0
    for line in lines:
        stripped = line.strip()
        # 跳过附件相关 import
        if any(stripped.startswith(imp) for imp in (
            "import com.epoint.basic.faces.fileupload.",
            "import com.epoint.basic.faces.tree.DefaultFileUploadHandlerImpl9;",
            "import java.util.UUID;",
            "import com.epoint.core.utils.string.StringUtil;"
        )):
            continue
        # 跳过 FileUploadModel9 字段声明
        if re.search(r"\bprivate\s+FileUploadModel9\s+\w+;", stripped):
            continue
        # 跳过附件生命周期注释和 pageLoad 中的附件块
        if "附件生命周期" in stripped:
            skip_block = 1
            continue
        if skip_block > 0:
            if "{" in stripped and "}" not in stripped:
                skip_block += 1
            elif "}" in stripped and "{" not in stripped:
                skip_block -= 1
            continue
        # 跳过 getXxxUploadModel 方法块
        if re.search(r"\bpublic\s+FileUploadModel9\s+get\w+UploadModel\s*\(", stripped):
            skip_block = 1
            continue
        result.append(line)
    return "\n".join(result)


def _find_method_end(lines, start_index):
    balance = 0
    started = False
    for idx in range(start_index, len(lines)):
        balance += lines[idx].count("{") - lines[idx].count("}")
        if "{" in lines[idx]:
            started = True
        if started and balance <= 0:
            return idx
    return -1


def _find_class_end(lines):
    for idx in range(len(lines) - 1, -1, -1):
        if lines[idx].strip() == "}":
            return idx
    return -1


def _codeitem_factory_append_flag(section_key):
    normalized = str(section_key or "").strip().lower()
    if "list" in normalized or "列表" in normalized:
        return "true"
    return "false"


def _skip_braced_block(lines, start_index):
    balance = 0
    i = start_index
    started = False
    while i < len(lines):
        balance += lines[i].count("{") - lines[i].count("}")
        if "{" in lines[i]:
            started = True
        i += 1
        if started and balance <= 0:
            break
    return i


def _ensure_feature_bridge_imports(template, rule_content, bridge_key):
    """
    从当前版本桶规则的 AI Requirement Bridge Contract 附近提取 import 真值。

    不在生成器里写死 jar 包路径：不同 versionBucket 的规则模板可能使用不同
    DataUtil/SelectItem/CodeModalFactory 包名。维护点是规则文件自身：谁声明 code_item
    bridge，谁在规则模板/bridge 附近给出对应 import。生成器只负责把该版本桶规则里
    已存在的 import 补到当前 Action section。
    """
    imports = _extract_feature_bridge_imports(rule_content, bridge_key)
    if not imports:
        return template
    return _ensure_java_imports(template, imports)


def _extract_feature_bridge_imports(rule_content, bridge_key):
    text = str(rule_content or "")
    key = str(bridge_key or "").strip()
    if not text or not key:
        return []
    marker = re.search(r"(?m)^\s*" + re.escape(key) + r"\s*:\s*$", text)
    if not marker:
        return []

    imports = []
    seen = set()

    # 优先吃 bridge 显式 required_imports/imports（未来规则统一维护推荐写法）。
    after = text[marker.end():]
    next_bridge = re.search(r"(?m)^\s{2}[A-Za-z0-9_]+\s*:\s*$", after)
    bridge_block = after[:next_bridge.start()] if next_bridge else after
    explicit_block_match = re.search(r"(?m)^\s*(?:required_imports|imports)\s*:\s*$([\s\S]*?)(?=^\s*[A-Za-z0-9_]+\s*:|^\s{2}[A-Za-z0-9_]+\s*:|\Z)", bridge_block)
    if explicit_block_match:
        for match in re.finditer(r"import\s+[A-Za-z_][A-Za-z0-9_.]*(?:\.\*)?\s*;", explicit_block_match.group(1)):
            line = match.group(0).strip()
            if line not in seen:
                seen.add(line)
                imports.append(line)

    if imports:
        return imports

    # 兼容现有规则：bridge 没有显式 imports 时，从 bridge 之前所有 Java import 行中，
    # 选取 prompt/code_validate 提到的类名对应 import。这样仍由当前版本桶规则提供包名。
    before = text[:marker.start()]
    signals = set()
    bridge_text = bridge_block
    for token in re.findall(r"[A-Za-z_][A-Za-z0-9_]*", bridge_text):
        if token and token[:1].isupper():
            signals.add(token)
    if "DataUtil" in bridge_text:
        signals.add("DataUtil")
    if "CodeModalFactory" in bridge_text:
        signals.add("CodeModalFactory")
    if "SelectItem" in bridge_text:
        signals.add("SelectItem")
    if "List" in bridge_text or "getXxxModel" in bridge_text:
        signals.add("List")
    if "Map" in before and ("CodeModalFactory" in bridge_text or "DataUtil" in bridge_text):
        signals.add("Map")

    for match in re.finditer(r"(?m)^\s*import\s+([A-Za-z_][A-Za-z0-9_.]*(?:\.\*)?)\s*;", before):
        full_name = match.group(1).strip()
        simple_name = full_name.split(".")[-1]
        if simple_name in signals:
            line = "import " + full_name + ";"
            if line not in seen:
                seen.add(line)
                imports.append(line)
    return imports


def _ensure_java_imports(template, imports):
    wanted = [str(item or "").strip() for item in (imports or []) if str(item or "").strip().startswith("import ")]
    if not wanted:
        return template
    lines = template.splitlines()
    existing = set(line.strip() for line in lines if line.strip().startswith("import "))
    missing = [item for item in wanted if item not in existing]
    if not missing:
        return template

    insert_pos = -1
    last_import = -1
    package_pos = -1
    for idx, line in enumerate(lines):
        stripped = line.strip()
        if stripped.startswith("package ") and stripped.endswith(";"):
            package_pos = idx
        if stripped.startswith("import "):
            last_import = idx
    if last_import >= 0:
        insert_pos = last_import + 1
    elif package_pos >= 0:
        insert_pos = package_pos + 1
        if insert_pos < len(lines) and lines[insert_pos].strip() == "":
            insert_pos += 1
    else:
        insert_pos = 0

    lines[insert_pos:insert_pos] = missing
    return "\n".join(lines)


# ---- HtmlPage 字段自动展开 ----

def _post_fill_html_page(template, facts, substitutions, target_file, section_key=""):
    """
    HtmlPage 模板按 subType 给的是"1-2 个示例字段 + AI_TODO 占位"，Builder 要做的是：
      1) 删示例字段块
      2) 用 databaseColumns 按字段类型/名特征生成 N 个完整控件块
      3) 替换 {表中文名} 为 databaseTables[0].tableComment
      4) 代码项绑定只认字段级 codeItem 真值；没有 codeItem 的字段按普通控件渲染，不留代码项 TODO。
         F9 选择器等关联类型仍需后续按规则和 GWT 补齐。

    subType 由 targetFile 文件名后缀决定：
      gxh{pagename}list.html / add / edit / detail
    """
    if is_reuse_query_section("HtmlPage", section_key):
        return post_fill_reuse_query_html_page(template, facts)

    tables = facts.get("databaseTables") or []
    if not tables:
        return template
    primary_table = tables[0]
    table_comment = str(primary_table.get("tableComment") or "").strip()
    business_columns = primary_table.get("businessColumns") or []
    if not business_columns:
        return template

    # 替换 {表中文名}
    if table_comment:
        template = template.replace("{表中文名}", table_comment)

    # 推 subType
    sub_type = _detect_html_subtype_from_filename(target_file)
    if not sub_type:
        return template

    if sub_type == "add":
        if _has_page_composition(facts):
            return _expand_composed_html_page(template, facts, mode="add")
        return _expand_html_form_block(template, business_columns, mode="add")
    if sub_type == "edit":
        if _has_page_composition(facts):
            return _expand_composed_html_page(template, facts, mode="edit")
        return _expand_html_form_block(template, business_columns, mode="edit")
    if sub_type == "detail":
        if _has_page_composition(facts):
            template = _expand_composed_html_page(template, facts, mode="detail")
            return _ensure_detail_attachment_readonly_script(template, business_columns)
        template = _expand_html_form_block(template, business_columns, mode="detail")
        return _ensure_detail_attachment_readonly_script(template, business_columns)
    if sub_type == "workflow":
        return _expand_html_form_block(template, business_columns, mode="edit")
    if sub_type == "list":
        template = _rewrite_html_list_dialog_urls_from_target(template, target_file)
        template = _expand_html_list_filter_block(template, business_columns, facts.get("queryFilters") or [])
        return _expand_html_list_columns(template, business_columns)
    return template


def _has_page_composition(facts):
    composition = (facts or {}).get("pageComposition") or {}
    return isinstance(composition, dict) and bool(composition.get("blocks"))


def _expand_composed_html_page(template, facts, mode):
    composition = facts.get("pageComposition") or {}
    tables = facts.get("databaseTables") or []
    table_by_object = {
        str((table or {}).get("objectKey") or "").strip(): table
        for table in tables
        if str((table or {}).get("objectKey") or "").strip()
    }
    blocks = [block for block in composition.get("blocks") or [] if isinstance(block, dict)]
    if not blocks:
        return template
    attachment_fields_by_object = {}
    for block in blocks:
        if str(block.get("kind") or "").strip() != "attachment":
            continue
        object_key = str(block.get("objectKey") or "").strip()
        attachment_fields_by_object.setdefault(object_key, set()).update(
            str(ref or "").split(".")[-1]
            for ref in block.get("fieldRefs") or []
            if str(ref or "").strip()
        )

    content = ['<div class="fui-content">']
    use_accordion = str(composition.get("layout") or "").strip() == "accordion"
    sections = [section for section in composition.get("sections") or [] if isinstance(section, dict)]
    sectioned_form = use_accordion and bool(sections)
    if sectioned_form:
        content.append('    <div id="fui-form" class="fui-form">')
    if use_accordion:
        content.append('    <div class="fui-accordions">')
    for block_index, block in enumerate(blocks):
        object_key = str(block.get("objectKey") or "").strip()
        kind = str(block.get("kind") or "").strip()
        table = table_by_object.get(object_key) or (tables[0] if tables and kind == "form" else {})
        if not table:
            continue
        display_name = str(block.get("displayName") or table.get("tableComment") or object_key).strip()
        if sectioned_form and kind == "form":
            columns = table.get("businessColumns") or []
            for section_index, section in enumerate(sections):
                field_names = {
                    str(ref or "").split(".")[-1]
                    for ref in section.get("fieldRefs") or []
                    if str(ref or "").strip()
                }
                section_columns = [
                    column for column in columns
                    if str((column or {}).get("name") or "").strip() in field_names
                ]
                if not section_columns:
                    continue
                section_key = str(section.get("sectionKey") or f"section_{section_index + 1}").strip()
                section_title = str(section.get("title") or section_key).strip()
                section_id = _html_safe_id(object_key + "_" + section_key + "_section")
                section_lines = ['<div role="form">']
                section_lines.extend(_render_html_form_rows(section_columns, mode, "    "))
                section_lines.append('</div>')
                content.extend([
                    f'        <div role="accordion" opened="true" id="{section_id}">',
                    f'            <div role="head" title="{section_title}"></div>',
                    '            <div role="body">'
                ])
                content.extend('                ' + line if line else '' for line in section_lines)
                content.extend(['            </div>', '        </div>'])
            continue
        block_id = _html_safe_id(object_key + "_" + kind + "_block")
        body_lines = _render_composition_block(
            block, table, mode, block_index, attachment_fields_by_object.get(object_key, set())
        )
        if not body_lines:
            continue
        if use_accordion:
            content.extend([
                f'        <div role="accordion" opened="true" id="{block_id}">',
                f'            <div role="head" title="{display_name}"></div>',
                '            <div role="body">'
            ])
            content.extend('                ' + line if line else '' for line in body_lines)
            content.extend(['            </div>', '        </div>'])
        else:
            content.extend('    ' + line if line else '' for line in body_lines)
    if use_accordion:
        content.append('    </div>')
    if sectioned_form:
        content.append('    </div>')
    content.append('</div>')
    result = _replace_first_fui_content(template, content)
    editable_grids = [block for block in blocks if str(block.get("kind") or "") == "child_edit"]
    if mode in ("add", "edit") and editable_grids:
        result = _append_composition_grid_script(result, editable_grids)
    return result


def _render_composition_block(block, table, mode, block_index, attachment_fields=None):
    kind = str(block.get("kind") or "").strip()
    object_key = str(block.get("objectKey") or "").strip()
    columns = table.get("businessColumns") or []
    if kind == "form":
        hidden_fields = attachment_fields or set()
        form_columns = [col for col in columns if str(col.get("name") or "").strip() not in hidden_fields]
        form_id = "fui-form" if block_index == 0 else "fui-form-" + _html_safe_id(object_key)
        lines = [f'<div id="{form_id}" class="fui-form">', '    <div role="form">']
        lines.extend(_render_html_form_rows(form_columns, mode, "        "))
        lines.extend(['    </div>', '</div>'])
        return lines
    if kind in ("child_edit", "child_readonly"):
        editable = kind == "child_edit" and mode in ("add", "edit")
        return _render_composition_grid(object_key, columns, editable)
    if kind == "attachment":
        field_names = {
            str(ref or "").split(".")[-1]
            for ref in block.get("fieldRefs") or []
            if str(ref or "").strip()
        }
        attachment_columns = [col for col in columns if str(col.get("name") or "").strip() in field_names]
        lines = ['<div class="fui-form">', '    <div role="form">']
        lines.extend(_render_html_form_rows(attachment_columns, mode, "        "))
        lines.extend(['    </div>', '</div>'])
        return lines
    return []


def _render_composition_grid(object_key, columns, editable):
    grid_id = _html_safe_id(object_key) + "Grid"
    data_columns = [
        col for col in columns or []
        if not str((col or {}).get("relationRef") or "").strip()
        and not _is_attachment_column(col)
    ]
    attrs = [
        f'id="{grid_id}"',
        'class="mini-datagrid"',
        'idField="rowguid"',
        f'action="get{_to_pascal(object_key)}Data"',
        'showPager="false"',
        'style="height:260px;"'
    ]
    if editable:
        attrs.extend(['allowCellEdit="true"', 'allowCellSelect="true"', 'allowCellValid="true"', 'editNextOnEnterKey="true"'])
    lines = []
    if editable:
        lines.extend([
            '<div class="fui-toolbar">',
            f'    <a class="mini-button" onclick="add{_to_pascal(object_key)}Row">新增</a>',
            f'    <a class="mini-button" onclick="remove{_to_pascal(object_key)}Rows">删除</a>',
            '</div>'
        ])
    lines.extend([f'<div {" ".join(attrs)}>', '    <div property="columns">', '        <div type="indexcolumn" width="40">序</div>'])
    for col in data_columns:
        name = str(col.get("name") or "").strip()
        label = str(col.get("comment") or name).strip()
        if not name:
            continue
        if editable:
            editor = _render_grid_editor(col)
            lines.append(f'        <div field="{name}" headerAlign="center">{label}{editor}</div>')
        else:
            code_item = _get_code_item_name(col)
            code_attr = f' data-options="{{code:\'{code_item}\'}}"' if code_item else ''
            lines.append(f'        <div field="{name}" headerAlign="center"{code_attr}>{label}</div>')
    lines.extend(['    </div>', '</div>'])
    return lines


def _render_grid_editor(col):
    required = col.get("required") is True
    label = str(col.get("comment") or col.get("name") or "字段").strip()
    required_attr = f' required="true" requiredErrorText="{label}不能为空!"' if required else ''
    db_type = str(col.get("type") or "").strip().upper()
    code_item = _get_code_item_name(col)
    if code_item:
        return f'<input property="editor" class="mini-combobox" action="get{_to_pascal(col.get("name"))}Model" textField="text" valueField="id"{required_attr} />'
    if db_type in ("DATE", "DATETIME", "TIMESTAMP"):
        return f'<input property="editor" class="mini-datepicker" format="{_html_date_format(col)}"{required_attr} />'
    if db_type in ("INT", "INTEGER", "TINYINT", "SMALLINT", "BIGINT", "DECIMAL", "NUMERIC", "DOUBLE", "FLOAT"):
        return f'<input property="editor" class="mini-spinner" minValue="0"{required_attr} />'
    return f'<input property="editor" class="mini-textbox"{required_attr} />'


def _replace_first_fui_content(template, replacement_lines):
    lines = template.splitlines()
    start = next((idx for idx, line in enumerate(lines) if 'class="fui-content"' in line), -1)
    if start < 0:
        return template
    depth = 0
    end = -1
    for idx in range(start, len(lines)):
        depth += len(re.findall(r"<div\b", lines[idx], flags=re.IGNORECASE))
        depth -= len(re.findall(r"</div\s*>", lines[idx], flags=re.IGNORECASE))
        if depth == 0:
            end = idx
            break
    if end < start:
        return template
    return "\n".join(lines[:start] + replacement_lines + lines[end + 1:])


def _append_composition_grid_script(template, blocks):
    grids = []
    functions = []
    for block in blocks:
        object_key = str(block.get("objectKey") or "").strip()
        if not object_key:
            continue
        pascal = _to_pascal(object_key)
        grid_id = _html_safe_id(object_key) + "Grid"
        grids.append(grid_id)
        functions.extend([
            f'function add{pascal}Row() {{',
            f'    var grid = mini.get(\'{grid_id}\');',
            '    var row = { rowguid: \'\' };',
            '    grid.addRow(row, 0);',
            '    grid.beginEditRow(row);',
            '}',
            f'function remove{pascal}Rows() {{',
            f'    var grid = mini.get(\'{grid_id}\');',
            '    grid.removeRows(grid.getSelecteds());',
            '}'
        ])
    if not grids:
        return template
    helper = [
        'function validateCompositionGrids() {',
        f'    var grids = [{", ".join("mini.get(\'" + grid + "\')" for grid in grids)}];',
        '    for (var i = 0; i < grids.length; i++) {',
        '        var grid = grids[i];',
        '        if (grid && !grid.isValid()) return false;',
        '    }',
        '    return true;',
        '}',
        *functions,
        '// AI_TODO[CompositeSaveContract]: Coder按GP-05把各明细grid.getChanges()传给Action，并在Service中事务保存主从数据。'
    ]
    script_end = template.lower().rfind('</script>')
    if script_end < 0:
        return template
    result = template[:script_end].rstrip() + "\n" + "\n".join(helper) + "\n" + template[script_end:]
    result = re.sub(r"if\s*\(\s*epoint\.validate\(\)\s*\)", "if (epoint.validate() && validateCompositionGrids())", result)
    return result


def _html_safe_id(value):
    tokens = [token for token in re.split(r"[^A-Za-z0-9]+", str(value or "")) if token]
    if not tokens:
        return "block"
    return tokens[0].lower() + "".join(token[:1].upper() + token[1:] for token in tokens[1:])


def _detect_html_subtype_from_filename(target_file):
    """从 gxhplaceadd.html / gxhplacelist.html 等推 subType。"""
    name = os.path.basename(str(target_file or "")).lower()
    if not name.endswith(".html"):
        return ""
    base = name[:-5]  # 去 .html
    for sub in ("workflow", "mylist", "list", "add", "edit", "detail"):
        if base.endswith(sub):
            return "list" if sub == "mylist" else sub
    return ""


def _html_sibling_page_stems_from_target(target_file):
    """从当前 HtmlPage 物理文件名推导同目录 add/edit/detail 页面 stem。"""
    name = os.path.basename(str(target_file or ""))
    if not name.lower().endswith(".html"):
        return {}
    stem = name[:-5]
    match = re.search(r"(list)$", stem, flags=re.IGNORECASE)
    if not match:
        return {}
    prefix = stem[:match.start()]
    if not prefix:
        return {}
    list_suffix = match.group(1)
    def same_case(value):
        if list_suffix.isupper():
            return value.upper()
        if list_suffix[:1].isupper():
            return value[:1].upper() + value[1:]
        return value
    return {
        "add": prefix + same_case("add"),
        "edit": prefix + same_case("edit"),
        "detail": prefix + same_case("detail")
    }


def _rewrite_html_list_dialog_urls_from_target(template, target_file):
    """
    列表页 openAdd/openEdit/openDetail 的 URL 必须跟 HtmlPage 物理文件名同源。
    规则模板里的 ./{pagename}add 会在主替换阶段变成 ./placeadd，但导航契约
    可能实际生成 gxhplaceadd.html / xplaceadd.html 等带壳文件名。这里从当前
    list targetFile 反推兄弟页 stem，避免弹窗 404。
    """
    stems = _html_sibling_page_stems_from_target(target_file)
    if not stems:
        return template
    result = template
    for sub, stem in stems.items():
        result = re.sub(r"(\./)[A-Za-z0-9_\-]*" + sub + r"(?=(?:\?guid=)?['\"])",
                        r"\1" + stem,
                        result,
                        flags=re.IGNORECASE)
    return result


def _expand_html_form_block(template, business_columns, mode):
    """
    展开 add / edit / detail 三种 form 页面的字段块。

    模板结构形如：
      <div role="form"><div role="row">
          <div role="control" label="...">
              <input class="mini-textbox" bind="dataBean.{field_name}" .../>
          </div>
          <div role="control" label="...">
              <input class="mini-combobox" bind="dataBean.{codeItemField}" .../>
          </div>
      </div></div>

    策略：找 `<div role="form">` ... `</div></div>` 这一对外层 div，把内部的
    所有 `<div role="control">` 块**整体替换**为按 columns 生成的多行控件块。
    公司 EUI 表单通常一行 1-2 个 control；附件/长文本类控件独占一行，避免
    所有字段被挤进同一个 role="row" 造成页面横向堆叠。
    """
    lines = template.splitlines()
    # 定位 <div role="form"> 开头和对应结束
    form_start = -1
    for i, line in enumerate(lines):
        if 'role="form"' in line and form_start == -1:
            form_start = i
            break
    if form_start == -1:
        return template

    # 从 form_start 找 inner row 区域结束（</div></div> 在同一行）
    form_end = -1
    for i in range(form_start, len(lines)):
        if "</div></div>" in lines[i]:
            form_end = i
            break
    if form_end == -1:
        return template

    # 抽出 form 块前 / 后两半
    before = lines[:form_start]
    after = lines[form_end + 1:]

    # 拼新 form 块
    indent = "        "  # 与原模板缩进一致
    new_lines = []
    new_lines.append(indent + '<div role="form">')
    new_lines.extend(_render_html_form_rows(business_columns, mode, indent + "    "))
    new_lines.append(indent + "</div>")

    return "\n".join(before + new_lines + after)


def _render_html_form_rows(business_columns, mode, row_indent, controls_per_row=2):
    rows = []
    pending = []

    def flush_pending():
        nonlocal pending
        if not pending:
            return
        rows.append(row_indent + '<div role="row">')
        for item in pending:
            rows.extend(_render_html_control(item, mode, row_indent + "    "))
        rows.append(row_indent + '</div>')
        pending = []

    for col in business_columns or []:
        if not isinstance(col, dict) or not str(col.get("name") or "").strip():
            continue
        if _is_full_row_form_column(col, mode):
            flush_pending()
            rows.append(row_indent + '<div role="row">')
            rows.extend(_render_html_control(col, mode, row_indent + "    "))
            rows.append(row_indent + '</div>')
            continue
        pending.append(col)
        if len(pending) >= controls_per_row:
            flush_pending()
    flush_pending()
    return rows


def _is_full_row_form_column(col, mode=""):
    if _is_attachment_column(col):
        return True
    db_type = str((col or {}).get("type") or "").strip().upper()
    length = (col or {}).get("length")
    if db_type in ("TEXT", "CLOB", "NCLOB", "LONGTEXT", "MEDIUMTEXT", "BLOB"):
        return True
    try:
        if int(length) > 200:
            return True
    except Exception:
        pass
    name = str((col or {}).get("name") or "").strip().lower()
    comment = str((col or {}).get("comment") or "").strip()
    long_text_hints = ("备注", "说明", "内容", "须知", "标准", "介绍", "描述", "详情", "常见问题")
    if any(hint in comment for hint in long_text_hints):
        return True
    if any(token in name for token in ("remark", "memo", "content", "desc", "description", "detail", "faq")):
        return True
    return False


def _render_html_control(col, mode, indent):
    """
    按字段类型生成一个 `<div role="control">` 块。
    mode: 'add' / 'edit' / 'detail'
    """
    name = str(col.get("name") or "").strip()
    label = str(col.get("comment") or name).strip()
    code_item = _get_code_item_name(col)
    required = col.get("required") is True
    db_type = str(col.get("type") or "").strip().upper()
    length = col.get("length")
    out = []

    if mode == "detail":
        # 只读：公司页面常用 mini-outputtext 展示表单详情。
        if _is_attachment_column(col):
            action_name = _attachment_upload_action_name(col)
            out.append(indent + '<div role="control" label="' + _attachment_label(col, label) + '">')
            out.append(indent + '    <div id="' + name + '" class="mini-webuploader" action="' + action_name + '" fileNumLimit="1" showDefaultUI="true" auto="true" enabled="true"></div>')
            out.append(indent + '</div>')
        elif code_item:
            out.append(indent + '<div role="control" label="' + label + '">')
            out.append(indent + '    <div class="mini-outputtext" bind="dataBean.' + name + '" data-options="{code:\'' + code_item + '\'}"></div>')
            out.append(indent + '</div>')
        elif db_type in ("DATE", "DATETIME", "TIMESTAMP"):
            out.append(indent + '<div role="control" label="' + label + '">')
            out.append(indent + '    <div class="mini-outputtext" bind="dataBean.' + name + '" data-options="{format:\'' + _html_date_format(col) + '\'}"></div>')
            out.append(indent + '</div>')
        else:
            out.append(indent + '<div role="control" label="' + label + '">')
            out.append(indent + '    <div class="mini-outputtext" bind="dataBean.' + name + '"></div>')
            out.append(indent + '</div>')
        return out

    # add / edit：可输入
    starred = ' starred="true"' if required else ''
    required_attr = ' required="true" requiredErrorText="' + label + '不能为空!"' if required else ''

    # 附件稳定标识字段：渲染为 mini-webuploader，不渲染为普通文本框。
    if _is_attachment_column(col):
        action_name = _attachment_upload_action_name(col)
        required_upload = ' required="true"' if required else ''
        out.append(indent + '<div role="control" label="' + _attachment_label(col, label) + '"' + starred + '>')
        out.append(indent + '    <div id="' + name + '" class="mini-webuploader" action="' + action_name + '" fileNumLimit="1"')
        out.append(indent + '         fileSingleSizeLimit="20480" limitType="doc,docx,txt,rar,zip,jpg,jpeg,pdf,xls,xlsx,gif,bmp,png"')
        out.append(indent + '         mimeTypes="*" auto="true"' + required_upload + '></div>')
        out.append(indent + '</div>')
        return out

    # 是否字段：VARCHAR(1) + 名带 is/has
    if _looks_like_boolean_field(col):
        out.append(indent + '<div role="control" label="' + label + '"' + starred + '>')
        out.append(indent + '    <input class="mini-combobox" bind="dataBean.' + name + '" data="[{id:\'1\',text:\'是\'},{id:\'0\',text:\'否\'}]"' + required_attr + ' />')
        out.append(indent + '</div>')
        return out

    # 代码项字段：只有设计阶段 LLM 显式给 codeItem 中文名称时才生成字典控件。
    if code_item:
        out.append(indent + '<div role="control" label="' + label + '"' + starred + '>')
        out.append(indent + '    <input class="mini-combobox" bind="dataBean.' + name + '" action="get' + _to_pascal(name) + 'Model" textField="text" valueField="id" emptyText="请选择..."' + required_attr + ' />')
        out.append(indent + '</div>')
        return out

    # 日期：mini-datepicker
    if db_type in ("DATE", "DATETIME", "TIMESTAMP"):
        out.append(indent + '<div role="control" label="' + label + '"' + starred + '>')
        out.append(indent + '    <input class="mini-datepicker" bind="dataBean.' + name + '" format="' + _html_date_format(col) + '"' + required_attr + ' />')
        out.append(indent + '</div>')
        return out

    # 数值：mini-spinner
    if db_type in ("INT", "INTEGER", "TINYINT", "SMALLINT", "BIGINT"):
        out.append(indent + '<div role="control" label="' + label + '"' + starred + '>')
        out.append(indent + '    <input class="mini-spinner" bind="dataBean.' + name + '" minValue="0"' + required_attr + ' />')
        out.append(indent + '</div>')
        return out

    if db_type in ("DECIMAL", "NUMERIC", "DOUBLE", "FLOAT"):
        out.append(indent + '<div role="control" label="' + label + '"' + starred + '>')
        out.append(indent + '    <input class="mini-spinner" bind="dataBean.' + name + '" decimalPlaces="2"' + required_attr + ' />')
        out.append(indent + '</div>')
        return out

    # 默认：textbox
    out.append(indent + '<div role="control" label="' + label + '"' + starred + '>')
    out.append(indent + '    <input class="mini-textbox" bind="dataBean.' + name + '"' + required_attr + ' />')
    out.append(indent + '</div>')
    return out


def _html_date_format(col):
    db_type = str((col or {}).get("type") or "").strip().upper()
    if db_type == "DATE":
        return "yyyy-MM-dd"
    return "yyyy-MM-dd HH:mm:ss"


def _looks_like_boolean_field(col):
    """VARCHAR(1) + 名以 is/has 开头 / 含 isxxx 等 → 视作 yes/no 字段。"""
    name = str(col.get("name") or "").lower()
    db_type = str(col.get("type") or "").upper()
    length = col.get("length")
    if db_type in ("VARCHAR", "CHAR") and (length == 1 or length == "1"):
        return True
    if name.startswith("is") or name.startswith("has"):
        return True
    return False


def _get_code_item_name(col):
    """代码项是否成立只看设计阶段字段级 codeItem 真值，不按字段名猜。"""
    if not isinstance(col, dict):
        return ""
    value = col.get("codeItem")
    if isinstance(value, str):
        return value.strip()
    return ""


def _is_attachment_column(col):
    return isinstance(col, dict) and col.get("attachmentKey") is True and bool(str(col.get("name") or "").strip())


def _attachment_label(col, fallback="附件"):
    value = str((col or {}).get("attachmentLabel") or "").strip()
    return value or str(fallback or "附件").strip() or "附件"


def _attachment_upload_action_name(col):
    return "get" + _to_pascal(str((col or {}).get("name") or "").strip()) + "UploadModel"


def _attachment_info(col):
    field = str((col or {}).get("name") or "").strip()
    pascal = _to_pascal(field)
    camel = pascal[:1].lower() + pascal[1:] if pascal else field
    return {
        "field": field,
        "pascal": pascal,
        "camel": camel,
        "label": _attachment_label(col, field or "附件"),
        "model_field": camel + "UploadModel" if camel else "attachUploadModel"
    }


def _ensure_detail_attachment_readonly_script(template, business_columns):
    if not any(_is_attachment_column(col) for col in business_columns or []):
        return template
    if "mini-uploader-btns" in template and "mini-uploader-remove" in template:
        return template
    script = [
        "    // 详情页附件只读展示，禁止上传和删除。",
        "    $(function() {",
        "        $('.mini-uploader-btns').hide();",
        "        $('.mini-uploader-remove').hide();",
        "    });"
    ]
    lines = template.splitlines()
    for idx in range(len(lines) - 1, -1, -1):
        if lines[idx].strip() == "</script>":
            lines[idx:idx] = script
            return "\n".join(lines)
    return template


def _expand_html_list_columns(template, business_columns):
    """
    list 页：替换 datagrid 的 <div property="columns"> 区段为按 columns 生成的列定义。

    结构：
      <div property="columns">
          <div type="checkcolumn"...></div>
          <div type="indexcolumn"...></div>
          <!-- AI_TODO[{主要字段}]: ... -->
          <!-- AI_TODO[{代码项名},{代码项字段}]: ... -->
          <div field="operatedate"...>时间</div>
          <div ...renderer="onDetailRenderer">查看</div>
          <div ...renderer="onEditRenderer">编辑</div>
      </div>

    策略：保留 checkcolumn / indexcolumn / operatedate / 查看 / 编辑 这些固定列；
    把含 {主要字段}/{代码项名} 的 AI_TODO 行替换成按 columns 生成的字段列。
    """
    lines = template.splitlines()
    out_lines = []
    expanded = False
    for line in lines:
        if "{主要字段}" in line or "{代码项名}" in line or "{代码项字段}" in line or "代码项显示示例" in line:
            if not expanded:
                # 在第一个 {主要字段}/{代码项名} 占位行处展开所有业务列
                indent = "            "
                for col in business_columns:
                    if _is_attachment_column(col):
                        continue
                    name = str(col.get("name") or "").strip()
                    label = str(col.get("comment") or name).strip()
                    code_item = _get_code_item_name(col)
                    if not name:
                        continue
                    date_attr = ' dateFormat="yyyy-MM-dd HH:mm:ss"' if _is_date_column(col) else ""
                    if code_item:
                        out_lines.append(indent + '<div field="' + name + '" width="100" headerAlign="center" align="center" data-options="{code:\'' + code_item + '\'}">' + label + '</div>')
                    else:
                        out_lines.append(indent + '<div field="' + name + '" width="120" headerAlign="center" allowSort="true"' + date_attr + '>' + label + '</div>')
                expanded = True
            # 跳过原 AI_TODO 占位行
            continue
        out_lines.append(line)
    return "\n".join(out_lines)


def _expand_html_list_filter_block(template, business_columns, query_filters=None):
    """列表查询区：按公司默认两列布局生成关键字、代码项和日期范围查询控件。"""
    date_columns = _date_range_columns(business_columns)
    controls = _render_html_list_filter_controls(template, business_columns, query_filters)
    template = _replace_html_list_form_block(template, controls)
    return _ensure_html_list_date_draw_scripts(template, date_columns)


def _render_html_list_filter_controls(template, business_columns, query_filters=None):
    controls = []

    # 关联筛选不是主表字段：单独保留输入，具体查询由Coder沿已确认关系实现。
    for item in query_filters or []:
        if not isinstance(item, dict) or item.get("implementation") != "coder":
            continue
        bind = str(item.get("inputKey") or "").strip()
        label = str(item.get("objectKey") or "") + "." + str(item.get("fieldName") or "")
        controls.append([
            '    <div role="control" label="' + label + '">',
            '        <input class="mini-textbox" bind="' + bind + '" />',
            '    </div>'
        ])

    primary_col = None
    primary_name = _first_text_search_field_name(business_columns)
    if primary_name:
        for col in business_columns or []:
            if str((col or {}).get("name") or "").strip() == primary_name:
                primary_col = col
                break
    primary_filter = next((item for item in (query_filters or [])
                           if isinstance(item, dict)
                           and item.get("implementation") != "coder"
                           and str(item.get("fieldName") or "").strip() == primary_name), None)
    if primary_col and primary_filter:
        label = str(primary_col.get("comment") or primary_name).strip()
        bind = str(primary_filter.get("inputKey") or "").strip()
        controls.append([
            '    <div role="control" label="' + label + '">',
            '        <input class="mini-textbox" bind="' + bind + '" emptyText="请输入' + label + '..." />',
            '    </div>'
        ])

    code_col = _first_code_item_column(business_columns)
    if code_col:
        field_name = str(code_col.get("name") or "").strip()
        label = str(code_col.get("comment") or field_name).strip()
        pascal = _to_pascal(field_name)
        bind = field_name
        controls.append([
            '    <div role="control" label="' + label + '">',
            '        <input class="mini-combobox" bind="' + bind + '" action="get' + pascal + 'Model"',
            '               textField="text" valueField="id" emptyText="请选择..." />',
            '    </div>'
        ])

    for col in _date_range_columns(business_columns):
        field_name = str(col.get("name") or "").strip()
        label = str(col.get("comment") or field_name).strip()
        if not field_name:
            continue
        start_draw_func, end_draw_func = _date_range_draw_function_names(field_name)
        controls.append([
            '    <div role="control" label="' + label + '">',
            '        <div>',
            '            <input id="' + field_name + 'Start" class="mini-datepicker" width="120" ondrawdate="' + start_draw_func + '"',
            '                   allowInput="false" format="yyyy-MM-dd" showClose="true" autoClear="true" bind="' + field_name + 'Start" />',
            '            至',
            '            <input id="' + field_name + 'End" class="mini-datepicker" width="120" ondrawdate="' + end_draw_func + '"',
            '                   allowInput="false" format="yyyy-MM-dd" showClose="true" autoClear="true" bind="' + field_name + 'End" />',
            '        </div>',
            '    </div>'
        ])

    if not controls:
        controls.append([
            '    <div role="control" label="关键字">',
            '        <input class="mini-textbox" bind="searchKeyword" emptyText="请输入查询内容..." />',
            '    </div>'
        ])
    return controls


def _date_range_draw_function_names(field_name):
    safe_name = _safe_java_identifier(field_name)
    pascal = _to_pascal(safe_name) or "Date"
    return "on" + pascal + "StartDate", "on" + pascal + "EndDate"


def _ensure_html_list_date_draw_scripts(template, date_columns):
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


def _escape_js_string(value):
    return str(value or "").replace("\\", "\\\\").replace("'", "\\'")


def _replace_html_list_form_block(template, controls):
    lines = template.splitlines()
    form_start = -1
    for idx, line in enumerate(lines):
        if 'role="form"' in line:
            form_start = idx
            break
    if form_start < 0:
        return _replace_html_codeitem_filter_block(template, [])

    balance = 0
    form_end = -1
    for idx in range(form_start, len(lines)):
        balance += len(re.findall(r"<div\b", lines[idx]))
        balance -= len(re.findall(r"</div>", lines[idx]))
        if idx > form_start and balance <= 0:
            form_end = idx
            break
    if form_end < 0:
        return _replace_html_codeitem_filter_block(template, [])

    indent = lines[form_start][:len(lines[form_start]) - len(lines[form_start].lstrip())]
    form_tag = '<div id="cform" role="form">' if 'id="cform"' in lines[form_start] else '<div role="form">'
    new_lines = [indent + form_tag]
    new_lines.extend(_render_two_column_control_rows(controls, indent + "    "))
    new_lines.append(indent + "</div>")
    return "\n".join(lines[:form_start] + new_lines + lines[form_end + 1:])


def _render_two_column_control_rows(controls, row_indent):
    rows = []
    safe_controls = [control for control in (controls or []) if control]
    for idx in range(0, len(safe_controls), 2):
        pair = safe_controls[idx:idx + 2]
        rows.append(row_indent + '<div role="row">')
        for control in pair:
            for line in control:
                rows.append(row_indent + line)
        if len(pair) == 1:
            rows.append(row_indent + '    <div role="control"></div>')
        rows.append(row_indent + '</div>')
    return rows


def _replace_html_codeitem_filter_block(template, replacement_lines):
    lines = template.splitlines()
    out = []
    i = 0
    while i < len(lines):
        line = lines[i]
        if "{codeItemField}" in line or "{CodeItem}" in line or "代码项查询" in line:
            # 如果当前在 control 块内，从最近写入的 <div role="control"...> 开始替换整个块。
            start = len(out) - 1
            while start >= 0 and '<div role="control"' not in out[start]:
                start -= 1
            if start >= 0:
                out = out[:start]
            while i < len(lines):
                if "</div>" in lines[i]:
                    i += 1
                    break
                i += 1
            out.extend(replacement_lines)
            continue
        out.append(line)
        i += 1
    return "\n".join(out)


def _first_code_item_column(business_columns):
    for col in business_columns or []:
        if _get_code_item_name(col):
            return col
    return None


def _first_text_search_field_name(business_columns):
    for col in business_columns or []:
        if not _is_text_search_column(col):
            continue
        name = str(col.get("name") or "").strip()
        if name:
            return name
    return ""


def _first_primary_field_name(business_columns):
    for col in business_columns or []:
        name = str(col.get("name") or "").strip()
        if name and not _get_code_item_name(col):
            return name
    for col in business_columns or []:
        name = str(col.get("name") or "").strip()
        if name:
            return name
    return ""


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True)
    parser.add_argument("--strict", action="store_true", required=True,
                        help="Enable strict materialize mode for the design_tdd skeleton Builder")
    args = parser.parse_args()
    result = run_strict_materialize(args.input)
    print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    main()
