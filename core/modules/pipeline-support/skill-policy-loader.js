/**
 * Skill Policy Loader & Enforcer (v1)
 *
 * Skill 在自己的目录下放 policy.json，由本模块通用解释执行。
 * 字段定义单源在 skills/_schema/policy-schema.md。
 *
 * Skill 不写 policy.json 时退化为放行；现有 hardcoded 拦截照旧生效。
 *
 * 设计原则（AGENTS.md 红线）：
 * - 不写死项目样例：拦截规则全部从 policy.json 来，本文件只解释 schema
 * - shared policy 单源：工具分类判定全部走 skill-tool-policy-shared.js 的 isXxxToolName
 */

const fs = require('fs');
const path = require('path');
const {
    isSearchToolName,
    isReadToolName,
    isWriteToolName,
    isCommandToolName,
    isHighRiskToolName,
    normalizeToolName
} = require('./skill-tool-policy-shared');

const POLICY_FILENAME = 'policy.json';
const POLICY_CACHE_TTL_MS = 5 * 60 * 1000; // 5 分钟

const TOOL_CATEGORY_CHECKERS = Object.freeze({
    search: isSearchToolName,
    read: isReadToolName,
    write: isWriteToolName,
    command: isCommandToolName,
    high_risk: isHighRiskToolName
});

const PATH_ARG_FIELDS = Object.freeze([
    'path',
    'filePath',
    'targetFile',
    'target',
    'targetPath',
    'outputPath',
    'file',
    'filePaths',
    'file_pattern',
    'pattern'
]);

const CONTENT_ARG_FIELDS = Object.freeze([
    'text',
    'content',
    'contents',
    'data',
    'body',
    'newString',
    'replacement',
    'insertText',
    'appendText'
]);

class SkillPolicyLoader {
    constructor() {
        this.cache = new Map(); // skillRoot -> { policy, loadedAt }
    }

    /**
     * 读取并缓存 policy.json。失败返回 null。
     */
    loadPolicy(skillRoot) {
        const root = String(skillRoot || '').trim();
        if (!root) return null;
        const cached = this.cache.get(root);
        const now = Date.now();
        if (cached && now - cached.loadedAt < POLICY_CACHE_TTL_MS) {
            return cached.policy;
        }
        const policyPath = path.join(root, POLICY_FILENAME);
        if (!fs.existsSync(policyPath)) {
            this.cache.set(root, { policy: null, loadedAt: now });
            return null;
        }
        try {
            const raw = fs.readFileSync(policyPath, 'utf-8');
            const parsed = JSON.parse(raw);
            const validated = this._validateSchema(parsed, policyPath);
            this.cache.set(root, { policy: validated, loadedAt: now });
            return validated;
        } catch (err) {
            // policy.json 损坏不阻塞 Skill 运行；记录后退化为 null
            // eslint-disable-next-line no-console
            console.error(`[SkillPolicyLoader] Failed to load ${policyPath}: ${err.message}`);
            this.cache.set(root, { policy: null, loadedAt: now });
            return null;
        }
    }

    invalidateCache(skillRoot) {
        if (skillRoot) {
            this.cache.delete(String(skillRoot));
        } else {
            this.cache.clear();
        }
    }

    _validateSchema(policy, policyPath) {
        if (!policy || typeof policy !== 'object' || Array.isArray(policy)) {
            throw new Error(`policy 必须是对象`);
        }
        if (typeof policy.skillName !== 'string' || !policy.skillName.trim()) {
            throw new Error(`skillName 必填`);
        }
        if (typeof policy.version !== 'string' || !policy.version.trim()) {
            throw new Error(`version 必填`);
        }
        const restrictions = policy.globalRestrictions || {};
        if (typeof restrictions !== 'object') {
            throw new Error(`globalRestrictions 必须是对象`);
        }
        // 各字段类型容忍：缺省时取默认空数组
        return {
            skillName: policy.skillName.trim(),
            version: policy.version.trim(),
            globalRestrictions: {
                forbiddenToolCategories: this._asStringArray(restrictions.forbiddenToolCategories),
                forbiddenTools: this._asStringArray(restrictions.forbiddenTools).map(normalizeToolName),
                allowedTools: this._asStringArray(restrictions.allowedTools).map(normalizeToolName),
                forbiddenPathPatterns: this._asStringArray(restrictions.forbiddenPathPatterns),
                allowedPathPrefixes: this._asStringArray(restrictions.allowedPathPrefixes),
                forbiddenArgPatterns: Array.isArray(restrictions.forbiddenArgPatterns)
                    ? restrictions.forbiddenArgPatterns.filter(item =>
                        item && typeof item === 'object' && typeof item.tool === 'string' &&
                        typeof item.argField === 'string' && typeof item.regex === 'string')
                    : [],
                forbiddenContentPatterns: Array.isArray(restrictions.forbiddenContentPatterns)
                    ? restrictions.forbiddenContentPatterns.filter(item =>
                        item && typeof item === 'object' && typeof item.tool === 'string' &&
                        typeof item.regex === 'string')
                    : [],
                blockReason: typeof restrictions.blockReason === 'string'
                    ? restrictions.blockReason
                    : ''
            }
        };
    }

