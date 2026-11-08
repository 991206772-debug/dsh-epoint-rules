/* eslint-disable */
const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

const RuleValidationContract = require('../rule-validation-contract');
const DesignTddRequiredRulesConfigService = require('./design-tdd-required-rules-config-service');

function uniqueStrings(values = []) {
    const out = [];
    const seen = new Set();
    for (const value of (Array.isArray(values) ? values : [])) {
        const text = String(value || '').trim();
        if (!text || seen.has(text)) continue;
        seen.add(text);
        out.push(text);
    }
    return out;
}

function array(value) {
    return Array.isArray(value) ? value : [];
}

function limitText(value, max = 180) {
    const text = String(value || '').replace(/\s+/g, ' ').trim();
    if (text.length <= max) return text;
    const hardLimit = Math.max(1, max - 1);
    const candidate = text.slice(0, hardLimit);
    const boundary = Math.max(
        candidate.lastIndexOf(' '),
        candidate.lastIndexOf(','),
        candidate.lastIndexOf('，'),
        candidate.lastIndexOf(')'),
        candidate.lastIndexOf(';')
    );
    const cut = boundary >= Math.floor(hardLimit * 0.65) ? candidate.slice(0, boundary + 1).trim() : candidate.trim();
    return `${cut}…`;
}

const BACKEND_PROJECT_API_FILE_KINDS = Object.freeze([
    'Action',
    'Rest',
    'Job',
    'ServiceApi',
    'ServiceImpl',
    'ServiceInternal',
    'Entity'
]);

const BACKEND_FILE_KINDS = Object.freeze([
    'Action',
    'Rest',
    'Job',
    'ServiceApi',
    'ServiceImpl',
    'ServiceInternal',
    'Entity'
]);

const DEFAULT_USAGE_CONTRACTS_BY_CAPABILITY = Object.freeze({
    SqlConditionUtil: [{
        contractId: 'SqlConditionUtil.query-condition-map',
        appliesToFileKinds: ['Action', 'Rest', 'Job', 'ServiceInternal'],
        objectSource: 'SqlConditionUtil sql = new SqlConditionUtil();',
        argumentContracts: [
            '查询/分页/统计条件 Map 参数来自 sql.getMap()',
            '筛选项用 sql.eq/like/ge/gt/le/lt/in/setOrderAsc/setOrderDesc 组装'
        ],
        callSequence: [
            '先创建 SqlConditionUtil',
            '按真实筛选项补 sql.* 条件',
            '调用 Service/API 时传 sql.getMap()'
        ],
        forbiddenAlternatives: [
            '不要 new HashMap 手搓查询条件后传给分页/统计/查询方法',
            '不要手拼 %xxx% 表达 like 语义'
        ],
        positiveExample: 'SqlConditionUtil sql = new SqlConditionUtil(); sql.like("name", name.trim()); service.paginatorList(sql.getMap(), first, pageSize);'
    }],
    UserSession: [{
        contractId: 'UserSession.action-inherited-field',
        appliesToFileKinds: ['Action'],
        objectSource: '管理端 Action 使用 BaseController 继承字段 userSession',
        argumentContracts: [
            '当前用户 guid/name/ou/baseOu 从 userSession 对应 getter 读取'
        ],
        callSequence: [
            '确认当前文件是 extends BaseController 的管理端 Action',
            '直接调用 userSession.getUserGuid()/getDisplayName()/getOuGuid()/getBaseOUGuid()'
        ],
        forbiddenAlternatives: [
            'Action 中不要 UserSession.getInstance()',
            '不要猜 getCurrentUser/getUserName/getBaseOuGuid 这类未证实方法名'
        ],
        positiveExample: 'String userguid = userSession.getUserGuid(); String username = userSession.getDisplayName();'
    }, {
        contractId: 'UserSession.non-action-source-check',
        appliesToFileKinds: ['Rest', 'Job', 'ServiceInternal'],
        objectSource: '非 Action 场景不套 BaseController 字段；按规则原文或项目样例确认会话来源',
        argumentContracts: [
            '没有规则/源码证据时不要凭 Action 写法迁移 userSession 字段'
        ],
        callSequence: [
            '先读 UserSession 规则或项目样例',
            '确认当前入口是否真的需要登录上下文',
            '证据不足时 blocker'
        ],
        forbiddenAlternatives: [
            '不要在非 Action 文件中凭记忆补 userSession 字段',
            '不要把前端传入用户/区域当最终可信来源'
        ],
        positiveExample: '非 Action 使用前先按 ruleRefs/项目样例确认获取方式。'
    }]
});

class DesignTddRuleUsageHintService {
    constructor(options = {}) {
        this.requiredRulesConfigService = options.requiredRulesConfigService
            || new DesignTddRequiredRulesConfigService(options.requiredRulesConfig || {});
    }

    _limits(versionContext = '') {
        return this.requiredRulesConfigService.getHintLimits(versionContext);
    }

    _versionContext(options = {}) {
        if (options && typeof options === 'object' && !Array.isArray(options)) {
            return {
                versionBucket: String(options.versionBucket || '').trim(),
                frameworkVersion: String(options.frameworkVersion || '').trim()
            };
        }
        return { versionBucket: String(options || '').trim(), frameworkVersion: '' };
    }

    buildModuleHints({ relevantRulesData, moduleId, maxMethodsPerRule, versionBucket = '', frameworkVersion = '' } = {}) {
        try {
            const versionContext = this._versionContext({ versionBucket, frameworkVersion });
            const rules = this._rulesForModule(relevantRulesData, moduleId);
            if (rules.length === 0) return [];
            const limits = this._limits(versionContext);
            const templateRuleAliases = new Set(this.requiredRulesConfigService.getAllTemplateRuleAliases(versionContext));
            const nonTemplateRules = rules.filter(rule => {
                const alias = String(rule && rule.ruleAlias || '').trim();
                if (!alias) return false;
                return !templateRuleAliases.has(alias);
            });
            return this.buildHintsFromRules(nonTemplateRules, {
                maxMethodsPerRule: maxMethodsPerRule || limits.methodsPerRule,
                versionBucket,
                frameworkVersion
            });
        } catch (_) {
            return [];
        }
    }

