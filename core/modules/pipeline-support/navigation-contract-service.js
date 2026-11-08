/* eslint-disable */
const fs = require('fs');
const path = require('path');
const RuleValidationContract = require('../rule-validation-contract');

const DEFAULT_HEADINGS = [
    '## 1. 模块与落点',
    '## 2. 命名与路径规则摘要',
    '## 3. 真实样例锚点',
    '## 4. 后续阶段使用约束'
];

const EMPTY_PROJECT_BOOTSTRAP_MODE = 'empty_project_builtin_defaults';
const BACKEND_SAMPLE_KEYS = ['action', 'rest', 'service_api', 'service_impl', 'entity', 'job'];
const GENERATION_PATH_FILE_KINDS = Object.freeze({
    action: ['Action'],
    rest: ['Rest'],
    service_api: ['ServiceApi'],
    service_impl: ['ServiceImpl', 'ServiceInternal'],
    entity: ['Entity'],
    job: ['Job']
});
const BUILTIN_EXPERT_FILE_NAME_PATTERNS = Object.freeze({
    Entity: 'Gxh{EntityName}.java',
    ServiceApi: 'IGxh{EntityName}Service.java',
    ServiceInternal: 'Gxh{EntityName}Service.java',
    ServiceImpl: 'Gxh{EntityName}ServiceImpl.java',
    Action: 'Gxh{EntityName}{SubType}Action.java',
    Rest: 'Gxh{FeatureName}RestController.java',
    Job: 'Gxh{OperationName}Job.java',
    HtmlPage: 'gxh{pagename}{SubType}.html',
    Js: 'gxh{pagename}.js',
    Css: 'gxh{pagename}.css'
});
const BUILTIN_WEBSITE_FILE_NAME_PATTERNS = Object.freeze({
    ...BUILTIN_EXPERT_FILE_NAME_PATTERNS,
    HtmlPage: '{pageName}.html',
    Js: '{pageName}.js',
    Css: '{pageName}.css'
});

const EMPTY_PROJECT_DEFAULT_PLACEMENT_POLICY = {
    sourceRuleName: '内置空工程默认命名',
    backendPackageTemplate: 'com.epoint.xmgxh.{domain}.{bizModule}',
    backendPathTemplate: 'src/main/java/com/epoint/xmgxh/{domain}/{bizModule}',
    webPathTemplate: 'src/main/webapp/xmgxh/{bizModule}',
    bootstrap: true,
    paths: {
        action: 'src/main/java/com/epoint/xmgxh/{domain}/{bizModule}/action/',
        rest: 'src/main/java/com/epoint/xmgxh/{domain}/{bizModule}/rest/',
        service_api: 'src/main/java/com/epoint/xmgxh/{domain}/{bizModule}/api/',
        service_impl: 'src/main/java/com/epoint/xmgxh/{domain}/{bizModule}/impl/',
        entity: 'src/main/java/com/epoint/xmgxh/{domain}/{bizModule}/api/entity/',
        job: 'src/main/java/com/epoint/xmgxh/{domain}/{bizModule}/job/',
        web: 'src/main/webapp/xmgxh/{bizModule}/'
    },
    fileNamePatterns: {
        Entity: 'Gxh{EntityName}.java',
        ServiceApi: 'IGxh{EntityName}Service.java',
        ServiceInternal: 'Gxh{EntityName}Service.java',
        ServiceImpl: 'Gxh{EntityName}ServiceImpl.java',
        Action: 'Gxh{EntityName}{SubType}Action.java',
        Rest: 'Gxh{FeatureName}RestController.java',
        Job: 'Gxh{OperationName}Job.java',
        HtmlPage: 'gxh{pagename}{SubType}.html',
        Js: 'gxh{pagename}.js',
        Css: 'gxh{pagename}.css'
    },
    databaseNamingContract: {
        source: 'rule',
        sourceRule: '内置空工程默认命名',
        usage: 'generation',
        tableNamePattern: 'xm_{moduleAbbr}_{tableFeatureName}',
        caseStyle: 'lower_snake',
        requiredVariables: ['moduleAbbr', 'tableFeatureName']
    }
};

class NavigationContractService {
    constructor(options = {}) {
        this.baselineScanner = options.baselineScanner || null;
        this.ensureDirectoryExists = typeof options.ensureDirectoryExists === 'function'
            ? options.ensureDirectoryExists
            : dirPath => {
                if (dirPath && !fs.existsSync(dirPath)) fs.mkdirSync(dirPath, { recursive: true });
                return dirPath;
            };
        this.hasUnfilledTemplateMarker = typeof options.hasUnfilledTemplateMarker === 'function'
            ? options.hasUnfilledTemplateMarker
            : () => false;
        this.readNavigationContractJsonState = typeof options.readNavigationContractJsonState === 'function'
            ? options.readNavigationContractJsonState
            : () => ({ ok: false, message: 'NAVIGATION_CONTRACT_JSON_STATE_UNAVAILABLE' });
        this.buildCompactPayload = typeof options.buildCompactPayload === 'function'
            ? options.buildCompactPayload
            : payload => payload;
        this.writeJsonArtifact = typeof options.writeJsonArtifact === 'function'
            ? options.writeJsonArtifact
            : (filePath, payload) => fs.writeFileSync(filePath, JSON.stringify(payload, null, 2), 'utf-8');
        this.deriveCompactJsonPath = typeof options.deriveCompactJsonPath === 'function'
            ? options.deriveCompactJsonPath
            : filePath => {
                const sourcePath = String(filePath || '').trim();
                if (!sourcePath) return '';
                const parsed = path.parse(sourcePath);
                return path.join(parsed.dir, `${parsed.name}.compact.json`);
            };
        this.resolvePlacementPolicy = typeof options.resolvePlacementPolicy === 'function'
            ? options.resolvePlacementPolicy
            : () => null;
    }

    _hasBackendSourceEvidence(snapshotData = null, summary = null) {
        const snapshot = snapshotData && typeof snapshotData === 'object' ? snapshotData : {};
        const modules = Array.isArray(snapshot.modules) ? snapshot.modules : [];
        if (modules.some(module => module && module.hasJavaRoot === true)) return true;
        if (modules.some(module => Number(module && module.javaCount || 0) > 0)) return true;
        if (modules.some(module => {
            const counts = module && module.kindCounts && typeof module.kindCounts === 'object'
                ? module.kindCounts
                : {};
            return ['action', 'rest', 'serviceApi', 'serviceImpl', 'entity', 'job']
                .some(key => Number(counts[key] || 0) > 0);
        })) return true;

        const sampleSources = [snapshot.samples, summary && summary.samples];
        return sampleSources.some(samples => BACKEND_SAMPLE_KEYS.some(key =>
            Array.isArray(samples && samples[key]) && samples[key].length > 0
        ));
    }

