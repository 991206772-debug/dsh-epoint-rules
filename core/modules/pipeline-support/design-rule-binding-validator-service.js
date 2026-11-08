/* eslint-disable */

/**
 * DesignRuleBindingValidatorService
 *
 * Validates source closure between Coder-facing designJson.businessEntities[].boundRules
 * and the design-stage audit artifact rule-bindings.json.
 *
 * This layer only checks structural/source consistency:
 * - bound rule aliases are not globally blocked
 * - each entity bound rule is backed by that entity's rule-bindings entry
 * - appliesTo points back to the entityKey
 */
class DesignRuleBindingValidatorService {
    validateRuleBindings(designJson = {}, ruleBindings = null, options = {}) {
        const issues = [];
        const boundRules = this._collectDesignBoundRules(designJson);
        const hasBoundRules = boundRules.length > 0;
        if (!hasBoundRules) {
            return this._result([]);
        }

        if (!ruleBindings || typeof ruleBindings !== 'object' || Array.isArray(ruleBindings)) {
            issues.push({
                code: 'RULE_BINDING_ARTIFACT_MISSING',
                path: options.sourcePath || 'rule-bindings.json',
                field: 'rule-bindings.json',
                expected: 'object with globalWhitelist/globalBlocklist/entityBindings',
                actual: ruleBindings === null || ruleBindings === undefined ? 'missing' : typeof ruleBindings,
                message: '设计 JSON 已声明 boundRules[]，但缺少可解析的 rule-bindings.json 来源证据。'
            });
            boundRules.forEach(item => {
                issues.push({
                    code: 'RULE_BINDING_ENTITY_BINDING_MISSING',
                    path: `$.entityBindings.${item.entityKey}`,
                    field: 'entityBindings',
                    entityKey: item.entityKey,
                    ruleAlias: item.ruleAlias,
                    expected: `entityBindings entry for ${item.entityKey}`,
                    actual: 'missing',
                    message: `entity ${item.entityKey} 的 boundRules[] 缺少 rule-bindings.json.entityBindings 来源。`
                });
            });
            return this._result(issues);
        }

        const globalBlocklist = this._aliasSet(ruleBindings.globalBlocklist);
        const globalWhitelist = this._aliasSet(ruleBindings.globalWhitelist);
        const whitelistIsAuthoritative = Array.isArray(ruleBindings.globalWhitelist) && ruleBindings.globalWhitelist.length > 0;
        // 兼容 entityBindings / moduleBindings 两种 key（旧 rule-bindings.json 用 moduleBindings）
        const entityBindingMap = this._entityBindingMap(ruleBindings.entityBindings || ruleBindings.moduleBindings);

        for (const item of boundRules) {
            if (globalBlocklist.has(item.ruleAlias)) {
                issues.push({
                    code: 'RULE_BINDING_RULE_BLOCKED',
                    path: `$.businessEntities[id=${item.entityKey}].boundRules[${item.index}]`,
                    field: 'boundRules.ruleAlias',
                    entityKey: item.entityKey,
                    ruleAlias: item.ruleAlias,
                    expected: 'ruleAlias not in globalBlocklist',
                    actual: item.ruleAlias,
                    message: `entity ${item.entityKey} 绑定了已被 globalBlocklist 剔除的规则：${item.ruleAlias}`
                });
            }
            if (whitelistIsAuthoritative && !globalWhitelist.has(item.ruleAlias)) {
                issues.push({
                    code: 'RULE_BINDING_RULE_NOT_WHITELISTED',
                    path: `$.businessEntities[id=${item.entityKey}].boundRules[${item.index}]`,
                    field: 'boundRules.ruleAlias',
                    entityKey: item.entityKey,
                    ruleAlias: item.ruleAlias,
                    expected: 'ruleAlias present in globalWhitelist',
                    actual: item.ruleAlias,
                    message: `entity ${item.entityKey} 绑定的规则未出现在 globalWhitelist 中：${item.ruleAlias}`
                });
            }

            const binding = entityBindingMap.get(item.entityKey);
            if (!binding) {
                issues.push({
                    code: 'RULE_BINDING_ENTITY_BINDING_MISSING',
                    path: `$.entityBindings.${item.entityKey}`,
                    field: 'entityBindings',
                    entityKey: item.entityKey,
                    ruleAlias: item.ruleAlias,
                    expected: `entityBindings entry for ${item.entityKey}`,
                    actual: 'missing',
                    message: `entity ${item.entityKey} 的 boundRules[] 缺少 rule-bindings.json.entityBindings 来源。`
                });
                continue;
            }

            const selection = binding.selections.find(candidate => candidate.ruleAlias === item.ruleAlias);
            if (!selection) {
                issues.push({
                    code: 'RULE_BINDING_SELECTION_MISSING',
                    path: `${binding.path}.ruleSelections`,
                    field: 'entityBindings.ruleSelections',
                    entityKey: item.entityKey,
                    ruleAlias: item.ruleAlias,
                    expected: `ruleSelection ${item.ruleAlias}`,
                    actual: 'missing',
                    message: `entity ${item.entityKey} 的规则 ${item.ruleAlias} 未在 rule-bindings.json 的 entity 绑定中出现。`
                });
                continue;
            }

            if (selection.appliesToValues.length > 0 && !selection.appliesToValues.includes(item.entityKey)) {
                issues.push({
                    code: 'RULE_BINDING_APPLIES_TO_MISMATCH',
                    path: selection.path,
                    field: 'entityBindings.ruleSelections.appliesTo',
                    entityKey: item.entityKey,
                    ruleAlias: item.ruleAlias,
                    expected: item.entityKey,
                    actual: selection.appliesToValues.join(','),
                    message: `rule-bindings.json 中 ${item.ruleAlias} 的 appliesTo 未指向 entity ${item.entityKey}。`
                });
            }
        }

        return this._result(issues);
    }

