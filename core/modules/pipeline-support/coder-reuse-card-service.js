/* eslint-disable */
/**
 * coder-reuse-card-service.js — Coder 复用卡（reuseCard）「指路而非缓存」内部 Builder service
 *
 * 故事线：Coder 改已有 Action 要调 Service 时看不见调用目标有什么方法、又禁搜，于是瞎猜/重造。
 * 本 service 从 scan 落盘的 code-reuse-index.json 取「候选 Action 注入了哪几个 Service + 接口精确路径」、
 * 「历史入口页面 → Action 方法 → 一跳直接调用」证据，做成只读 reuseCard 烘进 requirementWorkPackage。
 *
 * 指路而非缓存：reuseCard 只给 接口名 + 精确路径 + sourceKind + read_file 许可，以及入口链路的
 *   方法名/调用名证据；**不缓存方法签名**（方法 Coder 现读活源码，永不 stale）。
 * 框架服务无源码：project_source 给路径 / api_rule_documented 给 ruleAlias 走 rule_expert /
 *   framework_unresolved blocked 不编（红线 #6）。
 *
 * 本 service 是内部 Builder 组件，**不注册为 MCP 工具**（消费模型反转：Builder 烘，不是 Coder 查）。
 * 设计依据：.planning/2026-06-01-coder-reuse-card/findings.md §8。
 *
 * @module pipeline-support/coder-reuse-card-service
 */
const fs = require('fs');
const path = require('path');

const REUSE_INDEX_FILENAME = 'code-reuse-index.json';
const REUSE_INDEX_RECEIPT_FILENAME = 'code-reuse-index-receipt.json';

// 已知有「接口使用规范」沉淀的框架服务别名映射（无源码但有 api-rule 文档）。
// 只放别名推导规则，不写死项目事实；规则正文真值仍由 rule_expert(read, outputMode=full) 取。
function deriveApiRuleAlias(interfaceName) {
    const name = String(interfaceName || '').trim();
    if (!name) return '';
    return `${name}接口使用规范`;
}

class CoderReuseCardService {
    constructor(options = {}) {
        this.getProjectStructureDir = typeof options.getProjectStructureDir === 'function'
            ? options.getProjectStructureDir
            : (projectPath => path.join(String(projectPath || ''), '.ai-workspace', 'project'));
        this.readJsonSafe = typeof options.readJsonSafe === 'function'
            ? options.readJsonSafe
            : CoderReuseCardService._defaultReadJsonSafe;
    }

    static _defaultReadJsonSafe(filePath) {
        try {
            return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        } catch (_) {
            return null;
        }
    }

    _indexPath(projectPath) {
        return path.join(this.getProjectStructureDir(projectPath), REUSE_INDEX_FILENAME);
    }

    _receiptPath(projectPath) {
        return path.join(this.getProjectStructureDir(projectPath), REUSE_INDEX_RECEIPT_FILENAME);
    }

    loadIndex(projectPath) {
        const indexPath = this._indexPath(projectPath);
        if (!fs.existsSync(indexPath)) {
            return { ok: false, errorCode: 'SCAN_REUSE_INDEX_MISSING', indexPath };
        }
        const index = this.readJsonSafe(indexPath);
        if (!index || typeof index !== 'object') {
            return { ok: false, errorCode: 'SCAN_REUSE_INDEX_INVALID', indexPath };
        }
        return { ok: true, index, indexPath };
    }

