const fs = require('fs');
const path = require('path');

const ALLOWED_PLACEMENT_SOURCE_TYPES = new Set([
    'scan_contract',
    'user_confirmed',
    'resolved_manifest',
    'navigation_template_resolved',
    'user_explicit_path',
    'question_card_confirmed'
]);

const FORBIDDEN_PLACEMENT_SOURCE_TYPES = new Set([
    'source_code',
    'search_result',
    'inferred',
    'guessed',
    'markdown_only',
    'source_discovery'
]);

class PlacementNamingGateService {
    constructor(options = {}) {
        this.helpers = options.helpers || {};
    }

    checkPlacementEvidenceSourceType(evidence, index, item, issues) {
        const sourceType = String(evidence.sourceType || '').trim();
        if (!sourceType) {
            issues.push({
                code: 'DEMAND_PLANNER_PLACEMENT_SOURCE_TYPE_MISSING',
                severity: 'error',
                message: `allowedFileScope[${index}] 缺少 placementEvidence.sourceType，无法证明授权来源。`,
                evidence: item && (item.filePath || item.path || JSON.stringify(item)),
                path: `construction-plan.json.allowedFileScope[${index}].placementEvidence.sourceType`,
                owner: 'Planner',
                fix: `补充合法 sourceType：${Array.from(ALLOWED_PLACEMENT_SOURCE_TYPES).join('|')}；无法补证据就降级 candidateFileScope。`
            });
            return;
        }
        if (FORBIDDEN_PLACEMENT_SOURCE_TYPES.has(sourceType) || !ALLOWED_PLACEMENT_SOURCE_TYPES.has(sourceType)) {
            issues.push({
                code: 'DEMAND_PLANNER_PLACEMENT_SOURCE_TYPE_FORBIDDEN',
                severity: 'error',
                message: `allowedFileScope[${index}] 的 placementEvidence.sourceType=${sourceType} 不允许作为授权来源。`,
                evidence: item && (item.filePath || item.path || JSON.stringify(item)),
                path: `construction-plan.json.allowedFileScope[${index}].placementEvidence.sourceType`,
                owner: 'Planner',
                fix: '只能使用 scan_contract/user_confirmed/resolved_manifest/navigation_template_resolved/user_explicit_path/question_card_confirmed；否则该文件必须降级 candidateFileScope。'
            });
        }
    }

