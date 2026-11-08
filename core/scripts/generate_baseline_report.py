#!/usr/bin/env python3
from __future__ import annotations

import argparse
import hashlib
import json
import re
import xml.etree.ElementTree as ET
from collections import Counter, defaultdict
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Dict, Iterable, List, Optional, Sequence, Set, Tuple

IGNORED_DIR_NAMES: Set[str] = {
    ".git", ".idea", ".settings", ".svn", "target", "bin", "node_modules", "dist", "out",
    "frame", "framemanager", "h5", "padh5", "widgets", ".ai-workspace", "_docs",
    ".knowledge", ".agents"
}

AI_WORKSPACE_DIR_NAME = ".ai-workspace"
AI_WORKSPACE_PROJECT_DIR_NAME = "project"
AI_WORKSPACE_KNOWLEDGE_DIR_NAME = "knowledge"


def ai_workspace_dir(root: Path) -> Path:
    return root / AI_WORKSPACE_DIR_NAME


def project_artifact_dir(root: Path) -> Path:
    return ai_workspace_dir(root) / AI_WORKSPACE_PROJECT_DIR_NAME


def api_rules_dir(root: Path) -> Path:
    return ai_workspace_dir(root) / AI_WORKSPACE_KNOWLEDGE_DIR_NAME / "api-rules"

DEFAULT_MAX_POM_FILES = 300
DEFAULT_MAX_JAVA_FILES = 2500
DEFAULT_MAX_HTML_FILES = 1200
MAX_SAMPLE_ITEMS = 3  # 压缩采样以节省 Token
MAX_MODULE_TREE_NODES = 60
RESOURCE_SUFFIXES = {".properties", ".xml", ".yml", ".yaml", ".json", ".conf"}
RESOURCE_REF_RE = re.compile(r"[\w./-]+\.(?:properties|xml|ya?ml|json|conf)", re.I)

VERSION_TOKEN_RE = re.compile(r"\$\{([^}]+)\}")
PACKAGE_RE = re.compile(r"^\s*package\s+([\w\.]+)\s*;", re.M)
SERVICE_INTERFACE_RE = re.compile(r"^I[A-Z].*Service$")

DB_KEYWORDS = {
    "mysql": "MySQL",
    "oracle": "Oracle",
    "sqlserver": "SQLServer",
    "sql server": "SQLServer",
    "dm": "达梦",
    "kingbase": "人大金仓",
    "postgresql": "PostgreSQL",
}

JAVA_COMMON_TYPE_NAMES = {
    "String", "Integer", "Long", "Short", "Byte", "Boolean", "Double", "Float", "BigDecimal",
    "Date", "LocalDate", "LocalDateTime", "Timestamp", "Object", "Map", "HashMap", "List",
    "ArrayList", "Set", "HashSet", "Collection", "Iterable", "Optional", "PageData", "PageInfo",
    "Paginator", "PageResult", "ResponseEntity", "Model", "HttpServletRequest", "HttpServletResponse",
    "MultipartFile", "InputStream", "OutputStream", "File", "Void", "Result", "BaseEntity"
}

GENERIC_METHOD_NAMES = {
    "insert", "update", "delete", "find", "findlist", "count", "list", "add", "edit", "detail",
    "save", "remove", "query", "get", "set", "sync", "paginatorlist", "page", "select"
}

GENERIC_TEXT_TOKENS = {
    "service", "services", "interface", "method", "methods", "api", "project", "module", "data",
    "page", "pages", "map", "list", "count", "find", "insert", "update", "delete", "detail",
    "save", "query", "info", "manager", "management", "object", "record", "result"
}

GENERIC_API_SUMMARY_PATTERNS: Sequence[Tuple[str, str]] = (
    (r"对应的后台\s*service接口", ""),
    (r"对应的后台\s*接口", ""),
    (r"后台\s*service接口", ""),
    (r"后台\s*service", ""),
    (r"后台\s*接口", ""),
    (r"\bservice接口\b", ""),
    (r"\bservice\b", ""),
    (r"\bapi接口\b", ""),
    (r"\bapi\b", ""),
    (r"接口$", ""),
    (r"服务$", ""),
)


@dataclass
class PomRecord:
    path: Path
    relative_path: str
    group_id: Optional[str]
    artifact_id: Optional[str]
    version: Optional[str]
    packaging: str
    parent_path: Optional[Path]
    parent_group_id: Optional[str]
    parent_artifact_id: Optional[str]
    parent_version: Optional[str]
    properties: Dict[str, str] = field(default_factory=dict)
    dependencies: List[Tuple[str, str, str]] = field(default_factory=list)
    modules: List[str] = field(default_factory=list)
    effective_group_id: Optional[str] = None
    effective_version: Optional[str] = None


@dataclass
class ModuleScan:
    module_dir: Path
    relative_dir: str
    artifact_id: str
    packaging: str
    parent_artifact: str
    dependency_artifacts: List[str] = field(default_factory=list)

    java_count: int = 0
    html_count: int = 0
    action_count: int = 0
    rest_count: int = 0
    service_api_count: int = 0
    service_impl_count: int = 0
    entity_count: int = 0
    job_count: int = 0

    package_counter: Counter = field(default_factory=Counter)
    action_pkg_counter: Counter = field(default_factory=Counter)
    rest_pkg_counter: Counter = field(default_factory=Counter)
    service_api_pkg_counter: Counter = field(default_factory=Counter)
    service_impl_pkg_counter: Counter = field(default_factory=Counter)
    entity_pkg_counter: Counter = field(default_factory=Counter)
    job_pkg_counter: Counter = field(default_factory=Counter)

    action_samples: List[str] = field(default_factory=list)
    rest_samples: List[str] = field(default_factory=list)
    service_samples: List[str] = field(default_factory=list)
    entity_samples: List[str] = field(default_factory=list)
    job_samples: List[str] = field(default_factory=list)
    rest_return_counter: Counter = field(default_factory=Counter)
    web_dirs: Set[str] = field(default_factory=set)
    has_java_root: bool = False
    has_web_root: bool = False


@dataclass
class EntityRecord:
    entity_name: str
    package_name: str
    module_name: str
    source_file: str
    table_name: str = ""
    summary: str = ""
    fields: List[Dict[str, str]] = field(default_factory=list)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="快速生成项目现状基线报告")
    parser.add_argument("--root", default=".", help="项目根目录")
    parser.add_argument("--output", default=None, help="输出文件路径")
    parser.add_argument("--max-pom-files", type=int, default=DEFAULT_MAX_POM_FILES, help="最大扫描 pom 文件数")
    parser.add_argument("--max-java-files", type=int, default=DEFAULT_MAX_JAVA_FILES, help="最大扫描 Java 文件数")
    parser.add_argument("--max-html-files", type=int, default=DEFAULT_MAX_HTML_FILES, help="最大扫描 HTML 文件数")
    parser.add_argument("--snapshot", action="store_true", help="仅输出 JSON 格式的物理路径快照")
    parser.add_argument("--api-catalog", action="store_true", help="初始化项目历史 API 索引与接口规则")
    parser.add_argument("--asset-index-lite", action="store_true", help="仅快速生成轻量项目 API 资产索引并早停")
    parser.add_argument("--all-in-one", action="store_true",
                        help="一次性跑完报告/快照/API 资产/业务图/实体图/REST 风格，复用 scan_poms 和 scan_modules，避免多次 walk。stdout 输出 snapshot JSON。")
    parser.add_argument("--business-graph", action="store_true", help="初始化项目业务关系图")
    parser.add_argument("--rest-style", action="store_true", help="仅快速勘测 REST return 风格并早停")
    parser.add_argument("--reuse-index", action="store_true",
                        help="仅生成 Coder 复用卡指路索引 code-reuse-index.json（Action 注入的 Service + 接口路径 + route 边），不存方法签名。finalize 后受控刷新用。stdout 输出 receipt JSON。")
    return parser.parse_args()


def safe_rel(path: Path, root: Path) -> str:
    try:
        rel = path.relative_to(root).as_posix()
        return rel if rel else "."
    except Exception:
        return path.as_posix()


def should_ignore(path: Path, root: Path) -> bool:
    try:
        parts = [p.lower() for p in path.relative_to(root).parts]
    except Exception:
        return False
    return any(p in IGNORED_DIR_NAMES for p in parts)


def iter_files(root: Path, pattern: str, limit: int) -> Iterable[Path]:
    seen = 0
    for file_path in root.rglob(pattern):
        if should_ignore(file_path, root):
            continue
        yield file_path
        seen += 1
        if seen >= max(1, limit):
            break


def find_files(root: Path, pattern: str, limit: int) -> List[str]:
    return [safe_rel(p, root) for p in iter_files(root, pattern, limit)]


def is_business_source_file(file_path: Path, root: Path) -> bool:
    """Only files under real project source roots can become project assets."""
    try:
        parts = tuple(part.lower() for part in file_path.resolve().relative_to(root.resolve()).parts)
    except Exception:
        return False
    if len(parts) < 4:
        return False
    for index in range(0, len(parts) - 2):
        if parts[index:index + 3] in (
            ("src", "main", "java"),
            ("src", "main", "webapp"),
            ("src", "main", "resources"),
        ):
            return True
    return False


def iter_business_source_files(
    root: Path,
    scans_map: Dict[Path, ModuleScan],
    source_parts: Sequence[str],
    pattern: str,
    limit: int,
) -> Iterable[Path]:
    """Yield files from Maven/business source roots only, never from project-root examples/tools."""
    seen_paths: Set[Path] = set()
    seen = 0
    normalized_parts = [str(item).strip() for item in source_parts if str(item).strip()]
    module_dirs = sorted(scans_map.keys(), key=lambda p: (safe_rel(p, root).count("/"), len(safe_rel(p, root))))
    for module_dir in module_dirs:
        source_root = module_dir.joinpath(*normalized_parts)
        if not source_root.exists() or not source_root.is_dir():
            continue
        for file_path in source_root.rglob(pattern):
            if should_ignore(file_path, root):
                continue
            resolved = file_path.resolve()
            if resolved in seen_paths:
                continue
            seen_paths.add(resolved)
            yield file_path
            seen += 1
            if seen >= max(1, limit):
                return


def iter_business_java_files(root: Path, scans_map: Dict[Path, ModuleScan], limit: int) -> Iterable[Path]:
    return iter_business_source_files(root, scans_map, ("src", "main", "java"), "*.java", limit)


def iter_business_html_files(root: Path, scans_map: Dict[Path, ModuleScan], limit: int) -> Iterable[Path]:
    return iter_business_source_files(root, scans_map, ("src", "main", "webapp"), "*.html", limit)


def parse_properties_text(text: str) -> Dict[str, str]:
    result: Dict[str, str] = {}
    for raw in str(text or "").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or line.startswith("!"):
            continue
        match = re.match(r"([^:=\s]+)\s*[:=]\s*(.*)$", line)
        if not match:
            continue
        result[match.group(1).strip()] = match.group(2).strip()
    return result


def read_properties_file(file_path: Path) -> Dict[str, str]:
    try:
        return parse_properties_text(file_path.read_text(encoding="utf-8", errors="ignore"))
    except Exception:
        return {}


def child_text(node: Optional[ET.Element], name: str) -> Optional[str]:
    if node is None:
        return None
    item = node.find(f"{{*}}{name}")
    if item is None or item.text is None:
        return None
    text = item.text.strip()
    return text if text else None


def parse_properties(node: Optional[ET.Element]) -> Dict[str, str]:
    result: Dict[str, str] = {}
    if node is None:
        return result
    for child in list(node):
        key = child.tag.rsplit("}", 1)[-1]
        val = (child.text or "").strip()
        if key and val:
            result[key] = val
    return result


def parse_dependencies(root_node: ET.Element) -> List[Tuple[str, str, str]]:
    result: List[Tuple[str, str, str]] = []
    deps = root_node.find("{*}dependencies")
    if deps is None:
        return result
    for dep in deps.findall("{*}dependency"):
        gid = child_text(dep, "groupId") or ""
        aid = child_text(dep, "artifactId") or ""
        ver = child_text(dep, "version") or ""
        if gid and aid:
            result.append((gid, aid, ver))
    return result


def parse_modules(root_node: ET.Element) -> List[str]:
    modules: List[str] = []
    modules_node = root_node.find("{*}modules")
    if modules_node is None:
        return modules
    for module_node in modules_node.findall("{*}module"):
        txt = (module_node.text or "").strip()
        if txt:
            modules.append(txt)
    return modules


def resolve_parent_path(pom_path: Path, parent_node: Optional[ET.Element]) -> Optional[Path]:
    if parent_node is None:
        return None
    rel = child_text(parent_node, "relativePath") or "../pom.xml"
    target = (pom_path.parent / rel).resolve()
    return target if target.exists() else None


def parse_pom(pom_path: Path, root: Path) -> Optional[PomRecord]:
    try:
        tree = ET.parse(pom_path)
        root_node = tree.getroot()
        parent = root_node.find("{*}parent")
        record = PomRecord(
            path=pom_path.resolve(),
            relative_path=safe_rel(pom_path, root),
            group_id=child_text(root_node, "groupId"),
            artifact_id=child_text(root_node, "artifactId"),
            version=child_text(root_node, "version"),
            packaging=child_text(root_node, "packaging") or "jar",
            parent_path=resolve_parent_path(pom_path, parent),
            parent_group_id=child_text(parent, "groupId"),
            parent_artifact_id=child_text(parent, "artifactId"),
            parent_version=child_text(parent, "version"),
            properties=parse_properties(root_node.find("{*}properties")),
            dependencies=parse_dependencies(root_node),
            modules=parse_modules(root_node),
        )
        return record if record.artifact_id else None
    except Exception:
        return None


def resolve_value(value: Optional[str], record: PomRecord, index: Dict[Path, PomRecord], seen: Optional[Set[str]] = None) -> Optional[str]:
    if not value:
        return value
    current = value
    seen = seen or set()

    while True:
        match = VERSION_TOKEN_RE.search(current)
        if not match:
            return current

        token = match.group(1)
        if token in seen:
            return current

        replacement: Optional[str] = None
        if token in record.properties:
            replacement = record.properties[token]
        elif token == "project.version":
            replacement = record.version or record.parent_version
        elif token == "project.groupId":
            replacement = record.group_id or record.parent_group_id
        elif token == "project.parent.version":
            replacement = record.parent_version
        elif token == "project.parent.groupId":
            replacement = record.parent_group_id

        if replacement is None and record.parent_path and record.parent_path in index:
            parent = index[record.parent_path]
            replacement = parent.properties.get(token)

        if replacement is None:
            return current

        replacement = resolve_value(replacement, record, index, seen | {token}) or replacement
        current = current.replace(match.group(0), replacement)


def scan_poms(root: Path, max_pom_files: int) -> List[PomRecord]:
    records: List[PomRecord] = []
    for pom_path in iter_files(root, "pom.xml", max_pom_files):
        parsed = parse_pom(pom_path, root)
        if parsed:
            records.append(parsed)

    index = {r.path: r for r in records}
    for rec in records:
        parent = index.get(rec.parent_path) if rec.parent_path else None
        rec.effective_group_id = rec.group_id or rec.parent_group_id or (parent.effective_group_id if parent else None)
        rec.effective_version = rec.version or rec.parent_version or (parent.effective_version if parent else None)

        rec.effective_group_id = resolve_value(rec.effective_group_id, rec, index)
        rec.effective_version = resolve_value(rec.effective_version, rec, index)

    return records


def choose_main_record(records: Sequence[PomRecord]) -> Optional[PomRecord]:
    if not records:
        return None
    wars = [r for r in records if (r.packaging or "").lower() == "war"]
    if wars:
        return sorted(wars, key=lambda x: (x.relative_path.count("/"), len(x.relative_path)))[0]

    web_like = [r for r in records if "web" in (r.artifact_id or "").lower()]
    if web_like:
        return sorted(web_like, key=lambda x: (x.relative_path.count("/"), len(x.relative_path)))[0]

    return sorted(records, key=lambda x: (x.relative_path.count("/"), len(x.relative_path)))[0]


def extract_jdk_version(main: Optional[PomRecord]) -> str:
    if not main:
        return "未识别"
    for key in ["java.version", "maven.compiler.source", "maven.compiler.target", "jdk.version"]:
        if key in main.properties:
            return main.properties[key]
    return "未识别"


def extract_spring_version(main: Optional[PomRecord]) -> str:
    if not main:
        return "未识别"
    for key, value in main.properties.items():
        key_low = key.lower()
        if "spring" in key_low and "version" in key_low:
            return value
    for gid, aid, ver in main.dependencies:
        if "spring" in gid.lower() or "spring" in aid.lower():
            return ver or "未显式声明"
    return "未识别"


def detect_db_types(root: Path) -> Tuple[str, List[str]]:
    found: List[str] = []

    jdbc_candidates = list(iter_files(root, "jdbc.properties", 120))
    for jdbc in jdbc_candidates:
        text = jdbc.read_text(encoding="utf-8", errors="ignore").lower()
        for kw, name in DB_KEYWORDS.items():
            if kw in text and name not in found:
                found.append(name)

    spring_candidates = list(iter_files(root, "appcontext*.xml", 240))
    for xml in spring_candidates:
        text = xml.read_text(encoding="utf-8", errors="ignore").lower()
        for kw, name in DB_KEYWORDS.items():
            if kw in text and name not in found:
                found.append(name)

    if not found:
        return "未识别", []
    return found[0], found[1:]


def collect_core_dependencies(main: Optional[PomRecord], records: Sequence[PomRecord]) -> List[Tuple[str, str]]:
    if not main:
        return []

    selected: Dict[str, str] = {}

    def add_item(key: str, value: str) -> None:
        if key in selected or not value or len(selected) >= 12:
            return
        selected[key] = value

    preferred = [
        "epoint-zwfwcorecode-version",
        "epoint-zwfw-version",
        "epoint-zwdt-version",
        "epoint-authenticator-version",
        "spring_version",
        "spring.version",
        "fastjson-version",
        "fastjson.version",
    ]
    for key in preferred:
        if key in main.properties:
            add_item(key, main.properties[key])

    for key, val in sorted(main.properties.items()):
        low = key.lower()
        if "version" in low and any(t in low for t in ["epoint", "spring", "fastjson", "mybatis", "jackson", "druid"]):
            add_item(key, val)

    for rec in records:
        for gid, aid, ver in rec.dependencies[:80]:
            if any(t in (gid + aid).lower() for t in ["epoint", "spring", "fastjson"]):
                add_item(f"{aid}-version", ver or "未显式声明")

    return list(selected.items())


def normalize_product_version(version: Optional[str]) -> Optional[str]:
    if not version:
        return version
    val = version.strip()
    if not val:
        return val
    if "${" in val:
        return val

    m = re.match(r"^(\d+(?:\.\d+){1,3})", val)
    if m:
        return m.group(1)

    if "-" in val:
        return val.split("-", 1)[0]
    return val


def get_resolved_property(record: PomRecord, key: str, index: Dict[Path, PomRecord]) -> Optional[str]:
    current: Optional[PomRecord] = record
    visited: Set[Path] = set()

    while current and current.path not in visited:
        visited.add(current.path)
        raw = current.properties.get(key)
        if raw:
            return resolve_value(raw, current, index)

        if not current.parent_path or current.parent_path not in index:
            break
        current = index[current.parent_path]

    return None


def infer_product_version(main: Optional[PomRecord], records: Sequence[PomRecord]) -> str:
    if not main:
        return "未识别"

    index = {r.path: r for r in records}
    artifact = (main.artifact_id or "").lower()

    keys: List[str] = []
    if "zwdt" in artifact:
        keys.extend(["epoint-zwdt-version", "epoint-zwdt.version", "zwdt-version"])
    if "zwfw" in artifact:
        keys.extend(["epoint-zwfw-version", "epoint-zwfw.version", "zwfw-version"])

    keys.extend([
        "epoint-zwdt-version",
        "epoint-zwfw-version",
        "project.version",
        "revision",
    ])

    seen_keys: Set[str] = set()
    for key in keys:
        if key in seen_keys:
            continue
        seen_keys.add(key)

        resolved = get_resolved_property(main, key, index)
        normalized = normalize_product_version(resolved)
        if normalized and "${" not in normalized:
            return normalized

    fallback = normalize_product_version(main.effective_version or main.version)
    return fallback or "未识别"


def add_sample(items: List[str], val: str, limit: int = MAX_SAMPLE_ITEMS) -> None:

    if val and val not in items and len(items) < limit:
        items.append(val)


def extract_package(java_text: str) -> str:
    m = PACKAGE_RE.search(java_text)
    return m.group(1).strip() if m else ""


def to_package_prefix(pkg: str) -> Optional[str]:
    if not pkg or not pkg.startswith("com.epoint"):
        return None
    parts = pkg.split(".")
    return ".".join(parts[:4]) if len(parts) >= 4 else pkg


def detect_java_kind(java_path: Path, pkg: str, text: str, rel: str) -> str:
    file_name = java_path.name
    stem = java_path.stem
    name_low = file_name.lower()
    pkg_low = pkg.lower() if pkg else ""
    rel_low = rel.lower()
    text_low = text.lower()

    if name_low.endswith("action.java") or ".action" in pkg_low:
        return "action"
    if "restcontroller" in name_low or name_low.endswith("controller.java") or ".rest" in pkg_low:
        return "rest"
    if name_low.endswith("serviceimpl.java") or (".impl" in pkg_low and "service" in name_low):
        return "service_impl"
    if SERVICE_INTERFACE_RE.match(stem):
        return "service_api"
    if "/api/entity/" in rel_low or ".api.entity" in pkg_low or "@entity" in text_low:
        return "entity"
    if name_low.endswith("job.java") or "/job/" in rel_low or ".job" in pkg_low:
        return "job"
    return ""


def detect_rest_return_patterns(text: str) -> List[str]:
    patterns: List[str] = []
    source = text or ""
    helper_pattern = re.compile(
        r"\breturn\s+([A-Z][A-Za-z0-9_]*(?:Utils?|Kit|Result|Response|Rest)?\."
        r"[A-Za-z0-9_]*(?:Return|Result|Success|Error|Ok|Fail|success|error|ok|fail))\s*\("
    )
    loose_return_pattern = re.compile(
        r"\b([A-Z][A-Za-z0-9_]*(?:Utils?|Kit|Result|Response|Rest)?\."
        r"[A-Za-z0-9_]*Return)\s*\("
    )
    for match in helper_pattern.finditer(source):
        patterns.append(match.group(1))
    for match in loose_return_pattern.finditer(source):
        patterns.append(match.group(1))
    if re.search(r"\bResponseEntity(?:\s*<[^>]+>)?\b", source):
        patterns.append("ResponseEntity")
    if re.search(r"\breturn\s+(?:new\s+)?Result(?:\.|\s*\()", source) or re.search(r"\bResult(?:\s*<[^>]+>)?\b", source):
        patterns.append("Result")
    if re.search(r"\breturn\s+(?:new\s+)?(?:HashMap|Map)\b", source) or re.search(r"\bMap\s*<", source):
        patterns.append("Map")
    return list(dict.fromkeys(patterns))


def is_primary_rest_helper_pattern(pattern: str) -> bool:
    text = normalize_whitespace(str(pattern or ""))
    if not text or text in {"Map", "Result", "ResponseEntity"}:
        return False
    return "." in text


def rank_rest_patterns(counter: Counter) -> List[Tuple[str, int]]:
    return sorted(
        counter.items(),
        key=lambda item: (
            0 if is_primary_rest_helper_pattern(item[0]) else 1,
            -int(item[1]),
            str(item[0]).lower(),
        ),
    )


