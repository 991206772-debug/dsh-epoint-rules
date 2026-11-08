/* eslint-disable */
const fs = require('fs');
const path = require('path');

const TechStackGuardService = require('./design-tdd-code-style-guard-service');
const DesignTddCodeRuntimeService = require('./design-tdd-code-runtime-service');

class DesignTddContextService {
    constructor(options = {}) {
        this.codeRuntimeService = options.codeRuntimeService || new DesignTddCodeRuntimeService();
        this.workProjectionService = options.workProjectionService || null;
        this.navigationContractService = options.navigationContractService || null;
    }

    prepare(args = {}) {
        return this._prepare(args, { includeLoadedArtifacts: false });
    }

    prepareForBuilder(args = {}) {
        return this._prepare(args, { includeLoadedArtifacts: true });
    }

    prepareForBuilderWithDesign(args = {}, designDocument = {}) {
        return this._prepare(args, {
            includeLoadedArtifacts: true,
            designDocumentOverride: designDocument
        });
    }

    _prepare(args = {}, options = {}) {
        const projectPath = String(args.projectPath || '').trim();
        if (!projectPath) {
            return this._blocked('DESIGN_TDD_PROJECT_PATH_MISSING', '缺少projectPath，无法锁定Design TDD输入上下文。');
        }
        const projectPathInfo = this._normalizePrepareProjectPath(projectPath);
        const normalizedProject = projectPathInfo.normalizedProject;
        const withCorrection = value => this._withProjectPathCorrection(value, projectPathInfo);
        const projectArtifactsDir = path.join(normalizedProject, '.ai-workspace', 'project');
        const activeDemandPath = path.join(projectArtifactsDir, '.active-demand');
        if (!fs.existsSync(activeDemandPath)) {
            return withCorrection(this._blocked('DESIGN_TDD_ACTIVE_DEMAND_MISSING', `缺少.active-demand：${activeDemandPath}`, {
                fixedPaths: { activeDemandPath },
                machineRecoverable: true,
                stopLockRequired: false
            }));
        }
        const demandName = String(fs.readFileSync(activeDemandPath, 'utf-8') || '').trim();
        if (!demandName) {
            return withCorrection(this._blocked('DESIGN_TDD_ACTIVE_DEMAND_EMPTY', `.active-demand为空：${activeDemandPath}`, {
                fixedPaths: { activeDemandPath },
                machineRecoverable: true,
                stopLockRequired: false
            }));
        }
        const demandDir = path.resolve(projectArtifactsDir, demandName);
        if (!this._isSameOrChild(demandDir, projectArtifactsDir)) {
            return withCorrection(this._blocked('DESIGN_TDD_DEMAND_DIR_OUT_OF_PROJECT', `.active-demand指向非法目录：${demandName}`, {
                fixedPaths: { activeDemandPath },
                demandName
            }));
        }

        const fixedPaths = {
            activeDemandPath,
            demandDir,
            designDocumentPath: path.join(demandDir, 'design', '设计文档.json'),
            requirementRulePoolPath: path.join(demandDir, 'demand', 'rule-pool.json'),
            codeStatePath: path.join(demandDir, 'code', 'code-state.json'),
            designTddPlanPath: path.join(demandDir, 'code', 'design-tdd-plan.md'),
            designTddPlanJsonPath: path.join(demandDir, 'code', 'design-tdd-plan.json'),
            businessFactsPath: path.join(demandDir, 'code', 'business-facts.json'),
            navigationCompactContractPath: path.join(projectArtifactsDir, '工程导航契约.compact.json'),
            navigationContractPath: path.join(projectArtifactsDir, '工程导航契约.json'),
            frameworkBucketPath: path.join(projectArtifactsDir, '框架版本档位.json')
        };

        const designDocument = options.designDocumentOverride && typeof options.designDocumentOverride === 'object'
            ? { ok: true, value: options.designDocumentOverride, exists: true, source: 'in_memory_design_preflight' }
            : this._readRequiredJson(fixedPaths.designDocumentPath, 'DESIGN_TDD_DESIGN_DOCUMENT');
        if (!designDocument.ok) return withCorrection(this._blocked(designDocument.errorCode, designDocument.message, { fixedPaths, demandName }));
        const requirementRulePool = this._readRequiredJson(fixedPaths.requirementRulePoolPath, 'DESIGN_TDD_REQUIREMENT_RULE_POOL');
        if (!requirementRulePool.ok) return withCorrection(this._blocked(requirementRulePool.errorCode, requirementRulePool.message, { fixedPaths, demandName }));
        const navigationContract = this._readNavigationContract(fixedPaths, normalizedProject);
        if (!navigationContract.ok) return withCorrection(this._blocked(navigationContract.errorCode, navigationContract.message, { fixedPaths, demandName }));
        if (options.includeLoadedArtifacts === true) {
            const designSeedContract = this._validateDesignFileSeedContracts(
                designDocument.value,
                navigationContract.value
            );
            if (!designSeedContract.ok) {
                return withCorrection(this._blocked(
                    'DESIGN_TDD_NAVIGATION_FILE_CONTRACT_MISSING',
                    [
                        `设计文档中的新增文件缺少可执行导航合同：${designSeedContract.message}`,
                        `导航合同来源：${navigationContract.sourcePath || fixedPaths.navigationContractCompactPath || fixedPaths.navigationContractPath}`,
                        '修复方式：先回到 scan 重新生成工程导航 JSON/compact；设计清单只补业务逻辑变量，不手写最终文件名或路径。',
                        '该问题属于 scan/设计上下文输入缺陷，不能留给 Coder 猜文件名。'
                    ].join('\n'),
                    {
                        fixedPaths,
                        demandName,
                        navigationContractSourcePath: navigationContract.sourcePath || '',
                        seedContract: designSeedContract
                    }
                ));
            }
        }
        const frameworkBucket = this._readRequiredJson(fixedPaths.frameworkBucketPath, 'DESIGN_TDD_FRAMEWORK_BUCKET');
        if (!frameworkBucket.ok) return withCorrection(this._blocked(frameworkBucket.errorCode, frameworkBucket.message, { fixedPaths, demandName }));
        const codeState = this._readOptionalJson(fixedPaths.codeStatePath, 'DESIGN_TDD_CODE_STATE');
        if (!codeState.ok) return withCorrection(this._blocked(codeState.errorCode, codeState.message, { fixedPaths, demandName }));

        if (options.includeLoadedArtifacts === true) {
            return withCorrection({
                ok: true,
                status: 'ready',
                source: 'design_tdd_context_prepare',
                demandName,
                demandDir,
                fixedPaths,
                loadedArtifacts: {
                    designDocument: designDocument.value,
                    requirementRulePool: requirementRulePool.value,
                    navigationContract: navigationContract.value,
                    navigationContractSourcePath: navigationContract.sourcePath,
                    placementContracts: this._normalizePlacementContracts(navigationContract.value),
                    frameworkBucket: frameworkBucket.value,
                    codeState: codeState.exists ? codeState.value : null
                }
            });
        }

        const hasPlan = fs.existsSync(fixedPaths.designTddPlanJsonPath);
        const hasFacts = fs.existsSync(fixedPaths.businessFactsPath);
        if (hasPlan && hasFacts) {
            let runtimeResult = this.codeRuntimeService.prepare({ projectPath: normalizedProject });
            if (
                runtimeResult && runtimeResult.errorCode === 'DESIGN_TDD_WORK_SLICE_INDEX_MISSING'
                && this.workProjectionService
                && typeof this.workProjectionService.rebuildWorkProjection === 'function'
            ) {
                const projection = this.workProjectionService.rebuildWorkProjection({ projectPath: normalizedProject });
                if (!projection || projection.ok !== true) {
                    return withCorrection({
                        ...(projection || runtimeResult),
                        demandName,
                        fixedPaths
                    });
                }
                runtimeResult = this.codeRuntimeService.prepare({ projectPath: normalizedProject });
            }
            return withCorrection({
                ...runtimeResult,
                demandName,
                fixedPaths: {
                    designTddPlanPath: fixedPaths.designTddPlanPath,
                    codeStatePath: fixedPaths.codeStatePath
                }
            });
        }

        const buildPlanArguments = {
            projectPath: normalizedProject,
            skillName: 'epoint-design-tdd-coder',
            ...((hasPlan || hasFacts || codeState.exists) ? { overwritePlan: true } : {})
        };
        return withCorrection({
            ok: true,
            status: 'ready',
            demandName,
            resumeMode: hasPlan || hasFacts || codeState.exists
                ? 'rebuild_incomplete_plan_projection'
                : 'first_run_create_code_state',
            techStackDeclaration: new TechStackGuardService().getDeclaration(),
            fixedPaths: {
                designTddPlanPath: fixedPaths.designTddPlanPath,
                codeStatePath: fixedPaths.codeStatePath
            },
            nextActionCard: {
                title: hasPlan || hasFacts || codeState.exists
                    ? `检测到未闭合计划投影（${demandName}），下一步重建plan和v2状态`
                    : `首次编码（${demandName}），下一步生成plan和v2状态`,
                toolName: 'design_tdd_build_plan',
                arguments: buildPlanArguments,
                callTemplate: `design_tdd_build_plan(${JSON.stringify(buildPlanArguments)})`,
                instruction: '只传上方 projectPath（业务项目根目录）。Builder 会先校验工程导航 JSON/compact 的 fileKind、relativeDirPattern、fileNamePattern 并自动修复 compact；不要在设计清单里手写最终文件名或路径。若返回导航合同缺口，按返回的 sourcePath、字段名和 allowedNextActions 回到 scan/设计输入修复。',
                stopAfter: false
            }
        });
    }

