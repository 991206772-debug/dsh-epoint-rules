/* eslint-disable */
const fs = require('fs');
const path = require('path');
const RuleValidationContract = require('../rule-validation-contract');

class WebsitePageRulesContractService {
    constructor(owner) {
        this.owner = owner;
        return new Proxy(this, {
            get(target, prop, receiver) {
                if (prop in target) {
                    const value = Reflect.get(target, prop, receiver);
                    return typeof value === 'function' ? value.bind(receiver) : value;
                }
                const owner = target.owner || {};
                const value = owner[prop];
                return typeof value === 'function' ? value.bind(owner) : value;
            }
        });
    }

    _isStructuredContractPayload(payload = {}) {
        return Boolean(
            payload
            && typeof payload === 'object'
            && ['structured_json', 'page_composition_contract'].includes(String(payload.sourceType || '').trim())
        );
    }

    _isPageCompositionPayload(payload = {}) {
        return Boolean(
            payload
            && typeof payload === 'object'
            && (String(payload.sourceType || '').trim() === 'page_composition'
                || (payload.pageComposition && typeof payload.pageComposition === 'object'))
        );
    }

    _extractPageCompositionPayloadFromMarkdown(content = '') {
        const match = String(content || '').match(/```json\s+page-composition\s*([\s\S]*?)```/i);
        if (!match) return null;
        try {
            const payload = JSON.parse(match[1]);
            return this._isPageCompositionPayload(payload) ? payload : null;
        } catch (_) {
            return null;
        }
    }

    _pickCompositionFact(items = [], predicate = null) {
        const list = Array.isArray(items) ? items : [];
        if (typeof predicate === 'function') {
            return list.find(predicate) || null;
        }
        return list[0] || null;
    }

    _metaFromCompositionFact(fact = null, sourceFiles = [], confidence = 0.86) {
        if (!fact || typeof fact !== 'object') {
            return this.buildObservationFact('', sourceFiles);
        }
        const factSources = Array.isArray(fact.sourceFiles) && fact.sourceFiles.length > 0
            ? fact.sourceFiles
            : sourceFiles;
        return {
            value: '',
            confidence: Number.isFinite(Number(fact.confidence)) ? Number(fact.confidence) : confidence,
            sampleCount: factSources.length,
            sourceFiles: factSources,
            alternatives: []
        };
    }

    _buildCompositionObservations(compositionPayload = {}, pageRulesPath = '') {
        const pageComposition = compositionPayload.pageComposition || {};
        const sourceFiles = Array.isArray(compositionPayload.sourceFiles)
            ? compositionPayload.sourceFiles.map(item => String(item || '').trim()).filter(Boolean)
            : [];
        const dataFlows = Array.isArray(pageComposition.dataFlows) ? pageComposition.dataFlows : [];
        const backendObservations = Array.isArray(pageComposition.backendObservations) ? pageComposition.backendObservations : [];
        const primaryFlow = this._pickCompositionFact(dataFlows, item => item && item.value && item.value.tool === 'Util.ajax' && (item.value.effectiveUrlExpression || item.value.urlExpression))
            || this._pickCompositionFact(dataFlows, item => item && item.value && item.value.tool === 'Util.ajax')
            || this._pickCompositionFact(dataFlows);
        const primaryFlowValue = primaryFlow && primaryFlow.value && typeof primaryFlow.value === 'object' ? primaryFlow.value : {};
        const successFlow = this._pickCompositionFact(dataFlows, item => item && item.value && String(item.value.successLogic || '').trim())
            || primaryFlow;
        const successFlowValue = successFlow && successFlow.value && typeof successFlow.value === 'object' ? successFlow.value : {};
        const backendReturn = this._pickCompositionFact(backendObservations, item => item && item.kind === 'return_mirror');
        const backendImport = this._pickCompositionFact(backendObservations, item => item && item.kind === 'json_utils_import');
        const settingsAccess = String(primaryFlowValue.effectiveUrlExpression || primaryFlowValue.urlExpression || '').trim();
        const settingsReferenceStyle = /_settings\.(?:be|fe)\.[A-Za-z0-9_]+/i.test(settingsAccess)
            ? 'nested_member'
            : (/_settings\.[A-Za-z0-9_]+/i.test(settingsAccess) ? 'flat_member' : '');
        const flowMeta = this._metaFromCompositionFact(primaryFlow, sourceFiles);
        const successMeta = this._metaFromCompositionFact(successFlow, sourceFiles);
        const backendReturnMeta = this._metaFromCompositionFact(backendReturn, sourceFiles);
        const backendImportMeta = this._metaFromCompositionFact(backendImport, sourceFiles);
        const resourceSkeleton = {
            mode: pageComposition.resourceLoading && pageComposition.resourceLoading.mode || '',
            pathStyle: pageComposition.resourceLoading && pageComposition.resourceLoading.pathStyle || '',
            bootScripts: Array.isArray(pageComposition.resourceLoading && pageComposition.resourceLoading.bootScripts)
                ? pageComposition.resourceLoading.bootScripts.map(item => item.value).filter(Boolean).slice(0, 10)
                : []
        };
        const templateTypes = [...new Set((Array.isArray(pageComposition.templateBlocks) ? pageComposition.templateBlocks : [])
            .map(item => item && item.value && item.value.type || item && item.value && item.value.tag || '')
            .filter(Boolean))];
        return {
            ok: true,
            payload: {
                generatedAt: new Date().toISOString(),
                sourcePageRulesPath: pageRulesPath,
                sampleCount: Number.isFinite(Number(compositionPayload.sampleCount)) ? Number(compositionPayload.sampleCount) : sourceFiles.length,
                sourceFiles,
                sourceType: 'page_composition',
                frontend: {
                    ajaxTool: { ...flowMeta, value: String(primaryFlowValue.tool || '').trim() },
                    settingsAccess: { ...flowMeta, value: settingsAccess },
                    successLogic: { ...successMeta, value: String(successFlowValue.successLogic || '').trim() },
                    settingsReferenceStyle: { ...flowMeta, value: settingsReferenceStyle },
                    coreCallSnippet: { ...flowMeta, value: String(primaryFlowValue.snippet || '').trim() },
                    templateTypes,
                    resourceSkeleton,
                    pageComposition
                },
                backend: {
                    returnUtil: {
                        ...backendReturnMeta,
                        value: String(backendReturn && backendReturn.value && backendReturn.value.utility || '').trim()
                    },
                    importMirror: {
                        ...backendImportMeta,
                        value: String(backendImport && backendImport.value && backendImport.value.mirror || '').trim()
                    },
                    returnMirror: {
                        ...backendReturnMeta,
                        value: String(backendReturn && backendReturn.value && backendReturn.value.mirror || '').trim()
                    }
                },
                warnings: Array.isArray(compositionPayload.warnings) ? compositionPayload.warnings : []
            }
        };
    }