    checkAllowedCreateFileNaming(plan, projectPath, gateContract, issues) {
        if (!plan || plan.draft !== false) {
            return;
        }
        const allowed = Array.isArray(plan.allowedFileScope) ? plan.allowedFileScope : [];
        const createItems = allowed
            .map((item, index) => ({ item, index }))
            .filter(({ item }) => this.isCreateScopeItem(item));
        if (createItems.length === 0) {
            return;
        }

        const selfReview = plan.selfReviewSummary && typeof plan.selfReviewSummary === 'object' ? plan.selfReviewSummary : {};
        this.checkSelfReviewSummaryContract(selfReview, gateContract, issues);
        const fileNaming = this.normalizeSelfReviewStatus(selfReview.fileNaming);
        const fileScope = this.normalizeSelfReviewStatus(selfReview.fileScope);
        const gateContractId = String(selfReview.gateContractId || selfReview.contractId || '').trim();
        const expectedGateContractId = String(gateContract && gateContract.contractId || '').trim();
        if ((fileNaming === 'pass' || fileScope === 'pass') && expectedGateContractId && gateContractId !== expectedGateContractId) {
            issues.push({
                code: this._contractWarningCode(gateContract, 'fileNaming', 'DEMAND_PLANNER_SELF_REVIEW_GATE_CONTRACT_MISSING'),
                severity: 'warning',
                message: '新增文件命名/范围自审 pass 必须声明同源 gateContractId，不能手写自审结论。',
                evidence: `expected=${expectedGateContractId},actual=${gateContractId || 'EMPTY'}`,
                path: 'construction-plan.json.selfReviewSummary.gateContractId',
                owner: 'Planner',
                fix: '先调用 gate_contract 获取当前合同；selfReviewSummary 只记录该合同维度检查结果，不能复制 Skill 文档中的固定规则。'
            });
        }
        if (fileNaming !== 'pass') {
            issues.push({
                code: this._contractWarningCode(gateContract, 'fileNaming', 'DEMAND_PLANNER_FILE_NAMING_SELF_REVIEW_MISSING'),
                severity: 'warning',
                message: '存在新增文件时，建议 selfReviewSummary.fileNaming 回放命名预览检查结果；该展示字段不替代 namingPreview/path/sourceType 硬校验。',
                evidence: `fileNaming=${fileNaming || 'EMPTY'}`,
                path: 'construction-plan.json.selfReviewSummary.fileNaming',
                owner: 'Planner',
                fix: '需要审计展示时补 fileNaming；真正阻断只看 namingPreview 是否 resolved、candidatePath 是否存在且与 allowed 路径一致。'
            });
        }
        if (fileScope === 'pass' && fileNaming !== 'pass') {
            issues.push({
                code: this._contractWarningCode(gateContract, 'fileScope', 'DEMAND_PLANNER_FILE_SCOPE_PASS_WITHOUT_FILE_NAMING'),
                severity: 'warning',
                message: 'selfReviewSummary.fileScope=pass 但 fileNaming 未 pass；这是自审展示链不一致。',
                evidence: `fileScope=${fileScope},fileNaming=${fileNaming || 'EMPTY'}`,
                path: 'construction-plan.json.selfReviewSummary',
                owner: 'Planner',
                fix: '需要审计展示时同步 fileNaming；新增文件是否可写由 allowedFileScope、placementEvidence、namingPreview 硬字段决定。'
            });
        }
        this.checkSelfReviewEvidenceReplay(selfReview, createItems, gateContract, issues);

        const navigationContract = this.loadNavigationPlacementContract(plan, projectPath);
        createItems.forEach(({ item, index }) => {
            this.checkCreateFileNamingItem(plan, item, index, navigationContract, projectPath, gateContract, issues);
        });
    }

    normalizeSelfReviewStatus(value) {
        if (value && typeof value === 'object' && !Array.isArray(value)) {
            return String(value.status || value.result || value.state || '').trim().toLowerCase();
        }
        return String(value || '').trim().toLowerCase();
    }

