/* eslint-disable */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const GateContractRegistry = require('./gate-contract-registry');
const { flattenBusinessFactsAcceptanceItems } = require('./design-tdd-acceptance-utils');

const CODE_STATE_SCHEMA = 'design-tdd-code-state/v3';
const VIBE_CODING_MODE = 'vibe_coding';
const VIBE_CODING_START_TOOL = 'host_coder_vibecoding';
function array(value) {
    return Array.isArray(value) ? value : [];
}

function uniqueStrings(values = []) {
    return Array.from(new Set(array(values)
        .map(value => String(value || '').trim())
        .filter(Boolean)));
}

function stableStringify(value) {
    if (value === null || value === undefined) return JSON.stringify(value);
    if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
    if (typeof value === 'object') {
        return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
    }
    return JSON.stringify(value);
}

function sha256(value) {
    return crypto.createHash('sha256').update(String(value || ''), 'utf-8').digest('hex');
}

class DesignTddCodeRuntimeService {
    constructor(options = {}) {
        this.now = options.now || (() => new Date().toISOString());
    }

    initialize({ codeDir = '', demandName = '', facts = {}, plan = {}, previousPlan = null, previousState = null } = {}) {
        const resolvedCodeDir = path.resolve(String(codeDir || '').trim());
        if (!codeDir) return this._blocked('DESIGN_TDD_CODE_DIR_MISSING', '缺少 codeDir，无法初始化编码运行态。');

        const inputFingerprint = this._inputFingerprint(facts, plan);
        const statePath = path.join(resolvedCodeDir, 'code-state.json');
        const previous = previousState || this._readJson(statePath) || {};
        const sameInput = previous.schemaVersion === CODE_STATE_SCHEMA
            && String(previous.inputFingerprint || '').trim() === inputFingerprint;

        const completedPaths = array(previous.skeleton && previous.skeleton.materializedTargets).slice();
        if (previousPlan && previous.phase === VIBE_CODING_MODE && previous.skeleton?.pendingCount === 0) {
            completedPaths.push(...this._plannedSkeletonFiles(previousPlan).map(file => this._targetId(file)));
        }
        const preservedTargets = new Set(completedPaths);
        const planned = this._plannedSkeletonFiles(plan);
        const retained = planned.filter(file => preservedTargets.has(this._targetId(file)) && fs.existsSync(file.path));
        const skeleton = this._buildSkeletonState(plan, sameInput ? previous.skeleton : null);
        if (!sameInput) {
            skeleton.materializedCount = retained.length;
            skeleton.pendingCount = planned.length - retained.length;
        }
        skeleton.materializedTargets = sameInput && !completedPaths.length && skeleton.pendingCount === 0
            ? planned.map(file => this._targetId(file)) : retained.map(file => this._targetId(file));
        const phase = skeleton.pendingCount > 0 ? 'skeleton_materialize' : VIBE_CODING_MODE;
        const state = {
            schemaVersion: CODE_STATE_SCHEMA,
            demandName: String(demandName || previous.demandName || '').trim(),
            inputFingerprint,
            feedbackContinuation: previous.feedbackContinuation === true || Boolean(previousPlan
                && previousPlan.designInputHash !== plan.designInputHash && Number(previous.skeleton?.materializedCount) > 0),
            generatedAt: sameInput && previous.generatedAt ? previous.generatedAt : this.now(),
            updatedAt: this.now(),
            phase,
            codingMode: phase === VIBE_CODING_MODE ? VIBE_CODING_MODE : '',
            storyCount: this._storyCount(facts),
            skeleton,
            nextRequiredTool: phase === 'skeleton_materialize'
                ? 'design_tdd_skeleton_materialize'
                : VIBE_CODING_START_TOOL
        };
        if (plan && plan.projectionHashes) {
            state.projectionRevision = String(plan.projectionHashes.projectionRevision || '').trim();
        }
        if (plan && plan.designInputHash) state.designInputHash = String(plan.designInputHash).trim();
        if (plan && plan.intentLedgerHash) state.intentLedgerHash = String(plan.intentLedgerHash).trim();

        fs.mkdirSync(resolvedCodeDir, { recursive: true });
        this._writeJsonAtomic(statePath, state);
        if (!sameInput) this._removeSkeletonCompileReceipt(path.join(resolvedCodeDir, 'skeleton-compile-receipt.json'));
        return { ok: true, statePath, state };
    }

