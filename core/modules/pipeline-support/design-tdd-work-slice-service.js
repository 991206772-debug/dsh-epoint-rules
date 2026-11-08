/* eslint-disable */
const fs = require('fs');
const path = require('path');
const DesignTddRequiredRulesConfigService = require('./design-tdd-required-rules-config-service');
const ProjectionTransactionService = require('./design-tdd-projection-transaction-service');
const { CoderMaterialService, ENTRY_BYTES, obsoleteMaterialFiles } = require('./coder-material-service');

const DRAFT_INDEX_SCHEMA = 'requirement-work-draft-index/v3';
const SLICE_INDEX_SCHEMA = 'work-slices-index/v3';

const BASE_SLICE_DEFS = [
    {
        id: 'stories',
        ref: 'work-slices/stories.json',
        readGroup: 'stories',
        whenToRead: '启动读取全部功能和 AC 目录；当前任务完整验收从 detailRef 读取。'
    },
    {
        id: 'files-fields',
        ref: 'work-slices/files-fields.json',
        readGroup: 'files-fields',
        whenToRead: '确认候选文件、可写边界、业务字段、表字段和实体字段时读取。'
    },
    {
        id: 'routes',
        ref: 'work-slices/routes.json',
        readGroup: 'routes',
        whenToRead: '修改 HtmlPage、epoint.execute、MiniUI action 或 Action public 方法闭合时读取。'
    },
    {
        id: 'reuse',
        ref: 'work-slices/reuse.json',
        readGroup: 'reuse',
        whenToRead: '涉及复用既有入口、复用表、复用实体、复用工具类或精确源码路径时读取。'
    },
    {
        id: 'self-check',
        ref: 'work-slices/self-check.json',
        readGroup: 'self-check',
        whenToRead: '每个连续实现批次完成后按需读取，用于回看验收、红线、调用闭合和验证结果。'
    }
];
const COMMON_FILE_KIND = 'Common';

function array(value) {
    return Array.isArray(value) ? value : [];
}

function stripUndefined(obj = {}) {
    const out = {};
    Object.keys(obj || {}).forEach(key => {
        const value = obj[key];
        if (value === undefined || value === null || value === '') return;
        if (Array.isArray(value) && value.length === 0) return;
        out[key] = value;
    });
    return out;
}

function uniqueNonEmptyStrings(values = []) {
    const out = [];
    const seen = new Set();
    for (const value of (Array.isArray(values) ? values : [])) {
        const text = String(value || '').trim();
        if (!text || seen.has(text)) continue;
        seen.add(text);
        out.push(text);
    }
    return out;
}

class DesignTddWorkSliceService {
    constructor(options = {}) {
        this.now = options.now || (() => new Date().toISOString());
        this.requiredRulesConfigService = options.requiredRulesConfigService
            || new DesignTddRequiredRulesConfigService(options.requiredRulesConfig || {});
        this.transactionService = options.transactionService || new ProjectionTransactionService();
    }

    buildAndWrite({ codeDir = '', fullDraft = {}, requirementWorkPackage = {}, modulesOwnerFiles = [],
        modulePlans = [], constructionBindings = [], storyWorkPackages = [], targetIndex: suppliedTargets = null } = {}) {
        const targetDir = String(codeDir || '').trim();
        if (!targetDir) {
            return {
                written: false,
                reason: 'code_dir_unresolved'
            };
        }
        const workSlicesDir = path.join(targetDir, 'work-slices');
        const pending = this.transactionService.recoverPending({
            managedRoots: [path.resolve(targetDir)],
            transactionRoot: path.join(path.resolve(targetDir), '.projection-tx')
        });
        if (!pending.ok) {
            const error = new Error(pending.message || 'Coder 资料事务恢复失败。');
            error.code = pending.errorCode;
            throw error;
        }
        this.transactionService.cleanOrphanedStaging({ rootDir: path.resolve(targetDir),
            transactionRoot: path.join(path.resolve(targetDir), '.projection-tx') });
        const slices = this._buildSlices({ fullDraft, requirementWorkPackage });
        const resourceIndex = this._resourceIndex(slices);
        const targetIndex = suppliedTargets || this.buildTargetIndex({ modulesOwnerFiles, modulePlans,
            constructionBindings, storyWorkPackages, requirementWorkPackage });
        const readCatalog = this._buildReadCatalog({ codeDir: targetDir, resourceIndex, requirementWorkPackage,
            targetIndex, modulePlans, constructionBindings });
        const material = new CoderMaterialService().build({ codeDir: targetDir, slices, fullDraft,
            requirementWorkPackage, targetIndex, readCatalog });
        for (const item of resourceIndex) {
            item.byteSize = Buffer.byteLength(material.writer.files.get(item.ref) || '', 'utf8');
        }
        const indexPath = path.join(workSlicesDir, 'index.json');
        const sliceIndex = {
            schemaVersion: SLICE_INDEX_SCHEMA,
            generatedAt: this.now(),
            purpose: 'Coder 施工包主题切片目录；LLM 按 resourceIndex 精确读取，不回读大 draft/package。',
            resourceIndex,
            readCatalogRef: material.readCatalogRef,
            targetIndexRef: material.targetIndexRef
        };
        const draftIndex = this.buildDraftIndex({ codeDir: targetDir, fullDraft, requirementWorkPackage, sliceWrite: material });
        material.writer.write('requirement-work-draft.json', draftIndex, ENTRY_BYTES);
        material.writer.files.set('requirement-work-package.json', `${JSON.stringify(requirementWorkPackage, null, 2)}\n`);
        sliceIndex.managedFiles = [...material.writer.files.keys(), 'work-slices/index.json'];
        material.writer.write('work-slices/index.json', sliceIndex);
        const txRoot = path.join(path.resolve(targetDir), '.projection-tx');
        fs.mkdirSync(txRoot, { recursive: true });
        const stagingDir = fs.mkdtempSync(path.join(txRoot, `coder-material-${process.pid}-`));
        let canRemoveStaging = true;
        try {
            const files = [];
            for (const [ref, content] of material.writer.files) {
                const newPath = path.join(stagingDir, 'next', ref);
                fs.mkdirSync(path.dirname(newPath), { recursive: true });
                fs.writeFileSync(newPath, content, 'utf8');
                files.push({ path: path.resolve(targetDir, ref), newPath });
            }
            files.push(...obsoleteMaterialFiles(targetDir, material.writer.files.keys()));
            const published = this.transactionService.publishFiles({ rootDir: path.resolve(targetDir), stagingDir, files });
            if (!published.ok) {
                canRemoveStaging = published.recovery?.ok === true;
                const error = new Error(published.cause || published.message || 'Coder 资料发布失败');
                error.code = published.errorCode; error.transactionPath = published.transactionPath;
                throw error;
            }
        } finally {
            if (canRemoveStaging && !fs.existsSync(path.join(stagingDir, 'projection-transaction.json'))) {
                this.transactionService.discardStaging({ stagingDir, managedRoots: [path.resolve(targetDir)] });
            }
        }
        return {
            written: true,
            workSlicesDir,
            indexPath,
            resourceIndex,
            slices,
            draftIndex,
            readCatalogRef: material.readCatalogRef,
            targetIndexRef: material.targetIndexRef,
            storyCatalogRef: material.storyCatalogRef
        };
    }

