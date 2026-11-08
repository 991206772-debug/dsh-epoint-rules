/* eslint-disable */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const DesignProjectContextResolver = require('./design-project-context-resolver');
const DesignModelCompiler = require('./design-model-compiler');
const DesignDocumentBuilderService = require('./design-document-builder-service');
const RequirementRulePoolService = require('./requirement-rule-pool-service');
const FeedbackContract = require('./stage-feedback-contract');
const { StageTemporaryCleanupService } = require('./stage-temporary-cleanup-service');
const {
    OBJECT_KEY_PATTERN,
    CODE_ITEM_FACT_TYPES,
    DECISION_ROW_HELP,
    DETAIL_ROW_HELP,
    COMPOSITION_ROW_HELP
} = require('./design-decision-step-definition');

const WORKFLOW_VERSION = 'design-workflow/v7';
const MAX_CARD_BYTES = 12 * 1024;

class DesignWorkflowService {
    constructor(options = {}) {
        this.resolver = options.resolver || new DesignProjectContextResolver();
        this.compiler = options.compiler || new DesignModelCompiler();
        this.finalize = typeof options.finalize === 'function' ? options.finalize : null;
        this.validateCompleted = typeof options.validateCompleted === 'function' ? options.validateCompleted : null;
        this.beforeAtomicReplace = typeof options.beforeAtomicReplace === 'function' ? options.beforeAtomicReplace : null;
        this.maxCardBytes = Number(options.maxCardBytes || MAX_CARD_BYTES);
    }

    cleanupCompleted(projectPath) {
        try {
            const resolved = this.resolver.resolve(projectPath);
            if (!resolved.ok) return { ok: true, skipped: '无法确认当前需求目录' };
            const result = new StageTemporaryCleanupService().cleanDesign({ resolved,
                isCompleted: () => {
                    const state = this._readJson(resolved.workflowStatePath);
                    const context = this._loadContext(resolved);
                    return state?.currentPhase === 'completed' && !state.downstreamSyncPending
                        && context.ok && state.inputVersionHash === context.inputVersionHash
                        && Boolean(this._completedResult(resolved)) && !this._hasPendingPlanSync(resolved);
                } });
            const { removed, missing, ...compact } = result;
            return compact;
        } catch (error) {
            return { ok: false, removedFiles: 0, removedBytes: 0, errors: [{ message: String(error.message || error) }] };
        }
    }

    async run(args = {}) {
        const feedbackCheck = FeedbackContract.validate(args, true);
        if (!feedbackCheck.ok) return feedbackCheck;
        const resolved = this.resolver.resolve(args.projectPath);
        if (!resolved.ok) return resolved;
        const state = this._readJson(resolved.workflowStatePath);
        const completed = this._completedResult(resolved);
        const context = this._loadContext(resolved);
        if (args.requestMode === 'revise') {
            if (!context.ok) return context;
            return this._beginRevision(args, resolved, context, state);
        }
        const revisionPending = state && (state.revision || state.downstreamSyncPending || this._hasPendingPlanSync(resolved))
            && state.currentPhase !== 'completed';
        if (completed && !revisionPending && (!context.ok || !state || state.inputVersionHash === context.inputVersionHash)) {
            const submitted = ['decisionRows', 'detailRows', 'compositionRows'].find(field => args[field] !== undefined);
            return { ...completed, ...(submitted ? {
                submissionApplied: args.stepId === state?.lastAcceptedStepId
                    && this._payloadHash(args[submitted]) === state?.lastAcceptedPayloadHash
            } : {}) };
        }
        if (!context.ok) return context;
        const phase = String(args.phase || 'prepare').trim().toLowerCase() || 'prepare';
        const stateIsCompatible = state && state.workflowVersion === WORKFLOW_VERSION;
        const stateIsCurrent = stateIsCompatible && state.inputVersionHash === context.inputVersionHash;

        if (stateIsCurrent && state.currentPhase === 'completed') {
            if (phase !== 'prepare') return this._prepareRequired('Design完成态的finalize receipt或受管产物hash无效。');
            this._clearUnfinishedRuntime(resolved);
            return this._beginStructureStep(resolved, context, { finalizeArtifactsInvalid: true });
        }

        if (state && !stateIsCurrent) {
            if (phase !== 'prepare') return this._prepareRequired('Requirement上游凭证已变化，未完成Design状态已失效。');
            if (stateIsCompatible && Array.isArray(state.acceptedRows)) {
                return this._recoverAfterInputChange(resolved, context, state);
            }
            this._clearUnfinishedRuntime(resolved);
            return this._beginStructureStep(resolved, context, { upstreamChanged: true });
        }

        if (phase === 'prepare') {
            return stateIsCurrent
                ? this._resumeResult(resolved, state, { includeRecoveryEvidence: true })
                : this._beginStructureStep(resolved, context);
        }
        if (phase === 'structure_confirmed') {
            return this._submitStructureStep(args, resolved, context, stateIsCurrent ? state : null);
        }
        if (phase === 'details_confirmed') {
            return this._submitDetailStep(args, resolved, context, stateIsCurrent ? state : null);
        }
        if (phase === 'page_design_confirmed') {
            return this._submitPageDesignStep(args, resolved, context, stateIsCurrent ? state : null);
        }
        return this._blocked(
            'DESIGN_WORKFLOW_PHASE_INVALID',
            `phase=${phase}不合法。`,
            ['call_design_prepare_context_without_phase'],
            { acceptedPhases: ['prepare', 'structure_confirmed', 'details_confirmed', 'page_design_confirmed'] }
        );
    }

    _beginRevision(args, resolved, context, state) {
        if (!state || !Array.isArray(state.acceptedRows) || state.acceptedRows.length === 0) {
            return this._blocked('DESIGN_REVISION_ACCEPTED_ANSWERS_MISSING',
                '缺少已接受的设计答案，不能从最终文档猜答案；先恢复当前设计卡。', ['call_design_prepare_context_without_phase']);
        }
        const stories = context.requirementStories.stories || [];
        const storyIds = args.affectedStoryIds || stories.map(story => story.storyId);
        const unknown = storyIds.filter(id => !stories.some(story => story.storyId === id));
        if (unknown.length) return { ok: false, status: 'repair_required', stopAfter: false,
            errorCode: 'DESIGN_REVISION_STORY_UNKNOWN', message: 'affectedStoryIds 引用了当前需求不存在的 Story。',
            unknownStoryIds: unknown, allowedStoryIds: stories.map(story => story.storyId) };
        const requestHash = this._sha256(JSON.stringify([args.revisionPhase, storyIds, args.feedback]));
        if (state.revision?.requestHash === requestHash) {
            return state.currentPhase === 'completed'
                ? { ...this._completedResult(resolved), idempotentReplay: true }
                : this._resumeResult(resolved, state, { idempotentReplay: true });
        }
        const objectKeys = Array.from(new Set(state.acceptedRows
            .filter(row => (row.dependencyRefs || []).some(ref => storyIds.includes(ref.replace(/^STORY:/, ''))))
            .flatMap(row => this._rowObjectKeys(row.row)).filter(Boolean)));
        const expandedIds = Array.from(new Set([...storyIds, ...state.acceptedRows
            .filter(row => this._rowObjectKeys(row.row).some(key => objectKeys.includes(key)))
            .flatMap(row => (row.dependencyRefs || []).filter(ref => ref.startsWith('STORY:')).map(ref => ref.slice(6)))]));
        const next = { ...state, revision: { requestHash, feedback: args.feedback, phase: args.revisionPhase,
            storyIds: expandedIds, baseDesignHash: fs.existsSync(resolved.designJsonPath)
                ? this._sha256(fs.readFileSync(resolved.designJsonPath)) : '' },
            recoveryMode: 'explicit_revision', recoveryAffectedStoryIds: expandedIds,
            recoveryDetailObjectKeys: objectKeys, recoveryPageStoryIds: expandedIds,
            lastAcceptedStepId: '', lastAcceptedPayloadHash: '' };
        if (args.revisionPhase === 'structure_confirmed') {
            return this._beginStructureStep(resolved, context, { revisionPrepared: true }, next);
        }
        if (args.revisionPhase === 'page_design_confirmed') {
            const model = this._readJson(state.acceptedModelRef || resolved.canonicalModelPath);
            if (!model) return this._blocked('DESIGN_REVISION_MODEL_MISSING', '缺少受管设计模型，不能猜测恢复。', ['call_design_prepare_context_without_phase']);
            return this._beginPageDesignStep(model, resolved, context, next, '', '');
        }
        return this._resumeRetainedModel(resolved, context, next, { retained: state.acceptedRows, invalidated: [] });
    }

    _beginStructureStep(resolved, context, extra = {}, retainedState = null) {
        try {
            fs.mkdirSync(resolved.runtimeDir, { recursive: true });
            const currentStepId = this._stepId('structure', context.inputVersionHash);
            const bundle = this._buildStructureCard(resolved, context, currentStepId, extra.recovery || null);
            const { card } = bundle;
            const state = {
                ...(retainedState || {}),
                workflowVersion: WORKFLOW_VERSION,
                canonicalProjectRoot: resolved.projectPath,
                demandDir: resolved.demandDir,
                inputVersionRefs: context.inputVersionRefs,
                inputVersionHash: context.inputVersionHash,
                sourceStoryHashes: context.sourceStoryHashes,
                sourceRefHashes: context.sourceRefHashes,
                currentStepId,
                currentPhase: 'structure_confirmed',
                acceptedModelRef: '',
                pendingBatchId: '',
                pendingBatchRef: '',
                currentCardRef: bundle.cardRef,
                sharedStoryEvidenceRefs: card.storyEvidenceRefs || [],
                nextCall: 'structure_confirmed',
                finalizeReceiptRef: '',
                lastAcceptedStepId: '',
                lastAcceptedPayloadHash: '',
                acceptedRows: Array.isArray(retainedState && retainedState.acceptedRows)
                    ? retainedState.acceptedRows
                    : []
            };
            for (const [ref, value] of bundle.contents) this._writeContent(ref, value);
            this._writeJsonAtomic(resolved.workflowStatePath, state);
            return this._resumeResult(resolved, state, extra);
        } catch (error) {
            return this._stateWriteBlocked(error, resolved);
        }
    }

    async _submitStructureStep(args, resolved, context, state) {
        const stepCheck = this._checkStep(args, state, 'structure_confirmed', 'decisionRows');
        if (!stepCheck.ok) return stepCheck;
        if (stepCheck.replay || stepCheck.resumeCurrent) return this._resumeResult(resolved, state,
            stepCheck.replay ? { idempotentReplay: true } : { submissionApplied: false });
        const recoveryScope = this._validateRecoveryRetainedRowScope(state, args.decisionRows);
        if (!recoveryScope.ok) return state.recoveryMode === 'explicit_revision'
            ? this._stepRepair(recoveryScope, state, resolved) : recoveryScope;

        const decisionRows = this._mergedRows(state, 'structure_confirmed', args.decisionRows);
        const compiled = this.compiler.compileModel({
            decisionRows,
            requirementStories: context.requirementStories,
            confirmedTableCandidates: context.confirmedTableCandidateFacts || context.confirmedTableCandidates
        });
        if (!compiled.ok) return this._stepRepair(compiled, state, resolved);
        const acceptedRows = this._replaceAcceptedPhaseRows(
            state,
            'structure_confirmed',
            decisionRows,
            compiled.canonicalModel
        );
        let baseModel = compiled.canonicalModel;
        const retainedDetailRows = this._acceptedRawRows({ ...state, acceptedRows }, 'details_confirmed');
        if (retainedDetailRows.length > 0) {
            const retainedDetails = this.compiler.applyDetails({
                canonicalModel: baseModel,
                detailRows: retainedDetailRows,
                requirementStories: context.requirementStories,
                final: false
            });
            if (!retainedDetails.ok) {
                return this._projectionDefect(
                    retainedDetails,
                    state,
                    resolved,
                    'DESIGN_WORKFLOW_RETAINED_ROWS_PROJECTION_DEFECT'
                );
            }
            baseModel = retainedDetails.canonicalModel;
        }
        const payloadHash = this._payloadHash(args.decisionRows);
        try {
            let batchPlan = this._buildBatchPlan(resolved, context, compiled.canonicalModel);
            if (state && ['story_dependency_invalidation', 'explicit_revision'].includes(state.recoveryMode)) {
                batchPlan = this._filterRecoveryBatchPlan(batchPlan, compiled.canonicalModel, state);
            }
            const cards = batchPlan.batches.map(batch => this._buildDetailCard(
                resolved, context, baseModel, batch, this._stepId(batch.batchId, context.inputVersionHash)
            ));
            this._writeJsonAtomic(resolved.canonicalModelPath, baseModel);
            const batchPlanPath = path.join(resolved.runtimeDir, 'detail-batches.json');
            this._writeJsonAtomic(batchPlanPath, batchPlan);
            if (batchPlan.batches.length === 0) {
                const finalModel = this.compiler.applyDetails({
                    canonicalModel: this._topologyOnlyModel(baseModel),
                    detailRows: retainedDetailRows,
                    requirementStories: context.requirementStories,
                    final: true
                });
                if (!finalModel.ok) return this._stepRepair(finalModel, state, resolved);
                return this._beginPageDesignStep(
                    finalModel.canonicalModel,
                    resolved,
                    context,
                    { ...state, acceptedRows },
                    payloadHash,
                    args.stepId
                );
            }
            const next = this._detailState(
                resolved,
                context,
                { ...state, acceptedRows },
                batchPlan,
                0,
                payloadHash,
                args.stepId,
                cards[0].stepId
            );
            next.currentCardRef = this._writeDetailCard(cards[0]);
            this._writeJsonAtomic(resolved.workflowStatePath, next);
            return this._resumeResult(resolved, next);
        } catch (error) {
            return this._stateWriteBlocked(error, resolved);
        }
    }

