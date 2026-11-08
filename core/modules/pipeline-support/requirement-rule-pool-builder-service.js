/* eslint-disable */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

class RequirementRulePoolBuilderService {
    constructor(options = {}) {
        this.skillIntentService = options.skillIntentService;
        this.requirementRulePoolService = options.requirementRulePoolService;
    }

    buildRuleDraft(options = {}) {
        const projectPath = String(options.projectPath || '').trim();
        const paths = options.paths || {};
        if (!projectPath) return this._blocked('REQUIREMENT_RULE_POOL_DRAFT_PROJECT_PATH_MISSING', '缺少 projectPath，无法生成需求规则池草案。');
        if (!this.skillIntentService || typeof this.skillIntentService.buildRequirementRuleAnalyzeResult !== 'function') {
            return this._blocked('REQUIREMENT_RULE_POOL_DRAFT_BUILDER_UNAVAILABLE', '缺少规则召回 Builder，无法生成需求规则池草案。');
        }
        // 需求分析.md 是 finalize 收口时由 Builder 生成的人读展示；规则召回的机器真值
        // 来自 stories.json + analysis-state.json。这里保留 Markdown 读取仅作旧 demand 兜底。
        const demandAnalysisText = this._readText(paths.demandAnalysisPath);
        const analysisStateRead = this._readJson(paths.analysisStatePath);
        if (!analysisStateRead.ok) {
            return this._blocked('REQUIREMENT_RULE_POOL_DRAFT_ANALYSIS_STATE_INVALID', `analysis-state.json 缺失或无法解析：${paths.analysisStatePath || ''}`);
        }

        const stories = this._extractStories(analysisStateRead.value, demandAnalysisText, paths);
        if (stories.length === 0) {
            return this._blocked('REQUIREMENT_RULE_POOL_DRAFT_STORIES_EMPTY', '未提取到 User Story，无法按 Story 生成规则池草案。');
        }

        const confirmedDecisions = this._extractConfirmedDecisions(analysisStateRead.value);
        const userSupplement = String(options.userSupplement || options.additionalIntent || '').trim();
        const explicitTableNamesResult = this._normalizeExplicitTableNames(options.userSupplementTableNames);
        if (!explicitTableNamesResult.ok) return explicitTableNamesResult;
        const explicitTableNames = explicitTableNamesResult.names;
        const storyRuleRecalls = stories.map(story => {
            const ruleSearchIntent = this._buildRuleSearchIntent(story, confirmedDecisions, userSupplement);
            const analyzeResult = this.skillIntentService.buildRequirementRuleAnalyzeResult(ruleSearchIntent, {
                projectPath,
                skillName: 'epoint-requirement-analyzer',
                userSupplementTableNames: explicitTableNames
            }) || {};
            const acceptedRules = this._filterRulesByAuthoritativeStoryEvidence(
                story,
                analyzeResult.acceptedRules,
                userSupplement
            );
            return {
                storyId: story.storyId,
                userStory: story.userStory,
                ruleSearchIntent,
                recallInput: {
                    confirmedDecisions
                },
                acceptedRules,
                baselineConstraints: Array.isArray(analyzeResult.baselineConstraints) ? analyzeResult.baselineConstraints : [],
                projectTableCandidates: Array.isArray(analyzeResult.projectTableCandidates) ? analyzeResult.projectTableCandidates : [],
                unresolvedSignals: Array.isArray(analyzeResult.unresolvedSignals) ? analyzeResult.unresolvedSignals : [],
                diagnostics: analyzeResult.diagnostics || {}
            };
        });

        const ruleCandidates = this._dedupeRules(storyRuleRecalls);
        const tableCandidates = this._dedupeTableCandidates(storyRuleRecalls);
        const explicitTableCheck = this._validateExplicitTableCandidates(
            explicitTableNames,
            tableCandidates,
            { projectPath }
        );
        if (!explicitTableCheck.ok) return explicitTableCheck;
        const decisionDraftId = this._draftId({
            demandName: paths.demandName || '',
            userSupplement,
            userSupplementTableNames: explicitTableNames,
            storyRuleRecalls,
            ruleCandidates,
            tableCandidates
        });
        const draft = {
            schemaVersion: 'requirement-rule-pool-draft/v1',
            decisionDraftId,
            createdAt: new Date().toISOString(),
            demandName: paths.demandName || '',
            demandDir: paths.demandDir || '',
            userSupplement,
            userSupplementTableNames: explicitTableNames,
            storyRuleRecalls,
            ruleCandidates,
            tableCandidates,
            confirmationCard: this._buildRuleConfirmationCard(ruleCandidates)
        };
        const draftHash = this._sha256(JSON.stringify(draft));
        const receiptPath = path.join(paths.demandArtifactDir || path.dirname(paths.rulePoolPath || ''), 'rule-pool-draft-receipt.json');
        const receipt = {
            schemaVersion: 'requirement-rule-pool-draft-receipt/v1',
            status: 'awaiting_user_confirmation',
            ok: true,
            decisionDraftId,
            draftHash,
            createdAt: draft.createdAt,
            demandName: paths.demandName || '',
            draft
        };
        this._writeJson(receiptPath, receipt);
        return {
            ok: true,
            status: 'awaiting_rule_confirmation',
            actionMode: 'display_rule_candidate_confirmation_card',
            decisionDraftId,
            receipt: { written: true, path: receiptPath },
            summary: {
                storyCount: storyRuleRecalls.length,
                ruleCandidateCount: ruleCandidates.length,
                confirmedDecisionCount: confirmedDecisions.length,
                hasUserSupplement: !!userSupplement,
                explicitTableCount: explicitTableNames.length
            },
            confirmationCard: draft.confirmationCard,
            ruleCandidates: ruleCandidates.map(item => this._slimRuleCandidate(item)),
            // s2c 范式：明确告诉 LLM 下一步只能展示规则确认卡 + 等用户回复 + 调 submit_rule_decision。
            nextActionCard: {
                title: '展示规则确认卡给用户 → 等用户回复 → 调 submit_rule_decision',
                userGate: true,
                stopAfter: true,
                instruction: '把 confirmationCard 字符串原样展示给用户（最后一屏），等用户回复后把结构化 keptRuleAliases 数组提交给 submit_rule_decision，并把用户对规则确认卡的原始回复原样放入 userInput。userInput 是 finalize 审计必填字段，不能省略；禁止从用户原文解析表决策。',
                onUserContinueCallTemplate: `submit_rule_decision(${JSON.stringify({
                    projectPath,
                    skillName: 'epoint-requirement-analyzer',
                    decisionDraftId,
                    keptRuleAliases: ['TEMPLATE_FILL_REQUIRED (从用户明确选择映射出的规则别名数组；空数组表示全部剔除)'],
                    userInput: 'TEMPLATE_REQUIRED_RAW_USER_REPLY (用户对规则确认卡的原始回复，必须原样透传，如：OK/确认/都保留/剔除 R2)'
                })})`
            },
            allowedNextActions: ['display_rule_confirmationCard_to_user', 'call_submit_rule_decision_after_user_reply'],
            forbiddenActions: ['write_rule_pool_json_directly', 'set_rule_pool_confirmed_true_manually']
        };
    }

    submitRuleDecision(options = {}) {
        const paths = options.paths || {};
        const decisionDraftId = String(options.decisionDraftId || '').trim();
        const userInput = String(options.userInput || options.userDecision || '').trim();
        if (!decisionDraftId) return this._blocked('REQUIREMENT_RULE_POOL_SUBMIT_DRAFT_ID_MISSING', '缺少 decisionDraftId，无法提交规则确认结果。');
        if (!Array.isArray(options.keptRuleAliases)) {
            return this._blocked('REQUIREMENT_RULE_POOL_RULE_ALIASES_REQUIRED', '缺少 keptRuleAliases 数组，无法提交规则确认结果。');
        }
        const draftLoad = this._loadDraftReceipt(paths, decisionDraftId);
        if (!draftLoad.ok) return draftLoad;
        const draft = draftLoad.draft;
        const ruleCandidates = Array.isArray(draft.ruleCandidates) ? draft.ruleCandidates : [];
        if (ruleCandidates.length > 0 && !userInput) {
            return this._blocked(
                'REQUIREMENT_RULE_POOL_RULE_CONFIRMATION_USER_INPUT_MISSING',
                '规则候选非空时，submit_rule_decision 必须把用户对规则确认卡的原始回复放入 userInput，例如 OK/确认/都保留/剔除 R2；禁止事后手写 rule-pool.json。'
            );
        }
        const candidateAliases = ruleCandidates.map(item => this._ruleAlias(item)).filter(Boolean);
        const keptRuleAliases = options.keptRuleAliases.map(alias => String(alias || '').trim()).filter(Boolean);
        const unknown = keptRuleAliases.filter(alias => !candidateAliases.includes(alias));
        if (unknown.length > 0) {
            return this._blocked('REQUIREMENT_RULE_POOL_RULE_ALIAS_UNKNOWN', `keptRuleAliases 包含不在候选集内的规则别名：${unknown.join(', ')}`);
        }
        const receiptPath = this._ruleStageReceiptPath(paths);
        const receipt = {
            schemaVersion: 'requirement-rule-pool-rule-stage-receipt/v1',
            status: 'rule_decision_submitted',
            ok: true,
            decisionDraftId,
            draftHash: draftLoad.draftReceipt.draftHash || '',
            keptRuleAliases,
            blockedRuleAliases: candidateAliases.filter(alias => !keptRuleAliases.includes(alias)),
            userInput,
            submittedAt: new Date().toISOString()
        };
        this._writeJson(receiptPath, receipt);
        return {
            ok: true,
            status: 'awaiting_table_confirmation',
            actionMode: 'rule_decision_recorded_awaiting_table_decision',
            decisionDraftId,
            receipt: { written: true, path: receiptPath },
            summary: {
                keptRuleCount: receipt.keptRuleAliases.length,
                blockedRuleCount: receipt.blockedRuleAliases.length
            },
            nextActionCard: {
                title: '规则决策已记录 → 调 build_table_draft 展示表候选',
                stopAfter: false,
                instruction: '规则阶段凭证已写入。下一步调用 build_table_draft 获取仅包含项目表候选的确认卡；禁止直接写 rule-pool.json。',
                onContinueCallTemplate: `build_table_draft(${JSON.stringify({ projectPath: options.projectPath || '', decisionDraftId })})`
            },
            allowedNextActions: ['call_build_table_draft'],
            forbiddenActions: ['write_rule_pool_json_directly', 'set_rule_pool_confirmed_true_manually']
        };
    }