    checkSelfReviewSummaryContract(selfReview = {}, gateContract, issues = []) {
        const status = String(selfReview.status || '').trim().toLowerCase();
        const hasOpenGaps = Array.isArray(selfReview.openGaps);
        const hasWarnings = Array.isArray(selfReview.warnings);
        if (!['pass', 'warning', 'fail'].includes(status)) {
            issues.push({
                code: this._contractFailureCode(gateContract, 'selfReviewEvidence', 'DEMAND_PLANNER_SELF_REVIEW_STATUS_MISSING'),
                severity: 'warning',
                message: 'selfReviewSummary.status 必须是 pass/warning/fail，用于声明 Planner 自审结论；不能只写自然语言。',
                evidence: `status=${status || 'EMPTY'}`,
                path: 'construction-plan.json.selfReviewSummary.status',
                owner: 'Planner',
                fix: '补充 status=pass|warning|fail；Gate 只校验结构和闭环，不评价文案。'
            });
        }
        if (!hasOpenGaps) {
            issues.push({
                code: this._contractFailureCode(gateContract, 'selfReviewEvidence', 'DEMAND_PLANNER_SELF_REVIEW_OPEN_GAPS_MISSING'),
                severity: 'warning',
                message: 'selfReviewSummary.openGaps 建议写成数组，用于声明仍未闭合的风险。',
                path: 'construction-plan.json.selfReviewSummary.openGaps',
                owner: 'Planner',
                fix: '补充 openGaps 数组；无开放风险时写 []。'
            });
        }
        if (!hasWarnings) {
            issues.push({
                code: this._contractFailureCode(gateContract, 'selfReviewEvidence', 'DEMAND_PLANNER_SELF_REVIEW_WARNINGS_MISSING'),
                severity: 'warning',
                message: 'selfReviewSummary.warnings 建议写成数组，用于承载非阻断提醒。',
                path: 'construction-plan.json.selfReviewSummary.warnings',
                owner: 'Planner',
                fix: '补充 warnings 数组；无提醒时写 []。'
            });
        }
        if (status === 'fail') {
            issues.push({
                code: this._contractFailureCode(gateContract, 'selfReviewEvidence', 'DEMAND_PLANNER_SELF_REVIEW_FAIL_WITH_DRAFT_FALSE'),
                severity: 'error',
                message: 'selfReviewSummary.status=fail 时不得 draft=false 进入正式 preflight。',
                path: 'construction-plan.json.selfReviewSummary.status',
                owner: 'Planner',
                fix: '保持 draft=true 或修复自审失败项后再进入正式 preflight。'
            });
        }
        if (hasOpenGaps && selfReview.openGaps.length > 0) {
            issues.push({
                code: this._contractFailureCode(gateContract, 'selfReviewEvidence', 'DEMAND_PLANNER_SELF_REVIEW_OPEN_GAPS_WITH_DRAFT_FALSE'),
                severity: 'error',
                message: 'selfReviewSummary.openGaps 非空时不得 draft=false 交付。',
                evidence: `openGaps=${selfReview.openGaps.length}`,
                path: 'construction-plan.json.selfReviewSummary.openGaps',
                owner: 'Planner',
                fix: '闭合 openGaps 或转入 questionCards/blockers，并保持 draft=true。'
            });
        }
        if (status === 'pass' && hasOpenGaps && selfReview.openGaps.length > 0) {
            issues.push({
                code: this._contractFailureCode(gateContract, 'selfReviewEvidence', 'DEMAND_PLANNER_SELF_REVIEW_PASS_WITH_OPEN_GAPS'),
                severity: 'error',
                message: 'selfReviewSummary.status=pass 与 openGaps 非空自相矛盾。',
                path: 'construction-plan.json.selfReviewSummary',
                owner: 'Planner',
                fix: '要么清空 openGaps 并提供闭合证据，要么把 status 改为 warning/fail 并保持 draft=true。'
            });
        }
    }

    checkSelfReviewEvidenceReplay(selfReview = {}, createItems = [], gateContract, issues = []) {
        const replay = Array.isArray(selfReview.evidenceReplay) ? selfReview.evidenceReplay : [];
        if (replay.length === 0) {
            issues.push({
                code: this._contractWarningCode(gateContract, 'selfReviewEvidence', 'DEMAND_PLANNER_SELF_REVIEW_EVIDENCE_REPLAY_MISSING'),
                severity: 'warning',
                message: 'selfReviewSummary.evidenceReplay[] 缺失；审计信息缺失，不作为独立硬阻断。',
                path: 'construction-plan.json.selfReviewSummary.evidenceReplay',
                owner: 'Planner',
                fix: '需要审计时补充 decisionType/target/source/risk；Coder 写入边界以 allowedFileScope 为准。'
            });
            return;
        }
        createItems.forEach(({ index }) => {
            const target = `allowedFileScope[${index}]`;
            const matched = replay.find(item => {
                const decisionType = String(item && item.decisionType || '').trim();
                const itemTarget = String(item && item.target || '').trim();
                return decisionType === 'file_path' && itemTarget === target;
            });
            if (!matched) {
                issues.push({
                    code: this._contractWarningCode(gateContract, 'selfReviewEvidence', 'DEMAND_PLANNER_SELF_REVIEW_EVIDENCE_REPLAY_INCOMPLETE'),
                    severity: 'warning',
                    message: `selfReviewSummary.evidenceReplay[] 未回放新增文件路径决策：${target}。`,
                    path: 'construction-plan.json.selfReviewSummary.evidenceReplay',
                    owner: 'Planner',
                    fix: '需要审计时补 file_path replay；新增文件硬授权以 placementEvidence、namingPreview.candidatePath 与 allowedFileScope.filePath 一致性为准。'
                });
            }
        });
    }

