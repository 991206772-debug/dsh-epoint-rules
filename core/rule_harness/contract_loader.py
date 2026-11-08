import os
import re
from dataclasses import dataclass
from typing import Any, Dict, List, Optional

import yaml


CONTRACT_HEADINGS = {
    "validation": "AI Validation Contract",
    "stage": "AI Stage Contract",
    "api_capability": "AI API Capability Contract",
}


@dataclass
class RuleContract:
    contract_type: str
    rule_name: str
    source_path: str
    payload: Dict[str, Any]
    raw_yaml: str


def _strip_frontmatter(content: str) -> str:
    return re.sub(r"^---[\s\S]*?---\s*", "", content or "", count=1)


def _extract_frontmatter(content: str) -> Dict[str, Any]:
    match = re.match(r"^---\s*\n([\s\S]*?)\n---\s*", content or "")
    if not match:
        return {}
    try:
        payload = yaml.safe_load(match.group(1)) or {}
        return payload if isinstance(payload, dict) else {}
    except Exception:
        return {}


def _extract_contract_yaml(content: str, heading: str) -> str:
    body = _strip_frontmatter(content)
    safe_heading = re.escape(heading)
    pattern = re.compile(
        rf"(?:^|\n)##\s+{safe_heading}\s*\n+```yaml\s*\n([\s\S]*?)\n```",
        re.MULTILINE,
    )
    match = pattern.search(body)
    return (match.group(1).strip() if match else "")


def _parse_yaml(yaml_text: str) -> Dict[str, Any]:
    payload = yaml.safe_load(yaml_text) or {}
    return payload if isinstance(payload, dict) else {}


def _rule_name_from_path(path: str, content: str) -> str:
    metadata = _extract_frontmatter(content)
    for key in ("rule_alias", "ruleAlias", "name", "description"):
        value = str(metadata.get(key) or "").strip()
        if value:
            return value
    return os.path.splitext(os.path.basename(path))[0]


def _load_contracts_from_file(source_path: str) -> List[RuleContract]:
    contracts: List[RuleContract] = []
    if not source_path.lower().endswith((".md", ".mdc")) or not os.path.isfile(source_path):
        return contracts
    try:
        with open(source_path, "r", encoding="utf-8") as handle:
            content = handle.read()
    except UnicodeDecodeError:
        with open(source_path, "r", encoding="utf-8", errors="ignore") as handle:
            content = handle.read()
    rule_name = _rule_name_from_path(source_path, content)
    for contract_type, heading in CONTRACT_HEADINGS.items():
        raw_yaml = _extract_contract_yaml(content, heading)
        if not raw_yaml:
            continue
        payload = _parse_yaml(raw_yaml)
        contracts.append(RuleContract(
            contract_type=contract_type,
            rule_name=rule_name,
            source_path=source_path,
            payload=payload,
            raw_yaml=raw_yaml,
        ))
    return contracts


def load_rule_contracts(rules_root: str, rule_paths: Optional[List[str]] = None) -> List[RuleContract]:
    contracts: List[RuleContract] = []
    explicit_paths = [os.path.abspath(str(item or "")) for item in (rule_paths or []) if str(item or "").strip()]
    if explicit_paths:
        seen = set()
        for source_path in explicit_paths:
            if source_path in seen:
                continue
            seen.add(source_path)
            contracts.extend(_load_contracts_from_file(source_path))
        return contracts

    root = os.path.abspath(str(rules_root or ""))
    if not root or not os.path.isdir(root):
        return contracts

    for current_root, _dirs, files in os.walk(root):
        for file_name in files:
            if not file_name.lower().endswith((".md", ".mdc")):
                continue
            source_path = os.path.join(current_root, file_name)
            contracts.extend(_load_contracts_from_file(source_path))
    return contracts


def resolve_profile_payload(payload: Dict[str, Any], profile: str) -> Optional[Dict[str, Any]]:
    profiles = payload.get("profiles") if isinstance(payload, dict) else None
    normalized = str(profile or "").strip()
    if isinstance(profiles, dict):
        selected = profiles.get(normalized)
        return selected if isinstance(selected, dict) else None
    return payload if isinstance(payload, dict) else None


def resolve_stage_payload(payload: Dict[str, Any], profile: str, stage: str) -> Optional[Dict[str, Any]]:
    profile_payload = resolve_profile_payload(payload, profile)
    if not isinstance(profile_payload, dict):
        return None
    normalized_stage = str(stage or "").strip()
    if not normalized_stage:
        return profile_payload
    stages = profile_payload.get("stages")
    if isinstance(stages, dict):
        selected = stages.get(normalized_stage)
        return selected if isinstance(selected, dict) else None
    selected = profile_payload.get(normalized_stage)
    if isinstance(selected, dict):
        return selected
    return profile_payload
