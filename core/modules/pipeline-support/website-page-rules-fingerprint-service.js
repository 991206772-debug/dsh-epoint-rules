/* eslint-disable */

class WebsitePageRulesFingerprintService {
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

    escapeRegexText(value) {
        return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }

    buildLiteralRegex(value) {
        const normalized = this.escapeRegexText(String(value || '').trim()).replace(/\s+/g, '\\s*');
        return normalized ? new RegExp(normalized, 'i') : null;
    }

    buildCallRegex(value) {
        const normalized = this.escapeRegexText(String(value || '').trim()).replace(/\s+/g, '\\s*');
        return normalized ? new RegExp(`${normalized}\\s*\\(`, 'i') : null;
    }

    buildFrontendFingerprintConfig(contractPayload) {
        const validations = Array.isArray(contractPayload && contractPayload.frontend && contractPayload.frontend.validations)
            ? contractPayload.frontend.validations
            : [];
        const frontend = contractPayload && contractPayload.frontend && typeof contractPayload.frontend === 'object'
            ? contractPayload.frontend
            : {};
        const config = { mustHaveGroups: [], forbidden: [], minFiles: 1, validatorSource: 'page_rules_contract' };
        let hasValidation = false;

        const requireLiteral = value => {
            const regex = this.buildLiteralRegex(value);
            if (regex) {
                config.mustHaveGroups.push([regex]);
                hasValidation = true;
            }
        };
        const requireCall = value => {
            const regex = this.buildCallRegex(value);
            if (regex) {
                config.mustHaveGroups.push([regex]);
                hasValidation = true;
            }
        };

        requireCall(frontend.ajaxTool);
        requireCall(frontend.successLogic);
        requireLiteral(frontend.coreCallSnippet);
        if (frontend.settingsAccess === 'flat_member') {
            config.mustHaveGroups.push([/_settings\.[A-Za-z0-9_]+/i]);
            hasValidation = true;
        } else if (frontend.settingsAccess === 'nested_member') {
            config.mustHaveGroups.push([/_settings\.(?:be|fe)\.[A-Za-z0-9_]+/i]);
            hasValidation = true;
        }
        const bootScripts = frontend.resourceSkeleton && Array.isArray(frontend.resourceSkeleton.bootScripts)
            ? frontend.resourceSkeleton.bootScripts
            : [];
        bootScripts.slice(0, 6).forEach(script => requireLiteral(script));
        config.forbidden.push(/\$\.ajax\s*\(/i, /window\.open\s*\(/i);

        validations.forEach(validation => {
            const type = String(validation && validation.type || '').trim();
            const confidence = Number(validation && validation.confidence);
            if (Number.isFinite(confidence) && confidence < 0.55) {
                return;
            }
            if (type === 'required_call') {
                const regex = this.buildCallRegex(validation.value);
                if (regex) {
                    config.mustHaveGroups.push([regex]);
                    hasValidation = true;
                }
                return;
            }
            if (type === 'required_expression') {
                const regex = this.buildLiteralRegex(validation.value);
                if (regex) {
                    config.mustHaveGroups.push([regex]);
                    hasValidation = true;
                }
                return;
            }
            if (type === 'required_settings_reference') {
                if (validation.value === 'flat_member') {
                    config.mustHaveGroups.push([/_settings\.[A-Za-z0-9_]+/i]);
                    hasValidation = true;
                } else if (validation.value === 'nested_member') {
                    config.mustHaveGroups.push([/_settings\.(?:be|fe)\.[A-Za-z0-9_]+/i]);
                    hasValidation = true;
                }
                return;
            }
            if (type === 'forbidden_settings_suffix') {
                const suffixes = (Array.isArray(validation.value) ? validation.value : [])
                    .map(item => String(item || '').trim())
                    .filter(Boolean)
                    .map(item => this.escapeRegexText(item));
                if (suffixes.length > 0) {
                    config.forbidden.push(new RegExp(`_settings\\.(?:${suffixes.join('|')})\\.[A-Za-z0-9_]+\\b`, 'i'));
                    hasValidation = true;
                }
            }
        });

        if (!hasValidation) {
            return {
                blockingIssue: 'PAGE_RULES_FRONTEND_CONTRACT_EMPTY',
                validatorSource: 'page_rules_contract',
                failures: [this.buildValidationFailure('PAGE_RULES_FRONTEND_CONTRACT_EMPTY', 'PAGE_RULES_FRONTEND_CONTRACT_EMPTY', false)]
            };
        }
        return config;
    }

    resolveFingerprintConfig(step, ruleContext = null, options = {}) {
        const layerSpecName = String(ruleContext && ruleContext.layerSpecName || '').trim();
        const hint = `${String(step && step.label || '')} ${String(layerSpecName || '')}`.toLowerCase();
        if (!hint.includes('page-rules') && !hint.includes('前端') && !hint.includes('页面')) {
            return null;
        }
        const contractState = this.resolveContract(ruleContext, options);
        if (!contractState.ok) {
            return {
                blockingIssue: contractState.message,
                validatorSource: 'page_rules_contract',
                failures: [this.buildValidationFailure(contractState.message, contractState.message, false)]
            };
        }
        return this.buildFrontendFingerprintConfig(contractState.payload);
    }

}

module.exports = WebsitePageRulesFingerprintService;