    checkCreateFileNamingItem(plan, item, index, navigationContract, projectPath, gateContract, issues) {
        const filePath = item && (item.filePath || item.path || item.candidatePath);
        const fileKind = this.extractFileKind(item);
        const preview = this.findNamingPreview(plan, item, projectPath);
        if (!preview) {
            issues.push({
                code: this._contractFailureCode(gateContract, 'fileNaming', 'DEMAND_PLANNER_FILE_NAMING_PREVIEW_MISSING'),
                severity: 'error',
                message: `allowedFileScope[${index}] 是新增文件，但缺少事前 namingPreview。`,
                evidence: filePath || JSON.stringify(item || {}),
                path: `construction-plan.json.allowedFileScope[${index}].namingPreview`,
                owner: 'Planner',
                fix: '写正式施工单前先根据 rulePlacementContract 生成 namingPreview；未 resolved 的新增文件只能进入 candidateFileScope 或 blocker。'
            });
            return;
        }
        const placementEvidence = item && item.placementEvidence && typeof item.placementEvidence === 'object' ?
            item.placementEvidence :
            {};
        const sourceType = String(placementEvidence.sourceType || '').trim();
        if (sourceType !== 'navigation_template_resolved') {
            issues.push({
                code: this._contractFailureCode(gateContract, 'fileScope', 'DEMAND_PLANNER_CREATE_FILE_SOURCE_NOT_TEMPLATE'),
                severity: 'error',
                message: `allowedFileScope[${index}] 是新增文件，路径授权必须来自导航契约模板解析，不能只用 ${sourceType || 'EMPTY'}。`,
                evidence: filePath || JSON.stringify(item || {}),
                path: `construction-plan.json.allowedFileScope[${index}].placementEvidence.sourceType`,
                owner: 'Planner',
                fix: '用户确认只能确认“需要新增/承载方式/变量值”，不能确认绕过命名合同的具体新增路径；按 rulePlacementContract 渲染 candidatePath 后使用 sourceType=navigation_template_resolved，或降级 candidateFileScope。'
            });
        } else {
            this.checkNavigationTemplateResolvedEvidence(placementEvidence, preview, index, item, issues);
        }

        const status = String(preview.status || '').trim().toLowerCase();
        const unresolved = Array.isArray(preview.unresolvedVariables) ? preview.unresolvedVariables.filter(Boolean) : [];
        if (status !== 'resolved' || unresolved.length > 0) {
            issues.push({
                code: this._contractFailureCode(gateContract, 'fileNaming', 'DEMAND_PLANNER_FILE_NAMING_PREVIEW_UNRESOLVED'),
                severity: 'error',
                message: `allowedFileScope[${index}] 的 namingPreview 尚未 resolved，不能升入 allowedFileScope。`,
                evidence: `status=${status || 'EMPTY'},unresolvedVariables=${unresolved.join(',') || 'EMPTY'}`,
                path: `construction-plan.json.allowedFileScope[${index}].namingPreview`,
                owner: 'Planner',
                fix: '缺少模板变量证据时，保持 draft=true 并输出 questionCard/blocker；变量名必须来自当前导航契约模板，不允许写死产品线命名。'
            });
        }

        const resolvedFileKind = String(preview.fileKind || fileKind || '').trim();
        const rule = this.findPlacementRule(navigationContract, resolvedFileKind);
        if (!rule) {
            issues.push({
                code: this._contractFailureCode(gateContract, 'placementContract', 'DEMAND_PLANNER_PLACEMENT_CONTRACT_MISSING'),
                severity: 'error',
                message: `新增文件缺少可回放的 rulePlacementContract 模板：${resolvedFileKind || 'EMPTY'}。`,
                evidence: filePath || JSON.stringify(item || {}),
                path: `construction-plan.json.allowedFileScope[${index}].placementEvidence`,
                owner: 'Planner',
                fix: '从工程导航契约 compact 的 rulePlacementContract.rules[] 读取新增文件模板；找不到模板时降级 candidateFileScope。'
            });
            return;
        }

        const variables = this.mergeNamingVariables(preview, item);
        const requiredVariables = this.extractTemplateVariables(`${rule.relativeDirPattern || ''}/${rule.fileNamePattern || ''}`);
        const variableCheck = this.checkNamingVariables(variables, requiredVariables);
        if (!variableCheck.ok) {
            issues.push({
                code: this._contractWarningCode(gateContract, 'fileNaming', 'DEMAND_PLANNER_FILE_NAMING_VARIABLES_INCOMPLETE'),
                severity: 'warning',
                message: `新增文件 ${filePath || resolvedFileKind || `#${index}`} 的命名变量来源不完整；这是命名审计信息缺失，不阻断已解析路径。`,
                evidence: variableCheck.evidence,
                path: `construction-plan.json.allowedFileScope[${index}].namingPreview.resolvedVariables`,
                owner: 'Planner',
                fix: '需要审计时补齐模板变量 value/source；硬阻断只针对 namingPreview 未 resolved、candidatePath 缺失或 allowedFileScope.filePath 与 candidatePath 不一致。'
            });
        }

        const actualPath = this.normalizeComparablePlanPath(filePath, projectPath);
        const previewPath = this.normalizeComparablePlanPath(preview.candidatePath || preview.filePath || preview.path || '', projectPath);
        if (!previewPath) {
            issues.push({
                code: 'DEMAND_PLANNER_FILE_NAMING_CANDIDATE_PATH_MISSING',
                severity: 'error',
                message: `allowedFileScope[${index}] 声明了 navigation_template_resolved，但 namingPreview.candidatePath 为空，无法证明具体路径由模板解析得到。`,
                evidence: filePath || JSON.stringify(item || {}),
                path: `construction-plan.json.allowedFileScope[${index}].namingPreview.candidatePath`,
                owner: 'Planner',
                fix: '不要只改 sourceType 字段；必须用 rulePlacementContract 模板生成 candidatePath，并让 allowedFileScope.filePath 与 candidatePath 一致。'
            });
        }
        if (previewPath && actualPath && actualPath !== previewPath) {
            issues.push({
                code: this._contractFailureCode(gateContract, 'fileNaming', 'DEMAND_PLANNER_FILE_NAMING_TEMPLATE_MISMATCH'),
                severity: 'error',
                message: `allowedFileScope[${index}] 新增文件路径与 namingPreview.candidatePath 不一致。`,
                evidence: `fileKind=${resolvedFileKind || 'EMPTY'},actual=${actualPath || 'EMPTY'},preview=${previewPath || 'EMPTY'}`,
                path: `construction-plan.json.allowedFileScope[${index}].filePath`,
                owner: 'Planner',
                fix: '门禁只校验 Planner 产物内部一致性；请全量重建 namingPreview 与 allowedFileScope，让 allowedFileScope.filePath 等于 namingPreview.candidatePath，或降级 candidateFileScope。'
            });
        }
    }