def primary_rest_pattern(counter: Counter) -> str:
    ranked = rank_rest_patterns(counter)
    return ranked[0][0] if ranked else ""


def init_module_scans(root: Path, records: Sequence[PomRecord]) -> Dict[Path, ModuleScan]:
    scans: Dict[Path, ModuleScan] = {}
    by_pom = {r.path: r for r in records}

    for rec in records:
        module_dir = rec.path.parent.resolve()
        rel = safe_rel(module_dir, root)
        scans[module_dir] = ModuleScan(
            module_dir=module_dir,
            relative_dir=rel,
            artifact_id=rec.artifact_id or module_dir.name,
            packaging=rec.packaging,
            parent_artifact=(by_pom.get(rec.parent_path).artifact_id if rec.parent_path in by_pom else (rec.parent_artifact_id or "-")),
            dependency_artifacts=[aid for _, aid, _ in rec.dependencies if aid],
        )

    if not scans:
        scans[root] = ModuleScan(
            module_dir=root,
            relative_dir=".",
            artifact_id=root.name,
            packaging="jar",
            parent_artifact="-",
        )

    return scans


def scan_modules(
    root: Path,
    records: Sequence[PomRecord],
    max_java_files: int,
    max_html_files: int,
) -> Dict[Path, ModuleScan]:
    scans = init_module_scans(root, records)

    module_dirs = sorted(scans.keys(), key=lambda p: (safe_rel(p, root).count("/"), len(safe_rel(p, root))))

    total_java = 0
    total_html = 0

    for module_dir in module_dirs:
        scan = scans[module_dir]

        java_root = module_dir / "src" / "main" / "java"
        if java_root.exists() and java_root.is_dir():
            scan.has_java_root = True
        if java_root.exists() and java_root.is_dir() and total_java < max(1, max_java_files):
            for java_file in java_root.rglob("*.java"):
                if should_ignore(java_file, root):
                    continue
                if total_java >= max(1, max_java_files):
                    break

                total_java += 1
                scan.java_count += 1
                rel = safe_rel(java_file, root)
                text = java_file.read_text(encoding="utf-8", errors="ignore")[:5000]
                pkg = extract_package(text)

                prefix = to_package_prefix(pkg)
                if prefix:
                    scan.package_counter[prefix] += 1

                kind = detect_java_kind(java_file, pkg, text, rel)
                if kind == "action":
                    scan.action_count += 1
                    add_sample(scan.action_samples, rel)
                    if pkg:
                        scan.action_pkg_counter[pkg] += 1
                elif kind == "rest":
                    scan.rest_count += 1
                    add_sample(scan.rest_samples, rel)
                    for return_pattern in detect_rest_return_patterns(text):
                        scan.rest_return_counter[return_pattern] += 1
                    if pkg:
                        scan.rest_pkg_counter[pkg] += 1
                elif kind == "service_api":
                    scan.service_api_count += 1
                    add_sample(scan.service_samples, rel)
                    if pkg:
                        scan.service_api_pkg_counter[pkg] += 1
                elif kind == "service_impl":
                    scan.service_impl_count += 1
                    add_sample(scan.service_samples, rel)
                    if pkg:
                        scan.service_impl_pkg_counter[pkg] += 1
                elif kind == "entity":
                    scan.entity_count += 1
                    add_sample(scan.entity_samples, rel)
                    if pkg:
                        scan.entity_pkg_counter[pkg] += 1
                elif kind == "job":
                    scan.job_count += 1
                    add_sample(scan.job_samples, rel)
                    if pkg:
                        scan.job_pkg_counter[pkg] += 1

        web_root = module_dir / "src" / "main" / "webapp"
        if web_root.exists() and web_root.is_dir():
            scan.has_web_root = True
        if web_root.exists() and web_root.is_dir() and total_html < max(1, max_html_files):
            for html_file in web_root.rglob("*.html"):
                if should_ignore(html_file, root):
                    continue
                if total_html >= max(1, max_html_files):
                    break

                total_html += 1
                scan.html_count += 1
                add_sample_list = safe_rel(html_file.parent, root)
                scan.web_dirs.add(add_sample_list)

    return scans


def top_counter_key(counter: Counter) -> Optional[str]:
    if not counter:
        return None
    return counter.most_common(1)[0][0]


def normalize_base_package(pkg: Optional[str], kind: str) -> str:
    if not pkg:
        return "com.epoint.{domain}"

    base = pkg
    ordered_suffixes = {
        "action": [".action"],
        "rest": [".rest", ".controller"],
        "service_api": [".api", ".service"],
        "service_impl": [".impl", ".service"],
        "entity": [".api.entity", ".entity", ".model"],
        "job": [".job"],
    }

    for suffix in ordered_suffixes.get(kind, []):
        idx = base.find(suffix)
        if idx > 0:
            base = base[:idx]
            break

    if not base.startswith("com.epoint"):
        return "com.epoint.{domain}"
    return base


def infer_project_type(records: Sequence[PomRecord]) -> str:
    if len(records) <= 1:
        return "single-module"
    if any((record.packaging or "").lower() == "pom" for record in records):
        return "maven-multi-module"
    return "maven-multi-module"


def clamp_confidence(value: float) -> float:
    return max(0.0, min(1.0, value))


def build_module_kind_score(scan: ModuleScan, kind: str) -> int:
    artifact_low = (scan.artifact_id or "").lower()
    relative_low = (scan.relative_dir or "").lower()
    packaging_low = (scan.packaging or "").lower()
    dependency_low = " ".join(scan.dependency_artifacts or []).lower()
    identity_low = f"{artifact_low}/{relative_low}"
    java_weight = min(scan.java_count, 8)
    html_weight = min(scan.html_count, 8)

    def has_exact_role(role: str) -> bool:
        return bool(re.search(rf"(?:^|[-_/]){re.escape(role)}(?:$|[-_/])", identity_low))

    score = 0

    if kind == "action":
        score += scan.action_count * 10
        score += java_weight
        if scan.has_java_root:
            score += 2
        if "war" == packaging_low:
            score += 4
        if any(token in artifact_low for token in ["web", "action", "admin", "manage"]):
            score += 3
    elif kind == "rest":
        score += scan.rest_count * 10
        score += java_weight
        if scan.has_java_root:
            score += 2
        if has_exact_role("rest"):
            score += 5000
        elif "rest" in artifact_low:
            score += 18
        if "war" == packaging_low:
            score += 1
        if "impl" in dependency_low and "api" in dependency_low:
            score += 8
    elif kind == "service_api":
        score += scan.service_api_count * 10
        score += java_weight
        if scan.has_java_root:
            score += 2
        if has_exact_role("api"):
            score += 5000
        elif any(token in artifact_low for token in ["api", "service"]):
            score += 16
    elif kind == "service_impl":
        score += scan.service_impl_count * 10
        score += java_weight
        if scan.has_java_root:
            score += 2
        if has_exact_role("impl"):
            score += 5000
        elif any(token in artifact_low for token in ["impl", "service"]):
            score += 16
        if "api" in dependency_low:
            score += 6
    elif kind == "service":
        score += (scan.service_api_count + scan.service_impl_count) * 10
        score += java_weight
        if scan.has_java_root:
            score += 2
        if any(token in artifact_low for token in ["api", "impl", "service"]):
            score += 4
    elif kind == "entity":
        score += scan.entity_count * 10
        score += java_weight
        if scan.has_java_root:
            score += 2
        if has_exact_role("api"):
            score += 4000
        elif any(token in artifact_low for token in ["api", "domain", "entity", "model"]):
            score += 16
    elif kind == "job":
        score += scan.job_count * 10
        score += java_weight
        if scan.has_java_root:
            score += 2
        if has_exact_role("job"):
            score += 5000
        elif "job" in artifact_low:
            score += 18
        if "impl" in dependency_low and "api" in dependency_low:
            score += 8
    elif kind == "web":
        score += scan.html_count * 10
        score += html_weight
        if scan.has_web_root:
            score += 5
        if "war" == packaging_low:
            score += 4
        if any(token in artifact_low for token in ["web", "site", "portal"]):
            score += 3
    else:
        score += scan.java_count + scan.html_count

    return score


def rank_module_candidates(scans: Sequence[ModuleScan], kind: str) -> List[Dict[str, object]]:
    scored: List[Tuple[ModuleScan, int]] = []
    for scan in scans:
        score = build_module_kind_score(scan, kind)
        if score > 0:
            scored.append((scan, score))

    if not scored:
        return []

    scored.sort(key=lambda item: (item[1], item[0].java_count + item[0].html_count, item[0].relative_dir), reverse=True)
    top_score = scored[0][1]
    ranked: List[Dict[str, object]] = []
    for scan, score in scored[:3]:
        confidence = clamp_confidence(score / top_score) if top_score > 0 else 0.0
        ranked.append({
            "moduleId": scan.artifact_id,
            "modulePath": scan.relative_dir,
            "packaging": scan.packaging,
            "score": score,
            "confidence": round(confidence, 2)
        })
    return ranked


def choose_module(scans: Sequence[ModuleScan], kind: str) -> Optional[ModuleScan]:
    ranked = rank_module_candidates(scans, kind)
    if not ranked:
        return None
    top = ranked[0]
    for scan in scans:
        if scan.artifact_id == top["moduleId"] and scan.relative_dir == top["modulePath"]:
            return scan
    return None


def package_template_from_base(base_package: str) -> str:
    if not base_package or not base_package.startswith("com.epoint"):
        return "com.epoint.{domain}"
    parts = base_package.split(".")
    if len(parts) <= 3:
        return "com.epoint.{domain}"
    return ".".join(parts[:-1] + ["{domain}"])


def build_package_candidates(counter: Counter, kind: str) -> List[Dict[str, object]]:
    if not counter:
        return []

    items = counter.most_common(3)
    results: List[Dict[str, object]] = []
    top_count = items[0][1] if items else 0
    for pkg, count in items:
        base_package = normalize_base_package(pkg, kind)
        results.append({
            "observedPackage": pkg,
            "basePackage": base_package,
            "packageTemplate": package_template_from_base(base_package),
            "count": count,
            "confidence": round(clamp_confidence(count / top_count) if top_count > 0 else 0.0, 2),
            "recommended": count == top_count
        })
    return results


def build_web_dir_candidates(web_dirs: Set[str]) -> List[Dict[str, object]]:
    if not web_dirs:
        return []
    ordered = sorted(web_dirs, key=lambda x: (x.count("/"), len(x), x))
    top_dir = ordered[0]
    results: List[Dict[str, object]] = []
    for item in ordered[:3]:
        results.append({
            "relativeDir": item,
            "recommended": item == top_dir
        })
    return results


def build_module_summary(scan: ModuleScan) -> Dict[str, object]:
    return {
        "moduleId": scan.artifact_id,
        "modulePath": scan.relative_dir,
        "packaging": scan.packaging,
        "hasJavaRoot": scan.has_java_root,
        "hasWebRoot": scan.has_web_root,
        "kindCounts": {
            "action": scan.action_count,
            "rest": scan.rest_count,
            "serviceApi": scan.service_api_count,
            "serviceImpl": scan.service_impl_count,
            "entity": scan.entity_count,
            "job": scan.job_count,
            "html": scan.html_count
        }
    }


def package_to_path(pkg: str) -> str:
    return pkg.replace(".", "/")


def build_module_tree(records: Sequence[PomRecord], root: Path) -> List[str]:
    if not records:
        return ["(未识别到 pom 模块信息)"]

    by_path = {r.path: r for r in records}
    children: Dict[Path, List[PomRecord]] = defaultdict(list)

    for rec in records:
        if rec.parent_path and rec.parent_path in by_path:
            children[rec.parent_path].append(rec)

    for key in children:
        children[key] = sorted(children[key], key=lambda x: x.relative_path)

    roots = [r for r in records if not r.parent_path or r.parent_path not in by_path]
    roots = sorted(roots, key=lambda x: x.relative_path)

    lines: List[str] = []
    node_count = 0

    def label(rec: PomRecord) -> str:
        module_dir_rel = safe_rel(rec.path.parent, root)
        show_dir = "." if module_dir_rel == "." else module_dir_rel
        return f"{rec.artifact_id} [{rec.packaging}] ({show_dir})"

    def walk(rec: PomRecord, prefix: str, is_last: bool) -> None:
        nonlocal node_count
        if node_count >= MAX_MODULE_TREE_NODES:
            return
        branch = "└── " if prefix else ""
        if prefix:
            branch = "└── " if is_last else "├── "
        lines.append(f"{prefix}{branch}{label(rec)}")
        node_count += 1

        children_list = children.get(rec.path, [])
        if not children_list:
            return

        child_prefix = prefix + ("    " if is_last else "│   ") if prefix else ""
        if not prefix:
            child_prefix = ""

        for idx, child in enumerate(children_list):
            last = idx == len(children_list) - 1
            if prefix:
                walk(child, child_prefix, last)
            else:
                walk(child, "", last)

    if len(roots) == 1:
        root_rec = roots[0]
        lines.append(label(root_rec))
        node_count += 1
        first_children = children.get(root_rec.path, [])
        for idx, child in enumerate(first_children):
            walk(child, "", idx == len(first_children) - 1)
    else:
        for i, root_rec in enumerate(roots):
            if node_count >= MAX_MODULE_TREE_NODES:
                break
            lines.append(label(root_rec))
            node_count += 1
            first_children = children.get(root_rec.path, [])
            for idx, child in enumerate(first_children):
                walk(child, "", idx == len(first_children) - 1)
            if i != len(roots) - 1:
                lines.append("")

    if node_count >= MAX_MODULE_TREE_NODES:
        lines.append("...(模块过多，已截断展示)")

    return lines


def collect_package_examples(scans: Sequence[ModuleScan]) -> List[str]:
    package_counter: Counter = Counter()
    for s in scans:
        package_counter.update(s.package_counter)
    return [pkg for pkg, _ in package_counter.most_common(MAX_SAMPLE_ITEMS)]


def collect_web_dirs(scans: Sequence[ModuleScan]) -> List[str]:
    dirs: Set[str] = set()
    for s in scans:
        dirs.update(s.web_dirs)
    return sorted(dirs, key=lambda x: (x.count("/"), len(x)))[:MAX_SAMPLE_ITEMS]


def scan_persistence_artifacts(root: Path, max_java_files: int = 1800) -> Dict[str, object]:
    dao_samples: List[str] = []
    mapper_samples: List[str] = []
    repository_samples: List[str] = []
    entity_samples: List[str] = []
    records = scan_poms(root, DEFAULT_MAX_POM_FILES)
    scans_map = scan_modules(root, records, max_java_files, DEFAULT_MAX_HTML_FILES)

    for java_file in iter_business_java_files(root, scans_map, max_java_files):
        rel = safe_rel(java_file, root)
        low_name = java_file.name.lower()

        if low_name.endswith("dao.java"):
            add_sample(dao_samples, rel)
        if low_name.endswith("mapper.java"):
            add_sample(mapper_samples, rel)
        if low_name.endswith("repository.java"):
            add_sample(repository_samples, rel)

        text_head = java_file.read_text(encoding="utf-8", errors="ignore")[:3000].lower()
        if "@entity" in text_head or "/entity/" in rel.lower():
            add_sample(entity_samples, rel)

    xml_mapper_samples: List[str] = []
    for pattern in ["*Mapper.xml", "*mapper.xml", "*.hbm.xml"]:
        for xml_file in iter_files(root, pattern, 80):
            rel = safe_rel(xml_file, root)
            add_sample(xml_mapper_samples, rel)

    has_java_persistence = bool(dao_samples or mapper_samples or repository_samples or entity_samples)
    has_xml_mapper = bool(xml_mapper_samples)

    if has_xml_mapper and has_java_persistence:
        mode = "注解/接口 + XML 混合模式"
    elif has_xml_mapper:
        mode = "以 XML 映射为主"
    elif has_java_persistence:
        mode = "注解/接口方式（无固定 XML 映射要求）"
    else:
        mode = "未识别到明确持久层特征"

    return {
        "mode": mode,
        "dao": dao_samples,
        "mapper": mapper_samples,
        "repository": repository_samples,
        "entity": entity_samples,
        "xml_mapper": xml_mapper_samples[:MAX_SAMPLE_ITEMS],
    }


def find_first_file(root: Path, pattern: str) -> Optional[str]:
    for path in iter_files(root, pattern, 120):
        return safe_rel(path, root)
    return None



def format_quote(v: Optional[str]) -> str:
    return v if v else "-"


def find_project_page_path(root: Path, scans: Sequence[ModuleScan]) -> Optional[Dict[str, str]]:
    candidates: List[Tuple[int, Path, ModuleScan, str]] = []
    scan_by_dir = {scan.module_dir.resolve(): scan for scan in scans}
    for file_path in root.rglob("src/main/resources/epointframe.properties"):
        if should_ignore(file_path, root):
            continue
        props = read_properties_file(file_path)
        page_path = props.get("projectPagePath", "").strip().strip("/")
        if not page_path:
            continue
        module_dir = file_path.parent.parent.parent.parent
        scan = scan_by_dir.get(module_dir.resolve())
        if not scan:
            continue
        score = (100 if scan.has_web_root else 0) + scan.html_count
        candidates.append((score, file_path, scan, page_path))
    if not candidates:
        return None
    candidates.sort(key=lambda item: (-item[0], safe_rel(item[1], root)))
    _, file_path, scan, page_path = candidates[0]
    module_prefix = "" if scan.relative_dir == "." else f"{scan.relative_dir}/"
    return {
        "path": safe_rel(file_path, root),
        "value": page_path,
        "moduleId": scan.artifact_id,
        "modulePath": scan.relative_dir,
        "webRoot": f"{module_prefix}src/main/webapp/{page_path}/{{bizModule}}/"
    }


def collect_rest_style_contract(root: Path, scans: Sequence[ModuleScan]) -> Dict[str, object]:
    counter: Counter = Counter()
    evidence: Dict[str, List[str]] = defaultdict(list)
    rest_files: List[str] = []
    for scan in scans:
        for pattern, count in scan.rest_return_counter.items():
            counter[pattern] += count
        for sample in scan.rest_samples:
            rest_files.append(sample)
            try:
                text = (root / sample).read_text(encoding="utf-8", errors="ignore")[:8000]
            except Exception:
                text = ""
            for pattern in detect_rest_return_patterns(text):
                if sample not in evidence[pattern]:
                    evidence[pattern].append(sample)
    ranked_patterns = rank_rest_patterns(counter)
    status = "detected" if counter else "unknown"
    primary = ranked_patterns[0][0] if ranked_patterns else ""
    primary_evidence = (evidence.get(primary, []) if primary else rest_files)[:3]
    return {
        "generatedAt": datetime.now().isoformat(timespec="seconds"),
        "projectPath": str(root),
        "status": status,
        "primaryReturnPattern": primary,
        "returnHelper": build_rest_return_helper(root, primary, primary_evidence) if primary else None,
        "returnPatterns": [
            {
                "pattern": pattern,
                "count": count,
                "evidenceFiles": evidence.get(pattern, [])[:3],
                "returnHelper": build_rest_return_helper(root, pattern, evidence.get(pattern, [])[:3]),
            }
            for pattern, count in ranked_patterns
        ],
        "evidenceFiles": primary_evidence,
        "policy": {
            "detected": "已识别项目 REST 返回封装；生成 REST 代码必须使用 primaryReturnPattern。",
            "unknown": "未识别项目 REST 返回封装；停止生成 REST 代码，先补齐 rest-interface-style.contract。"
        }
    }


def write_rest_style_contract(root: Path, contract: Dict[str, object]) -> str:
    structure_dir = project_artifact_dir(root)
    structure_dir.mkdir(parents=True, exist_ok=True)
    target = structure_dir / "rest-interface-style.contract.json"
    target.write_text(json.dumps(contract, indent=2, ensure_ascii=False), encoding="utf-8")
    return str(target)


def is_rest_controller_candidate(file_path: Path, text: str) -> bool:
    low_name = file_path.name.lower()
    if "controller" in low_name or "rest" in low_name:
        return True
    return bool(re.search(r"@RestController|@ResponseBody|@RequestMapping\s*\(", text or ""))


def parse_rest_return_helper_pattern(pattern: str) -> Optional[Dict[str, str]]:
    text = str(pattern or "").strip()
    if not text or text in {"Map", "Result", "ResponseEntity"} or "." not in text:
        return None
    class_name, method_name = text.split(".", 1)
    class_name = class_name.strip()
    method_name = method_name.strip()
    if not class_name or not method_name:
        return None
    return {"className": class_name, "methodName": method_name}


def find_import_for_simple_class_in_java(root: Path, rel_path: str, simple_class: str) -> str:
    rel = str(rel_path or "").strip()
    class_name = str(simple_class or "").strip()
    if not rel or not class_name:
        return ""
    source = Path(rel) if Path(rel).is_absolute() else root / rel
    try:
        text = source.read_text(encoding="utf-8", errors="ignore")
    except Exception:
        return ""
    import_re = re.compile(
        rf"^\s*import\s+([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*\.{re.escape(class_name)})\s*;\s*$",
        re.M,
    )
    match = import_re.search(text)
    return match.group(1).strip() if match else ""


def build_rest_return_helper(root: Path, pattern: str, evidence_files: Sequence[str]) -> Optional[Dict[str, str]]:
    parsed = parse_rest_return_helper_pattern(pattern)
    if not parsed:
        return None
    import_name = ""
    source_file = ""
    for rel_path in evidence_files or []:
        import_name = find_import_for_simple_class_in_java(root, rel_path, parsed["className"])
        if import_name:
            source_file = str(rel_path or "").strip()
            break
    return {
        **parsed,
        "importName": import_name,
        "sourceFile": source_file,
    }


def read_rest_scan_text(file_path: Path, max_full_chars: int = 600000, context_lines: int = 10) -> str:
    try:
        text = file_path.read_text(encoding="utf-8", errors="ignore")
    except Exception:
        return ""
    if len(text) <= max_full_chars:
        return text

    lines = text.splitlines()
    selected: Set[int] = set()
    marker_re = re.compile(
        r"@(?:RestController|ResponseBody|RequestMapping|GetMapping|PostMapping|PutMapping|DeleteMapping|PatchMapping)\b|\breturn\b",
        re.I,
    )
    for idx, line in enumerate(lines):
        if not marker_re.search(line):
            continue
        start = max(0, idx - context_lines)
        end = min(len(lines), idx + context_lines + 1)
        selected.update(range(start, end))
    if not selected:
        return text[:max_full_chars]
    return "\n".join(lines[idx] for idx in sorted(selected))