    async _submitDetailStep(args, resolved, context, state) {
        const stepCheck = this._checkStep(args, state, 'details_confirmed', 'detailRows');
        if (!stepCheck.ok) return stepCheck;
        if (stepCheck.replay || stepCheck.resumeCurrent) return this._resumeResult(resolved, state,
            stepCheck.replay ? { idempotentReplay: true } : { submissionApplied: false });
        const model = this._readJson(resolved.canonicalModelPath);
        const batchPlan = this._readJson(path.join(resolved.runtimeDir, 'detail-batches.json'));
        if (!model || !batchPlan || !Array.isArray(batchPlan.batches)) {
            return this._blocked('DESIGN_WORKFLOW_RUNTIME_INCOMPLETE', '受管canonical model或detail batch计划缺失；重新prepare恢复。', ['call_design_prepare_context_without_phase']);
        }
        const batchIndex = batchPlan.batches.findIndex(item => item.batchId === state.pendingBatchId);
        const batch = batchIndex >= 0 ? batchPlan.batches[batchIndex] : null;
        if (!batch) {
            return this._blocked('DESIGN_WORKFLOW_PENDING_BATCH_STALE', '当前pendingBatchId不在受管批次计划中；重新prepare恢复。', ['call_design_prepare_context_without_phase']);
        }
        const scope = this._validateDetailBatchScope(args.detailRows, batch);
        if (!scope.ok) return this._stepRepair(scope, state, resolved);
        const isLast = batchIndex === batchPlan.batches.length - 1;
        const detailRows = this._mergedRows(state, 'details_confirmed', args.detailRows);
        const detailed = this.compiler.applyDetails({
            canonicalModel: this._topologyOnlyModel(model),
            detailRows,
            requirementStories: context.requirementStories,
            final: isLast
        });
        if (!detailed.ok) return this._stepRepair(detailed, state, resolved);
        const acceptedRows = this._replaceAcceptedPhaseRows(
            state,
            'details_confirmed',
            detailRows,
            detailed.canonicalModel
        );
        const payloadHash = this._payloadHash(args.detailRows);
        try {
            if (isLast) {
                return this._beginPageDesignStep(
                    detailed.canonicalModel,
                    resolved,
                    context,
                    { ...state, acceptedRows },
                    payloadHash,
                    args.stepId
                );
            }
            const next = this._detailState(
                resolved,
                context,
                { ...state, acceptedRows },
                batchPlan,
                batchIndex + 1,
                payloadHash,
                args.stepId,
                this._stepId(batchPlan.batches[batchIndex + 1].batchId, context.inputVersionHash)
            );
            const card = this._buildDetailCard(resolved, context, detailed.canonicalModel,
                batchPlan.batches[batchIndex + 1], next.currentStepId);
            this._writeJsonAtomic(resolved.canonicalModelPath, detailed.canonicalModel);
            next.currentCardRef = this._writeDetailCard(card);
            this._writeJsonAtomic(resolved.workflowStatePath, next);
            return this._resumeResult(resolved, next);
        } catch (error) {
            return this._stateWriteBlocked(error, resolved);
        }
    }

    _beginPageDesignStep(canonicalModel, resolved, context, state, payloadHash, acceptedStepId) {
        try {
            const next = this._pageDesignState(resolved, context, state, payloadHash, acceptedStepId);
            next.currentStepId = `page-design-${this._sha256(JSON.stringify([context.inputVersionHash, canonicalModel, state.recoveryPageStoryIds || [], state.revision?.requestHash || ''])).slice(0, 24)}`;
            next.currentCardRef = this._writePageDesignCard(
                resolved,
                canonicalModel,
                next.currentStepId,
                Array.isArray(state && state.sharedStoryEvidenceRefs) ? state.sharedStoryEvidenceRefs : [],
                Array.isArray(state && state.recoveryPageStoryIds) ? state.recoveryPageStoryIds : [],
                state.recoveryMode === 'explicit_revision' && state.revision?.phase === 'page_design_confirmed'
            );
            next.acceptedModelRef = this._writeContent(this._contentPath(resolved, 'model', canonicalModel), canonicalModel);
            this._writeJsonAtomic(resolved.workflowStatePath, next);
            return this._resumeResult(resolved, next);
        } catch (error) {
            return this._stateWriteBlocked(error, resolved);
        }
    }

    async _submitPageDesignStep(args, resolved, context, state) {
        const stepCheck = this._checkStep(args, state, 'page_design_confirmed', 'compositionRows');
        if (!stepCheck.ok) return stepCheck;
        if (stepCheck.replay || stepCheck.resumeCurrent) return this._resumeResult(resolved, state,
            stepCheck.replay ? { idempotentReplay: true } : { submissionApplied: false });
        const recoveryScope = this._validateRecoveryPageScope(state, args.compositionRows);
        if (!recoveryScope.ok) return state.recoveryMode === 'explicit_revision'
            ? this._stepRepair(recoveryScope, state, resolved) : recoveryScope;
        const model = this._readJson(state.acceptedModelRef || resolved.canonicalModelPath);
        if (!model) {
            return this._blocked('DESIGN_WORKFLOW_RUNTIME_INCOMPLETE', '受管canonical model缺失；重新prepare恢复。', ['call_design_prepare_context_without_phase']);
        }
        const compositionRows = this._mergedRows(state, 'page_design_confirmed', args.compositionRows);
        const designed = this.compiler.applyPageDesign({
            canonicalModel: model,
            compositionRows,
            requirementStories: context.requirementStories
        });
        if (!designed.ok) return this._stepRepair(designed, state, resolved);
        const acceptedRows = this._replaceAcceptedPhaseRows(
            state,
            'page_design_confirmed',
            compositionRows,
            designed.canonicalModel
        );
        const payloadHash = this._payloadHash(args.compositionRows);
        return await this._finalizeModel(
            designed.canonicalModel,
            resolved,
            context,
            { ...state, acceptedRows },
            payloadHash
        );
    }

    async _finalizeModel(canonicalModel, resolved, context, state, payloadHash) {
        const projected = this.compiler.toBuilderInput(canonicalModel, context.requirementStories);
        if (!projected.ok && projected.issues?.length > 0
            && projected.issues.every(issue => issue.code === 'DESIGN_MODEL_QUERY_FILTER_SURFACE_CONFLICT')) {
            return this._stepRepair(projected, state, resolved);
        }
        if (!projected.ok) return this._projectionDefect(projected, state, resolved, 'DESIGN_PUBLIC_INPUT_PROJECTION_DEFECT');
        if (!this.finalize) {
            return this._projectionDefect({ message: '最终Builder/Coder预检未注入。' }, state, resolved, 'DESIGN_WORKFLOW_MODEL_PREFLIGHT_UNAVAILABLE');
        }
        let finalized;
        try {
            finalized = await this.finalize({
                resolved,
                context,
                canonicalModel,
                builderInput: projected
            });
        } catch (error) {
            const completed = this._completedRevisionResult(resolved, state);
            if (completed) {
                return {
                    ...completed,
                    warning: `Finalizer返回前中断，但有效finalize receipt及全部产物hash已闭合：${error.message}`
                };
            }
            return this._finalizeInterrupted(error, state, resolved);
        }
        if (!finalized || finalized.ok !== true || finalized.designFinalized !== true) {
            if (finalized?.downstreamSyncPending) {
                this._writeJsonAtomic(resolved.workflowStatePath, { ...state, downstreamSyncPending: true });
                if (finalized.stopLockRequired === true) return finalized;
                return { ...finalized, status: 'repair_required', stopAfter: false,
                    currentPhase: state.currentPhase, currentStepId: state.currentStepId,
                    currentCardRef: state.currentCardRef,
                    allowedNextActions: ['resubmit_current_step_with_same_step_id'] };
            }
            const completed = this._completedRevisionResult(resolved, state);
            if (completed) return completed;
            const actionMode = String(finalized && finalized.actionMode || '');
            const errorCode = String(finalized && finalized.errorCode || '');
            const isProjectionDefect = actionMode === 'report_design_projection_defect'
                || errorCode === 'DESIGN_PUBLIC_INPUT_PROJECTION_DEFECT'
                || errorCode === 'DESIGN_CODER_BUILD_PLAN_PREFLIGHT_FAILED';
            const isUpstreamBlocked = actionMode === 'upstream_design_repair'
                || actionMode.startsWith('stop_upstream_')
                || errorCode === 'REQUIREMENT_STORIES_LOCAL_PERSISTENCE_UNRESOLVED';
            return isProjectionDefect
                ? this._projectionDefect(finalized, state, resolved, errorCode || 'DESIGN_PUBLIC_INPUT_PROJECTION_DEFECT')
                : (isUpstreamBlocked
                    ? this._upstreamBlocked(finalized, state, resolved)
                    : this._finalizeInterrupted(finalized, state, resolved));
        }
        try {
            const completedState = {
                ...state,
                downstreamSyncPending: false,
                currentPhase: 'completed',
                currentStepId: '',
                pendingBatchId: '',
                pendingBatchRef: '',
                currentCardRef: '',
                nextCall: '',
                finalizeReceiptRef: finalized.finalizeReceiptRef || resolved.finalizeReceiptPath,
                lastAcceptedStepId: state.currentStepId,
                lastAcceptedPayloadHash: payloadHash
            };
            this._writeJsonAtomic(resolved.workflowStatePath, completedState);
        } catch (error) {
            return {
                ...finalized,
                warning: 'Design最终产物已完成，但workflow state完成标记写入失败；下次prepare将以有效finalize receipt返回completed。',
                stateWriteError: error.message
            };
        }
        return { ...finalized, currentPhase: 'completed' };
    }

    _completedRevisionResult(resolved, state) {
        if (state?.downstreamSyncPending || this._hasPendingPlanSync(resolved)) return null;
        if (state?.revision?.baseDesignHash && fs.existsSync(resolved.designJsonPath)
            && this._sha256(fs.readFileSync(resolved.designJsonPath)) === state.revision.baseDesignHash) return null;
        return this._completedResult(resolved);
    }

    _hasPendingPlanSync(resolved) {
        const plan = this._readJson(path.join(resolved.demandDir, 'code', 'design-tdd-plan.json'));
        const design = this._readJson(resolved.designJsonPath);
        return Boolean(plan && design && plan.designInputHash !== this._sha256(JSON.stringify(design)));
    }

    _detailState(resolved, context, state, plan, index, payloadHash, acceptedStepId, stepId) {
        const batch = plan.batches[index];
        return {
            ...state,
            workflowVersion: WORKFLOW_VERSION,
            inputVersionRefs: context.inputVersionRefs,
            inputVersionHash: context.inputVersionHash,
            sourceStoryHashes: context.sourceStoryHashes,
            sourceRefHashes: context.sourceRefHashes,
            currentStepId: stepId,
            currentPhase: 'details_confirmed',
            acceptedModelRef: resolved.canonicalModelPath,
            pendingBatchId: batch.batchId,
            pendingBatchRef: path.join(resolved.runtimeDir, 'detail-batches.json'),
            currentCardRef: resolved.currentCardPath,
            nextCall: 'details_confirmed',
            lastAcceptedStepId: acceptedStepId,
            lastAcceptedPayloadHash: payloadHash
        };
    }

    _pageDesignState(resolved, context, state, payloadHash, acceptedStepId) {
        return {
            ...state,
            workflowVersion: WORKFLOW_VERSION,
            inputVersionRefs: context.inputVersionRefs,
            inputVersionHash: context.inputVersionHash,
            sourceStoryHashes: context.sourceStoryHashes,
            sourceRefHashes: context.sourceRefHashes,
            currentStepId: this._stepId('page-design', context.inputVersionHash),
            currentPhase: 'page_design_confirmed',
            acceptedModelRef: resolved.canonicalModelPath,
            pendingBatchId: '',
            pendingBatchRef: '',
            currentCardRef: resolved.currentCardPath,
            nextCall: 'page_design_confirmed',
            lastAcceptedStepId: acceptedStepId,
            lastAcceptedPayloadHash: payloadHash
        };
    }

