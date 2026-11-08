/* eslint-disable */

const OBJECT_KEY_PATTERN = /^[a-z][a-z0-9_]*$/;
const STORY_ID_PATTERN = /^US[0-9]+$/;
const TABLE_MODES = Object.freeze(['new', 'reuse']);
const STATISTICS_SOURCE_ROLES = Object.freeze(['primary', 'secondary']);
const RELATION_KINDS = Object.freeze(['one_to_one', 'one_to_many', 'many_to_one', 'reference']);
const CAPABILITIES = Object.freeze(['maintain', 'query', 'action', 'job', 'configure']);
const COMPOSITION_LAYOUTS = Object.freeze(['plain', 'accordion']);
const PAGE_COMPOSITION_BLOCK_CONTRACT = Object.freeze({
    form: Object.freeze({ relationPathMinItems: 0, directRelationOnly: false }),
    child_edit: Object.freeze({ relationPathMinItems: 1, directRelationOnly: true }),
    child_readonly: Object.freeze({ relationPathMinItems: 1, directRelationOnly: true }),
    attachment: Object.freeze({ relationPathMinItems: 0, directRelationOnly: false })
});
const COMPOSITION_BLOCK_KINDS = Object.freeze(Object.keys(PAGE_COMPOSITION_BLOCK_CONTRACT)
    .filter(kind => kind !== 'attachment'));
const DETAIL_ROW_KINDS = Object.freeze(['FIELD', 'CODE_ITEM', 'ATTACHMENT', 'REST', 'WORKFLOW_EVENT']);
const CODE_ITEM_MODES = Object.freeze(['new', 'reuse']);
const CODE_ITEM_FACT_TYPES = Object.freeze([
    'company_mechanism.code_items',
    'company_mechanism.code_item_candidate',
    'company_mechanism.code_item_confirmed'
]);
const DESIGN_DECISION_TAG_PATTERN = /^[a-z][a-z0-9_]*$/;
const FIELD_REF_PATTERN = /^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/;
const QUERY_FILTER_INPUT_PATTERN = /^[a-z][A-Za-z0-9_]*$/;
const QUERY_FILTER_OPERATORS = Object.freeze(['contains', 'exact']);
const QUERY_FILTER_NORMALIZERS = Object.freeze(['trim', 'none']);
const CODE_ITEM_VALUE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;
const WORKFLOW_PARAMETER_CONSTANT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:/-]*$/;
const JAVA_METHOD_NAME_PATTERN = /^[a-z][A-Za-z0-9]*$/;
const WORKFLOW_OPERATION_KEY_PATTERN = /^operation_[a-z0-9][a-z0-9_]*$/;

const DECISION_ROW_HELP = Object.freeze({
    TABLE_NEW: 'TABLE|logicalTableKey|new|中文业务表名',
    TABLE_REUSE: 'TABLE|logicalTableKey|reuse|确认候选表名|中文业务表名',
    RELATION: 'RELATION|parentTableKey|childTableKey|one_to_one/one_to_many/many_to_one/reference|业务关系含义',
    STORY: 'STORY|storyId|maintain/query/action/job/configure|tableKey或-（configure只填-）',
    TABLE_STORY: 'TABLE_STORY|logicalTableKey|storyId',
    STATISTICS_SOURCE: 'STATISTICS_SOURCE|storyId|确认候选表名|primary/secondary',
    QUERY_SURFACE: 'QUERY_SURFACE|storyId|independent|pageKey（仅在Story已绑定真实TABLE或已有入口证据时提交）'
});

const DETAIL_ROW_HELP = Object.freeze({
    FIELD: 'FIELD|tableKey|columnName|type|length或-|true/false|中文业务含义',
    CODE_ITEM: 'CODE_ITEM|tableKey|columnName|new/reuse|代码项中文名|new时codeValue=显示名,...；reuse时Requirement事实ref',
    ATTACHMENT: 'ATTACHMENT|tableKey|columnName|true/false|附件业务名称',
    REST: 'REST|storyId|operation_key(小写snake_case)|业务目的|请求事实|返回事实',
    WORKFLOW_EVENT: 'WORKFLOW_EVENT|storyId|operationKey|none|-|-|- 或 WORKFLOW_EVENT|storyId|operationKey|service_method|methodName|业务效果|pviguid=$PVI_GUID:流程实例标识,status=10:状态值；除$PVI_GUID外只能填写ASCII稳定常量'
});

const COMPOSITION_ROW_HELP = Object.freeze({
    COMPOSE: 'COMPOSE|storyId|plain/accordion|form:tableKey,child_edit:tableKey或child_readonly:tableKey[|可选ASCII审计标签；可省略、留空或填-]',
    SECTION: 'SECTION|storyId|sectionKey|中文分区标题|tableKey.fieldName,tableKey.fieldName',
    PAGE_BIND: 'PAGE_BIND|storyId|shared|targetComposeStoryId 或 PAGE_BIND|storyId|independent|self',
    QUERY_FILTER: 'QUERY_FILTER|storyId|inputKey|tableKey.fieldName|contains/exact|trim/none'
});