    _normalizePrepareProjectPath(projectPath = '') {
        const resolved = path.resolve(projectPath);
        const normalizedInputPath = resolved.replace(/[\\/]+/g, path.sep);
        const marker = `${path.sep}.ai-workspace${path.sep}project`;
        const markerIndex = normalizedInputPath.toLowerCase().indexOf(marker.toLowerCase());
        if (markerIndex > 0) {
            const suffix = normalizedInputPath.slice(markerIndex + marker.length);
            if (suffix && !suffix.startsWith(path.sep)) return { normalizedProject: resolved };
            const projectRoot = normalizedInputPath.slice(0, markerIndex);
            if (!projectRoot) return { normalizedProject: resolved };
            return {
                normalizedProject: path.resolve(projectRoot),
                correctedFrom: resolved,
                correctionReason: 'projectPath指向.ai-workspace/project或需求目录，已归一为业务项目根。'
            };
        }
        const detectedProjectRoot = this._findProjectRootWithActiveDemand(resolved);
        if (detectedProjectRoot && path.resolve(detectedProjectRoot) !== resolved) {
            return {
                normalizedProject: path.resolve(detectedProjectRoot),
                correctedFrom: resolved,
                correctionReason: 'projectPath指向业务项目子目录，已向上归一为业务项目根。'
            };
        }
        return { normalizedProject: resolved };
    }

