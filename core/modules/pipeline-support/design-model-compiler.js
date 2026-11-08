/* eslint-disable */
const crypto = require('crypto');
const {
    OBJECT_KEY_PATTERN,
    STORY_ID_PATTERN,
    TABLE_MODES,
    RELATION_KINDS,
    CAPABILITIES,
    CODE_ITEM_FACT_TYPES,
    PAGE_COMPOSITION_BLOCK_CONTRACT,
    parseDecisionRows,
    parseDetailRows,
    parseCompositionRows
} = require('./design-decision-step-definition');
const {
    sceneSupportsLinkedTableKind,
    getNeedsPageMode
} = require('./design-construction-scene-contract');

class DesignModelCompiler {
    compileModel({ decisionRows = [], requirementStories = {}, confirmedTableCandidates = [] } = {}) {
        const parsed = parseDecisionRows(decisionRows);
        if (!parsed.ok) return this._blocked('DESIGN_MODEL_DECISION_ROWS_INVALID', parsed.issues);
        const issues = [];
        const stories = this._stories(requirementStories);
        const storiesById = new Map(stories.map(story => [this._storyId(story), story]).filter(([id]) => id));
        const objectMap = new Map();
        const carrierMap = new Map();
        const routeMap = new Map();
        const candidateFacts = this._normalizeCandidateFacts(confirmedTableCandidates);
        const candidateSet = new Set(candidateFacts.map(item => item.tableName.toUpperCase()).filter(Boolean));
        const candidateByName = new Map();
        candidateFacts.forEach(candidate => {
            [candidate.tableName, candidate.entityName].map(name => String(name || '').trim().toUpperCase())
                .filter(Boolean)
                .forEach(name => {
                    if (!candidateByName.has(name)) candidateByName.set(name, candidate);
                });
        });
        const tableStoryMap = new Map();
        const statisticsSourceMap = new Map();
        const querySurfaceMap = new Map();

        parsed.tables.forEach(item => {
            if (!OBJECT_KEY_PATTERN.test(item.tableKey)) {
                issues.push(this._issue('DESIGN_MODEL_TABLE_KEY_INVALID', `decisionRows[${item.rowIndex}]`, `tableKey=${item.tableKey} 必须是小写 snake_case。`));
            }
            if (!item.displayName) {
                issues.push(this._issue('DESIGN_MODEL_TABLE_NAME_MISSING', `decisionRows[${item.rowIndex}]`, 'TABLE 中文业务表名不能为空。'));
            }
            if (!TABLE_MODES.includes(item.mode)) {
                issues.push(this._issue('DESIGN_MODEL_TABLE_MODE_INVALID', `decisionRows[${item.rowIndex}]`, `TABLE mode必须是${TABLE_MODES.join('/')}。`));
            }
            if (objectMap.has(item.tableKey)) {
                issues.push(this._issue('DESIGN_MODEL_TABLE_DUPLICATED', `decisionRows[${item.rowIndex}]`, `TABLE ${item.tableKey} 重复。`));
                return;
            }
            objectMap.set(item.tableKey, { objectKey: item.tableKey, displayName: item.displayName });
            const carrier = { objectKey: item.tableKey, mode: item.mode };
            if (item.mode === 'reuse') {
                const tableName = String(item.tableName || '').trim();
                if (!tableName || !candidateSet.has(tableName.toUpperCase())) {
                    issues.push(this._issue('DESIGN_MODEL_REUSE_TABLE_NOT_CONFIRMED', `decisionRows[${item.rowIndex}]`, `TABLE|reuse只能引用已确认候选表，当前=${tableName || '(empty)'}。`));
                }
                carrier.tableName = tableName;
            }
            carrierMap.set(item.tableKey, carrier);
        });

        const relationKeys = new Set();
        parsed.relations.forEach(item => {
            if (!objectMap.has(item.parentTableKey) || !objectMap.has(item.childTableKey)) {
                issues.push(this._issue('DESIGN_MODEL_RELATION_TABLE_NOT_FOUND', `decisionRows[${item.rowIndex}]`, `RELATION必须引用已声明TABLE：${item.parentTableKey} -> ${item.childTableKey}。`));
            }
            if (item.parentTableKey === item.childTableKey) {
                issues.push(this._issue('DESIGN_MODEL_RELATION_SELF_REFERENCE', `decisionRows[${item.rowIndex}]`, 'RELATION父子TABLE不能相同。'));
            }
            if (!RELATION_KINDS.includes(item.relationKind)) {
                issues.push(this._issue('DESIGN_MODEL_RELATION_KIND_INVALID', `decisionRows[${item.rowIndex}]`, `relationKind必须是${RELATION_KINDS.join('/')}。`));
            }
            if (!item.meaning) {
                issues.push(this._issue('DESIGN_MODEL_RELATION_MEANING_MISSING', `decisionRows[${item.rowIndex}]`, 'RELATION业务关系含义不能为空。'));
            }
            const key = item.relationKey;
            if (relationKeys.has(key)) {
                issues.push(this._issue('DESIGN_MODEL_RELATION_DUPLICATED', `decisionRows[${item.rowIndex}]`, `TABLE关系 ${item.parentTableKey} -> ${item.childTableKey}重复。`));
            }
            relationKeys.add(key);
        });
        const internalRelations = parsed.relations.map(item => ({
            ...item,
            parentObjectKey: item.parentTableKey,
            childObjectKey: item.childTableKey
        }));
        if (this._hasRelationCycle(internalRelations)) {
            issues.push(this._issue('DESIGN_MODEL_RELATION_CYCLE', 'decisionRows', '对象关系形成循环，无法机械确定父子外键。'));
        }

        parsed.tableStories.forEach(item => {
            if (!objectMap.has(item.tableKey)) {
                issues.push(this._issue(
                    'DESIGN_MODEL_TABLE_STORY_TABLE_NOT_FOUND',
                    `decisionRows[${item.rowIndex}]`,
                    `TABLE_STORY引用未声明TABLE ${item.tableKey}。`
                ));
            }
            if (!storiesById.has(item.storyId)) {
                issues.push(this._issue(
                    'DESIGN_MODEL_TABLE_STORY_STORY_NOT_FOUND',
                    `decisionRows[${item.rowIndex}]`,
                    `TABLE_STORY引用的Story ${item.storyId}不在Requirement中。`
                ));
            }
            if (tableStoryMap.has(item.tableKey)) {
                issues.push(this._issue(
                    'DESIGN_MODEL_TABLE_STORY_DUPLICATED',
                    `decisionRows[${item.rowIndex}]`,
                    `TABLE ${item.tableKey}只能绑定一个owner Story。`
                ));
                return;
            }
            tableStoryMap.set(item.tableKey, {
                tableKey: item.tableKey,
                storyId: item.storyId,
                rowIndex: item.rowIndex
            });
        });

        parsed.statisticsSources.forEach(item => {
            const story = storiesById.get(item.storyId);
            if (!story) {
                issues.push(this._issue(
                    'DESIGN_STATISTICS_SOURCE_STORY_NOT_FOUND',
                    `decisionRows[${item.rowIndex}]`,
                    `STATISTICS_SOURCE引用的Story ${item.storyId}不在Requirement中。`,
                    { storyId: item.storyId }
                ));
            } else if (!story.statisticsIntent || typeof story.statisticsIntent !== 'object' || Array.isArray(story.statisticsIntent)) {
                issues.push(this._issue(
                    'DESIGN_STATISTICS_SOURCE_STORY_NOT_STATISTICS',
                    `decisionRows[${item.rowIndex}]`,
                    `Story ${item.storyId}没有Requirement确认的statisticsIntent，不能声明统计来源。`,
                    { storyId: item.storyId, repairHint: '回Requirement补齐statisticsIntent，或删除STATISTICS_SOURCE行。' }
                ));
            }
            const candidate = candidateByName.get(String(item.tableName || '').trim().toUpperCase());
            if (!candidate) {
                issues.push(this._issue(
                    'DESIGN_STATISTICS_SOURCE_TABLE_NOT_CONFIRMED',
                    `decisionRows[${item.rowIndex}]`,
                    `STATISTICS_SOURCE引用的表 ${item.tableName || '(empty)'} 不在Requirement已确认候选表中。`,
                    {
                        storyId: item.storyId,
                        tableName: item.tableName,
                        allowedTableNames: Array.from(candidateSet),
                        repairHint: '只能复制结构卡 confirmedTableCandidates 中的 tableName；未知表先回Requirement完成候选确认。'
                    }
                ));
            }
            const tableName = String(candidate && candidate.tableName || item.tableName || '').trim();
            const key = `${item.storyId}::${tableName.toUpperCase()}`;
            if (statisticsSourceMap.has(key)) {
                issues.push(this._issue(
                    'DESIGN_STATISTICS_SOURCE_DUPLICATED',
                    `decisionRows[${item.rowIndex}]`,
                    `Story ${item.storyId}重复声明统计来源表 ${tableName}。`,
                    { storyId: item.storyId, tableName }
                ));
            } else {
                statisticsSourceMap.set(key, {
                    storyId: item.storyId,
                    tableName,
                    role: item.role,
                    sourceName: String(candidate && (candidate.tableDisplayName || candidate.entityName) || tableName).trim(),
                    candidateRole: String(candidate && candidate.candidateRole || '').trim(),
                    rowIndex: item.rowIndex
                });
            }
        });

        parsed.querySurfaces.forEach(item => {
            if (!storiesById.has(item.storyId)) {
                issues.push(this._issue(
                    'DESIGN_MODEL_QUERY_SURFACE_STORY_NOT_FOUND',
                    `decisionRows[${item.rowIndex}]`,
                    `QUERY_SURFACE引用的Story ${item.storyId}不在Requirement中。`
                ));
            }
            if (querySurfaceMap.has(item.storyId)) {
                issues.push(this._issue(
                    'DESIGN_MODEL_QUERY_SURFACE_DUPLICATED',
                    `decisionRows[${item.rowIndex}]`,
                    `Story ${item.storyId}只能声明一个独立查询页面。`
                ));
                return;
            }
            querySurfaceMap.set(item.storyId, {
                storyId: item.storyId,
                mode: item.mode,
                pageKey: item.pageKey,
                rowIndex: item.rowIndex
            });
        });

        parsed.stories.forEach(item => {
            if (!storiesById.has(item.storyId)) {
                issues.push(this._issue('DESIGN_MODEL_STORY_NOT_FOUND', `decisionRows[${item.rowIndex}]`, `STORY的storyId=${item.storyId}不在Requirement中。`));
            }
            if (routeMap.has(item.storyId)) {
                issues.push(this._issue('DESIGN_MODEL_STORY_DUPLICATED', `decisionRows[${item.rowIndex}]`, `Story ${item.storyId}只能声明一次。`));
            }
            if (!CAPABILITIES.includes(item.capability)) {
                issues.push(this._issue('DESIGN_MODEL_ROUTE_CAPABILITY_INVALID', `decisionRows[${item.rowIndex}]`, `capability必须是${CAPABILITIES.join('/')}。`));
            }
            let primaryObjectKey = item.tableKey;
            if (item.tableKey === '-') {
                primaryObjectKey = this._managedNoTableObjectKey(item.storyId, objectMap);
                objectMap.set(primaryObjectKey, { objectKey: primaryObjectKey, displayName: `${item.storyId}业务能力`, managedProjection: true });
                carrierMap.set(primaryObjectKey, { objectKey: primaryObjectKey, mode: 'none', managedProjection: true });
            } else if (!objectMap.has(item.tableKey)) {
                issues.push(this._issue('DESIGN_MODEL_STORY_TABLE_NOT_FOUND', `decisionRows[${item.rowIndex}]`, `STORY引用未声明TABLE ${item.tableKey}。`));
            }
            const story = storiesById.get(item.storyId) || {};
            const requirementProjection = this.projectRequirementObligations(story);
            const requirementSceneLock = requirementProjection.constructionSceneKey;
            const businessMechanisms = requirementProjection.businessMechanisms;
            if (item.capability === 'configure' && (item.tableKey !== '-'
                || requirementSceneLock || story.existingAdjustment
                || parsed.tableStories.some(binding => binding.storyId === item.storyId))) {
                issues.push(this._issue('DESIGN_MODEL_CONFIGURE_CONTRACT_CONFLICT', `decisionRows[${item.rowIndex}]`,
                    `configure只表达现有平台配置，必须填STORY|${item.storyId}|configure|-，不能绑定TABLE、修改既有代码或承担REST/统计/工作流交付。`));
            }
            const routeCarrier = carrierMap.get(primaryObjectKey);
            const querySurface = querySurfaceMap.get(item.storyId);
            if (querySurface && item.capability !== 'query') {
                issues.push(this._issue(
                    'DESIGN_MODEL_QUERY_SURFACE_CAPABILITY_INVALID',
                    `decisionRows[${querySurface.rowIndex}]`,
                    `QUERY_SURFACE只能绑定query Story，当前${item.storyId}=${item.capability}。`
                ));
            }
            const hasExistingQueryCarrier = !!(story && story.existingAdjustment
                && Array.isArray(story.existingAdjustment.entryFiles)
                && story.existingAdjustment.entryFiles.length > 0);
            if (querySurface
                && querySurface.mode === 'independent'
                && item.capability === 'query'
                && routeCarrier
                && routeCarrier.mode === 'none'
                && !hasExistingQueryCarrier) {
                issues.push(this._issue(
                    'DESIGN_MODEL_QUERY_SURFACE_CARRIER_REQUIRED',
                    `decisionRows[${item.rowIndex}]`,
                    `Story ${item.storyId}声明独立查询页面，但STORY的tableKey=-；独立查询必须绑定真实数据载体，不能只提交QUERY_SURFACE。`,
                    {
                        storyId: item.storyId,
                        storyRowIndex: item.rowIndex,
                        querySurfaceRowIndex: querySurface.rowIndex,
                        actualShape: [
                            `STORY|${item.storyId}|query|-`,
                            `QUERY_SURFACE|${item.storyId}|independent|${querySurface.pageKey}`
                        ],
                        repairHint: '二选一：①补TABLE|<logicalTableKey>|new|<displayName>或TABLE|<logicalTableKey>|reuse|<confirmedCandidate>|<displayName>，并把STORY第4段改为该logicalTableKey；②如果不需要独立页面，删除QUERY_SURFACE行。已有入口必须在Requirement中提供entryFiles证据。',
                        allowedShapes: [
                            'STORY|<storyId>|query|<logicalTableKey> + 已声明TABLE',
                            'STORY|<storyId>|query|-（不提交QUERY_SURFACE）'
                        ]
                    }
                ));
            }
            if (story.workflowIntent && routeCarrier && routeCarrier.mode === 'none') {
                issues.push(this._issue(
                    'DESIGN_MODEL_WORKFLOW_CARRIER_REQUIRED',
                    `decisionRows[${item.rowIndex}]`,
                    `Workflow Story ${item.storyId} 必须绑定本次TABLE或确认复用表，不能填-。`
                ));
            }
            routeMap.set(item.storyId, {
                storyId: item.storyId,
                routeKey: item.routeKey,
                capability: item.capability,
                primaryObjectKey,
                surface: this._projectSurface(item.capability, primaryObjectKey, routeCarrier, internalRelations, querySurface),
                ...(item.capability === 'query' ? {
                    querySurface: querySurface
                        ? {
                            mode: 'independent',
                            pageKey: querySurface.pageKey,
                            surfaceIdentity: `admin:${primaryObjectKey}:list:${querySurface.pageKey}`
                        }
                        : {
                            mode: 'reuse_carrier_list',
                            pageKey: 'default',
                            surfaceIdentity: `admin:${primaryObjectKey}:list:default`
                        }
                } : {}),
                requirementSceneLock,
                businessMechanisms
            });
        });
        storiesById.forEach((_, storyId) => {
            if (!routeMap.has(storyId)) {
                issues.push(this._issue('DESIGN_MODEL_STORY_ROUTE_MISSING', 'decisionRows', `Requirement Story ${storyId}缺少STORY行。`));
            }
        });

        const routeList = Array.from(routeMap.values());
        carrierMap.forEach(carrier => {
            const direct = routeList.filter(route => route.primaryObjectKey === carrier.objectKey);
            const connected = routeList.filter(route => this._objectsConnected(route.primaryObjectKey, carrier.objectKey, internalRelations));
            const explicitBinding = tableStoryMap.get(carrier.objectKey);
            const ownerRoute = direct.find(route => route.capability === 'maintain')
                || direct[0]
                || connected.find(route => route.capability === 'maintain')
                || connected[0];
            if (carrier.mode === 'reuse') {
                if (explicitBinding && (!ownerRoute || explicitBinding.storyId !== ownerRoute.storyId)) {
                    issues.push(this._issue(
                        'DESIGN_MODEL_TABLE_STORY_REUSE_FORBIDDEN',
                        `decisionRows[${explicitBinding.rowIndex}]`,
                        `TABLE_STORY不能给reuse Carrier ${carrier.objectKey}声明owner；reuse Carrier必须由STORY/RELATION绑定，统计来源表应使用STATISTICS_SOURCE。`,
                        {
                            tableKey: carrier.objectKey,
                            storyId: explicitBinding.storyId,
                            repairHint: `删除 TABLE_STORY|${carrier.objectKey}|${explicitBinding.storyId}；如果它只是统计读取来源，删除 TABLE|${carrier.objectKey}|reuse...，改用 STATISTICS_SOURCE|<statisticsStoryId>|${carrier.tableName}|primary/secondary。`
                        }
                    ));
                }
                if (direct.length === 0 && connected.length === 0) {
                    const sourceOnly = Array.from(statisticsSourceMap.values())
                        .filter(source => String(source.tableName || '').toUpperCase() === String(carrier.tableName || '').toUpperCase());
                    const candidate = candidateByName.get(String(carrier.tableName || '').toUpperCase());
                    const statsStoryIds = Array.from(new Set(sourceOnly.map(source => source.storyId)));
                    const likelyStatisticsSource = sourceOnly.length > 0
                        || ['weak_related_candidate', 'triggered_side_effect_candidate'].includes(String(candidate && candidate.candidateRole || '').trim());
                    if (likelyStatisticsSource) {
                        issues.push(this._issue(
                            'DESIGN_MODEL_STATISTICS_SOURCE_CARRIER_MISUSED',
                            'decisionRows',
                            `候选表 ${carrier.tableName || carrier.objectKey} 只是只读统计来源，却被写成了没有业务Story归属的 reuse Carrier。`,
                            {
                                tableKey: carrier.objectKey,
                                tableName: carrier.tableName,
                                candidateRole: String(candidate && candidate.candidateRole || '').trim(),
                                sourceStoryIds: statsStoryIds,
                                repairHint: `删除 TABLE|${carrier.objectKey}|reuse|${carrier.tableName}|... 及其 TABLE_STORY 行；保留真正统计Story的 STORY|<storyId>|query|-，需要引用此表时提交 STATISTICS_SOURCE|<storyId>|${carrier.tableName}|primary/secondary。`
                            }
                        ));
                    } else {
                        issues.push(this._issue(
                            'DESIGN_MODEL_CARRIER_STORY_BINDING_MISSING',
                            'decisionRows',
                            `reuse Carrier ${carrier.objectKey}没有可由STORY/RELATION推出的owner Story；如果它只是查询来源，不要声明TABLE Carrier。`,
                            {
                                tableKey: carrier.objectKey,
                                tableName: carrier.tableName,
                                allowedStoryIds: stories.map(story => this._storyId(story)).filter(Boolean),
                                repairHint: `补一条引用该业务对象的 STORY 行，或删除 TABLE|${carrier.objectKey}|reuse...；统计只读来源使用 STATISTICS_SOURCE 行。`
                            }
                        ));
                    }
                }
                return;
            }
            if (explicitBinding && ownerRoute && explicitBinding.storyId !== ownerRoute.storyId) {
                issues.push(this._issue(
                    'DESIGN_MODEL_TABLE_STORY_CONFLICT',
                    `decisionRows[${explicitBinding.rowIndex}]`,
                    `TABLE_STORY ${carrier.objectKey}归属${explicitBinding.storyId}与STORY/RELATION已推导归属${ownerRoute.storyId}冲突。`,
                    { tableKey: carrier.objectKey, derivedOwnerStoryId: ownerRoute.storyId }
                ));
            }
            if (!ownerRoute && !explicitBinding) {
                issues.push(this._issue(
                    'DESIGN_MODEL_CARRIER_STORY_BINDING_MISSING',
                    'decisionRows',
                    `new Carrier ${carrier.objectKey}没有可由STORY/RELATION推出的owner Story，必须补TABLE_STORY|${carrier.objectKey}|<storyId>。`,
                    {
                        tableKey: carrier.objectKey,
                        allowedStoryIds: stories.map(story => this._storyId(story)).filter(Boolean)
                    }
                ));
            }
            carrier.ownerStoryId = String(ownerRoute && ownerRoute.storyId || explicitBinding && explicitBinding.storyId || '').trim();
            carrier.ownerDerivedByBuilder = !!ownerRoute;
            if (!ownerRoute && explicitBinding) carrier.ownerBinding = 'TABLE_STORY';
        });

        if (issues.length > 0) {
            const missingCarrierBinding = issues.some(issue => issue && issue.code === 'DESIGN_MODEL_CARRIER_STORY_BINDING_MISSING');
            const missingQuerySurfaceCarrier = issues.some(issue => issue && issue.code === 'DESIGN_MODEL_QUERY_SURFACE_CARRIER_REQUIRED');
            const statisticsSourceCarrierMisused = issues.some(issue => issue && issue.code === 'DESIGN_MODEL_STATISTICS_SOURCE_CARRIER_MISUSED');
            const reuseTableStoryForbidden = issues.some(issue => issue && issue.code === 'DESIGN_MODEL_TABLE_STORY_REUSE_FORBIDDEN');
            return this._blocked(
                missingQuerySurfaceCarrier
                    ? 'DESIGN_MODEL_QUERY_SURFACE_CARRIER_REQUIRED'
                    : (statisticsSourceCarrierMisused
                        ? 'DESIGN_MODEL_STATISTICS_SOURCE_CARRIER_MISUSED'
                        : (reuseTableStoryForbidden
                            ? 'DESIGN_MODEL_TABLE_STORY_REUSE_FORBIDDEN'
                            : (missingCarrierBinding ? 'DESIGN_MODEL_CARRIER_STORY_BINDING_MISSING' : 'DESIGN_MODEL_TOPOLOGY_INVALID'))),
                issues
            );
        }
        const statisticsSourceDependencies = Array.from(statisticsSourceMap.values()).map(item => ({
            storyId: item.storyId,
            tableName: item.tableName,
            role: item.role,
            sourceName: item.sourceName,
            ...(item.candidateRole ? { candidateRole: item.candidateRole } : {})
        }));
        const canonicalModel = {
            schemaVersion: 'design-canonical-model/v1',
            managedBy: 'design_model_compiler',
            managedProjection: false,
            dataObjects: Array.from(objectMap.values()),
            carriers: Array.from(carrierMap.values()),
            tableStoryBindings: Array.from(tableStoryMap.values()).map(item => ({
                tableKey: item.tableKey,
                storyId: item.storyId
            })),
            objectRelations: internalRelations.map(item => ({
                relationKey: item.relationKey,
                parentObjectKey: item.parentObjectKey,
                childObjectKey: item.childObjectKey,
                relationKind: item.relationKind,
                meaning: item.meaning
            })),
            storyRoutes: Array.from(routeMap.values()),
            querySurfaces: Array.from(querySurfaceMap.values()).map(item => ({
                storyId: item.storyId,
                mode: 'independent',
                pageKey: item.pageKey
            })),
            pageCompositions: [],
            pageBindings: [],
            ...(statisticsSourceDependencies.length > 0 ? { statisticsSourceDependencies } : {}),
            objectFields: Array.from(carrierMap.values()).filter(carrier => carrier.mode === 'reuse')
                .flatMap(carrier => (candidateByName.get(carrier.tableName.toUpperCase())?.columns || [])
                    .map(column => ({ ...column, objectKey: carrier.objectKey }))),
            restOperations: [],
            workflowOperationEvents: [],
            confirmedTableCandidates: Array.from(candidateSet),
            decisionHash: this._hashRows(decisionRows)
        };
        return { ok: true, canonicalModel };
    }

