const QUESTION_CONFIRMATION_SOURCE_TYPES = new Set([
    'user_confirmed',
    'question_card_confirmed'
]);

const QUESTION_RECOMMENDATION_EVIDENCE_SOURCE_TYPES = new Set([
    'user_input',
    'user_confirmed',
    'question_card_confirmed',
    'rule_read',
    'scan_contract',
    'navigation_contract',
    'gate_contract',
    'project_scan',
    'requirement_contract'
]);

class QuestionCardGateService {
    constructor(options = {}) {
        this.helpers = options.helpers || {};
    }

    isQuestionResolved(item = {}, plan = {}) {
        return this.checkQuestionConfirmation(item, plan).ok;
    }

    checkQuestionCardStructuredAnswers(questionCards, pendingArtifact, plan = {}, markdownText = '', artifactPaths = {}, issues = []) {
        // questionCards already sourced from pending or plan by caller; pendingArtifact is kept for call compatibility.
        void pendingArtifact;
        void markdownText;
        void artifactPaths;
        const qcs = Array.isArray(questionCards) ? questionCards : [];

        if (qcs.length === 0) {
            return;
        }
        qcs.forEach((item, index) => {
            const id = String(item && (item.questionId || item.id || item.cardId || '') || '').trim();
            const status = String(item && (item.status || item.state || '') || '').trim().toLowerCase();
            const confirmedAnswer = String(item && (item.confirmedAnswer || item.answer || item.selectedAnswer || '') || '').trim();
            const hasConfirmedFlag = ['resolved', 'answered', 'confirmed', 'closed'].includes(status) ||
                item.resolved === true ||
                item.confirmed === true;
            const answerResolution = this.findAnswerResolutionForQuestion(item, plan);
            const confirmationCheck = this.checkQuestionConfirmation(item, plan);
            if (!this.isQuestionResolved(item, plan)) {
                const missingRecommendationFields = this.questionCardRecommendationFields()
                    .filter(field => !String(item && item[field] || '').trim());
                if (missingRecommendationFields.length > 0) {
                    issues.push({
                        code: 'DEMAND_PLANNER_QUESTION_CARD_RECOMMENDATION_MISSING',
                        severity: 'error',
                        message: 'questionCards 必须带 AI 推荐方案、推荐原因和回答影响，不能把选择题裸抛给用户。',
                        evidence: `questionCards[${index}].id=${id || `#${index}`},missing=${missingRecommendationFields.join(',')}`,
                        path: `construction-plan.json.questionCards[${index}]`,
                        owner: 'Planner',
                        fix: '在生成 questionCards 时同步写入 suggestedAnswer/recommendReason/answerImpact，并在最终“请直接回复以下问题”区域原样回显推荐。'
                    });
                }
            }
            const recommendationEvidenceCheck = this.checkQuestionRecommendationEvidence(item);
            if (!recommendationEvidenceCheck.ok) {
                issues.push({
                    code: recommendationEvidenceCheck.code,
                    severity: 'error',
                    message: recommendationEvidenceCheck.message,
                    evidence: `questionCards[${index}].id=${id || `#${index}`},${recommendationEvidenceCheck.evidence}`,
                    path: `construction-plan.json.questionCards[${index}].recommendationEvidence`,
                    owner: 'Planner',
                    fix: recommendationEvidenceCheck.fix
                });
            }
            const placementMisrouteCheck = this.checkProjectPlacementQuestionMisroute(item);
            if (!placementMisrouteCheck.ok) {
                issues.push({
                    code: placementMisrouteCheck.code,
                    severity: 'error',
                    message: placementMisrouteCheck.message,
                    evidence: `questionCards[${index}].id=${id || `#${index}`},${placementMisrouteCheck.evidence}`,
                    path: `construction-plan.json.questionCards[${index}]`,
                    owner: 'Planner',
                    fix: placementMisrouteCheck.fix
                });
            }
            if (hasConfirmedFlag && !confirmedAnswer && !answerResolution) {
                issues.push({
                    code: 'DEMAND_PLANNER_QUESTION_CARD_CONFIRMED_WITHOUT_ANSWER',
                    severity: 'error',
                    message: 'questionCards 已标记确认/解决，但缺少 confirmedAnswer/answer/selectedAnswer，不能作为用户确认依据。',
                    evidence: `questionCards[${index}].id=${id || `#${index}`},status=${status || 'EMPTY'}`,
                    path: `construction-plan.json.questionCards[${index}]`,
                    owner: 'Planner',
                    fix: '按当前 FLOW 全量重建 JSON：写入 confirmedAnswer、confirmedAt/answeredAt，并同步关闭对应 unresolvedSignals；不能只改 Markdown。'
                });
            }
            if (hasConfirmedFlag && confirmedAnswer && !confirmationCheck.ok) {
                const issueCode = confirmationCheck.code || 'DEMAND_PLANNER_QUESTION_CONFIRMATION_SOURCE_TYPE_INVALID';
                const issuePath = String(confirmationCheck.path || `construction-plan.json.questionCards[${index}].confirmationEvidence.sourceType`)
                    .replace('questionCards[]', `questionCards[${index}]`);
                issues.push({
                    code: issueCode,
                    severity: 'error',
                    message: confirmationCheck.message || 'questionCards 已标记确认/解决，但 confirmationEvidence 缺失或不合规。',
                    evidence: `questionCards[${index}].id=${id || `#${index}`},${confirmationCheck.evidence}`,
                    path: issuePath,
                    owner: 'Planner',
                    fix: confirmationCheck.fix || 'confirmationEvidence.sourceType 必须为 user_confirmed 或 question_card_confirmed；必须由用户回复生成 confirmedAnswer。'
                });
            }
            this.checkQuestionStructuredDecisionTypes(item, index, issues);
        });
    }

