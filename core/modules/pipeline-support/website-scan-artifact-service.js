/* eslint-disable */
const fs = require('fs');
const path = require('path');
const PageCompositionExtractor = require('../page-composition-extractor');

class WebsiteScanArtifactService {
    constructor(options = {}) {
        this.getProjectStructurePaths = typeof options.getProjectStructurePaths === 'function'
            ? options.getProjectStructurePaths
            : () => ({});
        this.getProjectApiCatalogPaths = typeof options.getProjectApiCatalogPaths === 'function'
            ? options.getProjectApiCatalogPaths
            : () => ({});
        this.getWebsiteArtifactPaths = typeof options.getWebsiteArtifactPaths === 'function'
            ? options.getWebsiteArtifactPaths
            : () => ({});
        this.ensureDirectoryExists = typeof options.ensureDirectoryExists === 'function'
            ? options.ensureDirectoryExists
            : () => {};
        this.fileExists = typeof options.fileExists === 'function'
            ? options.fileExists
            : filePath => Boolean(filePath && fs.existsSync(filePath));
        this.readTextFile = typeof options.readTextFile === 'function'
            ? options.readTextFile
            : filePath => fs.readFileSync(filePath, 'utf-8');
        this.writeTextArtifact = typeof options.writeTextArtifact === 'function'
            ? options.writeTextArtifact
            : (filePath, content) => {
                this.ensureDirectoryExists(path.dirname(filePath));
                fs.writeFileSync(filePath, content, 'utf-8');
                return filePath;
            };
        this.getWebsiteScanStageConfig = typeof options.getWebsiteScanStageConfig === 'function'
            ? options.getWebsiteScanStageConfig
            : () => ({});
        this.isForceRefreshScan = typeof options.isForceRefreshScan === 'function'
            ? options.isForceRefreshScan
            : () => false;
        this.extractSamplePageInput = typeof options.extractSamplePageInput === 'function'
            ? options.extractSamplePageInput
            : () => '';
        this.extractWebsiteTripleAnchorInputs = typeof options.extractWebsiteTripleAnchorInputs === 'function'
            ? options.extractWebsiteTripleAnchorInputs
            : (userIntent, existing = {}) => ({
                samplePage: this.extractSamplePageInput(userIntent) || String(existing.samplePage || '').trim(),
                targetFolder: String(existing.targetFolder || '').trim(),
                subPath: String(existing.subPath || '').trim(),
                missingKeys: ['samplePage', 'targetFolder'].filter(key => !existing[key] && !(key === 'samplePage' && this.extractSamplePageInput(userIntent)))
            });
        this.ensureWebsiteNavigationArtifacts = typeof options.ensureWebsiteNavigationArtifacts === 'function'
            ? options.ensureWebsiteNavigationArtifacts
            : () => ({ ok: false, message: 'WEBSITE_NAVIGATION_SERVICE_MISSING' });
        this.validateWebsiteNavigationArtifacts = typeof options.validateWebsiteNavigationArtifacts === 'function'
            ? options.validateWebsiteNavigationArtifacts
            : () => ({ ok: false, message: 'WEBSITE_NAVIGATION_VALIDATOR_MISSING' });
        this.validateProjectApiCatalog = typeof options.validateProjectApiCatalog === 'function'
            ? options.validateProjectApiCatalog
            : () => ({ ok: false, message: 'PROJECT_API_CATALOG_VALIDATOR_MISSING' });
        this.validateFrameworkVersionBucket = typeof options.validateFrameworkVersionBucket === 'function'
            ? options.validateFrameworkVersionBucket
            : () => ({ ok: false, message: 'FRAMEWORK_VERSION_BUCKET_VALIDATOR_MISSING' });
        this.ensureProjectApiCatalog = typeof options.ensureProjectApiCatalog === 'function'
            ? options.ensureProjectApiCatalog
            : () => ({ ok: false, message: 'PROJECT_API_CATALOG_ENSURE_MISSING' });
        this.extractPageComposition = typeof options.extractPageComposition === 'function'
            ? options.extractPageComposition
            : (filePaths, projectPath) => PageCompositionExtractor.extract(filePaths, projectPath);
        this.renderPageCompositionMarkdown = typeof options.renderPageCompositionMarkdown === 'function'
            ? options.renderPageCompositionMarkdown
            : payload => PageCompositionExtractor.toMarkdown(payload);
        this.pageRulesService = options.pageRulesService;
    }

