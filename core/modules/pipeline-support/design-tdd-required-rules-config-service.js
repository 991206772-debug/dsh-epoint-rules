/* eslint-disable */
const fs = require('fs');
const path = require('path');

const DEFAULT_CONFIG_PATH = path.join(__dirname, '..', '..', 'contracts', 'design-tdd-required-rules.json');
const builtinConfig = require('../../contracts/design-tdd-required-rules.json');

function uniqueStrings(values = []) {
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

function normalizeStringArray(value) {
    if (!Array.isArray(value)) return [];
    return uniqueStrings(value);
}

function positiveInt(value, fallback) {
    const num = Number(value);
    return Number.isFinite(num) && num > 0 ? Math.floor(num) : fallback;
}

function mergeRequiredRules(base = [], override = []) {
    const out = [];
    const byAlias = new Map();
    for (const item of [...(Array.isArray(base) ? base : []), ...(Array.isArray(override) ? override : [])]) {
        const ruleAlias = String(item && item.ruleAlias || '').trim();
        if (!ruleAlias) continue;
        byAlias.set(ruleAlias, item);
    }
    for (const item of byAlias.values()) out.push(item);
    return out;
}

function mergeConfigPayload(base = {}, override = {}) {
    const source = base && typeof base === 'object' && !Array.isArray(base) ? base : {};
    const patch = override && typeof override === 'object' && !Array.isArray(override) ? override : {};
    return {
        ...source,
        ...patch,
        hintLimits: {
            ...((source.hintLimits && typeof source.hintLimits === 'object' && !Array.isArray(source.hintLimits)) ? source.hintLimits : {}),
            ...((patch.hintLimits && typeof patch.hintLimits === 'object' && !Array.isArray(patch.hintLimits)) ? patch.hintLimits : {})
        },
        fileKindTemplateRules: {
            ...((source.fileKindTemplateRules && typeof source.fileKindTemplateRules === 'object' && !Array.isArray(source.fileKindTemplateRules)) ? source.fileKindTemplateRules : {}),
            ...((patch.fileKindTemplateRules && typeof patch.fileKindTemplateRules === 'object' && !Array.isArray(patch.fileKindTemplateRules)) ? patch.fileKindTemplateRules : {})
        },
        requiredRules: mergeRequiredRules(source.requiredRules, patch.requiredRules)
    };
}

function normalizeConfigCore(payload = {}) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
        throw new Error('DESIGN_TDD_REQUIRED_RULES_CONFIG_INVALID: root must be object');
    }
    const fileKindTemplateRules = {};
    const templateSource = payload.fileKindTemplateRules && typeof payload.fileKindTemplateRules === 'object'
        && !Array.isArray(payload.fileKindTemplateRules)
        ? payload.fileKindTemplateRules
        : {};
    Object.keys(templateSource).forEach(fileKind => {
        const key = String(fileKind || '').trim();
        if (!key) return;
        fileKindTemplateRules[key] = normalizeStringArray(templateSource[fileKind]);
    });

    const requiredRules = (Array.isArray(payload.requiredRules) ? payload.requiredRules : [])
        .map(item => ({
            ruleAlias: String(item && item.ruleAlias || '').trim(),
            appliesToFileKinds: normalizeStringArray(item && item.appliesToFileKinds),
            reason: String(item && item.reason || '').trim()
        }))
        .filter(item => item.ruleAlias && item.appliesToFileKinds.length > 0);

    const fileKindRequiredRules = {};
    Object.keys(fileKindTemplateRules).forEach(fileKind => {
        fileKindRequiredRules[fileKind] = [...fileKindTemplateRules[fileKind]];
    });
    for (const item of requiredRules) {
        for (const fileKind of item.appliesToFileKinds) {
            if (!fileKindRequiredRules[fileKind]) fileKindRequiredRules[fileKind] = [];
            fileKindRequiredRules[fileKind].push(item.ruleAlias);
            fileKindRequiredRules[fileKind] = uniqueStrings(fileKindRequiredRules[fileKind]);
        }
    }

    const ruleFileKindsMap = {};
    Object.entries(fileKindRequiredRules).forEach(([fileKind, aliases]) => {
        for (const alias of aliases) {
            if (!ruleFileKindsMap[alias]) ruleFileKindsMap[alias] = [];
            ruleFileKindsMap[alias].push(fileKind);
            ruleFileKindsMap[alias] = uniqueStrings(ruleFileKindsMap[alias]);
        }
    });

    const hintLimitsSource = payload.hintLimits && typeof payload.hintLimits === 'object'
        && !Array.isArray(payload.hintLimits)
        ? payload.hintLimits
        : {};
    const hintLimits = {
        maxHintsPerCard: positiveInt(hintLimitsSource.maxHintsPerCard, 3),
        methodsPerRule: positiveInt(hintLimitsSource.methodsPerRule, 8),
        methodsPerCardHint: positiveInt(hintLimitsSource.methodsPerCardHint, 4),
        actionsPerHint: positiveInt(hintLimitsSource.actionsPerHint, 8),
        actionsPerCardHint: positiveInt(hintLimitsSource.actionsPerCardHint, 6),
        forbiddenPerHint: positiveInt(hintLimitsSource.forbiddenPerHint, 8),
        forbiddenPerCardHint: positiveInt(hintLimitsSource.forbiddenPerCardHint, 5),
        triggerTermsPerHint: positiveInt(hintLimitsSource.triggerTermsPerHint, 8),
        ruleRefsPerCard: positiveInt(hintLimitsSource.ruleRefsPerCard, 6),
        ruleRefsPerHint: positiveInt(hintLimitsSource.ruleRefsPerHint, 3),
        tableNamesPerHint: positiveInt(hintLimitsSource.tableNamesPerHint, 4),
        entityNamesPerHint: positiveInt(hintLimitsSource.entityNamesPerHint, 4),
        intentKeywordsPerHint: positiveInt(hintLimitsSource.intentKeywordsPerHint, 8),
        intentKeywordsPerCardHint: positiveInt(hintLimitsSource.intentKeywordsPerCardHint, 6),
        signatureChars: positiveInt(hintLimitsSource.signatureChars, 300),
        summaryChars: positiveInt(hintLimitsSource.summaryChars, 120),
        descriptionChars: positiveInt(hintLimitsSource.descriptionChars, 140),
        maxCandidatesPerCard: positiveInt(hintLimitsSource.maxCandidatesPerCard, 4),
        maxUnknownFileKindCandidates: positiveInt(hintLimitsSource.maxUnknownFileKindCandidates, 2),
        candidateSignatureChars: positiveInt(hintLimitsSource.candidateSignatureChars, 160),
        candidateReasonChars: positiveInt(hintLimitsSource.candidateReasonChars, 80)
    };

    return {
        schemaVersion: String(payload.schemaVersion || 'design-tdd-required-rules/v1').trim(),
        description: String(payload.description || '').trim(),
        hintLimits,
        fileKindTemplateRules,
        requiredRules,
        fileKindRequiredRules,
        ruleFileKindsMap
    };
}