    checkQuestionConfirmation(item = {}, plan = {}) {
        if (this.isQuestionClosedByRuntime(item, plan)) {
            return { ok: true, evidence: 'runtime userReplyLedger + impactReviewLedger' };
        }
        const status = String(item && (item.status || item.state || '') || '').trim().toLowerCase();
        const confirmedAnswer = String(item && (item.confirmedAnswer || item.answer || item.selectedAnswer || '') || '').trim();
        const hasConfirmedStatus = ['resolved', 'answered', 'confirmed', 'closed'].includes(status) ||
            item.resolved === true ||
            item.confirmed === true;
        const answerResolution = this.findAnswerResolutionForQuestion(item, plan);
        if (answerResolution) {
            return { ok: true, evidence: 'answerResolutions[]' };
        }
        if (!hasConfirmedStatus || !confirmedAnswer) {
            return {
                ok: false,
                evidence: `status=${status || 'EMPTY'},confirmedAnswer=${confirmedAnswer || 'EMPTY'}`
            };
        }
        const confirmationEvidence = item.confirmationEvidence && typeof item.confirmationEvidence === 'object' ?
            item.confirmationEvidence :
            {};
        const sourceType = String(confirmationEvidence.sourceType || confirmationEvidence.source || '').trim();
        if (!QUESTION_CONFIRMATION_SOURCE_TYPES.has(sourceType)) {
            return {
                ok: false,
                evidence: `confirmationEvidence.sourceType=${sourceType || 'EMPTY'}`
            };
        }
        const sourceReference = String(
            confirmationEvidence.sourceMessageDigest ||
            confirmationEvidence.userMessageDigest ||
            confirmationEvidence.messageDigest ||
            confirmationEvidence.sourceMessageId ||
            confirmationEvidence.sourceMessageRef ||
            confirmationEvidence.userReplyRef ||
            ''
        ).trim();
        if (!sourceReference) {
            return {
                ok: false,
                code: 'DEMAND_PLANNER_QUESTION_CONFIRMATION_EVIDENCE_MISSING',
                message: 'questionCards 已标记确认/解决，但缺少由 Builder 编译出的用户回复证据；不能只靠 sourceType 放行。',
                evidence: `sourceType=${sourceType},sourceReference=EMPTY`,
                path: 'construction-plan.json.questionCards[].confirmationEvidence',
                fix: '新流程下不要手写 questionCards[].confirmationEvidence；把用户回复引用写入 answerResolutions[].userReplyRef/sourceMessageDigest/userReplyText，由 Builder 编译确认字段；否则保持问题卡 open 且 draft=true。'
            };
        }
        if (!this.hasQuestionSemanticResolution(item, confirmedAnswer)) {
            return {
                ok: false,
                code: 'DEMAND_PLANNER_QUESTION_SEMANTIC_RESOLUTION_MISSING',
                message: 'questionCards 已标记确认/解决，但缺少由 Builder 编译出的用户回答结构化决策。',
                evidence: `confirmedAnswer=${confirmedAnswer},sourceType=${sourceType},semanticResolution=EMPTY`,
                path: 'construction-plan.json.questionCards[].semanticResolution',
                fix: '新流程下不要手写 questionCards[].semanticResolution/decisionEffects；把用户原话如何转成施工决策写入 answerResolutions[].decisions[].payload。'
            };
        }
        return {
            ok: true,
            evidence: `sourceType=${sourceType}`
        };
    }