    _rulesForModule(relevantRulesData, moduleId = '') {
        const key = String(moduleId || '').trim();
        if (!relevantRulesData || typeof relevantRulesData !== 'object' || !key) return [];
        const modules = relevantRulesData.modules && typeof relevantRulesData.modules === 'object'
            ? relevantRulesData.modules
            : {};
        const entry = modules[key];
        if (!entry || typeof entry !== 'object') return [];
        const rulesByAlias = relevantRulesData.rulesByAlias && typeof relevantRulesData.rulesByAlias === 'object'
            ? relevantRulesData.rulesByAlias
            : {};
        const refs = Array.isArray(entry.ruleRefs) ? entry.ruleRefs : [];
        return refs
            .map(ref => String(ref && ref.ruleAlias || ref || '').trim())
            .filter(Boolean)
            .map(alias => rulesByAlias[alias] || { ruleAlias: alias, foundStatus: 'not_found' });
    }

    buildHintsFromRules(rules = [], options = {}) {
        const out = [];
        const seen = new Set();
        const versionContext = this._versionContext(options);
        for (const rule of (Array.isArray(rules) ? rules : [])) {
            const ruleAlias = String(rule && rule.ruleAlias || '').trim();
            if (!ruleAlias || seen.has(ruleAlias)) continue;
            seen.add(ruleAlias);
            if (rule.foundStatus === 'not_found') {
                out.push(this._ruleRefOnly(rule, 'not_found', versionContext));
                continue;
            }
            const filePath = String(rule.filePath || '').trim();
            if (!filePath || !fs.existsSync(filePath)) {
                out.push(this._ruleRefOnly(rule, 'file_missing', versionContext));
                continue;
            }
            try {
                const content = fs.readFileSync(filePath, 'utf-8');
                const hint = this._extractHint(rule, content, options);
                out.push(hint || this._ruleRefOnly(rule, 'unparsed', versionContext));
            } catch (_) {
                out.push(this._ruleRefOnly(rule, 'read_failed', versionContext));
            }
        }
        return out;
    }

    buildApiUsageCard({ facts, moduleId, fileKind = '', businessFactsPath = '', maxHints, acceptanceCode = '' } = {}) {
        const key = String(moduleId || '').trim();
        const moduleEntry = this._resolveFactsEntry(facts, key);
        if (!moduleEntry) return null;
        const versionContext = this._versionContext((facts && facts.frameworkContext) || {});
        const limits = this._limits(versionContext);
        const hints = Array.isArray(moduleEntry.apiUsageHints) ? moduleEntry.apiUsageHints : [];
        const selfAudit = Array.isArray(moduleEntry.selfAuditBeforeWrite) ? moduleEntry.selfAuditBeforeWrite : [];
        if (hints.length === 0 && selfAudit.length === 0) return null;

        const selected = this.selectHintsForFileKind(hints, fileKind, maxHints || limits.maxHintsPerCard)
            .map(item => this._slimHintForCard(item, versionContext));
        if (selected.length === 0) return null;
        const frameworkQuickReference = this._buildFrameworkQuickReference({
            selected,
            selfAudit,
            fileKind,
            limits
        });
        const candidates = this._buildDynamicCandidates({
            selected,
            moduleEntry,
            acceptanceCode,
            fileKind,
            limits
        });
        const ruleRefs = selected
            .flatMap(item => Array.isArray(item.ruleRefs) ? item.ruleRefs : [])
            .filter(ref => ref && ref.ruleName);
        return {
            source: 'business-facts.json.apiUsageHints',
            businessFactsPath: String(businessFactsPath || '').trim(),
            fileKind: String(fileKind || '').trim(),
            selectionMode: fileKind ? 'fileKind_ranked' : 'unknown_fileKind_broad_preview',
            totalHints: hints.length,
            totalRelevantRules: selfAudit.length || hints.length,
            instruction: '先看 candidates 中的当前真实候选方法；不要凭通用 CRUD 方法名猜测。候选不覆盖参数、返回值或边界时，再按 ruleRefs 读原文。',
            p0: [
                '先复用 candidates 中列出的当前真实方法。',
                '不要凭通用 CRUD 方法名猜测。',
                '候选不足时再读 ruleRefs。'
            ],
            ...(candidates.length > 0 ? { candidates } : {}),
            ...(frameworkQuickReference.length > 0 ? { frameworkQuickReference } : {}),
            hints: selected,
            ruleRefs: this._dedupeRuleRefs(ruleRefs).slice(0, limits.ruleRefsPerCard)
        };
    }

    _resolveFactsEntry(facts, moduleId = '') {
        if (!facts || typeof facts !== 'object') return null;
        const key = String(moduleId || '').trim();
        if (facts.rulePool && typeof facts.rulePool === 'object') {
            return {
                acceptanceCriteria: this._acceptanceCriteriaFromLedger(facts, key),
                selfAuditBeforeWrite: Array.isArray(facts.rulePool.selfAuditBeforeWrite) ? facts.rulePool.selfAuditBeforeWrite : [],
                apiUsageHints: Array.isArray(facts.rulePool.apiUsageHints) ? facts.rulePool.apiUsageHints : []
            };
        }
        return facts.modules && key ? facts.modules[key] : null;
    }

    _acceptanceCriteriaFromLedger(facts, moduleId = '') {
        const items = facts && facts.acceptanceLedger && Array.isArray(facts.acceptanceLedger.items)
            ? facts.acceptanceLedger.items
            : [];
        const out = { storyAcceptanceItems: [], happyPath: [], exception: [], boundary: [] };
        const wantedModule = String(moduleId || '').trim();
        for (const item of items) {
            if (!item || typeof item !== 'object') continue;
            const code = String(item.code || '').trim();
            if (wantedModule && !code.startsWith(`${wantedModule}-`)) continue;
            const group = String(item.group || '').trim();
            const copy = { ...item };
            out.storyAcceptanceItems.push(copy);
            if (Array.isArray(out[group])) out[group].push(copy);
        }
        return out;
    }

