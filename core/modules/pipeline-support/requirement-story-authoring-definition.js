/* eslint-disable */
const crypto = require('crypto');

function array(value) {
    return Array.isArray(value) ? value : [];
}

function text(value) {
    return String(value || '').trim();
}

function stableKey(prefix, storyId, seed) {
    const hash = crypto.createHash('sha256').update(`${storyId}|${seed}`, 'utf-8').digest('hex').slice(0, 10);
    return `${prefix}_${hash}`;
}

function stripEmpty(value) {
    if (Array.isArray(value)) return value.map(stripEmpty);
    if (!value || typeof value !== 'object') return value;
    const out = {};
    Object.keys(value).forEach(key => {
        const item = stripEmpty(value[key]);
        if (item === undefined || item === null || item === '') return;
        if (Array.isArray(item) && item.length === 0) return;
        if (item && typeof item === 'object' && !Array.isArray(item) && Object.keys(item).length === 0) return;
        out[key] = item;
    });
    return out;
}

const ACCEPTANCE_ITEM = Object.freeze({
    scenario: Object.freeze({ projection: 'preserve' }),
    given: Object.freeze({ projection: 'preserve' }),
    when: Object.freeze({ projection: 'preserve' }),
    then: Object.freeze({ projection: 'preserve' })
});

const EXISTING_ADJUSTMENT_FIELDS = Object.freeze({
    entryFiles: Object.freeze({
        projection: 'preserve',
        itemFields: Object.freeze({
            fileKind: Object.freeze({ projection: 'preserve' }),
            path: Object.freeze({ projection: 'preserve' }),
            source: Object.freeze({ projection: 'forbidden' }),
            verificationStatus: Object.freeze({ projection: 'forbidden' }),
            resolvedPath: Object.freeze({ projection: 'forbidden' }),
            filePath: Object.freeze({ projection: 'forbidden' })
        })
    }),
    preserveBehaviors: Object.freeze({
        projection: 'preserve',
        itemFields: Object.freeze({
            businessResult: Object.freeze({ projection: 'preserve' }),
            regressionScope: Object.freeze({ projection: 'preserve' })
        })
    })
});

const CODING_FACT_FIELDS = Object.freeze({
    factId: Object.freeze({ projection: 'forbidden' }),
    factType: Object.freeze({ projection: 'preserve' }),
    description: Object.freeze({ projection: 'preserve' }),
    confirmedFacts: Object.freeze({ projection: 'preserve' })
});

const STATISTICS_FILTER_FIELDS = Object.freeze({
    key: Object.freeze({ projection: 'forbidden' }),
    label: Object.freeze({ projection: 'preserve' }),
    type: Object.freeze({ projection: 'preserve' }),
    required: Object.freeze({ projection: 'preserve' }),
    description: Object.freeze({ projection: 'preserve' })
});

const STATISTICS_DIMENSION_FIELDS = Object.freeze({
    key: Object.freeze({ projection: 'forbidden' }),
    label: Object.freeze({ projection: 'preserve' }),
    granularity: Object.freeze({ projection: 'preserve' }),
    description: Object.freeze({ projection: 'preserve' })
});

const STATISTICS_METRIC_FIELDS = Object.freeze({
    key: Object.freeze({ projection: 'forbidden' }),
    label: Object.freeze({ projection: 'preserve' }),
    aggregate: Object.freeze({ projection: 'preserve' }),
    condition: Object.freeze({ projection: 'preserve' }),
    formula: Object.freeze({ projection: 'preserve' }),
    description: Object.freeze({ projection: 'preserve' })
});

const WORKFLOW_OPERATION_FIELDS = Object.freeze({
    key: Object.freeze({ projection: 'forbidden' }),
    name: Object.freeze({ projection: 'preserve' }),
    type: Object.freeze({ projection: 'preserve' }),
    semantic: Object.freeze({ projection: 'preserve' }),
    targetActivity: Object.freeze({ projection: 'preserve' }),
    requiresOpinion: Object.freeze({ projection: 'preserve' })
});

const WORKFLOW_ACTIVITY_FIELDS = Object.freeze({
    key: Object.freeze({ projection: 'forbidden' }),
    name: Object.freeze({ projection: 'preserve' }),
    actor: Object.freeze({ projection: 'preserve' }),
    type: Object.freeze({ projection: 'preserve' }),
    operations: Object.freeze({ projection: 'derive', itemFields: WORKFLOW_OPERATION_FIELDS })
});

const WORKFLOW_TRANSITION_FIELDS = Object.freeze({
    from: Object.freeze({ projection: 'preserve' }),
    to: Object.freeze({ projection: 'preserve' }),
    condition: Object.freeze({ projection: 'preserve' })
});