    _collectDesignBoundRules(designJson = {}) {
        const entities = Array.isArray(designJson.businessEntities) ? designJson.businessEntities : [];
        const result = [];
        entities.forEach(entity => {
            const entityKey = String(entity && entity.entityKey || '').trim();
            const boundRules = Array.isArray(entity && entity.boundRules) ? entity.boundRules : [];
            boundRules.forEach((rule, index) => {
                if (!rule || typeof rule !== 'object' || Array.isArray(rule)) return;
                const ruleAlias = String(rule.ruleAlias || '').trim();
                if (!entityKey || !ruleAlias) return;
                result.push({
                    entityKey,
                    ruleAlias,
                    appliesTo: String(rule.appliesTo || '').trim(),
                    index
                });
            });
        });
        return result;
    }

    _entityBindingMap(entityBindings = undefined) {
        const map = new Map();
        if (Array.isArray(entityBindings)) {
            entityBindings.forEach((entry, index) => {
                this._addEntityBinding(map, entry, `$.entityBindings[${index}]`);
            });
            return map;
        }
        if (entityBindings && typeof entityBindings === 'object') {
            Object.entries(entityBindings).forEach(([entityKey, entry]) => {
                const normalizedEntry = entry && typeof entry === 'object' && !Array.isArray(entry)
                    ? { entityKey, ...entry }
                    : { entityKey, ruleSelections: [] };
                this._addEntityBinding(map, normalizedEntry, `$.entityBindings.${entityKey}`);
            });
        }
        return map;
    }

    _addEntityBinding(map, entry = {}, entryPath = '') {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return;
        const entityKey = String(entry.entityKey || entry.moduleId || entry.id || '').trim();
        if (!entityKey) return;
        const rawSelections = Array.isArray(entry.ruleSelections)
            ? entry.ruleSelections
            : (Array.isArray(entry.boundRules) ? entry.boundRules : []);
        map.set(entityKey, {
            path: entryPath,
            selections: rawSelections
                .filter(item => item && typeof item === 'object' && !Array.isArray(item))
                .map((item, index) => ({
                    ruleAlias: String(item.ruleAlias || '').trim(),
                    appliesToValues: this._appliesToValues(item.appliesTo || item.entityKey || item.moduleId || entityKey),
                    path: `${entryPath}.${Array.isArray(entry.ruleSelections) ? 'ruleSelections' : 'boundRules'}[${index}]`
                }))
                .filter(item => item.ruleAlias)
        });
    }

