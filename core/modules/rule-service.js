const fs = require('fs');
const fsPromises = require('fs').promises;
const path = require('path');
const NodeCache = require('node-cache');
const yaml = require('js-yaml');
const PipelineUtils = require('./pipeline-utils');

const repoDirs = ['.project_repo', '.product_repo', '.skill_hub_repo'];
const RULE_DOC_EXTENSIONS = new Set(['.md', '.mdc']);
const VERSION_BUCKET_OPTIONS = new Set(['950及以上', '950以下']);
const PROJECT_API_ASSET_CATEGORIES = new Set(['项目现成接口规范', 'API资产沉淀']);
const PROJECT_FEATURE_ASSET_CATEGORIES = new Set(['功能沉淀']);
const PROJECT_KNOWLEDGE_CATEGORIES = new Set(['需求规则沉淀', '项目知识沉淀']);
const RULE_SOURCE_POLICY = {
    MIXED: 'mixed',
    SYSTEM_ONLY: 'system-only'
};

class RuleService {
    constructor(rulesPath, userRulesPath, gitRepoPath, gitBranch, skillHubRepoPath) {
        this.rulesPath = rulesPath;
        this.userRulesPath = userRulesPath;
        this.gitRepoPath = gitRepoPath;
        this.skillHubRepoPath = skillHubRepoPath;
        this.gitBranch = gitBranch || 'main';
        const envProjectPath = process.env.EPOINT_PROJECT_PATH || null;
        const projectContext = this._resolveProjectContext(envProjectPath);
        this.projectRootPath = projectContext.projectRootPath;
        this.projectDocsPath = projectContext.projectDocsPath;
        this.ruleEntries = [];
        this.ruleMap = new Map(); // 规则名 -> 绝对路径
        this.nameToPathMap = new Map();

        // 1. 内容缓存 (LRU): 5分钟TTL
        this.contentCache = new NodeCache({ stdTTL: 300, checkperiod: 120 });

        // 2. [新增] 元数据缓存 (描述/关键词): 1小时TTL，键为 fullPath + mtime
        this.metadataCache = new NodeCache({ stdTTL: 3600, checkperiod: 600 });

        // 3. [新增] 规则列表内存快照
        this.ruleListCache = null;

        this.refreshRuleMap();
    }

    _isRuleDocFile(fileName) {
        return RULE_DOC_EXTENSIONS.has(path.extname(fileName).toLowerCase());
    }

    _resolveProjectContext(projectPath) {
        if (!projectPath || typeof projectPath !== 'string') {
            return {
                projectRootPath: null,
                projectDocsPath: null
            };
        }

        const resolvedProjectPath = path.resolve(projectPath.trim());
        if (!resolvedProjectPath) {
            return {
                projectRootPath: null,
                projectDocsPath: null
            };
        }

        let projectDocsPath = null;
        let projectRootPath = resolvedProjectPath;

        try {
            const currentStats = fs.statSync(resolvedProjectPath);
            if (!currentStats.isDirectory()) {
                return {
                    projectRootPath,
                    projectDocsPath: null
                };
            }
        } catch (_) {
            return {
                projectRootPath,
                projectDocsPath: null
            };
        }

        const baseName = path.basename(resolvedProjectPath).toLowerCase();
        const parentName = path.basename(path.dirname(resolvedProjectPath)).toLowerCase();
        if (baseName === PipelineUtils.AI_WORKSPACE_KNOWLEDGE_DIR_NAME
            && parentName === PipelineUtils.AI_WORKSPACE_DIR_NAME) {
            projectDocsPath = resolvedProjectPath;
            projectRootPath = path.dirname(path.dirname(resolvedProjectPath));
        } else if (baseName === PipelineUtils.AI_WORKSPACE_DIR_NAME) {
            const knowledgePath = path.join(resolvedProjectPath, PipelineUtils.AI_WORKSPACE_KNOWLEDGE_DIR_NAME);
            projectDocsPath = fs.existsSync(knowledgePath) && fs.statSync(knowledgePath).isDirectory()
                ? knowledgePath
                : null;
            projectRootPath = path.dirname(resolvedProjectPath);
        } else {
            const docsPath = PipelineUtils.getKnowledgeBaseDir(resolvedProjectPath);
            try {
                projectDocsPath = fs.existsSync(docsPath) && fs.statSync(docsPath).isDirectory()
                    ? docsPath
                    : null;
            } catch (_) {
                projectDocsPath = null;
            }
        }

        return {
            projectRootPath,
            projectDocsPath
        };
    }

    _syncProjectDocsPath(projectPath) {
        if (projectPath === undefined) return;

        const projectContext = this._resolveProjectContext(projectPath);
        const nextProjectRoot = projectContext.projectRootPath;
        const nextProjectDocsPath = projectContext.projectDocsPath;
        const changed = this.projectRootPath !== nextProjectRoot || this.projectDocsPath !== nextProjectDocsPath;

        if (changed) {
            this.projectRootPath = nextProjectRoot;
            this.projectDocsPath = nextProjectDocsPath;
            this.refreshRuleMap();
        }
    }