    isOptionalEmptyProjectApiCatalog(validation = {}) {
        return !!(
            validation
            && validation.ok === false
            && /PROJECT_API_RULES_EMPTY\b/.test(String(validation.message || ''))
        );
    }

    normalizeProjectApiCatalogState(validation = {}) {
        if (this.isOptionalEmptyProjectApiCatalog(validation)) {
            return {
                ok: true,
                empty: true,
                optional: true,
                message: validation.message || 'PROJECT_API_RULES_EMPTY',
                paths: validation.paths || null
            };
        }
        return validation;
    }

    prepareArtifacts(projectPath, artifactPath, userIntent = '', options = {}) {
        const globalPaths = this.getProjectStructurePaths(projectPath);
        const apiPaths = this.getProjectApiCatalogPaths(projectPath);
        const localPaths = this.getWebsiteArtifactPaths(artifactPath);
        const scanConfig = this.getWebsiteScanStageConfig();
        const forceRefresh = this.isForceRefreshScan(userIntent);
        const source = 'global-cache';
        const existingTripleAnchors = options && options.websiteTripleAnchors && typeof options.websiteTripleAnchors === 'object'
            ? options.websiteTripleAnchors
            : {};
        const websiteTripleAnchors = this.extractWebsiteTripleAnchorInputs(userIntent, existingTripleAnchors);
        this.ensureDirectoryExists(globalPaths.structureDir);

        let pageRulesState = this.pageRulesService.prepareArtifacts(globalPaths, {
            forceRefresh,
            scanConfig,
            source
        });
        let effectiveSource = source;
        let pageRulesValidation = pageRulesState.ok
            ? { ok: true, content: pageRulesState.content, path: pageRulesState.path }
            : pageRulesState;

        const apiCatalogState = this.normalizeProjectApiCatalogState(this.ensureProjectApiCatalog(projectPath, {
            forceRefresh,
            errorMessagePrefix: '❌ 网站 scan 初始化项目 API 资产失败：',
            invalidMessagePrefix: '❌ 网站 scan 初始化项目 API 资产失败：'
        }));

        if (!pageRulesValidation.ok && /^RULE_STAGE_CONTRACT_MISSING:/i.test(String(pageRulesValidation.message || ''))) {
            return {
                ok: false,
                forceRefresh,
                globalPaths,
                apiPaths,
                localPaths,
                apiCatalogState,
                message: pageRulesValidation.message
            };
        }

        let autoRebuildState = null;
        if (!pageRulesValidation.ok && this._canAutoRebuildPageRules(websiteTripleAnchors)) {
            autoRebuildState = this._autoRebuildPageRules(projectPath, globalPaths, websiteTripleAnchors);
            if (autoRebuildState.ok) {
                effectiveSource = forceRefresh ? 'forced-refresh' : 'rebuilt';
                pageRulesState = this.pageRulesService.prepareArtifacts(globalPaths, {
                    forceRefresh: false,
                    scanConfig,
                    source: effectiveSource
                });
                pageRulesValidation = pageRulesState.ok
                    ? { ok: true, content: pageRulesState.content, path: pageRulesState.path }
                    : pageRulesState;
            }
        }

        if (pageRulesValidation.ok) {
            const navigationResult = this.ensureWebsiteNavigationArtifacts(projectPath, forceRefresh, { userIntent });
            if (!navigationResult.ok) {
                return {
                    ok: false,
                    forceRefresh,
                    globalPaths,
                    apiPaths,
                    localPaths,
                    message: `❌ 网站 scan 初始化工程导航契约失败：${navigationResult.message}`
                };
            }
            if (!pageRulesState.ok) {
                return {
                    ok: false,
                    forceRefresh,
                    globalPaths,
                    apiPaths,
                    localPaths,
                    message: pageRulesState.message || 'WEBSITE_PAGE_RULES_INVALID'
                };
            }

            if (!apiCatalogState.ok && !this.isOptionalEmptyProjectApiCatalog(apiCatalogState)) {
                return {
                    ok: false,
                    forceRefresh,
                    globalPaths,
                    apiPaths,
                    localPaths,
                    message: apiCatalogState.message
                };
            }

            return {
                ok: true,
                source: effectiveSource,
                forceRefresh,
                globalPaths,
                apiPaths,
                localPaths,
                apiCatalogState,
                autoRebuildState,
                paths: localPaths
            };
        }

        const autoRebuildFailure = autoRebuildState && autoRebuildState.ok === false ? autoRebuildState : null;
        const invalidSamplePages = autoRebuildFailure && Array.isArray(autoRebuildFailure.missingSamplePages)
            ? autoRebuildFailure.missingSamplePages
            : [];
        const pendingMissingKeys = Array.isArray(websiteTripleAnchors.missingKeys) ? websiteTripleAnchors.missingKeys.slice() : [];
        if (invalidSamplePages.length > 0 && !pendingMissingKeys.includes('samplePage')) {
            pendingMissingKeys.push('samplePage');
        }

        return {
            ok: false,
            needsRebuild: true,
            forceRefresh,
            globalPaths,
            apiPaths,
            localPaths,
            apiCatalogState,
            autoRebuildState,
            samplePage: websiteTripleAnchors.samplePage || '',
            samplePages: Array.isArray(websiteTripleAnchors.samplePages) ? websiteTripleAnchors.samplePages.slice() : [],
            targetFolder: websiteTripleAnchors.targetFolder || '',
            subPath: websiteTripleAnchors.subPath || '',
            invalidSamplePages,
            missingKeys: pendingMissingKeys,
            websiteTripleAnchors,
            message: (autoRebuildFailure ? autoRebuildFailure.message : '') || pageRulesValidation.message || 'WEBSITE_PAGE_RULES_REBUILD_REQUIRED'
        };
    }