function issue(code, rowIndex, field, message, extra = {}) {
    return { code, rowIndex, field, message, ...extra };
}

function normalizeRows(rows) {
    return Array.isArray(rows) ? rows : [];
}

function splitRow(raw, rowIndex, issues, contractName, publicRowsField = '') {
    if (typeof raw !== 'string' || !raw.trim()) {
        const field = publicRowsField || `${contractName.toLowerCase()}Rows`;
        issues.push(issue(`${contractName}_ROW_NOT_STRING`, rowIndex, `${field}[${rowIndex}]`, '每行必须是非空字符串。'));
        return null;
    }
    return raw.split('|').map(part => part.trim());
}

function exactPartCount(parts, expected, rowIndex, kind, issues, help, publicRowsField = '') {
    if (parts.length === expected) return true;
    issues.push(issue(
        `DESIGN_${kind}_ROW_PART_COUNT_INVALID`,
        rowIndex,
        `${publicRowsField || `${kind.toLowerCase()}Rows`}[${rowIndex}]`,
        `${kind} 行必须有 ${expected} 段，合法格式：${help}`,
        { expectedShape: help, actualPartCount: parts.length }
    ));
    return false;
}

function parseDecisionRows(rows = []) {
    const issues = [];
    const parsed = { tables: [], relations: [], stories: [], tableStories: [], statisticsSources: [], querySurfaces: [] };
    const values = normalizeRows(rows);
    if (values.length === 0) {
        return {
            ok: false,
            issues: [issue('DESIGN_DECISION_ROWS_EMPTY', -1, 'decisionRows', 'decisionRows 必须是非空字符串数组。')]
        };
    }
    values.forEach((raw, rowIndex) => {
        const parts = splitRow(raw, rowIndex, issues, 'DESIGN_DECISION');
        if (!parts) return;
        const kind = String(parts[0] || '').toUpperCase();
        if (kind === 'TABLE') {
            const mode = String(parts[2] || '').toLowerCase();
            const help = mode === 'reuse' ? DECISION_ROW_HELP.TABLE_REUSE : DECISION_ROW_HELP.TABLE_NEW;
            const expected = mode === 'reuse' ? 5 : 4;
            if (!exactPartCount(parts, expected, rowIndex, kind, issues, help)) return;
            parsed.tables.push({
                tableKey: parts[1],
                mode,
                tableName: mode === 'reuse' ? parts[3] : '',
                displayName: mode === 'reuse' ? parts[4] : parts[3],
                rowIndex
            });
            return;
        }
        if (kind === 'RELATION') {
            if (!exactPartCount(parts, 5, rowIndex, kind, issues, DECISION_ROW_HELP.RELATION)) return;
            parsed.relations.push({
                parentTableKey: parts[1],
                childTableKey: parts[2],
                relationKind: parts[3].toLowerCase(),
                meaning: parts[4],
                relationKey: `${parts[1]}_${parts[2]}`,
                rowIndex
            });
            return;
        }
        if (kind === 'STORY') {
            if (!exactPartCount(parts, 4, rowIndex, kind, issues, DECISION_ROW_HELP.STORY)) return;
            parsed.stories.push({
                storyId: parts[1].toUpperCase(),
                capability: parts[2].toLowerCase(),
                tableKey: parts[3],
                routeKey: `${parts[1].toLowerCase()}_${parts[2].toLowerCase()}`,
                rowIndex
            });
            return;
        }
        if (kind === 'TABLE_STORY') {
            if (!exactPartCount(parts, 3, rowIndex, kind, issues, DECISION_ROW_HELP.TABLE_STORY)) return;
            const storyId = String(parts[2] || '').trim().toUpperCase();
            if (!OBJECT_KEY_PATTERN.test(parts[1])) {
                issues.push(issue('DESIGN_TABLE_STORY_TABLE_KEY_INVALID', rowIndex, `decisionRows[${rowIndex}]`, `TABLE_STORY的tableKey=${parts[1] || '(empty)'}必须是小写snake_case。`));
            }
            if (!STORY_ID_PATTERN.test(storyId)) {
                issues.push(issue('DESIGN_TABLE_STORY_STORY_ID_INVALID', rowIndex, `decisionRows[${rowIndex}]`, `TABLE_STORY的storyId=${parts[2] || '(empty)'}必须是US+数字。`));
            }
            parsed.tableStories.push({ tableKey: parts[1], storyId, rowIndex });
            return;
        }
        if (kind === 'STATISTICS_SOURCE') {
            if (!exactPartCount(parts, 4, rowIndex, kind, issues, DECISION_ROW_HELP.STATISTICS_SOURCE)) return;
            const storyId = String(parts[1] || '').trim().toUpperCase();
            const role = String(parts[3] || '').trim().toLowerCase();
            if (!STORY_ID_PATTERN.test(storyId)) {
                issues.push(issue('DESIGN_STATISTICS_SOURCE_STORY_ID_INVALID', rowIndex, `decisionRows[${rowIndex}]`, `STATISTICS_SOURCE的storyId=${parts[1] || '(empty)'}必须是US+数字。`));
            }
            if (!parts[2]) {
                issues.push(issue('DESIGN_STATISTICS_SOURCE_TABLE_NAME_MISSING', rowIndex, `decisionRows[${rowIndex}]`, 'STATISTICS_SOURCE必须填写已确认候选表名。'));
            }
            if (!STATISTICS_SOURCE_ROLES.includes(role)) {
                issues.push(issue(
                    'DESIGN_STATISTICS_SOURCE_ROLE_INVALID',
                    rowIndex,
                    `decisionRows[${rowIndex}]`,
                    `STATISTICS_SOURCE的role只能是${STATISTICS_SOURCE_ROLES.join('/')}，当前=${parts[3] || '(empty)'}。`,
                    { allowedValues: STATISTICS_SOURCE_ROLES.slice() }
                ));
            }
            parsed.statisticsSources.push({ storyId, tableName: parts[2], role, rowIndex });
            return;
        }
        if (kind === 'QUERY_SURFACE') {
            if (!exactPartCount(parts, 4, rowIndex, kind, issues, DECISION_ROW_HELP.QUERY_SURFACE)) return;
            const storyId = String(parts[1] || '').trim().toUpperCase();
            const mode = String(parts[2] || '').trim().toLowerCase();
            const pageKey = String(parts[3] || '').trim().toLowerCase();
            if (!STORY_ID_PATTERN.test(storyId)) {
                issues.push(issue('DESIGN_QUERY_SURFACE_STORY_ID_INVALID', rowIndex, `decisionRows[${rowIndex}]`, `QUERY_SURFACE的storyId=${parts[1] || '(empty)'}必须是US+数字。`));
            }
            if (mode !== 'independent') {
                issues.push(issue('DESIGN_QUERY_SURFACE_MODE_INVALID', rowIndex, `decisionRows[${rowIndex}]`, 'QUERY_SURFACE的mode只能是independent。', { allowedValues: ['independent'] }));
            }
            if (!DESIGN_DECISION_TAG_PATTERN.test(pageKey)) {
                issues.push(issue('DESIGN_QUERY_SURFACE_PAGE_KEY_INVALID', rowIndex, `decisionRows[${rowIndex}]`, 'QUERY_SURFACE的pageKey必须是ASCII snake_case。'));
            }
            parsed.querySurfaces.push({ storyId, mode, pageKey, rowIndex });
            return;
        }
        issues.push(issue(
            'DESIGN_DECISION_ROW_KIND_INVALID',
            rowIndex,
            `decisionRows[${rowIndex}]`,
            `首段必须是 TABLE/RELATION/STORY/TABLE_STORY/STATISTICS_SOURCE/QUERY_SURFACE，当前为 ${kind || '(empty)'}。`,
            { allowedValues: ['TABLE', 'RELATION', 'STORY', 'TABLE_STORY', 'STATISTICS_SOURCE', 'QUERY_SURFACE'] }
        ));
    });
    return issues.length > 0 ? { ok: false, issues } : { ok: true, ...parsed };
}