    refreshRuleMap() {
        this.ruleEntries = [];
        this.ruleMap.clear();
        this.nameToPathMap = new Map();

        const scan = (dir, source, relPath = '') => {
            if (!fs.existsSync(dir)) return;
            const items = fs.readdirSync(dir);
            for (const item of items) {
                const fullPath = path.join(dir, item);
                const stat = fs.statSync(fullPath);
                if (stat.isDirectory()) {
                    scan(fullPath, source, path.join(relPath, item));
                } else if (this._isRuleDocFile(item)) {
                    const ext = path.extname(item);
                    const ruleName = path.basename(item, ext);
                    const relativePath = path.join(relPath, ruleName).replace(/\\/g, '/');

                    this.ruleEntries.push({
                        name: relativePath,
                        path: fullPath,
                        source
                    });

                    if (source === 'user' || !this.ruleMap.has(relativePath)) {
                        this.ruleMap.set(relativePath, fullPath);
                    }
                    if (source === 'user' || !this.nameToPathMap.has(ruleName)) {
                        this.nameToPathMap.set(ruleName, fullPath);
                    }
                }
            }
        };

        // 1. 扫描各个仓库（优先使用注入的物理路径）
        const repos = [
            { path: this.gitRepoPath || path.join(this.rulesPath, '.project_repo'), name: '.project_repo' },
            { path: this.skillHubRepoPath || path.join(this.rulesPath, '.skill_hub_repo'), name: '.skill_hub_repo' },
            { path: path.join(this.rulesPath, '.product_repo'), name: '.product_repo' }
        ];

        repos.forEach(repo => {
            if (repo.path && fs.existsSync(repo.path)) {
                scan(repo.path, 'system', repo.name);
            }
        });

        // 2. 扫描根目录 (兼容旧版或手动放置的情况)
        if (fs.existsSync(this.rulesPath)) {
            const items = fs.readdirSync(this.rulesPath);
            for (const item of items) {
                if (repoDirs.includes(item)) continue;
                const fullPath = path.join(this.rulesPath, item);
                const stat = fs.statSync(fullPath);
                if (stat.isDirectory()) {
                    scan(fullPath, 'system', item);
                } else if (this._isRuleDocFile(item)) {
                    // 如果根目录下直接有文件，则扫描一遍根目录（scan 本身是递归的，传空 relPath 即可）
                    // 注意：这里为了不重复扫描子仓库，其实可以在上面循环外单独处理文件
                }
            }
            // 扫描根目录下的文件
            const files = fs.readdirSync(this.rulesPath).filter(f => this._isRuleDocFile(f));
            files.forEach(f => {
                const fullPath = path.join(this.rulesPath, f);
                const ruleName = path.basename(f, path.extname(f));
                this.ruleEntries.push({
                    name: ruleName,
                    path: fullPath,
                    source: 'system'
                });
                if (!this.ruleMap.has(ruleName)) {
                    this.ruleMap.set(ruleName, fullPath);
                    this.nameToPathMap.set(ruleName, fullPath);
                }
            });
        }

        if (this.projectDocsPath) {
            scan(this.projectDocsPath, 'project', 'project_docs');
        }

        if (this.userRulesPath) scan(this.userRulesPath, 'user');
        this.clearAllCache();
    }

    _normalizeSourcePolicy(sourcePolicy = RULE_SOURCE_POLICY.MIXED) {
        return String(sourcePolicy || RULE_SOURCE_POLICY.MIXED).trim() === RULE_SOURCE_POLICY.SYSTEM_ONLY
            ? RULE_SOURCE_POLICY.SYSTEM_ONLY
            : RULE_SOURCE_POLICY.MIXED;
    }

    _getAllowedSourcesForPolicy(sourcePolicy = RULE_SOURCE_POLICY.MIXED) {
        const normalizedPolicy = this._normalizeSourcePolicy(sourcePolicy);
        if (normalizedPolicy === RULE_SOURCE_POLICY.SYSTEM_ONLY) {
            return new Set(['system']);
        }
        return null;
    }

    _isSourceAllowed(source = '', sourcePolicy = RULE_SOURCE_POLICY.MIXED) {
        const allowedSources = this._getAllowedSourcesForPolicy(sourcePolicy);
        return !allowedSources || allowedSources.has(String(source || '').trim());
    }

    _normalizeRuleLookupName(ruleName = '') {
        return String(ruleName || '').trim().replace(/\\/g, '/');
    }

    _getRuleBaseName(ruleName = '') {
        const normalizedName = this._normalizeRuleLookupName(ruleName);
        if (!normalizedName) return '';
        const ext = path.extname(normalizedName);
        return ext ? path.basename(normalizedName, ext) : path.basename(normalizedName);
    }