def collect_rest_style_contract_fast(
    root: Path,
    max_java_files: int = 1200,
    min_primary_hits: int = 3,
    max_evidence_files: int = 6,
) -> Dict[str, object]:
    counter: Counter = Counter()
    evidence: Dict[str, List[str]] = defaultdict(list)
    scanned_java_files = 0
    scanned_controller_files = 0
    stopped_early = False
    records = scan_poms(root, DEFAULT_MAX_POM_FILES)
    scans_map = scan_modules(root, records, max_java_files, DEFAULT_MAX_HTML_FILES)

    def enough() -> bool:
        if not counter:
            return False
        primary = primary_rest_pattern(counter)
        count = counter.get(primary, 0)
        return count >= min_primary_hits and len(evidence.get(primary, [])) >= min(2, max_evidence_files)

    for java_file in iter_business_java_files(root, scans_map, max_java_files):
        scanned_java_files += 1
        text = read_rest_scan_text(java_file)
        if not is_rest_controller_candidate(java_file, text):
            continue
        scanned_controller_files += 1
        rel = safe_rel(java_file, root)
        for pattern in detect_rest_return_patterns(text):
            counter[pattern] += 1
            if rel not in evidence[pattern] and len(evidence[pattern]) < max_evidence_files:
                evidence[pattern].append(rel)
        if enough():
            stopped_early = True
            break

    ranked_patterns = rank_rest_patterns(counter)
    status = "detected" if counter else "unknown"
    primary = ranked_patterns[0][0] if ranked_patterns else ""
    primary_evidence = (evidence.get(primary, []) if primary else [])[:3]
    return {
        "generatedAt": datetime.now().isoformat(timespec="seconds"),
        "projectPath": str(root),
        "status": status,
        "primaryReturnPattern": primary,
        "returnHelper": build_rest_return_helper(root, primary, primary_evidence) if primary else None,
        "returnPatterns": [
            {
                "pattern": pattern,
                "count": count,
                "evidenceFiles": evidence.get(pattern, [])[:3],
                "returnHelper": build_rest_return_helper(root, pattern, evidence.get(pattern, [])[:3]),
            }
            for pattern, count in ranked_patterns
        ],
        "evidenceFiles": primary_evidence,
        "policy": {
            "detected": "已识别项目 REST 返回封装；生成 REST 代码必须使用 primaryReturnPattern。",
            "unknown": "未识别项目 REST 返回封装；停止生成 REST 代码，先补齐 rest-interface-style.contract。",
        },
        "diagnostics": {
            "source": "python-fast-rest-style-scan",
            "scannedJavaFiles": scanned_java_files,
            "scannedControllerFiles": scanned_controller_files,
            "stoppedEarly": stopped_early,
        },
    }


def classify_resource_file(root: Path, file_path: Path) -> Optional[Dict[str, str]]:
    rel = safe_rel(file_path, root)
    name = file_path.name.lower()
    props = read_properties_file(file_path) if file_path.suffix.lower() == ".properties" else {}
    keys = {key.lower() for key in props.keys()}
    if name == "epointframe.properties" and "projectpagepath" in keys:
        return {
            "path": rel,
            "purpose": "框架核心配置；提供页面根路径 projectPagePath",
            "evidence": "key 命中 projectPagePath",
            "confidence": "high"
        }
    if name == "jdbc.properties" or {"url", "username", "password"} & keys:
        return {
            "path": rel,
            "purpose": "数据库连接配置",
            "evidence": "文件名/key 命中 jdbc/url/username/password",
            "confidence": "high"
        }
    if name == "authen.properties" or any(token in key for key in keys for token in ["sfb", "alipay", "weixin", "appid", "app_id"]):
        return {
            "path": rel,
            "purpose": "认证/第三方登录配置",
            "evidence": "文件名或 key 命中认证/第三方登录特征",
            "confidence": "medium"
        }
    if name == "datasyncjdbc.properties":
        return {
            "path": rel,
            "purpose": "第三方数据同步/接口配置",
            "evidence": "文件名命中 datasyncjdbc",
            "confidence": "medium"
        }
    return None


def collect_key_resource_summaries(root: Path, limit: int = 8) -> List[Dict[str, str]]:
    results: List[Dict[str, str]] = []
    seen: Set[str] = set()
    for file_path in root.rglob("src/main/resources/*"):
        if should_ignore(file_path, root) or not file_path.is_file():
            continue
        if file_path.suffix.lower() not in RESOURCE_SUFFIXES:
            continue
        item = classify_resource_file(root, file_path)
        if not item:
            continue
        if item["path"] in seen:
            continue
        seen.add(item["path"])
        results.append(item)
        if len(results) >= limit:
            break
    return results


def build_class_placement(scans: Sequence[ModuleScan], root: Path) -> Tuple[List[str], Dict[str, str], Dict[str, str]]:
    if not scans:
        return ["- 暂未识别到可用于落点推断的模块"], {}, {}

    action_mod = choose_module(scans, "action")
    rest_mod = choose_module(scans, "rest")
    service_api_mod = choose_module(scans, "service_api") or choose_module(scans, "service")
    service_impl_mod = choose_module(scans, "service_impl") or choose_module(scans, "service")
    entity_mod = choose_module(scans, "entity") or service_api_mod or service_impl_mod
    job_mod = choose_module(scans, "job")
    web_mod = choose_module(scans, "web")

    def module_root_prefix(mod: Optional[ModuleScan]) -> str:
        if mod is None:
            return ""
        return "" if mod.relative_dir == "." else f"{mod.relative_dir}/"

    def best_pkg(mod: Optional[ModuleScan], kind: str) -> str:
        if mod is None:
            return "com.epoint.{domain}"
        if kind == "action":
            return package_template_from_base(normalize_base_package(top_counter_key(mod.action_pkg_counter) or top_counter_key(mod.package_counter), "action"))
        if kind == "rest":
            return package_template_from_base(normalize_base_package(top_counter_key(mod.rest_pkg_counter) or top_counter_key(mod.package_counter), "rest"))
        if kind == "service_api":
            return package_template_from_base(normalize_base_package(top_counter_key(mod.service_api_pkg_counter) or top_counter_key(mod.package_counter), "service_api"))
        if kind == "service_impl":
            return package_template_from_base(normalize_base_package(top_counter_key(mod.service_impl_pkg_counter) or top_counter_key(mod.package_counter), "service_impl"))
        if kind == "entity":
            return package_template_from_base(normalize_base_package(top_counter_key(mod.entity_pkg_counter) or top_counter_key(mod.package_counter), "entity"))
        if kind == "job":
            return package_template_from_base(normalize_base_package(top_counter_key(mod.job_pkg_counter) or top_counter_key(mod.package_counter), "job"))
        return "com.epoint.{domain}"

    action_base = best_pkg(action_mod, "action")
    rest_base = best_pkg(rest_mod, "rest")
    service_api_base = best_pkg(service_api_mod, "service_api")
    service_impl_base = best_pkg(service_impl_mod, "service_impl")
    entity_base = best_pkg(entity_mod, "entity")
    job_base = best_pkg(job_mod, "job")

    action_path = f"{module_root_prefix(action_mod)}src/main/java/{package_to_path(action_base)}/action/"
    rest_path = f"{module_root_prefix(rest_mod)}src/main/java/{package_to_path(rest_base)}/rest/"
    service_api_path = f"{module_root_prefix(service_api_mod)}src/main/java/{package_to_path(service_api_base)}/api/"
    service_impl_path = f"{module_root_prefix(service_impl_mod)}src/main/java/{package_to_path(service_impl_base)}/impl/"
    entity_path = f"{module_root_prefix(entity_mod)}src/main/java/{package_to_path(entity_base)}/api/entity/"
    job_path = f"{module_root_prefix(job_mod)}src/main/java/{package_to_path(job_base)}/job/"

    diagnostics: Dict[str, str] = {}
    project_page_path = find_project_page_path(root, scans)
    web_path = "src/main/webapp/{domain}/{bizModule}/"
    if project_page_path:
        web_path = project_page_path["webRoot"]
        diagnostics["webPathSource"] = "epointframe.properties:projectPagePath"
        diagnostics["projectPagePath"] = project_page_path["value"]
        diagnostics["projectPagePathFile"] = project_page_path["path"]
        if project_page_path.get("moduleId"):
            diagnostics["projectPagePathModule"] = project_page_path["moduleId"]
    elif web_mod is not None:
        if web_mod.web_dirs:
            web_path = sorted(web_mod.web_dirs, key=lambda x: (x.count("/"), len(x)))[0] + "/"
        else:
            web_path = f"{module_root_prefix(web_mod)}src/main/webapp/{{domain}}/{{bizModule}}/"

    lines = [
        f"- **Action 类**：优先放在 `{action_path}`（模块 `{action_mod.artifact_id if action_mod else '-'}`）",
        f"- **REST 类**：优先放在 `{rest_path}`（模块 `{rest_mod.artifact_id if rest_mod else '-'}`）",
        f"- **Service 接口**：优先放在 `{service_api_path}`（模块 `{service_api_mod.artifact_id if service_api_mod else '-'}`）",
        f"- **Service 实现**：优先放在 `{service_impl_path}`（模块 `{service_impl_mod.artifact_id if service_impl_mod else '-'}`）",
        f"- **Entity 类**：优先放在 `{entity_path}`（模块 `{entity_mod.artifact_id if entity_mod else '-'}`）",
        f"- **Job 类**：优先放在 `{job_path}`（模块 `{job_mod.artifact_id if job_mod else '-'}`）",
        f"- **前端页面**：优先放在 `{web_path}`（模块 `{web_mod.artifact_id if web_mod else '-'}`）",
    ]

    paths = {
        "action": action_path,
        "rest": rest_path,
        "service_api": service_api_path,
        "service_impl": service_impl_path,
        "entity": entity_path,
        "job": job_path,
        "web": web_path,
    }
    return lines, paths, diagnostics


def build_ownership_rules(scans: Sequence[ModuleScan]) -> List[Dict[str, object]]:
    rules: List[Dict[str, object]] = []
    for file_kind, score_kind in [
        ("Action", "action"),
        ("Rest", "rest"),
        ("ServiceApi", "service_api"),
        ("ServiceImpl", "service_impl"),
        ("Entity", "entity"),
        ("Job", "job"),
        ("HtmlPage", "web")
    ]:
        candidates = rank_module_candidates(scans, score_kind)
        if not candidates:
            continue
        rules.append({
            "fileKind": file_kind,
            "candidateModules": candidates,
            "recommendedModule": candidates[0]["moduleId"],
            "confidence": candidates[0]["confidence"]
        })
    return rules


def build_placement_candidates(scans: Sequence[ModuleScan]) -> List[Dict[str, object]]:
    results: List[Dict[str, object]] = []
    kind_map = [
        ("Action", "action", "packageCandidates", "action_pkg_counter", "action_samples"),
        ("Rest", "rest", "packageCandidates", "rest_pkg_counter", "rest_samples"),
        ("ServiceApi", "service_api", "packageCandidates", "service_api_pkg_counter", "service_samples"),
        ("ServiceImpl", "service_impl", "packageCandidates", "service_impl_pkg_counter", "service_samples"),
        ("Entity", "entity", "packageCandidates", "entity_pkg_counter", "entity_samples"),
        ("Job", "job", "packageCandidates", "job_pkg_counter", "job_samples"),
        ("HtmlPage", "web", "webDirCandidates", "web_dirs", None)
    ]

    for file_kind, score_kind, candidate_key, counter_attr, sample_attr in kind_map:
        ranked = rank_module_candidates(scans, score_kind)
        if not ranked:
            continue
        recommended_module_id = ranked[0]["moduleId"]
        for candidate in ranked:
            scan = next((item for item in scans if item.artifact_id == candidate["moduleId"] and item.relative_dir == candidate["modulePath"]), None)
            if scan is None:
                continue
            payload: Dict[str, object] = {
                "fileKind": file_kind,
                "moduleId": scan.artifact_id,
                "modulePath": scan.relative_dir,
                "score": candidate["score"],
                "confidence": candidate["confidence"],
                "recommended": scan.artifact_id == recommended_module_id
            }
            if candidate_key == "packageCandidates":
                payload[candidate_key] = build_package_candidates(getattr(scan, counter_attr), score_kind)
                payload["samples"] = list(getattr(scan, sample_attr))[:MAX_SAMPLE_ITEMS] if sample_attr else []
            else:
                payload[candidate_key] = build_web_dir_candidates(scan.web_dirs)
                payload["samples"] = sorted(scan.web_dirs)[:MAX_SAMPLE_ITEMS]
            results.append(payload)
    return results


def build_placement_contract_draft(placement_paths: Dict[str, str], ownership_rules: Sequence[Dict[str, object]]) -> Dict[str, object]:
    kind_map = {
        "Action": "action",
        "Rest": "rest",
        "ServiceApi": "service_api",
        "ServiceImpl": "service_impl",
        "Entity": "entity",
        "Job": "job",
        "HtmlPage": "web"
    }
    ownership_map = {str(item.get("fileKind")): item for item in ownership_rules}
    rules: List[Dict[str, object]] = []
    for file_kind, path_key in kind_map.items():
        placement_path = placement_paths.get(path_key)
        if not placement_path:
            continue
        ownership = ownership_map.get(file_kind, {})
        rules.append({
            "fileKind": file_kind,
            "recommendedModule": ownership.get("recommendedModule", ""),
            "relativeDirPattern": placement_path
        })
    return {"rules": rules}


def build_snapshot_warnings(scans: Sequence[ModuleScan], ownership_rules: Sequence[Dict[str, object]], placement_candidates: Sequence[Dict[str, object]], placement_paths: Dict[str, str]) -> List[str]:
    warnings: List[str] = []
    ownership_map = {str(item.get("fileKind")): item for item in ownership_rules}
    rest_rule = ownership_map.get("Rest")
    if rest_rule:
        candidates = rest_rule.get("candidateModules", []) or []
        if len(candidates) >= 2:
            top = candidates[0]
            second = candidates[1]
            if float(second.get("confidence", 0.0)) >= 0.4:
                warnings.append("REST 模块归属不稳定：存在多个高相似候选模块，设计阶段需人工确认归属。")

    service_api_rule = ownership_map.get("ServiceApi")
    service_impl_rule = ownership_map.get("ServiceImpl")
    if service_api_rule and service_impl_rule and service_api_rule.get("recommendedModule") != service_impl_rule.get("recommendedModule"):
        warnings.append("Service API / Impl 分散在不同模块：不要直接把历史业务包当成统一模板。")

    for item in placement_candidates:
        package_candidates = item.get("packageCandidates", [])
        if len(package_candidates) >= 2 and item.get("fileKind") in {"Action", "Rest", "ServiceApi", "ServiceImpl", "Entity"}:
            top = package_candidates[0]
            second = package_candidates[1]
            if float(top.get("confidence", 0.0)) - float(second.get("confidence", 0.0)) <= 0.25:
                warnings.append(f"{item.get('fileKind')} 业务包分散：请把业务包名视为历史样例，不要直接升格为通用命名模板。")
                break

    web_path = placement_paths.get("web", "")
    if web_path.rstrip("/").endswith("src/main/webapp"):
        warnings.append("Web 根路径过宽：仅识别到 src/main/webapp，设计阶段需再确认业务子目录。")

    if any(scan.packaging.lower() == "pom" for scan in scans):
        warnings.append("多模块工程禁止将业务代码落在聚合父工程，必须先确认推荐模块。")

    return warnings


def build_backend_tree_example(paths: Dict[str, str]) -> List[str]:
    if not paths:
        return ["(未识别到后端结构落点)"]

    action_path = paths.get("action", "src/main/java/com/epoint/{domain}/action/").rstrip("/")
    service_api_path = paths.get("service_api", "src/main/java/com/epoint/{domain}/api/").rstrip("/")
    service_impl_path = paths.get("service_impl", "src/main/java/com/epoint/{domain}/impl/").rstrip("/")
    entity_path = paths.get("entity", "src/main/java/com/epoint/{domain}/api/entity/").rstrip("/")
    rest_path = paths.get("rest", "src/main/java/com/epoint/{domain}/rest/").rstrip("/")
    job_path = paths.get("job", "src/main/java/com/epoint/{domain}/job/").rstrip("/")

    lines = [
        f"{action_path.rsplit('/action', 1)[0]}/",
        "├── api/                          # 对外接口层",
        "│   ├── entity/                   # 实体类",
        "│   │   └── {EntityName}.java     # 实体类定义",
        "│   └── I{EntityName}Service.java # 服务接口",
        "├── impl/                         # 实现层",
        "│   └── {EntityName}ServiceImpl.java",
        "├── action/                       # 管理端控制器层",
        "│   ├── {PageName}ListAction.java",
        "│   ├── {PageName}AddAction.java",
        "│   ├── {PageName}EditAction.java",
        "│   └── {PageName}DetailAction.java",
        "├── job/                          # 定时任务层",
        "│   └── Gxh{OperationName}Job.java",
        "└── rest/                         # REST接口控制器层",
        "    └── {功能名}RestController.java",
        "",
        f"# Action落点: {action_path}/",
        f"# Service接口落点: {service_api_path}/",
        f"# Service实现落点: {service_impl_path}/",
        f"# Entity落点: {entity_path}/",
        f"# Job落点: {job_path}/",
        f"# Rest落点: {rest_path}/",
    ]
    return lines


def build_report(
    root: Path,
    output_path: Path,
    max_pom_files: int,
    max_java_files: int,
    max_html_files: int,
    records: Optional[Sequence[PomRecord]] = None,
    scans_map: Optional[Dict[Path, ModuleScan]] = None,
) -> None:
    now = datetime.now()
    scan_date = now.strftime("%Y-%m-%d")

    if records is None:
        records = scan_poms(root, max_pom_files)
    main = choose_main_record(records)

    product_name = main.artifact_id if main else "未识别"
    product_version = infer_product_version(main, records)
    group_id = (main.effective_group_id or main.group_id) if main else "未识别"
    coordinate_version = (main.effective_version or main.version) if main else "未识别"
    coordinate = f"{format_quote(group_id)}:{format_quote(product_name)}:{format_quote(coordinate_version)}"


    jdk = extract_jdk_version(main)
    spring = extract_spring_version(main)
    db_primary, db_others = detect_db_types(root)
    db_desc = f"{db_primary}（主），支持{'、'.join(db_others)}" if db_others else db_primary

    deps = collect_core_dependencies(main, records)
    if scans_map is None:
        scans_map = scan_modules(root, records, max_java_files, max_html_files)
    scans = list(scans_map.values())

    package_examples = collect_package_examples(scans)
    web_dirs = collect_web_dirs(scans)
    module_tree = build_module_tree(records, root)
    placement_lines, placement_paths, placement_diagnostics = build_class_placement(scans, root)
    ownership_rules = build_ownership_rules(scans)
    placement_candidates = build_placement_candidates(scans)
    placement_contract_draft = build_placement_contract_draft(placement_paths, ownership_rules)
    warnings = build_snapshot_warnings(scans, ownership_rules, placement_candidates, placement_paths)
    backend_tree_lines = build_backend_tree_example(placement_paths)
    rest_style_contract = collect_rest_style_contract(root, scans)
    write_rest_style_contract(root, rest_style_contract)
    key_resources = collect_key_resource_summaries(root)

    all_actions: List[str] = []
    all_rest: List[str] = []
    all_services: List[str] = []
    all_jobs: List[str] = []
    for s in sorted(scans, key=lambda x: x.relative_dir):
        all_actions.extend(s.action_samples)
        all_rest.extend(s.rest_samples)
        all_services.extend(s.service_samples)
        all_jobs.extend(s.job_samples)

    # 保留样例数量上限
    all_actions = all_actions[:MAX_SAMPLE_ITEMS]
    all_rest = all_rest[:MAX_SAMPLE_ITEMS]
    all_services = all_services[:MAX_SAMPLE_ITEMS]
    all_jobs = all_jobs[:MAX_SAMPLE_ITEMS]

    persistence_info = scan_persistence_artifacts(root)

    main_module_dir = "."
    if main and main.relative_path:
        main_module_dir = Path(main.relative_path).parent.as_posix() or "."
    package_command = "mvn clean package"
    packaging_kind = str(main.packaging or "").strip().lower() if main else ""
    if packaging_kind:
        package_command = "mvn clean package" if packaging_kind == "war" else "mvn clean install"
    module_summary_lines = []
    for item in sorted(scans, key=lambda x: (x.relative_dir.count("/"), x.relative_dir))[:12]:
        roles = []
        if item.action_count:
            roles.append("Action")
        if item.rest_count:
            roles.append("REST")
        if item.service_api_count:
            roles.append("ServiceApi")
        if item.service_impl_count:
            roles.append("ServiceImpl")
        if item.entity_count:
            roles.append("Entity")
        if item.job_count:
            roles.append("Job")
        if item.html_count:
            roles.append("Web")
        role_text = "、".join(roles) if roles else "未识别主要代码角色"
        module_summary_lines.append(f"- `{item.artifact_id}`（`{item.relative_dir}`，{item.packaging}）：{role_text}")

    lines: List[str] = []
    lines += [
        "---",
        'version: ""',
        f'product_name: "{format_quote(product_name)}"',
        f'product_version: "{format_quote(product_version)}"',
        f'scan_date: "{scan_date}"',
        "---",
        "# 项目现状报告",
        "",
        "## 1. 项目概述",
        "",
        "### 1.1 项目画像",
        f"- 产品名称：`{format_quote(product_name)}`",
        f"- 产品版本：`{format_quote(product_version)}`",
        f"- 工程坐标：`{coordinate}`",
        f"- 项目根目录：`{root.as_posix()}`",
        "- 报告定位：面向开发者与 AI 的项目画像；严格代码落点以 `.ai-workspace/project/工程导航契约.json` 为准。",
        "",
        "### 1.2 技术栈与版本",
        f"- JDK：`{format_quote(jdk)}`",
        f"- Spring：`{format_quote(spring)}`",
        f"- 数据库：`{db_desc}`",
        f"- Maven 主模块：`{main_module_dir}`",
        f"- 打包方式：`{format_quote(main.packaging if main else '未识别')}`",
        "",
        "### 1.3 核心依赖",
        "```xml",
    ]
    if deps:
        lines.extend([f"- {k}: {v}" for k, v in deps])
    else:
        lines.append("- 暂未识别到核心版本属性")
    rest_status = str(rest_style_contract.get("status") or "unknown")
    rest_primary = str(rest_style_contract.get("primaryReturnPattern") or "未检出统一返回封装")
    rest_evidence = rest_style_contract.get("evidenceFiles", []) if isinstance(rest_style_contract.get("evidenceFiles"), list) else []
    rest_pattern_total = sum(int(item.get("count", 0)) for item in rest_style_contract.get("returnPatterns", []) if isinstance(item, dict))
    web_source = placement_diagnostics.get("webPathSource", "history-webapp-scan")
    web_value = placement_diagnostics.get("projectPagePath", "")
    web_file = placement_diagnostics.get("projectPagePathFile", "")

    lines += [
        "```",
        "",
        "## 2. 项目架构",
        "",
        "### 2.1 模块职责",
    ]
    lines.extend(module_summary_lines or ["- 暂未识别到 Maven 模块职责，请结合 pom.xml 人工确认。"])
    lines += [
        "",
        "### 2.2 模块结构",
        "```",
    ]
    lines.extend([line for line in module_tree if str(line).strip()])
    lines += [
        "```",
        "",
        "### 2.3 代码落点摘要",
        "```text",
        f"Action:      {placement_paths.get('action', '-')}",
        f"REST:        {placement_paths.get('rest', '-')}",
        f"Service API: {placement_paths.get('service_api', '-')}",
        f"ServiceImpl: {placement_paths.get('service_impl', '-')}",
        f"Entity:      {placement_paths.get('entity', '-')}",
        f"Job:         {placement_paths.get('job', '-')}",
        f"HtmlPage:    {placement_paths.get('web', '-')}",
        "```",
    ]
    if web_source == "epointframe.properties:projectPagePath":
        lines.append(f"- HtmlPage 来源：`{web_file}#projectPagePath={web_value}`")
    else:
        lines.append("- HtmlPage 来源：历史 webapp 目录扫描")
    lines += [
        "- 完整机器契约：`.ai-workspace/project/工程导航契约.json`",
        "- 代码生成物理真值：`2_生成文件清单.resolved.json`",
        "",
        "## 3. REST 接口事实",
        f"- REST 根路径：`{placement_paths.get('rest', '-')}`",
        f"- Job 根路径：`{placement_paths.get('job', '-')}`",
        f"- REST return：`{rest_primary}`（{rest_status}，证据 {rest_pattern_total} 处）",
        "- Coder 必读契约：`.ai-workspace/project/rest-interface-style.contract.json`",
        "- 证据样例：",
    ]
    if rest_evidence:
        lines.extend([f"  - `{item}`" for item in rest_evidence[:2]])
    elif all_rest:
        lines.extend([f"  - `{item}`" for item in all_rest[:2]])
    else:
        lines.append("  - 暂未识别")
    if all_jobs:
        lines.extend([
            "- Job 证据样例：",
            *[f"  - `{item}`" for item in all_jobs[:2]]
        ])

    lines += [
        "",
        "## 4. 重点 resources 配置",
        "| 文件 | 用途 | 依据 | 置信度 |",
        "| --- | --- | --- | --- |",
    ]
    if key_resources:
        for item in key_resources:
            lines.append(f"| `{item['path']}` | {item['purpose']} | {item['evidence']} | {item['confidence']} |")
    else:
        lines.append("| 未检出 | 未检出重点配置 | 无 | unknown |")

    lines += [
        "",
        "## 5. 自动勘测摘要",
        "| 类型 | 推荐模块 | 置信度 |",
        "| --- | --- | --- |",
    ]
    if ownership_rules:
        for item in ownership_rules:
            lines.append(f"| {item['fileKind']} | `{item['recommendedModule']}` | {item['confidence']} |")
    else:
        lines.append("| 未识别 | - | - |")

    lines += [
        "",
        "## 6. 流水线自动产物说明",
        "| 文件 | 作用 | 是否手改 |",
        "| --- | --- | --- |",
        "| `项目现状报告.md` | 人读项目摘要，帮助快速理解模块、落点、REST return 与关键资源 | 不手改 |",
        "| `工程导航契约.md` | 人读代码落点与命名契约 | 谨慎修订 |",
        "| `工程导航契约.json` | 代码落点、命名、页面根路径的机器执行契约 | 谨慎修订 |",
        "| `工程导航契约.compact.json` | 给 prompt / 阶段上下文使用的轻量契约 | 不手改 |",
        "| `框架版本档位.json` | 规则桶选择依据，记录 950 档位及来源证据 | 谨慎修订 |",
        "| `rest-interface-style.contract.json` | REST return/注解/接口风格事实契约，Coder 必读 | 不手改 |",
        "| `asset-index.json` | 项目资产检索数据库，只取 Top N 摘要，不全文进 prompt | 不手改 |",
        "| `business-graph.json` | 完整业务关系图数据库，只检索复用，不全文进 prompt | 一般不手改 |",
        "| `business-graph.index.json` | 业务图轻量索引，供需求/设计/quick 快速召回 | 不手改 |",
        "| `entity-graph.json` | 实体、表、字段、实体关系图数据库，只检索复用 | 一般不手改 |",
        "| `entity-graph.index.json` | 实体图轻量索引 | 不手改 |",
        "",
        "## 7. 已识别风险",
        "- REST return 必须以 `rest-interface-style.contract.json` 为准，不得照规范示例硬套。",
    ]
    if web_source == "epointframe.properties:projectPagePath":
        lines.append("- HtmlPage 必须以 `projectPagePath` 派生路径为准，不得落到宽泛 `src/main/webapp/`。")
    for warning in warnings:
        lines.append(f"- {warning}")
    lines += [
        "",
        "---",
        f"**报告生成时间**：{scan_date}",
        "**勘测人员**：AI Assistant",
        "**报告版本**：v1.0",
    ]

    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text("\n".join(lines), encoding="utf-8")