    _findProjectRootWithActiveDemand(startPath = '') {
        let cursor = path.resolve(startPath || '.');
        try {
            if (fs.existsSync(cursor) && !fs.statSync(cursor).isDirectory()) cursor = path.dirname(cursor);
        } catch (_) {
            // Keep walking from the resolved input.
        }
        while (cursor) {
            if (fs.existsSync(path.join(cursor, '.ai-workspace', 'project', '.active-demand'))) return cursor;
            const parent = path.dirname(cursor);
            if (!parent || parent === cursor) break;
            cursor = parent;
        }
        return '';
    }

    _withProjectPathCorrection(response = {}, projectPathInfo = {}) {
        if (!projectPathInfo.correctedFrom) return response;
        return {
            ...response,
            projectPathCorrection: {
                correctedFrom: projectPathInfo.correctedFrom,
                normalizedProject: projectPathInfo.normalizedProject,
                reason: projectPathInfo.correctionReason
            }
        };
    }

    _readNavigationContract(fixedPaths = {}, projectPath = '') {
        const compactPath = fixedPaths.navigationCompactContractPath;
        const fullPath = fixedPaths.navigationContractPath;
        const compactExists = !!(compactPath && fs.existsSync(compactPath));
        const readFull = () => this._readRequiredJson(fullPath, 'DESIGN_TDD_NAVIGATION_CONTRACT');
        const rebuildFull = (fullValue, previous) => {
            const rebuilt = this._rebuildNavigationContract(projectPath, fullValue);
            if (!rebuilt.ok) return rebuilt;
            this._persistNavigationContract(fixedPaths, projectPath, rebuilt.value);
            return {
                ok: true,
                exists: true,
                value: rebuilt.value,
                sourcePath: fullPath,
                sourceKind: 'rebuilt_incomplete_navigation_contract',
                repair: { code: 'NAVIGATION_GENERATION_CONTRACT_REBUILT', previous }
            };
        };
        const repairCompactFromFull = (fullValue, previous, repair = {}) => {
            const refreshed = this._refreshNavigationCompact(compactPath, fullValue);
            return {
                ok: true,
                exists: true,
                value: fullValue,
                sourcePath: fullPath,
                sourceKind: refreshed ? 'full_repaired_compact' : 'full_compact_refresh_unwritten',
                repair: {
                    code: repair.code || 'NAVIGATION_COMPACT_REPAIRED',
                    compactPath,
                    compactRefreshed: refreshed,
                    previous,
                    ...(repair.compare ? { compare: repair.compare } : {})
                }
            };
        };

        let compact = null;
        let compactContract = null;
        if (compactExists) {
            compact = this._parseJson(compactPath, 'DESIGN_TDD_NAVIGATION_COMPACT_CONTRACT');
            if (compact.ok) compactContract = this._validateGenerationContract(compact.value);
        }

        // full 是导航契约的权威来源。compact 存在时也必须读取 full，避免旧 compact
        // 以“校验通过”的假象覆盖已经修好的完整合同。
        const full = readFull();
        if (!full.ok) {
            if (!compactExists) return full;
            if (compact && !compact.ok) return compact;
            if (!compactContract || !compactContract.ok) {
                return this._blocked(
                    'DESIGN_TDD_NAVIGATION_CONTRACT_INCOMPLETE',
                    `工程导航契约 full 不可用，且 compact 也不完整：full=${fullPath}；compact=${compactPath}；${compactContract && compactContract.message || compact && compact.message || full.message}`,
                    { fixedPaths, fullPath, compactPath, fullError: full.message, compactContract }
                );
            }
            // 没有 full 时不能把 compact 反向写成 full；仅在 compact 自身完整时兼容读取。
            return { ok: true, exists: true, value: compact.value, sourcePath: compactPath, sourceKind: 'compact_without_full' };
        }

        const fullContract = this._validateGenerationContract(full.value);
        if (!fullContract.ok) {
            return rebuildFull(full.value, fullContract);
        }

        if (!compactExists) {
            // full 已完整但 compact 丢失时即时补齐，避免下一阶段才报 compact 缺失。
            return repairCompactFromFull(full.value, { code: 'NAVIGATION_COMPACT_MISSING', missing: compactPath });
        }
        if (!compact || !compact.ok) {
            return repairCompactFromFull(full.value, { code: 'NAVIGATION_COMPACT_INVALID_JSON', previous: compact && compact.message });
        }
        if (!compactContract || !compactContract.ok) {
            return repairCompactFromFull(full.value, compactContract || { code: 'NAVIGATION_COMPACT_CONTRACT_INVALID' });
        }

        const comparison = this._compareGenerationContracts(full.value, compact.value);
        if (!comparison.equal) {
            return repairCompactFromFull(
                full.value,
                { code: 'NAVIGATION_COMPACT_DERIVATION_MISMATCH', previous: compactContract },
                { code: 'NAVIGATION_COMPACT_DERIVATION_MISMATCH', compare: comparison }
            );
        }
        return { ok: true, exists: true, value: compact.value, sourcePath: compactPath, sourceKind: 'compact' };
    }

