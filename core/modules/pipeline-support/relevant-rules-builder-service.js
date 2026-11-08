/* eslint-disable */
/**
 * RelevantRulesBuilderService — 按需求构建模块级相关规则清单
 *
 * 故事线：
 *   LLM 凭印象写 userSession.getUserName()（实际叫 getDisplayName）的根因是规则文件在那、
 *   LLM 没读。我们尝试过几条治本路径：
 *     ① 抠 methodCheatSheet 把规则结构化喂进 nextStep —— 太重，token 占用高，违反"不物化规则"
 *     ② Gate 扫代码反查规则未读拦截 —— 越界裁判业务（"涉不涉及 UserSession"是语义判断）
 *     ③ 渐进式按需读 + LLM 自审清单 —— 契合"Builder 不裁判 + LLM 自觉"
 *   选 ③ 落地：build_plan 时一次性把本需求所有相关规则的 filePath / intentKeywords 落盘，
 *   物化时按当前 moduleId + fileKind 过滤后塞进 nextStep 形成自审清单，LLM 写代码前对照
 *   清单决定调哪条 rule_expert(action=read, outputMode=full) 读原文。
 *
 * 调度复用：
 *   规则发现完全复用 rule-service.listRules + ruleAlias/versionBucket/source 三段过滤，
 *   和 design_tdd_skeleton_materialize 走同一条路径——保证骨架物化用到的规则文件 ==
 *   selfAuditBeforeWrite 引用的规则文件。**不再自己写递归 walk**，避免：
 *     - 全盘搜索 N 次（规则多时慢）
 *     - alias 派生逻辑两套（rule-service 看 metadata.rule_alias，自写递归只看文件名）
 *     - source 优先级各自一套（user > project > system 在 rule-service 已确定）
 *     - versionBucket 调度两套（rule-service 用 _inferVersionBucket，自写递归用路径段+frontmatter）
 *
 * 输入：
 *   - moduleRuleSelections (Coder 按模块施工时的规则引用投影)
 *   - ruleService    rule-service.js 实例（从 mcp 入口注入；提供 listRules + _getRuleSourcePriority）
 *   - projectPath    传给 listRules 让它把项目侧 .ai-workspace/knowledge 也加入快照
 *   - versionBucket  框架版本桶（从 框架版本档位.json 取，由调用方注入；LLM 视野不暴露）
 *
 * 输出：
 *   <demandDir>/code/relevant-rules.json
 *   {
 *     schemaVersion: "relevant-rules/v2",
 *     generatedAt: "...",
 *     versionBucket: "950以下" | "950及以上" | "",
 *     rulesByAlias: {
 *       "SqlConditionUtil使用规范": {
 *         ruleAlias,
 *         source,
 *         filePath,
 *         description,
 *         intentKeywords,
 *         globs,
 *         versionBucket,
 *         foundStatus
 *       }
 *     },
 *     modules: {
 *       "MOD-01": {
 *         ruleRefs: [{ ruleAlias: "SqlConditionUtil使用规范" }]
 *       }
 *     }
 *   }
 *
 * 关键设计取舍（AGENTS.md 红线对齐）：
 *   - 不抠规则正文（不物化规则）：只暴露规则元数据，不解析方法表 / 不抽示例
 *   - 不复制合同：每条规则只放一份索引，filePath 是真值入口，正文由 LLM 调 rule_expert(read, outputMode=full) 取
 *   - 不裁判业务：本服务只生成清单，是否读、什么时候读由 LLM 自审决定
 *   - 不写死项目样例：源目录不在本服务维护，由 ruleService 通过其构造参数管理
 *   - 不让 LLM 传 versionBucket：versionBucket 是 scan 已固定的确定事实（框架版本档位.json），
 *     由 plan-service 从 context.loadedArtifacts.frameworkBucket 自取后传给 build()
 */
const fs = require('fs');
const path = require('path');

class RelevantRulesBuilderService {

    constructor(options = {}) {
        // ruleService 通过依赖注入；测试时可传 mock。生产由 mcp 入口注入 this.ruleService。
        this.ruleService = options.ruleService || null;
    }