    _canAutoRebuildPageRules(websiteTripleAnchors = {}) {
        const samplePages = Array.isArray(websiteTripleAnchors.samplePages)
            ? websiteTripleAnchors.samplePages.map(item => String(item || '').trim()).filter(Boolean)
            : (websiteTripleAnchors.samplePage ? [String(websiteTripleAnchors.samplePage || '').trim()] : []);
        const targetFolder = String(websiteTripleAnchors.targetFolder || '').trim();
        return samplePages.length > 0 && Boolean(targetFolder);
    }

    _autoRebuildPageRules(projectPath, globalPaths, websiteTripleAnchors = {}) {
        const sampleState = this._collectAutoRebuildSampleFiles(projectPath, websiteTripleAnchors);
        const sampleFiles = sampleState.sampleFiles || [];
        if (sampleFiles.length === 0) {
            return {
                ok: false,
                message: sampleState.missingSamplePages && sampleState.missingSamplePages.length > 0
                    ? `WEBSITE_PAGE_RULES_SAMPLE_FILE_NOT_FOUND: ${sampleState.missingSamplePages.join(', ')}`
                    : 'WEBSITE_PAGE_RULES_AUTO_REBUILD_INPUT_MISSING',
                missingSamplePages: sampleState.missingSamplePages || []
            };
        }

        const compositionState = this.extractPageComposition(sampleFiles, projectPath);
        if (!compositionState || compositionState.ok === false) {
            return {
                ok: false,
                message: compositionState && compositionState.message
                    ? compositionState.message
                    : 'WEBSITE_PAGE_RULES_AUTO_REBUILD_EXTRACT_FAILED'
            };
        }
        const dataFlows = compositionState.pageComposition && Array.isArray(compositionState.pageComposition.dataFlows)
            ? compositionState.pageComposition.dataFlows
            : [];
        if (dataFlows.length === 0) {
            return {
                ok: false,
                message: 'WEBSITE_PAGE_RULES_FRONTEND_FACTS_MISSING: 参考页缺少数据调用证据或业务 JS 未解析；scan 已读取 HTML，但未从样本中抽到 Util.ajax/_settings 等前端业务调用，请补充可追踪的业务 JS 参考页。',
                sampleFiles,
                payload: compositionState
            };
        }

        const markdown = String(this.renderPageCompositionMarkdown(compositionState) || '').trim();
        if (!markdown) {
            return { ok: false, message: 'WEBSITE_PAGE_RULES_AUTO_REBUILD_MARKDOWN_EMPTY' };
        }

        this.writeTextArtifact(globalPaths.pageRulesPath, `${markdown}\n`);
        return {
            ok: true,
            path: globalPaths.pageRulesPath,
            sampleFiles,
            payload: compositionState
        };
    }