    _getRuleMatchLevel(entryName = '', normalizedName = '', baseName = '') {
        if (!entryName || !baseName) return 0;
        if (entryName === normalizedName) return 400;
        if (path.basename(entryName) === baseName) return 300;
        if (entryName.endsWith(`/${baseName}`)) return 250;
        return 0;
    }

    _collectRuleCandidates(ruleName, options = {}) {
        this._syncProjectDocsPath(options.projectPath);
        const normalizedName = this._normalizeRuleLookupName(ruleName);
        const baseName = this._getRuleBaseName(normalizedName);
        if (!normalizedName || !baseName) return [];

        return this.ruleEntries
            .map(entry => {
                const matchLevel = this._getRuleMatchLevel(entry.name, normalizedName, baseName);
                if (matchLevel <= 0) return null;
                return {
                    ...entry,
                    matchLevel,
                    sourcePriority: this._getRuleSourcePriority(entry.source),
                    depth: String(entry.name || '').split('/').length
                };
            })
            .filter(Boolean)
            .sort((a, b) => {
                if (b.matchLevel !== a.matchLevel) return b.matchLevel - a.matchLevel;
                if (b.sourcePriority !== a.sourcePriority) return b.sourcePriority - a.sourcePriority;
                if (a.depth !== b.depth) return a.depth - b.depth;
                return String(a.name || '').localeCompare(String(b.name || ''));
            });
    }

    _inferSourceFromPath(filePath = '') {
        const normalizedPath = String(filePath || '').trim().toLowerCase();
        if (!normalizedPath) return '';
        if (this.projectDocsPath && normalizedPath.startsWith(path.resolve(this.projectDocsPath).toLowerCase())) {
            return 'project';
        }
        if (this.userRulesPath && normalizedPath.startsWith(path.resolve(this.userRulesPath).toLowerCase())) {
            return 'user';
        }
        if (this.rulesPath && normalizedPath.startsWith(path.resolve(this.rulesPath).toLowerCase())) {
            return 'system';
        }
        return 'absolute';
    }

    _resolveLegacyPath(ruleName) {
        const tryPaths = [
            path.join(this.rulesPath, `${ruleName}.mdc`),
            path.join(this.rulesPath, `${ruleName}.md`),
            this.projectDocsPath ? path.join(this.projectDocsPath, `${ruleName}.mdc`) : null,
            this.projectDocsPath ? path.join(this.projectDocsPath, `${ruleName}.md`) : null,
            this.userRulesPath ? path.join(this.userRulesPath, `${ruleName}.mdc`) : null,
            this.userRulesPath ? path.join(this.userRulesPath, `${ruleName}.md`) : null
        ].filter(Boolean);

        for (const candidatePath of tryPaths) {
            if (fs.existsSync(candidatePath)) return candidatePath;
        }
        return null;
    }

    _tryLoadRemoteRuleContent(ruleName, cacheKey) {
        const reposToTry = [
            { path: this.gitRepoPath, branch: this.gitBranch },
            { path: this.skillHubRepoPath, branch: 'main' }
        ];

        for (const repo of reposToTry) {
            if (!repo.path || !fs.existsSync(repo.path)) continue;
            try {
                const normalizedPath = this._normalizeRuleLookupName(ruleName);
                const { execSync } = require('child_process');
                const trySuffixes = normalizedPath.includes('.') ? [''] : ['.md', '.mdc'];
                for (const suffix of trySuffixes) {
                    try {
                        const gitPath = `origin/${repo.branch}:${normalizedPath}${suffix}`;
                        const content = execSync(`git show "${gitPath}"`, {
                            cwd: repo.path,
                            encoding: 'utf-8',
                            stdio: ['ignore', 'pipe', 'ignore']
                        });
                        if (content) {
                            const text = content.toString();
                            this.contentCache.set(cacheKey, text);
                            return {
                                content: text,
                                source: 'cloud',
                                path: `git://${repo.branch}/${normalizedPath}${suffix}`
                            };
                        }
                    } catch (_) { }
                }
            } catch (_) { }
        }

        return null;
    }

    resolveRule(ruleName, options = {}) {
        const normalizedName = this._normalizeRuleLookupName(ruleName);
        const sourcePolicy = this._normalizeSourcePolicy(options.sourcePolicy);
        if (!normalizedName) return null;

        if (path.isAbsolute(normalizedName) && fs.existsSync(normalizedName)) {
            const absoluteSource = this._inferSourceFromPath(normalizedName);
            if (!this._isSourceAllowed(absoluteSource, sourcePolicy)) {
                return null;
            }
            return {
                name: normalizedName,
                path: normalizedName,
                source: absoluteSource,
                sourcePolicy
            };
        }

        const candidates = this._collectRuleCandidates(normalizedName, options)
            .filter(candidate => this._isSourceAllowed(candidate.source, sourcePolicy));
        if (candidates.length > 0) {
            const winner = candidates[0];
            return {
                name: winner.name,
                path: winner.path,
                source: winner.source,
                sourcePolicy
            };
        }

        if (sourcePolicy === RULE_SOURCE_POLICY.SYSTEM_ONLY) {
            return null;
        }

        const legacyPath = this._resolveLegacyPath(normalizedName);
        if (legacyPath) {
            return {
                name: normalizedName,
                path: legacyPath,
                source: this._inferSourceFromPath(legacyPath),
                sourcePolicy
            };
        }

        return null;
    }

