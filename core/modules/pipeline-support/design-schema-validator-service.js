/* eslint-disable */
const { PAGE_COMPOSITION_BLOCK_CONTRACT } = require('./design-decision-step-definition');

/**
 * DesignSchemaValidatorService — 设计文档机器合同 schema 校验（entity-first）
 *
 * 校验对象：design_prepare_context Builder 派生的 designJson 顶层结构。
 *
 * 顶层结构：
 *   {
 *     meta: { name },
 *     businessEntities: [{ entityKey, displayName, businessObject, domain, bizModule,
 *                          entityName, featureName, pageName, relatedStoryIds, relatedStories,
 *                          linkedTable, fileSet, carriedByEntityKey? }],
 *     acceptanceCriteria: { <entityKey>: { happyPath:[GWT...], exception:[GWT...], boundary:[GWT...] } },
 *     databaseDesign: { required, status, tables, constraints, createStatements }
 *   }
 *
 * 历史 module-first 校验：modules[] + codingHandoff.fileSeeds/htmlPages 等。entity 重构后
 * Builder 直接派生 fileSet（12 件套），LLM 不再提交 fileSeeds/htmlPages，schema 不需要校验它们。
 */
class DesignSchemaValidatorService {

    /**
     * 把 designJson 标准化（去多余字段，aggregateRoot 默认 = businessObject 等）
     */
    normalizeMachineJson(designJson = {}) {
        const source = this._clone(designJson);
        const normalized = {};

        if (source.meta && typeof source.meta === 'object' && !Array.isArray(source.meta)) {
            const meta = {};
            ['name', 'demandName'].forEach(field => {
                if (source.meta[field] !== undefined && source.meta[field] !== null && String(source.meta[field]).trim()) {
                    meta[field] = source.meta[field];
                }
            });
            normalized.meta = meta;
        } else if ('meta' in source) {
            normalized.meta = source.meta;
        }

        if (Array.isArray(source.stories)) {
            normalized.stories = source.stories;
        }

        if (source.canonicalModel && typeof source.canonicalModel === 'object' && !Array.isArray(source.canonicalModel)) {
            normalized.canonicalModel = source.canonicalModel;
        }
        if (source.managedProjection === true) {
            normalized.managedProjection = true;
        }

        normalized.businessEntities = Array.isArray(source.businessEntities)
            ? source.businessEntities.map(entity => this._normalizeMachineEntity(entity))
            : source.businessEntities;

        // Phase 2 兼容投影：Builder 同时输出 modules[]（每 entity → 1 module + codingHandoff
        // 镜像 fileSet），下游 design-tdd-plan/skeleton/acceptance/business-facts 服务暂时仍按
        // modules[] 消费。normalize 必须保留这份投影到 disk，否则 finalize 落盘后下游读不到模块
        // → moduleCount=0 → plan 物化串联失败。entity-first 真值仍是 businessEntities[]，
        // modules[] 是 derived/display；详见 design-document-builder-service._projectEntitiesToLegacyModules。
        if (Array.isArray(source.modules)) {
            normalized.modules = source.modules;
        }

        if ('acceptanceCriteria' in source) {
            normalized.acceptanceCriteria = source.acceptanceCriteria;
        }
        if ('databaseDesign' in source) {
            normalized.databaseDesign = source.databaseDesign;
        }
        if (source.designDecisionAudit && typeof source.designDecisionAudit === 'object' && !Array.isArray(source.designDecisionAudit)) {
            normalized.designDecisionAudit = source.designDecisionAudit;
        }
        return normalized;
    }

    validateSchema(designJson = {}) {
        const issues = [];

        // 1. Root structure
        issues.push(...this._validateRootStructure(designJson));
        issues.push(...this._validateDatabaseDesign(designJson.databaseDesign));

        // 2. businessEntities
        const entities = Array.isArray(designJson.businessEntities) ? designJson.businessEntities : [];
        const seenEntityKeys = new Set();
        const nonCarriedEntityKeys = new Set();
        entities.forEach(entity => {
            issues.push(...this._validateEntity(entity, seenEntityKeys));
            const entityKey = String(entity && entity.entityKey || '').trim();
            if (entityKey) {
                seenEntityKeys.add(entityKey);
                if (!String(entity && entity.carriedByEntityKey || '').trim()) {
                    nonCarriedEntityKeys.add(entityKey);
                }
            }
        });

        // 3. acceptanceCriteria 顶层 index 校验（required entityKeys = 非 carried；allowed entityKeys = 全集）
        issues.push(...this._validateAcceptanceCriteriaIndex(designJson.acceptanceCriteria, nonCarriedEntityKeys, seenEntityKeys));

        const ok = issues.length === 0;
        return {
            ok,
            status: ok ? 'schema_valid' : 'schema_invalid',
            schemaLayer: {
                ok,
                issues,
                compact: ok ? {
                    ok,
                    issueCount: 0,
                    issueGroups: [],
                    sampleIssues: [],
                    repairCards: []
                } : this._buildCompactSchemaLayer(issues),
                repairCards: ok ? [] : this._buildSchemaRepairCards(issues)
            }
        };
    }

    // ─── Root Structure ───────────────────────────────────────────────────────