    _validateGenerationContract(payload = {}) {
        if (this.navigationContractService && typeof this.navigationContractService.validateGenerationContract === 'function') {
            return this.navigationContractService.validateGenerationContract(payload);
        }
        const contract = payload && payload.rulePlacementContract && typeof payload.rulePlacementContract === 'object'
            ? payload.rulePlacementContract
            : {};
        const missing = (Array.isArray(contract.rules) ? contract.rules : [])
            .filter(rule => String(rule && rule.relativeDirPattern || '').trim()
                && !String(rule && rule.fileNamePattern || '').trim());
        return {
            ok: missing.length === 0,
            missing,
            message: missing.length === 0
                ? ''
                : `NAVIGATION_GENERATION_CONTRACT_INCOMPLETE: ${missing.map(rule => String(rule.fileKind || 'Unknown')).join(', ')}`
        };
    }

    _compareGenerationContracts(fullPayload = {}, compactPayload = {}) {
        if (this.navigationContractService && typeof this.navigationContractService.compareGenerationContracts === 'function') {
            const result = this.navigationContractService.compareGenerationContracts(fullPayload, compactPayload);
            return { equal: result.equal === true, ...result };
        }
        const normalize = payload => {
            const paths = payload && payload.paths && typeof payload.paths === 'object' ? payload.paths : {};
            const contract = payload && payload.rulePlacementContract && typeof payload.rulePlacementContract === 'object'
                ? payload.rulePlacementContract
                : {};
            const rules = Array.isArray(contract.rules) ? contract.rules : [];
            return {
                paths: Object.fromEntries(['action', 'rest', 'service_api', 'service_impl', 'entity', 'job', 'web']
                    .sort().map(key => [key, String(paths[key] || '').trim()])),
                rules: rules.map(rule => ({
                    fileKind: String(rule && rule.fileKind || '').trim(),
                    relativeDirPattern: String(rule && rule.relativeDirPattern || '').trim(),
                    fileNamePattern: String(rule && rule.fileNamePattern || '').trim()
                })).sort((left, right) => left.fileKind.localeCompare(right.fileKind))
            };
        };
        const fullSnapshot = normalize(fullPayload);
        const compactSnapshot = normalize(compactPayload);
        return {
            equal: JSON.stringify(fullSnapshot) === JSON.stringify(compactSnapshot),
            fullSnapshot,
            compactSnapshot,
            reason: 'generation_projection_mismatch'
        };
    }

