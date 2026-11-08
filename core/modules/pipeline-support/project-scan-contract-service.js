const fs = require('fs');
const path = require('path');

const DEFAULT_FILE_NAME_PATTERNS = Object.freeze({
    Entity: 'Gxh{EntityName}.java',
    ServiceApi: 'IGxh{EntityName}Service.java',
    ServiceInternal: 'Gxh{EntityName}Service.java',
    ServiceImpl: 'Gxh{EntityName}ServiceImpl.java',
    Action: 'Gxh{EntityName}{SubType}Action.java',
    Rest: 'Gxh{FeatureName}RestController.java',
    Job: 'Gxh{OperationName}Job.java',
    HtmlPage: 'gxh{pagename}{SubType}.html',
    Js: 'gxh{pagename}.js',
    Css: 'gxh{pagename}.css'
});

class ProjectScanContractService {
    constructor(ruleService, getProjectStructurePaths) {
        this.ruleService = ruleService;
        this.getProjectStructurePaths = getProjectStructurePaths;
        this.navigationContractService = null;
    }

    _getCoreRuleSourcePolicy() {
        return 'system-only';
    }

    _getCodePlacementArtifacts(_artifactFolder, projectPath) {
        return this.getProjectStructurePaths(projectPath);
    }

    _getNavigationContractService() {
        return this.navigationContractService;
    }