    _validateRootStructure(doc = {}) {
        const issues = [];
        const requiredRootFields = ['meta', 'businessEntities', 'acceptanceCriteria', 'databaseDesign'];
        requiredRootFields.forEach(field => {
            if (!(field in doc) || doc[field] === undefined || doc[field] === null) {
                issues.push({
                    code: 'ROOT_MISSING_FIELD',
                    path: `$.${field}`,
                    field,
                    expected: 'present and non-null',
                    actual: 'missing',
                    message: `根结构缺少必填字段 ${field}`,
                    layer: 'schema'
                });
            }
        });

        // Root-level field type checks
        if ('meta' in doc && doc.meta !== null && typeof doc.meta !== 'object') {
            issues.push({ code: 'ROOT_FIELD_TYPE', path: '$.meta', field: 'meta', expected: 'object', actual: typeof doc.meta, layer: 'schema' });
        }
        if ('businessEntities' in doc && !Array.isArray(doc.businessEntities)) {
            issues.push({ code: 'ROOT_FIELD_TYPE', path: '$.businessEntities', field: 'businessEntities', expected: 'array', actual: typeof doc.businessEntities, layer: 'schema' });
        }
        if ('acceptanceCriteria' in doc && doc.acceptanceCriteria !== null && (typeof doc.acceptanceCriteria !== 'object' || Array.isArray(doc.acceptanceCriteria))) {
            issues.push({ code: 'ROOT_FIELD_TYPE', path: '$.acceptanceCriteria', field: 'acceptanceCriteria', expected: 'object keyed by entityKey', actual: Array.isArray(doc.acceptanceCriteria) ? 'array' : typeof doc.acceptanceCriteria, layer: 'schema' });
        }
        if ('databaseDesign' in doc && doc.databaseDesign !== null && typeof doc.databaseDesign !== 'object') {
            issues.push({ code: 'ROOT_FIELD_TYPE', path: '$.databaseDesign', field: 'databaseDesign', expected: 'object', actual: typeof doc.databaseDesign, layer: 'schema' });
        }

        // Meta fields
        if (doc.meta && typeof doc.meta === 'object') {
            ['name'].forEach(f => {
                if (!(f in doc.meta) || doc.meta[f] === undefined || doc.meta[f] === null) {
                    issues.push({ code: 'META_MISSING_FIELD', path: '$.meta.' + f, field: 'meta.' + f, expected: 'present', actual: 'missing', layer: 'schema' });
                }
            });
        }

        return issues;
    }

    // ─── Entity ───────────────────────────────────────────────────────────────