    /**
     * 为候选文件构建 reuseCard。
     * @param {object} params
     * @param {string} params.projectPath
     * @param {Array}  params.candidateFiles 施工包候选文件（fileKind/resolvedPath）
     * @returns {object|null} reuseCard 或 null（无可指路信息时不烘卡）
     */
    buildReuseCard({ projectPath = '', candidateFiles = [] } = {}) {
        const loaded = this.loadIndex(projectPath);
        if (!loaded.ok) {
            // scan 缺索引 → 不 fallback 编内容；给 blocked 信号让上层决定（红线 #6）
            return {
                blocked: true,
                errorCode: loaded.errorCode,
                indexPath: loaded.indexPath,
                message: 'code-reuse-index 缺失或损坏，本卡暂无复用导航，不代表项目没有 Service。Vibe Coding 可从已知实体/调用方定向查源码；本卡不能替代上游必需事实校验。'
            };
        }
        const index = loaded.index;
        const actions = Array.isArray(index.actions) ? index.actions : [];
        const serviceInterfaces = Array.isArray(index.serviceInterfaces) ? index.serviceInterfaces : [];
        const routeEdges = Array.isArray(index.routeEdges) ? index.routeEdges : [];
        const actionMethodSlices = Array.isArray(index.actionMethodSlices) ? index.actionMethodSlices : [];

        const candidateActionClasses = this._resolveCandidateActionClasses(projectPath, candidateFiles, actions);
        const candidateHtmlPages = this._resolveCandidateHtmlPages(projectPath, candidateFiles);
        if (candidateActionClasses.size === 0 && candidateHtmlPages.size === 0) {
            // 候选里没有 Action（纯新建/纯前端）→ 无指路需求，不烘卡
            return null;
        }

        const svcByName = new Map();
        for (const svc of serviceInterfaces) {
            const name = String(svc && svc.interfaceName || '').trim();
            if (name && !svcByName.has(name)) svcByName.set(name, svc);
        }

        const services = [];
        const seenService = new Set();
        const relatedActions = [];
        for (const action of actions) {
            const className = String(action && action.className || '').trim();
            if (!candidateActionClasses.has(className)) continue;
            relatedActions.push({
                className,
                sourcePath: String(action.sourcePath || ''),
                restControllerKey: String(action.restControllerKey || '')
            });
            for (const inj of (Array.isArray(action.injectedServices) ? action.injectedServices : [])) {
                const interfaceName = String(inj && inj.interfaceName || '').trim();
                if (!interfaceName || seenService.has(interfaceName)) continue;
                seenService.add(interfaceName);
                services.push(this._buildServiceEntry(interfaceName, svcByName.get(interfaceName)));
            }
        }

        // 相关 route 边：候选 Action 对应的 HtmlPage 入口（指路用）
        const relatedRoutes = routeEdges
            .filter(edge => candidateActionClasses.has(String(edge && edge.actionClass || '').trim())
                || candidateHtmlPages.has(this._normPath(edge && edge.htmlPage)))
            .map(edge => ({
                htmlPage: String(edge.htmlPage || ''),
                actionClass: String(edge.actionClass || ''),
                actionPath: String(edge.actionPath || ''),
                routeKey: String(edge.routeKey || ''),
                methodName: String(edge.methodName || ''),
                binding: String(edge.binding || '')
            }));
        const codeSlices = this._buildCodeSlices({
            projectPath,
            candidateActionClasses,
            candidateHtmlPages,
            actionMethodSlices
        });
        if (services.length === 0 && relatedActions.length === 0 && codeSlices.length === 0) return null;

        return {
            purpose: '改候选 Action/历史入口前，先看 services 与 codeSlices：Service 接口按精确路径 read_file，历史入口链路按证据判断可复用的 Action/Util/日志实体；不要凭印象造方法名，也不要重复造已有方法。',
            readPermission: '优先读取 services[].sourcePath、codeSlices[].directCalls[].sourcePath、codeSlices[].relatedEntities[].sourcePath；导航失效或证据不足时按当前类名/实体/调用方定向检索，签名以当前源码为准。',
            services,
            relatedRoutes,
            ...(codeSlices.length > 0 ? { codeSlices } : {}),
            note: '本卡只指路，不内联方法签名；方法体以精确 sourcePath 现读为准。框架服务无源码时按 ruleAlias 调 rule_expert(action=read, outputMode=full) 读接口使用规范。'
        };
    }