    getRuleDiagnostics(ruleName, options = {}) {
        const normalizedName = this._normalizeRuleLookupName(ruleName);
        const sourcePolicy = this._normalizeSourcePolicy(options.sourcePolicy);
        const candidates = this._collectRuleCandidates(normalizedName, options);
        const resolved = this.resolveRule(normalizedName, options);
        const resolvedPath = resolved && resolved.path ? path.resolve(resolved.path) : '';
        const ignoredCandidates = candidates
            .filter(candidate => !resolvedPath || path.resolve(candidate.path) !== resolvedPath)
            .filter(candidate => !this._isSourceAllowed(candidate.source, sourcePolicy) || !!resolvedPath)
            .map(candidate => ({
                name: candidate.name,
                path: candidate.path,
                source: candidate.source,
                ignoredReason: this._isSourceAllowed(candidate.source, sourcePolicy) ? 'shadowed' : `policy_blocked:${sourcePolicy}`
            }));

        return {
            ruleName: normalizedName,
            sourcePolicy,
            resolved,
            ignoredCandidates
        };
    }

    // 读取规范内容（带 LRU 缓存）
    getRuleContent(ruleName) {
        return this.getRuleContentByPolicy(ruleName, { sourcePolicy: RULE_SOURCE_POLICY.MIXED });
    }

    getRuleContentByPolicy(ruleName, options = {}) {
        const sourcePolicy = this._normalizeSourcePolicy(options.sourcePolicy);
        const resolved = this.resolveRule(ruleName, options);
        const cacheKey = `content:${sourcePolicy}:${resolved && resolved.path ? resolved.path : this._normalizeRuleLookupName(ruleName)}`;
        const cached = this.contentCache.get(cacheKey);
        if (cached !== undefined) {
            return cached;
        }

        if (resolved && resolved.path && fs.existsSync(resolved.path)) {
            try {
                const content = fs.readFileSync(resolved.path, 'utf-8');
                this.contentCache.set(cacheKey, content);
                return content;
            } catch (err) {
                console.error(`[RuleService] 读取文件失败: ${resolved.path}`, err.message);
                return null;
            }
        }

        if (sourcePolicy !== RULE_SOURCE_POLICY.SYSTEM_ONLY) {
            const remoteResult = this._tryLoadRemoteRuleContent(ruleName, cacheKey);
            if (remoteResult && remoteResult.content) {
                return remoteResult.content;
            }
        }

        return null;
    }

    // 缓存失效：当规则文件变更时调用
    invalidateCache(ruleName) {
        const normalizedName = this._normalizeRuleLookupName(ruleName);
        this.contentCache.keys()
            .filter(key => key.includes(normalizedName))
            .forEach(key => this.contentCache.del(key));
    }

    // 批量清理缓存（如 Git 同步后）
    clearAllCache() {
        this.contentCache.flushAll();
        this.metadataCache.flushAll();
        this.ruleListCache = null;
    }

    _inferRuleAlias(relativeName = '', metadata = {}) {
        return String(metadata.rule_alias || path.basename(String(relativeName || ''))).trim();
    }

    _inferFramework(relativeName = '', metadata = {}) {
        return String(metadata.framework || '').trim();
    }

    _inferVersionBucket(relativeName = '', metadata = {}) {
        const explicit = String(metadata.version_bucket || '').trim();
        if (VERSION_BUCKET_OPTIONS.has(explicit)) return explicit;
        const normalized = String(relativeName || '').replace(/\\/g, '/');
        const match = normalized.match(/(?:^|\/)(950及以上|950以下)(?:\/|$)/);
        return match ? match[1] : '';
    }

    _readFrontmatterMetadata(fullPath) {
        try {
            const fd = fs.openSync(fullPath, 'r');
            const chunks = [];
            const buffer = Buffer.alloc(4096);
            let total = 0;
            let bytesRead = 0;
            let text = '';
            do {
                bytesRead = fs.readSync(fd, buffer, 0, buffer.length, total);
                if (bytesRead > 0) {
                    chunks.push(Buffer.from(buffer.subarray(0, bytesRead)));
                    total += bytesRead;
                    text = Buffer.concat(chunks).toString('utf8');
                    if (!text.startsWith('---')) break;
                    if (/^---\s*[\r\n]+[\s\S]*?[\r\n]+---/.test(text)) break;
                }
            } while (bytesRead > 0 && total < 65536);
            fs.closeSync(fd);
            return this._parseFrontmatter(text);
        } catch (_) {
            return {};
        }
    }