def normalize_whitespace(text: str) -> str:
    return re.sub(r"\s+", " ", str(text or "")).strip()


def extract_javadoc_summary(block: str) -> str:
    if not block:
        return ""
    lines: List[str] = []
    for raw in block.replace("/**", "").replace("*/", "").splitlines():
        cleaned = raw.strip()
        if cleaned.startswith("*"):
            cleaned = cleaned[1:].strip()
        cleaned = normalize_whitespace(cleaned)
        if not cleaned or cleaned.startswith("@"):
            continue
        lines.append(cleaned)
    return lines[0] if lines else ""


def extract_line_comment_summary(block: str) -> str:
    if not block:
        return ""
    lines: List[str] = []
    for raw in str(block).splitlines():
        cleaned = raw.strip()
        if not cleaned.startswith("//"):
            continue
        cleaned = normalize_whitespace(cleaned[2:])
        if not cleaned:
            continue
        lines.append(cleaned)
    if not lines:
        return ""

    def is_code_like_comment(text: str) -> bool:
        normalized = normalize_whitespace(text)
        if not normalized:
            return False
        if "(" in normalized and ")" in normalized and ";" in normalized:
            return True
        return bool(re.search(r"[A-Za-z_][A-Za-z0-9_<>\[\], ?.&]*\s+[A-Za-z_][A-Za-z0-9_]*\s*\([^)]*\)\s*;?$", normalized))

    filtered: List[str] = []
    for index, item in enumerate(lines):
        next_item = lines[index + 1] if index + 1 < len(lines) else ""
        if is_code_like_comment(item):
            continue
        if next_item and is_code_like_comment(next_item):
            continue
        filtered.append(item)

    candidates = filtered or [item for item in lines if not is_code_like_comment(item)]
    if not candidates:
        return ""
    return normalize_whitespace(" ".join(candidates))


def extract_method_comment_summary(block: str) -> str:
    text = str(block or "").strip()
    if not text:
        return ""
    javadoc_match = re.search(r"/\*\*[\s\S]*?\*/", text)
    if javadoc_match:
        return extract_javadoc_summary(javadoc_match.group(0))
    if "//" in text:
        return extract_line_comment_summary(text)
    return ""


def extract_declaration_comment_summary(block: str) -> str:
    return extract_method_comment_summary(block)


def normalize_lookup_token(value: str) -> str:
    return re.sub(r"[^a-z0-9]+", "", str(value or "").lower())


def derive_lookup_keys(name: str) -> Set[str]:
    raw = str(name or "").strip()
    if not raw:
        return set()
    normalized = normalize_lookup_token(raw)
    keys = {normalized}
    return {item for item in keys if item}


def safe_module_name(module_name: str) -> str:
    return re.sub(r'[\\/:*?"<>|\s]+', "_", str(module_name or "").strip()) or "root"


def parse_java_file_with_fallback(java_path: Path) -> Dict[str, str]:
    text = java_path.read_text(encoding="utf-8", errors="ignore")
    normalized = text.replace("\r\n", "\n").replace("\r", "\n")
    return {
        "text": normalized,
        "package_name": extract_package(normalized),
    }


def parse_entity_fields(java_text: str) -> List[Dict[str, str]]:
    field_re = re.compile(
        r"(?s)("
        r"(?:(?:/\*\*.*?\*/|(?:(?:[ \t]*//[^\n]*\n)+)|@\w+(?:\([^)]*\))?)\s*)*"
        r")"
        r"((?:(?:private|protected|public|static|final|transient|volatile)\s+)+)"
        r"([A-Za-z0-9_<>\[\], ?.&]+?)\s+"
        r"([A-Za-z_][A-Za-z0-9_]*)\s*(?:=[^;]+)?;"
    )
    column_re = re.compile(r'@Column\s*\(\s*name\s*=\s*["\']([^"\']+)["\']', re.I)
    # Epoint 公司 BaseEntity 模式：字段不写 private/Column，而是
    #   @EntityLength(length=50)
    #   public String getRowguid() { return super.get("rowguid"); }
    # 这里抽 getter 体里的 super.get("xxx") + 上下文 @EntityLength + 返回类型，
    # 让 Entity anchor.fields 不再失明（无证明项目实证：之前 fields=[]，现在能召回）。
    epoint_getter_re = re.compile(
        r"(?s)("
        r"(?:(?:/\*\*.*?\*/|(?:(?:[ \t]*//[^\n]*\n)+)|@\w+(?:\([^)]*\))?)\s*)*"
        r")"
        r"public\s+([A-Za-z0-9_<>\[\], ?.&]+?)\s+"
        r"get([A-Z][A-Za-z0-9_]*)\s*\(\s*\)\s*\{[^}]*?"
        r"super\s*\.\s*get\s*\(\s*[\"']([^\"']+)[\"']\s*\)"
    )
    fields: List[Dict[str, str]] = []
    seen: Set[str] = set()

    # 1) 标准 Java 字段（@Column / private 模式）
    for match in field_re.finditer(java_text):
        metadata_block = str(match.group(1) or "")
        modifiers = normalize_whitespace(match.group(2))
        java_type = normalize_whitespace(match.group(3))
        field_name = normalize_whitespace(match.group(4))
        if not field_name or field_name in seen:
            continue
        if " static " in f" {modifiers} ":
            continue
        if field_name == "serialVersionUID":
            continue

        summary = extract_declaration_comment_summary(metadata_block)
        column_match = column_re.search(metadata_block)
        column_name = normalize_whitespace(column_match.group(1) if column_match else field_name)
        fields.append({
            "fieldName": field_name,
            "columnName": column_name,
            "javaType": java_type or "未识别",
            "summary": summary or field_name,
        })
        seen.add(field_name)

    # 2) Epoint super.get("xxx") 动态字段：@EntityLength + getter 模式
    for match in epoint_getter_re.finditer(java_text):
        metadata_block = str(match.group(1) or "")
        java_type = normalize_whitespace(match.group(2))
        field_name = normalize_whitespace(match.group(4))  # super.get 的字符串 key 是真名
        if not field_name or field_name in seen:
            continue
        # 公共字段（rowguid/operatedate 等）由 BaseEntity 提供，业务图照样收，让需求侧能召回
        summary = extract_declaration_comment_summary(metadata_block) or field_name
        fields.append({
            "fieldName": field_name,
            "columnName": field_name,  # Epoint 字段名 = 列名（动态查 dataSourceMeta）
            "javaType": java_type or "未识别",
            "summary": summary,
        })
        seen.add(field_name)

    return fields


def find_owner_module(java_path: Path, scans_map: Dict[Path, ModuleScan], root: Path) -> Tuple[str, str]:
    owner: Optional[ModuleScan] = None
    for module_dir, scan in scans_map.items():
        try:
            java_path.resolve().relative_to(module_dir.resolve())
            if owner is None or len(module_dir.parts) > len(owner.module_dir.parts):
                owner = scan
        except Exception:
            continue

    if owner:
        return owner.artifact_id or owner.module_dir.name, owner.relative_dir
    return root.name, "."


def scan_entity_records(root: Path, scans_map: Dict[Path, ModuleScan], max_java_files: int) -> List[EntityRecord]:
    # 进程内复用：同一份 scans_map（按 id 识别）反复调时直接返回上次结果，避免重复 walk Java 源码
    cache = getattr(scan_entity_records, "_cache", None)
    if cache is None:
        cache = {}
        scan_entity_records._cache = cache
    cache_key = (id(scans_map), max_java_files)
    if cache_key in cache:
        return cache[cache_key]

    entities: List[EntityRecord] = []
    class_re = re.compile(r"\bclass\s+([A-Za-z_][A-Za-z0-9_]*)\b")
    table_re = re.compile(r'@Entity\s*\(\s*table\s*=\s*["\']([^"\']+)["\']', re.I)
    summary_re = re.compile(r"(?s)(/\*\*.*?\*/)\s*(?:@\w+(?:\([^)]*\))?\s*)*(?:public\s+)?class\s+[A-Za-z_][A-Za-z0-9_]*\b")

    for java_file in iter_business_java_files(root, scans_map, max_java_files):
        parsed = parse_java_file_with_fallback(java_file)
        text = parsed["text"]
        rel = safe_rel(java_file, root)
        pkg = parsed["package_name"]
        kind = detect_java_kind(java_file, pkg, text[:5000], rel)
        if kind != "entity" and "@Entity" not in text:
            continue

        class_match = class_re.search(text)
        if not class_match:
            continue

        summary_match = summary_re.search(text)
        table_match = table_re.search(text)
        module_name, _ = find_owner_module(java_file, scans_map, root)
        entities.append(EntityRecord(
            entity_name=class_match.group(1).strip(),
            package_name=pkg,
            module_name=module_name,
            source_file=rel,
            table_name=(table_match.group(1).strip() if table_match else ""),
            summary=extract_javadoc_summary(summary_match.group(1) if summary_match else ""),
            fields=parse_entity_fields(text),
        ))

    cache[cache_key] = entities
    return entities


def build_entity_lookup(entities: Sequence[EntityRecord]) -> Dict[str, EntityRecord]:
    lookup: Dict[str, EntityRecord] = {}
    for item in entities:
        for key in derive_lookup_keys(item.entity_name):
            lookup[key] = item
    return lookup


def build_entity_table_display_name(entity: EntityRecord) -> str:
    return normalize_whitespace(entity.summary) or normalize_whitespace(entity.entity_name)


def dedupe_entity_keywords(*values: str) -> List[str]:
    result: List[str] = []
    seen: Set[str] = set()
    for value in values:
        clean = normalize_whitespace(value)
        if not clean or clean in seen:
            continue
        seen.add(clean)
        result.append(clean)
    return result


def build_entity_relation_tokens(entity_name: str, table_name: str, table_display_name: str) -> Set[str]:
    values = [entity_name, table_name, table_display_name]
    tokens: Set[str] = set()
    for value in values:
        clean = normalize_whitespace(value)
        if not clean:
            continue
        normalized = normalize_lookup_token(clean)
        if normalized:
            tokens.add(normalized)
        tokens.update(derive_lookup_keys(clean))
        for token in graph_split_tokens(clean):
            normalized_token = normalize_lookup_token(token)
            if normalized_token:
                tokens.add(normalized_token)
    return {item for item in tokens if item and item not in {"entity", "table"}}


def infer_entity_role_seed(entity_name: str, table_name: str, summary: str) -> str:
    text = f"{entity_name} {table_name} {summary}".lower()
    if re.search(r"(history|version|历史|版本)", text):
        return "history"
    if re.search(r"(rel|relation|map|关联|关系)", text):
        return "relation"
    if re.search(r"(extend|extension|扩展)", text):
        return "extension"
    if re.search(r"(detail|item|明细|子项)", text):
        return "detail"
    return "master"


def strip_entity_role_suffix(value: str, role: str) -> str:
    text = normalize_lookup_token(value)
    if not text:
        return ""
    patterns = {
        "history": [r"(history|version)$"],
        "relation": [r"(rel|relation|map)$"],
        "extension": [r"(extend|extension)$"],
        "detail": [r"(detail|item)$"],
    }
    for pattern in patterns.get(role, []):
        stripped = re.sub(pattern, "", text)
        if stripped and stripped != text:
            return stripped
    return text


def infer_reference_prefix(field_name: str) -> str:
    raw = normalize_lookup_token(field_name)
    if not raw:
        return ""
    raw = re.sub(r"(row)?guid$", "", raw)
    raw = re.sub(r"id$", "", raw)
    raw = re.sub(r"(fk|key)$", "", raw)
    return raw


def select_best_related_entity(prefix: str, current_id: str, token_index: Dict[str, Set[str]], entity_nodes: Dict[str, Dict[str, object]]) -> Optional[str]:
    normalized = normalize_lookup_token(prefix)
    if len(normalized) < 3:
        return None
    direct = [item for item in token_index.get(normalized, set()) if item != current_id]
    if len(direct) == 1:
        return direct[0]

    candidates: List[Tuple[int, str]] = []
    for entity_id, node in entity_nodes.items():
        if entity_id == current_id:
            continue
        relation_tokens = set(node.get("_relationTokens", []))
        if not relation_tokens:
            continue
        score = 0
        if normalized in relation_tokens:
            score += 10
        if any(token.endswith(normalized) for token in relation_tokens):
            score += 8
        if any(normalized in token for token in relation_tokens):
            score += 5
        if score > 0:
            candidates.append((score, entity_id))
    candidates.sort(key=lambda item: (-item[0], item[1]))
    if len(candidates) == 1:
        return candidates[0][1]
    if len(candidates) >= 2 and candidates[0][0] > candidates[1][0]:
        return candidates[0][1]
    return None


def build_entity_graph(root: Path, records: Sequence[PomRecord], max_java_files: int, max_html_files: int, scans_map: Optional[Dict[Path, ModuleScan]] = None) -> Dict[str, object]:
    if scans_map is None:
        scans_map = scan_modules(root, records, max_java_files, max_html_files)
    entity_records = scan_entity_records(root, scans_map, max_java_files)
    nodes: List[Dict[str, object]] = []
    token_index: Dict[str, Set[str]] = defaultdict(set)
    nodes_by_id: Dict[str, Dict[str, object]] = {}

    for entity in entity_records:
        table_display_name = build_entity_table_display_name(entity)
        node = {
            "id": f"entity:{entity.entity_name}",
            "entityName": entity.entity_name,
            "tableName": normalize_whitespace(entity.table_name),
            "tableDisplayName": table_display_name,
            "role": infer_entity_role_seed(entity.entity_name, entity.table_name, entity.summary),
            "sourceFile": entity.source_file,
            "moduleName": entity.module_name,
            "summary": normalize_whitespace(entity.summary),
            "keywords": dedupe_entity_keywords(table_display_name, entity.table_name, entity.entity_name),
            "fields": list(entity.fields),
            "_relationTokens": sorted(build_entity_relation_tokens(entity.entity_name, entity.table_name, table_display_name))
        }
        nodes.append(node)
        nodes_by_id[node["id"]] = node
        for token in node["_relationTokens"]:
            token_index[token].add(node["id"])

    edge_map: Dict[Tuple[str, str, str], Dict[str, object]] = {}

    def push_edge(from_id: str, to_id: str, edge_type: str, confidence: float, evidence: Sequence[str], join_keys: Optional[Sequence[Dict[str, str]]] = None) -> None:
        if not from_id or not to_id or not edge_type:
            return
        key = (from_id, to_id, edge_type)
        candidate = {
            "from": from_id,
            "to": to_id,
            "type": edge_type,
            "confidence": round(float(confidence), 2),
            "joinKeys": list(join_keys or []),
            "evidence": [normalize_whitespace(item) for item in evidence if normalize_whitespace(item)],
        }
        existing = edge_map.get(key)
        if not existing or float(existing.get("confidence", 0)) < candidate["confidence"]:
            edge_map[key] = candidate

    for node in nodes:
        role_seed = str(node.get("role", "master") or "master").strip() or "master"
        entity_id = str(node.get("id", "")).strip()
        relation_tokens = set(node.get("_relationTokens", []))

        base_token = strip_entity_role_suffix(str(node.get("entityName", "")), role_seed)
        if role_seed in {"detail", "relation", "extension", "history"} and base_token:
            target_id = select_best_related_entity(base_token, entity_id, token_index, nodes_by_id)
            if target_id:
                edge_type = {
                    "detail": "detail_of",
                    "relation": "relation_of",
                    "extension": "extension_of",
                    "history": "history_of",
                }[role_seed]
                push_edge(
                    entity_id,
                    target_id,
                    edge_type,
                    0.72,
                    [f"name: {node.get('entityName', '')}", f"role: {role_seed}"]
                )

        for field in node.get("fields", []):
            field_name = normalize_whitespace(field.get("fieldName", ""))
            column_name = normalize_whitespace(field.get("columnName", ""))
            field_summary = normalize_whitespace(field.get("summary", ""))
            lowered = field_name.lower()
            if lowered in {"rowguid", "id"}:
                continue

            if lowered in {"parentguid", "parentid"}:
                push_edge(
                    entity_id,
                    entity_id,
                    "parent_of",
                    0.78,
                    [f"field: {field_name}", f"summary: {field_summary or '父子层级字段'}"],
                    [{"fromField": field_name, "toField": "rowguid"}]
                )
                continue

            prefix = infer_reference_prefix(field_name)
            target_id = select_best_related_entity(prefix, entity_id, token_index, nodes_by_id)
            if not target_id:
                continue

            edge_type = "detail_of"
            if role_seed == "history":
                edge_type = "history_of"
            elif role_seed == "relation":
                edge_type = "relation_of"
            elif role_seed == "extension":
                edge_type = "extension_of"
            confidence = 0.78
            evidence = [f"field: {field_name}"]
            if field_summary:
                evidence.append(f"summary: {field_summary}")
                if re.search(r"(明细|子表|列表|窗口)", field_summary):
                    edge_type = "detail_of"
                    confidence = 0.84
                elif re.search(r"(版本|历史)", field_summary):
                    edge_type = "history_of"
                    confidence = 0.84
                elif re.search(r"(扩展|附加)", field_summary):
                    edge_type = "extension_of"
                    confidence = 0.84
                elif re.search(r"(关联|关系)", field_summary):
                    edge_type = "relation_of"
                    confidence = 0.84
            if column_name and column_name != field_name:
                evidence.append(f"column: {column_name}")
            if any(token.endswith(prefix) for token in relation_tokens):
                confidence = max(confidence, 0.82)
            push_edge(
                entity_id,
                target_id,
                edge_type,
                confidence,
                evidence,
                [{"fromField": field_name, "toField": "rowguid"}]
            )

    for node in nodes:
        outgoing = [item for item in edge_map.values() if item["from"] == node["id"] and item["to"] != node["id"]]
        if outgoing:
            preferred = sorted(outgoing, key=lambda item: (-float(item.get("confidence", 0)), item["type"]))[0]
            node["role"] = {
                "detail_of": "detail",
                "relation_of": "relation",
                "extension_of": "extension",
                "history_of": "history",
                "parent_of": "master",
            }.get(preferred["type"], node["role"])
        node.pop("_relationTokens", None)

    edges = sorted(edge_map.values(), key=lambda item: (
        str(item.get("from", "")),
        str(item.get("to", "")),
        str(item.get("type", ""))
    ))
    nodes.sort(key=lambda item: str(item.get("entityName", "")))

    return {
        "entityGraph": {
            "version": 1,
            "sourcePolicy": {
                "tableDisplayName": "entity_javadoc_first",
                "keywords": ["tableDisplayName", "tableName", "entityName"]
            },
            "nodes": nodes,
            "edges": edges
        },
        "generatedAt": datetime.now().isoformat(timespec="seconds"),
        "projectPath": str(root),
    }


def split_java_parameters(params_text: str) -> List[str]:
    text = str(params_text or "").strip()
    if not text:
        return []

    parts: List[str] = []
    current: List[str] = []
    angle_depth = 0
    paren_depth = 0
    bracket_depth = 0

    for ch in text:
        if ch == "<":
            angle_depth += 1
        elif ch == ">" and angle_depth > 0:
            angle_depth -= 1
        elif ch == "(":
            paren_depth += 1
        elif ch == ")" and paren_depth > 0:
            paren_depth -= 1
        elif ch == "[":
            bracket_depth += 1
        elif ch == "]" and bracket_depth > 0:
            bracket_depth -= 1

        if ch == "," and angle_depth == 0 and paren_depth == 0 and bracket_depth == 0:
            piece = normalize_whitespace("".join(current))
            if piece:
                parts.append(piece)
            current = []
            continue
        current.append(ch)

    tail = normalize_whitespace("".join(current))
    if tail:
        parts.append(tail)
    return parts


def parse_method_params(params_text: str) -> List[Dict[str, str]]:
    params: List[Dict[str, str]] = []
    for raw_param in split_java_parameters(params_text):
        clean = re.sub(r"@\w+(?:\([^)]*\))?\s*", "", raw_param)
        clean = re.sub(r"\bfinal\s+", "", clean).strip()
        if not clean:
            continue
        tokens = clean.split()
        if len(tokens) == 1:
            params.append({"name": tokens[0], "type": ""})
            continue
        params.append({
            "name": tokens[-1],
            "type": " ".join(tokens[:-1]),
        })
    return params


