/* eslint-disable */
'use strict';

/**
 * DesignCodingHandoffService — design_prepare_context 末相主校验（entity-first）
 *
 * 职责：在 design_prepare_context 自动封存前 preflight 校验 Coder-facing designJson。
 *
 * entity 重构后：
 *   - schema 校验已由 DesignSchemaValidatorService 完成（businessEntities[] / acceptanceCriteria / linkedTable）
 *   - fileSet 12 件套由 Builder._buildEntityFileSet 直接派生，preflight 不再校验 fileSeeds/htmlPages
 *   - 本 service 只做"占位符未填"扫描 + entity 级业务命名硬约束（domain ≠ bizModule、carriedByEntityKey 闭合）
 *
 * 历史 module-first 版本校验大量字段（fileSeeds/htmlPages/serviceContractSeeds/carriedByModuleId/
 *   excludedFromCoding/_validateHtmlPageName/_suggestBizModuleSlug 等）。entity 重构后
 *   这些都由 Builder 自动派生或 schema-validator 直接拦，不再需要二次校验。
 */
class DesignCodingHandoffService {

    validateDesignHandoff(designDocument = {}, navigationContract = {}) {
        const entities = Array.isArray(designDocument.businessEntities) ? designDocument.businessEntities : [];
        const modules = Array.isArray(designDocument.modules) ? designDocument.modules : [];

        // 双形态兼容：
        //   - entity-first：含 businessEntities → 按 entity 校验（主路径）
        //   - 旧 module-only fixture：仅含 modules → 退化按 module 形态最小校验（兼容历史测试）
        // 真实生产路径走 Builder.build()，输出同时含 businessEntities + modules 投影，
        // 进 entity 校验分支；旧测试 fixture 仅写 modules 不走 Builder，进 module 兼容分支。
        if (entities.length === 0 && modules.length > 0) {
            return this._validateLegacyModulesShape(designDocument, navigationContract);
        }
        return this._validateEntityShape(designDocument, navigationContract);
    }

    _validateEntityShape(designDocument = {}, navigationContract = {}) {
        const entities = Array.isArray(designDocument.businessEntities) ? designDocument.businessEntities : [];
        const placeholderIssues = this._collectTemplatePlaceholderIssues(designDocument);

        const issues = [];

        if (entities.length === 0) {
            issues.push({
                code: 'PREFLIGHT_BUSINESS_ENTITIES_EMPTY',
                path: '$.businessEntities',
                message: 'businessEntities[] 不能为空：每个业务对象必须独立成 entity'
            });
        }

        // entityKey 闭合校验（含 carriedByEntityKey 指向已存在的 entity）
        const entityKeySet = new Set();
        entities.forEach(entity => {
            const entityKey = String(entity && entity.entityKey || '').trim();
            if (entityKey) entityKeySet.add(entityKey);
        });

        for (const entity of entities) {
            const entityKey = String(entity && entity.entityKey || '').trim();
            if (!entityKey) {
                issues.push({
                    code: 'PREFLIGHT_ENTITY_KEY_MISSING',
                    path: '$.businessEntities[].entityKey',
                    message: 'businessEntities[] 缺少 entityKey'
                });
                continue;
            }

            // domain ≠ bizModule（防下游 path 段重复）
            const domainSlug = String(entity.domain || '').trim().toLowerCase();
            const bizModuleSlug = String(entity.bizModule || '').trim().toLowerCase();
            if (domainSlug && bizModuleSlug && domainSlug === bizModuleSlug) {
                issues.push({
                    code: 'PREFLIGHT_ENTITY_DOMAIN_EQUALS_BIZMODULE',
                    path: `$.businessEntities[id=${entityKey}].domain`,
                    entityKey,
                    expected: 'domain ≠ bizModule',
                    actual: domainSlug,
                    message: `entity ${entityKey} domain 与 bizModule 相同（${domainSlug}），违反 domainNaming 规则。domain 是包路径业务大类（多 entity 共享），bizModule 是聚合根级（每个 entity 独占）；相同会让下游路径段重复。`
                });
            }

            // carriedByEntityKey 必须指向已存在的 entityKey 且不指向自己
            const carried = String(entity.carriedByEntityKey || '').trim();
            if (carried) {
                if (carried === entityKey) {
                    issues.push({
                        code: 'PREFLIGHT_CARRIED_BY_SELF',
                        path: `$.businessEntities[id=${entityKey}].carriedByEntityKey`,
                        entityKey,
                        message: `entity ${entityKey} carriedByEntityKey 不能指向自己`
                    });
                } else if (!entityKeySet.has(carried)) {
                    issues.push({
                        code: 'PREFLIGHT_CARRIED_BY_ENTITY_NOT_FOUND',
                        path: `$.businessEntities[id=${entityKey}].carriedByEntityKey`,
                        entityKey,
                        expected: `carriedByEntityKey ∈ {${Array.from(entityKeySet).join(', ')}}`,
                        actual: carried,
                        message: `entity ${entityKey} carriedByEntityKey="${carried}" 未在 businessEntities[] 中定义。`
                    });
                }
            }
        }

        const allIssues = [...issues, ...placeholderIssues];
        if (allIssues.length === 0) {
            return { ok: true, status: 'preflight_valid', preflightLayer: { ok: true, issues: [] } };
        }

        return {
            ok: false,
            status: 'preflight_invalid',
            actionMode: 'repair_design_document_json',
            errorCode: 'DESIGN_PREFLIGHT_FAILED',
            preflightLayer: {
                ok: false,
                issues: allIssues,
                issueCount: allIssues.length
            },
            allowedNextActions: ['repair_design_document_json', 'rerun_design_prepare_context'],
            forbiddenActions: ['write_design_document_json_directly']
        };
    }