    buildDraftIndex({
        codeDir = '',
        fullDraft = {},
        requirementWorkPackage = {},
        sliceWrite = null
    } = {}) {
        const firstEditCard = fullDraft.firstEditCard && typeof fullDraft.firstEditCard === 'object'
            ? fullDraft.firstEditCard
            : {};
        const acceptanceCodes = this._collectAcceptanceCodes({
            firstEditCard,
            storyCards: fullDraft.storyCards,
            userStories: requirementWorkPackage.userStories
        });
        const currentAcceptanceCode = acceptanceCodes[0] || '';
        const redlines = this._buildTopRedlines(fullDraft);
        return stripUndefined({
            schemaVersion: DRAFT_INDEX_SCHEMA,
            generatedAt: this.now(),
            driver: 'story_draft_index',
            purpose: '先读取全部功能目录，再按当前任务直接读取完整验收、骨架和规范；不预读完整代码目录。',
            storyCatalogRef: sliceWrite?.storyCatalogRef || path.resolve(codeDir, 'work-slices/stories.json'),
            targetIndexRef: sliceWrite?.targetIndexRef || path.resolve(codeDir, 'work-slices/target-index.json'),
            readCatalogRef: sliceWrite?.readCatalogRef || path.resolve(codeDir, 'work-slices/read-catalog.json'),
            current: stripUndefined({
                acceptanceCode: currentAcceptanceCode,
                storyId: String(firstEditCard.storyId || '').trim(),
                targetFile: String(firstEditCard.targetFile || '').trim(),
                fileKind: String(firstEditCard.fileKind || '').trim()
            }),
            redlines,
            forbidden: [
                '不要读取 IDE 临时 toolcall 输出文件。',
                '启动读取本入口和 storyCatalogRef；当前任务完整验收及资料从 detailRef 直接读取，续读 contentRef/contentRefs/nextRef 不得遗漏。',
                '需要技术事实时可用当前 Story、骨架类名、对象键或 API 名在工程内锚点检索；不要用无关结果补业务事实。',
                '不要修改 authorizedWriteRoots 外的业务源码；files-fields 候选文件只是参考入口。',
                '任务要求和实施进展统一写 code/demand-implementation-tasks.md，TodoList 展示按主 Skill 执行，不写 code-state 或其它 Builder 真值。'
            ]
        });
    }

