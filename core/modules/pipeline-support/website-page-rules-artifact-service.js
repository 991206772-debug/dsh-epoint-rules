/* eslint-disable */
const fs = require('fs');
const path = require('path');
const RuleValidationContract = require('../rule-validation-contract');

class WebsitePageRulesArtifactService {
    constructor(pageRulesService) {
        this.pageRulesService = pageRulesService;
    }

    buildCompactPayload(contractPayload = {}, observationsPayload = null, sourcePath = '') {
        const frontend = contractPayload.frontend && typeof contractPayload.frontend === 'object' ? contractPayload.frontend : {};
        const backend = contractPayload.backend && typeof contractPayload.backend === 'object' ? contractPayload.backend : {};
        const observationFrontend = observationsPayload && observationsPayload.frontend && typeof observationsPayload.frontend === 'object'
            ? observationsPayload.frontend
            : {};
        const pickMeta = value => value && typeof value === 'object'
            ? {
                value: value.value || '',
                confidence: Number.isFinite(Number(value.confidence)) ? Number(value.confidence) : null,
                sampleCount: Number.isFinite(Number(value.sampleCount)) ? Number(value.sampleCount) : null,
                sourceFiles: Array.isArray(value.sourceFiles) ? value.sourceFiles.slice(0, 10) : [],
                alternatives: Array.isArray(value.alternatives) ? value.alternatives.slice(0, 6) : []
            }
            : null;
        return {
            compactKind: 'page-rules',
            generatedAt: new Date().toISOString(),
            sourcePath,
            sourcePageRulesPath: String(contractPayload.sourcePageRulesPath || '').trim(),
            sampleCount: Number.isFinite(Number(contractPayload.sampleCount)) ? Number(contractPayload.sampleCount) : 0,
            sourceFiles: Array.isArray(contractPayload.sourceFiles) ? contractPayload.sourceFiles.slice(0, 20) : [],
            frontend: {
                ajaxTool: frontend.ajaxTool || '',
                ajaxToolMeta: pickMeta(frontend.ajaxToolMeta),
                settingsAccess: frontend.settingsAccess || '',
                settingsAccessMeta: pickMeta(frontend.settingsAccessMeta),
                settingsReferenceStyle: frontend.settingsReferenceStyle || '',
                settingsReferenceStyleMeta: pickMeta(frontend.settingsReferenceStyleMeta),
                successLogic: frontend.successLogic || '',
                successLogicMeta: pickMeta(frontend.successLogicMeta),
                templateTypes: Array.isArray(observationFrontend.templateTypes) ? observationFrontend.templateTypes.slice(0, 10) : [],
                resourceSkeleton: observationFrontend.resourceSkeleton || null,
                pageComposition: frontend.pageComposition && typeof frontend.pageComposition === 'object'
                    ? {
                        resourceLoading: frontend.pageComposition.resourceLoading || null,
                        templateBlocks: Array.isArray(frontend.pageComposition.templateBlocks) ? frontend.pageComposition.templateBlocks.slice(0, 20) : [],
                        configRegistry: frontend.pageComposition.configRegistry || null,
                        dataFlows: Array.isArray(frontend.pageComposition.dataFlows) ? frontend.pageComposition.dataFlows.slice(0, 20) : [],
                        rendering: frontend.pageComposition.rendering || null,
                        widgets: Array.isArray(frontend.pageComposition.widgets) ? frontend.pageComposition.widgets.slice(0, 20) : []
                    }
                    : null,
                validations: Array.isArray(frontend.validations) ? frontend.validations.slice(0, 20) : []
            },
            backend: {
                returnUtil: backend.returnUtil || '',
                returnUtilMeta: pickMeta(backend.returnUtilMeta),
                importMirror: backend.importMirror || '',
                importMirrorMeta: pickMeta(backend.importMirrorMeta),
                returnMirror: backend.returnMirror || '',
                returnMirrorMeta: pickMeta(backend.returnMirrorMeta)
            },
            evidence: contractPayload.evidence && typeof contractPayload.evidence === 'object' ? contractPayload.evidence : {},
            warnings: Array.isArray(contractPayload.warnings) ? contractPayload.warnings.slice(0, 20) : []
        };
    }

    ensureCompact(compactPath, contractPath, observationsPath = '', options = {}) {
        const service = this.pageRulesService;
        const contractState = service.validateContract(contractPath, options);
        if (!contractState.ok) {
            return { ok: false, message: contractState.message, path: compactPath };
        }
        const contractPayload = contractState.payload;
        const observationsPayload = observationsPath ? service.readJsonSafe(observationsPath) : null;
        const payload = this.buildCompactPayload(contractPayload, observationsPayload, contractPath);
        service.writeJsonArtifact(compactPath, payload);
        return { ok: true, path: compactPath, payload };
    }

    validateCompact(filePath) {
        const service = this.pageRulesService;
        if (!filePath || !fs.existsSync(filePath)) {
            return { ok: false, message: `WEBSITE_PAGE_RULES_COMPACT_MISSING: ${filePath || 'EMPTY'}`, path: filePath };
        }
        const payload = service.readJsonSafe(filePath);
        if (!payload || typeof payload !== 'object') {
            return { ok: false, message: `WEBSITE_PAGE_RULES_COMPACT_INVALID: ${filePath}`, path: filePath };
        }
        if (payload.compactKind !== 'page-rules') {
            return { ok: false, message: `WEBSITE_PAGE_RULES_COMPACT_INVALID: compactKind mismatch`, path: filePath };
        }
        if (!payload.frontend || typeof payload.frontend !== 'object') {
            return { ok: false, message: `WEBSITE_PAGE_RULES_COMPACT_INVALID: frontend missing`, path: filePath };
        }
        if (!payload.backend || typeof payload.backend !== 'object') {
            return { ok: false, message: `WEBSITE_PAGE_RULES_COMPACT_INVALID: backend missing`, path: filePath };
        }
        return { ok: true, path: filePath, payload };
    }