    isQuestionClosedByRuntime(item = {}, plan = {}) {
        const questionId = String(item && (item.questionId || item.id || item.cardId || '') || '').trim();
        if (!questionId) {
            return false;
        }
        const ledgerEntries = (Array.isArray(plan.userReplyLedger) ? plan.userReplyLedger : [])
            .filter(entry => String(entry && entry.questionId || '').trim() === questionId);
        if (ledgerEntries.length === 0) {
            return false;
        }
        const reviewedHashes = new Set();
        const checkpoint = plan.userAnswerReviewCheckpoint && typeof plan.userAnswerReviewCheckpoint === 'object'
            ? plan.userAnswerReviewCheckpoint
            : null;
        if (checkpoint && String(checkpoint.status || '').trim() === 'satisfied') {
            (Array.isArray(checkpoint.reviewedHashes) ? checkpoint.reviewedHashes : [])
                .map(hash => String(hash || '').trim())
                .filter(Boolean)
                .forEach(hash => reviewedHashes.add(hash));
            (Array.isArray(checkpoint.userReplyHashes) ? checkpoint.userReplyHashes : [])
                .map(hash => String(hash || '').trim())
                .filter(Boolean)
                .forEach(hash => reviewedHashes.add(hash));
        }
        (Array.isArray(plan.impactReviewLedger) ? plan.impactReviewLedger : [])
            .map(review => String(review && review.userReplyHash || '').trim())
            .filter(Boolean)
            .forEach(hash => reviewedHashes.add(hash));
        if (reviewedHashes.size === 0) {
            return false;
        }
        return ledgerEntries.some(entry => {
            const hash = String(entry && (entry.userReplyHash || entry.hash || entry.messageHash) || '').trim();
            return hash && reviewedHashes.has(hash);
        });
    }

    findAnswerResolutionForQuestion(item = {}, plan = {}) {
        const questionId = String(item && (item.questionId || item.id || item.cardId || '') || '').trim();
        if (!questionId || !Array.isArray(plan.answerResolutions)) {
            return null;
        }
        return plan.answerResolutions.find(resolution => {
            const id = String(resolution && (resolution.questionId || resolution.id || resolution.questionCardId) || '').trim();
            if (id !== questionId) {
                return false;
            }
            const answer = String(resolution.confirmedAnswer || resolution.answer || resolution.selectedAnswer || '').trim();
            const hasReplyEvidence = Boolean(String(
                resolution.userReplyRef ||
                resolution.sourceMessageRef ||
                resolution.sourceMessageId ||
                resolution.sourceMessageDigest ||
                resolution.userReplyHash ||
                resolution.userReplyText ||
                ''
            ).trim());
            const replyRef = String(
                resolution.userReplyRef ||
                resolution.sourceMessageRef ||
                resolution.sourceMessageId ||
                resolution.sourceMessageDigest ||
                resolution.userReplyHash ||
                resolution.userReplyText ||
                ''
            ).trim();
            const ledger = Array.isArray(plan.userReplyLedger) ? plan.userReplyLedger : [];
            const ledgerMatched = ledger.some(entry => {
                const hash = String(entry && (entry.userReplyHash || entry.hash || entry.messageHash) || '').trim();
                const ref = String(entry && (entry.userReplyRef || entry.ref || entry.messageId) || '').trim();
                const text = String(entry && (entry.userReplyText || entry.text || entry.message) || '').trim();
                return (hash && hash === replyRef) ||
                    (ref && ref === replyRef) ||
                    (hash && hash === String(resolution.userReplyHash || '').trim()) ||
                    (text && text === String(resolution.userReplyText || '').trim());
            });
            return Boolean(answer && hasReplyEvidence && ledgerMatched);
        }) || null;
    }

