/* eslint-disable */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const SLICE_BYTES = 32 * 1024;
const ENTRY_BYTES = 12 * 1024;
const array = value => Array.isArray(value) ? value : [];
const unique = values => [...new Set(values.filter(Boolean))];
const encode = value => `${JSON.stringify(value, null, 2)}\n`;
const bytes = value => Buffer.byteLength(encode(value), 'utf8');
const safe = value => encodeURIComponent(String(value)).replace(/\./g, '%2E');
const digest = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 24);
const identity = value => {
    const resolved = path.resolve(value);
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
};
const RETIRED_FILES = ['executable-rule-contracts.json', 'pre-materialize-draft.json'];

function readMaterialIndex(codeDir) {
    const root = path.resolve(codeDir);
    const active = new Set();
    const resolve = value => {
        if (!value || typeof value !== 'object') return value;
        if (value.schemaVersion === 'work-slice/continuation/v1') {
            const parts = value.contentRefs.map(read);
            if (value.nextRef) parts.push(read(value.nextRef));
            if (value.valueType === 'array') return parts.flat();
            if (value.valueType === 'string') return parts.join('');
            return Object.assign({}, ...parts);
        }
        if (Object.keys(value).length === 1 && value.contentRef) return read(value.contentRef);
        if (Array.isArray(value)) return value.map(resolve);
        return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, resolve(item)]));
    };
    const read = file => {
        const resolved = path.resolve(root, file);
        const relative = path.relative(root, resolved);
        if (!relative || relative.startsWith('..') || path.isAbsolute(relative) || active.has(resolved)) throw new Error('Invalid material index reference');
        let parent = resolved;
        while (true) {
            if (fs.lstatSync(parent).isSymbolicLink()) throw new Error('Linked material index reference');
            if (identity(parent) === identity(root)) break;
            parent = path.dirname(parent);
        }
        active.add(resolved);
        try { return resolve(JSON.parse(fs.readFileSync(resolved, 'utf8'))); }
        finally { active.delete(resolved); }
    };
    try { return read(path.join(root, 'work-slices/index.json')); } catch (_) { return null; }
}

function ownedMaterialName(relative) {
    return /^(?:requirement-work-draft|requirement-work-package)(?:\.[\w%.-]+)?\.json$/.test(relative)
        || /^work-slices\/(?:index|stories|files-fields|business-facts|target-index|read-catalog|routes|reuse|self-check)(?:\.[\w%.-]+)?\.json$/.test(relative)
        || /^work-slices\/records\/[\w%.-]+-[a-f0-9]{24}(?:\.[\w%.-]+)?\.json$/.test(relative)
        || /^work-slices\/stories\/US\d+(?:\.[\w%.-]+)?\.json$/.test(relative)
        || /^work-slices\/targets\/MOD-[\w%.-]+\.json$/.test(relative)
        || /^work-slices\/(?:rules|practices)\/[A-Z][\w%.-]*\.json$/.test(relative);
}

function obsoleteMaterialFiles(codeDir, nextFiles) {
    const root = path.resolve(codeDir);
    const expected = new Set([...nextFiles].map(ref => identity(path.resolve(root, ref))));
    const owned = new Set(array(readMaterialIndex(root)?.managedFiles));
    const sliceRoot = path.join(root, 'work-slices');
    // Legacy publications did not record ownership. Restrict discovery to their generated names.
    const visit = (dir, prefix = '') => {
        if (!fs.existsSync(dir) || fs.lstatSync(dir).isSymbolicLink()) return;
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            if (entry.isSymbolicLink()) continue;
            const relative = `${prefix}${entry.name}`;
            if (entry.isDirectory()) {
                if (['records', 'stories', 'targets', 'rules', 'practices'].includes(entry.name) && !prefix) visit(path.join(dir, entry.name), `${entry.name}/`);
            } else if (entry.isFile() && ownedMaterialName(`work-slices/${relative}`)) {
                owned.add(`work-slices/${relative}`);
            }
        }
    };
    visit(sliceRoot);
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
        if (entry.isFile() && ownedMaterialName(entry.name)) owned.add(entry.name);
    }
    const result = [];
    for (const ref of [...owned, ...RETIRED_FILES]) {
        const target = path.resolve(root, ref);
        const relative = path.relative(root, target);
        if (!relative || relative.startsWith('..') || path.isAbsolute(relative)
            || (!ownedMaterialName(relative.replace(/\\/g, '/')) && !RETIRED_FILES.includes(relative))
            || expected.has(identity(target)) || !fs.existsSync(target)) continue;
        let parent = target;
        let linked = false;
        while (true) {
            if (fs.lstatSync(parent).isSymbolicLink()) { linked = true; break; }
            if (identity(parent) === identity(root)) break;
            parent = path.dirname(parent);
        }
        if (!linked && fs.lstatSync(target).isFile()) result.push({ path: target });
    }
    return result;
}