    buildTableDraft(options = {}) {
        const paths = options.paths || {};
        const decisionDraftId = String(options.decisionDraftId || '').trim();
        if (!decisionDraftId) return this._blocked('REQUIREMENT_RULE_POOL_TABLE_DRAFT_ID_MISSING', '缺少 decisionDraftId，无法生成表候选确认卡。');
        const draftLoad = this._loadDraftReceipt(paths, decisionDraftId);
        if (!draftLoad.ok) return draftLoad;
        const ruleStageLoad = this._loadRuleStageReceipt(paths, decisionDraftId);
        if (!ruleStageLoad.ok) return ruleStageLoad;
        const draft = draftLoad.draft;
        const tableCandidatesBeforeNexbot = Array.isArray(draft.tableCandidates) ? draft.tableCandidates : [];
        const nexbotEvidenceResult = this._attachNexbotSourceEvidence(
            tableCandidatesBeforeNexbot,
            options.nexbotSourceEvidence
        );
        const tableCandidates = nexbotEvidenceResult.candidates;
        if (nexbotEvidenceResult.changed) {
            draft.tableCandidates = tableCandidates;
            draft.nexbotSourceEvidence = nexbotEvidenceResult.acceptedEvidence;
            draft.nexbotSourceEvidenceUpdatedAt = new Date().toISOString();
            const draftHash = this._sha256(JSON.stringify(draft));
            draftLoad.draftReceipt.draft = draft;
            draftLoad.draftReceipt.draftHash = draftHash;
            this._writeJson(draftLoad.path, draftLoad.draftReceipt);
            // 规则阶段 receipt 只引用当前草案的 hash；来源说明是 Builder 的可审计附注，
            // 不改变规则决策，也不改变表候选集合，因此同步更新引用即可。
            if (ruleStageLoad.receipt && typeof ruleStageLoad.receipt === 'object') {
                ruleStageLoad.receipt.draftHash = draftHash;
                this._writeJson(ruleStageLoad.path, ruleStageLoad.receipt);
            }
        }
        const explicitTableNamesResult = this._normalizeExplicitTableNames(draft.userSupplementTableNames);
        if (!explicitTableNamesResult.ok) return explicitTableNamesResult;
        const explicitTableNames = explicitTableNamesResult.names;
        return {
            ok: true,
            status: 'awaiting_table_confirmation',
            actionMode: 'display_table_candidate_confirmation_card',
            decisionDraftId,
            requiredTableNames: explicitTableNames,
            confirmationCard: this._buildTableConfirmationCard(tableCandidates),
            tableCandidates: tableCandidates.map(item => this._slimTableCandidate(item)),
            nexbotSourceSummary: nexbotEvidenceResult.summary,
            nextActionCard: {
                title: '展示表候选确认卡给用户 → 等用户回复 → 调 submit_table_decision',
                userGate: true,
                stopAfter: true,
                instruction: `把 confirmationCard 字符串原样展示给用户，等用户回复后提交结构化 keptTableNames 数组或 dropAll=true，并把用户对表候选确认卡的原始回复原样放入 userInput。userInput 是后续审计字段，不能省略；禁止从用户原文解析规则决策。若首次调用未带 Nexbot 来源说明，可在展示卡片前用同一 decisionDraftId 可选重调并传入精确结果；Nexbot 不可用时直接展示当前卡片，不得等待或阻断。${explicitTableNames.length > 0 ? `用户已明确指定必须保留：${explicitTableNames.join('、')}；这些表必须出现在 keptTableNames，不能 dropAll。` : ''}`,
                onUserContinueCallTemplate: `submit_table_decision(${JSON.stringify({
                    projectPath: options.projectPath || '',
                    skillName: 'epoint-requirement-analyzer',
                    decisionDraftId,
                    keptTableNames: ['TEMPLATE_FILL_REQUIRED (保留表名数组；全部剔除时传空数组并设置 dropAll=true)'],
                    dropAll: false,
                    userInput: 'TEMPLATE_REQUIRED_RAW_USER_REPLY (用户对表候选确认卡的原始回复，必须原样透传，如：保留/全部剔除/保留 T1)'
                })})`
            },
            allowedNextActions: ['display_table_confirmationCard_to_user', 'call_submit_table_decision_after_user_reply'],
            forbiddenActions: ['write_rule_pool_json_directly', 'parse_userInput_for_table_decision']
        };
    }