    selectHintsForFileKind(hints = [], fileKind = '', maxHints = 3) {
        const kind = String(fileKind || '').trim();
        return (Array.isArray(hints) ? hints : [])
            .filter(hint => this._hintAppliesToFileKind(hint, kind))
            .map((hint, index) => ({ hint, index, score: this._scoreHint(hint, kind) }))
            .sort((a, b) => {
                const scoreDiff = b.score - a.score;
                if (scoreDiff !== 0) return scoreDiff;
                return a.index - b.index;
            })
            .slice(0, Math.max(1, maxHints || 3))
            .map(item => item.hint);
    }

    _hintAppliesToFileKind(hint = {}, fileKind = '') {
        const kind = String(fileKind || '').trim();
        if (!kind) return true;
        if (hint.kind === 'project_api' && kind === 'HtmlPage') return false;
        const appliesTo = Array.isArray(hint.appliesToFileKinds) ? hint.appliesToFileKinds : [];
        if (appliesTo.length === 0) return true;
        return appliesTo.includes(kind);
    }

    _extractHint(rule, content, options = {}) {
        const versionContext = this._versionContext(options);
        const skeletonApi = RuleValidationContract.parseSkeletonApiContract(content);
        if (skeletonApi.ok) {
            return this._buildSkeletonApiHint(rule, skeletonApi.contract, versionContext);
        }
        const apiCapability = RuleValidationContract.parseApiCapabilityContract(content);
        if (apiCapability.ok) {
            return this._buildFrameworkApiHint(rule, apiCapability.contract, versionContext);
        }
        if (this._looksLikeProjectApiRule(rule, content)) {
            return this._buildProjectApiHint(rule, content, options);
        }
        return this._ruleRefOnly(rule, 'rule_ref_only', versionContext);
    }

    _buildSkeletonApiHint(rule, contract = {}, versionContext = '') {
        const limits = this._limits(versionContext);
        const ruleAlias = String(rule.ruleAlias || '').trim();
        const generatedMethods = Array.isArray(contract.generatedMethods) ? contract.generatedMethods : [];
        const methods = generatedMethods.map(item => ({
            name: String(item && item.name || '').trim(),
            signature: limitText(item && (item.signature || item.signaturePattern) || '', limits.signatureChars),
            summary: limitText(item && (item.summary || item.description) || '', limits.summaryChars),
            capabilityTags: uniqueStrings(item && item.capabilityTags || []).slice(0, limits.triggerTermsPerHint),
            triggerTerms: uniqueStrings(item && item.triggerTerms || []).slice(0, limits.triggerTermsPerHint),
            appliesToFileKinds: uniqueStrings(item && item.appliesToFileKinds || [])
        })).filter(item => item.name || item.signature);
        const fallbackRefs = (Array.isArray(contract.fallbackRuleRefs) ? contract.fallbackRuleRefs : [])
            .map(ref => ({
                ruleName: String(ref && ref.ruleName || '').trim(),
                filePath: String(ref && ref.filePath || '').trim(),
                whenToRead: String(ref && ref.whenToRead || '候选方法无法覆盖当前能力时读原文。').trim()
            }))
            .filter(ref => ref.ruleName);
        return {
            kind: 'skeleton_api',
            source: 'ai_skeleton_api_contract',
            ruleAlias,
            appliesToFileKinds: uniqueStrings(contract.appliesToFileKinds || this.requiredRulesConfigService.getFileKindsForRule(ruleAlias, versionContext)),
            methods: methods.slice(0, limits.methodsPerRule),
            ruleRefs: [
                this._ruleRef(rule, '需要确认骨架候选方法的生成规则、参数或边界时读原文。'),
                ...fallbackRefs
            ]
        };
    }

    _buildFrameworkApiHint(rule, contract = {}, versionContext = '') {
        const ruleAlias = String(rule.ruleAlias || '').trim();
        const limits = this._limits(versionContext);
        const actions = Array.isArray(contract.actions) ? contract.actions : [];
        const capabilityId = String(contract.capabilityId || '').trim();
        const requiredWhenReferenced = contract.requiredWhenReferenced && typeof contract.requiredWhenReferenced === 'object'
            && !Array.isArray(contract.requiredWhenReferenced)
            ? contract.requiredWhenReferenced
            : {};
        const forbiddenWhenReferenced = Array.isArray(contract.forbiddenWhenReferenced)
            ? contract.forbiddenWhenReferenced.map(item => String(item || '').trim()).filter(Boolean).slice(0, limits.forbiddenPerHint)
            : [];
        const usageContracts = this._normalizeUsageContracts({
            capabilityId,
            contracts: contract.usageContracts || contract.usageContract,
            versionContext
        });
        return {
            kind: 'framework_api',
            source: 'ai_api_capability_contract',
            ruleAlias,
            capabilityId,
            interfaceName: String(contract.serviceInterface || contract.capabilityId || '').trim(),
            appliesToFileKinds: this.requiredRulesConfigService.getFileKindsForRule(ruleAlias, versionContext),
            triggerTerms: uniqueStrings(contract.triggerTerms || []).slice(0, limits.triggerTermsPerHint),
            actions: actions.map(item => ({
                name: String(item && item.name || '').trim(),
                method: String(item && item.method || '').trim()
            })).filter(item => item.name || item.method).slice(0, limits.actionsPerHint),
            requiredWhenReferenced,
            forbiddenWhenReferenced,
            ...(usageContracts.length > 0 ? { usageContracts } : {}),
            ruleRefs: [this._ruleRef(rule, '涉及该能力的方法名、获取方式或禁用写法时读原文。')]
        };
    }