function normalizeConfig(payload = {}) {
    const base = normalizeConfigCore(payload);
    const versionBuckets = {};
    const buckets = payload && payload.versionBuckets && typeof payload.versionBuckets === 'object' && !Array.isArray(payload.versionBuckets)
        ? payload.versionBuckets
        : {};
    for (const [bucket, override] of Object.entries(buckets)) {
        const key = String(bucket || '').trim();
        if (!key) continue;
        versionBuckets[key] = normalizeConfigCore(mergeConfigPayload(payload, override));
    }
    const frameworkVersions = {};
    const versions = payload && payload.frameworkVersions && typeof payload.frameworkVersions === 'object' && !Array.isArray(payload.frameworkVersions)
        ? payload.frameworkVersions
        : {};
    for (const [frameworkVersion, override] of Object.entries(versions)) {
        const key = String(frameworkVersion || '').trim();
        if (!key) continue;
        frameworkVersions[key] = normalizeConfigCore(mergeConfigPayload(payload, override));
    }
    return {
        ...base,
        versionBuckets,
        frameworkVersions
    };
}

class DesignTddRequiredRulesConfigService {
    constructor(options = {}) {
        this.configPath = String(options.configPath || DEFAULT_CONFIG_PATH).trim();
        this._cache = null;
    }

    loadConfig() {
        if (this._cache) return this._cache;
        if (!this.configPath) {
            throw new Error('DESIGN_TDD_REQUIRED_RULES_CONFIG_PATH_MISSING');
        }
        let parsed;
        try {
            const raw = fs.readFileSync(this.configPath, 'utf-8');
            parsed = JSON.parse(raw);
        } catch (err) {
            if (this.configPath === DEFAULT_CONFIG_PATH) {
                parsed = builtinConfig;
            } else {
                throw err;
            }
        }
        this._cache = {
            ...normalizeConfig(parsed),
            rawPayload: parsed,
            configPath: this.configPath
        };
        return this._cache;
    }

    _versionContext(input = '') {
        if (input && typeof input === 'object' && !Array.isArray(input)) {
            const frameworkBucket = input.frameworkBucket && typeof input.frameworkBucket === 'object'
                ? input.frameworkBucket
                : {};
            const evidence = input.evidence && typeof input.evidence === 'object'
                ? input.evidence
                : {};
            const frameworkVersionEvidence = input.frameworkVersionEvidence && typeof input.frameworkVersionEvidence === 'object'
                ? input.frameworkVersionEvidence
                : {};
            return {
                versionBucket: String(
                    input.versionBucket ||
                    input.bucket ||
                    frameworkBucket.versionBucket ||
                    frameworkBucket.bucket ||
                    ''
                ).trim(),
                frameworkVersion: String(
                    input.frameworkVersion ||
                    input.frameVersion ||
                    input.projectContextFrameVersion ||
                    evidence.version ||
                    frameworkVersionEvidence.version ||
                    ''
                ).trim()
            };
        }
        return {
            versionBucket: String(input || '').trim(),
            frameworkVersion: ''
        };
    }

