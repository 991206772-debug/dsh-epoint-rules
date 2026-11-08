/* eslint-disable */
const fs = require('fs');

function array(value) {
    return Array.isArray(value) ? value : [];
}

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

function stripUndefined(obj = {}) {
    const out = {};
    Object.keys(obj || {}).forEach(key => {
        const value = obj[key];
        if (value === undefined || value === null || value === '') return;
        if (Array.isArray(value) && value.length === 0) return;
        out[key] = value;
    });
    return out;
}

class DesignTddPrePatchRuleReadPlanService {
    build({
        projectPath = '',
        storyId = '',
        acceptanceCode = '',
        fileKind = '',
        readRefs = [],
        mustReadRefIds = [],
        apiUsageCard = null
    } = {}) {
        const hits = this._collectRuleHits({ readRefs, mustReadRefIds, apiUsageCard });
        const tiers = this._classifyRuleHits({ hits, fileKind });
        if (
            tiers.mustReadBeforeEdit.length === 0
            && tiers.readBeforeMark.length === 0
            && tiers.optionalReference.length === 0
        ) return null;
        const makeCalls = (ruleNames = []) => ruleNames.map(ruleName => ({
            toolName: 'rule_expert',
            arguments: stripUndefined({
                action: 'read',
                skillName: 'epoint-design-tdd-coder',
                projectPath,
                storyId,
                ruleName,
                outputMode: 'full'
            })
        }));
        const toolCalls = makeCalls(tiers.mustReadBeforeEdit);
        const readBeforeMarkToolCalls = makeCalls(tiers.readBeforeMark);
        const optionalReferenceToolCalls = makeCalls(tiers.optionalReference);
        return stripUndefined({
            required: tiers.mustReadBeforeEdit.length > 0,
            mode: 'tiered_rule_read_plan',
            decisionFirst: true,
            toolCallCopyRule: '调用规则原文时必须逐字复制对应 toolCalls[].arguments / readBeforeMarkToolCalls[].arguments / optionalReferenceToolCalls[].arguments；不要自己重组参数。',
            requiredReadArguments: 'action="read" + outputMode="full" + ruleName + skillName；缺 action 会被 rule_expert 拒收。',
            forbiddenOutputModes: ['snippet', 'summary'],
            storyId,
            acceptanceCode,
            fileKind,
            tierPolicy: 'decisionFirst=读 current-execution-bundle 后先判断本轮最小证据; mustReadBeforeEdit=仅当前 fileKind 且本轮会触碰的规则原文; readBeforeMark=mark前自查; optionalReference=不确定时读',
            useRule: '不要把本计划当全量预读清单；Story 判断确认会修改哪个 fileKind 后，只读取 mustReadBeforeEdit 中与本轮 patch 直接相关的规则。调用时复制 toolCalls[].arguments，不要改成 snippet/summary 或漏传 action。',
            mustReadBeforeEditRuleAliases: tiers.mustReadBeforeEdit,
            readBeforeMarkRuleAliases: tiers.readBeforeMark,
            optionalReferenceRuleAliases: tiers.optionalReference,
            toolCalls,
            callTemplates: toolCalls.map(call => `rule_expert(${JSON.stringify(call.arguments)})`),
            readBeforeMarkToolCalls,
            optionalReferenceToolCalls
        });
    }

    _classifyRuleHits({ hits = [], fileKind = '' } = {}) {
        const before = [];
        const mark = [];
        const optional = [];
        for (const hit of array(hits).slice(0, 20)) {
            const ruleName = String(hit && hit.ruleName || '').trim();
            if (!ruleName) continue;
            if (this._isMustReadBeforeEdit(hit, fileKind)) {
                before.push(ruleName);
            } else if (this._isOptionalReference(hit, fileKind)) {
                optional.push(ruleName);
            } else {
                mark.push(ruleName);
            }
        }
        return {
            mustReadBeforeEdit: uniqueStrings(before).slice(0, 8),
            readBeforeMark: uniqueStrings(mark).slice(0, 8),
            optionalReference: uniqueStrings(optional).slice(0, 8)
        };
    }

    _isMustReadBeforeEdit(hit = {}, fileKind = '') {
        const ruleName = String(hit && hit.ruleName || '').trim();
        const sources = array(hit && hit.sources).join(' ');
        if (/apiUsageCard\.ruleRefs/u.test(sources)) {
            return this._ruleAppliesToCurrentFileKind(ruleName, fileKind);
        }
        if (this._ruleAppliesToCurrentFileKind(ruleName, fileKind)) {
            return true;
        }
        return false;
    }