    buildTargetIndex({
        modulesOwnerFiles = [],
        modulePlans = [],
        constructionBindings = [],
        storyWorkPackages = [],
        requirementWorkPackage = {}
    } = {}) {
        const carriedByEntityKeyMap = new Map();
        const businessObjects = (requirementWorkPackage.businessFacts && requirementWorkPackage.businessFacts.businessObjects) || [];
        for (const obj of businessObjects) {
            const key = String(obj && obj.objectKey || '').trim().toLowerCase();
            const carried = String(obj && obj.carriedByEntityKey || '').trim();
            if (key && carried) carriedByEntityKeyMap.set(key, carried);
        }
        const modulesById = new Map();
        for (const modulePlan of array(modulePlans)) {
            const moduleId = String(modulePlan && modulePlan.moduleId || '').trim();
            if (moduleId) modulesById.set(moduleId, modulePlan);
        }
        for (const moduleEntry of array(modulesOwnerFiles)) {
            const moduleId = String(moduleEntry && moduleEntry.moduleId || '').trim();
            if (!moduleId) continue;
            modulesById.set(moduleId, {
                ...(modulesById.get(moduleId) || {}),
                ...moduleEntry,
                businessContext: {
                    ...((modulesById.get(moduleId) || {}).businessContext || {}),
                    ...(moduleEntry.businessContext || {})
                }
            });
        }
        const bindingsByStoryId = new Map();
        for (const binding of array(constructionBindings)) {
            const storyId = String(binding && binding.storyId || '').trim().toUpperCase();
            if (!storyId) continue;
            if (!bindingsByStoryId.has(storyId)) bindingsByStoryId.set(storyId, []);
            bindingsByStoryId.get(storyId).push({ ...binding, storyId });
        }
        const storyIdsByPath = new Map();
        const accessByPath = new Map();
        const mergeAccess = (current = '', next = '') => {
            if (current === 'write' || next === 'write') return 'write';
            return current || next || '';
        };
        for (const storyPackage of array(storyWorkPackages)) {
            const storyId = String(storyPackage && storyPackage.storyId || '').trim().toUpperCase();
            if (!storyId) continue;
            for (const file of array(storyPackage && storyPackage.files)) {
                const identity = this._pathIdentity(file && (file.resolvedPath || file.path));
                if (!identity) continue;
                if (!storyIdsByPath.has(identity)) storyIdsByPath.set(identity, []);
                storyIdsByPath.get(identity).push(storyId);
                if (!accessByPath.has(identity)) accessByPath.set(identity, new Map());
                const access = String(file && file.access || '').trim().toLowerCase();
                const current = accessByPath.get(identity).get(storyId) || '';
                const merged = mergeAccess(current, access);
                if (merged) accessByPath.get(identity).set(storyId, merged);
            }
        }
        const resultByPath = new Map();
        const carrierIdFor = binding => {
            const logicalModule = modulesById.get(String(binding && binding.moduleId || '').trim()) || {};
            return String(binding && (binding.carriedByModuleId || binding.carrierModuleId)
                || logicalModule.carriedByModuleId || logicalModule.businessContext?.carriedByModuleId || '').trim();
        };
        for (const moduleEntry of (Array.isArray(modulesOwnerFiles) ? modulesOwnerFiles : [])) {
            const moduleId = String(moduleEntry && moduleEntry.moduleId || '').trim();
            if (!moduleId) continue;
            const ctx = moduleEntry && moduleEntry.businessContext && typeof moduleEntry.businessContext === 'object'
                ? moduleEntry.businessContext : {};
            const objectKey = String(ctx.objectKey || '').trim();
            const constructionSceneKey = String(ctx.constructionSceneKey || '').trim();
            const carriedByModuleId = String(ctx.carriedByModuleId || moduleEntry.carriedByModuleId || '').trim();
            const carriedByEntityKey = carriedByEntityKeyMap.get(objectKey.toLowerCase())
                || this._moduleObjectKey(modulesById.get(carriedByModuleId))
                || '';
            for (const ownerFile of (Array.isArray(moduleEntry.ownerFiles) ? moduleEntry.ownerFiles : [])) {
                const resolvedPath = String(ownerFile.resolvedPath || '').trim();
                const identity = this._pathIdentity(resolvedPath);
                if (!identity) continue;
                // constructionBindings 是逻辑 Story 到物理承载面的事实。不能只从
                // storyWorkPackages 反推 Story，否则 carried workflow/patch/query 在
                // 首次恢复时没有任何物理文件可读。先找所有声明本物理路径的绑定，
                // 再把绑定 Story 合并进该路径的导航闭包。
                const bindingsForPath = array(constructionBindings)
                    .map(binding => ({
                        ...binding,
                        storyId: String(binding && binding.storyId || '').trim().toUpperCase()
                    }))
                    .filter(binding => {
                        if (!binding.storyId) return false;
                        const bindingModuleId = String(binding && binding.moduleId || '').trim();
                        const bindingModule = modulesById.get(bindingModuleId) || {};
                        const bindingCarrierId = carrierIdFor(binding);
                        return bindingModuleId === moduleId
                            || bindingCarrierId === moduleId
                            || this._moduleContainsPath(bindingModule, resolvedPath);
                    });
                const storyIds = uniqueNonEmptyStrings([
                    ...array(ownerFile.storyIds),
                    ...array(storyIdsByPath.get(identity)),
                    ...bindingsForPath.map(binding => binding.storyId)
                ]).map(storyId => String(storyId).trim().toUpperCase());
                const storyBindings = [];
                for (const storyId of storyIds) {
                    const bindings = array(bindingsByStoryId.get(storyId));
                    const relevantBindings = bindings.filter(binding => {
                        const bindingModuleId = String(binding && binding.moduleId || '').trim();
                        const bindingModule = modulesById.get(bindingModuleId) || {};
                        return bindingModuleId === moduleId || carrierIdFor(binding) === moduleId
                            || this._moduleContainsPath(bindingModule, resolvedPath);
                    });
                    const selectedBindings = relevantBindings.length > 0 ? relevantBindings : bindings;
                    for (const binding of (selectedBindings.length > 0 ? selectedBindings : [{ moduleId }])) {
                        const logicalModuleId = String(binding && binding.moduleId || moduleId).trim();
                        const logicalModule = modulesById.get(logicalModuleId) || {};
                        const logicalContext = logicalModule.businessContext && typeof logicalModule.businessContext === 'object'
                            ? logicalModule.businessContext : {};
                        const logicalObjectKey = String(logicalModule.objectKey || logicalContext.objectKey || objectKey).trim();
                        const logicalCarrierModuleId = carrierIdFor(binding);
                        const logicalCarriedEntityKey = carriedByEntityKeyMap.get(logicalObjectKey.toLowerCase())
                            || String(binding && binding.carriedByEntityKey || '').trim()
                            || this._moduleObjectKey(modulesById.get(logicalCarrierModuleId))
                            || '';
                        storyBindings.push(stripUndefined({
                            storyId,
                            moduleId: logicalModuleId,
                            objectKey: logicalObjectKey,
                            constructionSceneKey: String(
                                binding && binding.constructionSceneKey
                                || logicalModule.constructionSceneKey
                                || logicalContext.constructionSceneKey
                                || constructionSceneKey
                            ).trim(),
                            ...(logicalCarrierModuleId ? { carriedByModuleId: logicalCarrierModuleId } : {}),
                            ...(logicalCarriedEntityKey ? { carriedByEntityKey: logicalCarriedEntityKey } : {})
                        }));
                    }
                }
                const accessByStoryId = {};
                storyIds.forEach(storyId => {
                    const packageAccess = accessByPath.get(identity) && accessByPath.get(identity).get(storyId);
                    accessByStoryId[storyId] = mergeAccess(
                        packageAccess,
                        ownerFile.mechanicallyComplete === true ? 'read' : 'write'
                    );
                });
                const projected = stripUndefined({
                    moduleId,
                    fileKind: String(ownerFile.fileKind || '').trim(),
                    ...(ownerFile.subType ? { subType: String(ownerFile.subType || '').trim() } : {}),
                    resolvedPath,
                    operation: String(ownerFile.operation || 'create').trim(),
                    storyIds,
                    ...(Object.keys(accessByStoryId).length > 0 ? { accessByStoryId } : {}),
                    objectKey,
                    constructionSceneKey,
                    ...(carriedByModuleId ? { carriedByModuleId } : {}),
                    ...(carriedByEntityKey ? { carriedByEntityKey } : {}),
                    ...(storyBindings.length > 0
                        ? { storyBindings: this._uniqueStoryBindings(storyBindings) }
                        : {})
                });
                const existing = resultByPath.get(identity);
                if (!existing) {
                    resultByPath.set(identity, projected);
                    continue;
                }
                existing.storyIds = uniqueNonEmptyStrings([...array(existing.storyIds), ...storyIds]);
                existing.accessByStoryId = Object.entries({
                    ...(existing.accessByStoryId || {}),
                    ...(projected.accessByStoryId || {})
                }).reduce((out, [storyId, access]) => {
                    out[storyId] = mergeAccess(out[storyId] || '', access);
                    return out;
                }, {});
                existing.storyBindings = this._uniqueStoryBindings([
                    ...array(existing.storyBindings),
                    ...array(projected.storyBindings)
                ]);
            }
        }
        return Array.from(resultByPath.values());
    }