    normalizeProjectAssetMetadata(relativeName = '', fullPath = '', source = '', metadata = {}) {
        const normalizedName = String(relativeName || '').replace(/\\/g, '/');
        const normalizedPath = String(fullPath || '').replace(/\\/g, '/');
        const normalized = {
            ...(metadata && typeof metadata === 'object' && !Array.isArray(metadata) ? metadata : {})
        };
        const category = String(normalized.category || '').trim();
        const explicitAssetType = String(normalized.asset_type || normalized.assetType || '').trim();
        const explicitLane = String(normalized.match_lane || normalized.matchLane || '').trim();
        let assetType = explicitAssetType;

        if (!assetType) {
            if (
                explicitLane === 'project_api_asset'
                || PROJECT_API_ASSET_CATEGORIES.has(category)
                || /(?:^|\/)项目规则\/(?:现成接口规则|API资产)(?:\/|$)/.test(normalizedName)
                || /(?:^|\/)项目规则\/(?:现成接口规则|API资产)(?:\/|$)/.test(normalizedPath)
            ) {
                assetType = 'project_api_asset';
            } else if (
                explicitLane === 'project_feature_asset'
                || PROJECT_FEATURE_ASSET_CATEGORIES.has(category)
                || /(?:^|\/)项目规则\/功能沉淀(?:\/|$)/.test(normalizedName)
                || /(?:^|\/)项目规则\/功能沉淀(?:\/|$)/.test(normalizedPath)
            ) {
                assetType = 'project_feature_asset';
            } else if (
                explicitLane === 'project_knowledge'
                || PROJECT_KNOWLEDGE_CATEGORIES.has(category)
                || /(?:^|\/)项目规则\/需求沉淀(?:\/|$)/.test(normalizedName)
                || /(?:^|\/)项目规则\/需求沉淀(?:\/|$)/.test(normalizedPath)
            ) {
                assetType = 'project_knowledge';
            } else {
                assetType = 'hard_rule';
            }
        }

        if (!String(normalized.match_lane || '').trim()) {
            if (assetType === 'project_api_asset') normalized.match_lane = 'project_api_asset';
            if (assetType === 'project_feature_asset') normalized.match_lane = 'project_feature_asset';
            if (assetType === 'project_knowledge') normalized.match_lane = 'project_knowledge';
        }
        if (!String(normalized.reference_policy || '').trim()) {
            if (assetType === 'project_api_asset' || assetType === 'project_feature_asset' || assetType === 'project_knowledge') {
                normalized.reference_policy = 'context_only';
            }
        }
        normalized.asset_type = assetType;
        return normalized;
    }

    _buildRuleListEntry(relativeName, fullPath, stats, source, metadata = {}) {
        const normalizedName = String(relativeName || '').replace(/\\/g, '/');
        const normalizedMetadata = this.normalizeProjectAssetMetadata(normalizedName, fullPath, source, metadata);
        return {
            name: normalizedName,
            id: normalizedName,
            path: fullPath,
            size: stats.size,
            mtime: stats.mtime,
            source,
            description: normalizedMetadata.description || '',
            keywords: normalizedMetadata.intent_keywords || [],
            category: normalizedMetadata.category || '未分类',
            ruleAlias: this._inferRuleAlias(normalizedName, normalizedMetadata),
            framework: this._inferFramework(normalizedName, normalizedMetadata),
            versionBucket: this._inferVersionBucket(normalizedName, normalizedMetadata),
            assetType: String(normalizedMetadata.asset_type || '').trim(),
            matchLane: String(normalizedMetadata.match_lane || '').trim(),
            referencePolicy: String(normalizedMetadata.reference_policy || '').trim(),
            pipelineVisibility: normalizedMetadata.pipeline_visibility && typeof normalizedMetadata.pipeline_visibility === 'object'
                ? normalizedMetadata.pipeline_visibility
                : {},
            websiteConsumption: normalizedMetadata.website_consumption && typeof normalizedMetadata.website_consumption === 'object'
                ? normalizedMetadata.website_consumption
                : {},
            metadata: normalizedMetadata
        };
    }

    _getRuleSourcePriority(source = '') {
        switch (source) {
        case 'user': return 400;
        case 'project': return 300;
        case 'system': return 200;
        case 'cloud': return 100;
        default: return 0;
        }
    }

    /**
     * 解析规则名到文件路径（内部方法，复用逻辑）
     * @param {string} ruleName - 规则名称
     * @returns {string|null} 文件路径或 null
     */
    _resolvePath(ruleName) {
        const resolved = this.resolveRule(ruleName, { sourcePolicy: RULE_SOURCE_POLICY.MIXED });
        return resolved ? resolved.path : null;
    }