// One writer for all Coder resources. References preserve the original value,
// including an individual AC/string larger than the normal file budget.
class MaterialWriter {
    constructor(codeDir) { this.codeDir = path.resolve(codeDir); this.files = new Map(); }
    absolute(ref) { return path.join(this.codeDir, ref); }
    write(ref, value, budget = SLICE_BYTES) {
        if (value === undefined) value = null;
        if (bytes(value) <= budget) { this.files.set(ref, encode(value)); return this.absolute(ref); }
        const child = label => ref.replace(/\.json$/, `.${label}.json`);
        const valueType = Array.isArray(value) ? 'array' : typeof value === 'string' ? 'string' : 'object';
        let pieces;
        if (valueType === 'string') {
            pieces = []; let text = ''; let size = 3;
            for (const character of value) {
                const cost = Buffer.byteLength(JSON.stringify(character), 'utf8') - 2;
                if (size + cost > budget - 256 && text) { pieces.push(text); text = ''; size = 3; }
                text += character; size += cost;
            }
            if (text) pieces.push(text);
        } else {
            const entries = valueType === 'array' ? value.map((item, index) => [index, item]) : Object.entries(value);
            pieces = []; let part = valueType === 'array' ? [] : {};
            for (const [key, item] of entries) {
                const fitted = bytes(item) > budget / 2
                    ? { contentRef: this.write(child(`value-${safe(key)}`), item) } : item;
                const next = valueType === 'array' ? [...part, fitted] : { ...part, [key]: fitted };
                if (bytes(next) > budget && Object.keys(part).length) {
                    pieces.push(part); part = valueType === 'array' ? [fitted] : { [key]: fitted };
                } else part = next;
            }
            if (Object.keys(part).length) pieces.push(part);
        }
        const refs = pieces.map((part, index) => this.write(child(`part-${index + 1}`), part));
        // Reference lists are paged too; a large requirement never becomes a capacity gate.
        const pages = []; let refsPage = [];
        for (const refPath of refs) {
            if (bytes({ schemaVersion: 'work-slice/continuation/v1', valueType, contentRefs: [...refsPage, refPath] }) > budget - 1024 && refsPage.length) {
                pages.push(refsPage); refsPage = [];
            }
            refsPage.push(refPath);
        }
        if (refsPage.length) pages.push(refsPage);
        for (let index = pages.length - 1; index >= 0; index--) {
            const pageRef = index ? child(`refs-${index}`) : ref;
            this.files.set(pageRef, encode({ schemaVersion: 'work-slice/continuation/v1', valueType,
                contentRefs: pages[index], ...(index + 1 < pages.length ? { nextRef: this.absolute(child(`refs-${index + 1}`)) } : {}) }));
        }
        return this.absolute(ref);
    }
}