    /**
     * 为复用表构建表级复用指路。
     *
     * 与 buildReuseCard 的候选文件匹配不同，本方法按 business-facts 中的复用表反查
     * code-reuse-index.actionMethodSlices[].relatedEntities，覆盖“新建查询入口但可参考历史
     * Action/Util/日志实体调用链”的场景。
     */
    buildReuseTableGuide({ projectPath = '', databaseTables = [] } = {}) {
        const tables = (Array.isArray(databaseTables) ? databaseTables : [])
            .map(table => {
                const tableName = String(table && table.tableName || '').trim();
                const tableComment = String(table && table.tableComment || '').trim();
                const entityName = String(table && table.entityName || '').trim();
                const reuseSourceFile = this._normalizeReadablePath(table && table.reuseSourceFile, projectPath);
                const reusedApis = this._uniq(table && table.reusedApis || []);
                const reuseDirHints = this._uniq(table && table.reuseDirHints || []);
                const isReuse = table && table.reuse === true;
                if (!isReuse && reusedApis.length === 0 && !reuseSourceFile && reuseDirHints.length === 0) return null;
                return {
                    tableName,
                    tableComment,
                    entityName,
                    ...(isReuse ? { reuse: true } : {}),
                    ...(reusedApis.length > 0 ? { reusedApis } : {}),
                    ...(reuseSourceFile ? { reuseSourceFile } : {}),
                    ...(reuseDirHints.length > 0 ? { reuseDirHints } : {})
                };
            })
            .filter(item => item && (item.tableName || item.entityName || item.reuseSourceFile || (item.reusedApis || []).length > 0));
        if (tables.length === 0) return null;

        const loaded = this.loadIndex(projectPath);
        if (!loaded.ok) {
            return {
                blocked: true,
                errorCode: loaded.errorCode,
                indexPath: loaded.indexPath,
                message: 'code-reuse-index 缺失或损坏，无法为复用表反查历史 Action 方法链。'
            };
        }
        const index = loaded.index;
        const tableNames = new Set(tables.map(item => String(item.tableName || '').trim().toLowerCase()).filter(Boolean));
        const entityNames = new Set(tables.map(item => String(item.entityName || '').trim().toLowerCase()).filter(Boolean));
        const sourcePaths = new Set(tables.map(item => this._normPath(item.reuseSourceFile || '')).filter(Boolean));
        const codeSlices = this._buildTableRelatedCodeSlices({
            projectPath,
            tableNames,
            entityNames,
            sourcePaths,
            actionMethodSlices: Array.isArray(index.actionMethodSlices) ? index.actionMethodSlices : []
        });
        return {
            purpose: '复用表指路：本需求声明复用已有表/实体时，先看 tables 的复用落点；若 codeSlices 命中历史入口方法，可 read_file 精确路径核对调用链，不要凭表名猜 Service 方法。',
            readPermission: '优先读取 tables[].reuseSourceFile、codeSlices[].actionPath、codeSlices[].directCalls[].sourcePath、codeSlices[].relatedEntities[].sourcePath；导航不足时允许围绕当前实体和调用方定向检索，不凭表名猜 API。',
            tables,
            ...(codeSlices.length > 0 ? { codeSlices } : {}),
            note: '本卡按复用表反查历史方法链；codeSlices 是方法使用证据，不等同于可直接填写 linkedTable.reusedApis 的 Service API。'
        };
    }

    _buildServiceEntry(interfaceName, svc) {
        if (svc && String(svc.sourcePath || '').trim()) {
            return {
                interfaceName,
                sourceKind: 'project_source',
                sourcePath: String(svc.sourcePath || '').trim(),
                useWhen: '工程内有源码：read_file 此路径，按接口方法 + 中文 Javadoc 判断复用/新增。'
            };
        }
        // 无源码（框架/跨模块服务）：给 api-rule 别名走 rule_expert，不给路径、不编方法。
        // 优先用索引已带的 ruleAlias（scan 阶段 framework_unresolved 已派生），无则本地派生。
        const ruleAlias = String(svc && svc.ruleAlias || '').trim() || deriveApiRuleAlias(interfaceName);
        return {
            interfaceName,
            sourceKind: 'api_rule_documented',
            ruleAlias,
            useWhen: '框架/跨模块服务无工程源码：调 rule_expert(action="read", ruleName=ruleAlias, outputMode="full") 读接口使用规范；规范缺失则停下补规范，禁止凭印象写方法。'
        };
    }

    _resolveCandidateActionClasses(projectPath, candidateFiles, actions) {
        const projectRoot = String(projectPath || '').trim() ? path.resolve(String(projectPath).trim()) : '';
        const classes = new Set();
        // 候选文件里 fileKind=Action 的，按 resolvedPath 反查 index.actions 的 className
        const actionByNormPath = new Map();
        for (const action of actions) {
            const sp = String(action && action.sourcePath || '').trim();
            if (!sp) continue;
            actionByNormPath.set(this._normPath(sp), String(action.className || '').trim());
        }
        for (const file of (Array.isArray(candidateFiles) ? candidateFiles : [])) {
            const fileKind = String(file && file.fileKind || '').trim();
            if (fileKind && fileKind !== 'Action') continue;
            const resolved = String(file && (file.resolvedPath || file.path) || '').trim();
            if (!resolved) continue;
            // index.sourcePath 是相对工程根的 posix 路径；候选是绝对路径 → 取相对再归一比对
            let rel = resolved;
            if (projectRoot && path.isAbsolute(resolved)) {
                rel = path.relative(projectRoot, resolved);
            }
            const norm = this._normPath(rel);
            const className = actionByNormPath.get(norm);
            if (className) classes.add(className);
        }
        return classes;
    }

