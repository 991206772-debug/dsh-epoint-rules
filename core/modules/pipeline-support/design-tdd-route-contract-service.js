/* eslint-disable */
const fs = require('fs');
const path = require('path');

function uniqueNonEmptyStrings(values = []) {
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

class DesignTddRouteContractService {
    buildContracts({ projectPath = '', candidateFiles = [] } = {}) {
        const normalizedProject = String(projectPath || '').trim() ? path.resolve(String(projectPath || '').trim()) : '';
        const files = (Array.isArray(candidateFiles) ? candidateFiles : [])
            .map(file => this._normalizeCandidateFile(file, normalizedProject))
            .filter(Boolean);
        const htmlFiles = files.filter(file => file.fileKind === 'HtmlPage' && this._isReadableFile(file.resolvedPath));
        const actionFiles = files.filter(file => file.fileKind === 'Action' && this._isReadableFile(file.resolvedPath));
        if (htmlFiles.length === 0 || actionFiles.length === 0) return [];

        const actionSummaries = this._dedupeActionSummaries(actionFiles.map(file => this._summarizeActionFile(file)).filter(Boolean));
        const out = [];
        for (const htmlFile of htmlFiles) {
            const htmlText = fs.readFileSync(htmlFile.resolvedPath, 'utf-8');
            const defaultActionName = this._resolveDefaultActionName(htmlText, actionSummaries);
            const frontendCalls = this.collectFrontendCalls(htmlText);
            const actionNames = uniqueNonEmptyStrings(actionSummaries.map(item => item.actionName));
            const explicitActionCandidates = actionSummaries.filter(item => item.actionName && item.actionName !== defaultActionName);
            out.push({
                htmlPage: htmlFile.resolvedPath,
                storyIds: uniqueNonEmptyStrings([htmlFile.storyId, htmlFile.sourceStoryId]),
                defaultActionName,
                candidateActions: actionSummaries,
                actionNames,
                explicitActionRequired: !!(defaultActionName && explicitActionCandidates.length > 0),
                allowedExecuteForms: this._buildAllowedExecuteForms({ defaultActionName, actionSummaries }),
                forbiddenExecuteForms: explicitActionCandidates.map(action => ({
                    actionName: action.actionName,
                    reason: `方法写在 ${action.actionName} 时，页面不能裸写 epoint.execute('method')，必须写 ${action.actionName}/method。`
                })),
                frontendCalls
            });
        }
        return out;
    }

    validate({ projectPath = '', candidateFiles = [], routeContracts = null } = {}) {
        const normalizedProject = String(projectPath || '').trim() ? path.resolve(String(projectPath || '').trim()) : '';
        const files = (Array.isArray(candidateFiles) ? candidateFiles : [])
            .map(file => this._normalizeCandidateFile(file, normalizedProject))
            .filter(Boolean);
        const contracts = Array.isArray(routeContracts) && routeContracts.length > 0
            ? routeContracts
            : this.buildContracts({ projectPath: normalizedProject, candidateFiles: files });
        const actionFiles = files.filter(file => file.fileKind === 'Action' && this._isReadableFile(file.resolvedPath));
        const actionSummaries = this._mergeActionSummaries([
            ...actionFiles.map(file => this._summarizeActionFile(file)).filter(Boolean),
            ...this._collectContractActionSummaries(contracts)
        ]);
        const actionMethodsByName = new Map();
        const actionMethodDetailsByName = new Map();
        for (const action of actionSummaries) {
            if (action.actionName) actionMethodsByName.set(action.actionName, new Set(action.methods || []));
            if (action.actionName) actionMethodDetailsByName.set(action.actionName, action.methodDetails || {});
        }
        const issues = [];
        for (const contract of contracts) {
            const htmlPage = String(contract && contract.htmlPage || '').trim();
            const resolvedHtml = this._resolveInsideProject(normalizedProject, htmlPage);
            if (!resolvedHtml || !this._isReadableFile(resolvedHtml)) continue;
            const htmlText = fs.readFileSync(resolvedHtml, 'utf-8');
            const defaultActionName = this._normalizeActionName(contract.defaultActionName || this._resolveDefaultActionName(htmlText, actionSummaries));
            const calls = this.collectFrontendCalls(htmlText);
            for (const call of calls) {
                const isNewFrontendCall = this._isNewFrontendCall(contract, call);
                const target = this.resolveCallTarget(call.raw, defaultActionName);
                if (call.type === 'epoint_call' && isNewFrontendCall && call.paramsShape === 'object') {
                    issues.push(this._buildIssue({
                        code: 'EPOINT_EXECUTE_OBJECT_PARAMS_FORBIDDEN',
                        htmlPage: resolvedHtml,
                        call,
                        methodName: target.methodName,
                        defaultActionName,
                        requiredActionName: target.actionName,
                        actionSummaries,
                        blocking: true,
                        allowedParameterForms: ['标量', '[arg1, arg2]'],
                        message: `HtmlPage 调用 "${call.raw}" 的第三参是对象字面量。epoint.execute 只允许按 Java public 方法形参顺序传标量或 [arg1, arg2]；对象参数会丢失位置与参数数量，不能调用。`
                    }));
                    continue;
                }
                if (call.type === 'epoint_call' && isNewFrontendCall && target.isDotAction === true) {
                    issues.push(this._buildIssue({
                        code: 'EPOINT_EXECUTE_CROSS_ACTION_DOT_FORBIDDEN',
                        htmlPage: resolvedHtml,
                        call,
                        methodName: target.methodName,
                        defaultActionName,
                        requiredActionName: target.actionName,
                        actionSummaries,
                        blocking: true,
                        allowedParameterForms: [`${target.actionName}/${target.methodName}`],
                        message: `HtmlPage 跨 Action 调用 "${call.raw}" 使用了点号。请改为 "${target.actionName}/${target.methodName}"；epoint.execute 不接受 xxxaction.method 作为跨 Action 路由。`
                    }));
                    continue;
                }
                if (!target.methodName) continue;
                if (!target.actionName) {
                    issues.push(this._buildIssue({
                        code: 'DESIGN_TDD_ACTION_ROUTE_UNKNOWN',
                        htmlPage: resolvedHtml,
                        call,
                        methodName: target.methodName,
                        defaultActionName,
                        actionSummaries,
                        message: `HtmlPage 调用了 "${call.raw}"，但页面没有 epoint.initPage 默认 Action，无法判断裸方法路由。`
                    }));
                    continue;
                }
                const methods = actionMethodsByName.get(target.actionName);
                if (!methods) {
                    if (target.isBare === true && isNewFrontendCall) {
                        const alternativeActions = this._findAlternativeActions({
                            actionSummaries,
                            defaultActionName,
                            methodName: target.methodName
                        });
                        if (alternativeActions.length > 0) {
                            issues.push(this._buildIssue({
                                code: 'DESIGN_TDD_ACTION_BARE_CALL_AMBIGUOUS',
                                htmlPage: resolvedHtml,
                                call,
                                methodName: target.methodName,
                                defaultActionName,
                                requiredActionName: alternativeActions[0].actionName,
                                actionSummaries,
                                message: `HtmlPage 本次新增裸调用 "${call.raw}" 会路由到默认 Action ${defaultActionName}；候选 Action ${alternativeActions[0].actionName} 也存在同名方法。若业务目标是候选 Action，请写 "${alternativeActions[0].actionName}/${target.methodName}"；若目标是产品默认 Action，可保留裸调用。`
                            }));
                            continue;
                        }
                    }
                    issues.push(this._buildIssue({
                        code: 'DESIGN_TDD_ACTION_ROUTE_NOT_CANDIDATE',
                        htmlPage: resolvedHtml,
                        call,
                        methodName: target.methodName,
                        defaultActionName,
                        requiredActionName: target.actionName,
                        actionSummaries,
                        message: `HtmlPage 调用了 "${call.raw}"，目标 Action ${target.actionName} 不在候选 Action 文件中。`
                    }));
                    continue;
                }
                if (!methods.has(target.methodName)) {
                    if (target.isBare === true) {
                        const alternativeActions = this._findAlternativeActions({
                            actionSummaries,
                            defaultActionName,
                            methodName: target.methodName
                        });
                        if (alternativeActions.length > 0 && isNewFrontendCall) {
                            issues.push(this._buildIssue({
                                code: 'DESIGN_TDD_ACTION_BARE_CALL_AMBIGUOUS',
                                htmlPage: resolvedHtml,
                                call,
                                methodName: target.methodName,
                                defaultActionName,
                                requiredActionName: alternativeActions[0].actionName,
                                actionSummaries,
                                message: `HtmlPage 本次新增裸调用 "${call.raw}" 会路由到默认 Action ${defaultActionName}；候选 Action ${alternativeActions[0].actionName} 也存在同名方法。若业务目标是候选 Action，请写 "${alternativeActions[0].actionName}/${target.methodName}"；若目标是默认 Action，可保留裸调用。`
                            }));
                            continue;
                        }
                    }
                    issues.push(this._buildIssue({
                        code: 'DESIGN_TDD_ACTION_METHOD_NOT_FOUND',
                        htmlPage: resolvedHtml,
                        call,
                        methodName: target.methodName,
                        defaultActionName,
                        requiredActionName: target.actionName,
                        actionSummaries,
                        message: `HtmlPage 调用了 "${call.raw}"，但 ${target.actionName} 中未找到 public ${target.methodName}(...).`
                    }));
                    continue;
                }
                if (call.type === 'epoint_call') {
                    const methodDetails = actionMethodDetailsByName.get(target.actionName) || {};
                    const method = methodDetails[target.methodName] || {};
                    if (isNewFrontendCall && method.parameterCount > 1 && call.paramsShape !== 'array') {
                        issues.push(this._buildIssue({
                            code: 'EPOINT_EXECUTE_PARAMS_ARRAY_REQUIRED',
                            htmlPage: resolvedHtml,
                            call,
                            methodName: target.methodName,
                            defaultActionName,
                            requiredActionName: target.actionName,
                            actionSummaries,
                            blocking: true,
                            allowedParameterForms: ['[arg1, arg2]'],
                            message: `HtmlPage 调用 "${call.raw}" 对应 ${target.actionName}.public ${target.methodName}(...) 有 ${method.parameterCount} 个 Java 形参；第三参必须传 Array，并按 Java 形参顺序填写，例如 [arg1, arg2]。`
                        }));
                        continue;
                    }
                    if (isNewFrontendCall && Number.isInteger(method.parameterCount) && call.paramCount !== undefined
                        && call.paramCount !== method.parameterCount) {
                        issues.push(this._buildIssue({
                            code: 'DESIGN_TDD_ACTION_PARAM_COUNT_MISMATCH',
                            htmlPage: resolvedHtml,
                            call,
                            methodName: target.methodName,
                            defaultActionName,
                            requiredActionName: target.actionName,
                            actionSummaries,
                            blocking: true,
                            message: `HtmlPage 调用 "${call.raw}" 传参个数为 ${call.paramCount}，但 ${target.actionName}.public ${target.methodName}(...) 需要 ${method.parameterCount} 个参数；请按 Java public 方法形参顺序传 Array。`
                        }));
                        continue;
                    }
                }
            }
        }
        return {
            ok: issues.length === 0,
            checked: true,
            issueCount: issues.length,
            blockingIssueCount: issues.filter(issue => issue && issue.blocking === true).length,
            issues
        };
    }

    collectFrontendCalls(htmlText = '') {
        const calls = [];
        const source = String(htmlText || '');
        const actionAttrRe = /\baction\s*=\s*["']([^"']+)["']/giu;
        let match;
        while ((match = actionAttrRe.exec(source)) !== null) {
            const value = String(match[1] || '').trim();
            if (value && !this._isIgnoredActionValue(value)) {
                calls.push({ type: 'action_attr', raw: value, line: this._lineAt(source, match.index) });
            }
        }
        const executeRe = /\bepoint\.execute\s*\(/giu;
        while ((match = executeRe.exec(source)) !== null) {
            const openParenIndex = match.index + match[0].length - 1;
            const parsed = this._readParenthesized(source, openParenIndex);
            if (!parsed) continue;
            executeRe.lastIndex = parsed.endIndex + 1;
            const args = this._splitTopLevelArgs(parsed.body);
            const value = this._readStringArgument(args[0]);
            if (!value || this._isIgnoredActionValue(value)) continue;
            const parameter = this._describeExecuteParameters(args);
            calls.push({
                type: 'epoint_call',
                raw: value,
                ids: this._readStringArgument(args[1]) || String(args[1] || '').trim(),
                ...parameter,
                argumentCount: args.length,
                line: this._lineAt(source, match.index)
            });
        }
        return this._dedupeFrontendCalls(calls);
    }

    _readParenthesized(source = '', openParenIndex = -1) {
        const input = String(source || '');
        if (openParenIndex < 0 || input[openParenIndex] !== '(') return null;
        let depth = 0;
        let quote = '';
        for (let i = openParenIndex; i < input.length; i += 1) {
            const ch = input[i];
            if (quote) {
                if (ch === quote && !this._isEscaped(input, i)) quote = '';
                continue;
            }
            if (ch === '\'' || ch === '"' || ch === '`') {
                quote = ch;
                continue;
            }
            if (ch === '(') depth += 1;
            if (ch === ')') {
                depth -= 1;
                if (depth === 0) {
                    return { body: input.slice(openParenIndex + 1, i), endIndex: i };
                }
            }
        }
        return null;
    }

    _describeExecuteParameters(args = []) {
        const thirdArg = String((Array.isArray(args) ? args : [])[2] || '').trim();
        if (!thirdArg || this._isCallbackArgument(thirdArg)) return { paramsShape: 'none', paramCount: 0 };
        if (/^\{[\s\S]*\}$/u.test(thirdArg)) return { paramsShape: 'object', paramCount: 1 };
        if (/^\[[\s\S]*\]$/u.test(thirdArg)) {
            const body = thirdArg.slice(1, -1).trim();
            return {
                paramsShape: 'array',
                paramCount: body ? this._splitTopLevelArgs(body).length : 0
            };
        }
        return { paramsShape: 'scalar', paramCount: 1 };
    }

    _isCallbackArgument(value = '') {
        const text = String(value || '').trim();
        return /^function\b/u.test(text) || /^(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/u.test(text);
    }

    _readStringArgument(value = '') {
        const text = String(value || '').trim();
        const match = /^(['"])([\s\S]*)\1$/u.exec(text);
        return match ? String(match[2] || '').trim() : '';
    }

    _dedupeFrontendCalls(calls = []) {
        const out = [];
        const seen = new Set();
        for (const call of (Array.isArray(calls) ? calls : [])) {
            const key = [
                String(call && call.type || '').trim(),
                String(call && call.raw || '').trim(),
                String(call && call.ids || '').trim(),
                String(call && call.paramsShape || '').trim(),
                call && call.paramCount !== undefined ? String(call.paramCount) : ''
            ].join('::');
            if (seen.has(key)) continue;
            seen.add(key);
            out.push(call);
        }
        return out;
    }

    _lineAt(source = '', index = 0) {
        return String(source || '').slice(0, Math.max(0, Number(index) || 0)).split(/\r?\n/u).length;
    }

    _isEscaped(input = '', index = 0) {
        let slashCount = 0;
        for (let cursor = Number(index) - 1; cursor >= 0 && input[cursor] === '\\'; cursor -= 1) slashCount += 1;
        return slashCount % 2 === 1;
    }

    _splitTopLevelArgs(text = '') {
        const out = [];
        let current = '';
        let depth = 0;
        let quote = '';
        const input = String(text || '');
        for (let i = 0; i < input.length; i += 1) {
            const ch = input[i];
            const prev = input[i - 1];
            if (quote) {
                current += ch;
                if (ch === quote && prev !== '\\') quote = '';
                continue;
            }
            if (ch === '\'' || ch === '"' || ch === '`') {
                quote = ch;
                current += ch;
                continue;
            }
            if (ch === '(' || ch === '[' || ch === '{') depth += 1;
            if (ch === ')' || ch === ']' || ch === '}') depth = Math.max(0, depth - 1);
            if (ch === ',' && depth === 0) {
                out.push(current.trim());
                current = '';
                continue;
            }
            current += ch;
        }
        if (current.trim()) out.push(current.trim());
        return out;
    }

    _isNewFrontendCall(contract = {}, call = {}) {
        if (!Array.isArray(contract && contract.frontendCalls)) return false;
        const currentKey = this._frontendCallKey(call);
        return !contract.frontendCalls.some(item => this._frontendCallKey(item) === currentKey);
    }

    _frontendCallKey(call = {}) {
        return [
            String(call && call.type || '').trim(),
            String(call && call.raw || '').trim(),
            String(call && call.ids || '').trim(),
            String(call && call.paramsShape || '').trim(),
            call && call.paramCount !== undefined ? String(call.paramCount) : ''
        ].join('::');
    }

    resolveCallTarget(rawCall = '', defaultActionName = '') {
        const raw = String(rawCall || '').trim();
        if (!raw) return { actionName: '', methodName: '', isBare: true, isDotAction: false };
        const noQuery = raw.split('?')[0].split('#')[0].trim();
        const parts = noQuery.split('/').map(item => item.trim()).filter(Boolean);
        if (parts.length >= 2) {
            return {
                actionName: this._normalizeActionName(parts[parts.length - 2]),
                methodName: parts[parts.length - 1],
                isBare: false,
                isDotAction: false
            };
        }
        const dotMatch = /^([A-Za-z_$][\w$]*action)\.([A-Za-z_$][\w$]*)$/iu.exec(noQuery);
        if (dotMatch) {
            return {
                actionName: this._normalizeActionName(dotMatch[1]),
                methodName: dotMatch[2],
                isBare: false,
                isDotAction: true
            };
        }
        return {
            actionName: this._normalizeActionName(defaultActionName),
            methodName: parts.length === 1 ? parts[0] : noQuery,
            isBare: true,
            isDotAction: false
        };
    }

    _buildAllowedExecuteForms({ defaultActionName = '', actionSummaries = [] } = {}) {
        const out = [];
        for (const action of (Array.isArray(actionSummaries) ? actionSummaries : [])) {
            const actionName = String(action && action.actionName || '').trim();
            if (!actionName) continue;
            if (actionName === defaultActionName) {
                out.push({
                    actionName,
                    form: "epoint.execute('methodName')",
                    reason: '裸方法会路由到页面 initPage 默认 Action。'
                });
            } else {
                out.push({
                    actionName,
                    form: `epoint.execute('${actionName}/methodName')`,
                    reason: '目标 Action 不是页面 initPage 默认 Action，必须显式指定 action/method。'
                });
            }
        }
        return out;
    }

    _findAlternativeActions({ actionSummaries = [], defaultActionName = '', methodName = '' } = {}) {
        const expectedMethod = String(methodName || '').trim();
        if (!expectedMethod) return [];
        return (Array.isArray(actionSummaries) ? actionSummaries : [])
            .filter(action => {
                const actionName = String(action && action.actionName || '').trim();
                return actionName && actionName !== defaultActionName;
            })
            .filter(action => (Array.isArray(action && action.methods) ? action.methods : [])
                .some(method => String(method || '').trim() === expectedMethod));
    }

    _collectContractActionSummaries(contracts = []) {
        const out = [];
        for (const contract of (Array.isArray(contracts) ? contracts : [])) {
            for (const action of (Array.isArray(contract && contract.candidateActions) ? contract.candidateActions : [])) {
                const actionName = this._normalizeActionName(action && action.actionName);
                const actionPath = String(action && (action.path || action.resolvedPath || action.filePath) || '').trim();
                if (!actionName && !actionPath) continue;
                out.push({
                    fileKind: 'Action',
                    path: actionPath,
                    actionName,
                    methods: Array.isArray(action && action.methods)
                        ? action.methods.map(item => String(item || '').trim()).filter(Boolean)
                        : [],
                    methodDetails: action && action.methodDetails && typeof action.methodDetails === 'object'
                        ? action.methodDetails
                        : {}
                });
            }
        }
        return out;
    }

    _mergeActionSummaries(actionSummaries = []) {
        const byKey = new Map();
        for (const action of (Array.isArray(actionSummaries) ? actionSummaries : [])) {
            const normalized = this._normalizeActionSummary(action);
            if (!normalized) continue;
            const key = normalized.actionName || (normalized.path ? path.resolve(normalized.path).toLowerCase() : '');
            if (!key) continue;
            const existing = byKey.get(key);
            byKey.set(key, existing ? this._mergeActionSummary(existing, normalized) : normalized);
        }
        return Array.from(byKey.values());
    }

    _normalizeActionSummary(action = {}) {
        const actionName = this._normalizeActionName(action && action.actionName);
        const actionPath = String(action && (action.path || action.resolvedPath || action.filePath) || '').trim();
        const methods = uniqueNonEmptyStrings(Array.isArray(action && action.methods) ? action.methods : []);
        const methodDetails = action && action.methodDetails && typeof action.methodDetails === 'object'
            ? action.methodDetails
            : {};
        if (!actionName && !actionPath && methods.length === 0) return null;
        return {
            fileKind: 'Action',
            path: actionPath,
            actionName,
            methods,
            methodDetails
        };
    }

    _mergeActionSummary(left = {}, right = {}) {
        return {
            fileKind: 'Action',
            path: String(left.path || right.path || '').trim(),
            actionName: String(left.actionName || right.actionName || '').trim(),
            methods: uniqueNonEmptyStrings([
                ...(Array.isArray(left.methods) ? left.methods : []),
                ...(Array.isArray(right.methods) ? right.methods : [])
            ]),
            methodDetails: {
                ...(right.methodDetails && typeof right.methodDetails === 'object' ? right.methodDetails : {}),
                ...(left.methodDetails && typeof left.methodDetails === 'object' ? left.methodDetails : {})
            }
        };
    }

    _buildIssue({ code, htmlPage, call, methodName, defaultActionName = '', requiredActionName = '', actionSummaries = [], message = '', blocking = false, allowedParameterForms = [] } = {}) {
        const candidates = this._dedupeActionSummaries(actionSummaries);
        const relatedCandidates = blocking === true
            ? candidates.filter(action => {
                const actionName = String(action && action.actionName || '').trim();
                return actionName && (actionName === requiredActionName || actionName === defaultActionName);
            }).map(action => this._summarizeIssueActionCandidate(action, methodName))
            : [];
        return {
            code,
            htmlPage,
            frontendCall: call && call.raw || '',
            callType: call && call.type || '',
            ...(call && call.line !== undefined ? { line: call.line } : {}),
            ...(call && call.ids !== undefined ? { frontendIds: call.ids } : {}),
            ...(call && call.paramsShape ? { frontendParamsShape: call.paramsShape } : {}),
            ...(call && call.paramCount !== undefined ? { frontendParamCount: call.paramCount } : {}),
            methodName,
            defaultActionName,
            requiredActionName,
            blocking: blocking === true,
            candidateActionNames: uniqueNonEmptyStrings(candidates.map(action => action && action.actionName)),
            ...(relatedCandidates.length > 0 ? { actionCandidates: relatedCandidates } : {}),
            ...(allowedParameterForms.length > 0 ? { allowedParameterForms } : {}),
            message
        };
    }

    _dedupeActionSummaries(actionSummaries = []) {
        const out = [];
        const seen = new Set();
        for (const action of (Array.isArray(actionSummaries) ? actionSummaries : [])) {
            const resolved = String(action && action.path || '').trim();
            const key = resolved ? path.resolve(resolved).toLowerCase() : String(action && action.actionName || '').trim().toLowerCase();
            if (!key || seen.has(key)) continue;
            seen.add(key);
            out.push(action);
        }
        return out;
    }

    _summarizeIssueActionCandidate(action = {}, methodName = '') {
        const methods = Array.from(action && action.methods || []).sort();
        const methodDetails = action && action.methodDetails && typeof action.methodDetails === 'object'
            ? action.methodDetails
            : {};
        const detail = methodName && methodDetails[methodName] ? methodDetails[methodName] : null;
        return {
            path: action.path,
            actionName: action.actionName,
            methods,
            ...(detail ? { methodDetail: detail } : {})
        };
    }

    _summarizeActionFile(file = {}) {
        const resolvedPath = String(file && file.resolvedPath || '').trim();
        if (!resolvedPath || !this._isReadableFile(resolvedPath)) return null;
        const text = fs.readFileSync(resolvedPath, 'utf-8');
        const actionName = this._extractActionName(text) || this._inferActionNameFromPath(resolvedPath);
        return {
            fileKind: 'Action',
            path: resolvedPath,
            actionName,
            methods: this._collectActionMethods(text),
            methodDetails: this._collectActionMethodDetails(text)
        };
    }

    _extractDefaultActionName(htmlText = '') {
        const match = /\bepoint\.initPage\s*\(\s*["']([^"']+)["']/iu.exec(String(htmlText || ''));
        return match ? this._normalizeActionName(match[1]) : '';
    }

    _resolveDefaultActionName(htmlText = '', actionSummaries = []) {
        const explicit = this._extractDefaultActionName(htmlText);
        if (explicit) return explicit;
        const actionNames = uniqueNonEmptyStrings((Array.isArray(actionSummaries) ? actionSummaries : [])
            .map(action => action && action.actionName));
        return actionNames.length === 1 ? actionNames[0] : '';
    }

    _extractActionName(javaText = '') {
        const text = String(javaText || '');
        const rest = /@RestController\s*\(\s*["']([^"']+)["']\s*\)/u.exec(text);
        if (rest) return this._normalizeActionName(rest[1]);
        const ctrl = /@Controller\s*\(\s*["']([^"']+)["']\s*\)/u.exec(text);
        if (ctrl) return this._normalizeActionName(ctrl[1]);
        return '';
    }

    _inferActionNameFromPath(filePath = '') {
        const base = path.basename(String(filePath || ''), path.extname(String(filePath || '')));
        if (!base) return '';
        return this._normalizeActionName(base
            .replace(/^Gxh/u, 'gxh')
            .replace(/Action$/u, 'action')
            .replace(/^[A-Z]/u, c => c.toLowerCase()));
    }

    _normalizeActionName(value = '') {
        return String(value || '').trim().toLowerCase();
    }

    _collectActionMethods(javaText = '') {
        const methods = new Set();
        const methodRe = /\bpublic\s+(?:<[^>]+>\s*)?(?:[\w$<>\[\],.?]+\s+)+([A-Za-z_$][\w$]*)\s*\(/gu;
        let match;
        while ((match = methodRe.exec(String(javaText || ''))) !== null) {
            const methodName = String(match[1] || '').trim();
            if (methodName && methodName !== 'class' && methodName !== 'interface') methods.add(methodName);
        }
        return Array.from(methods);
    }

    _collectActionMethodDetails(javaText = '') {
        const out = {};
        const methodRe = /\bpublic\s+(?:<[^>]+>\s*)?(?:[\w$<>\[\],.?]+\s+)+([A-Za-z_$][\w$]*)\s*\(([^)]*)\)/gu;
        let match;
        while ((match = methodRe.exec(String(javaText || ''))) !== null) {
            const methodName = String(match[1] || '').trim();
            if (!methodName || methodName === 'class' || methodName === 'interface') continue;
            const paramsText = String(match[2] || '').trim();
            const params = paramsText
                ? paramsText.split(',').map(item => String(item || '').trim()).filter(Boolean)
                : [];
            out[methodName] = {
                parameterCount: params.length,
                parameters: params
            };
        }
        return out;
    }

    _normalizeCandidateFile(file = {}, projectPath = '') {
        const fileKind = String(file && file.fileKind || '').trim();
        const rawPath = String(file && (file.resolvedPath || file.path || file.filePath) || '').trim();
        const resolvedPath = this._resolveInsideProject(projectPath, rawPath);
        if (!fileKind || !resolvedPath) return null;
        return {
            fileKind,
            resolvedPath,
            storyId: String(file && file.storyId || '').trim(),
            sourceStoryId: String(file && file.sourceStoryId || '').trim()
        };
    }

    _resolveInsideProject(projectPath = '', rawPath = '') {
        const root = String(projectPath || '').trim() ? path.resolve(String(projectPath || '').trim()) : '';
        const input = String(rawPath || '').trim();
        if (!input || input.includes('\0')) return '';
        const resolved = path.isAbsolute(input) ? path.resolve(input) : (root ? path.resolve(root, input) : path.resolve(input));
        return !root || this._isSameOrChild(resolved, root) ? resolved : '';
    }

    _isIgnoredActionValue(value = '') {
        const text = String(value || '').trim();
        if (!text) return true;
        if (/^(?:http|https|javascript|mailto):/iu.test(text)) return true;
        if (/^\$\{.*\}$/u.test(text)) return true;
        if (/[{}]/u.test(text)) return true;
        return false;
    }

    _isReadableFile(filePath = '') {
        try {
            return filePath && fs.existsSync(filePath) && fs.statSync(filePath).isFile();
        } catch (_) {
            return false;
        }
    }

    _isSameOrChild(child = '', parent = '') {
        const c = path.resolve(child);
        const p = path.resolve(parent);
        const cc = process.platform === 'win32' ? c.toLowerCase() : c;
        const pp = process.platform === 'win32' ? p.toLowerCase() : p;
        return cc === pp || cc.startsWith(pp + path.sep);
    }
}

module.exports = DesignTddRouteContractService;