    _validateEntity(entity = {}, seenEntityKeys = new Set()) {
        const issues = [];
        const entityKey = entity && entity.entityKey || '(unnamed)';

        // entityKey 必填 + 形态 + 唯一
        if (!entity.entityKey) {
            issues.push({ code: 'ENTITY_MISSING_FIELD', path: '$.businessEntities[id=(unnamed)].entityKey', field: 'entityKey', expected: 'non-empty string', actual: 'missing', message: 'businessEntities[] 缺少 entityKey', layer: 'schema', entityKey });
        } else if (!/^[a-z][a-z0-9_]*$/.test(entity.entityKey)) {
            issues.push({ code: 'ENTITY_FIELD_VALUE_INVALID', path: `$.businessEntities[id=${entityKey}].entityKey`, field: 'entityKey', expected: '^[a-z][a-z0-9_]*$', actual: entity.entityKey, message: `entityKey="${entity.entityKey}" 必须匹配 ^[a-z][a-z0-9_]*$`, layer: 'schema', entityKey });
        } else if (seenEntityKeys.has(entity.entityKey)) {
            issues.push({ code: 'ENTITY_FIELD_VALUE_INVALID', path: `$.businessEntities[id=${entityKey}].entityKey`, field: 'entityKey', expected: 'unique', actual: 'duplicated', message: `entityKey="${entity.entityKey}" 重复`, layer: 'schema', entityKey });
        }

        // 必填业务命名字段
        ['displayName', 'businessObject', 'domain', 'bizModule'].forEach(field => {
            if (!String(entity[field] || '').trim()) {
                issues.push({
                    code: 'ENTITY_MISSING_FIELD',
                    path: `$.businessEntities[id=${entityKey}].${field}`,
                    field,
                    expected: 'non-empty string',
                    actual: 'missing',
                    message: `entity ${entityKey} 缺少 ${field}`,
                    layer: 'schema',
                    entityKey
                });
            }
        });

        // domain ≠ bizModule
        const domainSlug = String(entity.domain || '').trim().toLowerCase();
        const bizModuleSlug = String(entity.bizModule || '').trim().toLowerCase();
        if (domainSlug && bizModuleSlug && domainSlug === bizModuleSlug) {
            issues.push({
                code: 'ENTITY_DOMAIN_EQUALS_BIZMODULE',
                path: `$.businessEntities[id=${entityKey}].domain`,
                field: 'domain',
                expected: '≠ bizModule',
                actual: domainSlug,
                message: `entity ${entityKey} domain 与 bizModule 相同（${domainSlug}），违反 domainNaming 规则。domain 是包路径业务大类（多 entity 共享），bizModule 是聚合根级（每个 entity 独占）。`,
                layer: 'schema',
                entityKey
            });
        }

        // relatedStoryIds 必填非空数组（carriedByEntityKey entity 例外：由父 entity 承载，不独立关联 Story）
        const carriedByKey = String(entity.carriedByEntityKey || '').trim();
        if (!carriedByKey) {
            if (!Array.isArray(entity.relatedStoryIds) || entity.relatedStoryIds.length === 0) {
                issues.push({
                    code: 'ENTITY_FIELD_EMPTY',
                    path: `$.businessEntities[id=${entityKey}].relatedStoryIds`,
                    field: 'relatedStoryIds',
                    expected: 'non-empty array of storyIds',
                    actual: Array.isArray(entity.relatedStoryIds) ? 'empty array' : (entity.relatedStoryIds === undefined ? 'missing' : typeof entity.relatedStoryIds),
                    message: `entity ${entityKey} relatedStoryIds 不能为空；至少关联 1 个 Story`,
                    layer: 'schema',
                    entityKey
                });
            }
        }

        // linkedTable 必填 + kind ∈ {new, reuse, none}
        const linkedTable = entity.linkedTable;
        if (!linkedTable || typeof linkedTable !== 'object' || Array.isArray(linkedTable)) {
            issues.push({
                code: 'ENTITY_MISSING_FIELD',
                path: `$.businessEntities[id=${entityKey}].linkedTable`,
                field: 'linkedTable',
                expected: 'object with kind ∈ {new, reuse, none}',
                actual: linkedTable === undefined ? 'missing' : (Array.isArray(linkedTable) ? 'array' : typeof linkedTable),
                message: `entity ${entityKey} 缺少 linkedTable`,
                layer: 'schema',
                entityKey
            });
        } else {
            const kind = String(linkedTable.kind || '').trim().toLowerCase();
            if (kind !== 'new' && kind !== 'reuse' && kind !== 'none') {
                issues.push({
                    code: 'ENTITY_LINKED_TABLE_KIND_INVALID',
                    path: `$.businessEntities[id=${entityKey}].linkedTable.kind`,
                    field: 'linkedTable.kind',
                    expected: 'new | reuse | none',
                    actual: linkedTable.kind || 'missing',
                    message: `entity ${entityKey} linkedTable.kind 必须是 new、reuse 或 none`,
                    layer: 'schema',
                    entityKey
                });
            } else if (kind === 'new') {
                if (!String(linkedTable.tableComment || '').trim()) {
                    issues.push({ code: 'ENTITY_MISSING_FIELD', path: `$.businessEntities[id=${entityKey}].linkedTable.tableComment`, field: 'linkedTable.tableComment', expected: 'non-empty string', actual: 'missing', message: `linkedTable.kind=new 时 tableComment 必填`, layer: 'schema', entityKey });
                }
                if (!String(linkedTable.tableFeatureName || '').trim()) {
                    issues.push({ code: 'ENTITY_MISSING_FIELD', path: `$.businessEntities[id=${entityKey}].linkedTable.tableFeatureName`, field: 'linkedTable.tableFeatureName', expected: 'non-empty string', actual: 'missing', message: `linkedTable.kind=new 时 tableFeatureName 必填`, layer: 'schema', entityKey });
                }
                if (!Array.isArray(linkedTable.businessColumns) || linkedTable.businessColumns.length === 0) {
                    issues.push({ code: 'ENTITY_FIELD_EMPTY', path: `$.businessEntities[id=${entityKey}].linkedTable.businessColumns`, field: 'linkedTable.businessColumns', expected: 'non-empty array', actual: Array.isArray(linkedTable.businessColumns) ? 'empty array' : 'missing', message: `linkedTable.kind=new 时 businessColumns 不能为空`, layer: 'schema', entityKey });
                }
            } else if (kind === 'reuse') {
                if (!String(linkedTable.tableName || '').trim()) {
                    issues.push({ code: 'ENTITY_MISSING_FIELD', path: `$.businessEntities[id=${entityKey}].linkedTable.tableName`, field: 'linkedTable.tableName', expected: 'non-empty string', actual: 'missing', message: `linkedTable.kind=reuse 时 tableName 必填`, layer: 'schema', entityKey });
                }
                if (!this._hasReuseEvidence(linkedTable)) {
                    issues.push({
                        code: 'ENTITY_REUSE_EVIDENCE_MISSING',
                        path: `$.businessEntities[id=${entityKey}].linkedTable`,
                        field: 'linkedTable',
                        expected: 'reusedApis[] or scan-derived reuseSourceFile/reuseDirHints/columns',
                        actual: 'missing reuse evidence',
                        message: `linkedTable.kind=reuse 时必须有可执行复用证据：reusedApis[]，或 Builder 从 scan 派生的 reuseSourceFile/reuseDirHints/columns。`,
                        layer: 'schema',
                        entityKey
                    });
                }
            }
            if (Object.prototype.hasOwnProperty.call(linkedTable, 'needsPage') && typeof linkedTable.needsPage !== 'boolean') {
                issues.push({
                    code: 'FIELD_TYPE_MISMATCH',
                    path: `$.businessEntities[id=${entityKey}].linkedTable.needsPage`,
                    field: 'linkedTable.needsPage',
                    expected: 'boolean',
                    actual: typeof linkedTable.needsPage,
                    message: `linkedTable.needsPage 若出现必须是 boolean`,
                    layer: 'schema',
                    entityKey
                });
            }
        }

        if (entity.pageComposition !== undefined) {
            issues.push(...this._validatePageComposition(entity.pageComposition, entityKey));
        }

        return issues;
    }