    _buildReadCatalog({
        codeDir = '',
        resourceIndex = [],
        requirementWorkPackage = {},
        targetIndex = [],
        modulePlans = [],
        constructionBindings = []
    } = {}) {
        const items = array(resourceIndex).map(item => this._normalizeResourceItem(item)).filter(item => item.id && item.ref);
        const baseDir = path.resolve(String(codeDir || '.').trim() || '.');
        const resources = {};
        for (const item of items) {
            resources[item.id] = path.resolve(baseDir, item.ref);
        }
        resources['business-facts'] = path.join(baseDir, 'business-facts.json');
        const itemId = id => Object.prototype.hasOwnProperty.call(resources, id) ? id : '';
        const storiesId = itemId('stories');
        const filesFieldsId = itemId('files-fields');
        const routesId = itemId('routes');
        const reuseId = itemId('reuse');
        const selfCheckId = itemId('self-check');
        const businessFactsId = 'business-facts';
        const startupRefs = uniqueNonEmptyStrings([storiesId]);
        const commonRefs = items
            .filter(item => String(item.readGroup || '').trim() === 'rules'
                && String(item.fileKind || '').trim() === 'Common')
            .map(item => item.id);
        const byFileKind = {};
        for (const item of items) {
            const kind = String(item.fileKind || '').trim();
            if (!kind) continue;
            if (!byFileKind[kind]) byFileKind[kind] = [];
            byFileKind[kind].push(item.id);
        }
        Object.keys(byFileKind).forEach(kind => {
            byFileKind[kind] = uniqueNonEmptyStrings(byFileKind[kind]);
        });

        const bindings = array(constructionBindings);
        const modulesById = new Map(array(modulePlans)
            .map(modulePlan => [String(modulePlan && modulePlan.moduleId || '').trim(), modulePlan])
            .filter(([moduleId]) => moduleId));
        const storyIds = uniqueNonEmptyStrings([
            ...array(requirementWorkPackage && requirementWorkPackage.userStories).map(story => story && story.storyId),
            ...array(targetIndex).flatMap(target => array(target && target.storyIds))
        ]);
        const hasReuseFacts = Boolean(
            reuseId && (
                requirementWorkPackage.reuseCard
                || requirementWorkPackage.reuseTableGuide
                || array(requirementWorkPackage.dataAccessPlans).length > 0
            )
        );
        const byStoryId = {};
        if (hasReuseFacts) {
            const reuseKinds = new Set(['Action', 'ServiceApi', 'ServiceImpl', 'ServiceInternal', 'Entity', 'Rest', 'Job']);
            for (const target of array(targetIndex)) {
                const kind = String(target && target.fileKind || '').trim();
                if (reuseKinds.has(kind)) byFileKind[kind] = uniqueNonEmptyStrings([...(byFileKind[kind] || []), reuseId]);
            }
        }
        for (const storyId of storyIds) {
            const storyTargets = array(targetIndex).filter(target => array(target && target.storyIds).includes(storyId));
            const storyBindings = storyTargets.flatMap(target =>
                array(target && target.storyBindings).filter(binding => binding && binding.storyId === storyId));
            const refs = [filesFieldsId];
            if (routesId && storyTargets.some(target => ['Action', 'HtmlPage', 'Rest'].includes(String(target.fileKind || '').trim()))) {
                refs.push(routesId);
            }
            if (hasReuseFacts && storyBindings.some(binding => String(binding && binding.carriedByModuleId || '').trim())) {
                refs.push(reuseId);
            }
            if (storyBindings.some(binding => this._isSpecialFeatureKey(binding && binding.constructionSceneKey))) {
                refs.push(businessFactsId);
            }
            byStoryId[storyId] = uniqueNonEmptyStrings(refs);
        }

        const moduleIds = uniqueNonEmptyStrings([
            ...Array.from(modulesById.keys()),
            ...array(targetIndex).map(target => target && target.moduleId),
            ...array(targetIndex).flatMap(target => array(target && target.storyBindings).map(binding => binding && binding.moduleId))
        ]);
        const byModuleId = {};
        for (const moduleId of moduleIds) {
            const moduleTargets = array(targetIndex).filter(target =>
                String(target && target.moduleId || '').trim() === moduleId
                || array(target && target.storyBindings).some(binding => String(binding && binding.moduleId || '').trim() === moduleId));
            const modulePlan = modulesById.get(moduleId) || {};
            const moduleContext = modulePlan.businessContext && typeof modulePlan.businessContext === 'object'
                ? modulePlan.businessContext : {};
            const carriedByModuleId = String(modulePlan.carriedByModuleId || moduleContext.carriedByModuleId || '').trim();
            const refs = [filesFieldsId];
            if (routesId && moduleTargets.some(target => ['Action', 'HtmlPage', 'Rest'].includes(String(target.fileKind || '').trim()))) {
                refs.push(routesId);
            }
            const isCarrier = array(targetIndex).some(target => array(target && target.storyBindings)
                .some(binding => String(binding && binding.carriedByModuleId || '').trim() === moduleId));
            if (hasReuseFacts && (carriedByModuleId || isCarrier)) refs.push(reuseId);
            const featureKeys = uniqueNonEmptyStrings([
                modulePlan.constructionSceneKey,
                moduleContext.constructionSceneKey,
                ...moduleTargets.flatMap(target => array(target && target.storyBindings)
                    .filter(binding => String(binding && binding.moduleId || '').trim() === moduleId)
                    .map(binding => binding && binding.constructionSceneKey))
            ]);
            if (featureKeys.some(featureKey => this._isSpecialFeatureKey(featureKey))) refs.push(businessFactsId);
            byModuleId[moduleId] = uniqueNonEmptyStrings(refs);
        }

        const featureKeys = uniqueNonEmptyStrings([
            ...array(modulePlans).map(modulePlan => modulePlan && modulePlan.constructionSceneKey),
            ...bindings.map(binding => binding && binding.constructionSceneKey),
            ...array(targetIndex).flatMap(target => array(target && target.storyBindings)
                .map(binding => binding && binding.constructionSceneKey))
        ]);
        const byFeatureKey = {};
        for (const featureKey of featureKeys) {
            const refs = [filesFieldsId];
            if (routesId && ['workflow_process', 'statistics_analysis', 'rest_interface', 'query_result_entry', 'targeted_patch_only']
                .includes(featureKey)) refs.push(routesId);
            if (hasReuseFacts && ['statistics_analysis', 'query_result_entry', 'targeted_patch_only'].includes(featureKey)) refs.push(reuseId);
            if (this._isSpecialFeatureKey(featureKey)) refs.push(businessFactsId);
            byFeatureKey[featureKey] = uniqueNonEmptyStrings(refs);
        }

        return {
            resources,
            startupRefs,
            commonRefs: uniqueNonEmptyStrings(commonRefs),
            byStoryId,
            byModuleId,
            byFileKind,
            byFeatureKey,
            afterBatchRef: uniqueNonEmptyStrings([selfCheckId])
        };
    }