    /**
     * 异步读取规范内容（带 LRU 缓存）
     * 适用于批量操作或热路径，避免阻塞事件循环
     * @param {string} ruleName - 规则名称
     * @returns {Promise<string|null>} 规则内容或 null
     */
    async getRuleContentAsync(ruleName, options = {}) {
        const sourcePolicy = this._normalizeSourcePolicy(options.sourcePolicy);
        const resolved = this.resolveRule(ruleName, options);
        const cacheKey = `content:${sourcePolicy}:${resolved && resolved.path ? resolved.path : this._normalizeRuleLookupName(ruleName)}`;
        const cached = this.contentCache.get(cacheKey);
        if (cached !== undefined) {
            return cached;
        }

        if (!resolved || !resolved.path || !fs.existsSync(resolved.path)) {
            if (sourcePolicy !== RULE_SOURCE_POLICY.SYSTEM_ONLY) {
                const remoteResult = this._tryLoadRemoteRuleContent(ruleName, cacheKey);
                return remoteResult ? remoteResult.content : null;
            }
            return null;
        }

        try {
            const content = await fsPromises.readFile(resolved.path, 'utf-8');
            this.contentCache.set(cacheKey, content);
            return content;
        } catch (err) {
            console.error(`[RuleService] 异步读取文件失败: ${resolved.path}`, err.message);
            return null;
        }
    }

    // 解析 Frontmatter
    _parseFrontmatter(content) {
        const match = content.match(/^---\s*[\r\n]+([\s\S]*?)[\r\n]+---/);
        if (!match) return {};
        try {
            const payload = yaml.load(match[1]) || {};
            if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return {};
            return payload;
        } catch (_) {
            return {};
        }
    }

    // 列出所有规范 (携带元数据) - 高性能版本
    listRules(projectPath) {
        this._syncProjectDocsPath(projectPath);
        // 1. 优先从内存快照返回
        if (this.ruleListCache) {
            return this.ruleListCache;
        }

        const rules = [];
        const getRulesFromPath = (dirPath, source, relPath = '') => {
            if (!fs.existsSync(dirPath)) return;
            const stats = fs.statSync(dirPath);
            if (!stats.isDirectory()) return;

            const files = fs.readdirSync(dirPath);
            files.forEach(file => {
                const fullPath = path.join(dirPath, file);
                try {
                    const stats = fs.statSync(fullPath);

                    if (stats.isDirectory()) {
                        getRulesFromPath(fullPath, source, path.join(relPath, file));
                    } else if (this._isRuleDocFile(file)) {
                        const ext = path.extname(file);
                        const mtime = stats.mtimeMs;
                        const cacheKey = `${fullPath}:${mtime}`;

                        // 2. 尝试从元数据缓存获取
                        let metadata = this.metadataCache.get(cacheKey);

                        if (!metadata) {
                            try {
                                metadata = this._readFrontmatterMetadata(fullPath);
                                // 存入元数据缓存
                                this.metadataCache.set(cacheKey, metadata);
                            } catch (e) {
                                metadata = {};
                            }
                        }

                        rules.push(this._buildRuleListEntry(
                            path.join(relPath, path.basename(file, ext)),
                            fullPath,
                            stats,
                            source,
                            metadata
                        ));
                    }
                } catch (err) {
                    // 忽略单个文件错误
                }
            });
        };

        const repoDirs = ['.project_repo', '.product_repo', '.skill_hub_repo'];
        repoDirs.forEach(repoDir => {
            const repoPath = path.join(this.rulesPath, repoDir);
            if (fs.existsSync(repoPath)) {
                getRulesFromPath(repoPath, 'system', repoDir);
            }
        });

        if (fs.existsSync(this.rulesPath)) {
            const items = fs.readdirSync(this.rulesPath);
            for (const item of items) {
                if (repoDirs.includes(item)) continue;
                const fullPath = path.join(this.rulesPath, item);
                const stats = fs.statSync(fullPath);

                if (stats.isDirectory()) {
                    getRulesFromPath(fullPath, 'system', item);
                } else if (this._isRuleDocFile(item)) {
                    // 处理根目录下的规范文件
                    const ext = path.extname(item);
                    const mtime = stats.mtimeMs;
                    const cacheKey = `${fullPath}:${mtime}`;

                    let metadata = this.metadataCache.get(cacheKey);
                    if (!metadata) {
                        try {
                            metadata = this._readFrontmatterMetadata(fullPath);
                            this.metadataCache.set(cacheKey, metadata);
                        } catch (e) {
                            metadata = {};
                        }
                    }

                    rules.push(this._buildRuleListEntry(
                        path.basename(item, ext),
                        fullPath,
                        stats,
                        'system',
                        metadata
                    ));
                }
            }
        }

        if (this.projectDocsPath) {
            getRulesFromPath(this.projectDocsPath, 'project', 'project_docs');
        }

        if (this.userRulesPath) {
            getRulesFromPath(this.userRulesPath, 'user');
        }

        // 4. [新增] 穿透 Git 索引获取远程技能列表 (实现 100% 零物理文件发现)
        const remoteRepos = [
            { path: this.gitRepoPath, branch: this.gitBranch, source: 'cloud-rules' },
            { path: this.skillHubRepoPath, branch: 'main', source: 'skill-hub' }
        ];

        remoteRepos.forEach(repo => {
            if (repo.path && fs.existsSync(repo.path)) {
                try {
                    const { execSync } = require('child_process');
                    // 仅获取 .md 和 .mdc 文件，且深度限制在 3 层内
                    const output = execSync(`git ls-tree -r --name-only origin/${repo.branch}`, {
                        cwd: repo.path,
                        encoding: 'utf-8',
                        stdio: ['ignore', 'pipe', 'ignore']
                    });

                    if (output) {
                        const files = output.split('\n').filter(f => this._isRuleDocFile(f));
                        files.forEach(file => {
                            const name = file.replace(/\.(md|mdc)$/, '');
                            // 如果本地已经存在同名规则，则跳过远程版本以本地为准
                            if (!rules.find(r => r.name === name)) {
                                rules.push({
                                    name: name,
                                    id: name,
                                    path: `git://${repo.source}/${file}`, // 虚拟路径标识
                                    size: 0,
                                    mtime: new Date(),
                                    source: 'cloud',
                                    description: `[远程] 自 ${repo.source}`,
                                    keywords: [],
                                    category: repo.source === 'skill-hub' ? '🧩 远程技能' : '🌐 云端规约',
                                    ruleAlias: path.basename(name),
                                    framework: '',
                                    versionBucket: this._inferVersionBucket(name, {})
                                });
                            }
                        });
                    }
                } catch (e) {
                    // Ignore git errors
                }
            }
        });

        // 5. 结果存入快照
        this.ruleListCache = rules;
        return rules;
    }