    checkNavigationTemplateResolvedEvidence(evidence = {}, preview = {}, index, item, issues = []) {
        const sourceArtifact = String(evidence.sourceArtifact || '').trim();
        const sourceField = String(evidence.sourceField || '').trim();
        const candidatePath = String(preview.candidatePath || preview.filePath || preview.path || '').trim();
        const missing = [];
        if (!sourceArtifact) {
            missing.push('placementEvidence.sourceArtifact');
        }
        if (!sourceField) {
            missing.push('placementEvidence.sourceField');
        } else if (!/rulePlacementContract\.rules(?:\[\d+\])?/iu.test(sourceField)) {
            missing.push('placementEvidence.sourceField(rulePlacementContract.rules[n])');
        }
        if (!candidatePath) {
            missing.push('namingPreview.candidatePath');
        }
        if (missing.length === 0) {
            return;
        }
        issues.push({
            code: 'DEMAND_PLANNER_NAVIGATION_TEMPLATE_EVIDENCE_INCOMPLETE',
            severity: 'error',
            message: `allowedFileScope[${index}] 不能只把 sourceType 改成 navigation_template_resolved；还必须回放导航契约模板、模板字段和解析后的 candidatePath。`,
            evidence: `missing=${missing.join(',')}; file=${item && (item.filePath || item.path || item.candidatePath) || 'EMPTY'}`,
            path: `construction-plan.json.allowedFileScope[${index}].placementEvidence`,
            owner: 'Planner',
            fix: '按 rulePlacementContract.rules[n] 生成 namingPreview.candidatePath，并写入 placementEvidence.sourceArtifact/sourceField；否则降级 candidateFileScope。'
        });
    }