    _resolveEffectivePlacementPolicy(projectPath, snapshotData = null, summary = null) {
        const resolvedPlacementPolicy = this.resolvePlacementPolicy(projectPath, snapshotData);
        const hasExplicitPlacementPaths = !!(resolvedPlacementPolicy
            && resolvedPlacementPolicy.paths
            && typeof resolvedPlacementPolicy.paths === 'object'
            && Object.values(resolvedPlacementPolicy.paths).some(value => String(value || '').trim()));
        const hasProjectInventory = !!(snapshotData && typeof snapshotData === 'object'
            && (Array.isArray(snapshotData.modules)
                || (snapshotData.samples && typeof snapshotData.samples === 'object')));
        const hasBackendSourceEvidence = this._hasBackendSourceEvidence(snapshotData, summary);
        if (!hasBackendSourceEvidence && (hasProjectInventory || !hasExplicitPlacementPaths)) {
            return {
                placementPolicy: EMPTY_PROJECT_DEFAULT_PLACEMENT_POLICY,
                bootstrap: {
                    mode: EMPTY_PROJECT_BOOTSTRAP_MODE,
                    source: 'builtin',
                    reason: '未观测到 Java 后端源码样例，使用内置公司默认目录与命名合同。'
                }
            };
        }
        return {
            placementPolicy: resolvedPlacementPolicy,
            bootstrap: null
        };
    }

    _mergeSampleBucket(primary = [], secondary = [], limit = 3) {
        const merged = [];
        const push = value => {
            const normalized = String(value || '').replace(/\\/g, '/').replace(/\/{2,}/g, '/').replace(/^\/+/, '').trim();
            if (normalized && !merged.includes(normalized)) merged.push(normalized);
        };
        (Array.isArray(primary) ? primary : []).forEach(push);
        (Array.isArray(secondary) ? secondary : []).forEach(push);
        return merged.slice(0, limit);
    }

    buildAnchorSummary(projectPath, snapshotData = null) {
        const scanner = this.baselineScanner;
        const snapshotPaths = snapshotData && snapshotData.paths ? snapshotData.paths : {};
        const observedSamples = scanner && typeof scanner.collectBaselineSamples === 'function'
            ? scanner.collectBaselineSamples(projectPath)
            : {};
        const snapshotSamples = snapshotData && snapshotData.samples && typeof snapshotData.samples === 'object'
            ? snapshotData.samples
            : {};
        const samples = {
            action: this._mergeSampleBucket(snapshotSamples.action, observedSamples.action),
            rest: this._mergeSampleBucket(snapshotSamples.rest, observedSamples.rest),
            service_api: this._mergeSampleBucket(snapshotSamples.service_api, observedSamples.service_api),
            service_impl: this._mergeSampleBucket(snapshotSamples.service_impl, observedSamples.service_impl),
            entity: this._mergeSampleBucket(snapshotSamples.entity, observedSamples.entity),
            job: this._mergeSampleBucket(snapshotSamples.job, observedSamples.job),
            web: this._mergeSampleBucket(snapshotSamples.web, observedSamples.web)
        };
        const fallbackRoots = scanner && typeof scanner.getFallbackRoots === 'function'
            ? scanner.getFallbackRoots()
            : {};
        const resolveRoot = key => {
            const fallbackPath = String(snapshotPaths[key] || fallbackRoots[key] || '').trim();
            if (scanner && typeof scanner.resolveBaselineRoot === 'function') {
                return scanner.resolveBaselineRoot(samples[key], fallbackPath);
            }
            return fallbackPath;
        };
        const pathsPayload = {
            action: resolveRoot('action'),
            rest: resolveRoot('rest'),
            service_api: resolveRoot('service_api'),
            service_impl: resolveRoot('service_impl'),
            entity: resolveRoot('entity'),
            job: resolveRoot('job'),
            web: resolveRoot('web')
        };
        return {
            root: snapshotData && snapshotData.root ? snapshotData.root : projectPath,
            product: snapshotData && snapshotData.product ? snapshotData.product : path.basename(projectPath),
            generator: snapshotData && snapshotData.generator ? snapshotData.generator : 'unknown',
            paths: pathsPayload,
            roots: pathsPayload,
            samples: {
                action: Array.isArray(samples.action) ? samples.action.slice(0, 3) : [],
                rest: Array.isArray(samples.rest) ? samples.rest.slice(0, 3) : [],
                service_api: Array.isArray(samples.service_api) ? samples.service_api.slice(0, 3) : [],
                service_impl: Array.isArray(samples.service_impl) ? samples.service_impl.slice(0, 3) : [],
                entity: Array.isArray(samples.entity) ? samples.entity.slice(0, 3) : [],
                job: Array.isArray(samples.job) ? samples.job.slice(0, 3) : [],
                web: Array.isArray(samples.web) ? samples.web.slice(0, 3) : []
            }
        };
    }

    buildContractPayload(projectPath, snapshotData = null) {
        const summary = this.buildAnchorSummary(projectPath, snapshotData);
        const rootPaths = summary && typeof summary === 'object'
            ? (summary.paths || summary.roots || {})
            : {};
        const sanitizeArray = value => Array.isArray(value) ? value : [];
        const sanitizeObject = value => value && typeof value === 'object' ? value : {};
        const effectivePlacement = this._resolveEffectivePlacementPolicy(projectPath, snapshotData, summary);
        const placementPolicy = effectivePlacement.placementPolicy;
        const ownershipRules = sanitizeArray(snapshotData && snapshotData.ownershipRules);
        const placementCandidates = sanitizeArray(snapshotData && snapshotData.placementCandidates);
        const finalRootPaths = this.alignRootPathsToOwnership(
            this.applyRulePlacementPolicyToPaths(rootPaths, placementPolicy),
            ownershipRules,
            sanitizeArray(snapshotData && snapshotData.modules)
        );
        const preserveSnapshotWebPath = this.shouldPreserveSnapshotWebPath(snapshotData, placementPolicy);
        if (preserveSnapshotWebPath) {
            finalRootPaths.web = snapshotData.paths.web;
        }
        const webPreservedRootPaths = preserveSnapshotWebPath
            ? { ...finalRootPaths, web: snapshotData.paths.web }
            : finalRootPaths;
        const observedProjectFacts = this.buildObservedProjectFacts(snapshotData, summary, placementCandidates);
        const rulePlacementContract = this.buildRulePlacementContract(
            placementPolicy,
            ownershipRules,
            webPreservedRootPaths,
            sanitizeArray(snapshotData && snapshotData.modules)
        );
        const placementContractDraft = this.buildCompatiblePlacementDraft(
            sanitizeObject(snapshotData && snapshotData.placementContractDraft),
            rulePlacementContract,
            observedProjectFacts
        );
        return {
            generatedAt: new Date().toISOString(),
            root: summary.root,
            product: summary.product,
            generator: summary.generator,
            paths: finalRootPaths,
            samples: summary.samples || {},
            projectType: String(snapshotData && snapshotData.projectType || '').trim() || 'single-module',
            modules: sanitizeArray(snapshotData && snapshotData.modules),
            ownershipRules,
            placementCandidates: this.markEvidenceOnlyCandidates(
                this.applyRulePlacementPolicyToCandidates(placementCandidates, placementPolicy)
            ),
            databaseNamingContract: placementPolicy && placementPolicy.databaseNamingContract ? placementPolicy.databaseNamingContract : null,
            rulePlacementContract,
            observedProjectFacts,
            contractConflicts: this.detectContractConflicts(rulePlacementContract, observedProjectFacts),
            placementContractDraft,
            diagnostics: sanitizeObject(snapshotData && snapshotData.diagnostics),
            ...(effectivePlacement.bootstrap ? { bootstrap: effectivePlacement.bootstrap } : {}),
            warnings: sanitizeArray(snapshotData && snapshotData.warnings)
        };
    }