def parse_interface_signature(java_text: str) -> Dict[str, object]:
    signature_re = re.compile(
        r"(?s)(/\*\*.*?\*/\s*)?(?:@\w+(?:\([^)]*\))?\s*)*(?:public\s+)?interface\s+([A-Za-z_][A-Za-z0-9_]*)\b"
    )
    match = signature_re.search(java_text)
    if not match:
        return {"interface_name": "", "summary": "", "imports": []}
    imports = [
        item.rsplit(".", 1)[-1]
        for item in re.findall(r"^\s*import\s+([\w\.]+)\s*;", java_text, re.M)
        if item and not item.startswith("java.") and not item.startswith("javax.")
    ]
    return {
        "interface_name": match.group(2).strip(),
        "summary": extract_javadoc_summary(match.group(1) or ""),
        "imports": imports,
    }


def parse_interface_methods(java_text: str) -> List[Dict[str, object]]:
    method_re = re.compile(
        r"(?s)(/\*\*.*?\*/[ \t]*|(?:(?:[ \t]*//[^\n]*\n)+)[ \t]*)?"
        r"(?:@\w+(?:\([^)]*\))?\s*)*"
        r"(?:public\s+)?(?:abstract\s+)?"
        r"([A-Za-z0-9_<>\[\], ?.&]+?)\s+"
        r"([A-Za-z_][A-Za-z0-9_]*)\s*"
        r"\((.*?)\)\s*"
        r"(?:throws\s+[^;]+)?;"
    )
    methods: List[Dict[str, object]] = []
    for match in method_re.finditer(java_text):
        return_type = normalize_whitespace(match.group(2))
        method_name = normalize_whitespace(match.group(3))
        raw_params = normalize_whitespace(match.group(4))
        params = parse_method_params(raw_params)
        methods.append({
            "name": method_name,
            "signature": f"{return_type} {method_name}({raw_params})",
            "summary": extract_method_comment_summary(match.group(1) or ""),
            "params": params,
            "returnType": return_type,
        })
    return methods


def build_interface_candidate_tokens(interface_name: str, imports: Sequence[str], methods: Sequence[Dict[str, object]], summary: str) -> Set[str]:
    tokens: Set[str] = {str(item or "").strip() for item in imports if str(item or "").strip()}

    base_name = str(interface_name or "").strip()
    if base_name.startswith("I") and len(base_name) > 1:
        base_name = base_name[1:]
    if base_name.endswith("Service"):
        base_name = base_name[:-7]
    if base_name:
        tokens.add(base_name)

    content = " ".join(
        [summary]
        + [str(method.get("signature", "")) for method in methods]
        + [str(method.get("summary", "")) for method in methods]
    )
    tokens.update(re.findall(r"\b[A-Z][A-Za-z0-9_]+\b", content))
    return {item for item in tokens if item and item not in JAVA_COMMON_TYPE_NAMES}


def resolve_related_entities(
    interface_name: str,
    imports: Sequence[str],
    methods: Sequence[Dict[str, object]],
    summary: str,
    entity_lookup: Dict[str, EntityRecord],
) -> List[EntityRecord]:
    entities: Dict[str, EntityRecord] = {}
    for token in build_interface_candidate_tokens(interface_name, imports, methods, summary):
        keys = derive_lookup_keys(token)
        normalized = normalize_lookup_token(token)
        if normalized:
            keys.add(normalized)
        for key in keys:
            entity = entity_lookup.get(key)
            if entity:
                entities[entity.entity_name] = entity
    return sorted(entities.values(), key=lambda item: (item.table_name or item.entity_name, item.entity_name))


def build_table_structures(entities: Sequence[EntityRecord], table_names: Sequence[str]) -> List[Dict[str, object]]:
    structures: List[Dict[str, object]] = []
    seen: Set[str] = set()

    for entity in entities:
        key = f"{entity.table_name}::{entity.entity_name}"
        if key in seen:
            continue
        seen.add(key)
        structures.append({
            "tableName": entity.table_name,
            "entityName": entity.entity_name,
            "entitySourceFile": entity.source_file,
            "fields": entity.fields or [],
        })

    for table_name in table_names:
        if any(item.get("tableName") == table_name for item in structures):
            continue
        structures.append({
            "tableName": table_name,
            "entityName": "",
            "entitySourceFile": "",
            "fields": [],
        })

    return structures


def extract_business_terms(text: str, limit: int = 12) -> List[str]:
    found: List[str] = []
    seen: Set[str] = set()
    normalized_text = str(text or "")
    for token in re.findall(r"[\u4e00-\u9fff]{2,12}", normalized_text):
        clean = normalize_whitespace(token)
        if clean and clean not in seen:
            seen.add(clean)
            found.append(clean)
            if len(found) >= limit:
                return found

    for token in re.findall(r"[A-Za-z][A-Za-z0-9_]{3,}", normalized_text):
        clean = token.strip()
        lower = clean.lower()
        if lower in GENERIC_TEXT_TOKENS or lower in GENERIC_METHOD_NAMES:
            continue
        if clean and clean not in seen:
            seen.add(clean)
            found.append(clean)
            if len(found) >= limit:
                return found
    return found


def clean_api_summary(summary: str) -> str:
    cleaned = normalize_whitespace(summary)
    if not cleaned:
        return ""
    for pattern, replacement in GENERIC_API_SUMMARY_PATTERNS:
        cleaned = re.sub(pattern, replacement, cleaned, flags=re.I)
        cleaned = normalize_whitespace(cleaned)
    cleaned = cleaned.strip("：:，,。；;、 ")
    return cleaned


def build_method_subject(interface_summary: str, entity_names: Sequence[str], table_names: Sequence[str]) -> str:
    summary_subject = clean_api_summary(interface_summary)
    if summary_subject:
        return summary_subject
    if entity_names:
        return str(entity_names[0]).strip()
    if table_names:
        return str(table_names[0]).strip()
    return ""


def infer_param_label(param_name: str) -> str:
    normalized = str(param_name or "").strip()
    if not normalized:
        return "参数"
    lower = normalized.lower()
    if lower in {"id", "primarykey"}:
        return "主键"
    if lower == "guid":
        return "guid"
    if lower.endswith("rowguid"):
        return "rowguid"
    if lower.endswith("guid"):
        return normalized
    if lower.endswith("formid"):
        return "表单ID"
    if lower.endswith("certnum"):
        return "证书编号"
    if lower.endswith("sqltablename") or lower == "tablename":
        return "表名"
    return normalized


def infer_method_summary(
    method_name: str,
    return_type: str,
    params: Sequence[Dict[str, str]],
    interface_summary: str,
    entity_names: Sequence[str],
    table_names: Sequence[str],
) -> str:
    name = str(method_name or "").strip()
    if not name:
        return "源码未提供方法注释，请结合签名与调用方确认"

    lower_name = name.lower()
    subject = build_method_subject(interface_summary, entity_names, table_names)
    first_param_name = str((params[0] or {}).get("name", "")).strip() if params else ""
    param_label = infer_param_label(first_param_name) if first_param_name else "参数"

    def with_subject(subject_text: str, generic_text: str) -> str:
        return subject_text.format(subject=subject, param=param_label) if subject else generic_text

    if lower_name.startswith(("insert", "add", "save", "create")):
        return with_subject("新增{subject}", "源码未提供方法注释，按签名推断为新增操作")
    if lower_name.startswith(("update", "edit", "modify")):
        return with_subject("更新{subject}", "源码未提供方法注释，按签名推断为更新操作")
    if lower_name.startswith(("delete", "remove")):
        return with_subject("删除{subject}", "源码未提供方法注释，按签名推断为删除操作")
    if lower_name.startswith(("count", "total")):
        return with_subject("统计{subject}数量", "源码未提供方法注释，按签名推断为统计数量操作")
    if lower_name.startswith(("sync", "import")):
        return with_subject("同步{subject}数据", "源码未提供方法注释，按签名推断为同步操作")
    if lower_name.startswith("export"):
        return with_subject("导出{subject}数据", "源码未提供方法注释，按签名推断为导出操作")

    list_like = any(token in str(return_type or "") for token in ["List<", "Set<", "Collection<", "PageData<", "PageInfo<", "PageResult<", "Paginator"])
    if list_like or "list" in lower_name or "page" in lower_name:
        if first_param_name:
            return with_subject(f"按{param_label}查询{{subject}}列表", "源码未提供方法注释，按签名推断为列表查询操作")
        return with_subject("查询{subject}列表", "源码未提供方法注释，按签名推断为列表查询操作")

    if lower_name.startswith(("find", "get", "select", "query", "load")):
        if first_param_name:
            return with_subject(f"按{param_label}查询{{subject}}", "源码未提供方法注释，按签名推断为查询操作")
        return with_subject("查询{subject}", "源码未提供方法注释，按签名推断为查询操作")

    return "源码未提供方法注释，请结合签名与调用方确认"


def enrich_method_summaries(
    methods: Sequence[Dict[str, object]],
    interface_summary: str,
    entity_names: Sequence[str],
    table_names: Sequence[str],
) -> List[Dict[str, object]]:
    enriched: List[Dict[str, object]] = []
    for method in methods:
        item = dict(method)
        summary = normalize_whitespace(str(item.get("summary", "") or ""))
        if not summary:
            item["summary"] = infer_method_summary(
                method_name=str(item.get("name", "") or ""),
                return_type=str(item.get("returnType", "") or ""),
                params=item.get("params", []) if isinstance(item.get("params"), list) else [],
                interface_summary=interface_summary,
                entity_names=entity_names,
                table_names=table_names,
            )
        enriched.append(item)
    return enriched


def build_api_intent_keywords(
    interface_name: str,
    entity_names: Sequence[str],
    table_names: Sequence[str],
    methods: Sequence[Dict[str, object]],
    summary: str,
    module_name: str,
) -> List[str]:
    keywords: List[str] = []
    seen: Set[str] = set()

    def push(value: str) -> None:
        clean = normalize_whitespace(value)
        if not clean:
            return
        key = clean.lower()
        if key in seen:
            return
        seen.add(key)
        keywords.append(clean)

    summary_text = clean_api_summary(summary)
    if summary_text:
        push(summary_text)
        for term in extract_business_terms(summary_text, limit=8):
            push(term)

    for table_name in table_names:
        push(table_name)
    for entity_name in entity_names:
        push(entity_name)
    push(interface_name)

    return keywords[:12]


def scan_public_interfaces(
    root: Path,
    scans_map: Dict[Path, ModuleScan],
    entity_lookup: Dict[str, EntityRecord],
    max_java_files: int,
) -> List[Dict[str, object]]:
    # 进程内复用：build_api_catalog / build_business_graph 都会调，避免重复 walk Java 源码
    cache = getattr(scan_public_interfaces, "_cache", None)
    if cache is None:
        cache = {}
        scan_public_interfaces._cache = cache
    cache_key = (id(scans_map), id(entity_lookup), max_java_files)
    if cache_key in cache:
        return cache[cache_key]

    interfaces: List[Dict[str, object]] = []

    for java_file in iter_business_java_files(root, scans_map, max_java_files):
        parsed = parse_java_file_with_fallback(java_file)
        text = parsed["text"]
        rel = safe_rel(java_file, root)
        pkg = parsed["package_name"]
        if not re.search(r"\bpublic\s+interface\b", text):
            continue

        signature = parse_interface_signature(text)
        interface_name = str(signature.get("interface_name", "")).strip()
        if not interface_name:
            continue

        methods = parse_interface_methods(text)

        module_name, module_rel = find_owner_module(java_file, scans_map, root)
        related_entities = resolve_related_entities(
            interface_name=interface_name,
            imports=signature.get("imports", []) if isinstance(signature.get("imports"), list) else [],
            methods=methods,
            summary=str(signature.get("summary", "") or ""),
            entity_lookup=entity_lookup,
        )
        entity_names = sorted(item.entity_name for item in related_entities)
        table_names = sorted({item.table_name for item in related_entities if item.table_name})
        methods = enrich_method_summaries(
            methods=methods,
            interface_summary=str(signature.get("summary", "") or ""),
            entity_names=entity_names,
            table_names=table_names,
        )
        keywords = build_api_intent_keywords(
            interface_name=interface_name,
            entity_names=entity_names,
            table_names=table_names,
            methods=methods,
            summary=str(signature.get("summary", "") or ""),
            module_name=module_name,
        )

        interfaces.append({
            "interfaceName": interface_name,
            "packageName": pkg,
            "moduleName": module_name,
            "moduleDir": module_rel,
            "sourceFile": rel,
            "summary": str(signature.get("summary", "") or f"{interface_name} 历史接口能力"),
            "entityNames": entity_names,
            "tableNames": table_names,
            "methodNames": [str(item.get("name", "")).strip() for item in methods if str(item.get("name", "")).strip()],
            "methods": methods,
            "tableStructures": build_table_structures(related_entities, table_names),
            "anchors": [f"module:{module_name}", f"package:{pkg}", f"source:{rel}"],
            "keywords": keywords,
        })

    interfaces.sort(key=lambda item: (item.get("moduleName", ""), item.get("interfaceName", "")))
    cache[cache_key] = interfaces
    return interfaces


def build_rule_file_name(interface_name: str, module_name: str, duplicates: Counter) -> str:
    base_name = f"{interface_name}接口使用规范"
    if duplicates.get(interface_name, 0) > 1:
        base_name = f"{safe_module_name(module_name)}__{base_name}"
    return f"{base_name}.md"


def build_api_catalog(
    root: Path,
    records: Sequence[PomRecord],
    max_java_files: int,
    max_html_files: int,
    scans_map: Optional[Dict[Path, ModuleScan]] = None,
) -> Dict[str, object]:
    if scans_map is None:
        scans_map = scan_modules(root, records, max_java_files, max_html_files)
    entities = scan_entity_records(root, scans_map, max_java_files)
    entity_lookup = build_entity_lookup(entities)
    interfaces = scan_public_interfaces(root, scans_map, entity_lookup, max_java_files)
    duplicates = Counter(item["interfaceName"] for item in interfaces)

    interface_entries: List[Dict[str, object]] = []
    for index, item in enumerate(interfaces, start=1):
        rule_file_name = build_rule_file_name(str(item["interfaceName"]), str(item["moduleName"]), duplicates)
        rule_file = f"{AI_WORKSPACE_DIR_NAME}/{AI_WORKSPACE_KNOWLEDGE_DIR_NAME}/api-rules/{rule_file_name}"
        rule_alias = Path(rule_file_name).stem
        interface_entries.append({
            "ruleId": f"api-rule-{index:04d}",
            "ruleAlias": rule_alias,
            "ruleFile": rule_file.replace("\\", "/"),
            "interfaceName": item["interfaceName"],
            "packageName": item["packageName"],
            "moduleName": item["moduleName"],
            "sourceFile": item["sourceFile"],
            "summary": item["summary"],
            "entityNames": item["entityNames"],
            "tableNames": item["tableNames"],
            "methodNames": item["methodNames"],
            "keywords": item["keywords"],
            "methods": item["methods"],
            "tableStructures": item.get("tableStructures", []),
            "anchors": item["anchors"],
        })

    return {
        "generatedAt": datetime.now().isoformat(timespec="seconds"),
        "projectPath": str(root),
        "interfaces": interface_entries,
    }


def normalize_business_graph_key(value: str) -> str:
    text = normalize_whitespace(str(value or ""))
    if not text:
        return "unknown"
    text = re.sub(r"^(?:I)(?=[A-Z])", "", text)
    text = re.sub(
        r"(?:ServiceImpl|Service|RestController|Controller|ListAction|AddAction|EditAction|DetailAction|Action|Entity)$",
        "",
        text,
    )
    text = re.sub(r"([a-z0-9])([A-Z])", r"\1-\2", text)
    text = re.sub(r"[^A-Za-z0-9\u4e00-\u9fff]+", "-", text).strip("-").lower()
    return text or "unknown"


def graph_split_tokens(*values: str) -> List[str]:
    tokens: List[str] = []
    seen: Set[str] = set()
    for value in values:
        text = str(value or "")
        camel = re.sub(r"([a-z0-9])([A-Z])", r"\1 \2", text)
        parts = re.findall(r"[A-Za-z0-9]{2,}|[\u4e00-\u9fff]{2,}", camel.lower())
        for part in parts:
            if part in GENERIC_TEXT_TOKENS or part in GENERIC_METHOD_NAMES:
                continue
            if part not in seen:
                seen.add(part)
                tokens.append(part)
    return tokens[:80]


def build_asset_tokens(*values: str) -> List[str]:
    tokens = graph_split_tokens(*values)
    expanded: List[str] = []
    seen: Set[str] = set()
    for token in tokens:
        for item in [token, normalize_business_graph_key(token)]:
            clean = normalize_whitespace(item)
            if clean and clean not in seen:
                seen.add(clean)
                expanded.append(clean)
    return expanded[:80]


def detect_graph_role(name: str, rel: str = "") -> str:
    text = f"{name} {rel}".lower()
    if "list" in text or "列表" in text:
        return "list"
    if "add" in text or "create" in text or "新增" in text:
        return "add"
    if "edit" in text or "modify" in text or "编辑" in text or "修改" in text:
        return "edit"
    if "detail" in text or "view" in text or "详情" in text or "查看" in text:
        return "detail"
    if "rest" in text or "controller" in text:
        return "rest"
    return ""


def dedupe_text_list(items: Sequence[str], limit: int = 12) -> List[str]:
    results: List[str] = []
    seen: Set[str] = set()
    for item in items:
        clean = normalize_whitespace(item)
        if not clean:
            continue
        key = clean.lower()
        if key in seen:
            continue
        seen.add(key)
        results.append(clean)
        if len(results) >= limit:
            break
    return results


def humanize_graph_key(business_key: str) -> str:
    text = normalize_whitespace(str(business_key or "")).strip("-")
    if not text or text == "unknown":
        return "未命名业务"
    if re.search(r"[\u4e00-\u9fff]", text):
        return text.replace("-", "")
    return text.replace("-", " ")


def infer_graph_operation(method_name: str = "", role: str = "") -> str:
    role_text = normalize_whitespace(role).lower()
    if role_text in {"list", "add", "edit", "detail", "rest"}:
        return role_text
    lower_name = normalize_whitespace(method_name).lower()
    if not lower_name:
        return ""
    if re.match(r"^(find|get|query|select|load|list|page)", lower_name):
        return "query"
    if re.match(r"^(insert|add|save|create)", lower_name):
        return "add"
    if re.match(r"^(update|edit|modify)", lower_name):
        return "edit"
    if re.match(r"^(delete|remove)", lower_name):
        return "delete"
    if re.match(r"^(sync|import)", lower_name):
        return "sync"
    if re.match(r"^export", lower_name):
        return "export"
    if re.match(r"^(detail|view)", lower_name):
        return "detail"
    return ""


def build_graph_aliases(business_key: str, items: Sequence[Dict[str, object]], limit: int = 8) -> List[str]:
    raw_aliases: List[str] = [humanize_graph_key(business_key)]
    for item in items:
        for field in ["entityName", "tableName", "className", "interfaceName", "pageName", "summary"]:
            value = normalize_whitespace(item.get(field, ""))
            if field == "summary":
                value = clean_api_summary(value) or value
            if not value:
                continue
            lower_value = value.lower()
            if lower_value in GENERIC_TEXT_TOKENS or value in {"接口", "后台", "service接口", "service"}:
                continue
            raw_aliases.append(value)
            raw_aliases.extend(extract_business_terms(value, limit=4))
    return dedupe_text_list(raw_aliases, limit=limit)


def pick_graph_subject_alias(aliases: Sequence[str], fallback: str) -> str:
    for alias in aliases:
        if re.search(r"[\u4e00-\u9fff]", str(alias or "")):
            return str(alias)
    return aliases[0] if aliases else fallback


def build_graph_primary_actions(items: Sequence[Dict[str, object]], available_methods: Sequence[Dict[str, object]]) -> List[str]:
    actions: List[str] = []
    for item in items:
        operation = infer_graph_operation(role=str(item.get("role", "")))
        if operation:
            actions.append(operation)
    for method in available_methods:
        operation = infer_graph_operation(method_name=str(method.get("name", "")))
        if operation:
            actions.append(operation)
    return dedupe_text_list(actions, limit=8)


def describe_graph_action(action: str, subject: str) -> str:
    mapping = {
        "list": f"{subject}列表",
        "query": f"{subject}查询",
        "add": f"{subject}新增维护",
        "edit": f"{subject}编辑维护",
        "detail": f"{subject}详情查看",
        "delete": f"{subject}删除处理",
        "sync": f"{subject}同步导入",
        "export": f"{subject}导出处理",
        "rest": f"{subject}接口访问",
    }
    return mapping.get(action, f"{subject}{action}")


def build_graph_summary(
    business_key: str,
    aliases: Sequence[str],
    entities_payload: Sequence[Dict[str, object]],
    available_methods: Sequence[Dict[str, object]],
) -> str:
    entity_summary = next(
        (normalize_whitespace(item.get("summary", "")) for item in entities_payload if normalize_whitespace(item.get("summary", ""))),
        "",
    )
    if entity_summary:
        return entity_summary
    method_summary = next(
        (normalize_whitespace(item.get("summary", "")) for item in available_methods if normalize_whitespace(item.get("summary", ""))),
        "",
    )
    if method_summary:
        return method_summary
    subject = aliases[0] if aliases else humanize_graph_key(business_key)
    return f"{subject}相关业务"


def build_graph_capability_phrases(
    aliases: Sequence[str],
    primary_actions: Sequence[str],
    available_methods: Sequence[Dict[str, object]],
) -> List[str]:
    subject = pick_graph_subject_alias(aliases, "当前业务")
    phrases: List[str] = []
    for action in primary_actions:
        phrases.append(describe_graph_action(action, subject))
    for method in available_methods[:4]:
        summary = normalize_whitespace(method.get("summary", ""))
        if summary:
            phrases.append(summary)
    return dedupe_text_list(phrases, limit=8)


def build_graph_example_phrases(
    aliases: Sequence[str],
    capability_phrases: Sequence[str],
    primary_actions: Sequence[str],
) -> List[str]:
    subject = pick_graph_subject_alias(aliases, "当前业务")
    phrases: List[str] = []
    for capability in capability_phrases[:4]:
        phrases.append(capability)
    for action in primary_actions:
        phrased = describe_graph_action(action, subject)
        if phrased not in phrases:
            phrases.append(phrased)
    if subject:
        phrases.extend([
            f"{subject}增加字段调整",
            f"{subject}按条件筛选",
        ])
    return dedupe_text_list(phrases, limit=6)