    prepare({ projectPath = '' } = {}) {
        const resolved = this.resolvePaths(projectPath);
        if (!resolved.ok) return resolved;
        const facts = this._readJson(resolved.factsPath);
        const plan = this._readJson(resolved.planPath);
        if (!facts) return this._blocked('DESIGN_TDD_BUSINESS_FACTS_MISSING', `缺少 business-facts.json：${resolved.factsPath}`);
        if (!plan) return this._blocked('DESIGN_TDD_PLAN_JSON_MISSING', `缺少 design-tdd-plan.json：${resolved.planPath}`);

        let state = this._readJson(resolved.statePath);
        const expectedFingerprint = this._inputFingerprint(facts, plan);
        if (!state || state.schemaVersion !== CODE_STATE_SCHEMA
            || String(state.inputFingerprint || '').trim() !== expectedFingerprint) {
            const initialized = this.initialize({
                codeDir: resolved.codeDir,
                demandName: resolved.demandName,
                facts,
                plan
            });
            if (!initialized.ok) return initialized;
            state = initialized.state;
        }

        const refreshed = this.refreshSkeletonProgress({
            resolved,
            state,
            plan,
            transitionToVibe: true
        });
        if (!refreshed.ok) return refreshed;
        state = refreshed.state;
        if (state.skeleton.pendingCount > 0) {
            return {
                ok: true,
                status: 'ready',
                phase: 'skeleton_materialize',
                skeleton: state.skeleton,
                nextActionCard: {
                    toolName: 'design_tdd_skeleton_materialize',
                    arguments: { projectPath: resolved.projectPath }
                }
            };
        }
        return this._vibeCodingCompletionResponse({ resolved, state });
    }

    getSkeletonWork({ projectPath = '' } = {}) {
        const resolved = this.resolvePaths(projectPath);
        if (!resolved.ok) return resolved;
        const state = this._readJson(resolved.statePath);
        const plan = this._readJson(resolved.planPath);
        if (!state || state.schemaVersion !== CODE_STATE_SCHEMA || !plan) {
            return this._blocked('DESIGN_TDD_SKELETON_STATE_MISSING', '缺少有效编码运行态或 design-tdd-plan.json。');
        }
        const plannedFiles = this._plannedSkeletonFiles(plan);
        const stateSkeleton = state.skeleton && typeof state.skeleton === 'object'
            ? state.skeleton
            : {};
        const statePlannedCount = Number(stateSkeleton.plannedCount);
        const stateMaterializedCount = Number(stateSkeleton.materializedCount);
        const statePendingCount = Number(stateSkeleton.pendingCount);
        const stateCompletionIsAuthoritative = state.phase !== 'skeleton_materialize'
            && Number.isInteger(statePlannedCount)
            && statePlannedCount === plannedFiles.length
            && Number.isInteger(stateMaterializedCount)
            && stateMaterializedCount === plannedFiles.length
            && Number.isInteger(statePendingCount)
            && statePendingCount === 0;
        if (stateCompletionIsAuthoritative) {
            // 完成阶段会清理 skeleton-manifests-ledger.json。此时 code-state/v3
            // 的闭合计数是唯一当前状态，不能因账本被清理而把全部文件重新判成待办。
            return {
                ok: true,
                status: 'skeleton_completed_replay',
                idempotentReplay: true,
                resolved,
                state,
                plan,
                pendingFiles: [],
                materializedFiles: plannedFiles,
                plannedCount: plannedFiles.length
            };
        }

        const ledger = this._readJson(resolved.ledgerPath) || {};
        const materialized = new Set([...array(stateSkeleton.materializedTargets), ...array(ledger.entries)
            .map(item => this._targetId({ fileKind: item.fileKind, path: item.targetFile }))]);
        const materializedFiles = plannedFiles.filter(item => materialized.has(this._targetId(item)));
        const pendingFiles = plannedFiles.filter(item => !materialized.has(this._targetId(item)));
        if (state.phase !== 'skeleton_materialize' && pendingFiles.length === 0) {
            // 兼容旧状态：如果账本仍存在，仍可按账本确认幂等完成。
            return {
                ok: true,
                status: 'skeleton_completed_replay',
                idempotentReplay: true,
                resolved,
                state,
                plan,
                pendingFiles: [],
                materializedFiles,
                plannedCount: plannedFiles.length
            };
        }
        // 一次把所有未登记文件交给 MCP handler；账本仍是唯一完成真值。
        return {
            ok: true,
            resolved,
            state,
            plan,
            pendingFiles,
            materializedFiles,
            plannedCount: plannedFiles.length
        };
    }

