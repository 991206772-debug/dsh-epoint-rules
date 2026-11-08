/* eslint-disable */
const fs = require('fs');
const path = require('path');

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

class DesignTddJavaCallClosureService {
    validate({ projectPath = '', evidenceFile = '' } = {}) {
        const normalizedProject = String(projectPath || '').trim() ? path.resolve(projectPath) : '';
        const javaFile = String(evidenceFile || '').trim() ? path.resolve(evidenceFile) : '';
        if (!normalizedProject || !javaFile || path.extname(javaFile).toLowerCase() !== '.java') {
            return { ok: true, checked: false, skipped: true, reason: 'not_java_evidence' };
        }
        if (!this._isSameOrChild(javaFile, normalizedProject) || !fs.existsSync(javaFile)) {
            return { ok: true, checked: false, skipped: true, reason: 'java_evidence_unreadable_or_outside_project' };
        }
        let source = '';
        try {
            source = fs.readFileSync(javaFile, 'utf-8');
        } catch (_) {
            return { ok: true, checked: false, skipped: true, reason: 'java_evidence_read_failed' };
        }
        const variableTypes = this._collectVariableTypes(source);
        const surfaceIndex = this._buildMethodSurfaceIndex(normalizedProject);
        const rawCalls = this._collectReceiverCalls(source);
        const calls = rawCalls
            .map(call => {
                const variableType = variableTypes.get(call.receiver);
                if (variableType) {
                    return { ...call, typeName: variableType, callKind: 'receiver' };
                }
                if (/^[A-Z]\w*$/u.test(call.receiver)) {
                    const staticSurface = this._resolveSurface(surfaceIndex, call.receiver);
                    if (staticSurface) {
                        return { ...call, typeName: call.receiver, callKind: 'staticClass' };
                    }
                }
                return null;
            })
            .filter(Boolean);
        const issues = [];
        const warnings = [];
        for (const call of calls) {
            const typeName = call.typeName;
            const surface = this._resolveSurface(surfaceIndex, typeName);
            if (!surface) {
                warnings.push({
                    code: 'DESIGN_TDD_JAVA_CALL_SURFACE_UNKNOWN',
                    receiver: call.receiver,
                    typeName,
                    methodName: call.methodName,
                    line: call.line,
                    message: `无法确认 ${typeName} 的方法表，跳过 ${call.receiver}.${call.methodName}(...) 闭合阻断。`
                });
                continue;
            }
            if (this._isJavaObjectMethod(call.methodName)) {
                continue;
            }
            if (!surface.methodNames.has(call.methodName)) {
                const serviceTriadInfo = this._serviceTriadInfoForType(normalizedProject, surface.ownerName || typeName);
                warnings.push({
                    code: 'DESIGN_TDD_JAVA_METHOD_NOT_FOUND',
                    severity: 'warning',
                    blocking: false,
                    receiver: call.receiver,
                    typeName: surface.ownerName || typeName,
                    methodName: call.methodName,
                    line: call.line,
                    sourcePath: surface.sourcePath || '',
                    ...serviceTriadInfo,
                    availableMethods: Array.from(surface.methodNames).slice(0, 30),
                    availableSignatures: surface.methodSignatures.slice(0, 12),
                    callKind: call.callKind,
                    message: serviceTriadInfo && serviceTriadInfo.serviceTriadRequired
                        ? `Java 调用了 ${call.receiver}.${call.methodName}(...), 但 ${surface.ownerName || typeName} 的真实方法表中没有 ${call.methodName}；这是当前项目 Service 三层方法闭合问题，必须按 ServiceApi/ServiceImpl/ServiceInternal 同名同参补齐，不允许绕到 Job/DAO/ServiceInternal 规避。`
                        : `Java 调用了 ${call.receiver}.${call.methodName}(...), 但 ${surface.ownerName || typeName} 的真实方法表中没有 ${call.methodName}；按第一原则必须先读规则原文/API 菜单或真实源码确认方法名，禁止凭通用命名猜。`
                });
                continue;
            }
            const strictArities = surface.strictMethodArities && surface.strictMethodArities.get(call.methodName);
            if (
                strictArities
                && strictArities.size > 0
                && Number.isInteger(call.argCount)
                && !strictArities.has(call.argCount)
            ) {
                const signatures = this._signaturesForMethod(surface, call.methodName);
                warnings.push({
                    code: 'DESIGN_TDD_JAVA_METHOD_SIGNATURE_NOT_FOUND',
                    severity: 'warning',
                    blocking: false,
                    receiver: call.receiver,
                    typeName: surface.ownerName || typeName,
                    methodName: call.methodName,
                    line: call.line,
                    argCount: call.argCount,
                    sourcePath: surface.sourcePath || '',
                    expectedArgCounts: Array.from(strictArities),
                    availableMethods: Array.from(surface.methodNames).slice(0, 30),
                    availableSignatures: signatures.slice(0, 12),
                    callKind: call.callKind,
                    message: `Java 调用了 ${call.receiver}.${call.methodName}(...) 且参数个数为 ${call.argCount}，但 ${surface.ownerName || typeName} 已知签名只允许：${signatures.map(item => item.signature || item.name).filter(Boolean).join('；') || Array.from(strictArities).join('/') + ' 个参数'}。`
                });
            }
        }
        const serviceTriadCheck = this._validateServiceTriadClosure({
            projectPath: normalizedProject,
            evidenceFile: javaFile
        });
        issues.push(...array(serviceTriadCheck && serviceTriadCheck.issues));
        warnings.push(...array(serviceTriadCheck && serviceTriadCheck.warnings));
        const prioritizedWarnings = this._prioritizeWarnings(warnings);
        return {
            ok: issues.length === 0,
            checked: true,
            issueCount: issues.length,
            blockingIssueCount: issues.length,
            warningCount: prioritizedWarnings.length,
            issues,
            warnings: prioritizedWarnings.slice(0, 8)
        };
    }