    checkQuestionRecommendationEvidence(item = {}) {
        const recommendationText = [
            item && item.suggestedAnswer,
            item && item.recommendReason,
            item && item.answerImpact
        ].map(value => String(value || '').trim()).filter(Boolean).join('\n');
        if (!this.recommendationClaimsProjectFact(recommendationText)) {
            return { ok: true };
        }
        const evidenceList = this.questionRecommendationEvidenceItems(item);
        if (evidenceList.length === 0) {
            return {
                ok: false,
                code: 'DEMAND_PLANNER_QUESTION_RECOMMENDATION_EVIDENCE_MISSING',
                message: 'questionCards 推荐理由引用现有页面、已有按钮、既有交互或项目事实时，必须提供 recommendationEvidence/evidenceRefs 证据回放。',
                evidence: 'recommendationEvidence=EMPTY',
                fix: '补充 recommendationEvidence[] 或 evidenceRefs[]，sourceType 必须来自 user_input/rule_read/scan_contract/navigation_contract 等白名单；没有证据时改为“证据不足，需用户确认”。'
            };
        }
        const invalid = evidenceList
            .map((evidence, index) => ({ evidence, index }))
            .find(({ evidence }) => !this.isValidQuestionRecommendationEvidence(evidence));
        if (invalid) {
            const sourceType = this.questionRecommendationEvidenceSourceType(invalid.evidence);
            return {
                ok: false,
                code: 'DEMAND_PLANNER_QUESTION_RECOMMENDATION_EVIDENCE_INVALID',
                message: 'questionCards 推荐证据缺少 sourceType 或证据内容，不能证明推荐理由中的项目事实。',
                evidence: `recommendationEvidence[${invalid.index}].sourceType=${sourceType || 'EMPTY'}`,
                fix: '推荐证据必须包含白名单 sourceType，并携带 evidence/sourceArtifact/sourceField/sourcePath/ref 等可回放内容；禁止使用 inferred/search_result/source_code 作为推荐证据。'
            };
        }
        return { ok: true };
    }

    checkProjectPlacementQuestionMisroute(item = {}) {
        const text = this.questionCardVisibleText(item);
        if (!this.questionAsksProjectPlacementFact(text)) {
            return { ok: true };
        }
        return {
            ok: false,
            code: 'DEMAND_PLANNER_QUESTION_CARD_PROJECT_PLACEMENT_MISROUTED',
            message: 'questionCards 不得让用户确认工程目录、包路径、文件坐落点或命名模板这类项目基础事实。',
            evidence: this.compactTextEvidence(text),
            fix: '先读取并消费基础资料：<projectPath>/.ai-workspace/project/工程导航契约.compact.json 的 rulePlacementContract.rules[] / databaseNamingContract；新增文件必须生成 namingPreview，不能问用户选择目录。导航契约缺失或模板变量无法解析时转 blocker/project_scan；用户只确认业务意图、承载方式或模板变量，不替 Planner 确认工程目录。'
        };
    }

    questionCardVisibleText(item = {}) {
        const optionText = (Array.isArray(item && item.options) ? item.options : (Array.isArray(item && item.allowedAnswers) ? item.allowedAnswers : []))
            .map(option => {
                if (option && typeof option === 'object') {
                    return [
                        option.id,
                        option.code,
                        option.value,
                        option.label,
                        option.description,
                        option.text
                    ].map(value => String(value || '').trim()).filter(Boolean).join(' ');
                }
                return String(option || '').trim();
            })
            .filter(Boolean)
            .join('\n');
        return [
            item && (item.question || item.title || item.label || item.message),
            item && item.suggestedAnswer,
            item && item.recommendReason,
            item && item.answerImpact,
            optionText
        ].map(value => String(value || '').trim()).filter(Boolean).join('\n');
    }