    replaySkeletonCompletion({ batch = null } = {}) {
        if (!batch || batch.status !== 'skeleton_completed_replay'
            || !batch.resolved || !batch.state) {
            return this._blocked('DESIGN_TDD_SKELETON_REPLAY_INVALID', '缺少可复用的骨架完成状态，不能执行幂等重放。');
        }
        return this._vibeCodingCompletionResponse({
            resolved: batch.resolved,
            state: batch.state
        });
    }

    recordSkeletonCompileReceipt({ projectPath = '', result = null, files = [] } = {}) {
        const resolved = this.resolvePaths(projectPath);
        if (!resolved.ok) return resolved;
        if (!this._isCompileAttemptResult(result)) {
            return this._blocked('DESIGN_TDD_SKELETON_COMPILE_FAILED', '骨架编译结果无效，不能写入执行凭证.', {
                result: result || null,
                files: uniqueStrings(files)
            });
        }
        const state = this._readJson(resolved.statePath);
        const plan = this._readJson(resolved.planPath);
        if (!state || !plan || state.schemaVersion !== CODE_STATE_SCHEMA) {
            return this._blocked('DESIGN_TDD_SKELETON_STATE_MISSING', '缺少有效编码运行态或 design-tdd-plan.json。');
        }
        const normalizedFiles = uniqueStrings(files).sort();
        const receipt = {
            schemaVersion: 'design-tdd-skeleton-compile-receipt/v1',
            generatedAt: this.now(),
            inputFingerprint: String(state.inputFingerprint || '').trim(),
            projectionRevision: String(plan.projectionHashes && plan.projectionHashes.projectionRevision || '').trim(),
            files: normalizedFiles,
            compileFingerprint: sha256(JSON.stringify({
                inputFingerprint: state.inputFingerprint,
                projectionRevision: plan.projectionHashes && plan.projectionHashes.projectionRevision,
                files: normalizedFiles
            })),
            result: JSON.parse(JSON.stringify(result)),
            compilePassed: this._isVerifiedCompileResult(result)
        };
        try {
            this._writeJsonAtomic(resolved.skeletonCompileReceiptPath, receipt);
            return { ok: true, path: resolved.skeletonCompileReceiptPath, receipt };
        } catch (error) {
            return this._blocked('DESIGN_TDD_SKELETON_COMPILE_RECEIPT_WRITE_FAILED',
                `骨架编译执行凭证写盘失败：${String(error && error.message || error)}`, {
                    machineRecoverable: true,
                    stopLockRequired: false
                });
        }
    }

    completeSkeletonBatch({ projectPath = '' } = {}) {
        const resolved = this.resolvePaths(projectPath);
        if (!resolved.ok) return resolved;
        const refreshed = this.refreshSkeletonProgress({ resolved, transitionToVibe: true });
        if (!refreshed.ok) return refreshed;
        if (refreshed.state.skeleton.pendingCount > 0) {
            return this._blocked('DESIGN_TDD_SKELETON_BATCH_INCOMPLETE', '批量骨架仍有未物化文件，可继续调用 design_tdd_skeleton_materialize。');
        }
        return this._vibeCodingCompletionResponse({ resolved, state: refreshed.state });
    }

