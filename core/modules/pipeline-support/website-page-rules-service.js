/* eslint-disable */
const fs = require('fs');
const WebsitePageRulesArtifactService = require('./website-page-rules-artifact-service');
const WebsitePageRulesContractService = require('./website-page-rules-contract-service');
const WebsitePageRulesInputParser = require('./website-page-rules-input-parser');
const WebsitePageRulesFingerprintService = require('./website-page-rules-fingerprint-service');

class WebsitePageRulesService {
    constructor(options = {}) {
        this.resolvePageRulesStageConfig = typeof options.resolvePageRulesStageConfig === 'function'
            ? options.resolvePageRulesStageConfig
            : () => ({ ok: false, message: 'RULE_STAGE_CONTRACT_MISSING: pageRules' });
        this.resolvePageRulesContractConfig = typeof options.resolvePageRulesContractConfig === 'function'
            ? options.resolvePageRulesContractConfig
            : () => ({ ok: false, message: 'RULE_STAGE_CONTRACT_MISSING: pageRulesContract' });
        this.extractFrameworkVersionBucketInput = typeof options.extractFrameworkVersionBucketInput === 'function'
            ? options.extractFrameworkVersionBucketInput
            : () => '';
        this.ensureDirectoryExists = typeof options.ensureDirectoryExists === 'function'
            ? options.ensureDirectoryExists
            : dirPath => {
                if (dirPath && !fs.existsSync(dirPath)) fs.mkdirSync(dirPath, { recursive: true });
                return dirPath;
            };
        this.writeJsonArtifact = typeof options.writeJsonArtifact === 'function'
            ? options.writeJsonArtifact
            : (filePath, payload) => fs.writeFileSync(filePath, JSON.stringify(payload, null, 2), 'utf-8');
        this.buildValidationFailure = typeof options.buildValidationFailure === 'function'
            ? options.buildValidationFailure
            : (code, message, fixable = false) => ({ code, message, fixable });
        this.readJsonSafe = typeof options.readJsonSafe === 'function'
            ? options.readJsonSafe
            : filePath => {
                try {
                    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
                } catch (_) {
                    return null;
                }
            };
    }


    _getArtifactService() {
        if (!this.artifactService) {
            this.artifactService = new WebsitePageRulesArtifactService(this);
        }
        return this.artifactService;
    }

    _getContractService() {
        if (!this.contractService) {
            this.contractService = new WebsitePageRulesContractService(this);
        }
        return this.contractService;
    }

    _getInputParser() {
        if (!this.inputParser) {
            this.inputParser = new WebsitePageRulesInputParser(this);
        }
        return this.inputParser;
    }

    _getFingerprintService() {
        if (!this.fingerprintService) {
            this.fingerprintService = new WebsitePageRulesFingerprintService(this);
        }
        return this.fingerprintService;
    }

    _isStructuredContractPayload(...args) {
        return this._getContractService()._isStructuredContractPayload(...args);
    }

    _isPageCompositionPayload(...args) {
        return this._getContractService()._isPageCompositionPayload(...args);
    }

    _extractPageCompositionPayloadFromMarkdown(...args) {
        return this._getContractService()._extractPageCompositionPayloadFromMarkdown(...args);
    }

    _pickCompositionFact(...args) {
        return this._getContractService()._pickCompositionFact(...args);
    }

    _metaFromCompositionFact(...args) {
        return this._getContractService()._metaFromCompositionFact(...args);
    }

    _buildCompositionObservations(...args) {
        return this._getContractService()._buildCompositionObservations(...args);
    }

    _normalizeContractMeta(...args) {
        return this._getContractService()._normalizeContractMeta(...args);
    }

    _buildStructuredValidations(...args) {
        return this._getContractService()._buildStructuredValidations(...args);
    }

    _normalizeStructuredContractPayload(...args) {
        return this._getContractService()._normalizeStructuredContractPayload(...args);
    }

    validateContent(...args) {
        return this._getContractService().validateContent(...args);
    }

    validateFile(...args) {
        return this._getContractService().validateFile(...args);
    }

    extractFact(...args) {
        return this._getContractService().extractFact(...args);
    }

    extractCodeBlock(...args) {
        return this._getContractService().extractCodeBlock(...args);
    }

    extractSourceFiles(...args) {
        return this._getContractService().extractSourceFiles(...args);
    }

    buildObservationFact(...args) {
        return this._getContractService().buildObservationFact(...args);
    }

    buildObservations(...args) {
        return this._getContractService().buildObservations(...args);
    }

    ensureObservations(...args) {
        return this._getContractService().ensureObservations(...args);
    }

    validateObservations(...args) {
        return this._getContractService().validateObservations(...args);
    }

    buildContract(...args) {
        return this._getContractService().buildContract(...args);
    }

    loadStructuredContract(...args) {
        return this._getContractService().loadStructuredContract(...args);
    }

    ensureContract(...args) {
        return this._getContractService().ensureContract(...args);
    }

    buildCompactPayload(...args) {
        return this._getContractService().buildCompactPayload(...args);
    }

    ensureCompact(...args) {
        return this._getContractService().ensureCompact(...args);
    }

    validateCompact(...args) {
        return this._getContractService().validateCompact(...args);
    }

    validateFrontendFacts(...args) {
        return this._getContractService().validateFrontendFacts(...args);
    }

    validateContract(...args) {
        return this._getContractService().validateContract(...args);
    }

