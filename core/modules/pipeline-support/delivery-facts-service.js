const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const FACTS_SCHEMA_VERSION = 'delivery-facts/v4';
const MAX_FACTS_BYTES = 64 * 1024;

class DeliveryFactsService {
    constructor(options = {}) {
        this.fs = options.fsImpl || fs;
        this.path = options.pathImpl || path;
        this.maxBytes = Number(options.maxBytes || MAX_FACTS_BYTES);
        this.now = typeof options.now === 'function' ? options.now : () => new Date().toISOString();
    }

    buildOrReuse(options = {}) {
        const factsPath = this._resolve(options.deliveryFactsPath || this.path.join(
            String(options.demandDir || '').trim(),
            'delivery',
            '.runtime',
            'delivery-facts.json'
        ));
        if (!factsPath) return { ok: false, errorCode: 'DELIVERY_FACTS_PATH_MISSING' };

        const sourceRefs = this._sourceRefs(options);
        const sourceFingerprints = this._fingerprintRefs(sourceRefs);
        const sourceHash = this._hashJson(sourceFingerprints);
        const existing = this._readJson(factsPath);
        if (existing && existing.schemaVersion === FACTS_SCHEMA_VERSION
            && existing.sourceHash === sourceHash && this._partsAvailable(existing, factsPath)) {
            return {
                ok: true,
                reused: true,
                path: factsPath,
                facts: existing,
                sourceHash
            };
        }

        const facts = this._buildFacts({ ...options, sourceFingerprints, sourceHash });
        const pretty = `${JSON.stringify(facts, null, 2)}\n`;
        const serialized = Buffer.byteLength(pretty, 'utf8') <= this.maxBytes
            ? pretty
            : `${JSON.stringify(facts)}\n`;
        let output = { facts, serialized, parts: [] };
        if (Buffer.byteLength(serialized, 'utf8') > this.maxBytes) {
            output = this._splitFacts(facts, factsPath);
            if (!output.ok) return { ...output, path: factsPath, maxBytes: this.maxBytes };
        }
        const byteLength = Buffer.byteLength(output.serialized, 'utf8');
        if (byteLength > this.maxBytes) {
            return {
                ok: false,
                errorCode: 'DELIVERY_FACTS_TOO_LARGE',
                message: `delivery facts 超过 ${this.maxBytes} 字节预算：${byteLength}`,
                path: factsPath,
                byteLength,
                maxBytes: this.maxBytes
            };
        }

        try {
            for (const part of output.parts) this._writeJsonAtomic(part.path, part.serialized);
            this._writeJsonAtomic(factsPath, output.serialized);
        } catch (error) {
            return {
                ok: false,
                errorCode: 'DELIVERY_FACTS_WRITE_FAILED',
                message: `delivery facts 原子写入失败：${error.message}`,
                path: factsPath
            };
        }
        return {
            ok: true,
            reused: false,
            path: factsPath,
            facts: output.facts,
            sourceHash,
            byteLength
        };
    }

    _splitFacts(facts, factsPath) {
        const manifest = { ...facts, partRefs: [], sectionCounts: {} };
        const parts = [];
        for (const [section, items] of Object.entries(facts)) {
            if (!Array.isArray(items) || items.length === 0) continue;
            manifest[section] = [];
            manifest.sectionCounts[section] = items.length;
            let batch = [];
            const fits = values => Buffer.byteLength(`${JSON.stringify({
                schemaVersion: 'delivery-facts-part/v1', sourceHash: facts.sourceHash,
                section, index: manifest.partRefs.filter(ref => ref.section === section).length,
                items: values
            })}\n`, 'utf8') <= this.maxBytes;
            const append = () => {
                if (batch.length === 0) return;
                const index = manifest.partRefs.filter(ref => ref.section === section).length;
                const payload = { schemaVersion: 'delivery-facts-part/v1', sourceHash: facts.sourceHash,
                    section, index, items: batch };
                const serialized = `${JSON.stringify(payload)}\n`;
                const sha256 = this._hashText(serialized);
                const fileName = `delivery-facts-${section}-${sha256.slice(7, 23)}-${index}.json`;
                const partPath = this.path.join(this.path.dirname(factsPath), fileName);
                manifest.partRefs.push({ section, index, path: partPath, sha256, itemCount: batch.length });
                parts.push({ path: partPath, serialized });
                batch = [];
            };
            for (const item of items) {
                if (!fits([...batch, item]) && batch.length > 0) {
                    append();
                }
                if (!fits([...batch, item])) {
                    return { ok: false, errorCode: 'DELIVERY_FACTS_ITEM_TOO_LARGE',
                        message: `delivery facts 的 ${section} 单条事实超过 ${this.maxBytes} 字节预算` };
                }
                batch.push(item);
            }
            append();
        }
        const serialized = `${JSON.stringify(manifest)}\n`;
        return { ok: true, facts: manifest, serialized, parts };
    }