    questionAsksProjectPlacementFact(text = '') {
        const value = String(text || '').trim();
        if (!value) {
            return false;
        }
        const allowedBusinessVariableQuestion = /(业务模块|模块名|页面语义|功能名|实体名|表名含义|变量值|模板变量).{0,20}(确认|选择|填写|提供)/iu.test(value) &&
            !/(工程目录|项目目录|后端目录|前端目录|Action\s*目录|Action\s*类所在目录|Service\s*目录|ServiceImpl\s*目录|Entity\s*目录|RestController\s*目录|包路径|包名|文件路径|页面路径|源码目录|src[\\/]+main|webapp|com[\\/.\w-]*[\\/.\w-]*(action|service|impl|entity|rest)|[\\/][\w.-]+[\\/][\w.-]+|\.java\b|\.html\b|放在|存放|类所在|所在目录)/iu.test(value);
        const allowedBusinessVariableQuestionPrefix = /(确认|选择|填写|提供).{0,24}(业务模块|模块名|页面语义|功能名|实体名|表名含义|变量值|模板变量)/iu.test(value) &&
            !/(工程目录|项目目录|后端目录|前端目录|Action\s*目录|Action\s*类所在目录|Service\s*目录|ServiceImpl\s*目录|Entity\s*目录|RestController\s*目录|包路径|包名|文件路径|页面路径|源码目录|src[\\/]+main|webapp|com[\\/.\w-]*[\\/.\w-]*(action|service|impl|entity|rest)|[\\/][\w.-]+[\\/][\w.-]+|\.java\b|\.html\b|放在|存放|类所在|所在目录)/iu.test(value);
        if (allowedBusinessVariableQuestion || allowedBusinessVariableQuestionPrefix) {
            return false;
        }
        const asksPlacementConfirmation = /(请确认|确认|请选择|选择|是否|是不是).{0,30}(工程目录|项目目录|后端目录|前端目录|Action\s*目录|Action\s*类所在目录|Service\s*目录|ServiceImpl\s*目录|Entity\s*目录|RestController\s*目录|包路径|包名|文件路径|页面路径|源码目录|落点|坐落|放在|存放|类所在|所在目录)/iu.test(value);
        const explicitPathOption = /(src[\\/]+main|webapp|com[\\/.\w-]*[\\/.\w-]*(action|service|impl|entity|rest)|[\\/][\w.-]+[\\/][\w.-]+|\.java\b|\.html\b)/iu.test(value);
        const asksNamingTemplateItself = /(请确认|确认|请选择|选择|是否|是不是).{0,30}(命名模板|rulePlacementContract|relativeDirPattern|fileNamePattern)/iu.test(value);
        if (asksPlacementConfirmation || explicitPathOption || asksNamingTemplateItself) {
            return true;
        }
        const asksConfirmation = /(请确认|确认|请选择|选择|是否|是不是|所在|位于|落点|坐落|放在|存放|类所在)/iu.test(value);
        if (!asksConfirmation) {
            return false;
        }
        const placementTerms = /(工程目录|项目目录|后端目录|前端目录|Action\s*目录|Action\s*类所在目录|Service\s*目录|ServiceImpl\s*目录|Entity\s*目录|RestController\s*目录|包路径|包名|文件路径|页面路径|源码目录|src[\\/]+main|webapp|com[\\/.\w-]*[\\/.\w-]*(action|service|impl|entity|rest)|[\\/][\w.-]+[\\/][\w.-]+|\.java\b|\.html\b|rulePlacementContract|命名模板|namingPreview|放在|存放|类所在|所在目录)/iu;
        return placementTerms.test(value);
    }

    compactTextEvidence(text = '') {
        const value = String(text || '').replace(/\s+/g, ' ').trim();
        return value.length > 180 ? `${value.slice(0, 180)}...` : value;
    }

    checkQuestionStructuredDecisionTypes(item = {}, index = 0, issues = []) {
        const invalid = this.invalidStructuredDecisionFields(item);
        invalid.forEach(field => {
            const isDecisionEffects = field.path.endsWith('decisionEffects');
            issues.push({
                code: isDecisionEffects
                    ? 'DEMAND_PLANNER_QUESTION_DECISION_EFFECTS_TYPE_INVALID'
                    : 'DEMAND_PLANNER_QUESTION_SEMANTIC_RESOLUTION_TYPE_INVALID',
                severity: 'error',
                message: isDecisionEffects
                    ? 'questionCards.decisionEffects 必须是对象数组或对象，不能写成自然语言字符串。'
                    : 'questionCards.semanticResolution 必须是结构化对象，不能写成自然语言字符串。',
                evidence: `questionCards[${index}].${field.path}=type:${field.actualType}`,
                path: `construction-plan.json.questionCards[${index}].${field.path}`,
                owner: 'Planner',
                fix: isDecisionEffects
                    ? '旧 questionCards.decisionEffects 输入已删除；删除该字段，把用户回答解析成 answerResolutions[].decisions[]，每项包含 targetPath/payload/reason。'
                    : '旧 questionCards.semanticResolution 输入已删除；删除该字段，把用户回答解析成 answerResolutions[].decisions[].payload，自然语言说明只能作为 reason。'
            });
        });
    }

