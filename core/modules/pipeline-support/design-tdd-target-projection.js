/* eslint-disable */
const crypto = require('crypto');
const path = require('path');

function array(value) {
    return Array.isArray(value) ? value : [];
}

function uniqueStrings(...values) {
    const out = [];
    const seen = new Set();
    for (const group of values) {
        for (const value of (Array.isArray(group) ? group : [group])) {
            const text = String(value || '').trim();
            if (!text || seen.has(text)) continue;
            seen.add(text);
            out.push(text);
        }
    }
    return out;
}

function sha256(value) {
    return crypto.createHash('sha256').update(String(value || ''), 'utf8').digest('hex');
}

function stable(value) {
    if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
    if (!value || typeof value !== 'object') return JSON.stringify(value);
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`;
}

class DesignTddTargetProjection {
    project({
        projectPath = '',
        filePlan = [],
        modulePlans = [],
        dataAccessPlans = {},
        intents = [],
        resolveIntent = null
    } = {}) {
        const normalizedProject = String(projectPath || '').trim();
        const projectedFiles = array(filePlan).map(item => ({ ...item }));
        const intentResult = this._appendIntentFiles({
            projectPath: normalizedProject,
            filePlan: projectedFiles,
            modulePlans,
            intents,
            resolveIntent
        });
        if (!intentResult.ok) return intentResult;
        const modulesOwnerFiles = this.buildModulesOwnerFiles(
            intentResult.filePlan,
            modulePlans,
            normalizedProject,
            dataAccessPlans
        );
        this.attachDataAccessReadEvidence(modulesOwnerFiles, dataAccessPlans);
        const storyWorkPackages = this.buildStoryWorkPackages(modulesOwnerFiles);
        const integrity = this.verifyStoryWorkPackageProjection(modulesOwnerFiles, storyWorkPackages);
        if (!integrity.ok) {
            return {
                ok: false,
                status: 'blocked',
                errorCode: 'DESIGN_TDD_FILESET_PROJECTION_DEFECT',
                message: '唯一 fileSet 投影到 ownerFiles/storyWorkPackages 时文件身份或 hash 不一致。',
                fileProjectionIntegrity: integrity
            };
        }
        const storyProjectionHashes = {};
        storyWorkPackages.forEach(item => {
            storyProjectionHashes[String(item.storyId || '').trim().toUpperCase()] = item.fileIdentityHash;
        });
        return {
            ok: true,
            status: 'projection_ready',
            filePlan: intentResult.filePlan,
            modulesOwnerFiles,
            storyWorkPackages,
            fileProjectionIntegrity: integrity,
            projectionHashes: {
                projectionRevision: sha256(stable({
                    modulesOwnerFiles,
                    storyWorkPackages
                })),
                storyProjectionHashes
            },
            intents: intentResult.intents
        };
    }

    buildModulesOwnerFiles(filePlan = [], modulePlans = [], projectPath = '', dataAccessPlans = {}) {
        const grouped = new Map();
        const projectRoot = String(projectPath || '').trim();
        const moduleStoryIds = new Map(array(modulePlans)
            .map(module => [String(module && module.moduleId || '').trim(), String(module && (module.storyId || module.id) || '').trim().toUpperCase()])
            .filter(([moduleId, storyId]) => moduleId && storyId));
        for (const file of array(filePlan)) {
            if (String(file && file.role || 'owner').trim() !== 'owner') continue;
            const moduleId = String(file && file.moduleId || '').trim();
            if (!moduleId) continue;
            if (!grouped.has(moduleId)) grouped.set(moduleId, []);
            const rawPath = String(file.resolvedPath || file.path || '').trim();
            const absolutePath = path.isAbsolute(rawPath)
                ? rawPath
                : (projectRoot ? path.resolve(projectRoot, rawPath) : rawPath);
            const dataAccessPlan = dataAccessPlans && dataAccessPlans[moduleId] ? dataAccessPlans[moduleId] : null;
            const fileKind = String(file.fileKind || '').trim();
            const subType = String(file.subType || '').trim().toLowerCase();
            const queryOnly = file.queryOnly === true;
            const statisticsSourcePlan = dataAccessPlan && (
                String(dataAccessPlan.mode || '').trim() === 'statistics_source'
                || String(dataAccessPlan.accessType || '').trim() === 'statistics_sources'
            );
            const serviceOnlyPlan = dataAccessPlan && dataAccessPlan.serviceOnly === true;
            // 文件显式绑定的 Story 是唯一优先事实。只有文件完全没有声明 Story 时，
            // 才允许使用模块的单一 owner Story 作为默认值；否则会把同一模块的
            // Action/Rest 等跨 Story 文件错误复制到当前 Story 的施工包。
            const hasExplicitStoryBinding = array(file.writeStoryIds || file.storyIds).length > 0
                || array(file.readStoryIds).length > 0;
            const moduleDefaultStory = hasExplicitStoryBinding ? '' : moduleStoryIds.get(moduleId);
            const writeStoryIds = uniqueStrings(file.writeStoryIds || file.storyIds, moduleDefaultStory).map(id => id.toUpperCase());
            const readStoryIds = uniqueStrings(file.readStoryIds).map(id => id.toUpperCase());
            const ownerFile = {
                fileKind,
                resolvedPath: absolutePath,
                operation: file.operation || 'create',
                evidenceRef: file.evidenceRef || moduleId,
                subType: file.subType || '',
                ...(queryOnly ? { queryOnly: true } : {}),
                ...(file.statisticsOnly === true ? { statisticsOnly: true } : {}),
                ...(file.serviceOnly === true ? { serviceOnly: true } : {}),
                ...(file.noEntity === true ? { noEntity: true } : {}),
                ...(file.targetPageRole ? { targetPageRole: file.targetPageRole } : {}),
                ...(file.interactionCarrier ? { interactionCarrier: file.interactionCarrier } : {}),
                ...(file.objectKey ? { objectKey: file.objectKey } : {}),
                ...(writeStoryIds.length > 0 ? { storyIds: writeStoryIds, writeStoryIds } : {}),
                ...(readStoryIds.length > 0 ? { readStoryIds } : {}),
                ...(file.projectionSource ? { projectionSource: file.projectionSource } : {}),
                ...(file.managedProjection === true ? { managedProjection: true } : {}),
                ...(file.mechanicallyComplete === true
                    || (fileKind === 'Entity' && file.managedProjection === true)
                    ? { mechanicallyComplete: true }
                    : {}),
                ...(file.sectionKey ? { sectionKey: file.sectionKey } : {}),
                ...(dataAccessPlan && (
                    (queryOnly && (subType === 'list' || !subType))
                    || (fileKind === 'Rest' && String(dataAccessPlan.accessType || '').trim() === 'carried_rest_service')
                    || (statisticsSourcePlan && (fileKind === 'Action' || file.serviceOnly === true))
                    || (serviceOnlyPlan && file.serviceOnly === true)
                ) ? { dataAccessPlanRef: dataAccessPlan.planId } : {})
            };
            ownerFile.fileIdentity = this.ownerFileIdentity(moduleId, ownerFile);
            ownerFile.fileIdentityHash = sha256(ownerFile.fileIdentity);
            grouped.get(moduleId).push(ownerFile);
        }
        for (const list of grouped.values()) {
            list.sort((a, b) => {
                const order = { Entity: 1, ServiceApi: 2, ServiceInternal: 3, ServiceImpl: 4, Rest: 5, Job: 6, Action: 7, HtmlPage: 8 };
                const kindDelta = (order[String(a.fileKind || '')] || 99) - (order[String(b.fileKind || '')] || 99);
                if (kindDelta !== 0) return kindDelta;
                return String(a.subType || '').localeCompare(String(b.subType || ''));
            });
        }
        const result = [];
        for (const module of array(modulePlans)) {
            const moduleId = String(module && module.moduleId || '').trim();
            if (!grouped.has(moduleId) && !String(module && module.carriedByModuleId || '').trim()) continue;
            result.push({
                moduleId,
                storyId: String(module && (module.storyId || module.id) || '').trim().toUpperCase(),
                businessContext: {
                    ...(module.objectKey ? { objectKey: module.objectKey } : {}),
                    bizModule: module.bizModule || '',
                    domain: module.domain || '',
                    entityName: module.entityName || '',
                    featureName: module.featureName || '',
                    operationName: module.operationName || '',
                    pageName: module.pageName || '',
                    constructionSceneKey: module.constructionSceneKey || '',
                    carriedByModuleId: module.carriedByModuleId || '',
                    ...(module.pageComposition ? { pageComposition: module.pageComposition } : {}),
                    ...(module.statisticsContract ? { statisticsContract: module.statisticsContract } : {}),
                    ...(Array.isArray(module.statisticsContracts) && module.statisticsContracts.length > 0 ? { statisticsContracts: module.statisticsContracts } : {}),
                    ...(module.workflowContract ? { workflowContract: module.workflowContract } : {}),
                    ...(Array.isArray(module.workflowContracts) && module.workflowContracts.length > 0 ? { workflowContracts: module.workflowContracts } : {}),
                    ...(module.restContract ? { restContract: module.restContract } : {})
                },
                ownerFiles: grouped.get(moduleId) || []
            });
        }
        return result;
    }

    buildStoryWorkPackages(modulesOwnerFiles = []) {
        const grouped = new Map();
        const fileIdentity = (moduleId, file) => {
            const explicit = String(file && file.fileIdentity || '').trim();
            if (explicit) return explicit;
            const normalizedPath = path.resolve(String(file && file.resolvedPath || file && file.path || ''))
                .replace(/\\/g, '/')
                .toLowerCase();
            return [
                String(moduleId || '').trim(),
                String(file && file.fileKind || '').trim(),
                normalizedPath,
                String(file && file.objectKey || '').trim(),
                String(file && file.subType || '').trim().toLowerCase()
            ].join('|');
        };
        const append = (moduleId, file, storyId, access) => {
            const normalizedStoryId = String(storyId || '').trim().toUpperCase();
            if (!/^US\d+$/.test(normalizedStoryId)) return;
            if (!grouped.has(normalizedStoryId)) grouped.set(normalizedStoryId, []);
            const files = grouped.get(normalizedStoryId);
            const identity = fileIdentity(moduleId, file);
            const identityHash = String(file && file.fileIdentityHash || '').trim() || sha256(identity);
            const existing = files.find(item => item.fileIdentityHash === identityHash);
            if (existing) {
                if (existing.access === 'read' && access === 'write') existing.access = 'write';
                return;
            }
            files.push({
                moduleId,
                access,
                fileKind: String(file && file.fileKind || '').trim(),
                resolvedPath: String(file && file.resolvedPath || '').trim(),
                objectKey: String(file && file.objectKey || '').trim(),
                subType: String(file && file.subType || '').trim(),
                projectionSource: String(file && file.projectionSource || '').trim(),
                statisticsOnly: file && file.statisticsOnly === true,
                managedProjection: file && file.managedProjection === true,
                mechanicallyComplete: file && file.mechanicallyComplete === true,
                fileIdentity: identity,
                fileIdentityHash: identityHash
            });
        };
        const appendWriteBindings = module => {
            const moduleId = String(module && module.moduleId || '').trim();
            array(module && module.ownerFiles).forEach(file => {
                const hasExplicitStoryBinding = array(file && (file.writeStoryIds || file.storyIds)).length > 0
                    || array(file && file.readStoryIds).length > 0;
                const writeIds = uniqueStrings(
                    file && (file.writeStoryIds || file.storyIds),
                    hasExplicitStoryBinding ? '' : module && module.storyId
                );
                const access = file && file.mechanicallyComplete === true ? 'read' : 'write';
                writeIds.forEach(storyId => append(moduleId, file, storyId, access));
            });
        };
        const appendReadBindings = module => {
            const moduleId = String(module && module.moduleId || '').trim();
            array(module && module.ownerFiles).forEach(file => {
                uniqueStrings(file && file.readStoryIds).forEach(storyId => append(moduleId, file, storyId, 'read'));
            });
        };
        // 保持旧投影的闭包顺序：先扫描所有 owner/write 绑定，再补跨模块 read 依赖。
        // 这样 REST/Action 等当前 Story 的写目标不会被承载模块的只读依赖提前遮蔽。
        array(modulesOwnerFiles).forEach(appendWriteBindings);
        array(modulesOwnerFiles).forEach(appendReadBindings);
        return Array.from(grouped.entries())
            .sort((left, right) => this.storySortKey(left[0]) - this.storySortKey(right[0]))
            .map(([storyId, files]) => ({
                storyId,
                // 保留唯一 fileSet 的模块/文件顺序。该顺序同时表达机械文件闭包：
                // 共享实体先出现时先作为只读依赖，跨模块 Rest/Action 仍保持其原始承载顺序。
                files,
                fileIdentityHash: sha256(files.map(file => file.fileIdentityHash).sort().join('\n'))
            }));
    }

    attachDataAccessReadEvidence(modulesOwnerFiles = [], dataAccessPlans = {}) {
        const modulesById = new Map(array(modulesOwnerFiles)
            .map(module => [String(module && module.moduleId || '').trim(), module])
            .filter(([moduleId]) => moduleId));
        Object.values(dataAccessPlans && typeof dataAccessPlans === 'object' ? dataAccessPlans : {}).forEach(plan => {
            if (!plan || String(plan.mode || '').trim() !== 'carried_service') return;
            if (String(plan.accessType || '').trim() !== 'carried_rest_service') return;
            const storyIds = uniqueStrings(plan.storyIds).map(id => id.toUpperCase()).filter(id => /^US\d+$/.test(id));
            const carrier = modulesById.get(String(plan.carriedByModuleId || '').trim());
            if (!carrier || storyIds.length === 0) return;
            array(carrier.ownerFiles).forEach(file => {
                if (!['Entity', 'ServiceApi', 'ServiceInternal'].includes(String(file && file.fileKind || '').trim())) return;
                file.readStoryIds = uniqueStrings(file.readStoryIds, storyIds).map(id => id.toUpperCase());
            });
        });
    }

    ownerFileIdentity(moduleId = '', file = {}) {
        const normalizedPath = path.resolve(String(file && file.resolvedPath || '')).replace(/\\/g, '/').toLowerCase();
        return [
            String(moduleId || '').trim(),
            String(file && file.fileKind || '').trim(),
            normalizedPath,
            String(file && file.objectKey || '').trim(),
            String(file && file.subType || '').trim().toLowerCase()
        ].join('|');
    }

    verifyStoryWorkPackageProjection(modulesOwnerFiles = [], storyWorkPackages = []) {
        const expectedByStory = new Map();
        const actualByStory = new Map();
        const issues = [];
        array(modulesOwnerFiles).forEach(module => array(module && module.ownerFiles).forEach(file => {
            const identity = this.ownerFileIdentity(module.moduleId, file);
            const hash = sha256(identity);
            if (file.fileIdentity !== identity || file.fileIdentityHash !== hash) {
                issues.push({ code: 'OWNER_FILE_IDENTITY_STALE', moduleId: module.moduleId, fileKind: file.fileKind });
            }
            const hasExplicitStoryBinding = array(file && (file.writeStoryIds || file.storyIds)).length > 0
                || array(file && file.readStoryIds).length > 0;
            const storyIds = uniqueStrings(
                [...(file.writeStoryIds || file.storyIds || []), ...(file.readStoryIds || [])],
                hasExplicitStoryBinding ? '' : module && module.storyId
            )
                .map(id => id.toUpperCase()).filter(id => /^US\d+$/.test(id));
            storyIds.forEach(storyId => {
                if (!expectedByStory.has(storyId)) expectedByStory.set(storyId, []);
                if (!expectedByStory.get(storyId).includes(hash)) expectedByStory.get(storyId).push(hash);
            });
        }));
        array(storyWorkPackages).forEach(pkg => {
            const storyId = String(pkg && pkg.storyId || '').trim().toUpperCase();
            const hashes = array(pkg && pkg.files).map(file => {
                const identity = this.ownerFileIdentity(file && file.moduleId, file);
                const hash = sha256(identity);
                if (String(file && file.fileIdentity || '').trim() !== identity
                    || String(file && file.fileIdentityHash || '').trim() !== hash) {
                    issues.push({ code: 'STORY_WORK_PACKAGE_FILE_IDENTITY_STALE', storyId, fileKind: file && file.fileKind, resolvedPath: file && file.resolvedPath });
                }
                return String(file && file.fileIdentityHash || '').trim();
            }).filter(Boolean);
            actualByStory.set(storyId, hashes);
            if (pkg.fileIdentityHash !== sha256(hashes.slice().sort().join('\n'))) {
                issues.push({ code: 'STORY_WORK_PACKAGE_HASH_STALE', storyId });
            }
        });
        const storyIds = Array.from(new Set([...expectedByStory.keys(), ...actualByStory.keys()])).sort();
        storyIds.forEach(storyId => {
            const expected = (expectedByStory.get(storyId) || []).slice().sort();
            const actual = (actualByStory.get(storyId) || []).slice().sort();
            if (stable(expected) !== stable(actual)) issues.push({ code: 'STORY_WORK_PACKAGE_FILESET_DRIFT', storyId, expected, actual });
        });
        return {
            ok: issues.length === 0,
            ownerFileCount: Array.from(expectedByStory.values()).reduce((sum, values) => sum + values.length, 0),
            storyCount: storyIds.length,
            issues
        };
    }

    _appendIntentFiles({ projectPath = '', filePlan = [], modulePlans = [], intents = [], resolveIntent = null } = {}) {
        const output = array(filePlan).map(item => ({ ...item }));
        const accepted = [];
        for (const intent of array(intents)) {
            if (!['ready_for_projection', 'projected'].includes(String(intent && intent.lifecycleStatus || '').trim())) continue;
            const resolved = typeof resolveIntent === 'function'
                ? resolveIntent({ projectPath, intent, modulePlans, filePlan: output })
                : (String(intent && intent.resolvedPath || '').trim()
                    ? { ok: true, file: { ...intent, resolvedPath: intent.resolvedPath } }
                    : { ok: false, errorCode: 'FRAMEWORK_NAVIGATION_MISSING', message: 'implementation intent 缺少受管 Builder 文件解析器。' });
            if (!resolved || resolved.ok !== true || !resolved.file) return resolved || {
                ok: false,
                errorCode: 'DESIGN_TDD_TARGET_PROJECTION_DEFECT',
                message: '无法从 implementation intent 解析唯一文件身份。'
            };
            const file = {
                ...resolved.file,
                role: 'owner',
                projectionSource: 'implementation-file-intent',
                managedProjection: true,
                writeStoryIds: [String(intent.storyId || '').trim().toUpperCase()],
                storyIds: [String(intent.storyId || '').trim().toUpperCase()],
                contractRows: uniqueStrings(intent.contractRows),
                intentRequestId: String(intent.requestId || '').trim()
            };
            const key = `${String(file.fileKind || '').trim()}:${path.resolve(String(file.resolvedPath || '')).toLowerCase()}`;
            const existing = output.find(item => `${String(item.fileKind || '').trim()}:${path.resolve(String(item.resolvedPath || '')).toLowerCase()}` === key);
            if (existing) {
                const existingRows = uniqueStrings(existing.contractRows);
                const incomingRows = uniqueStrings(file.contractRows);
                if (existingRows.length > 0 && incomingRows.length > 0
                    && stable(existingRows.slice().sort()) !== stable(incomingRows.slice().sort())) {
                    return { ok: false, errorCode: 'DESIGN_TDD_TARGET_PROJECTION_CONFLICT', message: `文件身份冲突：${key}` };
                }
                existing.writeStoryIds = uniqueStrings([...(existing.writeStoryIds || existing.storyIds || []), ...(file.writeStoryIds || [])]);
                existing.storyIds = existing.writeStoryIds.slice();
                existing.contractRows = uniqueStrings(existingRows, incomingRows);
            } else {
                output.push(file);
            }
            accepted.push(intent);
        }
        return { ok: true, filePlan: output, intents: accepted };
    }

    storySortKey(storyId = '') {
        const match = String(storyId || '').match(/(\d+)/);
        return match ? Number(match[1]) : Number.MAX_SAFE_INTEGER;
    }
}

module.exports = DesignTddTargetProjection;