    submitTableDecision(options = {}) {
        const paths = options.paths || {};
        const decisionDraftId = String(options.decisionDraftId || '').trim();
        const userInput = String(options.userInput || options.userDecision || '').trim();
        if (!decisionDraftId) return this._blocked('REQUIREMENT_RULE_POOL_SUBMIT_DRAFT_ID_MISSING', '缺少 decisionDraftId，无法提交表候选确认结果。');
        if (!Array.isArray(options.keptTableNames)) {
            return this._blocked('REQUIREMENT_RULE_POOL_TABLE_NAMES_REQUIRED', '缺少 keptTableNames 数组，无法提交表候选确认结果。');
        }
        const dropAll = options.dropAll === true;
        const keptTableNames = options.keptTableNames.map(name => String(name || '').trim()).filter(Boolean);
        if (dropAll && keptTableNames.length > 0) {
            return this._blocked('REQUIREMENT_RULE_POOL_TABLE_DECISION_CONFLICT', 'dropAll=true 时 keptTableNames 必须为空。');
        }
        const draftLoad = this._loadDraftReceipt(paths, decisionDraftId);
        if (!draftLoad.ok) return draftLoad;
        const ruleStageLoad = this._loadRuleStageReceipt(paths, decisionDraftId);
        if (!ruleStageLoad.ok) return ruleStageLoad;
        const draft = draftLoad.draft;
        const tableCandidates = Array.isArray(draft.tableCandidates) ? draft.tableCandidates : [];
        const explicitTableNamesResult = this._normalizeExplicitTableNames(draft.userSupplementTableNames);
        if (!explicitTableNamesResult.ok) return explicitTableNamesResult;
        const explicitTableNames = explicitTableNamesResult.names;
        if (tableCandidates.length > 0 && !userInput) {
            return this._blocked(
                'REQUIREMENT_RULE_POOL_TABLE_CONFIRMATION_USER_INPUT_MISSING',
                '表候选非空时，submit_table_decision 必须把用户对表候选确认卡的原始回复放入 userInput，例如 保留/全部剔除/保留 T1；禁止事后手写 rule-pool.json。'
            );
        }
        const tableCandidateByName = new Map();
        tableCandidates.forEach(item => {
            [item.tableName, item.entityName].map(value => String(value || '').trim()).filter(Boolean).forEach(name => tableCandidateByName.set(name, item));
        });
        const tableCandidateByNormalizedName = new Map();
        tableCandidates.forEach(item => {
            [item.tableName, item.entityName]
                .map(value => String(value || '').trim())
                .filter(Boolean)
                .forEach(name => tableCandidateByNormalizedName.set(name.toLowerCase(), item));
        });
        const unknown = keptTableNames.filter(name => !tableCandidateByName.has(name));
        if (unknown.length > 0) {
            return this._blocked('REQUIREMENT_RULE_POOL_TABLE_NAME_UNKNOWN', `keptTableNames 包含不在候选集内的表名/实体名：${unknown.join(', ')}`);
        }
        const keptTableKeys = new Set(dropAll ? [] : keptTableNames.map(name => this._tableKey(tableCandidateByName.get(name))).filter(Boolean));
        const missingRequiredTableNames = explicitTableNames.filter(name => {
            const candidate = tableCandidateByNormalizedName.get(name.toLowerCase());
            return !candidate || !keptTableKeys.has(this._tableKey(candidate));
        });
        if (missingRequiredTableNames.length > 0) {
            return this._blocked(
                'REQUIREMENT_RULE_POOL_EXPLICIT_TABLE_NOT_KEPT',
                `用户已明确指定必须使用的表，但本次表决策未保留：${missingRequiredTableNames.join('、')}。Builder 不会把明确要求的表静默剔除；请在 keptTableNames 中保留这些表，或重新生成草案修正指定表。`,
                {
                    requiredTableNames: explicitTableNames,
                    missingRequiredTableNames,
                    allowedNextActions: ['resubmit_table_decision_with_required_table_names'],
                    nextActionCard: {
                        title: '必须保留用户明确指定的表',
                        stopAfter: false,
                        instruction: '表候选决策未包含所有 userSupplementTableNames。请把 requiredTableNames 原样放入 keptTableNames，并使用新的 userInput 原文重调 req_table_decision_submit；不要设置 dropAll=true。',
                        requiredTableNames: explicitTableNames,
                        callTemplate: `req_table_decision_submit(${JSON.stringify({
                            projectPath: options.projectPath || '',
                            skillName: 'epoint-requirement-analyzer',
                            decisionDraftId,
                            keptTableNames: explicitTableNames,
                            dropAll: false,
                            userInput: 'TEMPLATE_REQUIRED_RAW_USER_REPLY'
                        })})`
                    }
                }
            );
        }
        const blockedTableKeys = new Set(tableCandidates.map(item => this._tableKey(item)).filter(key => key && !keptTableKeys.has(key)));
        const ruleCandidates = Array.isArray(draft.ruleCandidates) ? draft.ruleCandidates : [];
        const keptRuleAliases = new Set((ruleStageLoad.receipt.keptRuleAliases || []).map(alias => String(alias || '').trim()).filter(Boolean));
        const blockedRuleAliases = new Set((ruleStageLoad.receipt.blockedRuleAliases || []).map(alias => String(alias || '').trim()).filter(Boolean));
        const tableCandidateByKey = new Map(tableCandidates.map(item => [this._tableKey(item), item]).filter(([key]) => key));

        const storyRuleRecalls = (Array.isArray(draft.storyRuleRecalls) ? draft.storyRuleRecalls : []).map(entry => ({
            storyId: entry.storyId,
            userStory: entry.userStory,
            ruleSearchIntent: entry.ruleSearchIntent,
            recallInput: entry.recallInput || {},
            acceptedRules: (Array.isArray(entry.acceptedRules) ? entry.acceptedRules : [])
                .filter(rule => keptRuleAliases.has(this._ruleAlias(rule)) && !blockedRuleAliases.has(this._ruleAlias(rule))),
            baselineConstraints: Array.isArray(entry.baselineConstraints) ? entry.baselineConstraints : [],
            projectTableCandidates: (Array.isArray(entry.projectTableCandidates) ? entry.projectTableCandidates : [])
                .filter(item => keptTableKeys.has(this._tableKey(item)) && !blockedTableKeys.has(this._tableKey(item)))
                .map(item => this._stripCandidateFields(tableCandidateByKey.get(this._tableKey(item)) || item)),
            unresolvedSignals: Array.isArray(entry.unresolvedSignals) ? entry.unresolvedSignals : []
        }));

        const rulePool = {
            schemaVersion: 'requirement-rule-pool/v2',
            managedBy: 'requirement_rule_pool_builder',
            confirmed: true,
            userInputForGlobalPool: ruleStageLoad.receipt.userInput || '',
            tableCandidatePoolConfirmed: true,
            userInputForTableCandidatePool: userInput,
            userSupplementTableNames: explicitTableNames,
            globalWhitelist: ruleCandidates.filter(item => keptRuleAliases.has(this._ruleAlias(item))).map(item => this._stripCandidateFields(item)),
            globalBlocklist: ruleCandidates.filter(item => !keptRuleAliases.has(this._ruleAlias(item))).map(item => this._stripCandidateFields(item)),
            globalTableCandidateWhitelist: tableCandidates.filter(item => keptTableKeys.has(this._tableKey(item))).map(item => this._stripCandidateFields(item)),
            globalTableCandidateBlocklist: tableCandidates.filter(item => blockedTableKeys.has(this._tableKey(item))).map(item => this._stripCandidateFields(item)),
            storyRuleRecalls,
            builderDecision: {
                decisionDraftId,
                draftHash: draftLoad.draftReceipt.draftHash || '',
                ruleStageReceiptPath: ruleStageLoad.path,
                submittedAt: new Date().toISOString()
            }
        };
        const unresolvedSignals = this._collectUnresolvedSignals(storyRuleRecalls);
        const unresolvedSignalsByStory = this._collectUnresolvedSignalsByStory(storyRuleRecalls);

        this._writeJson(paths.rulePoolPath, rulePool);
        const rulePoolRaw = fs.readFileSync(paths.rulePoolPath, 'utf-8');
        const rulePoolHash = this._sha256(rulePoolRaw);
        const submitReceiptPath = path.join(paths.demandArtifactDir || path.dirname(paths.rulePoolPath || ''), 'rule-pool-submit-receipt.json');
        const submitReceipt = {
            schemaVersion: 'requirement-rule-pool-submit-receipt/v1',
            status: 'submitted',
            ok: true,
            decisionDraftId,
            draftHash: draftLoad.draftReceipt.draftHash || '',
            ruleStageReceiptPath: ruleStageLoad.path,
            rulePoolHash,
            userInputForGlobalPool: ruleStageLoad.receipt.userInput || '',
            userInputForTableCandidatePool: userInput,
            userSupplementTableNames: explicitTableNames,
            submittedAt: rulePool.builderDecision.submittedAt,
            rulePoolPath: paths.rulePoolPath || '',
            ruleRecallRawPath: paths.ruleRecallRawPath || ''
        };
        this._writeJson(submitReceiptPath, submitReceipt);
        rulePool.builderDecision.submitReceiptPath = submitReceiptPath;
        this._writeJson(paths.rulePoolPath, rulePool);
        const finalRulePoolRaw = fs.readFileSync(paths.rulePoolPath, 'utf-8');
        submitReceipt.rulePoolHash = this._sha256(finalRulePoolRaw);
        this._writeJson(submitReceiptPath, submitReceipt);

        this._writeRuleRecallRaw(paths.ruleRecallRawPath, {
            draft,
            rulePool,
            userInput: [ruleStageLoad.receipt.userInput || '', userInput].filter(Boolean).join('\n')
        });
        this._updateAnalysisState(paths.analysisStatePath, {
            decisionDraftId,
            rulePoolHash: submitReceipt.rulePoolHash,
            storyRuleRecalls,
            userInput: ruleStageLoad.receipt.userInput || '',
            tableUserInput: userInput,
            ruleCandidateCount: ruleCandidates.length,
            tableCandidateCount: tableCandidates.length
        });

        const summary = {
            keptRuleCount: rulePool.globalWhitelist.length,
            blockedRuleCount: rulePool.globalBlocklist.length,
            keptTableCandidateCount: rulePool.globalTableCandidateWhitelist.length,
            blockedTableCandidateCount: rulePool.globalTableCandidateBlocklist.length,
            explicitTableCount: explicitTableNames.length,
            unresolvedSignalCount: unresolvedSignals.length,
            unresolvedSignalNames: unresolvedSignals.map(item => item.signal).filter(Boolean).slice(0, 8)
        };
        const baseResult = {
            ok: true,
            decisionDraftId,
            rulePool: { written: true, path: paths.rulePoolPath, hash: submitReceipt.rulePoolHash },
            ruleRecallRaw: { written: true, path: paths.ruleRecallRawPath },
            receipt: { written: true, path: submitReceiptPath },
            summary,
            unresolvedSignals: unresolvedSignalsByStory,
            forbiddenActions: ['write_rule_pool_json_directly', 'set_rule_pool_confirmed_true_manually']
        };
        if (unresolvedSignalsByStory.length > 0) {
            baseResult.ruleGapAdvisory = this._buildRuleGapAdvisoryCard(unresolvedSignalsByStory);
        }
        const advisoryInstruction = unresolvedSignalsByStory.length > 0
            ? 'rule-pool.json 已落盘，unresolvedSignals 仅作为规则召回提示项保留，不阻断需求 finalize、设计或 Coder。后续阶段不得把这些提示伪造成已确认规则；如用户补充规则线索，可重跑规则池刷新提示。'
            : 'rule-pool.json 已落盘，可做 finalize 前自审并调用 req_finalize_artifacts。';
        return {
            ...baseResult,
            status: 'ready',
            actionMode: 'rule_pool_written_by_builder',
            nextActionCard: {
                title: '规则池已确认 — 可继续需求 finalize',
                userGate: false,
                stopAfter: false,
                instruction: advisoryInstruction
            },
            allowedNextActions: ['mark_analysis_state_done_when_other_requirement_steps_complete', 'call_req_finalize_artifacts']
        };
    }

    _collectUnresolvedSignals(storyRuleRecalls = []) {
        const bySignal = new Map();
        (Array.isArray(storyRuleRecalls) ? storyRuleRecalls : []).forEach(entry => {
            (Array.isArray(entry && entry.unresolvedSignals) ? entry.unresolvedSignals : []).forEach(item => {
                const signal = String(item && item.signal || '').trim();
                const fallbackKey = [
                    item && item.userAnchor,
                    item && item.usageDuty,
                    item && item.reason
                ].map(value => String(value || '').trim()).filter(Boolean).join('|');
                const key = signal || fallbackKey;
                if (!key || bySignal.has(key)) return;
                bySignal.set(key, {
                    signal,
                    userAnchor: String(item && item.userAnchor || '').trim(),
                    usageDuty: String(item && item.usageDuty || '').trim()
                });
            });
        });
        return Array.from(bySignal.values());
    }

    _collectUnresolvedSignalsByStory(storyRuleRecalls = []) {
        const byKey = new Map();
        (Array.isArray(storyRuleRecalls) ? storyRuleRecalls : []).forEach(entry => {
            const storyId = String(entry && entry.storyId || '').trim();
            const userStory = String(entry && entry.userStory || '').trim();
            (Array.isArray(entry && entry.unresolvedSignals) ? entry.unresolvedSignals : []).forEach(item => {
                const signal = String(item && item.signal || '').trim();
                const userAnchor = String(item && item.userAnchor || '').trim();
                const usageDuty = String(item && item.usageDuty || '').trim();
                const reason = String(item && item.reason || '').trim();
                const fallbackKey = [userAnchor, usageDuty, reason].filter(Boolean).join('|');
                const key = signal || fallbackKey;
                if (!key) return;
                const current = byKey.get(key) || {
                    signal,
                    userAnchor,
                    usageDuty,
                    reason,
                    source: String(item && item.source || '').trim(),
                    storyIds: [],
                    userStories: []
                };
                if (storyId && !current.storyIds.includes(storyId)) current.storyIds.push(storyId);
                if (userStory && !current.userStories.includes(userStory)) current.userStories.push(userStory);
                if (!current.signal && signal) current.signal = signal;
                if (!current.userAnchor && userAnchor) current.userAnchor = userAnchor;
                if (!current.usageDuty && usageDuty) current.usageDuty = usageDuty;
                if (!current.reason && reason) current.reason = reason;
                byKey.set(key, current);
            });
        });
        return Array.from(byKey.values());
    }

