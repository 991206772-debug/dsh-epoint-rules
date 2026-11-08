import argparse
import json
import os
from typing import Any, Dict, List

from contract_loader import load_rule_contracts, resolve_profile_payload, resolve_stage_payload
from validators.api_capability_validator import validate_api_capability
from validators.code_fingerprint_validator import validate_code_fingerprint


def _ensure_dir(path: str) -> None:
    if path:
        os.makedirs(path, exist_ok=True)


def _write_json(path: str, payload: Any) -> None:
    _ensure_dir(os.path.dirname(path))
    with open(path, "w", encoding="utf-8") as handle:
        json.dump(payload, handle, ensure_ascii=False, indent=2)


def _write_text(path: str, content: str) -> None:
    _ensure_dir(os.path.dirname(path))
    with open(path, "w", encoding="utf-8") as handle:
        handle.write(content)


def _build_fix_prompt(violations: List[Dict[str, Any]]) -> str:
    if not violations:
        return "RuleContractHarness 未发现阻断问题。\n"
    lines = ["# RuleContractHarness 修复提示", ""]
    for index, item in enumerate(violations, 1):
        lines.extend([
            f"## {index}. {item.get('problem') or item.get('code')}",
            f"- 问题：{item.get('message') or item.get('code')}",
            f"- 定位：{item.get('location') or 'targetFiles'}",
            f"- 依据：{item.get('ruleName') or 'unknown'}",
            f"- 修复：{item.get('fix') or '按规则合同补齐产物。'}",
            "",
        ])
    return "\n".join(lines).rstrip() + "\n"


def _build_report(result: Dict[str, Any]) -> str:
    lines = [
        "# RuleContractHarness Report",
        "",
        f"- ok: {str(result.get('ok')).lower()}",
        f"- validationContracts: {result['summary'].get('validationContracts', 0)}",
        f"- stageContracts: {result['summary'].get('stageContracts', 0)}",
        f"- apiCapabilityContracts: {result['summary'].get('apiCapabilityContracts', 0)}",
        f"- violations: {len(result.get('violations') or [])}",
        "",
    ]
    for item in result.get("violations") or []:
        lines.append(f"- `{item.get('code')}` {item.get('message')} ({item.get('ruleName')})")
    return "\n".join(lines).rstrip() + "\n"


def _profile_missing_violation(contract, profile: str) -> Dict[str, Any]:
    return {
        "code": "RULE_PROFILE_CONTRACT_MISSING",
        "ruleName": contract.rule_name,
        "sourcePath": contract.source_path,
        "problem": f"规则包含 profiles，但缺少 {profile} profile 合同",
        "location": "profiles",
        "message": f"RULE_PROFILE_CONTRACT_MISSING: {contract.rule_name} profile={profile}",
        "fix": "补齐对应 profile 的合同，或确保当前流水线只选择可见规则。",
    }


def run_harness(options: Dict[str, Any]) -> Dict[str, Any]:
    rules_root = str(options.get("rulesRoot") or "")
    profile = str(options.get("profile") or "expert")
    stage = str(options.get("stage") or "code")
    target_files = options.get("targetFiles") or []
    rule_paths = options.get("rulePaths") or []
    referenced_capabilities = options.get("referencedCapabilities") or []
    contract_types = {
        str(item or "").strip()
        for item in (options.get("contractTypes") or [])
        if str(item or "").strip()
    }
    output_dir = str(options.get("outputDir") or "")
    contracts = load_rule_contracts(rules_root, rule_paths)
    violations: List[Dict[str, Any]] = []
    parsed = {
        "validationContracts": 0,
        "stageContracts": 0,
        "apiCapabilityContracts": 0,
    }

    for contract in contracts:
        if contract_types and contract.contract_type not in contract_types:
            continue
        if contract.contract_type == "validation":
            parsed["validationContracts"] += 1
            selected = resolve_profile_payload(contract.payload, profile)
            if selected is None:
                violations.append(_profile_missing_violation(contract, profile))
                continue
            validator_type = str(selected.get("validator_type") or selected.get("validatorType") or "").strip()
            if validator_type == "code_fingerprint" or "fingerprint" in selected:
                violations.extend(validate_code_fingerprint(selected, target_files, {
                    "ruleName": contract.rule_name,
                    "sourcePath": contract.source_path,
                    "profile": profile,
                    "stage": stage,
                }))
        elif contract.contract_type == "stage":
            parsed["stageContracts"] += 1
            selected = resolve_stage_payload(contract.payload, profile, stage)
            if selected is None:
                violations.append(_profile_missing_violation(contract, profile))
        elif contract.contract_type == "api_capability":
            parsed["apiCapabilityContracts"] += 1
            violations.extend(validate_api_capability(contract.payload, target_files, {
                "ruleName": contract.rule_name,
                "sourcePath": contract.source_path,
                "profile": profile,
                "stage": stage,
                "referencedCapabilities": referenced_capabilities,
            }))

    result = {
        "ok": len(violations) == 0,
        "summary": parsed,
        "violations": violations,
    }
    if output_dir:
        _ensure_dir(output_dir)
        _write_json(os.path.join(output_dir, "violations.json"), violations)
        _write_text(os.path.join(output_dir, "fix_prompt.md"), _build_fix_prompt(violations))
        _write_text(os.path.join(output_dir, "harness-report.md"), _build_report(result))
    return result


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True)
    args = parser.parse_args()
    with open(args.input, "r", encoding="utf-8") as handle:
        options = json.load(handle)
    result = run_harness(options)
    print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    main()