    _resolveCandidateHtmlPages(projectPath, candidateFiles) {
        const projectRoot = String(projectPath || '').trim() ? path.resolve(String(projectPath).trim()) : '';
        const pages = new Set();
        for (const file of (Array.isArray(candidateFiles) ? candidateFiles : [])) {
            const fileKind = String(file && file.fileKind || '').trim();
            if (fileKind !== 'HtmlPage') continue;
            const resolved = String(file && (file.resolvedPath || file.path) || '').trim();
            if (!resolved) continue;
            let rel = resolved;
            if (projectRoot && path.isAbsolute(resolved)) {
                rel = path.relative(projectRoot, resolved);
            }
            pages.add(this._normPath(rel));
        }
        return pages;
    }

    _buildCodeSlices({ projectPath = '', candidateActionClasses = new Set(), candidateHtmlPages = new Set(), actionMethodSlices = [] } = {}) {
        const out = [];
        const seen = new Set();
        for (const slice of (Array.isArray(actionMethodSlices) ? actionMethodSlices : [])) {
            if (!slice || typeof slice !== 'object') continue;
            const actionClass = String(slice.actionClass || '').trim();
            const htmlPage = this._normPath(slice.htmlPage || '');
            if (!candidateActionClasses.has(actionClass) && !candidateHtmlPages.has(htmlPage)) continue;
            const methodName = String(slice.methodName || '').trim();
            const actionPath = String(slice.actionPath || '').trim();
            const key = `${htmlPage}::${actionClass}::${methodName}`;
            if (!methodName || seen.has(key)) continue;
            seen.add(key);
            out.push({
                htmlPage: String(slice.htmlPage || ''),
                frontendCall: String(slice.frontendCall || ''),
                routeKey: String(slice.routeKey || ''),
                binding: String(slice.binding || ''),
                actionClass,
                actionPath,
                methodName,
                directCalls: this._normalizeDirectCalls(slice.directCalls, projectPath),
                relatedEntities: this._normalizeRelatedEntities(slice.relatedEntities, projectPath),
                callbackParams: this._uniq(slice.callbackParams).slice(0, 12),
                responseFields: this._uniq(slice.responseFields).slice(0, 16),
                evidence: this._uniq(slice.evidence).slice(0, 8)
            });
        }
        return out.slice(0, 12);
    }

    _buildTableRelatedCodeSlices({ projectPath = '', tableNames = new Set(), entityNames = new Set(), sourcePaths = new Set(), actionMethodSlices = [] } = {}) {
        const out = [];
        const seen = new Set();
        for (const slice of (Array.isArray(actionMethodSlices) ? actionMethodSlices : [])) {
            if (!slice || typeof slice !== 'object') continue;
            const related = Array.isArray(slice.relatedEntities) ? slice.relatedEntities : [];
            const matched = related.some(entity => {
                const tableName = String(entity && entity.tableName || '').trim().toLowerCase();
                const entityName = String(entity && entity.entityName || '').trim().toLowerCase();
                const sourcePath = this._normPath(entity && entity.sourcePath || '');
                return (tableName && tableNames.has(tableName))
                    || (entityName && entityNames.has(entityName))
                    || (sourcePath && sourcePaths.has(sourcePath));
            });
            if (!matched) continue;
            const actionClass = String(slice.actionClass || '').trim();
            const methodName = String(slice.methodName || '').trim();
            const htmlPage = this._normPath(slice.htmlPage || '');
            const key = `${htmlPage}::${actionClass}::${methodName}`;
            if (!methodName || seen.has(key)) continue;
            seen.add(key);
            out.push({
                htmlPage: String(slice.htmlPage || ''),
                frontendCall: String(slice.frontendCall || ''),
                routeKey: String(slice.routeKey || ''),
                binding: String(slice.binding || ''),
                actionClass,
                actionPath: this._normalizeReadablePath(slice.actionPath, projectPath) || String(slice.actionPath || ''),
                methodName,
                directCalls: this._normalizeDirectCalls(slice.directCalls, projectPath),
                relatedEntities: this._normalizeRelatedEntities(slice.relatedEntities, projectPath),
                callbackParams: this._uniq(slice.callbackParams).slice(0, 12),
                responseFields: this._uniq(slice.responseFields).slice(0, 16),
                evidence: this._uniq(slice.evidence).slice(0, 8)
            });
        }
        return out.slice(0, 12);
    }

