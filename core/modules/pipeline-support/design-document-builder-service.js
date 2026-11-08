/* eslint-disable */

/**
 * DesignDocumentBuilderService — 设计文档机器合同 Builder（entity-first）
 *
 * 设计阶段 LLM 入参精简为"业务对象 + 表绑定"判断，
 * Builder 从需求阶段 stories.json 读 userStory/acceptanceCriteria/invariants
 * （AGENTS.md "确定事实不进 LLM 视野" 红线），并派生完整 designJson 机器合同。
 *
 * 历史 module-first 形态：每个 User Story 一个 module → 同业务对象多 Story 时
 * domain/bizModule/entityName 重复填 N 份，LLM 凭印象写错（实测 7 个 Story 5 个撞名 +
 * 1 个 Place vs PlaceWindow 撞表 → 窗口骨架完全没生成）。
 *
 * entity-first 形态：N 个 Story → M 个业务对象 entity。
 * 同一业务对象、同一可验收结果、同一 Coder 施工场景的多个动作 Story 才归到同一 entity.relatedStoryIds[]。
 * REST / Job / 独立查询入口 / 既有入口补丁 / 后台承载即使共享同一张表，也应拆成不同 entity。
 * Builder 按 entityKey + constructionSceneKey + linkedTable 派生 entityName / fileSet / acceptanceCriteria；
 * Builder 不用关键词裁判语义，只校验结构和同一 entity 内部自洽。
 *
 * 入参形态：
 *   {
 *     entityJudgments: [
 *       {
 *         entityKey: "<slug>",                  // LLM-owned 唯一业务对象 slug
 *         displayName: "<2-8 字中文短名>",       // LLM-owned
 *         businessObject: "<纯名词>",            // LLM-owned
 *         domain: "<slug>",                     // LLM-owned 包路径业务大类（多 entity 共享，必须 ≠ entityKey）
 *         relatedStoryIds: ["US1", "US2", ...], // LLM-owned 关联 storyIds
 *         constructionSceneKey: "crud_new_full" // LLM-owned 施工场景锁；Builder 只做枚举/冲突校验和工程映射
 *         practiceSceneKeys?: ["code_item"],    // LLM-owned 专项实践场景，Builder 后续映射 practiceCards
 *         statisticsContract?: { ... },         // Builder-owned，单 Story 兼容字段
 *         statisticsContracts?: [{ storyId, ... }], // Builder-owned，由需求阶段 stories[].statisticsIntent 按 Story 投影
 *         restContract?: {                      // operations 为 LLM-owned，basePath 由 Builder 从 entityKey 派生
 *           operations: [{ methodName, path, httpMethod, purpose, requestShape, responseShape }]
 *         },
 *         linkedTable: {                        // LLM-owned 必填
 *           kind: 'new' | 'reuse' | 'none',
 *           // kind=new: tableComment, tableFeatureName, businessColumns
 *           // kind=reuse: tableName, reusedApis?: []
 *         },
 *         carriedByEntityKey?: '<parent>'       // LLM-owned 可选
 *       }
 *     ]
 *   }
 *
 * 输出 designJson 顶层：
 *   {
 *     meta: { name },
 *     businessEntities: [{ entityKey, entityName, displayName, ..., fileSet, relatedStories }],
 *     acceptanceCriteria: { <entityKey>: { happyPath, exception, boundary } },
 *     databaseDesign: { required, status, tables, constraints, createStatements }
 *   }
 *
 * Builder-owned 字段（不在 LLM 入参里）：entityName / featureName / pageName / fileSet /
 *   acceptanceCriteria / relatedStories / databaseDesign.tables[].tableName /
 *   createStatements / 公共字段（rowguid/operate xxx/yearflag/belongxiaqucode/pviguid）
 */

const {
    CONSTRUCTION_SCENE_KEYS,
    sceneSupportsLinkedTableKind,
    getNeedsPageMode
} = require('./design-construction-scene-contract');
const DesignStoryWorkPackageCompiler = require('./design-story-work-package-compiler');

const MIXED_PREPARE_REPAIR_GUIDE = 'mixed_prepare_then_patch必须同时有Requirement确认的既有入口证据，以及新Carrier或独立结果面。';
const OPENDIALOG_RESULT_SURFACE_REPAIR_GUIDE = '页面组合由Builder根据Requirement既有入口证据和canonical surface机械投影，禁止手填内部交互载体。';

const PRACTICE_SCENE_KEYS = Object.freeze([
    'code_item',
    'attachment_preview_download',
    'external_api',
    'audit_log',
    'system_parameter',
    'job_or_mq',
    'status_flow',
    'workflow',
    'statistics_analysis',
    'report_analysis'
]);

class DesignDocumentBuilderService {

    constructor(options = {}) {
        this.storyWorkPackageCompiler = options.storyWorkPackageCompiler || new DesignStoryWorkPackageCompiler();
    }

    /**
     * 主入口：从瘦身入参派生完整 designJson。
     *
     * @param {object} args DesignModelCompiler受管投影 { entityJudgments, canonicalModel, managedProjection }
     * @param {object} context { demandName, navigationContract, confirmedRequirementRulePool, requirementStories }
     * @returns { ok, designJson?, errorCode?, message?, issues? }
     */
    build(args = {}, context = {}) {
        // 需求阶段 stories.json 是确定事实，必须存在；Builder 按 storyId join 取整 story 对象。
        const requirementStories = context.requirementStories || null;
        const storiesById = new Map();
        if (requirementStories && Array.isArray(requirementStories.stories)) {
            for (const story of requirementStories.stories) {
                const id = String(story && story.storyId || '').trim().toUpperCase();
                if (id) storiesById.set(id, story);
            }
        }

        const issues = [];
        const trustedCanonicalProjection = args.managedProjection === true
            && args.allowSharedStoryIds === true
            && args.canonicalModel
            && args.canonicalModel.schemaVersion === 'design-canonical-model/v1'
            && args.canonicalModel.managedBy === 'design_model_compiler';
        const inputJudgments = Array.isArray(args.entityJudgments) ? args.entityJudgments : [];
        const inputTableCandidateFitDecisions = args.tableCandidateFitDecisions;

        if (inputJudgments.length === 0) {
            issues.push({
                code: 'DESIGN_BUILDER_ENTITIES_EMPTY',
                field: 'entityJudgments',
                message: '受管canonical model没有生成任何Builder entity投影。'
            });
        }
        if (storiesById.size === 0) {
            issues.push({
                code: 'DESIGN_BUILDER_REQUIREMENT_STORIES_MISSING',
                field: 'requirementStories',
                message: '需求阶段 stories.json 缺失或为空；设计阶段必须先回需求阶段调 req_stories_submit 提交结构化 User Story。'
            });
        }

        // 1) entityKey 唯一性 + 必填字段
        const seenEntityKeys = new Set();
        // bizModule = entityKey 去下划线后的包路径段；两个不同 entityKey 归一化后撞同一段必须报错，
        // 不能静默合并（否则两个 entity 物化到同一包/页面路径，文件互相覆盖）。
        const seenPathSegments = new Map();
        const allUsedStoryIds = new Set();
        const storyIdOwnerMap = new Map();
        const expectedStoryIds = new Set(Array.from(storiesById.keys()));

        inputJudgments.forEach((entity, idx) => {
            const entityKey = String(entity && entity.entityKey || '').trim();
            if (!entityKey) {
                issues.push({
                    code: 'DESIGN_BUILDER_ENTITY_KEY_MISSING',
                    field: `entityJudgments[${idx}].entityKey`,
                    message: `entityJudgments[${idx}] 缺少 entityKey；每个 entity 必须有唯一英文 slug。`
                });
            } else if (!/^[a-z][a-z0-9_]*$/.test(entityKey)) {
                issues.push({
                    code: 'DESIGN_BUILDER_ENTITY_KEY_INVALID',
                    field: `entityJudgments[${idx}].entityKey`,
                    entityKey,
                    message: `entityJudgments[${idx}].entityKey="${entityKey}" 必须匹配 ^[a-z][a-z0-9_]*$（纯小写 ASCII + 下划线），禁止 camelCase/PascalCase。`
                });
            } else if (seenEntityKeys.has(entityKey)) {
                issues.push({
                    code: 'DESIGN_BUILDER_ENTITY_KEY_DUPLICATED',
                    field: `entityJudgments[${idx}].entityKey`,
                    entityKey,
                    message: `entityJudgments[${idx}].entityKey="${entityKey}" 重复；同一需求内 entityKey 必须唯一。`
                });
            }
            if (entityKey) seenEntityKeys.add(entityKey);

            // bizModule 由 entityKey 去下划线派生（Java 包路径段 / HTML 文件名段必须纯小写字母数字）。
            // 校验归一化后是否与另一个 entityKey 撞段——撞了就报错，不静默合并。
            if (entityKey && /^[a-z][a-z0-9_]*$/.test(entityKey)) {
                const pathSegment = this._toPathSegment(entityKey);
                if (seenPathSegments.has(pathSegment) && seenPathSegments.get(pathSegment) !== entityKey) {
                    issues.push({
                        code: 'DESIGN_BUILDER_ENTITY_KEY_PATH_SEGMENT_COLLISION',
                        field: `entityJudgments[${idx}].entityKey`,
                        entityKey,
                        message: `entityJudgments[${idx}].entityKey="${entityKey}" 去下划线后为 "${pathSegment}"，与 entityKey="${seenPathSegments.get(pathSegment)}" 冲突。两者会渲染成同一包路径/页面段导致文件互相覆盖；请改用不会撞段的业务短名。`
                    });
                } else {
                    seenPathSegments.set(pathSegment, entityKey);
                }
            }

            // 必填业务命名字段（bizModule 不再 LLM-owned，由 Builder 从 entityKey 派生）
            ['displayName', 'businessObject', 'domain'].forEach(field => {
                if (!String(entity && entity[field] || '').trim()) {
                    issues.push({
                        code: 'DESIGN_BUILDER_ENTITY_FIELD_MISSING',
                        field: `entityJudgments[${idx}].${field}`,
                        entityKey,
                        message: `entityJudgments[${idx}].${field} 必填。`
                    });
                }
            });

            this._validateConstructionScene(entity, idx, storiesById).forEach(issue => issues.push(issue));
            this._validateStatisticsContract(entity, idx).forEach(issue => issues.push(issue));
            this._validateWorkflowContract(entity, idx).forEach(issue => issues.push(issue));
            this._validateRestContract(entity, idx).forEach(issue => issues.push(issue));

            // domain ≠ entityKey 哨兵（bizModule = entityKey，domain 与之相同会让下游路径段重复）
            const domainSlug = String(entity && entity.domain || '').trim().toLowerCase();
            if (entityKey && domainSlug && domainSlug === entityKey) {
                issues.push({
                    code: 'DESIGN_BUILDER_ENTITY_DOMAIN_EQUALS_BIZMODULE',
                    field: `entityJudgments[${idx}].domain`,
                    entityKey,
                    message: `entityJudgments[${idx}].domain="${domainSlug}" 与 entityKey 相同。domain 是包路径业务大类（多 entity 共享），entityKey 是具体业务对象；相同会让下游路径段重复。请把 domain 改为这些 entity 共属的业务集群英文短名，不要等于具体 entity 名。`
                });
            }
            // domain 禁止下划线（Java 包路径段规范）
            if (domainSlug && /_/.test(domainSlug)) {
                issues.push({
                    code: 'DESIGN_BUILDER_ENTITY_DOMAIN_CONTAINS_UNDERSCORE',
                    field: `entityJudgments[${idx}].domain`,
                    entityKey,
                    message: `entityJudgments[${idx}].domain="${domainSlug}" 包含下划线。domain 作为 Java 包路径段使用，必须是纯小写字母+数字（^[a-z][a-z0-9]*$），不能有下划线。`
                });
            }

            // relatedStoryIds 必填非空，每个 storyId 必须 ∈ stories.json 且全局唯一归属
            const storyIds = Array.isArray(entity && entity.relatedStoryIds) ? entity.relatedStoryIds : [];
            if (storyIds.length === 0) {
                issues.push({
                    code: 'DESIGN_BUILDER_ENTITY_RELATED_STORIES_EMPTY',
                    field: `entityJudgments[${idx}].relatedStoryIds`,
                    entityKey,
                    message: `entityJudgments[${idx}].relatedStoryIds 不能为空；每个 entity 至少关联 1 个 Story。`
                });
            }
            storyIds.forEach((sid, sidx) => {
                const upper = String(sid || '').trim().toUpperCase();
                if (!upper) {
                    issues.push({
                        code: 'DESIGN_BUILDER_ENTITY_STORY_ID_EMPTY',
                        field: `entityJudgments[${idx}].relatedStoryIds[${sidx}]`,
                        entityKey,
                        message: `entityJudgments[${idx}].relatedStoryIds[${sidx}] 是空字符串。`
                    });
                    return;
                }
                if (expectedStoryIds.size > 0 && !expectedStoryIds.has(upper)) {
                    issues.push({
                        code: 'DESIGN_BUILDER_ENTITY_STORY_ID_NOT_IN_REQUIREMENT',
                        field: `entityJudgments[${idx}].relatedStoryIds[${sidx}]`,
                        entityKey,
                        storyId: upper,
                        message: `entityJudgments[${idx}].relatedStoryIds[${sidx}]="${upper}" 不在需求阶段 stories.json 中（合法 storyIds: ${Array.from(expectedStoryIds).join(', ')}）。`
                    });
                }
                if (allUsedStoryIds.has(upper) && !trustedCanonicalProjection) {
                    // 允许父子关系的 entity 共享 storyId：
                    // 如果当前 entity 的 carriedByEntityKey 指向已占用该 storyId 的 entity，
                    // 或已占用该 storyId 的 entity 的 carriedByEntityKey 指向当前 entity，则放行。
                    const carriedBy = String(entity && entity.carriedByEntityKey || '').trim();
                    const ownerEntityKey = storyIdOwnerMap.get(upper) || '';
                    const ownerEntity = inputJudgments.find(e => String(e && e.entityKey || '').trim() === ownerEntityKey);
                    const ownerCarriedBy = String(ownerEntity && ownerEntity.carriedByEntityKey || '').trim();
                    const isParentChild = (carriedBy === ownerEntityKey) || (ownerCarriedBy === entityKey);
                    if (!isParentChild) {
                        issues.push({
                            code: 'DESIGN_BUILDER_STORY_ID_BOUND_TO_MULTIPLE_ENTITIES',
                            field: `entityJudgments[${idx}].relatedStoryIds[${sidx}]`,
                            entityKey,
                            storyId: upper,
                    message: `storyId="${upper}" 已经被 entity="${ownerEntityKey}" 和 entity="${entityKey}" 同时关联；每个 storyId 只能归属唯一非父子 entity（父子关系允许共享）。不要简单合并所有冲突 entity。请先判定冲突类型：同一主业务能力的多个动作 Story → 合并到主业务 entity；父子关系 → 子 entity 填 carriedByEntityKey；主业务结果 + 副作用/审计记录 → Story 归主业务 entity，副作用 entity 只绑定自己的独立 Story；既有入口调整只是入口承载证据，不是跳过设计归属的理由，若无本地持久化可归入 linkedTable.kind="none" 的主业务能力 entity；一个 Story 同时包含多个独立用户目标且无法唯一归属 → 回需求阶段拆 Story 后再提交。`
                        });
                    }
                }
                if (!allUsedStoryIds.has(upper)) {
                    storyIdOwnerMap.set(upper, entityKey);
                }
                allUsedStoryIds.add(upper);
            });

            // linkedTable 必填 + 形态校验
            const linkedTable = entity && entity.linkedTable;
            if (!linkedTable || typeof linkedTable !== 'object' || Array.isArray(linkedTable)) {
                issues.push({
                    code: 'DESIGN_BUILDER_ENTITY_LINKED_TABLE_MISSING',
                    field: `entityJudgments[${idx}].linkedTable`,
                    entityKey,
                    message: `entityJudgments[${idx}].linkedTable 必填；每个 entity 必须说明数据承载（kind=new / kind=reuse / kind=none）。`
                });
            } else {
                const kind = String(linkedTable.kind || '').trim().toLowerCase();
                if (kind !== 'new' && kind !== 'reuse' && kind !== 'none') {
                    issues.push({
                        code: 'DESIGN_BUILDER_ENTITY_LINKED_TABLE_KIND_INVALID',
                        field: `entityJudgments[${idx}].linkedTable.kind`,
                        entityKey,
                        message: `entityJudgments[${idx}].linkedTable.kind 必须是 'new'、'reuse' 或 'none'（当前="${linkedTable.kind}"）。`
                    });
                } else if (kind === 'new') {
                    if (!String(linkedTable.tableComment || '').trim()) {
                        issues.push({
                            code: 'DESIGN_BUILDER_ENTITY_NEW_TABLE_COMMENT_MISSING',
                            field: `entityJudgments[${idx}].linkedTable.tableComment`,
                            entityKey,
                            message: `linkedTable.kind=new 时 tableComment 必填。`
                        });
                    }
                    const tableFeatureName = String(linkedTable.tableFeatureName || '').trim();
                    if (!tableFeatureName) {
                        issues.push({
                            code: 'DESIGN_BUILDER_ENTITY_NEW_TABLE_FEATURE_MISSING',
                            field: `entityJudgments[${idx}].linkedTable.tableFeatureName`,
                            entityKey,
                            message: `linkedTable.kind=new 时 tableFeatureName 必填（参与 tableName 派生）。`
                        });
                    } else if (!/^[a-z][a-z0-9_]*$/.test(tableFeatureName)) {
                        issues.push({
                            code: 'DESIGN_BUILDER_ENTITY_NEW_TABLE_FEATURE_ASCII_INVALID',
                            field: `entityJudgments[${idx}].linkedTable.tableFeatureName`,
                            entityKey,
                            value: tableFeatureName,
                            message: `linkedTable.kind=new 时 tableFeatureName 必须是业务特征英文 slug（^[a-z][a-z0-9_]*$），用于 Java 类名和 tableName 派生；中文说明请放 tableComment，例如 tableFeatureName="cert_call_daily_stat"，不要填 "${tableFeatureName}"。`
                        });
                    }
                    if (!Array.isArray(linkedTable.businessColumns) || linkedTable.businessColumns.length === 0) {
                        issues.push({
                            code: 'DESIGN_BUILDER_ENTITY_NEW_TABLE_COLUMNS_EMPTY',
                            field: `entityJudgments[${idx}].linkedTable.businessColumns`,
                            entityKey,
                            message: `linkedTable.kind=new 时 businessColumns 不能为空；至少声明 1 个业务字段。`
                        });
                    } else {
                        // codeItem 形态校验
                        linkedTable.businessColumns.forEach((col, ci) => {
                            issues.push(...this._validateCodeItemColumnProjection(col, idx, ci, entityKey));
                            if (col && typeof col === 'object' && Object.prototype.hasOwnProperty.call(col, 'codeItem')) {
                                if (typeof col.codeItem !== 'string' || !col.codeItem.trim()) {
                                    issues.push({
                                        code: 'DESIGN_BUILDER_ENTITY_COLUMN_CODE_ITEM_INVALID',
                                        field: `entityJudgments[${idx}].linkedTable.businessColumns[${ci}].codeItem`,
                                        entityKey,
                                        message: `businessColumns[${ci}].codeItem 若出现，必须是非空中文代码项名称字符串；普通字段不要传 codeItem。`
                                    });
                                }
                            }
                            if (col && typeof col === 'object' && Object.prototype.hasOwnProperty.call(col, 'attachmentKey')) {
                                if (typeof col.attachmentKey !== 'boolean') {
                                    issues.push({
                                        code: 'DESIGN_BUILDER_ENTITY_COLUMN_ATTACHMENT_KEY_INVALID',
                                        field: `entityJudgments[${idx}].linkedTable.businessColumns[${ci}].attachmentKey`,
                                        entityKey,
                                        message: `businessColumns[${ci}].attachmentKey 若出现，必须是 boolean；只有本字段保存附件稳定标识时才传 true。`
                                    });
                                }
                            }
                            if (col && typeof col === 'object' && Object.prototype.hasOwnProperty.call(col, 'attachmentLabel')) {
                                if (typeof col.attachmentLabel !== 'string' || !col.attachmentLabel.trim()) {
                                    issues.push({
                                        code: 'DESIGN_BUILDER_ENTITY_COLUMN_ATTACHMENT_LABEL_INVALID',
                                        field: `entityJudgments[${idx}].linkedTable.businessColumns[${ci}].attachmentLabel`,
                                        entityKey,
                                        message: `businessColumns[${ci}].attachmentLabel 若出现，必须是非空中文附件业务名称；普通字段不要传 attachmentLabel。`
                                    });
                                }
                            }
                        });
                    }
                } else if (kind === 'reuse') {
                    if (!String(linkedTable.tableName || '').trim()) {
                        issues.push({
                            code: 'DESIGN_BUILDER_ENTITY_REUSE_TABLE_NAME_MISSING',
                            field: `entityJudgments[${idx}].linkedTable.tableName`,
                            entityKey,
                            message: `linkedTable.kind=reuse 时 tableName 必填（取自 globalTableCandidateWhitelist[].tableName）。`
                        });
                    }
                    if (Object.prototype.hasOwnProperty.call(linkedTable, 'reusedApis') && !Array.isArray(linkedTable.reusedApis)) {
                        issues.push({
                            code: 'DESIGN_BUILDER_ENTITY_REUSE_APIS_TYPE_INVALID',
                            field: `entityJudgments[${idx}].linkedTable.reusedApis`,
                            entityKey,
                            message: `linkedTable.kind=reuse 时 reusedApis 若出现必须是数组；没有已确认可复用 API 时不要编造，Builder 会从 scan 表/Entity 索引补复用落点。`
                        });
                    }
                }
                if (Object.prototype.hasOwnProperty.call(linkedTable, 'needsPage') && typeof linkedTable.needsPage !== 'boolean') {
                    issues.push({
                        code: 'DESIGN_BUILDER_ENTITY_NEEDS_PAGE_TYPE_INVALID',
                        field: `entityJudgments[${idx}].linkedTable.needsPage`,
                        entityKey,
                        message: `linkedTable.needsPage 若出现必须是 boolean；用于表达本业务对象是否需要新增独立查询、列表、选择、查看或结果承载面。`
                    });
                }
            }
        });

        this._validateConfirmedTableCandidateFitDecisions(
            inputJudgments,
            inputTableCandidateFitDecisions,
            context.confirmedRequirementRulePool
        ).forEach(issue => issues.push(issue));

        if (expectedStoryIds.size > 0) {
            for (const expected of expectedStoryIds) {
                if (!allUsedStoryIds.has(expected)) {
                    issues.push({
                        code: 'DESIGN_BUILDER_STORY_ID_NOT_BOUND_TO_ANY_ENTITY',
                        field: 'entityJudgments[].relatedStoryIds',
                        storyId: expected,
                        message: `stories.json 中的 storyId="${expected}" 未被任何 entity 关联。每个 Story 都必须有设计层业务对象承接验收；existingAdjustment.entryFiles 只说明既有入口承载位置，不是跳过设计归属的理由。若本 Story 无本地持久化承载，请放入 linkedTable.kind="none" 的主业务能力 entity；若需要新增独立查询、列表、选择、查看或结果承载面，再设置 needsPage=true。`
                    });
                }
            }
        }

        // 3) carriedByEntityKey 必须指向已存在的 entityKey；工作流 consumer 也必须显式声明承载 owner。
        inputJudgments.forEach((entity, idx) => {
            const linkedTable = entity && entity.linkedTable && typeof entity.linkedTable === 'object' && !Array.isArray(entity.linkedTable)
                ? entity.linkedTable
                : {};
            const linkedKind = String(linkedTable.kind || '').trim().toLowerCase();
            const scene = String(entity && entity.constructionSceneKey || '').trim();
            const carried = String(entity && entity.carriedByEntityKey || '').trim();
            if (scene === 'workflow_process' && linkedKind === 'none' && !carried) {
                issues.push({
                    code: 'DESIGN_BUILDER_WORKFLOW_CARRIER_REQUIRED',
                    field: `entityJudgments[${idx}].carriedByEntityKey`,
                    entityKey: String(entity && entity.entityKey || '').trim(),
                    message: 'workflow_process + linkedTable.kind="none" 表示当前流程 Story 不生产自己的流程业务表；必须在 T2 填 carriedByEntityKey=<本次流程业务表 owner entityKey>。否则 Coder 无法派生 workflow 骨架所需 tableName/Entity/Service。若本 Story 自己生产流程业务表，应改 linkedTable.kind="new" 并补 newTable；若读取已确认候选业务表，应改 kind="reuse" + tableName。'
                });
            }
        });

        inputJudgments.forEach((entity, idx) => {
            const carried = String(entity && entity.carriedByEntityKey || '').trim();
            if (!carried) return;
            if (!seenEntityKeys.has(carried)) {
                issues.push({
                    code: 'DESIGN_BUILDER_CARRIED_BY_ENTITY_KEY_NOT_FOUND',
                    field: `entityJudgments[${idx}].carriedByEntityKey`,
                    entityKey: entity && entity.entityKey,
                    message: `carriedByEntityKey="${carried}" 未在当前 entityJudgments 中定义。`
                });
            }
            if (carried === String(entity.entityKey || '').trim()) {
                issues.push({
                    code: 'DESIGN_BUILDER_CARRIED_BY_SELF',
                    field: `entityJudgments[${idx}].carriedByEntityKey`,
                    entityKey: entity.entityKey,
                    message: `carriedByEntityKey 不能指向自己。`
                });
            }
            const linkedTable = entity && entity.linkedTable && typeof entity.linkedTable === 'object' && !Array.isArray(entity.linkedTable)
                ? entity.linkedTable
                : {};
            const linkedKind = String(linkedTable.kind || '').trim().toLowerCase();
            const scene = String(entity && entity.constructionSceneKey || '').trim();
            const carrier = inputJudgments.find(item => String(item && item.entityKey || '').trim() === carried);
            const carrierLinkedTable = carrier && carrier.linkedTable && typeof carrier.linkedTable === 'object' && !Array.isArray(carrier.linkedTable)
                ? carrier.linkedTable
                : {};
            const carrierLinkedKind = String(carrierLinkedTable.kind || '').trim().toLowerCase();
            if (scene === 'query_result_entry' || scene === 'statistics_analysis' || scene === 'workflow_process') {
                if (linkedKind !== 'none' || linkedTable.needsPage !== true) {
                    issues.push({
                        code: scene === 'workflow_process'
                            ? 'DESIGN_BUILDER_CARRIED_WORKFLOW_REQUIRES_NONE_PAGE'
                            : scene === 'statistics_analysis'
                                ? 'DESIGN_BUILDER_CARRIED_STATISTICS_REQUIRES_NONE_PAGE'
                                : 'DESIGN_BUILDER_CARRIED_QUERY_REQUIRES_NONE_PAGE',
                        field: `entityJudgments[${idx}].linkedTable`,
                        entityKey: String(entity && entity.entityKey || '').trim(),
                        carriedByEntityKey: carried,
                        message: scene === 'workflow_process'
                            ? '工作流节点/待办/办理/查看 Story 若消费本次设计中新建流程业务表，应填 constructionSceneKey="workflow_process" + linkedTable.kind="none" + needsPage=true + carriedByEntityKey=<流程业务表 owner entityKey>；不要为每个流程节点 new 近似表。'
                            : scene === 'statistics_analysis'
                                ? '统计分析 Story 若读取本次设计中新建表，应填 constructionSceneKey="statistics_analysis" + linkedTable.kind="none" + needsPage=true + carriedByEntityKey=<新表 owner entityKey>；不要把本次新表写成 reuse，也不要让统计 Story 自己写 new。'
                                : '查询/报表 Story 若查询本次设计中新建表，应填 constructionSceneKey="query_result_entry" + linkedTable.kind="none" + needsPage=true + carriedByEntityKey=<新表 owner entityKey>；不要把本次新表写成 reuse，也不要让查询 Story 自己写 new。'
                    });
                }
                if (carrierLinkedKind !== 'new') {
                    issues.push({
                        code: scene === 'workflow_process'
                            ? 'DESIGN_BUILDER_CARRIED_WORKFLOW_CARRIER_MUST_BE_NEW_TABLE'
                            : scene === 'statistics_analysis'
                                ? 'DESIGN_BUILDER_CARRIED_STATISTICS_CARRIER_MUST_BE_NEW_TABLE'
                                : 'DESIGN_BUILDER_CARRIED_QUERY_CARRIER_MUST_BE_NEW_TABLE',
                        field: `entityJudgments[${idx}].carriedByEntityKey`,
                        entityKey: String(entity && entity.entityKey || '').trim(),
                        carriedByEntityKey: carried,
                        message: `${scene} 使用 carriedByEntityKey="${carried}" 时，承载 entity 必须拥有 linkedTable.kind="new" 的本次新建表；否则 Coder 无法复用承载模块 Entity/Service。`
                    });
                }
            }
        });

        if (issues.length > 0) {
            return {
                ok: false,
                errorCode: 'DESIGN_BUILDER_INPUT_INVALID',
                message: '受管canonical投影不满足最终Builder结构合同。',
                issues
            };
        }

        // 4) 派生 designJson —— LLM-owned 入参 + Builder 从 stories.json join 取上游事实
        const navigationContract = context.navigationContract || {};
        const databaseNamingContract = this._extractDatabaseNamingContract(navigationContract);
        const needsProjectModuleAbbr = Array.from(String(databaseNamingContract.tableNamePattern || '').matchAll(/\{([^}]+)\}/g))
            .some(match => String(match[1] || '').trim() === 'moduleAbbr');
        const hasNewTable = inputJudgments.some(item => String(item && item.linkedTable && item.linkedTable.kind || '').trim().toLowerCase() === 'new');
        if (hasNewTable && needsProjectModuleAbbr && !databaseNamingContract.moduleAbbr) {
            return {
                ok: false,
                errorCode: 'DESIGN_BUILDER_PROJECT_MODULE_ABBR_MISSING',
                message: '项目数据库命名模板要求 moduleAbbr，但 scan/工程导航契约没有显式值或唯一可推导的命名前缀；这是上游命名上下文缺陷，不要求 Design LLM 填写命名问卷。',
                issues: [{
                    code: 'DESIGN_BUILDER_PROJECT_MODULE_ABBR_MISSING',
                    field: 'navigationContract.databaseNamingContract.moduleAbbr',
                    message: `tableNamePattern=${databaseNamingContract.tableNamePattern} 需要项目级 moduleAbbr。`
                }]
            };
        }
        const placementRules = this._extractPlacementRules(navigationContract);
        const confirmedTableCandidates = this._extractConfirmedTableCandidates(
            context.confirmedRequirementRulePool && context.confirmedRequirementRulePool.globalTableCandidateWhitelist
        );
        const businessEntities = inputJudgments.map(judgment => {
            return this._buildEntity(judgment, {
                storiesById,
                placementRules,
                entityGraph: context.entityGraph || null,
                confirmedTableCandidates
            });
        });
        const carrierMergeResult = this._mergeCarrierBusinessColumnsIntoOwners(businessEntities);
        if (!carrierMergeResult.ok) {
            return {
                ok: false,
                errorCode: 'DESIGN_BUILDER_INPUT_INVALID',
                message: '受管canonical投影的Carrier字段无法合并到owner表。',
                issues: carrierMergeResult.issues || []
            };
        }