    _normalizeContractMeta(meta = {}, fallbackValue = '', sourceFiles = [], confidence = 0.95) {
        if (meta && typeof meta === 'object' && !Array.isArray(meta) && Object.prototype.hasOwnProperty.call(meta, 'value')) {
            return {
                value: String(meta.value || '').trim(),
                confidence: Number.isFinite(Number(meta.confidence)) ? Number(meta.confidence) : confidence,
                sampleCount: Number.isFinite(Number(meta.sampleCount)) ? Number(meta.sampleCount) : sourceFiles.length,
                sourceFiles: Array.isArray(meta.sourceFiles) ? meta.sourceFiles.map(item => String(item || '').trim()).filter(Boolean) : sourceFiles,
                alternatives: Array.isArray(meta.alternatives) ? meta.alternatives.map(item => String(item || '').trim()).filter(Boolean) : []
            };
        }
        return {
            value: String(fallbackValue || '').trim(),
            confidence: Number.isFinite(Number(confidence)) ? Number(confidence) : 0.95,
            sampleCount: sourceFiles.length,
            sourceFiles,
            alternatives: []
        };
    }

    _buildStructuredValidations(frontend = {}, sourceFiles = []) {
        if (Array.isArray(frontend.validations) && frontend.validations.length > 0) {
            return frontend.validations;
        }
        const validations = [];
        const ajaxTool = String(frontend.ajaxTool || '').trim();
        const successLogic = String(frontend.successLogic || '').trim();
        const settingsReferenceStyle = String(frontend.settingsReferenceStyle || '').trim();
        if (ajaxTool) {
            validations.push({
                type: 'required_call',
                value: ajaxTool,
                evidence: `前端工具: ${ajaxTool}`,
                confidence: 0.95,
                sampleCount: sourceFiles.length,
                sourceFiles,
                alternatives: []
            });
        }
        if (successLogic) {
            validations.push({
                type: 'required_expression',
                value: successLogic,
                evidence: `成功判定逻辑: ${successLogic}`,
                confidence: 0.95,
                sampleCount: sourceFiles.length,
                sourceFiles,
                alternatives: []
            });
        }
        if (settingsReferenceStyle) {
            validations.push({
                type: 'required_settings_reference',
                value: settingsReferenceStyle,
                evidence: `Settings 访问风格: ${settingsReferenceStyle}`,
                confidence: 0.9,
                sampleCount: sourceFiles.length,
                sourceFiles,
                alternatives: settingsReferenceStyle === 'flat_member' ? ['nested_member'] : ['flat_member']
            });
        }
        const forbiddenSettingsSuffixes = Array.isArray(frontend.forbiddenSettingsSuffixes)
            ? frontend.forbiddenSettingsSuffixes.map(item => String(item || '').trim()).filter(Boolean)
            : [];
        if (forbiddenSettingsSuffixes.length > 0) {
            validations.push({
                type: 'forbidden_settings_suffix',
                value: forbiddenSettingsSuffixes,
                evidence: forbiddenSettingsSuffixes.join(','),
                confidence: 0.9,
                sampleCount: sourceFiles.length,
                sourceFiles,
                alternatives: []
            });
        }
        return validations;
    }