    buildScanReportContent(pageRulesContent, pageRulesPath, source = 'global-cache', options = {}) {
        const service = this.pageRulesService;
        const configState = service.resolvePageRulesStageConfig(options);
        if (!configState.ok) return configState;
        const extractors = configState.extractors;
        const diagnostics = options.diagnostics || {};
        const diagnosticFrontend = diagnostics.frontend && typeof diagnostics.frontend === 'object' ? diagnostics.frontend : {};
        const diagnosticBackend = diagnostics.backend && typeof diagnostics.backend === 'object' ? diagnostics.backend : {};
        const settingsUsage = String(diagnosticFrontend.settingsAccess || '').trim()
            || service.extractFact(pageRulesContent, RuleValidationContract.compileRegex(extractors.settingsUsage));
        const backendReturnUtil = String(diagnosticBackend.returnUtil || '').trim()
            || service.extractFact(pageRulesContent, RuleValidationContract.compileRegex(extractors.backendReturnUtil));
        const successLogic = String(diagnosticFrontend.successLogic || '').trim()
            || service.extractFact(pageRulesContent, RuleValidationContract.compileRegex(extractors.successLogic));
        const importMirror = String(diagnosticBackend.importMirror || '').trim()
            || service.extractFact(pageRulesContent, RuleValidationContract.compileRegex(extractors.importMirror));
        const returnMirror = String(diagnosticBackend.returnMirror || '').trim()
            || service.extractFact(pageRulesContent, RuleValidationContract.compileRegex(extractors.returnMirror));

        const sourceTextMap = {
            'global-cache': '命中项目级 page-rules 基线后复用。',
            rebuilt: '重新执行页面规约提取后写回项目级基线。',
            'forced-refresh': '收到强制刷新指令后重建项目级 page-rules 基线。'
        };

        return {
            ok: true,
            content: [
                '# 网站项目现状报告',
                '',
                '## 1. 基线来源',
                `- 处理方式：${sourceTextMap[source] || '已准备网站 scan 基线。'}`,
                `- page-rules 真值：\`${pageRulesPath}\``,
                `- 契约来源：\`${diagnostics.sourceType || 'unknown'}\``,
                `- 置信度：\`${diagnostics.confidence || 'unknown'}\``,
                diagnostics.fallbackUsed ? '> [!WARNING]\n> 当前契约基于 Markdown 正则提取 (Fallback)，可能存在失真，建议通过 `page-rules.contract.json` 固化。' : '> [!NOTE]\n> 当前契约优先采用了结构化机器契约 (Structured JSON)。',
                '',
                '## 2. 前端规约摘要',
                `- Settings 访问路径：\`${settingsUsage || '未识别'}\``,
                `- Ajax 工具：\`${diagnosticFrontend.ajaxTool || '未识别'}\``,
                `- 页面组成契约：\`${diagnostics.sourceType === 'page_composition_contract' ? '已启用' : '未启用'}\``,
                '',
                '## 3. 后端接口范式',
                `- 返回工具类：\`${backendReturnUtil || '未识别'}\``,
                `- 成功判定：\`${successLogic || '未识别'}\``,
                `- JsonUtils 导包：\`${importMirror || '未识别'}\``,
                returnMirror ? `\`\`\`java\n${returnMirror}\n\`\`\`` : '- 返回镜像：未识别',
                '',
                '## 4. 说明',
                '- 本报告为网站项目级 scan 基线摘要，后续 requirement/design/code 以 page-rules.md 与本报告共同作为真值。'
            ].join('\n')
        };
    }

    ensureScanReport(reportPath, pageRulesContent, pageRulesPath, source = 'global-cache', options = {}) {
        const service = this.pageRulesService;
        service.ensureDirectoryExists(path.dirname(reportPath));
        const reportState = this.buildScanReportContent(pageRulesContent, pageRulesPath, source, options);
        if (!reportState.ok) return reportState;
        fs.writeFileSync(reportPath, reportState.content, 'utf-8');
        return { ok: true, path: reportPath };
    }

    validateScanReport(filePath) {
        if (!filePath || !fs.existsSync(filePath)) {
            return { ok: false, message: `WEBSITE_SCAN_REPORT_MISSING: ${filePath || 'EMPTY'}` };
        }
        try {
            const content = fs.readFileSync(filePath, 'utf-8');
            if (!String(content || '').trim()) return { ok: false, message: 'WEBSITE_SCAN_REPORT_EMPTY' };
            if (/TEMPLATE_FILL_REQUIRED|待补充/.test(content)) return { ok: false, message: 'WEBSITE_SCAN_REPORT_TEMPLATE_NOT_FILLED' };
            return { ok: true, content };
        } catch (error) {
            return { ok: false, message: `WEBSITE_SCAN_REPORT_READ_ERROR: ${error.message}` };
        }
    }
}

module.exports = WebsitePageRulesArtifactService;
