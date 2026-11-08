const yaml = require('js-yaml');

function stripFrontmatter(content = '') {
    return String(content || '').replace(/^---[\s\S]*?---\s*/, '');
}

function extractContractYaml(content = '', heading = 'AI Validation Contract') {
    const body = stripFrontmatter(content);
    const safeHeading = String(heading || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const match = body.match(new RegExp(`(?:^|\\n)##\\s+${safeHeading}\\s*\\n+\\\`\\\`\\\`yaml\\s*\\n([\\s\\S]*?)\\n\\\`\\\`\\\``, 'm'));
    return match ? String(match[1] || '').trim() : '';
}

function extractValidationContractYaml(content = '') {
    return extractContractYaml(content, 'AI Validation Contract');
}

function extractStageContractYaml(content = '') {
    return extractContractYaml(content, 'AI Stage Contract');
}

function extractRequirementBridgeContractYaml(content = '') {
    return extractContractYaml(content, 'AI Requirement Bridge Contract');
}

function extractApiCapabilityContractYaml(content = '') {
    return extractContractYaml(content, 'AI API Capability Contract');
}

function extractSkeletonApiContractYaml(content = '') {
    return extractContractYaml(content, 'AI Skeleton API Contract');
}

function parseYamlContract(content = '', heading = 'AI Validation Contract', missingCode = 'RULE_VALIDATION_CONTRACT_MISSING') {
    const yamlText = extractContractYaml(content, heading);
    if (!yamlText) {
        return {
            ok: false,
            code: missingCode,
            message: missingCode
        };
    }

    try {
        const payload = yaml.load(yamlText) || {};
        if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
            return {
                ok: false,
                code: 'RULE_VALIDATION_CONTRACT_INVALID',
                message: 'RULE_VALIDATION_CONTRACT_INVALID: payload must be an object'
            };
        }
        return { ok: true, contract: payload, rawYaml: yamlText };
    } catch (error) {
        return {
            ok: false,
            code: `${missingCode.replace(/MISSING$/, 'PARSE_ERROR')}`,
            message: `${missingCode.replace(/MISSING$/, 'PARSE_ERROR')}: ${error.message}`
        };
    }
}

function parseValidationContract(content = '') {
    return parseYamlContract(content, 'AI Validation Contract', 'RULE_VALIDATION_CONTRACT_MISSING');
}

function parseStageContract(content = '') {
    return parseYamlContract(content, 'AI Stage Contract', 'RULE_STAGE_CONTRACT_MISSING');
}

function parseRequirementBridgeContract(content = '') {
    return parseYamlContract(content, 'AI Requirement Bridge Contract', 'RULE_REQUIREMENT_BRIDGE_CONTRACT_MISSING');
}

function parseApiCapabilityContract(content = '') {
    return parseYamlContract(content, 'AI API Capability Contract', 'RULE_API_CAPABILITY_CONTRACT_MISSING');
}

function parseSkeletonApiContract(content = '') {
    return parseYamlContract(content, 'AI Skeleton API Contract', 'RULE_SKELETON_API_CONTRACT_MISSING');
}

function resolveContractProfile(contract = {}, profileName = '') {
    const normalizedProfile = String(profileName || '').trim();
    const profiles = contract && typeof contract === 'object' && !Array.isArray(contract)
        ? contract.profiles
        : null;
    if (!normalizedProfile || !profiles || typeof profiles !== 'object' || Array.isArray(profiles)) {
        return contract;
    }
    return profiles[normalizedProfile] || contract;
}

function resolveStageContract(contract = {}, profileName = '', stageKey = '') {
    const profileContract = resolveContractProfile(contract, profileName);
    const normalizedStageKey = String(stageKey || '').trim();
    if (!normalizedStageKey) return profileContract;
    if (profileContract && profileContract.stages && typeof profileContract.stages === 'object' && !Array.isArray(profileContract.stages)) {
        return profileContract.stages[normalizedStageKey] || null;
    }
    if (profileContract && typeof profileContract === 'object' && !Array.isArray(profileContract)) {
        return profileContract[normalizedStageKey] || null;
    }
    return null;
}