    refreshSkeletonProgress({ resolved = null, state = null, plan = null, transitionToVibe = false } = {}) {
        const paths = resolved || this.resolvePaths('');
        if (!paths.ok) return paths;
        const current = state || this._readJson(paths.statePath);
        const currentPlan = plan || this._readJson(paths.planPath);
        if (!current || !currentPlan) return this._blocked('DESIGN_TDD_SKELETON_STATE_MISSING', '缺少骨架运行态或计划。');
        const planned = this._plannedSkeletonFiles(currentPlan);
        const ledger = this._readJson(paths.ledgerPath) || {};
        const materialized = new Set([...array(current.skeleton?.materializedTargets), ...array(ledger.entries)
            .map(item => this._targetId({ fileKind: item.fileKind, path: item.targetFile }))]);
        if (current.phase === VIBE_CODING_MODE && current.skeleton?.pendingCount === 0
            && current.skeleton?.plannedCount === planned.length && !materialized.size) {
            planned.forEach(file => materialized.add(this._targetId(file)));
        }
        const next = {
            ...current,
            skeleton: {
                plannedCount: planned.length,
                materializedCount: planned.filter(item => materialized.has(this._targetId(item))).length,
                pendingCount: planned.filter(item => !materialized.has(this._targetId(item))).length,
                materializedTargets: planned.filter(item => materialized.has(this._targetId(item))).map(item => this._targetId(item))
            },
            updatedAt: this.now()
        };
        // 只有明确的阶段推进调用才切到 Vibe Coding。失败批次刷新进度时即使
        // ledger 暂时显示没有待办，也必须保留 skeleton_materialize，保证下一次
        // 调用可以重试凭证/登记而不会被“阶段已完成”门禁挡住。
        if (next.skeleton.pendingCount === 0 && transitionToVibe) {
            next.phase = VIBE_CODING_MODE;
            next.codingMode = VIBE_CODING_MODE;
            next.nextRequiredTool = VIBE_CODING_START_TOOL;
        }
        this._writeJsonAtomic(paths.statePath, next);
        return { ok: true, state: next };
    }

    resolvePaths(projectPath = '') {
        const normalizedProject = path.resolve(String(projectPath || '').trim());
        if (!projectPath) return this._blocked('DESIGN_TDD_PROJECT_PATH_MISSING', '缺少 projectPath。');
        try {
            const projectDir = path.join(normalizedProject, '.ai-workspace', 'project');
            const activeDemandPath = path.join(projectDir, '.active-demand');
            if (!fs.existsSync(activeDemandPath)) return this._blocked('DESIGN_TDD_ACTIVE_DEMAND_MISSING', `缺少.active-demand：${activeDemandPath}`);
            const demandName = String(fs.readFileSync(activeDemandPath, 'utf-8') || '').trim();
            if (!demandName) return this._blocked('DESIGN_TDD_ACTIVE_DEMAND_EMPTY', `.active-demand为空：${activeDemandPath}`);
            const demandDir = path.resolve(projectDir, demandName);
            if (!this._isSameOrChild(demandDir, projectDir)) return this._blocked('DESIGN_TDD_DEMAND_DIR_OUT_OF_PROJECT', '.active-demand指向项目外目录。');
            const codeDir = path.join(demandDir, 'code');
            return {
                ok: true,
                projectPath: normalizedProject,
                demandName,
                demandDir,
                codeDir,
                factsPath: path.join(codeDir, 'business-facts.json'),
                planPath: path.join(codeDir, 'design-tdd-plan.json'),
                statePath: path.join(codeDir, 'code-state.json'),
                ledgerPath: path.join(codeDir, 'skeleton-manifests-ledger.json'),
                skeletonCompileReceiptPath: path.join(codeDir, 'skeleton-compile-receipt.json')
            };
        } catch (error) {
            return this._blocked('DESIGN_TDD_PATH_RESOLVE_FAILED', '解析编码运行路径失败。', {
                cause: String(error && error.message || error)
            });
        }
    }