    applyDetails({ canonicalModel = {}, detailRows = [], requirementStories = {}, final = true } = {}) {
        const parsed = parseDetailRows(detailRows);
        if (!parsed.ok) return this._blocked('DESIGN_MODEL_DETAIL_ROWS_INVALID', parsed.issues);
        const model = JSON.parse(JSON.stringify(canonicalModel || {}));
        const issues = [];
        const objectMap = new Map((Array.isArray(model.dataObjects) ? model.dataObjects : []).map(item => [item.objectKey, item]));
        const carrierMap = new Map((Array.isArray(model.carriers) ? model.carriers : []).map(item => [item.objectKey, item]));
        const routeMap = new Map((Array.isArray(model.storyRoutes) ? model.storyRoutes : []).map(item => [item.storyId, item]));
        const storiesById = new Map(this._stories(requirementStories).map(story => [this._storyId(story), story]).filter(([id]) => id));
        const requirementFactRefs = new Set();
        const codeItemFactRefs = new Set();
        storiesById.forEach(story => {
            const facts = Array.isArray(story && story.codingFactHandoff) ? story.codingFactHandoff : [];
            facts.forEach(fact => {
                const factId = String(fact && fact.factId || '').trim();
                if (!factId) return;
                requirementFactRefs.add(factId);
                const factType = String(fact && fact.factType || '').trim().toLowerCase();
                if (CODE_ITEM_FACT_TYPES.includes(factType)) codeItemFactRefs.add(factId);
            });
        });
        const fieldMap = new Map((Array.isArray(model.objectFields) ? model.objectFields : []).map(field => [`${field.objectKey}::${field.name}`, field]));
        const codeItemDefinitionMap = new Map();
        fieldMap.forEach(field => {
            if (!field || !field.codeItem || !field.codeItemDefinition) return;
            codeItemDefinitionMap.set(String(field.codeItem).trim().toLowerCase(), this._codeItemDefinitionSignature(field.codeItemDefinition));
        });

        parsed.fields.forEach(field => {
            const key = `${field.objectKey}::${field.name}`;
            const carrier = carrierMap.get(field.objectKey);
            if (!objectMap.has(field.objectKey)) {
                issues.push(this._issue('DESIGN_MODEL_FIELD_OBJECT_NOT_FOUND', `detailRows[${field.rowIndex}]`, `FIELD引用未声明对象${field.objectKey}。`));
            } else if (!carrier || carrier.mode !== 'new') {
                issues.push(this._issue('DESIGN_MODEL_FIELD_ON_NON_NEW_CARRIER', `detailRows[${field.rowIndex}]`, `只有new Carrier可新增字段，当前对象=${field.objectKey}。`));
            }
            if (!OBJECT_KEY_PATTERN.test(field.name)) {
                issues.push(this._issue('DESIGN_MODEL_FIELD_NAME_INVALID', `detailRows[${field.rowIndex}]`, `字段名${field.name}必须是小写snake_case。`));
            }
            if (!field.type || !/^[A-Z][A-Z0-9_]*$/.test(field.type)) {
                issues.push(this._issue('DESIGN_MODEL_FIELD_TYPE_INVALID', `detailRows[${field.rowIndex}]`, `字段${field.name}类型不合法。`));
            }
            if (!field.comment) {
                issues.push(this._issue('DESIGN_MODEL_FIELD_COMMENT_MISSING', `detailRows[${field.rowIndex}]`, `字段${field.name}缺少业务含义。`));
            }
            if (fieldMap.has(key)) {
                issues.push(this._issue('DESIGN_MODEL_FIELD_DUPLICATED', `detailRows[${field.rowIndex}]`, `字段${key}重复。`));
            } else {
                fieldMap.set(key, {
                    objectKey: field.objectKey,
                    name: field.name,
                    type: field.type,
                    length: field.length,
                    required: field.required,
                    comment: field.comment
                });
            }
        });

        parsed.codeItems.forEach(item => {
            const field = fieldMap.get(`${item.objectKey}::${item.columnName}`);
            if (!field) {
                issues.push(this._issue('DESIGN_MODEL_CODE_ITEM_FIELD_NOT_FOUND', `detailRows[${item.rowIndex}]`, `CODE_ITEM字段${item.objectKey}.${item.columnName}尚未声明。`));
            } else {
                if (field.codeItem) {
                    issues.push(this._issue('DESIGN_MODEL_CODE_ITEM_FIELD_DUPLICATED', `detailRows[${item.rowIndex}]`, `字段${item.objectKey}.${item.columnName}已声明代码项，不得重复绑定。`));
                    return;
                }
                if (item.mode === 'reuse' && !requirementFactRefs.has(item.sourceRef)) {
                    issues.push(this._issue(
                        'DESIGN_MODEL_CODE_ITEM_REUSE_SOURCE_NOT_FOUND',
                        `detailRows[${item.rowIndex}]`,
                        `复用代码项${item.codeItem}的sourceRef=${item.sourceRef}不在Requirement codingFactHandoff中。`,
                        {
                            allowedSourceRefs: Array.from(codeItemFactRefs),
                            expectedShape: 'CODE_ITEM|tableKey|columnName|reuse|代码项中文名|<allowedSourceRef>'
                        }
                    ));
                    return;
                }
                if (item.mode === 'new' && this._isIntegerFieldType(field.type)) {
                    const invalidCodes = (Array.isArray(item.codes) ? item.codes : [])
                        .map(code => String(code && code.codeValue || '').trim())
                        .filter(codeValue => !/^\d+$/u.test(codeValue));
                    if (invalidCodes.length > 0) {
                        issues.push(this._issue(
                            'DESIGN_MODEL_CODE_ITEM_VALUE_TYPE_INVALID',
                            `detailRows[${item.rowIndex}]`,
                            `代码项${item.codeItem}绑定的整数类型字段${item.objectKey}.${item.columnName}不能使用文本代码值。`,
                            {
                                fieldType: String(field.type || '').trim().toUpperCase(),
                                invalidValues: invalidCodes,
                                allowedPattern: '^\\d+$',
                                expectedShape: '整数类型代码项使用0、1、10等数字稳定值；业务含义写在codeLabel'
                            }
                        ));
                        return;
                    }
                }
                const definition = item.mode === 'new'
                    ? { mode: 'new', codes: item.codes.map(code => ({ ...code })) }
                    : { mode: 'reuse', sourceRef: item.sourceRef };
                const definitionKey = String(item.codeItem).trim().toLowerCase();
                const signature = this._codeItemDefinitionSignature(definition);
                if (codeItemDefinitionMap.has(definitionKey) && codeItemDefinitionMap.get(definitionKey) !== signature) {
                    issues.push(this._issue('DESIGN_MODEL_CODE_ITEM_DEFINITION_CONFLICT', `detailRows[${item.rowIndex}]`, `代码项${item.codeItem}在不同字段上的new/reuse来源或值列表不一致。`));
                    return;
                }
                codeItemDefinitionMap.set(definitionKey, signature);
                field.codeItem = item.codeItem;
                field.codeItemDefinition = definition;
            }
        });
        parsed.attachments.forEach(item => {
            const key = `${item.objectKey}::${item.columnName}`;
            const carrier = carrierMap.get(item.objectKey);
            if (!objectMap.has(item.objectKey)) {
                issues.push(this._issue('DESIGN_MODEL_ATTACHMENT_OBJECT_NOT_FOUND', `detailRows[${item.rowIndex}]`, `ATTACHMENT引用未声明对象${item.objectKey}。`));
            } else if (!carrier || carrier.mode !== 'new') {
                issues.push(this._issue('DESIGN_MODEL_ATTACHMENT_ON_NON_NEW_CARRIER', `detailRows[${item.rowIndex}]`, `只有new Carrier可声明附件字段，当前对象=${item.objectKey}。`));
            }
            if (!OBJECT_KEY_PATTERN.test(item.columnName)) {
                issues.push(this._issue('DESIGN_MODEL_ATTACHMENT_FIELD_NAME_INVALID', `detailRows[${item.rowIndex}]`, `附件字段名${item.columnName}必须是小写snake_case。`));
            }
            if (!item.attachmentLabel) {
                issues.push(this._issue('DESIGN_MODEL_ATTACHMENT_LABEL_MISSING', `detailRows[${item.rowIndex}]`, 'ATTACHMENT业务名称不能为空。'));
            } else if (fieldMap.has(key)) {
                issues.push(this._issue(
                    'DESIGN_MODEL_ATTACHMENT_FIELD_DUPLICATED',
                    `detailRows[${item.rowIndex}]`,
                    `ATTACHMENT已声明字段${item.objectKey}.${item.columnName}，不得再提交同名FIELD。`,
                    {
                        expectedShape: 'ATTACHMENT|tableKey|columnName|true/false|附件业务名称',
                        forbiddenShape: 'FIELD + ATTACHMENT'
                    }
                ));
            } else {
                fieldMap.set(key, {
                    objectKey: item.objectKey,
                    name: item.columnName,
                    type: 'VARCHAR',
                    length: '50',
                    required: item.required,
                    comment: item.attachmentLabel,
                    attachmentKey: true,
                    attachmentLabel: item.attachmentLabel
                });
            }
        });

        const restMap = new Map((Array.isArray(model.restOperations) ? model.restOperations : []).map(item => [`${item.storyId}::${item.operationKey}`, item]));
        parsed.restOperations.forEach(item => {
            const route = routeMap.get(item.storyId);
            if (!storiesById.has(item.storyId) || !route) {
                issues.push(this._issue('DESIGN_MODEL_REST_STORY_NOT_FOUND', `detailRows[${item.rowIndex}]`, `REST的Story ${item.storyId}没有已确认Route。`));
            } else if (route.requirementSceneLock !== 'rest_interface') {
                issues.push(this._issue('DESIGN_MODEL_REST_ROUTE_NOT_EXTERNAL', `detailRows[${item.rowIndex}]`, `REST只允许绑定Requirement已确认的对外REST交付，当前Story没有rest_interface交付边界。`));
            }
            if (!OBJECT_KEY_PATTERN.test(item.operationKey)) {
                issues.push(this._issue(
                    'DESIGN_MODEL_REST_OPERATION_KEY_INVALID',
                    `detailRows[${item.rowIndex}]`,
                    `operationKey=${item.operationKey}必须是小写snake_case。`,
                    {
                        allowedPattern: OBJECT_KEY_PATTERN.source,
                        expectedShape: 'REST|storyId|operation_key|业务目的|请求事实|返回事实'
                    }
                ));
            }
            if (!item.purpose || !item.requestShape || !item.responseShape) {
                issues.push(this._issue('DESIGN_MODEL_REST_BUSINESS_SHAPE_MISSING', `detailRows[${item.rowIndex}]`, 'REST业务目的、请求事实和返回事实都必须填写；确实无请求业务字段时用-明确表达。'));
            }
            const key = `${item.storyId}::${item.operationKey}`;
            if (restMap.has(key)) {
                issues.push(this._issue('DESIGN_MODEL_REST_OPERATION_DUPLICATED', `detailRows[${item.rowIndex}]`, `REST operation ${key}重复。`));
            } else {
                restMap.set(key, {
                    storyId: item.storyId,
                    operationKey: item.operationKey,
                    purpose: item.purpose,
                    requestShape: item.requestShape,
                    responseShape: item.responseShape
                });
            }
        });

        const workflowEventMap = new Map((Array.isArray(model.workflowOperationEvents) ? model.workflowOperationEvents : [])
            .map(item => [`${item.storyId}::${item.operationKey}`, item]));
        const workflowOperationsByStory = this._workflowOperationsByStory(storiesById);
        parsed.workflowEvents.forEach(item => {
            const operation = workflowOperationsByStory.get(`${item.storyId}::${item.operationKey}`);
            const route = routeMap.get(item.storyId);
            if (!storiesById.has(item.storyId) || !route || !operation) {
                issues.push(this._issue(
                    'DESIGN_MODEL_WORKFLOW_EVENT_OPERATION_NOT_FOUND',
                    `detailRows[${item.rowIndex}]`,
                    `WORKFLOW_EVENT引用的${item.storyId}/${item.operationKey}不在Requirement workflowIntent.operations中。`,
                    {
                        allowedOperationKeys: Array.from(workflowOperationsByStory.keys())
                            .filter(key => key.startsWith(`${item.storyId}::`))
                            .map(key => key.slice(item.storyId.length + 2))
                    }
                ));
                return;
            }
            const key = `${item.storyId}::${item.operationKey}`;
            if (workflowEventMap.has(key)) {
                issues.push(this._issue('DESIGN_MODEL_WORKFLOW_EVENT_DUPLICATED', `detailRows[${item.rowIndex}]`, `工作流操作${key}只能有一条WORKFLOW_EVENT决策。`));
                return;
            }
            workflowEventMap.set(key, {
                storyId: item.storyId,
                operationKey: item.operationKey,
                activityKey: operation.activityKey,
                activityName: operation.activityName,
                operationName: operation.operationName,
                semantic: operation.semantic,
                mode: item.mode,
                methodName: item.methodName,
                businessEffect: item.businessEffect,
                parameters: item.parameters.map(parameter => ({ ...parameter }))
            });
        });
        if (final) {
            workflowOperationsByStory.forEach((operation, key) => {
                if (!workflowEventMap.has(key)) {
                    issues.push(this._issue(
                        'DESIGN_MODEL_WORKFLOW_EVENT_DECISION_MISSING',
                        'detailRows',
                        `工作流操作${key}缺少WORKFLOW_EVENT决策。`,
                        {
                            expectedShape: operation.expectedShape,
                            allowedNextActions: [`WORKFLOW_EVENT|${operation.storyId}|${operation.operationKey}|none|-|-|-`]
                        }
                    ));
                }
            });
        }

        if (final) {
            carrierMap.forEach(carrier => {
                if (carrier.mode !== 'new') return;
                const count = Array.from(fieldMap.values()).filter(field => field.objectKey === carrier.objectKey).length;
                if (count === 0) {
                    issues.push(this._issue('DESIGN_MODEL_NEW_CARRIER_FIELDS_MISSING', 'detailRows', `new Carrier ${carrier.objectKey}至少需要一个真实业务字段。`));
                }
            });
            routeMap.forEach(route => {
                if (route.requirementSceneLock === 'rest_interface') {
                    const count = Array.from(restMap.values()).filter(item => item.storyId === route.storyId).length;
                    if (count === 0) {
                        issues.push(this._issue('DESIGN_MODEL_EXTERNAL_ROUTE_REST_MISSING', 'detailRows', `外部查询Route ${route.storyId}至少需要一个REST操作。`));
                    }
                }
            });
            issues.push(...this._validateStatisticsReferences({
                ...model,
                objectFields: Array.from(fieldMap.values())
            }, storiesById));
        }
        if (issues.length > 0) return this._blocked('DESIGN_MODEL_DETAILS_INVALID', issues);
        model.objectFields = Array.from(fieldMap.values());
        model.restOperations = Array.from(restMap.values());
        model.workflowOperationEvents = Array.from(workflowEventMap.values());
        model.detailHash = this._hashRows(detailRows);
        return { ok: true, canonicalModel: model };
    }