    _partsAvailable(facts, factsPath) {
        if (facts.partRefs === undefined) return true;
        if (!Array.isArray(facts.partRefs) || !facts.sectionCounts
            || typeof facts.sectionCounts !== 'object') return false;
        const counts = {};
        for (const ref of facts.partRefs) {
            if (!ref || typeof ref !== 'object' || !Number.isInteger(ref.itemCount) || ref.itemCount < 1
                || !Number.isInteger(ref.index) || ref.index < 0 || !Array.isArray(facts[ref.section])) return false;
            counts[ref.section] = (counts[ref.section] || 0) + ref.itemCount;
        }
        if (Object.entries(facts.sectionCounts).some(([section, count]) => counts[section] !== count)
            || Object.keys(counts).some(section => facts.sectionCounts[section] !== counts[section])) return false;
        return facts.partRefs.every(ref => ref && typeof ref === 'object'
            && this.path.dirname(this._resolve(ref.path)) === this.path.dirname(factsPath)
            && this.path.basename(ref.path) === `delivery-facts-${ref.section}-${String(ref.sha256).slice(7, 23)}-${ref.index}.json`
            && this._isFile(ref.path)
            && this._hashFile(ref.path) === ref.sha256);
    }

    _buildFacts(options = {}) {
        const design = options.design && typeof options.design === 'object' ? options.design : {};
        const stories = this._readJson(options.requirementStoriesPath);
        const businessFacts = this._readJson(options.businessFactsPath);
        const codeState = this._readJson(options.codeStatePath);
        const documentStage = String(options.documentStage || 'coder').trim().toLowerCase();
        const sqlPaths = this._uniquePaths(options.sqlPaths);
        const workflowPaths = this._uniquePaths(options.workflowPaths);
        const workflowArtifacts = this._projectWorkflowArtifacts(options.workflowArtifacts, workflowPaths);
        const workflowExternalMethodChanges = this._projectWorkflowExternalMethodChanges(codeState);
        const workflowEvents = this._projectWorkflowEvents({
            design,
            workflowArtifacts,
            workflowExternalMethodChanges
        });
        const workflowExternalMethods = this._projectWorkflowExternalMethods({
            workflowArtifacts,
            workflowEvents,
            workflowExternalMethodChanges
        });

        return {
            schemaVersion: FACTS_SCHEMA_VERSION,
            generatedAt: this.now(),
            documentStage,
            demandName: String(options.demandName || '').trim(),
            sourceHash: options.sourceHash,
            stories: this._projectStories(stories, design),
            pages: this._projectPages(design),
            tables: this._projectTables(design),
            codeItems: this._projectCodeItems(design),
            systemParameters: this._projectNamedCollections(
                [design, businessFacts, codeState],
                ['systemParameters', 'systemParams', 'systemParameter']
            ),
            configFiles: this._projectConfigFiles({ design, businessFacts, codeState, options }),
            sqlArtifacts: sqlPaths.map(filePath => ({
                path: filePath,
                status: '已生成、未执行'
            })),
            workflowArtifacts,
            workflowEvents: workflowEvents.map(({ parameters, ...event }) => event),
            workflowExternalMethods,
            workflowExternalMethodChanges,
            restContracts: this._projectRestContracts(design),
            moduleRoles: this._projectNamedCollections(
                [design, businessFacts, codeState],
                ['moduleRoles', 'moduleRoleConfigurations', 'moduleRoleConfig']
            ),
            provenance: options.sourceFingerprints || []
        };
    }