    _buildRuleGapAdvisoryCard(unresolvedSignals = []) {
        const lines = [];
        lines.push('规则召回提示');
        lines.push('─────────────────');
        lines.push('以下需求信号暂未匹配到专门公司规则，仅作为后续设计/Coder 的风险提示，不阻断需求 finalize、设计或编码。');
        lines.push('');
        lines.push('| 提示信号 | 影响 Story | 用户需求锚点 | 建议关注点 |');
        lines.push('|---|---|---|---|');
        (Array.isArray(unresolvedSignals) ? unresolvedSignals : []).forEach(item => {
            lines.push(`| ${this._mdCell(item.signal || '-')} | ${this._mdCell((item.storyIds || []).join(', ') || '-')} | ${this._mdCell(item.userAnchor || '-')} | ${this._mdCell(item.usageDuty || item.reason || '-')} |`);
        });
        lines.push('');
        lines.push('处理口径：继续按已确认规则、表候选和项目通用约束推进；不得把提示信号伪造成已确认规则，也不得手写删除 rule-pool.json 中的 unresolvedSignals。用户后续补充规则线索时，可重跑规则池刷新提示。');
        return lines.join('\n');
    }

    /**
     * 统一校验需求阶段规则池是否由 Builder 合法落盘：
     *   1. rule-pool.json 必须存在且可解析；
     *   2. rule-pool.json.managedBy 必须等于 'requirement_rule_pool_builder'（手写池一律 blocked）；
     *   3. 同目录下必须存在 rule-pool-submit-receipt.json；
     *   4. receipt 必须 ok=true 且 status='submitted'；
     *   5. receipt.rulePoolHash 必须等于当前 rule-pool.json 内容的 sha256，杜绝"先 submit 再手改"。
     * 任一失败统一返回 { ok:false, code, message }，调用方按错误码包装 blocked 响应。
     */
    validateSubmitReceipt(options = {}) {
        const rulePoolPath = String(options.rulePoolPath || '').trim();
        const receiptPath = String(options.receiptPath || '').trim();
        if (!rulePoolPath || !fs.existsSync(rulePoolPath)) {
            return { ok: false, code: 'REQUIREMENT_RULE_POOL_FILE_MISSING', message: `缺少 rule-pool.json：${rulePoolPath}` };
        }
        let rulePool = null;
        try {
            rulePool = JSON.parse(fs.readFileSync(rulePoolPath, 'utf-8'));
        } catch (error) {
            return { ok: false, code: 'REQUIREMENT_RULE_POOL_INVALID_JSON', message: `rule-pool.json 解析失败：${rulePoolPath}；${error.message}` };
        }
        if (!rulePool || rulePool.managedBy !== 'requirement_rule_pool_builder') {
            return {
                ok: false,
                code: 'REQUIREMENT_RULE_POOL_BUILDER_RECEIPT_REQUIRED',
                message: 'rule-pool.json 不是由 Builder 落盘（缺少 managedBy=requirement_rule_pool_builder）。请重新走 req_rule_pool_build_rule_draft → 规则确认 → req_rule_decision_submit → req_rule_pool_build_table_draft → 表确认 → req_table_decision_submit，禁止手写规则池。'
            };
        }
        if (!receiptPath || !fs.existsSync(receiptPath)) {
            return { ok: false, code: 'REQUIREMENT_RULE_POOL_SUBMIT_RECEIPT_MISSING', message: `缺少 Builder 提交凭证：${receiptPath}` };
        }
        const receiptRead = this._readJson(receiptPath);
        if (!receiptRead.ok) {
            return { ok: false, code: 'REQUIREMENT_RULE_POOL_SUBMIT_RECEIPT_INVALID', message: `Builder 提交凭证无法解析：${receiptPath}` };
        }
        const receipt = receiptRead.value || {};
        if (receipt.ok !== true || String(receipt.status || '') !== 'submitted') {
            return { ok: false, code: 'REQUIREMENT_RULE_POOL_SUBMIT_RECEIPT_NOT_READY', message: `Builder 提交凭证未处于 submitted 状态：${receiptPath}` };
        }
        const raw = fs.readFileSync(rulePoolPath, 'utf-8');
        const currentHash = this._sha256(raw);
        if (String(receipt.rulePoolHash || '') !== currentHash) {
            return { ok: false, code: 'REQUIREMENT_RULE_POOL_SUBMIT_RECEIPT_HASH_MISMATCH', message: 'rule-pool.json 与 Builder 提交凭证 hash 不一致，请重新提交规则池决策。', currentHash, receiptHash: receipt.rulePoolHash || '' };
        }
        return { ok: true, receipt, currentHash };
    }

    _extractStories(analysisState = {}, markdown = '', paths = {}) {
        const storiesRead = this._readJson(paths.storiesPath);
        if (storiesRead.ok && storiesRead.value && Array.isArray(storiesRead.value.stories)) {
            const seenStories = new Set();
            const stories = storiesRead.value.stories
                .map(story => ({
                    storyId: String(story.storyId || '').trim().toUpperCase(),
                    userStory: String(story.userStory || story.value || '').trim(),
                    // 关键修复：透传 acceptanceCriteria 和 invariants 给 _buildRuleSearchIntent
                    // 故事线：早期版本只读 storyId/userStory，把 GWT 三组（每条 scenario/given/when/then）
                    // 和 invariants 全部丢弃，导致意图检索文本只剩一句话叙事，匹配能力低到只能命中
                    // userStory 偶然出现的关键词。修法：直接把 stories.json 里冻结的 acceptanceCriteria
                    // 和 invariants 透传出来，由 _buildRuleSearchIntent 展开进意图文本。
                    acceptanceCriteria: (story.acceptanceCriteria && typeof story.acceptanceCriteria === 'object' && !Array.isArray(story.acceptanceCriteria))
                        ? {
                            happyPath: Array.isArray(story.acceptanceCriteria.happyPath) ? story.acceptanceCriteria.happyPath : [],
                            exception: Array.isArray(story.acceptanceCriteria.exception) ? story.acceptanceCriteria.exception : [],
                            boundary: Array.isArray(story.acceptanceCriteria.boundary) ? story.acceptanceCriteria.boundary : []
                        }
                        : { happyPath: [], exception: [], boundary: [] },
                    invariants: Array.isArray(story.invariants) ? story.invariants : [],
                    codingFactHandoff: Array.isArray(story.codingFactHandoff) ? story.codingFactHandoff : [],
                    statisticsIntent: (story.statisticsIntent && typeof story.statisticsIntent === 'object' && !Array.isArray(story.statisticsIntent))
                        ? story.statisticsIntent
                        : null,
                    workflowIntent: (story.workflowIntent && typeof story.workflowIntent === 'object' && !Array.isArray(story.workflowIntent))
                        ? story.workflowIntent
                        : null
                }))
                .filter(story => {
                    if (!story.storyId || !story.userStory || seenStories.has(story.storyId)) return false;
                    seenStories.add(story.storyId);
                    return true;
                });
            if (stories.length > 0) return stories;
        }

        const markdownStories = this.requirementRulePoolService && typeof this.requirementRulePoolService.extractUserStories === 'function'
            ? this.requirementRulePoolService.extractUserStories(null, markdown)
            : [];
        const byId = new Map(markdownStories.map(story => [String(story.storyId || '').trim().toUpperCase(), story]));
        const stateIds = Array.isArray(analysisState && analysisState.storyIds)
            ? analysisState.storyIds.map(id => String(id || '').trim().toUpperCase()).filter(Boolean)
            : [];
        const ids = stateIds.length > 0 ? stateIds : markdownStories.map(story => String(story.storyId || '').trim().toUpperCase()).filter(Boolean);
        const seen = new Set();
        return ids
            .filter(id => {
                if (!id || seen.has(id)) return false;
                seen.add(id);
                return true;
            })
            .map(id => {
                const fromMarkdown = byId.get(id) || {};
                return {
                    storyId: id,
                    userStory: String(fromMarkdown.userStory || fromMarkdown.value || id).trim(),
                    // markdown 兜底路径没有 acceptanceCriteria/invariants（早期 demand 里也读不到），
                    // 给空对象保证 _buildRuleSearchIntent 不报错。
                    acceptanceCriteria: { happyPath: [], exception: [], boundary: [] },
                    invariants: [],
                    codingFactHandoff: [],
                    statisticsIntent: null,
                    workflowIntent: null
                };
            });
    }