    _collectAutoRebuildSampleFiles(projectPath, websiteTripleAnchors = {}) {
        const rawSamplePages = Array.isArray(websiteTripleAnchors.samplePages)
            ? websiteTripleAnchors.samplePages
            : (websiteTripleAnchors.samplePage ? [websiteTripleAnchors.samplePage] : []);
        const targetFolder = String(websiteTripleAnchors.targetFolder || '').trim();
        const missingSamplePages = [];
        const resolvedHtmlFiles = [];
        for (const samplePage of rawSamplePages) {
            const resolved = this._resolveProjectFile(projectPath, samplePage, { targetFolder });
            if (resolved && this.fileExists(resolved)) {
                resolvedHtmlFiles.push(resolved);
            } else if (String(samplePage || '').trim()) {
                missingSamplePages.push(String(samplePage || '').trim());
            }
        }
        const uniqueHtmlFiles = [...new Set(resolvedHtmlFiles)];
        const relatedFiles = new Set(uniqueHtmlFiles);

        uniqueHtmlFiles.forEach(htmlFilePath => {
            this._collectSiblingAssets(htmlFilePath).forEach(filePath => relatedFiles.add(filePath));
            this._collectLinkedAssets(projectPath, htmlFilePath, { targetFolder }).forEach(filePath => relatedFiles.add(filePath));
        });

        return {
            sampleFiles: [...relatedFiles],
            resolvedHtmlFiles: uniqueHtmlFiles,
            missingSamplePages
        };
    }

    _collectSiblingAssets(htmlFilePath = '') {
        const result = [];
        const extName = path.extname(htmlFilePath);
        const basePath = extName ? htmlFilePath.slice(0, -extName.length) : htmlFilePath;
        ['.js', '.css'].forEach(ext => {
            const candidate = `${basePath}${ext}`;
            if (this.fileExists(candidate)) result.push(candidate);
        });
        return result;
    }

    _collectLinkedAssets(projectPath, htmlFilePath = '', options = {}) {
        if (!this.fileExists(htmlFilePath)) return [];
        let content = '';
        try {
            content = this.readTextFile(htmlFilePath);
        } catch (_) {
            return [];
        }

        const webappRoot = this._resolveWebappRoot(htmlFilePath, projectPath);
        const linkedFiles = new Set();
        const patterns = [
            /<script\b[^>]*src=["']([^"'#?]+(?:\.js|\.mjs))["'][^>]*>/gi,
            /<link\b[^>]*href=["']([^"'#?]+\.css)["'][^>]*>/gi
        ];
        patterns.forEach(pattern => {
            for (const match of content.matchAll(pattern)) {
                const candidate = this._resolveLinkedAssetPath(projectPath, htmlFilePath, webappRoot, match[1] || '');
                if (candidate && this.fileExists(candidate)) linkedFiles.add(candidate);
            }
        });
        this._extractRegistryAssetRefs(content).forEach(assetRef => {
            const candidate = this._resolveRegistryAssetPath(projectPath, htmlFilePath, webappRoot, assetRef, options);
            if (candidate && this.fileExists(candidate)) linkedFiles.add(candidate);
        });
        return [...linkedFiles];
    }

