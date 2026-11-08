/* eslint-disable */
const fs = require('fs');
const path = require('path');

class ProjectApiCatalogService {
    constructor(options = {}) {
        this.getProjectApiCatalogPaths = typeof options.getProjectApiCatalogPaths === 'function'
            ? options.getProjectApiCatalogPaths
            : () => ({});
        this.ensureDirectoryExists = typeof options.ensureDirectoryExists === 'function'
            ? options.ensureDirectoryExists
            : dirPath => {
                if (dirPath && !fs.existsSync(dirPath)) fs.mkdirSync(dirPath, { recursive: true });
                return dirPath;
            };
        this.runApiCatalogScript = typeof options.runApiCatalogScript === 'function'
            ? options.runApiCatalogScript
            : () => ({});
        this.refreshRuleServiceMap = typeof options.refreshRuleServiceMap === 'function'
            ? options.refreshRuleServiceMap
            : () => {};
    }

    readIndexSafe(indexPath, collectionKey) {
        if (!fs.existsSync(indexPath)) {
            return { ok: false, message: `PROJECT_API_INDEX_MISSING: ${indexPath}`, items: [], payload: null };
        }

        let payload = null;
        try {
            payload = JSON.parse(fs.readFileSync(indexPath, 'utf-8'));
        } catch (error) {
            return { ok: false, message: `PROJECT_API_INDEX_PARSE_ERROR: ${error.message}`, items: [], payload: null };
        }

        let items = [];
        if (Array.isArray(payload)) items = payload;
        else if (payload && Array.isArray(payload[collectionKey])) items = payload[collectionKey];
        if (!Array.isArray(items)) {
            return {
                ok: false,
                message: `PROJECT_API_INDEX_FORMAT_INVALID: ${indexPath}`,
                items: [],
                payload
            };
        }
        return { ok: true, items, payload };
    }

    validateCatalog(projectPath) {
        const apiPaths = this.getProjectApiCatalogPaths(projectPath);
        if (!fs.existsSync(apiPaths.ruleDir) || !fs.statSync(apiPaths.ruleDir).isDirectory()) {
            return { ok: false, message: `PROJECT_API_RULE_DIR_MISSING: ${apiPaths.ruleDir}`, paths: apiPaths };
        }
        const ruleFiles = fs.readdirSync(apiPaths.ruleDir)
            .filter(name => name.endsWith('接口使用规范.md'))
            .map(name => path.join(apiPaths.ruleDir, name))
            .filter(file => fs.existsSync(file));
        if (!ruleFiles.length) {
            return { ok: false, message: `PROJECT_API_RULES_EMPTY: ${apiPaths.ruleDir}`, paths: apiPaths };
        }

        const requiredMarkers = [
            '## 1. 基本锚点',
            '## 2. 表与实体',
            '### 2.1 表结构摘要',
            '## 3. 方法目录',
            '## 4. 方法明细',
            '## 5. 代码锚点',
            '## 6. 复用提示'
        ];
        const invalidRule = ruleFiles.find(file => {
            const content = fs.readFileSync(file, 'utf-8');
            if (!String(content || '').trim()) return true;
            if (/TEMPLATE_FILL_REQUIRED|待补充/.test(content)) return true;
            return requiredMarkers.some(marker => !content.includes(marker));
        });
        if (invalidRule) {
            return { ok: false, message: `PROJECT_API_RULE_INVALID: ${invalidRule}`, paths: apiPaths };
        }

        return { ok: true, paths: apiPaths, ruleFiles };
    }

    ensureCatalog(projectPath, options = {}) {
        const forceRefresh = options.forceRefresh === true;
        let validation = forceRefresh
            ? { ok: false, message: 'PROJECT_API_CATALOG_FORCE_REFRESH' }
            : this.validateCatalog(projectPath);
        if (validation.ok) {
            return { ok: true, source: 'global-cache', paths: validation.paths, ruleFiles: validation.ruleFiles };
        }

        try {
            const apiPaths = this.getProjectApiCatalogPaths(projectPath);
            this.ensureDirectoryExists(apiPaths.ruleDir);
            const runResult = this.runApiCatalogScript(String(options.scriptPath || '').trim(), projectPath);
            if (runResult && runResult.ruleDir) {
                this.ensureDirectoryExists(runResult.ruleDir);
            }
            this.refreshRuleServiceMap();
            validation = this.validateCatalog(projectPath);
            if (!validation.ok) {
                return {
                    ok: false,
                    message: options.invalidMessagePrefix
                        ? `${options.invalidMessagePrefix}${validation.message}`
                        : validation.message,
                    paths: validation.paths
                };
            }
            return {
                ok: true,
                source: forceRefresh ? 'forced-refresh' : 'rebuilt',
                paths: validation.paths,
                ruleFiles: validation.ruleFiles
            };
        } catch (error) {
            return {
                ok: false,
                message: options.errorMessagePrefix
                    ? `${options.errorMessagePrefix}${error.message}`
                    : error.message
            };
        }
    }
}

module.exports = ProjectApiCatalogService;