function parseDetailRows(rows = []) {
    const issues = [];
    const parsed = { fields: [], codeItems: [], attachments: [], restOperations: [], workflowEvents: [] };
    const values = normalizeRows(rows);
    values.forEach((raw, rowIndex) => {
        const parts = splitRow(raw, rowIndex, issues, 'DESIGN_DETAIL');
        if (!parts) return;
        const kind = String(parts[0] || '').toUpperCase();
        if (!DETAIL_ROW_KINDS.includes(kind)) {
            issues.push(issue(
                'DESIGN_DETAIL_ROW_KIND_INVALID',
                rowIndex,
                `detailRows[${rowIndex}]`,
                `首段必须是 ${DETAIL_ROW_KINDS.join('/')}，当前为 ${kind || '(empty)'}。`,
                { allowedValues: DETAIL_ROW_KINDS.slice() }
            ));
            return;
        }
        if (kind === 'FIELD') {
            if (!exactPartCount(parts, 7, rowIndex, kind, issues, DETAIL_ROW_HELP.FIELD)) return;
            const requiredText = parts[5].toLowerCase();
            if (requiredText !== 'true' && requiredText !== 'false') {
                issues.push(issue('DESIGN_FIELD_REQUIRED_INVALID', rowIndex, `detailRows[${rowIndex}]`, 'FIELD 第6段只能是 true 或 false。'));
                return;
            }
            parsed.fields.push({
                objectKey: parts[1],
                name: parts[2],
                type: parts[3].toUpperCase(),
                length: parts[4] === '-' ? '' : parts[4],
                required: requiredText === 'true',
                comment: parts[6],
                rowIndex
            });
            return;
        }
        if (kind === 'CODE_ITEM') {
            if (!exactPartCount(parts, 6, rowIndex, kind, issues, DETAIL_ROW_HELP.CODE_ITEM)) return;
            const mode = String(parts[3] || '').toLowerCase();
            if (!CODE_ITEM_MODES.includes(mode)) {
                issues.push(issue('DESIGN_CODE_ITEM_MODE_INVALID', rowIndex, `detailRows[${rowIndex}].mode`, `CODE_ITEM第4段必须是new或reuse，当前=${parts[3] || '(empty)'}。`, { allowedValues: CODE_ITEM_MODES.slice() }));
                return;
            }
            const codeItem = String(parts[4] || '').trim();
            if (!codeItem) {
                issues.push(issue('DESIGN_CODE_ITEM_NAME_MISSING', rowIndex, `detailRows[${rowIndex}].codeItem`, 'CODE_ITEM代码项中文名不能为空。'));
                return;
            }
            if (mode === 'reuse') {
                const sourceRef = String(parts[5] || '').trim();
                if (!sourceRef) {
                    issues.push(issue('DESIGN_CODE_ITEM_REUSE_SOURCE_MISSING', rowIndex, `detailRows[${rowIndex}].sourceRef`, 'reuse代码项必须填写Requirement已确认事实ref。'));
                    return;
                }
                parsed.codeItems.push({ objectKey: parts[1], columnName: parts[2], codeItem, mode, sourceRef, rowIndex });
                return;
            }
            const codes = [];
            const seenValues = new Set();
            const valueTokens = String(parts[5] || '').split(',').map(item => item.trim()).filter(Boolean);
            valueTokens.forEach((token, codeIndex) => {
                const separator = token.indexOf('=');
                const codeValue = separator > 0 ? token.slice(0, separator).trim() : '';
                const codeLabel = separator > 0 ? token.slice(separator + 1).trim() : '';
                if (!CODE_ITEM_VALUE_PATTERN.test(codeValue) || !codeLabel) {
                    issues.push(issue(
                        'DESIGN_CODE_ITEM_VALUE_INVALID',
                        rowIndex,
                        `detailRows[${rowIndex}].codes[${codeIndex}]`,
                        `new代码值必须是codeValue=显示名，codeValue为ASCII稳定值，当前=${token || '(empty)'}。`,
                        {
                            allowedPattern: CODE_ITEM_VALUE_PATTERN.source,
                            expectedShape: 'codeValue=显示名'
                        }
                    ));
                    return;
                }
                if (seenValues.has(codeValue)) {
                    issues.push(issue('DESIGN_CODE_ITEM_VALUE_DUPLICATED', rowIndex, `detailRows[${rowIndex}].codes[${codeIndex}]`, `new代码项的codeValue=${codeValue}重复。`));
                    return;
                }
                seenValues.add(codeValue);
                codes.push({ codeValue, codeLabel, order: codeIndex + 1 });
            });
            if (valueTokens.length === 0 || codes.length !== valueTokens.length) {
                if (valueTokens.length === 0) {
                    issues.push(issue('DESIGN_CODE_ITEM_VALUES_EMPTY', rowIndex, `detailRows[${rowIndex}].codes`, 'new代码项必须至少填写一个codeValue=显示名。'));
                }
                return;
            }
            parsed.codeItems.push({ objectKey: parts[1], columnName: parts[2], codeItem, mode, codes, rowIndex });
            return;
        }
        if (kind === 'ATTACHMENT') {
            if (!exactPartCount(parts, 5, rowIndex, kind, issues, DETAIL_ROW_HELP.ATTACHMENT)) return;
            const requiredText = parts[3].toLowerCase();
            if (requiredText !== 'true' && requiredText !== 'false') {
                issues.push(issue(
                    'DESIGN_ATTACHMENT_REQUIRED_INVALID',
                    rowIndex,
                    `detailRows[${rowIndex}]`,
                    'ATTACHMENT 第4段只能是 true 或 false。',
                    { expectedShape: DETAIL_ROW_HELP.ATTACHMENT }
                ));
                return;
            }
            parsed.attachments.push({
                objectKey: parts[1],
                columnName: parts[2],
                required: requiredText === 'true',
                attachmentLabel: parts[4],
                rowIndex
            });
            return;
        }
        if (kind === 'WORKFLOW_EVENT') {
            if (!exactPartCount(parts, 7, rowIndex, kind, issues, DETAIL_ROW_HELP.WORKFLOW_EVENT)) return;
            const storyId = String(parts[1] || '').trim().toUpperCase();
            const operationKey = String(parts[2] || '').trim();
            const mode = String(parts[3] || '').trim().toLowerCase();
            if (!STORY_ID_PATTERN.test(storyId)) {
                issues.push(issue('DESIGN_WORKFLOW_EVENT_STORY_ID_INVALID', rowIndex, `detailRows[${rowIndex}].storyId`, 'WORKFLOW_EVENT storyId必须是US+数字。'));
            }
            if (!WORKFLOW_OPERATION_KEY_PATTERN.test(operationKey)) {
                issues.push(issue('DESIGN_WORKFLOW_EVENT_OPERATION_KEY_INVALID', rowIndex, `detailRows[${rowIndex}].operationKey`, 'WORKFLOW_EVENT operationKey必须是operation_开头的小写ASCII标识。'));
            }
            if (!['none', 'service_method'].includes(mode)) {
                issues.push(issue('DESIGN_WORKFLOW_EVENT_MODE_INVALID', rowIndex, `detailRows[${rowIndex}].mode`, 'WORKFLOW_EVENT模式只能是none或service_method。', { allowedValues: ['none', 'service_method'] }));
                return;
            }
            if (mode === 'none') {
                if ([parts[4], parts[5], parts[6]].some(value => String(value || '').trim() !== '-')) {
                    issues.push(issue('DESIGN_WORKFLOW_EVENT_NONE_PAYLOAD_INVALID', rowIndex, `detailRows[${rowIndex}]`, 'none事件的methodName、businessEffect和parameters必须全部填写-。'));
                    return;
                }
                parsed.workflowEvents.push({ storyId, operationKey, mode, methodName: '', businessEffect: '', parameters: [], rowIndex });
                return;
            }
            const methodName = String(parts[4] || '').trim();
            const businessEffect = String(parts[5] || '').trim();
            const parameterText = String(parts[6] || '').trim();
            if (!JAVA_METHOD_NAME_PATTERN.test(methodName)) {
                issues.push(issue('DESIGN_WORKFLOW_EVENT_METHOD_NAME_INVALID', rowIndex, `detailRows[${rowIndex}].methodName`, 'service_method的methodName必须是合法lowerCamelCase Java方法名。'));
            }
            if (!businessEffect || businessEffect === '-') {
                issues.push(issue('DESIGN_WORKFLOW_EVENT_BUSINESS_EFFECT_MISSING', rowIndex, `detailRows[${rowIndex}].businessEffect`, 'service_method必须填写明确业务效果。'));
            }
            const parameters = [];
            const seenParameters = new Set();
            if (!parameterText || parameterText === '-') {
                issues.push(issue('DESIGN_WORKFLOW_EVENT_PARAMETERS_MISSING', rowIndex, `detailRows[${rowIndex}].parameters`, 'service_method必须填写参数；至少包含pviguid=$PVI_GUID:流程实例标识。'));
            } else {
                parameterText.split(',').map(item => item.trim()).filter(Boolean).forEach((token, parameterIndex) => {
                    const equalIndex = token.indexOf('=');
                    const colonIndex = equalIndex >= 0 ? token.indexOf(':', equalIndex + 1) : -1;
                    const name = equalIndex > 0 ? token.slice(0, equalIndex).trim() : '';
                    const value = equalIndex > 0 && colonIndex > equalIndex
                        ? token.slice(equalIndex + 1, colonIndex).trim()
                        : '';
                    const description = colonIndex > equalIndex ? token.slice(colonIndex + 1).trim() : '';
                    if (!JAVA_METHOD_NAME_PATTERN.test(name)) {
                        issues.push(issue('DESIGN_WORKFLOW_EVENT_PARAMETER_NAME_INVALID', rowIndex, `detailRows[${rowIndex}].parameters[${parameterIndex}]`, '工作流外部方法参数名必须是合法lowerCamelCase Java标识。'));
                        return;
                    }
                    if (seenParameters.has(name)) {
                        issues.push(issue('DESIGN_WORKFLOW_EVENT_PARAMETER_DUPLICATED', rowIndex, `detailRows[${rowIndex}].parameters[${parameterIndex}]`, `参数${name}重复。`));
                        return;
                    }
                    if (!value || !description || description === '-') {
                        issues.push(issue('DESIGN_WORKFLOW_EVENT_PARAMETER_INVALID', rowIndex, `detailRows[${rowIndex}].parameters[${parameterIndex}]`, '参数必须使用name=value:参数说明格式。'));
                        return;
                    }
                    const source = value === '$PVI_GUID' ? '$PVI_GUID' : 'constant';
                    if (source === 'constant' && !WORKFLOW_PARAMETER_CONSTANT_PATTERN.test(value)) {
                        issues.push(issue(
                            'DESIGN_WORKFLOW_EVENT_PARAMETER_VALUE_INVALID',
                            rowIndex,
                            `detailRows[${rowIndex}].parameters[${parameterIndex}]`,
                            '工作流外部方法参数值只能是$PVI_GUID或ASCII稳定常量；业务字段名、中文字段名和运行时表达式必须先补充已确认的参数来源合同。',
                            {
                                allowedSources: ['$PVI_GUID', 'constant'],
                                allowedPattern: WORKFLOW_PARAMETER_CONSTANT_PATTERN.source,
                                expectedShape: 'name=$PVI_GUID:说明 或 name=10:说明'
                            }
                        ));
                        return;
                    }
                    seenParameters.add(name);
                    parameters.push({ name, source, description, value: source === 'constant' ? value : '' });
                });
            }
            if (!parameters.some(parameter => parameter.name === 'pviguid' && parameter.source === '$PVI_GUID')) {
                issues.push(issue('DESIGN_WORKFLOW_EVENT_PVI_PARAMETER_MISSING', rowIndex, `detailRows[${rowIndex}].parameters`, 'service_method必须包含pviguid=$PVI_GUID:流程实例标识。'));
            }
            if (!issues.some(item => item.rowIndex === rowIndex)) {
                parsed.workflowEvents.push({ storyId, operationKey, mode, methodName, businessEffect, parameters, rowIndex });
            }
            return;
        }
        if (!exactPartCount(parts, 6, rowIndex, kind, issues, DETAIL_ROW_HELP.REST)) return;
        parsed.restOperations.push({
            storyId: parts[1].toUpperCase(),
            operationKey: parts[2],
            purpose: parts[3],
            requestShape: parts[4],
            responseShape: parts[5],
            rowIndex
        });
    });
    return issues.length > 0 ? { ok: false, issues } : { ok: true, ...parsed };
}