    _validateDesignFileSeedContracts(designDocument = {}, navigationPayload = {}) {
        const rules = Array.isArray(
            navigationPayload
                && navigationPayload.rulePlacementContract
                && navigationPayload.rulePlacementContract.rules
        )
            ? navigationPayload.rulePlacementContract.rules
            : [];
        const ruleByKind = new Map(rules
            .filter(rule => rule && typeof rule === 'object')
            .map(rule => [String(rule.fileKind || '').trim(), rule])
            .filter(([fileKind]) => fileKind));
        const issues = [];
        const modules = Array.isArray(designDocument && designDocument.modules)
            ? designDocument.modules
            : [];
        modules.forEach((module, moduleIndex) => {
            const handoff = module && module.codingHandoff && typeof module.codingHandoff === 'object'
                ? module.codingHandoff
                : {};
            const seeds = handoff.fileSeeds || handoff.files || handoff.filePlan || [];
            (Array.isArray(seeds) ? seeds : []).forEach((seed, seedIndex) => {
                if (!seed || typeof seed !== 'object') return;
                const fileKind = String(seed.fileKind || seed.type || '').trim();
                if (!fileKind || fileKind === 'Sql') return;
                const operation = String(seed.operation || 'create').trim().toLowerCase();
                const hasExplicitPhysicalTarget = String(seed.fileName || seed.resolvedPath || seed.path || '').trim();
                // 既有 HtmlPage 的物理路径由需求 existingAdjustment 提供，不要求新建命名模板。
                if (fileKind === 'HtmlPage' && operation === 'modify') return;
                if (hasExplicitPhysicalTarget) return;
                const rule = ruleByKind.get(fileKind);
                const missingFields = [];
                if (!rule) {
                    missingFields.push('rulePlacementContract.rules[fileKind].');
                } else {
                    if (!String(rule.relativeDirPattern || '').trim()) missingFields.push('relativeDirPattern');
                    if (!String(rule.fileNamePattern || '').trim()) missingFields.push('fileNamePattern');
                }
                if (missingFields.length > 0) {
                    issues.push({
                        moduleId: String(module && module.moduleId || '').trim(),
                        moduleIndex,
                        seedIndex,
                        fileKind,
                        operation,
                        missingFields
                    });
                }
            });
        });
        return {
            ok: issues.length === 0,
            issues,
            message: issues.length === 0
                ? ''
                : issues.map(item => `${item.moduleId || `modules[${item.moduleIndex}]`}.${item.fileKind} 缺少 ${item.missingFields.join('、')}`).join('；')
        };
    }