    _projectWorkflowArtifacts(values = [], fallbackPaths = []) {
        const artifacts = [];
        (Array.isArray(values) ? values : []).forEach(value => {
            if (!value || typeof value !== 'object') return;
            const filePath = this._resolve(value.path);
            if (!filePath) return;
            const item = {
                path: filePath,
                status: String(value.status || '已生成、未导入').trim()
            };
            ['storyId', 'processName', 'relatedFeature', 'initiator', 'bizModule', 'kind', 'artifactKind']
                .forEach(key => {
                    if (value[key] !== undefined && value[key] !== null && value[key] !== '') {
                        item[key] = String(value[key]).trim();
                    }
                });
            ['activities', 'transitions'].forEach(key => {
                if (Array.isArray(value[key]) && value[key].length > 0) item[key] = this._clone(value[key]);
            });
            ['serviceInternalTypeName', 'serviceInternalSourcePath'].forEach(key => {
                if (value[key] !== undefined && value[key] !== null && value[key] !== '') {
                    item[key] = String(value[key]).trim();
                }
            });
            ['workflowExternalMethodSeeds', 'operationEvents'].forEach(key => {
                if (Array.isArray(value[key]) && value[key].length > 0) item[key] = this._clone(value[key]);
            });
            artifacts.push(item);
        });
        (Array.isArray(fallbackPaths) ? fallbackPaths : []).forEach(filePath => {
            const resolved = this._resolve(filePath);
            if (resolved && !artifacts.some(item => this._resolve(item.path) === resolved)) {
                artifacts.push({ path: resolved, status: '已生成、未导入' });
            }
        });
        return this._uniqueObjects(artifacts);
    }

    _workflowContracts(root = {}) {
        const contracts = [];
        const seen = new Set();
        this._walk(root, value => {
            const candidates = [];
            if (value && value.workflowContract && typeof value.workflowContract === 'object'
                && !Array.isArray(value.workflowContract)) {
                candidates.push({ contract: value.workflowContract, owner: value });
            }
            if (value && Array.isArray(value.workflowContracts)) {
                value.workflowContracts.forEach(contract => candidates.push({ contract, owner: value }));
            }
            if (value && Array.isArray(value.operationEvents) && (value.processName || value.activities)) {
                candidates.push({ contract: value, owner: value });
            }
            candidates.forEach(({ contract, owner }) => {
                if (!contract || typeof contract !== 'object' || Array.isArray(contract) || seen.has(contract)) return;
                seen.add(contract);
                contracts.push({ contract, owner });
            });
        });
        return contracts;
    }

    _workflowOperation(contract = {}, operationKey = '') {
        const activities = Array.isArray(contract.activities) ? contract.activities : [];
        for (const activity of activities) {
            if (!activity || typeof activity !== 'object') continue;
            const operations = Array.isArray(activity.operations) ? activity.operations : [];
            for (const operation of operations) {
                const operationObject = operation && typeof operation === 'object'
                    ? operation
                    : { name: String(operation || '').trim() };
                const key = String(operationObject.key || operationObject.operationKey || '').trim();
                if (key !== operationKey) continue;
                return {
                    activityKey: String(activity.key || activity.activityKey || '').trim(),
                    activityName: String(activity.name || activity.activityName || '').trim(),
                    name: String(operationObject.name || operationObject.operationName || '').trim()
                };
            }
        }
        return {};
    }

    _projectWorkflowParameters(parameters = []) {
        return (Array.isArray(parameters) ? parameters : [])
            .filter(parameter => parameter && typeof parameter === 'object' && !Array.isArray(parameter))
            .map((parameter, index) => {
                const source = String(parameter.source || parameter.valueSource || '').trim();
                const rawValue = String(parameter.value || parameter.valueExpression || '').trim();
                const value = source === '$PVI_GUID'
                    ? '[#=ProcessVersionInstance_ProcessVersionInstanceGuid#]'
                    : rawValue;
                const type = String(parameter.type || parameter.javaType || parameter.parameterType || 'String').trim() || 'String';
                const order = this._numberOrDefault(parameter.order || parameter.orderNum, index + 1);
                return {
                    name: String(parameter.name || parameter.parameterName || '').trim(),
                    type,
                    source,
                    sourceLabel: this._workflowParameterSourceLabel(source),
                    value,
                    description: String(parameter.description || parameter.parameterDescription || '').trim(),
                    order
                };
            })
            .filter(parameter => parameter.name);
    }

    _mergeWorkflowParameters(existing = [], incoming = []) {
        const merged = new Map();
        const add = parameter => {
            if (!parameter || typeof parameter !== 'object') return;
            const name = String(parameter.name || '').trim();
            if (!name) return;
            const current = merged.get(name) || {};
            const next = { ...current };
            ['type', 'source', 'sourceLabel', 'value', 'description', 'order'].forEach(key => {
                if (parameter[key] !== undefined && parameter[key] !== null && parameter[key] !== '') next[key] = parameter[key];
            });
            next.name = name;
            merged.set(name, next);
        };
        (Array.isArray(existing) ? existing : []).forEach(add);
        (Array.isArray(incoming) ? incoming : []).forEach(add);
        return Array.from(merged.values()).sort((left, right) => Number(left.order || 0) - Number(right.order || 0));
    }