    _normalizeUsageContracts({ capabilityId = '', contracts = null, versionContext = '' } = {}) {
        const limits = this._limits(versionContext);
        const configured = Array.isArray(contracts)
            ? contracts
            : (contracts && typeof contracts === 'object' ? [contracts] : []);
        const fallback = DEFAULT_USAGE_CONTRACTS_BY_CAPABILITY[String(capabilityId || '').trim()] || [];
        const source = configured.length > 0 ? configured : fallback;
        return source
            .map((item, index) => this._slimUsageContract(item, index, limits))
            .filter(item => item.contractId || item.objectSource || item.positiveExample)
            .slice(0, 3);
    }

    _slimUsageContract(item = {}, index = 0, limits = {}) {
        const listLimit = 4;
        const textLimit = Math.max(80, limits.summaryChars || 120);
        const normalizeList = values => uniqueStrings(Array.isArray(values) ? values : [values])
            .map(value => limitText(value, textLimit))
            .slice(0, listLimit);
        return {
            contractId: String(item && (item.contractId || item.id) || `usage-${index + 1}`).trim(),
            appliesToFileKinds: uniqueStrings(item && item.appliesToFileKinds || []).slice(0, listLimit),
            objectSource: limitText(item && item.objectSource || '', textLimit),
            argumentContracts: normalizeList(item && item.argumentContracts || item && item.argumentContract || []),
            callSequence: normalizeList(item && item.callSequence || []),
            forbiddenAlternatives: normalizeList(item && item.forbiddenAlternatives || []),
            positiveExample: limitText(item && item.positiveExample || item && item.example || '', Math.max(160, limits.signatureChars || 240))
        };
    }

    _buildProjectApiHint(rule, content, options = {}) {
        const frontmatter = this._parseFrontmatter(content);
        const limits = this._limits(this._versionContext(options));
        const ruleAlias = String(rule.ruleAlias || frontmatter.rule_alias || '').trim();
        const sourceFile = String(frontmatter.source_file || '').trim();
        const interfaceName = this._inferInterfaceName(ruleAlias, sourceFile);
        const methods = this._extractProjectApiMethods(content, this._versionContext(options))
            .slice(0, Math.max(1, options.maxMethodsPerRule || limits.methodsPerRule));
        return {
            kind: 'project_api',
            source: 'project_api_rule',
            ruleAlias,
            interfaceName,
            sourceFile,
            sourcePackage: String(frontmatter.source_package || '').trim(),
            tableNames: uniqueStrings(frontmatter.table_names || []).slice(0, limits.tableNamesPerHint),
            entityNames: uniqueStrings(frontmatter.entity_names || []).slice(0, limits.entityNamesPerHint),
            appliesToFileKinds: BACKEND_PROJECT_API_FILE_KINDS,
            methods,
            ruleRefs: [this._ruleRef(rule, '需要复用项目现成接口、确认参数或返回值时读原文。')]
        };
    }