    _pathIdentity(value = '') {
        const text = String(value || '').trim();
        if (!text) return '';
        return text.replace(/\\/gu, '/').replace(/\/+$/gu, '').toLowerCase();
    }

    _moduleContainsPath(modulePlan = {}, targetPath = '') {
        const target = this._pathIdentity(targetPath);
        if (!target) return false;
        return [...array(modulePlan && modulePlan.files), ...array(modulePlan && modulePlan.htmlPages)]
            .some(candidate => {
                const normalized = this._pathIdentity(candidate);
                return normalized && (normalized === target || target.endsWith(`/${normalized}`) || normalized.endsWith(`/${target}`));
            });
    }

    _moduleObjectKey(modulePlan = {}) {
        const ctx = modulePlan && modulePlan.businessContext && typeof modulePlan.businessContext === 'object'
            ? modulePlan.businessContext : {};
        return String(modulePlan && modulePlan.objectKey || ctx.objectKey || '').trim();
    }

    _uniqueStoryBindings(bindings = []) {
        const seen = new Set();
        return array(bindings).filter(binding => {
            const key = [
                binding && binding.storyId,
                binding && binding.moduleId,
                binding && binding.constructionSceneKey,
                binding && binding.carriedByModuleId
            ].map(value => String(value || '').trim()).join('|');
            if (!key.replace(/\|/gu, '') || seen.has(key)) return false;
            seen.add(key);
            return true;
        });
    }

    _isSpecialFeatureKey(value = '') {
        return ['workflow_process', 'statistics_analysis', 'rest_interface', 'scheduled_job']
            .includes(String(value || '').trim());
    }

    buildReadPlan(resourceIndex = [], fileKind = '') {
        const currentKind = this._normalizeFileKind(fileKind);
        const focused = array(resourceIndex)
            .map(item => this._normalizeResourceItem(item))
            .filter(item => item.id && item.ref)
            .map(item => {
                const phase = this._readPhaseForItem(item, currentKind);
                return stripUndefined({
                    ...item,
                    readPhase: phase,
                    readReason: this._readReasonForItem(item, currentKind, phase)
                });
            });
        return {
            resourceIndex: focused,
            mustReadNow: focused
                .filter(item => item.readPhase === 'must')
                .map(item => item.ref),
            onDemandRead: focused
                .filter(item => item.readPhase === 'onDemand')
                .map(item => item.ref),
            afterPatchRead: focused
                .filter(item => item.readPhase === 'afterPatch')
                .map(item => item.ref)
        };
    }

    isDraftIndex(value = {}) {
        const version = String(value && value.schemaVersion || '').trim();
        return value && typeof value === 'object'
            && version === DRAFT_INDEX_SCHEMA;
    }

