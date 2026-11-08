/* eslint-disable */
'use strict';

class DesignTddSqlConditionUtilGuardService {
    validate({ filePath = '', source = '', queryFilters = [] } = {}) {
        const text = String(source || '');
        const variables = this._collectVariables(text);
        const violations = [];
        const calls = [];
        for (const variable of variables) {
            for (const call of this._collectCalls(text, variable)) {
                calls.push(call);
                if (call.method === 'like' && /(?:["']%|%["'])/u.test(call.arguments[1] || '')) {
                    violations.push(this._violation(filePath, call, 'SQL_CONDITION_UTIL_LIKE_WILDCARD_FORBIDDEN',
                        'SqlConditionUtil.like 接收原始关键词；禁止手工拼接 %，需要时传 value.trim()。', {
                            allowedSignatures: ['like(field, value)', 'like(field, value.trim())']
                        }));
                }
            }
        }
        violations.push(...this._validateListActionQueryAccessors({
            filePath,
            source: text,
            queryFilters,
            calls
        }));
        return { ok: violations.length === 0, violations };
    }

    _validateListActionQueryAccessors({ filePath = '', source = '', queryFilters = [], calls = [] } = {}) {
        if (!/ListAction\.java$/iu.test(String(filePath || ''))) return [];
        const violations = [];
        for (const filter of (Array.isArray(queryFilters) ? queryFilters : [])) {
            const inputKey = String(filter && filter.inputKey || '').trim();
            const fieldName = String(filter && filter.fieldName || '').trim();
            if (!inputKey || !fieldName) continue;
            const accessor = accessorSpec(inputKey);
            const missing = [
                !new RegExp(`\\bprivate\\s+String\\s+${escapeRegExp(inputKey)}\\s*;`, 'u').test(source) ? 'private String' : '',
                !new RegExp(`\\bpublic\\s+String\\s+${escapeRegExp(accessor.getter)}\\s*\\(\\s*\\)`, 'u').test(source) ? accessor.getter : '',
                !new RegExp(`\\bpublic\\s+void\\s+${escapeRegExp(accessor.setter)}\\s*\\(\\s*String\\s+${escapeRegExp(inputKey)}\\s*\\)`, 'u').test(source) ? accessor.setter : ''
            ].filter(Boolean);
            if (missing.length > 0) {
                violations.push({
                    code: 'SQL_CONDITION_UTIL_LIST_QUERY_ACCESSOR_MISSING',
                    file: String(filePath || ''),
                    line: 1,
                    inputKey,
                    fieldName,
                    message: `列表查询字段 ${inputKey} 缺少 ${missing.join('、')}；页面 bind 必须对应 Action 的 private String 与 getter/setter。`,
                    allowedSignatures: [
                        `private String ${inputKey};`,
                        `String ${accessor.getter}()`,
                        `void ${accessor.setter}(String ${inputKey})`
                    ]
                });
                continue;
            }
            if (new RegExp(`\\bgetRequestParameter\\s*\\(\\s*["']${escapeRegExp(inputKey)}["']\\s*\\)`, 'u').test(source)) {
                violations.push({
                    code: 'SQL_CONDITION_UTIL_LIST_QUERY_DIRECT_REQUEST_FORBIDDEN',
                    file: String(filePath || ''),
                    line: lineNumberAt(source, source.indexOf(`getRequestParameter("${inputKey}")`)),
                    inputKey,
                    fieldName,
                    message: `列表查询字段 ${inputKey} 禁止直接 getRequestParameter；直接使用 Action 属性 ${inputKey}。`,
                    allowedSignatures: [`${inputKey}.trim()`, accessor.getter]
                });
            }
            if (String(filter && filter.operator || '').trim() === 'contains'
                && filter.implementation !== 'coder'
                && !calls.some(call => call.method === 'like'
                    && String(call.arguments[0] || '').replace(/["']/gu, '').trim() === fieldName
                    && new RegExp(`\\b${escapeRegExp(inputKey)}\\b`, 'u').test(call.arguments[1] || ''))) {
                violations.push({
                    code: 'SQL_CONDITION_UTIL_LIST_QUERY_LIKE_MISSING',
                    file: String(filePath || ''),
                    line: 1,
                    inputKey,
                    fieldName,
                    message: `列表模糊查询字段 ${inputKey} 必须使用 like("${fieldName}", ${inputKey}.trim())。`,
                    allowedSignatures: [`like("${fieldName}", ${inputKey}.trim())`]
                });
            }
        }
        return violations;
    }

    _collectVariables(source = '') {
        const variables = new Set();
        const declaration = /\bSqlConditionUtil\s+([A-Za-z_$][\w$]*)\s*=\s*new\s+SqlConditionUtil\s*\(/gu;
        for (const match of String(source || '').matchAll(declaration)) variables.add(match[1]);
        return Array.from(variables);
    }

    _collectCalls(source = '', variable = '') {
        const text = String(source || '');
        const calls = [];
        const variablePattern = new RegExp(`\\b${escapeRegExp(variable)}\\b`, 'gu');
        for (const match of text.matchAll(variablePattern)) {
            let cursor = match.index + variable.length;
            cursor = skipWhitespace(text, cursor);
            while (text[cursor] === '.') {
                cursor = skipWhitespace(text, cursor + 1);
                const nameMatch = text.slice(cursor).match(/^([A-Za-z_$][\w$]*)/u);
                if (!nameMatch) break;
                const method = nameMatch[1];
                cursor += method.length;
                cursor = skipWhitespace(text, cursor);
                if (text[cursor] !== '(') break;
                const parsed = readParenthesized(text, cursor);
                if (!parsed) break;
                calls.push({
                    method,
                    arguments: splitTopLevelArguments(parsed.content),
                    index: match.index,
                    line: lineNumberAt(text, match.index)
                });
                cursor = skipWhitespace(text, parsed.end);
            }
        }
        return calls;
    }

    _violation(filePath, call, code, message, extra = {}) {
        return {
            code,
            file: String(filePath || ''),
            line: call.line,
            method: call.method,
            message,
            ...extra
        };
    }
}

function escapeRegExp(value = '') {
    return String(value || '').replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

function skipWhitespace(text, index) {
    let cursor = index;
    while (cursor < text.length && /\s/u.test(text[cursor])) cursor += 1;
    return cursor;
}

function readParenthesized(text, openIndex) {
    let depth = 0;
    let quote = '';
    for (let index = openIndex; index < text.length; index += 1) {
        const char = text[index];
        if (quote) {
            if (char === '\\') {
                index += 1;
            } else if (char === quote) {
                quote = '';
            }
            continue;
        }
        if (char === '"' || char === "'") {
            quote = char;
        } else if (char === '(') {
            depth += 1;
        } else if (char === ')') {
            depth -= 1;
            if (depth === 0) return { content: text.slice(openIndex + 1, index), end: index + 1 };
        }
    }
    return null;
}

function splitTopLevelArguments(content = '') {
    const text = String(content || '').trim();
    if (!text) return [];
    const out = [];
    let start = 0;
    let depth = 0;
    let quote = '';
    for (let index = 0; index < text.length; index += 1) {
        const char = text[index];
        if (quote) {
            if (char === '\\') index += 1;
            else if (char === quote) quote = '';
            continue;
        }
        if (char === '"' || char === "'") quote = char;
        else if (char === '(' || char === '[' || char === '{') depth += 1;
        else if (char === ')' || char === ']' || char === '}') depth -= 1;
        else if (char === ',' && depth === 0) {
            out.push(text.slice(start, index).trim());
            start = index + 1;
        }
    }
    out.push(text.slice(start).trim());
    return out;
}

function lineNumberAt(text, index) {
    return text.slice(0, index).split('\n').length;
}

function accessorSpec(inputKey = '') {
    const name = String(inputKey || '');
    const capitalized = name ? `${name.charAt(0).toUpperCase()}${name.slice(1)}` : '';
    return { getter: `get${capitalized}`, setter: `set${capitalized}` };
}

module.exports = DesignTddSqlConditionUtilGuardService;