    _workflowParameterSourceLabel(source = '') {
        if (source === '$PVI_GUID') return '流程实例上下文';
        if (source === 'constant') return '固定值';
        return String(source || '').trim();
    }

    _numberOrDefault(value, fallback = 0) {
        const number = Number(value);
        return Number.isFinite(number) ? number : fallback;
    }

    _projectWorkflowEvents({ design = {}, workflowArtifacts = [], workflowExternalMethodChanges = [] } = {}) {
        const events = [];
        const add = ({ event = {}, contract = {}, artifact = {}, fallbackStoryId = '' } = {}) => {
            if (!event || typeof event !== 'object' || Array.isArray(event)) return;
            const mode = String(event.mode || event.eventMode || '').trim().toLowerCase();
            const methodName = String(event.methodName || event.handlerMethod || '').trim();
            if (mode !== 'service_method' && !methodName) return;
            if (!methodName) return;

            const operationKey = String(event.operationKey || event.operationId || '').trim();
            const operation = this._workflowOperation(contract, operationKey);
            const storyId = String(
                event.storyId || contract.storyId || contract.sourceStoryId || artifact.storyId || fallbackStoryId || ''
            ).trim().toUpperCase();
            const operationName = String(
                event.operationName || event.operation || operation.name || ''
            ).trim();
            const activityName = String(
                event.activityName || operation.activityName || ''
            ).trim();
            const item = {
                storyId,
                operationKey,
                activityKey: String(event.activityKey || operation.activityKey || '').trim(),
                activityName,
                eventName: String(event.eventName || event.name || operationName || methodName).trim(),
                eventSource: String(event.eventSource || event.sourceType || '操作').trim(),
                eventType: String(event.eventType || '操作后').trim(),
                eventTypeCode: String(event.eventTypeCode || event.typeCode || '55').trim(),
                operationName,
                methodName,
                className: String(
                    event.className || event.typeName || contract.serviceInternalTypeName
                        || artifact.serviceInternalTypeName || ''
                ).trim(),
                returnType: String(event.returnType || event.returnValueType || 'String').trim(),
                methodRemark: String(event.methodRemark || event.remark || event.note || event.businessEffect || '').trim(),
                businessEffect: String(event.businessEffect || event.note || '').trim(),
                methodOrder: this._numberOrDefault(event.methodOrder || event.orderNum, 0),
                registration: String(event.registration || '@OutJarMethod').trim(),
                sourcePath: String(event.sourcePath || artifact.serviceInternalSourcePath || '').trim(),
                parameters: this._projectWorkflowParameters(event.parameters)
            };
            events.push(item);
        };

        this._workflowContracts(design).forEach(({ contract, owner }) => {
            const fallbackStoryId = String(owner && (owner.storyId || owner.sourceStoryId) || '').trim();
            const operationEvents = Array.isArray(contract.operationEvents) ? contract.operationEvents : [];
            const beforeCount = events.length;
            operationEvents.forEach(event => add({ event, contract, fallbackStoryId }));
            if (events.length === beforeCount) {
                (Array.isArray(contract.workflowExternalMethodSeeds) ? contract.workflowExternalMethodSeeds : [])
                    .forEach(event => add({ event, contract, fallbackStoryId }));
            }
        });
        (Array.isArray(workflowArtifacts) ? workflowArtifacts : []).forEach(artifact => {
            const operationEvents = Array.isArray(artifact.operationEvents) ? artifact.operationEvents : [];
            const seeds = Array.isArray(artifact.workflowExternalMethodSeeds)
                ? artifact.workflowExternalMethodSeeds
                : [];
            const beforeCount = events.length;
            operationEvents.forEach(event => add({ event, contract: artifact, artifact }));
            if (events.length === beforeCount) seeds.forEach(event => add({ event, contract: artifact, artifact }));
        });
        (Array.isArray(workflowExternalMethodChanges) ? workflowExternalMethodChanges : [])
            .forEach(event => add({ event }));

        const seen = new Set();
        return events.filter(item => {
            const key = `${item.storyId}::${item.operationKey}::${item.methodName}`.toLowerCase();
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
        });
    }