    _buildSlices({ fullDraft = {}, requirementWorkPackage = {} } = {}) {
        return {
            stories: this._replaceDraftRefs({
                schemaVersion: 'work-slice/stories/v1',
                purpose: '全部 Story、GWT 验收项、首改卡和 Story 顺序。',
                storyOrder: fullDraft.storyOrder,
                storyCards: fullDraft.storyCards,
                contextReadBudget: fullDraft.contextReadBudget,
                firstEditCard: fullDraft.firstEditCard,
                acceptanceLedgerRef: requirementWorkPackage.acceptanceLedgerRef
            }),
            'files-fields': this._replaceDraftRefs({
                schemaVersion: 'work-slice/files-fields/v1',
                purpose: '候选文件、可写边界、业务对象、表字段和实体字段。',
                candidateFileCards: fullDraft.candidateFileCards,
                businessFieldCards: fullDraft.businessFieldCards,
                candidateFiles: requirementWorkPackage.candidateFiles,
                businessFacts: requirementWorkPackage.businessFacts,
                decisionBoundary: requirementWorkPackage.decisionBoundary,
                evidencePolicy: requirementWorkPackage.evidencePolicy
            }),
            ...this._buildRuleSlices({
                ruleCheckCards: fullDraft.ruleCheckCards,
                redlineGuide: fullDraft.redlineGuide
            }),
            ...this._buildPracticeSlices({
                practiceCards: fullDraft.practiceCards
            }),
            routes: this._replaceDraftRefs({
                schemaVersion: 'work-slice/routes/v1',
                purpose: '页面/API/Action 闭合、epoint.execute 与页面 API 自检。',
                routeCards: fullDraft.routeCards,
                pageApiSelfCheckCard: fullDraft.pageApiSelfCheckCard,
                frontendPageSelfCheckMatrix: fullDraft.frontendPageSelfCheckMatrix
            }),
            reuse: this._replaceDraftRefs({
                schemaVersion: 'work-slice/reuse/v1',
                purpose: '复用入口、复用表、复用字段、精确源码读取路径。',
                reuseGuideCards: fullDraft.reuseGuideCards,
                reuseTableGuideCards: fullDraft.reuseTableGuideCards,
                reuseFieldMappingCards: fullDraft.reuseFieldMappingCards,
                reuseCard: requirementWorkPackage.reuseCard,
                reuseTableGuide: requirementWorkPackage.reuseTableGuide
            }),
            'self-check': this._replaceDraftRefs({
                schemaVersion: 'work-slice/self-check/v1',
                purpose: '连续实现批次完成后的轻量自检；由 Coder 自主执行，不形成独立审核阶段。',
                postEditSelfCheckCard: fullDraft.postEditSelfCheckCard,
                javaDependencySelfCheckCard: this._buildJavaDependencySelfCheckCard(),
                pageApiSelfCheckCard: fullDraft.pageApiSelfCheckCard,
                afterWrite: fullDraft.afterWrite,
                doNot: fullDraft.doNot
            })
        };
    }

    _resourceIndex(slices = {}) {
        return this._sliceDefsFor(slices).map(def => {
            const slice = slices[def.id] || {};
            return stripUndefined({
                id: def.id,
                ref: def.ref,
                readGroup: def.readGroup,
                fileKind: def.fileKind,
                whenToRead: def.whenToRead,
                byteSize: Object.keys(slice).length > 0
                    ? Buffer.byteLength(JSON.stringify(slice, null, 2), 'utf-8')
                    : undefined
            });
        });
    }

    _sliceDefsFor(slices = {}) {
        const out = [];
        const addBase = id => {
            const def = BASE_SLICE_DEFS.find(item => item.id === id);
            if (def && slices[id]) out.push(def);
        };
        addBase('stories');
        addBase('files-fields');
        out.push(...this._dynamicDefsForGroup(slices, 'rules'));
        out.push(...this._dynamicDefsForGroup(slices, 'practices'));
        addBase('routes');
        addBase('reuse');
        addBase('self-check');
        return out;
    }

    _dynamicDefsForGroup(slices = {}, group = '') {
        return Object.keys(slices || {})
            .filter(id => id.startsWith(`${group}.`))
            .sort((a, b) => {
                const ak = a.endsWith(`.${COMMON_FILE_KIND}`) ? '' : a;
                const bk = b.endsWith(`.${COMMON_FILE_KIND}`) ? '' : b;
                return ak.localeCompare(bk);
            })
            .map(id => {
                const fileKind = id.slice(group.length + 1);
                return {
                    id,
                    ref: `work-slices/${group}/${this._safePathSegment(fileKind)}.json`,
                    readGroup: group,
                    fileKind,
                    whenToRead: fileKind === COMMON_FILE_KIND
                        ? `${group === 'rules' ? '通用规则红线' : '通用公司实践'}；当前 fileKind 没有专属桶时也可按需读取。`
                        : `当前 fileKind=${fileKind} 时读取。`
                };
            });
    }

    _buildRuleSlices({ ruleCheckCards = [], redlineGuide = null } = {}) {
        const buckets = this._bucketCardsByFileKind(ruleCheckCards);
        for (const [fileKind, cards] of this._requiredRuleMenuBuckets().entries()) {
            if (!buckets.has(fileKind)) buckets.set(fileKind, []);
            buckets.get(fileKind).push(...cards);
        }
        const out = {};
        const commonKey = COMMON_FILE_KIND;
        if (!buckets.has(commonKey)) buckets.set(commonKey, []);
        for (const [fileKind, cards] of buckets.entries()) {
            const id = `rules.${fileKind}`;
            const dedupedCards = this._dedupeCards(cards);
            out[id] = this._replaceDraftRefs(stripUndefined({
                schemaVersion: `work-slice/rules/${fileKind}/v1`,
                purpose: fileKind === COMMON_FILE_KIND
                    ? '通用规则红线、规则池和未绑定 fileKind 的规则小卡。'
                    : `fileKind=${fileKind} 的规则小卡。`,
                fileKind,
                ruleMenuPolicy: '本切片是当前 fileKind 可用规则菜单，不是全文预读清单；Coder 先做能力规划，再按本轮真正触碰的能力选择规则或项目 API 证据。',
                ruleMenuCards: dedupedCards,
                ...(fileKind === COMMON_FILE_KIND ? { redlineGuide } : {})
            }));
        }
        return out;
    }