const WORKFLOW_FIELDS = Object.freeze({
    processName: Object.freeze({ projection: 'preserve' }),
    starter: Object.freeze({ projection: 'preserve' }),
    activities: Object.freeze({ projection: 'derive', itemFields: WORKFLOW_ACTIVITY_FIELDS }),
    transitions: Object.freeze({ projection: 'derive', itemFields: WORKFLOW_TRANSITION_FIELDS }),
    businessResults: Object.freeze({ projection: 'preserve' }),
    className: Object.freeze({ projection: 'forbidden' }),
    javaClass: Object.freeze({ projection: 'forbidden' }),
    file: Object.freeze({ projection: 'forbidden' }),
    filePath: Object.freeze({ projection: 'forbidden' }),
    path: Object.freeze({ projection: 'forbidden' }),
    xml: Object.freeze({ projection: 'forbidden' }),
    guid: Object.freeze({ projection: 'forbidden' }),
    vmlId: Object.freeze({ projection: 'forbidden' }),
    actionName: Object.freeze({ projection: 'forbidden' }),
    pageName: Object.freeze({ projection: 'forbidden' }),
    controller: Object.freeze({ projection: 'forbidden' }),
    serviceName: Object.freeze({ projection: 'forbidden' }),
    methodName: Object.freeze({ projection: 'forbidden' })
});

const STATISTICS_DISPLAY = Object.freeze({
    summaryCards: Object.freeze({ projection: 'preserve' }),
    dataGrid: Object.freeze({ projection: 'preserve' }),
    chart: Object.freeze({ projection: 'preserve' }),
    note: Object.freeze({ projection: 'preserve' }),
    refreshInterval: Object.freeze({ projection: 'preserve' }),
    showLastUpdatedAt: Object.freeze({ projection: 'preserve' }),
    refreshFailure: Object.freeze({ projection: 'preserve' })
});

const STORY_FIELDS = Object.freeze({
    storyId: { projection: 'forbidden' },
    actor: { projection: 'preserve' },
    userStory: { projection: 'preserve' },
    acceptanceCriteria: {
        projection: 'preserve',
        fields: Object.freeze({
            happyPath: { projection: 'preserve', itemFields: ACCEPTANCE_ITEM },
            exception: { projection: 'preserve', itemFields: ACCEPTANCE_ITEM },
            boundary: { projection: 'preserve', itemFields: ACCEPTANCE_ITEM }
        })
    },
    invariants: { projection: 'preserve' },
    deliveryBoundary: { projection: 'preserve' },
    existingAdjustment: { projection: 'derive', fields: EXISTING_ADJUSTMENT_FIELDS },
    codingFactHandoff: { projection: 'derive', itemFields: CODING_FACT_FIELDS },
    statisticsIntent: {
        projection: 'derive',
        fields: Object.freeze({
            title: { projection: 'preserve' },
            purpose: { projection: 'preserve' },
            filters: { projection: 'derive', itemFields: STATISTICS_FILTER_FIELDS },
            dimensions: { projection: 'derive', itemFields: STATISTICS_DIMENSION_FIELDS },
            metrics: { projection: 'derive', itemFields: STATISTICS_METRIC_FIELDS },
            display: { projection: 'preserve', fields: STATISTICS_DISPLAY },
            exportRequired: { projection: 'preserve' }
        })
    },
    workflowIntent: { projection: 'derive', fields: WORKFLOW_FIELDS }
});

class RequirementStoryAuthoringDefinition {
    constructor() {
        this.schemaVersion = 'requirement-story-authoring-definition/v1';
        this.fields = STORY_FIELDS;
    }

    publicContract() {
        return {
            schemaVersion: this.schemaVersion,
            identity: 'Story身份只写stories.US1对象键，storyId由Builder派生。',
            fields: this._describeFields(this.fields)
        };
    }

    validate(story = {}, storyId = '') {
        const issues = [];
        if (!story || typeof story !== 'object' || Array.isArray(story)) {
            return [{
                code: 'REQUIREMENT_STORY_AUTHORING_NOT_OBJECT',
                field: `stories.${storyId || '<story>'}`,
                message: 'Story必须是object。'
            }];
        }
        this._validateKnownObject(story, this.fields, `stories.${storyId || '<story>'}`, issues);
        const ac = story.acceptanceCriteria;
        if (ac && Object.prototype.hasOwnProperty.call(ac, 'invariants')) {
            issues.push({
                code: 'REQUIREMENT_STORY_INVARIANTS_MISPLACED',
                field: `stories.${storyId}.acceptanceCriteria.invariants`,
                message: 'invariants属于Story顶层，禁止放入acceptanceCriteria。',
                repair: `移动到stories.${storyId}.invariants，保持原数组内容不变。`
            });
        }
        return issues;
    }