    applyPageDesign({ canonicalModel = {}, compositionRows = [], requirementStories = {} } = {}) {
        const parsed = parseCompositionRows(compositionRows);
        if (!parsed.ok) return this._blocked('DESIGN_MODEL_COMPOSITION_ROWS_INVALID', parsed.issues);
        const model = JSON.parse(JSON.stringify(canonicalModel || {}));
        const issues = [];
        const objects = Array.isArray(model.dataObjects) ? model.dataObjects : [];
        const relations = Array.isArray(model.objectRelations) ? model.objectRelations : [];
        const routes = Array.isArray(model.storyRoutes) ? model.storyRoutes : [];
        const objectFields = Array.isArray(model.objectFields) ? model.objectFields : [];
        const objectMap = new Map(objects.map(item => [String(item && item.objectKey || '').trim(), item]));
        const fieldMap = new Map(objectFields.map(field => [`${field.objectKey}.${field.name}`, field]));
        const routeMap = new Map(routes.map(item => [String(item && item.storyId || '').trim().toUpperCase(), item]));
        const requirementStoryIds = new Set(this._stories(requirementStories).map(story => this._storyId(story)).filter(Boolean));
        const compositions = [];
        const queryFilters = [];
        const seenStoryIds = new Set();
        const sectionRowsByStory = new Map();
        parsed.sections.forEach(section => {
            if (!sectionRowsByStory.has(section.storyId)) sectionRowsByStory.set(section.storyId, []);
            sectionRowsByStory.get(section.storyId).push(section);
        });

        parsed.compositions.forEach(item => {
            const rowPath = `compositionRows[${item.rowIndex}]`;
            const route = routeMap.get(item.storyId);
            if (!requirementStoryIds.has(item.storyId) || !route) {
                issues.push(this._issue('DESIGN_MODEL_COMPOSITION_STORY_NOT_FOUND', rowPath, `COMPOSE的Story ${item.storyId}没有已声明STORY行。`));
                return;
            }
            if (seenStoryIds.has(item.storyId)) {
                issues.push(this._issue('DESIGN_MODEL_COMPOSITION_DUPLICATED', rowPath, `Story ${item.storyId}只能声明一行COMPOSE。`));
                return;
            }
            seenStoryIds.add(item.storyId);
            if (!route.primaryObjectKey || route.primaryObjectKey.startsWith('story_')) {
                issues.push(this._issue('DESIGN_MODEL_COMPOSITION_PRIMARY_OBJECT_MISSING', rowPath, `COMPOSE Story ${item.storyId}必须绑定真实TABLE。`));
                return;
            }
            if (!['maintain', 'query'].includes(route.capability)) {
                issues.push(this._issue('DESIGN_MODEL_COMPOSITION_CAPABILITY_INVALID', rowPath, `COMPOSE只支持maintain/query页面，当前Story ${item.storyId}=${route.capability}。`));
                return;
            }
            if (route.capability === 'query' && item.blocks.some(block => block.kind === 'child_edit')) {
                issues.push(this._issue('DESIGN_MODEL_QUERY_COMPOSITION_EDIT_FORBIDDEN', rowPath, `query Story ${item.storyId}不能声明child_edit。`));
                return;
            }
            const formBlocks = item.blocks.filter(block => block.kind === 'form');
            if (formBlocks.length !== 1) {
                issues.push(this._issue('DESIGN_MODEL_COMPOSITION_PRIMARY_FORM_INVALID', rowPath, 'COMPOSE必须且只能包含一个form业务块。'));
                return;
            }
            const formObjectKey = formBlocks[0].objectKey;
            if (!objectMap.has(formObjectKey)) {
                issues.push(this._issue('DESIGN_MODEL_COMPOSITION_OBJECT_NOT_FOUND', rowPath, `form组合块引用未声明TABLE ${formObjectKey}。`));
                return;
            }
            const rootToForm = this._directedRelationPath(route.primaryObjectKey, formObjectKey, relations);
            if (!rootToForm.ok) {
                issues.push(this._compositionPathIssue(rootToForm, rowPath, route.primaryObjectKey, formObjectKey, 'form'));
                return;
            }
            const blocks = [];
            const seenBlocks = new Set();
            item.blocks.forEach((block, blockIndex) => {
                const field = `${rowPath}.blocks[${blockIndex}]`;
                if (!objectMap.has(block.objectKey)) {
                    issues.push(this._issue('DESIGN_MODEL_COMPOSITION_OBJECT_NOT_FOUND', field, `组合块引用未声明TABLE ${block.objectKey}。`));
                    return;
                }
                const blockKey = `${block.kind}:${block.objectKey}`;
                if (seenBlocks.has(blockKey)) {
                    issues.push(this._issue('DESIGN_MODEL_COMPOSITION_BLOCK_DUPLICATED', field, `组合块 ${blockKey}重复。`));
                    return;
                }
                seenBlocks.add(blockKey);
                const blockContract = PAGE_COMPOSITION_BLOCK_CONTRACT[block.kind];
                const pathResult = block.kind === 'form'
                    ? rootToForm
                    : this._directedRelationPath(formObjectKey, block.objectKey, relations);
                if (!pathResult.ok || pathResult.relationPath.length < blockContract.relationPathMinItems) {
                    issues.push(this._compositionPathIssue(pathResult, field, formObjectKey, block.objectKey, block.kind));
                    return;
                }
                if (blockContract.directRelationOnly && pathResult.relationPath.length !== 1) {
                    issues.push(this._issue(
                        'DESIGN_MODEL_COMPOSITION_CHILD_NOT_DIRECT_FROM_FORM',
                        field,
                        `${block.kind}必须是LLM所选form对象${formObjectKey}的直接明细；当前路径=${pathResult.relationPath.join('>')}。请选择实际承载编辑字段的form对象，不得伪造Story根对象直连关系。`
                    ));
                    return;
                }
                blocks.push({
                    kind: block.kind,
                    objectKey: block.objectKey,
                    relationPath: pathResult.relationPath.slice()
                });
            });
            if (blocks.length !== item.blocks.length) return;
            const sectionRows = sectionRowsByStory.get(item.storyId) || [];
            const sections = [];
            const seenSectionKeys = new Set();
            const assignedFieldRefs = new Set();
            sectionRows.forEach(section => {
                const field = `compositionRows[${section.rowIndex}]`;
                if (seenSectionKeys.has(section.sectionKey)) {
                    issues.push(this._issue('DESIGN_MODEL_SECTION_DUPLICATED', field, `Story ${item.storyId}的sectionKey=${section.sectionKey}重复。`));
                    return;
                }
                seenSectionKeys.add(section.sectionKey);
                const invalidRefs = section.fieldRefs.filter(ref => {
                    const target = fieldMap.get(ref);
                    return !target || target.objectKey !== formObjectKey;
                });
                if (invalidRefs.length > 0) {
                    issues.push(this._issue(
                        'DESIGN_MODEL_SECTION_FIELD_REF_INVALID',
                        field,
                        `SECTION只能引用表单对象${formObjectKey}的业务字段。`,
                        { invalidRefs }
                    ));
                    return;
                }
                const duplicatedRefs = section.fieldRefs.filter(ref => assignedFieldRefs.has(ref));
                if (duplicatedRefs.length > 0) {
                    issues.push(this._issue(
                        'DESIGN_MODEL_SECTION_FIELD_DUPLICATED',
                        field,
                        '同一个表单字段不能被分配到多个页面分区。',
                        { duplicatedRefs }
                    ));
                    return;
                }
                section.fieldRefs.forEach(ref => assignedFieldRefs.add(ref));
                sections.push({
                    sectionKey: section.sectionKey,
                    title: section.title,
                    fieldRefs: section.fieldRefs.slice()
                });
            });
            if (sections.length !== sectionRows.length) return;
            if (item.layout !== 'accordion' && sections.length > 0) {
                issues.push(this._issue('DESIGN_MODEL_SECTION_LAYOUT_INVALID', rowPath, 'SECTION只用于accordion布局；plain布局直接按业务块顺序展示。'));
                return;
            }
            if (item.layout === 'accordion') {
                const visualRegionCount = sections.length
                    + blocks.filter(block => block.kind !== 'form').length
                    + (sections.length === 0 ? 1 : 0);
                if (visualRegionCount < 2) {
                    issues.push(this._issue(
                        'DESIGN_MODEL_ACCORDION_REGIONS_INSUFFICIENT',
                        rowPath,
                        'accordion至少需要两个可展示分区；单个form业务对象可通过多个SECTION按字段分类。'
                    ));
                    return;
                }
                if (sections.length > 0) {
                    const nonAttachmentFields = objectFields
                        .filter(field => field.objectKey === formObjectKey && field.attachmentKey !== true);
                    const expectedFieldRefs = nonAttachmentFields
                        .map(field => `${field.objectKey}.${field.name}`);
                    const missingFieldRefs = expectedFieldRefs.filter(ref => !assignedFieldRefs.has(ref));
                    if (missingFieldRefs.length > 0) {
                        const allNonAttachFieldRefs = expectedFieldRefs;
                        const uncovered = allNonAttachFieldRefs.filter(ref => !assignedFieldRefs.has(ref));
                        const sectionCount = Math.max(2, Math.ceil(allNonAttachFieldRefs.length / 4));
                        const expectedCompleteSectionRows = [];
                        for (let i = 0; i < sectionCount; i++) {
                            const chunkSize = Math.ceil(uncovered.length / sectionCount);
                            const chunk = uncovered.slice(i * chunkSize, (i + 1) * chunkSize);
                            if (chunk.length === 0) break;
                            expectedCompleteSectionRows.push(`SECTION|${item.storyId}|section_${i + 1}|分区${i + 1}|${chunk.join(',')}`);
                        }
                        issues.push(this._issue(
                            'DESIGN_MODEL_SECTION_FIELD_COVERAGE_INCOMPLETE',
                            rowPath,
                            '使用SECTION拆分表单时，必须覆盖表单对象全部非附件业务字段；附件字段可归入SECTION也可由Builder单独投影。',
                            { missingFieldRefs, expectedCompleteSectionRows }
                        ));
                        return;
                    }
                }
            }
            const layoutConflict = compositions.find(existing =>
                existing.formObjectKey === formObjectKey
                && existing.capability === route.capability
                && existing.layout !== item.layout
            );
            if (layoutConflict) {
                issues.push(this._issue(
                    'DESIGN_MODEL_COMPOSITION_LAYOUT_CONFLICT',
                    `${rowPath}.layout`,
                    `同一表单对象${formObjectKey}的同一页面类型（${route.capability}）布局必须一致：${layoutConflict.storyId}=${layoutConflict.layout}，${item.storyId}=${item.layout}。`,
                    {
                        formObjectKey,
                        capability: route.capability,
                        conflictStoryIds: [layoutConflict.storyId, item.storyId],
                        allowedResolutions: [
                            `将 ${item.storyId} 的 layout 改为 ${layoutConflict.layout}（与 ${layoutConflict.storyId} 一致）`,
                            `将 ${layoutConflict.storyId} 的 layout 改为 ${item.layout}（与 ${item.storyId} 一致）`
                        ]
                    }
                ));
                return;
            }
            compositions.push({
                storyId: item.storyId,
                primaryObjectKey: route.primaryObjectKey,
                formObjectKey,
                capability: route.capability,
                layout: item.layout,
                decisionTags: item.decisionTags.slice(),
                blocks,
                sections
            });
        });
        parsed.sections.forEach(section => {
            if (seenStoryIds.has(section.storyId)) return;
            issues.push(this._issue(
                'DESIGN_MODEL_SECTION_COMPOSITION_MISSING',
                `compositionRows[${section.rowIndex}]`,
                `SECTION的Story ${section.storyId}缺少COMPOSE行。`
            ));
        });
        const seenQueryFilterKeys = new Set();
        parsed.queryFilters.forEach(filter => {
            const rowPath = `compositionRows[${filter.rowIndex}]`;
            const route = routeMap.get(filter.storyId);
            const field = fieldMap.get(`${filter.objectKey}.${filter.fieldName}`);
            if (!requirementStoryIds.has(filter.storyId) || !route) {
                issues.push(this._issue('DESIGN_MODEL_QUERY_FILTER_STORY_NOT_FOUND', rowPath, `QUERY_FILTER的Story ${filter.storyId}没有已声明STORY行。`));
                return;
            }
            if (!['maintain', 'query'].includes(route.capability)) {
                issues.push(this._issue('DESIGN_MODEL_QUERY_FILTER_CAPABILITY_INVALID', rowPath, `QUERY_FILTER只支持maintain/query页面，当前Story ${filter.storyId}=${route.capability}。`));
                return;
            }
            if (!field) {
                issues.push(this._issue('DESIGN_MODEL_QUERY_FILTER_FIELD_REF_INVALID', rowPath, 'QUERY_FILTER必须引用字段画像中的真实字段；复用表字段由扫描提供，不用FIELD补造。'));
                return;
            }
            // 查询可从明细回查主表；方向不决定SQL写法，唯一关系路径只用于Coder取证。
            const queryRelations = relations.concat(relations.map(relation => ({ ...relation,
                parentObjectKey: relation.childObjectKey, childObjectKey: relation.parentObjectKey })));
            const path = this._directedRelationPath(route.primaryObjectKey, filter.objectKey, queryRelations);
            if (!path.ok) {
                issues.push(this._issue('DESIGN_MODEL_QUERY_FILTER_RELATION_INVALID', rowPath,
                    `筛选字段与主对象没有唯一关系路径：${path.reason}。`, { candidatePaths: path.candidatePaths }));
                return;
            }
            if (filter.operator === 'contains' && !['VARCHAR', 'CHAR', 'TEXT'].includes(String(field.type || '').toUpperCase())) {
                issues.push(this._issue('DESIGN_MODEL_QUERY_FILTER_CONTAINS_TYPE_INVALID', rowPath, `contains只支持文本字段，${filter.objectKey}.${filter.fieldName}=${field.type || '(empty)'}。`));
                return;
            }
            const identity = `${filter.storyId}:${filter.inputKey}`;
            if (seenQueryFilterKeys.has(identity)) {
                issues.push(this._issue('DESIGN_MODEL_QUERY_FILTER_DUPLICATED', rowPath, `Story ${filter.storyId}的inputKey=${filter.inputKey}重复。`));
                return;
            }
            seenQueryFilterKeys.add(identity);
            queryFilters.push({
                storyId: filter.storyId,
                inputKey: filter.inputKey,
                objectKey: filter.objectKey,
                fieldName: filter.fieldName,
                operator: filter.operator,
                normalize: filter.normalize,
                ...(filter.objectKey !== route.primaryObjectKey ? {
                    primaryObjectKey: route.primaryObjectKey,
                    relationPath: path.relationPath,
                    implementation: 'coder'
                } : {})
            });
        });
        if (issues.length > 0) return this._blocked('DESIGN_MODEL_COMPOSITION_INVALID', issues);
        const pageBindingResult = this._compilePageBindings({
            pageBindings: parsed.pageBindings,
            compositions,
            routes,
            requirementStoryIds
        });
        if (!pageBindingResult.ok) {
            return this._blocked('DESIGN_MODEL_PAGE_BINDING_INVALID', pageBindingResult.issues);
        }
        model.pageCompositions = compositions;
        model.pageBindings = pageBindingResult.pageBindings;
        model.queryFilters = queryFilters;
        issues.push(...this._deliveryBoundaryProjectionIssues(model, requirementStories));
        if (issues.length > 0) return this._blocked('DESIGN_MODEL_DELIVERY_BOUNDARY_CONFLICT', issues);
        model.pageDesignHash = this._hashRows(compositionRows);
        return { ok: true, canonicalModel: model };
    }

