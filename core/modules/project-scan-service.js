const fs = require('fs');
const path = require('path');
const PipelineUtils = require('./pipeline-utils');
const RuleValidationContract = require('./rule-validation-contract');
const BaselineScanner = require('./pipeline-support/baseline-scanner');
const NavigationContractService = require('./pipeline-support/navigation-contract-service');
const ProjectApiCatalogService = require('./pipeline-support/project-api-catalog-service');
const BusinessGraphService = require('./pipeline-support/business-graph-service');
const FrameworkVersionService = require('./pipeline-support/framework-version-service');
const ProjectScanContractService = require('./pipeline-support/project-scan-contract-service');
const TextAnalysisUtils = require('./pipeline-support/text-analysis-utils');

class ProjectScanService {
    constructor(ruleService) {
        this.ruleService = ruleService;
        const ensureDirectoryExists = dirPath => fs.mkdirSync(dirPath, { recursive: true });
        const contracts = new ProjectScanContractService(ruleService, projectPath => this.getProjectStructurePaths(projectPath));
        this.baselineScanner = new BaselineScanner({
            getProjectApiCatalogPaths: projectPath => this.getProjectApiCatalogPaths(projectPath),
            ensureDirectoryExists,
            getScriptCandidates: () => [
                path.join(__dirname, '..', 'scripts', 'generate_baseline_report.py'),
                path.join(__dirname, '..', 'mcp_tools', 'scripts', 'generate_baseline_report.py')
            ]
        });
        this.navigationContractService = new NavigationContractService({
            baselineScanner: this.baselineScanner,
            ensureDirectoryExists,
            hasUnfilledTemplateMarker: content => TextAnalysisUtils.hasUnfilledTemplateMarker(
                String(content || '').replace(/```mermaid[\s\S]*?```/gi, '')
            ),
            readNavigationContractJsonState: (...args) => contracts._readNavigationContractJsonState(...args),
            buildCompactPayload: (...args) => contracts._buildNavigationCompactPayload(...args),
            writeJsonArtifact: (...args) => contracts._writeJsonArtifact(...args),
            deriveCompactJsonPath: filePath => contracts._deriveCompactJsonPath(filePath),
            resolvePlacementPolicy: projectPath => contracts._getStructureNamingPlacementPolicy(projectPath)
        });
        contracts.navigationContractService = this.navigationContractService;
        this.projectApiCatalogService = new ProjectApiCatalogService({
            getProjectApiCatalogPaths: projectPath => this.getProjectApiCatalogPaths(projectPath),
            ensureDirectoryExists,
            runApiCatalogScript: (...args) => this.baselineScanner.runApiCatalogScript(...args),
            refreshRuleServiceMap: () => this._refreshRuleServiceMap()
        });
        this.businessGraphService = new BusinessGraphService({
            ensureDirectoryExists,
            readJsonSafe: filePath => {
                try { return JSON.parse(fs.readFileSync(filePath, 'utf-8')); } catch (_) { return null; }
            },
            writeJsonArtifact: (...args) => contracts._writeJsonArtifact(...args),
            refreshGraphExternal: projectPath => this.baselineScanner.runApiCatalogScript('', projectPath)
        });
        this.frameworkVersionService = new FrameworkVersionService({
            bucketOptions: ['950及以上', '950以下'],
            framework: 'management',
            getProjectStructurePaths: projectPath => this.getProjectStructurePaths(projectPath),
            ensureDirectoryExists
        });
    }

    getProjectStructurePaths(projectPath) {
        const structureDir = PipelineUtils.getProjectStructureDir(projectPath);
        return {
            structureDir,
            scanReportPath: path.join(structureDir, '项目现状报告.md'),
            navigationContractPath: path.join(structureDir, '工程导航契约.md'),
            navigationContractJsonPath: path.join(structureDir, '工程导航契约.json'),
            navigationContractCompactPath: path.join(structureDir, '工程导航契约.compact.json'),
            frameworkBucketPath: path.join(structureDir, '框架版本档位.json'),
            businessGraphPath: path.join(structureDir, 'business-graph.json'),
            businessGraphIndexPath: path.join(structureDir, 'business-graph.index.json'),
            assetIndexPath: path.join(structureDir, 'asset-index.json'),
            entityGraphPath: path.join(structureDir, 'entity-graph.json'),
            entityGraphIndexPath: path.join(structureDir, 'entity-graph.index.json'),
            restInterfaceStyleContractPath: path.join(structureDir, 'rest-interface-style.contract.json')
        };
    }

    getProjectApiCatalogPaths(projectPath) {
        return {
            structureDir: PipelineUtils.getProjectStructureDir(projectPath),
            ruleDir: PipelineUtils.getApiRuleDir(projectPath)
        };
    }

    isForceRefreshScan(userIntent = '') {
        return /(重新勘测|重跑勘测|重新扫描|刷新勘测|刷新基线|重建基线|强制勘测|强制扫描)/.test(String(userIntent || ''));
    }

    prepareFrameworkVersionBucket(projectPath, userIntent = '') {
        return this.frameworkVersionService.prepareBucket(projectPath, userIntent);
    }