    _extractProjectApiMethods(content, versionContext = '') {
        const limits = this._limits(versionContext);
        const details = [];
        const detailRegex = /###\s+4\.\d+\s+`([^`]+)`([\s\S]*?)(?=\n###\s+4\.\d+\s+`|\n##\s+5\.|$)/g;
        let match;
        while ((match = detailRegex.exec(content)) !== null) {
            const name = String(match[1] || '').trim();
            const body = String(match[2] || '');
            const signatureMatch = body.match(/签名：`([^`]+)`/);
            const summaryMatch = body.match(/说明：([^\r\n]+)/);
            const paramsText = this._extractMethodParamsText(body);
            details.push(this._methodWithInferredBindings({
                name,
                signature: limitText(signatureMatch ? signatureMatch[1] : '', limits.signatureChars),
                summary: limitText(summaryMatch ? summaryMatch[1] : '', limits.summaryChars),
                paramsText
            }, { versionContext }));
        }
        if (details.length > 0) return this._dedupeMethods(details);

        const rows = [];
        const inTable = this._sliceBetween(content, /##\s+3\.\s+方法目录/, /##\s+4\.\s+方法明细/);
        for (const rawLine of inTable.split(/\r?\n/)) {
            const line = rawLine.trim();
            if (!line.startsWith('|') || /^[-|\s]+$/.test(line.replace(/`/g, ''))) continue;
            const parts = line.split('|').map(item => item.trim()).filter(Boolean);
            if (parts.length < 3 || parts[0] === '方法') continue;
            rows.push(this._methodWithInferredBindings({
                name: parts[0].replace(/`/g, ''),
                signature: limitText(`${parts[1].replace(/`/g, '')} ${parts[0].replace(/`/g, '')}`, limits.signatureChars),
                summary: limitText(parts[2].replace(/`/g, ''), limits.summaryChars)
            }, { versionContext }));
        }
        return this._dedupeMethods(rows);
    }

    _extractMethodParamsText(body = '') {
        const match = String(body || '').match(/参数：([^\r\n]+)/u);
        return match ? match[1] : '';
    }

    _methodWithInferredBindings(method = {}, { versionContext = '' } = {}) {
        const signature = String(method && method.signature || '').trim();
        const name = String(method && method.name || '').trim();
        const queryLike = /\b(find|findList|findListByPaginator|paginatorList|queryInt|count|list|page)\b/iu
            .test(`${name} ${signature}`);
        const hasConditionMap = /\bMap\s*<\s*String\s*,\s*Object\s*>/u.test(signature);
        const apiArgumentBindings = this._buildProjectApiArgumentBindings(method, versionContext);
        const usageContracts = queryLike && hasConditionMap
            ? this._normalizeUsageContracts({ capabilityId: 'SqlConditionUtil', versionContext }).slice(0, 1)
            : [];
        const { paramsText, ...cleanMethod } = method;
        return {
            ...cleanMethod,
            ...(usageContracts.length > 0 ? { usageContracts } : {}),
            ...(apiArgumentBindings.length > 0 ? { apiArgumentBindings } : {})
        };
    }

    _buildProjectApiArgumentBindings(method = {}, versionContext = '') {
        const limits = this._limits(versionContext);
        const name = String(method && method.name || '').trim();
        const signature = String(method && method.signature || '').trim();
        if (!name && !signature) return [];
        const params = this._extractJavaParams({
            signature,
            paramsText: method && method.paramsText
        }).slice(0, 8);
        const parameterBindings = params.map(param => this._projectApiParameterBinding(param, { methodName: name, signature }))
            .filter(item => item.name || item.type || item.bindingHint)
            .slice(0, 6);
        const rawSql = this._hasRawSqlParams(params);
        const queryObjectMap = this._hasQueryObjectMapParams(params, { methodName: name, signature });
        const stringMap = this._hasStringMapParams(params);
        return [{
            bindingId: `project-api.${name || 'method'}.argument-binding`,
            source: 'project_api_method_signature',
            methodName: name,
            signature: limitText(signature, limits.signatureChars),
            objectSource: 'receiver 对象必须来自当前骨架/allowedTargetFiles 已有注入、reuse 源码或 apiUsageCard owner；没有对象来源证据就先补读或 blocker。',
            parameterSourceRule: rawSql
                ? '该历史 API 签名暴露 sql/args 参数；调用前必须读规则原文或 source_file 确认 SQL 模板和参数顺序，Action/Rest/Job 不得凭记忆手写业务 SQL。'
                : '按项目 API 签名逐个参数绑定；参数名、顺序、类型以规则/源码为准，不要把业务词脑补成新参数或新 Map key。',
            ...(queryObjectMap ? {
                frameworkAssist: '若该 Map<String,Object> 参数是查询条件 Map，且当前层负责组装查询条件，可用 SqlConditionUtil 生成后传 sql.getMap()；仍以该 API 签名和源码约定为准。'
            } : {}),
            ...(stringMap ? {
                mapContractNote: 'Map<String,String> 不是 SqlConditionUtil.getMap() 的确定合同；必须按该 API 规则/源码确认 key/value，不能套 conditionMap 写法。'
            } : {}),
            parameterBindings,
            forbiddenAlternatives: [
                '不要凭通用 CRUD 记忆改方法名或参数顺序。',
                '不要在规则/源码未说明时编造 Map key、SQL 字段、状态值或默认参数。',
                '不要因为历史 API 缺少额外能力合同就忽略它的方法目录和签名。'
            ].slice(0, 4)
        }];
    }

    _projectApiParameterBinding(param = {}, context = {}) {
        const type = String(param && param.type || '').trim();
        const name = String(param && param.name || '').trim();
        const lowerName = name.toLowerCase();
        let bindingHint = '从当前 Story 请求参数、业务实体字段、已读源码返回值或已确认上下文中取值；证据不足时不要猜。';
        if (/^Class\s*</u.test(type)) {
            bindingHint = '传真实 Entity.class；Entity 来源必须来自当前 execution bundle、dataAccessPlan 或 reuse 实体源码。';
        } else if (/^Map\s*<\s*String\s*,\s*Object\s*>/u.test(type)) {
            bindingHint = '若这是查询条件 Map，优先按 SqlConditionUtil 组装并传 sql.getMap()；具体 key 仍来自业务字段/源码约定。';
        } else if (/^Map\s*<\s*String\s*,\s*String\s*>/u.test(type)) {
            bindingHint = '按该项目 API 规则/源码确认 key/value；不要直接套 SqlConditionUtil.getMap()。';
        } else if (/^String\b/u.test(type) && /sql|field|where|condition|sel/u.test(lowerName)) {
            bindingHint = '这是查询片段/字段片段类参数；必须读规则原文或 source_file 确认构造方式，不在 Action/Rest/Job 凭记忆拼 SQL。';
        } else if (/^Object\.\.\./u.test(type) || /^Object\s*\[\]/u.test(type)) {
            bindingHint = '按签名中 sql/模板参数顺序传 args；顺序不清楚先读源码。';
        } else if (/^(int|Integer|long|Long)\b/u.test(type) && /page|first|size|num|start|limit/u.test(lowerName)) {
            bindingHint = '分页参数来自框架分页上下文或请求分页参数；不要硬编码。';
        } else if (/^[A-Z][A-Za-z0-9_]*(?:<.*>)?$/u.test(type) && !/^(String|Integer|Long|Boolean|Double|Float|Object)$/u.test(type)) {
            bindingHint = '传该类型真实对象；对象字段先按当前实体/请求 DTO/源码证据赋值，不造幽灵字段。';
        }
        return {
            name,
            type,
            bindingHint: limitText(bindingHint, 140)
        };
    }

    _extractJavaParams({ signature = '', paramsText = '' } = {}) {
        const fromText = [];
        const paramText = String(paramsText || '');
        const paramRegex = /`([^`]+)`\s*:\s*`([^`]+)`/gu;
        let textMatch;
        while ((textMatch = paramRegex.exec(paramText)) !== null) {
            fromText.push({
                name: String(textMatch[1] || '').trim(),
                type: String(textMatch[2] || '').trim()
            });
        }
        if (fromText.length > 0) return fromText;

        const raw = String(signature || '');
        const start = raw.indexOf('(');
        const end = raw.lastIndexOf(')');
        if (start < 0 || end <= start) return [];
        return this._splitJavaParams(raw.slice(start + 1, end))
            .map(part => this._parseJavaParam(part))
            .filter(param => param.name || param.type);
    }

    _splitJavaParams(text = '') {
        const out = [];
        let current = '';
        let depth = 0;
        for (const ch of String(text || '')) {
            if (ch === '<') depth += 1;
            if (ch === '>') depth = Math.max(0, depth - 1);
            if (ch === ',' && depth === 0) {
                if (current.trim()) out.push(current.trim());
                current = '';
                continue;
            }
            current += ch;
        }
        if (current.trim()) out.push(current.trim());
        return out;
    }

    _parseJavaParam(part = '') {
        const clean = String(part || '')
            .replace(/@\w+(?:\([^)]*\))?\s*/g, '')
            .replace(/\bfinal\s+/g, '')
            .trim();
        if (!clean) return {};
        const tokens = clean.split(/\s+/u);
        if (tokens.length === 1) return { type: tokens[0], name: '' };
        const name = tokens[tokens.length - 1].replace(/\[\]$/u, '').trim();
        const type = tokens.slice(0, -1).join(' ').trim();
        return { type, name };
    }

    _hasQueryObjectMapParams(params = [], context = {}) {
        const text = `${context.methodName || ''} ${context.signature || ''}`;
        if (!/\b(find|findList|findListByPaginator|paginatorList|query|count|list|page)\b/iu.test(text)) return false;
        return params.some(param => /^Map\s*<\s*String\s*,\s*Object\s*>/u.test(String(param && param.type || '')));
    }

    _hasStringMapParams(params = []) {
        return params.some(param => /^Map\s*<\s*String\s*,\s*String\s*>/u.test(String(param && param.type || '')));
    }

    _hasRawSqlParams(params = []) {
        return params.some(param => /^String\b/u.test(String(param && param.type || ''))
            && /^(sql|fieldStr|fieldStr1|sel|where|condition)$/iu.test(String(param && param.name || '')));
    }

    _dedupeMethods(methods = []) {
        const out = [];
        const seen = new Set();
        for (const method of methods) {
            const key = `${method.name}::${method.signature}`;
            if (!method.name || seen.has(key)) continue;
            seen.add(key);
            out.push(method);
        }
        return out;
    }

    _ruleRefOnly(rule, extractionStatus, versionContext = '') {
        const limits = this._limits(versionContext);
        return {
            kind: 'rule_ref_only',
            source: 'rule_ref',
            extractionStatus,
            ruleAlias: String(rule && rule.ruleAlias || '').trim(),
            description: limitText(rule && rule.description || '', limits.descriptionChars),
            intentKeywords: uniqueStrings(rule && rule.intentKeywords || []).slice(0, limits.intentKeywordsPerHint),
            appliesToFileKinds: this.requiredRulesConfigService.getFileKindsForRule(String(rule && rule.ruleAlias || '').trim(), versionContext),
            ruleRefs: [this._ruleRef(rule, '该规则无法稳定抽小抄；命中 selfAuditBeforeWrite 时读原文。')]
        };
    }

    _ruleRef(rule, whenToRead) {
        return {
            ruleName: String(rule && rule.ruleAlias || '').trim(),
            filePath: String(rule && rule.filePath || '').trim(),
            whenToRead
        };
    }

    _scoreHint(hint = {}, fileKind = '') {
        const appliesTo = Array.isArray(hint.appliesToFileKinds) ? hint.appliesToFileKinds : [];
        let score = 0;
        if (fileKind && appliesTo.includes(fileKind)) score += 100;
        if (!fileKind || appliesTo.length === 0) score += 20;
        if (hint.kind === 'skeleton_api') score += 45;
        if (hint.kind === 'framework_api') score += 30;
        if (hint.kind === 'project_api') score += fileKind ? 25 : 40;
        if (hint.kind === 'rule_ref_only') score += 5;
        if (/^代码生成规范-/u.test(String(hint.ruleAlias || ''))) score -= 10;
        return score;
    }

    _slimHintForCard(hint = {}, versionContext = '') {
        const limits = this._limits(versionContext);
        const base = {
            kind: hint.kind,
            ruleAlias: hint.ruleAlias,
            ruleRefs: this._dedupeRuleRefs(hint.ruleRefs || []).slice(0, limits.ruleRefsPerHint)
        };
        if (hint.kind === 'project_api') {
            return {
                ...base,
                interfaceName: hint.interfaceName || '',
                sourceFile: hint.sourceFile || '',
                appliesToFileKinds: BACKEND_PROJECT_API_FILE_KINDS,
                methods: (Array.isArray(hint.methods) ? hint.methods : [])
                    .map(method => this._slimMethodForCard(method, limits))
                    .slice(0, limits.methodsPerCardHint)
            };
        }
        if (hint.kind === 'framework_api') {
            const usageContracts = this._usageContractsForHint(hint, versionContext).slice(0, 2);
            return {
                ...base,
                capabilityId: hint.capabilityId || '',
                interfaceName: hint.interfaceName || '',
                actions: (Array.isArray(hint.actions) ? hint.actions : []).slice(0, limits.actionsPerCardHint),
                forbiddenWhenReferenced: (Array.isArray(hint.forbiddenWhenReferenced) ? hint.forbiddenWhenReferenced : []).slice(0, limits.forbiddenPerCardHint),
                ...(usageContracts.length > 0 ? { usageContracts } : {})
            };
        }
        if (hint.kind === 'skeleton_api') {
            return {
                ...base,
                methods: (Array.isArray(hint.methods) ? hint.methods : []).slice(0, limits.methodsPerCardHint)
            };
        }
        return {
            ...base,
            extractionStatus: hint.extractionStatus || '',
            description: hint.description || '',
            intentKeywords: (Array.isArray(hint.intentKeywords) ? hint.intentKeywords : []).slice(0, limits.intentKeywordsPerCardHint)
        };
    }

    _buildFrameworkQuickReference({ selected = [], selfAudit = [], fileKind = '', limits = {} } = {}) {
        const kind = String(fileKind || '').trim();
        if (!kind || !BACKEND_FILE_KINDS.includes(kind)) return [];
        const aliasText = [
            ...array(selected).map(item => item && item.ruleAlias),
            ...array(selfAudit).map(item => item && (item.ruleAlias || item.ruleName || item.alias))
        ].filter(Boolean).join(' ');
        const out = [];
        const hasEpointDateUtil = /EpointDateUtil/u.test(aliasText);
        const hasJsonRule = /Json|JSON|REST|Rest|接口|外部|第三方/u.test(aliasText);
        if (hasJsonRule) {
            out.push({
                capabilityId: 'FastJSON.JSONObject',
                appliesToFileKinds: ['Action', 'Rest', 'Job', 'ServiceInternal'],
                positiveExamples: [
                    'JSONObject paramsObj = jsonObject.getJSONObject("params");',
                    'String token = jsonObject.getString("token");',
                    'Integer pageNumObj = paramsObj.getInteger("pageNum"); int pageNum = pageNumObj == null || pageNumObj <= 0 ? 1 : pageNumObj;',
                    'int count = data.getIntValue("total");'
                ].slice(0, 4),
                negativeExamples: [
                    'JSONObject.getIntValue("pageNum", 1) 未证实默认值重载；默认值显式判空/边界处理。',
                    '不要把 Object 强转成 JSONObject，优先用 getJSONObject("params")。'
                ].slice(0, 3)
            });
        }
        if (hasEpointDateUtil) {
            out.push({
                capabilityId: 'EpointDateUtil',
                ruleAlias: 'EpointDateUtil使用规范',
                appliesToFileKinds: BACKEND_FILE_KINDS,
                positiveExamples: [
                    'EpointDateUtil.convertDate2String(date, "yyyy-MM-dd HH:mm:ss");',
                    'EpointDateUtil.convertString2Date(dateText, "yyyy-MM-dd HH:mm:ss");',
                    'EpointDateUtil.getCurrentDate(EpointDateUtil.DATE_TIME_FORMAT);'
                ].slice(0, 4),
                negativeExamples: [
                    '不要写 EpointDateUtil.format(...)：未在规则小抄或项目样例证实。',
                    '不要写 EpointDateUtil.parseDate(...)：未在规则小抄或项目样例证实。'
                ].slice(0, 3)
            });
        }
        return out.slice(0, Math.max(1, limits.maxFrameworkQuickReference || 4));
    }

    _buildDynamicCandidates({ selected = [], moduleEntry = {}, acceptanceCode = '', fileKind = '', limits = {} } = {}) {
        const target = this._findAcceptanceItem(moduleEntry, acceptanceCode);
        const gwtText = this._acceptanceText(target || {});
        const max = fileKind ? limits.maxCandidatesPerCard : limits.maxUnknownFileKindCandidates;
        const candidates = [];
        for (const hint of (Array.isArray(selected) ? selected : [])) {
            if (hint.kind === 'skeleton_api') {
                for (const method of (Array.isArray(hint.methods) ? hint.methods : [])) {
                    candidates.push(this._candidateFromMethod({ hint, method, kind: 'skeleton_api', gwtText, limits }));
                }
            }
            if (hint.kind === 'project_api') {
                for (const method of (Array.isArray(hint.methods) ? hint.methods : [])) {
                    candidates.push(this._candidateFromMethod({ hint, method, kind: 'project_api', gwtText, limits }));
                }
            }
            if (hint.kind === 'framework_api') {
                const usageContracts = this._usageContractsForHint(hint, this._versionContext({})).slice(0, 2);
                for (const action of (Array.isArray(hint.actions) ? hint.actions : [])) {
                    candidates.push({
                        kind: 'framework_api',
                        ruleAlias: hint.ruleAlias || '',
                        name: action.method || action.name || '',
                        signature: limitText(action.method || action.name || '', limits.candidateSignatureChars),
                        reason: limitText(`来自 ${hint.ruleAlias || '框架能力'} 小抄`, limits.candidateReasonChars),
                        ...(usageContracts.length > 0 ? { usageContracts } : {}),
                        score: this._scoreCandidate({
                            name: action.method || action.name || '',
                            summary: action.name || '',
                            triggerTerms: hint.triggerTerms || []
                        }, gwtText)
                    });
                }
            }
        }
        return this._dedupeCandidates(candidates)
            .sort((a, b) => b.score - a.score)
            .slice(0, Math.max(1, max || 4))
            .map(({ score, ...candidate }) => candidate);
    }

    _usageContractsForHint(hint = {}, versionContext = '') {
        const capabilityId = String(hint && hint.capabilityId || '').trim();
        const ruleAlias = String(hint && hint.ruleAlias || '').trim();
        if (Array.isArray(hint && hint.usageContracts) && hint.usageContracts.length > 0) {
            return hint.usageContracts;
        }
        const inferredCapability = capabilityId || this._inferCapabilityIdFromRuleAlias(ruleAlias);
        return this._normalizeUsageContracts({ capabilityId: inferredCapability, versionContext });
    }

    _inferCapabilityIdFromRuleAlias(ruleAlias = '') {
        const text = String(ruleAlias || '').trim();
        if (/SqlConditionUtil/u.test(text)) return 'SqlConditionUtil';
        if (/UserSession/u.test(text)) return 'UserSession';
        return '';
    }

    _candidateFromMethod({ hint = {}, method = {}, kind = '', gwtText = '', limits = {} } = {}) {
        const name = String(method.name || '').trim();
        const signature = limitText(method.signature || name, limits.candidateSignatureChars);
        const summary = limitText(method.summary || '', limits.summaryChars);
        const score = this._scoreCandidate(method, gwtText);
        const owner = String(hint.interfaceName || hint.capabilityId || hint.ruleAlias || '').trim();
        return {
            kind,
            ruleAlias: hint.ruleAlias || '',
            ...(owner ? { owner } : {}),
            name,
            method: name,
            signature,
            ...(this._buildCallShape(owner, name, signature) ? { callShape: this._buildCallShape(owner, name, signature) } : {}),
            ...(Array.isArray(method.usageContracts) && method.usageContracts.length > 0 ? { usageContracts: method.usageContracts.slice(0, 2) } : {}),
            ...(Array.isArray(method.apiArgumentBindings) && method.apiArgumentBindings.length > 0 ? { apiArgumentBindings: method.apiArgumentBindings.slice(0, 1) } : {}),
            ...(summary ? { summary } : {}),
            reason: limitText(score > 0 ? '命中当前 Story 验收项文本或能力关键词' : `来自 ${hint.ruleAlias || '规则'} 小抄`, limits.candidateReasonChars),
            score
        };
    }

    _slimMethodForCard(method = {}, limits = {}) {
        const out = {
            name: String(method && method.name || '').trim(),
            signature: limitText(method && method.signature || '', limits.signatureChars),
            summary: limitText(method && method.summary || '', limits.summaryChars),
            capabilityTags: uniqueStrings(method && method.capabilityTags || []).slice(0, limits.triggerTermsPerHint),
            triggerTerms: uniqueStrings(method && method.triggerTerms || []).slice(0, limits.triggerTermsPerHint),
            appliesToFileKinds: uniqueStrings(method && method.appliesToFileKinds || [])
        };
        const usageContracts = Array.isArray(method && method.usageContracts) ? method.usageContracts.slice(0, 1) : [];
        const apiArgumentBindings = Array.isArray(method && method.apiArgumentBindings) ? method.apiArgumentBindings.slice(0, 1) : [];
        if (usageContracts.length > 0) out.usageContracts = usageContracts;
        if (apiArgumentBindings.length > 0) out.apiArgumentBindings = apiArgumentBindings;
        return out;
    }

    _buildCallShape(owner = '', methodName = '', signature = '') {
        const ownerText = String(owner || '').trim();
        const method = String(methodName || '').trim();
        const sig = String(signature || '').trim();
        if (!method) return '';
        if (/^[A-Za-z_$][\w$]*\s*\(/.test(sig)) return sig;
        if (!ownerText) return `${method}(...)`;
        return `${ownerText}.${method}(...)`;
    }

    _scoreCandidate(candidate = {}, gwtText = '') {
        const haystack = String(gwtText || '').toLowerCase();
        const terms = []
            .concat(candidate.name || [])
            .concat(candidate.summary || [])
            .concat(candidate.signature || [])
            .concat(candidate.capabilityTags || [])
            .concat(candidate.triggerTerms || [])
            .map(item => String(item || '').trim())
            .filter(Boolean);
        let score = 0;
        for (const term of terms) {
            const lower = term.toLowerCase();
            if (!lower) continue;
            if (haystack && haystack.includes(lower)) score += 20;
            if (Array.isArray(candidate.triggerTerms) && candidate.triggerTerms.includes(term)) score += 5;
            if (Array.isArray(candidate.capabilityTags) && candidate.capabilityTags.includes(term)) score += 3;
        }
        return score;
    }

    _findAcceptanceItem(moduleEntry = {}, acceptanceCode = '') {
        const code = String(acceptanceCode || '').trim();
        const ac = moduleEntry && moduleEntry.acceptanceCriteria && typeof moduleEntry.acceptanceCriteria === 'object'
            ? moduleEntry.acceptanceCriteria
            : {};
        const groups = ['happyPath', 'exception', 'boundary'];
        for (const group of groups) {
            const items = Array.isArray(ac[group]) ? ac[group] : [];
            const found = code ? items.find(item => String(item && item.code || '').trim() === code) : items[0];
            if (found) return found;
        }
        return null;
    }

    _acceptanceText(item = {}) {
        return [item.code, item.scenario, item.given, item.when, item.then]
            .map(value => String(value || '').trim())
            .filter(Boolean)
            .join(' ');
    }

    _dedupeCandidates(candidates = []) {
        const out = [];
        const seen = new Set();
        for (const candidate of (Array.isArray(candidates) ? candidates : [])) {
            const key = `${candidate.kind || ''}::${candidate.ruleAlias || ''}::${candidate.name || ''}::${candidate.signature || ''}`;
            if (!candidate.name || seen.has(key)) continue;
            seen.add(key);
            out.push(candidate);
        }
        return out;
    }

    _dedupeRuleRefs(refs = []) {
        const out = [];
        const seen = new Set();
        for (const ref of (Array.isArray(refs) ? refs : [])) {
            const key = `${String(ref && ref.ruleName || '').trim()}::${String(ref && ref.filePath || '').trim()}`;
            if (!String(ref && ref.ruleName || '').trim() || seen.has(key)) continue;
            seen.add(key);
            out.push(ref);
        }
        return out;
    }

    _looksLikeProjectApiRule(rule, content) {
        const filePath = String(rule && rule.filePath || '').replace(/\\/g, '/');
        return filePath.includes('/.ai-workspace/knowledge/api-rules/')
            || /接口使用规范\.md$/u.test(path.basename(filePath))
            || (content.includes('## 3. 方法目录') && content.includes('## 4. 方法明细'));
    }

    _parseFrontmatter(content) {
        const match = String(content || '').match(/^---\s*\r?\n([\s\S]*?)\r?\n---/);
        if (!match) return {};
        try {
            return yaml.load(match[1]) || {};
        } catch (_) {
            return {};
        }
    }

    _inferInterfaceName(ruleAlias, sourceFile) {
        const fromAlias = String(ruleAlias || '').replace(/接口使用规范$/u, '').trim();
        if (fromAlias) return fromAlias;
        const base = path.basename(String(sourceFile || ''), path.extname(String(sourceFile || '')));
        return base || '';
    }

    _sliceBetween(content, startRegex, endRegex) {
        const text = String(content || '');
        const start = text.search(startRegex);
        if (start < 0) return '';
        const afterStart = text.slice(start);
        const firstLineEnd = afterStart.search(/\r?\n/);
        const body = firstLineEnd >= 0 ? afterStart.slice(firstLineEnd + 1) : '';
        const end = body.search(endRegex);
        return end >= 0 ? body.slice(0, end) : body;
    }
}

module.exports = DesignTddRuleUsageHintService;