        const acceptanceCriteria = this._buildAcceptanceCriteriaIndex(businessEntities, storiesById);

        // Phase 2/3 兼容映射：把 businessEntities + acceptanceCriteria 投影成下游消费的 modules[]。
        // 下游 design-tdd-plan/skeleton/acceptance/business-facts 服务暂时仍按 modules[] 消费（每个 entity = 1 个 module）。
        // 待 Phase 2/3 单独重构后，可移除此投影。
        const projection = this._projectEntitiesToLegacyModules(businessEntities, acceptanceCriteria, storiesById);
        const modules = projection.modules;
        // entityKey → moduleId 映射也喂给 databaseDesign，让 tables[].relatedModuleIds 用真实 moduleId
        // 不重新发明派生逻辑。下游 plan-service / skeleton-service 全按 relatedModuleIds 反查。
        const entityKeyToModuleId = projection.entityKeyToModuleId;

        const designDecisionAudit = this._buildDesignDecisionAudit(inputTableCandidateFitDecisions, confirmedTableCandidates);
        const designJson = {
            meta: {
                name: String(context.demandName || '').trim()
            },
            stories: this._buildRequirementStoriesProjection(storiesById),
            businessEntities,
            acceptanceCriteria,
            modules,
            databaseDesign: this._buildDatabaseDesignFromEntities(businessEntities, databaseNamingContract, entityKeyToModuleId),
            ...(trustedCanonicalProjection ? {
                canonicalModel: JSON.parse(JSON.stringify(args.canonicalModel)),
                managedProjection: true
            } : {}),
            ...(designDecisionAudit ? { designDecisionAudit } : {})
        };