    project(story = {}, storyId = '', adapters = {}) {
        const issues = this.validate(story, storyId);
        if (issues.length > 0) return { ok: false, issues };
        const out = { storyId: text(storyId) };
        Object.entries(this.fields).forEach(([field, definition]) => {
            if (!Object.prototype.hasOwnProperty.call(story, field)) return;
            const value = story[field];
            if (definition.projection === 'preserve') {
                out[field] = this._projectPreserved(value, definition);
                return;
            }
            const adapter = adapters[field];
            if (typeof adapter === 'function') {
                const projected = adapter(value, storyId, story);
                if (projected !== undefined && projected !== null) out[field] = projected;
                return;
            }
            if (field === 'statisticsIntent') {
                out[field] = this._projectStatistics(value, storyId);
                return;
            }
            out[field] = JSON.parse(JSON.stringify(value));
        });
        return { ok: true, story: stripEmpty(out) };
    }

    definitionIssues() {
        const issues = [];
        const visit = (fields, path) => {
            Object.entries(fields || {}).forEach(([key, definition]) => {
                if (!definition || !['preserve', 'derive', 'forbidden'].includes(definition.projection)) {
                    issues.push(`${path}.${key}缺少preserve/derive/forbidden投影语义`);
                }
                if (definition && definition.fields) visit(definition.fields, `${path}.${key}`);
                if (definition && definition.itemFields) visit(definition.itemFields, `${path}.${key}[]`);
            });
        };
        visit(this.fields, 'stories.USx');
        return issues;
    }

    _validateKnownObject(value, definitions, path, issues) {
        if (!value || typeof value !== 'object' || Array.isArray(value)) return;
        Object.keys(value).forEach(key => {
            const definition = definitions[key];
            if (!definition) {
                issues.push({
                    code: 'REQUIREMENT_STORY_AUTHORING_FIELD_UNKNOWN',
                    field: `${path}.${key}`,
                    message: `${path}.${key}不在Builder作者合同中；禁止静默丢弃。`
                });
                return;
            }
            if (definition.projection === 'forbidden') {
                issues.push({
                    code: 'REQUIREMENT_STORY_AUTHORING_FIELD_FORBIDDEN',
                    field: `${path}.${key}`,
                    message: `${path}.${key}禁止由LLM填写。`
                });
                return;
            }
            if (definition.fields && value[key] && typeof value[key] === 'object' && !Array.isArray(value[key])) {
                this._validateKnownObject(value[key], definition.fields, `${path}.${key}`, issues);
            }
            if (definition.itemFields && Array.isArray(value[key])) {
                value[key].forEach((item, index) => this._validateKnownObject(
                    item,
                    definition.itemFields,
                    `${path}.${key}[${index}]`,
                    issues
                ));
            }
        });
    }

    _projectPreserved(value, definition = {}) {
        if (definition.fields && value && typeof value === 'object' && !Array.isArray(value)) {
            const out = {};
            Object.keys(definition.fields).forEach(key => {
                if (!Object.prototype.hasOwnProperty.call(value, key)) return;
                out[key] = this._projectPreserved(value[key], definition.fields[key]);
            });
            return out;
        }
        if (definition.itemFields && Array.isArray(value)) {
            return value.map(item => this._projectPreserved(item, { fields: definition.itemFields }));
        }
        return value && typeof value === 'object' ? JSON.parse(JSON.stringify(value)) : value;
    }

    _projectStatistics(value = {}, storyId = '') {
        if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
        const normalizeLabelRows = (items, prefix) => array(items).map((item, index) => {
            const source = typeof item === 'string' ? { label: text(item) } : stripEmpty({
                label: text(item && item.label),
                type: text(item && item.type),
                required: item && item.required === true,
                granularity: text(item && item.granularity),
                description: text(item && item.description)
            });
            return { key: stableKey(prefix, storyId, `${source.label}|${index}`), ...source };
        });
        const metrics = array(value.metrics).map((item, index) => ({
            key: stableKey('metric', storyId, `${text(item && item.label)}|${index}`),
            ...stripEmpty({
                label: text(item && item.label),
                aggregate: text(item && item.aggregate),
                condition: text(item && item.condition),
                formula: text(item && item.formula),
                description: text(item && item.description)
            })
        }));
        return stripEmpty({
            title: text(value.title),
            purpose: text(value.purpose),
            filters: normalizeLabelRows(value.filters, 'filter'),
            dimensions: normalizeLabelRows(value.dimensions, 'dimension'),
            metrics,
            display: this._projectPreserved(value.display || {}, { fields: STATISTICS_DISPLAY }),
            ...(typeof value.exportRequired === 'boolean' ? { exportRequired: value.exportRequired } : {})
        });
    }

    _describeFields(fields = {}) {
        const out = {};
        Object.entries(fields).forEach(([key, definition]) => {
            if (definition.projection === 'forbidden') return;
            out[key] = {
                projection: definition.projection,
                ...(definition.fields ? { fields: this._describeFields(definition.fields) } : {}),
                ...(definition.itemFields ? { itemFields: this._describeFields(definition.itemFields) } : {})
            };
        });
        return out;
    }
}

module.exports = RequirementStoryAuthoringDefinition;