    _normalizeStructuredContractPayload(payload = {}, filePath = '') {
        const sourcePageRulesPath = String(
            payload.sourcePageRulesPath
            || payload.pageRulesPath
            || payload.sourcePath
            || String(filePath || '').replace(/\.contract\.json$/i, '.md')
        ).trim();
        const sourceFiles = Array.isArray(payload.sourceFiles)
            ? payload.sourceFiles.map(item => String(item || '').trim()).filter(Boolean)
            : (sourcePageRulesPath ? [sourcePageRulesPath] : []);
        const sampleCount = Number.isFinite(Number(payload.sampleCount)) ? Number(payload.sampleCount) : sourceFiles.length;
        const frontendInput = payload.frontend && typeof payload.frontend === 'object' ? payload.frontend : {};
        const backendInput = payload.backend && typeof payload.backend === 'object' ? payload.backend : {};
        const frontend = {
            ajaxTool: String(frontendInput.ajaxTool || '').trim(),
            settingsAccess: String(frontendInput.settingsAccess || '').trim(),
            successLogic: String(frontendInput.successLogic || '').trim(),
            settingsReferenceStyle: String(frontendInput.settingsReferenceStyle || '').trim(),
            coreCallSnippet: String(frontendInput.coreCallSnippet || '').trim()
        };
        const backend = {
            returnUtil: String(backendInput.returnUtil || '').trim(),
            importMirror: String(backendInput.importMirror || '').trim(),
            returnMirror: String(backendInput.returnMirror || '').trim()
        };
        return {
            ...payload,
            ok: payload.ok !== false,
            schemaVersion: Number.isFinite(Number(payload.schemaVersion)) ? Number(payload.schemaVersion) : 1,
            sourceType: String(payload.sourceType || '').trim() || 'structured_json',
            fallbackUsed: payload.fallbackUsed === true ? true : false,
            confidence: Number.isFinite(Number(payload.confidence)) ? Number(payload.confidence) : 0.95,
            sourcePageRulesPath,
            sourceFiles,
            sampleCount,
            frontend: {
                ...frontendInput,
                ...frontend,
                ajaxToolMeta: this._normalizeContractMeta(frontendInput.ajaxToolMeta, frontend.ajaxTool, sourceFiles, payload.confidence || 0.95),
                settingsAccessMeta: this._normalizeContractMeta(frontendInput.settingsAccessMeta, frontend.settingsAccess, sourceFiles, payload.confidence || 0.95),
                successLogicMeta: this._normalizeContractMeta(frontendInput.successLogicMeta, frontend.successLogic, sourceFiles, payload.confidence || 0.95),
                settingsReferenceStyleMeta: this._normalizeContractMeta(frontendInput.settingsReferenceStyleMeta, frontend.settingsReferenceStyle, sourceFiles, payload.confidence || 0.95),
                coreCallSnippetMeta: this._normalizeContractMeta(frontendInput.coreCallSnippetMeta, frontend.coreCallSnippet, sourceFiles, payload.confidence || 0.95),
                validations: this._buildStructuredValidations(frontendInput, sourceFiles)
            },
            backend: {
                ...backendInput,
                ...backend,
                returnUtilMeta: this._normalizeContractMeta(backendInput.returnUtilMeta, backend.returnUtil, sourceFiles, payload.confidence || 0.95),
                importMirrorMeta: this._normalizeContractMeta(backendInput.importMirrorMeta, backend.importMirror, sourceFiles, payload.confidence || 0.95),
                returnMirrorMeta: this._normalizeContractMeta(backendInput.returnMirrorMeta, backend.returnMirror, sourceFiles, payload.confidence || 0.95)
            },
            evidence: payload.evidence && typeof payload.evidence === 'object'
                ? payload.evidence
                : {
                    ajaxTool: frontend.ajaxTool,
                    settingsAccess: frontend.settingsAccess,
                    successLogic: frontend.successLogic,
                    importMirror: backend.importMirror,
                    coreCallSnippet: frontend.coreCallSnippet,
                    returnMirror: backend.returnMirror
                },
            warnings: Array.isArray(payload.warnings) ? payload.warnings : []
        };
    }

    validateContent(content, options = {}) {
        const configState = this.resolvePageRulesStageConfig(options);
        if (!configState.ok) return { ok: false, message: configState.message };
        const text = String(content || '');
        if (!text.trim()) return { ok: false, message: 'WEBSITE_PAGE_RULES_EMPTY' };
        if (/TEMPLATE_FILL_REQUIRED|待补充/.test(text)) return { ok: false, message: 'WEBSITE_PAGE_RULES_TEMPLATE_NOT_FILLED' };
        if (this._extractPageCompositionPayloadFromMarkdown(text)) {
            return { ok: true, content: text };
        }
        const missingMarkers = configState.requiredMarkers.filter(marker => !text.includes(marker));
        if (missingMarkers.length > 0) {
            return { ok: false, message: `WEBSITE_PAGE_RULES_MARKERS_MISSING: ${missingMarkers.join(', ')}` };
        }
        return { ok: true, content: text };
    }

    validateFile(filePath, options = {}) {
        if (!filePath || !fs.existsSync(filePath)) {
            return { ok: false, message: `WEBSITE_PAGE_RULES_MISSING: ${filePath || 'EMPTY'}`, path: filePath };
        }
        try {
            const content = fs.readFileSync(filePath, 'utf-8');
            const validation = this.validateContent(content, options);
            return { ...validation, path: filePath };
        } catch (error) {
            return { ok: false, message: `WEBSITE_PAGE_RULES_READ_ERROR: ${error.message}`, path: filePath };
        }
    }

    extractFact(content, regex) {
        const match = String(content || '').match(regex);
        return match ? String(match[1] || '').trim() : '';
    }

    extractCodeBlock(content, regex) {
        const match = String(content || '').match(regex);
        return match ? String(match[1] || '').trim() : '';
    }

    extractSourceFiles(content = '') {
        const matches = [...String(content || '').matchAll(/^\s*>\s*-\s+(.+?)\s*$/gm)];
        return [...new Set(matches.map(item => String(item[1] || '').trim()).filter(Boolean))];
    }