    _projectWorkflowExternalMethods({
        workflowArtifacts = [],
        workflowEvents = [],
        workflowExternalMethodChanges = []
    } = {}) {
        const methods = new Map();
        const keyOf = item => `${String(item.storyId || '').trim().toUpperCase()}::${String(item.operationKey || '').trim()}::${String(item.methodName || '').trim()}`.toLowerCase();
        const merge = (existing, item) => {
            const out = { ...existing };
            [
                'storyId', 'operationKey', 'activityKey', 'activityName', 'eventName', 'eventSource', 'eventType',
                'eventTypeCode', 'operationName', 'methodName', 'className', 'returnType', 'methodRemark',
                'businessEffect', 'methodOrder', 'registration', 'sourcePath', 'changeType', 'status', 'dataSource'
            ].forEach(key => {
                if (item[key] !== undefined && item[key] !== null && item[key] !== '') out[key] = item[key];
            });
            out.parameters = this._mergeWorkflowParameters(existing.parameters, item.parameters);
            return out;
        };
        const add = item => {
            if (!item || typeof item !== 'object') return;
            const methodName = String(item.methodName || '').trim();
            if (!methodName) return;
            const normalized = {
                ...item,
                storyId: String(item.storyId || '').trim().toUpperCase(),
                operationKey: String(item.operationKey || '').trim(),
                methodName,
                returnType: String(item.returnType || 'String').trim() || 'String',
                methodRemark: String(item.methodRemark || item.businessEffect || '').trim(),
                registration: String(item.registration || '@OutJarMethod').trim(),
                methodOrder: this._numberOrDefault(item.methodOrder, 0),
                parameters: this._projectWorkflowParameters(item.parameters)
            };
            const key = keyOf(normalized);
            methods.set(key, methods.has(key) ? merge(methods.get(key), normalized) : normalized);
        };

        (Array.isArray(workflowEvents) ? workflowEvents : []).forEach(event => add({
            ...event,
            changeType: 'planned',
            status: '设计阶段预置',
            dataSource: 'design'
        }));
        (Array.isArray(workflowExternalMethodChanges) ? workflowExternalMethodChanges : []).forEach(item => add({
            ...item,
            status: '实际实现',
            dataSource: 'code-state'
        }));

        // 兼容仅有 generated-workflow receipt、但 design JSON 未带完整 contract 的阶段。
        (Array.isArray(workflowArtifacts) ? workflowArtifacts : []).forEach(artifact => {
            const seeds = Array.isArray(artifact.workflowExternalMethodSeeds)
                ? artifact.workflowExternalMethodSeeds
                : [];
            seeds.forEach(seed => add({
                ...seed,
                storyId: seed.storyId || artifact.storyId,
                className: seed.className || seed.typeName || artifact.serviceInternalTypeName,
                sourcePath: seed.sourcePath || artifact.serviceInternalSourcePath,
                changeType: 'planned',
                status: '设计阶段预置',
                dataSource: 'workflow-artifact'
            }));
        });

        return Array.from(methods.values()).map(item => ({
            ...item,
            parameters: this._mergeWorkflowParameters([], item.parameters)
        }));
    }

    _projectWorkflowExternalMethodChanges(codeState = {}) {
        const changes = [];
        const stories = codeState && codeState.stories && typeof codeState.stories === 'object'
            ? codeState.stories
            : {};
        Object.entries(stories).forEach(([fallbackStoryId, story]) => {
            const storyId = String(story && story.storyId || fallbackStoryId || '').trim().toUpperCase();
            const rows = Array.isArray(story && story.workflowExternalMethodChanges)
                ? story.workflowExternalMethodChanges
                : [];
            rows.forEach(item => {
                if (!item || typeof item !== 'object') return;
                const normalized = {};
                [
                    'changeType', 'storyId', 'operationKey', 'className', 'methodName', 'businessEffect', 'sourcePath',
                    'returnType', 'methodRemark'
                ]
                    .forEach(key => {
                        if (item[key] !== undefined && item[key] !== null && item[key] !== '') normalized[key] = String(item[key]).trim();
                    });
                normalized.storyId = normalized.storyId || storyId;
                if (Array.isArray(item.parameters) && item.parameters.length > 0) {
                    normalized.parameters = item.parameters
                        .filter(parameter => parameter && typeof parameter === 'object')
                        .map(parameter => ({
                            name: String(parameter.name || '').trim(),
                            description: String(parameter.description || '').trim()
                        }))
                        .filter(parameter => parameter.name);
                }
                if (normalized.changeType && normalized.className && normalized.methodName) changes.push(normalized);
            });
        });
        const seen = new Set();
        return changes.filter(item => {
            const key = `${item.storyId}::${item.className}::${item.methodName}::${JSON.stringify(item.parameters || [])}`;
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
        });
    }