    shouldPreserveSnapshotWebPath(snapshotData = null, placementPolicy = null) {
        const snapshotWebPath = String(snapshotData && snapshotData.paths && snapshotData.paths.web || '').trim();
        if (!snapshotWebPath) return false;
        if (placementPolicy && placementPolicy.preserveWebPathFromSnapshot) return true;
        const diagnostics = snapshotData && snapshotData.diagnostics && typeof snapshotData.diagnostics === 'object'
            ? snapshotData.diagnostics
            : {};
        return String(diagnostics.webPathSource || '').trim() === 'epointframe.properties:projectPagePath';
    }

    markEvidenceOnlyCandidates(candidates = []) {
        return (Array.isArray(candidates) ? candidates : []).map(item => {
            const record = item && typeof item === 'object' ? item : {};
            const markCandidate = candidate => ({
                ...(candidate && typeof candidate === 'object' ? candidate : {}),
                source: 'observed',
                usage: 'evidence_only'
            });
            return {
                ...record,
                source: 'observed',
                usage: 'evidence_only',
                packageCandidates: Array.isArray(record.packageCandidates)
                    ? record.packageCandidates.map(markCandidate)
                    : record.packageCandidates,
                webDirCandidates: Array.isArray(record.webDirCandidates)
                    ? record.webDirCandidates.map(markCandidate)
                    : record.webDirCandidates
            };
        });
    }

    _isUnsafeGenerationPath(filePath = '') {
        const normalized = String(filePath || '').replace(/\\/g, '/').replace(/\/{2,}/g, '/').trim();
        if (!normalized) return false;
        return /(?:^|\/)\.knowledge(?:\/|$)|(?:^|\/)\.ai-workspace\/knowledge(?:\/|$)|(?:^|\/)target(?:\/|$)|crud-examples/i.test(normalized);
    }

    _collectOwnershipModuleCandidates(ownership = {}, modules = []) {
        const moduleMap = new Map((Array.isArray(modules) ? modules : [])
            .map(item => [String(item && item.moduleId || '').trim(), item])
            .filter(([moduleId]) => moduleId));
        const candidates = [];
        const push = (moduleId = '', modulePath = '', source = '') => {
            const id = String(moduleId || '').trim();
            const normalizedPath = String(modulePath || '').trim();
            if (!id && !normalizedPath) return;
            if (candidates.some(item => item.moduleId === id && item.modulePath === normalizedPath)) return;
            candidates.push({
                moduleId: id,
                modulePath: normalizedPath === '.' ? '' : normalizedPath,
                source
            });
        };
        const recommendedModule = String(ownership && ownership.recommendedModule || '').trim();
        const recommendedRecord = moduleMap.get(recommendedModule);
        if (recommendedModule) {
            push(recommendedModule, recommendedRecord && recommendedRecord.modulePath || recommendedModule, 'recommendedModule');
        }
        (Array.isArray(ownership && ownership.candidateModules) ? ownership.candidateModules : []).forEach(item => {
            const moduleId = String(item && item.moduleId || '').trim();
            const moduleRecord = moduleMap.get(moduleId);
            push(moduleId, String(item && item.modulePath || moduleRecord && moduleRecord.modulePath || moduleId).trim(), 'candidateModules');
        });
        return candidates;
    }

    resolveOwnershipModule(ownershipRules = [], modules = [], fileKind = '') {
        const ownership = (Array.isArray(ownershipRules) ? ownershipRules : [])
            .find(item => String(item && item.fileKind || '') === fileKind) || {};
        const candidates = this._collectOwnershipModuleCandidates(ownership, modules);
        const safe = candidates.find(item => item.modulePath && !this._isUnsafeGenerationPath(item.modulePath));
        if (safe) return safe;
        const dotModule = candidates.find(item => !item.modulePath);
        if (dotModule) return dotModule;
        return { moduleId: '', modulePath: '', source: 'none' };
    }

    buildObservedProjectFacts(snapshotData = null, summary = {}, placementCandidates = []) {
        return {
            source: 'observed',
            usage: 'evidence_only',
            paths: snapshotData && snapshotData.paths && typeof snapshotData.paths === 'object'
                ? snapshotData.paths
                : {},
            samples: summary && summary.samples ? summary.samples : {},
            placementCandidates: this.markEvidenceOnlyCandidates(placementCandidates),
            modules: Array.isArray(snapshotData && snapshotData.modules) ? snapshotData.modules : [],
            ownershipRules: Array.isArray(snapshotData && snapshotData.ownershipRules) ? snapshotData.ownershipRules : [],
            diagnostics: snapshotData && snapshotData.diagnostics && typeof snapshotData.diagnostics === 'object'
                ? snapshotData.diagnostics
                : {}
        };
    }