    _checkStep(args, state, expectedPhase, payloadField) {
        if (!state) {
            return this._blocked('DESIGN_WORKFLOW_STATE_MISSING', '没有可恢复的Design状态；先调用无phase的prepare。', ['call_design_prepare_context_without_phase']);
        }
        const stepId = String(args.stepId || '').trim();
        if (!stepId) {
            return this._blocked('DESIGN_WORKFLOW_STEP_ID_MISSING', '写提交必须携带prepare返回的currentStepId。', ['call_design_prepare_context_without_phase']);
        }
        const payload = args[payloadField];
        const normalized = this._normalizeRowsPayload(payload);
        if (normalized === null) {
            const actualType = payload === null ? 'null'
                : payload === undefined ? 'undefined'
                : Array.isArray(payload) ? 'array'
                : typeof payload === 'object' ? 'object'
                : typeof payload;
            return this._blocked('DESIGN_WORKFLOW_PAYLOAD_NOT_ARRAY', `${payloadField}必须是扁平字符串数组，实际提交的是 ${actualType}。`, ['call_design_prepare_context_without_phase'], {
                actualType,
                expectedShape: payloadField === 'compositionRows'
                    ? '传字符串数组；仅所有行类型均无设计义务时传 []。普通列表仍可提交 ["QUERY_FILTER|US1|searchKeyword|authorization.field1|contains|trim"]；普通布局示例 ["COMPOSE|US1|plain|form:authorization"]，审计标签可省略，plain不写SECTION；Story和字段须替换为当前卡片的真实引用。'
                    : '传 ["TABLE|table_key|new|中文表名"] 这类扁平字符串数组',
                forbiddenValue: '不要传占位符字符串 "<按currentCardRef填写>"、null 或对象；不要把 nextCall.arguments 里的占位符原样回传',
                recoveryAction: '用当前卡的 stepId 重新提交，payload 改为合法的扁平字符串数组'
            });
        }
        args[payloadField] = normalized;
        const hash = this._payloadHash(normalized);
        if (stepId === state.lastAcceptedStepId) {
            if (hash === state.lastAcceptedPayloadHash) return { ok: true, replay: true };
            return { ok: true, resumeCurrent: true };
        }
        if (state.currentPhase !== expectedPhase || stepId !== state.currentStepId) {
            return { ok: true, resumeCurrent: true };
        }
        return { ok: true, replay: false };
    }

    _buildBatchPlan(resolved, context, model) {
        const required = [];
        const carriers = new Map((model.carriers || []).map(item => [item.objectKey, item]));
        const workflowStoryIds = new Set(this._stories(context.requirementStories)
            .filter(story => story && story.workflowIntent && typeof story.workflowIntent === 'object')
            .map(story => this._storyId(story))
            .filter(Boolean));
        (model.dataObjects || []).forEach(object => {
            const carrier = carriers.get(object.objectKey);
            const restStoryIds = (model.storyRoutes || [])
                .filter(route => route.primaryObjectKey === object.objectKey && route.requirementSceneLock === 'rest_interface')
                .map(route => route.storyId);
            const objectWorkflowStoryIds = (model.storyRoutes || [])
                .filter(route => route.primaryObjectKey === object.objectKey)
                .map(route => String(route.storyId || '').trim().toUpperCase())
                .filter(storyId => workflowStoryIds.has(storyId));
            const ownerWorkflowStoryId = String(carrier && carrier.ownerStoryId || '').trim().toUpperCase();
            if (workflowStoryIds.has(ownerWorkflowStoryId)) objectWorkflowStoryIds.push(ownerWorkflowStoryId);
            const uniqueWorkflowStoryIds = Array.from(new Set(objectWorkflowStoryIds));
            if ((carrier && carrier.mode === 'new') || restStoryIds.length > 0 || uniqueWorkflowStoryIds.length > 0) {
                required.push({
                    objectKey: object.objectKey,
                    restStoryIds,
                    ...(uniqueWorkflowStoryIds.length > 0 ? { workflowStoryIds: uniqueWorkflowStoryIds } : {})
                });
            }
        });
        const batches = [];
        let items = [];
        const batchFor = values => ({
            batchId: `detail-${String(batches.length + 1).padStart(3, '0')}`,
            tableKeys: values.map(item => item.objectKey),
            restStoryIds: Array.from(new Set(values.flatMap(item => item.restStoryIds))),
            ...(values.some(item => Array.isArray(item.workflowStoryIds))
                ? { workflowStoryIds: Array.from(new Set(values.flatMap(item => item.workflowStoryIds || []))) }
                : {})
        });
        const check = values => {
            const batch = batchFor(values);
            return this._buildDetailCard(resolved, context, model, batch,
                this._stepId(batch.batchId, context.inputVersionHash)).budget;
        };
        const flush = () => {
            if (items.length === 0) return;
            batches.push(batchFor(items));
            items = [];
        };
        required.forEach(item => {
            const candidate = items.concat(item);
            if (!check(candidate).withinTarget && items.length > 0) {
                flush();
            }
            items.push(item);
        });
        flush();
        return { schemaVersion: 'design-detail-batches/v1', batches };
    }

    _buildStructureCard(resolved, context, stepId, recovery = null) {
        const contents = new Map();
        const stage = (kind, value) => {
            const ref = this._contentPath(resolved, kind, value, 'structure');
            contents.set(ref, value);
            return ref;
        };
        const recoveryStoryIds = new Set(Array.isArray(recovery && recovery.storyIds) ? recovery.storyIds : []);
        const ruleRefsByStory = new RequirementRulePoolService().buildStoryRuleRefs(context.rulePool);
        const allStoryFacts = this._stories(context.requirementStories);
        const storyFacts = (recoveryStoryIds.size > 0
            ? allStoryFacts.filter(story => recoveryStoryIds.has(this._storyId(story)))
            : allStoryFacts).map(story => {
            const requirementProjection = this.compiler.projectRequirementObligations(story);
            return {
                ...this._compactStoryFact(story),
                ruleRefs: ruleRefsByStory[this._storyId(story)] || [],
                requirementLocks: {
                    workflow: requirementProjection.businessMechanisms.includes('workflow_process'),
                    statistics: requirementProjection.businessMechanisms.includes('statistics_analysis'),
                    restInterface: requirementProjection.requiresRestDelivery,
                    existingAdjustment: !!(story.existingAdjustment && Array.isArray(story.existingAdjustment.entryFiles) && story.existingAdjustment.entryFiles.length > 0)
                }
            };
        });
        const evidenceRefs = this._writeEvidenceChunks(storyFacts, stage);
        const card = {
            schemaVersion: 'design-decision-card/v3',
            stepId,
            phase: 'structure_confirmed',
            purpose: '先从Story验收和不变量识别业务对象、生命周期、长期保存与关系事实，再判断全局新建/复用表和每个Story承载及maintain/query/action/job/configure能力；Story不等于表、模块或页面，table_key_or_dash只表示主要业务承载，不表示必须新建表；未知事实不猜，不新增必填项。页面布局必须等字段闭合后再判断。',
            responseMode: 'tool_call_only',
            rowContracts: {
                table: `${DECISION_ROW_HELP.TABLE_NEW}，或${DECISION_ROW_HELP.TABLE_REUSE}`,
                relation: DECISION_ROW_HELP.RELATION,
                story: DECISION_ROW_HELP.STORY,
                statisticsSource: DECISION_ROW_HELP.STATISTICS_SOURCE
            },
            confirmedTableCandidatePolicy: {
                rule: 'confirmedTableCandidates 是扫描得到的候选表，不等于最终复用结论或本次业务的Carrier；Design结合对象生命周期、字段和关系评估新建/复用，仍遵守用户明确固定使用的表。只有真正承载本次新增/维护/查询模块的业务对象才写TABLE；candidateRole=weak_related_candidate、triggered_side_effect_candidate或没有owner Story的候选，默认按只读来源处理，不能写TABLE或TABLE_STORY。',
                sourceOnlyShape: DECISION_ROW_HELP.STATISTICS_SOURCE,
                sourceOnlyRepair: '统计Story需要读取已确认候选表时，只提交STATISTICS_SOURCE行；不要为来源表创建Carrier。纯接口或无表来源可以不提交STATISTICS_SOURCE。',
                candidateFacts: this._compactTableCandidateFacts(context.confirmedTableCandidateFacts || context.confirmedTableCandidates)
            },
            tableKeyPolicy: 'logicalTableKey是稳定的逻辑业务slug，只描述业务对象；禁止包含xm_、gxh_、项目缩写或数据库物理前缀。例如place、place_version、window_version、sync_batch。物理表名由Builder根据databaseNamingContract统一生成。',
            deferredDecisionPolicy: '本阶段禁止填写COMPOSE或猜页面布局；字段、代码项、附件和关系闭合后，Builder会返回独立页面设计卡给LLM动态判断。',
            capabilityMeanings: {
                maintain: '通用新增、编辑、删除或状态维护；有表单填写、有新增记录、有状态流转、有续期或复制的业务选这个。',
                query: '主结果是独立浏览、检索或查看。',
                action: '依附业务上下文的一次性命令，如发布、同步或导出；没有表单填写、没有新增记录、只触发一个动作选这个。',
                job: '没有人工触发的后台任务。',
                configure: '整条Story已确认由现有平台配置满足，只填-，不声明表、字段、REST、工作流或页面；配置和验收要求仍须交付。'
            },
            capabilityDecisionGuide: '先按业务结果判断maintain/query/action/job/configure，不能仅凭有无表单分类；有表单通常选maintain，批量发布、导入、重算仍按实际业务结果判断。工作流Story有申请表单时选maintain。只有已确认整条Story通过现有平台配置满足才选configure；存在定制业务实现仍选原能力，不能凭权限、菜单或代码项关键词免除开发。',
            workflowCarrierPolicy: {
                rule: '先判断工作流是否只是主业务记录的生命周期。提交、审核、退回、办结或办理查询通常挂靠主业务 entity，不因多个 Story 共用主表而新建流程表。',
                carriedConsumer: '在 STORY 行填写主业务 tableKey；多个 Story 可以绑定同一张新建或确认复用的表，Builder 自动生成内部承载关系，不填写额外内部字段。',
                independentProcess: '只有需求存在需要独立保存的流程业务对象时，才用 TABLE 声明该对象并通过 STORY 绑定，不为满足生成器而新建流程表。'
            },
            querySurfacePolicy: {
                rule: '独立查询页面必须有真实数据载体；STORY 的 tableKey=- 只允许没有独立页面的内部查询。',
                validSubmissions: [
                    'STORY|<storyId>|query|<logicalTableKey> + TABLE|<logicalTableKey>|new|<displayName>',
                    'STORY|<storyId>|query|<logicalTableKey> + TABLE|<logicalTableKey>|reuse|<confirmedCandidate>|<displayName>',
                    'STORY|<storyId>|query|-（不提交 QUERY_SURFACE）'
                ],
                invalidSubmission: 'STORY|<storyId>|query|- + QUERY_SURFACE|<storyId>|independent|<pageKey>',
                repairInstruction: '若提交独立查询，请先绑定已声明TABLE；若只是无页面内部查询，请删除对应QUERY_SURFACE行。已有入口只有在Requirement提供entryFiles证据时才可不绑定TABLE。'
            },
            executionPolicy: '按storyEvidenceRefs读取Story证据；ruleRefs只作已确认规则导航，现有能力判断所需正文按Design Skill定向读取，不全读API或再次召回。同一阶段不重复无目的读取，发现对象、Story或关系矛盾时只定向重读相关证据，业务分析在内存完成后直接提交工具调用，不输出草稿或提交前复述。',
            forbiddenActions: ['read_tool_descriptor', 'read_stories_json_directly', 'read_rule_pool_json_directly', 'narrate_design_reasoning', 'print_rows_before_tool_call'],
            statisticsSourcePolicy: {
                meaning: '统计来源表只读，不拥有本次业务模块代码；来源表与Carrier是两个不同概念。',
                valid: 'STATISTICS_SOURCE|<statisticsStoryId>|<confirmedCandidateTableName>|primary/secondary',
                invalid: 'TABLE|<sourceTable>|reuse|... + TABLE_STORY|<sourceTable>|<storyId>',
                repair: '删除来源表的TABLE/TABLE_STORY行；保留统计Story的STORY|<storyId>|query|-；如需明确来源，补STATISTICS_SOURCE行。'
            },
            builderProjection: ['表名、主键、公共字段和关系外键', 'Story归属与页面角色', '统计来源依赖（只读）', 'Entity、Service、页面、REST、Job和Workflow骨架'],
            confirmedTableCandidates: context.confirmedTableCandidates,
            storyEvidenceRefs: evidenceRefs,
            ...(recoveryStoryIds.size > 0 ? {
                recoveryMode: 'story_dependency_invalidation',
                requiredStoryIds: Array.from(recoveryStoryIds),
                requiredRowKeys: Array.isArray(recovery && recovery.requiredRowKeys)
                    ? recovery.requiredRowKeys
                    : [],
                retainedAcceptedRowCount: Number(recovery && recovery.retainedAcceptedRowCount || 0),
                recoveryPolicy: '只提交requiredRowKeys对应的新业务判断；未列出的已确认行由Builder保留并机械合并，禁止重填。'
            } : {}),
            submit: { tool: 'design_prepare_context', phase: 'structure_confirmed', stepId, argument: 'decisionRows' }
        };
        return { card, cardRef: stage('card', card), contents };
    }