    _projectStories(stories = null, design = {}) {
        if (!stories || typeof stories !== 'object') return [];
        const configurationBindings = (Array.isArray(design.businessEntities) ? design.businessEntities : [])
            .flatMap(entity => Array.isArray(entity.constructionBindings) ? entity.constructionBindings : [])
            .filter(binding => binding.bindingKind === 'configuration_only');
        const project = (story = {}, fallbackId = '') => {
            if (!story || typeof story !== 'object') return null;
            const storyId = String(story.storyId || fallbackId || '').trim().toUpperCase();
            const title = String(story.title || story.userStory || story.description || '').trim();
            if (!storyId && !title) return null;
            const bindings = configurationBindings.filter(binding => binding.storyId === storyId);
            return {
                ...(storyId ? { storyId } : {}),
                ...(title ? { title } : {}),
                ...(bindings.length ? {
                    constructionBindings: this._clone(bindings),
                    acceptanceCriteria: this._clone(story.acceptanceCriteria || {}),
                    invariants: this._clone(story.invariants || []),
                    codingFactHandoff: this._clone(story.codingFactHandoff || [])
                } : {})
            };
        };
        if (Array.isArray(stories.stories)) {
            return stories.stories.map(story => project(story)).filter(Boolean);
        }
        if (stories.stories && typeof stories.stories === 'object') {
            return Object.entries(stories.stories)
                .map(([storyId, story]) => project(story, storyId))
                .filter(Boolean);
        }
        return [];
    }

    _projectPages(root = {}) {
        const pages = [];
        this._walk(root, value => {
            const fileKind = String(value && (value.fileKind || value.kind || '') || '').trim().toLowerCase();
            if (fileKind !== 'htmlpage') return;
            const rawPath = String(value.resolvedPath || value.path || value.fileName || '').trim();
            const route = this._pageRoute(rawPath);
            const item = {
                name: String(value.fileName || value.pageName || value.name || '').trim()
            };
            if (route) item.route = route;
            if (rawPath) item.sourcePath = rawPath;
            if (item.name || item.route) pages.push(item);
        });
        return this._uniqueObjects(pages);
    }

    _projectTables(root = {}) {
        const tables = [];
        const candidates = root && root.databaseDesign && Array.isArray(root.databaseDesign.tables)
            ? root.databaseDesign.tables
            : [];
        candidates.forEach(table => {
            if (!table || typeof table !== 'object') return;
            const columns = Array.isArray(table.businessColumns || table.columns || table.fields)
                ? (table.businessColumns || table.columns || table.fields)
                : [];
            tables.push({
                tableName: String(table.tableName || '').trim(),
                tableComment: String(table.tableComment || table.comment || '').trim(),
                columns: columns.map(column => this._projectColumn(column)).filter(Boolean)
            });
        });
        if (tables.length === 0) {
            this._walk(root, value => {
                const linked = value && value.linkedTable;
                if (!linked || typeof linked !== 'object' || !linked.tableName) return;
                const columns = Array.isArray(linked.businessColumns || linked.columns || linked.fields)
                    ? (linked.businessColumns || linked.columns || linked.fields)
                    : [];
                tables.push({
                    tableName: String(linked.tableName || '').trim(),
                    tableComment: String(linked.tableComment || '').trim(),
                    columns: columns.map(column => this._projectColumn(column)).filter(Boolean)
                });
            });
        }
        return this._uniqueObjects(tables.filter(item => item.tableName));
    }

    _projectColumn(column = {}) {
        if (!column || typeof column !== 'object') return null;
        const out = {};
        ['name', 'columnName', 'comment', 'description', 'type', 'length', 'required', 'codeItem', 'attachmentKey']
            .forEach(key => {
                if (column[key] !== undefined && column[key] !== null && column[key] !== '') out[key] = this._clone(column[key]);
            });
        if (column.codeItemDefinition && typeof column.codeItemDefinition === 'object') {
            const definition = column.codeItemDefinition;
            out.codeItemDefinition = {};
            ['mode', 'sourceRef', 'identifier', 'levelValue', 'level', 'codes', 'values', 'items', 'options']
                .forEach(key => {
                    if (definition[key] !== undefined && definition[key] !== null && definition[key] !== '') {
                        out.codeItemDefinition[key] = this._clone(definition[key]);
                    }
                });
        }
        return Object.keys(out).length > 0 ? out : null;
    }