    _isOptionalReference(hit = {}, fileKind = '') {
        const ruleName = String(hit && hit.ruleName || '').trim();
        const kind = String(fileKind || '').trim();
        if (!kind) return false;
        if (!this._ruleAppliesToCurrentFileKind(ruleName, kind)) return true;
        if (kind === 'HtmlPage' && /后台|Service|DAO|SQL/u.test(ruleName)) return true;
        if (kind !== 'HtmlPage' && /前端|MiniUI|HtmlPage|页面/u.test(ruleName)) return true;
        return false;
    }

    _ruleAppliesToCurrentFileKind(ruleName = '', fileKind = '') {
        const name = String(ruleName || '').trim();
        const kind = String(fileKind || '').trim();
        if (!name) return false;
        if (!kind) return true;
        if (kind === 'HtmlPage') {
            return /前端|页面|HtmlPage|MiniUI|FUI|epoint|execute|openDialog|closeDialog|附件上传页面/u.test(name);
        }
        if (kind === 'Action') {
            return /Action|控制层|UserSession|用户|登录|权限|角色|IFrame|HttpUtil|JsonUtil|EpointDateUtil|SqlConditionUtil|附件|导入|导出|安全/u.test(name);
        }
        if (kind === 'Rest') {
            return /REST|Rest|接口|外部|第三方|token|URL|HttpUtil|JsonUtil|EpointDateUtil|用户|权限|安全/u.test(name);
        }
        if (kind === 'Job') {
            return /Job|MQ|定时|队列|HttpUtil|JsonUtil|EpointDateUtil|Service|幂等|日志/u.test(name);
        }
        if (kind === 'ServiceApi' || kind === 'ServiceImpl') {
            return /Service|服务|三层|接口|Impl|实现规范/u.test(name);
        }
        if (kind === 'ServiceInternal') {
            return /Service|服务|三层|DAO|SQL|SqlConditionUtil|CommonDao|ICommonDao|HttpUtil|JsonUtil|EpointDateUtil|附件|字典/u.test(name);
        }
        if (kind === 'Entity') {
            return /Entity|实体|字段|数据库|ORM|注解|附件|代码项/u.test(name);
        }
        return /REST|接口|Job|Service|DAO|SQL|MiniUI|前端|页面/u.test(name);
    }

    _collectRuleHits({ readRefs = [], mustReadRefIds = [], apiUsageCard = null } = {}) {
        const sourcesByRule = new Map();
        const add = (ruleName, source) => {
            const name = String(ruleName || '').trim();
            if (!name) return;
            if (!sourcesByRule.has(name)) sourcesByRule.set(name, new Set());
            const src = String(source || '').trim();
            if (src) sourcesByRule.get(name).add(src);
        };

        const requiredIds = new Set(array(mustReadRefIds).map(id => String(id || '').trim()).filter(Boolean));
        for (const ref of array(readRefs)) {
            const id = String(ref && ref.id || '').trim();
            if (!id || !id.startsWith('rules.')) continue;
            if (requiredIds.size > 0 && !requiredIds.has(id)) continue;
            const slice = this._readJson(ref && ref.path);
            for (const card of array(slice && slice.ruleCheckCards)) {
                add(card && (card.ruleAlias || card.ruleName || card.alias), `${id}.ruleCheckCards`);
                for (const nestedRef of array(card && card.ruleRefs)) {
                    add(nestedRef && (nestedRef.ruleName || nestedRef.ruleAlias), `${id}.ruleCheckCards.ruleRefs`);
                }
            }
        }

        for (const ref of array(apiUsageCard && apiUsageCard.ruleRefs)) {
            add(ref && (ref.ruleName || ref.ruleAlias), 'apiUsageCard.ruleRefs');
        }

        return Array.from(sourcesByRule.entries()).map(([ruleName, sources]) => ({
            ruleName,
            sources: Array.from(sources)
        }));
    }

    _readJson(filePath = '') {
        const target = String(filePath || '').trim();
        if (!target || !fs.existsSync(target)) return null;
        try {
            return JSON.parse(fs.readFileSync(target, 'utf-8'));
        } catch (_) {
            return null;
        }
    }
}

module.exports = DesignTddPrePatchRuleReadPlanService;