    /**
     * 主入口：按 moduleRuleSelections 构建相关规则清单。
     *
     * @param {object} args
     * @param {Array<{moduleId, ruleSelections: [{ruleAlias, ...}]}>} args.moduleRuleSelections
     * @param {string} [args.projectPath] 项目根，传给 ruleService.listRules 让它纳入项目侧规则
     * @param {string} [args.versionBucket] 目标版本桶；带桶的规则强制按桶匹配，无桶规则（如工具类规范）退到根版
     * @param {object} [args.ruleService] 临时覆盖（测试用），不传则用构造时注入的
     * @returns {{ ok, payload?, errorCode?, message? }}
     */
    build(args = {}) {
        const moduleRuleSelections = Array.isArray(args.moduleRuleSelections) ? args.moduleRuleSelections : [];
        const projectPath = String(args.projectPath || '').trim();
        const versionBucket = String(args.versionBucket || '').trim();
        const ruleService = args.ruleService || this.ruleService;

        if (!ruleService || typeof ruleService.listRules !== 'function') {
            return {
                ok: false,
                errorCode: 'RELEVANT_RULES_RULE_SERVICE_MISSING',
                message: '必须注入 ruleService（提供 listRules + _getRuleSourcePriority），不再自己写递归 walk'
            };
        }

        // 一次拉取规则索引（rule-service 内部已带快照缓存），后续 module 共享
        const allRules = ruleService.listRules(projectPath);

        // 同一 ruleAlias 在多 module 出现时只解析一次；payload 只在 rulesByAlias 写一份完整元数据。
        const cache = new Map();
        const rulesByAlias = {};

        const modules = {};
        for (const binding of moduleRuleSelections) {
            if (!binding || typeof binding !== 'object') continue;
            const moduleId = String(binding.moduleId || '').trim();
            if (!moduleId) continue;
            const ruleSelections = Array.isArray(binding.ruleSelections) ? binding.ruleSelections : [];
            const ruleRefs = [];
            const seenModuleAliases = new Set();
            for (const sel of ruleSelections) {
                const ruleAlias = String(sel && sel.ruleAlias || '').trim();
                if (!ruleAlias || seenModuleAliases.has(ruleAlias)) continue;
                seenModuleAliases.add(ruleAlias);
                if (cache.has(ruleAlias)) {
                    rulesByAlias[ruleAlias] = { ...cache.get(ruleAlias) };
                    ruleRefs.push({ ruleAlias });
                    continue;
                }
                const resolved = this._resolveRule(ruleAlias, allRules, versionBucket, ruleService);
                cache.set(ruleAlias, resolved);
                rulesByAlias[ruleAlias] = { ...resolved };
                ruleRefs.push({ ruleAlias });
            }
            modules[moduleId] = { ruleRefs };
        }

        return {
            ok: true,
            payload: {
                schemaVersion: 'relevant-rules/v2',
                generatedAt: new Date().toISOString(),
                versionBucket: versionBucket || '',
                rulesByAlias,
                modules
            }
        };
    }

    /**
     * 落盘 relevant-rules.json 到指定路径。
     */
    writePayload(destPath, payload) {
        const target = String(destPath || '').trim();
        if (!target) return { ok: false, errorCode: 'RELEVANT_RULES_DEST_PATH_MISSING' };
        try {
            fs.mkdirSync(path.dirname(target), { recursive: true });
            fs.writeFileSync(target, JSON.stringify(payload, null, 2), 'utf-8');
            return { ok: true, path: target };
        } catch (error) {
            return { ok: false, errorCode: 'RELEVANT_RULES_WRITE_FAILED', message: error.message };
        }
    }

    /**
     * 在 rule-service.listRules 快照中按 alias / versionBucket / source 三段过滤，
     * 同 design_tdd_skeleton_materialize 走的 resolveVersionedRule 路径。
     *
     * 匹配优先级（与骨架完全一致）：
     *   ① ruleAlias 完全相等
     *   ② versionBucket 命中：
     *      - 规则带桶 → 必须等于目标桶
     *      - 规则无桶（如 工具类规范/UserSession使用规范.mdc）→ 任何目标桶都接受
     *   ③ source 优先级 user > project > system > cloud（同 _getRuleSourcePriority）
     */
    _resolveRule(ruleAlias, allRules, versionBucket, ruleService) {
        const aliasMatches = allRules.filter(r => String(r.ruleAlias || '').trim() === ruleAlias);
        if (aliasMatches.length === 0) {
            return this._notFound(ruleAlias);
        }

        let pool;
        if (versionBucket) {
            // 带桶规则严格按桶过滤，无桶规则始终保留（让无桶根版也能命中）
            pool = aliasMatches.filter(r => {
                const rb = String(r.versionBucket || '').trim();
                return !rb || rb === versionBucket;
            });
            if (pool.length === 0) pool = aliasMatches; // 极端兜底
        } else {
            pool = aliasMatches;
        }

        // source 优先级排序，同优先级里有桶规则优先（更精确）
        const getPriority = typeof ruleService._getRuleSourcePriority === 'function'
            ? ruleService._getRuleSourcePriority.bind(ruleService)
            : (() => 0);
        pool.sort((a, b) => {
            const sp = getPriority(b.source) - getPriority(a.source);
            if (sp !== 0) return sp;
            const ab = String(a.versionBucket || '').trim();
            const bb = String(b.versionBucket || '').trim();
            // 有桶的优先于无桶（更精确）
            return (bb ? 1 : 0) - (ab ? 1 : 0);
        });

        const target = pool[0];
        return {
            ruleAlias,
            source: String(target.source || 'unknown').trim(),
            filePath: target.path || '',
            description: String(target.description || '').trim(),
            intentKeywords: Array.isArray(target.keywords) ? target.keywords : [],
            globs: this._normalizeGlobs(target.metadata && target.metadata.globs),
            versionBucket: String(target.versionBucket || '').trim(),
            foundStatus: 'found'
        };
    }

    _notFound(ruleAlias) {
        return {
            ruleAlias,
            source: 'unknown',
            filePath: '',
            description: '',
            intentKeywords: [],
            globs: [],
            versionBucket: '',
            foundStatus: 'not_found'
        };
    }

    _normalizeGlobs(value) {
        if (!value) return [];
        if (Array.isArray(value)) return value.map(item => String(item || '').trim()).filter(Boolean);
        const text = String(value).trim();
        if (!text) return [];
        if (text.includes(',')) {
            return text.split(',').map(item => item.trim()).filter(Boolean);
        }
        return [text];
    }
}

module.exports = RelevantRulesBuilderService;