    _vibeCodingCompletionResponse({ resolved, state } = {}) {
        const skeleton = state && state.skeleton || {};
        const codeDir = resolved && resolved.codeDir || '';
        const demandDir = resolved && resolved.demandDir || path.dirname(codeDir);
        const implementationTasksPath = path.join(codeDir, 'demand-implementation-tasks.md');
        const coderIntakeRef = path.join(codeDir, 'requirement-work-draft.json');
        const feedbackContinuation = state?.feedbackContinuation === true;
        const completionSummary = {
            plannedCount: Number(skeleton.plannedCount || 0),
            materializedCount: Number(skeleton.materializedCount || 0),
            pendingCount: Number(skeleton.pendingCount || 0),
            storyCount: Number(state && state.storyCount || 0)
        };
        const displayLine = `骨架物化完成：计划 ${completionSummary.plannedCount} 个文件，成功 ${completionSummary.materializedCount} 个，剩余 ${completionSummary.pendingCount} 个；共 ${completionSummary.storyCount} 个 Story。下一阶段：整需求 Vibe Coding。`;
        return {
            ok: true,
            status: 'skeleton_completed',
            phase: VIBE_CODING_MODE,
            codingMode: VIBE_CODING_MODE,
            awaitingUser: !feedbackContinuation,
            stopAfter: !feedbackContinuation,
            responseMode: feedbackContinuation ? 'silent_continuation' : 'wait_for_user_to_start_next_stage',
            completionSummary,
            displayLine,
            skillName: 'epoint-design-tdd-coder',
            projectPath: resolved.projectPath,
            coderIntakeRef,
            implementationTasksPath,
            nextActionCard: {
                title: feedbackContinuation ? '反馈新增骨架已完成，继续现有实施任务' : '批量骨架已完成，等待用户启动整需求 Vibe Coding',
                displayRequired: true,
                displayLine,
                awaitingUser: !feedbackContinuation,
                stopAfter: !feedbackContinuation,
                instruction: feedbackContinuation
                    ? '反馈新增骨架已完成，不再要求启动确认。按 Coder 主 Skill 读取更新的 intake 和受影响事实，保留实施任务编号及未完成项，增量修改已有业务代码并继续验证；不得模板覆盖旧代码。'
                    : '骨架已经全部完成。向用户告知完成情况后停止；用户启动编码时使用 epoint-design-tdd-coder 主 Skill，读取 coderIntakeRef 和 storyCatalogRef，将覆盖关系、实际结果及缺口统一保存到 implementationTasksPath，按主 Skill 展示和更新当前批次 TodoList。当前 Story 从 detailRef 读取完整验收与必要资料，不预读全部代码目录。事实足够后立即写对应行为测试或业务实现；测试先行后立即实现对应行为。整个编码及恢复按主 Skill 执行，不调用会推进状态的 MCP；CodeGraph、Nextbot 或原生待办工具不可用时不因此阻断。',
                afterUserStarts: {
                    skillName: 'epoint-design-tdd-coder',
                    codingMode: VIBE_CODING_MODE,
                    projectPath: resolved.projectPath,
                    coderIntakeRef,
                    implementationTasksPath
                }
            },
            allowedNextActions: ['display_skeleton_completion_then_start_direct_vibecoding'],
            forbiddenActions: [
                'call_coder_orchestration_mcp_after_skeleton',
                'drive_work_by_single_story_or_file_type',
                'edit_business_code_in_same_turn_as_initial_skeleton_materialize',
                'modify_builder_owned_truth_files'
            ]
        };
    }

    _storyCount(facts = {}) {
        const storyIds = new Set();
        const storyValues = Array.isArray(facts.stories)
            ? facts.stories
            : (facts.stories && typeof facts.stories === 'object' ? Object.values(facts.stories) : []);
        storyValues.forEach(story => {
            const storyId = String(story && story.storyId || '').trim().toUpperCase();
            if (storyId) storyIds.add(storyId);
        });
        flattenBusinessFactsAcceptanceItems(facts).forEach(item => {
            const storyId = String(item && (item.storyId || item.sourceStoryId) || '').trim().toUpperCase();
            if (storyId) storyIds.add(storyId);
        });
        return storyIds.size;
    }

    _buildSkeletonState(plan = {}, previous = null) {
        const planned = this._plannedSkeletonFiles(plan);
        const old = previous && typeof previous === 'object' ? previous : {};
        const oldMaterializedCount = Number(old.materializedCount || 0);
        return {
            plannedCount: planned.length,
            materializedCount: Math.min(oldMaterializedCount, planned.length),
            pendingCount: Math.max(0, planned.length - oldMaterializedCount)
        };
    }

    _targetId(file) {
        return `${String(file.fileKind || '').trim()}:${this._normalizePath(file.path)}`;
    }