    toBuilderInput(canonicalModel = {}, requirementStories = {}) {
        const issues = [];
        const objects = Array.isArray(canonicalModel.dataObjects) ? canonicalModel.dataObjects : [];
        const carriers = Array.isArray(canonicalModel.carriers) ? canonicalModel.carriers : [];
        const relations = Array.isArray(canonicalModel.objectRelations) ? canonicalModel.objectRelations : [];
        const routes = Array.isArray(canonicalModel.storyRoutes) ? canonicalModel.storyRoutes : [];
        const fields = Array.isArray(canonicalModel.objectFields) ? canonicalModel.objectFields : [];
        const restOperations = Array.isArray(canonicalModel.restOperations) ? canonicalModel.restOperations : [];
        const pageCompositions = Array.isArray(canonicalModel.pageCompositions) ? canonicalModel.pageCompositions : [];
        const pageBindings = Array.isArray(canonicalModel.pageBindings) ? canonicalModel.pageBindings : [];
        const queryFilters = Array.isArray(canonicalModel.queryFilters) ? canonicalModel.queryFilters : [];
        const statisticsSourceDependencies = Array.isArray(canonicalModel.statisticsSourceDependencies)
            ? canonicalModel.statisticsSourceDependencies
            : [];
        const objectMap = new Map(objects.map(item => [item.objectKey, item]));
        const carrierMap = new Map(carriers.map(item => [item.objectKey, item]));
        const storiesById = new Map(this._stories(requirementStories).map(story => [this._storyId(story), story]).filter(([id]) => id));
        const entityJudgments = [];
        const routeConsumedByCarrier = new Set();
        const pageBindingProjection = this._pageBindingProjection(pageBindings, pageCompositions);
        pageBindingProjection.byStoryId.forEach(binding => {
            if (binding.independent !== true && binding.sharedTargetStoryIds.length > 0) {
                routeConsumedByCarrier.add(binding.storyId);
            }
        });

        carriers.forEach(carrier => {
            const object = objectMap.get(carrier.objectKey);
            if (!object) return;
            const objectRoutes = routes.filter(route => route.primaryObjectKey === carrier.objectKey);
            const ownerRoute = carrier.mode === 'new'
                ? objectRoutes.find(route => route.storyId === carrier.ownerStoryId && route.capability === 'maintain')
                : objectRoutes[0];
            const linkedTable = this._linkedTableForCarrier(carrier, object, fields, relations, objectMap);
            const ownerStory = ownerRoute ? storiesById.get(ownerRoute.storyId) || {} : {};
            const ownerProjection = ownerRoute
                ? this._resolveRouteProjectionForPageBinding(
                    ownerRoute,
                    carrier,
                    ownerStory,
                    'carrier_owner',
                    pageBindingProjection.byStoryId.get(ownerRoute.storyId)
                )
                : null;
            const ownerRouteUsesCarrierEntity = !!(ownerProjection
                && (carrier.mode !== 'new' || ownerProjection.canOwnNewCarrier));
            const mergedMaintainRoutes = carrier.mode === 'new'
                && ownerRouteUsesCarrierEntity
                && ownerProjection.sharesCarrierEntity
                ? objectRoutes.filter(route => this._resolveRouteProjectionForPageBinding(
                    route,
                    carrier,
                    storiesById.get(route.storyId) || {},
                    route.storyId === carrier.ownerStoryId ? 'carrier_owner' : 'carrier_consumer',
                    pageBindingProjection.byStoryId.get(route.storyId)
                ).sharesCarrierEntity)
                : [];
            const sceneRoute = ownerRouteUsesCarrierEntity
                ? (mergedMaintainRoutes.find(route => route.surface === 'independent') || ownerRoute)
                : null;
            const sceneStory = sceneRoute ? storiesById.get(sceneRoute.storyId) || {} : {};
            const sceneProjection = sceneRoute
                ? this._resolveRouteProjectionForPageBinding(
                    sceneRoute,
                    carrier,
                    sceneStory,
                    'carrier_owner',
                    pageBindingProjection.byStoryId.get(sceneRoute.storyId)
                )
                : null;
            const scene = sceneProjection
                ? sceneProjection.constructionSceneKey
                : (carrier.mode === 'new' ? 'backend_data_carrier' : '');
            linkedTable.needsPage = sceneProjection ? sceneProjection.needsPage : false;
            const relatedStoryIds = Array.from(new Set([
                carrier.mode === 'new' ? carrier.ownerStoryId : String(ownerRoute && ownerRoute.storyId || '').trim(),
                ...mergedMaintainRoutes.map(route => route.storyId),
                ...(pageBindingProjection.sharedStoryIdsByPagePrimaryObjectKey.get(carrier.objectKey) || [])
            ].filter(Boolean)));
            if (relatedStoryIds.length === 0) {
                issues.push(this._issue('DESIGN_MODEL_CARRIER_STORY_BINDING_MISSING', 'canonicalModel.carriers', `Carrier ${carrier.objectKey}无法绑定Requirement Story。`));
                return;
            }
            if (ownerRouteUsesCarrierEntity) routeConsumedByCarrier.add(ownerRoute.storyId);
            mergedMaintainRoutes.forEach(route => routeConsumedByCarrier.add(route.storyId));
            const carrierPatchRoutes = objectRoutes.filter(route => {
                if (routeConsumedByCarrier.has(route.storyId) || carrier.mode === 'none') return false;
                const projection = this._resolveRouteProjectionForPageBinding(
                    route,
                    carrier,
                    storiesById.get(route.storyId) || {},
                    'carrier_consumer',
                    pageBindingProjection.byStoryId.get(route.storyId)
                );
                return ['targeted_patch_only', 'existing_entry_patch'].includes(projection.constructionSceneKey);
            });
            carrierPatchRoutes.forEach(route => routeConsumedByCarrier.add(route.storyId));
            const boundRoutes = Array.from(new Map([
                ...(ownerRouteUsesCarrierEntity && ownerRoute ? [ownerRoute] : []),
                ...mergedMaintainRoutes,
                ...carrierPatchRoutes
            ].map(route => [route.storyId, route])).values());
            boundRoutes.forEach(route => {
                if (!relatedStoryIds.includes(route.storyId)) relatedStoryIds.push(route.storyId);
            });
            const entity = {
                entityKey: carrier.objectKey,
                displayName: object.displayName,
                businessObject: object.displayName,
                aggregateRoot: this._rootObjectKey(carrier.objectKey, relations),
                domain: this._domainForObject(carrier.objectKey, relations),
                relatedStoryIds,
                constructionSceneKey: scene || 'backend_data_carrier',
                linkedTable,
                constructionBindings: boundRoutes.map(route => this._constructionBindingForRoute(
                    route,
                    this._resolveRouteProjectionForPageBinding(
                        route,
                        carrier,
                        storiesById.get(route.storyId) || {},
                        route.storyId === carrier.ownerStoryId ? 'carrier_owner' : 'carrier_consumer',
                        pageBindingProjection.byStoryId.get(route.storyId)
                    ).constructionSceneKey,
                    carrier.objectKey,
                    carrier.mode
                )),
                practiceSceneKeys: this._practiceSceneKeys(linkedTable.businessColumns || []),
                managedProjection: true
            };
            const entityQueryFilters = this._queryFiltersForEntity(queryFilters, carrier.objectKey, relatedStoryIds);
            if (entityQueryFilters.issues.length > 0) {
                issues.push(...entityQueryFilters.issues);
                return;
            }
            if (entityQueryFilters.filters.length > 0) entity.queryFilters = entityQueryFilters.filters;
            const pageComposition = this._pageCompositionForEntity({
                entityObjectKey: carrier.objectKey,
                relatedStoryIds,
                pageCompositions,
                objectMap,
                fields,
                sharedStoryIdsByTargetStoryId: pageBindingProjection.sharedStoryIdsByTargetStoryId
            });
            if (pageComposition) entity.pageComposition = pageComposition;
            if (scene === 'rest_interface' && ownerRoute) {
                entity.restContract = this._restContractForRoute(ownerRoute, restOperations);
            }
            if (scene === 'statistics_analysis' && ownerStory.statisticsIntent) {
                entity.statisticsContract = this._normalizeStatisticsContractForModel(
                    ownerStory.statisticsIntent,
                    canonicalModel,
                    ownerRoute && ownerRoute.storyId
                );
                entity.statisticsContract = this._attachStatisticsSourceDependencies(
                    entity.statisticsContract,
                    statisticsSourceDependencies,
                    ownerRoute && ownerRoute.storyId
                );
            }
            if (scene === 'rest_interface' && ownerStory.statisticsIntent && ownerRoute) {
                entity.statisticsContracts = [{
                    storyId: ownerRoute.storyId,
                    ...this._normalizeStatisticsContractForModel(
                        ownerStory.statisticsIntent,
                        canonicalModel,
                        ownerRoute.storyId
                    )
                }];
                entity.statisticsContracts[0] = {
                    ...entity.statisticsContracts[0],
                    ...this._attachStatisticsSourceDependencies(
                        entity.statisticsContracts[0],
                        statisticsSourceDependencies,
                        ownerRoute.storyId
                    )
                };
            }
            if (scene === 'workflow_process' && ownerStory.workflowIntent) {
                entity.workflowContract = this._workflowContractForStory(
                    ownerStory,
                    canonicalModel.workflowOperationEvents,
                    ownerRoute && ownerRoute.storyId
                );
            }
            if (scene === 'rest_interface' && ownerStory.workflowIntent && ownerRoute) {
                entity.workflowContracts = [{
                    storyId: ownerRoute.storyId,
                    ...this._workflowContractForStory(ownerStory, canonicalModel.workflowOperationEvents, ownerRoute.storyId)
                }];
            }
            entityJudgments.push(entity);
        });

        const routeGroupByKey = new Map();
        routes.forEach(route => {
            if (routeConsumedByCarrier.has(route.storyId)) return;
            const object = objectMap.get(route.primaryObjectKey);
            const carrier = carrierMap.get(route.primaryObjectKey);
            if (!object || !carrier) return;
            const story = storiesById.get(route.storyId) || {};
            const routeProjection = this._resolveRouteProjection(route, carrier, story, 'carrier_consumer');
            const scene = routeProjection.constructionSceneKey;
            const groupKey = `${route.primaryObjectKey}::${scene}`;
            const existingGroup = routeGroupByKey.get(groupKey);
            if (existingGroup) {
                if (!existingGroup.relatedStoryIds.includes(route.storyId)) existingGroup.relatedStoryIds.push(route.storyId);
                const groupFilters = this._queryFiltersForEntity(queryFilters, carrier.objectKey, existingGroup.relatedStoryIds);
                if (groupFilters.filters.length > 0) existingGroup.queryFilters = groupFilters.filters;
                issues.push(...groupFilters.issues);
                existingGroup.constructionBindings.push(this._constructionBindingForRoute(
                    route,
                    scene,
                    carrier.objectKey,
                    carrier.mode
                ));
                if (scene === 'rest_interface') {
                    const next = this._restContractForRoute(route, restOperations);
                    const restMerge = this._mergeRestOperationProjections(
                        existingGroup.restContract.operations,
                        next.operations
                    );
                    existingGroup.restContract.operations = restMerge.operations;
                    issues.push(...restMerge.issues);
                }
                if (['statistics_analysis', 'rest_interface'].includes(scene) && story.statisticsIntent) {
                    if (!Array.isArray(existingGroup.statisticsContracts)) existingGroup.statisticsContracts = [];
                    existingGroup.statisticsContracts.push({
                        storyId: route.storyId,
                        ...this._normalizeStatisticsContractForModel(story.statisticsIntent, canonicalModel, route.storyId)
                    });
                    existingGroup.statisticsContracts[existingGroup.statisticsContracts.length - 1] = {
                        ...existingGroup.statisticsContracts[existingGroup.statisticsContracts.length - 1],
                        ...this._attachStatisticsSourceDependencies(
                            existingGroup.statisticsContracts[existingGroup.statisticsContracts.length - 1],
                            statisticsSourceDependencies,
                            route.storyId
                        )
                    };
                    delete existingGroup.statisticsContract;
                }
                if (['workflow_process', 'rest_interface'].includes(scene) && story.workflowIntent) {
                    if (!Array.isArray(existingGroup.workflowContracts)) existingGroup.workflowContracts = [];
                    existingGroup.workflowContracts.push({
                        storyId: route.storyId,
                        ...this._workflowContractForStory(story, canonicalModel.workflowOperationEvents, route.storyId)
                    });
                    delete existingGroup.workflowContract;
                }
                return;
            }
            const entityKey = this._uniqueRouteEntityKey(route, scene, entityJudgments);
            let linkedTable;
            let carriedByEntityKey = '';
            if (carrier.mode === 'new') {
                linkedTable = { kind: 'none', needsPage: routeProjection.needsPage };
                carriedByEntityKey = carrier.objectKey;
            } else {
                linkedTable = this._linkedTableForCarrier(carrier, object, fields, relations, objectMap);
                linkedTable.needsPage = routeProjection.needsPage;
            }
            const entity = {
                entityKey,
                displayName: `${object.displayName}${this._routeLabel(route.capability)}`,
                businessObject: object.displayName,
                aggregateRoot: this._rootObjectKey(route.primaryObjectKey, relations),
                domain: this._domainForObject(route.primaryObjectKey, relations),
                relatedStoryIds: [route.storyId],
                constructionSceneKey: scene,
                linkedTable,
                constructionBindings: [this._constructionBindingForRoute(
                    route,
                    scene,
                    carrier.objectKey,
                    carrier.mode
                )],
                ...(carriedByEntityKey ? { carriedByEntityKey } : {}),
                managedProjection: true
            };
            if (scene === 'rest_interface') {
                entity.restContract = this._restContractForRoute(route, restOperations);
            }
            if (['statistics_analysis', 'rest_interface'].includes(scene) && story.statisticsIntent) {
                entity.statisticsContracts = [{
                    storyId: route.storyId,
                    ...this._normalizeStatisticsContractForModel(story.statisticsIntent, canonicalModel, route.storyId)
                }];
                entity.statisticsContracts[0] = {
                    ...entity.statisticsContracts[0],
                    ...this._attachStatisticsSourceDependencies(
                        entity.statisticsContracts[0],
                        statisticsSourceDependencies,
                        route.storyId
                    )
                };
            }
            if (['workflow_process', 'rest_interface'].includes(scene) && story.workflowIntent) {
                entity.workflowContracts = [{
                    storyId: route.storyId,
                    ...this._workflowContractForStory(story, canonicalModel.workflowOperationEvents, route.storyId)
                }];
            }
            const routeFilters = this._queryFiltersForEntity(queryFilters, carrier.objectKey, [route.storyId]);
            if (routeFilters.filters.length > 0) entity.queryFilters = routeFilters.filters;
            entityJudgments.push(entity);
            routeGroupByKey.set(groupKey, entity);
        });

        if (issues.length > 0) return this._blocked('DESIGN_MODEL_BUILDER_PROJECTION_INVALID', issues);
        return {
            ok: true,
            entityJudgments,
            tableCandidateFitDecisions: this._candidateFitDecisions(canonicalModel, entityJudgments),
            canonicalModel: JSON.parse(JSON.stringify(canonicalModel)),
            allowSharedStoryIds: true,
            managedProjection: true
        };
    }