def build_graph_natural_language_evidence(
    entities_payload: Sequence[Dict[str, object]],
    apis_payload: Sequence[Dict[str, object]],
    items: Sequence[Dict[str, object]],
    available_methods: Sequence[Dict[str, object]],
) -> List[str]:
    evidence: List[str] = []
    for entity in entities_payload[:2]:
        entity_name = normalize_whitespace(entity.get("entityName", ""))
        summary = normalize_whitespace(entity.get("summary", ""))
        if entity_name and summary:
            evidence.append(f"实体 {entity_name}: {summary}")
        elif entity_name:
            evidence.append(f"实体 {entity_name}")
    for api in apis_payload[:2]:
        interface_name = normalize_whitespace(api.get("interfaceName", ""))
        summary = normalize_whitespace(api.get("summary", ""))
        if interface_name and summary:
            evidence.append(f"接口 {interface_name}: {summary}")
        elif interface_name:
            evidence.append(f"接口 {interface_name}")
    for item in items[:2]:
        kind = normalize_whitespace(item.get("kind", ""))
        role = normalize_whitespace(item.get("role", ""))
        path_text = normalize_whitespace(item.get("path", ""))
        if kind and path_text:
            evidence.append(f"{kind}{f'({role})' if role else ''}: {path_text}")
    for method in available_methods[:2]:
        owner_name = normalize_whitespace(method.get("ownerName", ""))
        method_name = normalize_whitespace(method.get("name", ""))
        summary = normalize_whitespace(method.get("summary", ""))
        if owner_name and method_name:
            evidence.append(f"方法 {owner_name}.{method_name}: {summary or '历史方法'}")
    return dedupe_text_list(evidence, limit=8)


def build_graph_natural_language_payload(
    business_key: str,
    items: Sequence[Dict[str, object]],
    entities_payload: Sequence[Dict[str, object]],
    apis_payload: Sequence[Dict[str, object]],
    available_methods: Sequence[Dict[str, object]],
) -> Dict[str, object]:
    aliases = build_graph_aliases(business_key, items)
    primary_actions = build_graph_primary_actions(items, available_methods)
    primary_entities = dedupe_text_list(
        [normalize_whitespace(item.get("entityName", "")) for item in entities_payload],
        limit=6
    )
    summary = build_graph_summary(business_key, aliases, entities_payload, available_methods)
    capability_phrases = build_graph_capability_phrases(aliases, primary_actions, available_methods)
    example_phrases = build_graph_example_phrases(aliases, capability_phrases, primary_actions)
    evidence = build_graph_natural_language_evidence(entities_payload, apis_payload, items, available_methods)
    confidence = min(
        0.98,
        0.25
        + min(0.20, len(aliases) * 0.04)
        + min(0.20, len(capability_phrases) * 0.04)
        + (0.12 if summary else 0)
        + min(0.18, len(evidence) * 0.03)
    )
    return {
        "aliases": aliases,
        "summary": summary,
        "examplePhrases": example_phrases,
        "capabilityPhrases": capability_phrases,
        "primaryActions": primary_actions,
        "primaryEntities": primary_entities,
        "naturalLanguageConfidence": round(confidence, 2),
        "naturalLanguageEvidence": evidence,
    }


def parse_class_methods(java_text: str, class_name: str = "", kind: str = "") -> List[Dict[str, object]]:
    method_re = re.compile(
        r"(?s)(/\*\*.*?\*/[ \t]*|(?:(?:[ \t]*//[^\n]*\n)+)[ \t]*)?"
        r"(?:@\w+(?:\([^)]*\))?\s*)*"
        r"(?:public|protected)\s+"
        r"(?:static\s+)?"
        r"([A-Za-z0-9_<>\[\], ?.&]+?)\s+"
        r"([A-Za-z_][A-Za-z0-9_]*)\s*"
        r"\((.*?)\)\s*"
        r"(?:throws\s+[^{]+)?\{"
    )
    # Action / Rest 的 endpoint 方法可能合法地以 get/set 起头（如 getTaskListByCondition、setReadFlag），
    # 这是真实业务端点，不是 JavaBean accessor。只对其它类（ServiceImpl 等）过滤 get/set 噪音。
    skip_accessors = kind not in {"action", "rest"}
    methods: List[Dict[str, object]] = []
    for match in method_re.finditer(java_text):
        method_name = normalize_whitespace(match.group(3))
        if not method_name or method_name == class_name:
            continue
        if skip_accessors and method_name.startswith(("get", "set")):
            continue
        return_type = normalize_whitespace(match.group(2))
        raw_params = normalize_whitespace(match.group(4))
        methods.append({
            "name": method_name,
            "signature": f"{return_type} {method_name}({raw_params})",
            "summary": extract_method_comment_summary(match.group(1) or ""),
            "params": parse_method_params(raw_params),
            "returnType": return_type,
        })
    return methods[:80]


def build_graph_anchor(kind: str, path_text: str, **extra: object) -> Dict[str, object]:
    rel = str(path_text or "").replace("\\", "/")
    return {
        "id": f"{kind}:{rel}",
        "kind": kind,
        "path": rel,
        "storesSourceText": False,
        **extra,
    }


def build_asset_index_entry(
    asset_type: str,
    asset_id: str,
    business_key: str,
    title: str,
    source_path: str,
    tokens: Sequence[str],
    summary: str = "",
    extra: Optional[Dict[str, object]] = None,
) -> Dict[str, object]:
    payload = {
        "assetId": asset_id,
        "assetType": asset_type,
        "businessKey": business_key,
        "title": title,
        "summary": summary,
        "sourcePath": source_path,
        "assetTokens": list(dict.fromkeys([str(item) for item in tokens if str(item or "").strip()]))[:80],
    }
    if extra:
        payload.update(extra)
    return payload


def extract_java_class_name(text: str, fallback: str = "") -> str:
    match = re.search(r"\b(?:public\s+)?(?:class|interface)\s+([A-Za-z_][A-Za-z0-9_]*)\b", text or "")
    return match.group(1).strip() if match else fallback


def extract_mapping_paths(annotation_text: str) -> List[str]:
    text = str(annotation_text or "")
    paths: List[str] = []
    mapping_re = re.compile(
        r"@(?:RequestMapping|GetMapping|PostMapping|PutMapping|DeleteMapping|PatchMapping)\s*(?:\((.*?)\))?",
        re.S,
    )
    for match in mapping_re.finditer(text):
        args = match.group(1) or ""
        for path_match in re.finditer(r"(?:value\s*=\s*|path\s*=\s*)?(?:\{\s*)?[\"']([^\"']+)[\"']", args):
            candidate = normalize_whitespace(path_match.group(1))
            if candidate:
                paths.append(candidate)
                break
        if not args.strip():
            paths.append("")
    return dedupe_text_list(paths, limit=8)


def join_url_paths(*parts: str) -> str:
    clean_parts: List[str] = []
    for part in parts:
        text = normalize_whitespace(str(part or ""))
        if not text:
            continue
        clean_parts.append(text.strip("/"))
    if not clean_parts:
        return ""
    return "/" + "/".join(item for item in clean_parts if item)


def find_matching_brace(text: str, open_index: int, max_chars: int = 180000) -> int:
    depth = 0
    in_string = ""
    escaped = False
    end_limit = min(len(text), open_index + max_chars)
    for idx in range(open_index, end_limit):
        ch = text[idx]
        if in_string:
            if escaped:
                escaped = False
            elif ch == "\\":
                escaped = True
            elif ch == in_string:
                in_string = ""
            continue
        if ch in {"\"", "'"}:
            in_string = ch
            continue
        if ch == "{":
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth <= 0:
                return idx
    return end_limit


def extract_service_calls(text: str, limit: int = 8) -> List[str]:
    calls: List[str] = []
    seen: Set[str] = set()
    for match in re.finditer(r"\b([a-z][A-Za-z0-9_]*(?:Service|Manager|Dao|Mapper))\.([A-Za-z_][A-Za-z0-9_]*)\s*\(", text or ""):
        call = f"{match.group(1)}.{match.group(2)}"
        if call not in seen:
            seen.add(call)
            calls.append(call)
            if len(calls) >= limit:
                break
    return calls


def parse_controller_method_assets(
    root: Path,
    java_file: Path,
    text: str,
    max_methods_per_file: int = 40,
) -> List[Dict[str, object]]:
    rel = safe_rel(java_file, root)
    package_name = extract_package(text)
    class_name = extract_java_class_name(text, java_file.stem)
    class_prefix_text = text[: max(0, text.find(class_name))] if class_name and class_name in text else text[:5000]
    class_paths = extract_mapping_paths(class_prefix_text)
    if not class_paths:
        class_paths = [""]

    method_re = re.compile(
        r"(?s)((?:\s*@(?:RequestMapping|GetMapping|PostMapping|PutMapping|DeleteMapping|PatchMapping)\s*(?:\([^)]*\))?\s*)+)"
        r"(?:public|protected|private)?\s*(?:static\s+)?(?:final\s+)?"
        r"([A-Za-z0-9_<>\[\], ?.&]+?)\s+"
        r"([A-Za-z_][A-Za-z0-9_]*)\s*"
        r"\((.*?)\)\s*(?:throws\s+[^{]+)?\{"
    )
    assets: List[Dict[str, object]] = []
    for match in method_re.finditer(text):
        if len(assets) >= max_methods_per_file:
            break
        annotations = match.group(1) or ""
        return_type = normalize_whitespace(match.group(2))
        method_name = normalize_whitespace(match.group(3))
        params_text = normalize_whitespace(match.group(4))
        body_start = match.end() - 1
        body_end = find_matching_brace(text, body_start)
        method_body = text[body_start:body_end + 1]
        return_patterns = detect_rest_return_patterns(method_body)
        primary_return = primary_rest_pattern(Counter(return_patterns))
        method_paths = extract_mapping_paths(annotations) or [""]
        urls = [join_url_paths(class_path, method_path) for class_path in class_paths for method_path in method_paths]
        urls = dedupe_text_list(urls, limit=6)
        service_calls = extract_service_calls(method_body, limit=8)
        keywords = dedupe_text_list(
            [class_name, method_name, *urls, *service_calls, primary_return, rel],
            limit=16,
        )
        summary = f"{class_name}.{method_name}"
        if urls:
            summary += f"；URL: {urls[0]}"
        if primary_return:
            summary += f"；return: {primary_return}"
        if service_calls:
            summary += f"；调用: {', '.join(service_calls[:3])}"
        assets.append({
            "assetId": f"api:{class_name}.{method_name}",
            "assetType": "project_api_asset",
            "title": f"{class_name}.{method_name}",
            "summary": summary[:300],
            "intentKeywords": keywords,
            "assetTokens": build_asset_tokens(*keywords),
            "sourcePath": rel,
            "sourceFile": rel,
            "packageName": package_name,
            "controllerName": class_name,
            "methodName": method_name,
            "signature": f"{return_type} {method_name}({params_text})",
            "urls": urls,
            "returnPattern": primary_return,
            "returnPatterns": return_patterns,
            "serviceCalls": service_calls,
            "referencePolicy": "context_only",
            "matchLane": "project_api_asset",
            "reuseAdvice": "命中后优先复用现有 Controller/API 语义；代码落点仍以工程导航契约为准。",
            "status": "partial",
        })
    return assets


def build_asset_index_lite(
    root: Path,
    max_java_files: int = 1200,
    max_assets: int = 200,
) -> Dict[str, object]:
    assets: List[Dict[str, object]] = []
    scanned_java_files = 0
    scanned_controller_files = 0
    stopped_early = False
    records = scan_poms(root, DEFAULT_MAX_POM_FILES)
    scans_map = scan_modules(root, records, max_java_files, DEFAULT_MAX_HTML_FILES)
    for java_file in iter_business_java_files(root, scans_map, max_java_files):
        scanned_java_files += 1
        text = read_rest_scan_text(java_file)
        if not is_rest_controller_candidate(java_file, text):
            continue
        scanned_controller_files += 1
        assets.extend(parse_controller_method_assets(root, java_file, text))
        if len(assets) >= max_assets:
            assets = assets[:max_assets]
            stopped_early = True
            break
    return {
        "generatedAt": datetime.now().isoformat(timespec="seconds"),
        "projectPath": str(root),
        "version": 2,
        "source": "python-asset-index-lite",
        "assetIndex": assets,
        "stats": {
            "assetIndexCount": len(assets),
            "scannedJavaFiles": scanned_java_files,
            "scannedControllerFiles": scanned_controller_files,
            "stoppedEarly": stopped_early,
            "status": "partial" if stopped_early else "verified",
        },
    }


def write_asset_index_lite_output(root: Path, payload: Dict[str, object]) -> Dict[str, str]:
    structure_dir = project_artifact_dir(root)
    structure_dir.mkdir(parents=True, exist_ok=True)
    asset_index_path = structure_dir / "asset-index.json"
    existing_items: List[Dict[str, object]] = []
    if asset_index_path.exists():
        try:
            existing_payload = json.loads(asset_index_path.read_text(encoding="utf-8"))
            if isinstance(existing_payload, dict) and isinstance(existing_payload.get("assetIndex"), list):
                existing_items = [item for item in existing_payload["assetIndex"] if isinstance(item, dict)]
        except Exception:
            existing_items = []

    merged: Dict[str, Dict[str, object]] = {}
    for item in existing_items:
        asset_id = normalize_whitespace(str(item.get("assetId", "")))
        if asset_id:
            merged[asset_id] = item
    for item in payload.get("assetIndex", []) if isinstance(payload.get("assetIndex"), list) else []:
        asset_id = normalize_whitespace(str(item.get("assetId", "")))
        if asset_id:
            merged[asset_id] = item

    asset_items = sorted(merged.values(), key=lambda item: str(item.get("assetId", "")))
    output_payload = {
        "generatedAt": payload.get("generatedAt", ""),
        "projectPath": payload.get("projectPath", str(root)),
        "version": payload.get("version", 2),
        "source": payload.get("source", "python-asset-index-lite"),
        "assetIndex": asset_items,
        "stats": {
            **(payload.get("stats", {}) if isinstance(payload.get("stats"), dict) else {}),
            "assetIndexCount": len(asset_items),
        },
    }
    asset_index_path.write_text(json.dumps(output_payload, indent=2, ensure_ascii=False), encoding="utf-8")
    return {
        "assetIndexPath": str(asset_index_path),
        "assetIndexCount": str(len(asset_items)),
        "source": str(output_payload.get("source", "")),
    }


# ── Coder 复用卡指路索引（code-reuse-index）──────────────────────────────────
# 故事线：Coder 改已有 Action 要调 Service 时看不见调用目标有什么方法、又禁搜，于是瞎猜/重造。
# 本索引只做「指路」——存「Action 注入哪几个 Service 接口」「接口→精确路径 + sourceKind」
# 「HtmlPage epoint.execute('key') → 管理端 Action」，**只存路径不存方法签名**（方法 Coder 现读活源码）。
# 设计依据见 .planning/2026-06-01-coder-reuse-card/findings.md §8。

# @Autowired private IXxxService field;（字段注入，可多个；不抓方法体内调用）
AUTOWIRED_SERVICE_FIELD_RE = re.compile(
    r"@(?:Autowired|Resource)\b[^;{}]*?\b(I[A-Z][A-Za-z0-9_]*Service)\s+([a-z][A-Za-z0-9_]*)\s*;",
    re.S,
)
# epoint.initPage('xxxaction') —— HtmlPage 绑定的后台 Action（真实 route 绑定点；
# epoint.execute('method') 只调已绑定 action 的方法，不带 action key，故 route 边以 initPage 为准）
EPOINT_INITPAGE_RE = re.compile(r"""epoint\.initPage\s*\(\s*['"]([a-zA-Z0-9_]+)['"]""")
# epoint.execute('key/method') / epoint.execute('key:method') 指向明确 Action 方法。
EPOINT_EXECUTE_RE = re.compile(r"""epoint\.execute\s*\(\s*['"]([^'"]+)['"]""")


def extract_injected_services(text: str) -> List[Dict[str, str]]:
    """抽 Action / RestController 里的 @Autowired private IXxxService 字段（接口类型 + 字段名）。"""
    services: List[Dict[str, str]] = []
    seen: Set[str] = set()
    for match in AUTOWIRED_SERVICE_FIELD_RE.finditer(text or ""):
        interface_name = match.group(1).strip()
        field_name = match.group(2).strip()
        key = f"{interface_name}::{field_name}"
        if interface_name and key not in seen:
            seen.add(key)
            services.append({"interfaceName": interface_name, "fieldName": field_name})
    return services


def extract_rest_controller_key(text: str) -> str:
    """管理端 Action 的 @RestController("key") 命名 value；RestController 用 @RequestMapping("/path") 不在此列。"""
    match = re.search(r"""@RestController\s*\(\s*['"]([a-zA-Z0-9_]+)['"]\s*\)""", text or "")
    return match.group(1).strip() if match else ""


def extract_java_import_map(text: str) -> Dict[str, str]:
    imports: Dict[str, str] = {}
    for match in re.finditer(r"^\s*import\s+([\w\.]+)\s*;", text or "", re.M):
        qualified = match.group(1).strip()
        if not qualified or qualified.endswith(".*"):
            continue
        simple = qualified.rsplit(".", 1)[-1]
        if simple and simple not in imports:
            imports[simple] = qualified
    return imports


def resolve_import_source_path(root: Path, scans_map: Dict[Path, ModuleScan], qualified_name: str) -> str:
    qualified = str(qualified_name or "").strip()
    if not qualified or "." not in qualified:
        return ""
    rel_parts = qualified.split(".")
    rel_parts[-1] = f"{rel_parts[-1]}.java"
    module_dirs = sorted(scans_map.keys(), key=lambda p: (safe_rel(p, root).count("/"), len(safe_rel(p, root))))
    for module_dir in module_dirs:
        candidate = module_dir.joinpath("src", "main", "java", *rel_parts)
        if candidate.exists() and candidate.is_file() and not should_ignore(candidate, root):
            return safe_rel(candidate, root)
    return ""


def find_matching_brace(text: str, open_index: int) -> int:
    depth = 0
    in_string = ""
    escaped = False
    i = open_index
    while i < len(text):
        ch = text[i]
        if in_string:
            if escaped:
                escaped = False
            elif ch == "\\":
                escaped = True
            elif ch == in_string:
                in_string = ""
        else:
            if ch in {"'", '"'}:
                in_string = ch
            elif ch == "{":
                depth += 1
            elif ch == "}":
                depth -= 1
                if depth == 0:
                    return i
        i += 1
    return -1


def extract_action_method_body(java_text: str, method_name: str) -> Dict[str, object]:
    name = str(method_name or "").strip()
    if not name:
        return {}
    method_re = re.compile(
        r"(?s)(?:/\*\*.*?\*/[ \t]*|(?:(?:[ \t]*//[^\n]*\n)+)[ \t]*)?"
        r"(?:@\w+(?:\([^)]*\))?\s*)*"
        r"(?:public|protected)\s+"
        r"(?:static\s+)?"
        r"([A-Za-z0-9_<>\[\], ?.&]+?)\s+"
        + re.escape(name) +
        r"\s*\((.*?)\)\s*"
        r"(?:throws\s+[^{]+)?\{"
    )
    match = method_re.search(java_text or "")
    if not match:
        return {}
    open_index = match.end() - 1
    close_index = find_matching_brace(java_text, open_index)
    if close_index < 0:
        return {}
    return {
        "methodName": name,
        "returnType": normalize_whitespace(match.group(1)),
        "params": parse_method_params(normalize_whitespace(match.group(2))),
        "body": java_text[open_index + 1:close_index],
    }


def parse_epoint_execute_target(raw_value: str) -> Dict[str, str]:
    raw = str(raw_value or "").strip()
    if not raw:
        return {"routeKey": "", "methodName": "", "binding": "", "executeTarget": ""}
    if "/" in raw:
        route_key, method_name = raw.split("/", 1)
        return {
            "routeKey": route_key.strip(),
            "methodName": method_name.strip(),
            "binding": "execute_path",
            "executeTarget": raw,
        }
    if ":" in raw:
        route_key, method_name = raw.split(":", 1)
        return {
            "routeKey": route_key.strip(),
            "methodName": method_name.strip(),
            "binding": "execute_key_method",
            "executeTarget": raw,
        }
    return {
        "routeKey": "",
        "methodName": raw,
        "binding": "execute_page_method",
        "executeTarget": raw,
    }


def extract_callback_params(method_body: str) -> List[str]:
    return list(dict.fromkeys(
        match.group(1).strip()
        for match in re.finditer(r"""addCallbackParam\s*\(\s*['"]([^'"]+)['"]""", method_body or "")
        if match.group(1).strip()
    ))[:12]


def extract_json_field_keys(method_body: str) -> List[str]:
    pattern = r"""get(?:String|JSONObject|JSONArray|IntValue|LongValue|BooleanValue|DoubleValue)\s*\(\s*['"]([^'"]+)['"]"""
    return list(dict.fromkeys(
        match.group(1).strip()
        for match in re.finditer(pattern, method_body or "")
        if match.group(1).strip()
    ))[:16]


def parse_entity_info_from_source(text: str, class_name: str, source_path: str) -> Dict[str, str]:
    if not re.search(r"\bextends\s+BaseEntity\b|\b@Entity\s*\(", text or ""):
        return {}
    table_match = re.search(r"""@Entity\s*\([^)]*table\s*=\s*['"]([^'"]+)['"]""", text or "")
    return {
        "entityName": class_name,
        "tableName": table_match.group(1).strip() if table_match else "",
        "sourcePath": source_path,
    }


def build_action_method_slice(
    root: Path,
    scans_map: Dict[Path, ModuleScan],
    action: Dict[str, object],
    action_detail: Dict[str, object],
    edge: Dict[str, object],
    service_by_name: Dict[str, Dict[str, object]],
) -> Dict[str, object]:
    method_name = str(edge.get("methodName", "") or "").strip()
    java_text = str(action_detail.get("text", "") or "")
    method = extract_action_method_body(java_text, method_name)
    if not method:
        return {}
    body = str(method.get("body", "") or "")
    import_map = action_detail.get("importMap", {}) if isinstance(action_detail.get("importMap"), dict) else {}
    injected = action.get("injectedServices", []) if isinstance(action.get("injectedServices"), list) else []
    service_by_field = {
        str(item.get("fieldName", "") or "").strip(): str(item.get("interfaceName", "") or "").strip()
        for item in injected
        if str(item.get("fieldName", "") or "").strip() and str(item.get("interfaceName", "") or "").strip()
    }

    direct_calls: List[Dict[str, object]] = []
    seen_calls: Set[str] = set()

    def push_call(item: Dict[str, object]) -> None:
        owner = str(item.get("ownerName", "") or "").strip()
        method = str(item.get("methodName", "") or "").strip()
        call_type = str(item.get("callType", "") or "").strip()
        if not owner or not method or not call_type:
            return
        key = f"{call_type}::{owner}::{method}::{item.get('sourcePath', '')}::{item.get('fieldName', '')}"
        if key in seen_calls:
            return
        seen_calls.add(key)
        direct_calls.append(item)

    for match in re.finditer(r"\b([A-Z][A-Za-z0-9_]*)\.([a-zA-Z_][A-Za-z0-9_]*)\s*\(", body):
        owner_name = match.group(1).strip()
        called_method = match.group(2).strip()
        qualified = str(import_map.get(owner_name, "") or "").strip()
        source_path = resolve_import_source_path(root, scans_map, qualified) if qualified else ""
        if not source_path:
            continue
        push_call({
            "callType": "static_imported",
            "ownerName": owner_name,
            "methodName": called_method,
            "sourcePath": source_path,
        })

    for field_name, interface_name in service_by_field.items():
        field_re = re.compile(r"\b" + re.escape(field_name) + r"\.([a-zA-Z_][A-Za-z0-9_]*)\s*\(")
        for match in field_re.finditer(body):
            called_method = match.group(1).strip()
            service = service_by_name.get(interface_name, {})
            item = {
                "callType": "injected_service",
                "ownerName": interface_name,
                "fieldName": field_name,
                "methodName": called_method,
                "sourceKind": str(service.get("sourceKind", "") or "framework_unresolved"),
            }
            if str(service.get("sourcePath", "") or "").strip():
                item["sourcePath"] = str(service.get("sourcePath", "") or "").strip()
            if str(service.get("ruleAlias", "") or "").strip():
                item["ruleAlias"] = str(service.get("ruleAlias", "") or "").strip()
            push_call(item)

    related_entities: List[Dict[str, str]] = []
    seen_entities: Set[str] = set()
    for class_name, qualified in import_map.items():
        if not re.search(r"\b(new\s+)?" + re.escape(class_name) + r"\b", body):
            continue
        source_path = resolve_import_source_path(root, scans_map, qualified)
        if not source_path:
            continue
        source_abs = root / source_path
        try:
            source_text = source_abs.read_text(encoding="utf-8", errors="ignore")
        except Exception:
            continue
        entity = parse_entity_info_from_source(source_text, class_name, source_path)
        if not entity:
            continue
        key = f"{entity.get('entityName', '')}::{entity.get('sourcePath', '')}"
        if key in seen_entities:
            continue
        seen_entities.add(key)
        related_entities.append(entity)

    evidence = [
        f"HtmlPage: {edge.get('htmlPage', '')}" if edge.get("htmlPage") else "",
        f"Action: {action.get('sourcePath', '')}",
        f"Method: {action.get('className', '')}.{method_name}",
    ]

    return {
        "htmlPage": str(edge.get("htmlPage", "") or ""),
        "frontendCall": str(edge.get("executeTarget", "") or ""),
        "routeKey": str(edge.get("routeKey", "") or ""),
        "binding": str(edge.get("binding", "") or ""),
        "actionClass": str(action.get("className", "") or ""),
        "actionPath": str(action.get("sourcePath", "") or ""),
        "methodName": method_name,
        "directCalls": direct_calls[:16],
        "relatedEntities": related_entities[:12],
        "callbackParams": extract_callback_params(body),
        "responseFields": extract_json_field_keys(body),
        "evidence": [item for item in evidence if item],
    }