    buildScanReportContent(...args) {
        return this._getContractService().buildScanReportContent(...args);
    }

    ensureScanReport(...args) {
        return this._getContractService().ensureScanReport(...args);
    }

    validateScanReport(...args) {
        return this._getContractService().validateScanReport(...args);
    }
    extractLooseWebsiteAnchorTuple(...args) {
        return this._getInputParser().extractLooseWebsiteAnchorTuple(...args);
    }

    _normalizeSubPath(...args) {
        return this._getInputParser()._normalizeSubPath(...args);
    }

    _tokenizeLooseAnchorParts(...args) {
        return this._getInputParser()._tokenizeLooseAnchorParts(...args);
    }

    _looksLikeFrameworkBucketToken(...args) {
        return this._getInputParser()._looksLikeFrameworkBucketToken(...args);
    }

    _looksLikeHtmlToken(...args) {
        return this._getInputParser()._looksLikeHtmlToken(...args);
    }

    _looksLikePathToken(...args) {
        return this._getInputParser()._looksLikePathToken(...args);
    }

    _looksLikeSlugToken(...args) {
        return this._getInputParser()._looksLikeSlugToken(...args);
    }

    extractSamplePageInput(...args) {
        return this._getInputParser().extractSamplePageInput(...args);
    }

    extractTargetFolderInput(...args) {
        return this._getInputParser().extractTargetFolderInput(...args);
    }

    extractSubPathInput(...args) {
        return this._getInputParser().extractSubPathInput(...args);
    }

    extractWebsiteTripleAnchorInputs(...args) {
        return this._getInputParser().extractWebsiteTripleAnchorInputs(...args);
    }

    resolveContract(...args) {
        return this._getInputParser().resolveContract(...args);
    }
    escapeRegexText(...args) {
        return this._getFingerprintService().escapeRegexText(...args);
    }

    buildLiteralRegex(...args) {
        return this._getFingerprintService().buildLiteralRegex(...args);
    }

    buildCallRegex(...args) {
        return this._getFingerprintService().buildCallRegex(...args);
    }

    buildFrontendFingerprintConfig(...args) {
        return this._getFingerprintService().buildFrontendFingerprintConfig(...args);
    }

    resolveFingerprintConfig(...args) {
        return this._getFingerprintService().resolveFingerprintConfig(...args);
    }
    prepareArtifacts(globalPaths, options = {}) {
        const scanConfig = options.scanConfig && typeof options.scanConfig === 'object' ? options.scanConfig : {};
        const forceRefresh = options.forceRefresh === true;
        const source = String(options.source || 'global-cache').trim() || 'global-cache';
        let pageRulesValidation = forceRefresh
            ? { ok: false, message: 'WEBSITE_PAGE_RULES_FORCE_REFRESH' }
            : this.validateFile(globalPaths.pageRulesPath, { scanConfig });

        if (!pageRulesValidation.ok) {
            return pageRulesValidation;
        }

        const contractValidation = this.validateContract(globalPaths.pageRulesContractPath, { scanConfig });
        const pageRulesCompositionPayload = this._extractPageCompositionPayloadFromMarkdown(pageRulesValidation.content);
        const shouldRefreshFromComposition = this._isPageCompositionPayload(pageRulesCompositionPayload)
            && (!contractValidation.ok || String(contractValidation.payload && contractValidation.payload.sourceType || '') !== 'page_composition_contract');
        let diagnostics = {};
        if (!contractValidation.ok || forceRefresh || shouldRefreshFromComposition) {
            const ensureContractState = this.ensureContract(globalPaths.pageRulesContractPath, pageRulesValidation.content, globalPaths.pageRulesPath, {
                scanConfig,
                forceRefresh: forceRefresh || shouldRefreshFromComposition,
                compositionPayload: pageRulesCompositionPayload
            });
            if (!ensureContractState.ok) return ensureContractState;
            diagnostics = ensureContractState.payload || {};
        } else {
            diagnostics = contractValidation.payload || {};
        }
        const frontendFactsState = this.validateFrontendFacts(diagnostics);
        if (!frontendFactsState.ok) {
            return {
                ok: false,
                path: globalPaths.pageRulesContractPath,
                message: frontendFactsState.message
            };
        }

        const reportValidation = this.validateScanReport(globalPaths.scanReportPath);
        if (!reportValidation.ok || forceRefresh) {
            const reportState = this.ensureScanReport(globalPaths.scanReportPath, pageRulesValidation.content, globalPaths.pageRulesPath, source, {
                scanConfig,
                diagnostics
            });
            if (!reportState.ok) return reportState;
        }

        const observationsValidation = this.validateObservations(globalPaths.pageRulesObservationsPath);
        if (!observationsValidation.ok || forceRefresh) {
            const ensureObservationsState = this.ensureObservations(globalPaths.pageRulesObservationsPath, pageRulesValidation.content, globalPaths.pageRulesPath, { scanConfig });
            if (!ensureObservationsState.ok) return ensureObservationsState;
        }

        const compactState = this.ensureCompact(
            globalPaths.pageRulesCompactPath,
            globalPaths.pageRulesContractPath,
            globalPaths.pageRulesObservationsPath,
            { scanConfig }
        );
        if (!compactState.ok) return compactState;

        return {
            ok: true,
            content: pageRulesValidation.content,
            path: globalPaths.pageRulesPath
        };
    }
}

module.exports = WebsitePageRulesService;