    _queryFiltersForEntity(queryFilters = [], objectKey = '', relatedStoryIds = []) {
        const filters = [];
        const byInputKey = new Map();
        const storyIds = new Set((Array.isArray(relatedStoryIds) ? relatedStoryIds : []).map(item => String(item || '').trim()).filter(Boolean));
        const issues = [];
        (Array.isArray(queryFilters) ? queryFilters : []).forEach(filter => {
            if (!filter || String(filter.primaryObjectKey || filter.objectKey || '').trim() !== objectKey || !storyIds.has(String(filter.storyId || '').trim())) return;
            const normalized = {
                ...filter,
                storyId: String(filter.storyId || '').trim(),
                inputKey: String(filter.inputKey || '').trim(),
                objectKey: filter.objectKey,
                fieldName: String(filter.fieldName || '').trim(),
                operator: String(filter.operator || '').trim(),
                normalize: String(filter.normalize || '').trim()
            };
            const existing = byInputKey.get(normalized.inputKey);
            const contract = JSON.stringify({
                objectKey: normalized.objectKey,
                fieldName: normalized.fieldName,
                operator: normalized.operator,
                normalize: normalized.normalize
            });
            if (existing && existing.contract !== contract) {
                issues.push(this._issue(
                    'DESIGN_MODEL_QUERY_FILTER_SURFACE_CONFLICT',
                    'canonicalModel.queryFilters',
                    `共享列表输入 ${normalized.inputKey} 被多个Story声明为不等价查询合同。`,
                    { inputKey: normalized.inputKey, storyIds: [existing.filter.storyId, normalized.storyId] }
                ));
                return;
            }
            if (!existing) {
                byInputKey.set(normalized.inputKey, { contract, filter: normalized });
                filters.push(normalized);
            }
        });
        return { filters, issues };
    }

    _linkedTableForCarrier(carrier, object, fields, relations, objectMap) {
        if (carrier.mode === 'reuse') return { kind: 'reuse', tableName: carrier.tableName, needsPage: false };
        if (carrier.mode === 'none') return { kind: 'none', needsPage: false };
        const businessColumns = fields
            .filter(field => field.objectKey === carrier.objectKey)
            .map(field => {
                const column = {
                    name: field.name,
                    type: field.type,
                    length: field.length,
                    required: field.required === true,
                    comment: field.comment
                };
                if (field.codeItem) {
                    column.codeItem = field.codeItem;
                    column.codeItemDefinition = JSON.parse(JSON.stringify(field.codeItemDefinition));
                }
                if (field.attachmentKey === true) {
                    column.attachmentKey = true;
                    column.attachmentLabel = field.attachmentLabel;
                }
                return column;
            });
        relations.filter(relation => relation.childObjectKey === carrier.objectKey).forEach(relation => {
            const parent = objectMap.get(relation.parentObjectKey);
            const name = `${this._toPathSegment(relation.parentObjectKey)}rowguid`;
            if (!businessColumns.some(column => column.name === name)) {
                businessColumns.push({
                    name,
                    type: 'VARCHAR',
                    length: '50',
                    required: true,
                    comment: `关联${String(parent && parent.displayName || relation.parentObjectKey)}rowguid`,
                    relationRef: relation.relationKey
                });
            }
        });
        return {
            kind: 'new',
            needsPage: false,
            tableComment: `${object.displayName}表`,
            tableFeatureName: carrier.objectKey,
            businessColumns
        };
    }

    _candidateFitDecisions(model, entities) {
        const candidates = this._candidateNames(model.confirmedTableCandidates || []);
        const allStoryIds = Array.from(new Set((Array.isArray(model.storyRoutes) ? model.storyRoutes : [])
            .map(route => String(route && route.storyId || '').trim().toUpperCase())
            .filter(Boolean)));
        return candidates.map(tableName => {
            const matched = entities.filter(entity => entity.linkedTable && entity.linkedTable.kind === 'reuse'
                && String(entity.linkedTable.tableName || '').toUpperCase() === tableName.toUpperCase());
            const entityKeys = matched.map(item => item.entityKey);
            const coveredStoryIds = Array.from(new Set(matched.flatMap(item => item.relatedStoryIds || [])));
            const coveredStoryIdSet = new Set(coveredStoryIds);
            const reused = matched.length > 0;
            return {
                tableName,
                decision: reused
                    ? (entityKeys.length > 1 || coveredStoryIds.length > 1 ? 'reuse_for_story_group' : 'reuse_for_entity')
                    : 'not_applicable',
                fitReason: reused
                    ? `Canonical Carrier 已确认由 ${entityKeys.join(', ')} 复用候选表 ${tableName}。`
                    : `Canonical Carrier 未选择候选表 ${tableName} 作为本次业务承载。`,
                entityKeys,
                coveredStoryIds,
                weakRelatedStoryIds: [],
                nonCoveredStoryIds: allStoryIds.filter(storyId => !coveredStoryIdSet.has(storyId)),
                usages: matched.flatMap(entity => (entity.relatedStoryIds || []).map(storyId => ({
                    storyId,
                    usageType: 'data_carrier',
                    entityKey: entity.entityKey,
                    reason: `Story ${storyId} 通过 Canonical Carrier 复用 ${tableName}。`
                })))
            };
        });
    }

    _resolveRouteProjection(route = {}, carrier = {}, story = {}, role = 'carrier_consumer') {
        const ownsNewCarrier = role === 'carrier_owner' && carrier.mode === 'new';
        const effectiveCarrierMode = carrier.mode === 'new' && !ownsNewCarrier ? 'none' : carrier.mode;
        const requirementSceneLock = String(route.requirementSceneLock || this._requirementSceneLock(story) || '').trim();
        const hasExistingEntry = !!(story && story.existingAdjustment
            && Array.isArray(story.existingAdjustment.entryFiles)
            && story.existingAdjustment.entryFiles.length > 0);
        const constructionSceneKey = this._constructionScene(route, effectiveCarrierMode, story);
        return {
            role,
            constructionSceneKey,
            needsPage: this._projectionNeedsPage(constructionSceneKey, route),
            canOwnNewCarrier: sceneSupportsLinkedTableKind(constructionSceneKey, 'new'),
            sharesCarrierEntity: carrier.mode === 'new'
                && route.capability === 'maintain'
                && !requirementSceneLock
                && !hasExistingEntry
        };
    }