    _extractRegistryAssetRefs(content = '') {
        const refs = [];
        const text = String(content || '');
        const outputPattern = /\b[A-Za-z_$][\w$]*Boot\.output\s*\(\s*\[([\s\S]*?)\]\s*\)/g;
        for (const callMatch of text.matchAll(outputPattern)) {
            const body = String(callMatch[1] || '');
            for (const itemMatch of body.matchAll(/["']([^"']+\.(?:js|mjs|css))(?:[?#][^"']*)?["']/gi)) {
                const value = String(itemMatch[1] || '').trim();
                if (value && !refs.includes(value)) refs.push(value);
            }
        }
        return refs;
    }

    _resolveRegistryAssetPath(projectPath, htmlFilePath, webappRoot, assetRef = '', options = {}) {
        const ref = String(assetRef || '').trim();
        if (!ref || !/\.(?:js|mjs|css)$/i.test(ref)) return '';
        const direct = this._resolveLinkedAssetPath(projectPath, htmlFilePath, webappRoot, ref);
        if (direct && this.fileExists(direct)) return direct;

        const candidates = [];
        const normalizedRef = ref.replace(/\\/g, '/').replace(/^[./]+/, '');
        const strippedParentRef = ref.replace(/\\/g, '/').replace(/^(?:\.\.\/)+/, '');
        const addCandidate = candidate => {
            const normalized = String(candidate || '').trim();
            if (normalized && !candidates.includes(normalized)) candidates.push(normalized);
        };
        if (webappRoot) {
            addCandidate(path.resolve(webappRoot, strippedParentRef));
            addCandidate(path.resolve(webappRoot, normalizedRef));
        }

        const folderNames = [
            String(options.targetFolder || '').trim(),
            ...String(ref || '').replace(/\\/g, '/').split('/').filter(part => /^[A-Za-z0-9_-]+$/.test(part))
        ].filter(Boolean);
        folderNames.forEach(folderName => {
            const marker = `/${folderName}/`;
            const normalized = `/${ref.replace(/\\/g, '/')}`;
            const index = normalized.toLowerCase().indexOf(marker.toLowerCase());
            if (index >= 0 && webappRoot) {
                addCandidate(path.resolve(webappRoot, normalized.slice(index + 1)));
            }
        });

        const found = candidates.find(candidate => this.fileExists(candidate));
        if (found) return found;
        return this._findLinkedAssetBySample(webappRoot || projectPath, ref, options);
    }

    _resolveLinkedAssetPath(projectPath, htmlFilePath, webappRoot, assetRef = '') {
        const ref = String(assetRef || '').trim();
        if (!ref || /^(?:https?:)?\/\//i.test(ref) || /^(?:data|javascript):/i.test(ref)) return '';
        if (/^[A-Za-z]:[\\/]/.test(ref)) return ref;
        if (/^[\\/]/.test(ref)) {
            const stripped = ref.replace(/^[\\/]+/, '');
            if (webappRoot) return path.resolve(webappRoot, stripped);
            return path.resolve(projectPath, stripped);
        }
        return path.resolve(path.dirname(htmlFilePath), ref);
    }

    _findLinkedAssetBySample(rootPath, assetRef = '', options = {}) {
        const root = String(rootPath || '').trim();
        const raw = String(assetRef || '').replace(/\\/g, '/').trim();
        const fileName = path.basename(raw);
        if (!root || !fileName || !/\.(?:js|mjs|css)$/i.test(fileName) || !fs.existsSync(root)) return '';
        const targetFolder = String(options.targetFolder || '').trim().toLowerCase();
        const suffix = raw.includes('/') ? raw.toLowerCase().replace(/^(?:\.\.\/)+/, '') : '';
        const candidates = [];
        const ignored = new Set(['.git', 'node_modules', 'target', 'dist', 'out']);
        const walk = dirPath => {
            let entries = [];
            try {
                entries = fs.readdirSync(dirPath, { withFileTypes: true });
            } catch (_) {
                return;
            }
            for (const entry of entries) {
                if (ignored.has(entry.name)) continue;
                const fullPath = path.join(dirPath, entry.name);
                if (entry.isDirectory()) {
                    if (!fullPath.includes(`${path.sep}.ai-workspace${path.sep}`)) walk(fullPath);
                    continue;
                }
                if (!entry.isFile() || entry.name.toLowerCase() !== fileName.toLowerCase()) continue;
                const normalizedFull = fullPath.replace(/\\/g, '/').toLowerCase();
                let score = 0;
                if (targetFolder && normalizedFull.includes(`/${targetFolder}/`)) score += 50;
                if (suffix && normalizedFull.endsWith(suffix)) score += 40;
                if (/\/webapp\//i.test(normalizedFull)) score += 20;
                candidates.push({ filePath: fullPath, score });
            }
        };
        walk(root);
        if (candidates.length === 0) return '';
        return candidates.sort((a, b) => b.score - a.score || a.filePath.localeCompare(b.filePath))[0].filePath;
    }

    _resolveProjectFile(projectPath, filePath = '', options = {}) {
        const raw = String(filePath || '').trim();
        if (!raw) return '';
        if (path.isAbsolute(raw)) return raw;
        const direct = path.resolve(projectPath, raw);
        if (this.fileExists(direct)) return direct;
        return this._findProjectFileBySample(projectPath, raw, options);
    }

    _findProjectFileBySample(projectPath, samplePage = '', options = {}) {
        const root = String(projectPath || '').trim();
        const raw = String(samplePage || '').replace(/\\/g, '/').trim();
        const fileName = path.basename(raw);
        if (!root || !fileName || !/\.html?$/i.test(fileName) || !fs.existsSync(root)) return '';
        const targetFolder = String(options.targetFolder || '').trim();
        const suffix = raw.includes('/') ? raw.toLowerCase() : '';
        const candidates = [];
        const ignored = new Set(['.git', 'node_modules', 'target', 'dist', 'out']);
        const walk = dirPath => {
            let entries = [];
            try {
                entries = fs.readdirSync(dirPath, { withFileTypes: true });
            } catch (_) {
                return;
            }
            for (const entry of entries) {
                if (ignored.has(entry.name)) continue;
                const fullPath = path.join(dirPath, entry.name);
                if (entry.isDirectory()) {
                    if (!fullPath.includes(`${path.sep}.ai-workspace${path.sep}`)) walk(fullPath);
                    continue;
                }
                if (!entry.isFile() || entry.name.toLowerCase() !== fileName.toLowerCase()) continue;
                const normalizedFull = fullPath.replace(/\\/g, '/').toLowerCase();
                if (suffix && !normalizedFull.endsWith(suffix)) continue;
                candidates.push(fullPath);
            }
        };
        walk(root);
        if (candidates.length === 0) return '';
        const scored = candidates
            .map(filePath => {
                const normalized = filePath.replace(/\\/g, '/').toLowerCase();
                let score = 0;
                if (/\/webapp\//i.test(normalized)) score += 20;
                if (targetFolder && normalized.includes(`/webapp/${targetFolder.toLowerCase()}/`)) score += 50;
                if (suffix && normalized.endsWith(suffix)) score += 30;
                return { filePath, score };
            })
            .sort((a, b) => b.score - a.score || a.filePath.localeCompare(b.filePath));
        return scored[0].filePath;
    }

    _resolveWebappRoot(filePath = '', projectPath = '') {
        const normalized = String(filePath || '').replace(/\//g, '\\');
        const match = normalized.match(/^(.*?\\webapp)(?:\\|$)/i);
        if (match) return match[1];
        return String(projectPath || '').trim();
    }
}

module.exports = WebsiteScanArtifactService;