    resolveVersionedRule(options = {}) {
        const alias = String(options.alias || '').trim();
        const framework = String(options.framework || '').trim();
        const versionBucket = String(options.versionBucket || '').trim();
        const projectPath = options.projectPath;
        if (!alias || !versionBucket) return null;

        const candidates = this.listRules(projectPath)
            .filter(rule => String(rule.ruleAlias || '').trim() === alias)
            .filter(rule => String(rule.versionBucket || '').trim() === versionBucket)
            .filter(rule => !framework || !String(rule.framework || '').trim() || String(rule.framework || '').trim() === framework)
            .sort((a, b) => this._getRuleSourcePriority(b.source) - this._getRuleSourcePriority(a.source));

        if (candidates.length === 0) return null;
        const target = candidates[0];
        const content = this.getRuleContent(target.name) || '';
        if (!content.trim()) return null;

        return { rule: target, content };
    }

    // 搜索规范（利用缓存）
    searchRules(keyword, projectPath) {
        const allRules = this.listRules(projectPath);
        const results = [];
        const lowerKeyword = keyword.toLowerCase();

        for (const rule of allRules) {
            // 使用 getRuleContent 以利用缓存
            const content = this.getRuleContent(rule.name) || '';
            if (rule.name.toLowerCase().includes(lowerKeyword) || content.toLowerCase().includes(lowerKeyword)) {
                results.push({
                    ...rule,
                    matchCount: (content.toLowerCase().match(new RegExp(lowerKeyword, 'g')) || []).length
                });
            }
        }

        return results.sort((a, b) => b.matchCount - a.matchCount);
    }

    /**
     * 异步搜索规范（带并发控制）
     * 适用于大量规则时的搜索场景
     * @param {string} keyword - 搜索关键词
     * @param {number} concurrency - 并发数限制，默认 10
     * @returns {Promise<Array>} 搜索结果
     */
    async searchRulesAsync(keyword, concurrency = 10, projectPath) {
        const allRules = this.listRules(projectPath);
        const lowerKeyword = keyword.toLowerCase();
        const results = [];

        // 分批并发处理
        for (let i = 0; i < allRules.length; i += concurrency) {
            const batch = allRules.slice(i, i + concurrency);
            const batchPromises = batch.map(async (rule) => {
                const content = await this.getRuleContentAsync(rule.name) || '';
                if (rule.name.toLowerCase().includes(lowerKeyword) || content.toLowerCase().includes(lowerKeyword)) {
                    return {
                        ...rule,
                        matchCount: (content.toLowerCase().match(new RegExp(lowerKeyword, 'g')) || []).length
                    };
                }
                return null;
            });

            const batchResults = await Promise.allSettled(batchPromises);
            for (const result of batchResults) {
                if (result.status === 'fulfilled' && result.value) {
                    results.push(result.value);
                }
            }
        }

        return results.sort((a, b) => b.matchCount - a.matchCount);
    }

