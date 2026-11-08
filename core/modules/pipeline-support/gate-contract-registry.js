/**
 * gate-contract-registry.js — 门禁合同统一注册表
 *
 * 职责：
 * - 以 businessKey + stageKey + artifactKind + gateId + profile 查询门禁合同。
 * - 为 Skill、Gate、测试提供同一个合同来源。
 * - 合同只声明验证维度、依赖和失败码，不写入任何项目产品线样例值。
 */

const DesignTddRequiredRulesConfigService = require('./design-tdd-required-rules-config-service');

const SKELETON_ELIGIBLE_FILE_KINDS = Object.freeze([
    'Entity',
    'ServiceApi',
    'ServiceInternal',
    'ServiceImpl',
    'Rest',
    'Job',
    'Action',
    'HtmlPage'
]);

const RULE_ALIAS_MAP = Object.freeze({
    'Entity': '代码生成规范-后端实体层',
    'ServiceApi': '代码生成规范-后端实体层',
    'ServiceInternal': '代码生成规范-后端实体层',
    'ServiceImpl': '代码生成规范-后端实体层',
    'Rest': 'REST接口开发规范',
    'Job': '定时任务Job开发规范',
    'Action': '代码生成规范-后端控制层',
    'HtmlPage': '代码生成规范-前端页面'
});

const SECTION_TITLE_MAP = Object.freeze({
    '代码生成规范-后端实体层': {
        'Entity': 'Entity',
        'ServiceApi': 'ServiceApi',
        'ServiceInternal': 'ServiceInternal',
        'ServiceImpl': 'ServiceImpl'
    },
    '代码生成规范-后端控制层': {
        'ListAction': 'ListAction',
        'AddAction': 'AddAction',
        'EditAction': 'EditAction',
        'DetailAction': 'DetailAction',
        'ReuseQueryListAction': 'ReuseQueryListAction',
        'WorkflowMyListAction': 'WorkflowMyListAction',
        'WorkflowAction': 'WorkflowAction'
    },
    'REST接口开发规范': {
        'Rest': 'RestController',
        'RestController': 'RestController'
    },
    '定时任务Job开发规范': {
        'Job': 'Job'
    },
    '代码生成规范-前端页面': {
        // 入参 subType (list/add/edit/detail) → 中文 section 标题（规范 .md 里实际写的）
        'list': '列表页',
        'add': '新增页',
        'edit': '编辑页',
        'detail': '详情页',
        // 兼容首字母大写写法
        'List': '列表页',
        'Add': '新增页',
        'Edit': '编辑页',
        'Detail': '详情页',
        'ReuseQueryListHtmlPage': 'ReuseQueryListHtmlPage',
        'WorkflowMyListHtmlPage': 'WorkflowMyListHtmlPage',
        'WorkflowHtmlPage': 'WorkflowHtmlPage'
    }
});

const PLACEHOLDER_SOURCES = Object.freeze([
    // 后端骨架占位符
    '{模块}', '{module}', '{EntityName}', '{FeatureName}', '{OperationName}', '{operationName}', '{表名}', '{table_name}', '{pagename}', '{项目}', '{project}',
    // REST 设计契约占位符（由 design_tdd_build_plan.businessContext.restContract 派生）
    '{RestContractJson}', '{RestBasePath}', '{RestMethodName}', '{RestOperationPath}', '{RestHttpMethod}',
    // 工作流设计契约占位符（由需求 workflowIntent 投影到 design_tdd_build_plan.businessContext.workflowContract）
    '{WorkflowContractJson}', '{WorkflowContractsJson}', '{WorkflowProcessName}', '{WorkflowStarter}',
    // 前端 HtmlPage 模板占位符（与 代码生成规范-前端页面.md 保持一致）
    '{表中文名}', '{field_name}',
    // 列表页槽位
    '{主要字段}', '{代码项字段}', '{代码项名}', '{字典编码}', '{代码项列}', '{一般属性列}',
    '{一般查询}', '{代码项查询}', '{codeItemField}', '{CodeItem}',
    // 表单页槽位
    '{字段标签}', '{代码项录入}', '{代码项展示}', '{代码字段}', '{时间字段}'
]);

const REQUIRED_RULES_CONFIG_SERVICE = new DesignTddRequiredRulesConfigService();
const FILE_KIND_MUST_READ_RULES = Object.freeze(REQUIRED_RULES_CONFIG_SERVICE.getFileKindRequiredRulesMap());