    _buildDetailCard(resolved, context, model, batch, stepId) {
        const contents = new Map();
        const stage = (kind, value) => {
            const ref = this._contentPath(resolved, kind, value, 'detail');
            contents.set(ref, value);
            return ref;
        };
        const graphStoryIds = this._relatedStoryIdsForBatch(model, batch.tableKeys || []);
        const relevantStoryIds = new Set([
            ...(batch.restStoryIds || []),
            ...graphStoryIds,
            ...(model.storyRoutes || []).filter(route => batch.tableKeys.includes(route.primaryObjectKey)).map(route => route.storyId),
            ...(model.carriers || []).filter(carrier => batch.tableKeys.includes(carrier.objectKey)).map(carrier => carrier.ownerStoryId).filter(Boolean)
        ]);
        const workflowStoryIds = new Set(batch.workflowStoryIds || []);
        const workflowOperationCandidates = this._workflowOperationCandidates(
            context.requirementStories,
            workflowStoryIds
        );
        const codingFactCandidateRows = this._stories(context.requirementStories)
            .filter(story => relevantStoryIds.has(this._storyId(story)))
            .flatMap(story => (Array.isArray(story && story.codingFactHandoff) ? story.codingFactHandoff : [])
                .filter(fact => CODE_ITEM_FACT_TYPES.includes(String(fact && fact.factType || '').trim().toLowerCase()))
                .map(fact => {
                    const factId = String(fact && fact.factId || '').trim();
                    if (!factId) return '';
                    const cells = [
                        factId,
                        this._storyId(story),
                        String(fact && fact.factType || '').trim(),
                        String(fact && fact.description || '').trim()
                    ].map(value => value.replace(/\|/gu, '／').replace(/[\r\n]+/gu, ' '));
                    return cells.join('|');
                })
                .filter(Boolean));
        const card = {
            schemaVersion: 'design-detail-card/v4',
            stepId,
            phase: 'details_confirmed',
            batchId: batch.batchId,
            responseMode: 'tool_call_only',
            tableKeys: batch.tableKeys,
            restStoryIds: batch.restStoryIds,
            tables: (model.dataObjects || [])
                .filter(item => batch.tableKeys.includes(item.objectKey))
                .map(item => {
                    const carrier = (model.carriers || []).find(candidate => candidate.objectKey === item.objectKey) || {};
                    return {
                        tableKey: item.objectKey,
                        displayName: item.displayName,
                        mode: carrier.mode,
                        ...(carrier.tableName ? { confirmedTableName: carrier.tableName } : {})
                    };
                }),
            relations: (model.objectRelations || [])
                .filter(item => batch.tableKeys.includes(item.parentObjectKey) || batch.tableKeys.includes(item.childObjectKey))
                .map(item => ({
                    parentTableKey: item.parentObjectKey,
                    childTableKey: item.childObjectKey,
                    relationKind: item.relationKind,
                    meaning: item.meaning
                })),
            relatedStoryIds: Array.from(relevantStoryIds),
            storyEvidencePolicy: '结构卡已披露共享Story证据；字段卡只机械重复当前批次可引用的codingFactCandidateRows，不要求无目的重读Story。发现对象、生命周期、字段或关系矛盾时，可先无phase调用prepare并只定向读取recoveryEvidenceRefs；禁止重读stories.json、rule-pool.json原文或全量反复读取无关共享Story证据。',
            evidencePolicy: '候选与关系可能使用对应的Ref替代内嵌数组，二者互斥；有Ref时须完整读取并沿nextRef至末尾。引用分片不改变本卡tableKeys/restStoryIds及工作流Story提交范围，不重复无目的读取已读证据。',
            rowContracts: {
                field: DETAIL_ROW_HELP.FIELD,
                codeItem: DETAIL_ROW_HELP.CODE_ITEM,
                attachment: DETAIL_ROW_HELP.ATTACHMENT,
                rest: DETAIL_ROW_HELP.REST,
                ...(workflowOperationCandidates.length > 0 ? { workflowEvent: DETAIL_ROW_HELP.WORKFLOW_EVENT } : {})
            },
            ...(workflowOperationCandidates.length > 0 ? {
                workflowOperationCandidates,
                workflowEventPolicy: '每个候选工作流操作必须恰好提交一条WORKFLOW_EVENT；没有操作后业务填none，有操作后业务填service_method，并明确方法名、业务效果和参数。不要填写XML、GUID、类名或Java路径。'
            } : {}),
            codingFactCandidateRowContract: 'factId|storyId|factType|description',
            codingFactCandidateRows,
            codingFactCandidatePolicy: '每行首段factId是当前批次CODE_ITEM reuse可引用的稳定sourceRef候选；LLM只在factType/description确实表示代码项事实时选择。数组为空时禁止reuse，必须按已确认事实选择new或不写CODE_ITEM，禁止编造factId。',
            codeItemPolicy: 'CODE_ITEM只用于Requirement已确认的静态代码项字段；new填ASCII稳定codeValue=显示名列表，reuse的sourceRef只能复制codingFactCandidateRows首段factId。布尔控件和普通文本字段不强行转代码项。',
            dynamicOptionPolicy: '动态联动、远程搜索或运行时加载的选项不是静态代码值：保留FIELD，并且不写CODE_ITEM；只有Requirement明确确认静态值列表或可复用代码项事实时才写CODE_ITEM。',
            restOperationKeyPolicy: `REST operationKey必须是小写snake_case，匹配${OBJECT_KEY_PATTERN.source}；例如place_detail，禁止placeDetail。`,
            fieldDecisionOwner: 'LLM一次性决定业务字段拆分与type/length/required；Builder只补表名、表注释、主键、公共字段和关系外键，不重新选择业务存储形态。',
            beforeSubmitChecklist: [
                'tables 中每个 mode=new 的对象至少提交一个 FIELD 或 ATTACHMENT 行；复用对象不需要新建字段',
                'restStoryIds 中每个 Story 必须提交其 REST 操作',
                '完整工作流候选中每个操作必须有恰好一条 WORKFLOW_EVENT 行；存在引用时先沿 nextRef 读齐'
            ],
            executionPolicy: '在内存形成最终detailRows后直接提交工具调用；禁止在对话中输出字段清单、候选存储方案、自我讨论或提交前复述。提交前逐条核对 beforeSubmitChecklist。',
            forbiddenActions: ['read_tool_descriptor', 'reread_story_evidence_without_recovery', 'read_stories_json_directly', 'read_rule_pool_json_directly', 'invent_coding_fact_id', 'narrate_design_reasoning', 'print_rows_before_tool_call'],
            mechanicalFields: ['表名', '表注释', '主键', '公共字段', '关系外键', 'Entity/模块/页面/REST命名'],
            submit: { tool: 'design_prepare_context', phase: 'details_confirmed', stepId, argument: 'detailRows' }
        };
        for (const key of ['codingFactCandidateRows', 'workflowOperationCandidates', 'relatedStoryIds', 'relations']) {
            if (this._measureContextBudget(card).withinTarget) break;
            if (!Array.isArray(card[key]) || card[key].length === 0) continue;
            card[`${key}Ref`] = this._evidenceChain(key, card[key], stage,
                'design-detail-evidence/v1');
            delete card[key];
        }
        return { stepId, cardRef: stage('card', card), contents, budget: this._measureContextBudget(card) };
    }

    _writeDetailCard(bundle) {
        for (const [ref, value] of bundle.contents) this._writeContent(ref, value);
        return bundle.cardRef;
    }

    _writePageDesignCard(resolved, model, stepId, storyEvidenceRefs = [], targetStoryIds = [], replaceAffectedRows = false) {
        // Construct and measure the complete bundle before publishing any file.
        const pending = new Map();
        const stage = (kind, value) => {
            const ref = this._contentPath(resolved, kind, value);
            pending.set(ref, value);
            return ref;
        };
        const fields = Array.isArray(model && model.objectFields) ? model.objectFields : [];
        const objectProfiles = (Array.isArray(model && model.dataObjects) ? model.dataObjects : []).map(object => {
            const objectKey = String(object && object.objectKey || '').trim();
            const objectFields = fields.filter(field => String(field && field.objectKey || '').trim() === objectKey);
            return {
                objectKey,
                displayName: String(object && object.displayName || '').trim(),
                fieldCount: objectFields.length,
                requiredFieldCount: objectFields.filter(field => field.required === true).length,
                codeItemFieldCount: objectFields.filter(field => String(field && field.codeItem || '').trim()).length,
                attachmentFieldCount: objectFields.filter(field => field.attachmentKey === true).length,
                fields: objectFields.map(field => [
                    field.name,
                    field.type,
                    field.required === true ? 'required' : 'optional',
                    String(field.comment || '').trim()
                ].join(':'))
            };
        });
        const targetStorySet = new Set(Array.isArray(targetStoryIds) ? targetStoryIds.filter(Boolean) : []);
        const pageCandidates = (Array.isArray(model && model.storyRoutes) ? model.storyRoutes : [])
            .filter(route => DesignModelCompiler.isManagedPageRoute(route))
            .filter(route => targetStorySet.size === 0 || targetStorySet.has(String(route && route.storyId || '').trim()))
            .map(route => ({
                storyId: String(route.storyId || '').trim(),
                capability: String(route.capability || '').trim(),
                primaryObjectKey: String(route.primaryObjectKey || '').trim(),
                surface: String(route.surface || '').trim(),
                businessMechanisms: Array.isArray(route.businessMechanisms) ? route.businessMechanisms.slice() : []
            }));
        const card = {
            schemaVersion: 'design-page-card/v1',
            stepId,
            phase: 'page_design_confirmed',
            responseMode: 'tool_call_only',
            decisionOwner: 'LLM',
            pageCandidates,
            objectProfileRefs: this._writePageObjectProfileEvidence(resolved, objectProfiles, stage),
            evidencePolicy: '字段画像、候选和关系分片均须完整读取，沿nextRef读至末尾；Story证据清单仅在恢复或矛盾时定向使用。分片不改变本次提交范围。',
            relations: (Array.isArray(model && model.objectRelations) ? model.objectRelations : []).map(relation =>
                `${relation.relationKey}|${relation.parentObjectKey}->${relation.childObjectKey}|${relation.relationKind}|${relation.meaning}`
            ),
            rowContracts: {
                composition: COMPOSITION_ROW_HELP.COMPOSE,
                section: COMPOSITION_ROW_HELP.SECTION,
                pageBinding: COMPOSITION_ROW_HELP.PAGE_BIND,
                queryFilter: COMPOSITION_ROW_HELP.QUERY_FILTER
            },
            queryFilterPolicy: '筛选必须引用画像真实字段；关联字段必须使用已声明关系路径，交由Coder实现关联查询。',
            pageBindingGuidance: {
                requiredWhen: '某个maintain Story的对象被其它Story的COMPOSE作为child_edit承载时，必须为该Story至少提交一行PAGE_BIND。',
                shared: '共享到以child_edit承载源Story对象的目标COMPOSE，并取消自己的独立页面；同一Story可用多行shared明确绑定多个页面。',
                independent: '保留该Story自己的独立页面；与shared同时提交表示既进入目标页面又保留独立入口。',
                ownership: '页面归属由Design LLM结合导航、权限、交互和验收事实决定；Builder只验证Story、COMPOSE与对象关系。'
            },
            beforeSubmitChecklist: [
                'PAGE_BIND 只用于 pageCandidates 中 capability=maintain 的 Story；query/action/job/configure 不写 PAGE_BIND',
                '不在 pageCandidates 里的 Story 不写任何 compositionRows',
                '布局、页面归属和筛选分别判断；无COMPOSE仍须提交适用的PAGE_BIND/QUERY_FILTER，所有行类型均无设计义务时才提交空数组 []',
                'compositionRows 必须是扁平字符串数组，不要传对象、null 或嵌套数组'
            ],
            storyEvidenceIndexRef: this._evidenceChain('storyEvidenceRefs', storyEvidenceRefs, stage),
            ...(targetStorySet.size > 0 ? {
                recoveryMode: replaceAffectedRows ? 'explicit_revision' : 'story_dependency_invalidation',
                targetStoryIds: Array.from(targetStorySet),
                retainedCompositionPolicy: replaceAffectedRows
                    ? '提交targetStoryIds的完整COMPOSE/SECTION/PAGE_BIND/QUERY_FILTER；该范围旧行被替换，未提交的旧分区或绑定移除；其它Story保留。'
                    : '只提交targetStoryIds关联的新COMPOSE/SECTION/PAGE_BIND/QUERY_FILTER；其它Story页面设计由Builder保留并机械合并。'
            } : {}),
            submit: { tool: 'design_prepare_context', phase: 'page_design_confirmed', stepId, argument: 'compositionRows' }
        };
        for (const key of ['relations', 'pageCandidates', 'targetStoryIds']) {
            if (this._measureContextBudget(card).withinTarget) break;
            if (!Array.isArray(card[key]) || card[key].length === 0) continue;
            card[`${key}Ref`] = this._evidenceChain(key, card[key], stage);
            delete card[key];
        }
        const cardRef = stage('card', card);
        for (const [ref, value] of pending) this._writeContent(ref, value);
        return cardRef;
    }