    _validatePageComposition(composition, entityKey) {
        const issues = [];
        const basePath = `$.businessEntities[id=${entityKey}].pageComposition`;
        const addIssue = (code, suffix, expected, actual, message) => issues.push({
            code,
            path: `${basePath}${suffix}`,
            field: `pageComposition${suffix}`,
            expected,
            actual,
            message,
            layer: 'schema',
            entityKey
        });
        if (!composition || typeof composition !== 'object' || Array.isArray(composition)) {
            addIssue('PAGE_COMPOSITION_TYPE_INVALID', '', 'object', Array.isArray(composition) ? 'array' : typeof composition,
                `entity ${entityKey} pageComposition 必须是 Builder 生成的对象`);
            return issues;
        }
        if (composition.schemaVersion !== 'page-composition/v2') {
            addIssue('PAGE_COMPOSITION_SCHEMA_INVALID', '.schemaVersion', 'page-composition/v2', composition.schemaVersion || 'missing',
                `entity ${entityKey} pageComposition.schemaVersion 必须是 page-composition/v2`);
        }
        if (composition.managedProjection !== true) {
            addIssue('PAGE_COMPOSITION_OWNER_INVALID', '.managedProjection', 'true', composition.managedProjection,
                `entity ${entityKey} pageComposition 必须是 Builder 托管投影`);
        }
        if (!Array.isArray(composition.storyIds) || composition.storyIds.length === 0) {
            addIssue('PAGE_COMPOSITION_STORIES_EMPTY', '.storyIds', 'non-empty array', Array.isArray(composition.storyIds) ? 'empty array' : typeof composition.storyIds,
                `entity ${entityKey} pageComposition.storyIds 不能为空`);
        }
        if (!String(composition.primaryObjectKey || '').trim()) {
            addIssue('PAGE_COMPOSITION_PRIMARY_OBJECT_MISSING', '.primaryObjectKey', 'non-empty string', 'missing',
                `entity ${entityKey} pageComposition 缺少 primaryObjectKey`);
        }
        if (!String(composition.formObjectKey || '').trim()) {
            addIssue('PAGE_COMPOSITION_FORM_OBJECT_MISSING', '.formObjectKey', 'non-empty string', 'missing',
                `entity ${entityKey} pageComposition 缺少formObjectKey`);
        }
        if (composition.decisionTags !== undefined && !Array.isArray(composition.decisionTags)) {
            addIssue('PAGE_COMPOSITION_DECISION_TAGS_INVALID', '.decisionTags', 'array when provided', typeof composition.decisionTags,
                `entity ${entityKey} pageComposition.decisionTags填写时必须是数组，可省略或留空`);
        }
        if (!Array.isArray(composition.practiceIds)) {
            addIssue('PAGE_COMPOSITION_PRACTICES_TYPE_INVALID', '.practiceIds', 'array', typeof composition.practiceIds,
                `entity ${entityKey} pageComposition.practiceIds 必须是数组`);
        }
        if (!['plain', 'accordion'].includes(String(composition.layout || '').trim())) {
            addIssue('PAGE_COMPOSITION_LAYOUT_INVALID', '.layout', 'plain | accordion', composition.layout || 'missing',
                `entity ${entityKey} pageComposition.layout 必须是 plain 或 accordion`);
        }
        if (!Array.isArray(composition.blocks) || composition.blocks.length === 0) {
            addIssue('PAGE_COMPOSITION_BLOCKS_EMPTY', '.blocks', 'non-empty array', Array.isArray(composition.blocks) ? 'empty array' : typeof composition.blocks,
                `entity ${entityKey} pageComposition.blocks 不能为空`);
            return issues;
        }
        const allowedKinds = new Set(Object.keys(PAGE_COMPOSITION_BLOCK_CONTRACT));
        composition.blocks.forEach((block, index) => {
            const blockPath = `.blocks[${index}]`;
            if (!block || typeof block !== 'object' || Array.isArray(block)) {
                addIssue('PAGE_COMPOSITION_BLOCK_TYPE_INVALID', blockPath, 'object', Array.isArray(block) ? 'array' : typeof block,
                    `entity ${entityKey} pageComposition.blocks[${index}] 必须是对象`);
                return;
            }
            const kind = String(block.kind || '').trim();
            const blockContract = PAGE_COMPOSITION_BLOCK_CONTRACT[kind];
            if (!allowedKinds.has(kind)) {
                addIssue('PAGE_COMPOSITION_BLOCK_KIND_INVALID', `${blockPath}.kind`, Array.from(allowedKinds).join(' | '), kind || 'missing',
                    `entity ${entityKey} pageComposition.blocks[${index}].kind 不合法`);
            }
            if (!String(block.objectKey || '').trim()) {
                addIssue('PAGE_COMPOSITION_BLOCK_OBJECT_MISSING', `${blockPath}.objectKey`, 'non-empty string', 'missing',
                    `entity ${entityKey} pageComposition.blocks[${index}] 缺少 objectKey`);
            }
            if (!Array.isArray(block.relationPath)) {
                addIssue('PAGE_COMPOSITION_BLOCK_RELATION_PATH_INVALID', `${blockPath}.relationPath`, 'array', typeof block.relationPath,
                    `entity ${entityKey} ${kind}块缺少Builder生成的relationPath`);
            } else if (blockContract && block.relationPath.length < blockContract.relationPathMinItems) {
                addIssue('PAGE_COMPOSITION_CHILD_RELATION_PATH_EMPTY', `${blockPath}.relationPath`, 'non-empty array', 'empty array',
                    `entity ${entityKey} ${kind}块的relationPath不能为空`);
            }
        });
        if (!Array.isArray(composition.sections)) {
            addIssue('PAGE_COMPOSITION_SECTIONS_TYPE_INVALID', '.sections', 'array', typeof composition.sections,
                `entity ${entityKey} pageComposition.sections必须是数组`);
        } else {
            composition.sections.forEach((section, index) => {
                const sectionPath = `.sections[${index}]`;
                if (!section || typeof section !== 'object' || Array.isArray(section)) {
                    addIssue('PAGE_COMPOSITION_SECTION_TYPE_INVALID', sectionPath, 'object', Array.isArray(section) ? 'array' : typeof section,
                        `entity ${entityKey} pageComposition.sections[${index}]必须是对象`);
                    return;
                }
                if (!String(section.sectionKey || '').trim()) {
                    addIssue('PAGE_COMPOSITION_SECTION_KEY_MISSING', `${sectionPath}.sectionKey`, 'non-empty string', 'missing',
                        `entity ${entityKey} pageComposition.sections[${index}]缺少sectionKey`);
                }
                if (!String(section.title || '').trim()) {
                    addIssue('PAGE_COMPOSITION_SECTION_TITLE_MISSING', `${sectionPath}.title`, 'non-empty string', 'missing',
                        `entity ${entityKey} pageComposition.sections[${index}]缺少title`);
                }
                if (!Array.isArray(section.fieldRefs) || section.fieldRefs.length === 0) {
                    addIssue('PAGE_COMPOSITION_SECTION_FIELDS_INVALID', `${sectionPath}.fieldRefs`, 'non-empty array', Array.isArray(section.fieldRefs) ? 'empty array' : typeof section.fieldRefs,
                        `entity ${entityKey} pageComposition.sections[${index}].fieldRefs不能为空`);
                }
            });
        }
        return issues;
    }