    _extractConfirmedDecisions(analysisState = {}) {
        const result = [];
        const visit = (value, options = {}) => {
            if (!value) return;
            if (Array.isArray(value)) {
                value.forEach(item => visit(item, options));
                return;
            }
            if (typeof value !== 'object') return;
            const status = String(value.status || value.confirmStatus || '').trim().toLowerCase();
            const isAmbiguityPoint = options.ambiguityPoint === true;
            if (isAmbiguityPoint && status && !['confirmed', 'done', 'completed', '已确认', '已完成'].includes(status)) {
                return;
            }
            const fuzzyPoint = String(value.fuzzyPoint || value.question || value.title || value.aspect || '').trim();
            const userChoice = String(value.userChoice || value.choice || value.selectedOption || '').trim();
            const businessDecision = String(
                value.businessDecision
                || value.businessDecisionSummary
                || value.businessConclusion
                || value.cleanBusinessDecision
                || ''
            ).trim();
            const flowImpact = String(
                value.flowImpact
                || value.businessFlowImpact
                || value.processImpact
                || ''
            ).trim();
            const adoptedSolution = String(
                value.adoptedSolution
                || value.solution
                || value.answer
                || value.confirmedAnswer
                || value.selectedAnswer
                || value.userAnswer
                || value.reason
                || ''
            ).trim();
            const legacyUserInput = String(value.userInput || '').trim();
            const rawUserReply = String(value.rawUserReply || value.userReply || value.originalAnswer || '').trim();
            const cleanDecisionText = [businessDecision, flowImpact].filter(Boolean).join('；')
                || adoptedSolution
                || legacyUserInput;
            if (cleanDecisionText) {
                result.push({
                    fuzzyPoint,
                    userChoice,
                    ...(businessDecision ? { businessDecision } : {}),
                    ...(flowImpact ? { flowImpact } : {}),
                    adoptedSolution: cleanDecisionText,
                    rawUserReply
                });
            }
            if (Object.prototype.hasOwnProperty.call(value, 'decisions')) visit(value.decisions, options);
            if (Object.prototype.hasOwnProperty.call(value, 'decision')) visit(value.decision, options);
        };
        visit(analysisState.ambiguityPoints, { ambiguityPoint: true });
        visit(analysisState.ambiguityCards, { ambiguityPoint: true });
        visit(analysisState.decisions);
        visit(analysisState.confirmedDecisions);
        visit(analysisState.units);
        const seen = new Set();
        return result.filter(item => {
            const key = [item.fuzzyPoint, item.userChoice, item.businessDecision, item.flowImpact, item.adoptedSolution].join('\n');
            if (!String(item.adoptedSolution || '').trim() || seen.has(key)) return false;
            seen.add(key);
            return true;
        });
    }

    /**
     * 构造 Story 级规则召回意图文本。
     *
     * 输入字段（来自 stories.json）：
     *   - storyId / userStory（一句话叙事）
     *   - acceptanceCriteria.{happyPath, exception, boundary}（GWT 三组，每条 scenario/given/when/then）
     *   - invariants（不变量列表）
     *   - codingFactHandoff（规则/scan无法稳定推出的额外已确认事实）
     *   - statisticsIntent / workflowIntent（统计口径、工作流业务事实包）
     *
     * 故事线：早期版本只取 `User Story ${storyId}\n${userStory}` 进意图——
     * 用户提了"代码项配置"等关键决策、需求里写了完整 BDD GWT 三组、Story 自带不变量，
     * 全都没进检索。结果意图文本只有 ~10 个字符，匹配能力弱到只能命中"窗口"等 LLM
     * 偶然写在 userStory 一句话里的关键词；规则库里"代码项/SelectItem/下拉列表/DataGrid"
     * 等关键规则全部漏召。
     *
     * 修法：把 GWT 三组（scenario/given/when/then）+ invariants 全部展开进意图文本。
     * 这是 Builder-owned 衍生事实（stories.json 已经冻结），不引入 LLM 决策，
     * 不改任何上游产物 schema，纯内部召回信号增强。
     *
     * 设计取舍：
     *   - 不去重 / 不切词：纯字面量召回（diagnostics.scoringEngine='pure_like_recall_v1'），
     *     重复短语反而能让多 GWT 共享的关键词得到更高得分（命中次数 = 多次匹配）
     *   - 不引入 stop words：用户回复里"代码项""DataGrid"这种短词不能被当成停用词丢掉
     *   - 容错：所有 .map / Array.isArray 防御 stories.json 里 GWT 字段缺失（比如 boundary 为空）
     */
    _buildRuleSearchIntent(story = {}, decisions = [], userSupplement = '') {
        const lines = [
            `User Story ${story.storyId}`,
            story.userStory
        ].filter(Boolean);

        // GWT 三组：每条 scenario/given/when/then 全部展开进意图
        const ac = story && story.acceptanceCriteria && typeof story.acceptanceCriteria === 'object'
            ? story.acceptanceCriteria
            : {};
        const renderGwtItem = (item) => {
            if (!item || typeof item !== 'object') return '';
            return [item.scenario, item.given, item.when, item.then]
                .map(v => String(v || '').trim())
                .filter(Boolean)
                .join(' / ');
        };
        const groups = [
            { label: 'happyPath', items: Array.isArray(ac.happyPath) ? ac.happyPath : [] },
            { label: 'exception', items: Array.isArray(ac.exception) ? ac.exception : [] },
            { label: 'boundary', items: Array.isArray(ac.boundary) ? ac.boundary : [] }
        ];
        groups.forEach(g => {
            const rendered = g.items.map(renderGwtItem).filter(Boolean);
            if (rendered.length > 0) {
                lines.push(`AC ${g.label}:`);
                rendered.forEach((text, idx) => lines.push(`  ${idx + 1}. ${text}`));
            }
        });

        // invariants（不变量）：业务规则隐含约束，常含命名/校验/状态等关键词
        const invariants = Array.isArray(story.invariants)
            ? story.invariants.map(v => String(v || '').trim()).filter(Boolean)
            : [];
        if (invariants.length > 0) {
            lines.push('invariants:');
            invariants.forEach((text, idx) => lines.push(`  ${idx + 1}. ${text}`));
        }

        const codingFactParts = this._codingFactHandoffIntentParts(story.codingFactHandoff);
        if (codingFactParts.length > 0) {
            lines.push('codingFactHandoff:');
            codingFactParts.forEach((text, idx) => lines.push(`  ${idx + 1}. ${text}`));
        }

        const statisticsIntentParts = this._structuredIntentParts(story.statisticsIntent);
        if (statisticsIntentParts.length > 0) {
            lines.push('statisticsIntent:');
            statisticsIntentParts.forEach((text, idx) => lines.push(`  ${idx + 1}. ${text}`));
        }

        const workflowIntentParts = this._workflowIntentParts(story.workflowIntent);
        if (workflowIntentParts.length > 0) {
            lines.push('workflowIntent:');
            workflowIntentParts.forEach((text, idx) => lines.push(`  ${idx + 1}. ${text}`));
        }

        const companyMechanismAliases = this._companyMechanismAliasIntentParts([
            ...lines,
            ...codingFactParts,
            ...statisticsIntentParts,
            ...workflowIntentParts
        ], { hasWorkflowIntent: workflowIntentParts.length > 0 });
        if (companyMechanismAliases.length > 0) {
            lines.push('companyMechanismAliases:');
            companyMechanismAliases.forEach((text, idx) => lines.push(`  ${idx + 1}. ${text}`));
        }

        if (decisions.length > 0) {
            lines.push('已确认模糊点结论：');
            decisions.forEach((decision, index) => {
                const cleanParts = [
                    decision.fuzzyPoint,
                    decision.userChoice,
                    decision.businessDecision,
                    decision.flowImpact
                ].filter(Boolean);
                if (!decision.businessDecision && !decision.flowImpact) {
                    cleanParts.push(decision.adoptedSolution);
                }
                lines.push(`${index + 1}. ${cleanParts.filter(Boolean).join(' / ')}`);
            });
        }
        const supplement = String(userSupplement || '').trim();
        if (supplement) {
            lines.push('用户补充候选线索：');
            lines.push(supplement);
        }
        return lines.join('\n');
    }

    _codingFactHandoffIntentParts(codingFactHandoff = []) {
        const parts = [];
        if (!Array.isArray(codingFactHandoff)) return parts;
        codingFactHandoff.forEach(item => {
            if (!item || typeof item !== 'object' || Array.isArray(item)) return;
            this._pushIntentText(parts, item.factType);
            this._pushIntentText(parts, item.description);
            this._pushIntentText(parts, item.confirmedFacts);
        });
        return parts;
    }

    _workflowIntentParts(intent = null) {
        const parts = this._structuredIntentParts(intent);
        if (parts.length === 0) return parts;
        this._pushIntentText(parts, '公司工作流机制');
        this._pushIntentText(parts, '审批 流转 待办 审批意见 流程历史 提交 同意 退回 拒绝');
        return parts;
    }

    _structuredIntentParts(value = null) {
        const parts = [];
        const visit = (item) => {
            if (item === null || typeof item === 'undefined') return;
            if (Array.isArray(item)) {
                item.forEach(visit);
                return;
            }
            if (typeof item === 'object') {
                Object.values(item).forEach(visit);
                return;
            }
            this._pushIntentText(parts, item);
        };
        visit(value);
        return parts;
    }

    _companyMechanismAliasIntentParts(textParts = [], options = {}) {
        const joined = (Array.isArray(textParts) ? textParts : [])
            .map(value => String(value || '').trim())
            .filter(Boolean)
            .join('\n');
        const parts = [];
        if (/公司列表分页|分页边界|结果集分页|首页|末页|超出页码|筛选后.*空结果|company_mechanism\.list_pagination/i.test(joined)) {
            [
                '公司列表分页机制',
                'mini-datagrid showPager=true action=getDataGridData',
                'DataGridModel fetchData first pageSize sortField sortOrder',
                'PageData rowCount list paginatorList findListPageList',
                '查询刷新 epoint.refresh datagrid fui-form'
            ].forEach(text => this._pushIntentText(parts, text));
        }
        if (options.hasWorkflowIntent === true) {
            [
                '公司工作流机制',
                'workflow process approval task todo submit approve return reject',
                '流程待办 审批意见 流程历史 节点流转'
            ].forEach(text => this._pushIntentText(parts, text));
        }
        return parts;
    }