    _prioritizeWarnings(warnings = []) {
        const list = Array.isArray(warnings) ? warnings : [];
        const score = warning => {
            const code = String(warning && warning.code || '');
            if (code === 'DESIGN_TDD_JAVA_METHOD_NOT_FOUND') return 0;
            if (code === 'DESIGN_TDD_JAVA_METHOD_SIGNATURE_NOT_FOUND') return 1;
            if (warning && warning.serviceTriadRequired === true) return 2;
            if (code === 'DESIGN_TDD_JAVA_CALL_SURFACE_UNKNOWN') return 9;
            return 5;
        };
        return [...list].sort((a, b) => score(a) - score(b));
    }

    _validateServiceTriadClosure({ projectPath = '', evidenceFile = '' } = {}) {
        const evidenceKind = this._serviceLayerKindFromPath(evidenceFile);
        if (!evidenceKind) return { checked: false, issues: [], warnings: [] };
        const baseName = this._serviceTriadBaseName(evidenceFile, evidenceKind);
        if (!baseName) return { checked: false, issues: [], warnings: [] };
        const triad = this._collectServiceTriadFiles(projectPath, baseName, evidenceFile, evidenceKind);
        const issues = [];
        const warnings = [];
        const expectedFiles = {
            ServiceApi: `I${baseName}Service.java`,
            ServiceInternal: `${baseName}Service.java`,
            ServiceImpl: `${baseName}ServiceImpl.java`
        };
        Object.keys(expectedFiles).forEach(kind => {
            if (!triad[kind]) {
                issues.push({
                    code: 'DESIGN_TDD_SERVICE_TRIAD_FILE_MISSING',
                    layer: kind,
                    baseName,
                    expectedFileName: expectedFiles[kind],
                    evidenceFile,
                    message: `Service 三层闭合缺少 ${kind} 文件：${expectedFiles[kind]}。`
                });
            }
        });
        if (issues.length > 0) return { checked: true, issues, warnings };

        const apiSource = this._readText(triad.ServiceApi);
        const internalSource = this._readText(triad.ServiceInternal);
        const implSource = this._readText(triad.ServiceImpl);
        const apiMethods = this._extractJavaMethodSignatures(apiSource, expectedFiles.ServiceApi);
        const internalMethods = this._extractJavaMethodSignatures(internalSource, expectedFiles.ServiceInternal);
        const implMethods = this._extractJavaMethodSignatures(implSource, expectedFiles.ServiceImpl);
        const internalKeys = new Set(internalMethods.map(method => method.key));
        const implKeys = new Set(implMethods.map(method => method.key));
        for (const method of apiMethods) {
            if (!implKeys.has(method.key)) {
                issues.push({
                    code: 'DESIGN_TDD_SERVICE_TRIAD_METHOD_MISSING',
                    layer: 'ServiceImpl',
                    baseName,
                    methodName: method.name,
                    methodKey: method.key,
                    sourcePath: triad.ServiceImpl,
                    apiPath: triad.ServiceApi,
                    internalPath: triad.ServiceInternal,
                    message: `Service 三层未闭合：${expectedFiles.ServiceApi} 声明 ${method.key}，但 ${expectedFiles.ServiceImpl} 未实现。`
                });
            }
            if (!internalKeys.has(method.key)) {
                issues.push({
                    code: 'DESIGN_TDD_SERVICE_TRIAD_METHOD_MISSING',
                    layer: 'ServiceInternal',
                    baseName,
                    methodName: method.name,
                    methodKey: method.key,
                    sourcePath: triad.ServiceInternal,
                    apiPath: triad.ServiceApi,
                    implPath: triad.ServiceImpl,
                    message: `Service 三层未闭合：${expectedFiles.ServiceApi} 声明 ${method.key}，但 ${expectedFiles.ServiceInternal} 未实现。`
                });
            }
            if (implKeys.has(method.key) && !this._serviceImplDelegatesToInternal(implSource, baseName, method.name)) {
                issues.push({
                    code: 'DESIGN_TDD_SERVICE_IMPL_DELEGATION_MISSING',
                    layer: 'ServiceImpl',
                    baseName,
                    methodName: method.name,
                    methodKey: method.key,
                    sourcePath: triad.ServiceImpl,
                    internalPath: triad.ServiceInternal,
                    message: `Service 三层未闭合：${expectedFiles.ServiceImpl}.${method.name}(...) 必须委托 new ${baseName}Service().${method.name}(...), 不应绕过 ServiceInternal。`
                });
            }
        }
        const cleanImplSource = this._stripCommentsAndStrings(implSource);
        if (/\bCommonDao\.getInstance\s*\(|\bICommonDao\s+[A-Za-z_]\w*|\b(?:SqlHelper|SQLManageUtil|SqlConditionUtil)\s*[.(]|\bbaseDao\s*\./u.test(cleanImplSource)) {
            issues.push({
                code: 'DESIGN_TDD_SERVICE_IMPL_DIRECT_DAO_OR_SQL',
                layer: 'ServiceImpl',
                baseName,
                sourcePath: triad.ServiceImpl,
                message: `Service 三层未闭合：${expectedFiles.ServiceImpl} 不允许直接持有 DAO/SQL/SqlConditionUtil 逻辑，必须委托 ${expectedFiles.ServiceInternal}。`
            });
        }
        return { checked: true, issues, warnings };
    }

    _collectVariableTypes(source = '') {
        const clean = this._stripCommentsAndStrings(source);
        const map = new Map();
        const declareRe = /(?:^|[;\n\r{}(,])\s*(?:@\w+(?:\([^)]*\))?\s*)*(?:private|protected|public)?\s*(?:static\s+|final\s+|volatile\s+|transient\s+)*([A-Z][\w.$]*(?:\s*<[^;=(){}]+>)?)\s+([a-zA-Z_]\w*)\s*(?=[=;,\)])/g;
        let match;
        while ((match = declareRe.exec(clean)) !== null) {
            const typeName = this._simpleTypeName(match[1]);
            const varName = String(match[2] || '').trim();
            if (!typeName || !varName) continue;
            if (this._isLikelyValueType(typeName)) continue;
            map.set(varName, typeName);
        }
        return map;
    }

    _collectReceiverCalls(source = '') {
        const clean = this._stripCommentsAndStrings(source);
        const calls = [];
        const callRe = /\b([a-zA-Z_]\w*)\s*\.\s*([a-zA-Z_]\w*)\s*\(/g;
        let match;
        while ((match = callRe.exec(clean)) !== null) {
            const receiver = String(match[1] || '').trim();
            const methodName = String(match[2] || '').trim();
            if (!receiver || !methodName) continue;
            if (receiver === 'this' || receiver === 'super') continue;
            const openParenIndex = callRe.lastIndex - 1;
            const closeParenIndex = this._findClosingParen(clean, openParenIndex);
            calls.push({
                receiver,
                methodName,
                line: this._lineOf(clean, match.index),
                argCount: this._argumentCount(clean, openParenIndex, closeParenIndex)
            });
        }
        const seen = new Set();
        return calls.filter(call => {
            const key = `${call.receiver}.${call.methodName}:${call.line}:${call.argCount}`;
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
        });
    }

    _buildMethodSurfaceIndex(projectPath = '') {
        const index = new Map();
        const addSurface = (ownerName = '', sourcePath = '', methodNames = [], methodSignatures = []) => {
            const owner = String(ownerName || '').trim();
            const resolvedSourcePath = this._resolveSourcePath(sourcePath, projectPath);
            const liveMethodSignatures = this._methodSignaturesFromSourcePath(resolvedSourcePath);
            const combinedMethodSignatures = [
                ...array(methodSignatures),
                ...liveMethodSignatures
            ];
            const names = uniqueStrings([
                ...array(methodNames),
                ...combinedMethodSignatures.map(item => typeof item === 'string' ? this._methodNameFromSignature(item) : item && item.name)
            ]);
            if (!owner || names.length === 0) return;
            const current = index.get(owner) || {
                ownerName: owner,
                sourcePath: resolvedSourcePath || String(sourcePath || '').trim(),
                methodNames: new Set(),
                methodSignatures: [],
                strictMethodArities: new Map()
            };
            names.forEach(name => current.methodNames.add(name));
            combinedMethodSignatures.forEach(item => {
                const signature = typeof item === 'string' ? item : item && (item.signature || item.methodSignature);
                const name = typeof item === 'object' ? item.name : this._methodNameFromSignature(signature);
                const arity = typeof item === 'object' && Number.isInteger(item.arity)
                    ? item.arity
                    : (typeof item === 'object' && item.strictArity === true ? this._arityFromSignature(signature) : null);
                if (signature || name) current.methodSignatures.push(stripUndefined({ name, signature, arity }));
                if (name && Number.isInteger(arity)) {
                    if (!current.strictMethodArities.has(name)) current.strictMethodArities.set(name, new Set());
                    current.strictMethodArities.get(name).add(arity);
                }
            });
            if (!current.sourcePath && sourcePath) current.sourcePath = String(sourcePath || '').trim();
            index.set(owner, current);
        };

        const projectArtifactsDir = path.join(projectPath, '.ai-workspace', 'project');
        const graph = this._readJson(path.join(projectArtifactsDir, 'business-graph.json'));
        array(graph && graph.anchors).forEach(anchor => {
            addSurface(
                anchor.interfaceName || anchor.className || anchor.entityName || this._classNameFromPath(anchor.path),
                anchor.path,
                anchor.methodNames,
                anchor.methods
            );
        });
        const activeDemandPath = path.join(projectArtifactsDir, '.active-demand');
        let demandName = '';
        try {
            demandName = fs.existsSync(activeDemandPath) ? String(fs.readFileSync(activeDemandPath, 'utf-8') || '').trim() : '';
        } catch (_) {
            demandName = '';
        }
        const ledger = demandName ? this._readJson(path.join(projectArtifactsDir, demandName, 'code', 'skeleton-manifests-ledger.json')) : null;
        array(ledger && ledger.entries).forEach(entry => {
            addSurface(
                this._classNameFromPath(entry.targetFile || entry.filePath),
                entry.targetFile || entry.filePath,
                entry.methodNames,
                entry.methodSignatures
            );
        });
        this._addBuiltinMethodSurfaces(addSurface);
        return index;
    }

    _addBuiltinMethodSurfaces(addSurface) {
        addSurface('SqlConditionUtil', '__api_capability_contract__:SqlConditionUtil使用规范', [
            'eq',
            'like',
            'isBlankOrValue',
            'isBlank',
            'isNotBlank',
            'in',
            'notin',
            'nq',
            'gt',
            'ge',
            'lt',
            'le',
            'leftLike',
            'rightLike',
            'clear',
            'getMap',
            'setInnerJoinTable',
            'setLeftJoinTable',
            'setRightJoinTable',
            'setSelectFields',
            'setSelectCounts',
            'setOrder',
            'setOrderAsc',
            'setOrderDesc'
        ], [
            { name: 'eq', signature: 'SqlConditionUtil eq(String field, Object value)', arity: 2 },
            { name: 'like', signature: 'SqlConditionUtil like(String field, Object value)', arity: 2 },
            { name: 'isBlankOrValue', signature: 'SqlConditionUtil isBlankOrValue(String field, Object value)', arity: 2 },
            { name: 'isBlank', signature: 'SqlConditionUtil isBlank(String field)', arity: 1 },
            { name: 'isNotBlank', signature: 'SqlConditionUtil isNotBlank(String field)', arity: 1 },
            { name: 'in', signature: 'SqlConditionUtil in(String field, Object values)', arity: 2 },
            { name: 'notin', signature: 'SqlConditionUtil notin(String field, String values)', arity: 2 },
            { name: 'nq', signature: 'SqlConditionUtil nq(String field, Object value)', arity: 2 },
            { name: 'nq', signature: 'SqlConditionUtil nq(String field, Date value, String format)', arity: 3 },
            { name: 'gt', signature: 'SqlConditionUtil gt(String field, Object value)', arity: 2 },
            { name: 'gt', signature: 'SqlConditionUtil gt(String field, Date value, String format)', arity: 3 },
            { name: 'ge', signature: 'SqlConditionUtil ge(String field, Object value)', arity: 2 },
            { name: 'ge', signature: 'SqlConditionUtil ge(String field, Date value, String format)', arity: 3 },
            { name: 'lt', signature: 'SqlConditionUtil lt(String field, Object value)', arity: 2 },
            { name: 'lt', signature: 'SqlConditionUtil lt(String field, Date value, String format)', arity: 3 },
            { name: 'le', signature: 'SqlConditionUtil le(String field, Object value)', arity: 2 },
            { name: 'le', signature: 'SqlConditionUtil le(String field, Date value, String format)', arity: 3 },
            { name: 'leftLike', signature: 'SqlConditionUtil leftLike(String field, String value)', arity: 2 },
            { name: 'rightLike', signature: 'SqlConditionUtil rightLike(String field, String value)', arity: 2 },
            { name: 'clear', signature: 'SqlConditionUtil clear()', arity: 0 },
            { name: 'getMap', signature: 'Map<String, Object> getMap()', arity: 0 },
            { name: 'setInnerJoinTable', signature: 'SqlConditionUtil setInnerJoinTable(String tableName, String leftTableField, String rightTableField)', arity: 3 },
            { name: 'setLeftJoinTable', signature: 'SqlConditionUtil setLeftJoinTable(String tableName, String leftTableField, String rightTableField)', arity: 3 },
            { name: 'setRightJoinTable', signature: 'SqlConditionUtil setRightJoinTable(String tableName, String leftTableField, String rightTableField)', arity: 3 },
            { name: 'setSelectFields', signature: 'SqlConditionUtil setSelectFields(String fields)', arity: 1 },
            { name: 'setSelectCounts', signature: 'SqlConditionUtil setSelectCounts(Integer count)', arity: 1 },
            { name: 'setOrder', signature: 'SqlConditionUtil setOrder(String field, String order)', arity: 2 },
            { name: 'setOrderAsc', signature: 'SqlConditionUtil setOrderAsc(String field)', arity: 1 },
            { name: 'setOrderDesc', signature: 'SqlConditionUtil setOrderDesc(String field)', arity: 1 }
        ]);
        addSurface('JSONObject', '__api_capability_contract__:fastjson.JSONObject', [
            'parseObject',
            'getString',
            'getInteger',
            'getIntValue',
            'getLong',
            'getLongValue',
            'getBoolean',
            'getBooleanValue',
            'getBigDecimal',
            'getDouble',
            'getDoubleValue',
            'getFloat',
            'getFloatValue',
            'getShort',
            'getShortValue',
            'getByte',
            'getByteValue',
            'getBytes',
            'getDate',
            'getSqlDate',
            'getTimestamp',
            'getObject',
            'getOrDefault',
            'getJSONObject',
            'getJSONArray',
            'get',
            'put',
            'putAll',
            'remove',
            'clear',
            'containsKey',
            'keySet',
            'values',
            'entrySet',
            'isEmpty',
            'size',
            'toJSONString',
            'toJavaObject',
            'clone',
            'fluentPut',
            'fluentPutAll',
            'fluentRemove',
            'fluentClear'
        ], [
            { name: 'getString', signature: 'String getString(String key)', arity: 1 },
            { name: 'getInteger', signature: 'Integer getInteger(String key)', arity: 1 },
            { name: 'getIntValue', signature: 'int getIntValue(String key)', arity: 1 },
            { name: 'getLong', signature: 'Long getLong(String key)', arity: 1 },
            { name: 'getLongValue', signature: 'long getLongValue(String key)', arity: 1 },
            { name: 'getBoolean', signature: 'Boolean getBoolean(String key)', arity: 1 },
            { name: 'getBooleanValue', signature: 'boolean getBooleanValue(String key)', arity: 1 },
            { name: 'getJSONObject', signature: 'JSONObject getJSONObject(String key)', arity: 1 },
            { name: 'getJSONArray', signature: 'JSONArray getJSONArray(String key)', arity: 1 },
            { name: 'containsKey', signature: 'boolean containsKey(Object key)', arity: 1 },
            { name: 'put', signature: 'Object put(String key, Object value)', arity: 2 }
        ]);
        addSurface('JSONArray', '__api_capability_contract__:fastjson.JSONArray', [
            'add',
            'isEmpty',
            'size',
            'get',
            'getJSONObject',
            'getString',
            'getInteger',
            'getIntValue',
            'getLong',
            'getLongValue',
            'getObject',
            'remove',
            'clear',
            'toJSONString',
            'toJavaList'
        ], [
            { name: 'add', signature: 'boolean add(Object value)', arity: 1 },
            { name: 'isEmpty', signature: 'boolean isEmpty()', arity: 0 },
            { name: 'size', signature: 'int size()', arity: 0 },
            { name: 'get', signature: 'Object get(int index)', arity: 1 },
            { name: 'getJSONObject', signature: 'JSONObject getJSONObject(int index)', arity: 1 }
        ]);
    }

    _collectServiceTriadFiles(projectPath = '', baseName = '', evidenceFile = '', evidenceKind = '') {
        const expected = {
            ServiceApi: `I${baseName}Service.java`,
            ServiceInternal: `${baseName}Service.java`,
            ServiceImpl: `${baseName}ServiceImpl.java`
        };
        const out = {};
        if (evidenceKind && evidenceFile) out[evidenceKind] = evidenceFile;
        const found = this._findFilesByBasename(projectPath, Object.values(expected));
        Object.keys(expected).forEach(kind => {
            const key = expected[kind].toLowerCase();
            if (!out[kind] && found.has(key)) out[kind] = found.get(key);
        });
        return out;
    }

    _findFilesByBasename(projectPath = '', basenames = []) {
        const wanted = new Set(array(basenames).map(name => String(name || '').toLowerCase()).filter(Boolean));
        const found = new Map();
        if (!projectPath || wanted.size === 0) return found;
        const skipDirs = new Set(['.git', '.ai-workspace', 'node_modules', 'target', 'dist', 'build', '.gradle', '.idea']);
        const visit = dir => {
            if (!dir || found.size >= wanted.size) return;
            let entries = [];
            try {
                entries = fs.readdirSync(dir, { withFileTypes: true });
            } catch (_) {
                return;
            }
            for (const entry of entries) {
                if (found.size >= wanted.size) break;
                const fullPath = path.join(dir, entry.name);
                if (entry.isDirectory()) {
                    if (!skipDirs.has(entry.name)) visit(fullPath);
                    continue;
                }
                if (!entry.isFile()) continue;
                const key = entry.name.toLowerCase();
                if (wanted.has(key) && !found.has(key)) found.set(key, fullPath);
            }
        };
        visit(projectPath);
        return found;
    }

    _serviceLayerKindFromPath(filePath = '') {
        const name = path.basename(String(filePath || ''));
        if (/^I[A-Za-z0-9_]*Service\.java$/u.test(name)) return 'ServiceApi';
        if (/ServiceImpl\.java$/u.test(name)) return 'ServiceImpl';
        if (/Service\.java$/u.test(name) && !/^I/u.test(name)) return 'ServiceInternal';
        return '';
    }

    _serviceTriadBaseName(filePath = '', kind = '') {
        const className = path.basename(String(filePath || ''), '.java');
        if (!className) return '';
        if (kind === 'ServiceApi') return className.replace(/^I/u, '').replace(/Service$/u, '');
        if (kind === 'ServiceImpl') return className.replace(/ServiceImpl$/u, '');
        if (kind === 'ServiceInternal') return className.replace(/Service$/u, '');
        return '';
    }

    _serviceLayerKindFromTypeName(typeName = '') {
        const name = this._simpleTypeName(typeName);
        if (/^I[A-Za-z0-9_]*Service$/u.test(name)) return 'ServiceApi';
        if (/ServiceImpl$/u.test(name)) return 'ServiceImpl';
        if (/Service$/u.test(name) && !/^I/u.test(name)) return 'ServiceInternal';
        return '';
    }

    _serviceTriadBaseNameFromTypeName(typeName = '', kind = '') {
        const name = this._simpleTypeName(typeName);
        if (!name) return '';
        if (kind === 'ServiceApi') return name.replace(/^I/u, '').replace(/Service$/u, '');
        if (kind === 'ServiceImpl') return name.replace(/ServiceImpl$/u, '');
        if (kind === 'ServiceInternal') return name.replace(/Service$/u, '');
        return '';
    }

    _serviceTriadInfoForType(projectPath = '', typeName = '') {
        const serviceLayerKind = this._serviceLayerKindFromTypeName(typeName);
        if (!serviceLayerKind) return {};
        const baseName = this._serviceTriadBaseNameFromTypeName(typeName, serviceLayerKind);
        if (!baseName) return { serviceLayerKind };
        const triad = this._collectServiceTriadFiles(projectPath, baseName, '', '');
        const hasTriadEvidence = !!(triad.ServiceApi || triad.ServiceImpl || triad.ServiceInternal);
        if (!hasTriadEvidence) return { serviceLayerKind, baseName };
        return stripUndefined({
            serviceLayerKind,
            baseName,
            serviceTriadRequired: true,
            apiPath: triad.ServiceApi,
            implPath: triad.ServiceImpl,
            internalPath: triad.ServiceInternal
        });
    }

    _extractJavaMethodSignatures(source = '', classFileName = '') {
        const className = path.basename(String(classFileName || ''), '.java');
        const clean = this._stripCommentsAndStrings(source);
        const methods = [];
        const methodRe = /(?:^|[;\n\r{}])\s*(?:@\w+(?:\([^)]*\))?\s*)*(?:public|protected|private)?\s*(?:static\s+)?(?:<[^>{}]+>\s*)?[\w.$<>\[\], ?]+\s+([a-zA-Z_]\w*)\s*\(([^;{}]*)\)\s*(?:throws\s+[^{;]+)?[;{]/g;
        let match;
        while ((match = methodRe.exec(clean)) !== null) {
            const name = String(match[1] || '').trim();
            if (!name || name === className || this._isControlWord(name)) continue;
            const params = this._normalizeParamTypes(match[2]);
            methods.push({
                name,
                params,
                key: `${name}(${params.join(',')})`
            });
        }
        const seen = new Set();
        return methods.filter(method => {
            if (seen.has(method.key)) return false;
            seen.add(method.key);
            return true;
        });
    }

    _normalizeParamTypes(paramsText = '') {
        return this._splitTopLevelCommas(paramsText)
            .map(part => this._normalizeParamType(part))
            .filter(Boolean);
    }

    _splitTopLevelCommas(text = '') {
        const parts = [];
        let current = '';
        let genericDepth = 0;
        let parenDepth = 0;
        let bracketDepth = 0;
        let braceDepth = 0;
        for (const ch of String(text || '')) {
            if (ch === '<') genericDepth++;
            if (ch === '>') genericDepth = Math.max(0, genericDepth - 1);
            if (ch === '(') parenDepth++;
            if (ch === ')') parenDepth = Math.max(0, parenDepth - 1);
            if (ch === '[') bracketDepth++;
            if (ch === ']') bracketDepth = Math.max(0, bracketDepth - 1);
            if (ch === '{') braceDepth++;
            if (ch === '}') braceDepth = Math.max(0, braceDepth - 1);
            if (ch === ',' && genericDepth === 0 && parenDepth === 0 && bracketDepth === 0 && braceDepth === 0) {
                parts.push(current);
                current = '';
                continue;
            }
            current += ch;
        }
        if (current.trim()) parts.push(current);
        return parts;
    }

    _normalizeParamType(param = '') {
        const text = String(param || '')
            .replace(/@\w+(?:\([^)]*\))?/g, '')
            .replace(/\bfinal\b/g, '')
            .replace(/\.\.\./g, '[]')
            .trim();
        if (!text) return '';
        const withoutDefault = text.split('=')[0].trim();
        const match = withoutDefault.match(/^(.+?)\s+[A-Za-z_]\w*$/u);
        const typeText = (match ? match[1] : withoutDefault)
            .replace(/<[\s\S]*>/g, '')
            .replace(/\s+/g, ' ')
            .trim();
        return this._simpleTypeName(typeText.replace(/\[\s*\]/g, '[]'));
    }

    _serviceImplDelegatesToInternal(source = '', baseName = '', methodName = '') {
        const internalClass = `${baseName}Service`;
        const escapedClass = this._escapeRegex(internalClass);
        const escapedMethod = this._escapeRegex(methodName);
        const directNewCall = new RegExp(`new\\s+${escapedClass}\\s*\\(\\s*\\)\\s*\\.\\s*${escapedMethod}\\s*\\(`, 'u');
        if (directNewCall.test(source)) return true;
        const variableDecl = new RegExp(`\\b${escapedClass}\\s+([A-Za-z_]\\w*)\\s*=\\s*new\\s+${escapedClass}\\s*\\(`, 'u');
        const match = source.match(variableDecl);
        if (match && match[1]) {
            return new RegExp(`\\b${this._escapeRegex(match[1])}\\s*\\.\\s*${escapedMethod}\\s*\\(`, 'u').test(source);
        }
        return false;
    }

    _isControlWord(name = '') {
        return /^(if|for|while|switch|catch|return|new|throw|synchronized)$/u.test(String(name || ''));
    }

    _escapeRegex(text = '') {
        return String(text || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }

    _resolveSurface(index, typeName = '') {
        const simple = this._simpleTypeName(typeName);
        if (!simple) return null;
        return index.get(simple) || null;
    }

    _stripCommentsAndStrings(source = '') {
        return String(source || '')
            .replace(/\/\*[\s\S]*?\*\//g, match => '\n'.repeat((match.match(/\n/g) || []).length))
            .replace(/\/\/[^\r\n]*/g, '')
            .replace(/"(?:\\.|[^"\\])*"/g, '""')
            .replace(/'(?:\\.|[^'\\])*'/g, "''");
    }

    _simpleTypeName(typeName = '') {
        return String(typeName || '')
            .replace(/<[\s\S]*>/g, '')
            .trim()
            .split(/[.\s]/)
            .filter(Boolean)
            .pop() || '';
    }

    _methodNameFromSignature(signature = '') {
        const text = String(signature || '').trim();
        const match = text.match(/\b([A-Za-z_]\w*)\s*\(/);
        return match ? match[1] : '';
    }

    _methodSignaturesFromSourcePath(filePath = '') {
        const target = String(filePath || '').trim();
        if (!target || path.extname(target).toLowerCase() !== '.java' || !fs.existsSync(target)) return [];
        const source = this._readText(target);
        if (!source) return [];
        return this._extractJavaMethodSignatures(source, target)
            .map(method => stripUndefined({
                name: method.name,
                signature: method.key,
                source: 'liveSource'
            }));
    }

    _resolveSourcePath(filePath = '', projectPath = '') {
        const text = String(filePath || '').trim();
        if (!text) return '';
        const target = path.isAbsolute(text) ? text : path.resolve(projectPath || process.cwd(), text);
        return fs.existsSync(target) ? target : text;
    }

    _arityFromSignature(signature = '') {
        const text = String(signature || '').trim();
        const match = text.match(/\(([\s\S]*)\)/);
        if (!match) return null;
        const body = String(match[1] || '').trim();
        if (!body) return 0;
        return this._splitTopLevelCommas(body).length;
    }

    _signaturesForMethod(surface = {}, methodName = '') {
        const name = String(methodName || '').trim();
        return array(surface && surface.methodSignatures)
            .filter(item => String(item && item.name || '').trim() === name);
    }

    _isJavaObjectMethod(methodName = '') {
        return /^(toString|hashCode|equals|getClass|notify|notifyAll|wait)$/u
            .test(String(methodName || '').trim());
    }

    _classNameFromPath(filePath = '') {
        const text = String(filePath || '').trim();
        if (!text) return '';
        return path.basename(text, path.extname(text));
    }

    _isLikelyValueType(typeName = '') {
        return /^(String|Integer|Long|Boolean|Double|Float|BigDecimal|Date|Map|List|Set|PageData|DataGridModel|HashMap|ArrayList)$/u
            .test(String(typeName || '').trim());
    }

    _lineOf(text = '', index = 0) {
        return String(text || '').slice(0, Math.max(0, index)).split(/\r?\n/).length;
    }

    _findClosingParen(text = '', openIndex = -1) {
        if (openIndex < 0 || String(text || '')[openIndex] !== '(') return -1;
        let depth = 0;
        for (let i = openIndex; i < String(text || '').length; i++) {
            const ch = String(text || '')[i];
            if (ch === '(') depth++;
            if (ch === ')') {
                depth--;
                if (depth === 0) return i;
            }
        }
        return -1;
    }

    _argumentCount(text = '', openIndex = -1, closeIndex = -1) {
        if (openIndex < 0 || closeIndex <= openIndex) return null;
        const inner = String(text || '').slice(openIndex + 1, closeIndex).trim();
        if (!inner) return 0;
        return this._splitTopLevelCommas(inner).length;
    }

    _readJson(filePath = '') {
        try {
            if (!filePath || !fs.existsSync(filePath)) return null;
            return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        } catch (_) {
            return null;
        }
    }

    _readText(filePath = '') {
        try {
            if (!filePath || !fs.existsSync(filePath)) return '';
            return fs.readFileSync(filePath, 'utf-8');
        } catch (_) {
            return '';
        }
    }

    _isSameOrChild(child, parent) {
        if (!child || !parent) return false;
        const childAbs = path.resolve(child);
        const parentAbs = path.resolve(parent);
        const c = process.platform === 'win32' ? childAbs.toLowerCase() : childAbs;
        const p = process.platform === 'win32' ? parentAbs.toLowerCase() : parentAbs;
        return c === p || c.startsWith(p + path.sep);
    }
}

module.exports = DesignTddJavaCallClosureService;
