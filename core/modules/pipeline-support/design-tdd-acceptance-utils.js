const ACCEPTANCE_GROUPS = ['happyPath', 'exception', 'boundary'];

function _criteria(input = {}) {
    if (input && input.acceptanceCriteria && typeof input.acceptanceCriteria === 'object') {
        return input.acceptanceCriteria;
    }
    return input && typeof input === 'object' ? input : {};
}

function inferAcceptanceGroup(item = {}, fallback = 'happyPath') {
    const direct = String(item && item.group || '').trim();
    if (ACCEPTANCE_GROUPS.includes(direct)) return direct;
    const code = String(item && item.code || '').trim();
    const matched = code.match(/-(happyPath|exception|boundary)-\d+$/u);
    if (matched && ACCEPTANCE_GROUPS.includes(matched[1])) return matched[1];
    return ACCEPTANCE_GROUPS.includes(fallback) ? fallback : 'happyPath';
}

function getAcceptanceGroups(input = {}) {
    const ac = _criteria(input);
    const storyItems = Array.isArray(ac.storyAcceptanceItems) ? ac.storyAcceptanceItems : [];
    const storyGroups = { happyPath: [], exception: [], boundary: [] };
    storyItems.forEach(item => {
        storyGroups[inferAcceptanceGroup(item)].push(item);
    });
    const hasAnyLegacyGroup = ACCEPTANCE_GROUPS.some(group => Array.isArray(ac[group]) && ac[group].length > 0);
    return ACCEPTANCE_GROUPS.reduce((out, group) => {
        const legacy = Array.isArray(ac[group]) ? ac[group] : [];
        out[group] = legacy.length > 0 || hasAnyLegacyGroup ? legacy : storyGroups[group];
        return out;
    }, {});
}

function flattenAcceptanceItems(input = {}) {
    const ac = _criteria(input);
    const flat = [];
    const byCode = new Map();
    const add = (item, group, index, source) => {
        if (!item || typeof item !== 'object') return;
        const code = String(item.code || '').trim();
        const record = {
            item,
            code,
            group: inferAcceptanceGroup(item, group),
            index,
            source,
            scenario: String(item.scenario || '').trim()
        };
        if (code && byCode.has(code)) {
            const existing = byCode.get(code);
            if (!existing.scenario && record.scenario) existing.scenario = record.scenario;
            return;
        }
        if (code) byCode.set(code, record);
        flat.push(record);
    };
    const storyItems = Array.isArray(ac.storyAcceptanceItems) ? ac.storyAcceptanceItems : [];
    storyItems.forEach((item, index) => add(item, inferAcceptanceGroup(item), index, 'storyAcceptanceItems'));
    for (const group of ACCEPTANCE_GROUPS) {
        const arr = Array.isArray(ac[group]) ? ac[group] : [];
        arr.forEach((item, index) => add(item, group, index, group));
    }
    return flat;
}

function findAcceptanceItem(input = {}, code = '') {
    const wanted = String(code || '').trim();
    const found = flattenAcceptanceItems(input).find(entry => entry.code === wanted);
    return found ? { found: true, ...found } : { found: false };
}

function collectAcceptanceCodes(input = {}) {
    return flattenAcceptanceItems(input).map(entry => entry.code).filter(Boolean);
}

function inferModuleIdFromCode(code = '') {
    const text = String(code || '').trim();
    const match = text.match(/^((?:MOD|STORY)-\d+)-/iu);
    return match ? match[1].toUpperCase() : '';
}

function inferStoryIdFromCode(code = '') {
    const text = String(code || '').trim();
    const match = text.match(/^(US\d+)-/iu);
    return match ? match[1].toUpperCase() : '';
}

function acceptanceModuleId(item = {}, code = '') {
    return String(
        item && (item.moduleId || item.sourceModuleId)
        || inferModuleIdFromCode(code)
        || ''
    ).trim();
}

function acceptanceStoryId(item = {}, code = '') {
    return String(
        item && (item.storyId || item.sourceStoryId)
        || inferStoryIdFromCode(code)
        || ''
    ).trim().toUpperCase();
}

function flattenBusinessFactsAcceptanceItems(facts = {}) {
    const ledgerItems = facts && facts.acceptanceLedger && Array.isArray(facts.acceptanceLedger.items)
        ? facts.acceptanceLedger.items
        : [];
    if (ledgerItems.length > 0) {
        return ledgerItems
            .map((item, index) => {
                if (!item || typeof item !== 'object') return null;
                const code = String(item.code || '').trim();
                if (!code) return null;
                return {
                    item,
                    code,
                    group: inferAcceptanceGroup(item),
                    index,
                    source: 'acceptanceLedger',
                    moduleId: acceptanceModuleId(item, code),
                    storyId: acceptanceStoryId(item, code),
                    scenario: String(item.scenario || '').trim()
                };
            })
            .filter(Boolean);
    }

    const modules = facts && facts.modules && typeof facts.modules === 'object' ? facts.modules : {};
    const flat = [];
    for (const moduleId of Object.keys(modules)) {
        const ac = modules[moduleId] && modules[moduleId].acceptanceCriteria;
        flattenAcceptanceItems(ac || {}).forEach(entry => {
            flat.push({
                ...entry,
                moduleId,
                storyId: acceptanceStoryId(entry.item, entry.code)
            });
        });
    }
    return flat;
}

function findBusinessFactsAcceptanceItem(facts = {}, code = '', moduleId = '') {
    const wanted = String(code || '').trim();
    const wantedModule = String(moduleId || '').trim();
    const found = flattenBusinessFactsAcceptanceItems(facts).find(entry => {
        if (entry.code !== wanted) return false;
        return !wantedModule || entry.moduleId === wantedModule;
    });
    return found ? { found: true, ...found } : { found: false };
}

function collectBusinessFactsAcceptanceCodes(facts = {}) {
    return flattenBusinessFactsAcceptanceItems(facts).map(entry => entry.code).filter(Boolean);
}

module.exports = {
    ACCEPTANCE_GROUPS,
    collectBusinessFactsAcceptanceCodes,
    collectAcceptanceCodes,
    findBusinessFactsAcceptanceItem,
    findAcceptanceItem,
    flattenBusinessFactsAcceptanceItems,
    flattenAcceptanceItems,
    getAcceptanceGroups,
    inferModuleIdFromCode,
    inferStoryIdFromCode,
    inferAcceptanceGroup
};