/**
 * 阶段入口工具映射：用于 gate_contract.resolve() 命中 not_found 时，按 stageKey
 * 反查"该阶段对应的最终提交工具"，把 LLM 引导回 Builder 入口而不是让它瞎写文件。
 *
 * 设计目的：
 * - 设计/需求/TDD 阶段最终都不通过 gate_contract，而是通过专用的 Builder 入口
 *   （design_prepare_context / req_finalize_artifacts / design_tdd_skeleton_materialize）。
 * - 当 LLM 误把"先查门禁合同"的 r2c/coder 习惯套到这些阶段时，仅返回干瘪的
 *   "未找到合同"会让模型陷入自己写文件的死路。本表让 not_found 返回首屏直接
 *   告诉 LLM"本阶段唯一允许的工具是哪一个"。
 *
 * 维护原则：
 * - 只列"该阶段的 Builder 终点入口"，不写多个候选；
 * - 不写禁令清单（避免补丁地狱），只写 allowedNextActions；
 * - 新增阶段时，只在这里加一行，gate_contract not_found 自动覆盖。
 */
const STAGE_ENTRY_HINTS = Object.freeze({
    'design': {
        toolName: 'design_prepare_context',
        skill: 'epoint-requirement-design',
        hint: '设计阶段不通过gate_contract提交。无phase调用design_prepare_context建立或恢复当前卡，再按currentCardRef和currentStepId依次提交decisionRows、detailRows；字段闭合后必须用page_design_confirmed提交compositionRows，Builder只在页面设计通过后finalize。'
    },
    'requirement': {
        toolName: 'req_finalize_artifacts',
        skill: 'epoint-requirement-analyzer',
        hint: '需求分析阶段不通过 gate_contract 提交。请直接调 req_finalize_artifacts(projectPath)；Builder 验证已落盘产物并写入 finalize receipt。'
    },
    'tdd': {
        toolName: 'design_tdd_skeleton_materialize',
        skill: 'epoint-design-tdd-coder',
        hint: 'TDD 阶段不通过 gate_contract 提交。请按 epoint-design-tdd-coder 流程调用 design_tdd_skeleton_materialize 等专用工具。'
    }
});

const DEFAULT_PROFILE = '*';

function clone(value) {
    return JSON.parse(JSON.stringify(value));
}

class GateContractRegistry {
    constructor() {
        this._contracts = new Map();
    }

    register(contract) {
        this._validateContract(contract);
        const key = this._key(contract);
        if (this._contracts.has(key)) {
            throw new Error(`GateContractRegistry: duplicate contract route "${key}"`);
        }
        this._contracts.set(key, clone(contract));
        return this;
    }

    registerMany(contracts) {
        if (!Array.isArray(contracts)) {
            throw new Error('GateContractRegistry: registerMany expects an array');
        }
        contracts.forEach(contract => this.register(contract));
        return this;
    }

    getContract(query = {}) {
        const normalized = this._normalizeQuery(query);
        const exactKey = this._key(normalized);
        const wildcardKey = this._key({ ...normalized, profile: DEFAULT_PROFILE });
        const contract = this._contracts.get(exactKey) || this._contracts.get(wildcardKey);
        return contract ? clone(contract) : null;
    }

    listContracts(filter = {}) {
        const normalized = this._normalizePartial(filter);
        return Array.from(this._contracts.values())
            .filter(contract => {
                return Object.keys(normalized).every(key => {
                    if (!normalized[key]) {
                        return true;
                    }
                    if (key === 'profile') {
                        return contract.profile === normalized.profile || contract.profile === DEFAULT_PROFILE;
                    }
                    return contract[key] === normalized[key];
                });
            })
            .map(clone);
    }

    getFailureCodes(query = {}, dimensionId = '') {
        const contract = this.getContract(query);
        if (!contract || !Array.isArray(contract.dimensions)) {
            return [];
        }
        const dimension = contract.dimensions.find(item => item.dimensionId === dimensionId);
        return dimension && Array.isArray(dimension.failureCodes) ? [...dimension.failureCodes] : [];
    }