    _writeJsonArtifact(filePath, payload) {
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, JSON.stringify(payload, null, 2), 'utf-8');
        return filePath;
    }

    _normalizeProjectRelativePath(rawPath, projectPath = '') {
        const text = String(rawPath || '').trim();
        if (!text) return '';

        const slashify = value => String(value || '')
            .replace(/\\/g, '/')
            .replace(/\/+/g, '/')
            .replace(/^\.\//, '')
            .replace(/^\/+/, '');

        if (path.isAbsolute(text)) {
            const absolutePath = path.resolve(text);
            if (projectPath) {
                const rootPath = path.resolve(projectPath);
                const relativePath = path.relative(rootPath, absolutePath);
                if (relativePath && !relativePath.startsWith('..') && !path.isAbsolute(relativePath)) {
                    return slashify(relativePath);
                }
            }
            return slashify(absolutePath);
        }

        return slashify(path.normalize(text));
    }

    _normalizeComparableProjectPath(rawPath, projectPath = '') {
        return this._normalizeProjectRelativePath(rawPath, projectPath).toLowerCase();
    }

    _normalizeStructurePlaceholderTemplate(value = '') {
        return String(value || '')
            .replace(/\\/g, '/')
            .replace(/\{业务域\}/g, '{domain}')
            .replace(/\{模块名\}/g, '{bizModule}')
            .replace(/\{模块\}/g, '{bizModule}')
            .replace(/\{功能名\}/g, '{featureName}')
            .replace(/\{任务名\}/g, '{OperationName}')
            .replace(/\{任务描述\}/g, '{OperationName}')
            .replace(/\{operationName\}/g, '{OperationName}')
            .replace(/\/+$/g, '')
            .trim();
    }

    _readStructureNamingRuleContent(projectPath = '') {
        try {
            if (this.ruleService && typeof this.ruleService.getRuleContentByPolicy === 'function') {
                return this.ruleService.getRuleContentByPolicy('项目结构与命名规范', {
                    projectPath,
                    sourcePolicy: typeof this._getCoreRuleSourcePolicy === 'function' ? this._getCoreRuleSourcePolicy() : undefined
                }) || '';
            }
            if (this.ruleService && typeof this.ruleService.getRuleContent === 'function') {
                return this.ruleService.getRuleContent('项目结构与命名规范') || '';
            }
        } catch (_) {
            return '';
        }
        return '';
    }

    _extractStructurePackageTemplate(ruleContent = '') {
        const text = String(ruleContent || '');
        const candidates = [...text.matchAll(/com\.epoint(?:\.[A-Za-z0-9_{}业务域模块名模块功能名-]+)+/g)]
            .map(match => this._normalizeStructurePlaceholderTemplate(match[0]).replace(/\/+$/g, ''))
            .filter(Boolean);
        const selected = candidates.find(item => /\{(?:domain|bizModule)\}/.test(item)) || candidates[0] || '';
        if (!selected) return '';
        return /\{(?:domain|bizModule)\}/.test(selected) ? selected : `${selected}.{bizModule}`;
    }

    _extractStructureWebTemplate(ruleContent = '') {
        const text = String(ruleContent || '');
        const fullCandidates = [...text.matchAll(/src\/main\/webapp\/[^\s`)]+/g)]
            .map(match => this._normalizeStructurePlaceholderTemplate(match[0]))
            .filter(Boolean);
        const shortCandidates = [...text.matchAll(/webapp\/[^\s`)]+/g)]
            .map(match => {
                const normalized = this._normalizeStructurePlaceholderTemplate(match[0]);
                return normalized.startsWith('src/main/') ? normalized : `src/main/${normalized}`;
            })
            .filter(Boolean);
        let selected = [...fullCandidates, ...shortCandidates].find(item => /\{bizModule\}/.test(item))
            || [...fullCandidates, ...shortCandidates][0]
            || '';
        if (!selected) return '';
        if (!/\{bizModule\}/.test(selected)) selected = `${selected}/{bizModule}`;
        return selected.replace(/\/+$/g, '');
    }

    _getStructureNamingPlacementPolicy(projectPath = '') {
        const ruleContent = this._readStructureNamingRuleContent(projectPath);
        const packageTemplate = this._extractStructurePackageTemplate(ruleContent);
        const packagePath = packageTemplate ? packageTemplate.replace(/\./g, '/').replace(/\/+$/g, '') : '';
        const javaRoot = packagePath ? `src/main/java/${packagePath}` : '';
        const webRoot = this._extractStructureWebTemplate(ruleContent);
        const fileNamePatterns = {
            ...DEFAULT_FILE_NAME_PATTERNS,
            ...this._extractStructureFileNamePatterns(ruleContent)
        };
        const databaseNamingContract = this._extractStructureDatabaseNamingContract(ruleContent);
        return {
            sourceRuleName: '项目结构与命名规范',
            backendPackageTemplate: packageTemplate,
            backendPathTemplate: javaRoot,
            webPathTemplate: webRoot,
            fileNamePatterns,
            databaseNamingContract,
            paths: {
                action: javaRoot ? `${javaRoot}/action/` : '',
                rest: javaRoot ? `${javaRoot}/rest/` : '',
                service_api: javaRoot ? `${javaRoot}/api/` : '',
                service_impl: javaRoot ? `${javaRoot}/impl/` : '',
                entity: javaRoot ? `${javaRoot}/api/entity/` : '',
                job: javaRoot ? `${javaRoot}/job/` : '',
                web: webRoot ? `${webRoot}/` : ''
            }
        };
    }

    _extractStructureDatabaseNamingContract(ruleContent = '') {
        const text = String(ruleContent || '');
        const tableSection = text;
        const candidates = [];
        for (const match of tableSection.matchAll(/[`'"]([^`'"]*(?:模块名|模块|功能名|表名)[^`'"]*)[`'"]/g)) {
            candidates.push(match[1]);
        }
        for (const match of tableSection.matchAll(/(?:规则|格式)[：:]\s*([A-Za-z0-9_{}模块名首字母缩写功能名表名-]+)/g)) {
            candidates.push(match[1]);
        }
        const rawPattern = candidates
            .map(item => String(item || '').trim())
            .find(item => /(?:模块名|模块|功能名)/.test(item) && /[_-]/.test(item))
            || '';
        if (!rawPattern) return null;
        const tableNamePattern = this._normalizeDatabaseTablePattern(rawPattern);
        if (!tableNamePattern || !/\{[^}]+\}/.test(tableNamePattern)) return null;
        return {
            source: 'rule',
            sourceRule: '项目结构与命名规范',
            usage: 'generation',
            tableNamePattern,
            caseStyle: 'lower_snake',
            requiredVariables: this._extractTemplateVariables(tableNamePattern)
        };
    }

    _normalizeDatabaseTablePattern(pattern = '') {
        return String(pattern || '')
            .trim()
            .replace(/模块名首字母缩写/g, '{moduleAbbr}')
            .replace(/模块首字母缩写/g, '{moduleAbbr}')
            .replace(/模块缩写/g, '{moduleAbbr}')
            .replace(/模块名/g, '{bizModule}')
            .replace(/模块/g, '{bizModule}')
            .replace(/功能名/g, '{tableFeatureName}')
            .replace(/表名/g, '{tableFeatureName}')
            .replace(/\s+/g, '');
    }

    _extractStructureFileNamePatterns(ruleContent = '') {
        const text = String(ruleContent || '');
        const normalized = this._normalizeStructurePlaceholderTemplate(text);
        const result = {};
        let currentSection = '';
        const normalizePattern = pattern => String(pattern || '')
            .replace(/\{功能名\}/g, '{FeatureName}')
            .replace(/\{featureName\}/g, '{FeatureName}')
            .replace(/\{entityName\}/g, '{EntityName}')
            .replace(/\{interfaceName\}/g, '{InterfaceName}')
            .replace(/\{任务名\}/g, '{OperationName}')
            .replace(/\{任务描述\}/g, '{OperationName}')
            .replace(/\{operationName\}/g, '{OperationName}')
            .replace(/\{PageName\}/g, '{PageName}')
            .replace(/\{pagename\}/g, '{pagename}')
            .replace(/\{pageName\}/g, '{pageName}');
        const classifyPattern = (pattern, section) => {
            if (/Job\.java$/i.test(pattern)) return 'Job';
            if (/Action\.java$/i.test(pattern)) return 'Action';
            if (/RestController\.java$/i.test(pattern)) return 'Rest';
            if (/\.html$/i.test(pattern)) return 'HtmlPage';
            if (/\.js$/i.test(pattern)) return 'Js';
            if (/\.css$/i.test(pattern)) return 'Css';
            if (/ServiceImpl\.java$/i.test(pattern)) return 'ServiceImpl';
            if (/Service\.java$/i.test(pattern)) return section === 'impl' ? 'ServiceInternal' : 'ServiceApi';
            if (/\.java$/i.test(pattern) && /\{EntityName\}/.test(pattern)) return 'Entity';
            return '';
        };
        const fileNamePattern = /[A-Za-z0-9_$-]*\{(?:EntityName|entityName|InterfaceName|interfaceName|FeatureName|featureName|OperationName|operationName|PageName|pageName|pagename|任务名|功能名)\}[A-Za-z0-9_$-]*\.(?:java|html|js|css)/gi;
        normalized.split(/\r?\n/).forEach(line => {
            const sectionMatch = String(line || '').match(/(?:^|[\/\s])(?:api|entity|impl|action|rest|job|js|css)(?:[\/\s]|$)/i);
            if (sectionMatch) {
                currentSection = sectionMatch[0].replace(/[\/\s]/g, '').toLowerCase();
            }
            for (const match of String(line || '').matchAll(fileNamePattern)) {
                const pattern = normalizePattern(match[0]);
                const kind = classifyPattern(pattern, currentSection);
                if (kind && !result[kind]) result[kind] = pattern;
            }
        });
        return result;
    }

    _extractTemplateVariables(pattern = '') {
        return [...new Set((String(pattern || '').match(/\{[^}]+\}/g) || [])
            .map(item => item.replace(/[{}]/g, '').trim())
            .filter(Boolean))];
    }

    _hasRuleGenerationPlacementContract(payload = {}) {
        const isGenerationRule = rule => {
            const source = String(rule && rule.source || '').trim().toLowerCase();
            const usage = String(rule && rule.usage || '').trim().toLowerCase();
            return source === 'rule' && usage === 'generation';
        };
        const ruleContractRules = payload
            && payload.rulePlacementContract
            && Array.isArray(payload.rulePlacementContract.rules)
            ? payload.rulePlacementContract.rules
            : [];
        if (ruleContractRules.some(isGenerationRule)) return true;
        const draftRules = payload
            && payload.placementContractDraft
            && Array.isArray(payload.placementContractDraft.rules)
            ? payload.placementContractDraft.rules
            : [];
        return draftRules.some(isGenerationRule);
    }

    _upgradeLegacyNavigationContractPayload(payload = {}, filePath = '', projectPath = '', options = {}) {
        if (!payload || typeof payload !== 'object') return payload;
        if (this._hasRuleGenerationPlacementContract(payload)) return payload;
        if (options.upgradeLegacyRulePlacement === false) return payload;
        const navigationService = this._getNavigationContractService();
        if (!navigationService || typeof navigationService.buildContractPayload !== 'function') return payload;

        const effectiveProjectPath = String(projectPath || payload.root || '').trim();
        if (!effectiveProjectPath) return payload;

        let upgraded = null;
        try {
            upgraded = navigationService.buildContractPayload(effectiveProjectPath, payload);
        } catch (_) {
            return payload;
        }
        if (!upgraded || typeof upgraded !== 'object' || !this._hasRuleGenerationPlacementContract(upgraded)) {
            return payload;
        }

        upgraded.diagnostics = {
            ...(upgraded.diagnostics && typeof upgraded.diagnostics === 'object' ? upgraded.diagnostics : {}),
            legacyNavigationContractUpgrade: {
                upgradedAt: new Date().toISOString(),
                reason: 'legacy_navigation_contract_missing_rulePlacementContract',
                sourcePath: filePath
            }
        };

        if (options.persistLegacyRulePlacementUpgrade !== false && filePath) {
            try {
                this._writeJsonArtifact(filePath, upgraded);
                const compactPath = this._deriveCompactJsonPath(filePath);
                if (compactPath) {
                    this._writeJsonArtifact(compactPath, this._buildNavigationCompactPayload(upgraded, {
                        sourcePath: filePath
                    }));
                }
            } catch (_) {
                // 读取阶段升级失败不掩盖原始校验结果；后续门禁仍会按旧契约失败。
            }
        }
        return upgraded;
    }

    _readNavigationContractJsonState(projectPathOrFilePath, options = {}) {
        const input = String(projectPathOrFilePath || '').trim();
        const isExistingFile = path.isAbsolute(input) && fs.existsSync(input) && fs.statSync(input).isFile();
        const filePath = /\.json$/i.test(input) || isExistingFile
            ? input
            : this._getCodePlacementArtifacts('', input).navigationContractJsonPath;
        if (!filePath) {
            return { ok: false, message: 'NAVIGATION_CONTRACT_JSON_PATH_EMPTY', path: filePath, payload: null };
        }
        if (!fs.existsSync(filePath)) {
            return { ok: false, message: `NAVIGATION_CONTRACT_JSON_MISSING: ${filePath}`, path: filePath, payload: null };
        }

        let payload = null;
        try {
            payload = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        } catch (error) {
            return { ok: false, message: `NAVIGATION_CONTRACT_JSON_PARSE_ERROR: ${error.message}`, path: filePath, payload: null };
        }

        if (!payload || typeof payload !== 'object') {
            return { ok: false, message: 'NAVIGATION_CONTRACT_JSON_INVALID: payload empty', path: filePath, payload: null };
        }

        const projectPath = /\.json$/i.test(input) || isExistingFile
            ? String(options.projectPath || payload.root || '').trim()
            : input;
        payload = this._upgradeLegacyNavigationContractPayload(payload, filePath, projectPath, options);

        const requiredRoots = ['action', 'rest', 'service_api', 'service_impl', 'entity', 'web'];
        const missingRoots = requiredRoots.filter(key => !String(payload.paths && payload.paths[key] || '').trim());
        const missingExtendedKeys = [
            !String(payload.projectType || '').trim() ? 'projectType' : '',
            !Array.isArray(payload.modules) || payload.modules.length === 0 ? 'modules' : '',
            !Array.isArray(payload.ownershipRules) || payload.ownershipRules.length === 0 ? 'ownershipRules' : '',
            !Array.isArray(payload.placementCandidates) || payload.placementCandidates.length === 0 ? 'placementCandidates' : '',
            !payload.placementContractDraft || !Array.isArray(payload.placementContractDraft.rules) || payload.placementContractDraft.rules.length === 0
                ? 'placementContractDraft.rules'
                : ''
        ].filter(Boolean);
        if (!String(payload.root || '').trim()
            || !String(payload.product || '').trim()
            || !String(payload.generator || '').trim()
            || missingRoots.length > 0
            || missingExtendedKeys.length > 0) {
            return {
                ok: false,
                message: `NAVIGATION_CONTRACT_JSON_INVALID: missing ${[
                    !String(payload.root || '').trim() ? 'root' : '',
                    !String(payload.product || '').trim() ? 'product' : '',
                    !String(payload.generator || '').trim() ? 'generator' : '',
                    ...missingRoots.map(item => `paths.${item}`),
                    ...missingExtendedKeys
                ].filter(Boolean).join(', ')}`,
                path: filePath,
                payload
            };
        }

        if (options.projectPathRequired !== false && projectPath) {
            const normalizedProjectRoot = this._normalizeComparableProjectPath(projectPath);
            const normalizedPayloadRoot = this._normalizeComparableProjectPath(payload.root);
            if (normalizedProjectRoot && normalizedPayloadRoot && normalizedProjectRoot !== normalizedPayloadRoot) {
                return {
                    ok: false,
                    message: `NAVIGATION_CONTRACT_JSON_PROJECT_MISMATCH: expected ${projectPath}, actual ${payload.root}`,
                    path: filePath,
                    payload
                };
            }
        }

        return { ok: true, path: filePath, payload };
    }

    _deriveCompactJsonPath(filePath = '') {
        const sourcePath = String(filePath || '').trim();
        if (!sourcePath) return '';
        const parsed = path.parse(sourcePath);
        return path.join(parsed.dir, `${parsed.name}.compact.json`);
    }

    _buildNavigationCompactPayload(payload = {}, options = {}) {
        const pickModule = item => ({
            moduleId: String(item && item.moduleId || '').trim(),
            modulePath: String(item && item.modulePath || '').trim(),
            packaging: String(item && item.packaging || '').trim(),
            tags: Array.isArray(item && item.tags) ? item.tags.slice(0, 8) : [],
            kindCounts: item && typeof item.kindCounts === 'object' ? item.kindCounts : {}
        });
        const pickExistingWebTarget = item => {
            const normalizedPath = String(item || '').replace(/\\/g, '/').replace(/\/{2,}/g, '/').replace(/^\/+/, '').trim();
            if (!normalizedPath || !/\.html?$/i.test(normalizedPath)) return null;
            const comparablePath = `/${normalizedPath.toLowerCase()}/`;
            if (comparablePath.includes('/.knowledge/')
                || comparablePath.includes('/.ai-workspace/knowledge/')
                || comparablePath.includes('/knowledge/')
                || /(?:^|\/)crud-examples(?:\/|$)/i.test(normalizedPath)) {
                return null;
            }
            const fileName = normalizedPath.split('/').pop();
            const relativeDir = normalizedPath.slice(0, Math.max(0, normalizedPath.length - fileName.length)).replace(/\/+$/, '');
            const pageName = String(fileName || '').replace(/\.[^.]+$/i, '');
            const segments = relativeDir.split('/').filter(Boolean);
            return {
                fileKind: 'HtmlPage',
                operation: 'modify',
                path: normalizedPath,
                relativeDir,
                fileName,
                pageName,
                bizModule: segments[segments.length - 1] || '',
                source: 'scan.samples.web'
            };
        };
        const existingWebTargets = (Array.isArray(payload.samples && payload.samples.web) ? payload.samples.web : [])
            .map(pickExistingWebTarget)
            .filter(Boolean)
            .slice(0, 20);
        const rulePlacementContract = payload.rulePlacementContract && typeof payload.rulePlacementContract === 'object'
            ? payload.rulePlacementContract
            : (payload.placementContractDraft && typeof payload.placementContractDraft === 'object' ? payload.placementContractDraft : {});
        const databaseNamingContract = payload.databaseNamingContract && typeof payload.databaseNamingContract === 'object'
            ? payload.databaseNamingContract
            : (rulePlacementContract.databaseNamingContract && typeof rulePlacementContract.databaseNamingContract === 'object' ? rulePlacementContract.databaseNamingContract : {});
        return {
            compactKind: 'navigation',
            generatedAt: new Date().toISOString(),
            root: String(payload.root || '').trim(),
            product: String(payload.product || '').trim(),
            projectType: String(payload.projectType || '').trim(),
            paths: payload.paths && typeof payload.paths === 'object' ? payload.paths : {},
            modules: (Array.isArray(payload.modules) ? payload.modules : []).slice(0, 20).map(pickModule),
            existingTargets: {
                web: existingWebTargets
            },
            rulePlacementContract,
            databaseNamingContract,
            contractConflicts: Array.isArray(payload.contractConflicts) ? payload.contractConflicts.slice(0, 20) : [],
            warnings: Array.isArray(payload.warnings) ? payload.warnings.slice(0, 20) : []
        };
    }
}

module.exports = ProjectScanContractService;