    _constructionScene(route = {}, carrierMode = '', story = {}) {
        const locked = String(route.requirementSceneLock || this._requirementSceneLock(story) || '').trim();
        if (locked) return locked;
        const capability = String(route.capability || '').trim();
        const surface = String(route.surface || '').trim();
        const hasExistingEntry = !!(story && story.existingAdjustment
            && Array.isArray(story.existingAdjustment.entryFiles)
            && story.existingAdjustment.entryFiles.length > 0);
        if (capability === 'configure') return 'configuration_only';
        if (capability === 'job') return 'scheduled_job';
        if (capability === 'query') {
            if (route.querySurface && route.querySurface.mode === 'reuse_carrier_list') {
                return carrierMode === 'none' ? 'query_result_entry' : 'targeted_patch_only';
            }
            return surface === 'none' ? 'targeted_patch_only' : 'query_result_entry';
        }
        if (capability === 'action') {
            if (hasExistingEntry) return surface === 'independent' ? 'mixed_prepare_then_patch' : 'existing_entry_patch';
            return surface === 'independent' ? 'query_result_entry' : 'targeted_patch_only';
        }
        if (capability === 'maintain') {
            if (hasExistingEntry) return carrierMode === 'new' || surface === 'independent'
                ? 'mixed_prepare_then_patch'
                : 'existing_entry_patch';
            if (carrierMode === 'new') return surface === 'independent' ? 'crud_new_full' : 'backend_data_carrier';
            return surface === 'independent' ? 'query_result_entry' : 'targeted_patch_only';
        }
        return '';
    }

    _requirementSceneLock(story = {}) {
        return this.projectRequirementObligations(story).constructionSceneKey;
    }

    projectRequirementObligations(story = {}) {
        const requiresRestDelivery = this._requiresRestDelivery(story);
        const businessMechanisms = [
            ...(story && story.workflowIntent ? ['workflow_process'] : []),
            ...(story && story.statisticsIntent ? ['statistics_analysis'] : [])
        ];
        return {
            requiresRestDelivery,
            deliverySceneKey: requiresRestDelivery ? 'rest_interface' : '',
            businessMechanisms,
            constructionSceneKey: requiresRestDelivery ? 'rest_interface' : (businessMechanisms[0] || '')
        };
    }

    _workflowOperationsByStory(storiesById = new Map()) {
        const operations = new Map();
        storiesById.forEach(story => {
            const storyId = this._storyId(story);
            const intent = story && story.workflowIntent;
            const activities = intent && Array.isArray(intent.activities) ? intent.activities : [];
            activities.forEach((activity, activityIndex) => {
                const activityName = String(activity && activity.name || '').trim();
                const activityKey = String(activity && activity.key || '').trim()
                    || this._stableWorkflowKey('activity', `${storyId}|${activityName}|${activity && activity.actor || ''}|${activityIndex}`);
                const rawOperations = activity && Array.isArray(activity.operations) ? activity.operations : [];
                rawOperations.forEach((rawOperation, operationIndex) => {
                    const operation = rawOperation && typeof rawOperation === 'object'
                        ? rawOperation
                        : { name: String(rawOperation || '').trim() };
                    const operationName = String(operation.name || '').trim();
                    const operationKey = String(operation.key || '').trim()
                        || this._stableWorkflowKey('operation', `${storyId}|${activityKey}|${operationName}|${operation.semantic || ''}|${operationIndex}`);
                    if (!storyId || !operationName || !operationKey) return;
                    operations.set(`${storyId}::${operationKey}`, {
                        storyId,
                        operationKey,
                        activityKey,
                        activityName,
                        operationName,
                        semantic: String(operation.semantic || operation.actionType || '').trim().toLowerCase(),
                        expectedShape: `WORKFLOW_EVENT|${storyId}|${operationKey}|none|-|-|- 或 WORKFLOW_EVENT|${storyId}|${operationKey}|service_method|<methodName>|<业务效果>|pviguid=$PVI_GUID:流程实例标识,...`
                    });
                });
            });
        });
        return operations;
    }

    _workflowContractForStory(story = {}, workflowOperationEvents = [], storyId = '') {
        const contract = story && story.workflowIntent && typeof story.workflowIntent === 'object'
            ? JSON.parse(JSON.stringify(story.workflowIntent))
            : {};
        const events = (Array.isArray(workflowOperationEvents) ? workflowOperationEvents : [])
            .filter(item => !storyId || String(item && item.storyId || '').trim().toUpperCase() === String(storyId || '').trim().toUpperCase())
            .map(item => JSON.parse(JSON.stringify(item)));
        if (events.length > 0) {
            contract.operationEvents = events;
            const seeds = [];
            const seen = new Set();
            events.filter(item => item.mode === 'service_method').forEach(item => {
                const signature = `${item.methodName}::${(item.parameters || []).map(parameter => parameter.name).join(',')}`;
                if (seen.has(signature)) return;
                seen.add(signature);
                seeds.push({
                    storyId: item.storyId,
                    operationKey: item.operationKey,
                    activityName: item.activityName,
                    operationName: item.operationName,
                    methodName: item.methodName,
                    businessEffect: item.businessEffect,
                    parameters: (item.parameters || []).map(parameter => ({ ...parameter }))
                });
            });
            contract.workflowExternalMethodSeeds = seeds;
        }
        return contract;
    }

    _stableWorkflowKey(prefix, seed) {
        return `${prefix}_${crypto.createHash('sha256').update(String(seed || ''), 'utf8').digest('hex').slice(0, 10)}`;
    }

    _requiresRestDelivery(story = {}) {
        const rawBoundary = story && story.deliveryBoundary;
        const boundary = typeof rawBoundary === 'string'
            ? rawBoundary
            : String(rawBoundary && (rawBoundary.mode || rawBoundary.kind || rawBoundary.value) || '');
        const normalizedBoundary = boundary.trim().toLowerCase();
        if (['rest_interface', 'external_team_ui', 'inbound_system_api'].includes(normalizedBoundary)) return true;
        const codingFacts = Array.isArray(story && story.codingFactHandoff) ? story.codingFactHandoff : [];
        const hasRestBoundaryFact = codingFacts.some(item => [
            'delivery_boundary.rest_interface',
            'external_delivery.rest_interface',
            'delivery_boundary.external_team_ui',
            'delivery_boundary.inbound_system_api'
        ].includes(String(item && item.factType || '').trim().toLowerCase()));
        return hasRestBoundaryFact;
    }

    _deliveryBoundaryProjectionIssues(model = {}, requirementStories = {}) {
        const issues = [];
        const compositions = Array.isArray(model.pageCompositions) ? model.pageCompositions : [];
        const restOperations = Array.isArray(model.restOperations) ? model.restOperations : [];
        const apiBoundaries = new Set(['rest_interface', 'external_team_ui', 'inbound_system_api']);
        const nonApiBoundaries = new Set(['current_team_ui', 'outbound_external_api', 'no_ui']);
        this._stories(requirementStories).forEach(story => {
            const storyId = this._storyId(story);
            const raw = story && story.deliveryBoundary;
            const boundary = (typeof raw === 'string'
                ? raw
                : String(raw && (raw.mode || raw.kind || raw.value) || '')).trim().toLowerCase();
            if (!boundary) return;
            const storyCompositions = compositions.filter(item => item.storyId === storyId);
            const storyRestOperations = restOperations.filter(item => item.storyId === storyId);
            if (apiBoundaries.has(boundary) && storyCompositions.length > 0) {
                issues.push(this._issue(
                    'DESIGN_MODEL_DELIVERY_BOUNDARY_PAGE_CONFLICT',
                    `stories.${storyId}.deliveryBoundary`,
                    `${storyId}声明${boundary}，但COMPOSE同时声明本系统页面义务；两份独立业务合同冲突。`
                ));
            }
            if (apiBoundaries.has(boundary) && storyRestOperations.length === 0) {
                issues.push(this._issue(
                    'DESIGN_MODEL_DELIVERY_BOUNDARY_REST_MISSING',
                    `stories.${storyId}.deliveryBoundary`,
                    `${storyId}声明${boundary}，但没有独立REST业务操作合同。`
                ));
            }
            if (nonApiBoundaries.has(boundary) && storyRestOperations.length > 0) {
                issues.push(this._issue(
                    'DESIGN_MODEL_DELIVERY_BOUNDARY_REST_CONFLICT',
                    `stories.${storyId}.deliveryBoundary`,
                    `${storyId}声明${boundary}，但REST行同时声明本系统对外接口义务。`
                ));
            }
        });
        return issues;
    }

    _projectionNeedsPage(scene, route = {}) {
        const mode = getNeedsPageMode(scene);
        if (mode === 'required') return true;
        if (mode === 'forbidden') return false;
        if (mode === 'conditional') return String(route.surface || '').trim() === 'independent';
        return false;
    }

    _restContractForRoute(route, operations) {
        const selected = operations.filter(item => item.storyId === route.storyId);
        return {
            basePath: this._toPathSegment(route.primaryObjectKey),
            operations: selected.map(item => ({
                operationKey: item.operationKey,
                methodName: this._toLowerCamel(item.operationKey),
                path: `/${this._toPathSegment(item.operationKey)}`,
                httpMethod: 'POST',
                purpose: item.purpose,
                requestShape: item.requestShape,
                responseShape: item.responseShape,
                sourceStoryIds: [item.storyId]
            }))
        };
    }

    _mergeRestOperationProjections(existingOperations = [], incomingOperations = []) {
        const merged = [];
        const operationByMethod = new Map();
        const operationByRoute = new Map();
        const issues = [];
        [...existingOperations, ...incomingOperations].forEach(operation => {
            const methodKey = String(operation.methodName || '').trim();
            const routeKey = JSON.stringify([
                String(operation.httpMethod || 'POST').trim().toUpperCase(),
                String(operation.path || '').trim()
            ]);
            const contractKey = JSON.stringify([
                operation.operationKey,
                operation.methodName,
                operation.httpMethod,
                operation.path,
                operation.requestShape,
                operation.responseShape
            ]);
            const collisions = Array.from(new Set([
                operationByMethod.get(methodKey),
                operationByRoute.get(routeKey)
            ].filter(Boolean)));
            const conflictingProjection = collisions.find(item => item.contractKey !== contractKey);
            const existingProjection = collisions.find(item => item.contractKey === contractKey);
            if (conflictingProjection) {
                const existingSourceStoryIds = Array.isArray(conflictingProjection.operation.sourceStoryIds)
                    ? conflictingProjection.operation.sourceStoryIds
                    : [];
                issues.push(this._issue(
                    'DESIGN_MODEL_BUILDER_PROJECTION_CONFLICT',
                    'entityJudgments.restContract.operations',
                    `REST操作${operation.methodName}(${operation.httpMethod} ${operation.path})与已有操作投影到同一Java方法或HTTP路由，但业务合同不一致。`,
                    {
                        projectionIdentity: {
                            methodName: operation.methodName,
                            httpMethod: operation.httpMethod,
                            path: operation.path
                        },
                        sourceStoryIds: Array.from(new Set([
                            ...existingSourceStoryIds,
                            ...(Array.isArray(operation.sourceStoryIds) ? operation.sourceStoryIds : [])
                        ].filter(Boolean)))
                    }
                ));
                return;
            }
            if (!existingProjection) {
                const copy = {
                    ...operation,
                    sourceStoryIds: Array.from(new Set(Array.isArray(operation.sourceStoryIds)
                        ? operation.sourceStoryIds.filter(Boolean)
                        : []))
                };
                const projection = { contractKey, operation: copy };
                operationByMethod.set(methodKey, projection);
                operationByRoute.set(routeKey, projection);
                merged.push(copy);
                return;
            }
            const existing = existingProjection.operation;
            existing.sourceStoryIds = Array.from(new Set([
                ...(Array.isArray(existing.sourceStoryIds) ? existing.sourceStoryIds : []),
                ...(Array.isArray(operation.sourceStoryIds) ? operation.sourceStoryIds : [])
            ].filter(Boolean)));
        });
        return { operations: merged, issues };
    }

    _practiceSceneKeys(columns) {
        const keys = [];
        if (columns.some(column => column.codeItem)) keys.push('code_item');
        if (columns.some(column => column.attachmentKey === true)) keys.push('attachment_preview_download');
        return keys;
    }

    _codeItemDefinitionSignature(definition = {}) {
        const mode = String(definition && definition.mode || '').trim();
        if (mode === 'reuse') {
            return JSON.stringify({ mode, sourceRef: String(definition.sourceRef || '').trim() });
        }
        return JSON.stringify({
            mode,
            codes: (Array.isArray(definition && definition.codes) ? definition.codes : []).map(code => ({
                codeValue: String(code && code.codeValue || '').trim(),
                codeLabel: String(code && code.codeLabel || '').trim(),
                order: Number(code && code.order || 0)
            }))
        });
    }

    _isIntegerFieldType(type = '') {
        return /^(TINYINT|SMALLINT|MEDIUMINT|INT|INTEGER|BIGINT|INT2|INT4|INT8)$/u
            .test(String(type || '').trim().toUpperCase());
    }