    /**
     * 旧 module 形态最小校验：保留下游 plan-service 期望的 missingModules + repairCards 结构。
     * 仅用于兼容旧测试 fixture（用户态生产链路走 Builder.build() 永远进 entity 分支）。
     */
    _validateLegacyModulesShape(designDocument = {}, navigationContract = {}) {
        const modules = Array.isArray(designDocument.modules) ? designDocument.modules : [];
        const placeholderIssues = this._collectTemplatePlaceholderIssues(designDocument);
        const missingModules = [];
        const repairCards = [];

        for (const mod of modules) {
            const moduleId = String(mod && (mod.moduleId || mod.id) || '').trim();
            const handoff = (mod && typeof mod.codingHandoff === 'object' && !Array.isArray(mod.codingHandoff))
                ? mod.codingHandoff : null;
            const missing = [];
            if (!handoff) {
                missing.push('codingHandoff');
                missing.push('codingHandoff.bizModule');
            } else {
                if (!String(handoff.bizModule || '').trim()) missing.push('codingHandoff.bizModule');
                if (!String(mod.domain || handoff.domain || '').trim()) missing.push('domain');
                const domainSlug = String(mod.domain || handoff.domain || '').trim().toLowerCase();
                const bizModuleSlug = String(handoff.bizModule || '').trim().toLowerCase();
                if (domainSlug && bizModuleSlug && domainSlug === bizModuleSlug) {
                    missing.push('domain (must_differ_from_bizModule)');
                }
            }
            if (missing.length > 0) {
                missingModules.push({ moduleId, missing });
                repairCards.push({
                    cardId: `coding-handoff-repair:${moduleId || '$root'}`,
                    moduleId,
                    missing,
                    repairTemplate: {},
                    instruction: '回到 epoint-requirement-design 修 设计文档.json：补齐 codingHandoff.bizModule + domain。'
                });
            }
        }

        if (missingModules.length === 0 && placeholderIssues.length === 0) {
            return { ok: true, status: 'preflight_valid', preflightLayer: { ok: true, issues: [] } };
        }

        return {
            ok: false,
            status: 'preflight_invalid',
            actionMode: 'repair_design_document_json',
            errorCode: 'DESIGN_PREFLIGHT_FAILED',
            missingModules,
            repairCards,
            preflightLayer: {
                ok: false,
                issues: [...placeholderIssues, ...missingModules.flatMap(m => m.missing.map(field => ({
                    code: 'MODULE_HANDOFF_MISSING_FIELD',
                    moduleId: m.moduleId,
                    field,
                    message: `模块 ${m.moduleId} 缺少 ${field}`
                })))],
                issueCount: missingModules.length + placeholderIssues.length
            },
            allowedNextActions: ['repair_design_document_json', 'rerun_design_prepare_context'],
            forbiddenActions: ['write_design_document_json_directly']
        };
    }

    _collectTemplatePlaceholderIssues(value, currentPath = '', context = {}) {
        const issues = [];
        if (typeof value === 'string') {
            if (value.includes('TEMPLATE_FILL_REQUIRED')) {
                issues.push({
                    code: 'TEMPLATE_PLACEHOLDER_NOT_FILLED',
                    path: currentPath || '$',
                    entityKey: context.entityKey || '',
                    actual: value,
                    expected: 'replace TEMPLATE_FILL_REQUIRED with concrete business value',
                    message: `字段 ${currentPath || '$'} 残留 TEMPLATE_FILL_REQUIRED 占位符，请按当前需求填充。`
                });
            }
            return issues;
        }
        if (Array.isArray(value)) {
            value.forEach((item, index) => {
                issues.push(...this._collectTemplatePlaceholderIssues(item, `${currentPath}[${index}]`, context));
            });
            return issues;
        }
        if (!value || typeof value !== 'object') return issues;
        const nextContext = { ...context };
        if (value.entityKey) {
            nextContext.entityKey = String(value.entityKey).trim();
        }
        Object.keys(value).forEach(key => {
            issues.push(...this._collectTemplatePlaceholderIssues(value[key], `${currentPath}.${key}`, nextContext));
        });
        return issues;
    }
}

module.exports = DesignCodingHandoffService;