    _requiredRuleMenuBuckets() {
        const buckets = new Map();
        let map = {};
        try {
            map = this.requiredRulesConfigService.getFileKindRequiredRulesMap() || {};
        } catch (_) {
            map = {};
        }
        Object.entries(map).forEach(([fileKind, aliases]) => {
            const kind = this._normalizeFileKind(fileKind);
            if (!kind) return;
            const cards = uniqueNonEmptyStrings(aliases).map(ruleAlias => this._requiredRuleMenuCard(ruleAlias, kind));
            if (cards.length === 0) return;
            buckets.set(kind, cards);
        });
        return buckets;
    }

    _requiredRuleMenuCard(ruleAlias = '', fileKind = '') {
        const alias = String(ruleAlias || '').trim();
        const kind = this._normalizeFileKind(fileKind);
        return stripUndefined({
            source: 'design-tdd-required-rules-menu',
            ruleAlias: alias,
            appliesToFileKinds: kind ? [kind] : [],
            askYourself: `本轮 ${kind || '当前文件'} patch 是否会用到「${alias}」约束的能力？`,
            whenNeeded: `能力规划选中「${alias}」或代码中出现相关 API/类型/职责时，再读取本地规则卡指向的正文或项目样例确认。`,
            menuOnly: true
        });
    }

    _buildJavaDependencySelfCheckCard() {
        return {
            actionMode: 'llm_self_check_before_mark_no_gate',
            timing: 'Java/后端文件 patch 后、连续实现批次自查时使用；本卡不触发硬门禁。',
            purpose: '让 Coder 自查新增 import、类型、工具方法、项目 API 和 pom 依赖来源，避免凭记忆写不存在的方法或漏依赖。',
            requiredOutput: [
                '本轮新增/修改 import：',
                '本轮新增类型、工具方法、项目 API、注解、配置或依赖引用；按实际 import/new/call/static call/annotation/pom 变化列，不按固定枚举凑项。',
                '每个类型/方法的证据来源：规则菜单、项目 API 规则、真实源码、项目样例或已有 pom/父 pom。',
                'pom 是否需要修改；不改时说明父 pom 已有、子模块继承、已有项目依赖或本轮未新增外部 jar。'
            ],
            readPolicy: '只对本轮实际新增/修改的 Java 能力补证据；不要为了自检全量读取规则或 pom。'
        };
    }

    _buildPracticeSlices({ practiceCards = [] } = {}) {
        const buckets = this._bucketCardsByFileKind(practiceCards);
        const out = {};
        if (buckets.size === 0) {
            buckets.set(COMMON_FILE_KIND, []);
        }
        for (const [fileKind, cards] of buckets.entries()) {
            const id = `practices.${fileKind}`;
            out[id] = this._replaceDraftRefs(stripUndefined({
                schemaVersion: `work-slice/practices/${fileKind}/v1`,
                purpose: fileKind === COMMON_FILE_KIND
                    ? '未绑定 fileKind 的通用公司最佳实践卡。'
                    : `fileKind=${fileKind} 的公司最佳实践卡。`,
                fileKind,
                practiceCards: this._dedupeCards(cards)
            }));
        }
        return out;
    }

    _bucketCardsByFileKind(cards = []) {
        const buckets = new Map();
        for (const card of array(cards)) {
            if (!card || typeof card !== 'object') continue;
            const kinds = this._cardFileKinds(card);
            const targetKinds = kinds.length > 0 ? kinds : [COMMON_FILE_KIND];
            targetKinds.forEach(kind => {
                if (!buckets.has(kind)) buckets.set(kind, []);
                buckets.get(kind).push(card);
            });
        }
        return buckets;
    }

    _cardFileKinds(card = {}) {
        return uniqueNonEmptyStrings([
            ...array(card.appliesToFileKinds),
            ...array(card.fileKinds),
            ...array(card.applyToFileKinds),
            ...array(card.targetFileKinds),
            card.fileKind,
            card.targetFileKind
        ]).map(kind => this._normalizeFileKind(kind)).filter(Boolean);
    }

    _dedupeCards(cards = []) {
        const out = [];
        const seen = new Set();
        array(cards).forEach(card => {
            const key = JSON.stringify(card);
            if (key && seen.has(key)) return;
            if (key) seen.add(key);
            out.push(card);
        });
        return out;
    }

    _buildTopRedlines(fullDraft = {}) {
        const fromCards = array(fullDraft && fullDraft.redlineGuide && fullDraft.redlineGuide.activeCards)
            .map(card => String(card && (card.title || card.id || card.summary) || '').trim())
            .filter(Boolean);
        return uniqueNonEmptyStrings([
            'API 调用先验真方法/签名，禁止猜。',
            '只在 authorizedWriteRoots 内修改或新增业务源码；候选文件和既有入口仅作参考。',
            '页面调用必须闭合到候选 Action public 方法；跨 Action 必须显式 action/method。',
            ...fromCards
        ]).slice(0, 6);
    }

    _collectAcceptanceCodes({ firstEditCard = {}, storyCards = [], userStories = [] } = {}) {
        const direct = uniqueNonEmptyStrings(firstEditCard.acceptanceCodes);
        if (direct.length > 0) return direct;
        const storyId = String(firstEditCard.storyId || '').trim().toUpperCase();
        const candidates = [
            ...array(storyCards),
            ...array(userStories)
        ];
        const story = candidates.find(item =>
            String(item && (item.storyId || item.id || item.sourceStoryId) || '').trim().toUpperCase() === storyId)
            || candidates[0]
            || {};
        const out = [];
        const fromItems = array(story.acceptanceItems);
        for (const item of fromItems) {
            const code = String(item && item.code || '').trim();
            if (code) out.push(code);
        }
        const criteria = story.acceptanceCriteria && typeof story.acceptanceCriteria === 'object'
            ? story.acceptanceCriteria
            : {};
        ['happyPath', 'exception', 'boundary'].forEach(group => {
            array(criteria[group]).forEach(item => {
                const code = String(item && item.code || '').trim();
                if (code) out.push(code);
            });
        });
        return uniqueNonEmptyStrings(out);
    }