    // ─── acceptanceCriteria 顶层 index ────────────────────────────────────────

    _validateAcceptanceCriteriaIndex(acceptanceCriteria = {}, requiredEntityKeys = new Set(), allowedEntityKeys = null) {
        const issues = [];
        if (!acceptanceCriteria || typeof acceptanceCriteria !== 'object' || Array.isArray(acceptanceCriteria)) return issues;
        // allowedEntityKeys 缺省退化为 requiredEntityKeys（向后兼容）
        const allowedKeys = allowedEntityKeys || requiredEntityKeys;

        // 每个 required entityKey 都必须有对应 acceptanceCriteria 项
        requiredEntityKeys.forEach(entityKey => {
            if (!(entityKey in acceptanceCriteria)) {
                issues.push({
                    code: 'ACCEPTANCE_CRITERIA_MISSING_ENTITY',
                    path: `$.acceptanceCriteria.${entityKey}`,
                    field: `acceptanceCriteria.${entityKey}`,
                    expected: 'object { happyPath, exception, boundary }',
                    actual: 'missing',
                    message: `acceptanceCriteria 缺少 entityKey="${entityKey}" 的分组`,
                    layer: 'schema',
                    entityKey
                });
                return;
            }
            const groups = acceptanceCriteria[entityKey];
            if (!groups || typeof groups !== 'object' || Array.isArray(groups)) {
                issues.push({
                    code: 'FIELD_TYPE_MISMATCH',
                    path: `$.acceptanceCriteria.${entityKey}`,
                    field: `acceptanceCriteria.${entityKey}`,
                    expected: 'object { happyPath, exception, boundary }',
                    actual: Array.isArray(groups) ? 'array' : typeof groups,
                    message: `acceptanceCriteria.${entityKey} 应为 object`,
                    layer: 'schema',
                    entityKey
                });
                return;
            }
            ['happyPath', 'exception', 'boundary'].forEach(group => {
                const arr = groups[group];
                if (!Array.isArray(arr)) {
                    issues.push({
                        code: 'FIELD_TYPE_MISMATCH',
                        path: `$.acceptanceCriteria.${entityKey}.${group}`,
                        field: `acceptanceCriteria.${entityKey}.${group}`,
                        expected: 'array of GWT objects',
                        actual: arr === undefined ? 'missing' : typeof arr,
                        message: `acceptanceCriteria.${entityKey}.${group} 应为数组`,
                        layer: 'schema',
                        entityKey
                    });
                } else {
                    arr.forEach((item, index) => {
                        if (!item || typeof item !== 'object' || Array.isArray(item)) {
                            issues.push({
                                code: 'FIELD_TYPE_MISMATCH',
                                path: `$.acceptanceCriteria.${entityKey}.${group}[${index}]`,
                                field: `acceptanceCriteria.${entityKey}.${group}[${index}]`,
                                expected: 'GWT object { scenario, given, when, then }',
                                actual: item === null ? 'null' : typeof item,
                                message: `acceptanceCriteria.${entityKey}.${group}[${index}] 应为 GWT 对象`,
                                layer: 'schema',
                                entityKey
                            });
                            return;
                        }
                        ['scenario', 'given', 'when', 'then'].forEach(field => {
                            if (!String(item[field] || '').trim()) {
                                issues.push({
                                    code: 'ACCEPTANCE_CRITERIA_MISSING_FIELD',
                                    path: `$.acceptanceCriteria.${entityKey}.${group}[${index}].${field}`,
                                    field: `acceptanceCriteria.${entityKey}.${group}[${index}].${field}`,
                                    expected: 'non-empty string',
                                    actual: 'missing or empty',
                                    message: `acceptanceCriteria.${entityKey}.${group}[${index}] 缺少 ${field}`,
                                    layer: 'schema',
                                    entityKey
                                });
                            }
                        });
                    });
                }
            });
        });

        // acceptanceCriteria 中不应出现未声明的 entityKey
        Object.keys(acceptanceCriteria).forEach(key => {
            if (!allowedKeys.has(key)) {
                issues.push({
                    code: 'ACCEPTANCE_CRITERIA_UNKNOWN_ENTITY',
                    path: `$.acceptanceCriteria.${key}`,
                    field: `acceptanceCriteria.${key}`,
                    expected: `entityKey ∈ {${Array.from(allowedKeys).join(', ')}}`,
                    actual: key,
                    message: `acceptanceCriteria.${key} 出现未声明的 entityKey；businessEntities[] 中没有此 entityKey`,
                    layer: 'schema'
                });
            }
        });

        return issues;
    }