    buildObservationFact(value, sourceFiles = [], options = {}) {
        const normalizedValue = String(value || '').trim();
        const files = [...new Set((Array.isArray(sourceFiles) ? sourceFiles : []).map(item => String(item || '').trim()).filter(Boolean))];
        const sampleCount = files.length;
        const alternatives = [...new Set((Array.isArray(options.alternatives) ? options.alternatives : []).map(item => String(item || '').trim()).filter(Boolean).filter(item => item !== normalizedValue))];
        if (!normalizedValue) {
            return {
                value: '',
                confidence: 0,
                sampleCount,
                sourceFiles: files,
                alternatives
            };
        }
        let confidence = 0.58;
        if (sampleCount >= 2) confidence += 0.12;
        if (sampleCount >= 4) confidence += 0.08;
        if (options.hasMirror) confidence += 0.1;
        if (options.hasCoreSnippet) confidence += 0.07;
        if (options.strongSignal) confidence += 0.05;
        if (alternatives.length > 0) confidence -= Math.min(0.12, alternatives.length * 0.06);
        confidence = Math.max(0.35, Math.min(0.95, confidence));
        return {
            value: normalizedValue,
            confidence: Number(confidence.toFixed(2)),
            sampleCount,
            sourceFiles: files,
            alternatives
        };
    }

    buildObservations(pageRulesContent, pageRulesPath = '', options = {}) {
        const compositionPayload = options.compositionPayload || this._extractPageCompositionPayloadFromMarkdown(pageRulesContent);
        if (this._isPageCompositionPayload(compositionPayload)) {
            return this._buildCompositionObservations(compositionPayload, pageRulesPath);
        }
        const configState = this.resolvePageRulesStageConfig(options);
        if (!configState.ok) {
            return { ok: false, message: configState.message };
        }
        const extractors = configState.extractors;
        const sourceFiles = this.extractSourceFiles(pageRulesContent);
        const ajaxTool = this.extractFact(pageRulesContent, RuleValidationContract.compileRegex(extractors.ajaxTool));
        const settingsUsage = this.extractFact(pageRulesContent, RuleValidationContract.compileRegex(extractors.settingsUsage));
        const successLogic = this.extractFact(pageRulesContent, RuleValidationContract.compileRegex(extractors.successLogic));
        const backendReturnUtil = this.extractFact(pageRulesContent, RuleValidationContract.compileRegex(extractors.backendReturnUtil));
        const importMirror = this.extractFact(pageRulesContent, RuleValidationContract.compileRegex(extractors.importMirror));
        const returnMirror = this.extractFact(pageRulesContent, RuleValidationContract.compileRegex(extractors.returnMirror));
        const coreCallSnippet = this.extractCodeBlock(pageRulesContent, RuleValidationContract.compileRegex(extractors.coreCallSnippet));
        const settingsReferenceStyle = /_settings\.(?:be|fe)\.[A-Za-z0-9_]+/i.test(coreCallSnippet)
            ? 'nested_member'
            : (/_settings\.[A-Za-z0-9_]+/i.test(coreCallSnippet) ? 'flat_member' : '');
        const alternativeSettings = [];
        if (settingsReferenceStyle === 'flat_member') alternativeSettings.push('nested_member');
        if (settingsReferenceStyle === 'nested_member') alternativeSettings.push('flat_member');
        const warnings = [];
        if (sourceFiles.length < 2) warnings.push('PAGE_RULES_LOW_SAMPLE_COUNT');
        if (!coreCallSnippet) warnings.push('PAGE_RULES_CORE_CALL_SNIPPET_MISSING');
        if (!ajaxTool) warnings.push('PAGE_RULES_AJAX_TOOL_MISSING');
        if (!successLogic) warnings.push('PAGE_RULES_SUCCESS_LOGIC_MISSING');

        return {
            ok: true,
            payload: {
                generatedAt: new Date().toISOString(),
                sourcePageRulesPath: pageRulesPath,
                sampleCount: sourceFiles.length,
                sourceFiles,
                frontend: {
                    ajaxTool: this.buildObservationFact(ajaxTool, sourceFiles, {
                        hasCoreSnippet: Boolean(coreCallSnippet),
                        strongSignal: Boolean(ajaxTool)
                    }),
                    settingsAccess: this.buildObservationFact(settingsUsage, sourceFiles, {
                        hasCoreSnippet: Boolean(coreCallSnippet),
                        alternatives: settingsUsage && settingsUsage.includes('.be.')
                            ? ['_settings.xxx']
                            : alternativeSettings
                    }),
                    successLogic: this.buildObservationFact(successLogic, sourceFiles, {
                        hasCoreSnippet: Boolean(coreCallSnippet),
                        strongSignal: /code|success|ok/i.test(successLogic)
                    }),
                    settingsReferenceStyle: this.buildObservationFact(settingsReferenceStyle, sourceFiles, {
                        hasCoreSnippet: Boolean(coreCallSnippet),
                        alternatives: alternativeSettings
                    }),
                    coreCallSnippet: this.buildObservationFact(coreCallSnippet, sourceFiles, {
                        strongSignal: Boolean(coreCallSnippet)
                    })
                },
                backend: {
                    returnUtil: this.buildObservationFact(backendReturnUtil, sourceFiles, {
                        hasMirror: Boolean(returnMirror),
                        strongSignal: Boolean(backendReturnUtil)
                    }),
                    importMirror: this.buildObservationFact(importMirror, sourceFiles, {
                        hasMirror: Boolean(returnMirror)
                    }),
                    returnMirror: this.buildObservationFact(returnMirror, sourceFiles, {
                        hasMirror: Boolean(returnMirror),
                        strongSignal: Boolean(returnMirror)
                    })
                },
                warnings
            }
        };
    }

