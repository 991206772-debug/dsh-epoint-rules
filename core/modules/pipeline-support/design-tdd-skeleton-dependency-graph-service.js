/* eslint-disable */
const path = require('path');

const FILE_KIND_RANK = Object.freeze({
    Entity: 1,
    ServiceApi: 2,
    ServiceInternal: 3,
    ServiceImpl: 4,
    Rest: 5,
    Job: 6,
    Action: 7,
    HtmlPage: 8
});

function array(value) {
    return Array.isArray(value) ? value : [];
}

class DesignTddSkeletonDependencyGraphService {
    build({ projectPath = '', modulesOwnerFiles = [], modulePlans = [], dataAccessPlans = {}, serviceContractSeeds = [] } = {}) {
        const projectRoot = String(projectPath || '').trim();
        const moduleById = new Map(array(modulePlans)
            .map(module => [String(module && module.moduleId || '').trim(), module])
            .filter(([moduleId]) => moduleId));
        const records = [];
        const providers = new Map();

        const normalizeTarget = value => {
            const raw = String(value || '').trim();
            if (!raw) return '';
            const absolute = path.isAbsolute(raw) ? raw : path.resolve(projectRoot || '.', raw);
            return path.resolve(absolute).replace(/\\/g, '/').toLowerCase();
        };
        const identityFor = (fileKind, resolvedPath) => fileKind + ':' + normalizeTarget(resolvedPath);
        const addProvider = (moduleId, fileKind, record) => {
            const key = moduleId + ':' + fileKind;
            if (!providers.has(key)) providers.set(key, []);
            providers.get(key).push(record);
        };

        array(modulesOwnerFiles).forEach(module => {
            const moduleId = String(module && module.moduleId || '').trim();
            array(module && module.ownerFiles).forEach(file => {
                const fileKind = String(file && file.fileKind || '').trim();
                const resolvedPath = String(file && file.resolvedPath || '').trim();
                if (!moduleId || !fileKind || !resolvedPath) return;
                const providerFileIdentity = identityFor(fileKind, resolvedPath);
                const record = {
                    targetId: providerFileIdentity,
                    providerFileIdentity,
                    moduleId,
                    fileKind,
                    resolvedPath,
                    subType: String(file.subType || '').trim().toLowerCase(),
                    queryOnly: file.queryOnly === true,
                    serviceOnly: file.serviceOnly === true,
                    noEntity: file.noEntity === true,
                    storyIds: array(file.storyIds || file.writeStoryIds)
                        .concat(array(file.readStoryIds))
                        .map(storyId => String(storyId || '').trim().toUpperCase())
                        .filter(Boolean),
                    providedTypes: [{
                        kind: fileKind,
                        className: path.basename(resolvedPath).replace(/\.[^.]+$/u, '')
                    }],
                    requiredTypeBindings: [],
                    requiredMethodBindings: [],
                    generationRank: FILE_KIND_RANK[fileKind] || 99
                };
                records.push(record);
                addProvider(moduleId, fileKind, record);
            });
        });

        const missing = [];
        const findProvider = (moduleId, fileKind, target) => {
            const candidates = providers.get(moduleId + ':' + fileKind) || [];
            if (candidates.length === 1) return candidates[0];
            missing.push({
                target: target.providerFileIdentity,
                requiredFileKind: fileKind,
                providerModuleId: moduleId,
                message: candidates.length === 0
                    ? '目标 ' + target.resolvedPath + ' 缺少唯一 ' + fileKind + ' provider。'
                    : '目标 ' + target.resolvedPath + ' 找到多个 ' + fileKind + ' provider，禁止猜选。'
            });
            return null;
        };
        const bindType = (target, provider) => {
            if (!provider) return;
            target.requiredTypeBindings.push({
                bindingKind: 'type',
                providerFileIdentity: provider.providerFileIdentity,
                providerModuleId: provider.moduleId,
                providerFileKind: provider.fileKind,
                expectedType: provider.providedTypes[0].className
            });
        };

        records.forEach(record => {
            const accessPlan = dataAccessPlans && dataAccessPlans[record.moduleId]
                ? dataAccessPlans[record.moduleId]
                : {};
            const module = moduleById.get(record.moduleId) || {};
            const providerModuleId = String(
                accessPlan.carriedByModuleId
                || module.carriedByModuleId
                || record.moduleId
            ).trim();
            const isStatistics = String(module.constructionSceneKey || '').trim() === 'statistics_analysis';
            const accessType = String(accessPlan.accessType || '').trim();

            if (record.fileKind === 'ServiceInternal') {
                bindType(record, findProvider(record.moduleId, 'ServiceApi', record));
            } else if (record.fileKind === 'ServiceImpl') {
                bindType(record, findProvider(record.moduleId, 'ServiceInternal', record));
                bindType(record, findProvider(record.moduleId, 'ServiceApi', record));
            } else if (['Action', 'Rest', 'Job'].includes(record.fileKind)) {
                if (record.serviceOnly !== true && record.noEntity !== true && accessPlan.noEntity !== true) {
                    bindType(record, findProvider(providerModuleId, 'Entity', record));
                }
                bindType(record, findProvider(providerModuleId, 'ServiceApi', record));
                if (isStatistics || accessType === 'carried_query_list' || accessType === 'statistics_sources') {
                    bindType(record, findProvider(providerModuleId, 'ServiceInternal', record));
                }
            } else if (record.fileKind === 'HtmlPage') {
                const pairedActionSubType = record.subType === 'workflowdetail' ? 'workflow' : record.subType;
                const actionCandidates = (providers.get(record.moduleId + ':Action') || [])
                    .filter(action => !pairedActionSubType || action.subType === pairedActionSubType);
                if (actionCandidates.length !== 1) {
                    missing.push({
                        target: record.providerFileIdentity,
                        requiredFileKind: 'Action',
                        providerModuleId: record.moduleId,
                        message: '页面 ' + record.resolvedPath + ' 缺少与 subType 对应的唯一 Action。'
                    });
                } else {
                    bindType(record, actionCandidates[0]);
                }
            }

            const recordStoryIds = new Set([
                ...record.storyIds,
                String(module.storyId || '').trim().toUpperCase()
            ].filter(Boolean));
            // 统计契约方法只绑到入口层消费方（Action/Rest/Job）：
            // queryStatisticsData 由 ServiceInternal 提供实现、Action 调用。接口（ServiceApi）
            // 与 provider 自身（ServiceInternal）不产生方法依赖；历史版本不过滤 fileKind，
            // 导致 ServiceApi(先物化) 的 method 边指向 ServiceInternal(后物化)，
            // 与 type 边 ServiceInternal→ServiceApi 构成环，批次物化全量死锁。
            if (['Action', 'Rest', 'Job'].includes(record.fileKind)) {
                array(serviceContractSeeds)
                    .filter(seed => String(seed && seed.sourceType || '').trim() === 'statisticsContract')
                    .filter(seed => {
                        const sourceModuleId = String(seed && (seed.sourceModuleId || seed.moduleId) || '').trim();
                        if (sourceModuleId && sourceModuleId !== record.moduleId) return false;
                        const sourceStoryId = String(seed && (seed.sourceStoryId || seed.storyId) || '').trim().toUpperCase();
                        return !sourceStoryId || recordStoryIds.has(sourceStoryId);
                    })
                    .forEach(seed => {
                        const provider = (providers.get(providerModuleId + ':ServiceInternal') || [])[0];
                        if (!provider) return;
                        record.requiredMethodBindings.push({
                            providerFileIdentity: provider.providerFileIdentity,
                            methodName: String(seed.methodName || '').trim(),
                            sourceType: 'statisticsContract'
                        });
                    });
            }
        });

        if (missing.length > 0) {
            return {
                ok: false,
                status: 'blocked',
                errorCode: 'DESIGN_TDD_SKELETON_TYPE_BINDING_MISSING',
                message: '骨架依赖图无法为所有下游文件找到唯一上游类型 provider，禁止物化不完整骨架。',
                missingBindings: missing,
                allowedNextActions: ['repair_design_builder_projection_and_rerun_design_tdd_build_plan']
            };
        }

        // 环检测（Kahn 拓扑排序，type+method 全边）：循环依赖在 build_plan 阶段即暴露，
        // 不留到物化批次才死锁。自引用边同样会被捕获（入度永不为零）。
        const indegree = new Map(records.map(record => [record.providerFileIdentity, 0]));
        const adjacency = new Map(records.map(record => [record.providerFileIdentity, []]));
        records.forEach(record => {
            record.requiredTypeBindings.concat(record.requiredMethodBindings).forEach(required => {
                const providerId = String(required && required.providerFileIdentity || '').trim();
                if (!indegree.has(providerId) || !indegree.has(record.providerFileIdentity)) return;
                indegree.set(record.providerFileIdentity, indegree.get(record.providerFileIdentity) + 1);
                adjacency.get(providerId).push(record.providerFileIdentity);
            });
        });
        const readyQueue = Array.from(indegree.entries())
            .filter(([, degree]) => degree === 0)
            .map(([id]) => id);
        let visited = 0;
        const pendingQueue = readyQueue.slice();
        while (pendingQueue.length > 0) {
            const current = pendingQueue.shift();
            visited += 1;
            adjacency.get(current).forEach(next => {
                const degree = indegree.get(next) - 1;
                indegree.set(next, degree);
                if (degree === 0) pendingQueue.push(next);
            });
        }
        if (visited < records.length) {
            const cycleTargets = records
                .filter(record => indegree.get(record.providerFileIdentity) > 0)
                .map(record => record.providerFileIdentity);
            return {
                ok: false,
                status: 'blocked',
                errorCode: 'DESIGN_TDD_SKELETON_DEPENDENCY_CYCLE',
                message: '骨架依赖图存在循环依赖，禁止物化。',
                cycleTargets,
                allowedNextActions: ['repair_design_builder_projection_and_rerun_design_tdd_build_plan']
            };
        }

        const ordered = records.slice().sort((left, right) => {
            const rankDelta = left.generationRank - right.generationRank;
            return rankDelta || left.providerFileIdentity.localeCompare(right.providerFileIdentity);
        });
        return {
            ok: true,
            schemaVersion: 'design-tdd-skeleton-dependency-graph/v1',
            targetBindings: ordered,
            orderedTargetIds: ordered.map(item => item.providerFileIdentity),
            providerCount: ordered.length,
            edgeCount: ordered.reduce((count, item) => count + item.requiredTypeBindings.length, 0)
        };
    }
}

module.exports = DesignTddSkeletonDependencyGraphService;
