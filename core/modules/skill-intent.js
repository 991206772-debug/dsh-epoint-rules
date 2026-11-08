const fs = require('fs');
const fsPromises = require('fs').promises;
const path = require('path');
const yaml = require('js-yaml');


const PipelineUtils = require('./pipeline-utils');
const RuleValidationContract = require('./rule-validation-contract');
const GENERIC_CHINESE_INTENT_STOPWORDS = new Set([
    '新增', '支持', '状态', '来源', '渠道', '筛选', '业务', '管理员', '系统', '数据',
    '列表', '查询', '同步', '统计', '检索', '信息', '管理', '接口', '功能', '页面',
    '查看', '维护', '导出', '角色', '条件', '信息表', '对接', '用户', '图片', '文件', '附件',
    '第三方', '记录', '复用', '配置', '参数', '权限', '部门', '组织', '机构'
]);
const LOW_SIGNAL_REQUIREMENT_TERMS = new Set([
    'epoint', 'api', 'rest', 'service', 'controller', 'action', 'page', 'list', 'query', 'search',
    'info', 'view', 'manage', 'management',
    '接口api', 'api接口', '接口复用', 'api复用', '项目历史api资产复用', '项目历史api',
    '现成接口', '历史接口', '同步接口', '第三方接口', '资产复用'
]);

const REQUIREMENT_SIGNAL_DEFINITIONS = Object.freeze([
    {
        signal: 'frontend_interaction',
        rulePattern: /前端API|MiniUI|epoint\.execute|前端/iu,
        ruleUsageDuty: '前端按钮、页面交互、弹窗/列表承载和框架 API 调用必须按该规则施工。',
        coversSignals: ['frontend_existing_page_button', 'frontend_result_surface']
    },
    {
        signal: 'frontend_existing_page_button',
        userAnchor: '已有页面添加按钮/页面交互',
        requirementPattern: /(\.html|页面).{0,30}(按钮|添加|点击|展示)|按钮.{0,20}(点击|展示|列表|弹窗)/iu,
        usageDuty: '前端 Todo 需要绑定页面/按钮/MiniUI 或框架前端 API 规则。',
        coveredBySignals: ['frontend_interaction']
    },
    {
        signal: 'frontend_result_surface',
        userAnchor: '点击后展示列表/弹窗/结果',
        requirementPattern: /(展示|显示|打开).{0,16}(列表|表格|弹窗|数据)|列表.{0,12}(预览|下载|展示)/iu,
        usageDuty: '结果承载、列表和行操作需要绑定前端承载规则。',
        coveredBySignals: ['frontend_interaction']
    },
    {
        signal: 'external_http_api',
        userAnchor: '调用外部/第三方/平台接口',
        requirementPattern: /(电子证照|第三方|外部|平台|接口文档).{0,24}(接口|调用|对接|检索|调阅|下载)|调用.{0,20}(接口|电子证照)/iu,
        rulePattern: /HttpUtil|外部接口|第三方接口|HTTP请求|电子证照/iu,
        usageDuty: '接口调用 Todo 需要绑定外部 HTTP/API 调用规则。',
        ruleUsageDuty: '外部接口调用、请求封装、异常处理和调用边界必须按该规则施工。',
        coveredBySignals: ['rest_api_development']
    },
    {
        signal: 'rest_api_development',
        rulePattern: /REST接口|RestController/iu,
        ruleUsageDuty: '新增或暴露 REST 接口时必须按该规则施工；外部接口调用不得误当成新增 REST。'
    },
    {
        signal: 'file_preview',
        userAnchor: '预览文件或证照',
        requirementPattern: /预览/iu,
        rulePattern: /预览|PDF|Office|在线预览/iu,
        usageDuty: '预览能力建议匹配预览规则；未匹配时仅记录为规则召回提示项。',
        ruleUsageDuty: '文件/证照预览能力必须按该规则施工。'
    },
    {
        signal: 'file_download',
        userAnchor: '下载文件或证照',
        requirementPattern: /下载/iu,
        rulePattern: /下载|附件|AttachService|文件操作/iu,
        usageDuty: '下载能力建议匹配下载规则；未匹配时仅记录为规则召回提示项。',
        ruleUsageDuty: '文件/证照下载能力必须按该规则施工。'
    },
    {
        signal: 'call_log_persistence',
        userAnchor: '存储调用记录/日志/入参出参',
        requirementPattern: /(存储|保存|记录).{0,16}(调用记录|日志|入参|出参|调用人|调用时间)|入参|出参/iu,
        rulePattern: /日志|数据库|持久化|MIS表|CommonDao|SQL|表结构/iu,
        usageDuty: '调用记录持久化建议匹配数据库/日志/持久化规则；未匹配时仅记录为规则召回提示项。',
        ruleUsageDuty: '调用记录、日志或表结构持久化必须按该规则施工。'
    },
    {
        signal: 'file_placement',
        userAnchor: '文件坐落点/项目结构命名',
        requirementPattern: /(\.html|新增|创建|添加|修改|接口|数据库|表|文件|目录|包路径|action|rest|service|entity)/iu,
        rulePattern: /项目结构与命名|项目结构|命名规范|目录结构|包路径/iu,
        usageDuty: '文件范围和候选坐落点需要绑定项目结构与命名规则。',
        ruleUsageDuty: '仅用于候选坐落点、目录和命名约束；不得单独授权新增文件。'
    }
]);
const REQUIREMENT_SIGNAL_DEFINITION_BY_ID = new Map(REQUIREMENT_SIGNAL_DEFINITIONS.map(def => [def.signal, def]));

class SkillIntentService {
    constructor(ruleService) {
        this.ruleService = ruleService;
        this.skills = [];
        this.lastLoadTime = null;
        this.lastContextKey = null;
        this.requirementFeatureContractCache = new Map();
    }

    _buildContextKey(projectPath) {
        if (!projectPath || typeof projectPath !== 'string') {
            return '__default__';
        }

        try {
            return path.resolve(projectPath.trim()).toLowerCase();
        } catch (_) {
            return String(projectPath).trim().toLowerCase();
        }
    }

    /**
     * 核心改进：共用 RuleService 的规则发现逻辑
     * 不再自行扫描文件系统，而是处理 RuleService 提供的规则列表
     */
    loadSkillsConfig(projectPath) {
        const skills = [];
        this.requirementFeatureContractCache.clear();

        // 1. 获取 RuleService 发现的所有文件清单
        // listRules() 已经处理了 .project_repo, .product_repo, 用户目录等所有路径逻辑
        const allRules = this.ruleService.listRules(projectPath);

        // 2. 将文件清单转换为技能（Skills）
        for (const rule of allRules) {
            const ext = path.extname(rule.path);
            const ruleName = path.basename(rule.path, ext);

            if (this._isProjectAssetRuleEntry(rule)) {
                this._addSkillFromRuleEntry(skills, rule, ruleName, ext);
                continue;
            }

            // 使用 RuleService 的缓存读取内容
            const content = this.ruleService.getRuleContent(rule.name);
            if (content) {
                this._addSkillFromContent(skills, rule.name, ruleName, ext, content, rule.path, rule.source, rule);
            }
        }

        this.skills = skills;
        this.lastLoadTime = Date.now();
        this.lastContextKey = this._buildContextKey(projectPath);
        return { skills, count: skills.length };
    }

    resolveRuleReference(ruleName, options = {}) {
        const projectPath = typeof options === 'string'
            ? options
            : options.projectPath;
        const target = String(ruleName || '').trim();
        if (!target) {
            return { ok: false, code: 'RULE_REFERENCE_NAME_EMPTY', message: '规则名称为空' };
        }

        const normalize = value => String(value || '')
            .trim()
            .replace(/\\/g, '/')
            .replace(/\.(md|mdc)$/i, '');
        const targetNormalized = normalize(target);
        const targetBase = path.basename(targetNormalized);
        const loaded = this.loadSkillsConfig(projectPath);
        const skills = Array.isArray(loaded && loaded.skills) ? loaded.skills : [];
        const matchedSkill = skills.find(skill => {
            const id = normalize(skill.id);
            const name = normalize(skill.name);
            return id === targetNormalized
                || name === targetNormalized
                || path.basename(id) === targetBase
                || path.basename(name) === targetBase;
        });
        if (matchedSkill) {
            return {
                ok: true,
                ruleName: path.basename(normalize(matchedSkill.name || matchedSkill.id)),
                ruleId: matchedSkill.id,
                sourcePath: matchedSkill.path || '',
                source: matchedSkill.source || 'skill-intent'
            };
        }

        const resolvedRule = this.ruleService && typeof this.ruleService.resolveRule === 'function'
            ? this.ruleService.resolveRule(target, { projectPath })
            : null;
        if (resolvedRule) {
            return {
                ok: true,
                ruleName: path.basename(normalize(resolvedRule.name || target)),
                ruleId: resolvedRule.name || target,
                sourcePath: resolvedRule.path || '',
                source: resolvedRule.source || 'rule-service'
            };
        }

        return {
            ok: false,
            code: 'RULE_REFERENCE_NOT_FOUND',
            message: `未找到规则「${target}」`,
            searchedBy: 'skill-intent'
        };
    }

    /**
     * 异步加载 Skills 配置
     */
    async loadSkillsConfigAsync(projectPath) {
        const skills = [];
        this.requirementFeatureContractCache.clear();

        // 目前 RuleService.listRules 是同步的，但我们可以并行异步读取内容
        const allRules = this.ruleService.listRules(projectPath);

        const resolvedSkills = await Promise.all(allRules.map(async (rule) => {
            const ext = path.extname(rule.path);
            const ruleName = path.basename(rule.path, ext);

            if (this._isProjectAssetRuleEntry(rule)) {
                return this._buildSkillFromRuleEntry(rule, ruleName, ext);
            }

            const content = await this.ruleService.getRuleContentAsync(rule.name);
            if (content) {
                return this._buildSkillFromContent(rule.name, ruleName, ext, content, rule.path, rule.source, rule);
            }
            return null;
        }));

        resolvedSkills.filter(Boolean).forEach(skill => this._mergeSkillDefinition(skills, skill));

        this.skills = skills;
        this.lastLoadTime = Date.now();
        this.lastContextKey = this._buildContextKey(projectPath);
        return { skills, count: skills.length };
    }

    /**
     * 辅助方法：从内容中提取意图、关键词和动作
     * 这里保留 SkillIntentService 特有的业务逻辑（如驼峰分词、H1提取等）
     */
    _addSkillFromContent(skills, relativeId, ruleName, ext, content, fullPath, source, ruleEntry = null) {
        const skill = this._buildSkillFromContent(relativeId, ruleName, ext, content, fullPath, source, ruleEntry);
        if (skill) {
            this._mergeSkillDefinition(skills, skill);
        }
    }

    _addSkillFromRuleEntry(skills, ruleEntry = {}, ruleName = '', ext = '') {
        const skill = this._buildSkillFromRuleEntry(ruleEntry, ruleName, ext);
        if (skill) {
            this._mergeSkillDefinition(skills, skill);
        }
    }

    _buildSkillFromRuleEntry(ruleEntry = {}, ruleName = '', ext = '') {
        const metadata = ruleEntry && ruleEntry.metadata && typeof ruleEntry.metadata === 'object'
            ? ruleEntry.metadata
            : {};
        const title = String(metadata.title || metadata.rule_alias || ruleEntry.ruleAlias || ruleName || path.basename(String(ruleEntry.path || ''), ext)).trim();
        const minimalContent = `# ${title || ruleName}\n`;
        return this._buildSkillFromContent(
            ruleEntry.name || ruleName,
            ruleName || path.basename(String(ruleEntry.path || ''), ext),
            ext || path.extname(String(ruleEntry.path || '')),
            minimalContent,
            ruleEntry.path,
            ruleEntry.source,
            ruleEntry
        );
    }

    _mergeSkillDefinition(skills, skill) {
        if (!Array.isArray(skills) || !skill || typeof skill !== 'object') return;
        const existingIndex = skills.findIndex(item => item.id === skill.id);
        if (existingIndex !== -1) {
            if (skill.ext === '.mdc' || skills[existingIndex].ext === '.md') {
                skills[existingIndex] = skill;
            }
            return;
        }
        skills.push(skill);
    }

