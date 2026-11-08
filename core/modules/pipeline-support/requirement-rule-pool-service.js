/* eslint-disable */

/**
 * RequirementRulePoolService
 *
 * Requirement-stage rule recall is confirmed before design starts.
 * This service validates source closure and projects confirmed Story rule references:
 * - every User Story in 需求分析.md has one recall entry
 * - the global rule pool was confirmed by the user
 * - design rule bindings only use aliases from the confirmed pool
 */
class RequirementRulePoolService {
    /**
     * 提取 User Story 列表。
     *
     * 真值源优先级：
     *   1. options.stories（由 finalize 入口从 stories.json 注入，最权威）
     *   2. analysisState.storyIds（向后兼容旧 fixture / 旧 demand）
     *   3. demandMarkdown（兜底解析人读 markdown）
     *
     * AGENTS.md "确定事实不进 LLM 视野" 红线：
     *   stories.json 是 Builder 落盘的机器合同，应作为 storyIds 唯一真值源；
     *   analysis-state.json.storyIds 不再由 stories_submit 合回，仅留作向后兼容。
     */
    extractUserStories(analysisState, markdown = '', options = {}) {
        // 真值源 1：stories.json 派生的 storyIds（finalize 入口注入）
        const fromStoriesJson = this._extractStoriesFromInjectedStoryIds(options && options.storyIds);
        if (fromStoriesJson.length > 0) return fromStoriesJson;
        // 兼容源 2：analysis-state.json.storyIds（向后兼容老 demand）
        const fromState = this._extractStoriesFromAnalysisState(analysisState);
        if (fromState.length > 0) return fromState;
        // 兜底:解析 markdown（向后兼容老需求分析.md）
        const fromSection2 = this._extractStoriesFromSection2(markdown);
        if (fromSection2.length > 0) return fromSection2;
        const fromMatrix = this._extractStoriesFromMatrix(markdown);
        if (fromMatrix.length > 0) return fromMatrix;
        const fromAcceptanceHeadings = this._extractStoriesFromAcceptanceHeadings(markdown);
        if (fromAcceptanceHeadings.length > 0) return fromAcceptanceHeadings;
        return this._extractStoriesFromSection3Table(markdown);
    }

    _extractStoriesFromInjectedStoryIds(injectedIds) {
        if (!Array.isArray(injectedIds) || injectedIds.length === 0) return [];
        const stories = [];
        const seen = new Set();
        injectedIds.forEach(raw => {
            const storyId = this._normalizeStoryId(raw);
            if (!storyId || seen.has(storyId)) return;
            seen.add(storyId);
            stories.push({ storyId, userStory: storyId, value: storyId });
        });
        return stories;
    }

    _extractStoriesFromAnalysisState(analysisState) {
        if (!analysisState || typeof analysisState !== 'object' || Array.isArray(analysisState)) return [];
        const ids = Array.isArray(analysisState.storyIds) ? analysisState.storyIds : null;
        if (!ids || ids.length === 0) return [];
        const stories = [];
        const seen = new Set();
        ids.forEach(raw => {
            const storyId = this._normalizeStoryId(raw);
            if (!storyId || seen.has(storyId)) return;
            seen.add(storyId);
            stories.push({ storyId, userStory: storyId, value: storyId });
        });
        return stories;
    }