    // ─── databaseDesign（保持原样）────────────────────────────────────────────

    _validateDatabaseDesign(databaseDesign = undefined) {
        const issues = [];
        if (databaseDesign === undefined || databaseDesign === null) return issues;
        if (typeof databaseDesign !== 'object' || Array.isArray(databaseDesign)) return issues;

        if (!('required' in databaseDesign)) {
            issues.push({ code: 'DATABASE_MISSING_FIELD', path: '$.databaseDesign.required', field: 'databaseDesign.required', expected: 'boolean', actual: 'missing', message: 'databaseDesign.required 必填', layer: 'schema' });
        } else if (typeof databaseDesign.required !== 'boolean') {
            issues.push({ code: 'DATABASE_FIELD_TYPE', path: '$.databaseDesign.required', field: 'databaseDesign.required', expected: 'boolean', actual: typeof databaseDesign.required, message: 'databaseDesign.required 应为 boolean', layer: 'schema' });
        }

        if ('status' in databaseDesign && typeof databaseDesign.status !== 'string') {
            issues.push({ code: 'DATABASE_FIELD_TYPE', path: '$.databaseDesign.status', field: 'databaseDesign.status', expected: 'string', actual: typeof databaseDesign.status, message: 'databaseDesign.status 应为 string', layer: 'schema' });
        }

        if ('tables' in databaseDesign && !Array.isArray(databaseDesign.tables)) {
            issues.push({ code: 'DATABASE_FIELD_TYPE', path: '$.databaseDesign.tables', field: 'databaseDesign.tables', expected: 'array', actual: typeof databaseDesign.tables, message: 'databaseDesign.tables 应为数组', layer: 'schema' });
        } else if (Array.isArray(databaseDesign.tables)) {
            databaseDesign.tables.forEach((table, i) => {
                issues.push(...this._validateDatabaseTable(table, i));
            });
        }

        return issues;
    }

    _validateDatabaseTable(table = {}, tableIndex = 0) {
        const issues = [];
        const tablePath = `$.databaseDesign.tables[${tableIndex}]`;

        if (!table || typeof table !== 'object' || Array.isArray(table)) return issues;
        this._requireNonEmptyString(issues, tablePath, 'tableName', table.tableName, `databaseDesign.tables[${tableIndex}] 缺少 tableName`);
        this._requireNonEmptyString(issues, tablePath, 'tableComment', table.tableComment, `databaseDesign.tables[${tableIndex}] 缺少 tableComment`);

        if ('reuse' in table && typeof table.reuse !== 'boolean') {
            issues.push({ code: 'DATABASE_TABLE_FIELD_TYPE', path: `${tablePath}.reuse`, field: `tables[${tableIndex}].reuse`, expected: 'boolean', actual: typeof table.reuse, layer: 'schema' });
        }
        if (table.reuse === true) {
            if (!this._hasReuseEvidence(table)) {
                issues.push({
                    code: 'DATABASE_TABLE_REUSE_EVIDENCE_MISSING',
                    path: tablePath,
                    field: `tables[${tableIndex}]`,
                    expected: 'reusedApis[] or scan-derived reuseSourceFile/reuseDirHints/columns',
                    actual: 'missing reuse evidence',
                    message: `复用表 tables[${tableIndex}] 必须有可执行复用证据：reusedApis[]，或 Builder 从 scan 派生的 reuseSourceFile/reuseDirHints/columns。`,
                    layer: 'schema'
                });
            }
            if (Array.isArray(table.columns) && table.columns.length > 0) {
                issues.push(...this._validateDatabaseColumns(table.columns, tablePath, `tables[${tableIndex}].columns`));
            }
        } else {
            // 新建表：columns 必填
            if (!Array.isArray(table.columns) || table.columns.length === 0) {
                issues.push({ code: 'DATABASE_TABLE_FIELD_EMPTY', path: `${tablePath}.columns`, field: `tables[${tableIndex}].columns`, expected: 'non-empty array', actual: 'missing or empty', message: `新建表 tables[${tableIndex}] columns 必须非空`, layer: 'schema' });
            } else {
                issues.push(...this._validateDatabaseColumns(table.columns, tablePath, `tables[${tableIndex}].columns`));
            }
        }

        return issues;
    }