    _measureContextBudget(value) {
        const bytes = this._jsonByteLength(value);
        return { bytes, withinTarget: bytes <= this.maxCardBytes };
    }

    _contentPath(resolved, kind, value, prefix = 'page') {
        return path.join(resolved.runtimeDir, `${prefix}-${kind}-${this._sha256(JSON.stringify(value)).slice(0, 24)}.json`);
    }

    _writeContent(ref, value) {
        // Content-addressed files are immutable; the workflow-state pointer is the commit.
        if (JSON.stringify(this._readJson(ref)) !== JSON.stringify(value)) this._writeJsonAtomic(ref, value);
        return ref;
    }

    _evidenceChain(key, items, stage, schemaVersion = 'design-page-evidence/v1') {
        let nextRef;
        let chunk = [];
        const envelope = values => ({ schemaVersion, [key]: values, ...(nextRef ? { nextRef } : {}) });
        const flush = () => {
            if (!chunk.length) return;
            nextRef = stage(key, envelope(chunk));
            chunk = [];
        };
        for (const item of (Array.isArray(items) ? items : []).slice().reverse()) {
            if (chunk.length && !this._measureContextBudget(envelope([item, ...chunk])).withinTarget) flush();
            chunk.unshift(item);
        }
        flush();
        return nextRef;
    }

    _writePageObjectProfileEvidence(resolved, objectProfiles = [], stage) {
        const segments = [];
        (Array.isArray(objectProfiles) ? objectProfiles : []).forEach(profile => {
            const fields = Array.isArray(profile && profile.fields) ? profile.fields : [];
            const base = {
                objectKey: String(profile && profile.objectKey || '').trim(),
                displayName: String(profile && profile.displayName || '').trim(),
                fieldCount: Number(profile && profile.fieldCount || fields.length),
                requiredFieldCount: Number(profile && profile.requiredFieldCount || 0),
                codeItemFieldCount: Number(profile && profile.codeItemFieldCount || 0),
                attachmentFieldCount: Number(profile && profile.attachmentFieldCount || 0)
            };
            if (fields.length === 0) {
                segments.push({ ...base, fieldOffset: 0, fields: [] });
                return;
            }
            let fieldOffset = 0;
            let chunk = [];
            const flush = () => {
                if (chunk.length === 0) return;
                segments.push({ ...base, fieldOffset, fields: chunk });
                fieldOffset += chunk.length;
                chunk = [];
            };
            fields.forEach(field => {
                const candidate = chunk.concat(field);
                const evidence = {
                    schemaVersion: 'design-page-object-profiles/v1',
                    objectProfiles: [{ ...base, fieldOffset, fields: candidate }]
                };
                // Reserve the exact serialized space of a possible nextRef in the chain.
                evidence.nextRef = this._contentPath(resolved, 'objectProfiles', {});
                if (chunk.length > 0 && !this._measureContextBudget(evidence).withinTarget) flush();
                chunk.push(field);
            });
            flush();
        });

        const ref = this._evidenceChain('objectProfiles', segments, stage);
        return ref ? [ref] : [];
    }

    _jsonByteLength(value) {
        return Buffer.byteLength(this._serializeJson(value), 'utf8');
    }

    _serializeJson(value, compact = false) {
        return JSON.stringify(value, null, compact ? 0 : 2);
    }

    _relatedStoryIdsForBatch(model = {}, tableKeys = []) {
        const connected = new Set(Array.isArray(tableKeys) ? tableKeys : []);
        const relations = Array.isArray(model.objectRelations) ? model.objectRelations : [];
        let changed = true;
        while (changed) {
            changed = false;
            relations.forEach(relation => {
                const parent = String(relation.parentObjectKey || '').trim();
                const child = String(relation.childObjectKey || '').trim();
                if (connected.has(parent) && child && !connected.has(child)) {
                    connected.add(child);
                    changed = true;
                }
                if (connected.has(child) && parent && !connected.has(parent)) {
                    connected.add(parent);
                    changed = true;
                }
            });
        }
        return Array.from(new Set((Array.isArray(model.storyRoutes) ? model.storyRoutes : [])
            .filter(route => connected.has(route.primaryObjectKey))
            .map(route => route.storyId)
            .filter(Boolean)));
    }

    _workflowOperationCandidates(requirementStories = null, storyIds = new Set()) {
        const allowedStoryIds = storyIds instanceof Set
            ? storyIds
            : new Set(Array.isArray(storyIds) ? storyIds : []);
        const candidates = [];
        this._stories(requirementStories).forEach(story => {
            const storyId = this._storyId(story);
            if (!storyId || !allowedStoryIds.has(storyId)) return;
            const intent = story && story.workflowIntent;
            const activities = intent && Array.isArray(intent.activities) ? intent.activities : [];
            activities.forEach((activity, activityIndex) => {
                const activityName = String(activity && activity.name || '').trim();
                const actor = String(activity && activity.actor || '').trim();
                const activityKey = String(activity && activity.key || '').trim()
                    || `activity_${this._sha256(`${storyId}|${activityName}|${actor}|${activityIndex}`).slice(0, 10)}`;
                const operations = activity && Array.isArray(activity.operations) ? activity.operations : [];
                operations.forEach((rawOperation, operationIndex) => {
                    const operation = rawOperation && typeof rawOperation === 'object' && !Array.isArray(rawOperation)
                        ? rawOperation
                        : { name: String(rawOperation || '').trim() };
                    const operationName = String(operation.name || operation.label || '').trim();
                    if (!operationName) return;
                    const semantic = String(operation.semantic || operation.type || operation.actionType || '').trim().toLowerCase();
                    const operationKey = String(operation.key || operation.operationKey || '').trim()
                        || `operation_${this._sha256(`${storyId}|${activityKey}|${operationName}|${semantic}|${operationIndex}`).slice(0, 10)}`;
                    candidates.push({
                        storyId,
                        operationKey,
                        activityName,
                        actor,
                        operationName,
                        semantic,
                        businessResults: Array.isArray(intent.businessResults)
                            ? intent.businessResults.map(value => String(value || '').trim()).filter(Boolean)
                            : []
                    });
                });
            });
        });
        return candidates;
    }

    _writeEvidenceChunks(stories, stage) {
        const refs = [];
        let chunk = [];
        const flush = () => {
            if (chunk.length === 0) return;
            refs.push(stage('story-evidence', { schemaVersion: 'design-story-evidence/v1', stories: chunk }));
            chunk = [];
        };
        stories.forEach(story => {
            const candidate = chunk.concat(story);
            if (chunk.length > 0 && !this._measureContextBudget({ schemaVersion: 'design-story-evidence/v1', stories: candidate }).withinTarget) flush();
            chunk.push(story);
        });
        flush();
        return refs;
    }

    _validateDetailBatchScope(rows, batch) {
        const allowedObjects = new Set(batch.tableKeys || []);
        const allowedStories = new Set(batch.restStoryIds || []);
        const allowedWorkflowStories = new Set((batch.workflowStoryIds || []).map(storyId => String(storyId || '').trim().toUpperCase()));
        const issues = [];
        (Array.isArray(rows) ? rows : []).forEach((row, index) => {
            const parts = String(row || '').split('|').map(value => value.trim());
            const kind = String(parts[0] || '').toUpperCase();
            const ref = parts[1] || '';
            const outsideScope = kind === 'REST'
                ? !allowedStories.has(ref.toUpperCase())
                : kind === 'WORKFLOW_EVENT'
                    ? !allowedWorkflowStories.has(ref.toUpperCase())
                    : !allowedObjects.has(ref);
            if (outsideScope) {
                issues.push({
                    code: 'DESIGN_DETAIL_ROW_OUTSIDE_CURRENT_BATCH',
                    field: `detailRows[${index}]`,
                    message: `${kind || 'UNKNOWN'}行引用${ref || '(empty)'}，不属于当前batch=${batch.batchId}。`
                });
            }
        });
        return issues.length > 0
            ? { ok: false, errorCode: 'DESIGN_DETAIL_BATCH_SCOPE_INVALID', issues }
            : { ok: true };
    }

    _resumeResult(resolved, state, extra = {}) {
        if (state.currentPhase === 'details_confirmed') {
            const card = this._readJson(state.currentCardRef);
            if (card && card.phase === state.currentPhase && card.batchId === state.pendingBatchId
                && (card.stepId !== state.currentStepId || card.submit?.stepId !== state.currentStepId)) {
                // Repair the published card identity without changing accepted answers or business evidence.
                const corrected = { ...card, stepId: state.currentStepId,
                    submit: { ...card.submit, stepId: state.currentStepId } };
                try {
                    const ref = this._contentPath(resolved, 'card', corrected, 'detail');
                    this._writeContent(ref, corrected);
                    state = { ...state, currentCardRef: ref };
                    this._writeJsonAtomic(resolved.workflowStatePath, state);
                } catch (error) {
                    return this._stateWriteBlocked(error, resolved);
                }
            }
        }
        const includeRecoveryEvidence = extra.includeRecoveryEvidence === true;
        const publicExtra = { ...extra };
        delete publicExtra.includeRecoveryEvidence;
        const batchPlan = state.pendingBatchRef ? this._readJson(state.pendingBatchRef) : null;
        const pendingBatch = batchPlan && Array.isArray(batchPlan.batches)
            ? batchPlan.batches.find(item => item.batchId === state.pendingBatchId)
            : undefined;
        const payloadPlaceholder = state.currentPhase === 'structure_confirmed'
            ? { decisionRows: ['<按currentCardRef填写>'] }
            : (state.currentPhase === 'page_design_confirmed'
                ? { compositionRows: ['<按currentCardRef填写；所有行类型均无设计义务时才提交空数组>'] }
                : { detailRows: ['<按currentCardRef填写>'] });
        return {
            ok: true,
            status: 'ready',
            resumed: true,
            workflowVersion: WORKFLOW_VERSION,
            currentPhase: state.currentPhase,
            ...(state.revision ? { revisionFeedback: state.revision.feedback,
                affectedStoryIds: state.revision.storyIds, revisionPhase: state.revision.phase,
                acceptedAnswerRef: this._writeContent(this._contentPath(resolved, 'revision-answers', state.acceptedRows), {
                    rows: (state.acceptedRows || []).filter(item => item.phase === state.currentPhase
                        && (item.dependencyRefs || []).some(ref => state.revision.storyIds.includes(ref.replace(/^STORY:/, ''))))
                        .map(item => item.row),
                    submissionMode: state.revision.phase === 'page_design_confirmed'
                        ? 'replace_affected_page_rows' : 'patch_by_stable_row_key'
                }) } : {}),
            currentStepId: state.currentStepId,
            currentCardRef: state.currentCardRef,
            pendingBatch,
            nextCall: {
                tool: 'design_prepare_context',
                arguments: {
                    projectPath: resolved.projectPath,
                    skillName: 'epoint-requirement-design',
                    phase: state.currentPhase,
                    stepId: state.currentStepId,
                    ...payloadPlaceholder
                }
            },
            allowedNextActions: ['read_current_card_ref', 'read_only_card_managed_evidence_refs', 'submit_current_design_step'],
            forbiddenActions: [
                'read_tool_descriptor',
                'read_stories_or_rule_pool_directly',
                'narrate_design_reasoning',
                'print_rows_before_tool_call',
                'reanswer_completed_step',
                'write_design_runtime_directly',
                'create_nested_ai_workspace'
            ],
            ...(includeRecoveryEvidence && Array.isArray(state.sharedStoryEvidenceRefs) && state.sharedStoryEvidenceRefs.length > 0
                ? { recoveryEvidenceRefs: state.sharedStoryEvidenceRefs }
                : {}),
            ...publicExtra
        };
    }