    _plannedSkeletonFiles(plan = {}) {
        const mappings = GateContractRegistry.getSkeletonMappings ? GateContractRegistry.getSkeletonMappings() : {};
        const eligibleKinds = new Set(array(mappings.SKELETON_ELIGIBLE_FILE_KINDS)
            .map(item => String(item || '').trim())
            .filter(Boolean));
        const out = [];
        array(plan.modulesOwnerFiles).forEach(module => array(module && module.ownerFiles).forEach(file => {
            const filePath = String(file && file.resolvedPath || '').trim();
            const fileKind = String(file && file.fileKind || '').trim();
            if (!filePath || !eligibleKinds.has(fileKind)) return;
            out.push({
                moduleId: String(module && module.moduleId || '').trim(),
                fileKind,
                path: path.resolve(filePath),
                ownerFile: { ...file }
            });
        }));
        const order = new Map(array(plan.skeletonDependencyGraph && plan.skeletonDependencyGraph.orderedTargetIds)
            .map((targetId, index) => [String(targetId || '').trim(), index]));
        out.sort((left, right) => {
            const leftId = `${left.fileKind}:${this._normalizePath(left.path)}`;
            const rightId = `${right.fileKind}:${this._normalizePath(right.path)}`;
            return (order.get(leftId) ?? Number.MAX_SAFE_INTEGER)
                - (order.get(rightId) ?? Number.MAX_SAFE_INTEGER)
                || leftId.localeCompare(rightId);
        });
        return out;
    }

    _inputFingerprint(facts = {}, plan = {}) {
        const immutableFacts = JSON.parse(JSON.stringify(facts || {}));
        const immutablePlan = JSON.parse(JSON.stringify(plan || {}));
        delete immutableFacts.generatedAt;
        delete immutableFacts.updatedAt;
        delete immutablePlan.generatedAt;
        delete immutablePlan.updatedAt;
        return sha256(stableStringify({ facts: immutableFacts, plan: immutablePlan })).slice(0, 32);
    }

    _isCompileAttemptResult(result = null) {
        return Boolean(result
            && typeof result.ok === 'boolean'
            && typeof result.ran === 'boolean'
            && ['pass', 'fail', 'unavailable', 'skipped'].includes(String(result.result || '').trim()));
    }

    _isVerifiedCompileResult(result = null) {
        return Boolean(result
            && result.ok === true
            && result.ran === true
            && String(result.result || '').trim() === 'pass'
            && result.exitCode === 0);
    }

    _normalizePath(filePath = '') {
        return filePath ? path.resolve(String(filePath)).replace(/\\/g, '/').toLowerCase() : '';
    }

    _isSameOrChild(child = '', parent = '') {
        const relative = path.relative(path.resolve(parent), path.resolve(child));
        return relative === '' || (!!relative && !relative.startsWith('..') && !path.isAbsolute(relative));
    }

    _readJson(filePath = '') {
        try {
            if (!filePath || !fs.existsSync(filePath)) return null;
            const value = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
            return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
        } catch (_) {
            return null;
        }
    }

    _writeJsonAtomic(filePath = '', value = {}) {
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
        try {
            fs.writeFileSync(tempPath, `${JSON.stringify(value, null, 2)}\n`, 'utf-8');
            const handle = fs.openSync(tempPath, 'r+');
            try { fs.fsyncSync(handle); } finally { fs.closeSync(handle); }
            fs.renameSync(tempPath, filePath);
        } finally {
            if (fs.existsSync(tempPath)) {
                try { fs.unlinkSync(tempPath); } catch (_) { }
            }
        }
    }

    _removeSkeletonCompileReceipt(receiptPath = '') {
        try {
            if (receiptPath && fs.existsSync(receiptPath)) fs.rmSync(receiptPath, { force: true });
        } catch (_) { }
    }

    _blocked(errorCode, message, extra = {}) {
        return {
            ok: false,
            status: 'blocked',
            actionMode: 'blocker',
            errorCode,
            message,
            allowedNextActions: ['repair_upstream_artifact_or_rerun_design_tdd_build_plan'],
            ...extra
        };
    }
}

DesignTddCodeRuntimeService.CODE_STATE_SCHEMA = CODE_STATE_SCHEMA;
DesignTddCodeRuntimeService.VIBE_CODING_MODE = VIBE_CODING_MODE;
DesignTddCodeRuntimeService.VIBE_CODING_START_TOOL = VIBE_CODING_START_TOOL;

module.exports = DesignTddCodeRuntimeService;