    _projectCodeItems(root = {}) {
        const items = [];
        this._walk(root, value => {
            if (!value || !value.codeItem) return;
            const definition = value.codeItemDefinition && typeof value.codeItemDefinition === 'object'
                ? value.codeItemDefinition
                : {};
            const item = {
                name: String(value.codeItem || '').trim()
            };
            ['mode', 'identifier', 'sourceRef', 'levelValue', 'level', 'codes', 'values', 'items', 'options']
                .forEach(key => {
                    if (definition[key] !== undefined && definition[key] !== null && definition[key] !== '') {
                        item[key] = this._clone(definition[key]);
                    }
                });
            items.push(item);
        });
        return this._uniqueObjects(items.filter(item => item.name));
    }

    _projectRestContracts(root = {}) {
        const contracts = [];
        this._walk(root, value => {
            const contract = value && value.restContract;
            if (!contract || typeof contract !== 'object') return;
            contracts.push({
                entityKey: String(value.entityKey || value.businessObjectKey || '').trim(),
                basePath: String(contract.basePath || '').trim(),
                operations: Array.isArray(contract.operations)
                    ? contract.operations.map(operation => ({
                        operationKey: String(operation && (operation.operationKey || operation.methodName) || '').trim(),
                        methodName: String(operation && operation.methodName || '').trim(),
                        path: String(operation && operation.path || '').trim(),
                        httpMethod: String(operation && operation.httpMethod || '').trim(),
                        purpose: String(operation && operation.purpose || '').trim(),
                        requestShape: String(operation && operation.requestShape || '').trim(),
                        responseShape: String(operation && operation.responseShape || '').trim()
                    }))
                    : []
            });
        });
        return this._uniqueObjects(contracts);
    }

    _projectConfigFiles({ design = {}, businessFacts = {}, codeState = {}, options = {} } = {}) {
        const out = [];
        const add = value => {
            if (!value || typeof value !== 'object') return;
            const filePath = String(value.path || value.resolvedPath || value.targetFile || '').trim();
            const fileKind = String(value.fileKind || value.kind || '').trim().toLowerCase();
            const looksLikeConfig = fileKind.includes('config') || fileKind.includes('systemparam')
                || value.configuration === true || value.configFile === true;
            if (!looksLikeConfig) return;
            const item = {};
            if (value.name || value.fileName) item.name = String(value.name || value.fileName).trim();
            if (filePath) item.path = filePath;
            if (value.parameterName || value.paramName || value.key) item.parameterName = String(value.parameterName || value.paramName || value.key).trim();
            if (value.valueDescription || value.description || value.value !== undefined) {
                item.valueDescription = String(value.valueDescription || value.description || value.value || '').trim();
            }
            if (Object.keys(item).length > 0) out.push(item);
        };
        [design, businessFacts, codeState].forEach(root => this._walk(root, value => {
            if (value && (value.fileKind || value.kind || value.path || value.resolvedPath)) add(value);
        }));
        [design, businessFacts, codeState].forEach(root => {
            if (!root || typeof root !== 'object') return;
            ['configFiles', 'configurationFiles', 'configurations', 'systemParameterFiles'].forEach(key => {
                const values = root[key];
                if (Array.isArray(values)) values.forEach(add);
                else if (values && typeof values === 'object') Object.values(values).forEach(add);
            });
        });
        (Array.isArray(options.materializedFiles) ? options.materializedFiles : []).forEach(add);
        return this._uniqueObjects(out);
    }

    _projectNamedCollections(roots = [], keys = []) {
        const out = [];
        roots.forEach(root => {
            if (!root || typeof root !== 'object') return;
            keys.forEach(key => {
                const value = root[key];
                if (Array.isArray(value)) out.push(...this._clone(value));
                else if (value && typeof value === 'object') out.push(...Object.entries(value).map(([name, item]) => ({
                    name,
                    ...(item && typeof item === 'object' ? this._clone(item) : { value: item })
                })));
            });
        });
        return this._uniqueObjects(out);
    }