    _validateDatabaseColumns(columns = [], pathPrefix = '', fieldPrefix = '') {
        const issues = [];
        columns.forEach((column, index) => {
            const columnPath = `${pathPrefix}.columns[${index}]`;
            const fieldPath = `${fieldPrefix}[${index}]`;
            if (!column || typeof column !== 'object' || Array.isArray(column)) {
                issues.push({ code: 'DATABASE_COLUMN_FIELD_TYPE', path: columnPath, field: fieldPath, expected: 'object', actual: column === null ? 'null' : typeof column, layer: 'schema' });
                return;
            }
            this._requireNonEmptyString(issues, columnPath, 'name', column.name, `${fieldPath} 缺少 name`);
            this._requireNonEmptyString(issues, columnPath, 'type', column.type, `${fieldPath} 缺少 type`);
            if ('required' in column && typeof column.required !== 'boolean') {
                issues.push({ code: 'DATABASE_COLUMN_FIELD_TYPE', path: `${columnPath}.required`, field: `${fieldPath}.required`, expected: 'boolean', actual: typeof column.required, layer: 'schema' });
            }
            if ('formRequired' in column && typeof column.formRequired !== 'boolean') {
                issues.push({ code: 'DATABASE_COLUMN_FIELD_TYPE', path: `${columnPath}.formRequired`, field: `${fieldPath}.formRequired`, expected: 'boolean', actual: typeof column.formRequired, layer: 'schema' });
            }
        });
        return issues;
    }

    _requireNonEmptyString(issues, path, field, value, message, code = 'DATABASE_TABLE_MISSING_FIELD') {
        if (!String(value || '').trim()) {
            issues.push({
                code,
                path: `${path}.${field}`,
                field: `${path.replace(/^\$\./, '')}.${field}`,
                expected: 'non-empty string',
                actual: value === undefined ? 'missing' : (value === null ? 'null' : 'empty string'),
                message,
                layer: 'schema'
            });
        }
    }

    _hasReuseEvidence(value = {}) {
        if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
        if (Array.isArray(value.reusedApis) && value.reusedApis.some(item => String(item || '').trim())) return true;
        if (String(value.reuseSourceFile || '').trim()) return true;
        if (Array.isArray(value.reuseDirHints) && value.reuseDirHints.some(item => String(item || '').trim())) return true;
        if (Array.isArray(value.columns) && value.columns.length > 0) return true;
        return false;
    }

    // ─── Repair Cards / Compact ───────────────────────────────────────────────

    _buildCompactSchemaLayer(issues = []) {
        const groupMap = new Map();
        issues.forEach(issue => {
            const code = String(issue.code || 'UNKNOWN').trim() || 'UNKNOWN';
            const key = code;
            if (!groupMap.has(key)) {
                groupMap.set(key, {
                    code,
                    count: 0,
                    entities: new Set(),
                    fields: new Set(),
                    samplePaths: []
                });
            }
            const group = groupMap.get(key);
            group.count += 1;
            if (issue.entityKey) group.entities.add(issue.entityKey);
            if (issue.field) group.fields.add(issue.field);
            if (issue.path && group.samplePaths.length < 3) group.samplePaths.push(issue.path);
        });
        const issueGroups = Array.from(groupMap.values()).map(group => ({
            code: group.code,
            count: group.count,
            entityCount: group.entities.size,
            entities: Array.from(group.entities).slice(0, 8),
            fields: Array.from(group.fields).slice(0, 12),
            samplePaths: group.samplePaths
        }));
        const sampleIssues = issues.slice(0, 5).map(issue => ({
            code: issue.code,
            path: issue.path,
            field: issue.field,
            message: issue.message || '',
            expected: issue.expected,
            actual: issue.actual
        }));
        return {
            ok: false,
            issueCount: issues.length,
            issueGroups,
            sampleIssues,
            repairCards: this._buildSchemaRepairCards(issues).slice(0, 8),
            fullIssuesOmitted: true,
            fullIssuesReason: '为减少上下文，仅返回分组摘要和少量样例；按 issueGroups 修复后重跑 preflight。'
        };
    }

    _buildSchemaRepairCards(issues = []) {
        const grouped = {};
        issues.forEach(issue => {
            const key = issue.entityKey || '$root';
            if (!grouped[key]) grouped[key] = [];
            grouped[key].push(issue);
        });

        return Object.entries(grouped).map(([key, itemIssues]) => {
            const entityKey = key === '$root' ? '' : key;
            return {
                cardId: `schema-repair-card:${key}`,
                entityKey,
                issues: itemIssues.map(i => ({
                    code: i.code,
                    path: i.path,
                    message: i.message,
                    expected: i.expected,
                    actual: i.actual,
                    suggestedValue: i.suggestedValue || '',
                    suggestedFix: i.suggestedFix || ''
                })),
                repairTemplate: this._buildSchemaRepairTemplate(itemIssues),
                instruction: this._buildSchemaRepairInstruction(itemIssues)
            };
        });
    }

    _buildSchemaRepairTemplate(issues = []) {
        const template = {};
        const fields = issues.map(issue => String(issue.field || '')).filter(Boolean);

        // entity 级缺失字段
        const entityMissing = fields.filter(field => /^(displayName|businessObject|domain|bizModule|relatedStoryIds|linkedTable)$/.test(field));
        if (entityMissing.length > 0) {
            template.entityRequiredFields = entityMissing;
        }

        // linkedTable 缺失子字段
        const linkedTableFields = fields.filter(field => /^linkedTable\./.test(field));
        if (linkedTableFields.length > 0) {
            template.linkedTableMissingFields = linkedTableFields;
        }

        // acceptanceCriteria 缺失
        const acFields = fields.filter(field => /^acceptanceCriteria\./.test(field));
        if (acFields.length > 0) {
            template.acceptanceCriteriaMissingFields = acFields;
        }

        if (issues.some(issue => /^databaseDesign/.test(String(issue.field || '')))) {
            template.databaseDesign = 'object，包含 required/status；新建表使用 tableComment + columns[]，复用表必须带 reusedApis[] 或 scan 派生的 reuseSourceFile/reuseDirHints/columns';
        }
        return template;
    }