    _extractStoriesFromSection2(markdown = '') {
        // 模板格式：**US-1**: 作为 ... 我希望 ... 以便 ...（§2 纯文本）
        const section = this._extractSection(markdown, /^##\s*2[.\s：:、]/u);
        if (!section) return [];
        const lines = String(section).split(/\r?\n/u);
        const stories = [];
        const seen = new Set();
        const pattern = /^\s*(?:\*\*|__)?\s*(US[-_\s]?\d+)\s*(?:\*\*|__)?\s*[:：]\s*(.+?)\s*$/u;
        lines.forEach(line => {
            const match = pattern.exec(String(line || ''));
            if (!match) return;
            const storyId = this._normalizeStoryId(match[1]);
            const userStory = String(match[2] || '').trim();
            if (!storyId || !userStory || seen.has(storyId)) return;
            seen.add(storyId);
            stories.push({ storyId, userStory, value: userStory });
        });
        return stories;
    }

    _extractStoriesFromMatrix(markdown = '') {
        // 兼容格式：§2.5 Actor-Story 矩阵第二列含 US-N 业务摘要
        const section = this._extractSection(markdown, /^##\s*2\.5[.\s：:、]?/u)
            || this._extractSection(markdown, /Actor[\s\-_]?Story\s*矩阵/iu);
        if (!section) return [];
        const stories = [];
        const seen = new Set();
        this._extractTableRows(section).forEach(row => {
            if (row.length < 2) return;
            const cell = String(row[1] || '').trim();
            const match = /^(US[-_\s]?\d+)[\s\-_：:]?\s*(.+)?$/u.exec(cell);
            if (!match) return;
            const storyId = this._normalizeStoryId(match[1]);
            const summary = String(match[2] || cell).trim();
            if (!storyId || seen.has(storyId)) return;
            seen.add(storyId);
            stories.push({ storyId, userStory: summary, value: summary });
        });
        return stories;
    }

    _extractStoriesFromAcceptanceHeadings(markdown = '') {
        // 兼容格式：§3 用 ### US-N 子标题
        const section = this._extractSection(markdown, /^##\s*3[.\s：:、]/u);
        if (!section) return [];
        const stories = [];
        const seen = new Set();
        String(section).split(/\r?\n/u).forEach(line => {
            const match = /^#{2,4}\s*(US[-_\s]?\d+)\b\s*(.*)$/u.exec(String(line || ''));
            if (!match) return;
            const storyId = this._normalizeStoryId(match[1]);
            const summary = String(match[2] || '').trim() || storyId;
            if (!storyId || seen.has(storyId)) return;
            seen.add(storyId);
            stories.push({ storyId, userStory: summary, value: summary });
        });
        return stories;
    }

    _extractStoriesFromSection3Table(markdown = '') {
        // 兼容格式：§3 表格首列为 US1（旧回归 fixture 使用）
        const section = this._extractSection(markdown, /^##\s*3[.\s：:、]/u);
        if (!section) return [];
        const stories = [];
        const seen = new Set();
        this._extractTableRows(section).forEach(row => {
            const idCell = String(row[0] || '').trim();
            if (!/^US[-_\s]?\d+/iu.test(idCell)) return;
            const storyId = this._normalizeStoryId(idCell);
            const userStory = String(row[1] || '').trim();
            if (!storyId || !userStory || seen.has(storyId)) return;
            seen.add(storyId);
            stories.push({ storyId, userStory, value: String(row[2] || '').trim() });
        });
        return stories;
    }

    _normalizeStoryId(raw = '') {
        return String(raw || '').replace(/[\s_]/gu, '').toUpperCase().replace(/^US-?/u, 'US');
    }

    validateRulePool(rulePool = null, demandMarkdown = '', options = {}) {
        const issues = [];
        const sourcePath = String(options.sourcePath || 'demand/rule-pool.json');
        const analysisState = options && options.analysisState !== undefined ? options.analysisState : null;
        const injectedStoryIds = Array.isArray(options && options.storyIds) ? options.storyIds : null;
        if (!rulePool || typeof rulePool !== 'object' || Array.isArray(rulePool)) {
            return this._result([{
                code: 'REQUIREMENT_RULE_POOL_INVALID',
                path: sourcePath,
                field: 'rule-pool.json',
                expected: 'object',
                actual: rulePool === null || rulePool === undefined ? 'missing' : typeof rulePool,
                message: '需求阶段规则池缺失或不是 JSON object。'
            }], null, sourcePath);
        }

        const stories = this.extractUserStories(analysisState, demandMarkdown, { storyIds: injectedStoryIds });
        if (stories.length === 0) {
            issues.push({
                code: 'REQUIREMENT_RULE_POOL_STORY_ANCHORS_EMPTY',
                path: 'demand/stories.json',
                field: 'storyIds',
                expected: 'stories.json.storyIds 至少一条 US（由 req_stories_submit Builder 落盘）',
                actual: 'empty',
                message: '未提取到 User Story：请先调 req_stories_submit 让 Builder 落盘 stories.json。'
            });
        }

        const confirmed = rulePool.confirmed === true || rulePool.globalRulePoolConfirmed === true;
        if (!confirmed) {
            issues.push({
                code: 'REQUIREMENT_RULE_POOL_NOT_CONFIRMED',
                path: sourcePath,
                field: 'confirmed',
                expected: true,
                actual: rulePool.confirmed === undefined ? rulePool.globalRulePoolConfirmed : rulePool.confirmed,
                message: '需求阶段规则池尚未标记用户已确认，设计阶段不能消费。'
            });
        }

        if (!Array.isArray(rulePool.globalWhitelist)) {
            issues.push({
                code: 'REQUIREMENT_RULE_POOL_GLOBAL_WHITELIST_INVALID',
                path: `${sourcePath}$.globalWhitelist`,
                field: 'globalWhitelist',
                expected: 'array',
                actual: typeof rulePool.globalWhitelist,
                message: 'rule-pool.json 必须包含 globalWhitelist[]；没有可用业务规则时也写空数组。'
            });
        }
        if (!Array.isArray(rulePool.globalBlocklist)) {
            issues.push({
                code: 'REQUIREMENT_RULE_POOL_GLOBAL_BLOCKLIST_INVALID',
                path: `${sourcePath}$.globalBlocklist`,
                field: 'globalBlocklist',
                expected: 'array',
                actual: typeof rulePool.globalBlocklist,
                message: 'rule-pool.json 必须包含 globalBlocklist[]；没有剔除规则时也写空数组。'
            });
        }

        const entries = this._storyRuleEntries(rulePool);
        if (entries.length === 0) {
            issues.push({
                code: 'REQUIREMENT_RULE_POOL_STORY_RECALLS_EMPTY',
                path: `${sourcePath}$.storyRuleRecalls`,
                field: 'storyRuleRecalls',
                expected: 'array with one entry per User Story',
                actual: 'empty',
                message: 'rule-pool.json 缺少按 User Story 记录的规则召回结果。'
            });
        }

        const hasBusinessRules = this._ruleArrayHasAny(rulePool.globalWhitelist)
            || entries.some(entry => this._ruleArrayHasAny(entry && entry.acceptedRules));
        const userInputForGlobalPool = String(rulePool.userInputForGlobalPool || rulePool.globalRulePoolUserInput || '').trim();
        if (hasBusinessRules && !userInputForGlobalPool) {
            issues.push({
                code: 'REQUIREMENT_RULE_POOL_GLOBAL_CONFIRMATION_INPUT_MISSING',
                path: `${sourcePath}$.userInputForGlobalPool`,
                field: 'userInputForGlobalPool',
                expected: '用户对全局业务可选规则池的确认原文，如 OK/确认/剔除 2',
                actual: 'missing',
                message: '规则池含业务可选规则时，必须记录用户对全局规则剔除卡的确认输入，不能只写 confirmed=true。'
            });
        }

        const confirmedDecisionTexts = this._extractConfirmedDecisionTexts(analysisState);

        const expectedStoryIds = new Set(stories.map(item => item.storyId));
        const entryMap = new Map();
        entries.forEach((entry, index) => {
            const storyId = String(entry && (entry.storyId || entry.id || entry.userStoryId) || '').trim().toUpperCase();
            if (!storyId) {
                issues.push({
                    code: 'REQUIREMENT_RULE_POOL_STORY_ID_MISSING',
                    path: `${sourcePath}$.storyRuleRecalls[${index}]`,
                    field: 'storyId',
                    expected: 'US id',
                    actual: 'missing',
                    message: '规则池每条故事召回必须有 storyId。'
                });
                return;
            }
            if (entryMap.has(storyId)) {
                issues.push({
                    code: 'REQUIREMENT_RULE_POOL_STORY_DUPLICATED',
                    path: `${sourcePath}$.storyRuleRecalls[${index}]`,
                    field: 'storyId',
                    expected: 'unique storyId',
                    actual: storyId,
                    message: `规则池中 ${storyId} 重复。`
                });
            }
            entryMap.set(storyId, entry);
            if (!Array.isArray(entry.acceptedRules)) {
                issues.push({
                    code: 'REQUIREMENT_RULE_POOL_ACCEPTED_RULES_INVALID',
                    path: `${sourcePath}$.storyRuleRecalls[${index}].acceptedRules`,
                    field: 'acceptedRules',
                    storyId,
                    expected: 'array',
                    actual: typeof entry.acceptedRules,
                    message: `${storyId} 的 acceptedRules 必须是数组；无业务规则时写 []。`
                });
            }
            if (entry.baselineConstraints !== undefined && !Array.isArray(entry.baselineConstraints)) {
                issues.push({
                    code: 'REQUIREMENT_RULE_POOL_BASELINE_INVALID',
                    path: `${sourcePath}$.storyRuleRecalls[${index}].baselineConstraints`,
                    field: 'baselineConstraints',
                    storyId,
                    expected: 'array',
                    actual: typeof entry.baselineConstraints,
                    message: `${storyId} 的 baselineConstraints 必须是数组或省略。`
                });
            }
            confirmedDecisionTexts.forEach(decision => {
                const haystack = this._ruleSearchIntentHaystack(entry);
                if (!this._textContainsAll(haystack, decision.requiredTexts)) {
                    issues.push({
                        code: 'REQUIREMENT_RULE_POOL_CONFIRMED_DECISION_NOT_IN_RECALL_INPUT',
                        path: `${sourcePath}$.storyRuleRecalls[${index}].ruleSearchIntent`,
                        field: 'ruleSearchIntent',
                        storyId,
                        expected: `包含已确认模糊点结论：${decision.label}`,
                        actual: 'missing',
                        message: `${storyId} 的规则召回输入未包含 Step 5 已确认模糊点结论，不能证明用户回答已参与 rule_expert(action="analyze")。`
                    });
                }
            });
        });

        stories.forEach(story => {
            if (!entryMap.has(story.storyId)) {
                issues.push({
                    code: 'REQUIREMENT_RULE_POOL_STORY_MISSING',
                    path: `${sourcePath}$.storyRuleRecalls`,
                    field: 'storyId',
                    storyId: story.storyId,
                    expected: story.storyId,
                    actual: 'missing',
                    message: `规则池缺少 ${story.storyId} 的召回记录。`
                });
            }
        });

        const acceptedAliasSet = this._acceptedAliasSet(entries);
        const whitelist = this._aliasSet(rulePool.globalWhitelist);
        const blocklist = this._aliasSet(rulePool.globalBlocklist);
        entries.forEach((entry, index) => {
            (Array.isArray(entry && entry.acceptedRules) ? entry.acceptedRules : []).forEach(rule => {
                const alias = this._ruleAlias(rule);
                if (!alias) return;
                if (blocklist.has(alias)) {
                    issues.push({
                        code: 'REQUIREMENT_RULE_POOL_BLOCKLIST_STILL_ACCEPTED',
                        path: `${sourcePath}$.storyRuleRecalls[${index}].acceptedRules`,
                        field: 'storyRuleRecalls[].acceptedRules',
                        ruleAlias: alias,
                        expected: 'blocklisted alias removed from every story acceptedRules',
                        actual: alias,
                        message: `已剔除规则仍残留在 Story acceptedRules 中：${alias}`
                    });
                    return;
                }
                if (!whitelist.has(alias)) {
                    issues.push({
                        code: 'REQUIREMENT_RULE_POOL_ACCEPTED_RULE_NOT_CONFIRMED_GLOBALLY',
                        path: `${sourcePath}$.storyRuleRecalls[${index}].acceptedRules`,
                        field: 'storyRuleRecalls[].acceptedRules',
                        ruleAlias: alias,
                        expected: 'alias in globalWhitelist after user confirmation',
                        actual: alias,
                        message: `Story 召回的业务规则未进入全局用户确认白名单：${alias}。所有检索出的业务可选规则都必须展示给用户确认，保留后写入 globalWhitelist，剔除后写入 globalBlocklist 并从 Story acceptedRules 移除。`
                    });
                }
            });
        });
        whitelist.forEach(alias => {
            if (acceptedAliasSet.size > 0 && !acceptedAliasSet.has(alias)) {
                issues.push({
                    code: 'REQUIREMENT_RULE_POOL_WHITELIST_NOT_RECALLED',
                    path: `${sourcePath}$.globalWhitelist`,
                    field: 'globalWhitelist',
                    ruleAlias: alias,
                    expected: 'alias from story acceptedRules',
                    actual: alias,
                    message: `globalWhitelist 中的规则未出现在任一 User Story acceptedRules：${alias}`
                });
            }
            if (blocklist.has(alias)) {
                issues.push({
                    code: 'REQUIREMENT_RULE_POOL_ALIAS_BOTH_WHITE_AND_BLOCK',
                    path: `${sourcePath}$.globalWhitelist`,
                    field: 'globalWhitelist/globalBlocklist',
                    ruleAlias: alias,
                    expected: 'alias appears in only one list',
                    actual: alias,
                    message: `规则不能同时在 globalWhitelist 和 globalBlocklist 中：${alias}`
                });
            }
        });

        return this._result(issues, {
            confirmed,
            storyCount: stories.length,
            storyRuleRecalls: entries,
            globalWhitelist: Array.isArray(rulePool.globalWhitelist) ? rulePool.globalWhitelist : [],
            globalBlocklist: Array.isArray(rulePool.globalBlocklist) ? rulePool.globalBlocklist : [],
            tableCandidatePoolConfirmed: rulePool.tableCandidatePoolConfirmed === true,
            globalTableCandidateWhitelist: Array.isArray(rulePool.globalTableCandidateWhitelist) ? rulePool.globalTableCandidateWhitelist : [],
            globalTableCandidateBlocklist: Array.isArray(rulePool.globalTableCandidateBlocklist) ? rulePool.globalTableCandidateBlocklist : []
        }, sourcePath);
    }

    validateRuleBindingsAgainstPool(ruleBindings = null, rulePool = null, options = {}) {
        const sourcePath = String(options.sourcePath || 'design/rule-bindings.json');
        const poolPath = String(options.poolPath || 'demand/rule-pool.json');
        const issues = [];
        if (!ruleBindings || typeof ruleBindings !== 'object' || Array.isArray(ruleBindings)) {
            return this._poolBindingResult([]);
        }
        const poolValidation = this.validateRulePool(rulePool, options.demandMarkdown || '', {
            sourcePath: poolPath,
            analysisState: options.analysisState || null,
            storyIds: options.storyIds || null
        });
        if (!poolValidation.ok) {
            issues.push({
                code: 'RULE_BINDING_REQUIREMENT_POOL_INVALID',
                path: poolPath,
                field: 'rule-pool.json',
                expected: 'valid confirmed requirement rule pool',
                actual: 'invalid',
                message: '设计规则绑定需要先闭合到有效的需求阶段规则池。'
            });
            return this._poolBindingResult(issues);
        }

        const allowed = this._aliasSet(poolValidation.summary.globalWhitelist);
        const blocked = this._aliasSet(poolValidation.summary.globalBlocklist);
        const designWhitelist = this._aliasSet(ruleBindings.globalWhitelist);
        const moduleSelections = this._collectRuleBindingSelections(ruleBindings.moduleBindings);
        const aliases = new Set([...designWhitelist, ...moduleSelections.map(item => item.ruleAlias).filter(Boolean)]);
        aliases.forEach(alias => {
            if (blocked.has(alias)) {
                issues.push({
                    code: 'RULE_BINDING_ALIAS_BLOCKED_BY_REQUIREMENT_POOL',
                    path: sourcePath,
                    field: 'ruleAlias',
                    ruleAlias: alias,
                    expected: 'not in requirement globalBlocklist',
                    actual: alias,
                    message: `设计绑定引用了需求阶段已剔除的规则：${alias}`
                });
            }
            if (!allowed.has(alias)) {
                issues.push({
                    code: 'RULE_BINDING_ALIAS_NOT_IN_REQUIREMENT_POOL',
                    path: sourcePath,
                    field: 'ruleAlias',
                    ruleAlias: alias,
                    expected: 'alias in requirement globalWhitelist',
                    actual: alias,
                    message: `设计绑定引用了未在需求阶段确认池中的规则：${alias}`
                });
            }
        });
        return this._poolBindingResult(issues);
    }

    buildStoryRuleRefs(rulePool = {}) {
        rulePool = rulePool && typeof rulePool === 'object' ? rulePool : {};
        const confirmed = new Map((Array.isArray(rulePool.globalWhitelist) ? rulePool.globalWhitelist : [])
            .map(rule => [this._ruleAlias(rule), rule]).filter(([alias]) => alias));
        const blocked = new Set((Array.isArray(rulePool.globalBlocklist) ? rulePool.globalBlocklist : [])
            .map(rule => this._ruleAlias(rule)));
        return Object.fromEntries(this._storyRuleEntries(rulePool).map(entry => {
            const seen = new Set();
            const refs = (Array.isArray(entry.acceptedRules) ? entry.acceptedRules : []).flatMap(rule => {
                const alias = this._ruleAlias(rule);
                if (!confirmed.has(alias) || blocked.has(alias) || seen.has(alias)) return [];
                seen.add(alias);
                // Only project confirmed source metadata; recall hits are not capability decisions.
                const metadata = { ...confirmed.get(alias), ...(typeof rule === 'object' ? rule : {}) };
                return [{ ruleAlias: alias, ...this._pick(metadata,
                    ['path', 'source', 'signal', 'readScope', 'matchReason', 'version', 'versionBucket']) }];
            });
            return [String(entry.storyId || '').trim().toUpperCase(), refs];
        }));
    }

    buildSlimSummary(rulePool = {}, sourcePath = '') {
        const entries = this._storyRuleEntries(rulePool);
        return {
            sourcePath,
            confirmed: rulePool && (rulePool.confirmed === true || rulePool.globalRulePoolConfirmed === true),
            storyCount: entries.length,
            globalWhitelist: this._slimRules(rulePool.globalWhitelist || []),
            globalBlocklist: this._slimRules(rulePool.globalBlocklist || []),
            tableCandidatePoolConfirmed: rulePool && rulePool.tableCandidatePoolConfirmed === true,
            globalTableCandidateWhitelist: Array.isArray(rulePool && rulePool.globalTableCandidateWhitelist)
                ? rulePool.globalTableCandidateWhitelist.slice(0, 12).map(item => this._pick(item, ['tableName', 'entityName', 'tableDisplayName', 'role', 'matchedTerms', 'matchReasons', 'score', 'sourceStoryIds']))
                : [],
            globalTableCandidateBlocklist: Array.isArray(rulePool && rulePool.globalTableCandidateBlocklist)
                ? rulePool.globalTableCandidateBlocklist.slice(0, 12).map(item => this._pick(item, ['tableName', 'entityName', 'tableDisplayName', 'role', 'matchedTerms', 'matchReasons', 'score', 'sourceStoryIds']))
                : [],
            storyRuleRecalls: entries.map(entry => ({
                storyId: String(entry && (entry.storyId || entry.id || entry.userStoryId) || '').trim().toUpperCase(),
                userStory: String(entry && entry.userStory || '').trim(),
                acceptedRules: this._slimRules(entry && entry.acceptedRules || []),
                baselineConstraints: this._slimRules(entry && entry.baselineConstraints || []),
                projectTableCandidates: Array.isArray(entry && entry.projectTableCandidates)
                    ? entry.projectTableCandidates.slice(0, 8).map(item => this._pick(item, ['tableName', 'entityName', 'tableDisplayName', 'role', 'matchedTerms', 'matchReasons', 'score', 'sourceStoryIds']))
                    : [],
                unresolvedSignals: Array.isArray(entry && entry.unresolvedSignals) ? entry.unresolvedSignals.slice(0, 8) : []
            }))
        };
    }

    _collectRuleBindingSelections(moduleBindings = undefined) {
        const result = [];
        const visit = (moduleId, entry, path) => {
            if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return;
            const raw = Array.isArray(entry.ruleSelections)
                ? entry.ruleSelections
                : (Array.isArray(entry.boundRules) ? entry.boundRules : []);
            raw.forEach((selection, index) => {
                const ruleAlias = String(selection && (selection.ruleAlias || selection.ruleName) || '').trim();
                if (!ruleAlias) return;
                result.push({
                    moduleId,
                    ruleAlias,
                    path: `${path}.ruleSelections[${index}]`
                });
            });
        };
        if (Array.isArray(moduleBindings)) {
            moduleBindings.forEach((entry, index) => visit(String(entry && (entry.moduleId || entry.id) || '').trim(), entry, `$.moduleBindings[${index}]`));
        } else if (moduleBindings && typeof moduleBindings === 'object') {
            Object.entries(moduleBindings).forEach(([moduleId, entry]) => visit(moduleId, entry, `$.moduleBindings.${moduleId}`));
        }
        return result;
    }

    _storyRuleEntries(rulePool = {}) {
        const candidates = [
            rulePool && rulePool.storyRuleRecalls,
            rulePool && rulePool.storyRules,
            rulePool && rulePool.ruleRecalls,
            rulePool && rulePool.stories
        ];
        return candidates.find(Array.isArray) || [];
    }

    _ruleArrayHasAny(value = []) {
        return Array.isArray(value) && value.some(item => Boolean(this._ruleAlias(item)));
    }

    _extractConfirmedDecisionTexts(analysisState = null) {
        const candidates = [];
        const visit = value => {
            if (!value) return;
            if (Array.isArray(value)) {
                value.forEach(visit);
                return;
            }
            if (typeof value !== 'object') return;
            const fuzzyPoint = String(value.fuzzyPoint || value.question || value.title || value.aspect || '').trim();
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
            const adoptedSolution = String(value.adoptedSolution || value.solution || value.answer || value.confirmedAnswer || value.selectedAnswer || value.userAnswer || '').trim();
            const legacyUserInput = String(value.userInput || '').trim();
            const userChoice = String(value.userChoice || value.choice || value.selectedOption || '').trim();
            const cleanTexts = [businessDecision, flowImpact].filter(Boolean);
            const fallbackText = adoptedSolution || legacyUserInput;
            if (cleanTexts.length > 0 || fallbackText) {
                const requiredTexts = cleanTexts.length > 0 ? cleanTexts : [fallbackText].filter(Boolean);
                candidates.push({
                    label: [fuzzyPoint, ...requiredTexts, userChoice].filter(Boolean).join(' / '),
                    requiredTexts
                });
            }
            if (Object.prototype.hasOwnProperty.call(value, 'decisions')) visit(value.decisions);
            if (Object.prototype.hasOwnProperty.call(value, 'decision')) visit(value.decision);
        };
        if (analysisState && typeof analysisState === 'object') {
            visit(analysisState.ambiguityCards);
            visit(analysisState.ambiguityPoints);
            visit(analysisState.decisions);
            visit(analysisState.confirmedDecisions);
            visit(analysisState.units);
        }
        const seen = new Set();
        return candidates.filter(item => {
            const key = item.requiredTexts.join('\n');
            if (!key || seen.has(key)) return false;
            seen.add(key);
            return true;
        });
    }

    _ruleSearchIntentHaystack(entry = {}) {
        const parts = [
            entry && entry.ruleSearchIntent,
            entry && entry.searchIntent,
            entry && entry.userIntent,
            entry && entry.recallText
        ];
        return this._normalizeComparableText(parts.filter(Boolean).join('\n'));
    }

    _textContainsAll(haystack = '', needles = []) {
        const normalizedHaystack = this._normalizeComparableText(haystack);
        return needles.every(needle => {
            const normalizedNeedle = this._normalizeComparableText(needle);
            return !normalizedNeedle || normalizedHaystack.includes(normalizedNeedle);
        });
    }

    _normalizeComparableText(value = '') {
        return String(value || '').replace(/\s+/gu, '');
    }

    _acceptedAliasSet(entries = []) {
        const set = new Set();
        entries.forEach(entry => {
            (Array.isArray(entry && entry.acceptedRules) ? entry.acceptedRules : [])
                .forEach(rule => {
                    const alias = this._ruleAlias(rule);
                    if (alias) set.add(alias);
                });
        });
        return set;
    }

    _aliasSet(value = []) {
        const set = new Set();
        if (!Array.isArray(value)) return set;
        value.forEach(item => {
            const alias = this._ruleAlias(item);
            if (alias) set.add(alias);
        });
        return set;
    }

    _ruleAlias(value) {
        return typeof value === 'string'
            ? String(value || '').trim()
            : String(value && (value.ruleAlias || value.ruleName || value.alias) || '').trim();
    }

    _slimRules(rules = []) {
        if (!Array.isArray(rules)) return [];
        return rules.slice(0, 30).map(rule => {
            if (typeof rule === 'string') return rule;
            return this._pick(rule, [
                'ruleAlias',
                'ruleName',
                'category',
                'signal',
                'referencePolicy',
                'authorityMode',
                'usageDuty',
                'confidence',
                'matchReason',
                'matchedKeywords',
                'matchedTerms',
                'readScope'
            ]);
        });
    }

    _pick(source = {}, keys = []) {
        const result = {};
        if (!source || typeof source !== 'object') return result;
        keys.forEach(key => {
            if (Object.prototype.hasOwnProperty.call(source, key)) {
                result[key] = source[key];
            }
        });
        return result;
    }

    _extractSection(markdown = '', headingPattern = null) {
        const lines = String(markdown || '').split(/\r?\n/u);
        let start = -1;
        for (let i = 0; i < lines.length; i++) {
            const line = String(lines[i] || '');
            if (headingPattern && headingPattern.test(line)) {
                start = i;
                break;
            }
        }
        if (start < 0) return '';
        let end = lines.length;
        for (let i = start + 1; i < lines.length; i++) {
            if (/^##\s+/u.test(String(lines[i] || ''))) {
                end = i;
                break;
            }
        }
        return lines.slice(start, end).join('\n');
    }

    _extractTableRows(markdown = '') {
        return String(markdown || '').split(/\r?\n/u)
            .map(line => String(line || '').trim())
            .filter(line => line.startsWith('|') && line.endsWith('|'))
            .map(line => line.slice(1, -1).split('|').map(cell => cell.trim()))
            .filter(row => row.length > 1 && !row.every(cell => /^:?-{2,}:?$/u.test(cell)))
            .filter(row => !/^(编号|User Story|Actor|字段名称|User Story)$/iu.test(String(row[0] || '').trim()));
    }

    _result(issues = [], summarySource = null, sourcePath = '') {
        const ok = issues.length === 0;
        return {
            ok,
            status: ok ? 'requirement_rule_pool_valid' : 'requirement_rule_pool_invalid',
            issueCount: issues.length,
            issues,
            summary: ok && summarySource
                ? this.buildSlimSummary(summarySource, sourcePath)
                : null
        };
    }

    _poolBindingResult(issues = []) {
        const ok = issues.length === 0;
        return {
            ok,
            status: ok ? 'requirement_pool_binding_valid' : 'requirement_pool_binding_invalid',
            issues
        };
    }
}

module.exports = RequirementRulePoolService;