    invalidStructuredDecisionFields(item = {}) {
        const evidence = item && item.confirmationEvidence && typeof item.confirmationEvidence === 'object' ? item.confirmationEvidence : {};
        const checks = [
            { path: 'semanticResolution', value: item && item.semanticResolution, expected: 'object' },
            { path: 'decisionEffects', value: item && item.decisionEffects, expected: 'object_or_array' },
            { path: 'confirmedEffects', value: item && item.confirmedEffects, expected: 'object_or_array' },
            { path: 'ruleDecisions', value: item && item.ruleDecisions, expected: 'object_or_array' },
            { path: 'confirmationEvidence.semanticResolution', value: evidence.semanticResolution, expected: 'object' },
            { path: 'confirmationEvidence.decisionEffects', value: evidence.decisionEffects, expected: 'object_or_array' },
            { path: 'confirmationEvidence.confirmedEffects', value: evidence.confirmedEffects, expected: 'object_or_array' },
            { path: 'confirmationEvidence.ruleDecisions', value: evidence.ruleDecisions, expected: 'object_or_array' }
        ];
        return checks.filter(check => this.isInvalidStructuredDecisionField(check.value, check.expected))
            .map(check => ({
                path: check.path,
                actualType: Array.isArray(check.value) ? 'array' : typeof check.value
            }));
    }

    isInvalidStructuredDecisionField(value, expected = '') {
        if (value === undefined || value === null || value === '') {
            return false;
        }
        if (expected === 'object') {
            return !(value && typeof value === 'object' && !Array.isArray(value));
        }
        if (expected === 'object_or_array') {
            if (Array.isArray(value)) {
                return value.some(item => !(item && typeof item === 'object' && !Array.isArray(item)));
            }
            return !(value && typeof value === 'object');
        }
        return false;
    }

    recommendationClaimsProjectFact(text = '') {
        const value = String(text || '').trim();
        if (!value) {
            return false;
        }
        return /(现有|已有|既有|当前页面|原页面|项目中|项目内|当前项目|页面已有|已有页面|已有按钮|现有按钮|证明核验|交互模式一致|交互一致|与.{0,16}一致|复用.{0,12}(页面|按钮|交互|模式)|沿用.{0,12}(页面|按钮|交互|模式))/iu.test(value);
    }

    questionRecommendationEvidenceItems(item = {}) {
        const buckets = [
            item && item.recommendationEvidence,
            item && item.recommendEvidence,
            item && item.recommendationEvidenceRefs,
            item && item.evidenceRefs
        ];
        return buckets.flatMap(bucket => {
            if (Array.isArray(bucket)) {
                return bucket;
            }
            return bucket && typeof bucket === 'object' ? [bucket] : [];
        });
    }