function compileRegex(patternLike) {
    if (patternLike instanceof RegExp) return patternLike;
    const source = String(patternLike || '').trim();
    if (!source) return null;

    const literalMatch = source.match(/^\/([\s\S]*)\/([gimsuy]*)$/);
    try {
        if (literalMatch) {
            const body = literalMatch[1].includes('\\\\')
                ? literalMatch[1].replace(/\\\\/g, '\\')
                : literalMatch[1];
            return new RegExp(body, literalMatch[2]);
        }
        const normalizedSource = source.includes('\\\\')
            ? source.replace(/\\\\/g, '\\')
            : source;
        return new RegExp(normalizedSource);
    } catch (_) {
        return null;
    }
}

function compileRegexList(items = []) {
    return (Array.isArray(items) ? items : [])
        .map(item => compileRegex(item))
        .filter(Boolean);
}

function buildFingerprintConfig(contract = {}) {
    const fingerprint = contract && typeof contract === 'object'
        ? (contract.fingerprint || contract)
        : {};
    const buildBucket = bucket => {
        const normalizedBucket = bucket && typeof bucket === 'object' && !Array.isArray(bucket)
            ? bucket
            : {};
        const mustHaveGroups = Array.isArray(normalizedBucket.must_have_groups || normalizedBucket.mustHaveGroups)
            ? (normalizedBucket.must_have_groups || normalizedBucket.mustHaveGroups)
                .map(group => compileRegexList(group))
                .filter(group => group.length > 0)
            : [];
        return {
            minFiles: typeof normalizedBucket.min_files === 'number'
                ? normalizedBucket.min_files
                : (typeof normalizedBucket.minFiles === 'number' ? normalizedBucket.minFiles : null),
            requiredPathPatterns: compileRegexList(normalizedBucket.required_path_patterns || normalizedBucket.requiredPathPatterns),
            mustHaveGroups,
            forbidden: compileRegexList(normalizedBucket.forbidden_patterns || normalizedBucket.forbiddenPatterns)
        };
    };
    const mustHaveGroups = Array.isArray(fingerprint.must_have_groups)
        ? fingerprint.must_have_groups
            .map(group => compileRegexList(group))
            .filter(group => group.length > 0)
        : [];
    const byFileKindSource = fingerprint.by_file_kind && typeof fingerprint.by_file_kind === 'object' && !Array.isArray(fingerprint.by_file_kind)
        ? fingerprint.by_file_kind
        : (fingerprint.byFileKind && typeof fingerprint.byFileKind === 'object' && !Array.isArray(fingerprint.byFileKind)
            ? fingerprint.byFileKind
            : {});
    const byFileKind = Object.keys(byFileKindSource).reduce((result, key) => {
        const normalizedKey = String(key || '').trim();
        if (!normalizedKey) return result;
        result[normalizedKey] = buildBucket(byFileKindSource[key]);
        return result;
    }, {});

    return {
        minFiles: typeof fingerprint.min_files === 'number' ? fingerprint.min_files : null,
        requiredPathPatterns: compileRegexList(fingerprint.required_path_patterns),
        mustHaveGroups,
        forbidden: compileRegexList(fingerprint.forbidden_patterns),
        byFileKind
    };
}

module.exports = {
    stripFrontmatter,
    extractContractYaml,
    extractValidationContractYaml,
    extractStageContractYaml,
    extractRequirementBridgeContractYaml,
    extractApiCapabilityContractYaml,
    extractSkeletonApiContractYaml,
    parseYamlContract,
    parseValidationContract,
    parseStageContract,
    parseRequirementBridgeContract,
    parseApiCapabilityContract,
    parseSkeletonApiContract,
    resolveContractProfile,
    resolveStageContract,
    compileRegex,
    compileRegexList,
    buildFingerprintConfig
};