    isCreateScopeItem(item = {}) {
        const action = String(item.action || item.operation || item.fileAction || '').trim().toLowerCase();
        return action === 'create' || action === 'add' || action === 'new' || action === '新增';
    }

    extractFileKind(item = {}) {
        const evidence = item.placementEvidence && typeof item.placementEvidence === 'object' ? item.placementEvidence : {};
        return String(item.fileKind || item.kind || evidence.fileKind || evidence.targetKind || '').trim();
    }

    loadNavigationPlacementContract(plan, projectPath) {
        void plan;
        const candidates = [];
        if (projectPath) {
            candidates.push(path.join(projectPath, '.ai-workspace', 'project', '工程导航契约.compact.json'));
            candidates.push(path.join(projectPath, '.ai-workspace', 'project', '工程导航契约.json'));
        }
        for (const candidate of candidates) {
            if (!candidate || !fs.existsSync(candidate)) {
                continue;
            }
            try {
                const parsed = JSON.parse(fs.readFileSync(candidate, 'utf-8'));
                const contract = parsed && parsed.rulePlacementContract && typeof parsed.rulePlacementContract === 'object' ?
                    parsed.rulePlacementContract :
                    parsed;
                if (contract && Array.isArray(contract.rules)) {
                    return contract;
                }
            } catch (_) {
                // Ignore malformed navigation cache; the caller will emit a missing-contract issue.
            }
        }
        return null;
    }

    findPlacementRule(contract, fileKind) {
        const target = String(fileKind || '').trim().toLowerCase();
        if (!contract || !Array.isArray(contract.rules) || !target) {
            return null;
        }
        return contract.rules.find(rule => {
            const names = [
                rule && rule.fileKind,
                rule && rule.kind,
                rule && rule.targetKind,
                rule && rule.name
            ].map(value => String(value || '').trim().toLowerCase()).filter(Boolean);
            return names.includes(target);
        }) || null;
    }

    findNamingPreview(plan, item, projectPath) {
        if (item && item.namingPreview && typeof item.namingPreview === 'object') {
            return item.namingPreview;
        }
        const previews = this.collectNamingPreviews(plan);
        const itemPath = this.normalizeComparablePlanPath(item && (item.filePath || item.path || item.candidatePath), projectPath);
        const itemKind = this.extractFileKind(item).toLowerCase();
        const itemTodoIds = new Set(this._stringArray(item && item.boundTodoIds).map(String));
        const pathMatched = previews.find(preview => {
            const previewPath = this.normalizeComparablePlanPath(preview && (preview.candidatePath || preview.filePath || preview.path), projectPath);
            return Boolean(itemPath && previewPath && itemPath === previewPath);
        });
        if (pathMatched) {
            return pathMatched;
        }
        const kindMatched = previews.filter(preview => {
            const previewKind = String(preview && preview.fileKind || '').trim().toLowerCase();
            return itemKind && previewKind && itemKind === previewKind;
        });
        if (itemTodoIds.size > 0) {
            return kindMatched.find(preview => {
                const previewTodoIds = this._stringArray(preview && preview.boundTodoIds).map(String);
                return previewTodoIds.some(id => itemTodoIds.has(id));
            }) || null;
        }
        if (kindMatched.length === 1) {
            return kindMatched[0];
        }
        return null;
    }