    _normalizeFrameworkVersionKey(value = '') {
        return String(value || '').trim().toLowerCase().replace(/^v/u, '');
    }

    _frameworkVersionLookupKeys(frameworkVersion = '') {
        const normalized = this._normalizeFrameworkVersionKey(frameworkVersion);
        if (!normalized) return [];
        const out = [normalized];
        const release = normalized.replace(/[-+].*$/u, '');
        if (release && release !== normalized) out.push(release);
        const match = release.match(/^(\d+)(?:\.(\d+))?(?:\.(\d+))?/u);
        if (match) {
            const major = match[1];
            const minor = match[2];
            const patch = match[3];
            if (major && minor && patch) out.push(`${major}.${minor}.${patch}`);
            if (major && minor) {
                out.push(`${major}.${minor}.x`);
                out.push(`${major}.${minor}.*`);
            }
            if (major) {
                out.push(`${major}.x`);
                out.push(`${major}.*`);
            }
        }
        return uniqueStrings(out);
    }

    _pickFrameworkVersionOverrides(frameworkVersions = {}, frameworkVersion = '') {
        const keys = this._frameworkVersionLookupKeys(frameworkVersion);
        if (keys.length === 0) return [];
        const byKey = new Map();
        for (const [rawKey, override] of Object.entries(frameworkVersions || {})) {
            const normalizedKey = this._normalizeFrameworkVersionKey(rawKey);
            if (!normalizedKey || !keys.includes(normalizedKey)) continue;
            byKey.set(normalizedKey, override);
        }
        return [...keys].reverse()
            .map(key => byKey.get(key))
            .filter(Boolean);
    }

    _configForVersion(versionContext = '') {
        const config = this.loadConfig();
        const context = this._versionContext(versionContext);
        const rawPayload = config.rawPayload || {};
        const bucketOverride = context.versionBucket
            && rawPayload.versionBuckets
            && rawPayload.versionBuckets[context.versionBucket]
            ? rawPayload.versionBuckets[context.versionBucket]
            : null;
        const frameworkOverrides = this._pickFrameworkVersionOverrides(rawPayload.frameworkVersions, context.frameworkVersion);
        if (bucketOverride || frameworkOverrides.length > 0) {
            const cacheKey = `ctx:${context.versionBucket || ''}:${context.frameworkVersion || ''}`;
            if (!config._contextConfigs) config._contextConfigs = {};
            if (!config._contextConfigs[cacheKey]) {
                let merged = rawPayload;
                if (bucketOverride) merged = mergeConfigPayload(merged, bucketOverride);
                for (const frameworkOverride of frameworkOverrides) {
                    merged = mergeConfigPayload(merged, frameworkOverride);
                }
                config._contextConfigs[cacheKey] = normalizeConfigCore(merged);
            }
            return config._contextConfigs[cacheKey];
        }
        return config;
    }

    getFileKindRequiredRulesMap(versionContext = '') {
        return this._configForVersion(versionContext).fileKindRequiredRules;
    }

    getFileKindTemplateRulesMap(versionContext = '') {
        return this._configForVersion(versionContext).fileKindTemplateRules;
    }

    getAllTemplateRuleAliases(versionContext = '') {
        const map = this.getFileKindTemplateRulesMap(versionContext);
        return uniqueStrings(Object.values(map || {}).flat());
    }

    getApiUsageRulesForFileKind(fileKind, versionContext = '') {
        const key = String(fileKind || '').trim();
        if (!key) return [];
        const rules = this._configForVersion(versionContext).requiredRules || [];
        return uniqueStrings(rules
            .filter(rule => Array.isArray(rule.appliesToFileKinds) && rule.appliesToFileKinds.includes(key))
            .map(rule => rule.ruleAlias));
    }

    getAllApiUsageRuleAliases(versionContext = '') {
        const rules = this._configForVersion(versionContext).requiredRules || [];
        return uniqueStrings(rules.map(rule => rule.ruleAlias));
    }

    getRulesForFileKind(fileKind, versionContext = '') {
        const key = String(fileKind || '').trim();
        if (!key) return [];
        return uniqueStrings(this.getFileKindRequiredRulesMap(versionContext)[key] || []);
    }

    getRuleFileKindsMap(versionContext = '') {
        return this._configForVersion(versionContext).ruleFileKindsMap;
    }

    getFileKindsForRule(ruleAlias, versionContext = '') {
        const key = String(ruleAlias || '').trim();
        if (!key) return [];
        return uniqueStrings(this.getRuleFileKindsMap(versionContext)[key] || []);
    }

    getHintLimits(versionContext = '') {
        return this._configForVersion(versionContext).hintLimits;
    }
}

module.exports = DesignTddRequiredRulesConfigService;
module.exports.DEFAULT_CONFIG_PATH = DEFAULT_CONFIG_PATH;
module.exports.normalizeConfig = normalizeConfig;