    ensureObservations(observationsPath, pageRulesContent, pageRulesPath, options = {}) {
        this.ensureDirectoryExists(path.dirname(observationsPath));
        const observationsState = this.buildObservations(pageRulesContent, pageRulesPath, options);
        if (!observationsState.ok) return observationsState;
        fs.writeFileSync(observationsPath, JSON.stringify(observationsState.payload, null, 2), 'utf-8');
        return { ok: true, path: observationsPath, payload: observationsState.payload };
    }

    validateObservations(filePath) {
        if (!filePath || !fs.existsSync(filePath)) {
            return { ok: false, message: `WEBSITE_PAGE_RULES_OBSERVATIONS_MISSING: ${filePath || 'EMPTY'}`, path: filePath };
        }
        try {
            const payload = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
            if (!payload || typeof payload !== 'object') {
                return { ok: false, message: 'WEBSITE_PAGE_RULES_OBSERVATIONS_INVALID: payload empty', path: filePath };
            }
            if (!Array.isArray(payload.sourceFiles)) {
                return { ok: false, message: 'WEBSITE_PAGE_RULES_OBSERVATIONS_INVALID: sourceFiles missing', path: filePath };
            }
            if (typeof payload.sampleCount !== 'number') {
                return { ok: false, message: 'WEBSITE_PAGE_RULES_OBSERVATIONS_INVALID: sampleCount missing', path: filePath };
            }
            if (!payload.frontend || typeof payload.frontend !== 'object' || !payload.backend || typeof payload.backend !== 'object') {
                return { ok: false, message: 'WEBSITE_PAGE_RULES_OBSERVATIONS_INVALID: frontend/backend missing', path: filePath };
            }
            return { ok: true, path: filePath, payload };
        } catch (error) {
            return { ok: false, message: `WEBSITE_PAGE_RULES_OBSERVATIONS_PARSE_ERROR: ${error.message}`, path: filePath };
        }
    }