    _sourceRefs(options = {}) {
        const refs = [];
        const add = (kind, filePath) => {
            const resolved = this._resolve(filePath);
            if (!kind || !resolved || !this._isFile(resolved)) return;
            if (!refs.some(item => item.kind === kind && item.path === resolved)) refs.push({ kind, path: resolved });
        };
        add('design_json', options.designDocumentPath);
        if (String(options.documentStage || 'coder').trim().toLowerCase() === 'design') {
            add('design_finalize_receipt', options.finalizeReceiptPath);
        }
        add('business_facts', options.businessFactsPath);
        add('code_state', options.codeStatePath);
        add('design_markdown', options.designMarkdownPath);
        add('requirement_stories', options.requirementStoriesPath || this.path.join(String(options.demandDir || ''), 'demand', 'stories.json'));
        add('requirement_rule_pool', options.requirementRulePoolPath || this.path.join(String(options.demandDir || ''), 'demand', 'rule-pool.json'));
        (Array.isArray(options.additionalInputRefs) ? options.additionalInputRefs : []).forEach(ref => add(ref && ref.kind || 'additional_input', ref && ref.path));
        (Array.isArray(options.materializedFiles) ? options.materializedFiles : []).forEach(ref => add(ref && (ref.fileKind || ref.kind) || 'materialized_file', ref && (ref.targetFile || ref.resolvedPath || ref.path)));
        (Array.isArray(options.sqlPaths) ? options.sqlPaths : []).forEach(filePath => add('sql_artifact', filePath));
        (Array.isArray(options.workflowPaths) ? options.workflowPaths : []).forEach(filePath => add('workflow_xml', filePath));
        return refs;
    }

    _fingerprintRefs(refs = []) {
        return refs.map(ref => ({
            kind: ref.kind,
            path: ref.path,
            size: this.fs.statSync(ref.path).size,
            sha256: this._hashFile(ref.path)
        }));
    }

    _hashFile(filePath) {
        return `sha256:${crypto.createHash('sha256').update(this.fs.readFileSync(filePath)).digest('hex')}`;
    }

    _hashJson(value) {
        return `sha256:${crypto.createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex')}`;
    }

    _hashText(value) {
        return `sha256:${crypto.createHash('sha256').update(value, 'utf8').digest('hex')}`;
    }

    _writeJsonAtomic(filePath, serialized) {
        this.fs.mkdirSync(this.path.dirname(filePath), { recursive: true });
        const temporary = `${filePath}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
        try {
            this.fs.writeFileSync(temporary, serialized, 'utf8');
            this.fs.renameSync(temporary, filePath);
        } catch (error) {
            try { if (this.fs.existsSync(temporary)) this.fs.unlinkSync(temporary); } catch (_) {}
            throw error;
        }
    }

    _readJson(filePath = '') {
        const resolved = this._resolve(filePath);
        if (!resolved || !this._isFile(resolved)) return null;
        try { return JSON.parse(this.fs.readFileSync(resolved, 'utf8')); } catch (_) { return null; }
    }

    _isFile(filePath = '') {
        try { return Boolean(filePath && this.fs.existsSync(filePath) && this.fs.statSync(filePath).isFile()); } catch (_) { return false; }
    }

    _resolve(filePath = '') {
        const value = String(filePath || '').trim();
        return value ? this.path.resolve(value) : '';
    }

    _uniquePaths(values = []) {
        return Array.from(new Set((Array.isArray(values) ? values : [])
            .map(value => this._resolve(value))
            .filter(value => value && this._isFile(value))));
    }

    _uniqueObjects(values = []) {
        const seen = new Set();
        return values.filter(value => {
            const key = JSON.stringify(value);
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
        });
    }

    _clone(value) {
        return value && typeof value === 'object' ? JSON.parse(JSON.stringify(value)) : value;
    }

    _walk(value, visitor, seen = new Set()) {
        if (!value || typeof value !== 'object' || seen.has(value)) return;
        seen.add(value);
        visitor(value);
        if (Array.isArray(value)) value.forEach(item => this._walk(item, visitor, seen));
        else Object.values(value).forEach(item => this._walk(item, visitor, seen));
    }

    _pageRoute(filePath = '') {
        const normalized = String(filePath || '').replace(/\\/g, '/');
        if (!normalized) return '';
        const marker = '/src/main/webapp/';
        const markerIndex = normalized.toLowerCase().indexOf(marker);
        const relative = markerIndex >= 0 ? normalized.slice(markerIndex + marker.length) : normalized;
        return relative.replace(/^\/+/, '').replace(/\.html$/i, '').replace(/\//g, '\\');
    }
}

module.exports = DeliveryFactsService;