    _replaceDraftRefs(value) {
        if (typeof value === 'string') {
            return value
                .replace(/requirementWorkDraft\.candidateFileCards/g, 'work-slices/files-fields.json#candidateFileCards')
                .replace(/requirementWorkDraft\.businessFieldCards/g, 'work-slices/files-fields.json#businessFieldCards')
                .replace(/requirementWorkDraft\.ruleCheckCards/g, 'readCatalog.byFileKind[当前fileKind] -> work-slices/rules/<fileKind>.json#ruleMenuCards -> contentRef')
                .replace(/requirementWorkDraft\.redlineGuide\.activeCards/g, 'work-slices/rules/Common.json#redlineGuide.activeCards')
                .replace(/requirementWorkDraft\.practiceCards/g, 'readCatalog.byFileKind[当前fileKind] -> work-slices/practices/<fileKind>.json#practiceCards')
                .replace(/requirementWorkDraft\.routeCards/g, 'work-slices/routes.json#routeCards')
                .replace(/requirementWorkDraft\.pageApiSelfCheckCard/g, 'work-slices/routes.json#pageApiSelfCheckCard')
                .replace(/requirementWorkDraft\.reuseGuideCards/g, 'work-slices/reuse.json#reuseGuideCards')
                .replace(/requirementWorkDraft\.reuseTableGuideCards/g, 'work-slices/reuse.json#reuseTableGuideCards')
                .replace(/requirementWorkDraft\.reuseFieldMappingCards/g, 'work-slices/reuse.json#reuseFieldMappingCards')
                .replace(/requirementWorkDraft\.postEditSelfCheckCard/g, 'work-slices/self-check.json#postEditSelfCheckCard');
        }
        if (Array.isArray(value)) {
            return value.map(item => this._replaceDraftRefs(item));
        }
        if (value && typeof value === 'object') {
            const out = {};
            Object.keys(value).forEach(key => {
                const next = this._replaceDraftRefs(value[key]);
                if (next === undefined || next === null || next === '') return;
                if (Array.isArray(next) && next.length === 0) return;
                out[key] = next;
            });
            return out;
        }
        return value;
    }

    _normalizeResourceItem(item = {}) {
        return stripUndefined({
            id: String(item && item.id || '').trim(),
            ref: String(item && item.ref || '').trim(),
            readGroup: String(item && item.readGroup || '').trim(),
            fileKind: this._normalizeFileKind(item && item.fileKind),
            whenToRead: String(item && item.whenToRead || '').trim(),
            byteSize: item && item.byteSize
        });
    }

    _readPhaseForItem(item = {}, currentKind = '') {
        const id = String(item && item.id || '').trim();
        const group = String(item && item.readGroup || '').trim();
        const kind = this._normalizeFileKind(item && item.fileKind);
        if (id === 'self-check' || group === 'self-check') return 'afterPatch';
        if (id === 'stories' || id === 'files-fields') return 'onDemand';
        if (group === 'rules' || group === 'practices') {
            if (kind === COMMON_FILE_KIND) return 'onDemand';
            return currentKind && kind === currentKind ? 'must' : 'onDemand';
        }
        if (id === 'routes' || group === 'routes') {
            return currentKind === 'HtmlPage' ? 'must' : 'onDemand';
        }
        return 'onDemand';
    }

    _readReasonForItem(item = {}, currentKind = '', phase = '') {
        const id = String(item && item.id || '').trim();
        const group = String(item && item.readGroup || '').trim();
        const kind = this._normalizeFileKind(item && item.fileKind);
        if (phase === 'afterPatch') return '写完当前连续实现批次、更新实施计划前读取。';
        if (phase === 'must') {
            if (group === 'rules' || group === 'practices') {
                return kind === COMMON_FILE_KIND
                    ? '通用规则/实践，当前 fileKind 也必须遵守。'
                    : `当前 targetFile 的 fileKind=${currentKind || kind}，命中本桶。`;
            }
            if (group === 'routes') return '当前修改 HtmlPage，必须核对页面调用和 Action public 方法闭合。';
            return '当前首改/验收项必需的基础事实。';
        }
        if (id === 'stories') return 'storyBrief 不足以判断验收细节时读取。';
        if (id === 'files-fields') return '当前需求资料不足或缺字段来源时读取；不要把本文件当成逐文件施工清单。';
        if (kind === COMMON_FILE_KIND) return '通用规则/实践仅作按需补证据；当前 fileKind 已有专属桶时不要前置全文读取。';
        return '按需读取；当前 fileKind 未命中或仅在修改对应能力时需要。';
    }

    _normalizeFileKind(value = '') {
        const text = String(value || '').trim();
        if (!text) return '';
        const known = {
            htmlpage: 'HtmlPage',
            action: 'Action',
            rest: 'Rest',
            job: 'Job',
            entity: 'Entity',
            serviceapi: 'ServiceApi',
            serviceinternal: 'ServiceInternal',
            serviceimpl: 'ServiceImpl',
            js: 'Js',
            css: 'Css',
            common: COMMON_FILE_KIND
        };
        return known[text.toLowerCase()] || text.replace(/[\\/:*?"<>|\s]+/g, '');
    }

    _safePathSegment(value = '') {
        return this._normalizeFileKind(value) || COMMON_FILE_KIND;
    }
}

DesignTddWorkSliceService.DRAFT_INDEX_SCHEMA = DRAFT_INDEX_SCHEMA;
DesignTddWorkSliceService.SLICE_INDEX_SCHEMA = SLICE_INDEX_SCHEMA;
DesignTddWorkSliceService.SLICE_DEFS = BASE_SLICE_DEFS;

module.exports = DesignTddWorkSliceService;