    _filterRulesByAuthoritativeStoryEvidence(story = {}, acceptedRules = [], userSupplement = '') {
        const rules = Array.isArray(acceptedRules) ? acceptedRules : [];
        const workflowIntent = story && story.workflowIntent;
        const hasWorkflowIntent = Boolean(
            workflowIntent
            && typeof workflowIntent === 'object'
            && !Array.isArray(workflowIntent)
            && String(workflowIntent.processName || '').trim()
        );
        const explicitTechnicalEvidence = [
            String(userSupplement || '').trim(),
            ...this._codingFactHandoffIntentParts(story && story.codingFactHandoff)
        ].filter(Boolean).join('\n');
        return rules.filter(rule => {
            const alias = this._ruleAlias(rule);
            if (/SqlConditionUtil/iu.test(alias)) {
                return /SqlConditionUtil/iu.test(explicitTechnicalEvidence);
            }
            if (/工作流.*(?:规范|生成)|workflow/iu.test(alias)) {
                return hasWorkflowIntent;
            }
            return true;
        });
    }

    _pushIntentText(parts = [], value = null) {
        if (value === null || typeof value === 'undefined') return;
        if (Array.isArray(value)) {
            value.forEach(item => this._pushIntentText(parts, item));
            return;
        }
        if (typeof value === 'object') {
            const text = [value.name, value.title, value.action, value.businessResult, value.description]
                .map(item => String(item || '').trim())
                .filter(Boolean)
                .join(' / ');
            if (text) parts.push(text);
            return;
        }
        const text = String(value || '').trim();
        if (text) parts.push(text);
    }

    _dedupeRules(storyRuleRecalls = []) {
        const byAlias = new Map();
        storyRuleRecalls.forEach(entry => {
            (Array.isArray(entry.acceptedRules) ? entry.acceptedRules : []).forEach(rule => {
                const alias = this._ruleAlias(rule);
                if (!alias) return;
                if (!byAlias.has(alias)) {
                    byAlias.set(alias, {
                        ...rule,
                        candidateId: '',
                        ruleAlias: alias,
                        sourceStoryIds: [],
                        matchReasons: [],
                        matchedKeywords: []
                    });
                }
                const target = byAlias.get(alias);
                if (entry.storyId && !target.sourceStoryIds.includes(entry.storyId)) target.sourceStoryIds.push(entry.storyId);
                const reason = String(rule.matchReason || '').trim();
                if (reason && !target.matchReasons.includes(reason)) target.matchReasons.push(reason);
                (Array.isArray(rule.matchedKeywords) ? rule.matchedKeywords : []).forEach(keyword => {
                    const text = String(keyword || '').trim();
                    if (text && !target.matchedKeywords.includes(text)) target.matchedKeywords.push(text);
                });
            });
        });
        return [...byAlias.values()].map((item, index) => ({
            ...item,
            candidateId: `R${index + 1}`
        }));
    }

    _dedupeTableCandidates(storyRuleRecalls = []) {
        const byKey = new Map();
        storyRuleRecalls.forEach(entry => {
            (Array.isArray(entry.projectTableCandidates) ? entry.projectTableCandidates : []).forEach(table => {
                const key = this._tableKey(table);
                if (!key) return;
                if (!byKey.has(key)) {
                    byKey.set(key, {
                        ...table,
                        candidateId: '',
                        sourceStoryIds: [],
                        primaryOwnerStoryIds: [],
                        triggerStoryIds: [],
                        weakRelatedStoryIds: [],
                        matchedTerms: Array.isArray(table.matchedTerms) ? table.matchedTerms.slice(0) : [],
                        matchReasons: [],
                        ...(Array.isArray(table.productSourceEvidence) && table.productSourceEvidence.length > 0
                            ? { productSourceEvidence: table.productSourceEvidence.slice(0) }
                            : {}),
                        score: Number(table.score || 0)
                    });
                }
                const target = byKey.get(key);
                if (entry.storyId && !target.sourceStoryIds.includes(entry.storyId)) target.sourceStoryIds.push(entry.storyId);
                this._classifyTableCandidateStoryRelation(entry, table).forEach((bucket, storyId) => {
                    if (!target[bucket].includes(storyId)) target[bucket].push(storyId);
                });
                (Array.isArray(table.sourceStoryIds) ? table.sourceStoryIds : []).forEach(storyId => {
                    const text = String(storyId || '').trim();
                    if (text && !target.sourceStoryIds.includes(text)) target.sourceStoryIds.push(text);
                });
                (Array.isArray(table.matchedTerms) ? table.matchedTerms : []).forEach(term => {
                    const text = String(term || '').trim();
                    if (text && !target.matchedTerms.includes(text)) target.matchedTerms.push(text);
                });
                (Array.isArray(table.matchReasons) ? table.matchReasons : []).forEach(reason => {
                    const text = String(reason || '').trim();
                    if (text && !target.matchReasons.includes(text)) target.matchReasons.push(text);
                });
                const matchReason = String(table.matchReason || '').trim();
                if (matchReason && !target.matchReasons.includes(matchReason)) target.matchReasons.push(matchReason);
                (Array.isArray(table.productSourceEvidence) ? table.productSourceEvidence : []).forEach(evidence => {
                    const key = this._nexbotEvidenceKey(evidence);
                    const existingEvidence = Array.isArray(target.productSourceEvidence) ? target.productSourceEvidence : [];
                    if (key && !existingEvidence.some(item => this._nexbotEvidenceKey(item) === key)) {
                        target.productSourceEvidence = [...existingEvidence, evidence];
                    }
                });
                if (Number(table.score || 0) > Number(target.score || 0)) target.score = Number(table.score || 0);
            });
        });
        return [...byKey.values()]
            .map(item => {
                const matchReasons = Array.isArray(item.matchReasons) ? item.matchReasons.filter(Boolean) : [];
                if (matchReasons.length === 0) {
                    matchReasons.push(this._buildMechanicalTableMatchReason(item));
                }
                const candidateRole = this._resolveTableCandidateRole(item);
                return {
                    ...item,
                    candidateRole,
                    matchReasons
                };
            })
            .sort((a, b) => Number(b.score || 0) - Number(a.score || 0) || String(a.tableName || a.entityName || '').localeCompare(String(b.tableName || b.entityName || ''), 'zh-Hans-CN'))
            .map((item, index) => ({
                ...item,
                candidateId: `T${index + 1}`
            }));
    }

    _classifyTableCandidateStoryRelation(entry = {}, table = {}) {
        const out = new Map();
        const storyId = String(entry.storyId || '').trim().toUpperCase();
        if (!storyId) return out;
        const userStory = String(entry.userStory || '').trim();
        const intent = String(entry.ruleSearchIntent || '').trim();
        const terms = Array.isArray(table.matchedTerms) ? table.matchedTerms.join(' ') : '';
        const text = `${userStory}\n${intent}`;
        const tableSignal = `${table.tableName || ''} ${table.entityName || ''} ${table.tableDisplayName || ''} ${terms}`;
        const isLogCandidate = /(log|日志|调用记录|调用日志|接口调用|审计|追溯)/iu.test(tableSignal);
        const hasPersistenceGoal = /(记录|保存|存储|留痕|审计|追溯).{0,20}(调用|日志|记录|入参|出参|结果|情况)|调用.{0,12}(记录|日志|审计|追溯)/iu.test(userStory);
        const hasTriggerDuty = /(必须|需要|应当|自动).{0,12}(记录|写入|保存).{0,12}(调用|日志|记录)|调用.{0,12}(必须|需要|应当).{0,12}(记录|写入|保存)/iu.test(text);
        if (isLogCandidate && hasPersistenceGoal) {
            out.set(storyId, 'primaryOwnerStoryIds');
        } else if (isLogCandidate && hasTriggerDuty) {
            out.set(storyId, 'triggerStoryIds');
        } else {
            out.set(storyId, 'weakRelatedStoryIds');
        }
        return out;
    }

    _resolveTableCandidateRole(item = {}) {
        const primary = Array.isArray(item.primaryOwnerStoryIds) ? item.primaryOwnerStoryIds : [];
        const triggers = Array.isArray(item.triggerStoryIds) ? item.triggerStoryIds : [];
        const weak = Array.isArray(item.weakRelatedStoryIds) ? item.weakRelatedStoryIds : [];
        if (primary.length > 0 && (triggers.length > 0 || weak.length > 0)) return 'side_effect_carrier';
        if (primary.length > 0) return 'primary_persistence_candidate';
        if (triggers.length > 0) return 'triggered_side_effect_candidate';
        return 'weak_related_candidate';
    }

    _buildRuleConfirmationCard(ruleCandidates = []) {
        const lines = [];
        lines.push('规则候选确认');
        lines.push('─────────────────');
        lines.push('Builder 已按 User Story 完成业务规则召回汇总。请确认哪些业务规则进入后续设计评估。');
        lines.push('');
        lines.push('业务规则候选：');
        if (ruleCandidates.length === 0) {
            lines.push('- 无业务规则候选。');
        } else {
            lines.push('| ID | 规则 | 来源 Story | 命中依据 |');
            lines.push('|---|---|---|---|');
            ruleCandidates.forEach(item => {
                lines.push(`| ${item.candidateId} | ${item.ruleAlias || item.ruleName || ''} | ${(item.sourceStoryIds || []).join(', ') || '-'} | ${(item.matchReasons || []).join('；') || (item.matchedKeywords || []).join('、') || '-'} |`);
            });
        }
        lines.push('');
        lines.push('回复方式：明确给出要保留的规则别名；系统后续只接受结构化 keptRuleAliases。');
        return lines.join('\n');
    }