    resolve(query = {}) {
        const contract = this.getContract(query);
        if (!contract) {
            const normalizedQuery = this._normalizePartial(query);
            const stageKey = normalizedQuery.stageKey;
            const stageHint = stageKey ? STAGE_ENTRY_HINTS[stageKey] : null;
            if (stageHint) {
                // 行动锚点：LLM 误在 design/requirement/tdd 阶段调 gate_contract 时，
                // 直接告诉它本阶段的 Builder 终点入口，避免自己改成 Write 写文件。
                return {
                    ok: false,
                    status: 'not_found',
                    actionMode: 'use_stage_entry_tool',
                    query: normalizedQuery,
                    message: stageHint.hint,
                    expectedEntryTool: stageHint.toolName,
                    allowedNextActions: [`call_${stageHint.toolName}`],
                    forbiddenActions: ['write_stage_artifacts_directly_without_builder']
                };
            }
            return {
                ok: false,
                status: 'not_found',
                actionMode: 'verify_gate_contract_query',
                query: normalizedQuery,
                message: '未找到匹配的门禁合同；请确认 businessKey/stageKey/artifactKind/gateId 四元组是否正确。',
                allowedNextActions: ['verify_gate_contract_query']
            };
        }
        return {
            ok: true,
            status: 'found',
            gateContract: contract
        };
    }

    _validateContract(contract) {
        if (!contract || typeof contract !== 'object') {
            throw new Error('GateContractRegistry: contract must be an object');
        }
        ['contractType', 'contractId', 'businessKey', 'stageKey', 'artifactKind', 'gateId'].forEach(field => {
            if (!String(contract[field] || '').trim()) {
                throw new Error(`GateContractRegistry: ${field} is required`);
            }
        });
        if (contract.contractType !== 'gateContract') {
            throw new Error(`GateContractRegistry: contractType must be gateContract: ${contract.contractId}`);
        }
        if (!Array.isArray(contract.dimensions) || contract.dimensions.length === 0) {
            throw new Error(`GateContractRegistry: dimensions are required: ${contract.contractId}`);
        }
        contract.dimensions.forEach(dimension => {
            if (!String(dimension && dimension.dimensionId || '').trim()) {
                throw new Error(`GateContractRegistry: dimensionId is required: ${contract.contractId}`);
            }
        });
    }

    _normalizeQuery(query = {}) {
        const normalized = this._normalizePartial(query);
        ['businessKey', 'stageKey', 'artifactKind', 'gateId'].forEach(field => {
            if (!normalized[field]) {
                throw new Error(`GateContractRegistry: query.${field} is required`);
            }
        });
        return {
            ...normalized,
            profile: normalized.profile || DEFAULT_PROFILE
        };
    }

    _normalizePartial(query = {}) {
        return {
            businessKey: String(query.businessKey || '').trim(),
            stageKey: String(query.stageKey || '').trim(),
            artifactKind: String(query.artifactKind || '').trim(),
            gateId: String(query.gateId || '').trim(),
            profile: String(query.profile || '').trim()
        };
    }

    _key(value = {}) {
        return [
            value.businessKey,
            value.stageKey,
            value.artifactKind,
            value.gateId,
            value.profile || DEFAULT_PROFILE
        ].join('::');
    }

    static getInstance() {
        if (!GateContractRegistry._instance) {
            GateContractRegistry._instance = new GateContractRegistry();
        }
        return GateContractRegistry._instance;
    }

    static getSkeletonMappings() {
        return {
            SKELETON_ELIGIBLE_FILE_KINDS,
            RULE_ALIAS_MAP,
            SECTION_TITLE_MAP,
            PLACEHOLDER_SOURCES,
            FILE_KIND_MUST_READ_RULES,
            EXTENSION_SLOT_DRAFT_MAP: {
                Action: { fromMethodTargets: ['entryAdapter', 'serviceCall', 'callbackParams'] },
                ServiceImpl: { fromMethodTargets: ['businessMethod', 'externalCall', 'dataTransform'] },
                ServiceApi: { fromMethodTargets: ['methodSignature'] },
                ServiceInternal: { fromMethodTargets: ['internalMethod'] },
                Entity: { fromMethodTargets: ['fields', 'accessors'] },
                HtmlPage: {
                    create: ['toolbar', 'gridColumns', 'scriptFunctions'],
                    modify: ['toolbarPatch', 'scriptPatch']
                }
            }
        };
    }
}

GateContractRegistry._instance = null;

// Attach skeleton mapping constants as static properties
GateContractRegistry.SKELETON_ELIGIBLE_FILE_KINDS = SKELETON_ELIGIBLE_FILE_KINDS;
GateContractRegistry.RULE_ALIAS_MAP = RULE_ALIAS_MAP;
GateContractRegistry.SECTION_TITLE_MAP = SECTION_TITLE_MAP;
GateContractRegistry.PLACEHOLDER_SOURCES = PLACEHOLDER_SOURCES;
GateContractRegistry.FILE_KIND_MUST_READ_RULES = FILE_KIND_MUST_READ_RULES;

module.exports = GateContractRegistry;