    buildRulePlacementContract(placementPolicy = null, ownershipRules = [], finalRootPaths = {}, modules = []) {
        if (!placementPolicy || !placementPolicy.paths || typeof placementPolicy.paths !== 'object') {
            return {
                source: 'rule',
                sourceRule: '项目结构与命名规范',
                usage: 'generation',
                rules: []
            };
        }
        const fileNamePatterns = placementPolicy.fileNamePatterns && typeof placementPolicy.fileNamePatterns === 'object'
            ? placementPolicy.fileNamePatterns
            : {};
        const defaultFileNamePatterns = String(placementPolicy.profileName || '').trim().toLowerCase() === 'website'
            ? BUILTIN_WEBSITE_FILE_NAME_PATTERNS
            : BUILTIN_EXPERT_FILE_NAME_PATTERNS;
        const rootKeyByKind = {
            Action: 'action',
            Rest: 'rest',
            ServiceApi: 'service_api',
            ServiceInternal: 'service_impl',
            ServiceImpl: 'service_impl',
            Entity: 'entity',
            Job: 'job',
            HtmlPage: 'web',
            Js: 'web',
            Css: 'web'
        };
        const ownershipMap = new Map((Array.isArray(ownershipRules) ? ownershipRules : [])
            .map(item => [String(item && item.fileKind || ''), item]));
        const sanitizationConflicts = [];
        const rules = Object.keys(rootKeyByKind).map(fileKind => {
            const rootKey = rootKeyByKind[fileKind];
            let relativeDirPattern = String(finalRootPaths[rootKey] || placementPolicy.paths[rootKey] || '').trim();
            if (!relativeDirPattern) return null;
            const ownership = ownershipMap.get(fileKind)
                || (fileKind === 'ServiceInternal' ? ownershipMap.get('ServiceImpl') : null)
                || {};
            const ownershipModule = this.resolveOwnershipModule(ownershipRules, modules, fileKind === 'ServiceInternal' ? 'ServiceImpl' : fileKind);
            if (this._isUnsafeGenerationPath(relativeDirPattern)) {
                const repaired = ownershipModule.modulePath
                    ? this.replaceRootModulePrefix(relativeDirPattern, ownershipModule.modulePath)
                    : '';
                if (repaired && !this._isUnsafeGenerationPath(repaired)) {
                    relativeDirPattern = repaired;
                } else {
                    sanitizationConflicts.push({
                        code: 'GENERATION_PLACEMENT_PATH_UNSAFE',
                        fileKind,
                        unsafePath: relativeDirPattern,
                        message: `${fileKind} 生成路径命中了 .knowledge/.ai-workspace/knowledge/target 等只读证据目录，且未找到可安全替换的真实模块路径`,
                        source: 'pre_authoring_compact_hook'
                    });
                    return null;
                }
            }
            const configuredFileNamePattern = String(fileNamePatterns[fileKind] || '').trim();
            const fileNamePattern = configuredFileNamePattern || String(defaultFileNamePatterns[fileKind] || '').trim();
            const rule = {
                fileKind,
                recommendedModule: String(ownershipModule.moduleId || ownership.recommendedModule || '').trim(),
                relativeDirPattern,
                ...(fileNamePattern ? { fileNamePattern } : {}),
                source: 'rule',
                sourceRule: placementPolicy.sourceRuleName || '项目结构与命名规范',
                usage: 'generation',
                ...(configuredFileNamePattern ? {} : fileNamePattern ? {
                    contractOrigin: 'builtin_default',
                    contractFallbackReason: '项目规则缺少该 fileKind 的 fileNamePattern，按英文默认命名模板补齐。'
                } : {}),
                ...(placementPolicy.bootstrap === true ? { bootstrap: true } : {})
            };
            return this.enrichRulePlacementVariantContract(rule, placementPolicy);
        }).filter(Boolean);
        return {
            source: 'rule',
            sourceRule: placementPolicy.sourceRuleName || '项目结构与命名规范',
            usage: 'generation',
            ...(placementPolicy.databaseNamingContract ? { databaseNamingContract: placementPolicy.databaseNamingContract } : {}),
            rules,
            ...(sanitizationConflicts.length > 0 ? { sanitizationConflicts } : {})
        };
    }

    enrichRulePlacementVariantContract(rule = {}, placementPolicy = {}) {
        const fileKind = String(rule && rule.fileKind || '').trim();
        if (fileKind === 'HtmlPage') {
            return this._enrichHtmlPageVariants(rule, placementPolicy);
        }
        if (fileKind === 'Action') {
            return this._enrichActionVariants(rule, placementPolicy);
        }
        return rule;
    }

    /**
     * HtmlPage 4 个 subType（list/add/edit/detail）派生 variants：
     *   list  → gxh{pagename}list.html
     *   add   → gxh{pagename}add.html
     *   edit  → gxh{pagename}edit.html
     *   detail → gxh{pagename}detail.html
     *
     * 通用 fileNamePattern 为 gxh{pagename}{SubType}.html，variants 把 {SubType} 替换成具体后缀。
     */
    _enrichHtmlPageVariants(rule = {}, placementPolicy = {}) {
        const configuredMapping = placementPolicy && placementPolicy.htmlPageSubTypeMapping && typeof placementPolicy.htmlPageSubTypeMapping === 'object'
            ? placementPolicy.htmlPageSubTypeMapping
            : {};
        const subTypeMapping = {
            list: 'list',
            add: 'add',
            edit: 'edit',
            detail: 'detail',
            ...configuredMapping
        };
        const configuredPattern = String(rule.fileNamePattern || '').trim();
        const genericPattern = /\{SubType\}/u.test(configuredPattern)
            ? configuredPattern
            : this._deriveHtmlPageGenericFileNamePattern(configuredPattern);
        const variants = {};
        Object.keys(subTypeMapping).forEach(subType => {
            const suffix = String(subTypeMapping[subType] || '').trim();
            if (!subType || !suffix) return;
            variants[subType] = {
                subType,
                fileNamePattern: genericPattern.replace(/\{SubType\}/gu, suffix)
            };
        });
        return {
            ...rule,
            fileNamePattern: genericPattern,
            subTypeMapping,
            variants
        };
    }

    /**
     * Action 4 个 subType（list/add/edit/detail）派生 variants：
     *   list   → Gxh{EntityName}ListAction.java
     *   add    → Gxh{EntityName}AddAction.java
     *   edit   → Gxh{EntityName}EditAction.java
     *   detail → Gxh{EntityName}DetailAction.java
     *
     * Epoint 公司硬约定：每个 HtmlPage 有对应的 Action 类（一一配对）。
     * 通用 fileNamePattern 为 Gxh{EntityName}{SubType}Action.java，variants 把 {SubType} 替换成 PascalCase 后缀。
     */
    _enrichActionVariants(rule = {}, placementPolicy = {}) {
        const configuredMapping = placementPolicy && placementPolicy.actionSubTypeMapping && typeof placementPolicy.actionSubTypeMapping === 'object'
            ? placementPolicy.actionSubTypeMapping
            : {};
        const subTypeMapping = {
            list: 'List',
            add: 'Add',
            edit: 'Edit',
            detail: 'Detail',
            ...configuredMapping
        };
        const configuredPattern = String(rule.fileNamePattern || '').trim();
        const genericPattern = /\{SubType\}/u.test(configuredPattern)
            ? configuredPattern
            : this._deriveActionGenericFileNamePattern(configuredPattern);
        const variants = {};
        Object.keys(subTypeMapping).forEach(subType => {
            const suffix = String(subTypeMapping[subType] || '').trim();
            if (!subType || !suffix) return;
            variants[subType] = {
                subType,
                fileNamePattern: genericPattern.replace(/\{SubType\}/gu, suffix)
            };
        });
        return {
            ...rule,
            fileNamePattern: genericPattern,
            subTypeMapping,
            variants
        };
    }