function parseCompositionRows(rows = []) {
    const issues = [];
    const compositions = [];
    const sections = [];
    const pageBindings = [];
    const queryFilters = [];
    const values = normalizeRows(rows);
    values.forEach((raw, rowIndex) => {
        const parts = splitRow(raw, rowIndex, issues, 'DESIGN_COMPOSITION', 'compositionRows');
        if (!parts) return;
        const kind = String(parts[0] || '').toUpperCase();
        if (kind === 'QUERY_FILTER') {
            if (!exactPartCount(parts, 6, rowIndex, kind, issues, COMPOSITION_ROW_HELP.QUERY_FILTER, 'compositionRows')) return;
            const storyId = String(parts[1] || '').trim().toUpperCase();
            const inputKey = String(parts[2] || '').trim();
            const fieldRef = String(parts[3] || '').trim().toLowerCase();
            const operator = String(parts[4] || '').trim().toLowerCase();
            const normalize = String(parts[5] || '').trim().toLowerCase();
            if (!STORY_ID_PATTERN.test(storyId)) {
                issues.push(issue('DESIGN_QUERY_FILTER_STORY_ID_INVALID', rowIndex, `compositionRows[${rowIndex}].storyId`, `QUERY_FILTER storyId必须是US+数字，当前=${parts[1] || '(empty)'}。`));
                return;
            }
            if (!QUERY_FILTER_INPUT_PATTERN.test(inputKey)) {
                issues.push(issue('DESIGN_QUERY_FILTER_INPUT_KEY_INVALID', rowIndex, `compositionRows[${rowIndex}].inputKey`, 'QUERY_FILTER inputKey必须是以小写字母开头的ASCII标识，例如searchKeyword。'));
                return;
            }
            if (!FIELD_REF_PATTERN.test(fieldRef)) {
                issues.push(issue('DESIGN_QUERY_FILTER_FIELD_REF_INVALID', rowIndex, `compositionRows[${rowIndex}].fieldRef`, 'QUERY_FILTER字段必须是tableKey.fieldName。'));
                return;
            }
            if (!QUERY_FILTER_OPERATORS.includes(operator)) {
                issues.push(issue('DESIGN_QUERY_FILTER_OPERATOR_INVALID', rowIndex, `compositionRows[${rowIndex}].operator`, `QUERY_FILTER operator必须是${QUERY_FILTER_OPERATORS.join('/')}。`, { allowedValues: QUERY_FILTER_OPERATORS.slice() }));
                return;
            }
            if (!QUERY_FILTER_NORMALIZERS.includes(normalize)) {
                issues.push(issue('DESIGN_QUERY_FILTER_NORMALIZE_INVALID', rowIndex, `compositionRows[${rowIndex}].normalize`, `QUERY_FILTER normalize必须是${QUERY_FILTER_NORMALIZERS.join('/')}。`, { allowedValues: QUERY_FILTER_NORMALIZERS.slice() }));
                return;
            }
            const [objectKey, fieldName] = fieldRef.split('.');
            queryFilters.push({ storyId, inputKey, objectKey, fieldName, operator, normalize, rowIndex });
            return;
        }
        if (kind === 'SECTION') {
            if (!exactPartCount(parts, 5, rowIndex, kind, issues, COMPOSITION_ROW_HELP.SECTION, 'compositionRows')) return;
            const storyId = String(parts[1] || '').toUpperCase();
            const sectionKey = String(parts[2] || '').toLowerCase();
            const title = String(parts[3] || '').trim();
            const fieldRefs = Array.from(new Set(String(parts[4] || '')
                .split(',')
                .map(item => item.trim().toLowerCase())
                .filter(Boolean)));
            if (!STORY_ID_PATTERN.test(storyId)) {
                issues.push(issue('DESIGN_SECTION_STORY_ID_INVALID', rowIndex, `compositionRows[${rowIndex}].storyId`, `SECTION storyId必须是US+数字，当前=${parts[1] || '(empty)'}。`));
                return;
            }
            if (!DESIGN_DECISION_TAG_PATTERN.test(sectionKey)) {
                issues.push(issue('DESIGN_SECTION_KEY_INVALID', rowIndex, `compositionRows[${rowIndex}].sectionKey`, 'SECTION sectionKey必须是ASCII snake_case。'));
                return;
            }
            if (!title) {
                issues.push(issue('DESIGN_SECTION_TITLE_MISSING', rowIndex, `compositionRows[${rowIndex}].title`, 'SECTION中文分区标题不能为空。'));
                return;
            }
            if (fieldRefs.length === 0 || fieldRefs.some(ref => !FIELD_REF_PATTERN.test(ref))) {
                issues.push(issue('DESIGN_SECTION_FIELD_REFS_INVALID', rowIndex, `compositionRows[${rowIndex}].fieldRefs`, 'SECTION必须引用一个或多个合法tableKey.fieldName。'));
                return;
            }
            sections.push({ storyId, sectionKey, title, fieldRefs, rowIndex });
            return;
        }
        if (kind === 'PAGE_BIND') {
            if (!exactPartCount(parts, 4, rowIndex, kind, issues, COMPOSITION_ROW_HELP.PAGE_BIND, 'compositionRows')) return;
            const storyId = String(parts[1] || '').toUpperCase();
            const mode = String(parts[2] || '').toLowerCase();
            const target = mode === 'shared'
                ? String(parts[3] || '').toUpperCase()
                : String(parts[3] || '').toLowerCase();
            if (!STORY_ID_PATTERN.test(storyId)) {
                issues.push(issue('DESIGN_PAGE_BIND_STORY_ID_INVALID', rowIndex, `compositionRows[${rowIndex}].storyId`, `PAGE_BIND storyId必须是US+数字，当前=${parts[1] || '(empty)'}。`));
                return;
            }
            if (!['shared', 'independent'].includes(mode)) {
                issues.push(issue(
                    'DESIGN_PAGE_BIND_MODE_INVALID',
                    rowIndex,
                    `compositionRows[${rowIndex}].mode`,
                    `PAGE_BIND mode必须是shared或independent，当前=${parts[2] || '(empty)'}。`,
                    { allowedValues: ['shared', 'independent'] }
                ));
                return;
            }
            if (mode === 'shared' && !STORY_ID_PATTERN.test(target)) {
                issues.push(issue('DESIGN_PAGE_BIND_TARGET_STORY_ID_INVALID', rowIndex, `compositionRows[${rowIndex}].target`, 'shared PAGE_BIND的目标必须是已声明COMPOSE的Story ID。'));
                return;
            }
            if (mode === 'independent' && target !== 'self') {
                issues.push(issue('DESIGN_PAGE_BIND_INDEPENDENT_TARGET_INVALID', rowIndex, `compositionRows[${rowIndex}].target`, 'independent PAGE_BIND第4段只能是self。', { allowedValues: ['self'] }));
                return;
            }
            pageBindings.push({
                storyId,
                mode,
                targetStoryId: mode === 'shared' ? target : '',
                target: mode === 'shared' ? target : 'self',
                rowIndex
            });
            return;
        }
        if (kind !== 'COMPOSE') {
            issues.push(issue(
                'DESIGN_COMPOSITION_ROW_KIND_INVALID',
                rowIndex,
                `compositionRows[${rowIndex}]`,
                `首段必须是COMPOSE、SECTION、PAGE_BIND或QUERY_FILTER，当前为 ${kind || '(empty)'}。`,
                { allowedValues: ['COMPOSE', 'SECTION', 'PAGE_BIND', 'QUERY_FILTER'] }
            ));
            return;
        }
        if (parts.length === 4) parts.push('');
        if (!exactPartCount(parts, 5, rowIndex, kind, issues, COMPOSITION_ROW_HELP.COMPOSE, 'compositionRows')) return;
        if (!STORY_ID_PATTERN.test(String(parts[1] || '').toUpperCase())) {
            issues.push(issue('DESIGN_COMPOSE_STORY_ID_INVALID', rowIndex, `compositionRows[${rowIndex}].storyId`, `COMPOSE storyId必须是US+数字，当前=${parts[1] || '(empty)'}。`));
            return;
        }
        const layout = String(parts[2] || '').toLowerCase();
        if (!COMPOSITION_LAYOUTS.includes(layout)) {
            issues.push(issue(
                'DESIGN_COMPOSE_LAYOUT_INVALID',
                rowIndex,
                `compositionRows[${rowIndex}].layout`,
                `COMPOSE布局必须是${COMPOSITION_LAYOUTS.join('/')}，当前=${parts[2] || '(empty)'}。`,
                { allowedValues: COMPOSITION_LAYOUTS.slice() }
            ));
            return;
        }
        const blockTokens = String(parts[3] || '').split(',').map(item => item.trim()).filter(Boolean);
        if (blockTokens.length === 0) {
            issues.push(issue('DESIGN_COMPOSE_BLOCKS_EMPTY', rowIndex, `compositionRows[${rowIndex}]`, 'COMPOSE至少需要一个业务块。'));
            return;
        }
        const blocks = [];
        blockTokens.forEach((token, blockIndex) => {
            const pair = token.split(':').map(item => item.trim());
            if (pair.length !== 2 || !COMPOSITION_BLOCK_KINDS.includes(pair[0]) || !OBJECT_KEY_PATTERN.test(pair[1])) {
                issues.push(issue(
                    'DESIGN_COMPOSE_BLOCK_INVALID',
                    rowIndex,
                    `compositionRows[${rowIndex}].blocks[${blockIndex}]`,
                    `组合块必须是${COMPOSITION_BLOCK_KINDS.join('/')}之一加合法tableKey，当前=${token}。`,
                    { allowedValues: COMPOSITION_BLOCK_KINDS.slice() }
                ));
                return;
            }
            blocks.push({ kind: pair[0], objectKey: pair[1] });
        });
        const decisionTags = Array.from(new Set(String(parts[4] === '-' ? '' : parts[4] || '')
            .split(',')
            .map(item => item.trim().toLowerCase())
            .filter(Boolean)));
        if (decisionTags.some(tag => !DESIGN_DECISION_TAG_PATTERN.test(tag))) {
            issues.push(issue(
                'DESIGN_COMPOSE_DECISION_TAGS_INVALID',
                rowIndex,
                `compositionRows[${rowIndex}].decisionTags`,
                'COMPOSE审计标签可省略；填写时使用ASCII snake_case，不填写自然语言长理由。'
            ));
            return;
        }
        compositions.push({
            storyId: parts[1].toUpperCase(),
            layout,
            blocks,
            decisionTags,
            rowIndex
        });
    });
    return issues.length > 0 ? { ok: false, issues } : { ok: true, compositions, sections, pageBindings, queryFilters };
}