    _normalizeDirectCalls(items = [], projectPath = '') {
        return (Array.isArray(items) ? items : [])
            .map(item => {
                const callType = String(item && item.callType || '').trim();
                const ownerName = String(item && item.ownerName || '').trim();
                const methodName = String(item && item.methodName || '').trim();
                if (!callType || !ownerName || !methodName) return null;
                const sourcePath = this._normalizeReadablePath(item && item.sourcePath, projectPath);
                const out = {
                    callType,
                    ownerName,
                    methodName,
                    ...(item && item.fieldName ? { fieldName: String(item.fieldName || '').trim() } : {}),
                    ...(item && item.sourceKind ? { sourceKind: String(item.sourceKind || '').trim() } : {}),
                    ...(sourcePath ? { sourcePath } : {}),
                    ...(item && item.ruleAlias ? { ruleAlias: String(item.ruleAlias || '').trim() } : {})
                };
                return out;
            })
            .filter(Boolean)
            .slice(0, 16);
    }

    _normalizeRelatedEntities(items = [], projectPath = '') {
        return (Array.isArray(items) ? items : [])
            .map(item => {
                const entityName = String(item && item.entityName || '').trim();
                if (!entityName) return null;
                const sourcePath = this._normalizeReadablePath(item && item.sourcePath, projectPath);
                return {
                    entityName,
                    ...(item && item.tableName ? { tableName: String(item.tableName || '').trim() } : {}),
                    ...(sourcePath ? { sourcePath } : {})
                };
            })
            .filter(Boolean)
            .slice(0, 12);
    }

    _normalizeReadablePath(rawPath = '', projectPath = '') {
        const text = String(rawPath || '').trim();
        if (!text) return '';
        const projectRoot = String(projectPath || '').trim() ? path.resolve(String(projectPath).trim()) : '';
        if (!projectRoot) return text;
        const resolved = path.isAbsolute(text) ? path.resolve(text) : path.resolve(projectRoot, text);
        return this._isSameOrChild(resolved, projectRoot) ? resolved : '';
    }

    _isSameOrChild(child, parent) {
        const rel = path.relative(path.resolve(parent), path.resolve(child));
        return rel === '' || (!!rel && !rel.startsWith('..') && !path.isAbsolute(rel));
    }

    _normPath(p) {
        return String(p || '').replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase();
    }

    _uniq(values = []) {
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

    /**
     * finalize 后受控刷新索引：让本轮新增/改名的 Service/Action 进入下一轮 reuseCard。
     * Builder 同步动作（不依赖 LLM 二次调工具）；失败不阻断 finalize。
     * 只刷新「接口→路径」「Action 注入」「route 边」路径索引，不回灌方法签名（指路而非缓存）。
     * @returns {object} { ok, refreshReceipt? , skipped?, reason? }
     */
    refreshIndex({ projectPath = '', scriptPath = '', pythonCommand = 'python' } = {}) {
        const root = String(projectPath || '').trim();
        const script = String(scriptPath || '').trim();
        if (!root || !script || !fs.existsSync(script)) {
            return { ok: false, skipped: true, reason: 'missing_project_or_script' };
        }
        try {
            const { execFileSync } = require('child_process');
            execFileSync(pythonCommand || 'python', [script, '--root', root, '--reuse-index'], {
                encoding: 'utf-8',
                stdio: 'pipe',
                timeout: 600000,
                env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' }
            });
            const receiptPath = this._receiptPath(root);
            return {
                ok: fs.existsSync(receiptPath),
                refreshReceipt: { written: fs.existsSync(receiptPath), path: receiptPath }
            };
        } catch (error) {
            return { ok: false, skipped: true, reason: 'reuse_index_refresh_failed', message: String(error && error.message || error) };
        }
    }
}

module.exports = CoderReuseCardService;