    _asStringArray(value) {
        if (!Array.isArray(value)) return [];
        return value.filter(item => typeof item === 'string' && item.trim()).map(item => item.trim());
    }
}

class SkillPolicyEnforcer {
    constructor(loader = null) {
        this.loader = loader || new SkillPolicyLoader();
    }

    /**
     * 主入口。返回：
     *   - null：策略未拦截，调用方继续走默认逻辑
     *   - { code, reason }：拦截，调用方应返回 _blockedToolResponse(code, [reason, '[STOP]'])
     *
     * @param {string} toolName 工具名
     * @param {object} args 工具参数
     * @param {object} context { skillRoot, projectPath, demandDir, workspaceRoot }
     */
    check(toolName, args, context = {}) {
        const skillRoot = String(context.skillRoot || '').trim();
        if (!skillRoot) return null;
        const policy = this.loader.loadPolicy(skillRoot);
        if (!policy) return null;

        const restrictions = policy.globalRestrictions || {};
        const normalizedTool = normalizeToolName(toolName);
        const allowedTools = new Set(restrictions.allowedTools || []);
        const defaultReason = restrictions.blockReason ||
            `${policy.skillName} 的 policy.json 不允许调用 ${toolName}`;

        // 1. forbiddenTools 精确名单
        if ((restrictions.forbiddenTools || []).includes(normalizedTool)) {
            return this._block(defaultReason, policy.skillName, toolName);
        }

        // 2. forbiddenArgPatterns
        const argHit = this._checkForbiddenArgPatterns(toolName, args, restrictions.forbiddenArgPatterns || []);
        if (argHit) {
            return this._block(argHit.reason || defaultReason, policy.skillName, toolName);
        }

        // 2.1 forbiddenContentPatterns（按目标路径 + 写入内容联合拦截）
        const contentHit = this._checkForbiddenContentPatterns(toolName, args, restrictions.forbiddenContentPatterns || []);
        if (contentHit) {
            return this._block(contentHit.reason || defaultReason, policy.skillName, toolName);
        }

        // 3. forbiddenPathPatterns
        const pathHit = this._checkForbiddenPathPatterns(args, restrictions.forbiddenPathPatterns || [], context);
        if (pathHit) {
            return this._block(
                `${defaultReason}（命中禁止路径：${pathHit}）`,
                policy.skillName,
                toolName
            );
        }

        // 4. forbiddenToolCategories ∩ ¬allowedTools
        if (!allowedTools.has(normalizedTool)) {
            for (const category of restrictions.forbiddenToolCategories || []) {
                const checker = TOOL_CATEGORY_CHECKERS[category];
                if (checker && checker(toolName)) {
                    return this._block(
                        `${defaultReason}（${toolName} 属于禁止分类：${category}）`,
                        policy.skillName,
                        toolName
                    );
                }
            }
        }

        // 5. allowedPathPrefixes 白名单收敛（仅对 read/write 工具生效）
        const allowedPrefixes = restrictions.allowedPathPrefixes || [];
        if (allowedPrefixes.length > 0 && (isReadToolName(toolName) || isWriteToolName(toolName))) {
            const offending = this._checkAllowedPathPrefixes(args, allowedPrefixes, context);
            if (offending) {
                return this._block(
                    `${defaultReason}（路径未在白名单内：${offending}）`,
                    policy.skillName,
                    toolName
                );
            }
        }

        return null;
    }

    _block(reason, skillName, toolName) {
        return {
            code: 'SKILL_POLICY_VIOLATION',
            reason,
            skillName,
            toolName
        };
    }

    _checkForbiddenArgPatterns(toolName, args, patterns) {
        if (!Array.isArray(patterns) || patterns.length === 0) return null;
        const normalizedTool = normalizeToolName(toolName);
        for (const item of patterns) {
            const ruleTool = String(item.tool || '').trim();
            if (ruleTool !== '*' && normalizeToolName(ruleTool) !== normalizedTool) continue;
            const argValue = this._extractArgFieldValue(args, item.argField);
            if (!argValue) continue;
            let regex;
            try {
                regex = new RegExp(item.regex);
            } catch (_) {
                continue;
            }
            if (regex.test(argValue)) {
                return item;
            }
        }
        return null;
    }

    _checkForbiddenContentPatterns(toolName, args, patterns) {
        if (!Array.isArray(patterns) || patterns.length === 0) return null;
        const normalizedTool = normalizeToolName(toolName);
        for (const item of patterns) {
            const ruleTool = String(item.tool || '').trim();
            if (ruleTool !== '*' && normalizeToolName(ruleTool) !== normalizedTool) continue;
            if (!this._contentPatternPathMatches(args, item)) continue;
            const contentValue = this._collectContentArgValue(args, item);
            if (!contentValue) continue;
            let regex;
            try {
                regex = new RegExp(item.regex);
            } catch (_) {
                continue;
            }
            if (regex.test(contentValue)) {
                return item;
            }
        }
        return null;
    }