    collectNamingPreviews(plan) {
        const raw = plan && (plan.namingPreview || plan.namingPreviews || plan.fileNamingPreviews);
        if (!raw) {
            return [];
        }
        if (Array.isArray(raw)) {
            return raw.filter(item => item && typeof item === 'object');
        }
        if (typeof raw === 'object') {
            if (raw.status || raw.candidatePath || raw.fileKind) {
                return [raw];
            }
            return Object.values(raw).filter(item => item && typeof item === 'object');
        }
        return [];
    }

    mergeNamingVariables(preview = {}, item = {}) {
        const evidence = item.placementEvidence && typeof item.placementEvidence === 'object' ? item.placementEvidence : {};
        const merged = {};
        [evidence.resolvedVariables, preview.resolvedVariables].forEach(source => {
            if (!source || typeof source !== 'object') {
                return;
            }
            Object.keys(source).forEach(key => {
                merged[key] = source[key];
            });
        });
        return merged;
    }

    extractTemplateVariables(pattern) {
        const vars = new Set();
        const regex = /\{([A-Za-z_$][\w$]*)\}/gu;
        let match = regex.exec(String(pattern || ''));
        while (match) {
            vars.add(match[1]);
            match = regex.exec(String(pattern || ''));
        }
        return Array.from(vars);
    }

    checkNamingVariables(variables = {}, required = []) {
        const values = {};
        const missing = [];
        required.forEach(key => {
            const entry = variables[key];
            if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
                const value = String(entry.value || '').trim();
                const source = String(entry.source || entry.evidence || entry.sourceArtifact || '').trim();
                if (value && source) {
                    values[key] = value;
                    return;
                }
                missing.push(`${key}${value ? '.source' : '.value'}`);
                return;
            }
            const value = String(entry || '').trim();
            if (value) {
                missing.push(`${key}.source`);
            } else {
                missing.push(key);
            }
        });
        return {
            ok: missing.length === 0,
            values,
            evidence: missing.length > 0 ? `missing=${missing.join(',')}` : 'ok'
        };
    }

    renderTemplate(pattern, values = {}) {
        return String(pattern || '').replace(/\{([A-Za-z_$][\w$]*)\}/gu, (_, key) => String(values[key] || ''));
    }

    resolveMaybeProjectPath(filePath, projectPath) {
        const text = String(filePath || '').trim();
        if (!text) {
            return '';
        }
        if (path.isAbsolute(text)) {
            return path.resolve(text);
        }
        return path.resolve(String(projectPath || '').trim() || '.', text);
    }

    normalizeComparablePlanPath(filePath, projectPath) {
        const text = String(filePath || '').trim();
        if (!text) {
            return '';
        }
        let absolutePath = '';
        if (path.isAbsolute(text)) {
            absolutePath = path.resolve(text);
        }
        const root = String(projectPath || '').trim() ? path.resolve(projectPath) : '';
        if (absolutePath && root) {
            const relative = path.relative(root, absolutePath);
            if (relative && !relative.startsWith('..') && !path.isAbsolute(relative)) {
                return this.normalizeRelativePath(relative);
            }
        }
        return this.normalizeRelativePath(text);
    }

    normalizeRelativePath(filePath) {
        return String(filePath || '')
            .trim()
            .replace(/\\/gu, '/')
            .replace(/\/+/gu, '/')
            .replace(/^\.\//u, '')
            .replace(/\/$/u, '');
    }

    _stringArray(value) {
        if (!Array.isArray(value)) {
            return [];
        }
        return value.map(item => String(item || '').trim()).filter(Boolean);
    }

    _contractFailureCode(gateContract, dimensionId, fallbackCode) {
        const fn = this.helpers && this.helpers.contractFailureCode;
        return typeof fn === 'function' ? fn(gateContract, dimensionId, fallbackCode) : fallbackCode;
    }

    _contractWarningCode(gateContract, dimensionId, fallbackCode) {
        const fn = this.helpers && this.helpers.contractWarningCode;
        return typeof fn === 'function' ? fn(gateContract, dimensionId, fallbackCode) : fallbackCode;
    }
}

module.exports = PlacementNamingGateService;