    _rebuildNavigationContract(projectPath = '', payload = {}) {
        if (!this.navigationContractService || typeof this.navigationContractService.buildContractPayload !== 'function') {
            return this._blocked(
                'DESIGN_TDD_NAVIGATION_CONTRACT_INCOMPLETE',
                '工程导航契约存在目录但缺少文件名模板；请重新执行 project_scan 生成完整英文命名合同。',
                { generationContract: this._validateGenerationContract(payload) }
            );
        }
        try {
            const rebuilt = this.navigationContractService.buildContractPayload(projectPath, payload);
            const checked = this._validateGenerationContract(rebuilt);
            if (!checked.ok) {
                return this._blocked(
                    'DESIGN_TDD_NAVIGATION_CONTRACT_INCOMPLETE',
                    `工程导航契约仍缺少文件名模板：${checked.message}；请补充项目规则后重新执行 project_scan。`,
                    { generationContract: checked }
                );
            }
            return { ok: true, value: rebuilt };
        } catch (error) {
            return this._blocked(
                'DESIGN_TDD_NAVIGATION_CONTRACT_REBUILD_FAILED',
                `工程导航契约自动补全失败：${error.message}；请重新执行 project_scan。`
            );
        }
    }

    _refreshNavigationCompact(compactPath = '', payload = {}) {
        if (!compactPath || !this.navigationContractService
            || typeof this.navigationContractService.buildCompactPayload !== 'function') return false;
        try {
            const compactPayload = this.navigationContractService.buildCompactPayload(payload, { sourcePath: compactPath.replace(/\.compact\.json$/u, '.json') });
            fs.writeFileSync(compactPath, JSON.stringify(compactPayload, null, 2), 'utf-8');
            return true;
        } catch (_) {
            // Compact refresh 失败时 full 仍是权威来源，但要把未写入状态返回给调用方。
            return false;
        }
    }

    _persistNavigationContract(fixedPaths = {}, projectPath = '', payload = {}) {
        if (fixedPaths.navigationContractPath) {
            fs.writeFileSync(fixedPaths.navigationContractPath, JSON.stringify(payload, null, 2), 'utf-8');
        }
        this._refreshNavigationCompact(fixedPaths.navigationCompactContractPath, payload);
    }

    _normalizePlacementContracts(navigationContract = {}) {
        const rules = Array.isArray(navigationContract.rulePlacementContract && navigationContract.rulePlacementContract.rules)
            ? navigationContract.rulePlacementContract.rules
            : [];
        const byFileKind = {};
        for (const rule of rules) {
            if (!rule || typeof rule !== 'object') continue;
            const fileKind = String(rule.fileKind || '').trim();
            if (!fileKind) continue;
            byFileKind[fileKind] = {
                fileKind,
                recommendedModule: rule.recommendedModule || '',
                relativeDirPattern: rule.relativeDirPattern || '',
                fileNamePattern: rule.fileNamePattern || '',
                variants: rule.variants || {},
                subTypeMapping: rule.subTypeMapping || {},
                contractSource: {
                    source: rule.source || navigationContract.rulePlacementContract.source || '',
                    sourceRule: rule.sourceRule || navigationContract.rulePlacementContract.sourceRule || '',
                    usage: rule.usage || navigationContract.rulePlacementContract.usage || ''
                }
            };
        }
        return byFileKind;
    }

    _readRequiredJson(filePath, label) {
        if (!fs.existsSync(filePath)) {
            return { ok: false, errorCode: `${label}_MISSING`, message: `缺少必需产物：${filePath}` };
        }
        return this._parseJson(filePath, label);
    }

    _readOptionalJson(filePath, label) {
        if (!fs.existsSync(filePath)) return { ok: true, exists: false, value: null };
        const parsed = this._parseJson(filePath, label);
        return parsed.ok ? { ...parsed, exists: true } : parsed;
    }

    _parseJson(filePath, label) {
        try {
            return { ok: true, exists: true, value: JSON.parse(fs.readFileSync(filePath, 'utf-8')) };
        } catch (error) {
            return { ok: false, errorCode: `${label}_INVALID_JSON`, message: `JSON解析失败：${filePath}；${error.message}` };
        }
    }

    _isSameOrChild(candidate, parent) {
        const relative = path.relative(path.resolve(parent), path.resolve(candidate));
        return relative === '' || (!!relative && !relative.startsWith('..') && !path.isAbsolute(relative));
    }

    _blocked(errorCode, message, extra = {}) {
        return {
            ok: false,
            status: 'blocked',
            actionMode: 'blocker',
            errorCode,
            message,
            allowedNextActions: ['repair_upstream_artifact_or_restart_previous_stage'],
            forbiddenNextActions: ['file_search', 'list_directory', 'continue_design_tdd_without_context'],
            ...extra
        };
    }
}

module.exports = DesignTddContextService;