    _compilePageBindings({ pageBindings = [], compositions = [], routes = [], requirementStoryIds = new Set() } = {}) {
        const issues = [];
        const normalized = [];
        const seen = new Set();
        const routeMap = new Map((Array.isArray(routes) ? routes : [])
            .map(route => [String(route && route.storyId || '').trim().toUpperCase(), route])
            .filter(([storyId, route]) => storyId && route));
        const compositionMap = new Map((Array.isArray(compositions) ? compositions : [])
            .map(composition => [String(composition && composition.storyId || '').trim().toUpperCase(), composition])
            .filter(([storyId, composition]) => storyId && composition));

        (Array.isArray(pageBindings) ? pageBindings : []).forEach(item => {
            const rowPath = `compositionRows[${item.rowIndex}]`;
            const storyId = String(item && item.storyId || '').trim().toUpperCase();
            const mode = String(item && item.mode || '').trim().toLowerCase();
            const targetStoryId = String(item && item.targetStoryId || '').trim().toUpperCase();
            const route = routeMap.get(storyId);
            if (!requirementStoryIds.has(storyId) || !route) {
                issues.push(this._issue(
                    'DESIGN_MODEL_PAGE_BIND_STORY_NOT_FOUND',
                    `${rowPath}.storyId`,
                    `PAGE_BIND的Story ${storyId || '(empty)'}没有已声明STORY行。`,
                    { allowedStoryIds: Array.from(requirementStoryIds) }
                ));
                return;
            }
            if (route.capability !== 'maintain') {
                issues.push(this._issue(
                    'DESIGN_MODEL_PAGE_BIND_CAPABILITY_INVALID',
                    `${rowPath}.storyId`,
                    `PAGE_BIND只表达maintain Story的页面归属；${storyId}=${route.capability}。query入口继续使用QUERY_SURFACE合同。`,
                    { allowedCapabilities: ['maintain'] }
                ));
                return;
            }
            const key = `${storyId}:${mode}:${mode === 'shared' ? targetStoryId : 'self'}`;
            if (seen.has(key)) {
                issues.push(this._issue('DESIGN_MODEL_PAGE_BIND_DUPLICATED', rowPath, `PAGE_BIND ${key}重复。`));
                return;
            }
            seen.add(key);
            if (mode === 'independent') {
                normalized.push({ storyId, mode: 'independent', target: 'self' });
                return;
            }
            if (targetStoryId === storyId) {
                issues.push(this._issue(
                    'DESIGN_MODEL_PAGE_BIND_SHARED_SELF_REFERENCE',
                    `${rowPath}.target`,
                    `Story ${storyId}不能shared到自身；保留自己的页面请使用PAGE_BIND|${storyId}|independent|self。`
                ));
                return;
            }
            if (!requirementStoryIds.has(targetStoryId) || !routeMap.has(targetStoryId)) {
                issues.push(this._issue(
                    'DESIGN_MODEL_PAGE_BIND_TARGET_STORY_NOT_FOUND',
                    `${rowPath}.target`,
                    `shared目标Story ${targetStoryId || '(empty)'}不存在。`,
                    { allowedStoryIds: Array.from(requirementStoryIds).filter(value => value !== storyId) }
                ));
                return;
            }
            const targetComposition = compositionMap.get(targetStoryId);
            if (!targetComposition) {
                issues.push(this._issue(
                    'DESIGN_MODEL_PAGE_BIND_TARGET_COMPOSITION_MISSING',
                    `${rowPath}.target`,
                    `shared目标Story ${targetStoryId}缺少COMPOSE行；PAGE_BIND只能指向本次已声明页面。`,
                    { expectedShape: `COMPOSE|${targetStoryId}|plain/accordion|...|...` }
                ));
                return;
            }
            const representedBlocks = (Array.isArray(targetComposition.blocks) ? targetComposition.blocks : [])
                .filter(block => block && block.objectKey === route.primaryObjectKey);
            if (representedBlocks.length === 0) {
                issues.push(this._issue(
                    'DESIGN_MODEL_PAGE_BIND_OBJECT_NOT_REPRESENTED',
                    `${rowPath}.target`,
                    `目标页面${targetStoryId}没有承载Story ${storyId}的对象${route.primaryObjectKey}。`,
                    { requiredObjectKey: route.primaryObjectKey, targetComposeStoryId: targetStoryId }
                ));
                return;
            }
            if (!representedBlocks.some(block => block.kind === 'child_edit')) {
                issues.push(this._issue(
                    'DESIGN_MODEL_PAGE_BIND_INTERACTION_CONFLICT',
                    `${rowPath}.target`,
                    `maintain Story ${storyId}只能共享到${targetStoryId}中承载其对象的child_edit块；form同对象Story由稳定页面身份机械归并，child_readonly不承载维护。`,
                    { allowedBlockKinds: ['child_edit'] }
                ));
                return;
            }
            normalized.push({ storyId, mode: 'shared', targetStoryId });
        });

        const boundStoryIds = new Set(normalized.map(binding => binding.storyId));
        const candidateTargetsByStoryId = new Map();
        (Array.isArray(compositions) ? compositions : []).forEach(composition => {
            (Array.isArray(composition && composition.blocks) ? composition.blocks : [])
                .filter(block => block && block.kind === 'child_edit')
                .forEach(block => {
                    (Array.isArray(routes) ? routes : [])
                        .filter(route => DesignModelCompiler.isManagedPageRoute(route)
                            && route.capability === 'maintain'
                            && route.primaryObjectKey === block.objectKey
                            && route.storyId !== composition.storyId)
                        .forEach(route => {
                            const storyId = String(route.storyId || '').trim().toUpperCase();
                            const targets = candidateTargetsByStoryId.get(storyId) || [];
                            if (!targets.includes(composition.storyId)) targets.push(composition.storyId);
                            candidateTargetsByStoryId.set(storyId, targets);
                        });
                });
        });
        candidateTargetsByStoryId.forEach((targetStoryIds, storyId) => {
            if (boundStoryIds.has(storyId)) return;
            issues.push(this._issue(
                'DESIGN_MODEL_PAGE_BINDING_MISSING',
                'compositionRows',
                `Story ${storyId}的维护对象已进入其它Story页面，必须明确选择共享、独立或两者并存。`,
                {
                    storyId,
                    targetComposeStoryIds: targetStoryIds,
                    allowedShapes: [
                        ...targetStoryIds.map(targetStoryId => `PAGE_BIND|${storyId}|shared|${targetStoryId}`),
                        `PAGE_BIND|${storyId}|independent|self`
                    ]
                }
            ));
        });
        return issues.length > 0 ? { ok: false, issues } : { ok: true, pageBindings: normalized };
    }

    _pageBindingProjection(pageBindings = [], pageCompositions = []) {
        const byStoryId = new Map();
        const sharedStoryIdsByTargetStoryId = new Map();
        const sharedStoryIdsByPagePrimaryObjectKey = new Map();
        const addUnique = (target, values = []) => {
            values.forEach(value => {
                const normalized = String(value || '').trim().toUpperCase();
                if (normalized && !target.includes(normalized)) target.push(normalized);
            });
        };
        const compositionByStoryId = new Map((Array.isArray(pageCompositions) ? pageCompositions : [])
            .map(composition => [String(composition && composition.storyId || '').trim().toUpperCase(), composition])
            .filter(([storyId, composition]) => storyId && composition));
        (Array.isArray(pageBindings) ? pageBindings : []).forEach(binding => {
            const storyId = String(binding && binding.storyId || '').trim().toUpperCase();
            if (!storyId) return;
            const projected = byStoryId.get(storyId) || { storyId, independent: false, sharedTargetStoryIds: [] };
            if (binding.mode === 'independent') projected.independent = true;
            if (binding.mode === 'shared') {
                const targetStoryId = String(binding.targetStoryId || '').trim().toUpperCase();
                addUnique(projected.sharedTargetStoryIds, [targetStoryId]);
                const targetStories = sharedStoryIdsByTargetStoryId.get(targetStoryId) || [];
                addUnique(targetStories, [storyId]);
                sharedStoryIdsByTargetStoryId.set(targetStoryId, targetStories);
                const targetComposition = compositionByStoryId.get(targetStoryId) || {};
                const primaryObjectKey = String(targetComposition.primaryObjectKey || '').trim();
                if (primaryObjectKey) {
                    const pageStories = sharedStoryIdsByPagePrimaryObjectKey.get(primaryObjectKey) || [];
                    addUnique(pageStories, [storyId]);
                    sharedStoryIdsByPagePrimaryObjectKey.set(primaryObjectKey, pageStories);
                }
            }
            byStoryId.set(storyId, projected);
        });
        return { byStoryId, sharedStoryIdsByTargetStoryId, sharedStoryIdsByPagePrimaryObjectKey };
    }

    _resolveRouteProjectionForPageBinding(route = {}, carrier = {}, story = {}, role = 'carrier_consumer', pageBinding = null) {
        const base = this._resolveRouteProjection(route, carrier, story, role);
        if (!pageBinding
            || pageBinding.independent === true
            || !Array.isArray(pageBinding.sharedTargetStoryIds)
            || pageBinding.sharedTargetStoryIds.length === 0) {
            return base;
        }
        if (carrier.mode === 'new') {
            return {
                ...base,
                constructionSceneKey: 'backend_data_carrier',
                needsPage: false,
                canOwnNewCarrier: true,
                sharesCarrierEntity: false
            };
        }
        return {
            ...base,
            constructionSceneKey: 'targeted_patch_only',
            needsPage: false,
            canOwnNewCarrier: false,
            sharesCarrierEntity: false
        };
    }

    _pageCompositionForEntity({ entityObjectKey = '', relatedStoryIds = [], pageCompositions = [], objectMap = new Map(), fields = [], sharedStoryIdsByTargetStoryId = new Map() } = {}) {
        const storySet = new Set((Array.isArray(relatedStoryIds) ? relatedStoryIds : []).map(item => String(item || '').trim().toUpperCase()));
        // 页面/Action归业务入口对象；formObjectKey可以是沿关系可达的版本或明细承载对象。
        const selected = (Array.isArray(pageCompositions) ? pageCompositions : []).filter(item =>
            item && item.primaryObjectKey === entityObjectKey && storySet.has(String(item.storyId || '').trim().toUpperCase())
        );
        if (selected.length === 0) return null;
        const sectionFieldRefs = new Set(selected.flatMap(item =>
            (Array.isArray(item.sections) ? item.sections : []).flatMap(section =>
                Array.isArray(section && section.fieldRefs) ? section.fieldRefs : []
            )
        ));
        const blocks = [];
        const seen = new Set();
        selected.forEach(item => (Array.isArray(item.blocks) ? item.blocks : []).forEach(block => {
            const key = `${block.kind}:${block.objectKey}`;
            if (seen.has(key)) return;
            seen.add(key);
            const object = objectMap.get(block.objectKey) || {};
            blocks.push({
                kind: block.kind,
                objectKey: block.objectKey,
                displayName: String(object.displayName || block.objectKey).trim(),
                relationPath: Array.isArray(block.relationPath) ? block.relationPath.slice() : []
            });
        }));
        const representedObjects = new Set(blocks.map(block => block.objectKey));
        representedObjects.forEach(objectKey => {
            if (objectKey !== entityObjectKey) return;
            const attachmentFields = (Array.isArray(fields) ? fields : []).filter(field =>
                field && field.objectKey === objectKey && field.attachmentKey === true
                    && !sectionFieldRefs.has(`${objectKey}.${field.name}`)
            );
            if (attachmentFields.length === 0) return;
            const object = objectMap.get(objectKey) || {};
            blocks.push({
                kind: 'attachment',
                objectKey,
                displayName: `${String(object.displayName || objectKey).trim()}附件`,
                relationPath: [],
                fieldRefs: attachmentFields.map(field => `${objectKey}.${field.name}`)
            });
        });
        const practiceIds = [];
        const addPractice = value => { if (value && !practiceIds.includes(value)) practiceIds.push(value); };
        blocks.forEach(block => {
            if (block.kind === 'form') addPractice('GP-01');
            if (block.kind === 'child_edit' || block.kind === 'child_readonly') {
                addPractice('GP-05');
                if (block.kind === 'child_edit') addPractice('BP-12');
            }
            if (block.kind === 'attachment') addPractice('GP-08');
        });
        if ((Array.isArray(fields) ? fields : []).some(field =>
            field && field.attachmentKey === true && sectionFieldRefs.has(`${field.objectKey}.${field.name}`)
        )) addPractice('GP-08');
        const layouts = Array.from(new Set(selected.map(item => String(item.layout || '').trim()).filter(Boolean)));
        const layout = layouts[0] || '';
        if (layout === 'accordion') addPractice('BP-11');
        const decisionTags = Array.from(new Set(selected.flatMap(item => Array.isArray(item.decisionTags) ? item.decisionTags : [])));
        const sections = [];
        const seenSections = new Set();
        selected.forEach(item => (Array.isArray(item.sections) ? item.sections : []).forEach(section => {
            const key = String(section && section.sectionKey || '').trim();
            if (!key || seenSections.has(key)) return;
            seenSections.add(key);
            sections.push({
                sectionKey: key,
                title: String(section.title || '').trim(),
                fieldRefs: Array.isArray(section.fieldRefs) ? section.fieldRefs.slice() : []
            });
        }));
        const primaryObjectKey = String(selected[0] && selected[0].primaryObjectKey || '').trim();
        const formObjectKey = String(selected[0] && selected[0].formObjectKey || '').trim();
        const compositionStoryIds = Array.from(new Set([
            ...selected.map(item => item.storyId),
            ...selected.flatMap(item => sharedStoryIdsByTargetStoryId.get(String(item.storyId || '').trim().toUpperCase()) || [])
        ].map(item => String(item || '').trim().toUpperCase()).filter(Boolean)));
        return {
            schemaVersion: 'page-composition/v2',
            managedProjection: true,
            storyIds: compositionStoryIds,
            primaryObjectKey,
            formObjectKey,
            layout,
            blocks,
            sections,
            decisionTags,
            practiceIds
        };
    }

    _validateStatisticsReferences(model = {}, storiesById = new Map()) {
        const issues = [];
        for (const [storyId, story] of storiesById.entries()) {
            const intent = story && story.statisticsIntent;
            if (!intent || typeof intent !== 'object' || Array.isArray(intent)) continue;
            const metricKeys = new Set();
            (Array.isArray(intent.metrics) ? intent.metrics : []).forEach((metric, index) => {
                const key = String(metric && metric.key || '').trim();
                if (key && metricKeys.has(key)) {
                    issues.push(this._issue(
                        'DESIGN_MODEL_STATISTICS_METRIC_KEY_DUPLICATED',
                        'detailRows',
                        `Story ${storyId} statisticsIntent.metrics[${index}].key=${key} 重复；Coder 无法稳定引用指标。`
                    ));
                }
                if (key) metricKeys.add(key);
            });
            ['filters', 'dimensions', 'metrics'].forEach(group => {
                (Array.isArray(intent[group]) ? intent[group] : []).forEach((item, index) => {
                    const raw = String(item && item.sourceField || '').trim();
                    if (!raw || raw === '*') return;
                    if (raw.includes('.') && !this._resolveStatisticsFieldRef(raw, model, storyId)) {
                        issues.push(this._issue(
                            'DESIGN_MODEL_STATISTICS_SOURCE_FIELD_UNRESOLVED',
                            `statisticsIntent.${group}[${index}].sourceField`,
                            `Story ${storyId} 的显式统计引用 ${raw} 不存在于本次设计对象字段中。`,
                            { storyId, sourceField: raw, allowedFieldRefs: this._statisticsFieldRefs(model) }
                        ));
                    }
                });
            });
        }
        return issues;
    }

    _normalizeStatisticsContractForModel(intent = {}, model = {}, storyId = '') {
        const out = JSON.parse(JSON.stringify(intent || {}));
        ['filters', 'dimensions', 'metrics'].forEach(group => {
            if (!Array.isArray(out[group])) return;
            out[group] = out[group].map(item => {
                if (!item || typeof item !== 'object' || Array.isArray(item)) return item;
                const raw = String(item.sourceField || '').trim();
                if (!raw || raw === '*') return item;
                const resolved = this._resolveStatisticsFieldRef(raw, model, storyId);
                return resolved ? { ...item, sourceField: resolved } : item;
            });
        });
        const metrics = Array.isArray(out.metrics) ? out.metrics : [];
        metrics.forEach(metric => {
            if (!metric || typeof metric !== 'object' || Array.isArray(metric)) return;
            const formula = String(metric.formula || '').trim();
            if (!formula) return;
            const metricRefs = metrics
                .filter(candidate => candidate !== metric)
                .filter(candidate => {
                    const key = String(candidate && candidate.key || '').trim();
                    const label = String(candidate && candidate.label || '').trim();
                    return (key && formula.includes(key)) || (label && formula.includes(label));
                })
                .map(candidate => String(candidate.key || '').trim())
                .filter(Boolean);
            if (metricRefs.length > 0) metric.metricRefs = Array.from(new Set(metricRefs));
        });
        return out;
    }