    buildContract(pageRulesContent, pageRulesPath = '', options = {}) {
        // Phase 1: 结构化契约优先逻辑
        // 1. 尝试从 options 传入的现有契约中恢复 (如果是结构化的)
        if (options.existingContract && this._isStructuredContractPayload(options.existingContract) && !options.forceRefresh) {
            return this._normalizeStructuredContractPayload({
                ...options.existingContract,
                generatedAt: new Date().toISOString()
            }, String(options.contractPath || pageRulesPath || '').trim());
        }

        const compositionPayload = options.compositionPayload || this._extractPageCompositionPayloadFromMarkdown(pageRulesContent);
        if (this._isPageCompositionPayload(compositionPayload)) {
            const compositionObservationsState = this._buildCompositionObservations(compositionPayload, pageRulesPath);
            if (!compositionObservationsState.ok) return compositionObservationsState;
            const observations = compositionObservationsState.payload;
            const ajaxTool = String(observations.frontend && observations.frontend.ajaxTool && observations.frontend.ajaxTool.value || '').trim();
            const settingsUsage = String(observations.frontend && observations.frontend.settingsAccess && observations.frontend.settingsAccess.value || '').trim();
            const successLogic = String(observations.frontend && observations.frontend.successLogic && observations.frontend.successLogic.value || '').trim();
            const coreCallSnippet = String(observations.frontend && observations.frontend.coreCallSnippet && observations.frontend.coreCallSnippet.value || '').trim();
            const backendReturnUtil = String(observations.backend && observations.backend.returnUtil && observations.backend.returnUtil.value || '').trim();
            const importMirror = String(observations.backend && observations.backend.importMirror && observations.backend.importMirror.value || '').trim();
            const returnMirror = String(observations.backend && observations.backend.returnMirror && observations.backend.returnMirror.value || '').trim();
            const settingsReferenceStyle = String(observations.frontend && observations.frontend.settingsReferenceStyle && observations.frontend.settingsReferenceStyle.value || '').trim();
            const validations = [];
            const warnings = [...(Array.isArray(observations.warnings) ? observations.warnings : [])];
            const flowWarnings = (compositionPayload.pageComposition && Array.isArray(compositionPayload.pageComposition.dataFlows)
                ? compositionPayload.pageComposition.dataFlows
                : [])
                .flatMap(item => item && item.value && Array.isArray(item.value.warnings) ? item.value.warnings : []);
            warnings.push(...flowWarnings);
            if (ajaxTool) {
                validations.push({
                    type: 'required_call',
                    value: ajaxTool,
                    evidence: `page-composition 数据请求工具: ${ajaxTool}`,
                    confidence: observations.frontend.ajaxTool.confidence,
                    sampleCount: observations.frontend.ajaxTool.sampleCount,
                    sourceFiles: observations.frontend.ajaxTool.sourceFiles,
                    alternatives: observations.frontend.ajaxTool.alternatives
                });
            }
            if (successLogic) {
                validations.push({
                    type: 'required_expression',
                    value: successLogic,
                    evidence: `page-composition 成功判定: ${successLogic}`,
                    confidence: observations.frontend.successLogic.confidence,
                    sampleCount: observations.frontend.successLogic.sampleCount,
                    sourceFiles: observations.frontend.successLogic.sourceFiles,
                    alternatives: observations.frontend.successLogic.alternatives
                });
            }
            if (settingsReferenceStyle) {
                validations.push({
                    type: 'required_settings_reference',
                    value: settingsReferenceStyle,
                    evidence: `page-composition Settings 访问风格: ${settingsReferenceStyle}`,
                    confidence: observations.frontend.settingsReferenceStyle.confidence,
                    sampleCount: observations.frontend.settingsReferenceStyle.sampleCount,
                    sourceFiles: observations.frontend.settingsReferenceStyle.sourceFiles,
                    alternatives: observations.frontend.settingsReferenceStyle.alternatives
                });
            }
            if (ajaxTool === 'Util.ajax') {
                validations.push({
                    type: 'forbidden_settings_suffix',
                    value: ['be', 'fe'],
                    evidence: 'Util.ajax 已封装 be/fe 命名空间，JS 调用禁止写 _settings.be.xxx / _settings.fe.xxx',
                    confidence: 0.9,
                    sampleCount: observations.sampleCount,
                    sourceFiles: observations.sourceFiles,
                    alternatives: ['_settings.xxx']
                });
            }
            if (!validations.length) warnings.push('NO_FRONTEND_VALIDATIONS_EXTRACTED');
            return {
                ok: true,
                sourcePageRulesPath: pageRulesPath,
                generatedAt: new Date().toISOString(),
                sampleCount: observations.sampleCount,
                sourceFiles: observations.sourceFiles,
                sourceType: 'page_composition_contract',
                fallbackUsed: false,
                confidence: observations.sampleCount > 0 ? 0.9 : 0.5,
                frontend: {
                    ajaxTool,
                    ajaxToolMeta: observations.frontend.ajaxTool,
                    settingsAccess: settingsUsage,
                    settingsAccessMeta: observations.frontend.settingsAccess,
                    successLogic,
                    successLogicMeta: observations.frontend.successLogic,
                    settingsReferenceStyle,
                    settingsReferenceStyleMeta: observations.frontend.settingsReferenceStyle,
                    coreCallSnippet,
                    coreCallSnippetMeta: observations.frontend.coreCallSnippet,
                    templateTypes: observations.frontend.templateTypes,
                    resourceSkeleton: observations.frontend.resourceSkeleton,
                    pageComposition: observations.frontend.pageComposition,
                    validations
                },
                backend: {
                    returnUtil: backendReturnUtil,
                    returnUtilMeta: observations.backend.returnUtil,
                    importMirror,
                    importMirrorMeta: observations.backend.importMirror,
                    returnMirror,
                    returnMirrorMeta: observations.backend.returnMirror
                },
                evidence: {
                    ajaxTool,
                    settingsAccess: settingsUsage,
                    successLogic,
                    importMirror,
                    coreCallSnippet,
                    returnMirror
                },
                warnings: [...new Set(warnings)]
            };
        }

        const observationsState = this.buildObservations(pageRulesContent, pageRulesPath, options);
        if (!observationsState.ok) {
            return observationsState;
        }
        const observations = observationsState.payload;
        const ajaxTool = String(observations.frontend && observations.frontend.ajaxTool && observations.frontend.ajaxTool.value || '').trim();
        const settingsUsage = String(observations.frontend && observations.frontend.settingsAccess && observations.frontend.settingsAccess.value || '').trim();
        const successLogic = String(observations.frontend && observations.frontend.successLogic && observations.frontend.successLogic.value || '').trim();
        const backendReturnUtil = String(observations.backend && observations.backend.returnUtil && observations.backend.returnUtil.value || '').trim();
        const importMirror = String(observations.backend && observations.backend.importMirror && observations.backend.importMirror.value || '').trim();
        const returnMirror = String(observations.backend && observations.backend.returnMirror && observations.backend.returnMirror.value || '').trim();
        const coreCallSnippet = String(observations.frontend && observations.frontend.coreCallSnippet && observations.frontend.coreCallSnippet.value || '').trim();
        const validations = [];
        const warnings = [...(Array.isArray(observations.warnings) ? observations.warnings : [])];

        if (ajaxTool) {
            validations.push({
                type: 'required_call',
                value: ajaxTool,
                evidence: `前端工具: ${ajaxTool}`,
                confidence: observations.frontend.ajaxTool.confidence,
                sampleCount: observations.frontend.ajaxTool.sampleCount,
                sourceFiles: observations.frontend.ajaxTool.sourceFiles,
                alternatives: observations.frontend.ajaxTool.alternatives
            });
        }
        if (successLogic) {
            validations.push({
                type: 'required_expression',
                value: successLogic,
                evidence: `成功判定逻辑: ${successLogic}`,
                confidence: observations.frontend.successLogic.confidence,
                sampleCount: observations.frontend.successLogic.sampleCount,
                sourceFiles: observations.frontend.successLogic.sourceFiles,
                alternatives: observations.frontend.successLogic.alternatives
            });
        }

        let settingsReferenceStyle = '';
        if (/_settings\.(?:be|fe)\.[A-Za-z0-9_]+/i.test(coreCallSnippet)) {
            settingsReferenceStyle = 'nested_member';
            validations.push({
                type: 'required_settings_reference',
                value: settingsReferenceStyle,
                evidence: 'JS 调用镜像包含 `_settings.be.xxx / _settings.fe.xxx`',
                confidence: observations.frontend.settingsReferenceStyle.confidence,
                sampleCount: observations.frontend.settingsReferenceStyle.sampleCount,
                sourceFiles: observations.frontend.settingsReferenceStyle.sourceFiles,
                alternatives: observations.frontend.settingsReferenceStyle.alternatives
            });
        } else if (/_settings\.[A-Za-z0-9_]+/i.test(coreCallSnippet)) {
            settingsReferenceStyle = 'flat_member';
            validations.push({
                type: 'required_settings_reference',
                value: settingsReferenceStyle,
                evidence: 'JS 调用镜像包含 `_settings.xxx`',
                confidence: observations.frontend.settingsReferenceStyle.confidence,
                sampleCount: observations.frontend.settingsReferenceStyle.sampleCount,
                sourceFiles: observations.frontend.settingsReferenceStyle.sourceFiles,
                alternatives: observations.frontend.settingsReferenceStyle.alternatives
            });
        }

        const forbiddenSettingsSuffixes = [];
        if (settingsUsage && /\.(?:be)\b/i.test(settingsUsage)) forbiddenSettingsSuffixes.push('be');
        if (settingsUsage && /\.(?:fe)\b/i.test(settingsUsage)) forbiddenSettingsSuffixes.push('fe');
        if (forbiddenSettingsSuffixes.length > 0) {
            validations.push({
                type: 'forbidden_settings_suffix',
                value: forbiddenSettingsSuffixes,
                evidence: settingsUsage,
                confidence: observations.frontend.settingsAccess.confidence,
                sampleCount: observations.frontend.settingsAccess.sampleCount,
                sourceFiles: observations.frontend.settingsAccess.sourceFiles,
                alternatives: observations.frontend.settingsAccess.alternatives
            });
        }

        if (!validations.length) {
            warnings.push('NO_FRONTEND_VALIDATIONS_EXTRACTED');
        }

        return {
            ok: true,
            sourcePageRulesPath: pageRulesPath,
            generatedAt: new Date().toISOString(),
            sampleCount: observations.sampleCount,
            sourceFiles: observations.sourceFiles,
            sourceType: options.sourceType || 'markdown_fallback',
            fallbackUsed: options.fallbackUsed !== undefined ? options.fallbackUsed : true,
            confidence: options.confidence || (observations.sampleCount > 0 ? 0.75 : 0.5),
            frontend: {
                ajaxTool,
                ajaxToolMeta: observations.frontend.ajaxTool,
                settingsAccess: settingsUsage,
                settingsAccessMeta: observations.frontend.settingsAccess,
                successLogic,
                successLogicMeta: observations.frontend.successLogic,
                settingsReferenceStyle,
                settingsReferenceStyleMeta: observations.frontend.settingsReferenceStyle,
                coreCallSnippet,
                coreCallSnippetMeta: observations.frontend.coreCallSnippet,
                validations
            },
            backend: {
                returnUtil: backendReturnUtil,
                returnUtilMeta: observations.backend.returnUtil,
                importMirror,
                importMirrorMeta: observations.backend.importMirror,
                returnMirror,
                returnMirrorMeta: observations.backend.returnMirror
            },
            evidence: {
                ajaxTool,
                settingsAccess: settingsUsage,
                successLogic,
                importMirror,
                coreCallSnippet,
                returnMirror
            },
            warnings
        };
    }