def build_code_reuse_index(
    root: Path,
    scans_map: Dict[Path, ModuleScan],
    max_java_files: int,
    max_html_files: int,
) -> Dict[str, object]:
    """构建 Coder 复用卡指路索引：actions / serviceInterfaces / routeEdges / actionMethodSlices。

    性能：用文件名预筛三类目标（*Action.java / *Controller.java / I*Service.java），
    Util/Entity 只在 Action 方法体出现精确 import 时按包名定位读取。
    正确性：Action 引用的 Service 接口若工程内无源码（公司框架/跨 Maven 模块），
    仍在 serviceInterfaces 建 framework_unresolved 条目 + ruleAlias，避免在 reuseCard 视野中"消失"。
    """
    actions: List[Dict[str, object]] = []
    service_interfaces: List[Dict[str, object]] = []
    interface_seen: Set[str] = set()
    referenced_interfaces: Set[str] = set()
    source_files: List[str] = []
    action_details: Dict[str, Dict[str, object]] = {}

    # 1. 扫 Service 接口（按文件名预筛 I*Service.java，不读其它 java）
    for java_file in iter_business_source_files(root, scans_map, ("src", "main", "java"), "I*Service.java", max_java_files):
        parsed = parse_java_file_with_fallback(java_file)
        text = parsed["text"]
        if not re.search(r"\bpublic\s+interface\b", text):
            continue
        signature = parse_interface_signature(text)
        interface_name = str(signature.get("interface_name", "")).strip()
        if not interface_name or not SERVICE_INTERFACE_RE.match(interface_name) or interface_name in interface_seen:
            continue
        interface_seen.add(interface_name)
        rel = safe_rel(java_file, root)
        module_name, _ = find_owner_module(java_file, scans_map, root)
        service_interfaces.append({
            "interfaceName": interface_name,
            "sourcePath": rel,
            "packageName": parsed["package_name"],
            "moduleName": module_name,
            "sourceKind": "project_source",
            "summary": str(signature.get("summary", "") or ""),
        })
        source_files.append(rel)

    # 2. 扫 Action / RestController（按文件名预筛 *Action.java + *Controller.java）
    action_seen: Set[Path] = set()
    for action_pattern in ("*Action.java", "*Controller.java"):
        for java_file in iter_business_source_files(root, scans_map, ("src", "main", "java"), action_pattern, max_java_files):
            resolved = java_file.resolve()
            if resolved in action_seen:
                continue
            action_seen.add(resolved)
            parsed = parse_java_file_with_fallback(java_file)
            text = parsed["text"]
            rel = safe_rel(java_file, root)
            kind = detect_java_kind(java_file, parsed["package_name"], text[:5000], rel)
            if kind not in {"action", "rest"}:
                continue
            class_name = extract_java_class_name(text, java_file.stem)
            injected = extract_injected_services(text)
            rest_key = extract_rest_controller_key(text) if kind == "action" else ""
            actions.append({
                "className": class_name,
                "sourcePath": rel,
                "kind": kind,
                "restControllerKey": rest_key,
                "injectedServices": injected,
            })
            action_details[rel] = {
                "text": text,
                "importMap": extract_java_import_map(text),
            }
            source_files.append(rel)
            for inj in injected:
                referenced = str(inj.get("interfaceName", "") or "").strip()
                if referenced:
                    referenced_interfaces.add(referenced)

    # 3. 补"被引用但工程无源码"的 Service：框架/跨模块接口在 reuseCard 阶段走 ruleAlias，
    #    不能让它在 serviceInterfaces 里消失（否则 Coder 看不见 = 又回到瞎猜的盲区）。
    for ref_name in sorted(referenced_interfaces - interface_seen):
        service_interfaces.append({
            "interfaceName": ref_name,
            "sourcePath": "",
            "packageName": "",
            "moduleName": "",
            "sourceKind": "framework_unresolved",
            "ruleAlias": f"{ref_name}接口使用规范",
            "summary": "",
        })

    # routeEdges：HtmlPage → 管理端 Action。覆盖 initPage('key')、execute('key/method')、
    # execute('key:method') 以及 initPage 后 execute('method')。
    key_to_action: Dict[str, Dict[str, str]] = {}
    for action in actions:
        rest_key = str(action.get("restControllerKey", "")).strip()
        if rest_key:
            key_to_action[rest_key] = action
    route_edges: List[Dict[str, object]] = []
    edge_seen: Set[str] = set()
    for html_file in iter_business_html_files(root, scans_map, max_html_files):
        try:
            html_text = html_file.read_text(encoding="utf-8", errors="ignore")
        except Exception:
            continue
        html_rel = safe_rel(html_file, root)
        html_has_edge = False
        init_keys: List[str] = []
        page_keys: List[Dict[str, str]] = []
        for match in EPOINT_INITPAGE_RE.finditer(html_text):
            route_key = match.group(1).strip()
            init_keys.append(route_key)
            page_keys.append({
                "routeKey": route_key,
                "methodName": "",
                "binding": "initPage",
                "executeTarget": "",
            })
        for match in EPOINT_EXECUTE_RE.finditer(html_text):
            parsed = parse_epoint_execute_target(match.group(1).strip())
            if parsed["routeKey"]:
                page_keys.append(parsed)
            elif parsed["methodName"] and init_keys:
                for init_key in init_keys:
                    page_keys.append({
                        "routeKey": init_key,
                        "methodName": parsed["methodName"],
                        "binding": parsed["binding"],
                        "executeTarget": parsed["executeTarget"],
                    })
        for route in page_keys:
            route_key = route["routeKey"]
            method_name = route["methodName"]
            binding = route["binding"]
            action = key_to_action.get(route_key)
            if not action:
                continue
            edge_key = f"{html_rel}::{route_key}::{method_name}::{binding}::{action.get('className', '')}"
            if edge_key in edge_seen:
                continue
            edge_seen.add(edge_key)
            route_edges.append({
                "htmlPage": html_rel,
                "routeKey": route_key,
                "methodName": method_name,
                "binding": binding,
                "executeTarget": route["executeTarget"],
                "actionClass": str(action.get("className", "")),
                "actionPath": str(action.get("sourcePath", "")),
            })
            html_has_edge = True
        if html_has_edge:
            source_files.append(html_rel)

    service_by_name = {
        str(item.get("interfaceName", "") or "").strip(): item
        for item in service_interfaces
        if str(item.get("interfaceName", "") or "").strip()
    }
    action_by_path = {
        str(item.get("sourcePath", "") or "").strip(): item
        for item in actions
        if str(item.get("sourcePath", "") or "").strip()
    }
    action_method_slices: List[Dict[str, object]] = []
    slice_seen: Set[str] = set()
    for edge in route_edges:
        method_name = str(edge.get("methodName", "") or "").strip()
        action_path = str(edge.get("actionPath", "") or "").strip()
        if not method_name or not action_path:
            continue
        action = action_by_path.get(action_path)
        detail = action_details.get(action_path, {})
        if not action or not detail:
            continue
        slice_item = build_action_method_slice(root, scans_map, action, detail, edge, service_by_name)
        if not slice_item:
            continue
        key = f"{slice_item.get('htmlPage', '')}::{slice_item.get('actionPath', '')}::{slice_item.get('methodName', '')}"
        if key in slice_seen:
            continue
        slice_seen.add(key)
        action_method_slices.append(slice_item)
        for call in slice_item.get("directCalls", []) if isinstance(slice_item.get("directCalls"), list) else []:
            if isinstance(call, dict) and str(call.get("sourcePath", "") or "").strip():
                source_files.append(str(call.get("sourcePath", "") or "").strip())
        for entity in slice_item.get("relatedEntities", []) if isinstance(slice_item.get("relatedEntities"), list) else []:
            if isinstance(entity, dict) and str(entity.get("sourcePath", "") or "").strip():
                source_files.append(str(entity.get("sourcePath", "") or "").strip())

    actions.sort(key=lambda item: str(item.get("className", "")))
    service_interfaces.sort(key=lambda item: str(item.get("interfaceName", "")))
    route_edges.sort(key=lambda item: (str(item.get("routeKey", "")), str(item.get("htmlPage", ""))))
    action_method_slices.sort(key=lambda item: (
        str(item.get("htmlPage", "")),
        str(item.get("actionClass", "")),
        str(item.get("methodName", "")),
    ))

    return {
        "schemaVersion": "code-reuse-index/v1",
        "generatedAt": datetime.now().isoformat(timespec="seconds"),
        "actions": actions,
        "serviceInterfaces": service_interfaces,
        "routeEdges": route_edges,
        "actionMethodSlices": action_method_slices,
        "_sourceFiles": sorted(set(source_files)),
    }


def write_code_reuse_index_output(root: Path, index: Dict[str, object]) -> Dict[str, str]:
    """落盘 code-reuse-index.json + code-reuse-index-receipt.json（文件级新鲜度）。"""
    structure_dir = project_artifact_dir(root)
    structure_dir.mkdir(parents=True, exist_ok=True)
    index_path = structure_dir / "code-reuse-index.json"
    receipt_path = structure_dir / "code-reuse-index-receipt.json"

    source_files = index.pop("_sourceFiles", []) if isinstance(index.get("_sourceFiles"), list) else []
    index_path.write_text(json.dumps(index, indent=2, ensure_ascii=False), encoding="utf-8")

    actions = index.get("actions", []) if isinstance(index.get("actions"), list) else []
    service_interfaces = index.get("serviceInterfaces", []) if isinstance(index.get("serviceInterfaces"), list) else []
    route_edges = index.get("routeEdges", []) if isinstance(index.get("routeEdges"), list) else []
    node_count = len(actions) + len(service_interfaces)
    edge_count = len(route_edges)
    content_hash = hashlib.sha256(index_path.read_bytes()).hexdigest()
    receipt = {
        "schemaVersion": "code-reuse-index-receipt/v1",
        "generatedAt": index.get("generatedAt", datetime.now().isoformat(timespec="seconds")),
        "indexPath": str(index_path),
        "nodeCount": node_count,
        "edgeCount": edge_count,
        "actionCount": len(actions),
        "serviceInterfaceCount": len(service_interfaces),
        "routeEdgeCount": edge_count,
        "sourceFiles": source_files,
        "contentHash": content_hash,
    }
    receipt_path.write_text(json.dumps(receipt, indent=2, ensure_ascii=False), encoding="utf-8")
    return {
        "codeReuseIndexPath": str(index_path),
        "codeReuseIndexReceiptPath": str(receipt_path),
        "nodeCount": str(node_count),
        "edgeCount": str(edge_count),
    }


def scan_graph_java_anchors(
    root: Path,
    scans_map: Dict[Path, ModuleScan],
    max_java_files: int,
) -> List[Dict[str, object]]:
    cache = getattr(scan_graph_java_anchors, "_cache", None)
    if cache is None:
        cache = {}
        scan_graph_java_anchors._cache = cache
    cache_key = (id(scans_map), max_java_files)
    if cache_key in cache:
        return cache[cache_key]

    anchors: List[Dict[str, object]] = []
    class_re = re.compile(r"\b(?:class|interface)\s+([A-Za-z_][A-Za-z0-9_]*)\b")
    implements_re = re.compile(r"\bimplements\s+([A-Za-z0-9_,\s<>]+)\{", re.S)

    for java_file in iter_business_java_files(root, scans_map, max_java_files):
        parsed = parse_java_file_with_fallback(java_file)
        text = parsed["text"]
        rel = safe_rel(java_file, root)
        pkg = parsed["package_name"]
        kind = detect_java_kind(java_file, pkg, text[:5000], rel)
        if kind not in {"action", "rest", "service_impl"}:
            continue
        class_match = class_re.search(text)
        class_name = class_match.group(1).strip() if class_match else Path(rel).stem
        module_name, module_rel = find_owner_module(java_file, scans_map, root)
        # 把 kind 透传给 parse_class_methods：Action/Rest 的 endpoint 不过滤 get/set 起头的方法名
        # （之前 GxhWzmTaskController.getTaskListByCondition 被误过滤导致 anchor.methods=[]）。
        method_list = parse_class_methods(text, class_name, kind=kind)
        implemented = []
        impl_match = implements_re.search(text)
        if impl_match:
            implemented = [
                normalize_whitespace(re.sub(r"<.*?>", "", item))
                for item in impl_match.group(1).split(",")
                if normalize_whitespace(item)
            ]
        graph_kind = {
            "action": "Action",
            "rest": "Rest",
            "service_impl": "ServiceImpl",
        }.get(kind, "")
        if not graph_kind:
            continue
        business_key = normalize_business_graph_key(class_name)
        anchors.append(build_graph_anchor(
            graph_kind,
            rel,
            className=class_name,
            packageName=pkg,
            moduleName=module_name,
            moduleDir=module_rel,
            businessKey=business_key,
            role=detect_graph_role(class_name, rel),
            methodNames=[str(item.get("name", "")).strip() for item in method_list if str(item.get("name", "")).strip()],
            methods=enrich_method_summaries(
                methods=method_list,
                interface_summary="",
                entity_names=[],
                table_names=[],
            ),
            implements=implemented,
            tokens=graph_split_tokens(class_name, rel, pkg),
        ))
    cache[cache_key] = anchors
    return anchors


def scan_graph_page_anchors(root: Path, scans_map: Dict[Path, ModuleScan], max_html_files: int) -> List[Dict[str, object]]:
    cache = getattr(scan_graph_page_anchors, "_cache", None)
    if cache is None:
        cache = {}
        scan_graph_page_anchors._cache = cache
    cache_key = (id(scans_map), max_html_files)
    if cache_key in cache:
        return cache[cache_key]

    anchors: List[Dict[str, object]] = []
    for html_file in iter_business_html_files(root, scans_map, max_html_files):
        rel = safe_rel(html_file, root)
        basename = html_file.stem
        business_key = normalize_business_graph_key(basename)
        anchors.append(build_graph_anchor(
            "HtmlPage",
            rel,
            pageName=basename,
            businessKey=business_key,
            role=detect_graph_role(basename, rel),
            tokens=graph_split_tokens(basename, rel),
        ))
    cache[cache_key] = anchors
    return anchors


def build_business_graph(
    root: Path,
    records: Sequence[PomRecord],
    max_java_files: int,
    max_html_files: int,
    scans_map: Optional[Dict[Path, ModuleScan]] = None,
) -> Dict[str, object]:
    if scans_map is None:
        scans_map = scan_modules(root, records, max_java_files, max_html_files)
    entities = scan_entity_records(root, scans_map, max_java_files)
    entity_lookup = build_entity_lookup(entities)
    interfaces = scan_public_interfaces(root, scans_map, entity_lookup, max_java_files)
    anchors: List[Dict[str, object]] = []
    asset_index: List[Dict[str, object]] = []

    for entity in entities:
        business_key = normalize_business_graph_key(entity.entity_name)
        asset_tokens = build_asset_tokens(entity.entity_name, entity.table_name, entity.summary, entity.source_file)
        anchors.append(build_graph_anchor(
            "Entity",
            entity.source_file,
            entityName=entity.entity_name,
            packageName=entity.package_name,
            moduleName=entity.module_name,
            tableName=entity.table_name,
            summary=entity.summary,
            fields=entity.fields or [],
            businessKey=business_key,
            tokens=graph_split_tokens(entity.entity_name, entity.table_name, entity.summary, entity.source_file),
            assetTokens=asset_tokens,
        ))
        asset_index.append(build_asset_index_entry(
            "entity",
            f"entity:{entity.entity_name}",
            business_key,
            entity.entity_name,
            entity.source_file,
            asset_tokens,
            entity.summary,
            {"tableName": entity.table_name, "entityName": entity.entity_name},
        ))

    for api in interfaces:
        entity_names = api.get("entityNames", []) if isinstance(api.get("entityNames"), list) else []
        table_names = api.get("tableNames", []) if isinstance(api.get("tableNames"), list) else []
        business_key = normalize_business_graph_key(entity_names[0] if entity_names else str(api.get("interfaceName", "")))
        api_tokens = build_asset_tokens(
            str(api.get("interfaceName", "")),
            str(api.get("summary", "")),
            " ".join(str(item) for item in entity_names),
            " ".join(str(item) for item in table_names),
            str(api.get("sourceFile", "")),
        )
        anchors.append(build_graph_anchor(
            "ServiceApi",
            str(api.get("sourceFile", "")),
            interfaceName=api.get("interfaceName", ""),
            packageName=api.get("packageName", ""),
            moduleName=api.get("moduleName", ""),
            businessKey=business_key,
            entityNames=entity_names,
            tableNames=table_names,
            summary=api.get("summary", ""),
            methodNames=api.get("methodNames", []),
            methods=api.get("methods", []),
            tableStructures=api.get("tableStructures", []),
            tokens=graph_split_tokens(
                str(api.get("interfaceName", "")),
                str(api.get("summary", "")),
                " ".join(str(item) for item in entity_names),
                " ".join(str(item) for item in table_names),
                str(api.get("sourceFile", "")),
            ),
            assetTokens=api_tokens,
        ))
        asset_index.append(build_asset_index_entry(
            "service_api",
            f"service-api:{api.get('interfaceName', '')}",
            business_key,
            str(api.get("interfaceName", "")),
            str(api.get("sourceFile", "")),
            api_tokens,
            str(api.get("summary", "")),
            {"entityNames": entity_names, "tableNames": table_names, "methodNames": api.get("methodNames", [])},
        ))
        for method in api.get("methods", []) if isinstance(api.get("methods"), list) else []:
            method_name = str(method.get("name", "")).strip() if isinstance(method, dict) else ""
            if not method_name:
                continue
            method_tokens = build_asset_tokens(
                method_name,
                str(method.get("signature", "")),
                str(method.get("summary", "")),
                str(api.get("interfaceName", "")),
                " ".join(str(item) for item in entity_names),
                " ".join(str(item) for item in table_names),
            )
            asset_index.append(build_asset_index_entry(
                "service_method",
                f"service-method:{api.get('interfaceName', '')}.{method_name}",
                business_key,
                f"{api.get('interfaceName', '')}.{method_name}",
                str(api.get("sourceFile", "")),
                method_tokens,
                str(method.get("summary", "")),
                {
                    "ownerName": api.get("interfaceName", ""),
                    "methodName": method_name,
                    "signature": method.get("signature", ""),
                    "returnType": method.get("returnType", ""),
                },
            ))

    java_anchors = scan_graph_java_anchors(root, scans_map, max_java_files)
    page_anchors = scan_graph_page_anchors(root, scans_map, max_html_files)
    anchors.extend(java_anchors)
    anchors.extend(page_anchors)
    for item in java_anchors + page_anchors:
        asset_tokens = build_asset_tokens(
            str(item.get("className", "") or item.get("pageName", "")),
            str(item.get("path", "")),
            " ".join(str(token) for token in item.get("tokens", []) if token),
            " ".join(str(method) for method in item.get("methodNames", []) if method),
        )
        item["assetTokens"] = asset_tokens
        asset_index.append(build_asset_index_entry(
            str(item.get("kind", "")).lower(),
            str(item.get("id", "")),
            str(item.get("businessKey", "")),
            str(item.get("className", "") or item.get("pageName", "") or item.get("path", "")),
            str(item.get("path", "")),
            asset_tokens,
            "",
            {"role": item.get("role", ""), "methodNames": item.get("methodNames", [])},
        ))

    grouped: Dict[str, List[Dict[str, object]]] = defaultdict(list)
    for anchor in anchors:
        key = str(anchor.get("businessKey", "") or "unknown")
        grouped[key].append(anchor)

    business_blocks: List[Dict[str, object]] = []
    for business_key, items in grouped.items():
        entities_payload = [item for item in items if item.get("kind") == "Entity"]
        apis_payload = [item for item in items if item.get("kind") == "ServiceApi"]
        impls_payload = [item for item in items if item.get("kind") == "ServiceImpl"]
        available_methods: List[Dict[str, object]] = []
        seen_methods: Set[str] = set()
        for owner in apis_payload + impls_payload:
            owner_name = str(owner.get("interfaceName") or owner.get("className") or Path(str(owner.get("path", ""))).stem)
            for method in owner.get("methods", []) if isinstance(owner.get("methods"), list) else []:
                method_name = str(method.get("name", "")).strip() if isinstance(method, dict) else ""
                if not method_name:
                    continue
                key = f"{owner_name}::{method_name}::{method.get('signature', '') if isinstance(method, dict) else ''}"
                if key in seen_methods:
                    continue
                seen_methods.add(key)
                available_methods.append({
                    "ownerKind": owner.get("kind", ""),
                    "ownerName": owner_name,
                    "ownerPath": owner.get("path", ""),
                    "name": method_name,
                    "signature": method.get("signature", "") if isinstance(method, dict) else "",
                    "returnType": method.get("returnType", "") if isinstance(method, dict) else "",
                    "summary": method.get("summary", "") if isinstance(method, dict) else "",
                    "params": method.get("params", []) if isinstance(method, dict) else [],
                })
        tokens: List[str] = []
        asset_tokens: List[str] = []
        for item in items:
            tokens.extend(item.get("tokens", []) if isinstance(item.get("tokens"), list) else [])
            asset_tokens.extend(item.get("assetTokens", []) if isinstance(item.get("assetTokens"), list) else [])
        kinds = Counter(str(item.get("kind", "")) for item in items)
        confidence = min(
            0.98,
            (0.35 if kinds.get("Entity") else 0)
            + (0.25 if kinds.get("ServiceApi") else 0)
            + (0.20 if kinds.get("ServiceImpl") else 0)
            + (0.12 if kinds.get("Action") or kinds.get("Rest") else 0)
            + (0.08 if kinds.get("HtmlPage") else 0)
        )
        natural_language = build_graph_natural_language_payload(
            business_key=business_key,
            items=items,
            entities_payload=entities_payload,
            apis_payload=apis_payload,
            available_methods=available_methods,
        )
        business_blocks.append({
            "businessKey": business_key,
            "tokens": list(dict.fromkeys(tokens))[:100],
            "assetTokens": list(dict.fromkeys(asset_tokens))[:120],
            "confidence": round(confidence, 2),
            "aliases": natural_language["aliases"],
            "summary": natural_language["summary"],
            "examplePhrases": natural_language["examplePhrases"],
            "capabilityPhrases": natural_language["capabilityPhrases"],
            "primaryActions": natural_language["primaryActions"],
            "primaryEntities": natural_language["primaryEntities"],
            "naturalLanguageConfidence": natural_language["naturalLanguageConfidence"],
            "naturalLanguageEvidence": natural_language["naturalLanguageEvidence"],
            "anchorIds": [str(item.get("id", "")) for item in items if item.get("id")],
            "anchors": [{
                "id": item.get("id", ""),
                "kind": item.get("kind", ""),
                "role": item.get("role", ""),
                "path": item.get("path", ""),
                "methodNames": item.get("methodNames", []),
            } for item in items],
            "entities": [{
                "entityName": item.get("entityName", ""),
                "tableName": item.get("tableName", ""),
                "sourceFile": item.get("path", ""),
                "summary": item.get("summary", ""),
                "fields": item.get("fields", []),
            } for item in entities_payload],
            "serviceApis": [{
                "interfaceName": item.get("interfaceName", ""),
                "sourceFile": item.get("path", ""),
                "entityNames": item.get("entityNames", []),
                "tableNames": item.get("tableNames", []),
                "methodNames": item.get("methodNames", []),
            } for item in apis_payload],
            "serviceImpls": [{
                "className": item.get("className", ""),
                "sourceFile": item.get("path", ""),
                "implements": item.get("implements", []),
                "methodNames": item.get("methodNames", []),
            } for item in impls_payload],
            "availableMethods": available_methods[:120],
            "verifiedMethods": [],
            "plannedMethodUsage": [],
            "missingMethodCandidates": [],
            "reuseFirstPolicy": {
                "enabled": True,
                "message": "命中该业务块时必须先复用 availableMethods；新增方法需说明已有方法为何不能覆盖，并同步 ServiceApi/ServiceImpl。",
            },
            "links": [],
            "evidence": [f"{kind} x{count}" for kind, count in sorted(kinds.items()) if kind],
        })

    business_blocks.sort(key=lambda item: (-float(item.get("confidence", 0)), str(item.get("businessKey", ""))))
    return {
        "generatedAt": datetime.now().isoformat(timespec="seconds"),
        "lastUpdatedAt": datetime.now().isoformat(timespec="seconds"),
        "version": 2,
        "projectPath": str(root),
        "pipelineSupport": ["expert", "website"],
        "buildPolicy": {
            "seed": "entity-service-first",
            "storesSourceText": False,
            "ignoredDirs": sorted(IGNORED_DIR_NAMES),
            "reuseFirst": True,
        },
        "anchors": anchors,
        "businessBlocks": business_blocks,
        "assetIndex": asset_index,
        "stats": {
            "anchorCount": len(anchors),
            "businessBlockCount": len(business_blocks),
            "assetIndexCount": len(asset_index),
            "availableMethodCount": sum(len(item.get("availableMethods", [])) for item in business_blocks),
            "storesSourceText": False,
        },
    }