    _normalizeNexbotSourceEvidence(value) {
        if (!Array.isArray(value)) return [];
        const seen = new Set();
        const out = [];
        value.forEach(item => {
            if (!item || typeof item !== 'object' || Array.isArray(item)) return;
            const tableName = this._compactNexbotText(item.tableName, 200);
            const entityName = this._compactNexbotText(item.entityName, 200);
            const queryType = this._compactNexbotText(item.queryType, 32).toLowerCase();
            const query = this._compactNexbotText(item.query, 300);
            const result = this._compactNexbotText(item.result, 800);
            if (!tableName || !query || !result || !['search_symbol', 'search_code'].includes(queryType)) return;
            const normalized = {
                tableName,
                ...(entityName ? { entityName } : {}),
                ...(this._compactNexbotText(item.product, 120) ? { product: this._compactNexbotText(item.product, 120) } : {}),
                ...(this._compactNexbotText(item.version, 80) ? { version: this._compactNexbotText(item.version, 80) } : {}),
                queryType,
                query,
                result
            };
            const key = this._nexbotEvidenceKey(normalized);
            if (!key || seen.has(key)) return;
            seen.add(key);
            out.push(normalized);
        });
        return out;
    }

    _attachNexbotSourceEvidence(tableCandidates = [], rawEvidence) {
        const supplied = typeof rawEvidence !== 'undefined';
        const evidence = this._normalizeNexbotSourceEvidence(rawEvidence);
        const candidates = (Array.isArray(tableCandidates) ? tableCandidates : []).map(item => ({
            ...item,
            matchReasons: Array.isArray(item && item.matchReasons) ? item.matchReasons.slice(0) : [],
            ...(Array.isArray(item && item.productSourceEvidence)
                ? { productSourceEvidence: item.productSourceEvidence.slice(0) }
                : {})
        }));
        const acceptedEvidence = [];
        let changed = false;
        let matchedCount = 0;
        let ignoredCount = 0;
        evidence.forEach(item => {
            let matched = false;
            candidates.forEach(candidate => {
                if (!this._nexbotEvidenceMatchesCandidate(candidate, item)) return;
                matched = true;
                const existing = Array.isArray(candidate.productSourceEvidence) ? candidate.productSourceEvidence : [];
                const evidenceKey = this._nexbotEvidenceKey(item);
                if (!existing.some(value => this._nexbotEvidenceKey(value) === evidenceKey)) {
                    candidate.productSourceEvidence = [...existing, item];
                    changed = true;
                }
                const note = this._formatNexbotSourceEvidence([item]);
                if (note && !candidate.matchReasons.includes(note)) {
                    candidate.matchReasons.push(note);
                    changed = true;
                }
            });
            if (matched) {
                matchedCount += 1;
                acceptedEvidence.push(item);
            } else {
                ignoredCount += 1;
            }
        });
        let status = 'not_requested';
        if (supplied && evidence.length === 0) status = 'unavailable_or_empty';
        else if (supplied && matchedCount > 0) status = 'matched';
        else if (supplied) status = 'no_candidate_match';
        return {
            candidates,
            acceptedEvidence,
            changed,
            summary: {
                status,
                nonBlocking: true,
                suppliedCount: evidence.length,
                matchedCount,
                ignoredCount,
                message: status === 'matched'
                    ? 'Nexbot 结果仅作为已有表候选的产品源码来源说明，仍需用户确认是否复用。'
                    : 'Nexbot 未提供可匹配的产品表结果；继续按原表候选确认流程，不阻断。'
            }
        };
    }

    _nexbotEvidenceMatchesCandidate(candidate = {}, evidence = {}) {
        const candidateTableName = this._compactNexbotText(candidate.tableName, 200).toLowerCase();
        const candidateEntityName = this._compactNexbotText(candidate.entityName, 200).toLowerCase();
        const evidenceTableName = this._compactNexbotText(evidence.tableName, 200).toLowerCase();
        const evidenceEntityName = this._compactNexbotText(evidence.entityName, 200).toLowerCase();
        return (evidenceTableName && candidateTableName === evidenceTableName)
            || (evidenceEntityName && candidateEntityName === evidenceEntityName);
    }

    _nexbotEvidenceKey(value = {}) {
        const fields = [
            value && value.tableName,
            value && value.entityName,
            value && value.queryType,
            value && value.query,
            value && value.result
        ].map(item => this._compactNexbotText(item, 800).toLowerCase());
        return fields.some(Boolean) ? fields.join('|') : '';
    }

    _formatNexbotSourceEvidence(evidence = []) {
        const values = Array.isArray(evidence) ? evidence : [];
        if (values.length === 0) return '-';
        return values.map(item => {
            const productVersion = [item && item.product, item && item.version]
                .map(value => this._compactNexbotText(value, 120))
                .filter(Boolean)
                .join(' ');
            const queryType = this._compactNexbotText(item && item.queryType, 32);
            const query = this._compactNexbotText(item && item.query, 300);
            const result = this._compactNexbotText(item && item.result, 800);
            return `产品源码查询结果：${[productVersion, queryType && `${queryType}(${query})`, result].filter(Boolean).join('；')}`;
        }).join('；');
    }

    _compactNexbotText(value, maxLength = 200) {
        return String(value == null ? '' : value)
            .replace(/\s+/gu, ' ')
            .trim()
            .slice(0, maxLength);
    }

    _buildTableConfirmationCard(tableCandidates = []) {
        const lines = [];
        lines.push('项目表候选确认');
        lines.push('─────────────────');
        lines.push('Builder 已按 User Story 完成项目表候选汇总。请确认哪些项目表进入后续设计评估。');
        lines.push('');
        lines.push('项目表候选：');
        if (tableCandidates.length === 0) {
            lines.push('- 无项目表候选。');
        } else {
            lines.push('| ID | 表名 | 实体名 | 说明 | 来源 Story | 命中词 | 命中原因 | 产品源码查询结果 |');
            lines.push('|---|---|---|---|---|---|---|---|');
            tableCandidates.forEach(item => {
                lines.push(`| ${this._mdCell(item.candidateId)} | ${this._mdCell(item.tableName || '-')} | ${this._mdCell(item.entityName || '-')} | ${this._mdCell(item.tableDisplayName || item.role || '-')} | ${this._mdCell((item.sourceStoryIds || []).join(', ') || '-')} | ${this._mdCell((item.matchedTerms || []).join('、') || '-')} | ${this._mdCell((item.matchReasons || []).join('；') || '-')} | ${this._mdCell(this._formatNexbotSourceEvidence(item.productSourceEvidence))} |`);
            });
        }
        lines.push('');
        lines.push('回复方式：明确给出要保留的表名；全部剔除时明确说明。系统后续只接受结构化 keptTableNames/dropAll。');
        return lines.join('\n');
    }

    _loadDraftReceipt(paths = {}, decisionDraftId = '') {
        const draftReceiptPath = path.join(paths.demandArtifactDir || path.dirname(paths.rulePoolPath || ''), 'rule-pool-draft-receipt.json');
        const receiptRead = this._readJson(draftReceiptPath);
        if (!receiptRead.ok) {
            return this._blocked('REQUIREMENT_RULE_POOL_DRAFT_RECEIPT_MISSING', `缺少规则池草案凭证：${draftReceiptPath}`);
        }
        const draftReceipt = receiptRead.value || {};
        if (String(draftReceipt.decisionDraftId || '').trim() !== String(decisionDraftId || '').trim()) {
            return this._blocked('REQUIREMENT_RULE_POOL_DRAFT_ID_MISMATCH', '提交的 decisionDraftId 与最新草案凭证不一致，请重新生成规则池草案。');
        }
        const draft = draftReceipt.draft || {};
        if (!draft || typeof draft !== 'object' || Array.isArray(draft)) {
            return this._blocked('REQUIREMENT_RULE_POOL_DRAFT_INVALID', '规则池草案凭证缺少 draft，无法提交。');
        }
        return { ok: true, draftReceipt, draft, path: draftReceiptPath };
    }

    _ruleStageReceiptPath(paths = {}) {
        return path.join(paths.demandArtifactDir || path.dirname(paths.rulePoolPath || ''), 'rule-pool-rule-stage-receipt.json');
    }

    _loadRuleStageReceipt(paths = {}, decisionDraftId = '') {
        const receiptPath = this._ruleStageReceiptPath(paths);
        const receiptRead = this._readJson(receiptPath);
        if (!receiptRead.ok) {
            return this._blocked('REQUIREMENT_RULE_POOL_RULE_STAGE_RECEIPT_MISSING', `缺少规则阶段提交凭证：${receiptPath}`);
        }
        const receipt = receiptRead.value || {};
        if (String(receipt.decisionDraftId || '').trim() !== String(decisionDraftId || '').trim()) {
            return this._blocked('REQUIREMENT_RULE_POOL_RULE_STAGE_DRAFT_ID_MISMATCH', '表候选阶段 decisionDraftId 与规则阶段凭证不一致。');
        }
        return { ok: true, receipt, path: receiptPath };
    }