    loadStructuredContract(contractPath, options = {}) {
        if (!contractPath || !fs.existsSync(contractPath)) {
            return { ok: false, message: 'STRUCTURED_CONTRACT_NOT_FOUND', path: contractPath };
        }
        const payload = this.readJsonSafe(contractPath);
        if (!this._isStructuredContractPayload(payload)) {
            return { ok: false, message: 'STRUCTURED_CONTRACT_INVALID_OR_FALLBACK', path: contractPath };
        }
        return this._normalizeStructuredContractPayload(payload, contractPath);
    }

    ensureContract(contractPath, pageRulesContent, pageRulesPath, options = {}) {
        this.ensureDirectoryExists(path.dirname(contractPath));

        // Phase 1: 优先尝试加载结构化契约
        if (!options.forceRefresh) {
            const structured = this.loadStructuredContract(contractPath, options);
            if (structured.ok) {
                return { ok: true, path: contractPath, payload: structured };
            }
        }

        const payload = this.buildContract(pageRulesContent, pageRulesPath, options);
        if (!payload.ok) return payload;
        fs.writeFileSync(contractPath, JSON.stringify(payload, null, 2), 'utf-8');
        return { ok: true, path: contractPath, payload };
    }

    buildCompactPayload(contractPayload = {}, observationsPayload = null, sourcePath = '') {
        return this._getArtifactService().buildCompactPayload(contractPayload, observationsPayload, sourcePath);
    }

    ensureCompact(compactPath, contractPath, observationsPath = '', options = {}) {
        return this._getArtifactService().ensureCompact(compactPath, contractPath, observationsPath, options);
    }

    validateCompact(filePath) {
        return this._getArtifactService().validateCompact(filePath);
    }