    _contentPatternPathMatches(args, item = {}) {
        const pathRegexText = String(item.pathRegex || '').trim();
        if (!pathRegexText) return true;
        let regex;
        try {
            regex = new RegExp(pathRegexText);
        } catch (_) {
            return false;
        }
        const field = String(item.pathArgField || '').trim();
        const candidatePaths = field
            ? [this._extractArgFieldValue(args, field)].filter(Boolean)
            : this._collectArgPaths(args);
        return candidatePaths
            .map(candidate => this._normalizePath(candidate))
            .some(candidate => regex.test(candidate));
    }

    _collectContentArgValue(args, item = {}) {
        const fields = Array.isArray(item.contentArgFields) && item.contentArgFields.length > 0
            ? item.contentArgFields
            : (typeof item.contentArgField === 'string' && item.contentArgField.trim()
                ? [item.contentArgField.trim()]
                : CONTENT_ARG_FIELDS);
        return fields
            .map(field => this._extractArgFieldValue(args, field))
            .filter(Boolean)
            .join('\n');
    }

    _checkForbiddenPathPatterns(args, patterns, context) {
        if (!Array.isArray(patterns) || patterns.length === 0) return null;
        const candidatePaths = this._collectArgPaths(args);
        if (candidatePaths.length === 0) return null;
        const resolved = patterns.map(pat => this._resolvePlaceholders(pat, context));
        for (const candidate of candidatePaths) {
            for (const pattern of resolved) {
                if (this._matchGlob(candidate, pattern)) {
                    return candidate;
                }
            }
        }
        return null;
    }

    _checkAllowedPathPrefixes(args, allowedPrefixes, context) {
        const candidatePaths = this._collectArgPaths(args);
        if (candidatePaths.length === 0) return null;
        const resolved = allowedPrefixes
            .map(p => this._resolvePlaceholders(p, context))
            .map(p => this._normalizePath(p));
        for (const candidate of candidatePaths) {
            const normalized = this._normalizePath(candidate);
            const isAbsolute = path.isAbsolute(candidate);
            // 相对路径 / 通配符无法直接判断，放过给 forbiddenPathPatterns 处理
            if (!isAbsolute) continue;
            const ok = resolved.some(prefix => normalized.startsWith(prefix));
            if (!ok) {
                return candidate;
            }
        }
        return null;
    }

    _extractArgFieldValue(args, field) {
        if (!args || typeof args !== 'object' || !field) return '';
        const direct = args[field];
        if (typeof direct === 'string') return direct;
        if (Array.isArray(direct)) return direct.join('\n');
        if (typeof direct === 'object' && direct !== null) {
            try { return JSON.stringify(direct); } catch (_) { return ''; }
        }
        return '';
    }

    _collectArgPaths(args) {
        if (!args || typeof args !== 'object') return [];
        const out = [];
        for (const field of PATH_ARG_FIELDS) {
            const value = args[field];
            if (typeof value === 'string' && value.trim()) {
                out.push(value.trim());
            } else if (Array.isArray(value)) {
                value.forEach(v => {
                    if (typeof v === 'string' && v.trim()) out.push(v.trim());
                });
            }
        }
        return out;
    }

    _resolvePlaceholders(pattern, context = {}) {
        let result = String(pattern || '');
        const map = {
            '<projectPath>': context.projectPath || '',
            '<demandDir>': context.demandDir || '',
            '<skillRoot>': context.skillRoot || '',
            '<workspaceRoot>': context.workspaceRoot || ''
        };
        for (const [placeholder, value] of Object.entries(map)) {
            if (value) {
                result = result.split(placeholder).join(value);
            }
        }
        return result;
    }

    _normalizePath(value) {
        return String(value || '').replace(/\\/g, '/');
    }

    /**
     * 极简 glob 匹配。支持：
     *   ** - 跨目录
     *   *  - 同段任意字符（不跨 /）
     *   ?  - 单字符
     */
    _matchGlob(value, pattern) {
        const normalizedValue = this._normalizePath(value);
        const normalizedPattern = this._normalizePath(pattern);
        const regex = this._globToRegex(normalizedPattern);
        return regex.test(normalizedValue);
    }

    _globToRegex(glob) {
        let regexStr = '^';
        for (let i = 0; i < glob.length; i++) {
            const ch = glob[i];
            if (ch === '*') {
                if (glob[i + 1] === '*') {
                    regexStr += '.*';
                    i++;
                    if (glob[i + 1] === '/') i++;
                } else {
                    regexStr += '[^/]*';
                }
            } else if (ch === '?') {
                regexStr += '[^/]';
            } else if (/[.+^${}()|[\]\\]/.test(ch)) {
                regexStr += `\\${ch}`;
            } else {
                regexStr += ch;
            }
        }
        regexStr += '$';
        return new RegExp(regexStr);
    }
}

module.exports = {
    SkillPolicyLoader,
    SkillPolicyEnforcer,
    POLICY_FILENAME,
    POLICY_CACHE_TTL_MS
};