    isValidQuestionRecommendationEvidence(evidence = {}) {
        if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)) {
            return false;
        }
        const sourceType = this.questionRecommendationEvidenceSourceType(evidence);
        if (!QUESTION_RECOMMENDATION_EVIDENCE_SOURCE_TYPES.has(sourceType)) {
            return false;
        }
        return [
            evidence.evidence,
            evidence.text,
            evidence.sourceText,
            evidence.sourceArtifact,
            evidence.sourceField,
            evidence.sourcePath,
            evidence.path,
            evidence.ref,
            evidence.sourceRef,
            evidence.quote
        ].some(value => String(value || '').trim());
    }

    questionRecommendationEvidenceSourceType(evidence = {}) {
        return String(evidence && (evidence.sourceType || evidence.source || evidence.type) || '').trim();
    }

    hasQuestionSemanticResolution(item = {}) {
        const evidence = item.confirmationEvidence && typeof item.confirmationEvidence === 'object' ? item.confirmationEvidence : {};
        const resolution = item.semanticResolution && typeof item.semanticResolution === 'object' ? item.semanticResolution : null;
        const evidenceResolution = evidence.semanticResolution && typeof evidence.semanticResolution === 'object' ? evidence.semanticResolution : null;
        const effectBuckets = [
            item.decisionEffects,
            item.confirmedEffects,
            item.ruleDecisions,
            evidence.decisionEffects,
            evidence.confirmedEffects,
            evidence.ruleDecisions
        ];
        if (resolution || evidenceResolution || effectBuckets.some(bucket => Array.isArray(bucket) ? bucket.length > 0 : Boolean(bucket && typeof bucket === 'object'))) {
            return true;
        }
        return ['confirmedAnswerLabel', 'confirmedTableName', 'tableName', 'selectedOption', 'selectedOptionId', 'selectedOptionCode']
            .some(field => String(item[field] || evidence[field] || '').trim());
    }

    questionAllowedAnswerValues(item = {}) {
        const rawAnswers = Array.isArray(item.allowedAnswers) ? item.allowedAnswers :
            (Array.isArray(item.options) ? item.options : []);
        const values = [];
        rawAnswers.forEach((answer, index) => {
            const optionCode = index >= 0 && index < 26 ? String.fromCharCode(65 + index) : '';
            const numericCode = index >= 0 ? String(index + 1) : '';
            if (typeof answer === 'string' || typeof answer === 'number') {
                values.push(String(answer).trim());
                if (optionCode) values.push(optionCode);
                if (numericCode) values.push(numericCode);
                return;
            }
            if (answer && typeof answer === 'object') {
                ['id', 'code', 'value', 'key', 'label'].forEach(field => {
                    const value = String(answer[field] || '').trim();
                    if (value) {
                        values.push(value);
                    }
                });
            }
        });
        return Array.from(new Set(values.filter(Boolean)));
    }

    questionCardRecommendationFields() {
        return ['suggestedAnswer', 'recommendReason', 'answerImpact'];
    }

    isRevisionAfterUserSupplement(plan = {}) {
        const revision = plan && plan.revision && typeof plan.revision === 'object' ? plan.revision : {};
        const reason = String(revision.reason || plan.revisionReason || '').trim().toLowerCase();
        if (['user_supplement', 'question_answer', 'scope_change'].includes(reason)) {
            return true;
        }
        if (Array.isArray(plan.questionCards) && plan.questionCards.some(item => this.isQuestionResolved(item, plan))) {
            return true;
        }
        return false;
    }

    collectOpenGapEvidence(unresolvedSignals, questionCards, blockers) {
        const parts = [];
        unresolvedSignals.forEach((item, index) => {
            const signal = item && (item.signal || item.userAnchor || item.reason);
            parts.push(`unresolvedSignals[${index}]${signal ? `.signal=${signal}` : ''}`);
        });
        questionCards.forEach((item, index) => {
            if (!this.isQuestionResolved(item)) {
                const id = item && (item.questionId || item.id || item.cardId || `#${index}`);
                const status = item && (item.status || item.state || 'open');
                parts.push(`questionCards[${index}].id=${id},status=${status}`);
            }
        });
        blockers.forEach((item, index) => {
            const id = item && (item.blockerId || item.id || `#${index}`);
            const type = item && (item.type || item.code || 'blocker');
            parts.push(`blockers[${index}].id=${id},type=${type}`);
        });
        return parts.length > 0 ? parts.join('; ') : 'open gaps exist';
    }

    collectOpenQuestionEvidence(questionCards) {
        const openQuestions = Array.isArray(questionCards) ? questionCards : [];
        return openQuestions
            .map((item, index) => {
                if (this.isQuestionResolved(item)) {
                    return null;
                }
                const id = item && (item.questionId || item.id || item.cardId || `#${index}`);
                const status = item && (item.status || item.state || 'open');
                return `questionCards[${index}].id=${id},status=${status}`;
            })
            .filter(Boolean)
            .join('; ');
    }

    _looksLikeQuestionCardAnswer(text = '') {
        const fn = this.helpers && this.helpers.looksLikeQuestionCardAnswer;
        if (typeof fn === 'function') {
            return fn(text) === true;
        }
        return false;
    }
}

module.exports = QuestionCardGateService;