    _deriveActionGenericFileNamePattern(pattern = '') {
        const normalized = String(pattern || '').trim();
        if (/\{SubType\}/u.test(normalized)) {
            return normalized;
        }
        if (!normalized) {
            return '';
        }
        // 把已有的具体后缀（List/Add/Edit/Detail）替换成 {SubType} 通用占位符
        return normalized.replace(/(List|Add|Edit|Detail)(Action\.java)$/u, '{SubType}$2');
    }

    _deriveHtmlPageGenericFileNamePattern(pattern = '') {
        const normalized = String(pattern || '').trim();
        if (/\{SubType\}/u.test(normalized)) {
            return normalized;
        }
        if (!normalized) {
            return '';
        }
        return normalized
            .replace(/(list|add|edit|detail)(\.html?)$/iu, '{SubType}$2')
            .replace(/(\{(?:pageName|pagename|PageName)\})(\.html?)$/u, '$1{SubType}$2');
    }

    buildCompatiblePlacementDraft(draft = {}, rulePlacementContract = {}, observedProjectFacts = {}) {
        const observedRules = draft && Array.isArray(draft.rules) ? draft.rules : [];
        const ruleRules = Array.isArray(rulePlacementContract && rulePlacementContract.rules)
            ? rulePlacementContract.rules
            : [];
        return {
            ...(draft && typeof draft === 'object' ? draft : {}),
            sourceModel: 'rule_first',
            rules: [
                ...ruleRules.map(rule => ({
                    ...rule,
                    source: 'rule',
                    sourceRule: rule.sourceRule || '项目结构与命名规范',
                    usage: 'generation'
                })),
                ...observedRules
                    .filter(rule => !ruleRules.some(ruleItem => String(ruleItem.fileKind || '') === String(rule && rule.fileKind || '')))
                    .map(rule => ({
                        ...(rule && typeof rule === 'object' ? rule : {}),
                        source: 'observed',
                        usage: 'evidence_only'
                    }))
            ],
            observedProjectFacts: {
                source: 'observed',
                usage: 'evidence_only',
                samples: observedProjectFacts.samples || {}
            },
            ...(rulePlacementContract.databaseNamingContract ? { databaseNamingContract: rulePlacementContract.databaseNamingContract } : {})
        };
    }

    detectContractConflicts(rulePlacementContract = {}, observedProjectFacts = {}) {
        const rules = Array.isArray(rulePlacementContract && rulePlacementContract.rules)
            ? rulePlacementContract.rules
            : [];
        const conflicts = [];
        if (Array.isArray(rulePlacementContract && rulePlacementContract.sanitizationConflicts)) {
            rulePlacementContract.sanitizationConflicts.forEach(item => conflicts.push(item));
        }
        if (rules.length === 0) {
            conflicts.push({
                code: 'RULE_PLACEMENT_CONTRACT_MISSING',
                message: '项目结构与命名规范缺少机器可执行的路径与命名模板',
                source: 'rule'
            });
        }
        const facts = observedProjectFacts && typeof observedProjectFacts === 'object' ? observedProjectFacts : {};
        const observedPaths = facts.paths && typeof facts.paths === 'object' ? facts.paths : {};
        rules.forEach(rule => {
            if (rule && rule.bootstrap === true) return;
            const kind = String(rule && rule.fileKind || '').trim();
            const rootKeyByKind = {
                Action: 'action',
                Rest: 'rest',
                ServiceApi: 'service_api',
                ServiceInternal: 'service_impl',
                ServiceImpl: 'service_impl',
                Entity: 'entity',
                Job: 'job',
                HtmlPage: 'web',
                Js: 'web',
                Css: 'web'
            };
            const rootKey = rootKeyByKind[kind];
            if (!rootKey || !String(observedPaths[rootKey] || '').trim()) {
                conflicts.push({
                    code: 'RULE_PLACEMENT_OBSERVED_ROOT_MISSING',
                    fileKind: kind,
                    message: `${kind} 规则模板已存在，但项目现状未观测到对应根路径；后续按规则新增目录`,
                    source: 'observed'
                });
            }
        });
        return conflicts;
    }

    extractModulePrefix(rawPath = '', marker = '') {
        const normalized = String(rawPath || '').replace(/\\/g, '/');
        const index = marker ? normalized.indexOf(marker) : -1;
        return index >= 0 ? normalized.slice(0, index) : '';
    }

    withModulePrefix(templatePath = '', sourcePath = '', marker = '') {
        const normalizedTemplate = String(templatePath || '').replace(/\\/g, '/').replace(/^\/+/, '');
        const prefix = this.extractModulePrefix(sourcePath, marker);
        return `${prefix}${normalizedTemplate}`.replace(/\/+$/g, '/') || normalizedTemplate;
    }

    applyRulePlacementPolicyToPaths(rootPaths = {}, placementPolicy = null) {
        if (!placementPolicy || !placementPolicy.paths || typeof placementPolicy.paths !== 'object') {
            return rootPaths;
        }
        const output = { ...rootPaths };
        ['action', 'rest', 'service_api', 'service_impl', 'entity', 'job'].forEach(key => {
            if (placementPolicy.paths[key]) {
                output[key] = this.withModulePrefix(placementPolicy.paths[key], rootPaths[key], 'src/main/java/');
            }
        });
        if (placementPolicy.paths.web) {
            output.web = this.withModulePrefix(placementPolicy.paths.web, rootPaths.web, 'src/main/webapp/');
        }
        return output;
    }

    resolveOwnershipModulePath(ownershipRules = [], modules = [], fileKind = '') {
        const moduleInfo = this.resolveOwnershipModule(ownershipRules, modules, fileKind);
        return String(moduleInfo && moduleInfo.modulePath || '').trim();
    }