    _recoverAfterInputChange(resolved, context, state) {
        const changedRefs = this._changedSourceRefs(state.sourceRefHashes, context.sourceRefHashes);
        if (changedRefs.length === 0) {
            const refreshed = {
                ...state,
                inputVersionRefs: context.inputVersionRefs,
                inputVersionHash: context.inputVersionHash,
                sourceStoryHashes: context.sourceStoryHashes,
                sourceRefHashes: context.sourceRefHashes
            };
            try {
                this._writeJsonAtomic(resolved.workflowStatePath, refreshed);
                if (refreshed.currentPhase === 'completed') return this._completedResult(resolved)
                    || this._prepareRequired('设计完成凭证无效，请恢复当前设计卡。');
                return this._resumeResult(resolved, refreshed, { upstreamReceiptRefreshed: true });
            } catch (error) {
                return this._stateWriteBlocked(error, resolved);
            }
        }
        const invalidation = this._invalidateAcceptedRows(state.acceptedRows, changedRefs);
        const affectedStoryIds = Array.from(new Set([
            ...changedRefs.filter(ref => ref.startsWith('STORY:')).map(ref => ref.slice('STORY:'.length)),
            ...invalidation.invalidated.flatMap(row => (row.dependencyRefs || [])
                .filter(ref => ref.startsWith('STORY:'))
                .map(ref => ref.slice('STORY:'.length)))
        ])).sort();
        const affectedObjectKeys = Array.from(new Set(invalidation.invalidated
            .flatMap(row => this._rowObjectKeys(row.row))
            .filter(Boolean))).sort();
        const retainedState = {
            ...state,
            acceptedRows: invalidation.retained,
            recoveryMode: 'story_dependency_invalidation',
            recoveryAffectedStoryIds: affectedStoryIds,
            recoveryDetailObjectKeys: affectedObjectKeys,
            recoveryPageStoryIds: affectedStoryIds,
            invalidatedRowKeys: invalidation.invalidated.map(row => row.rowKey),
            lastAcceptedStepId: '',
            lastAcceptedPayloadHash: ''
        };
        const retainedStructureRows = this._acceptedRawRows(retainedState, 'structure_confirmed');
        if (retainedStructureRows.length === 0) {
            // 没有任何已确认的结构答案时不存在可恢复的模型；空数组不能
            // 进入 _resumeRetainedModel，否则会把“需要重新设计”误报成投影缺陷。
            this._clearUnfinishedRuntime(resolved);
            return this._beginStructureStep(resolved, context, {
                upstreamChanged: true,
                invalidatedRowCount: invalidation.invalidated.length,
                retainedAcceptedRowCount: 0
            });
        }
        const invalidatedStructureRows = invalidation.invalidated
            .filter(row => row.phase === 'structure_confirmed');
        if (invalidatedStructureRows.length > 0) {
            return this._beginStructureStep(resolved, context, {
                upstreamChanged: true,
                invalidatedRowCount: invalidation.invalidated.length,
                retainedAcceptedRowCount: invalidation.retained.length,
                recovery: {
                    storyIds: affectedStoryIds,
                    requiredRowKeys: invalidatedStructureRows.map(row => row.rowKey),
                    retainedAcceptedRowCount: invalidation.retained.length
                }
            }, retainedState);
        }
        return this._resumeRetainedModel(resolved, context, retainedState, invalidation);
    }

    _resumeRetainedModel(resolved, context, state, invalidation) {
        const decisionRows = this._acceptedRawRows(state, 'structure_confirmed');
        const compiled = this.compiler.compileModel({
            decisionRows,
            requirementStories: context.requirementStories,
            confirmedTableCandidates: context.confirmedTableCandidateFacts || context.confirmedTableCandidates
        });
        if (!compiled.ok) {
            return this._projectionDefect(
                compiled,
                state,
                resolved,
                'DESIGN_WORKFLOW_RETAINED_ROWS_PROJECTION_DEFECT'
            );
        }
        const detailRows = this._acceptedRawRows(state, 'details_confirmed');
        const detailed = this.compiler.applyDetails({
            canonicalModel: compiled.canonicalModel,
            detailRows,
            requirementStories: context.requirementStories,
            final: false
        });
        if (!detailed.ok) {
            return this._projectionDefect(
                detailed,
                state,
                resolved,
                'DESIGN_WORKFLOW_RETAINED_ROWS_PROJECTION_DEFECT'
            );
        }
        try {
            const batchPlan = this._filterRecoveryBatchPlan(
                this._buildBatchPlan(resolved, context, compiled.canonicalModel), compiled.canonicalModel, state
            );
            const cards = batchPlan.batches.map(batch => this._buildDetailCard(
                resolved, context, detailed.canonicalModel, batch, this._stepId(batch.batchId, context.inputVersionHash)
            ));
            this._writeJsonAtomic(resolved.canonicalModelPath, detailed.canonicalModel);
            const batchPlanPath = path.join(resolved.runtimeDir, 'detail-batches.json');
            this._writeJsonAtomic(batchPlanPath, batchPlan);
            if (batchPlan.batches.length > 0) {
                const next = this._detailState(resolved, context, state, batchPlan, 0, '', '', cards[0].stepId);
                next.currentCardRef = this._writeDetailCard(cards[0]);
                this._writeJsonAtomic(resolved.workflowStatePath, next);
                return this._resumeResult(resolved, next, {
                    upstreamChanged: true,
                    invalidatedRowCount: invalidation.invalidated.length,
                    retainedAcceptedRowCount: invalidation.retained.length
                });
            }
            const finalDetails = this.compiler.applyDetails({
                canonicalModel: compiled.canonicalModel,
                detailRows,
                requirementStories: context.requirementStories,
                final: true
            });
            if (!finalDetails.ok) return this._stepRepair(finalDetails, state, resolved);
            return this._beginPageDesignStep(finalDetails.canonicalModel, resolved, context, state, '', '');
        } catch (error) {
            return this._stateWriteBlocked(error, resolved);
        }
    }

    _changedSourceRefs(previous = {}, current = {}) {
        const keys = new Set([...Object.keys(previous || {}), ...Object.keys(current || {})]);
        return Array.from(keys).filter(key => previous[key] !== current[key]).sort();
    }

    _invalidateAcceptedRows(rows = [], changedRefs = []) {
        const retained = Array.isArray(rows) ? rows.slice() : [];
        const invalidated = [];
        const activeRefs = new Set(changedRefs);
        let changed = true;
        while (changed) {
            changed = false;
            for (let index = retained.length - 1; index >= 0; index -= 1) {
                const row = retained[index];
                if (!(row.dependencyRefs || []).some(ref => activeRefs.has(ref))) continue;
                retained.splice(index, 1);
                invalidated.push(row);
                this._rowOutputRefs(row.row).forEach(ref => activeRefs.add(ref));
                changed = true;
            }
        }
        return { retained, invalidated: invalidated.reverse(), changedRefs: Array.from(activeRefs) };
    }

    _mergedRows(state, phase, submittedRows = []) {
        const incoming = Array.isArray(submittedRows) ? submittedRows.slice() : [];
        const incomingKeys = new Set(incoming.map(row => this._rowKey(row)).filter(Boolean));
        const replacePageScope = phase === 'page_design_confirmed'
            && state?.recoveryMode === 'explicit_revision' && state.revision?.phase === phase;
        const affectedIds = new Set(state?.recoveryPageStoryIds || []);
        const retained = this._acceptedRawRows(state, phase)
            .filter(row => !replacePageScope || !affectedIds.has(String(row).split('|')[1]?.toUpperCase()))
            .filter(row => !incomingKeys.has(this._rowKey(row)));
        return retained.concat(incoming);
    }

    _validateRecoveryRetainedRowScope(state, submittedRows = []) {
        if (!state || !['story_dependency_invalidation', 'explicit_revision'].includes(state.recoveryMode)) return { ok: true };
        const retainedKeys = new Set((Array.isArray(state.acceptedRows) ? state.acceptedRows : [])
            .filter(item => item && item.phase === 'structure_confirmed')
            .filter(item => state.recoveryMode !== 'explicit_revision'
                || !(item.dependencyRefs || []).some(ref => (state.recoveryAffectedStoryIds || []).includes(ref.replace(/^STORY:/, ''))))
            .map(item => item.rowKey));
        const conflicts = (Array.isArray(submittedRows) ? submittedRows : [])
            .map((row, index) => ({ rowKey: this._rowKey(row), field: `decisionRows[${index}]` }))
            .filter(item => retainedKeys.has(item.rowKey));
        if (conflicts.length === 0) return { ok: true };
        return this._blocked(
            'DESIGN_WORKFLOW_RECOVERY_RETAINED_ROW_OVERWRITE_FORBIDDEN',
            '局部恢复提交包含未失效的已确认结构行；Builder拒绝覆盖保留答案。',
            ['call_design_prepare_context_without_phase'],
            { issues: conflicts }
        );
    }

    _validateRecoveryPageScope(state, submittedRows = []) {
        const allowed = new Set(Array.isArray(state && state.recoveryPageStoryIds)
            ? state.recoveryPageStoryIds
            : []);
        if (!state || !['story_dependency_invalidation', 'explicit_revision'].includes(state.recoveryMode) || allowed.size === 0) {
            return { ok: true };
        }
        const issues = [];
        (Array.isArray(submittedRows) ? submittedRows : []).forEach((row, index) => {
            const parts = String(row || '').split('|').map(value => value.trim());
            const kind = String(parts[0] || '').toUpperCase();
            const storyIds = [String(parts[1] || '').toUpperCase()];
            if (kind === 'PAGE_BIND' && String(parts[2] || '').toLowerCase() === 'shared') {
                storyIds.push(String(parts[3] || '').toUpperCase());
            }
            if (!storyIds.some(storyId => allowed.has(storyId))) {
                issues.push({
                    code: 'DESIGN_WORKFLOW_RECOVERY_PAGE_STORY_OUT_OF_SCOPE',
                    field: `compositionRows[${index}]`,
                    storyIds
                });
            }
        });
        return issues.length === 0
            ? { ok: true }
            : this._blocked(
                'DESIGN_WORKFLOW_RECOVERY_PAGE_SCOPE_INVALID',
                '页面局部恢复只能提交targetStoryIds关联的COMPOSE/SECTION/PAGE_BIND，禁止覆盖未变化Story。',
                ['call_design_prepare_context_without_phase'],
                { issues, allowedStoryIds: Array.from(allowed) }
            );
    }

    _acceptedRawRows(state, phase) {
        return (Array.isArray(state && state.acceptedRows) ? state.acceptedRows : [])
            .filter(item => item && item.phase === phase && typeof item.row === 'string')
            .map(item => item.row);
    }

    _replaceAcceptedPhaseRows(state, phase, rows, model) {
        const retained = (Array.isArray(state && state.acceptedRows) ? state.acceptedRows : [])
            .filter(item => item && item.phase !== phase);
        const accepted = (Array.isArray(rows) ? rows : []).map(row => ({
            phase,
            row,
            rowKey: this._rowKey(row),
            dependencyRefs: this._rowDependencyRefs(row, model)
        }));
        return retained.concat(accepted);
    }

    _rowKey(row) {
        const parts = String(row || '').split('|').map(value => value.trim());
        const kind = String(parts[0] || '').toUpperCase();
        if (kind === 'TABLE') return `TABLE:${parts[1] || ''}`;
        if (kind === 'RELATION') return `RELATION:${parts[1] || ''}:${parts[2] || ''}`;
        if (kind === 'STORY') return `STORY:${String(parts[1] || '').toUpperCase()}`;
        if (kind === 'STATISTICS_SOURCE') return `STATISTICS_SOURCE:${String(parts[1] || '').toUpperCase()}:${String(parts[2] || '').toUpperCase()}`;
        if (kind === 'FIELD' || kind === 'CODE_ITEM' || kind === 'ATTACHMENT') {
            return `${kind}:${parts[1] || ''}:${parts[2] || ''}`;
        }
        if (kind === 'REST') return `REST:${String(parts[1] || '').toUpperCase()}:${parts[2] || ''}`;
        if (kind === 'WORKFLOW_EVENT' || kind === 'QUERY_FILTER') return `${kind}:${String(parts[1] || '').toUpperCase()}:${parts[2] || ''}`;
        if (kind === 'COMPOSE') return `COMPOSE:${String(parts[1] || '').toUpperCase()}`;
        if (kind === 'SECTION') return `SECTION:${String(parts[1] || '').toUpperCase()}:${parts[2] || ''}`;
        if (kind === 'PAGE_BIND') return `PAGE_BIND:${String(parts[1] || '').toUpperCase()}:${String(parts[2] || '').toLowerCase()}:${String(parts[3] || '').toUpperCase()}`;
        return `${kind || 'UNKNOWN'}:${this._sha256(String(row || '')).slice(0, 12)}`;
    }