    _aliasSet(value = []) {
        const set = new Set();
        if (!Array.isArray(value)) return set;
        value.forEach(item => {
            const alias = typeof item === 'string'
                ? String(item || '').trim()
                : String(item && (item.ruleAlias || item.ruleName) || '').trim();
            if (alias) set.add(alias);
        });
        return set;
    }

    _appliesToValues(value) {
        if (Array.isArray(value)) {
            return value.map(item => String(item || '').trim()).filter(Boolean);
        }
        const text = String(value || '').trim();
        return text ? [text] : [];
    }

    _result(issues = []) {
        const ok = issues.length === 0;
        return {
            ok,
            status: ok ? 'rule_binding_valid' : 'rule_binding_invalid',
            ruleBindingLayer: ok ? {
                ok: true,
                issueCount: 0,
                issueGroups: [],
                sampleIssues: [],
                repairCards: []
            } : this._compact(issues)
        };
    }

    _compact(issues = []) {
        const groupMap = new Map();
        issues.forEach(issue => {
            const code = String(issue.code || 'UNKNOWN').trim() || 'UNKNOWN';
            if (!groupMap.has(code)) {
                groupMap.set(code, {
                    code,
                    count: 0,
                    entities: new Set(),
                    ruleAliases: new Set(),
                    samplePaths: []
                });
            }
            const group = groupMap.get(code);
            group.count += 1;
            if (issue.entityKey) group.entities.add(issue.entityKey);
            if (issue.ruleAlias) group.ruleAliases.add(issue.ruleAlias);
            if (issue.path && group.samplePaths.length < 3) group.samplePaths.push(issue.path);
        });
        return {
            ok: false,
            issueCount: issues.length,
            issueGroups: Array.from(groupMap.values()).map(group => ({
                code: group.code,
                count: group.count,
                entityCount: group.entities.size,
                entities: Array.from(group.entities).slice(0, 8),
                ruleAliases: Array.from(group.ruleAliases).slice(0, 8),
                samplePaths: group.samplePaths
            })),
            sampleIssues: issues.slice(0, 5).map(issue => ({
                code: issue.code,
                path: issue.path,
                field: issue.field,
                message: issue.message,
                expected: issue.expected,
                actual: issue.actual
            })),
            repairCards: this._repairCards(issues).slice(0, 8),
            fullIssuesOmitted: true,
            fullIssuesReason: '为减少上下文，仅返回规则绑定来源闭合摘要；按 repairCards 修复 rule-bindings.json 或 designJson.boundRules 后重跑 preflight。'
        };
    }

    _repairCards(issues = []) {
        const grouped = {};
        issues.forEach(issue => {
            const key = issue.entityKey || '$root';
            if (!grouped[key]) grouped[key] = [];
            grouped[key].push(issue);
        });
        return Object.entries(grouped).map(([key, itemIssues]) => ({
            cardId: `rule-binding-repair-card:${key}`,
            entityKey: key === '$root' ? '' : key,
            issues: itemIssues.map(issue => ({
                code: issue.code,
                path: issue.path,
                message: issue.message,
                expected: issue.expected,
                actual: issue.actual
            })),
            instruction: '修复 rule-bindings.json 的 globalWhitelist/globalBlocklist/entityBindings，使 businessEntities[].boundRules[] 每条规则都有同 entity 来源证据；或移除该 entity boundRules 并将 noRuleCoverage 置为 true。'
        }));
    }
}

module.exports = DesignRuleBindingValidatorService;