    validateFrontendFacts(contractPayload = {}) {
        const payload = contractPayload && typeof contractPayload === 'object' ? contractPayload : {};
        if (String(payload.sourceType || '').trim() !== 'page_composition_contract') {
            return { ok: true };
        }
        const frontend = payload.frontend && typeof payload.frontend === 'object' ? payload.frontend : {};
        const pageComposition = frontend.pageComposition && typeof frontend.pageComposition === 'object'
            ? frontend.pageComposition
            : {};
        const dataFlows = Array.isArray(pageComposition.dataFlows) ? pageComposition.dataFlows : [];
        const validations = Array.isArray(frontend.validations) ? frontend.validations : [];
        const warnings = Array.isArray(payload.warnings) ? payload.warnings : [];
        const reasons = [];
        if (dataFlows.length === 0 || warnings.includes('PAGE_COMPOSITION_DATA_FLOWS_MISSING')) {
            reasons.push('缺少业务 JS 数据调用证据');
        }
        if (!String(frontend.ajaxTool || '').trim()) {
            reasons.push('缺少请求工具事实，如 Util.ajax');
        }
        if (!String(frontend.settingsAccess || '').trim()) {
            reasons.push('缺少 _settings 接口地址访问事实');
        }
        if (validations.length === 0 || warnings.includes('NO_FRONTEND_VALIDATIONS_EXTRACTED')) {
            reasons.push('缺少可用于后续代码阶段校验的前端契约断言');
        }
        if (reasons.length === 0) return { ok: true };
        return {
            ok: false,
            message: `WEBSITE_PAGE_RULES_FRONTEND_FACTS_MISSING: page-rules.contract 未抽到可支撑网站生成的前端事实；${reasons.join('；')}。请在 scan 阶段补充可追踪到业务 JS 的参考页。`
        };
    }

    validateContract(filePath, options = {}) {
        const configState = this.resolvePageRulesContractConfig(options);
        if (!configState.ok) {
            return { ok: false, message: configState.message, path: filePath };
        }
        if (!filePath || !fs.existsSync(filePath)) {
            return { ok: false, message: `WEBSITE_PAGE_RULES_CONTRACT_MISSING: ${filePath || 'EMPTY'}`, path: filePath };
        }
        try {
            const rawPayload = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
            const payload = this._isStructuredContractPayload(rawPayload)
                ? this._normalizeStructuredContractPayload(rawPayload, filePath)
                : rawPayload;
            if (!payload || typeof payload !== 'object') {
                return { ok: false, message: 'WEBSITE_PAGE_RULES_CONTRACT_INVALID: payload empty', path: filePath };
            }
            if (!String(payload.sourcePageRulesPath || '').trim()) {
                return { ok: false, message: 'WEBSITE_PAGE_RULES_CONTRACT_INVALID: sourcePageRulesPath missing', path: filePath };
            }
            if (!Array.isArray(payload.sourceFiles)) {
                return { ok: false, message: 'WEBSITE_PAGE_RULES_CONTRACT_INVALID: sourceFiles missing', path: filePath };
            }
            if (typeof payload.sampleCount !== 'number') {
                return { ok: false, message: 'WEBSITE_PAGE_RULES_CONTRACT_INVALID: sampleCount missing', path: filePath };
            }
            if (!payload.frontend || typeof payload.frontend !== 'object') {
                return { ok: false, message: 'WEBSITE_PAGE_RULES_CONTRACT_INVALID: frontend missing', path: filePath };
            }
            if (!payload.backend || typeof payload.backend !== 'object') {
                return { ok: false, message: 'WEBSITE_PAGE_RULES_CONTRACT_INVALID: backend missing', path: filePath };
            }
            const missingFrontendKeys = configState.requiredFrontendKeys.filter(key => !Object.prototype.hasOwnProperty.call(payload.frontend, key));
            if (missingFrontendKeys.length > 0) {
                return { ok: false, message: `WEBSITE_PAGE_RULES_CONTRACT_INVALID: frontend missing ${missingFrontendKeys.join(', ')}`, path: filePath };
            }
            const missingBackendKeys = configState.requiredBackendKeys.filter(key => !Object.prototype.hasOwnProperty.call(payload.backend, key));
            if (missingBackendKeys.length > 0) {
                return { ok: false, message: `WEBSITE_PAGE_RULES_CONTRACT_INVALID: backend missing ${missingBackendKeys.join(', ')}`, path: filePath };
            }
            if (!payload.frontend.ajaxToolMeta || typeof payload.frontend.ajaxToolMeta !== 'object') {
                return { ok: false, message: 'WEBSITE_PAGE_RULES_CONTRACT_INVALID: frontend ajaxToolMeta missing', path: filePath };
            }
            if (!payload.backend.returnUtilMeta || typeof payload.backend.returnUtilMeta !== 'object') {
                return { ok: false, message: 'WEBSITE_PAGE_RULES_CONTRACT_INVALID: backend returnUtilMeta missing', path: filePath };
            }
            return { ok: true, path: filePath, payload };
        } catch (error) {
            return { ok: false, message: `WEBSITE_PAGE_RULES_CONTRACT_PARSE_ERROR: ${error.message}`, path: filePath };
        }
    }

    buildScanReportContent(pageRulesContent, pageRulesPath, source = 'global-cache', options = {}) {
        return this._getArtifactService().buildScanReportContent(pageRulesContent, pageRulesPath, source, options);
    }

    ensureScanReport(reportPath, pageRulesContent, pageRulesPath, source = 'global-cache', options = {}) {
        return this._getArtifactService().ensureScanReport(reportPath, pageRulesContent, pageRulesPath, source, options);
    }

    validateScanReport(filePath) {
        return this._getArtifactService().validateScanReport(filePath);
    }

    /** 松散格式：按逗号分隔提取 scan 锚点（sample.html, folder, 可选 subpath, 950及以上） */
}

module.exports = WebsitePageRulesContractService;