    _refreshRuleServiceMap() {
        try {
            if (typeof this.ruleService.refreshRuleMap === 'function') this.ruleService.refreshRuleMap();
            else if (typeof this.ruleService.clearAllCache === 'function') this.ruleService.clearAllCache();
        } catch (_) { }
    }

    _validateScanArtifacts(paths) {
        const content = this.ruleService.getRuleContentByPolicy('项目结构与命名规范', { sourcePolicy: 'system-only' });
        const parsed = RuleValidationContract.parseStageContract(content);
        const scan = parsed.ok ? RuleValidationContract.resolveStageContract(parsed.contract, 'expert', 'scan') : null;
        const config = scan && scan.validate && scan.validate.scanArtifacts || {};
        return this.navigationContractService.validateArtifacts(paths, {
            includeScanReport: true,
            projectPathRequired: false,
            requiredHeadings: Array.isArray(config.navigationContractHeadings) && config.navigationContractHeadings.length
                ? config.navigationContractHeadings
                : ['## 1. 模块与落点', '## 2. 命名与路径规则摘要', '## 3. 真实样例锚点', '## 4. 后续阶段使用约束'],
            anchorPatterns: Array.isArray(config.navigationAnchorPatterns) && config.navigationAnchorPatterns.length
                ? config.navigationAnchorPatterns
                : ['Action 根路径：`[^`]+`', 'Service (?:API|接口) ?根路径：`[^`]+`',
                    'Service (?:Impl|实现) ?根路径：`[^`]+`', 'Entity 根路径：`[^`]+`', 'Web 根路径：`[^`]+`'],
            errorCodes: {
                missing: 'SCAN_ARTIFACT_MISSING',
                scanReportEmpty: 'SCAN_REPORT_EMPTY',
                scanReportTemplateNotFilled: 'SCAN_REPORT_TEMPLATE_NOT_FILLED',
                contractTemplateNotFilled: 'NAVIGATION_CONTRACT_TEMPLATE_NOT_FILLED',
                headingsMissing: 'NAVIGATION_CONTRACT_HEADINGS_MISSING',
                anchorsMissing: 'NAVIGATION_CONTRACT_ANCHORS_MISSING'
            }
        });
    }

    prepareArtifacts(projectPath, artifactPath, userIntent = '') {
        const globalPaths = this.getProjectStructurePaths(projectPath);
        const apiPaths = this.getProjectApiCatalogPaths(projectPath);
        const forceRefresh = this.isForceRefreshScan(userIntent);
        let globalScanValidation = forceRefresh ? { ok: false } : this._validateScanArtifacts(globalPaths);
        let apiValidation = forceRefresh ? { ok: false } : this.projectApiCatalogService.validateCatalog(projectPath);
        let source = 'global-cache';
        if (!globalScanValidation.ok || !apiValidation.ok) {
            const baselineResult = this.baselineScanner.runBaselineArtifacts(projectPath, artifactPath, globalPaths, {
                fallbackReportTitle: '# 项目现状报告',
                fallbackReportNote: '- 本报告用于沉淀工程导航契约，后续 requirement/design 直接引用契约，不再重复全文读取结构规范。'
            });
            if (!baselineResult.ok) return baselineResult;
            this.navigationContractService.writeArtifacts(globalPaths, baselineResult.snapshotData, projectPath, { userIntent });
            this._refreshRuleServiceMap();
            globalScanValidation = this._validateScanArtifacts(globalPaths);
            apiValidation = this.projectApiCatalogService.validateCatalog(projectPath);
            if (!globalScanValidation.ok) return { ok: false, message: globalScanValidation.message, paths: globalPaths, apiPaths };
            if (!apiValidation.ok && !/^PROJECT_API_RULES_EMPTY\b/.test(String(apiValidation.message || ''))) {
                return { ok: false, message: apiValidation.message, paths: globalPaths, apiPaths };
            }
            source = forceRefresh ? 'forced-refresh' : 'rebuilt';
        }
        const apiCatalogState = !apiValidation.ok && /^PROJECT_API_RULES_EMPTY\b/.test(String(apiValidation.message || ''))
            ? { ok: true, empty: true, optional: true, message: apiValidation.message, paths: apiValidation.paths || null }
            : apiValidation;
        const result = {
            ok: true, source, forceRefresh, globalPaths, apiPaths, apiCatalogState,
            snapshotData: globalScanValidation.snapshotData, paths: globalPaths
        };
        for (const [kind, method, outputPath] of [
            ['businessGraph', 'ensureGraph', globalPaths.businessGraphPath],
            ['entityGraph', 'ensureEntityGraph', globalPaths.entityGraphPath]
        ]) {
            result[kind] = this.businessGraphService[method](projectPath, outputPath, { forceRefresh });
            if (!result[kind].ok && result[kind].recoverable !== true) {
                return { ok: false, message: result[kind].message, paths: globalPaths };
            }
            if (!result[kind].ok) {
                result.graphEnhancementWarnings = [...(result.graphEnhancementWarnings || []), result[kind].message];
            }
        }
        return result;
    }
}

module.exports = ProjectScanService;