    _attachStatisticsSourceDependencies(contract = {}, dependencies = [], storyId = '') {
        const normalizedStoryId = String(storyId || '').trim().toUpperCase();
        if (!contract || typeof contract !== 'object' || Array.isArray(contract) || !normalizedStoryId) {
            return contract;
        }
        const existing = Array.isArray(contract.dataSources) ? contract.dataSources : [];
        const out = existing.map(item => (item && typeof item === 'object' && !Array.isArray(item)
            ? JSON.parse(JSON.stringify(item))
            : item));
        const seen = new Set(out
            .filter(item => item && typeof item === 'object')
            .map(item => String(item.tableName || '').trim().toUpperCase())
            .filter(Boolean));
        (Array.isArray(dependencies) ? dependencies : [])
            .filter(item => String(item && item.storyId || '').trim().toUpperCase() === normalizedStoryId)
            .forEach(item => {
                const tableName = String(item && item.tableName || '').trim();
                if (!tableName || seen.has(tableName.toUpperCase())) return;
                seen.add(tableName.toUpperCase());
                out.push({
                    tableName,
                    role: String(item && item.role || '').trim(),
                    ...(String(item && item.sourceName || '').trim() ? { sourceName: String(item.sourceName).trim() } : {})
                });
            });
        return out.length > 0 ? { ...contract, dataSources: out } : contract;
    }

    _resolveStatisticsFieldRef(value = '', model = {}, storyId = '') {
        const raw = String(value || '').trim();
        if (!raw || raw === '*') return raw;
        const refs = this._statisticsFieldRefs(model);
        const normalized = text => String(text || '').toLowerCase().replace(/[^a-z0-9]/g, '');
        if (raw.includes('.')) {
            const exact = refs.find(ref => ref.toLowerCase() === raw.toLowerCase());
            return exact || '';
        }
        const route = (Array.isArray(model.storyRoutes) ? model.storyRoutes : [])
            .find(item => String(item && item.storyId || '').trim().toUpperCase() === String(storyId || '').trim().toUpperCase());
        const primaryObjectKey = String(route && route.primaryObjectKey || '').trim();
        const fieldMatches = refs.filter(ref => normalized(ref.split('.').slice(1).join('.')) === normalized(raw));
        const primaryMatch = fieldMatches.find(ref => ref.startsWith(`${primaryObjectKey}.`));
        if (primaryMatch) return primaryMatch;
        if (fieldMatches.length === 1) return fieldMatches[0];
        const idMatch = raw.match(/^(.+?)(?:_?id)$/i);
        if (idMatch) {
            const objectMatches = (Array.isArray(model.dataObjects) ? model.dataObjects : [])
                .filter(item => normalized(item && item.objectKey) === normalized(idMatch[1]));
            if (objectMatches.length === 1) {
                const ref = `${objectMatches[0].objectKey}.rowguid`;
                if (refs.includes(ref)) return ref;
            }
        }
        return '';
    }

    _statisticsFieldRefs(model = {}) {
        const refs = [];
        const carriers = new Map((Array.isArray(model.carriers) ? model.carriers : [])
            .map(item => [String(item && item.objectKey || '').trim(), item]));
        (Array.isArray(model.dataObjects) ? model.dataObjects : []).forEach(object => {
            const objectKey = String(object && object.objectKey || '').trim();
            const carrier = carriers.get(objectKey);
            if (objectKey && carrier && carrier.mode !== 'none') refs.push(`${objectKey}.rowguid`);
        });
        (Array.isArray(model.objectFields) ? model.objectFields : []).forEach(field => {
            const objectKey = String(field && field.objectKey || '').trim();
            const name = String(field && field.name || '').trim();
            if (objectKey && name) refs.push(`${objectKey}.${name}`);
        });
        return Array.from(new Set(refs));
    }

    _managedNoTableObjectKey(storyId, objectMap) {
        const base = `story_${String(storyId || '').trim().toLowerCase()}`;
        let value = base;
        let index = 2;
        while (objectMap.has(value)) value = `${base}_${index++}`;
        return value;
    }

    _projectSurface(capability, objectKey, carrier, relations = [], querySurface = null) {
        const value = String(capability || '').trim();
        if (value === 'job' || value === 'configure') return 'none';
        if (!carrier || carrier.mode === 'none') return value === 'action' ? 'none' : 'independent';
        if (value === 'maintain') return 'independent';
        if (value === 'action') return 'embedded';
        if (value === 'query' && querySurface && querySurface.mode === 'reuse_carrier_list') return 'shared';
        return 'independent';
    }

    _directedRelationPath(fromObjectKey = '', toObjectKey = '', relations = []) {
        const from = String(fromObjectKey || '').trim();
        const to = String(toObjectKey || '').trim();
        if (!from || !to) return { ok: false, reason: 'missing_object_key', relationPath: [], candidatePaths: [] };
        if (from === to) return { ok: true, relationPath: [], candidatePaths: [[]] };
        const outgoing = new Map();
        (Array.isArray(relations) ? relations : []).forEach(relation => {
            const parent = String(relation && relation.parentObjectKey || '').trim();
            const child = String(relation && relation.childObjectKey || '').trim();
            const relationKey = String(relation && relation.relationKey || '').trim();
            if (!parent || !child || !relationKey) return;
            if (!outgoing.has(parent)) outgoing.set(parent, []);
            outgoing.get(parent).push({ child, relationKey });
        });
        const queue = [{ objectKey: from, relationPath: [], visited: new Set([from]) }];
        const candidatePaths = [];
        while (queue.length > 0 && candidatePaths.length < 2) {
            const current = queue.shift();
            (outgoing.get(current.objectKey) || []).forEach(edge => {
                if (current.visited.has(edge.child) || candidatePaths.length >= 2) return;
                const relationPath = current.relationPath.concat(edge.relationKey);
                if (edge.child === to) {
                    candidatePaths.push(relationPath);
                    return;
                }
                const visited = new Set(current.visited);
                visited.add(edge.child);
                queue.push({ objectKey: edge.child, relationPath, visited });
            });
        }
        if (candidatePaths.length === 1) {
            return { ok: true, relationPath: candidatePaths[0], candidatePaths };
        }
        return {
            ok: false,
            reason: candidatePaths.length === 0 ? 'path_missing' : 'path_ambiguous',
            relationPath: [],
            candidatePaths
        };
    }

    _compositionPathIssue(pathResult = {}, field = '', fromObjectKey = '', toObjectKey = '', blockKind = '') {
        const from = String(fromObjectKey || '').trim();
        const to = String(toObjectKey || '').trim();
        if (pathResult && pathResult.reason === 'path_ambiguous') {
            return this._issue(
                'DESIGN_MODEL_COMPOSITION_RELATION_PATH_AMBIGUOUS',
                field,
                `${blockKind}从${from}到${to}存在多条关系路径，无法由Builder唯一机械投影。`,
                { candidatePaths: pathResult.candidatePaths || [] }
            );
        }
        return this._issue(
            'DESIGN_MODEL_COMPOSITION_OBJECT_DISCONNECTED',
            field,
            `${blockKind}从${from}到${to}没有已声明的有向业务关系路径。`
        );
    }

    _objectsConnected(left, right, relations = []) {
        if (!left || !right) return false;
        if (left === right) return true;
        const graph = new Map();
        relations.forEach(relation => {
            const parent = String(relation.parentObjectKey || '').trim();
            const child = String(relation.childObjectKey || '').trim();
            if (!parent || !child) return;
            if (!graph.has(parent)) graph.set(parent, []);
            if (!graph.has(child)) graph.set(child, []);
            graph.get(parent).push(child);
            graph.get(child).push(parent);
        });
        const queue = [left];
        const seen = new Set();
        while (queue.length > 0) {
            const current = queue.shift();
            if (current === right) return true;
            if (seen.has(current)) continue;
            seen.add(current);
            (graph.get(current) || []).forEach(next => {
                if (!seen.has(next)) queue.push(next);
            });
        }
        return false;
    }

    _rootObjectKey(objectKey, relations) {
        let current = objectKey;
        const seen = new Set();
        while (!seen.has(current)) {
            seen.add(current);
            const parent = relations.find(relation => relation.childObjectKey === current);
            if (!parent) break;
            current = parent.parentObjectKey;
        }
        return current;
    }

    _domainForObject(objectKey, relations) {
        const root = this._toPathSegment(this._rootObjectKey(objectKey, relations)) || 'business';
        return root.endsWith('manage') ? root : `${root}manage`;
    }

    _uniqueRouteEntityKey(route, scene, entities) {
        const suffixByScene = {
            query_result_entry: 'query',
            statistics_analysis: 'statistics',
            workflow_process: 'workflow',
            rest_interface: 'rest',
            scheduled_job: 'job',
            mixed_prepare_then_patch: 'mixed',
            existing_entry_patch: 'patch',
            targeted_patch_only: 'action',
            backend_data_carrier: 'backend',
            crud_new_full: 'maintenance'
        };
        const suffix = suffixByScene[String(scene || '').trim()] || String(route.capability || 'capability').trim();
        const base = `${route.primaryObjectKey}_${suffix}`;
        let value = base;
        let index = 2;
        const used = new Set(entities.map(entity => entity.entityKey));
        while (used.has(value)) value = `${base}_${index++}`;
        return value;
    }

    _constructionBindingForRoute(route = {}, scene = '', targetEntityKey = '', carrierMode = '') {
        const constructionSceneKey = String(scene || '').trim();
        const surface = String(route.surface || '').trim();
        const specializedKind = {
            rest_interface: 'rest_operation',
            scheduled_job: 'job',
            workflow_process: 'workflow',
            statistics_analysis: 'statistics',
            query_result_entry: 'owned_files',
            crud_new_full: 'owned_files',
            backend_data_carrier: 'service_owner',
            mixed_prepare_then_patch: 'carrier_patch',
            existing_entry_patch: 'existing_entry_patch',
            targeted_patch_only: carrierMode === 'none' ? 'service_only' : 'carrier_patch',
            configuration_only: 'configuration_only'
        };
        const bindingKind = specializedKind[constructionSceneKey] || 'service_only';
        const candidateFileKinds = ['carrier_patch', 'existing_entry_patch'].includes(bindingKind)
            ? ['Action', 'HtmlPage']
            : [];
        return {
            storyId: String(route.storyId || '').trim().toUpperCase(),
            routeKey: String(route.routeKey || '').trim(),
            capability: String(route.capability || '').trim(),
            surface,
            ...(route.querySurface ? { querySurface: JSON.parse(JSON.stringify(route.querySurface)) } : {}),
            constructionSceneKey,
            bindingKind,
            targetEntityKey: String(targetEntityKey || '').trim(),
            ...(bindingKind !== 'configuration_only' ? { serviceBinding: 'carrier_service' } : {}),
            ...(candidateFileKinds.length > 0 ? { candidateFileKinds } : {})
        };
    }

    _routeLabel(capability) {
        return { maintain: '维护', query: '查询', action: '动作', job: '任务', configure: '配置', workflow: '流程', statistics: '统计' }[capability] || '能力';
    }

    _hasRelationCycle(relations) {
        const graph = new Map();
        relations.forEach(relation => {
            if (!graph.has(relation.parentObjectKey)) graph.set(relation.parentObjectKey, []);
            graph.get(relation.parentObjectKey).push(relation.childObjectKey);
        });
        const visiting = new Set();
        const visited = new Set();
        const visit = node => {
            if (visiting.has(node)) return true;
            if (visited.has(node)) return false;
            visiting.add(node);
            for (const child of graph.get(node) || []) if (visit(child)) return true;
            visiting.delete(node);
            visited.add(node);
            return false;
        };
        return Array.from(graph.keys()).some(visit);
    }

    _candidateNames(values) {
        return (Array.isArray(values) ? values : []).map(value => String(
            value && typeof value === 'object' ? (value.tableName || value.name || '') : value
        ).trim()).filter(Boolean);
    }

    _normalizeCandidateFacts(values) {
        const seen = new Set();
        return (Array.isArray(values) ? values : []).map(value => {
            if (typeof value === 'string') return { tableName: String(value).trim() };
            if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
            const tableName = String(value.tableName || value.name || '').trim();
            if (!tableName) return null;
            const key = tableName.toUpperCase();
            if (seen.has(key)) return null;
            seen.add(key);
            return {
                tableName,
                ...(Array.isArray(value.columns) ? { columns: value.columns } : {}),
                ...(String(value.entityName || '').trim() ? { entityName: String(value.entityName).trim() } : {}),
                ...(String(value.tableDisplayName || '').trim() ? { tableDisplayName: String(value.tableDisplayName).trim() } : {}),
                ...(String(value.candidateRole || '').trim() ? { candidateRole: String(value.candidateRole).trim() } : {}),
                ...(Array.isArray(value.sourceStoryIds) ? { sourceStoryIds: value.sourceStoryIds.map(item => String(item || '').trim().toUpperCase()).filter(Boolean) } : {}),
                ...(Array.isArray(value.primaryOwnerStoryIds) ? { primaryOwnerStoryIds: value.primaryOwnerStoryIds.map(item => String(item || '').trim().toUpperCase()).filter(Boolean) } : {}),
                ...(Array.isArray(value.triggerStoryIds) ? { triggerStoryIds: value.triggerStoryIds.map(item => String(item || '').trim().toUpperCase()).filter(Boolean) } : {}),
                ...(Array.isArray(value.weakRelatedStoryIds) ? { weakRelatedStoryIds: value.weakRelatedStoryIds.map(item => String(item || '').trim().toUpperCase()).filter(Boolean) } : {})
            };
        }).filter(Boolean);
    }

    _stories(value) {
        if (Array.isArray(value)) return value;
        if (value && Array.isArray(value.stories)) return value.stories;
        if (value && value.stories && typeof value.stories === 'object') {
            return Object.entries(value.stories).map(([storyId, story]) => ({ storyId, ...(story || {}) }));
        }
        return [];
    }

    _storyId(story) {
        return String(story && (story.storyId || story.id) || '').trim().toUpperCase();
    }

    _toPathSegment(value) {
        return String(value || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '');
    }

    _toLowerCamel(value) {
        const parts = String(value || '').trim().toLowerCase().split(/_+/).filter(Boolean);
        return parts.map((part, index) => index === 0 ? part : part.charAt(0).toUpperCase() + part.slice(1)).join('');
    }

    _hashRows(rows) {
        return crypto.createHash('sha256').update(JSON.stringify(Array.isArray(rows) ? rows : []), 'utf8').digest('hex');
    }

    _issue(code, field, message, extra = {}) {
        return { code, field, message, ...extra };
    }

    _blocked(errorCode, issues) {
        return {
            ok: false,
            status: 'blocked',
            actionMode: 'repair_current_design_step',
            errorCode,
            issueCount: Array.isArray(issues) ? issues.length : 0,
            issues: Array.isArray(issues) ? issues : [],
            allowedNextActions: ['resubmit_current_step_only'],
            forbiddenActions: ['edit_builder_projection', 'write_design_document_json_directly', 'change_completed_step']
        };
    }
}

module.exports = DesignModelCompiler;

// 页面卡和页面绑定校验必须使用同一套“当前团队实际交付页面”边界。
// external_team_ui/rest_interface Story 仍然可以参与数据承载或 REST 投影，
// 但不应因为对象被内部页面作为 child_edit 承载而被要求填写 PAGE_BIND。
DesignModelCompiler.isManagedPageRoute = function isManagedPageRoute(route = {}) {
    return !!route
        && ['maintain', 'query'].includes(String(route.capability || '').trim())
        && String(route.requirementSceneLock || '').trim() !== 'rest_interface'
        && !String(route.primaryObjectKey || '').trim().startsWith('story_');
};