    _rowDependencyRefs(row, model = {}) {
        const parts = String(row || '').split('|').map(value => value.trim());
        const kind = String(parts[0] || '').toUpperCase();
        const refs = new Set();
        const addStory = storyId => {
            const normalized = String(storyId || '').trim().toUpperCase();
            if (normalized) refs.add(`STORY:${normalized}`);
        };
        const addObject = objectKey => {
            const normalized = String(objectKey || '').trim();
            if (!normalized || normalized === '-') return;
            refs.add(`OBJECT:${normalized}`);
            this._storyIdsForObject(model, normalized).forEach(addStory);
        };
        if (kind === 'TABLE') {
            addObject(parts[1]);
            if (String(parts[2] || '').toLowerCase() === 'reuse' && parts[3]) {
                refs.add(`TABLE_CANDIDATE:${String(parts[3]).toUpperCase()}`);
            }
        } else if (kind === 'RELATION') {
            addObject(parts[1]);
            addObject(parts[2]);
        } else if (kind === 'STORY') {
            addStory(parts[1]);
            addObject(parts[3]);
        } else if (kind === 'STATISTICS_SOURCE') {
            addStory(parts[1]);
            if (parts[2]) refs.add(`TABLE_CANDIDATE:${String(parts[2]).toUpperCase()}`);
        } else if (['FIELD', 'CODE_ITEM', 'ATTACHMENT'].includes(kind)) {
            addObject(parts[1]);
            if (kind === 'CODE_ITEM' && String(parts[3] || '').toLowerCase() === 'reuse' && parts[5]) {
                refs.add(`FACT:${parts[5]}`);
            }
        } else if (kind === 'REST') {
            addStory(parts[1]);
        } else if (kind === 'COMPOSE') {
            addStory(parts[1]);
            String(parts[3] || '').split(',').forEach(block => addObject(block.split(':')[1]));
        } else if (kind === 'SECTION') {
            addStory(parts[1]);
            String(parts[4] || '').split(',').forEach(ref => addObject(ref.split('.')[0]));
        } else if (kind === 'QUERY_FILTER') {
            addStory(parts[1]);
            addObject(String(parts[3] || '').split('.')[0]);
        } else if (kind === 'PAGE_BIND') {
            addStory(parts[1]);
            if (String(parts[2] || '').toLowerCase() === 'shared') {
                addStory(parts[3]);
                refs.add(`PAGE:${String(parts[3] || '').toUpperCase()}`);
            }
        }
        return Array.from(refs).sort();
    }

    _rowOutputRefs(row) {
        const parts = String(row || '').split('|').map(value => value.trim());
        const kind = String(parts[0] || '').toUpperCase();
        if (kind === 'TABLE') return [`OBJECT:${parts[1]}`];
        if (kind === 'RELATION') return [`OBJECT:${parts[1]}`, `OBJECT:${parts[2]}`];
        if (kind === 'STORY') return [`STORY_ROUTE:${String(parts[1] || '').toUpperCase()}`, `OBJECT:${parts[3]}`];
        if (kind === 'STATISTICS_SOURCE') return [`STATISTICS_SOURCE:${String(parts[1] || '').toUpperCase()}:${String(parts[2] || '').toUpperCase()}`];
        if (['FIELD', 'CODE_ITEM', 'ATTACHMENT'].includes(kind)) return [`FIELD:${parts[1]}.${parts[2]}`];
        if (kind === 'REST') return [`REST:${String(parts[1] || '').toUpperCase()}`];
        if (kind === 'COMPOSE' || kind === 'SECTION') return [`PAGE:${String(parts[1] || '').toUpperCase()}`];
        if (kind === 'PAGE_BIND') {
            const refs = [`PAGE_BIND:${String(parts[1] || '').toUpperCase()}`];
            if (String(parts[2] || '').toLowerCase() === 'shared') refs.push(`PAGE:${String(parts[3] || '').toUpperCase()}`);
            return refs;
        }
        return [];
    }

    _rowObjectKeys(row) {
        const parts = String(row || '').split('|').map(value => value.trim());
        const kind = String(parts[0] || '').toUpperCase();
        if (kind === 'TABLE' || ['FIELD', 'CODE_ITEM', 'ATTACHMENT'].includes(kind)) return [parts[1]];
        if (kind === 'RELATION') return [parts[1], parts[2]];
        if (kind === 'STORY') return parts[3] && parts[3] !== '-' ? [parts[3]] : [];
        if (kind === 'COMPOSE') return String(parts[3] || '').split(',').map(block => block.split(':')[1]);
        if (kind === 'SECTION') return String(parts[4] || '').split(',').map(ref => ref.split('.')[0]);
        return [];
    }

    _storyIdsForObject(model, objectKey) {
        const ids = [];
        (Array.isArray(model && model.carriers) ? model.carriers : []).forEach(carrier => {
            if (carrier.objectKey === objectKey && carrier.ownerStoryId) ids.push(carrier.ownerStoryId);
        });
        (Array.isArray(model && model.storyRoutes) ? model.storyRoutes : []).forEach(route => {
            if (route.primaryObjectKey === objectKey && route.storyId) ids.push(route.storyId);
        });
        return Array.from(new Set(ids.map(value => String(value).trim().toUpperCase()).filter(Boolean)));
    }

    _topologyOnlyModel(model = {}) {
        const copy = JSON.parse(JSON.stringify(model || {}));
        const reusedObjects = new Set((copy.carriers || []).filter(carrier => carrier.mode === 'reuse').map(carrier => carrier.objectKey));
        copy.objectFields = (copy.objectFields || []).filter(field => reusedObjects.has(field.objectKey));
        copy.restOperations = [];
        copy.pageCompositions = [];
        copy.pageBindings = [];
        delete copy.detailHash;
        delete copy.pageDesignHash;
        return copy;
    }

    _filterRecoveryBatchPlan(plan, model, state) {
        const targetObjects = new Set(Array.isArray(state && state.recoveryDetailObjectKeys)
            ? state.recoveryDetailObjectKeys
            : []);
        const affectedStories = new Set(Array.isArray(state && state.recoveryAffectedStoryIds)
            ? state.recoveryAffectedStoryIds
            : []);
        (Array.isArray(model && model.storyRoutes) ? model.storyRoutes : []).forEach(route => {
            if (affectedStories.has(route.storyId) && route.primaryObjectKey) targetObjects.add(route.primaryObjectKey);
        });
        let expanded = true;
        while (expanded) {
            expanded = false;
            (Array.isArray(model && model.objectRelations) ? model.objectRelations : []).forEach(relation => {
                const parent = relation.parentObjectKey;
                const child = relation.childObjectKey;
                if (targetObjects.has(parent) && child && !targetObjects.has(child)) {
                    targetObjects.add(child);
                    expanded = true;
                }
                if (targetObjects.has(child) && parent && !targetObjects.has(parent)) {
                    targetObjects.add(parent);
                    expanded = true;
                }
            });
        }
        const batches = (Array.isArray(plan && plan.batches) ? plan.batches : []).map(batch => ({
            ...batch,
            tableKeys: (batch.tableKeys || []).filter(key => targetObjects.has(key)),
            restStoryIds: (batch.restStoryIds || []).filter(storyId => affectedStories.has(storyId)),
            ...(Array.isArray(batch.workflowStoryIds)
                ? { workflowStoryIds: batch.workflowStoryIds.filter(storyId => affectedStories.has(storyId)) }
                : {})
        })).filter(batch => batch.tableKeys.length > 0 || batch.restStoryIds.length > 0);
        return { ...(plan || {}), batches };
    }

    _loadContext(resolved) {
        const requirementStories = this._readJson(resolved.storiesPath);
        const storiesReceipt = this._readJson(resolved.storiesReceiptPath);
        const rulePool = this._readJson(resolved.rulePoolPath);
        const rulePoolReceipt = this._readJson(resolved.rulePoolReceiptPath);
        if (!requirementStories || this._stories(requirementStories).length === 0
            || !this._receiptMatchesFile(storiesReceipt, resolved.storiesPath, 'storyHash')) {
            return this._blocked('DESIGN_WORKFLOW_REQUIREMENT_STORIES_INVALID', 'stories.json或stories-submit-receipt.json缺失；回Requirement闭合。', ['rerun_req_stories_submit']);
        }
        if (!rulePool || !this._receiptMatchesFile(rulePoolReceipt, resolved.rulePoolPath, 'rulePoolHash')) {
            return this._blocked('DESIGN_WORKFLOW_RULE_POOL_INVALID', 'rule-pool.json或rule-pool-submit-receipt.json缺失；回Requirement闭合。', ['rerun_requirement_rule_pool']);
        }
        const inputVersionRefs = [
            this._versionRef(resolved.storiesPath),
            this._versionRef(resolved.storiesReceiptPath),
            this._versionRef(resolved.rulePoolPath),
            this._versionRef(resolved.rulePoolReceiptPath)
        ];
        const entityGraphPath = path.join(resolved.projectArtifactsDir, 'entity-graph.json');
        const entityGraph = this._readJson(entityGraphPath);
        if (entityGraph) inputVersionRefs.push(this._versionRef(entityGraphPath));
        const documentBuilder = new DesignDocumentBuilderService();
        const confirmedTableCandidateFacts = (Array.isArray(rulePool.globalTableCandidateWhitelist)
            ? rulePool.globalTableCandidateWhitelist
            : []).map(item => {
                if (typeof item === 'string') item = { tableName: item };
                if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
                const tableName = String(item.tableName || item.name || '').trim();
                if (!tableName) return null;
                return {
                    tableName,
                    columns: documentBuilder._lookupReuseEntityFromGraph(tableName, entityGraph).columns,
                    ...(String(item.entityName || '').trim() ? { entityName: String(item.entityName).trim() } : {}),
                    ...(String(item.tableDisplayName || '').trim() ? { tableDisplayName: String(item.tableDisplayName).trim() } : {}),
                    ...(String(item.candidateRole || '').trim() ? { candidateRole: String(item.candidateRole).trim() } : {}),
                    ...(Array.isArray(item.sourceStoryIds) ? { sourceStoryIds: item.sourceStoryIds.map(value => String(value || '').trim().toUpperCase()).filter(Boolean) } : {}),
                    ...(Array.isArray(item.primaryOwnerStoryIds) ? { primaryOwnerStoryIds: item.primaryOwnerStoryIds.map(value => String(value || '').trim().toUpperCase()).filter(Boolean) } : {}),
                    ...(Array.isArray(item.triggerStoryIds) ? { triggerStoryIds: item.triggerStoryIds.map(value => String(value || '').trim().toUpperCase()).filter(Boolean) } : {}),
                    ...(Array.isArray(item.weakRelatedStoryIds) ? { weakRelatedStoryIds: item.weakRelatedStoryIds.map(value => String(value || '').trim().toUpperCase()).filter(Boolean) } : {})
                };
            }).filter(Boolean);
        const confirmedTableCandidates = confirmedTableCandidateFacts.map(item => item.tableName);
        const sourceStoryHashes = {};
        const sourceRefHashes = {};
        this._stories(requirementStories).forEach(story => {
            const storyId = this._storyId(story);
            if (!storyId) return;
            const hash = this._sha256(this._stableJsonStringify(story));
            sourceStoryHashes[storyId] = hash;
            sourceRefHashes[`STORY:${storyId}`] = hash;
            (Array.isArray(story && story.codingFactHandoff) ? story.codingFactHandoff : []).forEach(fact => {
                const factId = String(fact && fact.factId || '').trim();
                if (factId) sourceRefHashes[`FACT:${factId}`] = this._sha256(this._stableJsonStringify(fact));
            });
        });
        confirmedTableCandidateFacts.forEach(candidate => {
            const normalized = String(candidate.tableName || '').trim().toUpperCase();
            if (normalized) sourceRefHashes[`TABLE_CANDIDATE:${normalized}`] = this._sha256(this._stableJsonStringify({ tableName: normalized, columns: candidate.columns }));
        });
        return {
            ok: true,
            requirementStories,
            rulePool,
            confirmedTableCandidates,
            confirmedTableCandidateFacts,
            sourceStoryHashes,
            sourceRefHashes,
            inputVersionRefs,
            inputVersionHash: this._sha256(JSON.stringify(inputVersionRefs))
        };
    }

    _receiptMatchesFile(receipt, filePath, hashField) {
        if (!receipt || receipt.ok !== true || String(receipt.status || '') !== 'submitted') return false;
        const expected = String(receipt[hashField] || '').trim();
        if (!expected || !fs.existsSync(filePath)) return false;
        const actual = `sha256:${crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex')}`;
        return actual === expected;
    }