def write_business_graph_output(root: Path, graph: Dict[str, object]) -> Dict[str, str]:
    structure_dir = project_artifact_dir(root)
    structure_dir.mkdir(parents=True, exist_ok=True)
    graph_path = structure_dir / "business-graph.json"
    index_path = structure_dir / "business-graph.index.json"
    asset_index_path = structure_dir / "asset-index.json"
    business_blocks = graph.get("businessBlocks", []) if isinstance(graph.get("businessBlocks"), list) else []
    asset_index = graph.get("assetIndex", []) if isinstance(graph.get("assetIndex"), list) else []
    slim_graph = {
        **graph,
        "businessBlocks": business_blocks,
        "stats": {
            **(graph.get("stats", {}) if isinstance(graph.get("stats"), dict) else {}),
            "assetIndexPath": str(asset_index_path),
            "assetIndexCount": len(asset_index)
        }
    }
    slim_graph.pop("assetIndex", None)
    graph_path.write_text(json.dumps(slim_graph, indent=2, ensure_ascii=False), encoding="utf-8")
    index_payload = {
        "generatedAt": graph.get("generatedAt", ""),
        "projectPath": graph.get("projectPath", ""),
        "version": graph.get("version", 2),
        "buildPolicy": graph.get("buildPolicy", {}),
        "businessBlocks": [
            {
                "businessKey": item.get("businessKey", ""),
                "confidence": item.get("confidence", 0),
                "summary": item.get("summary", ""),
                "aliases": item.get("aliases", [])[:4],
                "primaryActions": item.get("primaryActions", [])[:4],
                "primaryEntities": item.get("primaryEntities", [])[:3],
                "keywords": dedupe_entity_keywords(
                    *(item.get("aliases", [])[:2] if isinstance(item.get("aliases"), list) else []),
                    item.get("summary", ""),
                    *(" ".join(item.get("primaryEntities", [])[:2]).split() if isinstance(item.get("primaryEntities"), list) else []),
                    *(" ".join(item.get("primaryActions", [])[:2]).split() if isinstance(item.get("primaryActions"), list) else [])
                )[:8],
                "anchorCount": len(item.get("anchors", [])) if isinstance(item.get("anchors"), list) else 0,
                "methodCount": len(item.get("availableMethods", [])) if isinstance(item.get("availableMethods"), list) else 0,
            }
            for item in business_blocks if isinstance(item, dict)
        ],
        "stats": {
            "businessBlockCount": len(business_blocks),
            "assetIndexPath": str(asset_index_path)
        }
    }
    index_path.write_text(json.dumps(index_payload, indent=2, ensure_ascii=False), encoding="utf-8")
    asset_index_payload = {
        "generatedAt": graph.get("generatedAt", ""),
        "projectPath": graph.get("projectPath", ""),
        "version": graph.get("version", 2),
        "assetIndex": [
            {
                "assetId": item.get("assetId", ""),
                "assetType": item.get("assetType", ""),
                "businessKey": item.get("businessKey", ""),
                "title": item.get("title", ""),
                "summary": item.get("summary", ""),
                "sourcePath": item.get("sourcePath", ""),
                "assetTokens": item.get("assetTokens", [])[:24]
            }
            for item in asset_index if isinstance(item, dict)
        ]
    }
    asset_index_path.write_text(json.dumps(asset_index_payload, indent=2, ensure_ascii=False), encoding="utf-8")
    return {
        "businessGraphPath": str(graph_path),
        "businessGraphIndexPath": str(index_path),
        "assetIndexPath": str(asset_index_path),
        "businessBlockCount": str(len(business_blocks)),
        "assetIndexCount": str(len(asset_index)),
        "availableMethodCount": str(graph.get("stats", {}).get("availableMethodCount", 0)),
    }


def write_entity_graph_output(root: Path, entity_graph_payload: Dict[str, object]) -> Dict[str, str]:
    structure_dir = project_artifact_dir(root)
    structure_dir.mkdir(parents=True, exist_ok=True)
    graph_path = structure_dir / "entity-graph.json"
    index_path = structure_dir / "entity-graph.index.json"
    graph_path.write_text(json.dumps(entity_graph_payload, indent=2, ensure_ascii=False), encoding="utf-8")
    graph = entity_graph_payload.get("entityGraph", {}) if isinstance(entity_graph_payload, dict) else {}
    nodes = graph.get("nodes", []) if isinstance(graph, dict) else []
    edges = graph.get("edges", []) if isinstance(graph, dict) else []
    related_map: Dict[str, List[str]] = defaultdict(list)
    for edge in edges:
        from_id = normalize_whitespace(edge.get("from", ""))
        to_id = normalize_whitespace(edge.get("to", ""))
        if from_id and to_id and to_id not in related_map[from_id]:
            related_map[from_id].append(to_id)
        if from_id and to_id and from_id not in related_map[to_id]:
            related_map[to_id].append(from_id)
    index_payload = {
        "generatedAt": entity_graph_payload.get("generatedAt", ""),
        "projectPath": entity_graph_payload.get("projectPath", ""),
        "version": graph.get("version", 1),
        "sourcePolicy": graph.get("sourcePolicy", {}),
        "nodes": [
            {
                "id": item.get("id", ""),
                "entityName": item.get("entityName", ""),
                "tableName": item.get("tableName", ""),
                "tableDisplayName": item.get("tableDisplayName", ""),
                "role": item.get("role", "master"),
                "keywords": item.get("keywords", [])[:3],
                "relatedEntityIds": related_map.get(str(item.get("id", "")), [])[:8]
            }
            for item in nodes if isinstance(item, dict)
        ]
    }
    index_path.write_text(json.dumps(index_payload, indent=2, ensure_ascii=False), encoding="utf-8")
    return {
        "entityGraphPath": str(graph_path),
        "entityGraphIndexPath": str(index_path),
        "entityNodeCount": str(len(nodes)),
        "entityEdgeCount": str(len(edges)),
    }


def render_frontmatter_list(key: str, items: Sequence[str]) -> List[str]:
    values = [normalize_whitespace(item) for item in items if normalize_whitespace(item)]
    if not values:
        return [f"{key}: []"]
    lines = [f"{key}:"]
    lines.extend([f"  - {item}" for item in values])
    return lines


def format_method_param_text(params: Sequence[Dict[str, str]]) -> str:
    if not params:
        return "无"
    return "；".join(
        f"`{item.get('name', '')}`: `{item.get('type', '') or '未识别'}`"
        for item in params
    )


def build_table_structure_lines(table_structures: Sequence[Dict[str, object]]) -> List[str]:
    lines: List[str] = ["### 2.1 表结构摘要"]
    if not table_structures:
        lines.extend([
            "- 未关联到可解析的实体字段，请结合实体类或 SQL 源码确认表结构。",
            "",
        ])
        return lines

    for item in table_structures:
        table_name = normalize_whitespace(item.get("tableName", "")) or "未识别表"
        entity_name = normalize_whitespace(item.get("entityName", "")) or "未识别实体"
        entity_source = normalize_whitespace(item.get("entitySourceFile", ""))
        fields = item.get("fields", []) if isinstance(item.get("fields"), list) else []

        lines.extend([
            f"#### `{table_name}`",
            f"- 实体：`{entity_name}`",
            f"- 实体源码：`{entity_source or '未识别'}`",
        ])
        if fields:
            lines.extend([
                "| 列名 | 字段名 | Java类型 | 说明 |",
                "|------|--------|----------|------|",
            ])
            for field in fields:
                lines.append(
                    f"| `{normalize_whitespace(field.get('columnName', '')) or '未识别'}` | "
                    f"`{normalize_whitespace(field.get('fieldName', '')) or '未识别'}` | "
                    f"`{normalize_whitespace(field.get('javaType', '')) or '未识别'}` | "
                    f"{normalize_whitespace(field.get('summary', '')) or '无'} |"
                )
        else:
            lines.append("- 未从实体源码解析到字段，请结合实体类或 SQL 源码确认。")
        lines.append("")
    return lines


def build_api_rule_markdown(entry: Dict[str, object]) -> str:
    frontmatter_lines = [
        "---",
        f"rule_alias: {entry['ruleAlias']}",
        "category: 项目现成接口规范",
    ]
    frontmatter_lines.extend(render_frontmatter_list("table_names", entry.get("tableNames", [])))
    frontmatter_lines.extend(render_frontmatter_list("entity_names", entry.get("entityNames", [])))
    frontmatter_lines.extend(render_frontmatter_list("method_names", entry.get("methodNames", [])[:24]))
    frontmatter_lines.extend(render_frontmatter_list("intent_keywords", entry.get("keywords", [])))
    frontmatter_lines.extend([
        f"source_file: {entry['sourceFile']}",
        f"source_package: {entry['packageName']}",
        "---",
        "",
        f"# {entry['interfaceName']}接口使用规范",
        "",
        "## 1. 基本锚点",
        f"- 模块：`{entry['moduleName']}`",
        f"- 接口：`{entry['interfaceName']}`",
        f"- 包名：`{entry['packageName']}`",
        f"- 源文件：`{entry['sourceFile']}`",
        f"- 规则文件：`{entry['ruleFile']}`",
        f"- 摘要：{entry['summary'] or '无'}",
        "",
        "## 2. 表与实体",
        f"- 关联表：{'、'.join(f'`{item}`' for item in entry.get('tableNames', [])) if entry.get('tableNames') else '无'}",
        f"- 实体：{'、'.join(f'`{item}`' for item in entry.get('entityNames', [])) if entry.get('entityNames') else '无'}",
        "",
    ])
    frontmatter_lines.extend(build_table_structure_lines(entry.get("tableStructures", [])))
    frontmatter_lines.extend([
        "## 3. 方法目录",
        "| 方法 | 返回类型 | 摘要 |",
        "|------|----------|------|",
    ])
    methods = entry.get("methods", [])
    if methods:
        for method in methods:
            frontmatter_lines.append(
                f"| `{method.get('name', '')}` | `{method.get('returnType', '')}` | {method.get('summary', '') or '无'} |"
            )
    else:
        frontmatter_lines.append("| 无 | 无 | 无 |")

    frontmatter_lines.extend([
        "",
        "## 4. 方法明细",
    ])
    if methods:
        for index, method in enumerate(methods, start=1):
            frontmatter_lines.extend([
                f"### 4.{index} `{method.get('name', '')}`",
                f"- 签名：`{method.get('signature', '')}`",
                f"- 参数：{format_method_param_text(method.get('params', []))}",
                f"- 返回类型：`{method.get('returnType', '')}`",
                f"- 说明：{method.get('summary', '') or '无'}",
                "",
            ])
    else:
        frontmatter_lines.extend(["- 无可用方法明细", ""])

    frontmatter_lines.extend([
        "## 5. 代码锚点",
        f"- sourceFile: `{entry['sourceFile']}`",
        f"- packageName: `{entry['packageName']}`",
        f"- moduleName: `{entry['moduleName']}`",
        f"- ruleId: `{entry['ruleId']}`",
        "",
        "## 6. 复用提示",
        "- 通用意图检索会直接命中该规则；优先阅读本规则中的表结构摘要、方法目录与代码锚点。",
        "- 命中后优先复用这里列出的历史方法与实体，不要重新发明同表同职责接口。",
        "- 如需扩展新能力，应先确认是否沿用同一实体与表，再决定新增方法还是新增接口。",
    ])
    return "\n".join(frontmatter_lines).strip() + "\n"


def write_api_catalog_outputs(root: Path, catalog: Dict[str, object]) -> Dict[str, str]:
    rule_dir = api_rules_dir(root)
    rule_dir.mkdir(parents=True, exist_ok=True)

    structure_dir = project_artifact_dir(root)
    for legacy_path in [
        structure_dir / "项目API接口索引.json",
        structure_dir / "项目API表索引.json",
        structure_dir / "项目API概览.md",
    ]:
        if legacy_path.exists():
            legacy_path.unlink()

    for old_rule in rule_dir.glob("*接口使用规范.md"):
        old_rule.unlink()

    for entry in catalog.get("interfaces", []):
        rule_path = root / Path(str(entry["ruleFile"]))
        rule_path.parent.mkdir(parents=True, exist_ok=True)
        rule_path.write_text(build_api_rule_markdown(entry), encoding="utf-8")

    return {
        "ruleDir": str(rule_dir),
        "ruleCount": str(len(catalog.get("interfaces", []))),
    }


def main() -> None:
    args = parse_args()
    root = Path(args.root).resolve()
    output = Path(args.output).resolve() if args.output else (project_artifact_dir(root) / "项目现状基线报告.md")

    if args.all_in_one:
        # 一次性产物：复用同一份 records / scans_map 跑出 snapshot + 报告 + api 资产 + 业务图 + 实体图 + REST 风格
        # 大项目 walk 一次足够，避免子进程多次重复扫描
        records = scan_poms(root, args.max_pom_files)
        scans_map = scan_modules(root, records, args.max_java_files, args.max_html_files)
        scans = list(scans_map.values())

        # snapshot
        main_rec = choose_main_record(records)
        product_name = main_rec.artifact_id if main_rec else "未识别"
        product_version = infer_product_version(main_rec, records)
        _, placement_paths, placement_diagnostics = build_class_placement(scans, root)
        ownership_rules = build_ownership_rules(scans)
        placement_candidates = build_placement_candidates(scans)
        placement_contract_draft = build_placement_contract_draft(placement_paths, ownership_rules)
        warnings = build_snapshot_warnings(scans, ownership_rules, placement_candidates, placement_paths)
        snap_data = {
            "root": str(root),
            "product": product_name,
            "version": product_version,
            "projectType": infer_project_type(records),
            "paths": placement_paths,
            "modules": [build_module_summary(scan) for scan in sorted(scans, key=lambda item: item.relative_dir)],
            "ownershipRules": ownership_rules,
            "placementCandidates": placement_candidates,
            "placementContractDraft": placement_contract_draft,
            "diagnostics": placement_diagnostics,
            "warnings": warnings,
        }

        # 报告
        try:
            build_report(
                root=root,
                output_path=output,
                max_pom_files=args.max_pom_files,
                max_java_files=args.max_java_files,
                max_html_files=args.max_html_files,
                records=records,
                scans_map=scans_map,
            )
        except Exception:
            # 报告生成失败不阻塞主链路；下游会用 JS fallback 写报告
            pass

        # api-catalog + business-graph + entity-graph
        try:
            catalog = build_api_catalog(
                root=root,
                records=records,
                max_java_files=args.max_java_files,
                max_html_files=args.max_html_files,
                scans_map=scans_map,
            )
            write_api_catalog_outputs(root, catalog)
        except Exception:
            pass
        try:
            graph = build_business_graph(
                root=root,
                records=records,
                max_java_files=args.max_java_files,
                max_html_files=args.max_html_files,
                scans_map=scans_map,
            )
            write_business_graph_output(root, graph)
        except Exception:
            pass
        try:
            entity_graph = build_entity_graph(
                root=root,
                records=records,
                max_java_files=args.max_java_files,
                max_html_files=args.max_html_files,
                scans_map=scans_map,
            )
            write_entity_graph_output(root, entity_graph)
        except Exception:
            pass

        # REST 风格契约
        try:
            write_rest_style_contract(root, collect_rest_style_contract(root, scans))
        except Exception:
            pass

        # Coder 复用卡指路索引（code-reuse-index）：Action 注入的 Service + 接口路径 + route 边
        try:
            reuse_index = build_code_reuse_index(
                root=root,
                scans_map=scans_map,
                max_java_files=args.max_java_files,
                max_html_files=args.max_html_files,
            )
            write_code_reuse_index_output(root, reuse_index)
        except Exception:
            pass

        # stdout 返回 snapshot JSON（baseline-scanner 直接消费）
        print(json.dumps(snap_data, indent=2, ensure_ascii=False))
        return

    if args.reuse_index:
        # 仅刷新 Coder 复用卡指路索引（finalize 后受控刷新用）。
        # 性能：用 init_module_scans 只取模块根目录（纯 pom 解析，不 walk 源码），
        # build_code_reuse_index 再按文件名预筛 *Action/*Controller/I*Service.java，
        # 不像 scan_modules 那样全量 read_text 每个 java。stdout 输出 receipt 摘要。
        records = scan_poms(root, args.max_pom_files)
        scans_map = init_module_scans(root, records)
        reuse_index = build_code_reuse_index(
            root=root,
            scans_map=scans_map,
            max_java_files=args.max_java_files,
            max_html_files=args.max_html_files,
        )
        result = write_code_reuse_index_output(root, reuse_index)
        print(json.dumps(result, indent=2, ensure_ascii=False))
        return

    if args.snapshot:
        records = scan_poms(root, args.max_pom_files)
        main_rec = choose_main_record(records)
        product_name = main_rec.artifact_id if main_rec else "未识别"
        product_version = infer_product_version(main_rec, records)
        scans_map = scan_modules(root, records, args.max_java_files, args.max_html_files)
        scans = list(scans_map.values())
        _, placement_paths, placement_diagnostics = build_class_placement(scans, root)
        ownership_rules = build_ownership_rules(scans)
        placement_candidates = build_placement_candidates(scans)
        warnings = build_snapshot_warnings(scans, ownership_rules, placement_candidates, placement_paths)
        placement_contract_draft = build_placement_contract_draft(placement_paths, ownership_rules)

        snap_data = {
            "root": str(root),
            "product": product_name,
            "version": product_version,
            "projectType": infer_project_type(records),
            "paths": placement_paths,
            "modules": [build_module_summary(scan) for scan in sorted(scans, key=lambda item: item.relative_dir)],
            "ownershipRules": ownership_rules,
            "placementCandidates": placement_candidates,
            "placementContractDraft": placement_contract_draft,
            "diagnostics": placement_diagnostics,
            "warnings": warnings
        }
        print(json.dumps(snap_data, indent=2, ensure_ascii=False))
        return

    if args.rest_style:
        contract = collect_rest_style_contract_fast(root, args.max_java_files)
        path = write_rest_style_contract(root, contract)
        print(json.dumps({
            "restInterfaceStyleContractPath": path,
            "contract": contract,
        }, indent=2, ensure_ascii=False))
        return

    if args.asset_index_lite:
        payload = build_asset_index_lite(root, args.max_java_files)
        outputs = write_asset_index_lite_output(root, payload)
        print(json.dumps(outputs, indent=2, ensure_ascii=False))
        return

    if args.api_catalog:
        records = scan_poms(root, args.max_pom_files)
        catalog = build_api_catalog(
            root=root,
            records=records,
            max_java_files=args.max_java_files,
            max_html_files=args.max_html_files,
        )
        outputs = write_api_catalog_outputs(root, catalog)
        graph = build_business_graph(
            root=root,
            records=records,
            max_java_files=args.max_java_files,
            max_html_files=args.max_html_files,
        )
        entity_graph = build_entity_graph(
            root=root,
            records=records,
            max_java_files=args.max_java_files,
            max_html_files=args.max_html_files,
        )
        outputs.update(write_business_graph_output(root, graph))
        outputs.update(write_entity_graph_output(root, entity_graph))
        scans = list(scan_modules(root, records, args.max_java_files, args.max_html_files).values())
        outputs["restInterfaceStyleContractPath"] = write_rest_style_contract(root, collect_rest_style_contract(root, scans))
        print(json.dumps(outputs, indent=2, ensure_ascii=False))
        return

    if args.business_graph:
        records = scan_poms(root, args.max_pom_files)
        graph = build_business_graph(
            root=root,
            records=records,
            max_java_files=args.max_java_files,
            max_html_files=args.max_html_files,
        )
        entity_graph = build_entity_graph(
            root=root,
            records=records,
            max_java_files=args.max_java_files,
            max_html_files=args.max_html_files,
        )
        outputs = write_business_graph_output(root, graph)
        outputs.update(write_entity_graph_output(root, entity_graph))
        scans = list(scan_modules(root, records, args.max_java_files, args.max_html_files).values())
        outputs["restInterfaceStyleContractPath"] = write_rest_style_contract(root, collect_rest_style_contract(root, scans))
        print(json.dumps(outputs, indent=2, ensure_ascii=False))
        return

    build_report(
        root=root,
        output_path=output,
        max_pom_files=args.max_pom_files,
        max_java_files=args.max_java_files,
        max_html_files=args.max_html_files,
    )
    print(f"报告已生成：{output}")


if __name__ == "__main__":
    main()