    // 获取规则目录结构
    getRuleStructure() {
        return {
            systemRules: this.buildDirectoryStructure(this.rulesPath, 'system'),
            userRules: this.userRulesPath ? this.buildDirectoryStructure(this.userRulesPath, 'user') : null
        };
    }

    buildDirectoryStructure(dirPath, dirName, depth = 0) {
        if (!fs.existsSync(dirPath)) return null;

        const stats = fs.statSync(dirPath);
        const info = {
            name: dirName,
            path: dirPath,
            type: stats.isDirectory() ? 'directory' : 'file'
        };

        if (stats.isDirectory() && depth < 3) {
            info.children = fs.readdirSync(dirPath).map(child => {
                return this.buildDirectoryStructure(path.join(dirPath, child), child, depth + 1);
            }).filter(Boolean);
        }

        return info;
    }

    // 读取规范文件内容（清理 YAML 头部）
    readRuleFile(ruleName) {
        if (!ruleName) return null;
        const content = this.getRuleContent(ruleName);
        if (content) {
            // 移除 YAML frontmatter (--- ... ---)
            return content.replace(/^---[\s\S]*?---\s*/, '');
        }
        return null;
    }

    // 检查规则是否存在
    ruleExists(ruleName) {
        if (!ruleName) return false;
        return !!this.resolveRule(ruleName, { sourcePolicy: RULE_SOURCE_POLICY.MIXED });
    }

    // 将规则列表分为 已存在 和 不存在 两个集合
    partitionExistingRules(ruleNames) {
        const availableRules = [];
        const missingRules = [];

        for (const name of ruleNames) {
            if (this.ruleExists(name)) {
                availableRules.push(name);
            } else {
                missingRules.push(name);
            }
        }

        return { availableRules, missingRules };
    }

    /**
     * 创建用户规范文件
     * @param {Object} options - 规范配置
     * @param {string} options.ruleName - 规范名称（不含扩展名）
     * @param {string} options.description - 规范简要描述
     * @param {string} options.category - 规则分类（如 '🧩 扩展功能'）
     * @param {string[]} options.intentKeywords - 意图关键词列表
     * @param {string} options.ruleContent - 规范正文内容（Markdown）
     * @param {boolean} options.overwrite - 是否覆盖已存在的文件
     * @returns {Object} 创建结果
     */
    createUserRule(options) {
        const {
            ruleName,
            description,
            category = '📄 用户自定义',
            intentKeywords = [],
            ruleContent,
            overwrite = false
        } = options;

        // 1. 检查用户规则目录
        if (!this.userRulesPath) {
            return { success: false, error: '用户规则目录未配置，请先在 VS Code 设置中配置 epointProjectRules.userRulesPath' };
        }

        // 确保目录存在
        if (!fs.existsSync(this.userRulesPath)) {
            fs.mkdirSync(this.userRulesPath, { recursive: true });
        }

        // 2. 文件名安全检查
        if (!ruleName || ruleName.includes('..') || ruleName.includes('/') || ruleName.includes('\\')) {
            return { success: false, error: '规范名称不合法，不能包含路径分隔符' };
        }

        const filePath = path.join(this.userRulesPath, `${ruleName}.md`);

        // 3. 检查文件是否已存在
        if (fs.existsSync(filePath) && !overwrite) {
            return { success: false, error: `规范文件 "${ruleName}.md" 已存在，如需覆盖请设置 overwrite: true` };
        }

        // 4. 构建 frontmatter
        const keywordsStr = intentKeywords.length > 0
            ? `[${intentKeywords.join(', ')}]`
            : '[]';

        const timestamp = new Date().toLocaleString('zh-CN');

        const fullContent = `---
description: ${description}
category: ${category}
intent_keywords: ${keywordsStr}
---

# ${ruleName}

${ruleContent}

---
> 📝 此规范由 AI 自动生成于 ${timestamp}
`;

        // 5. 写入文件
        try {
            fs.writeFileSync(filePath, fullContent, 'utf-8');
        } catch (err) {
            return { success: false, error: `写入文件失败: ${err.message}` };
        }

        // 6. 刷新规则映射
        this.refreshRuleMap();

        return {
            success: true,
            filePath,
            message: `规范 "${ruleName}" 已成功创建`
        };
    }

    /**
     * 获取 AI Agent 核心规则列表
     * 动态读取所有标记了 aiAgentCore: true 的规则
     * @returns {string[]} 核心规则名称数组
     */
    getCoreRules() {
        const coreRules = [];
        const rules = this.listRules();

        for (const rule of rules) {
            const content = this.getRuleContent(rule.name);
            if (content && /aiAgentCore:\s*true/i.test(content)) {
                coreRules.push(rule.name);
            }
        }

        return coreRules;
    }
}

module.exports = RuleService;