    _completedResult(resolved) {
        if (!fs.existsSync(resolved.finalizeReceiptPath) || !fs.existsSync(resolved.designJsonPath)) return null;
        if (this.validateCompleted) {
            const checked = this.validateCompleted(resolved);
            if (!checked || checked.ok !== true) return null;
        } else {
            const receipt = this._readJson(resolved.finalizeReceiptPath);
            if (!this._isValidFinalizeReceipt(receipt, resolved)) return null;
        }
        return {
            ok: true,
            status: 'completed',
            designFinalized: true,
            currentPhase: 'completed',
            designJsonRef: resolved.designJsonPath,
            finalizeReceiptRef: resolved.finalizeReceiptPath,
            allowedNextActions: ['continue_to_design_tdd_coder'],
            forbiddenActions: ['restart_completed_design', 'delete_final_design_artifacts']
        };
    }

    _isValidFinalizeReceipt(receipt, resolved) {
        if (!receipt || receipt.ok !== true
            || receipt.schemaVersion !== 'managed-artifact-finalizer/v1'
            || receipt.stageKey !== 'requirement-design'
            || !Array.isArray(receipt.artifacts)
            || receipt.artifacts.length === 0) return false;
        const designArtifact = receipt.artifacts.find(item => item && item.key === 'designJson');
        const comparablePath = value => {
            const normalized = path.resolve(String(value || ''));
            return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
        };
        if (!designArtifact || comparablePath(designArtifact.path) !== comparablePath(resolved.designJsonPath)) return false;
        return receipt.artifacts.every(artifact => {
            const filePath = String(artifact && artifact.path || '').trim();
            if (!filePath || !fs.existsSync(filePath)) return false;
            const expected = String(artifact.contentHash || '').trim();
            if (!expected) return false;
            const content = fs.readFileSync(filePath);
            const actual = `sha256:${crypto.createHash('sha256').update(content).digest('hex')}`;
            if (actual !== expected) return false;
            if (String(artifact.hashMode || '').trim() !== 'json_logical') return true;
            const expectedLogical = String(artifact.expectedHash || '').trim();
            if (!expectedLogical) return true;
            let logical;
            try {
                logical = `sha256:${crypto.createHash('sha256')
                    .update(JSON.stringify(JSON.parse(content.toString('utf8'))), 'utf8')
                    .digest('hex')}`;
            } catch (_) {
                return false;
            }
            const recordedActual = String(artifact.actualHash || '').trim();
            return logical === expectedLogical && (!recordedActual || recordedActual === logical);
        });
    }

    _stepRepair(result, state, resolved) {
        return {
            ...result,
            status: 'repair_required',
            stopAfter: false,
            actionMode: 'repair_current_design_step',
            currentPhase: state.currentPhase,
            currentStepId: state.currentStepId,
            currentCardRef: state.currentCardRef,
            allowedNextActions: ['resubmit_current_step_with_same_step_id'],
            forbiddenActions: ['change_completed_step', 'write_design_runtime_directly']
        };
    }

    _projectionDefect(result, state, resolved, errorCode) {
        const nestedPreflight = result && result.preflight && typeof result.preflight === 'object' && !Array.isArray(result.preflight)
            ? result.preflight
            : null;
        const preflight = nestedPreflight
            ? {
                ...(nestedPreflight.errorCode ? { errorCode: nestedPreflight.errorCode } : {}),
                ...(nestedPreflight.message ? { message: nestedPreflight.message } : {}),
                ...(Array.isArray(nestedPreflight.issues) ? { issues: nestedPreflight.issues } : {}),
                ...(Array.isArray(nestedPreflight.missingBindings)
                    ? { missingBindings: nestedPreflight.missingBindings }
                    : {}),
                ...(Array.isArray(nestedPreflight.allowedNextActions)
                    ? { allowedNextActions: nestedPreflight.allowedNextActions }
                    : {})
            }
            : null;
        return {
            ok: false,
            status: 'blocked',
            actionMode: 'report_design_projection_defect',
            errorCode,
            message: String(result && result.message || '公开输入已通过，但Builder/Coder预检拒绝其机械投影；这是系统合同缺陷，不要求LLM修改业务答案。'),
            ...(Array.isArray(result && result.issues)
                ? { issues: result.issues }
                : (preflight && Array.isArray(preflight.issues) ? { issues: preflight.issues } : {})),
            ...(preflight ? { preflight } : {}),
            currentPhase: state && state.currentPhase,
            currentStepId: state && state.currentStepId,
            currentCardRef: state && state.currentCardRef || resolved.currentCardPath,
            allowedNextActions: ['report_design_projection_defect'],
            forbiddenActions: ['repair_business_answer', 'retry_with_guessed_internal_fields', 'write_design_document_json_directly']
        };
    }

    _stateWriteBlocked(error, resolved) {
        return this._blocked('DESIGN_WORKFLOW_STATE_WRITE_FAILED', `Design workflow state原子写失败：${error.message}`, ['fix_design_runtime_permission_then_prepare'], {
            workflowStatePath: resolved.workflowStatePath
        });
    }

    _finalizeInterrupted(result, state, resolved) {
        const message = result instanceof Error
            ? result.message
            : String(result && result.message || result && result.errorCode || 'finalizer未完成');
        return {
            ok: false,
            status: 'blocked',
            actionMode: 'restore_design_after_finalize_interruption',
            errorCode: 'DESIGN_WORKFLOW_FINALIZE_INTERRUPTED',
            message: `Design最终落盘未闭合：${message}。字段与页面设计前置状态保持不变；无phase调用prepare后，用原currentStepId重试当前页面设计提交。`,
            currentPhase: state && state.currentPhase,
            currentStepId: state && state.currentStepId,
            currentCardRef: state && state.currentCardRef || resolved.currentCardPath,
            allowedNextActions: ['call_design_prepare_context_without_phase'],
            forbiddenActions: ['advance_to_coder', 'write_design_runtime_directly', 'create_nested_ai_workspace']
        };
    }

    _upstreamBlocked(result, state, resolved) {
        if (String(result && result.errorCode || '') === 'REQUIREMENT_STORIES_LOCAL_PERSISTENCE_UNRESOLVED') {
            return {
                ok: false,
                status: 'blocked',
                actionMode: 'return_to_requirement_step5',
                errorCode: 'REQUIREMENT_STORIES_LOCAL_PERSISTENCE_UNRESOLVED',
                storyId: String(result && result.storyId || '').trim().toUpperCase(),
                missingFactKind: String(result && result.missingFactKind || '').trim(),
                missingFactRef: String(result && result.missingFactRef || '').trim(),
                currentPhase: state && state.currentPhase,
                currentStepId: state && state.currentStepId,
                allowedNextActions: ['req_prepare_context'],
                forbiddenActions: [
                    'builder_generate_business_question',
                    'builder_generate_answer_options',
                    'builder_create_business_ambiguity_card',
                    'advance_to_coder',
                    'write_design_runtime_directly'
                ]
            };
        }
        return {
            ...(result || {}),
            ok: false,
            status: 'blocked',
            currentPhase: state && state.currentPhase,
            currentStepId: state && state.currentStepId,
            currentCardRef: state && state.currentCardRef || resolved.currentCardPath,
            forbiddenActions: Array.from(new Set([
                ...((result && result.forbiddenActions) || []),
                'write_design_runtime_directly',
                'advance_to_coder'
            ]))
        };
    }

    _clearUnfinishedRuntime(resolved) {
        if (!fs.existsSync(resolved.runtimeDir)) return;
        for (const name of fs.readdirSync(resolved.runtimeDir)) {
            const target = path.join(resolved.runtimeDir, name);
            if (fs.statSync(target).isFile()) fs.unlinkSync(target);
        }
    }

    _writeJsonAtomic(filePath, value, options = {}) {
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        const temporary = `${filePath}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
        try {
            fs.writeFileSync(temporary, this._serializeJson(value, options.compact === true), 'utf8');
            if (this.beforeAtomicReplace) this.beforeAtomicReplace(filePath, temporary);
            fs.renameSync(temporary, filePath);
        } catch (error) {
            try { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); } catch (_) {}
            throw error;
        }
    }

    _readJson(filePath) {
        try { return JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch (_) { return null; }
    }

    _versionRef(filePath) {
        const content = fs.readFileSync(filePath);
        return { path: filePath, sha256: this._sha256(content) };
    }

    _payloadHash(rows) {
        return this._sha256(JSON.stringify(Array.isArray(rows) ? rows : []));
    }

    _stepId(kind, inputVersionHash) {
        return `${kind}-${this._sha256(`${kind}|${inputVersionHash}|${Date.now()}|${crypto.randomBytes(8).toString('hex')}`).slice(0, 16)}`;
    }

    _sha256(value) {
        return crypto.createHash('sha256').update(value).digest('hex');
    }

    _stableJsonStringify(value) {
        const normalize = item => {
            if (Array.isArray(item)) return item.map(normalize);
            if (!item || typeof item !== 'object') return item;
            const out = {};
            Object.keys(item).sort().forEach(key => {
                if (typeof item[key] !== 'undefined') out[key] = normalize(item[key]);
            });
            return out;
        };
        return JSON.stringify(normalize(value));
    }

    _stories(value) {
        if (value && Array.isArray(value.stories)) return value.stories;
        if (value && value.stories && typeof value.stories === 'object') {
            return Object.entries(value.stories).map(([storyId, story]) => ({ storyId, ...(story || {}) }));
        }
        return Array.isArray(value) ? value : [];
    }

    _storyId(story) {
        return String(story && (story.storyId || story.id) || '').trim().toUpperCase();
    }

    _compactStoryFact(story) {
        return {
            storyId: this._storyId(story),
            userStory: story.userStory || story.intent,
            acceptanceCriteria: story.acceptanceCriteria,
            invariants: story.invariants,
            codingFactHandoff: story.codingFactHandoff,
            deliveryBoundary: story.deliveryBoundary,
            workflowIntent: story.workflowIntent,
            statisticsIntent: story.statisticsIntent,
            existingAdjustment: story.existingAdjustment
        };
    }

    _compactTableCandidateFacts(candidates = []) {
        return (Array.isArray(candidates) ? candidates : []).map(candidate => {
            const tableName = String(candidate && (candidate.tableName || candidate.name) || candidate || '').trim();
            if (!tableName) return null;
            const out = {
                tableName,
                ...(String(candidate && candidate.entityName || '').trim() ? { entityName: String(candidate.entityName).trim() } : {}),
                ...(String(candidate && candidate.tableDisplayName || '').trim() ? { tableDisplayName: String(candidate.tableDisplayName).trim() } : {}),
                ...(String(candidate && candidate.candidateRole || '').trim() ? { candidateRole: String(candidate.candidateRole).trim() } : {})
            };
            ['primaryOwnerStoryIds', 'triggerStoryIds', 'weakRelatedStoryIds'].forEach(field => {
                if (!Array.isArray(candidate && candidate[field]) || candidate[field].length === 0) return;
                out[field] = candidate[field].map(value => String(value || '').trim().toUpperCase()).filter(Boolean);
            });
            return out;
        }).filter(Boolean);
    }

    _prepareRequired(message) {
        return this._blocked(
            'DESIGN_WORKFLOW_PREPARE_REQUIRED',
            `${message} 先无phase调用design_prepare_context重建当前结构卡。`,
            ['call_design_prepare_context_without_phase']
        );
    }

    _normalizeRowsPayload(raw) {
        if (raw == null) return [];
        if (Array.isArray(raw)) {
            const out = [];
            for (const item of raw) {
                if (typeof item === 'string') { out.push(item); continue; }
                if (item && typeof item === 'object') {
                    let extracted = null;
                    for (const key of ['row', 'value', 'item', 'line', 'text', 'data', 'content', 'str']) {
                        if (typeof item[key] === 'string') { extracted = item[key]; break; }
                    }
                    if (extracted === null) {
                        const vals = Object.values(item).filter(v => typeof v === 'string');
                        if (vals.length > 0) extracted = vals[0];
                    }
                    if (typeof extracted === 'string' && extracted.trim()) { out.push(extracted); continue; }
                }
                if (typeof item === 'number' || typeof item === 'boolean') { out.push(String(item)); continue; }
            }
            return out;
        }
        if (typeof raw === 'string') {
            const trimmed = raw.trim();
            if (trimmed === '' || trimmed === '[]') return [];
            if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
                try {
                    return this._normalizeRowsPayload(JSON.parse(trimmed));
                } catch (_) { /* fall through */ }
            }
            return [trimmed];
        }
        if (typeof raw === 'object') {
            for (const key of ['item', 'items', 'value', 'values', 'list', 'array', 'data', 'entries']) {
                if (Array.isArray(raw[key])) return this._normalizeRowsPayload(raw[key]);
            }
        }
        return null;
    }

    _blocked(errorCode, message, allowedNextActions = [], extra = {}) {
        return {
            ok: false,
            status: 'blocked',
            actionMode: 'restore_or_repair_design_workflow',
            errorCode,
            message,
            allowedNextActions,
            forbiddenActions: ['write_design_runtime_directly', 'create_nested_ai_workspace'],
            ...extra
        };
    }
}

DesignWorkflowService.WORKFLOW_VERSION = WORKFLOW_VERSION;
module.exports = DesignWorkflowService;