class CoderMaterialService {
    build({ codeDir, slices, fullDraft, requirementWorkPackage, targetIndex, readCatalog }) {
        const writer = new MaterialWriter(codeDir);
        const records = new Map();
        // dataAccessPlans is the canonical module-to-table projection.  Do not
        // infer ownership from physical table names or generated file names.
        const tablesByModule = new Map();
        const addTable = (moduleId, tableName) => {
            const id = String(moduleId || '').trim();
            const name = String(tableName || '').trim();
            if (!id || !name) return;
            if (!tablesByModule.has(id)) tablesByModule.set(id, new Set());
            tablesByModule.get(id).add(name);
        };
        for (const plan of array(requirementWorkPackage.dataAccessPlans)) {
            const table = plan && plan.table;
            addTable(plan && plan.moduleId, table && table.tableName || plan && plan.tableName);
            for (const source of array(plan && plan.sources)) addTable(plan.moduleId, source && source.tableName);
        }
        const record = (kind, value) => {
            const identity = digest(value);
            if (!records.has(identity)) records.set(identity, writer.write(`work-slices/records/${safe(kind)}-${identity}.json`, value));
            return records.get(identity);
        };
        const targetGroups = new Map();
        const navigationByPath = new Map();
        for (const candidate of [...array(requirementWorkPackage.candidateFiles), ...array(fullDraft.candidateFileCards)]) {
            const candidatePath = candidate.resolvedPath || candidate.path;
            if (!candidatePath) continue;
            const key = identity(candidatePath);
            const additions = navigationByPath.get(key) || {};
            for (const field of ['queryOnly', 'dataAccessPlanRef', 'businessObject', 'useWhen']) {
                if (candidate[field] !== undefined && candidate[field] !== '') additions[field] = candidate[field];
            }
            navigationByPath.set(key, additions);
        }
        for (const target of targetIndex) {
            const moduleId = target.moduleId || 'unassigned';
            if (!targetGroups.has(moduleId)) targetGroups.set(moduleId, []);
            targetGroups.get(moduleId).push({ ...navigationByPath.get(identity(target.resolvedPath)), ...target });
        }
        const targetDescriptors = [...targetGroups].map(([moduleId, targets]) => ({ moduleId,
            storyIds: unique(targets.flatMap(target => [...array(target.storyIds), ...array(target.storyBindings).map(binding => binding.storyId)])),
            ref: writer.write(`work-slices/targets/${safe(moduleId)}.json`, { targets }) }));
        // The index points to groups; the physical targets themselves occur only in their owner group.
        const targetIndexRef = writer.write('work-slices/target-index.json', { schemaVersion: 'work-slice/target-index/v1', groups: targetDescriptors });

        const facts = requirementWorkPackage.businessFacts || {};
        const factDescriptors = [];
        const factIndex = Object.fromEntries(Object.entries(facts).map(([kind, values]) => [kind,
            Array.isArray(values) ? values.map(value => {
                const ref = record(kind, value);
                factDescriptors.push({ kind, value, ref });
                return { contentRef: ref };
            }) : values]));
        writer.write('work-slices/business-facts.json', factIndex);
        for (const kind of ['dataAccessPlans', 'routeContracts']) {
            for (const value of array(requirementWorkPackage[kind])) {
                factDescriptors.push({ kind, value, ref: record(kind, value) });
            }
        }
        const fieldSource = slices['files-fields'] || {};
        writer.write('work-slices/files-fields.json', {
            schemaVersion: 'work-slice/files-fields/v2', purpose: '字段和文件资料目录；先使用当前 Story 的直接引用，不全文预读。',
            targetIndexRef,
            businessFactsRef: writer.absolute('work-slices/business-facts.json'),
            // A derived field view is unnecessary when the canonical tables exist; retain otherwise.
            ...(!array(facts.databaseTables).length && fieldSource.businessFieldCards
                ? { businessFieldCards: fieldSource.businessFieldCards } : {}),
            decisionBoundary: fieldSource.decisionBoundary, evidencePolicy: fieldSource.evidencePolicy,
            authorizedWriteRoots: requirementWorkPackage.authorizedWriteRoots
        });
        const objectFacts = array(facts.businessObjects);
        const knownObjects = new Set(objectFacts.map(value => value.objectKey).filter(Boolean));
        const relatedKeys = value => unique([value.objectKey, value.targetEntityKey, value.carriedByEntityKey,
            value.parentObjectKey, value.childObjectKey, value.primaryObjectKey, value.formObjectKey,
            value.sourceObjectKey, value.targetObjectKey,
            ...array(value.pageComposition?.blocks).map(block => block.objectKey),
            ...array(value.constructionBindings).map(binding => binding.targetEntityKey)]);
        const storyIdsFor = value => unique([value.storyId, value.sourceStoryId,
            ...array(value.storyIds), ...array(value.relatedStoryIds),
            ...array(value.constructionBindings).map(binding => binding.storyId)]);
        const globalFactRefs = factDescriptors.filter(({ value }) => !value.storyId && !value.sourceStoryId
            && !array(value.storyIds).length && !value.moduleId && !relatedKeys(value).some(key => knownObjects.has(key))
            && !(value.tableName && [...tablesByModule.values()].some(names => names.has(value.tableName))))
            .map(item => item.ref);
        const sourceCards = array(fullDraft.storyCards);
        const storyOrder = array(fullDraft.storyOrder).length ? fullDraft.storyOrder : array(requirementWorkPackage.userStories);
        const orderedIds = unique([...storyOrder.map(item => item.storyId), ...sourceCards.map(item => item.storyId)]);
        const summaries = orderedIds.map(storyId => {
            const source = sourceCards.find(item => item.storyId === storyId) || storyOrder.find(item => item.storyId === storyId) || {};
            const storyTargets = targetIndex.filter(target => array(target.storyIds).includes(storyId)
                || array(target.storyBindings).some(binding => binding.storyId === storyId));
            const bindings = storyTargets.flatMap(target => array(target.storyBindings).filter(binding => binding.storyId === storyId));
            const moduleIds = new Set(unique([...storyTargets.map(target => target.moduleId),
                ...bindings.flatMap(binding => [binding.moduleId, binding.carriedByModuleId])]));
            const objectKeys = new Set(unique([...storyTargets.map(target => target.objectKey), ...bindings.flatMap(relatedKeys)]));
            // Follow only explicit object/page/relation references, never a table-name heuristic.
            for (const value of objectFacts) {
                if (value.storyId === storyId || array(value.storyIds).includes(storyId) || objectKeys.has(value.objectKey)) {
                    relatedKeys(value).forEach(key => objectKeys.add(key));
                }
            }
            const directObjectKeys = new Set(objectKeys);
            for (const { kind, value } of factDescriptors) {
                if (kind.toLowerCase().includes('relation') && relatedKeys(value).some(key => directObjectKeys.has(key))) {
                    relatedKeys(value).forEach(key => objectKeys.add(key));
                }
            }
            const tableNames = new Set([...moduleIds].flatMap(moduleId =>
                [...(tablesByModule.get(moduleId) || [])]));
            const associated = factDescriptors.filter(({ value }) => value.storyId === storyId
                || value.sourceStoryId === storyId || array(value.storyIds).includes(storyId)
                || moduleIds.has(value.moduleId) || relatedKeys(value).some(key => objectKeys.has(key))
                || (value.tableName && tableNames.has(value.tableName)));
            // Physical sharing does not make the carrier's other Story contracts mandatory.
            const logicalModules = new Set(bindings.map(binding => binding.moduleId));
            if (!logicalModules.size) storyTargets.forEach(target => logicalModules.add(target.moduleId));
            const owns = value => storyIdsFor(value).includes(storyId)
                || (!storyIdsFor(value).length && logicalModules.has(value.moduleId));
            const requiredKeys = new Set(bindings.flatMap(relatedKeys));
            if (!bindings.length) storyTargets.forEach(target => requiredKeys.add(target.objectKey));
            const requiredRelations = new Set();
            const addDependencies = value => {
                relatedKeys(value).forEach(key => requiredKeys.add(key));
                array(value.sources).forEach(source => { if (source.objectKey) requiredKeys.add(source.objectKey); });
                array(value.relationPath).forEach(key => requiredRelations.add(key));
                for (const child of [...array(value.blocks), ...array(value.pageComposition?.blocks), ...array(value.queryFilters)]) {
                    addDependencies(child);
                }
            };
            factDescriptors.filter(({ value }) => owns(value)).forEach(({ value }) => addDependencies(value));
            const logicalTables = new Set([...logicalModules].flatMap(moduleId => [...(tablesByModule.get(moduleId) || [])]));
            factDescriptors.filter(({ value }) => requiredRelations.has(value.relationId || value.relationKey))
                .forEach(({ value }) => addDependencies(value));
            const businessFactRefs = unique(factDescriptors.filter(({ kind, value }) => owns(value)
                || (['businessObjects', 'databaseTables'].includes(kind) && requiredKeys.has(value.objectKey))
                || (kind === 'databaseTables' && logicalTables.has(value.tableName))
                || requiredRelations.has(value.relationId || value.relationKey)).map(item => item.ref));
            const relatedFactRefs = unique(associated.map(item => item.ref))
                .filter(ref => !businessFactRefs.includes(ref) && !globalFactRefs.includes(ref));
            const acceptanceItems = array(source.acceptanceItems).map(item => {
                const result = { ...item }; if (result.userStory === source.userStory) delete result.userStory;
                return result;
            });
            const fileKinds = unique(storyTargets.map(target => target.fileKind));
            const menuIds = unique([...(readCatalog.commonRefs || []),
                ...fileKinds.flatMap(kind => readCatalog.byFileKind[kind] || [])]);
            const formalStory = { ...(array(requirementWorkPackage.userStories).find(item => item.storyId === storyId) || {}) };
            delete formalStory.acceptanceCriteria;
            const detail = { ...formalStory, ...source, acceptanceItems,
                targetRefs: targetDescriptors.filter(item => item.storyIds.includes(storyId)).map(item => item.ref),
                businessFactRefs,
                relatedFactRefs,
                globalFactRefs: globalFactRefs.filter(ref => !businessFactRefs.includes(ref)),
                ruleMenuRefs: menuIds.filter(id => id.startsWith('rules.')).map(id => readCatalog.resources[id]),
                practiceMenuRefs: menuIds.filter(id => id.startsWith('practices.')).map(id => readCatalog.resources[id]),
                resourceRefs: (readCatalog.byStoryId[storyId] || []).filter(id => !['files-fields', 'business-facts'].includes(id))
                    .map(id => readCatalog.resources[id]).filter(Boolean) };
            // Replace old whole-demand pointers with direct task references.
            delete detail.candidateFileGuideRef; delete detail.businessFactsRef;
            delete detail.candidateFileGuideRefs;
            delete detail.ruleGuideRef; delete detail.practiceGuideRef;
            const detailRef = writer.write(`work-slices/stories/${safe(storyId)}.json`, detail);
            readCatalog.resources[`story.${storyId}`] = detailRef;
            readCatalog.byStoryId[storyId] = [`story.${storyId}`, ...(readCatalog.byStoryId[storyId] || [])
                .filter(id => !['files-fields', 'business-facts'].includes(id))];
            return { storyId, userStory: source.userStory, sequence: source.sequence,
                acceptanceItems: acceptanceItems.map(({ code, group, scenario }) => ({ code, group, scenario })), detailRef };
        });
        writer.write('work-slices/stories.json', { schemaVersion: 'work-slice/stories/v2',
            purpose: '全部功能范围和 AC 索引；当前任务完整正文由 detailRef 读取。', stories: summaries,
            acceptanceLedgerRef: requirementWorkPackage.acceptanceLedgerRef });
        for (const [id, value] of Object.entries(slices)) {
            if (['stories', 'files-fields'].includes(id)) continue;
            const resourcePath = readCatalog.resources[id];
            let published = value;
            const cardKey = id.startsWith('rules.') ? 'ruleMenuCards' : id.startsWith('practices.') ? 'practiceCards' : '';
            if (cardKey) {
                const menuFields = ['ruleAlias', 'practiceId', 'id', 'label', 'source', 'appliesToFileKinds',
                    'fileKinds', 'useWhen', 'doNotUseWhen', 'askYourself', 'whenNeeded', 'menuOnly', 'required', 'selectionMode', 'triggerTerms'];
                published = { ...value, [cardKey]: array(value[cardKey]).map(card => ({
                    ...Object.fromEntries(menuFields.filter(key => card[key] !== undefined).map(key => [key, card[key]])),
                    contentRef: record(cardKey === 'ruleMenuCards' ? 'rule' : 'practice', card)
                })) };
            }
            if (resourcePath) writer.write(path.relative(codeDir, resourcePath), published);
        }
        readCatalog.resources['business-facts'] = writer.absolute('work-slices/business-facts.json');
        const readCatalogRef = writer.write('work-slices/read-catalog.json', readCatalog);
        return { writer, targetIndexRef, readCatalogRef, storyCatalogRef: writer.absolute('work-slices/stories.json'), summaries };
    }
}

module.exports = { CoderMaterialService, MaterialWriter, SLICE_BYTES, ENTRY_BYTES, readMaterialIndex, obsoleteMaterialFiles };