    replaceRootModulePrefix(rootPath = '', modulePath = '') {
        const normalizedRoot = String(rootPath || '').replace(/\\/g, '/').replace(/^\/+/, '');
        const normalizedModule = String(modulePath || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
        if (!normalizedRoot || !normalizedModule) return normalizedRoot;
        if (normalizedRoot === normalizedModule || normalizedRoot.startsWith(`${normalizedModule}/`)) return normalizedRoot;
        const markers = ['src/main/java/', 'src/main/webapp/'];
        const marker = markers.find(item => normalizedRoot.includes(item));
        if (!marker) return normalizedRoot;
        const markerIndex = normalizedRoot.indexOf(marker);
        if (markerIndex < 0) return normalizedRoot;
        return `${normalizedModule}/${normalizedRoot.slice(markerIndex)}`.replace(/\/+$/g, '/');
    }

    alignRootPathsToOwnership(rootPaths = {}, ownershipRules = [], modules = []) {
        const output = { ...rootPaths };
        const rootKeyByKind = {
            Action: 'action',
            Rest: 'rest',
            ServiceApi: 'service_api',
            ServiceInternal: 'service_impl',
            ServiceImpl: 'service_impl',
            Entity: 'entity',
            Job: 'job',
            HtmlPage: 'web'
        };
        Object.keys(rootKeyByKind).forEach(fileKind => {
            const rootKey = rootKeyByKind[fileKind];
            if (!output[rootKey]) return;
            const modulePath = this.resolveOwnershipModulePath(ownershipRules, modules, fileKind);
            if (!modulePath) return;
            output[rootKey] = this.replaceRootModulePrefix(output[rootKey], modulePath);
        });
        return output;
    }

    applyRulePlacementPolicyToCandidates(candidates = [], placementPolicy = null) {
        if (!placementPolicy || !placementPolicy.backendPackageTemplate) return candidates;
        const packageSuffixByKind = {
            Action: 'action',
            Rest: 'rest',
            ServiceApi: 'api',
            ServiceInternal: 'impl',
            ServiceImpl: 'impl',
            Entity: 'api.entity',
            Job: 'job'
        };
        return (Array.isArray(candidates) ? candidates : []).map(item => {
            const record = item && typeof item === 'object' ? item : {};
            const suffix = packageSuffixByKind[String(record.fileKind || '')];
            if (!suffix || !Array.isArray(record.packageCandidates)) return record;
            const basePackage = `${placementPolicy.backendPackageTemplate}.${suffix}`;
            return {
                ...record,
                packageCandidates: record.packageCandidates.map(candidate => ({
                    ...candidate,
                    basePackage,
                    packageTemplate: basePackage
                }))
            };
        });
    }

    applyRulePlacementPolicyToDraft(draft = {}, placementPolicy = null, ownershipRules = [], finalRootPaths = {}) {
        if (!placementPolicy || !placementPolicy.paths || typeof placementPolicy.paths !== 'object') {
            return draft;
        }
        const rulePlacementContract = this.buildRulePlacementContract(placementPolicy, ownershipRules, finalRootPaths);
        return this.buildCompatiblePlacementDraft(draft, rulePlacementContract, {});
    }

    buildSampleLines(title, items = []) {
        const cleanItems = (Array.isArray(items) ? items : []).filter(Boolean);
        const body = cleanItems.length > 0
            ? cleanItems.map(item => `- \`${item}\``).join('\n')
            : '- 无';
        return `### ${title}\n${body}`;
    }

    writeContractJson(contractJsonPath, snapshotData, projectPath) {
        const payload = this.buildContractPayload(projectPath, snapshotData);
        fs.writeFileSync(contractJsonPath, JSON.stringify(payload, null, 2), 'utf-8');
        const compactPath = this.deriveCompactJsonPath(contractJsonPath);
        if (compactPath) {
            this.writeJsonArtifact(compactPath, this.buildCompactPayload(payload, {
                sourcePath: contractJsonPath
            }));
        }
        return { path: contractJsonPath, payload };
    }

    writeContractSkeleton(contractPath, snapshotData, projectPath) {
        const anchorSummary = this.buildAnchorSummary(projectPath, snapshotData);
        const effectivePlacement = this._resolveEffectivePlacementPolicy(projectPath, snapshotData, anchorSummary);
        const placementPolicy = effectivePlacement.placementPolicy;
        const rootPaths = this.applyRulePlacementPolicyToPaths(anchorSummary.paths || anchorSummary.roots || {}, placementPolicy);
        if (placementPolicy && placementPolicy.preserveWebPathFromSnapshot && snapshotData && snapshotData.paths && snapshotData.paths.web) {
            rootPaths.web = snapshotData.paths.web;
        }
        const modules = Array.isArray(snapshotData && snapshotData.modules) ? snapshotData.modules : [];
        const ownershipRules = Array.isArray(snapshotData && snapshotData.ownershipRules) ? snapshotData.ownershipRules : [];
        const placementCandidates = Array.isArray(snapshotData && snapshotData.placementCandidates) ? snapshotData.placementCandidates : [];
        const warnings = Array.isArray(snapshotData && snapshotData.warnings) ? snapshotData.warnings : [];
        const moduleLines = modules.length > 0
            ? modules.slice(0, 8).map(item => {
                const moduleId = String(item && item.moduleId || '').trim() || 'unknown';
                const modulePath = String(item && item.modulePath || '').trim();
                const packaging = String(item && item.packaging || '').trim() || 'jar';
                return `- \`${moduleId}\`${modulePath ? `（${modulePath}）` : ''} [${packaging}]`;
            }).join('\n')
            : '- 无';
        const ownershipLines = ownershipRules.length > 0
            ? ownershipRules.map(item => {
                const fileKind = String(item && item.fileKind || '').trim() || 'Unknown';
                const recommendedModule = String(item && item.recommendedModule || '').trim() || '待确认';
                const confidence = Number(item && item.confidence);
                const confidenceText = Number.isFinite(confidence) ? `，置信度 ${confidence.toFixed(2)}` : '';
                return `- ${fileKind} -> \`${recommendedModule}\`${confidenceText}`;
            }).join('\n')
            : '- 无';
        const candidateLines = placementCandidates.length > 0
            ? placementCandidates.slice(0, 12).map(item => {
                const fileKind = String(item && item.fileKind || '').trim() || 'Unknown';
                const moduleId = String(item && item.moduleId || '').trim() || 'unknown';
                const sampleSource = Array.isArray(item && item.packageCandidates) && item.packageCandidates.length > 0
                    ? item.packageCandidates.map(candidate => String(candidate.basePackage || '').trim()).filter(Boolean).slice(0, 2)
                    : Array.isArray(item && item.webDirCandidates)
                        ? item.webDirCandidates.map(candidate => String(candidate.baseDir || candidate.dir || candidate.path || '').trim()).filter(Boolean).slice(0, 2)
                        : [];
                return `- ${fileKind} @ \`${moduleId}\`${sampleSource.length > 0 ? `：${sampleSource.join(' / ')}` : ''}`;
            }).join('\n')
            : '- 无';
        const warningLines = warnings.length > 0
            ? warnings.map(item => `- ${String(item || '').trim()}`).join('\n')
            : '- 无';
        const content = `# 工程导航契约

## 1. 模块与落点
- 项目根路径：\`${projectPath}\`
- 工程类型：\`${String(snapshotData && snapshotData.projectType || '').trim() || 'single-module'}\`
- Action 根路径：\`${rootPaths.action || ''}\`
- REST 根路径：\`${rootPaths.rest || ''}\`
- Service API 根路径：\`${rootPaths.service_api || ''}\`
- Service Impl 根路径：\`${rootPaths.service_impl || ''}\`
- Entity 根路径：\`${rootPaths.entity || ''}\`
- Job 根路径：\`${rootPaths.job || ''}\`
- Web 根路径：\`${rootPaths.web || ''}\`

### 1.1 模块候选摘要
${moduleLines}

### 1.2 推荐模块归属
${ownershipLines}

## 2. 命名与路径规则摘要
- 新增个性化代码的包名与前端根目录以《项目结构与命名规范》解析出的规则模板为准。
- \`paths.*\` 与 \`rulePlacementContract.rules[].relativeDirPattern\` 是后续阶段无条件可信的路径真值；design/code 阶段不得为了确认命名或目录存在再次搜索原工程源码。
- 真实样例锚点只是 scan 阶段的只读摘要，不是后续阶段待打开文件；不得反向覆盖规则模板中的个性化包名或目录名。
- Service / Entity / Action / 页面落点必须以本契约记录的物理根路径为准，禁止凭经验自行改目录。
- 禁止落到 \`commonservice\` 等公共服务模块；如存量样例出现公共模块，只能作为排除项，不得作为新代码落点。
- 若规则模板对应目录当前不存在，后续 code 阶段直接新增目录与文件，scan/design 阶段不得因此改投历史业务包。

### 2.1 候选落点摘要
${candidateLines}

## 3. 真实样例锚点
- root: \`${anchorSummary.root}\`
- product: \`${anchorSummary.product}\`
- generator: \`${anchorSummary.generator}\`

${this.buildSampleLines('3.1 Action 样例', anchorSummary.samples && anchorSummary.samples.action)}

${this.buildSampleLines('3.2 REST 样例', anchorSummary.samples && anchorSummary.samples.rest)}

${this.buildSampleLines('3.3 Service API 样例', anchorSummary.samples && anchorSummary.samples.service_api)}

${this.buildSampleLines('3.4 Service Impl 样例', anchorSummary.samples && anchorSummary.samples.service_impl)}

${this.buildSampleLines('3.5 Entity 样例', anchorSummary.samples && anchorSummary.samples.entity)}

${this.buildSampleLines('3.6 Web 样例', anchorSummary.samples && anchorSummary.samples.web)}

## 4. 后续阶段使用约束
- requirement / design 统一直接引用项目级本契约，不再读取需求目录里的导航副本。
- 发现路径或样例锚点不准确时，只允许修订本契约，不得改写脚本生成的《项目现状报告》。
- 不适用项写“无”，禁止保留模板占位符。

### 4.1 风险与警告
${warningLines}
`;
        fs.writeFileSync(contractPath, content, 'utf-8');
        return contractPath;
    }

    writeArtifacts(paths, snapshotData, projectPath, options = {}) {
        this.ensureDirectoryExists(path.dirname(paths.navigationContractPath));
        this.writeContractSkeleton(paths.navigationContractPath, snapshotData, projectPath);
        this.writeContractJson(paths.navigationContractJsonPath, snapshotData, projectPath);
        return paths;
    }

    /**
     * 校验生成合同本身，而不是只校验“已有 rule 的某个字段”。
     *
     * 旧实现遇到 { fileKind: 'Action' } 会返回 ok=true，后续 Builder 才在
     * _resolveFileSeed 里发现文件名缺失。这会把 scan/设计阶段的问题延迟成
     * “Coder 猜文件名”的门禁错误。这里把 rule 的两端（目录+文件名）和
     * paths.* 声明的最小 rule 绑定在同一个校验里。
     */
    validateGenerationContract(payload = {}) {
        const record = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : {};
        const contract = record.rulePlacementContract && typeof record.rulePlacementContract === 'object'
            ? record.rulePlacementContract
            : null;
        const rules = contract && Array.isArray(contract.rules) ? contract.rules : [];
        const issues = [];
        const ruleByKind = new Map();

        if (!contract) {
            issues.push({
                code: 'NAVIGATION_GENERATION_RULE_PLACEMENT_MISSING',
                fileKind: '',
                message: '缺少 rulePlacementContract；不能确认生成文件的目录和文件名合同。'
            });
        }

        rules.forEach((rule, index) => {
            const fileKind = String(rule && rule.fileKind || '').trim();
            const relativeDirPattern = String(rule && rule.relativeDirPattern || '').trim();
            const fileNamePattern = String(rule && rule.fileNamePattern || '').trim();
            if (!fileKind) {
                issues.push({
                    code: 'NAVIGATION_GENERATION_FILE_KIND_MISSING',
                    index,
                    message: `rulePlacementContract.rules[${index}] 缺少 fileKind。`
                });
                return;
            }
            if (ruleByKind.has(fileKind)) {
                issues.push({
                    code: 'NAVIGATION_GENERATION_FILE_KIND_DUPLICATE',
                    fileKind,
                    index,
                    message: `fileKind=${fileKind} 在 rulePlacementContract.rules 中重复。`
                });
                return;
            }
            ruleByKind.set(fileKind, rule);
            if (!relativeDirPattern) {
                issues.push({
                    code: 'NAVIGATION_GENERATION_RELATIVE_DIR_MISSING',
                    fileKind,
                    index,
                    message: `fileKind=${fileKind} 缺少 relativeDirPattern。`
                });
            }
            if (!fileNamePattern) {
                issues.push({
                    code: 'NAVIGATION_GENERATION_FILE_NAME_MISSING',
                    fileKind,
                    index,
                    message: `fileKind=${fileKind} 缺少 fileNamePattern。`
                });
            }
        });

        const paths = record.paths && typeof record.paths === 'object' ? record.paths : {};
        Object.entries(GENERATION_PATH_FILE_KINDS).forEach(([pathKey, acceptableKinds]) => {
            const pathPattern = String(paths[pathKey] || '').trim();
            if (!pathPattern) return;
            const hasRule = acceptableKinds.some(fileKind => ruleByKind.has(fileKind));
            if (!hasRule) {
                issues.push({
                    code: 'NAVIGATION_GENERATION_FILE_KIND_MISSING',
                    pathKey,
                    acceptableKinds: acceptableKinds.slice(),
                    message: `paths.${pathKey} 已声明生成目录，但 rulePlacementContract.rules 缺少 ${acceptableKinds.join(' 或 ')}。`
                });
            }
        });

        const missing = issues.filter(issue => [
            'NAVIGATION_GENERATION_FILE_NAME_MISSING',
            'NAVIGATION_GENERATION_RELATIVE_DIR_MISSING',
            'NAVIGATION_GENERATION_FILE_KIND_MISSING',
            'NAVIGATION_GENERATION_RULE_PLACEMENT_MISSING'
        ].includes(issue.code));
        const message = issues.length === 0
            ? ''
            : `NAVIGATION_GENERATION_CONTRACT_INCOMPLETE: ${issues.map(issue => issue.message).join('；')}`;
        return {
            ok: issues.length === 0,
            missing,
            issues,
            message
        };
    }

    /**
     * 生成合同的可比较投影。generatedAt、samples 等事实字段不参与比较，
     * 只有会影响落盘文件的 paths 和 rulePlacementContract 才算生成真值。
     */
    generationContractSnapshot(payload = {}) {
        const record = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : {};
        const paths = record.paths && typeof record.paths === 'object' ? record.paths : {};
        const contract = record.rulePlacementContract && typeof record.rulePlacementContract === 'object'
            ? record.rulePlacementContract
            : {};
        const rules = Array.isArray(contract.rules) ? contract.rules : [];
        const normalizeVariants = variants => {
            if (!variants || typeof variants !== 'object' || Array.isArray(variants)) return {};
            return Object.fromEntries(Object.keys(variants).sort().map(key => {
                const variant = variants[key] && typeof variants[key] === 'object' ? variants[key] : {};
                return [key, {
                    fileNamePattern: String(variant.fileNamePattern || '').trim(),
                    relativeDirPattern: String(variant.relativeDirPattern || '').trim()
                }];
            }));
        };
        return {
            paths: Object.fromEntries(Object.keys(GENERATION_PATH_FILE_KINDS).sort().map(key => [
                key,
                String(paths[key] || '').trim()
            ])),
            rules: rules.map(rule => ({
                fileKind: String(rule && rule.fileKind || '').trim(),
                relativeDirPattern: String(rule && rule.relativeDirPattern || '').trim(),
                fileNamePattern: String(rule && rule.fileNamePattern || '').trim(),
                variants: normalizeVariants(rule && rule.variants)
            })).sort((left, right) => left.fileKind.localeCompare(right.fileKind))
        };
    }

    compareGenerationContracts(fullPayload = {}, compactPayload = {}) {
        const fullValidation = this.validateGenerationContract(fullPayload);
        const compactValidation = this.validateGenerationContract(compactPayload);
        if (!fullValidation.ok || !compactValidation.ok) {
            return {
                ok: false,
                equal: false,
                reason: 'invalid',
                fullValidation,
                compactValidation
            };
        }
        const fullSnapshot = this.generationContractSnapshot(fullPayload);
        const compactSnapshot = this.generationContractSnapshot(compactPayload);
        const equal = JSON.stringify(fullSnapshot) === JSON.stringify(compactSnapshot);
        return {
            ok: true,
            equal,
            fullSnapshot,
            compactSnapshot,
            reason: equal ? '' : 'generation_projection_mismatch'
        };
    }

    validateArtifacts(paths, options = {}) {
        const codes = {
            missing: 'NAVIGATION_ARTIFACT_MISSING',
            compactInvalid: 'NAVIGATION_COMPACT_INVALID',
            scanReportEmpty: 'SCAN_REPORT_EMPTY',
            scanReportTemplateNotFilled: 'SCAN_REPORT_TEMPLATE_NOT_FILLED',
            contractTemplateNotFilled: 'NAVIGATION_CONTRACT_TEMPLATE_NOT_FILLED',
            headingsMissing: 'NAVIGATION_CONTRACT_HEADINGS_MISSING',
            anchorsMissing: 'NAVIGATION_CONTRACT_ANCHORS_MISSING',
            ...(options.errorCodes && typeof options.errorCodes === 'object' ? options.errorCodes : {})
        };
        const compactPath = String(paths.navigationContractCompactPath || this.deriveCompactJsonPath(paths.navigationContractJsonPath) || '').trim();
        const requiredPaths = [
            options.includeScanReport !== false ? paths.scanReportPath : '',
            paths.navigationContractPath,
            paths.navigationContractJsonPath,
            compactPath
        ].filter(Boolean);
        const missing = requiredPaths.filter(filePath => !fs.existsSync(filePath));
        if (missing.length > 0) {
            return { ok: false, message: `${codes.missing}: ${missing.join(', ')}` };
        }

        if (options.includeScanReport !== false) {
            const reportContent = fs.readFileSync(paths.scanReportPath, 'utf-8');
            if (!String(reportContent || '').trim()) return { ok: false, message: codes.scanReportEmpty };
            if (this.hasUnfilledTemplateMarker(reportContent)) return { ok: false, message: codes.scanReportTemplateNotFilled };
        }

        const contractContent = fs.readFileSync(paths.navigationContractPath, 'utf-8');
        if (this.hasUnfilledTemplateMarker(contractContent)) {
            return { ok: false, message: codes.contractTemplateNotFilled };
        }
        const requiredHeadings = Array.isArray(options.requiredHeadings) && options.requiredHeadings.length > 0
            ? options.requiredHeadings
            : DEFAULT_HEADINGS;
        if (requiredHeadings.some(heading => !contractContent.includes(heading))) {
            return { ok: false, message: codes.headingsMissing };
        }

        const anchorPatterns = Array.isArray(options.anchorPatterns) ? options.anchorPatterns : [];
        if (anchorPatterns.length > 0) {
            const compiledPatterns = RuleValidationContract.compileRegexList(anchorPatterns);
            if (compiledPatterns.some(pattern => !pattern.test(contractContent))) {
                return { ok: false, message: codes.anchorsMissing };
            }
        }

        const contractJsonState = this.readNavigationContractJsonState(paths.navigationContractJsonPath, {
            projectPath: String(options.projectPath || '').trim(),
            projectPathRequired: options.projectPathRequired !== false
        });
        if (!contractJsonState.ok) {
            return { ok: false, message: contractJsonState.message };
        }
        const generationContract = this.validateGenerationContract(contractJsonState.payload || {});
        if (!generationContract.ok) {
            return { ok: false, message: generationContract.message, generationContract };
        }

        let compactPayload = null;
        try {
            compactPayload = JSON.parse(fs.readFileSync(compactPath, 'utf-8'));
        } catch (error) {
            compactPayload = null;
        }
        if (!compactPayload || typeof compactPayload !== 'object') {
            return { ok: false, message: `${codes.compactInvalid}: ${compactPath}` };
        }
        const compactGenerationContract = this.validateGenerationContract(compactPayload);
        if (!compactGenerationContract.ok) {
            return { ok: false, message: compactGenerationContract.message, generationContract: compactGenerationContract };
        }
        const derivation = this.compareGenerationContracts(contractJsonState.payload || {}, compactPayload);
        if (!derivation.equal) {
            return {
                ok: false,
                message: [
                    'NAVIGATION_CONTRACT_DERIVATION_MISMATCH: 工程导航契约 JSON 与 compact 的生成落点或文件名模板不一致。',
                    `json: ${paths.navigationContractJsonPath || ''}`,
                    `compact: ${compactPath}`,
                    '修复方式：以 JSON 为权威重新生成 compact；禁止让 design/code 搜索源码或自行猜文件名。'
                ].join('\n'),
                derivation
            };
        }
        return { ok: true, state: contractJsonState, compactState: { ok: true, path: compactPath, payload: compactPayload } };
    }
}

module.exports = NavigationContractService;