function decisionRowsSchema() {
    return {
        type: 'array',
        minItems: 1,
        items: { type: 'string', minLength: 3 },
        description: `表与骨架单数组行协议。${Object.values(DECISION_ROW_HELP).join('；')}`
    };
}

function detailRowsSchema() {
    return {
        type: 'array',
        items: { type: 'string', minLength: 3 },
        description: `字段/API单数组行协议。${Object.values(DETAIL_ROW_HELP).join('；')}`
    };
}

function compositionRowsSchema() {
    return {
        type: 'array',
        items: { type: 'string', minLength: 3 },
        description: `字段闭合后的页面设计单数组行协议；布局、页面归属和筛选分别判断，无COMPOSE仍须提交适用的PAGE_BIND/QUERY_FILTER；所有行类型均无设计义务时才提交空数组。${Object.values(COMPOSITION_ROW_HELP).join('；')}`
    };
}

module.exports = {
    OBJECT_KEY_PATTERN,
    STORY_ID_PATTERN,
    TABLE_MODES,
    STATISTICS_SOURCE_ROLES,
    RELATION_KINDS,
    CAPABILITIES,
    COMPOSITION_LAYOUTS,
    COMPOSITION_BLOCK_KINDS,
    PAGE_COMPOSITION_BLOCK_CONTRACT,
    CODE_ITEM_MODES,
    CODE_ITEM_FACT_TYPES,
    WORKFLOW_PARAMETER_CONSTANT_PATTERN,
    DECISION_ROW_HELP,
    DETAIL_ROW_HELP,
    COMPOSITION_ROW_HELP,
    parseDecisionRows,
    parseDetailRows,
    parseCompositionRows,
    decisionRowsSchema,
    detailRowsSchema,
    compositionRowsSchema
};