    _writeRuleRecallRaw(filePath, context = {}) {
        const draft = context.draft || {};
        const rulePool = context.rulePool || {};
        const lines = [];
        lines.push('# 需求规则与表候选召回');
        lines.push('');
        lines.push(`- decisionDraftId: ${draft.decisionDraftId || ''}`);
        lines.push(`- 用户确认原文: ${context.userInput || ''}`);
        lines.push('');
        lines.push('## 全局业务规则池');
        (Array.isArray(rulePool.globalWhitelist) ? rulePool.globalWhitelist : []).forEach(rule => {
            lines.push(`- 保留：${this._ruleAlias(rule)}`);
        });
        (Array.isArray(rulePool.globalBlocklist) ? rulePool.globalBlocklist : []).forEach(rule => {
            lines.push(`- 剔除：${this._ruleAlias(rule)}`);
        });
        lines.push('');
        lines.push('## 全局表候选池');
        (Array.isArray(rulePool.globalTableCandidateWhitelist) ? rulePool.globalTableCandidateWhitelist : []).forEach(item => {
            lines.push(`- 保留：${item.tableName || '-'} / ${item.entityName || '-'}；命中原因：${(item.matchReasons || []).join('；') || '-'}`);
        });
        (Array.isArray(rulePool.globalTableCandidateBlocklist) ? rulePool.globalTableCandidateBlocklist : []).forEach(item => {
            lines.push(`- 剔除：${item.tableName || '-'} / ${item.entityName || '-'}；命中原因：${(item.matchReasons || []).join('；') || '-'}`);
        });
        lines.push('');
        lines.push('## Story 召回明细');
        lines.push('```json');
        lines.push(JSON.stringify(rulePool.storyRuleRecalls || [], null, 2));
        lines.push('```');
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, `${lines.join('\n')}\n`, 'utf-8');
    }

    _updateAnalysisState(filePath, payload = {}) {
        const read = this._readJson(filePath);
        if (!read.ok) return;
        const state = read.value || {};
        state.step6_6_ruleRecall = {
            status: 'confirmed',
            decisionDraftId: payload.decisionDraftId || '',
            rulePoolHash: payload.rulePoolHash || '',
            storyRuleRecalls: payload.storyRuleRecalls || [],
            userInputForGlobalPool: payload.userInput || '',
            userInputForTableCandidatePool: payload.tableUserInput || payload.userInput || '',
            ruleCandidateCount: payload.ruleCandidateCount || 0,
            tableCandidateCount: payload.tableCandidateCount || 0,
            updatedAt: new Date().toISOString()
        };
        this._writeJson(filePath, state);
    }

    _readText(filePath) {
        if (!filePath || !fs.existsSync(filePath)) return '';
        return fs.readFileSync(filePath, 'utf-8');
    }

    _readJson(filePath) {
        if (!filePath || !fs.existsSync(filePath)) return { ok: false, exists: false, value: null };
        try {
            return { ok: true, exists: true, value: JSON.parse(fs.readFileSync(filePath, 'utf-8')) };
        } catch (error) {
            return { ok: false, exists: true, value: null, error };
        }
    }

    _writeJson(filePath, payload) {
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf-8');
    }

    _draftId(value = {}) {
        return `RPD-${crypto.createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex').slice(0, 10).toUpperCase()}`;
    }

    _sha256(value = '') {
        return `sha256:${crypto.createHash('sha256').update(String(value || ''), 'utf8').digest('hex')}`;
    }

    _ruleAlias(value) {
        return typeof value === 'string'
            ? String(value || '').trim()
            : String(value && (value.ruleAlias || value.ruleName || value.alias) || '').trim();
    }

    _tableKey(value = {}) {
        const tableName = String(value && value.tableName || '').trim().toLowerCase();
        const entityName = String(value && value.entityName || '').trim().toLowerCase();
        return tableName || entityName ? `${tableName}|${entityName}` : '';
    }

    _stripCandidateFields(value = {}) {
        if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
        const next = { ...value };
        delete next.candidateId;
        return next;
    }

    _slimRuleCandidate(item = {}) {
        return {
            candidateId: item.candidateId,
            ruleAlias: item.ruleAlias || item.ruleName || '',
            sourceStoryIds: item.sourceStoryIds || [],
            matchReasons: item.matchReasons || [],
            matchedKeywords: item.matchedKeywords || []
        };
    }

    _slimTableCandidate(item = {}) {
        const slim = {
            candidateId: item.candidateId,
            tableName: item.tableName || '',
            entityName: item.entityName || '',
            tableDisplayName: item.tableDisplayName || '',
            sourceStoryIds: item.sourceStoryIds || [],
            matchedTerms: item.matchedTerms || [],
            matchReasons: item.matchReasons || [],
            score: Number(item.score || 0)
        };
        if (Array.isArray(item.productSourceEvidence) && item.productSourceEvidence.length > 0) {
            slim.productSourceEvidence = item.productSourceEvidence;
        }
        return slim;
    }

    _buildMechanicalTableMatchReason(item = {}) {
        const terms = (Array.isArray(item.matchedTerms) ? item.matchedTerms : []).map(term => String(term || '').trim()).filter(Boolean);
        const stories = (Array.isArray(item.sourceStoryIds) ? item.sourceStoryIds : []).map(storyId => String(storyId || '').trim()).filter(Boolean);
        const parts = [];
        parts.push(`命中词：${terms.length > 0 ? terms.join('、') : '-'}`);
        parts.push(`来源 Story：${stories.length > 0 ? stories.join('、') : '-'}`);
        parts.push(`score=${Number(item.score || 0)}`);
        return parts.join('；');
    }

    _mdCell(value = '') {
        return String(value == null ? '' : value)
            .replace(/\r?\n/gu, '<br>')
            .replace(/\|/gu, '\\|');
    }

    _normalizeExplicitTableNames(value) {
        if (typeof value === 'undefined') return { ok: true, names: [] };
        if (!Array.isArray(value)) {
            return this._blocked(
                'REQUIREMENT_RULE_POOL_EXPLICIT_TABLE_NAMES_INVALID',
                'userSupplementTableNames 必须是字符串数组；只有用户明确要求必须使用的表名才放入该数组，普通补充说明请放入 userSupplement。',
                {
                    allowedNextActions: ['rerun_req_rule_pool_build_rule_draft_with_userSupplementTableNames_array'],
                    nextActionCard: {
                        title: '修正明确表名参数格式',
                        stopAfter: false,
                        instruction: 'userSupplementTableNames 只能传表名字符串数组，例如 ["xm_dingtalk_report_cache"]；不要把整段用户原话放入该字段。'
                    }
                }
            );
        }
        const invalid = value.filter(item => typeof item !== 'string' || !item.trim());
        if (invalid.length > 0) {
            return this._blocked(
                'REQUIREMENT_RULE_POOL_EXPLICIT_TABLE_NAMES_INVALID',
                'userSupplementTableNames 只能包含非空表名字符串；普通补充说明请放入 userSupplement。',
                {
                    invalidTableNames: invalid.map(item => String(item == null ? '' : item)),
                    allowedNextActions: ['rerun_req_rule_pool_build_rule_draft_with_userSupplementTableNames_array']
                }
            );
        }
        const names = [];
        const seen = new Set();
        value.forEach(item => {
            const name = item.trim();
            const key = name.toLowerCase();
            if (seen.has(key)) return;
            seen.add(key);
            names.push(name);
        });
        return { ok: true, names };
    }

    _validateExplicitTableCandidates(requiredNames = [], candidates = [], options = {}) {
        const names = Array.isArray(requiredNames) ? requiredNames : [];
        if (names.length === 0) return { ok: true };
        const candidateNames = new Set();
        (Array.isArray(candidates) ? candidates : []).forEach(item => {
            [item && item.tableName, item && item.entityName]
                .map(value => String(value || '').trim().toLowerCase())
                .filter(Boolean)
                .forEach(name => candidateNames.add(name));
        });
        const missingTableNames = names.filter(name => !candidateNames.has(name.toLowerCase()));
        if (missingTableNames.length === 0) return { ok: true };
        const projectPath = String(options.projectPath || '').trim();
        return this._blocked(
            'REQUIREMENT_RULE_POOL_EXPLICIT_TABLE_NOT_IN_SCAN',
            `用户明确指定必须使用的表未出现在本次 project_scan 的实体图候选池中：${missingTableNames.join('、')}。Builder 不会按名称猜表，也不会把未扫描到的表写入确认池。请先重新执行 project_scan 刷新扫描产物；然后重调 req_rule_pool_build_rule_draft，并继续传 userSupplementTableNames 数组。`,
            {
                missingTableNames,
                requiredTableNames: names,
                scanCandidateCount: Array.isArray(candidates) ? candidates.length : 0,
                allowedNextActions: [
                    'rerun_project_scan_then_req_rule_pool_build_rule_draft',
                    'correct_userSupplementTableNames_then_req_rule_pool_build_rule_draft'
                ],
                nextActionCard: {
                    title: '用户指定的表未进入扫描候选池 — 先修复扫描再重试',
                    stopAfter: false,
                    instruction: '先调用 project_scan 刷新工程实体图；确认表名真实存在后，重新调用 req_rule_pool_build_rule_draft，并把 userSupplementTableNames 原样作为字符串数组传入。若表名写错，改成扫描产物中的真实 tableName/entityName。',
                    callTemplate: `req_rule_pool_build_rule_draft(${JSON.stringify({
                        projectPath,
                        skillName: 'epoint-requirement-analyzer',
                        userSupplementTableNames: names
                    })})`
                },
                forbiddenActions: [
                    'invent_table_candidate',
                    'write_rule_pool_json_directly',
                    'set_rule_pool_confirmed_true_manually'
                ]
            }
        );
    }

    _blocked(errorCode, message, extra = {}) {
        return {
            ok: false,
            status: 'blocked',
            actionMode: 'repair_requirement_rule_pool_builder_input',
            errorCode,
            message,
            allowedNextActions: ['repair_requirement_artifacts_then_rerun_rule_pool_builder'],
            forbiddenActions: ['write_rule_pool_json_directly', 'set_rule_pool_confirmed_true_manually'],
            ...extra
        };
    }
}

module.exports = RequirementRulePoolBuilderService;