        return { ok: true, designJson };
    }

    _validateConfirmedTableCandidateFitDecisions(entityJudgments = [], tableCandidateFitDecisions, confirmedRequirementRulePool = {}) {
        const candidates = this._extractConfirmedTableCandidates(confirmedRequirementRulePool && confirmedRequirementRulePool.globalTableCandidateWhitelist);

        const normalizeTableName = value => String(value || '').trim().toUpperCase();
        const candidateNames = new Set(candidates.map(item => normalizeTableName(item.tableName)).filter(Boolean));
        const candidateByTable = new Map(candidates
            .map(item => [normalizeTableName(item.tableName), item])
            .filter(([tableName]) => tableName));
        const decisions = Array.isArray(tableCandidateFitDecisions) ? tableCandidateFitDecisions : [];
        const issues = [];
        const entityByKey = new Map();
        const reuseEntityKeysByTable = new Map();
        const knownStoryIds = new Set();

        entityJudgments.forEach((entity, idx) => {
            const entityKey = String(entity && entity.entityKey || '').trim();
            if (entityKey) {
                entityByKey.set(entityKey, { entity, idx });
            }
            this._normalizeStoryIdArray(entity && entity.relatedStoryIds).forEach(storyId => knownStoryIds.add(storyId));
            const linkedTable = entity && entity.linkedTable && typeof entity.linkedTable === 'object' && !Array.isArray(entity.linkedTable)
                ? entity.linkedTable
                : {};
            const kind = String(linkedTable.kind || '').trim().toLowerCase();
            if (kind !== 'reuse') return;

            const tableName = String(linkedTable.tableName || '').trim();
            const normalizedTableName = normalizeTableName(tableName);
            if (!normalizedTableName) return;
            if (candidates.length > 0 && !candidateNames.has(normalizedTableName)) {
                issues.push({
                    code: 'DESIGN_BUILDER_REUSE_TABLE_NOT_CONFIRMED_CANDIDATE',
                    field: `entityJudgments[${idx}].linkedTable.tableName`,
                    entityKey: String(entity && entity.entityKey || '').trim(),
                    tableName,
                    message: `linkedTable.kind=reuse 的 tableName="${tableName}" 不在需求阶段确认的 globalTableCandidateWhitelist 中。复用表必须来自需求阶段已确认候选。`
                });
                return;
            }
            if (!reuseEntityKeysByTable.has(normalizedTableName)) {
                reuseEntityKeysByTable.set(normalizedTableName, []);
            }
            reuseEntityKeysByTable.get(normalizedTableName).push({
                entityKey,
                entityIndex: idx,
                tableName
            });
        });

        if (tableCandidateFitDecisions !== undefined && !Array.isArray(tableCandidateFitDecisions)) {
            issues.push({
                code: 'DESIGN_BUILDER_TABLE_CANDIDATE_FIT_DECISIONS_TYPE_INVALID',
                field: 'tableCandidateFitDecisions',
                message: 'tableCandidateFitDecisions 若出现必须是数组。需求阶段有表候选时，设计 LLM 必须逐项填写候选表适配判断。'
            });
        }

        if (candidates.length === 0) {
            decisions.forEach((decision, idx) => {
                const tableName = String(decision && decision.tableName || '').trim();
                issues.push({
                    code: 'DESIGN_BUILDER_TABLE_CANDIDATE_FIT_TABLE_UNKNOWN',
                    field: `tableCandidateFitDecisions[${idx}].tableName`,
                    tableName,
                    message: `tableCandidateFitDecisions[${idx}].tableName="${tableName}" 不在需求阶段确认的 globalTableCandidateWhitelist 中；无确认表候选时不要提交 tableCandidateFitDecisions。`
                });
            });
            return issues;
        }

        const seenDecisionByTable = new Map();
        decisions.forEach((decision, idx) => {
            const tableName = String(decision && decision.tableName || '').trim();
            const normalizedTableName = normalizeTableName(tableName);
            const decisionValue = String(decision && decision.decision || '').trim();
            const fitReason = String(decision && decision.fitReason || '').trim();
            const entityKeys = this._normalizeDecisionEntityKeys(decision);
            const coveredStoryIds = this._normalizeStoryIdArray(decision && decision.coveredStoryIds);
            const weakRelatedStoryIds = this._normalizeStoryIdArray(decision && decision.weakRelatedStoryIds);
            const nonCoveredStoryIds = this._normalizeStoryIdArray(decision && (decision.nonCoveredStoryIds || decision.rejectedStoryIds));
            const candidate = candidateByTable.get(normalizedTableName) || {};

            if (!normalizedTableName || !candidateNames.has(normalizedTableName)) {
                issues.push({
                    code: 'DESIGN_BUILDER_TABLE_CANDIDATE_FIT_TABLE_UNKNOWN',
                    field: `tableCandidateFitDecisions[${idx}].tableName`,
                    tableName,
                    message: `tableCandidateFitDecisions[${idx}].tableName="${tableName}" 不在需求阶段确认的 globalTableCandidateWhitelist 中。`
                });
            } else if (seenDecisionByTable.has(normalizedTableName)) {
                issues.push({
                    code: 'DESIGN_BUILDER_TABLE_CANDIDATE_FIT_DECISION_DUPLICATED',
                    field: `tableCandidateFitDecisions[${idx}].tableName`,
                    tableName,
                    message: `候选表 "${tableName}" 出现了多条 tableCandidateFitDecisions；每张确认候选表只能提交 1 条适配判断，避免同一表被多个结论同时解释。`
                });
            } else {
                seenDecisionByTable.set(normalizedTableName, { decision, idx });
            }

            if (!['reuse_for_entity', 'reuse_for_story_group', 'not_applicable', 'unclear'].includes(decisionValue)) {
                issues.push({
                    code: 'DESIGN_BUILDER_TABLE_CANDIDATE_FIT_DECISION_INVALID',
                    field: `tableCandidateFitDecisions[${idx}].decision`,
                    tableName,
                    message: `tableCandidateFitDecisions[${idx}].decision 必须是 reuse_for_entity、reuse_for_story_group、not_applicable 或 unclear（当前="${decisionValue}"）。`
                });
            }

            if (!fitReason) {
                issues.push({
                    code: 'DESIGN_BUILDER_TABLE_CANDIDATE_FIT_REASON_MISSING',
                    field: `tableCandidateFitDecisions[${idx}].fitReason`,
                    tableName,
                    message: `tableCandidateFitDecisions[${idx}].fitReason 必填；设计 LLM 必须说明该候选表与当前业务对象匹配、不匹配或不确定的业务原因。`
                });
            }

            if (decision && Object.prototype.hasOwnProperty.call(decision, 'entityKeys') && !Array.isArray(decision.entityKeys)) {
                issues.push({
                    code: 'DESIGN_BUILDER_TABLE_CANDIDATE_FIT_ENTITY_KEYS_TYPE_INVALID',
                    field: `tableCandidateFitDecisions[${idx}].entityKeys`,
                    tableName,
                    message: 'tableCandidateFitDecisions[].entityKeys 若出现必须是数组；同一候选表可列出多个复用该表的业务对象。'
                });
            }
            ['coveredStoryIds', 'weakRelatedStoryIds', 'nonCoveredStoryIds', 'rejectedStoryIds'].forEach(field => {
                if (decision && Object.prototype.hasOwnProperty.call(decision, field) && !Array.isArray(decision[field])) {
                    issues.push({
                        code: 'DESIGN_BUILDER_TABLE_CANDIDATE_STORY_IDS_TYPE_INVALID',
                        field: `tableCandidateFitDecisions[${idx}].${field}`,
                        tableName,
                        message: `tableCandidateFitDecisions[].${field} 若出现必须是 storyId 字符串数组。`
                    });
                }
            });
            [...coveredStoryIds, ...weakRelatedStoryIds, ...nonCoveredStoryIds].forEach(storyId => {
                if (knownStoryIds.size > 0 && !knownStoryIds.has(storyId)) {
                    issues.push({
                        code: 'DESIGN_BUILDER_TABLE_CANDIDATE_STORY_ID_NOT_IN_ENTITY_JUDGMENTS',
                        field: `tableCandidateFitDecisions[${idx}]`,
                        tableName,
                        storyId,
                        message: `tableCandidateFitDecisions 中 storyId="${storyId}" 未出现在 entityJudgments[].relatedStoryIds 中；表候选适配判断只能引用本次设计已承接的 Story。`
                    });
                }
            });
            this._validateTableCandidateUsages(decision && decision.usages, idx, tableName, entityByKey, knownStoryIds)
                .forEach(issue => issues.push(issue));

            if (['reuse_for_entity', 'reuse_for_story_group', 'not_applicable'].includes(decisionValue)) {
                const candidatePrimaryStoryIds = this._normalizeStoryIdArray(candidate.primaryOwnerStoryIds);
                const accountedStoryIds = new Set([...coveredStoryIds, ...weakRelatedStoryIds, ...nonCoveredStoryIds]);
                const missingPrimaryStoryIds = candidatePrimaryStoryIds.filter(storyId => !accountedStoryIds.has(storyId));
                if (missingPrimaryStoryIds.length > 0) {
                    issues.push({
                        code: 'DESIGN_BUILDER_TABLE_CANDIDATE_PRIMARY_STORY_NOT_ACCOUNTED',
                        field: `tableCandidateFitDecisions[${idx}].coveredStoryIds`,
                        tableName,
                        storyIds: missingPrimaryStoryIds,
                        message: `候选表 "${tableName}" 在需求规则池中标记了 primaryOwnerStoryIds=${candidatePrimaryStoryIds.join(', ')}；设计阶段必须在 coveredStoryIds / weakRelatedStoryIds / nonCoveredStoryIds 中逐个交代这些 Story 与该表的关系。Builder 只校验引用闭合，不替业务判断是否覆盖。`
                    });
                }
            }

            if (decisionValue === 'reuse_for_entity' || decisionValue === 'reuse_for_story_group') {
                if (entityKeys.length === 0) {
                    issues.push({
                        code: 'DESIGN_BUILDER_TABLE_CANDIDATE_FIT_ENTITY_MISSING',
                        field: `tableCandidateFitDecisions[${idx}].entityKeys`,
                        tableName,
                        message: `decision="${decisionValue}" 时 entityKey 或 entityKeys 必填，必须指向本次 entityJudgments[] 中复用该表的业务对象；同一表服务多个用途时用 entityKeys。`
                    });
                    return;
                }
                entityKeys.forEach(entityKey => {
                    const entityRef = entityByKey.get(entityKey);
                    if (!entityRef) {
                        issues.push({
                            code: 'DESIGN_BUILDER_TABLE_CANDIDATE_FIT_ENTITY_NOT_FOUND',
                            field: `tableCandidateFitDecisions[${idx}].entityKeys`,
                            tableName,
                            entityKey,
                            message: `tableCandidateFitDecisions[${idx}] 引用的 entityKey="${entityKey}" 未在 entityJudgments[] 中定义。`
                        });
                        return;
                    }
                    const linkedTable = entityRef.entity && entityRef.entity.linkedTable && typeof entityRef.entity.linkedTable === 'object' && !Array.isArray(entityRef.entity.linkedTable)
                        ? entityRef.entity.linkedTable
                        : {};
                    const linkedKind = String(linkedTable.kind || '').trim().toLowerCase();
                    const linkedTableName = String(linkedTable.tableName || '').trim();
                    if (linkedKind !== 'reuse' || normalizeTableName(linkedTableName) !== normalizedTableName) {
                        issues.push({
                            code: 'DESIGN_BUILDER_TABLE_CANDIDATE_REUSE_DECISION_NOT_LINKED',
                            field: `tableCandidateFitDecisions[${idx}].entityKeys`,
                            tableName,
                            entityKey,
                            message: `候选表 "${tableName}" 被判断为 ${decisionValue}，但 entityJudgments 中 entity="${entityKey}" 没有设置 linkedTable.kind="reuse" 且 tableName 指向同一候选表。`
                        });
                    }
                });
                const reuseLinks = reuseEntityKeysByTable.get(normalizedTableName) || [];
                const decisionEntityKeySet = new Set(entityKeys);
                const missingLinkedEntities = reuseLinks
                    .map(item => item.entityKey)
                    .filter(entityKey => entityKey && !decisionEntityKeySet.has(entityKey));
                if (missingLinkedEntities.length > 0) {
                    issues.push({
                        code: 'DESIGN_BUILDER_TABLE_CANDIDATE_REUSE_DECISION_ENTITY_KEYS_INCOMPLETE',
                        field: `tableCandidateFitDecisions[${idx}].entityKeys`,
                        tableName,
                        entityKeys: missingLinkedEntities,
                        message: `候选表 "${tableName}" 已被这些 entity 的 linkedTable.kind=reuse 使用，但未出现在 tableCandidateFitDecisions[].entityKeys 中：${missingLinkedEntities.join(', ')}。同一候选表服务多个业务用途时，请在一条适配判断里列全 entityKeys 并用 coveredStoryIds/usages 说明各自用途。`
                    });
                }
            } else if (decisionValue === 'not_applicable') {
                const reuseLinks = reuseEntityKeysByTable.get(normalizedTableName) || [];
                if (reuseLinks.length > 0) {
                    issues.push({
                        code: 'DESIGN_BUILDER_TABLE_CANDIDATE_NON_REUSE_DECISION_BUT_LINKED',
                        field: `tableCandidateFitDecisions[${idx}].decision`,
                        tableName,
                        entityKeys: reuseLinks.map(item => item.entityKey),
                        message: `候选表 "${tableName}" 被判断为 not_applicable，但 entityJudgments 中已有 entity 使用 linkedTable.kind="reuse" 指向该表；请保持适配判断与 linkedTable 一致。`
                    });
                }
            } else if (decisionValue === 'unclear') {
                issues.push({
                    code: 'DESIGN_BUILDER_TABLE_CANDIDATE_FIT_UNCLEAR',
                    field: `tableCandidateFitDecisions[${idx}].decision`,
                    tableName,
                    message: `候选表 "${tableName}" 与业务对象的承载关系被判断为 unclear；设计阶段无法替业务拍板，请回需求阶段补充业务事实后再提交设计。`
                });
            }
        });

        candidates.forEach(candidate => {
            const tableName = String(candidate.tableName || '').trim();
            const normalizedTableName = normalizeTableName(tableName);
            if (!normalizedTableName || seenDecisionByTable.has(normalizedTableName)) return;
            issues.push({
                code: 'DESIGN_BUILDER_TABLE_CANDIDATE_FIT_DECISION_MISSING',
                field: 'tableCandidateFitDecisions',
                tableName,
                message: `需求阶段确认了表候选 "${tableName}"，设计阶段必须在 tableCandidateFitDecisions[] 中提交一条适配判断：reuse_for_entity、reuse_for_story_group、not_applicable 或 unclear。Builder 只校验判断是否存在和引用是否闭合，不替业务判断是否复用。`
            });
        });

        return issues;
    }

    _validateConstructionScene(entity = {}, idx = 0, storiesById = new Map()) {
        const issues = [];
        const entityKey = String(entity && entity.entityKey || '').trim();
        const scene = String(entity && entity.constructionSceneKey || '').trim();
        const linkedTable = entity && entity.linkedTable && typeof entity.linkedTable === 'object' && !Array.isArray(entity.linkedTable)
            ? entity.linkedTable
            : {};
        const kind = String(linkedTable.kind || '').trim().toLowerCase();
        const needsPage = linkedTable.needsPage === true;
        const hasExistingEntry = this._entityHasExistingEntryFiles(entity, storiesById);

        if (!scene) {
            issues.push({
                code: 'DESIGN_BUILDER_CONSTRUCTION_SCENE_MISSING',
                field: `entityJudgments[${idx}].constructionSceneKey`,
                entityKey,
                allowedValues: CONSTRUCTION_SCENE_KEYS,
                message: `entityJudgments[${idx}].constructionSceneKey 必填：设计阶段必须一次性锁定 Coder 执行路线，后续 Builder 只按该枚举机械映射。`
            });
        } else if (!CONSTRUCTION_SCENE_KEYS.includes(scene)) {
            issues.push({
                code: 'DESIGN_BUILDER_CONSTRUCTION_SCENE_INVALID',
                field: `entityJudgments[${idx}].constructionSceneKey`,
                entityKey,
                value: scene,
                allowedValues: CONSTRUCTION_SCENE_KEYS,
                message: `constructionSceneKey="${scene}" 不在允许范围内。`
            });
        }

        if (Object.prototype.hasOwnProperty.call(entity || {}, 'practiceSceneKeys')) {
            if (!Array.isArray(entity.practiceSceneKeys)) {
                issues.push({
                    code: 'DESIGN_BUILDER_PRACTICE_SCENE_KEYS_TYPE_INVALID',
                    field: `entityJudgments[${idx}].practiceSceneKeys`,
                    entityKey,
                    message: 'practiceSceneKeys 若出现必须是数组。'
                });
            } else {
                entity.practiceSceneKeys.forEach((key, keyIdx) => {
                    const practiceKey = String(key || '').trim();
                    if (!PRACTICE_SCENE_KEYS.includes(practiceKey)) {
                        issues.push({
                            code: 'DESIGN_BUILDER_PRACTICE_SCENE_KEY_INVALID',
                            field: `entityJudgments[${idx}].practiceSceneKeys[${keyIdx}]`,
                            entityKey,
                            value: practiceKey,
                            allowedValues: PRACTICE_SCENE_KEYS,
                            message: `practiceSceneKeys[${keyIdx}]="${practiceKey}" 不在允许范围内。`
                        });
                    }
                });
            }
        }

        if (!scene || !CONSTRUCTION_SCENE_KEYS.includes(scene)) {
            return issues;
        }

        const pushConflict = (code, message) => {
            issues.push({
                code,
                field: `entityJudgments[${idx}].constructionSceneKey`,
                entityKey,
                constructionSceneKey: scene,
                linkedTableKind: kind,
                message
            });
        };

        if (scene === 'crud_new_full' && !sceneSupportsLinkedTableKind(scene, kind)) {
            pushConflict('DESIGN_BUILDER_CONSTRUCTION_SCENE_CONFLICT_CRUD_REQUIRES_NEW_TABLE',
                'crud_new_full 表示新建完整管理能力，linkedTable.kind 必须是 new。');
        }
        if (scene === 'backend_data_carrier' && !sceneSupportsLinkedTableKind(scene, kind)) {
            pushConflict('DESIGN_BUILDER_CONSTRUCTION_SCENE_CONFLICT_BACKEND_CARRIER_REQUIRES_NEW_TABLE',
                'backend_data_carrier 表示只准备本地数据承载，linkedTable.kind 必须是 new。');
        }
        if (scene === 'query_result_entry' && (!sceneSupportsLinkedTableKind(scene, kind) || getNeedsPageMode(scene) === 'required' && needsPage !== true)) {
            pushConflict('DESIGN_BUILDER_CONSTRUCTION_SCENE_CONFLICT_QUERY_ENTRY_REQUIRES_REUSE_OR_NONE_PAGE',
                'query_result_entry 表示新增查询/结果入口，linkedTable.kind 必须是 reuse 或 none，且 linkedTable.needsPage=true。');
        }
        if (scene === 'statistics_analysis' && (!sceneSupportsLinkedTableKind(scene, kind) || getNeedsPageMode(scene) === 'required' && needsPage !== true)) {
            pushConflict('DESIGN_BUILDER_CONSTRUCTION_SCENE_CONFLICT_STATISTICS_REQUIRES_REUSE_OR_NONE_PAGE',
                'statistics_analysis 表示独立统计/分析/汇总入口，linkedTable.kind 必须是 reuse 或 none，且 linkedTable.needsPage=true；本次新建结果表由 carriedByEntityKey 指向承载 Story。');
        }
        if (scene === 'workflow_process' && getNeedsPageMode(scene) === 'required' && needsPage !== true) {
            pushConflict('DESIGN_BUILDER_CONSTRUCTION_SCENE_CONFLICT_WORKFLOW_REQUIRES_PAGE',
                'workflow_process 表示完整工作流/审批流施工，必须有流程办理和查看入口，linkedTable.needsPage=true。');
        }
        if (scene === 'rest_interface' && getNeedsPageMode(scene) === 'forbidden' && needsPage === true) {
            pushConflict('DESIGN_BUILDER_CONSTRUCTION_SCENE_CONFLICT_REST_WITH_PAGE',
                'rest_interface 表示本系统对外提供 REST 接口，不新增页面；若还需要独立查询/列表入口，请拆到 query_result_entry entity。');
        }
        if (scene === 'scheduled_job' && getNeedsPageMode(scene) === 'forbidden' && needsPage === true) {
            pushConflict('DESIGN_BUILDER_CONSTRUCTION_SCENE_CONFLICT_JOB_WITH_PAGE',
                'scheduled_job 表示定时/异步后台执行，不新增页面；若还需要独立查询/列表入口，请拆到 query_result_entry entity。');
        }
        if (scene === 'existing_entry_patch' && !hasExistingEntry) {
            pushConflict('DESIGN_BUILDER_CONSTRUCTION_SCENE_CONFLICT_EXISTING_PATCH_REQUIRES_ENTRY_FILES',
                'existing_entry_patch 表示改既有入口，关联 Story 必须在需求阶段确认 existingAdjustment.entryFiles。');
        }
        if (scene === 'existing_entry_patch' && (!sceneSupportsLinkedTableKind(scene, kind) || getNeedsPageMode(scene) === 'forbidden' && needsPage === true)) {
            pushConflict('DESIGN_BUILDER_CONSTRUCTION_SCENE_CONFLICT_EXISTING_PATCH_WITH_PREPARE_SIDE',
                `existing_entry_patch 只表示既有入口内定点调整；若同一 entity 同时声明新建承载或独立结果承载面，请改用 mixed_prepare_then_patch。${OPENDIALOG_RESULT_SURFACE_REPAIR_GUIDE}`);
        }
        if (scene === 'mixed_prepare_then_patch') {
            if (!hasExistingEntry) {
                pushConflict('DESIGN_BUILDER_CONSTRUCTION_SCENE_CONFLICT_MIXED_REQUIRES_ENTRY_FILES',
                    'mixed_prepare_then_patch 表示先准备承载再改既有入口，关联 Story 必须在需求阶段确认 existingAdjustment.entryFiles。');
            }
            if (kind !== 'new' && needsPage !== true) {
                pushConflict('DESIGN_BUILDER_CONSTRUCTION_SCENE_CONFLICT_MIXED_REQUIRES_PREPARE_SIDE',
                    `mixed_prepare_then_patch 必须同时存在可机械准备的一侧：linkedTable.kind=new，或 reuse/none 且 needsPage=true。${MIXED_PREPARE_REPAIR_GUIDE}`);
            }
        }
        if (scene === 'targeted_patch_only' && !sceneSupportsLinkedTableKind(scene, kind)) {
            pushConflict('DESIGN_BUILDER_CONSTRUCTION_SCENE_CONFLICT_TARGETED_PATCH_WITH_NEW_TABLE',
                'targeted_patch_only 不新增结构；若 linkedTable.kind=new，请改用 backend_data_carrier、crud_new_full 或 mixed_prepare_then_patch。');
        }
        if (scene === 'targeted_patch_only' && getNeedsPageMode(scene) === 'forbidden' && needsPage === true) {
            pushConflict('DESIGN_BUILDER_CONSTRUCTION_SCENE_CONFLICT_TARGETED_PATCH_WITH_RESULT_ENTRY',
                'targeted_patch_only 不新增独立结果承载面；若 linkedTable.needsPage=true，请改用 query_result_entry 或 mixed_prepare_then_patch。');
        }

        return issues;
    }

    _validateStatisticsContract(entity = {}, idx = 0) {
        const issues = [];
        const entityKey = String(entity && entity.entityKey || '').trim();
        const scene = String(entity && entity.constructionSceneKey || '').trim();
        const hasContract = Object.prototype.hasOwnProperty.call(entity || {}, 'statisticsContract')
            && !this._isEmptyStatisticsContractShell(entity && entity.statisticsContract);
        const hasContractsField = Object.prototype.hasOwnProperty.call(entity || {}, 'statisticsContracts');
        const hasContracts = hasContractsField
            && Array.isArray(entity.statisticsContracts)
            && entity.statisticsContracts.length > 0;
        const contractList = hasContracts ? entity.statisticsContracts : [];
        if (!['statistics_analysis', 'rest_interface'].includes(scene)) {
            if (hasContract || hasContractsField) {
                issues.push({
                    code: 'DESIGN_BUILDER_STATISTICS_CONTRACT_SCENE_INVALID',
                    field: hasContractsField ? `entityJudgments[${idx}].statisticsContracts` : `entityJudgments[${idx}].statisticsContract`,
                    entityKey,
                    constructionSceneKey: scene,
                    message: 'statisticsContract/statisticsContracts 只允许承载统计页面或统计 REST 的 entity 填写。'
                });
            }
            return issues;
        }

        if (scene === 'statistics_analysis' && !hasContract && !hasContracts) {
            issues.push({
                code: 'DESIGN_BUILDER_STATISTICS_CONTRACT_MISSING',
                field: `entityJudgments[${idx}].statisticsContract`,
                entityKey,
                message: 'constructionSceneKey=statistics_analysis 时 statisticsContract/statisticsContracts 必填；新主线中它必须由需求阶段 stories[].statisticsIntent 投影，设计 LLM 不应临场补统计口径。'
            });
            return issues;
        }
        if (!hasContract && !hasContracts) return issues;

        if (hasContractsField && !Array.isArray(entity.statisticsContracts)) {
            issues.push({
                code: 'DESIGN_BUILDER_STATISTICS_CONTRACTS_TYPE_INVALID',
                field: `entityJudgments[${idx}].statisticsContracts`,
                entityKey,
                message: 'statisticsContracts 必须是数组。'
            });
            return issues;
        }

        if (hasContracts) {
            contractList.forEach((contract, contractIdx) => {
                if (!contract || typeof contract !== 'object' || Array.isArray(contract)) {
                    issues.push({
                        code: 'DESIGN_BUILDER_STATISTICS_CONTRACT_TYPE_INVALID',
                        field: `entityJudgments[${idx}].statisticsContracts[${contractIdx}]`,
                        entityKey,
                        message: 'statisticsContracts[] 每项必须是对象。'
                    });
                    return;
                }
                const storyRef = String(contract.storyId || contract.sourceStoryId || '').trim();
                if (!storyRef) {
                    issues.push({
                        code: 'DESIGN_BUILDER_STATISTICS_CONTRACT_STORY_ID_MISSING',
                        field: `entityJudgments[${idx}].statisticsContracts[${contractIdx}].storyId`,
                        entityKey,
                        message: 'statisticsContracts[] 必须带 storyId，供 Coder 按验收项消费对应统计口径。'
                    });
                }
                this._validateOneStatisticsContract(contract, {
                    idx,
                    entityKey,
                    fieldPath: `entityJudgments[${idx}].statisticsContracts[${contractIdx}]`
                }).forEach(issue => issues.push(issue));
            });
            return issues;
        }

        this._validateOneStatisticsContract(entity.statisticsContract, {
            idx,
            entityKey,
            fieldPath: `entityJudgments[${idx}].statisticsContract`
        }).forEach(issue => issues.push(issue));
        return issues;
    }

    _validateOneStatisticsContract(contract = {}, { idx = 0, entityKey = '', fieldPath = '' } = {}) {
        const issues = [];
        if (!contract || typeof contract !== 'object' || Array.isArray(contract)) {
            issues.push({
                code: 'DESIGN_BUILDER_STATISTICS_CONTRACT_MISSING',
                field: fieldPath || `entityJudgments[${idx}].statisticsContract`,
                entityKey,
                message: 'statisticsContract 必须是对象。'
            });
            return issues;
        }

        ['title', 'purpose'].forEach(field => {
            if (!String(contract[field] || '').trim()) {
                issues.push({
                    code: 'DESIGN_BUILDER_STATISTICS_CONTRACT_FIELD_MISSING',
                    field: `${fieldPath}.${field}`,
                    entityKey,
                    message: `statisticsContract.${field} 必填。`
                });
            }
        });

        const metrics = Array.isArray(contract.metrics) ? contract.metrics : [];
        if (metrics.length === 0) {
            issues.push({
                code: 'DESIGN_BUILDER_STATISTICS_CONTRACT_METRICS_EMPTY',
                field: `${fieldPath}.metrics`,
                entityKey,
                message: 'statisticsContract.metrics 至少 1 项；统计分析必须明确指标口径，不能让 Coder 临场猜。'
            });
        }
        metrics.forEach((metric, metricIdx) => {
            if (!metric || typeof metric !== 'object' || Array.isArray(metric)) {
                issues.push({
                    code: 'DESIGN_BUILDER_STATISTICS_METRIC_TYPE_INVALID',
                    field: `${fieldPath}.metrics[${metricIdx}]`,
                    entityKey,
                    message: 'statisticsContract.metrics[] 每项必须是对象。'
                });
                return;
            }
            ['key', 'label', 'aggregate'].forEach(field => {
                if (!String(metric[field] || '').trim()) {
                    issues.push({
                        code: 'DESIGN_BUILDER_STATISTICS_METRIC_FIELD_MISSING',
                        field: `${fieldPath}.metrics[${metricIdx}].${field}`,
                        entityKey,
                        message: `statisticsContract.metrics[].${field} 必填。`
                    });
                }
            });
        });

        ['dataSources', 'filters', 'dimensions'].forEach(field => {
            if (contract[field] !== undefined && !Array.isArray(contract[field])) {
                issues.push({
                    code: 'DESIGN_BUILDER_STATISTICS_CONTRACT_ARRAY_FIELD_INVALID',
                    field: `${fieldPath}.${field}`,
                    entityKey,
                    message: `statisticsContract.${field} 若出现必须是数组。`
                });
            }
        });
        if (contract.display !== undefined && (!contract.display || typeof contract.display !== 'object' || Array.isArray(contract.display))) {
            issues.push({
                code: 'DESIGN_BUILDER_STATISTICS_CONTRACT_DISPLAY_INVALID',
                field: `${fieldPath}.display`,
                entityKey,
                message: 'statisticsContract.display 若出现必须是对象。'
            });
        }
        if (contract.exportRequired !== undefined && typeof contract.exportRequired !== 'boolean') {
            issues.push({
                code: 'DESIGN_BUILDER_STATISTICS_CONTRACT_EXPORT_REQUIRED_INVALID',
                field: `${fieldPath}.exportRequired`,
                entityKey,
                message: 'statisticsContract.exportRequired 若出现必须是 boolean。'
            });
        }
        return issues;
    }

    _validateWorkflowContract(entity = {}, idx = 0) {
        const issues = [];
        const entityKey = String(entity && entity.entityKey || '').trim();
        const scene = String(entity && entity.constructionSceneKey || '').trim();
        const hasContract = Object.prototype.hasOwnProperty.call(entity || {}, 'workflowContract')
            && !this._isEmptyWorkflowContractShell(entity && entity.workflowContract);
        const hasContractsField = Object.prototype.hasOwnProperty.call(entity || {}, 'workflowContracts');
        const hasContracts = hasContractsField
            && Array.isArray(entity.workflowContracts)
            && entity.workflowContracts.length > 0;
        const contractList = hasContracts ? entity.workflowContracts : [];
        if (!['workflow_process', 'rest_interface'].includes(scene)) {
            if (hasContract || hasContractsField) {
                issues.push({
                    code: 'DESIGN_BUILDER_WORKFLOW_CONTRACT_SCENE_INVALID',
                    field: hasContractsField ? `entityJudgments[${idx}].workflowContracts` : `entityJudgments[${idx}].workflowContract`,
                    entityKey,
                    constructionSceneKey: scene,
                    message: 'workflowContract/workflowContracts 只允许承载流程页面或流程 REST 的 entity 填写。'
                });
            }
            return issues;
        }
        if (scene === 'workflow_process' && !hasContract && !hasContracts) {
            issues.push({
                code: 'DESIGN_BUILDER_WORKFLOW_CONTRACT_MISSING',
                field: `entityJudgments[${idx}].workflowContract`,
                entityKey,
                message: 'constructionSceneKey=workflow_process 时 workflowContract/workflowContracts 必填；新主线中它必须由需求阶段 stories[].workflowIntent 投影，设计 LLM 不应临场补流程结构。'
            });
            return issues;
        }
        if (!hasContract && !hasContracts) return issues;

        if (hasContractsField && !Array.isArray(entity.workflowContracts)) {
            issues.push({
                code: 'DESIGN_BUILDER_WORKFLOW_CONTRACTS_TYPE_INVALID',
                field: `entityJudgments[${idx}].workflowContracts`,
                entityKey,
                message: 'workflowContracts 必须是数组。'
            });
            return issues;
        }

        if (hasContracts) {
            contractList.forEach((contract, contractIdx) => {
                if (!contract || typeof contract !== 'object' || Array.isArray(contract)) {
                    issues.push({
                        code: 'DESIGN_BUILDER_WORKFLOW_CONTRACT_TYPE_INVALID',
                        field: `entityJudgments[${idx}].workflowContracts[${contractIdx}]`,
                        entityKey,
                        message: 'workflowContracts[] 每项必须是对象。'
                    });
                    return;
                }
                const storyRef = String(contract.storyId || contract.sourceStoryId || '').trim();
                if (!storyRef) {
                    issues.push({
                        code: 'DESIGN_BUILDER_WORKFLOW_CONTRACT_STORY_ID_MISSING',
                        field: `entityJudgments[${idx}].workflowContracts[${contractIdx}].storyId`,
                        entityKey,
                        message: 'workflowContracts[] 必须带 storyId，供 Coder 按 Story 消费对应流程事实。'
                    });
                }
                this._validateOneWorkflowContract(contract, {
                    idx,
                    entityKey,
                    fieldPath: `entityJudgments[${idx}].workflowContracts[${contractIdx}]`
                }).forEach(issue => issues.push(issue));
            });
            return issues;
        }

        this._validateOneWorkflowContract(entity.workflowContract, {
            idx,
            entityKey,
            fieldPath: `entityJudgments[${idx}].workflowContract`
        }).forEach(issue => issues.push(issue));
        return issues;
    }

    _validateOneWorkflowContract(contract = {}, { idx = 0, entityKey = '', fieldPath = '' } = {}) {
        const issues = [];
        if (!contract || typeof contract !== 'object' || Array.isArray(contract)) {
            issues.push({
                code: 'DESIGN_BUILDER_WORKFLOW_CONTRACT_MISSING',
                field: fieldPath || `entityJudgments[${idx}].workflowContract`,
                entityKey,
                message: 'workflowContract 必须是对象。'
            });
            return issues;
        }
        if (!String(contract.processName || '').trim()) {
            issues.push({
                code: 'DESIGN_BUILDER_WORKFLOW_CONTRACT_PROCESS_NAME_MISSING',
                field: `${fieldPath}.processName`,
                entityKey,
                message: 'workflowContract.processName 必填。'
            });
        }
        const activities = Array.isArray(contract.activities) ? contract.activities : [];
        if (activities.length === 0) {
            issues.push({
                code: 'DESIGN_BUILDER_WORKFLOW_CONTRACT_ACTIVITIES_EMPTY',
                field: `${fieldPath}.activities`,
                entityKey,
                message: 'workflowContract.activities 至少 1 项。'
            });
        }
        const activityKeys = new Set(['start', 'end']);
        activities.forEach((activity, activityIdx) => {
            const activityPath = `${fieldPath}.activities[${activityIdx}]`;
            if (!activity || typeof activity !== 'object' || Array.isArray(activity)) {
                issues.push({
                    code: 'DESIGN_BUILDER_WORKFLOW_CONTRACT_ACTIVITY_TYPE_INVALID',
                    field: activityPath,
                    entityKey,
                    message: 'workflowContract.activities[] 每项必须是对象。'
                });
                return;
            }
            ['key', 'name', 'actor'].forEach(field => {
                if (!String(activity[field] || '').trim()) {
                    issues.push({
                        code: 'DESIGN_BUILDER_WORKFLOW_CONTRACT_ACTIVITY_FIELD_MISSING',
                        field: `${activityPath}.${field}`,
                        entityKey,
                        message: `workflowContract.activities[].${field} 必填。`
                    });
                }
            });
            const key = String(activity.key || '').trim();
            if (key) activityKeys.add(key);
            if (activity.operations !== undefined && !Array.isArray(activity.operations)) {
                issues.push({
                    code: 'DESIGN_BUILDER_WORKFLOW_CONTRACT_ACTIVITY_OPERATIONS_INVALID',
                    field: `${activityPath}.operations`,
                    entityKey,
                    message: 'workflowContract.activities[].operations 若出现必须是数组。'
                });
            }
        });
        const transitions = Array.isArray(contract.transitions) ? contract.transitions : [];
        if (transitions.length === 0) {
            issues.push({
                code: 'DESIGN_BUILDER_WORKFLOW_CONTRACT_TRANSITIONS_EMPTY',
                field: `${fieldPath}.transitions`,
                entityKey,
                message: 'workflowContract.transitions 至少 1 项。'
            });
        }
        transitions.forEach((transition, transitionIdx) => {
            const transitionPath = `${fieldPath}.transitions[${transitionIdx}]`;
            if (!transition || typeof transition !== 'object' || Array.isArray(transition)) {
                issues.push({
                    code: 'DESIGN_BUILDER_WORKFLOW_CONTRACT_TRANSITION_TYPE_INVALID',
                    field: transitionPath,
                    entityKey,
                    message: 'workflowContract.transitions[] 每项必须是对象。'
                });
                return;
            }
            ['from', 'to'].forEach(field => {
                const value = String(transition[field] || '').trim();
                if (!value) {
                    issues.push({
                        code: 'DESIGN_BUILDER_WORKFLOW_CONTRACT_TRANSITION_FIELD_MISSING',
                        field: `${transitionPath}.${field}`,
                        entityKey,
                        message: `workflowContract.transitions[].${field} 必填。`
                    });
                    return;
                }
                if (!activityKeys.has(value)) {
                    issues.push({
                        code: 'DESIGN_BUILDER_WORKFLOW_CONTRACT_TRANSITION_REF_UNKNOWN',
                        field: `${transitionPath}.${field}`,
                        entityKey,
                        message: `workflowContract.transitions[].${field}="${value}" 未引用 start/end 或 activities[].key。`
                    });
                }
            });
        });
        if (contract.businessResults !== undefined && !Array.isArray(contract.businessResults)) {
            issues.push({
                code: 'DESIGN_BUILDER_WORKFLOW_CONTRACT_BUSINESS_RESULTS_INVALID',
                field: `${fieldPath}.businessResults`,
                entityKey,
                message: 'workflowContract.businessResults 若出现必须是数组。'
            });
        }
        return issues;
    }

    _validateRestContract(entity = {}, idx = 0) {
        const issues = [];
        const entityKey = String(entity && entity.entityKey || '').trim();
        const scene = String(entity && entity.constructionSceneKey || '').trim();
        const hasContract = Object.prototype.hasOwnProperty.call(entity || {}, 'restContract')
            && !this._isEmptyRestContractShell(entity && entity.restContract);
        const contract = hasContract ? entity.restContract : null;
        if (scene !== 'rest_interface') {
            if (hasContract) {
                issues.push({
                    code: 'DESIGN_BUILDER_REST_CONTRACT_SCENE_INVALID',
                    field: `entityJudgments[${idx}].restContract`,
                    entityKey,
                    constructionSceneKey: scene,
                    message: 'restContract 只允许在 constructionSceneKey=rest_interface 的 entity 上填写。'
                });
            }
            return issues;
        }

        if (!contract || typeof contract !== 'object' || Array.isArray(contract)) {
            issues.push({
                code: 'DESIGN_BUILDER_REST_CONTRACT_MISSING',
                field: `entityJudgments[${idx}].restContract`,
                entityKey,
                message: 'constructionSceneKey=rest_interface 时 restContract 必填；由设计 LLM 从外部调用方视角给出 operations，basePath 由 Builder 从 entityKey 机械派生。'
            });
            return issues;
        }

        const basePath = String(contract.basePath || '').trim();
        if (basePath && !this._isValidRestBasePath(basePath)) {
            issues.push({
                code: 'DESIGN_BUILDER_REST_CONTRACT_BASE_PATH_INVALID',
                field: `entityJudgments[${idx}].restContract.basePath`,
                entityKey,
                value: basePath,
                message: 'restContract.basePath 必须由英文、数字、下划线和 / 组成，可用公司常见 camelCase 段；禁止中文、空格、连续斜杠和末尾斜杠。govsite/ 不是默认前缀，只有业务明确是网站发布接口时才填写。'
            });
        }

        const operations = Array.isArray(contract.operations) ? contract.operations : [];
        if (operations.length === 0) {
            issues.push({
                code: 'DESIGN_BUILDER_REST_CONTRACT_OPERATIONS_EMPTY',
                field: `entityJudgments[${idx}].restContract.operations`,
                entityKey,
                message: 'restContract.operations 至少 1 项；每项说明一个对外 REST 操作。'
            });
        }
        operations.forEach((operation, opIdx) => {
            if (!operation || typeof operation !== 'object' || Array.isArray(operation)) {
                issues.push({
                    code: 'DESIGN_BUILDER_REST_OPERATION_TYPE_INVALID',
                    field: `entityJudgments[${idx}].restContract.operations[${opIdx}]`,
                    entityKey,
                    message: 'restContract.operations[] 每项必须是对象。'
                });
                return;
            }
            const methodName = String(operation.methodName || '').trim();
            const opPath = String(operation.path || '').trim();
            const httpMethod = String(operation.httpMethod || 'POST').trim().toUpperCase();
            if (!String(operation.operationKey || '').trim()) {
                issues.push({
                    code: 'DESIGN_BUILDER_REST_OPERATION_KEY_MISSING',
                    field: `entityJudgments[${idx}].restContract.operations[${opIdx}].operationKey`,
                    entityKey,
                    message: 'restContract.operations[].operationKey 必填，用英文 snake_case 标识该接口操作。'
                });
            }
            if (!methodName) {
                issues.push({
                    code: 'DESIGN_BUILDER_REST_OPERATION_METHOD_NAME_MISSING',
                    field: `entityJudgments[${idx}].restContract.operations[${opIdx}].methodName`,
                    entityKey,
                    message: 'restContract.operations[].methodName 必填，例如 getCertCallLogListByCondition。'
                });
            } else if (!/^[a-z][A-Za-z0-9]*$/.test(methodName)) {
                issues.push({
                    code: 'DESIGN_BUILDER_REST_OPERATION_METHOD_NAME_INVALID',
                    field: `entityJudgments[${idx}].restContract.operations[${opIdx}].methodName`,
                    entityKey,
                    value: methodName,
                    message: 'restContract.operations[].methodName 必须是 lowerCamelCase Java 方法名。'
                });
            } else if (methodName === 'queryList') {
                issues.push({
                    code: 'DESIGN_BUILDER_REST_OPERATION_METHOD_NAME_DEFAULT',
                    field: `entityJudgments[${idx}].restContract.operations[${opIdx}].methodName`,
                    entityKey,
                    value: methodName,
                    message: 'methodName=queryList 是骨架默认占位，不是业务接口命名；请按当前 REST 业务语义填写明确方法名。'
                });
            }
            if (!opPath) {
                issues.push({
                    code: 'DESIGN_BUILDER_REST_OPERATION_PATH_MISSING',
                    field: `entityJudgments[${idx}].restContract.operations[${opIdx}].path`,
                    entityKey,
                    message: 'restContract.operations[].path 必填，必须以 / 开头，例如 /getCertCallLogListByCondition。'
                });
            } else if (!this._isValidRestOperationPath(opPath)) {
                issues.push({
                    code: 'DESIGN_BUILDER_REST_OPERATION_PATH_INVALID',
                    field: `entityJudgments[${idx}].restContract.operations[${opIdx}].path`,
                    entityKey,
                    value: opPath,
                    message: 'restContract.operations[].path 必须以 / 开头，路径段可用英文、数字、下划线和公司常见 camelCase；禁止中文、空格、连续斜杠和末尾斜杠。'
                });
            } else if (opPath.toLowerCase() === '/querylist') {
                issues.push({
                    code: 'DESIGN_BUILDER_REST_OPERATION_PATH_DEFAULT',
                    field: `entityJudgments[${idx}].restContract.operations[${opIdx}].path`,
                    entityKey,
                    value: opPath,
                    message: 'path=/querylist 是骨架默认占位，不是业务接口路径；请按当前 REST 业务语义填写明确路径。'
                });
            }
            if (!['GET', 'POST', 'PUT', 'DELETE', 'PATCH'].includes(httpMethod)) {
                issues.push({
                    code: 'DESIGN_BUILDER_REST_OPERATION_HTTP_METHOD_INVALID',
                    field: `entityJudgments[${idx}].restContract.operations[${opIdx}].httpMethod`,
                    entityKey,
                    value: httpMethod,
                    message: 'restContract.operations[].httpMethod 必须是 GET / POST / PUT / DELETE / PATCH。'
                });
            }
            ['purpose', 'requestShape', 'responseShape'].forEach(field => {
                if (!String(operation[field] || '').trim()) {
                    issues.push({
                        code: 'DESIGN_BUILDER_REST_OPERATION_FIELD_MISSING',
                        field: `entityJudgments[${idx}].restContract.operations[${opIdx}].${field}`,
                        entityKey,
                        message: `restContract.operations[].${field} 必填，用一句业务事实说明接口用途、入参口径或返回口径。`
                    });
                }
            });
        });
        return issues;
    }

    _isValidRestBasePath(value = '') {
        const text = String(value || '').trim().replace(/^\/+/, '');
        if (!text || text.includes('//') || text.endsWith('/')) return false;
        return /^[A-Za-z][A-Za-z0-9_]*(\/[A-Za-z][A-Za-z0-9_]*)*$/.test(text);
    }

    _isValidRestOperationPath(value = '') {
        const text = String(value || '').trim();
        if (!text.startsWith('/') || text.includes('//') || (text.length > 1 && text.endsWith('/'))) return false;
        return /^\/[A-Za-z][A-Za-z0-9_]*(\/[A-Za-z][A-Za-z0-9_]*)*$/.test(text);
    }

    _normalizeRestContract(value = null, entityKey = '') {
        if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
        if (this._isEmptyRestContractShell(value)) return null;
        const operations = (Array.isArray(value.operations) ? value.operations : [])
            .filter(item => item && typeof item === 'object' && !Array.isArray(item))
            .map(item => ({
                operationKey: String(item.operationKey || '').trim(),
                methodName: String(item.methodName || '').trim(),
                path: String(item.path || '').trim(),
                httpMethod: String(item.httpMethod || 'POST').trim().toUpperCase(),
                purpose: String(item.purpose || '').trim(),
                requestShape: String(item.requestShape || '').trim(),
                responseShape: String(item.responseShape || '').trim()
            }));
        return {
            basePath: String(value.basePath || '').trim().replace(/^\/+/, '') || this._toPathSegment(entityKey),
            operations
        };
    }

    _normalizeSubmittedRestContractPresence(value = undefined) {
        if (value === undefined || value === null) return null;
        if (this._isEmptyRestContractShell(value)) return null;
        return value;
    }

    _isEmptyRestContractShell(value = null) {
        if (value === undefined || value === null) return true;
        if (typeof value === 'string') return value.trim().length === 0;
        if (typeof value !== 'object' || Array.isArray(value)) return false;
        const basePath = String(value.basePath || '').trim();
        const operations = Array.isArray(value.operations) ? value.operations : [];
        const hasMeaningfulExtra = Object.keys(value).some(key => {
            if (key === 'basePath' || key === 'operations') return false;
            return this._hasMeaningfulOptionalContractValue(value[key]);
        });
        return !basePath && operations.length === 0 && !hasMeaningfulExtra;
    }

    _normalizeStatisticsContract(value = null) {
        if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
        if (this._isEmptyStatisticsContractShell(value)) return null;
        const normalizeArray = (items = [], mapper = item => item) => (Array.isArray(items) ? items : [])
            .filter(item => item && typeof item === 'object' && !Array.isArray(item))
            .map(mapper)
            .filter(item => Object.keys(item).length > 0);
        const normalizeDisplay = display => {
            if (!display || typeof display !== 'object' || Array.isArray(display)) return null;
            return this._stripEmptyObject({
                summaryCards: display.summaryCards === true,
                dataGrid: display.dataGrid === true,
                chart: String(display.chart || '').trim(),
                note: String(display.note || '').trim()
            });
        };
        return this._stripEmptyObject({
            title: String(value.title || '').trim(),
            purpose: String(value.purpose || '').trim(),
            dataSources: normalizeArray(value.dataSources, item => this._stripEmptyObject({
                tableName: String(item.tableName || '').trim(),
                role: String(item.role || '').trim(),
                joinHint: String(item.joinHint || '').trim(),
                sourceName: String(item.sourceName || '').trim()
            })),
            filters: normalizeArray(value.filters, item => this._stripEmptyObject({
                key: String(item.key || '').trim(),
                label: String(item.label || '').trim(),
                type: String(item.type || '').trim(),
                sourceField: String(item.sourceField || '').trim(),
                required: item.required === true,
                description: String(item.description || '').trim()
            })),
            dimensions: normalizeArray(value.dimensions, item => this._stripEmptyObject({
                key: String(item.key || '').trim(),
                label: String(item.label || '').trim(),
                sourceField: String(item.sourceField || '').trim(),
                granularity: String(item.granularity || '').trim(),
                description: String(item.description || '').trim()
            })),
            metrics: normalizeArray(value.metrics, item => this._stripEmptyObject({
                key: String(item.key || '').trim(),
                label: String(item.label || '').trim(),
                aggregate: String(item.aggregate || '').trim(),
                sourceField: String(item.sourceField || '').trim(),
                condition: String(item.condition || '').trim(),
                formula: String(item.formula || '').trim(),
                description: String(item.description || '').trim()
            })),
            display: normalizeDisplay(value.display),
            ...(typeof value.exportRequired === 'boolean' ? { exportRequired: value.exportRequired } : {}),
            source: value.source && typeof value.source === 'object' && !Array.isArray(value.source)
                ? JSON.parse(JSON.stringify(value.source))
                : String(value.source || '').trim()
        });
    }

    _normalizeStatisticsContracts(value = [], fallback = null) {
        const out = [];
        const seen = new Set();
        const push = item => {
            const normalized = this._normalizeStatisticsContract(item);
            if (!normalized) return;
            const storyId = String(item && (item.storyId || item.sourceStoryId) || '').trim();
            const next = this._stripEmptyObject({
                ...(storyId ? { storyId, sourceStoryId: storyId } : {}),
                ...normalized
            });
            const key = `${storyId}::${JSON.stringify(this._stripStatisticsStoryRef(next))}`;
            if (seen.has(key)) return;
            seen.add(key);
            out.push(next);
        };
        if (Array.isArray(value)) {
            value.forEach(push);
        } else {
            push(value);
        }
        if (out.length === 0 && fallback) {
            push(fallback);
        }
        return out;
    }

    _normalizeWorkflowContract(value = null) {
        if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
        if (this._isEmptyWorkflowContractShell(value)) return null;
        const normalizeOperations = (items = []) => (Array.isArray(items) ? items : [])
            .map(item => {
                if (item && typeof item === 'object' && !Array.isArray(item)) {
                    return this._stripEmptyObject({
                        key: String(item.key || '').trim(),
                        name: String(item.name || '').trim(),
                        semantic: String(item.semantic || item.actionType || '').trim().toLowerCase(),
                        type: String(item.type || '').trim(),
                        operationType: String(item.operationType || '').trim(),
                        targetActivity: String(item.targetActivity || item.target || '').trim(),
                        requiresOpinion: item.requiresOpinion === true || item.isRequireOpinion === true,
                        checkMaterialSubmit: item.checkMaterialSubmit === true || item.isCheckMaterialSubmit === true
                    });
                }
                const text = String(item || '').trim();
                return text ? { name: text } : {};
            })
            .filter(item => Object.keys(item).length > 0);
        const activities = (Array.isArray(value.activities) ? value.activities : [])
            .filter(item => item && typeof item === 'object' && !Array.isArray(item))
            .map(item => this._stripEmptyObject({
                key: String(item.key || '').trim(),
                name: String(item.name || '').trim(),
                actor: String(item.actor || '').trim(),
                type: String(item.type || '').trim(),
                handleUrl: String(item.handleUrl || item.pageUrl || '').trim(),
                operations: normalizeOperations(item.operations)
            }))
            .filter(item => Object.keys(item).length > 0);
        const transitions = (Array.isArray(value.transitions) ? value.transitions : [])
            .filter(item => item && typeof item === 'object' && !Array.isArray(item))
            .map(item => this._stripEmptyObject({
                from: String(item.from || '').trim(),
                to: String(item.to || '').trim(),
                condition: String(item.condition || '').trim()
            }))
            .filter(item => Object.keys(item).length > 0);
        const businessResults = (Array.isArray(value.businessResults) ? value.businessResults : [])
            .map(item => String(item || '').trim())
            .filter(Boolean);
        const normalizeParameters = (items = []) => (Array.isArray(items) ? items : [])
            .filter(item => item && typeof item === 'object' && !Array.isArray(item))
            .map(item => this._stripEmptyObject({
                name: String(item.name || '').trim(),
                source: String(item.source || '').trim(),
                value: String(item.value || '').trim(),
                description: String(item.description || '').trim()
            }))
            .filter(item => Object.keys(item).length > 0);
        const operationEvents = (Array.isArray(value.operationEvents) ? value.operationEvents : [])
            .filter(item => item && typeof item === 'object' && !Array.isArray(item))
            .map(item => this._stripEmptyObject({
                storyId: String(item.storyId || '').trim().toUpperCase(),
                operationKey: String(item.operationKey || '').trim(),
                activityKey: String(item.activityKey || '').trim(),
                activityName: String(item.activityName || '').trim(),
                operationName: String(item.operationName || '').trim(),
                semantic: String(item.semantic || '').trim().toLowerCase(),
                mode: String(item.mode || '').trim().toLowerCase(),
                methodName: String(item.methodName || '').trim(),
                businessEffect: String(item.businessEffect || '').trim(),
                parameters: normalizeParameters(item.parameters)
            }))
            .filter(item => Object.keys(item).length > 0);
        const workflowExternalMethodSeeds = (Array.isArray(value.workflowExternalMethodSeeds) ? value.workflowExternalMethodSeeds : [])
            .filter(item => item && typeof item === 'object' && !Array.isArray(item))
            .map(item => this._stripEmptyObject({
                storyId: String(item.storyId || '').trim().toUpperCase(),
                operationKey: String(item.operationKey || '').trim(),
                activityName: String(item.activityName || '').trim(),
                operationName: String(item.operationName || '').trim(),
                methodName: String(item.methodName || '').trim(),
                businessEffect: String(item.businessEffect || '').trim(),
                parameters: normalizeParameters(item.parameters)
            }))
            .filter(item => Object.keys(item).length > 0);
        return this._stripEmptyObject({
            processName: String(value.processName || '').trim(),
            starter: String(value.starter || '').trim(),
            activities,
            transitions,
            businessResults,
            ...(operationEvents.length > 0 ? { operationEvents } : {}),
            ...(workflowExternalMethodSeeds.length > 0 ? { workflowExternalMethodSeeds } : {}),
            pageSet: String(value.pageSet || 'full_workflow_pages').trim() || 'full_workflow_pages',
            source: String(value.source || 'stories.workflowIntent').trim() || 'stories.workflowIntent'
        });
    }

    _normalizeWorkflowContracts(value = [], fallback = null) {
        const out = [];
        const seen = new Set();
        const push = item => {
            const normalized = this._normalizeWorkflowContract(item);
            if (!normalized) return;
            const storyId = String(item && (item.storyId || item.sourceStoryId) || '').trim();
            const next = this._stripEmptyObject({
                ...(storyId ? { storyId, sourceStoryId: storyId } : {}),
                ...normalized
            });
            const key = `${storyId}::${JSON.stringify(this._stripWorkflowStoryRef(next))}`;
            if (seen.has(key)) return;
            seen.add(key);
            out.push(next);
        };
        if (Array.isArray(value)) {
            value.forEach(push);
        } else {
            push(value);
        }
        if (out.length === 0 && fallback) {
            push(fallback);
        }
        return out;
    }

    _withWorkflowStoryRef(storyId = '', contract = {}) {
        const normalized = this._normalizeWorkflowContract(contract);
        if (!normalized) return null;
        const ref = String(storyId || contract.storyId || contract.sourceStoryId || '').trim();
        return this._stripEmptyObject({
            ...(ref ? { storyId: ref, sourceStoryId: ref } : {}),
            ...normalized
        });
    }

    _stripWorkflowStoryRef(contract = {}) {
        if (!contract || typeof contract !== 'object' || Array.isArray(contract)) return contract;
        const { storyId, sourceStoryId, ...rest } = contract;
        return rest;
    }

    _normalizeSubmittedWorkflowContractPresence(value = undefined) {
        if (value === undefined || value === null) return null;
        if (this._isEmptyWorkflowContractShell(value)) return null;
        return value;
    }

    _isEmptyWorkflowContractShell(value = null) {
        if (value === undefined || value === null) return true;
        if (typeof value === 'string') return value.trim().length === 0;
        if (typeof value !== 'object' || Array.isArray(value)) return false;
        const processName = String(value.processName || '').trim();
        const activities = Array.isArray(value.activities) ? value.activities : [];
        const transitions = Array.isArray(value.transitions) ? value.transitions : [];
        const businessResults = Array.isArray(value.businessResults) ? value.businessResults : [];
        const starter = String(value.starter || '').trim();
        return !processName && !starter && activities.length === 0 && transitions.length === 0 && businessResults.length === 0;
    }

    _withStatisticsStoryRef(storyId = '', contract = {}) {
        const normalized = this._normalizeStatisticsContract(contract);
        if (!normalized) return null;
        const ref = String(storyId || contract.storyId || contract.sourceStoryId || '').trim();
        return this._stripEmptyObject({
            ...(ref ? { storyId: ref, sourceStoryId: ref } : {}),
            ...normalized
        });
    }

    _stripStatisticsStoryRef(contract = {}) {
        if (!contract || typeof contract !== 'object' || Array.isArray(contract)) return contract;
        const { storyId, sourceStoryId, ...rest } = contract;
        return rest;
    }

    _normalizeSubmittedStatisticsContractPresence(value = undefined) {
        if (value === undefined || value === null) return null;
        if (this._isEmptyStatisticsContractShell(value)) return null;
        return value;
    }

    _isEmptyStatisticsContractShell(value = null) {
        return this._isEmptyRestContractShell(value);
    }

    _stripEmptyObject(value = {}) {
        const out = {};
        Object.keys(value || {}).forEach(key => {
            const item = value[key];
            if (item === undefined || item === null || item === '') return;
            if (Array.isArray(item) && item.length === 0) return;
            if (item && typeof item === 'object' && !Array.isArray(item) && Object.keys(item).length === 0) return;
            out[key] = item;
        });
        return out;
    }

    _hasMeaningfulOptionalContractValue(value) {
        if (Array.isArray(value)) return value.length > 0;
        if (value && typeof value === 'object') {
            return Object.keys(value).some(key => this._hasMeaningfulOptionalContractValue(value[key]));
        }
        return String(value || '').trim().length > 0;
    }

    _entityHasExistingEntryFiles(entity = {}, storiesById = new Map()) {
        const directStories = Array.isArray(entity && entity.relatedStories) ? entity.relatedStories : [];
        if (directStories.some(story => this._storyHasExistingEntryFiles(story))) {
            return true;
        }
        const relatedStoryIds = Array.isArray(entity && entity.relatedStoryIds)
            ? entity.relatedStoryIds.map(sid => String(sid || '').trim().toUpperCase()).filter(Boolean)
            : [];
        return relatedStoryIds.some(storyId => this._storyHasExistingEntryFiles(storiesById.get(storyId)));
    }

    _storyHasExistingEntryFiles(story = {}) {
        const existing = story && story.existingAdjustment && typeof story.existingAdjustment === 'object' && !Array.isArray(story.existingAdjustment)
            ? story.existingAdjustment
            : {};
        return Array.isArray(existing.entryFiles) && existing.entryFiles.length > 0;
    }

    /**
     * 兼容投影：每个 entity → 1 个 module，附 codingHandoff 镜像 fileSet 旧字段。
     * 下游 design-tdd-* 服务暂时仍按 modules[] 消费；entity 重构后由这层自动派生。
     */
    _projectEntitiesToLegacyModules(businessEntities = [], acceptanceCriteria = {}, storiesById = new Map()) {
        const entityKeyToModuleId = new Map();
        const entityByKey = new Map();
        // moduleId 派生：MOD-01 / MOD-02... 按 entity 顺序
        businessEntities.forEach((entity, idx) => {
            const moduleId = `MOD-${String(idx + 1).padStart(2, '0')}`;
            entityKeyToModuleId.set(entity.entityKey, moduleId);
            entityByKey.set(entity.entityKey, entity);
        });

        const modules = businessEntities.map((entity) => {
            const moduleId = entityKeyToModuleId.get(entity.entityKey);
            const fileSet = Array.isArray(entity.fileSet) ? entity.fileSet : [];
            // fileSeeds 只镜像 Java 后端文件（Entity / Service* / Action）；
            // HtmlPage 走单独的 htmlPages[] 通道交给 plan-service 的 _normalizeHtmlSeeds 循环。
            // 同时塞两边会让 plan-service 的 fileSeeds 循环先把 HtmlPage 注册到 dedup map，
            // _normalizeHtmlSeeds 二次进入时全部命中 existingOwner → 降级为 consumer →
            // build.htmlPages 数组为空 → plan 摘要 htmlPageCount=0（虽然 filePlan 仍有 HtmlPage）。
            const fileSeeds = fileSet
                .filter(file => file.fileKind !== 'HtmlPage')
                .map(file => ({
                    fileKind: file.fileKind,
                    ...(file.subType ? { subType: file.subType } : {}),
                    operation: file.operation || 'create',
                    evidenceRef: moduleId,
                    ...(file.objectKey ? { objectKey: file.objectKey } : {}),
                    ...(Array.isArray(file.storyIds) ? { storyIds: file.storyIds.slice() } : {}),
                    ...(file.projectionSource ? { projectionSource: file.projectionSource } : {}),
                    ...(file.managedProjection === true ? { managedProjection: true } : {}),
                    ...(file.queryOnly === true ? { queryOnly: true } : {}),
                    ...(file.statisticsOnly === true ? { statisticsOnly: true } : {}),
                    ...(file.serviceOnly === true ? { serviceOnly: true } : {}),
                    ...(file.noEntity === true ? { noEntity: true } : {}),
                    ...(file.sectionKey ? { sectionKey: file.sectionKey } : {}),
                    ...(file.targetPageRole ? { targetPageRole: file.targetPageRole } : {}),
                    ...(file.interactionCarrier ? { interactionCarrier: file.interactionCarrier } : {})
                }));
            // htmlPages 镜像：fileSet 中的 HtmlPage 项
            const htmlPages = fileSet
                .filter(file => file.fileKind === 'HtmlPage')
                .map(file => ({
                    subType: file.subType,
                    pageName: entity.pageName,
                    bizModule: entity.bizModule,
                    evidenceRef: moduleId,
                    ...(file.objectKey ? { objectKey: file.objectKey } : {}),
                    ...(Array.isArray(file.storyIds) ? { storyIds: file.storyIds.slice() } : {}),
                    ...(file.projectionSource ? { projectionSource: file.projectionSource } : {}),
                    ...(file.managedProjection === true ? { managedProjection: true } : {}),
                    ...(file.queryOnly === true ? { queryOnly: true } : {}),
                    ...(file.statisticsOnly === true ? { statisticsOnly: true } : {}),
                    ...(file.sectionKey ? { sectionKey: file.sectionKey } : {}),
                    ...(file.targetPageRole ? { targetPageRole: file.targetPageRole } : {}),
                    ...(file.interactionCarrier ? { interactionCarrier: file.interactionCarrier } : {})
                }));

            const carriedByModuleId = entity.carriedByEntityKey
                ? entityKeyToModuleId.get(entity.carriedByEntityKey)
                : undefined;
            const carriedByEntity = entity.carriedByEntityKey
                ? entityByKey.get(entity.carriedByEntityKey)
                : null;
            const carriedServiceName = this._serviceApiNameFromEntity(carriedByEntity);

            // 聚合本 entity 的 acceptanceCriteria（去掉 sourceStoryId 让旧 schema 校验不报）
            const ac = acceptanceCriteria[entity.entityKey] || { happyPath: [], exception: [], boundary: [] };
            const cleanGwt = list => (Array.isArray(list) ? list : []).map(g => ({
                scenario: g.scenario || '',
                given: g.given || '',
                when: g.when || '',
                then: g.then || ''
            }));

            // userStory：取关联 Story 的第一条；invariants：聚合所有关联 Story 的 invariants
            const firstStory = (Array.isArray(entity.relatedStories) && entity.relatedStories[0]) || {};
            const allInvariants = [];
            (entity.relatedStories || []).forEach(s => {
                (Array.isArray(s.invariants) ? s.invariants : []).forEach(inv => allInvariants.push(inv));
            });
            const codingFactHandoff = this._collectCodingFactHandoff(entity.relatedStories || []);

            return {
                moduleId,
                objectKey: entity.entityKey,
                moduleName: entity.displayName,
                userStory: firstStory.userStory || '',
                acceptanceCriteria: {
                    happyPath: cleanGwt(ac.happyPath),
                    exception: cleanGwt(ac.exception),
                    boundary: cleanGwt(ac.boundary)
                },
                invariants: allInvariants,
                ...(codingFactHandoff.length > 0 ? { codingFactHandoff } : {}),
                businessObject: entity.businessObject,
                aggregateRoot: entity.aggregateRoot || entity.businessObject,
                domain: entity.domain,
                constructionSceneKey: entity.constructionSceneKey,
                relatedStoryIds: Array.isArray(entity.relatedStoryIds) ? entity.relatedStoryIds.slice() : [],
                practiceSceneKeys: Array.isArray(entity.practiceSceneKeys) ? entity.practiceSceneKeys : [],
                ...(entity.statisticsContract ? { statisticsContract: entity.statisticsContract } : {}),
                ...(Array.isArray(entity.statisticsContracts) && entity.statisticsContracts.length > 0 ? { statisticsContracts: entity.statisticsContracts } : {}),
                ...(entity.workflowContract ? { workflowContract: entity.workflowContract } : {}),
                ...(Array.isArray(entity.workflowContracts) && entity.workflowContracts.length > 0 ? { workflowContracts: entity.workflowContracts } : {}),
                ...(entity.interactionCarrier ? { interactionCarrier: entity.interactionCarrier } : {}),
                ...(entity.pageComposition ? { pageComposition: JSON.parse(JSON.stringify(entity.pageComposition)) } : {}),
                ...(Array.isArray(entity.queryFilters) && entity.queryFilters.length > 0
                    ? { queryFilters: JSON.parse(JSON.stringify(entity.queryFilters)) }
                    : {}),
                ...(Array.isArray(entity.constructionBindings) && entity.constructionBindings.length > 0
                    ? { constructionBindings: entity.constructionBindings }
                    : {}),
                ...(entity.carriedByEntityKey ? { carriedByEntityKey: entity.carriedByEntityKey } : {}),
                ...(carriedByModuleId ? { carriedByModuleId } : {}),
                codingHandoff: {
                    objectKey: entity.entityKey,
                    bizModule: entity.bizModule,
                    domain: entity.domain,
                    entityName: entity.entityName,
                    featureName: entity.featureName || entity.entityName,
                    pageName: entity.pageName,
                    constructionSceneKey: entity.constructionSceneKey,
                    relatedStoryIds: Array.isArray(entity.relatedStoryIds) ? entity.relatedStoryIds.slice() : [],
                    practiceSceneKeys: Array.isArray(entity.practiceSceneKeys) ? entity.practiceSceneKeys : [],
                    ...(entity.statisticsContract ? { statisticsContract: entity.statisticsContract } : {}),
                    ...(Array.isArray(entity.statisticsContracts) && entity.statisticsContracts.length > 0 ? { statisticsContracts: entity.statisticsContracts } : {}),
                    ...(entity.workflowContract ? { workflowContract: entity.workflowContract } : {}),
                    ...(Array.isArray(entity.workflowContracts) && entity.workflowContracts.length > 0 ? { workflowContracts: entity.workflowContracts } : {}),
                    ...(entity.interactionCarrier ? { interactionCarrier: entity.interactionCarrier } : {}),
                    ...(entity.pageComposition ? { pageComposition: JSON.parse(JSON.stringify(entity.pageComposition)) } : {}),
                    ...(Array.isArray(entity.queryFilters) && entity.queryFilters.length > 0
                        ? { queryFilters: JSON.parse(JSON.stringify(entity.queryFilters)) }
                        : {}),
                    ...(Array.isArray(entity.constructionBindings) && entity.constructionBindings.length > 0
                        ? { constructionBindings: entity.constructionBindings }
                        : {}),
                    ...(entity.carriedByEntityKey ? { carriedByEntityKey: entity.carriedByEntityKey } : {}),
                    ...(entity.restContract ? { restContract: entity.restContract } : {}),
                    ...(carriedByModuleId ? { carriedByModuleId } : {}),
                    ...((entity.statisticsContract
                        || Array.isArray(entity.statisticsContracts) && entity.statisticsContracts.length > 0)
                        ? this._buildStatisticsContractSeeds(entity, moduleId, carriedServiceName)
                        : {}),
                    fileSeeds,
                    ...(htmlPages.length > 0 ? { htmlPages } : {})
                }
            };
        });

        return { modules, entityKeyToModuleId };
    }

    _serviceApiNameFromEntity(entity = null) {
        const candidates = (entity && Array.isArray(entity.fileSet) ? entity.fileSet : [])
            .filter(file => String(file && file.fileKind || '').trim() === 'ServiceApi');
        if (candidates.length !== 1) return '';
        const source = String(candidates[0].fileName || candidates[0].resolvedPath || '').trim();
        const fileName = source.split(/[\\/]/u).pop() || '';
        return fileName.replace(/\.java$/iu, '');
    }

    _buildStatisticsContractSeeds(entity = {}, moduleId = '', ownerService = '') {
        const contracts = this._normalizeStatisticsContracts(entity.statisticsContracts, entity.statisticsContract);
        if (contracts.length === 0) return {};
        const evidenceRef = String(moduleId || '').trim();
        const statisticsPage = String(entity.constructionSceneKey || '').trim() === 'statistics_analysis';
        const restOperations = entity.restContract && Array.isArray(entity.restContract.operations)
            ? entity.restContract.operations
            : [];
        const seedSuffix = (contract = {}, idx = 0) => {
            if (idx === 0) return '';
            const storyId = String(contract.storyId || contract.sourceStoryId || '').trim().replace(/[^a-zA-Z0-9]/g, '');
            return storyId || String(idx + 1);
        };
        const serviceContractSeeds = contracts.map((contract, idx) => {
            const suffix = seedSuffix(contract, idx);
            const basePurpose = contract.title
                ? `实现「${contract.title}」统计分析口径`
                : '实现统计分析筛选、维度和指标口径';
            const sourceStoryId = String(contract.storyId || contract.sourceStoryId || '').trim();
            const restOperation = restOperations.find(operation =>
                Array.isArray(operation && operation.sourceStoryIds)
                && operation.sourceStoryIds.includes(sourceStoryId)) || restOperations[idx] || restOperations[0];
            const serviceConsumer = statisticsPage
                ? `Action.getStatisticsData${suffix}`
                : `Rest.${String(restOperation && (restOperation.methodName || restOperation.operationKey) || 'statistics')}`;
            return {
                ownerService: String(ownerService || '').trim(),
                methodName: `queryStatisticsData${suffix}`,
                actionKey: `getStatisticsData${suffix}`,
                purpose: basePurpose,
                tddIntent: 'ServiceInternal 按 statisticsContract.filters/dimensions/metrics 组装统计查询和结果',
                sourceType: 'statisticsContract',
                ...(contract.storyId ? { sourceStoryId: contract.storyId } : {}),
                ...(contract.title ? { statisticsTitle: contract.title } : {}),
                evidenceRef,
                plannedConsumer: serviceConsumer
            };
        });
        if (!statisticsPage) return { serviceContractSeeds };
        return {
            serviceContractSeeds,
            actionContractSeeds: contracts.map((contract, idx) => {
                const suffix = seedSuffix(contract, idx);
                const basePurpose = contract.title
                    ? `实现「${contract.title}」统计分析口径`
                    : '实现统计分析筛选、维度和指标口径';
                return {
                    actionKey: `getStatisticsData${suffix}`,
                    methodName: `getStatisticsData${suffix}`,
                    purpose: basePurpose,
                    tddIntent: 'Action 只接收页面筛选参数并调用 Service，不直接拼 SQL 或聚合',
                    sourceType: 'statisticsContract',
                    ...(contract.storyId ? { sourceStoryId: contract.storyId } : {}),
                    ...(contract.title ? { statisticsTitle: contract.title } : {}),
                    evidenceRef,
                    plannedConsumer: 'HtmlPage.datagrid/summary/chart'
                };
            })
        };
    }

    _buildRequirementStoriesProjection(storiesById = new Map()) {
        const stories = [];
        for (const [storyId, story] of storiesById.entries()) {
            const item = {
                storyId,
                ...(story && story.actor ? { actor: String(story.actor || '').trim() } : {}),
                userStory: String(story && story.userStory || '').trim(),
                ...(story && story.deliveryBoundary ? { deliveryBoundary: String(story.deliveryBoundary || '').trim() } : {}),
                acceptanceCriteria: this._normalizeAcceptanceCriteria(story && story.acceptanceCriteria),
                invariants: Array.isArray(story && story.invariants)
                    ? story.invariants.map(item => String(item || '').trim()).filter(Boolean)
                    : [],
                ...this._existingAdjustmentProjection(story || {}),
                ...this._codingFactHandoffProjection(story || {}),
                ...this._workflowIntentProjection(story || {})
            };
            stories.push(item);
        }
        return stories;
    }

    /**
     * 单 entity 派生：LLM 入参（业务命名 + linkedTable）+ stories.json 上游事实 → 完整 entity object
     */
    _buildEntity(judgment = {}, options = {}) {
        const entityKey = String(judgment.entityKey || '').trim();
        const displayName = String(judgment.displayName || '').trim();
        const businessObject = String(judgment.businessObject || '').trim();
        const domain = String(judgment.domain || '').trim();
        // bizModule/entityName 是 Builder-owned 派生字段；先净化项目前缀和施工场景词，
        // 再渲染 Java 包路径段 / HTML 文件名段 / 类名，避免 GxhGxh...QueryResultEntry 这类坏名。
        // entityKey 原值仍用于分组/uniqueness/carriedBy 引用，不受命名净化影响。
        const carriedByEntityKey = String(judgment.carriedByEntityKey || '').trim() || undefined;
        const relatedStoryIds = Array.isArray(judgment.relatedStoryIds)
            ? judgment.relatedStoryIds.map(s => String(s || '').trim().toUpperCase()).filter(Boolean)
            : [];
        const constructionSceneKey = String(judgment.constructionSceneKey || '').trim();
        const practiceSceneKeys = this._normalizePracticeSceneKeys(judgment.practiceSceneKeys);
        const linkedTable = judgment.linkedTable || {};
        const interactionCarrier = judgment.interactionCarrier && typeof judgment.interactionCarrier === 'object' && !Array.isArray(judgment.interactionCarrier)
            ? judgment.interactionCarrier
            : null;
        const constructionBindings = Array.isArray(judgment.constructionBindings)
            ? JSON.parse(JSON.stringify(judgment.constructionBindings))
            : [];
        const linkedTableKind = String(linkedTable.kind || '').trim().toLowerCase();

        // entityName 派生：优先用 linkedTable.tableFeatureName（new 表）或 tableName 主体段（纯 reuse 表）。
        // reuse/none 且需要新增入口时用业务对象 entityKey 派生，避免把通用复用表名当成本次入口名。
        const needsPage = linkedTable.needsPage === true;
        const entitySource = linkedTableKind === 'new'
            ? String(linkedTable.tableFeatureName || '').trim()
            : (linkedTableKind === 'reuse' && !needsPage ? this._stripTablePrefixForFeature(linkedTable.tableName) : '');
        const bizModuleSource = this._normalizeEntityNamingSource(entityKey, constructionSceneKey);
        const entityNameSource = this._normalizeEntityNamingSource(entitySource || entityKey, constructionSceneKey);
        const bizModule = this._toPathSegment(bizModuleSource || entityKey);
        const entityName = this._toPascalCase(entityNameSource || entityKey);

        // relatedStories：从 stories.json join 取每个 storyId 的 userStory + invariants
        const storiesById = options.storiesById || new Map();
        const relatedStories = relatedStoryIds.map(sid => {
            const story = storiesById.get(sid) || {};
            return {
                storyId: sid,
                userStory: String(story.userStory || '').trim(),
                ...(story.deliveryBoundary ? { deliveryBoundary: String(story.deliveryBoundary || '').trim() } : {}),
                invariants: Array.isArray(story.invariants)
                    ? story.invariants.map(item => String(item || '').trim()).filter(Boolean)
                    : [],
                ...this._existingAdjustmentProjection(story),
                ...this._codingFactHandoffProjection(story),
                ...this._workflowIntentProjection(story)
            };
        });

        const restContract = this._normalizeRestContract(judgment.restContract, entityKey);
        const statisticsContracts = this._normalizeStatisticsContracts(judgment.statisticsContracts, judgment.statisticsContract);
        const statisticsContract = statisticsContracts.length === 1
            ? this._stripStatisticsStoryRef(statisticsContracts[0])
            : null;
        const workflowContracts = this._normalizeWorkflowContracts(judgment.workflowContracts, judgment.workflowContract);
        const workflowContract = workflowContracts.length === 1
            ? this._stripWorkflowStoryRef(workflowContracts[0])
            : null;
        const pageComposition = judgment.pageComposition
            && typeof judgment.pageComposition === 'object'
            && !Array.isArray(judgment.pageComposition)
            ? JSON.parse(JSON.stringify(judgment.pageComposition))
            : null;
        const queryFilters = Array.isArray(judgment.queryFilters)
            ? JSON.parse(JSON.stringify(judgment.queryFilters))
            : [];
        const fileSetContext = {
            constructionSceneKey,
            linkedTableKind,
            needsPage,
            carriedByEntityKey,
            entityName,
            featureName: entityName,
            operationName: entityName,
            bizModule,
            domain,
            interactionCarrier,
            serviceOnly: constructionBindings.some(item => item && item.bindingKind === 'service_only'),
            placementRules: options.placementRules
        };
        const entityFileContext = {
            entityName,
            featureName: entityName,
            operationName: entityName,
            bizModule,
            domain,
            carriedByEntityKey,
            interactionCarrier
        };
        const fileSet = this.storyWorkPackageCompiler.compileEntity({
            constructionSceneKey,
            pageComposition,
            constructionBindings,
            entityKey,
            storyIds: relatedStoryIds,
            renderConstructionScene: () => this._buildFileSetForConstructionScene(fileSetContext),
            renderPageSurface: () => this._buildEntityFileSet(entityFileContext, options.placementRules)
                .filter(file => file.fileKind === 'Action' || file.fileKind === 'HtmlPage')
        });
        const entity = {
            entityKey,
            displayName,
            businessObject,
            aggregateRoot: businessObject,
            domain,
            bizModule,
            entityName,
            featureName: entityName,
            pageName: bizModule.toLowerCase(),
            constructionSceneKey,
            practiceSceneKeys,
            ...(statisticsContract ? { statisticsContract } : {}),
            ...(statisticsContracts.length > 0 ? { statisticsContracts } : {}),
            ...(workflowContract ? { workflowContract } : {}),
            ...(workflowContracts.length > 0 ? { workflowContracts } : {}),
            ...(restContract ? { restContract } : {}),
            ...(pageComposition ? { pageComposition } : {}),
            ...(queryFilters.length > 0 ? { queryFilters } : {}),
            relatedStoryIds,
            relatedStories,
            linkedTable: this._normalizeLinkedTable(linkedTable, options.entityGraph, options.confirmedTableCandidates),
            ...(interactionCarrier ? { interactionCarrier } : {}),
            ...(constructionBindings.length > 0 ? { constructionBindings } : {}),
            ...(carriedByEntityKey ? { carriedByEntityKey } : {}),
            ...(Array.isArray(judgment.carrierBusinessColumns) && judgment.carrierBusinessColumns.length > 0
                ? { carrierBusinessColumns: JSON.parse(JSON.stringify(judgment.carrierBusinessColumns)) }
                : {}),
            fileSet
        };

        return entity;
    }

    _mergeCarrierBusinessColumnsIntoOwners(businessEntities = []) {
        const issues = [];
        const byEntityKey = new Map();
        (Array.isArray(businessEntities) ? businessEntities : []).forEach(entity => {
            const key = String(entity && entity.entityKey || '').trim();
            if (key) byEntityKey.set(key, entity);
        });

        (Array.isArray(businessEntities) ? businessEntities : []).forEach((entity, idx) => {
            const carrierColumns = Array.isArray(entity && entity.carrierBusinessColumns)
                ? entity.carrierBusinessColumns
                : [];
            if (carrierColumns.length === 0) return;
            const ownerKey = String(entity && entity.carriedByEntityKey || '').trim();
            const entityKey = String(entity && entity.entityKey || '').trim();
            if (!ownerKey) {
                issues.push({
                    code: 'DESIGN_BUILDER_CARRIER_FIELDS_OWNER_MISSING',
                    field: `entityJudgments[${idx}].carrierBusinessColumns`,
                    entityKey,
                    message: 'carrierFieldRows 只能用于 carried consumer；必须有 carriedByEntityKey 指向本次 owner 表。'
                });
                return;
            }
            const owner = byEntityKey.get(ownerKey);
            if (!owner) {
                issues.push({
                    code: 'DESIGN_BUILDER_CARRIER_FIELDS_OWNER_NOT_FOUND',
                    field: `entityJudgments[${idx}].carriedByEntityKey`,
                    entityKey,
                    carriedByEntityKey: ownerKey,
                    message: `carrierFieldRows 声明写入 owner="${ownerKey}"，但当前设计中找不到该 owner。`
                });
                return;
            }
            const ownerLinked = owner.linkedTable && typeof owner.linkedTable === 'object' && !Array.isArray(owner.linkedTable)
                ? owner.linkedTable
                : {};
            if (String(ownerLinked.kind || '').trim().toLowerCase() !== 'new') {
                issues.push({
                    code: 'DESIGN_BUILDER_CARRIER_FIELDS_OWNER_MUST_BE_NEW_TABLE',
                    field: `entityJudgments[${idx}].carriedByEntityKey`,
                    entityKey,
                    carriedByEntityKey: ownerKey,
                    message: 'carrierFieldRows 只能合并到本次新建 owner 表；确认候选表、外部接口或无本地表不能通过 carrierFieldRows 偷写 DDL。'
                });
                return;
            }
            if (!Array.isArray(ownerLinked.businessColumns)) {
                ownerLinked.businessColumns = [];
            }
            for (const column of carrierColumns) {
                const normalized = this._normalizeBusinessColumnForCompare(column);
                if (!normalized.name) continue;
                const existing = ownerLinked.businessColumns.find(item =>
                    String(item && item.name || '').trim().toLowerCase() === normalized.name.toLowerCase());
                if (!existing) {
                    ownerLinked.businessColumns.push(JSON.parse(JSON.stringify(column)));
                    continue;
                }
                if (!this._businessColumnDefinitionsEqual(existing, column)) {
                    issues.push({
                        code: 'DESIGN_BUILDER_CARRIER_FIELD_CONFLICT',
                        field: `entityJudgments[${idx}].carrierBusinessColumns`,
                        entityKey,
                        carriedByEntityKey: ownerKey,
                        columnName: normalized.name,
                        message: `carrierFieldRows 字段 "${normalized.name}" 与 owner 表已有字段同名但定义不一致；请回 T2 统一字段类型、长度、必填和注释，或改用不同业务字段名。`
                    });
                }
            }
            entity.carrierFieldMerge = {
                mergedIntoEntityKey: ownerKey,
                columnNames: carrierColumns
                    .map(column => String(column && column.name || '').trim())
                    .filter(Boolean)
            };
            delete entity.carrierBusinessColumns;
        });

        return issues.length > 0 ? { ok: false, issues } : { ok: true };
    }

    _validateCodeItemColumnProjection(column, entityIndex, columnIndex, entityKey) {
        if (!column || typeof column !== 'object') return [];
        const issues = [];
        const hasCodeItem = typeof column.codeItem === 'string' && !!column.codeItem.trim();
        const definition = column.codeItemDefinition;
        const field = `entityJudgments[${entityIndex}].linkedTable.businessColumns[${columnIndex}].codeItemDefinition`;
        if (!hasCodeItem && definition !== undefined) {
            issues.push({ code: 'DESIGN_BUILDER_CODE_ITEM_DEFINITION_WITHOUT_BINDING', field, entityKey, message: '字段没有codeItem名称时不得出现codeItemDefinition。' });
            return issues;
        }
        if (!hasCodeItem) return issues;
        if (!definition || typeof definition !== 'object' || Array.isArray(definition)) {
            issues.push({ code: 'DESIGN_BUILDER_CODE_ITEM_DEFINITION_MISSING', field, entityKey, message: `代码项${column.codeItem}缺少new/reuse判别定义。` });
            return issues;
        }
        const mode = String(definition.mode || '').trim();
        if (mode === 'reuse') {
            if (!String(definition.sourceRef || '').trim()) {
                issues.push({ code: 'DESIGN_BUILDER_CODE_ITEM_REUSE_SOURCE_MISSING', field: `${field}.sourceRef`, entityKey, message: `复用代码项${column.codeItem}缺少Requirement事实ref。` });
            }
            return issues;
        }
        if (mode !== 'new') {
            issues.push({ code: 'DESIGN_BUILDER_CODE_ITEM_MODE_INVALID', field: `${field}.mode`, entityKey, message: `代码项${column.codeItem}的mode必须是new或reuse。` });
            return issues;
        }
        const codes = Array.isArray(definition.codes) ? definition.codes : [];
        if (codes.length === 0) {
            issues.push({ code: 'DESIGN_BUILDER_CODE_ITEM_VALUES_EMPTY', field: `${field}.codes`, entityKey, message: `新增代码项${column.codeItem}至少需要一个代码值。` });
            return issues;
        }
        const seen = new Set();
        codes.forEach((code, codeIndex) => {
            const codeValue = String(code && code.codeValue || '').trim();
            const codeLabel = String(code && code.codeLabel || '').trim();
            if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(codeValue) || !codeLabel || !Number.isInteger(Number(code && code.order)) || Number(code.order) < 1) {
                issues.push({ code: 'DESIGN_BUILDER_CODE_ITEM_VALUE_INVALID', field: `${field}.codes[${codeIndex}]`, entityKey, message: `新增代码项${column.codeItem}的codeValue/codeLabel/order不合法。` });
            } else if (seen.has(codeValue)) {
                issues.push({ code: 'DESIGN_BUILDER_CODE_ITEM_VALUE_DUPLICATED', field: `${field}.codes[${codeIndex}].codeValue`, entityKey, message: `新增代码项${column.codeItem}的codeValue=${codeValue}重复。` });
            }
            seen.add(codeValue);
        });
        return issues;
    }

    _normalizeBusinessColumnForCompare(column = {}) {
        const lengthValue = column && Object.prototype.hasOwnProperty.call(column, 'length') ? column.length : '';
        return {
            name: String(column && column.name || '').trim(),
            type: String(column && column.type || '').trim().toUpperCase(),
            length: String(lengthValue === undefined || lengthValue === null ? '' : lengthValue).trim(),
            required: column && column.required === true,
            comment: String(column && column.comment || '').trim(),
            codeItem: String(column && column.codeItem || '').trim(),
            codeItemDefinition: JSON.stringify(column && column.codeItemDefinition || null),
            attachmentKey: column && column.attachmentKey === true,
            attachmentLabel: String(column && column.attachmentLabel || '').trim()
        };
    }

    _businessColumnDefinitionsEqual(left = {}, right = {}) {
        const l = this._normalizeBusinessColumnForCompare(left);
        const r = this._normalizeBusinessColumnForCompare(right);
        return l.name.toLowerCase() === r.name.toLowerCase()
            && l.type === r.type
            && l.length === r.length
            && l.required === r.required
            && l.comment === r.comment
            && l.codeItem === r.codeItem
            && l.codeItemDefinition === r.codeItemDefinition
            && l.attachmentKey === r.attachmentKey
            && l.attachmentLabel === r.attachmentLabel;
    }

    _normalizePracticeSceneKeys(value = []) {
        if (!Array.isArray(value)) return [];
        return Array.from(new Set(value
            .map(item => String(item || '').trim())
            .filter(item => PRACTICE_SCENE_KEYS.includes(item))));
    }

    _buildFileSetForConstructionScene(ctx = {}) {
        const entityCtx = {
            entityName: ctx.entityName,
            featureName: ctx.featureName || ctx.entityName,
            operationName: ctx.operationName || ctx.featureName || ctx.entityName,
            bizModule: ctx.bizModule,
            domain: ctx.domain,
            carriedByEntityKey: ctx.carriedByEntityKey,
            interactionCarrier: ctx.interactionCarrier || null
        };
        const placementRules = ctx.placementRules || {};
        const isCarriedConsumer = String(ctx.carriedByEntityKey || '').trim()
            && String(ctx.linkedTableKind || '').trim().toLowerCase() === 'none';
        switch (ctx.constructionSceneKey) {
            case 'configuration_only':
                return [];
            case 'crud_new_full':
                return this._buildEntityFileSet(entityCtx, placementRules);
            case 'backend_data_carrier':
                return this._buildBackendCarrierFileSet(entityCtx, placementRules);
            case 'query_result_entry':
                return this._buildQueryEntryFileSet(entityCtx, placementRules);
            case 'statistics_analysis':
                return this._buildStatisticsFileSet({
                    ...entityCtx,
                    interactionCarrier: entityCtx.interactionCarrier || {
                        kind: 'current_page_region',
                        targetPageRole: 'report',
                        trigger: 'menu_entry'
                    }
                }, placementRules);
            case 'workflow_process':
                if (isCarriedConsumer) return [];
                return this._buildWorkflowProcessFileSet(entityCtx, placementRules);
            case 'rest_interface':
                return this._mergeFileSets(
                    ctx.linkedTableKind === 'new' ? this._buildBackendCarrierFileSet(entityCtx, placementRules) : [],
                    this._buildRestFileSet(entityCtx, placementRules)
                );
            case 'scheduled_job':
                return this._mergeFileSets(
                    ctx.linkedTableKind === 'new' ? this._buildBackendCarrierFileSet(entityCtx, placementRules) : [],
                    this._buildJobFileSet(entityCtx, placementRules)
                );
            case 'mixed_prepare_then_patch':
                return this._mergeFileSets(
                    ctx.linkedTableKind === 'new' ? this._buildBackendCarrierFileSet(entityCtx, placementRules) : [],
                    ctx.needsPage === true ? this._buildQueryEntryFileSet(entityCtx, placementRules) : []
                );
            case 'existing_entry_patch':
            case 'targeted_patch_only':
                if (ctx.serviceOnly === true) return this._buildServiceOnlyFileSet(entityCtx, placementRules);
                return [];
            default:
                return [];
        }
    }

    _buildStatisticsFileSet(entityCtx = {}, placementRules = {}) {
        return this._buildQueryEntryFileSet(entityCtx, placementRules)
            .map(file => ({
                ...file,
                queryOnly: undefined,
                statisticsOnly: true,
                sectionKey: file.fileKind === 'Action' ? 'StatisticsAction' : 'StatisticsHtmlPage'
            }))
            .map(file => {
                const normalized = { ...file };
                delete normalized.queryOnly;
                return normalized;
            });
    }

    _buildServiceOnlyFileSet(entityCtx = {}, placementRules = {}) {
        return this._buildBackendCarrierFileSet(entityCtx, placementRules)
            .filter(file => file.fileKind !== 'Entity')
            .map(file => ({ ...file, serviceOnly: true, noEntity: true }));
    }

    _buildWorkflowProcessFileSet(entityCtx = {}, placementRules = {}) {
        const serviceFiles = this._buildBackendCarrierFileSet(entityCtx, placementRules);
        const workflowActionSubTypes = ['list', 'mylist', 'add', 'edit', 'detail', 'workflow'];
        const workflowHtmlSubTypes = [...workflowActionSubTypes, 'workflowdetail'];
        const pageRoleMap = {
            list: 'workflow_admin_list',
            mylist: 'workflow_my_list',
            add: 'workflow_add',
            edit: 'workflow_edit',
            detail: 'workflow_detail',
            workflow: 'workflow_process',
            workflowdetail: 'workflow_detail'
        };
        const actionFiles = this._buildSubTypePlacementFileSet('Action', workflowActionSubTypes, entityCtx, placementRules)
            .map(file => ({
                ...file,
                sectionKey: this._workflowSectionKey('Action', file.subType),
                targetPageRole: pageRoleMap[String(file.subType || '').trim().toLowerCase()] || 'workflow_process'
            }));
        const htmlFiles = this._buildSubTypePlacementFileSet('HtmlPage', workflowHtmlSubTypes, entityCtx, placementRules)
            .map(file => ({
                ...file,
                sectionKey: this._workflowSectionKey('HtmlPage', file.subType),
                targetPageRole: pageRoleMap[String(file.subType || '').trim().toLowerCase()] || 'workflow_process'
            }));
        return this._mergeFileSets(serviceFiles, actionFiles, htmlFiles);
    }

    _workflowSectionKey(fileKind = '', subType = '') {
        const kind = String(fileKind || '').trim();
        const sub = String(subType || '').trim().toLowerCase();
        if (kind === 'Action') {
            const map = {
                list: 'ListAction',
                mylist: 'WorkflowMyListAction',
                add: 'AddAction',
                edit: 'EditAction',
                detail: 'DetailAction',
                workflow: 'WorkflowAction'
            };
            return map[sub] || 'ListAction';
        }
        if (kind === 'HtmlPage') {
            const map = {
                list: '列表页',
                mylist: 'WorkflowMyListHtmlPage',
                add: '新增页',
                edit: '编辑页',
                detail: '详情页',
                workflow: 'WorkflowHtmlPage',
                workflowdetail: 'WorkflowDetailHtmlPage'
            };
            return map[sub] || sub;
        }
        return '';
    }

    _buildSubTypePlacementFileSet(fileKind = '', subTypes = [], entityCtx = {}, placementRules = {}) {
        const rule = placementRules[fileKind];
        if (!rule) return [];
        const renderRelativeDir = (pattern) => this._renderPlacementRelativeDir(pattern, entityCtx);
        const renderFileName = (pattern, subType) => this._renderPlacementFileName(pattern, entityCtx, subType);
        const dir = renderRelativeDir(rule.relativeDirPattern);
        if (!dir) return [];
        const variants = (rule.variants && typeof rule.variants === 'object') ? rule.variants : {};
        return (Array.isArray(subTypes) ? subTypes : [])
            .map(subType => {
                const sub = String(subType || '').trim().toLowerCase();
                if (!sub) return null;
                const variant = variants[sub] || {};
                const listVariant = variants.list || {};
                let fileNamePattern = String(variant.fileNamePattern || rule.fileNamePattern || listVariant.fileNamePattern || '').trim();
                if (fileKind === 'HtmlPage') {
                    fileNamePattern = fileNamePattern.replace(/\{SubType\}/gu, '{subType}');
                }
                if (fileNamePattern && !/\{SubType\}|\{subType\}/u.test(fileNamePattern)) {
                    if (fileKind === 'Action') {
                        fileNamePattern = fileNamePattern.replace(/(List|Add|Edit|Detail|Workflow|WorkFlow|MyList)(Action\.java)$/u, '{SubType}$2');
                    } else if (fileKind === 'HtmlPage') {
                        fileNamePattern = fileNamePattern
                            .replace(/(list|add|edit|workflowdetail|workflow|mylist|detail)(\.html?)$/iu, '{subType}$2')
                            .replace(/(\{(?:pageName|pagename|PageName)\})(\.html?)$/u, '$1{subType}$2');
                    }
                }
                const fileName = renderFileName(fileNamePattern, sub);
                if (!fileName) return null;
                return {
                    fileKind,
                    subType: sub,
                    operation: 'create',
                    relativeDir: dir,
                    fileName,
                    resolvedPath: this._joinPosix(dir, fileName)
                };
            })
            .filter(Boolean);
    }

    _mergeFileSets(...sets) {
        const out = [];
        const seen = new Set();
        for (const set of sets) {
            for (const file of (Array.isArray(set) ? set : [])) {
                const key = `${String(file && file.fileKind || '')}:${String(file && file.resolvedPath || '')}`;
                if (!key || seen.has(key)) continue;
                seen.add(key);
                out.push(file);
            }
        }
        return out;
    }

    _existingAdjustmentProjection(story = {}) {
        const existing = story && story.existingAdjustment && typeof story.existingAdjustment === 'object' && !Array.isArray(story.existingAdjustment)
            ? story.existingAdjustment
            : {};
        const entryFiles = this._normalizeExistingAdjustmentEntryFiles(existing.entryFiles);
        const preserveBehaviors = this._normalizeExistingAdjustmentPreserveBehaviors(existing.preserveBehaviors);
        const existingAdjustment = {};
        if (entryFiles.length > 0) existingAdjustment.entryFiles = entryFiles;
        if (preserveBehaviors.length > 0) existingAdjustment.preserveBehaviors = preserveBehaviors;
        return Object.keys(existingAdjustment).length > 0 ? { existingAdjustment } : {};
    }

    _workflowIntentProjection(story = {}) {
        const workflowContract = this._normalizeWorkflowContract(story && story.workflowIntent);
        return workflowContract ? { workflowIntent: workflowContract } : {};
    }

    _collectCodingFactHandoff(stories = []) {
        const out = [];
        const seen = new Set();
        for (const story of (Array.isArray(stories) ? stories : [])) {
            const storyId = String(story && story.storyId || '').trim().toUpperCase();
            const items = Array.isArray(story && story.codingFactHandoff) ? story.codingFactHandoff : [];
            for (const item of items) {
                const normalized = this._normalizeCodingFactHandoffItem(item);
                if (!normalized) continue;
                const key = `${storyId}::${normalized.factId || ''}::${normalized.description || ''}`;
                if (seen.has(key)) continue;
                seen.add(key);
                out.push({
                    ...(storyId ? { sourceStoryId: storyId } : {}),
                    ...normalized
                });
            }
        }
        return out;
    }

    _codingFactHandoffProjection(story = {}) {
        const raw = Array.isArray(story && story.codingFactHandoff) ? story.codingFactHandoff : [];
        const out = raw
            .map(item => this._normalizeCodingFactHandoffItem(item))
            .filter(Boolean);
        return out.length > 0 ? { codingFactHandoff: out } : {};
    }

    _normalizeCodingFactHandoffItem(item = {}) {
        if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
        const out = {};
        ['factId', 'factType', 'description'].forEach(key => {
            const value = String(item && item[key] || '').trim();
            if (value) out[key] = value;
        });
        ['confirmedFacts'].forEach(key => {
            const values = Array.isArray(item && item[key])
                ? item[key].map(value => String(value || '').trim()).filter(Boolean)
                : [];
            if (values.length > 0) out[key] = Array.from(new Set(values));
        });
        return Object.keys(out).length > 0 ? out : null;
    }

    _normalizeExistingAdjustmentEntryFiles(entryFiles = []) {
        const allowed = new Set(['HtmlPage', 'Action']);
        const out = [];
        const seen = new Set();
        for (const entry of (Array.isArray(entryFiles) ? entryFiles : [])) {
            const fileKind = String(entry && entry.fileKind || '').trim();
            const entryPath = String(entry && (entry.path || entry.resolvedPath || entry.filePath) || '').trim();
            if (!allowed.has(fileKind) || !entryPath) continue;
            const key = `${fileKind}::${entryPath}`;
            if (seen.has(key)) continue;
            seen.add(key);
            out.push({
                fileKind,
                path: entryPath,
                source: String(entry && entry.source || 'stories.existingAdjustment.entryFiles').trim() || 'stories.existingAdjustment.entryFiles',
                verificationStatus: String(entry && entry.verificationStatus || 'pending').trim() || 'pending'
            });
        }
        return out;
    }

    _normalizeExistingAdjustmentPreserveBehaviors(preserveBehaviors = []) {
        const out = [];
        const seen = new Set();
        for (const item of (Array.isArray(preserveBehaviors) ? preserveBehaviors : [])) {
            if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
            const businessResult = String(item.businessResult || '').trim();
            const regressionScope = String(item.regressionScope || '').trim();
            if (!businessResult) continue;
            const key = `${businessResult}::${regressionScope}`;
            if (seen.has(key)) continue;
            seen.add(key);
            out.push({
                businessResult,
                ...(regressionScope ? { regressionScope } : {})
            });
        }
        return out;
    }

    /**
     * 12 件套 fileSet 派生：从 navigation contract placement rules + entity 业务命名渲染 resolvedPath。
     *   - Entity / ServiceApi / ServiceInternal / ServiceImpl 各 1
     *   - Action 4（list/add/edit/detail，按 placement.variants 派生 fileNamePattern）
     *   - HtmlPage 4（list/add/edit/detail，按 placement.variants 派生 fileNamePattern）
     *
     * 路径 resolvedPath 含 {domain}/{bizModule} 占位符渲染；entity 名段（{EntityName}/{pagename}）
     * 由下游 plan-service 进一步渲染（保持向后兼容现有 plan 解析逻辑）。
     */
    _buildEntityFileSet(entityCtx = {}, placementRules = {}) {
        const fileSet = [];
        const { entityName, bizModule, domain } = entityCtx;
        const renderRelativeDir = (pattern) => {
            return String(pattern || '')
                .replace(/\{domain\}/g, String(domain || '').toLowerCase())
                .replace(/\{bizModule\}/g, String(bizModule || '').toLowerCase());
        };
        const renderFileName = (pattern, subType) => {
            const subTypePascal = subType
                ? subType.charAt(0).toUpperCase() + subType.slice(1).toLowerCase()
                : '';
            return String(pattern || '')
                .replace(/\{EntityName\}/g, String(entityName || ''))
                .replace(/\{pagename\}/g, String(bizModule || '').toLowerCase())
                .replace(/\{SubType\}/g, subTypePascal);
        };
        const pushSingle = (fileKind) => {
            const rule = placementRules[fileKind];
            if (!rule) return;
            const dir = renderRelativeDir(rule.relativeDirPattern);
            const fileName = renderFileName(rule.fileNamePattern, '');
            if (!dir || !fileName) return;
            fileSet.push({
                fileKind,
                operation: 'create',
                relativeDir: dir,
                fileName,
                resolvedPath: this._joinPosix(dir, fileName)
            });
        };
        const pushQuad = (fileKind) => {
            const rule = placementRules[fileKind];
            if (!rule) return;
            const SUB_TYPES = ['list', 'add', 'edit', 'detail'];
            const variants = (rule.variants && typeof rule.variants === 'object') ? rule.variants : {};
            SUB_TYPES.forEach(subType => {
                const variant = variants[subType] || {};
                const fileNamePattern = String(variant.fileNamePattern || rule.fileNamePattern || '').trim();
                const dir = renderRelativeDir(rule.relativeDirPattern);
                const fileName = renderFileName(fileNamePattern, subType);
                if (!dir || !fileName) return;
                fileSet.push({
                    fileKind,
                    subType,
                    operation: 'create',
                    relativeDir: dir,
                    fileName,
                    resolvedPath: this._joinPosix(dir, fileName)
                });
            });
        };

        // Epoint 公司硬约定：新建实体一律生成完整 12 件套
        pushSingle('Entity');
        pushSingle('ServiceApi');
        pushSingle('ServiceInternal');
        pushSingle('ServiceImpl');
        pushQuad('Action');
        pushQuad('HtmlPage');
        return fileSet;
    }

    _buildBackendCarrierFileSet(entityCtx = {}, placementRules = {}) {
        const fileSet = [];
        const { entityName, bizModule, domain } = entityCtx;
        const renderRelativeDir = (pattern) => {
            return String(pattern || '')
                .replace(/\{domain\}/g, String(domain || '').toLowerCase())
                .replace(/\{bizModule\}/g, String(bizModule || '').toLowerCase());
        };
        const renderFileName = (pattern) => {
            return String(pattern || '')
                .replace(/\{EntityName\}/g, String(entityName || ''))
                .replace(/\{pagename\}/g, String(bizModule || '').toLowerCase())
                .replace(/\{SubType\}/g, '');
        };
        const pushSingle = (fileKind) => {
            const rule = placementRules[fileKind];
            if (!rule) return;
            const dir = renderRelativeDir(rule.relativeDirPattern);
            const fileName = renderFileName(rule.fileNamePattern);
            if (!dir || !fileName) return;
            fileSet.push({
                fileKind,
                operation: 'create',
                relativeDir: dir,
                fileName,
                resolvedPath: this._joinPosix(dir, fileName)
            });
        };
        pushSingle('Entity');
        pushSingle('ServiceApi');
        pushSingle('ServiceInternal');
        pushSingle('ServiceImpl');
        return fileSet;
    }

    _buildQueryEntryFileSet(entityCtx = {}, placementRules = {}) {
        const fileSet = [];
        const { entityName, bizModule, domain } = entityCtx;
        const interactionCarrier = entityCtx.interactionCarrier && typeof entityCtx.interactionCarrier === 'object' && !Array.isArray(entityCtx.interactionCarrier)
            ? entityCtx.interactionCarrier
            : null;
        const targetPageRole = String(interactionCarrier && interactionCarrier.targetPageRole || 'list').trim() || 'list';
        const renderRelativeDir = (pattern) => {
            return String(pattern || '')
                .replace(/\{domain\}/g, String(domain || '').toLowerCase())
                .replace(/\{bizModule\}/g, String(bizModule || '').toLowerCase());
        };
        const renderFileName = (pattern, subType) => {
            const subTypePascal = subType
                ? subType.charAt(0).toUpperCase() + subType.slice(1).toLowerCase()
                : '';
            return String(pattern || '')
                .replace(/\{EntityName\}/g, String(entityName || ''))
                .replace(/\{pagename\}/g, String(bizModule || '').toLowerCase())
                .replace(/\{SubType\}/g, subTypePascal);
        };
        const pushList = (fileKind) => {
            const rule = placementRules[fileKind];
            if (!rule) return;
            const variant = rule.variants && rule.variants.list ? rule.variants.list : {};
            const fileNamePattern = String(variant.fileNamePattern || rule.fileNamePattern || '').trim();
            const dir = renderRelativeDir(rule.relativeDirPattern);
            const fileName = renderFileName(fileNamePattern, 'list');
            if (!dir || !fileName) return;
            fileSet.push({
                fileKind,
                subType: 'list',
                operation: 'create',
                relativeDir: dir,
                fileName,
                resolvedPath: this._joinPosix(dir, fileName),
                queryOnly: true,
                ...(targetPageRole ? { targetPageRole } : {}),
                ...(interactionCarrier ? { interactionCarrier } : {})
            });
        };
        pushList('Action');
        pushList('HtmlPage');
        return fileSet;
    }

    _renderPlacementRelativeDir(pattern = '', entityCtx = {}) {
        return String(pattern || '')
            .replace(/\{domain\}/g, String(entityCtx.domain || '').toLowerCase())
            .replace(/\{bizModule\}/g, String(entityCtx.bizModule || '').toLowerCase());
    }

    _renderPlacementFileName(pattern = '', entityCtx = {}, subType = '') {
        const subTypePascal = this._subTypePascal(subType);
        const entityName = String(entityCtx.entityName || '');
        const featureName = String(entityCtx.featureName || entityName);
        const operationName = String(entityCtx.operationName || featureName || entityName);
        const pageName = String(entityCtx.bizModule || '').toLowerCase();
        return String(pattern || '')
            .replace(/\{EntityName\}/g, entityName)
            .replace(/\{FeatureName\}/g, featureName)
            .replace(/\{OperationName\}/g, operationName)
            .replace(/\{pagename\}/g, pageName)
            .replace(/\{SubType\}/g, subTypePascal)
            .replace(/\{subType\}/g, String(subType || '').toLowerCase());
    }

    _subTypePascal(subType = '') {
        const sub = String(subType || '').trim().toLowerCase();
        if (!sub) return '';
        if (sub === 'mylist') return 'MyList';
        if (sub === 'workflow') return 'WorkFlow';
        if (sub === 'workflowdetail') return 'WorkflowDetail';
        return sub.charAt(0).toUpperCase() + sub.slice(1).toLowerCase();
    }

    _buildSinglePlacementFileSet(fileKind = '', entityCtx = {}, placementRules = {}) {
        const rule = placementRules[fileKind];
        if (!rule) return [];
        const dir = this._renderPlacementRelativeDir(rule.relativeDirPattern, entityCtx);
        const fileName = this._renderPlacementFileName(rule.fileNamePattern, entityCtx);
        if (!dir || !fileName) return [];
        return [{
            fileKind,
            operation: 'create',
            relativeDir: dir,
            fileName,
            resolvedPath: this._joinPosix(dir, fileName)
        }];
    }

    _buildRestFileSet(entityCtx = {}, placementRules = {}) {
        return this._buildSinglePlacementFileSet('Rest', entityCtx, placementRules);
    }

    _buildJobFileSet(entityCtx = {}, placementRules = {}) {
        return this._buildSinglePlacementFileSet('Job', entityCtx, placementRules);
    }

    /**
     * acceptanceCriteria 顶层 index：按 entityKey 分组，把 entity.relatedStoryIds[] 关联的
     * 所有 stories.json[].acceptanceCriteria.{happyPath/exception/boundary} flat 进去。
     */
    _buildAcceptanceCriteriaIndex(businessEntities = [], storiesById = new Map()) {
        const result = {};
        businessEntities.forEach(entity => {
            const entityKey = entity.entityKey;
            const flat = { happyPath: [], exception: [], boundary: [] };
            (entity.relatedStoryIds || []).forEach(sid => {
                const story = storiesById.get(sid);
                if (!story || !story.acceptanceCriteria) return;
                const ac = this._normalizeAcceptanceCriteria(story.acceptanceCriteria);
                ['happyPath', 'exception', 'boundary'].forEach(group => {
                    (ac[group] || []).forEach(gwt => {
                        flat[group].push({ ...gwt, sourceStoryId: sid });
                    });
                });
            });
            result[entityKey] = flat;
        });
        return result;
    }

    _normalizeLinkedTable(linkedTable = {}, entityGraph = null, confirmedTableCandidates = []) {
        const kind = String(linkedTable.kind || '').trim().toLowerCase();
        if (kind === 'new') {
            return {
                kind: 'new',
                tableComment: String(linkedTable.tableComment || '').trim(),
                tableFeatureName: this._normalizeTableFeatureName(linkedTable.tableFeatureName),
                businessColumns: Array.isArray(linkedTable.businessColumns) ? linkedTable.businessColumns : [],
                ...(Array.isArray(linkedTable.constraints) ? { constraints: linkedTable.constraints } : {}),
                ...(linkedTable.needsPage === true ? { needsPage: true } : {})
            };
        }
        if (kind === 'reuse') {
            const tableName = String(linkedTable.tableName || '').trim();
            const confirmedCandidate = this._lookupConfirmedTableCandidate(tableName, confirmedTableCandidates);
            // Builder 自动从 entity-graph 反查复用 entity 的 sourceFile，给 Coder 提供物理路径
            const reuseLookup = this._lookupReuseEntityFromGraph(tableName, entityGraph);
            const reusedApis = this._normalizeStringArray(linkedTable.reusedApis);
            const candidateApis = this._normalizeStringArray(confirmedCandidate.reusedApis);
            const columns = Array.isArray(reuseLookup.columns) ? reuseLookup.columns : [];
            return {
                kind: 'reuse',
                tableName,
                tableComment: String(linkedTable.tableComment || '').trim()
                    || String(reuseLookup.tableDisplayName || '').trim()
                    || String(confirmedCandidate.tableDisplayName || '').trim(),
                reusedApis: reusedApis.length > 0 ? reusedApis : candidateApis,
                ...(linkedTable.needsPage === true ? { needsPage: true } : {}),
                ...(reuseLookup.sourceFile ? { reuseSourceFile: reuseLookup.sourceFile } : {}),
                ...(reuseLookup.dirHints && reuseLookup.dirHints.length > 0 ? { reuseDirHints: reuseLookup.dirHints } : {}),
                ...(columns.length > 0 ? { columns } : {}),
                ...(reuseLookup.primaryKey ? { primaryKey: reuseLookup.primaryKey } : {}),
                ...(Array.isArray(linkedTable.appendFields) ? { appendFields: linkedTable.appendFields } : {})
            };
        }
        if (kind === 'none') {
            return {
                kind: 'none',
                ...(linkedTable.needsPage === true ? { needsPage: true } : {})
            };
        }
        return { kind };
    }

    /**
     * 从 entity-graph.json 反查复用表的 entity sourceFile 及推导 Service 目录提示。
     *
     * 逻辑：
     *   1) 在 entity-graph.nodes[] 里按 tableName（大小写不敏感）找到匹配 entity
     *   2) 取 sourceFile（Entity 类绝对路径）
     *   3) 反推 ServiceApi 目录（api/）和 ServiceImpl 目录（impl/）—— Epoint 工程惯例：
     *      api/entity/Xxx.java → 同模块 api/IXxxService.java + impl/XxxService.java
     */
    _lookupReuseEntityFromGraph(tableName, entityGraph) {
        if (!tableName || !entityGraph || typeof entityGraph !== 'object') {
            return { sourceFile: '', dirHints: [], tableDisplayName: '', columns: [], primaryKey: '' };
        }
        const graph = entityGraph.entityGraph || entityGraph;
        const nodes = Array.isArray(graph && graph.nodes) ? graph.nodes : [];
        const target = tableName.toLowerCase();
        const node = nodes.find(n => n && String(n.tableName || '').toLowerCase() === target);
        if (!node) return { sourceFile: '', dirHints: [], tableDisplayName: '', columns: [], primaryKey: '' };
        const sourceFile = String(node.sourceFile || '').replace(/\\/g, '/');
        const dirHints = [];
        // 反推同模块 api/ 和 impl/ 目录（Epoint 工程惯例）
        const apiEntityIdx = sourceFile.indexOf('/api/entity/');
        if (apiEntityIdx >= 0) {
            const apiBase = sourceFile.slice(0, apiEntityIdx + '/api/'.length);
            const implBase = apiBase.replace(/\/api\/$/, '/impl/');
            dirHints.push(apiBase);
            dirHints.push(implBase);
        }
        const columns = this._normalizeReuseColumnsFromEntityNode(node);
        return {
            sourceFile,
            dirHints,
            tableDisplayName: String(node.tableDisplayName || node.summary || '').trim(),
            columns,
            primaryKey: this._pickPrimaryKey(columns)
        };
    }

    /**
     * databaseDesign 派生：从 businessEntities[].linkedTable 聚合（new + reuse）
     * @param {Array}     businessEntities 已派生的 entity 列表
     * @param {object}    databaseNamingContract 表命名契约
     * @param {Map<string,string>} entityKeyToModuleId entityKey → moduleId 映射，
     *   下游 plan-service / skeleton-service 按 tables[].relatedModuleIds 反查表（必填）。
     */
    _buildDatabaseDesignFromEntities(businessEntities = [], databaseNamingContract = {}, entityKeyToModuleId = new Map()) {
        const tables = [];
        const constraints = [];
        const tableNamePattern = String(databaseNamingContract && databaseNamingContract.tableNamePattern || '').trim();
        const expectedPrefix = String(databaseNamingContract && databaseNamingContract.expectedPrefix || '').trim();

        businessEntities.forEach(entity => {
            const linkedTable = entity.linkedTable || {};
            const entityKey = entity.entityKey;
            const moduleId = entityKeyToModuleId.get(entityKey);
            // moduleId 必须能从映射拿到——entity 与 module 是 1:1 投影，没拿到说明上游漏建。
            // 不做兜底（fallback 字符串如 entityKey 会让下游 plan/skeleton 永远匹配不到）。
            const relatedModuleIds = moduleId ? [moduleId] : [];
            const carriedConsumerModuleIds = businessEntities
                .filter(candidate => String(candidate && candidate.carriedByEntityKey || '').trim() === entityKey)
                .map(candidate => entityKeyToModuleId.get(candidate.entityKey))
                .filter(Boolean);
            if (linkedTable.kind === 'reuse') {
                const tableName = String(linkedTable.tableName || '').trim();
                if (!tableName) return;
                const columns = Array.isArray(linkedTable.columns) ? linkedTable.columns : [];
                const normalizedTableName = tableName.toUpperCase();
                const existing = tables.find(table => table.reuse === true && String(table.tableName || '').trim().toUpperCase() === normalizedTableName);
                const reuseTable = existing || {
                    objectKey: entityKey,
                    tableName,
                    tableComment: String(linkedTable.tableComment || '').trim(),
                    reuse: true,
                    reusedApis: [],
                    appendFields: [],
                    relatedModuleIds: []
                };
                if (!reuseTable.tableComment && String(linkedTable.tableComment || '').trim()) {
                    reuseTable.tableComment = String(linkedTable.tableComment || '').trim();
                }
                reuseTable.reusedApis = this._mergeUniqueStringArrays(reuseTable.reusedApis, linkedTable.reusedApis);
                reuseTable.relatedModuleIds = this._mergeUniqueStringArrays(reuseTable.relatedModuleIds, relatedModuleIds);
                reuseTable.appendFields = this._mergeUniqueObjectsByJson(reuseTable.appendFields, linkedTable.appendFields);
                if (!reuseTable.reuseSourceFile && linkedTable.reuseSourceFile) {
                    reuseTable.reuseSourceFile = linkedTable.reuseSourceFile;
                }
                reuseTable.reuseDirHints = this._mergeUniqueStringArrays(reuseTable.reuseDirHints, linkedTable.reuseDirHints);
                if ((!Array.isArray(reuseTable.columns) || reuseTable.columns.length === 0) && columns.length > 0) {
                    reuseTable.columns = columns;
                }
                if (!reuseTable.primaryKey && linkedTable.primaryKey) {
                    reuseTable.primaryKey = linkedTable.primaryKey;
                }
                if (!existing) {
                    tables.push(reuseTable);
                }
                return;
            }
            if (linkedTable.kind === 'new') {
                const businessColumns = Array.isArray(linkedTable.businessColumns) ? linkedTable.businessColumns : [];
                // 兼容 _renderTableName 旧签名（按 entity.bizModule 当 moduleAbbr）
                const renderedTableName = this._renderTableNameForEntity(
                    tableNamePattern,
                    expectedPrefix,
                    linkedTable,
                    databaseNamingContract.moduleAbbr
                );
                const tableName = renderedTableName || String(linkedTable.tableName || '').trim();
                const allColumns = this._mergeWithCommonColumns(businessColumns);
                tables.push({
                    objectKey: entityKey,
                    tableName,
                    tableComment: String(linkedTable.tableComment || '').trim(),
                    reuse: false,
                    reusedApis: [],
                    appendFields: [],
                    columns: allColumns,
                    primaryKey: 'rowguid',
                    relatedModuleIds: this._mergeUniqueStringArrays(relatedModuleIds, carriedConsumerModuleIds)
                });
                if (Array.isArray(linkedTable.constraints)) {
                    linkedTable.constraints.forEach(c => {
                        if (c && typeof c === 'object' && c.name && c.description) constraints.push(c);
                    });
                }
            }
        });

        const required = tables.length > 0;
        const createStatements = tables
            .filter(t => t.reuse !== true && Array.isArray(t.columns) && t.columns.length > 0)
            .map(t => this._renderCreateStatement(t));

        return {
            required,
            status: required ? 'ready' : 'not_needed',
            tables,
            constraints,
            createStatements
        };
    }

    // ─── helpers ──────────────────────────────────────────────────────────────

    _toPathSegment(value = '') {
        // 业务 slug → Java 包路径段 / HTML 文件名段：去下划线、连字符，纯小写字母数字。
        // place_window → placewindow。与 domain 的 ^[a-z][a-z0-9]*$ 约束对称。
        return String(value || '').trim().toLowerCase().replace(/[_\-]/g, '');
    }

    _normalizeEntityNamingSource(value = '', constructionSceneKey = '') {
        const scene = String(constructionSceneKey || '').trim().toLowerCase();
        const source = String(value || '').trim()
            .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
            .replace(/[\s\-]+/g, '_')
            .toLowerCase()
            .replace(/[^a-z0-9_]+/g, '_')
            .replace(/_+/g, '_')
            .replace(/^_+|_+$/g, '');
        if (!source) return '';
        let parts = source.split('_').filter(Boolean);
        parts = this._stripKnownBusinessPrefixes(parts);
        parts = this._stripSceneNamePollution(parts, scene);
        if (parts.length === 0) {
            parts = source.split('_').filter(Boolean);
            parts = this._stripKnownBusinessPrefixes(parts);
        }
        if (parts.length === 0) return source;
        return parts.join('_');
    }

    _normalizeTableFeatureName(value = '') {
        const source = String(value || '').trim()
            .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
            .replace(/[\s\-]+/g, '_')
            .toLowerCase()
            .replace(/[^a-z0-9_]+/g, '_')
            .replace(/_+/g, '_')
            .replace(/^_+|_+$/g, '');
        if (!source) return '';
        const parts = this._stripKnownBusinessPrefixes(source.split('_').filter(Boolean));
        return parts.join('_') || source;
    }

    _stripKnownBusinessPrefixes(parts = []) {
        const out = [...(Array.isArray(parts) ? parts : [])];
        // 项目模板通常统一加 Gxh 等前缀；业务 slug/tableFeatureName 再带 gxh 会变成 GxhGxh...
        while (out.length > 1 && /^(gxh|qh|zwfw|wzm|xm)$/u.test(out[0])) {
            out.shift();
        }
        return out;
    }

    _stripSceneNamePollution(parts = [], scene = '') {
        const out = [...(Array.isArray(parts) ? parts : [])];
        const removeTail = tail => {
            if (tail.length === 0 || out.length <= tail.length) return false;
            const actual = out.slice(out.length - tail.length).join('_');
            if (actual !== tail.join('_')) return false;
            out.splice(out.length - tail.length, tail.length);
            return true;
        };
        const tails = [
            ...(scene === 'query_result_entry' ? [
                ['query', 'result', 'entry'],
                ['result', 'entry'],
                ['query', 'entry'],
                ['list', 'entry'],
                ['list'],
                ['detail', 'entry'],
                ['detail']
            ] : []),
            ...(scene === 'statistics_analysis' ? [
                ['statistics', 'analysis'],
                ['stat', 'analysis'],
                ['summary', 'analysis']
            ] : []),
            ...(scene === 'rest_interface' ? [
                ['rest']
            ] : []),
            ['entry'],
            ['page']
        ];
        let changed = true;
        while (changed) {
            changed = tails.some(removeTail);
        }
        return out;
    }

    _toPascalCase(value = '') {
        return String(value || '')
            .split(/[\s_\-]+/)
            .filter(Boolean)
            .map(seg => seg.charAt(0).toUpperCase() + seg.slice(1).toLowerCase())
            .join('');
    }

    _stripTablePrefixForFeature(tableName = '') {
        // 复用表的 entityName 派生：剥离常见项目前缀，留下功能段作 PascalCase 源
        const text = String(tableName || '').trim();
        if (!text) return '';
        return text
            .replace(/^[a-z]{1,8}_/i, '')
            .replace(/_+$/, '')
            .trim();
    }

    _joinPosix(dir, fileName) {
        const left = String(dir || '').replace(/\\/g, '/').replace(/\/+$/, '');
        const right = String(fileName || '').replace(/\\/g, '/').replace(/^\/+/, '');
        return left ? `${left}/${right}` : right;
    }

    _normalizeAcceptanceCriteria(ac = {}) {
        const result = { happyPath: [], exception: [], boundary: [] };
        if (!ac || typeof ac !== 'object' || Array.isArray(ac)) return result;
        ['happyPath', 'exception', 'boundary'].forEach(group => {
            const arr = Array.isArray(ac[group]) ? ac[group] : [];
            result[group] = arr.map((item, i) => {
                if (typeof item === 'string') {
                    return { scenario: `${group}-${i + 1}`, given: item, when: '', then: '' };
                }
                return {
                    scenario: String(item && item.scenario || `${group}-${i + 1}`).trim(),
                    given: String(item && item.given || '').trim(),
                    when: String(item && item.when || '').trim(),
                    then: String(item && item.then || '').trim()
                };
            });
        });
        return result;
    }

    _renderTableNameForEntity(pattern = '', expectedPrefix = '', linkedTable = {}, projectModuleAbbr = '') {
        // contract-first：有契约 pattern/prefix 就强制按契约渲染表名
        if (!pattern && !expectedPrefix) return '';
        const moduleAbbr = String(projectModuleAbbr || '').trim().toLowerCase();
        let tableFeatureName = String(linkedTable.tableFeatureName || '').trim();
        if (!tableFeatureName) {
            const llmTableName = String(linkedTable.tableName || '').trim();
            if (llmTableName) {
                const stripped = llmTableName
                    .replace(/^[a-z]{1,8}_/i, '')
                    .replace(new RegExp(`^${moduleAbbr}_`, 'i'), '')
                    .replace(/_+$/, '')
                    .trim();
                if (stripped) tableFeatureName = stripped;
            }
        }
        if (!tableFeatureName) tableFeatureName = 'main';
        if (moduleAbbr) {
            tableFeatureName = tableFeatureName.replace(new RegExp(`^${moduleAbbr}_`, 'i'), '') || tableFeatureName;
        }
        if (pattern) {
            return pattern
                .replace('{moduleAbbr}', moduleAbbr || 'mod')
                .replace('{tableFeatureName}', tableFeatureName);
        }
        return `${expectedPrefix}${moduleAbbr || 'mod'}_${tableFeatureName}`;
    }

    _mergeWithCommonColumns(businessColumns = []) {
        const COMMON_COLUMNS = [
            { name: 'rowguid', type: 'VARCHAR', length: 50, required: true, comment: '主键' },
            { name: 'row_id', type: 'INT', required: false, comment: '序号' },
            { name: 'operatedate', type: 'DATETIME', required: false, comment: '操作日期' },
            { name: 'operateusername', type: 'VARCHAR', length: 50, required: false, comment: '操作人姓名' },
            { name: 'operateuserguid', type: 'VARCHAR', length: 50, required: false, comment: '操作人Guid' },
            { name: 'operateuserouguid', type: 'VARCHAR', length: 50, required: false, comment: '操作人所在部门Guid' },
            { name: 'operateuserbaseouguid', type: 'VARCHAR', length: 50, required: false, comment: '操作人所在独立部门Guid' },
            { name: 'yearflag', type: 'VARCHAR', length: 4, required: false, comment: '年份标识' },
            { name: 'belongxiaqucode', type: 'VARCHAR', length: 50, required: false, comment: '所属辖区编号' },
            { name: 'pviguid', type: 'VARCHAR', length: 50, required: false, comment: '工作流标识' }
        ];
        const businessColNames = new Set(businessColumns.map(c => String(c && c.name || '').trim().toLowerCase()).filter(Boolean));
        const filteredCommon = COMMON_COLUMNS.filter(c => !businessColNames.has(c.name));
        const rowguid = filteredCommon.find(c => c.name === 'rowguid');
        const otherCommon = filteredCommon.filter(c => c.name !== 'rowguid');
        const result = [];
        if (rowguid) result.push(rowguid);
        businessColumns.forEach(c => {
            if (!c || typeof c !== 'object') return;
            const columnName = String(c.name || '').trim();
            const column = {
                name: columnName,
                type: String(c.type || 'VARCHAR').trim(),
                ...(c.length !== undefined ? { length: Number(c.length) } : {}),
                required: columnName.toLowerCase() === 'rowguid',
                formRequired: c.required === true,
                comment: String(c.comment || '').trim()
            };
            if (String(c.relationRef || '').trim()) {
                column.relationRef = String(c.relationRef).trim();
            }
            if (Object.prototype.hasOwnProperty.call(c, 'codeItem') && typeof c.codeItem === 'string') {
                const codeItem = c.codeItem.trim();
                if (codeItem) {
                    column.codeItem = codeItem;
                    if (c.codeItemDefinition && typeof c.codeItemDefinition === 'object') {
                        column.codeItemDefinition = JSON.parse(JSON.stringify(c.codeItemDefinition));
                    }
                }
            }
            if (c.attachmentKey === true) {
                column.attachmentKey = true;
                const attachmentLabel = String(c.attachmentLabel || c.comment || '').trim();
                if (attachmentLabel) column.attachmentLabel = attachmentLabel;
            }
            result.push(column);
        });
        result.push(...otherCommon);
        return result;
    }

    _renderCreateStatement(table = {}) {
        const lines = [];
        lines.push(`CREATE TABLE ${table.tableName} (`);
        const colLines = (Array.isArray(table.columns) ? table.columns : []).map(col => {
            const lengthPart = col.length ? `(${col.length})` : '';
            const nullable = col.required ? 'NOT NULL' : '';
            const comment = col.comment ? `COMMENT '${col.comment}'` : '';
            return `    ${col.name} ${col.type}${lengthPart}${nullable ? ' ' + nullable : ''}${comment ? ' ' + comment : ''}`.trim();
        });
        if (table.primaryKey) {
            colLines.push(`    PRIMARY KEY (${table.primaryKey})`);
        }
        lines.push(colLines.join(',\n'));
        lines.push(`) COMMENT='${table.tableComment || ''}';`);
        return lines.join('\n');
    }

    _extractDatabaseNamingContract(navigationContract = {}) {
        const candidates = [
            navigationContract && navigationContract.databaseNamingContract,
            navigationContract && navigationContract.rulePlacementContract && navigationContract.rulePlacementContract.databaseNamingContract,
            navigationContract && navigationContract.placementContractDraft && navigationContract.placementContractDraft.databaseNamingContract
        ];
        const contract = candidates.find(item => item && typeof item === 'object' && !Array.isArray(item)) || {};
        const tableNamePattern = String(contract.tableNamePattern || '').trim();
        const expectedPrefix = (() => {
            const text = tableNamePattern || String(contract.tablePrefix || '').trim();
            const idx = text.indexOf('{');
            return (idx >= 0 ? text.slice(0, idx) : text).trim();
        })();
        const explicitModuleAbbr = [
            contract.moduleAbbr,
            navigationContract && navigationContract.namingContext && navigationContract.namingContext.moduleAbbr,
            navigationContract && navigationContract.projectNamingContext && navigationContract.projectNamingContext.moduleAbbr
        ].map(value => String(value || '').trim().toLowerCase()).find(Boolean) || '';
        const inferredModuleAbbr = explicitModuleAbbr || this._inferProjectModuleAbbr(navigationContract);
        return { ...contract, tableNamePattern, expectedPrefix, moduleAbbr: inferredModuleAbbr };
    }

    _inferProjectModuleAbbr(navigationContract = {}) {
        const ruleSets = [
            navigationContract && navigationContract.rulePlacementContract && navigationContract.rulePlacementContract.rules,
            navigationContract && navigationContract.placementContractDraft && navigationContract.placementContractDraft.rules
        ];
        const candidates = new Map();
        for (const rules of ruleSets) {
            for (const rule of (Array.isArray(rules) ? rules : [])) {
                const pattern = String(rule && rule.fileNamePattern || '').trim();
                const match = pattern.match(/^([A-Za-z][A-Za-z0-9]*?)\{(?:EntityName|FeatureName|OperationName|pagename|pageName)\}/);
                if (!match) continue;
                let prefix = String(match[1] || '').replace(/^I(?=[A-Z])/u, '').toLowerCase();
                if (!prefix || prefix === 'i') continue;
                if (!candidates.has(prefix)) candidates.set(prefix, new Set());
                candidates.get(prefix).add(String(rule && rule.fileKind || '').trim() || pattern);
            }
        }
        const qualified = Array.from(candidates.entries())
            .filter(([, sources]) => sources.size >= 2)
            .map(([prefix]) => prefix);
        return qualified.length === 1 ? qualified[0] : '';
    }

    /**
     * 从 navigationContract.rulePlacementContract.rules[] 提取 fileKind → rule 映射，
     * 给 _buildEntityFileSet 消费。每条 rule 含 relativeDirPattern / fileNamePattern / variants。
     */
    _extractPlacementRules(navigationContract = {}) {
        const rules = navigationContract && navigationContract.rulePlacementContract
            && Array.isArray(navigationContract.rulePlacementContract.rules)
            ? navigationContract.rulePlacementContract.rules
            : [];
        const map = {};
        rules.forEach(rule => {
            const fileKind = String(rule && rule.fileKind || '').trim();
            if (!fileKind) return;
            map[fileKind] = rule;
        });
        return map;
    }

    _extractRuleAliasList(rules = []) {
        if (!Array.isArray(rules)) return [];
        return rules.map(rule => {
            if (typeof rule === 'string') return rule.trim();
            return String(rule && (rule.ruleAlias || rule.ruleName) || '').trim();
        }).filter(Boolean);
    }

    _extractConfirmedTableCandidates(candidates = []) {
        if (!Array.isArray(candidates)) return [];
        return candidates
            .map(candidate => ({
                tableName: String(candidate && candidate.tableName || '').trim(),
                entityName: String(candidate && candidate.entityName || '').trim(),
                tableDisplayName: String(candidate && (candidate.tableDisplayName || candidate.tableComment || candidate.role) || '').trim(),
                candidateRole: String(candidate && candidate.candidateRole || '').trim(),
                primaryOwnerStoryIds: this._normalizeStoryIdArray(candidate && candidate.primaryOwnerStoryIds),
                triggerStoryIds: this._normalizeStoryIdArray(candidate && candidate.triggerStoryIds),
                weakRelatedStoryIds: this._normalizeStoryIdArray(candidate && candidate.weakRelatedStoryIds),
                reusedApis: Array.isArray(candidate && candidate.reusedApis) ? candidate.reusedApis : []
            }))
            .filter(candidate => candidate.tableName);
    }

    _lookupConfirmedTableCandidate(tableName = '', candidates = []) {
        const normalized = String(tableName || '').trim().toUpperCase();
        if (!normalized || !Array.isArray(candidates)) return {};
        return candidates.find(candidate => String(candidate && candidate.tableName || '').trim().toUpperCase() === normalized) || {};
    }

    _normalizeStringArray(value = []) {
        return (Array.isArray(value) ? value : [])
            .map(item => String(item || '').trim())
            .filter(Boolean);
    }

    _mergeUniqueStringArrays(...arrays) {
        return Array.from(new Set(arrays
            .flatMap(value => Array.isArray(value) ? value : [])
            .map(item => String(item || '').trim())
            .filter(Boolean)));
    }

    _mergeUniqueObjectsByJson(...arrays) {
        const seen = new Set();
        const out = [];
        arrays
            .flatMap(value => Array.isArray(value) ? value : [])
            .filter(item => item && typeof item === 'object' && !Array.isArray(item))
            .forEach(item => {
                const key = JSON.stringify(item);
                if (seen.has(key)) return;
                seen.add(key);
                out.push(item);
            });
        return out;
    }

    _normalizeStoryIdArray(value = []) {
        return Array.from(new Set((Array.isArray(value) ? value : [])
            .map(item => String(item || '').trim().toUpperCase())
            .filter(Boolean)));
    }

    _normalizeDecisionEntityKeys(decision = {}) {
        const keys = [];
        const single = String(decision && decision.entityKey || '').trim();
        if (single) keys.push(single);
        if (Array.isArray(decision && decision.entityKeys)) {
            decision.entityKeys.forEach(item => {
                const key = String(item || '').trim();
                if (key) keys.push(key);
            });
        }
        return Array.from(new Set(keys));
    }

    _validateTableCandidateUsages(usages, decisionIndex, tableName, entityByKey = new Map(), knownStoryIds = new Set()) {
        const issues = [];
        if (usages === undefined) return issues;
        if (!Array.isArray(usages)) {
            issues.push({
                code: 'DESIGN_BUILDER_TABLE_CANDIDATE_USAGES_TYPE_INVALID',
                field: `tableCandidateFitDecisions[${decisionIndex}].usages`,
                tableName,
                message: 'tableCandidateFitDecisions[].usages 若出现必须是数组；用于说明同一候选表在不同 Story 中是写入副作用、查询入口、主数据承载或触发弱关联。'
            });
            return issues;
        }
        const allowedUsageTypes = new Set([
            'write_side_effect',
            'query_entry',
            'primary_data',
            'data_carrier',
            'trigger_only',
            'reference_only',
            'other'
        ]);
        usages.forEach((usage, usageIndex) => {
            const storyId = String(usage && usage.storyId || '').trim().toUpperCase();
            const usageType = String(usage && usage.usageType || '').trim();
            const entityKey = String(usage && usage.entityKey || '').trim();
            if (!storyId) {
                issues.push({
                    code: 'DESIGN_BUILDER_TABLE_CANDIDATE_USAGE_STORY_ID_MISSING',
                    field: `tableCandidateFitDecisions[${decisionIndex}].usages[${usageIndex}].storyId`,
                    tableName,
                    message: 'usages[].storyId 必填，用于说明该 Story 与候选表的关系。'
                });
            } else if (knownStoryIds.size > 0 && !knownStoryIds.has(storyId)) {
                issues.push({
                    code: 'DESIGN_BUILDER_TABLE_CANDIDATE_USAGE_STORY_ID_NOT_IN_ENTITY_JUDGMENTS',
                    field: `tableCandidateFitDecisions[${decisionIndex}].usages[${usageIndex}].storyId`,
                    tableName,
                    storyId,
                    message: `usages[].storyId="${storyId}" 未出现在 entityJudgments[].relatedStoryIds 中。`
                });
            }
            if (!allowedUsageTypes.has(usageType)) {
                issues.push({
                    code: 'DESIGN_BUILDER_TABLE_CANDIDATE_USAGE_TYPE_INVALID',
                    field: `tableCandidateFitDecisions[${decisionIndex}].usages[${usageIndex}].usageType`,
                    tableName,
                    usageType,
                    allowedValues: Array.from(allowedUsageTypes),
                    message: `usages[].usageType="${usageType}" 不在允许范围内；合法值：${Array.from(allowedUsageTypes).join(', ')}。`
                });
            }
            if (entityKey && !entityByKey.has(entityKey)) {
                issues.push({
                    code: 'DESIGN_BUILDER_TABLE_CANDIDATE_USAGE_ENTITY_NOT_FOUND',
                    field: `tableCandidateFitDecisions[${decisionIndex}].usages[${usageIndex}].entityKey`,
                    tableName,
                    entityKey,
                    message: `usages[].entityKey="${entityKey}" 未在 entityJudgments[] 中定义。`
                });
            }
        });
        return issues;
    }

    _buildDesignDecisionAudit(tableCandidateFitDecisions, confirmedTableCandidates = []) {
        if (!Array.isArray(tableCandidateFitDecisions) || tableCandidateFitDecisions.length === 0) return null;
        const normalizeTableName = value => String(value || '').trim().toUpperCase();
        const candidateByTable = new Map((confirmedTableCandidates || [])
            .map(candidate => [normalizeTableName(candidate.tableName), candidate])
            .filter(([tableName]) => tableName));
        const normalized = tableCandidateFitDecisions.map(decision => {
            const tableName = String(decision && decision.tableName || '').trim();
            const candidate = candidateByTable.get(normalizeTableName(tableName)) || {};
            const usages = Array.isArray(decision && decision.usages)
                ? decision.usages.map(usage => ({
                    storyId: String(usage && usage.storyId || '').trim().toUpperCase(),
                    usageType: String(usage && usage.usageType || '').trim(),
                    ...(String(usage && usage.entityKey || '').trim() ? { entityKey: String(usage.entityKey).trim() } : {}),
                    ...(String(usage && usage.reason || '').trim() ? { reason: String(usage.reason).trim() } : {})
                })).filter(usage => usage.storyId || usage.usageType || usage.entityKey)
                : [];
            return {
                tableName,
                decision: String(decision && decision.decision || '').trim(),
                entityKeys: this._normalizeDecisionEntityKeys(decision),
                coveredStoryIds: this._normalizeStoryIdArray(decision && decision.coveredStoryIds),
                weakRelatedStoryIds: this._normalizeStoryIdArray(decision && decision.weakRelatedStoryIds),
                nonCoveredStoryIds: this._normalizeStoryIdArray(decision && (decision.nonCoveredStoryIds || decision.rejectedStoryIds)),
                ...(usages.length > 0 ? { usages } : {}),
                fitReason: String(decision && decision.fitReason || '').trim(),
                candidateHints: {
                    candidateRole: String(candidate.candidateRole || '').trim(),
                    primaryOwnerStoryIds: this._normalizeStoryIdArray(candidate.primaryOwnerStoryIds),
                    triggerStoryIds: this._normalizeStoryIdArray(candidate.triggerStoryIds),
                    weakRelatedStoryIds: this._normalizeStoryIdArray(candidate.weakRelatedStoryIds)
                }
            };
        });
        return {
            tableCandidateFitDecisions: normalized
        };
    }

    _normalizeReuseColumnsFromEntityNode(node = {}) {
        const fields = Array.isArray(node && node.fields) ? node.fields : [];
        const columns = [];
        const seen = new Set();
        fields.forEach(field => {
            const name = String(field && (field.columnName || field.fieldName) || '').trim();
            if (!name) return;
            const key = name.toLowerCase();
            if (seen.has(key)) return;
            seen.add(key);
            const mapped = this._mapJavaTypeToColumn(field && field.javaType);
            const summary = String(field && field.summary || '').trim();
            columns.push({
                name,
                type: mapped.type,
                ...(mapped.length ? { length: mapped.length } : {}),
                required: key === 'rowguid',
                comment: summary && !/^=+$/.test(summary.replace(/\s/g, '')) ? summary : name
            });
        });
        return columns;
    }

    _mapJavaTypeToColumn(javaType = '') {
        const text = String(javaType || '').trim().toLowerCase();
        if (/^(long|bigint)$/.test(text)) return { type: 'BIGINT' };
        if (/^(int|integer|short)$/.test(text)) return { type: 'INT' };
        if (/^(double|float|bigdecimal|decimal)$/.test(text)) return { type: 'DECIMAL' };
        if (/^(date|localdate|localdatetime|timestamp)$/.test(text)) return { type: 'DATETIME' };
        if (/^(boolean|bool)$/.test(text)) return { type: 'BOOLEAN' };
        return { type: 'VARCHAR', length: 255 };
    }

    _pickPrimaryKey(columns = []) {
        const names = new Set((Array.isArray(columns) ? columns : [])
            .map(col => String(col && col.name || '').trim().toLowerCase())
            .filter(Boolean));
        if (names.has('rowguid')) return 'rowguid';
        if (names.has('id')) return 'id';
        return '';
    }
}

module.exports = DesignDocumentBuilderService;