    _buildSkillFromContent(relativeId, ruleName, ext, content, fullPath, source, ruleEntry = null) {
        let keywords = [];
        let explicitKeywords = [];
        let derivedKeywords = [];
        let actions = [];
        let audit_config = null;
        let globs = null;
        let category = '';
        let description = '';
        let matchLane = '';
        let referencePolicy = '';
        let assetType = '';
        let pipelineVisibility = {};
        let websiteConsumption = {};
        let ruleMetadata = ruleEntry && ruleEntry.metadata && typeof ruleEntry.metadata === 'object'
            ? ruleEntry.metadata
            : null;

        // 1. 自动注入文件名作为隐式关键词（增强：驼峰分词）
        derivedKeywords.push(ruleName.toLowerCase());

        // 驼峰分词 (AuditProject -> Audit, Project)
        const camelParts = ruleName.split(/(?=[A-Z])/).filter(k => k.length >= 2);
        if (camelParts.length > 1) {
            derivedKeywords.push(...camelParts.map(k => k.toLowerCase()));
        }

        // 符号拆分
        const nameKeywords = ruleName.split(/[\s\-\_\(\)（）.]+/)
            .filter(k => k.length >= 2 && !derivedKeywords.includes(k.toLowerCase()));
        derivedKeywords.push(...nameKeywords.map(k => k.toLowerCase()));

        // 2. 解析 Frontmatter
        const entryMetadata = ruleEntry && ruleEntry.metadata && typeof ruleEntry.metadata === 'object'
            ? ruleEntry.metadata
            : null;
        if (entryMetadata) {
            ruleMetadata = entryMetadata;
            description = String(entryMetadata.description || '').trim();
            category = String(entryMetadata.category || '').trim();
            if (entryMetadata.intent_keywords) {
                const ik = Array.isArray(entryMetadata.intent_keywords) ? entryMetadata.intent_keywords : [entryMetadata.intent_keywords];
                explicitKeywords.push(...ik.map(k => String(k).toLowerCase()));
            }
            actions = Array.isArray(entryMetadata.actions) ? entryMetadata.actions : [];
            globs = entryMetadata.globs || null;
            audit_config = entryMetadata.audit_config || null;
            matchLane = String(entryMetadata.match_lane || ruleEntry.matchLane || '').trim();
            referencePolicy = String(entryMetadata.reference_policy || ruleEntry.referencePolicy || '').trim();
            assetType = String(entryMetadata.asset_type || ruleEntry.assetType || '').trim();
            pipelineVisibility = entryMetadata.pipeline_visibility && typeof entryMetadata.pipeline_visibility === 'object'
                ? entryMetadata.pipeline_visibility
                : {};
            websiteConsumption = entryMetadata.website_consumption && typeof entryMetadata.website_consumption === 'object'
                ? entryMetadata.website_consumption
                : {};
        } else {
            const frontmatterMatch = content.match(/^---[\r\n]+([\s\S]*?)[\r\n]+---/);
            if (frontmatterMatch) {
                try {
                    let yamlStr = frontmatterMatch[1].replace(/\r\n/g, '\n').replace(/\r/g, '\n');
                    let frontmatter;
                    try {
                        frontmatter = yaml.load(yamlStr);
                    } catch (e) {
                        const fixedYamlStr = yamlStr.replace(/^(globs:\s*)([^\s\n\["'].*)$/m, '$1"$2"');
                        frontmatter = yaml.load(fixedYamlStr);
                    }
                    ruleMetadata = frontmatter && typeof frontmatter === 'object' && !Array.isArray(frontmatter)
                        ? frontmatter
                        : ruleMetadata;
                    description = String(frontmatter.description || '').trim();
                    category = String(frontmatter.category || '').trim();
                    if (frontmatter.intent_keywords) {
                        const ik = Array.isArray(frontmatter.intent_keywords) ? frontmatter.intent_keywords : [frontmatter.intent_keywords];
                        explicitKeywords.push(...ik.map(k => String(k).toLowerCase()));
                    }
                    actions = frontmatter.actions || [];
                    globs = frontmatter.globs || null;
                    audit_config = frontmatter.audit_config || null;
                    matchLane = String(frontmatter.match_lane || '').trim();
                    referencePolicy = String(frontmatter.reference_policy || '').trim();
                    assetType = String(frontmatter.asset_type || '').trim();
                    pipelineVisibility = frontmatter.pipeline_visibility && typeof frontmatter.pipeline_visibility === 'object'
                        ? frontmatter.pipeline_visibility
                        : {};
                    websiteConsumption = frontmatter.website_consumption && typeof frontmatter.website_consumption === 'object'
                        ? frontmatter.website_consumption
                        : {};
                } catch (yamlError) {
                    // 静默处理，某些文件可能不是标准格式
                }
            }
        }

        // 3. 提取 H1 标题
        const h1Match = content.match(/^#\s+(.+)$/m);
        if (h1Match) {
            const title = h1Match[1].trim();
            const titleKeywords = title.split(/[\s\(\)（）.]+/)
                .filter(k => k.length >= 2 && !k.match(/使用规范|接口|实体/));
            derivedKeywords.push(...titleKeywords.map(k => k.toLowerCase()));
        }

        explicitKeywords = [...new Set(explicitKeywords)].filter(k => k && k.length >= 2);
        derivedKeywords = [...new Set(derivedKeywords)].filter(k => k && k.length >= 2);
        keywords = [...new Set([...explicitKeywords, ...derivedKeywords])].filter(k => k && k.length >= 2);

        if (keywords.length > 0) {
            const requirementSignal = this._firstStringValue(
                ruleEntry && ruleEntry.requirementSignal,
                ruleEntry && ruleEntry.requirementSignalId,
                ruleEntry && ruleEntry.r2cSignal,
                ruleEntry && ruleEntry.signal,
                ruleMetadata && ruleMetadata.requirementSignal,
                ruleMetadata && ruleMetadata.requirement_signal,
                ruleMetadata && ruleMetadata.requirementSignalId,
                ruleMetadata && ruleMetadata.requirement_signal_id,
                ruleMetadata && ruleMetadata.r2cSignal,
                ruleMetadata && ruleMetadata.r2c_signal,
                ruleMetadata && ruleMetadata.signal
            );
            const questionHints = this._explicitObjectArray(
                ruleEntry && ruleEntry.questionHints,
                ruleEntry && ruleEntry.question_hints,
                ruleEntry && ruleEntry.preFoundationQuestionHints,
                ruleEntry && ruleEntry.pre_foundation_question_hints,
                ruleMetadata && ruleMetadata.questionHints,
                ruleMetadata && ruleMetadata.question_hints,
                ruleMetadata && ruleMetadata.preFoundationQuestionHints,
                ruleMetadata && ruleMetadata.pre_foundation_question_hints
            );
            const requiredInputs = this._explicitObjectArray(
                ruleEntry && ruleEntry.requiredInputs,
                ruleEntry && ruleEntry.required_inputs,
                ruleMetadata && ruleMetadata.requiredInputs,
                ruleMetadata && ruleMetadata.required_inputs
            );
            const owner = this._firstStringValue(
                ruleEntry && ruleEntry.owner,
                ruleEntry && ruleEntry.ownerType,
                ruleEntry && ruleEntry.resolutionOwner,
                ruleEntry && ruleEntry.decisionOwner,
                ruleMetadata && ruleMetadata.owner,
                ruleMetadata && ruleMetadata.owner_type,
                ruleMetadata && ruleMetadata.ownerType,
                ruleMetadata && ruleMetadata.resolution_owner,
                ruleMetadata && ruleMetadata.resolutionOwner,
                ruleMetadata && ruleMetadata.decision_owner,
                ruleMetadata && ruleMetadata.decisionOwner
            );
            const decisionEntry = this._firstStringValue(
                ruleEntry && ruleEntry.decisionEntry,
                ruleEntry && ruleEntry.decisionEntryPoint,
                ruleEntry && ruleEntry.userDecisionEntry,
                ruleEntry && ruleEntry.questionEntry,
                ruleMetadata && ruleMetadata.decisionEntry,
                ruleMetadata && ruleMetadata.decision_entry,
                ruleMetadata && ruleMetadata.decisionEntryPoint,
                ruleMetadata && ruleMetadata.decision_entry_point,
                ruleMetadata && ruleMetadata.userDecisionEntry,
                ruleMetadata && ruleMetadata.user_decision_entry,
                ruleMetadata && ruleMetadata.questionEntry,
                ruleMetadata && ruleMetadata.question_entry
            );
            const mustConfirm = ruleEntry && (ruleEntry.mustConfirm === true || ruleEntry.requiresUserDecision === true || ruleEntry.requiresUserConfirmation === true)
                || ruleMetadata && (ruleMetadata.mustConfirm === true || ruleMetadata.must_confirm === true || ruleMetadata.requiresUserDecision === true || ruleMetadata.requires_user_decision === true || ruleMetadata.requiresUserConfirmation === true || ruleMetadata.requires_user_confirmation === true);
            return {
                id: relativeId,
                name: ruleName,
                ext: ext,
                intent_keywords: keywords,
                explicit_intent_keywords: explicitKeywords,
                derived_intent_keywords: derivedKeywords,
                actions: actions.length > 0 ? actions : [{ name: 'READ', description: 'Read documentation' }],
                globs: globs,
                audit_config: audit_config,
                path: fullPath,
                source: source,
                category,
                description,
                assetType,
                matchLane,
                referencePolicy,
                pipelineVisibility,
                websiteConsumption,
                metadata: ruleMetadata || null,
                ...(requirementSignal ? { requirementSignal } : {}),
                ...(questionHints.length > 0 ? { questionHints } : {}),
                ...(requiredInputs.length > 0 ? { requiredInputs } : {}),
                ...(owner ? { owner } : {}),
                ...(decisionEntry ? { decisionEntry } : {}),
                ...(mustConfirm ? { mustConfirm: true, requiresUserDecision: true } : {})
            };
        }
        return null;
    }

    _ensureSkillsLoaded(projectPath) {
        const contextKey = this._buildContextKey(projectPath);
        const now = Date.now();
        if (
            !this.skills.length
            || !this.lastLoadTime
            || (now - this.lastLoadTime > 30000)
            || this.lastContextKey !== contextKey
        ) {
            this.loadSkillsConfig(projectPath);
        }
    }

    _normalizeIntentText(text) {
        return String(text || '')
            .toLowerCase()
            .replace(/[吧呢啊吗的了]/g, '')
            .replace(/[\s"'`~!@#$%^&*()+=[\]{}|;:,.<>/?，。！？、；：“”‘’（）《》【】]/g, '')
            .replace(/[_./\\-]+/g, '');
    }

    _buildKeywordVariants(keyword) {
        const raw = String(keyword || '').trim().toLowerCase();
        if (!raw) return [];
        return [...new Set([
            raw,
            raw.replace(/\s+/g, ''),
            raw.replace(/[_./\\-]+/g, ''),
            raw.replace(/^i(?=[a-z])/i, '')
        ])].filter(item => item && item.length >= 2);
    }

    _getRuleSourcePriority(source = '') {
        switch (String(source || '').trim()) {
        case 'user': return 30;
        case 'project': return 20;
        case 'system': return 10;
        case 'cloud': return 5;
        default: return 0;
        }
    }

    _sanitizeRequirementTerm(term) {
        const normalized = String(term || '')
            .trim()
            .replace(/^[\-*]\s*/, '')
            .replace(/[，。！？；：,.!?;:()"'\[\]{}【】《》]/g, '')
            .trim();
        return normalized.length >= 2 ? normalized : '';
    }

    _collectRequirementTermsFromValue(value, options = {}) {
        const preferredKeys = Array.isArray(options.preferredKeys) ? options.preferredKeys : [];
        const nestedKeys = Array.isArray(options.nestedKeys) && options.nestedKeys.length > 0
            ? options.nestedKeys
            : ['values', 'permissions', 'features', 'fields', 'methods', 'params', 'keywords', 'usage'];
        const fallbackKeys = Array.isArray(options.fallbackKeys) && options.fallbackKeys.length > 0
            ? options.fallbackKeys
            : [
                'name',
                'label',
                'title',
                'field_name',
                'fieldName',
                'param_name',
                'paramName',
                'role',
                'control',
                'entity_name',
                'entityName',
                'service_name',
                'serviceName',
                'api_name',
                'apiName',
                'path',
                'remark',
                'reason',
                'description'
            ];
        const maxDepth = Number.isInteger(options.maxDepth) ? options.maxDepth : 2;
        const collected = [];
        const seenObjects = new Set();
        const push = item => {
            if (typeof item === 'string' || typeof item === 'number' || typeof item === 'boolean') {
                collected.push(String(item).trim());
            }
        };
        const visit = (input, depth = 0) => {
            if (input === null || input === undefined || depth > maxDepth) return;
            if (Array.isArray(input)) {
                input.forEach(item => visit(item, depth + 1));
                return;
            }
            if (typeof input === 'string' || typeof input === 'number' || typeof input === 'boolean') {
                push(input);
                return;
            }
            if (typeof input !== 'object') return;
            if (seenObjects.has(input)) return;
            seenObjects.add(input);

            const keys = [...preferredKeys, ...nestedKeys, ...fallbackKeys]
                .filter((key, index, array) => key && array.indexOf(key) === index);
            let hit = false;
            keys.forEach(key => {
                if (!Object.prototype.hasOwnProperty.call(input, key)) return;
                hit = true;
                visit(input[key], depth + 1);
            });
            if (!hit && options.includeObjectValues === true) {
                Object.values(input).forEach(item => visit(item, depth + 1));
            }
        };

        visit(value, 0);
        return collected;
    }

    _dedupeRequirementTerms(items = []) {
        const seen = new Set();
        const normalized = [];
        for (const item of (Array.isArray(items) ? items : [items])) {
            const candidates = this._collectRequirementTermsFromValue(item);
            for (const candidate of candidates) {
                const clean = this._sanitizeRequirementTerm(candidate);
                if (!clean) continue;
                const dedupeKey = clean.toLowerCase();
                if (seen.has(dedupeKey)) continue;
                seen.add(dedupeKey);
                normalized.push(clean);
            }
        }
        return normalized;
    }

    _extractRequirementSummary(userIntent = '') {
        const text = String(userIntent || '').trim();
        if (!text) return '';
        const firstSentence = text.split(/[\r\n。！？!?]/).map(item => item.trim()).find(Boolean);
        return (firstSentence || text).slice(0, 120);
    }

    _normalizeRequirementFeatureDefinition(definition = {}) {
        if (!definition || typeof definition !== 'object' || Array.isArray(definition)) return null;
        const key = String(definition.key || '').trim();
        if (!key) return null;

        const parseTerms = value => this._dedupeRequirementTerms(Array.isArray(value) ? value : []);
        const minWeakHits = Number.isInteger(definition.min_weak_hits)
            ? definition.min_weak_hits
            : (Number.isInteger(definition.minWeakHits) ? definition.minWeakHits : Number.parseInt(definition.min_weak_hits || definition.minWeakHits || 1, 10));

        return {
            key,
            label: String(definition.label || key).trim(),
            metadataBucket: String(definition.metadata_bucket || definition.metadataBucket || '').trim(),
            emittedTerms: parseTerms(definition.emitted_terms || definition.obvious_terms || definition.match_terms),
            strongSignals: parseTerms(definition.strong_signals || definition.strongSignals),
            weakSignals: parseTerms(definition.weak_signals || definition.weakSignals),
            minWeakHits: Number.isInteger(minWeakHits) && minWeakHits > 0 ? minWeakHits : 1
        };
    }

    _normalizeRequirementFeatureContract(contract = {}) {
        const sourceContract = contract && typeof contract === 'object' && !Array.isArray(contract)
            ? contract
            : {};
        const stableFeatures = (Array.isArray(sourceContract.stable_features) ? sourceContract.stable_features : [])
            .map(item => this._normalizeRequirementFeatureDefinition(item))
            .filter(Boolean);

        const uiControls = this._dedupeRequirementTerms(
            Array.isArray(sourceContract.ui_controls) ? sourceContract.ui_controls : []
        );
        const entitySignals = this._dedupeRequirementTerms(
            Array.isArray(sourceContract.entity_signals) ? sourceContract.entity_signals : []
        );
        const serviceSignals = this._dedupeRequirementTerms(
            Array.isArray(sourceContract.service_signals) ? sourceContract.service_signals : []
        );
        const apiSignals = this._dedupeRequirementTerms(
            Array.isArray(sourceContract.api_signals) ? sourceContract.api_signals : []
        );

        return {
            stableFeatures,
            uiControls,
            entitySignals,
            serviceSignals,
            apiSignals
        };
    }

    _getRequirementFeatureContract(projectPath) {
        const cacheKey = this._buildContextKey(projectPath);
        if (this.requirementFeatureContractCache.has(cacheKey)) {
            return this.requirementFeatureContractCache.get(cacheKey);
        }

        try {
            if (this.ruleService && typeof this.ruleService.listRules === 'function') {
                this.ruleService.listRules(projectPath);
            }
        } catch (_) {
            // ignore rule discovery sync failures and fall back to defaults
        }

        let contract = null;
        let statusMessage = '';
        let statusOk = false;
        const guideContent = this.ruleService && typeof this.ruleService.getRuleContentByPolicy === 'function'
            ? this.ruleService.getRuleContentByPolicy('需求分析指南', {
                projectPath,
                sourcePolicy: 'system-only'
            })
            : (this.ruleService && typeof this.ruleService.getRuleContent === 'function'
                ? this.ruleService.getRuleContent('需求分析指南')
                : '');
        if (guideContent) {
            const parsed = RuleValidationContract.parseYamlContract(
                guideContent,
                'AI Requirement Feature Contract',
                'RULE_REQUIREMENT_FEATURE_CONTRACT_MISSING'
            );
            if (parsed && parsed.ok) {
                contract = parsed.contract;
                statusOk = true;
            } else {
                statusMessage = `REQUIREMENT_FEATURE_CONTRACT_INVALID: ${parsed && parsed.message ? parsed.message : '需求分析指南中的 AI Requirement Feature Contract 解析失败'}`;
            }
        } else {
            statusMessage = 'REQUIREMENT_FEATURE_CONTRACT_MISSING: 未找到 system-only 的《需求分析指南》或其中缺少 AI Requirement Feature Contract';
        }

        const normalizedContract = this._normalizeRequirementFeatureContract(contract);
        const result = {
            ...normalizedContract,
            ok: statusOk && normalizedContract.stableFeatures.length > 0,
            message: statusOk && normalizedContract.stableFeatures.length === 0
                ? 'REQUIREMENT_FEATURE_CONTRACT_EMPTY: 《需求分析指南》缺少 stable_features 定义'
                : statusMessage,
            warnings: [
                ...(normalizedContract.entitySignals.length === 0
                    ? ['REQUIREMENT_FEATURE_CONTRACT_ENTITY_SIGNALS_MISSING: 《需求分析指南》缺少 entity_signals 定义，实体识别已停用，请先补齐契约。']
                    : []),
                ...(normalizedContract.serviceSignals.length === 0
                    ? ['REQUIREMENT_FEATURE_CONTRACT_SERVICE_SIGNALS_MISSING: 《需求分析指南》缺少 service_signals 定义，服务识别已停用。']
                    : []),
                ...(normalizedContract.apiSignals.length === 0
                    ? ['REQUIREMENT_FEATURE_CONTRACT_API_SIGNALS_MISSING: 《需求分析指南》缺少 api_signals 定义，接口识别已停用。']
                    : [])
            ],
            source: statusOk ? 'system-rule' : 'missing'
        };
        this.requirementFeatureContractCache.set(cacheKey, result);
        return result;
    }

    getRequirementFeatureContract(projectPath) {
        return this._getRequirementFeatureContract(projectPath);
    }

    isKeywordTargetMatch(skillKeyword, targetKeyword) {
        return this._isKeywordTargetMatch(skillKeyword, targetKeyword);
    }

    collectRequirementMatchEvidence(rule = {}) {
        return this._collectRequirementMatchEvidence(rule);
    }

    _findRequirementFeature(featureContract = {}, key = '') {
        const stableFeatures = featureContract && Array.isArray(featureContract.stableFeatures)
            ? featureContract.stableFeatures
            : [];
        return stableFeatures.find(item => item.key === key) || null;
    }

    _buildRequirementAspectEntry(definition = {}, strongHits = [], weakHits = []) {
        const matchTerms = this._dedupeRequirementTerms([
            ...(Array.isArray(definition.emittedTerms) ? definition.emittedTerms : []),
            ...strongHits,
            ...weakHits
        ]);
        if (matchTerms.length === 0) return null;
        const reasonParts = [];
        if (strongHits.length > 0) reasonParts.push(`强信号: ${strongHits.join('、')}`);
        if (weakHits.length > 0) reasonParts.push(`弱信号: ${weakHits.join('、')}`);
        return {
            aspect: definition.label || definition.key || '未命名方面',
            aspect_key: definition.key || '',
            reason: reasonParts.join('；') || '基于需求分析指南识别',
            match_terms: matchTerms
        };
    }

    _buildRequirementMetadataInventory(aspectEntries = [], userIntent = '', featureContract = {}) {
        const byKey = new Map((Array.isArray(aspectEntries) ? aspectEntries : []).map(item => [item.aspect_key, item]));
        const metadataBuckets = {
            code_items: [],
            sys_params: [],
            role_permissions: []
        };

        (Array.isArray(featureContract.stableFeatures) ? featureContract.stableFeatures : []).forEach(definition => {
            if (!definition || !definition.metadataBucket || !Object.prototype.hasOwnProperty.call(metadataBuckets, definition.metadataBucket)) {
                return;
            }
            const matchedEntry = byKey.get(definition.key);
            if (!matchedEntry) return;
            metadataBuckets[definition.metadataBucket].push(...(Array.isArray(matchedEntry.match_terms) ? matchedEntry.match_terms : []));
        });

        return {
            code_items: this._dedupeRequirementTerms(metadataBuckets.code_items),
            sys_params: this._dedupeRequirementTerms(metadataBuckets.sys_params),
            role_permissions: this._dedupeRequirementTerms(metadataBuckets.role_permissions),
            ui_controls: this._collectIntentSignalHits(
                userIntent,
                Array.isArray(featureContract.uiControls) ? featureContract.uiControls : []
            )
        };
    }

    _buildRequirementEntityServiceApiChain(userIntent = '', featureContract = {}) {
        const text = String(userIntent || '');
        const fragments = this._extractChineseIntentFragments(text, 3, 6)
            .filter(item => !GENERIC_CHINESE_INTENT_STOPWORDS.has(String(item || '').trim()))
            .slice(0, 24);
        const entitySignals = this._dedupeRequirementTerms(
            Array.isArray(featureContract.entitySignals) ? featureContract.entitySignals : []
        );
        const apiReuseFeature = this._findRequirementFeature(featureContract, 'api_reuse');
        const reusableAssetSignals = this._dedupeRequirementTerms([
            ...(apiReuseFeature && Array.isArray(apiReuseFeature.strongSignals) ? apiReuseFeature.strongSignals : []),
            ...(apiReuseFeature && Array.isArray(apiReuseFeature.weakSignals) ? apiReuseFeature.weakSignals : []),
            ...(apiReuseFeature && Array.isArray(apiReuseFeature.emittedTerms) ? apiReuseFeature.emittedTerms : [])
        ]);
        const entities = this._dedupeRequirementTerms([
            ...this._collectIntentSignalHits(text, entitySignals),
            ...fragments.filter(fragment => entitySignals.some(signal => fragment.includes(signal) || signal.includes(fragment)))
        ]);
        const serviceSignals = this._dedupeRequirementTerms(
            Array.isArray(featureContract.serviceSignals) ? featureContract.serviceSignals : []
        );
        const apiSignals = this._dedupeRequirementTerms(
            Array.isArray(featureContract.apiSignals) ? featureContract.apiSignals : []
        );
        const services = this._dedupeRequirementTerms(this._collectIntentSignalHits(text, serviceSignals));
        const apis = this._dedupeRequirementTerms(this._collectIntentSignalHits(text, apiSignals));
        const reusableAssets = this._dedupeRequirementTerms(this._collectIntentSignalHits(text, reusableAssetSignals));
        return {
            entities,
            services,
            apis,
            reusable_assets: reusableAssets
        };
    }

    _collectIntentSignalHits(userIntent, signals = []) {
        const lowerIntent = String(userIntent || '').toLowerCase();
        const normalizedIntent = this._normalizeIntentText(userIntent);
        const hits = [];

        for (const signal of signals) {
            const variants = this._buildKeywordVariants(signal);
            if (variants.some(variant => lowerIntent.includes(variant) || normalizedIntent.includes(variant))) {
                hits.push(signal);
            }
        }

        return [...new Set(hits)];
    }

    _isKeywordTargetMatch(skillKeyword, targetKeyword) {
        const skillVariants = this._buildKeywordVariants(skillKeyword);
        const targetVariants = this._buildKeywordVariants(targetKeyword);
        return skillVariants.some(skillVariant => targetVariants.some(targetVariant =>
            skillVariant === targetVariant
            || skillVariant.includes(targetVariant)
            || targetVariant.includes(skillVariant)
        ));
    }

    _buildRuleMatchFromSkill(skill, weight, matchedKeywords, matchSource = 'heuristic') {
        const applicability = this._extractRuleApplicability(skill);
        return {
            name: skill.id,
            ruleAlias: skill.name,
            category: skill.category || '',
            description: skill.description || '',
            keywords: skill.intent_keywords,
            path: skill.path,
            source: skill.source,
            metadata: skill.metadata || null,
            ...(applicability.applicableLayers.length > 0 ? { applicableLayers: applicability.applicableLayers } : {}),
            ...(applicability.applicableExecutionRoles.length > 0 ? { applicableExecutionRoles: applicability.applicableExecutionRoles } : {}),
            ...(applicability.applicableFileKinds.length > 0 ? { applicableFileKinds: applicability.applicableFileKinds } : {}),
            weight,
            matchedKeywords: [...new Set(Array.isArray(matchedKeywords) ? matchedKeywords : [])],
            matchSource
        };
    }

    _extractRuleApplicability(rule = {}) {
        const metadata = rule && rule.metadata && typeof rule.metadata === 'object'
            ? rule.metadata
            : {};
        const nested = metadata.applicability && typeof metadata.applicability === 'object'
            ? metadata.applicability
            : {};
        return {
            applicableLayers: this._explicitStringArray(
                rule.applicableLayers,
                rule.applicable_layers,
                metadata.applicableLayers,
                metadata.applicable_layers,
                nested.applicableLayers,
                nested.applicable_layers
            ),
            applicableExecutionRoles: this._explicitStringArray(
                rule.applicableExecutionRoles,
                rule.applicable_execution_roles,
                metadata.applicableExecutionRoles,
                metadata.applicable_execution_roles,
                nested.applicableExecutionRoles,
                nested.applicable_execution_roles
            ),
            applicableFileKinds: this._explicitStringArray(
                rule.applicableFileKinds,
                rule.applicable_file_kinds,
                metadata.applicableFileKinds,
                metadata.applicable_file_kinds,
                nested.applicableFileKinds,
                nested.applicable_file_kinds
            )
        };
    }

    _explicitStringArray(...values) {
        for (const value of values) {
            const list = Array.isArray(value)
                ? value.map(item => String(item || '').trim()).filter(Boolean)
                : (typeof value === 'string' && value.trim() ? [value.trim()] : []);
            if (list.length > 0) {
                return Array.from(new Set(list));
            }
        }
        return [];
    }

    _explicitObjectArray(...values) {
        for (const value of values) {
            if (!Array.isArray(value)) {
                continue;
            }
            const list = value
                .filter(item => item && typeof item === 'object' && !Array.isArray(item))
                .map(item => ({ ...item }));
            if (list.length > 0) {
                return list;
            }
        }
        return [];
    }

    _firstStringValue(...values) {
        for (const value of values) {
            const text = String(value || '').trim();
            if (text) {
                return text;
            }
        }
        return '';
    }

    _normalizeRulePathLike(rule = {}) {
        return String(rule && (rule.id || rule.name || rule.path || '') || '').replace(/\\/g, '/');
    }

    _isProjectAssetRuleEntry(rule = {}) {
        const assetType = String(rule && (rule.assetType || (rule.metadata && (rule.metadata.asset_type || rule.metadata.assetType)) || '') || '').trim();
        const matchLane = String(rule && (rule.matchLane || (rule.metadata && (rule.metadata.match_lane || rule.metadata.matchLane)) || '') || '').trim();
        const category = String(rule && (rule.category || (rule.metadata && rule.metadata.category) || '') || '').trim();
        const normalizedPath = this._normalizeRulePathLike(rule);
        return assetType === 'project_api_asset'
            || assetType === 'project_feature_asset'
            || assetType === 'project_knowledge'
            || matchLane === 'project_api_asset'
            || matchLane === 'project_feature_asset'
            || matchLane === 'project_knowledge'
            || category === '项目现成接口规范'
            || category === 'API资产沉淀'
            || category === '功能沉淀'
            || category === '需求规则沉淀'
            || /(?:^|\/)项目规则\/(?:现成接口规则|API资产|功能沉淀|需求沉淀)(?:\/|$)/.test(normalizedPath);
    }

    _isProjectApiAssetRule(skill) {
        const assetType = String(skill && (skill.assetType || (skill.metadata && (skill.metadata.asset_type || skill.metadata.assetType)) || '') || '').trim();
        const explicitLane = String(skill && (skill.matchLane || (skill.metadata && (skill.metadata.match_lane || skill.metadata.matchLane)) || '') || '').trim();
        const category = String(skill && (skill.category || (skill.metadata && skill.metadata.category) || '') || '').trim();
        const normalizedPath = this._normalizeRulePathLike(skill);
        return assetType === 'project_api_asset'
            || explicitLane === 'project_api_asset'
            || category === '项目现成接口规范'
            || category === 'API资产沉淀'
            || /(?:^|\/)项目规则\/(?:现成接口规则|API资产)(?:\/|$)/.test(normalizedPath);
    }

    _isProjectFeatureAssetRule(skill) {
        const assetType = String(skill && (skill.assetType || (skill.metadata && (skill.metadata.asset_type || skill.metadata.assetType)) || '') || '').trim();
        const explicitLane = String(skill && (skill.matchLane || (skill.metadata && (skill.metadata.match_lane || skill.metadata.matchLane)) || '') || '').trim();
        const category = String(skill && (skill.category || (skill.metadata && skill.metadata.category) || '') || '').trim();
        const normalizedPath = this._normalizeRulePathLike(skill);
        return assetType === 'project_feature_asset'
            || explicitLane === 'project_feature_asset'
            || category === '功能沉淀'
            || /(?:^|\/)项目规则\/功能沉淀(?:\/|$)/.test(normalizedPath);
    }

    _getExplicitRequirementKeywords(skill = {}) {
        return this._dedupeRequirementTerms(
            Array.isArray(skill.explicit_intent_keywords) ? skill.explicit_intent_keywords : []
        );
    }

    _getRequirementMatchLane(rule) {
        if (this._isProjectApiAssetRule(rule)) return 'project_api_asset';
        if (this._isProjectFeatureAssetRule(rule)) return 'project_feature_asset';
        return 'reference_rule';
    }

    _decorateRequirementMatch(rule) {
        const matchLane = this._getRequirementMatchLane(rule);
        const applicability = this._extractRuleApplicability(rule);
        return {
            ...rule,
            matchLane,
            referencePolicy: matchLane === 'project_api_asset' || matchLane === 'project_feature_asset' ? 'context_only' : 'srs_reference',
            ...(applicability.applicableLayers.length > 0 ? { applicableLayers: applicability.applicableLayers } : {}),
            ...(applicability.applicableExecutionRoles.length > 0 ? { applicableExecutionRoles: applicability.applicableExecutionRoles } : {}),
            ...(applicability.applicableFileKinds.length > 0 ? { applicableFileKinds: applicability.applicableFileKinds } : {})
        };
    }

    _isLowSignalRequirementTerm(term) {
        const normalized = this._sanitizeRequirementTerm(term).toLowerCase();
        if (!normalized) return true;
        if (normalized.length <= 1) return true;
        const compact = normalized.replace(/[_./\\\s-]+/g, '');
        return GENERIC_CHINESE_INTENT_STOPWORDS.has(normalized)
            || GENERIC_CHINESE_INTENT_STOPWORDS.has(compact)
            || LOW_SIGNAL_REQUIREMENT_TERMS.has(normalized)
            || LOW_SIGNAL_REQUIREMENT_TERMS.has(compact);
    }

    _hasHighConfidenceRequirementMatch(rule = {}) {
        const matchedKeywords = this._dedupeRequirementTerms(
            Array.isArray(rule && rule.matchedKeywords) ? rule.matchedKeywords : []
        ).filter(term => !this._isLowSignalRequirementTerm(term));
        const matchedTerms = this._dedupeRequirementTerms(
            Array.isArray(rule && rule.matchedTerms) ? rule.matchedTerms : []
        ).filter(term => !this._isLowSignalRequirementTerm(term));
        return matchedKeywords.length > 0 && matchedTerms.length > 0;
    }

    _collectRequirementMatchEvidence(rule = {}) {
        const matchedKeywords = Array.isArray(rule && rule.matchedKeywords) ? rule.matchedKeywords : [];
        const matchedTerms = Array.isArray(rule && rule.matchedTerms) ? rule.matchedTerms : [];
        const declaredKeywords = Array.isArray(rule && rule.keywords) ? rule.keywords : [];
        const explicitKeywords = Array.isArray(rule && rule.explicit_intent_keywords) ? rule.explicit_intent_keywords : [];
        const distinctEvidence = this._dedupeRequirementTerms([
            ...matchedKeywords,
            ...matchedTerms,
            ...declaredKeywords,
            ...explicitKeywords
        ]).filter(term => !this._isLowSignalRequirementTerm(term));
        return {
            distinctEvidence,
            count: distinctEvidence.length
        };
    }

    _extractStableFeatureKeysFromAnalysis(analysis = {}) {
        const normalized = analysis && typeof analysis === 'object' ? analysis : {};
        const featureKeys = new Set();
        (Array.isArray(normalized.rule_coverage_aspects) ? normalized.rule_coverage_aspects : []).forEach(item => {
            const aspectKey = String(item && (item.aspect_key || item.aspectKey || item.aspect_name || item.aspectName) || '').trim();
            if (aspectKey) featureKeys.add(aspectKey);
        });
        const inventory = normalized.metadata_inventory && typeof normalized.metadata_inventory === 'object'
            ? normalized.metadata_inventory
            : {};
        if (Array.isArray(inventory.code_items) && inventory.code_items.length > 0) featureKeys.add('code_item');
        if (Array.isArray(inventory.sys_params) && inventory.sys_params.length > 0) featureKeys.add('sys_param');
        if (Array.isArray(inventory.role_permissions) && inventory.role_permissions.length > 0) featureKeys.add('role_permission');
        const entityChain = normalized.entity_service_api_chain && typeof normalized.entity_service_api_chain === 'object'
            ? normalized.entity_service_api_chain
            : {};
        if (
            (Array.isArray(entityChain.apis) && entityChain.apis.length > 0)
            || (Array.isArray(entityChain.reusable_assets) && entityChain.reusable_assets.length > 0)
        ) {
            featureKeys.add('api_reuse');
        }
        return [...featureKeys];
    }

    _normalizeRequirementIntentSignalPayload(payload = {}, featureContract = {}) {
        const normalizedPayload = payload && typeof payload === 'object' ? payload : {};
        const featureKeys = this._dedupeRequirementTerms(
            Array.isArray(normalizedPayload.featureKeys)
                ? normalizedPayload.featureKeys
                : (Array.isArray(normalizedPayload.explicitNeeds) ? normalizedPayload.explicitNeeds : [])
        );
        const analysisTerms = this._dedupeRequirementTerms(
            Array.isArray(normalizedPayload.analysisTerms)
                ? normalizedPayload.analysisTerms
                : (Array.isArray(normalizedPayload.ruleMatchTerms) ? normalizedPayload.ruleMatchTerms : [])
        );
        const intentSignals = this._dedupeRequirementTerms(
            Array.isArray(normalizedPayload.intentSignals)
                ? normalizedPayload.intentSignals
                : (Array.isArray(normalizedPayload.signals) ? normalizedPayload.signals : [])
        );
        const featureSignals = this._dedupeRequirementTerms(
            featureKeys.flatMap(featureKey => this._getRequirementFeatureSignalTerms(featureContract, featureKey))
        );
        return {
            stage: String(normalizedPayload.stage || 'requirement').trim() || 'requirement',
            featureKeys,
            analysisTerms,
            intentSignals,
            featureSignals,
            signals: this._dedupeRequirementTerms([
                ...intentSignals,
                ...analysisTerms,
                ...featureSignals
            ])
        };
    }

    _getRequirementFeatureSignalTerms(featureContract = {}, featureKey = '') {
        const feature = this._findRequirementFeature(featureContract, featureKey);
        if (!feature) return [];
        return this._dedupeRequirementTerms([
            feature.label,
            ...(Array.isArray(feature.emittedTerms) ? feature.emittedTerms : []),
            ...(Array.isArray(feature.strongSignals) ? feature.strongSignals : []),
            ...(Array.isArray(feature.weakSignals) ? feature.weakSignals : [])
        ]);
    }

    _collectRuleRequirementKeywords(rule = {}) {
        return this._dedupeRequirementTerms([
            ...(Array.isArray(rule && rule.explicit_intent_keywords) ? rule.explicit_intent_keywords : []),
            ...(Array.isArray(rule && rule.intent_keywords) ? rule.intent_keywords : []),
            ...(Array.isArray(rule && rule.keywords) ? rule.keywords : [])
        ]);
    }

    _ruleSupportsRequirementFeature(rule = {}, featureContract = {}, featureKey = '') {
        const ruleKeywords = this._collectRuleRequirementKeywords(rule);
        const featureSignals = this._getRequirementFeatureSignalTerms(featureContract, featureKey)
            .filter(signal => !this._isLowSignalRequirementTerm(signal));
        if (ruleKeywords.length === 0 || featureSignals.length === 0) {
            return { ok: false, matchedSignals: [] };
        }
        const matchedSignals = featureSignals.filter(signal =>
            ruleKeywords.some(keyword => this._isKeywordTargetMatch(keyword, signal))
        );
        return {
            ok: matchedSignals.length > 0,
            matchedSignals: this._dedupeRequirementTerms(matchedSignals)
        };
    }

    _scoreRuleForRequirementFeature(rule = {}, featureContract = {}, featureKey = '') {
        const support = this._ruleSupportsRequirementFeature(rule, featureContract, featureKey);
        if (!support.ok) return { weight: 0, matchedSignals: [] };
        const sourcePriority = this._getRuleSourcePriority(rule && rule.source || '');
        const explicitKeywordCount = Array.isArray(rule && rule.explicit_intent_keywords) ? rule.explicit_intent_keywords.length : 0;
        return {
            weight: support.matchedSignals.length * 20 + explicitKeywordCount * 2 + sourcePriority,
            matchedSignals: support.matchedSignals
        };
    }

    _shouldKeepRequirementReferenceRule(rule = {}, stableFeatureKeys = [], featureContract = {}) {
        const evidence = this._collectRequirementMatchEvidence(rule);
        if (evidence.count >= 1) return true;
        return (Array.isArray(stableFeatureKeys) ? stableFeatureKeys : [])
            .some(featureKey => this._ruleSupportsRequirementFeature(rule, featureContract, featureKey).ok);
    }

    _shouldKeepRequirementProjectAssetRule(rule = {}, stableFeatureKeys = [], featureContract = {}) {
        const evidence = this._collectRequirementMatchEvidence(rule);
        if (evidence.count >= 2) return true;
        return evidence.count >= 1
            && (Array.isArray(stableFeatureKeys) ? stableFeatureKeys : [])
                .some(featureKey => this._ruleSupportsRequirementFeature(rule, featureContract, featureKey).ok);
    }

    _buildStableFeatureRequirementMatches(stableFeatureKeys = [], featureContract = {}) {
        const featureSet = new Set(Array.isArray(stableFeatureKeys) ? stableFeatureKeys : []);
        if (featureSet.size === 0) return [];
        const syntheticMatches = [];
        const pushFeatureRule = featureKey => {
            if (!featureSet.has(featureKey)) return;
            const rankedRules = this.skills
                .filter(skill => this._isRequirementIntentCandidate(skill, { includeInterfaceRules: true }))
                .filter(skill => !this._isProjectAssetRuleEntry(skill))
                .map(skill => ({
                    skill,
                    score: this._scoreRuleForRequirementFeature(skill, featureContract, featureKey)
                }))
                .filter(item => item.score.weight > 0)
                .sort((left, right) =>
                    right.score.weight - left.score.weight
                    || this._getRuleSourcePriority(right.skill.source) - this._getRuleSourcePriority(left.skill.source)
                    || String(left.skill.name || left.skill.id || '').localeCompare(String(right.skill.name || right.skill.id || ''))
                );
            const topMatch = rankedRules[0];
            const rule = topMatch && topMatch.skill;
            if (!rule) return;
            const label = String(this._findRequirementFeature(featureContract, featureKey)?.label || featureKey).trim() || featureKey;
            syntheticMatches.push({
                name: rule.id,
                ruleAlias: rule.name,
                category: rule.category || '',
                description: rule.description || '',
                keywords: rule.intent_keywords,
                explicit_intent_keywords: rule.explicit_intent_keywords,
                path: rule.path,
                source: rule.source,
                matchLane: 'reference_rule',
                referencePolicy: 'srs_reference',
                metadata: rule.metadata || null,
                weight: 120 + Number(topMatch.score.weight || 0),
                matchedKeywords: topMatch.score.matchedSignals,
                matchedTerms: topMatch.score.matchedSignals,
                matchSource: `stable_feature.${featureKey}`
            });
        };

        pushFeatureRule('code_item');
        pushFeatureRule('role_permission');
        pushFeatureRule('sys_param');
        return syntheticMatches;
    }

    _hasRestApiDevelopmentIntent(normalizedPayload = {}) {
        const signals = this._dedupeRequirementTerms([
            ...(Array.isArray(normalizedPayload.intentSignals) ? normalizedPayload.intentSignals : []),
            ...(Array.isArray(normalizedPayload.analysisTerms) ? normalizedPayload.analysisTerms : []),
            ...(Array.isArray(normalizedPayload.signalTerms) ? normalizedPayload.signalTerms : []),
            ...(Array.isArray(normalizedPayload.signals) ? normalizedPayload.signals : [])
        ]);
        const compact = signals.join(' ').replace(/\s+/g, '');
        if (!compact) return false;
        if (this._hasExternalHttpCallIntent(normalizedPayload)) return false;
        return /restcontroller|@restcontroller/i.test(compact)
            || /(新增|开发|提供|暴露|发布|开放).{0,12}(rest接口|restapi|接口|api|controller)/iu.test(compact)
            || /(rest接口|restapi|接口|api|controller).{0,12}(新增|开发|提供|暴露|发布|开放|给.*调用|供.*调用)/iu.test(compact)
            || /(查询|保存|提交|办理|校验).{0,8}(接口|api).{0,12}(前端|页面|系统).{0,8}(调用|使用)/iu.test(compact)
            || /(前端|页面|系统).{0,8}(调用|使用).{0,8}(查询|保存|提交|办理|校验)?(接口|api)/iu.test(compact)
            || /(post接口|get接口).{0,8}(新增|开发|提供|暴露|发布|开放)?/iu.test(compact);
    }

    _hasExternalHttpCallIntent(normalizedPayload = {}) {
        const rawIntentSignals = this._dedupeRequirementTerms(
            Array.isArray(normalizedPayload.intentSignals) ? normalizedPayload.intentSignals : []
        );
        const signals = rawIntentSignals.length > 0
            ? rawIntentSignals
            : this._dedupeRequirementTerms([
                ...(Array.isArray(normalizedPayload.analysisTerms) ? normalizedPayload.analysisTerms : []),
                ...(Array.isArray(normalizedPayload.signalTerms) ? normalizedPayload.signalTerms : [])
            ]);
        const compact = signals.join(' ').replace(/\s+/g, '');
        if (!compact) return false;
        const callVerb = /(调用|对接|请求|获取|访问|检索|查询|拉取|调阅|下载)/iu;
        const externalTarget = /(外部|第三方|平台|电子证照|接口地址|api地址|url|http|https)/iu;
        return (callVerb.test(compact) && externalTarget.test(compact))
            || /(外部|第三方|平台|电子证照).{0,16}(接口|api|服务|地址)/iu.test(compact)
            || /(接口地址|api地址|http地址|https地址).{0,16}(调用|对接|请求|获取|访问)/iu.test(compact);
    }

    _findRequirementRuleByAlias(aliasPattern) {
        const pattern = aliasPattern instanceof RegExp ? aliasPattern : new RegExp(String(aliasPattern || ''), 'u');
        return (Array.isArray(this.skills) ? this.skills : [])
            .filter(skill => this._isRequirementIntentCandidate(skill, { includeInterfaceRules: true }))
            .filter(skill => !this._isProjectAssetRuleEntry(skill))
            .find(skill => pattern.test(String(skill && skill.name || '')) || pattern.test(String(skill && skill.id || '')));
    }

    _buildRestApiDevelopmentRequirementMatch(normalizedPayload = {}) {
        if (!this._hasRestApiDevelopmentIntent(normalizedPayload)) return null;
        const rule = this._findRequirementRuleByAlias(/REST接口开发规范/u);
        if (!rule) return null;
        const signals = this._dedupeRequirementTerms([
            ...(Array.isArray(normalizedPayload.intentSignals) ? normalizedPayload.intentSignals : []),
            ...(Array.isArray(normalizedPayload.analysisTerms) ? normalizedPayload.analysisTerms : []),
            ...(Array.isArray(normalizedPayload.signals) ? normalizedPayload.signals : [])
        ]);
        const matchedTerms = this._dedupeRequirementTerms([
            ...signals.filter(item => /rest|接口|api|开发|新增|提交|查询|保存|创建|补|写|提供|暴露/i.test(String(item || ''))),
            '接口开发'
        ]).slice(0, 8);
        return {
            name: rule.id,
            ruleAlias: rule.name,
            category: rule.category || '',
            description: rule.description || '',
            keywords: rule.intent_keywords,
            explicit_intent_keywords: rule.explicit_intent_keywords,
            path: rule.path,
            source: rule.source,
            matchLane: 'reference_rule',
            referencePolicy: 'srs_reference',
            metadata: rule.metadata || null,
            weight: 220,
            matchedKeywords: ['REST接口', '接口开发'],
            matchedTerms,
            matchSource: 'stable_feature.rest_api_development'
        };
    }

    _hasFrontendApiInteractionIntent(normalizedPayload = {}) {
        const signals = this._dedupeRequirementTerms([
            ...(Array.isArray(normalizedPayload.intentSignals) ? normalizedPayload.intentSignals : []),
            ...(Array.isArray(normalizedPayload.analysisTerms) ? normalizedPayload.analysisTerms : []),
            ...(Array.isArray(normalizedPayload.signals) ? normalizedPayload.signals : [])
        ]);
        const compact = signals.join(' ').replace(/\s+/g, '');
        if (!compact) return false;
        return /(\.html|页面|按钮|弹窗|列表|表格|前端|toolbar|点击|展示|显示|预览|下载)/iu.test(compact)
            && /(页面|按钮|弹窗|列表|表格|前端|toolbar|点击|展示|显示|\.html)/iu.test(compact);
    }

    _buildFrontendApiRequirementMatch(normalizedPayload = {}) {
        if (!this._hasFrontendApiInteractionIntent(normalizedPayload)) return null;
        const rule = this._findRequirementRuleByAlias(/前端API-开发手册|前端API/u);
        if (!rule) return null;
        const signals = this._dedupeRequirementTerms([
            ...(Array.isArray(normalizedPayload.intentSignals) ? normalizedPayload.intentSignals : []),
            ...(Array.isArray(normalizedPayload.analysisTerms) ? normalizedPayload.analysisTerms : []),
            ...(Array.isArray(normalizedPayload.signals) ? normalizedPayload.signals : [])
        ]);
        const matchedTerms = this._dedupeRequirementTerms([
            ...signals.filter(item => /(\.html|页面|按钮|弹窗|列表|表格|前端|toolbar|点击|展示|显示|预览|下载)/iu.test(String(item || ''))),
            '前端交互'
        ]).slice(0, 8);
        return {
            name: rule.id,
            ruleAlias: rule.name,
            category: rule.category || '',
            description: rule.description || '',
            keywords: rule.intent_keywords,
            explicit_intent_keywords: rule.explicit_intent_keywords,
            path: rule.path,
            source: rule.source,
            matchLane: 'reference_rule',
            referencePolicy: 'srs_reference',
            metadata: rule.metadata || null,
            weight: 230,
            matchedKeywords: ['前端API', 'MiniUI', 'epoint.execute'],
            matchedTerms,
            matchSource: 'stable_feature.frontend_interaction'
        };
    }

    _hasFilePlacementIntent(normalizedPayload = {}) {
        const signals = this._dedupeRequirementTerms([
            ...(Array.isArray(normalizedPayload.intentSignals) ? normalizedPayload.intentSignals : []),
            ...(Array.isArray(normalizedPayload.analysisTerms) ? normalizedPayload.analysisTerms : []),
            ...(Array.isArray(normalizedPayload.signals) ? normalizedPayload.signals : [])
        ]);
        const compact = signals.join(' ').replace(/\s+/g, '');
        if (!compact) return false;
        return /(\.html|新增|创建|添加|修改|页面|按钮|接口|service|entity|action|rest|数据库|表|落点|坐落|文件|目录|包路径)/iu.test(compact);
    }

    _buildFilePlacementRequirementMatch(normalizedPayload = {}) {
        if (!this._hasFilePlacementIntent(normalizedPayload)) return null;
        const rule = this._findRequirementRuleByAlias(/项目结构与命名规范/u);
        if (!rule) return null;
        const signals = this._dedupeRequirementTerms([
            ...(Array.isArray(normalizedPayload.intentSignals) ? normalizedPayload.intentSignals : []),
            ...(Array.isArray(normalizedPayload.analysisTerms) ? normalizedPayload.analysisTerms : []),
            ...(Array.isArray(normalizedPayload.signals) ? normalizedPayload.signals : [])
        ]);
        const matchedTerms = this._dedupeRequirementTerms([
            ...signals.filter(item => /(\.html|新增|创建|添加|修改|页面|接口|service|entity|action|rest|数据库|表|文件|目录|包路径)/iu.test(String(item || ''))),
            '文件坐落点'
        ]).slice(0, 8);
        return {
            name: rule.id,
            ruleAlias: rule.name,
            category: rule.category || '',
            description: rule.description || '',
            keywords: rule.intent_keywords,
            explicit_intent_keywords: rule.explicit_intent_keywords,
            path: rule.path,
            source: rule.source,
            matchLane: 'reference_rule',
            referencePolicy: 'placement_reference',
            metadata: rule.metadata || null,
            weight: 210,
            matchedKeywords: ['项目结构', '命名规范', '目录结构'],
            matchedTerms,
            matchSource: 'stable_feature.file_placement'
        };
    }

    _buildExternalHttpUtilRequirementMatch(normalizedPayload = {}) {
        if (!this._hasExternalHttpCallIntent(normalizedPayload)) return null;
        const rule = this._findRequirementRuleByAlias(/HttpUtil使用规范|HttpUtil HTTP请求工具使用规范/u);
        if (!rule) return null;
        const signals = this._dedupeRequirementTerms([
            ...(Array.isArray(normalizedPayload.intentSignals) ? normalizedPayload.intentSignals : []),
            ...(Array.isArray(normalizedPayload.analysisTerms) ? normalizedPayload.analysisTerms : []),
            ...(Array.isArray(normalizedPayload.signals) ? normalizedPayload.signals : [])
        ]);
        const matchedTerms = this._dedupeRequirementTerms([
            ...signals.filter(item => /(外部|第三方|平台|电子证照|接口地址|api地址|http|https|调用|对接|请求|获取|访问|调阅|下载)/iu.test(String(item || ''))),
            '外部接口调用'
        ]).slice(0, 8);
        return {
            name: rule.id,
            ruleAlias: rule.name,
            category: rule.category || '',
            description: rule.description || '',
            keywords: rule.intent_keywords,
            explicit_intent_keywords: rule.explicit_intent_keywords,
            path: rule.path,
            source: rule.source,
            matchLane: 'reference_rule',
            referencePolicy: 'srs_reference',
            metadata: rule.metadata || null,
            weight: 240,
            matchedKeywords: ['HttpUtil', '外部接口调用'],
            matchedTerms,
            matchSource: 'stable_feature.external_http_call'
        };
    }

    _mergeRequirementMatches(matchGroups = []) {
        const mergedByKey = new Map();

        matchGroups.flat().forEach(rawRule => {
            const rule = this._decorateRequirementMatch(rawRule);
            const key = String(rule.ruleAlias || rule.name || '').trim();
            if (!key) return;

            if (!mergedByKey.has(key)) {
                mergedByKey.set(key, rule);
                return;
            }

            const existing = mergedByKey.get(key);
            mergedByKey.set(key, {
                ...existing,
                ...rule,
                weight: Math.max(Number(existing.weight || 0), Number(rule.weight || 0)),
                matchedKeywords: [...new Set([
                    ...(Array.isArray(existing.matchedKeywords) ? existing.matchedKeywords : []),
                    ...(Array.isArray(rule.matchedKeywords) ? rule.matchedKeywords : [])
                ])],
                matchedTerms: [...new Set([
                    ...(Array.isArray(existing.matchedTerms) ? existing.matchedTerms : []),
                    ...(Array.isArray(rule.matchedTerms) ? rule.matchedTerms : [])
                ])],
                matchSource: existing.matchSource === rule.matchSource
                    ? existing.matchSource
                    : [existing.matchSource, rule.matchSource].filter(Boolean).join(',')
            });
        });

        return [...mergedByKey.values()];
    }

    _sortRequirementMatches(matches = []) {
        return [...matches].sort((a, b) =>
            Number(b.weight || 0) - Number(a.weight || 0)
            || (Array.isArray(b.matchedKeywords) ? b.matchedKeywords.length : 0) - (Array.isArray(a.matchedKeywords) ? a.matchedKeywords.length : 0)
            || this._getRuleSourcePriority(b.source) - this._getRuleSourcePriority(a.source)
            || String(a.ruleAlias || a.name || '').localeCompare(String(b.ruleAlias || b.name || ''))
        );
    }

    _extractChineseIntentFragments(text, minSize = 3, maxSize = 4) {
        const fragments = new Set();
        (String(text || '').match(/[\u4e00-\u9fff]{2,16}/g) || []).forEach(segment => {
            const upperBound = Math.min(maxSize, segment.length);
            for (let size = minSize; size <= upperBound; size += 1) {
                for (let index = 0; index + size <= segment.length; index += 1) {
                    const piece = segment.slice(index, index + size);
                    if (piece.length >= minSize && !GENERIC_CHINESE_INTENT_STOPWORDS.has(piece)) {
                        fragments.add(piece);
                    }
                }
            }
        });
        return [...fragments];
    }

    analyzeRequirementIntent(userIntent, options = {}) {
        const projectPath = typeof options === 'string'
            ? options
            : options.projectPath;
        const featureContract = this._getRequirementFeatureContract(projectPath);
        if (!featureContract.ok) {
            return {
                requirement_summary: this._extractRequirementSummary(userIntent),
                rule_coverage_aspects: [],
                info_completeness: {
                    confirmed: [],
                    gaps: [featureContract.message || 'REQUIREMENT_FEATURE_CONTRACT_MISSING']
                },
                metadata_inventory: {
                    code_items: [],
                    sys_params: [],
                    role_permissions: [],
                    ui_controls: []
                },
                entity_service_api_chain: {
                    entities: [],
                    services: [],
                    apis: [],
                    reusable_assets: []
                },
                rule_match_terms: [],
                contract_error: featureContract.message || 'REQUIREMENT_FEATURE_CONTRACT_MISSING'
            };
        }
        const summary = this._extractRequirementSummary(userIntent);
        const aspectEntries = [];
        for (const definition of featureContract.stableFeatures) {
            const strongHits = this._collectIntentSignalHits(userIntent, definition.strongSignals);
            const weakHits = this._collectIntentSignalHits(userIntent, definition.weakSignals);
            if (strongHits.length === 0 && weakHits.length < Number(definition.minWeakHits || 1)) continue;
            const entry = this._buildRequirementAspectEntry(definition, strongHits, weakHits);
            if (entry) {
                aspectEntries.push(entry);
            }
        }

        const metadataInventory = this._buildRequirementMetadataInventory(aspectEntries, userIntent, featureContract);
        const entityServiceApiChain = this._buildRequirementEntityServiceApiChain(userIntent, featureContract);
        const infoGaps = [];
        if (String(userIntent || '').trim().length < 20) {
            infoGaps.push('需求描述较短，建议补充业务范围、关键字段和页面/接口落点');
        }

        const confirmed = [];
        if (aspectEntries.length > 0) confirmed.push(`已识别 ${aspectEntries.length} 项规则覆盖方面`);
        if (metadataInventory.code_items.length > 0) confirmed.push('已识别代码项/选项来源盘点点');
        if (metadataInventory.sys_params.length > 0) confirmed.push('已识别系统参数/动态配置盘点点');
        if (metadataInventory.role_permissions.length > 0) confirmed.push('已识别角色权限盘点点');
        if (entityServiceApiChain.reusable_assets.length > 0) confirmed.push('已识别现成接口/项目资产复用线索');

        const ruleMatchTerms = this._dedupeRequirementTerms([
            ...aspectEntries.flatMap(item => item.match_terms || []),
            ...metadataInventory.code_items,
            ...metadataInventory.sys_params,
            ...metadataInventory.role_permissions,
            ...metadataInventory.ui_controls,
            ...entityServiceApiChain.entities,
            ...entityServiceApiChain.services,
            ...entityServiceApiChain.apis,
            ...entityServiceApiChain.reusable_assets,
            ...this._extractChineseIntentFragments(userIntent, 3, 5)
        ]);

        return {
            requirement_summary: summary,
            rule_coverage_aspects: aspectEntries,
            info_completeness: {
                confirmed,
                gaps: infoGaps
            },
            metadata_inventory: metadataInventory,
            entity_service_api_chain: entityServiceApiChain,
            rule_match_terms: ruleMatchTerms
        };
    }

    _extractRequirementRuleMatchTerms(analysis = {}) {
        const normalized = analysis && typeof analysis === 'object' ? analysis : {};
        const ruleMatchTerms = Array.isArray(normalized.rule_match_terms)
            ? normalized.rule_match_terms
            : (Array.isArray(normalized.ruleMatchTerms) ? normalized.ruleMatchTerms : []);
        const aspectTerms = (Array.isArray(normalized.rule_coverage_aspects) ? normalized.rule_coverage_aspects : [])
            .flatMap(item => Array.isArray(item && item.match_terms) ? item.match_terms : []);
        const metadataTerms = this._collectMetadataBucketTerms(normalized.metadata_inventory);
        const entityChainTerms = this._collectEntityChainTerms(normalized.entity_service_api_chain);
        return this._dedupeRequirementTerms([
            ...ruleMatchTerms,
            ...aspectTerms,
            ...metadataTerms,
            ...entityChainTerms
        ]);
    }

    _mergeRequirementAspectEntries(primary = [], supplement = []) {
        const merged = [];
        const indexByKey = new Map();
        const pushEntry = rawEntry => {
            const entry = rawEntry && typeof rawEntry === 'object' ? rawEntry : null;
            if (!entry) return;
            const aspectKey = String(entry.aspect_key || entry.aspectKey || entry.aspect_name || entry.aspectName || '').trim();
            if (!aspectKey) return;
            const normalizedEntry = {
                aspect: String(entry.aspect || entry.aspect_name || entry.aspectName || aspectKey).trim(),
                aspect_key: aspectKey,
                reason: String(entry.reason || '').trim(),
                match_terms: this._dedupeRequirementTerms(Array.isArray(entry.match_terms) ? entry.match_terms : entry.matchTerms)
            };
            if (!indexByKey.has(aspectKey)) {
                indexByKey.set(aspectKey, merged.length);
                merged.push(normalizedEntry);
                return;
            }
            const index = indexByKey.get(aspectKey);
            const existing = merged[index];
            merged[index] = {
                ...existing,
                aspect: existing.aspect || normalizedEntry.aspect,
                reason: this._dedupeRequirementTerms([existing.reason, normalizedEntry.reason]).join('；'),
                match_terms: this._dedupeRequirementTerms([
                    ...(Array.isArray(existing.match_terms) ? existing.match_terms : []),
                    ...(Array.isArray(normalizedEntry.match_terms) ? normalizedEntry.match_terms : [])
                ])
            };
        };
        (Array.isArray(primary) ? primary : []).forEach(pushEntry);
        (Array.isArray(supplement) ? supplement : []).forEach(pushEntry);
        return merged;
    }

    _mergeRequirementAnalysisPayloads(primary = {}, supplement = {}) {
        const base = primary && typeof primary === 'object' ? primary : {};
        const extra = supplement && typeof supplement === 'object' ? supplement : {};
        return {
            requirement_summary: base.requirement_summary || extra.requirement_summary || '',
            rule_coverage_aspects: this._mergeRequirementAspectEntries(base.rule_coverage_aspects, extra.rule_coverage_aspects),
            info_completeness: {
                confirmed: this._dedupeRequirementTerms([
                    ...(base.info_completeness && Array.isArray(base.info_completeness.confirmed) ? base.info_completeness.confirmed : []),
                    ...(extra.info_completeness && Array.isArray(extra.info_completeness.confirmed) ? extra.info_completeness.confirmed : [])
                ]),
                gaps: this._dedupeRequirementTerms([
                    ...(base.info_completeness && Array.isArray(base.info_completeness.gaps) ? base.info_completeness.gaps : []),
                    ...(extra.info_completeness && Array.isArray(extra.info_completeness.gaps) ? extra.info_completeness.gaps : [])
                ])
            },
            metadata_inventory: {
                code_items: this._dedupeRequirementTerms([
                    ...(base.metadata_inventory && Array.isArray(base.metadata_inventory.code_items) ? base.metadata_inventory.code_items : []),
                    ...(extra.metadata_inventory && Array.isArray(extra.metadata_inventory.code_items) ? extra.metadata_inventory.code_items : [])
                ]),
                sys_params: this._dedupeRequirementTerms([
                    ...(base.metadata_inventory && Array.isArray(base.metadata_inventory.sys_params) ? base.metadata_inventory.sys_params : []),
                    ...(extra.metadata_inventory && Array.isArray(extra.metadata_inventory.sys_params) ? extra.metadata_inventory.sys_params : [])
                ]),
                role_permissions: this._dedupeRequirementTerms([
                    ...(base.metadata_inventory && Array.isArray(base.metadata_inventory.role_permissions) ? base.metadata_inventory.role_permissions : []),
                    ...(extra.metadata_inventory && Array.isArray(extra.metadata_inventory.role_permissions) ? extra.metadata_inventory.role_permissions : [])
                ]),
                ui_controls: this._dedupeRequirementTerms([
                    ...(base.metadata_inventory && Array.isArray(base.metadata_inventory.ui_controls) ? base.metadata_inventory.ui_controls : []),
                    ...(extra.metadata_inventory && Array.isArray(extra.metadata_inventory.ui_controls) ? extra.metadata_inventory.ui_controls : [])
                ])
            },
            entity_service_api_chain: {
                entities: this._dedupeRequirementTerms([
                    ...(base.entity_service_api_chain && Array.isArray(base.entity_service_api_chain.entities) ? base.entity_service_api_chain.entities : []),
                    ...(extra.entity_service_api_chain && Array.isArray(extra.entity_service_api_chain.entities) ? extra.entity_service_api_chain.entities : [])
                ]),
                services: this._dedupeRequirementTerms([
                    ...(base.entity_service_api_chain && Array.isArray(base.entity_service_api_chain.services) ? base.entity_service_api_chain.services : []),
                    ...(extra.entity_service_api_chain && Array.isArray(extra.entity_service_api_chain.services) ? extra.entity_service_api_chain.services : [])
                ]),
                apis: this._dedupeRequirementTerms([
                    ...(base.entity_service_api_chain && Array.isArray(base.entity_service_api_chain.apis) ? base.entity_service_api_chain.apis : []),
                    ...(extra.entity_service_api_chain && Array.isArray(extra.entity_service_api_chain.apis) ? extra.entity_service_api_chain.apis : [])
                ]),
                reusable_assets: this._dedupeRequirementTerms([
                    ...(base.entity_service_api_chain && Array.isArray(base.entity_service_api_chain.reusable_assets) ? base.entity_service_api_chain.reusable_assets : []),
                    ...(extra.entity_service_api_chain && Array.isArray(extra.entity_service_api_chain.reusable_assets) ? extra.entity_service_api_chain.reusable_assets : [])
                ])
            },
            rule_match_terms: this._dedupeRequirementTerms([
                ...(Array.isArray(base.rule_match_terms) ? base.rule_match_terms : []),
                ...(Array.isArray(extra.rule_match_terms) ? extra.rule_match_terms : [])
            ])
        };
    }

    buildRequirementAnalysisForRuleMatching(analysis = {}, userIntent = '', options = {}) {
        const normalizedAnalysis = analysis && typeof analysis === 'object' ? analysis : {};
        const rawIntent = String(userIntent || options.currentNeed || '').trim();
        if (!rawIntent) return normalizedAnalysis;
        const syntheticAnalysis = this.analyzeRequirementIntent(rawIntent, options);
        return this._mergeRequirementAnalysisPayloads(normalizedAnalysis, syntheticAnalysis);
    }

    _collectMetadataBucketTerms(inventory) {
        if (!inventory || typeof inventory !== 'object') return [];
        return [
            ...(Array.isArray(inventory.code_items) ? inventory.code_items : []),
            ...(Array.isArray(inventory.sys_params) ? inventory.sys_params : []),
            ...(Array.isArray(inventory.role_permissions) ? inventory.role_permissions : []),
            ...(Array.isArray(inventory.ui_controls) ? inventory.ui_controls : [])
        ];
    }

    _collectEntityChainTerms(chain) {
        if (!chain || typeof chain !== 'object') return [];
        return [
            ...(Array.isArray(chain.entities) ? chain.entities : []),
            ...(Array.isArray(chain.services) ? chain.services : []),
            ...(Array.isArray(chain.apis) ? chain.apis : []),
            ...(Array.isArray(chain.reusable_assets) ? chain.reusable_assets : [])
        ];
    }

    _scoreSkillAgainstTerms(matchTerms = [], skill = {}) {
        const explicitKeywords = this._getExplicitRequirementKeywords(skill);
        const searchableKeywords = explicitKeywords.length > 0
            ? explicitKeywords
            : this._collectRuleRequirementKeywords(skill);
        if (searchableKeywords.length === 0) {
            return { weight: 0, matchedKeywords: [], matchedTerms: [] };
        }

        const matchedTerms = [];
        const matchedKeywords = new Set();
        for (const term of this._dedupeRequirementTerms(matchTerms)) {
            if (this._isLowSignalRequirementTerm(term)) continue;
            const localMatches = searchableKeywords.filter(keyword => this._isKeywordTargetMatch(keyword, term));
            if (localMatches.length === 0) continue;
            matchedTerms.push(term);
            localMatches.forEach(keyword => matchedKeywords.add(keyword));
        }

        const weight = matchedTerms.length * 20
            + matchedKeywords.size * 4
            + (explicitKeywords.length > 0 ? matchedKeywords.size * 2 : 0);
        return {
            weight,
            matchedKeywords: [...matchedKeywords],
            matchedTerms
        };
    }

    _scoreExplicitSignalSkillAgainstIntent(userIntent = '', skill = {}) {
        const signal = this._explicitRequirementRuleSignal(skill);
        if (!signal) {
            return { weight: 0, matchedKeywords: [], matchedTerms: [] };
        }
        const intentScore = this._scoreSkillAgainstIntent(userIntent, skill, { explicitOnly: true });
        if (intentScore.weight <= 0 || !Array.isArray(intentScore.matchedKeywords) || intentScore.matchedKeywords.length === 0) {
            return { weight: 0, matchedKeywords: [], matchedTerms: [] };
        }
        const matchedTerms = this._dedupeRequirementTerms([
            userIntent,
            ...intentScore.matchedKeywords
        ]).filter(Boolean).slice(0, 6);
        return {
            weight: Number(intentScore.weight || 0) + 180,
            matchedKeywords: intentScore.matchedKeywords,
            matchedTerms
        };
    }

    _createRequirementSignalMatch(skill = {}, score = {}, matchSource = 'intent_signals') {
        const decoratedSkill = this._decorateRequirementMatch(skill);
        return {
            name: decoratedSkill.id,
            ruleAlias: decoratedSkill.name,
            category: decoratedSkill.category || '',
            description: decoratedSkill.description || '',
            keywords: decoratedSkill.intent_keywords,
            explicit_intent_keywords: decoratedSkill.explicit_intent_keywords,
            path: decoratedSkill.path,
            source: decoratedSkill.source,
            matchLane: decoratedSkill.matchLane || '',
            referencePolicy: decoratedSkill.referencePolicy || '',
            metadata: decoratedSkill.metadata || null,
            ...(decoratedSkill.requirementSignal ? { requirementSignal: decoratedSkill.requirementSignal } : {}),
            ...(decoratedSkill.requirementSignalId ? { requirementSignalId: decoratedSkill.requirementSignalId } : {}),
            ...(decoratedSkill.r2cSignal ? { r2cSignal: decoratedSkill.r2cSignal } : {}),
            ...(decoratedSkill.signal ? { signal: decoratedSkill.signal } : {}),
            ...(Array.isArray(decoratedSkill.questionHints) && decoratedSkill.questionHints.length > 0 ? { questionHints: decoratedSkill.questionHints } : {}),
            ...(Array.isArray(decoratedSkill.requiredInputs) && decoratedSkill.requiredInputs.length > 0 ? { requiredInputs: decoratedSkill.requiredInputs } : {}),
            ...(decoratedSkill.owner ? { owner: decoratedSkill.owner } : {}),
            ...(decoratedSkill.ownerType ? { ownerType: decoratedSkill.ownerType } : {}),
            ...(decoratedSkill.resolutionOwner ? { resolutionOwner: decoratedSkill.resolutionOwner } : {}),
            ...(decoratedSkill.decisionOwner ? { decisionOwner: decoratedSkill.decisionOwner } : {}),
            ...(decoratedSkill.decisionEntry ? { decisionEntry: decoratedSkill.decisionEntry } : {}),
            ...(decoratedSkill.decisionEntryPoint ? { decisionEntryPoint: decoratedSkill.decisionEntryPoint } : {}),
            ...(decoratedSkill.userDecisionEntry ? { userDecisionEntry: decoratedSkill.userDecisionEntry } : {}),
            ...(decoratedSkill.questionEntry ? { questionEntry: decoratedSkill.questionEntry } : {}),
            ...(decoratedSkill.mustConfirm === true ? { mustConfirm: true } : {}),
            ...(decoratedSkill.requiresUserDecision === true ? { requiresUserDecision: true } : {}),
            ...(decoratedSkill.requiresUserConfirmation === true ? { requiresUserConfirmation: true } : {}),
            weight: Number(score.weight || 0),
            matchedKeywords: Array.isArray(score.matchedKeywords) ? score.matchedKeywords : [],
            matchedTerms: Array.isArray(score.matchedTerms) ? score.matchedTerms : [],
            matchSource
        };
    }

    _scoreSkillAgainstIntent(userIntent, skill, options = {}) {
        const lowerIntent = String(userIntent || '').toLowerCase();
        const cleanIntent = lowerIntent.replace(/[吧呢啊吗的了]/g, '');
        const normalizedIntent = this._normalizeIntentText(userIntent);
        const chineseIntentFragments = /[\u4e00-\u9fff]/.test(cleanIntent)
            ? this._extractChineseIntentFragments(cleanIntent)
            : [];
        const keywords = options.explicitOnly
            ? (Array.isArray(skill.explicit_intent_keywords) ? skill.explicit_intent_keywords : [])
            : (Array.isArray(skill.intent_keywords) ? skill.intent_keywords : []);
        let weight = 0;
        const matchedKeywords = [];

        for (const keyword of keywords) {
            const kw = String(keyword || '').toLowerCase();
            if (!kw) continue;
            const keywordVariants = this._buildKeywordVariants(keyword);

            if (cleanIntent === kw || normalizedIntent === kw) {
                weight += 15;
                matchedKeywords.push(keyword);
            }
            else if (keywordVariants.some(variant => cleanIntent.includes(variant) || normalizedIntent.includes(variant))) {
                let occurrences = 1;
                if (cleanIntent.length > 100) {
                    try {
                        const regex = new RegExp(kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g');
                        const matches = cleanIntent.match(regex);
                        occurrences = matches ? matches.length : 1;
                    } catch (_) {
                        occurrences = 1;
                    }
                }
                const frequencyFactor = 1 + Math.log2(occurrences);
                const baseWeight = Math.max(3, kw.length * 1.5);
                weight += baseWeight * frequencyFactor;
                matchedKeywords.push(keyword);
            }
            else if (
                cleanIntent.length >= 2
                && keywordVariants.some(variant => variant.includes(cleanIntent) || (normalizedIntent && variant.includes(normalizedIntent)))
            ) {
                weight += Math.max(2, Math.max(cleanIntent.length, normalizedIntent.length));
                matchedKeywords.push(keyword);
            }
            else if (
                kw.length >= 4
                && chineseIntentFragments.length > 0
                && keywordVariants.some(variant => /[\u4e00-\u9fff]/.test(variant))
                && chineseIntentFragments.some(fragment => keywordVariants.some(variant => variant.includes(fragment)))
            ) {
                weight += Math.max(4, Math.min(10, kw.length));
                matchedKeywords.push(keyword);
            }
            else if (kw.length >= 6 && cleanIntent.length >= 6 && cleanIntent.length < 50) {
                const strictPrefixLength = 6;
                const cleanPrefix = cleanIntent.slice(0, strictPrefixLength);
                const normalizedPrefix = normalizedIntent.slice(0, strictPrefixLength);
                if (keywordVariants.some(variant =>
                    variant.length >= strictPrefixLength
                    && (
                        variant.slice(0, strictPrefixLength) === cleanPrefix
                        || (normalizedPrefix && variant.slice(0, strictPrefixLength) === normalizedPrefix)
                    )
                )) {
                    weight += 1;
                }
            }
        }

        if (!options.explicitOnly && skill.name && cleanIntent.includes(String(skill.name).toLowerCase())) {
            weight += 5;
        }

        return { weight, matchedKeywords };
    }

    _sortIntentMatchedSkills(matches = []) {
        return [...matches].sort((a, b) =>
            Number(b.weight || 0) - Number(a.weight || 0)
            || (Array.isArray(b.matchedKeywords) ? b.matchedKeywords.length : 0) - (Array.isArray(a.matchedKeywords) ? a.matchedKeywords.length : 0)
            || this._getRuleSourcePriority(b.source) - this._getRuleSourcePriority(a.source)
            || String(a.name || a.id || '').localeCompare(String(b.name || b.id || ''))
        );
    }

    _rankSkillsByIntent(userIntent, options = {}) {
        const projectPath = typeof options === 'string'
            ? options
            : options.projectPath;
        this._ensureSkillsLoaded(projectPath);

        const scope = options.scope || '';
        const explicitOnly = options.explicitOnly === true;
        const minWeight = typeof options.minWeight === 'number' ? options.minWeight : 1;
        const minMatchedKeywords = typeof options.minMatchedKeywords === 'number' ? options.minMatchedKeywords : 1;
        const matchedSkills = [];

        for (const skill of this.skills) {
            if (scope === 'requirement' && !this._isRequirementIntentCandidate(skill, options)) {
                continue;
            }

            const { weight, matchedKeywords } = this._scoreSkillAgainstIntent(userIntent, skill, { explicitOnly });
            if (weight < minWeight) continue;
            if (matchedKeywords.length < minMatchedKeywords) continue;

            matchedSkills.push({
                ...skill,
                weight,
                matchedKeywords
            });
        }

        return this._sortIntentMatchedSkills(matchedSkills);
    }

    _buildIntentMatchDiagnostics(matches = [], options = {}) {
        const limit = Number.isInteger(options.limit) ? options.limit : 5;
        return {
            scoringEngine: 'rank_skills_by_intent_v1',
            matchCount: Array.isArray(matches) ? matches.length : 0,
            topMatches: (Array.isArray(matches) ? matches : []).slice(0, limit).map(skill => ({
                skillId: skill.id || '',
                ruleAlias: skill.name || '',
                weight: Number(skill.weight || 0),
                matchedKeywords: Array.isArray(skill.matchedKeywords) ? skill.matchedKeywords.slice(0, 6) : [],
                source: skill.source || '',
                category: skill.category || '',
                matchLane: skill.matchLane || ''
            }))
        };
    }

    _buildRequirementSignalDiagnostics(matches = [], normalizedPayload = {}, options = {}) {
        const limit = Number.isInteger(options.limit) ? options.limit : 6;
        return {
            scoringEngine: 'score_skill_against_terms_v1',
            stage: String(normalizedPayload.stage || 'requirement').trim() || 'requirement',
            featureKeys: Array.isArray(normalizedPayload.featureKeys) ? normalizedPayload.featureKeys : [],
            analysisTerms: Array.isArray(normalizedPayload.analysisTerms) ? normalizedPayload.analysisTerms : [],
            intentSignals: Array.isArray(normalizedPayload.intentSignals) ? normalizedPayload.intentSignals : [],
            signalTerms: Array.isArray(normalizedPayload.signals) ? normalizedPayload.signals : [],
            matchCount: Array.isArray(matches) ? matches.length : 0,
            topMatches: (Array.isArray(matches) ? matches : []).slice(0, limit).map(rule => ({
                ruleAlias: rule.ruleAlias || rule.name || '',
                weight: Number(rule.weight || 0),
                matchLane: rule.matchLane || '',
                matchedKeywords: Array.isArray(rule.matchedKeywords) ? rule.matchedKeywords.slice(0, 6) : [],
                matchedTerms: Array.isArray(rule.matchedTerms) ? rule.matchedTerms.slice(0, 6) : [],
                source: rule.source || '',
                category: rule.category || ''
            }))
        };
    }

    _isComponentDialogLayoutRule(skill = {}) {
        const category = String(skill && skill.category || '').trim();
        const idPath = String(skill && skill.id || '').replace(/\\/g, '/');
        const fullPath = String(skill && skill.path || '').replace(/\\/g, '/');
        return category === '组件化弹窗与布局'
            || /(?:^|\/)组件化弹窗与布局(?:\/|$)/.test(idPath)
            || /(?:^|\/)组件化弹窗与布局(?:\/|$)/.test(fullPath);
    }

    _isRequirementIntentCandidate(skill, options = {}) {
        const name = String(skill && skill.name || '').trim();
        const category = String(skill && skill.category || '').trim();
        const idPath = String(skill && skill.id || '').replace(/\\/g, '/');
        const fullPath = String(skill && skill.path || '').replace(/\\/g, '/');
        const visibility = skill && skill.pipelineVisibility && typeof skill.pipelineVisibility === 'object'
            ? skill.pipelineVisibility
            : {};
        const requirementVisible = visibility.requirement === true || String(visibility.requirement || '').toLowerCase() === 'true';
        const requirementHidden = visibility.requirement === false || String(visibility.requirement || '').toLowerCase() === 'false';

        if (requirementHidden) return false;
        if (requirementVisible) return !(options.includeInterfaceRules === false && /接口使用规范$/.test(name));
        if (!requirementVisible
            && !this._isComponentDialogLayoutRule(skill)
            && (/组件/.test(category) || /^components(?:$|[-_])/i.test(name) || /(^|\/)components(?:[-_/]|$)/i.test(idPath) || /(^|\/)components(?:[-_/]|$)/i.test(fullPath))) return false;
        if (/\.(json|jsonl|log|txt)$/i.test(fullPath)) return false;
        if (/\/docs\/项目需求\//.test(fullPath)) return false;
        if (options.includeInterfaceRules === false && /接口使用规范$/.test(name)) return false;
        return true;
    }

    matchRulesByIntentKeywords(userIntent, options = {}) {
        // Legacy retrieval helper: keep it aligned with the unified scoring core,
        // but do not let it evolve into another independent semantic decision path.
        const explicitOnly = options.explicitOnly === true;
        const maxResults = Number.isInteger(options.maxResults) ? options.maxResults : 6;
        return this._rankSkillsByIntent(userIntent, options)
            .slice(0, maxResults)
            .map(skill => ({
                name: skill.id,
                ruleAlias: skill.name,
                category: skill.category || '',
                description: skill.description || '',
                keywords: explicitOnly ? skill.explicit_intent_keywords : skill.intent_keywords,
                path: skill.path,
                source: skill.source,
                weight: skill.weight,
                matchedKeywords: skill.matchedKeywords
            }));
    }

    resolveRequirementRulesBySignals(intentPayload = {}, options = {}) {
        const projectPath = typeof options === 'string'
            ? options
            : options.projectPath;
        this._ensureSkillsLoaded(projectPath);
        const featureContract = this._getRequirementFeatureContract(projectPath);
        const normalizedPayload = this._normalizeRequirementIntentSignalPayload(intentPayload, featureContract);
        const maxReferenceResults = Number.isInteger(options.maxReferenceResults) ? options.maxReferenceResults : 6;
        const maxProjectAssetResults = Number.isInteger(options.maxProjectAssetResults) ? options.maxProjectAssetResults : 4;
        const allMatches = [];

        for (const skill of this.skills) {
            if (!this._isRequirementIntentCandidate(skill, { includeInterfaceRules: true })) {
                continue;
            }

            const score = this._scoreSkillAgainstTerms(normalizedPayload.signals, skill);
            if (score.weight > 0 && score.matchedKeywords.length > 0) {
                allMatches.push(this._createRequirementSignalMatch(skill, score));
                continue;
            }

            const explicitSignalScore = this._scoreExplicitSignalSkillAgainstIntent(
                String(options.userIntent || options.requirementText || options.requirement || '').trim(),
                skill
            );
            if (explicitSignalScore.weight > 0 && explicitSignalScore.matchedKeywords.length > 0) {
                allMatches.push(this._createRequirementSignalMatch(skill, explicitSignalScore, 'explicit_rule_signal.intent_keyword'));
            }
        }

        const ranked = this._sortRequirementMatches(this._mergeRequirementMatches([
            allMatches,
            this._buildStableFeatureRequirementMatches(normalizedPayload.featureKeys, featureContract),
            [this._buildFrontendApiRequirementMatch(normalizedPayload)].filter(Boolean),
            [this._buildExternalHttpUtilRequirementMatch(normalizedPayload)].filter(Boolean),
            [this._buildRestApiDevelopmentRequirementMatch(normalizedPayload)].filter(Boolean),
            [this._buildFilePlacementRequirementMatch(normalizedPayload)].filter(Boolean)
        ]));
        const referenceRules = ranked
            .filter(rule => rule.matchLane === 'reference_rule')
            .filter(rule => this._hasHighConfidenceRequirementMatch(rule))
            .slice(0, maxReferenceResults);
        const projectAssetRules = ranked
            .filter(rule => rule.matchLane === 'project_api_asset')
            .filter(rule => this._hasHighConfidenceRequirementMatch(rule))
            .slice(0, maxProjectAssetResults);
        const result = [...referenceRules, ...projectAssetRules];
        result.diagnostics = this._buildRequirementSignalDiagnostics(ranked, normalizedPayload, options);
        return result;
    }

    _collectRequirementSignalCatalog(userIntent = '') {
        const text = String(userIntent || '');
        const compact = text.replace(/\s+/g, '');
        return REQUIREMENT_SIGNAL_DEFINITIONS
            .filter(def => def.requirementPattern && def.requirementPattern.test(compact))
            .map(def => this._signalCatalogEntry(def));
    }

    collectRequirementSignalCatalog(userIntent = '') {
        return this._collectRequirementSignalCatalog(userIntent);
    }

    _signalCatalogEntry(definition = {}) {
        return {
            signal: definition.signal,
            userAnchor: definition.userAnchor,
            usageDuty: definition.usageDuty,
            source: 'requirement_pattern'
        };
    }

    _explicitRequirementRuleSignal(rule = {}) {
        return String(rule && (
            rule.requirementSignal ||
            rule.requirementSignalId ||
            rule.r2cSignal ||
            rule.signal
        ) || '').trim();
    }

    _inferRequirementRuleSignal(rule = {}) {
        const explicitSignal = this._explicitRequirementRuleSignal(rule);
        if (explicitSignal) return explicitSignal;
        const alias = String(rule && (rule.ruleAlias || rule.name) || '');
        const category = String(rule && rule.category || '');
        const ruleIdentity = [
            alias,
            category,
            ...(Array.isArray(rule && rule.matchedKeywords) ? rule.matchedKeywords : [])
        ].join(' ');
        const matched = REQUIREMENT_SIGNAL_DEFINITIONS.find(def => def.rulePattern && def.rulePattern.test(ruleIdentity));
        if (matched) return matched.signal;
        return 'requirement_rule';
    }

    _ruleCoversRequirementSignal(rule = {}, signal = '') {
        const targetSignal = String(signal || '').trim();
        const inferred = this._inferRequirementRuleSignal(rule);
        if (!targetSignal) return false;
        if (inferred === targetSignal) return true;
        const targetDefinition = REQUIREMENT_SIGNAL_DEFINITION_BY_ID.get(targetSignal) || {};
        if ((Array.isArray(targetDefinition.coveredBySignals) ? targetDefinition.coveredBySignals : []).includes(inferred)) {
            return true;
        }
        const inferredDefinition = REQUIREMENT_SIGNAL_DEFINITION_BY_ID.get(inferred) || {};
        return (Array.isArray(inferredDefinition.coversSignals) ? inferredDefinition.coversSignals : []).includes(targetSignal);
    }

    _inferRequirementRuleUsageDuty(rule = {}) {
        const signal = this._inferRequirementRuleSignal(rule);
        const definition = REQUIREMENT_SIGNAL_DEFINITION_BY_ID.get(signal);
        if (definition && definition.ruleUsageDuty) return definition.ruleUsageDuty;
        return '作为当前需求的规则上下文，施工单需说明适用 Todo 和读取范围。';
    }

    _readJsonFileSafe(filePath = '') {
        const target = String(filePath || '').trim();
        if (!target || !fs.existsSync(target)) return null;
        try {
            return JSON.parse(fs.readFileSync(target, 'utf-8') || '{}');
        } catch (_) {
            return null;
        }
    }

    _buildProjectTableRecallTerms(userIntent = '') {
        const text = String(userIntent || '').trim();
        if (!text) return [];
        const weakFragmentPattern = /(业务|管理|查询|信息|办理|项目)/u;
        const terms = new Set();
        const push = (value, source = 'explicit') => {
            const clean = this._sanitizeRequirementTerm(value);
            if (!clean) return;
            const normalized = clean.replace(/\s+/g, '');
            if (!normalized) return;
            if (source === 'generated_chinese_fragment'
                && normalized.length <= 3
                && weakFragmentPattern.test(normalized)) return;
            if (this._isLowSignalRequirementTerm(normalized)) return;
            terms.add(normalized);
        };

        push(text);
        const chunks = text.match(/[\u4e00-\u9fff]+|[A-Za-z][A-Za-z0-9_]+|\d+/g) || [];
        chunks.forEach(chunk => {
            const value = String(chunk || '').trim();
            if (!value) return;
            push(value);
            if (/^[\u4e00-\u9fff]+$/.test(value)) {
                const maxLen = Math.min(8, value.length);
                for (let len = maxLen; len >= 2; len -= 1) {
                    for (let index = 0; index <= value.length - len; index += 1) {
                        push(value.slice(index, index + len), 'generated_chinese_fragment');
                    }
                }
            } else {
                value.split(/[_\s-]+/g).forEach(part => {
                    if (String(part || '').trim().length >= 3) push(part);
                });
            }
        });

        return [...terms].sort((a, b) => b.length - a.length || a.localeCompare(b, 'zh-Hans-CN'));
    }

    _buildBusinessBlocksByEntity(businessGraphIndex = {}) {
        const blocks = Array.isArray(businessGraphIndex && businessGraphIndex.businessBlocks)
            ? businessGraphIndex.businessBlocks
            : [];
        const byEntity = new Map();
        blocks.forEach(block => {
            const entities = Array.isArray(block && block.primaryEntities) ? block.primaryEntities : [];
            entities.forEach(entityName => {
                const key = String(entityName || '').trim();
                if (!key) return;
                if (!byEntity.has(key)) byEntity.set(key, []);
                byEntity.get(key).push({
                    businessKey: String(block.businessKey || '').trim(),
                    summary: String(block.summary || '').trim(),
                    confidence: Number(block.confidence || 0),
                    primaryActions: Array.isArray(block.primaryActions) ? block.primaryActions.slice(0, 6) : []
                });
            });
        });
        return byEntity;
    }

    _scoreProjectTableNode(node = {}, recallTerms = []) {
        const keywords = Array.isArray(node && node.keywords) ? node.keywords : [];
        const searchableValues = [
            node.tableDisplayName,
            node.tableName,
            node.entityName,
            node.role,
            ...keywords
        ].map(item => String(item || '').trim()).filter(Boolean);
        const searchableText = searchableValues.join(' ').toLowerCase();
        const compactText = searchableValues.join('').toLowerCase().replace(/[\s_./\\-]+/g, '');
        const matchedTerms = [];
        let score = 0;

        recallTerms.forEach(term => {
            const clean = String(term || '').trim();
            if (!clean) return;
            const lower = clean.toLowerCase();
            const compact = lower.replace(/[\s_./\\-]+/g, '');
            const hit = searchableText.includes(lower) || (compact && compactText.includes(compact));
            if (!hit) return;
            matchedTerms.push(clean);
            const isChinese = /[\u4e00-\u9fff]/.test(clean);
            const exactKeyword = keywords.some(keyword => String(keyword || '').trim().toLowerCase() === lower);
            const exactDisplay = String(node.tableDisplayName || '').trim().toLowerCase() === lower;
            const exactTable = String(node.tableName || '').trim().toLowerCase() === lower;
            const exactEntity = String(node.entityName || '').trim().toLowerCase() === lower;
            score += clean.length * (isChinese ? 4 : 2);
            if (exactKeyword) score += 12;
            if (exactDisplay) score += 20;
            if (exactTable || exactEntity) score += 16;
        });

        return {
            score,
            matchedTerms: this._dedupeRequirementTerms(matchedTerms).slice(0, 8)
        };
    }

    _collectProjectTableCandidates(userIntent = '', options = {}) {
        const projectPath = typeof options === 'string'
            ? options
            : options.projectPath;
        const root = String(projectPath || '').trim();
        if (!root) return [];
        const explicitTableNames = new Set(
            Array.isArray(options && options.userSupplementTableNames)
                ? options.userSupplementTableNames
                    .map(value => String(value || '').trim().toLowerCase())
                    .filter(Boolean)
                : []
        );
        const maxResults = Number.isInteger(options.maxProjectTableCandidates)
            ? options.maxProjectTableCandidates
            : 8;
        const structureDir = PipelineUtils.getProjectStructureDir(root);
        const entityIndexPath = path.join(structureDir, 'entity-graph.index.json');
        const businessIndexPath = path.join(structureDir, 'business-graph.index.json');
        const entityIndex = this._readJsonFileSafe(entityIndexPath);
        if (!entityIndex || !Array.isArray(entityIndex.nodes)) return [];

        const recallTerms = this._buildProjectTableRecallTerms(userIntent);
        if (recallTerms.length === 0 && explicitTableNames.size === 0) return [];
        const businessBlocksByEntity = this._buildBusinessBlocksByEntity(this._readJsonFileSafe(businessIndexPath) || {});
        const byKey = new Map();

        entityIndex.nodes.forEach(node => {
            if (!node || typeof node !== 'object') return;
            const tableName = String(node.tableName || '').trim();
            const entityName = String(node.entityName || '').trim();
            const key = `${tableName.toLowerCase()}|${entityName.toLowerCase()}`;
            if (!tableName && !entityName) return;
            const scored = this._scoreProjectTableNode(node, recallTerms);
            const explicitName = [tableName, entityName]
                .find(value => explicitTableNames.has(value.toLowerCase())) || '';
            const explicitMatch = !!explicitName;
            if (!explicitMatch && (scored.score <= 0 || scored.matchedTerms.length === 0)) return;
            const matchedTerms = scored.matchedTerms.slice();
            if (explicitMatch && !matchedTerms.some(term => String(term || '').trim().toLowerCase() === explicitName.toLowerCase())) {
                matchedTerms.unshift(explicitName);
            }
            const businessBlocks = businessBlocksByEntity.get(entityName) || [];
            const candidate = {
                tableName,
                entityName,
                tableDisplayName: String(node.tableDisplayName || '').trim(),
                role: String(node.role || '').trim(),
                matchedTerms,
                score: scored.score,
                source: 'scan_entity_graph_index',
                authorityMode: 'scan_context_candidate',
                sourcePath: entityIndexPath,
                ...(explicitMatch ? { matchReason: `用户明确指定表名「${explicitName}」命中扫描实体图` } : {}),
                ...(businessBlocks.length > 0 ? {
                    businessContexts: businessBlocks
                        .sort((a, b) => Number(b.confidence || 0) - Number(a.confidence || 0))
                        .slice(0, 3)
                } : {})
            };
            const existing = byKey.get(key);
            if (!existing || Number(candidate.score || 0) > Number(existing.score || 0)) {
                byKey.set(key, candidate);
            }
        });

        const sortCandidates = (a, b) =>
            Number(b.score || 0) - Number(a.score || 0)
            || (Array.isArray(b.matchedTerms) ? b.matchedTerms.length : 0) - (Array.isArray(a.matchedTerms) ? a.matchedTerms.length : 0)
            || String(a.tableName || a.entityName || '').localeCompare(String(b.tableName || b.entityName || ''), 'zh-Hans-CN');
        const candidates = [...byKey.values()];
        const isExplicit = item => [item.tableName, item.entityName]
            .map(value => String(value || '').trim().toLowerCase())
            .some(name => explicitTableNames.has(name));
        const forced = candidates.filter(isExplicit).sort(sortCandidates);
        const ordinary = candidates.filter(item => !isExplicit(item)).sort(sortCandidates);
        return forced.concat(ordinary.slice(0, Math.max(0, maxResults - forced.length)));
    }

    _classifyRequirementBaselineConstraint(rule = {}) {
        const alias = String(rule && (rule.ruleAlias || rule.ruleName || rule.name) || '').trim();
        const category = String(rule && rule.category || '').trim();
        const referencePolicy = String(rule && rule.referencePolicy || '').trim();
        const signal = String(rule && rule.signal || this._inferRequirementRuleSignal(rule) || '').trim();
        const identity = [alias, category].join(' ');

        if (
            signal === 'file_placement' ||
            referencePolicy === 'placement_reference' ||
            /项目结构与命名规范|工程结构|目录结构|包路径|文件坐落点/u.test(identity)
        ) {
            return {
                constraintType: 'placement_contract',
                reasonCode: 'placement_by_scan_contract',
                authorityMode: 'scan_contract',
                authoritySource: '工程导航契约.compact.json.rulePlacementContract.rules[]|databaseNamingContract',
                ruleBodyReadRequired: false,
                readTiming: 'after_scan_contract_before_allowed_scope',
                readScope: 'scan_contract:rulePlacementContract.rules[]|databaseNamingContract'
            };
        }

        if (/^代码生成规范(?:-|$)|骨架(?:规则|模板|生成)?|代码.*模板|模板.*代码/u.test(alias)) {
            return {
                constraintType: 'skeleton_template',
                reasonCode: 'skeleton_rule_for_builder',
                authorityMode: 'baseline_constraint',
                authoritySource: 'Gate Contract / skeleton materialize resolver',
                ruleBodyReadRequired: false,
                readTiming: 'coder_skeleton_phase',
                readScope: 'builder_owned_skeleton_template'
            };
        }

        if (/前端API-开发手册|前端-MiniUI开发规范|MiniUI.*开发|前端页面.*基础/u.test(alias)) {
            return {
                constraintType: 'frontend_framework',
                reasonCode: 'frontend_framework_baseline',
                authorityMode: 'baseline_constraint',
                authoritySource: 'Coder page strategy / frontend framework baseline',
                ruleBodyReadRequired: true,
                readTiming: 'before_page_coder',
                readScope: 'baseline_frontend_framework_api'
            };
        }

        return null;
    }

    _decorateRequirementBaselineConstraint(rule = {}, classification = {}) {
        return {
            ...rule,
            ...classification,
            userSelectable: false,
            includeInRulePool: false,
            usageDuty: rule.usageDuty || '基础必需约束，仅供后续 Builder/Coder 审计消费；不进入用户规则池或模块绑定。'
        };
    }

    _buildRequirementRuleMatchReason(rule = {}) {
        const signal = String(rule && rule.signal || 'requirement_rule').trim() || 'requirement_rule';
        const keywords = this._dedupeRequirementTerms(Array.isArray(rule && rule.matchedKeywords) ? rule.matchedKeywords : [])
            .filter(item => !this._isLowSignalRequirementTerm(item))
            .slice(0, 4);
        const terms = this._dedupeRequirementTerms(Array.isArray(rule && rule.matchedTerms) ? rule.matchedTerms : [])
            .filter(item => !this._isLowSignalRequirementTerm(item))
            .slice(0, 4);
        const parts = [`signal=${signal}`];
        if (keywords.length > 0) parts.push(`命中关键词「${keywords.join(' / ')}」`);
        if (terms.length > 0) parts.push(`需求锚点「${terms.join(' / ')}」`);
        if (parts.length === 1) {
            const anchor = String(rule && rule.userAnchor || '').trim();
            if (anchor) parts.push(`需求锚点「${anchor}」`);
        }
        return parts.join('；');
    }

    /**
     * 纯 LIKE 召回：只看用户 intent 是否字面包含规则的 keyword（来自 frontmatter intent_keywords）。
     * 不打分、不切词、不做 stop words、不基于 lane 加权。
     * 命中数排序，由用户在 Step 3.5 剔除卡里收口。
     *
     * 设计原则（2026-05-25 改）：
     * - 多召回比少召回安全。规则池由用户决定，不在算法侧抑制。
     * - 关键词单字也算命中（如规则关键词写"用户"，intent 含"用户"就召回）。
     * - matchedKeywords 是 LIKE 真值，不再注入整段 userIntent。
     * - matchedTerms 与 matchedKeywords 同义（向后兼容下游消费）。
     */
    _likeRecallRules(userIntent, options = {}) {
        const intent = String(userIntent || '');
        if (!intent.trim()) return [];
        const optionObject = options && typeof options === 'object' ? options : {};
        const projectPath = typeof options === 'string' ? options : optionObject.projectPath;
        const allRules = (this.ruleService && typeof this.ruleService.listRules === 'function')
            ? this.ruleService.listRules(projectPath)
            : [];
        if (!Array.isArray(allRules) || allRules.length === 0) return [];
        const recalled = [];
        const seen = new Set();
        allRules.forEach(rule => {
            if (!rule || typeof rule !== 'object') return;
            let keywords = Array.isArray(rule.keywords) ? rule.keywords : [];
            let explicitKeywords = Array.isArray(rule.explicit_intent_keywords) ? rule.explicit_intent_keywords : [];
            // listRules entry 没带 keywords 时，回退从 frontmatter 解析（兼容简单 mock）
            if (keywords.length === 0 && explicitKeywords.length === 0
                && this.ruleService && typeof this.ruleService.getRuleContent === 'function') {
                const ruleId = String(rule.name || rule.id || '').trim();
                if (ruleId) {
                    try {
                        const content = this.ruleService.getRuleContent(ruleId) || '';
                        const fm = this._parseFrontmatterKeywords(content);
                        if (fm.length > 0) keywords = fm;
                    } catch (_) { /* fallback failure non-blocking */ }
                }
            }
            const allKeywords = this._dedupeRequirementTerms([...keywords, ...explicitKeywords])
                .map(kw => String(kw || '').trim())
                .filter(Boolean);
            if (allKeywords.length === 0) return;
            const hits = allKeywords.filter(kw => intent.includes(kw));
            if (hits.length === 0) return;
            const ruleAlias = String(rule.ruleAlias || rule.name || rule.id || '').trim();
            if (!ruleAlias) return;
            const key = ruleAlias;
            if (seen.has(key)) return;
            seen.add(key);
            recalled.push({
                ...rule,
                name: rule.name || rule.id || ruleAlias,
                ruleAlias,
                matchedKeywords: hits,
                matchedTerms: hits,
                hitCount: hits.length
            });
        });
        recalled.sort((a, b) => Number(b.hitCount || 0) - Number(a.hitCount || 0));
        return recalled;
    }

    _parseFrontmatterKeywords(content = '') {
        const text = String(content || '');
        const match = /^---\s*\n([\s\S]*?)\n---/u.exec(text);
        if (!match) return [];
        const fmText = match[1];
        const out = [];
        const lines = fmText.split(/\r?\n/);
        let inIntent = false;
        for (const line of lines) {
            const intentStart = /^\s*intent_keywords\s*:\s*(\[(.*?)\])?\s*$/u.exec(line);
            if (intentStart) {
                inIntent = true;
                if (intentStart[2]) {
                    intentStart[2].split(',').forEach(item => {
                        const v = String(item || '').trim().replace(/^["']|["']$/g, '').trim();
                        if (v) out.push(v);
                    });
                    inIntent = false;
                }
                continue;
            }
            if (inIntent) {
                const item = /^\s*-\s*(.+?)\s*$/u.exec(line);
                if (item) {
                    const v = String(item[1] || '').trim().replace(/^["']|["']$/g, '').trim();
                    if (v) out.push(v);
                    continue;
                }
                const isOtherKey = /^\s*[A-Za-z_][\w-]*\s*:/u.test(line) || /^\s*$/u.test(line);
                if (isOtherKey) {
                    inIntent = false;
                }
            }
        }
        return out;
    }

    /**
     * 注入 baseline 规则（前端API-开发手册 / 项目结构与命名规范 / 代码生成规范-*）。
     * baseline 不依赖 LIKE 命中，按 alias 正则强制识别后注入；matchedKeywords 留空，避免假装命中。
     */
    _injectBaselineRules(existingRules = []) {
        const allRules = (this.ruleService && typeof this.ruleService.listRules === 'function')
            ? this.ruleService.listRules() || []
            : [];
        const existingAliases = new Set(
            existingRules.map(rule => String(rule.ruleAlias || rule.name || '').trim()).filter(Boolean)
        );
        const isBaselineAlias = (alias = '') => {
            const value = String(alias || '').trim();
            if (!value) return false;
            return /项目结构与命名规范/u.test(value)
                || /^代码生成规范(?:-|$)/u.test(value)
                || /前端API-开发手册|前端-MiniUI开发规范/u.test(value);
        };
        const injected = [];
        allRules.forEach(rule => {
            if (!rule || typeof rule !== 'object') return;
            const alias = String(rule.ruleAlias || rule.name || rule.id || '').trim();
            if (!alias || !isBaselineAlias(alias)) return;
            if (existingAliases.has(alias)) return;
            existingAliases.add(alias);
            injected.push({
                ...rule,
                name: rule.name || rule.id || alias,
                ruleAlias: alias,
                matchedKeywords: [],
                matchedTerms: [],
                hitCount: 0
            });
        });
        return injected;
    }

    buildRequirementRuleAnalyzeResult(userIntent, options = {}) {
        const optionObject = options && typeof options === 'object' ? options : {};
        const projectPath = typeof options === 'string'
            ? options
            : optionObject.projectPath;

        // 1. 纯 LIKE 召回
        const recalledRules = this._likeRecallRules(userIntent, { projectPath });

        // 2. 注入 baseline（按 alias 正则识别，不依赖 LIKE 命中）
        const baselineInjected = this._injectBaselineRules(recalledRules);
        const allRules = [...recalledRules, ...baselineInjected];

        // 3. 项目表候选 + signal catalog（保留原有能力）
        const projectTableCandidates = this._collectProjectTableCandidates(userIntent, {
            ...optionObject,
            projectPath
        });
        const signalCatalog = this._collectRequirementSignalCatalog(userIntent);

        // 4. 字段映射
        const mappedRules = allRules.map(rule => {
            const signal = this._inferRequirementRuleSignal(rule);
            const rawReferencePolicy = String(rule.referencePolicy || '').trim();
            const scanDerivedPlacementRule = signal === 'file_placement' && /项目结构与命名规范/u.test(String(rule.ruleAlias || rule.name || ''));
            const referencePolicy = scanDerivedPlacementRule ? 'placement_reference' : (rawReferencePolicy || 'srs_reference');
            const applicability = this._extractRuleApplicability(rule);
            const ruleHasStructuredDecisionContract = (rule.mustConfirm === true || rule.requiresUserDecision === true || rule.requiresUserConfirmation === true) &&
                (Array.isArray(rule.questionHints) && rule.questionHints.length > 0 || Array.isArray(rule.requiredInputs) && rule.requiredInputs.length > 0);
            const hits = Array.isArray(rule.matchedKeywords) ? rule.matchedKeywords : [];
            const userAnchor = hits.length > 0
                ? hits.slice(0, 3).join('、')
                : String(userIntent || '').slice(0, 60);
            const matchReason = hits.length > 0
                ? `命中关键词「${hits.slice(0, 6).join(' / ')}」`
                : `signal=${signal}（基础约束，自动注入）`;
            return {
                ruleName: rule.name || rule.ruleAlias || '',
                ruleAlias: rule.ruleAlias || rule.name || '',
                category: rule.category || '',
                path: rule.path || '',
                source: rule.source || '',
                signal,
                referencePolicy,
                authorityMode: scanDerivedPlacementRule ? 'scan_contract' : 'rule_body',
                ruleBodyReadRequired: !scanDerivedPlacementRule,
                authoritySource: scanDerivedPlacementRule
                    ? '工程导航契约.compact.json.rulePlacementContract.rules[]|databaseNamingContract'
                    : 'rule_expert(action=read)',
                userAnchor,
                matchedKeywords: hits.slice(0, 12),
                matchedTerms: hits.slice(0, 12),
                hitCount: Number(rule.hitCount || hits.length || 0),
                matchReason,
                usageDuty: this._inferRequirementRuleUsageDuty(rule),
                confidence: hits.length >= 2 ? 'high' : (hits.length >= 1 ? 'medium' : 'baseline'),
                readTiming: scanDerivedPlacementRule ? 'after_scan_contract_before_allowed_scope' : 'before_todo',
                readScope: scanDerivedPlacementRule
                    ? 'scan_contract:rulePlacementContract.rules[]|databaseNamingContract'
                    : `only_sections_relevant_to:${signal}`,
                ...(applicability.applicableLayers.length > 0 ? { applicableLayers: applicability.applicableLayers } : {}),
                ...(applicability.applicableExecutionRoles.length > 0 ? { applicableExecutionRoles: applicability.applicableExecutionRoles } : {}),
                ...(applicability.applicableFileKinds.length > 0 ? { applicableFileKinds: applicability.applicableFileKinds } : {}),
                ...(Array.isArray(rule.questionHints) && rule.questionHints.length > 0 ? { questionHints: rule.questionHints } : {}),
                ...(Array.isArray(rule.requiredInputs) && rule.requiredInputs.length > 0 ? { requiredInputs: rule.requiredInputs } : {}),
                ...(ruleHasStructuredDecisionContract ? { decisionSignalSource: 'rule_metadata', mustConfirm: true } : {}),
                ...(ruleHasStructuredDecisionContract && (rule.owner || rule.ownerType || rule.resolutionOwner || rule.decisionOwner)
                    ? { owner: rule.owner || rule.ownerType || rule.resolutionOwner || rule.decisionOwner }
                    : {}),
                ...(ruleHasStructuredDecisionContract && (rule.decisionEntry || rule.decisionEntryPoint || rule.userDecisionEntry || rule.questionEntry)
                    ? { decisionEntry: rule.decisionEntry || rule.decisionEntryPoint || rule.userDecisionEntry || rule.questionEntry }
                    : {})
            };
        });

        // 5. 分流：业务规则 vs 基础约束
        const acceptedRules = [];
        const baselineConstraints = [];
        mappedRules.forEach(rule => {
            const classification = this._classifyRequirementBaselineConstraint(rule);
            if (classification) {
                baselineConstraints.push(this._decorateRequirementBaselineConstraint(rule, classification));
                return;
            }
            acceptedRules.push(rule);
        });

        // 6. 未解析信号
        const signalCoverageRules = [...acceptedRules, ...baselineConstraints];
        const unresolvedSignals = signalCatalog
            .filter(item => !signalCoverageRules.some(rule => this._ruleCoversRequirementSignal(rule, item.signal)))
            .map(item => ({
                ...item,
                signal: item.signal,
                userAnchor: item.userAnchor,
                reason: '未找到可回放到该需求信号的具体规则；仅作为规则召回提示项保留，禁止用其他规则冒名替代。',
                usageDuty: item.usageDuty
            }));

        return {
            mode: 'requirement_signal_rule_recall',
            signalCatalog,
            acceptedRules,
            baselineConstraints,
            projectTableCandidates,
            unresolvedSignals,
            diagnostics: {
                scoringEngine: 'pure_like_recall_v1',
                stage: 'requirement',
                matchCount: acceptedRules.length + baselineConstraints.length,
                strategy: '规则关键词字面量包含于 userIntent 即召回；命中数排序；不打分、不切词、无 stop words；多召回交由用户在 Step 3.5 剔除卡收口。'
            }
        };
    }

    resolveRequirementIntentRulesFromAnalysis(analysis = {}, options = {}) {
        const projectPath = typeof options === 'string'
            ? options
            : options.projectPath;
        return this.resolveRequirementRulesBySignals({
            stage: 'requirement',
            analysisTerms: this._extractRequirementRuleMatchTerms(analysis),
            featureKeys: this._extractStableFeatureKeysFromAnalysis(analysis),
            intentSignals: [options && typeof options === 'object' ? options.userIntent : ''].filter(Boolean)
        }, {
            ...(typeof options === 'object' && options ? options : {}),
            projectPath
        });
    }

    resolveRequirementIntentRules(userIntent, options = {}) {
        const projectPath = typeof options === 'string'
            ? options
            : options.projectPath;
        const providedAnalysis = options && typeof options === 'object'
            ? (options.analysis || options.requirementAnalysis || null)
            : null;
        const allowSyntheticAnalysis = !!(options && typeof options === 'object' && options.allowSyntheticAnalysis === true);
        if (providedAnalysis && typeof providedAnalysis === 'object') {
            return this.resolveRequirementIntentRulesFromAnalysis(providedAnalysis, {
                ...(typeof options === 'object' && options ? options : {}),
                userIntent,
                projectPath
            });
        }
        if (!allowSyntheticAnalysis) {
            return [];
        }
        const analysis = this.analyzeRequirementIntent(userIntent, options);
        return this.resolveRequirementIntentRulesFromAnalysis(analysis, {
            ...(typeof options === 'object' && options ? options : {}),
            userIntent,
            projectPath
        });
    }

    // 意图识别 (带自动刷新机制)
    intentRecognize(userIntent, options = {}) {
        const projectPath = typeof options === 'string'
            ? options
            : options.projectPath;
        const matchedSkills = this._rankSkillsByIntent(userIntent, { projectPath });

        if (matchedSkills.length === 0) {
            return {
                text: '抱歉，我没有找到与您意图匹配的特定技能。您可以尝试换个说法。',
                _structured: { matched: false }
            };
        }

        const matchesWithContent = matchedSkills.map(skill => {
            const content = this.ruleService.getRuleContent(skill.id);
            return { ...skill, content };
        });
        const diagnostics = this._buildIntentMatchDiagnostics(matchedSkills);

        const primarySkill = matchesWithContent[0];
        const ruleContent = primarySkill.content;
        const isDetailedRequest = userIntent.length > 80;

        let responseText = '';
        if (matchesWithContent.length > 1) {
            responseText = `✅ **检测到多项规范匹配**：\n`;
            matchesWithContent.forEach((m, idx) => {
                responseText += `${idx + 1}. **[${m.name}](mdc:${m.id}${m.ext || '.mdc'})**\n`;
            });
            responseText += `\n`;
        }

        if (isDetailedRequest) {
            if (matchesWithContent.length === 1) {
                responseText += `✅ **规范匹配成功**：**[${primarySkill.name}](mdc:${primarySkill.id}${primarySkill.ext || '.mdc'})**\n\n`;
            }
            responseText += `📌 **意图识别结果**：以上规范可作为后续需求规划、施工单或编码执行的关联上下文。\n\n`;
            responseText += `⚠️ **边界提醒**：本结果只完成规则命中分析，不代表已经授权直接修改代码；后续应按用户选择进入施工单、流水线或受控编码流程。\n`;
        } else {
            if (matchesWithContent.length === 1) {
                responseText += `🔍 **规范待确认**：检测到您正意图进行 **[${primarySkill.name}](mdc:${primarySkill.id}${primarySkill.ext || '.mdc'})** 相关操作。\n\n`;
            }
            responseText += `📌 **意图识别结果**：请结合用户后续指令决定是否继续读取规范、生成施工单或进入受控编码流程。\n`;
        }

        if (ruleContent) {
            const importantMatch = ruleContent.match(/>\s*\[!IMPORTANT\][\s\S]*?(?=\n\n|\n#|$)/);
            if (importantMatch) {
                responseText += `\n>> **${primarySkill.name} 核心约束**：\n${importantMatch[0].replace(/^>\s*/gm, '')}\n`;
            }

            const codeBlockMatch = ruleContent.match(/```java\s*([\s\S]*?)```/);
            if (codeBlockMatch) {
                const code = codeBlockMatch[1];
                responseText += `\n **强制模板（唯一实现方式）**：\n\`\`\`java\n${code}\n\`\`\`\n`;

                responseText += `\n👉 **使用提示**：如需落地代码，必须先确认需求边界、工程坐落点和允许文件范围。`;
            }
        }

        return {
            text: responseText,
            _structured: {
                matched: true,
                primary_skill: primarySkill,
                all_matches: matchesWithContent,
                rule_content: ruleContent,
                diagnostics
            }
        };
    }

    _isPipelineCodeRuleAlias(ruleName = '') {
        return /^代码生成规范-(?:后端实体层|后端控制层|前端页面)$/u.test(String(ruleName || '').trim());
    }

    executeSkillAction(skillId, actionName, parameters = {}) {
        if (this._isPipelineCodeRuleAlias(skillId)) {
            return [
                `错误：${skillId} 是流水线代码生成规范，不是可执行技能。`,
                '请不要用 `rule_expert(action="execute")` 生成流水线代码。',
                '正确顺序：通过需求 Skill 完成 Story，再由设计 Skill 调用 `design_prepare_context` 完成设计；骨架完成后启动 `epoint-design-tdd-coder`，按 intake 和 readCatalog 自主编码。',
                '若当前仍在设计阶段，请调用 `design_prepare_context` 获取当前步骤并按公开合同提交；编码阶段不通过 MCP 推进状态。'
            ].join('\n');
        }
        const skill = this.skills.find(s => s.id === skillId);
        if (!skill) return `错误：找不到技能 ${skillId}`;
        const action = skill.actions.find(a => a.name === actionName || a.method === actionName);
        if (!action) return `错误：在技能 ${skillId} 中找不到动作 ${actionName}`;
        return this.generateCodeTemplate(skill, action, parameters);
    }

    generateCodeTemplate(skill, action, parameters) {
        const entityName = parameters.entityName || 'NewEntity';
        const serviceName = skill.name ? skill.name.replace(/接口使用规范|使用规范/g, '').trim() : 'BaseService';
        const lookupKey = action.method || action.name;
        const content = this.ruleService.getRuleContent(skill.id);
        let template = PipelineUtils.extractCodeTemplateFromMarkdown(content, lookupKey);

        if (template) {
            template = template.replace(/\{entityName\}/g, entityName).replace(/\{serviceName\}/g, serviceName);
            return `// [Generated] 基于 ${skill.name} 的模板\n${template}`;
        }

        const method = action.method || 'executeAction';
        const serviceVar = serviceName.charAt(0).toLowerCase() + serviceName.slice(1);
        return `// 基于 ${skill.name} 自动生成的代码骨架\n@Autowired\nprivate ${serviceName} ${serviceVar};\n\npublic void handle${entityName}() {\n    ${serviceVar}.${method}(...);\n}\n`;
    }
}

module.exports = SkillIntentService;