    _buildSchemaRepairInstruction(issues = []) {
        const codes = issues.map(i => i.code);
        const lines = [];

        if (codes.includes('ROOT_MISSING_FIELD')) {
            lines.push('根结构缺少必填字段，请补充完整的顶层字段（meta / businessEntities / acceptanceCriteria / databaseDesign）。');
        }
        if (codes.includes('FIELD_TYPE_MISMATCH')) {
            lines.push('存在字段类型不匹配，按 issues[].expected 修复字段形状。');
        }
        if (codes.includes('ENTITY_MISSING_FIELD') || codes.includes('ENTITY_FIELD_EMPTY')) {
            const missingFields = issues.filter(i => i.code === 'ENTITY_MISSING_FIELD').map(i => i.field);
            const emptyFields = issues.filter(i => i.code === 'ENTITY_FIELD_EMPTY').map(i => i.field);
            lines.push(`entity 缺少或空字段：${missingFields.concat(emptyFields).join(' / ')}。`);
        }
        if (codes.includes('ENTITY_DOMAIN_EQUALS_BIZMODULE')) {
            lines.push('entity domain 与 bizModule 相同；请按 domainNaming 规则把 domain 改成业务集群级 slug，与 bizModule（聚合根级）分开。');
        }
        if (codes.includes('ENTITY_LINKED_TABLE_KIND_INVALID')) {
            lines.push('linkedTable.kind 必须是 new、reuse 或 none。new 必带 tableComment + tableFeatureName + businessColumns；reuse 必带 tableName，并由 reusedApis[] 或 scan 派生的 reuseSourceFile/reuseDirHints/columns 提供复用证据；none 表示无本地持久化承载。');
        }
        if (codes.includes('ENTITY_REUSE_EVIDENCE_MISSING')) {
            lines.push('复用表缺少可执行复用证据：如果已有 Service API 就填写 reusedApis[]；如果只有历史表/Entity，需回到 scan/规则池确认该表候选，让 Builder 派生 reuseSourceFile/reuseDirHints/columns。');
        }
        if (codes.some(code => /^ACCEPTANCE_CRITERIA_/.test(code))) {
            lines.push('acceptanceCriteria 顶层 object 按 entityKey 分组，每个 entityKey 必须有 happyPath/exception/boundary 三组数组；GWT 必须包含 scenario/given/when/then。');
        }
        if (codes.some(code => /^DATABASE_/.test(code))) {
            lines.push('databaseDesign 必须使用当前设计 JSON 机器合同：required/status 必填；新建表使用 tableComment + columns[]；复用表必须带 reusedApis[] 或 scan 派生的 reuseSourceFile/reuseDirHints/columns。');
        }
        if (codes.includes('FIELD_VALUE_INVALID')) {
            lines.push('存在字段值不符合机器合同，请按 issue.path 修正对应字段。');
        }
        return lines.join(' ');
    }

    // ─── Normalize ────────────────────────────────────────────────────────────

    _normalizeMachineEntity(entity = {}) {
        if (!entity || typeof entity !== 'object' || Array.isArray(entity)) return entity;
        const next = {};
        [
            'entityKey',
            'displayName',
            'businessObject',
            'aggregateRoot',
            'domain',
            'bizModule',
            'entityName',
            'featureName',
            'pageName',
            'constructionSceneKey',
            'practiceSceneKeys',
            'interactionCarrier',
            'constructionBindings',
            'statisticsContract',
            'statisticsContracts',
            'restContract',
            'pageComposition',
            'relatedStoryIds',
            'relatedStories',
            'linkedTable',
            'fileSet',
            'carriedByEntityKey'
        ].forEach(field => {
            if (entity[field] !== undefined) {
                next[field] = this._clone(entity[field]);
            }
        });

        // Builder-owned derivation: aggregateRoot 缺失时默认等于 businessObject
        if (!next.aggregateRoot && next.businessObject) {
            next.aggregateRoot = next.businessObject;
        }

        // bizModule / pageName 是 Builder-owned 派生字段。normalize 只做缺失兜底和物理路径段
        // 清洗，不能再把 Builder 已净化的命名强行覆盖回 entityKey 去下划线值。
        const fallbackBizModule = String(next.entityKey || '').trim().toLowerCase().replace(/[_\-]/g, '');
        const currentBizModule = String(next.bizModule || '').trim().toLowerCase().replace(/[_\-]/g, '');
        next.bizModule = currentBizModule || fallbackBizModule;
        if (next.bizModule) {
            next.pageName = String(next.bizModule).trim().toLowerCase();
        }

        return next;
    }

    _clone(value) {
        if (value === undefined) return {};
        try {
            return JSON.parse(JSON.stringify(value));
        } catch (error) {
            return value && typeof value === 'object' ? { ...value } : value;
        }
    }

    _pick(...values) {
        for (const value of values) {
            const text = String(value || '').trim();
            if (text) return text;
        }
        return '';
    }
}

module.exports = DesignSchemaValidatorService;
